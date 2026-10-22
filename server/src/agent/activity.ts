import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionActivity } from '../../../shared/protocol.js';

/**
 * Folds a session's SDK stream into one "Claude is …" line (see SessionActivity).
 * The stream itself only reaches browsers subscribed to that session; this
 * summary is what the board, dashboard and session list see.
 */

export type ActivityLine = Pick<SessionActivity, 'label' | 'detail'>;
type Step = Omit<SessionActivity, 'since'>;

const MAX_LABEL = 80;
const MAX_DETAIL = 160;

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function rel(p: unknown, root?: string): string | undefined {
  if (typeof p !== 'string' || !p) return undefined;
  return root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
const isAgentTool = (name: string) => name === 'Agent' || name === 'Task';

/**
 * The status line for a shell command Claude is running.
 *
 * `command` is the raw shell text (it can span many lines, and is '' while Claude
 * is still streaming the call). `description` is Claude's own 5–10 word summary
 * of it, e.g. "Run the server test suite" — usually present, never guaranteed,
 * and written by the model rather than derived from the command.
 *
 * `label` is the headline people scan on a busy board; `detail` is the smaller
 * monospace line under it. Both are whitespace-collapsed and clipped afterwards.
 */
export function describeBash(command: string, description: string | undefined): ActivityLine {
  // TODO(you): decide what a running command looks like at a glance.
  return { label: 'Running a command', detail: command || undefined };
}

/** Present-tense twin of ToolCard's describe(): "Editing", "Searching", … */
export function describeTool(name: string, input: Record<string, any> | undefined, root?: string): ActivityLine {
  const i = input ?? {};
  switch (name) {
    case 'Bash':
      return describeBash(typeof i.command === 'string' ? i.command : '', str(i.description));
    case 'BashOutput':
    case 'TaskOutput':
      return { label: 'Checking a background job' };
    case 'Read':
      return { label: 'Reading', detail: rel(i.file_path, root) };
    case 'Write':
      return { label: 'Writing', detail: rel(i.file_path, root) };
    case 'Edit':
    case 'MultiEdit':
      return { label: 'Editing', detail: rel(i.file_path, root) };
    case 'NotebookEdit':
      return { label: 'Editing a notebook', detail: rel(i.notebook_path, root) };
    case 'Glob':
      return { label: 'Finding files', detail: str(i.pattern) };
    case 'Grep':
      return { label: 'Searching', detail: str(i.pattern) };
    case 'WebSearch':
      return { label: 'Searching the web', detail: str(i.query) };
    case 'WebFetch': {
      let host: string | undefined;
      try {
        host = new URL(String(i.url)).host;
      } catch {
        host = str(i.url);
      }
      return { label: 'Reading the web', detail: host };
    }
    case 'TodoWrite': {
      // The item marked in_progress says what Claude is about to do, in its own words.
      const doing = Array.isArray(i.todos) ? i.todos.find((t: any) => t?.status === 'in_progress') : undefined;
      return { label: 'Updating the plan', detail: str(doing?.activeForm) ?? str(doing?.content) };
    }
    case 'Agent':
    case 'Task':
      return { label: str(i.subagent_type) ? `Agent · ${i.subagent_type}` : 'Running an agent', detail: str(i.description) };
    case 'AskUserQuestion':
      return { label: 'Asking you', detail: str(i.questions?.[0]?.question) };
    case 'ExitPlanMode':
      return { label: 'Proposing a plan' };
    case 'Skill':
      return { label: 'Using a skill', detail: str(i.skill) ?? str(i.name) };
  }
  if (name.startsWith('mcp__playwright__')) {
    const action = name.slice('mcp__playwright__'.length).replace(/^browser_/, '').replace(/_/g, ' ');
    return { label: `Browser · ${action}`, detail: str(i.url) ?? str(i.element) ?? str(i.text) };
  }
  if (name.startsWith('mcp__cloude__')) {
    const action = name.slice('mcp__cloude__'.length).replace(/_/g, ' ');
    return { label: action.charAt(0).toUpperCase() + action.slice(1), detail: str(i.name) ?? (i.port ? `port ${i.port}` : undefined) };
  }
  if (name.startsWith('mcp__')) {
    const [, server, ...tool] = name.split('__');
    return { label: `${server} · ${tool.join('__')}` };
  }
  return { label: name };
}

export class ActivityTracker {
  current: SessionActivity | null = null;

  /** `root` is Claude's working directory (paths under it are shown relative). */
  constructor(
    private root: () => string | undefined,
    private changed: () => void,
  ) {}

  observe(msg: SDKMessage) {
    switch (msg.type) {
      case 'stream_event': {
        if (msg.event.type !== 'content_block_start') return;
        const b = msg.event.content_block as { type: string; name?: string };
        const step: Step | null =
          b.type === 'thinking' || b.type === 'redacted_thinking'
            ? { kind: 'thinking', label: 'Thinking' }
            : b.type === 'text'
              ? { kind: 'writing', label: 'Writing a reply' }
              : b.type === 'tool_use' && b.name
                ? this.toolStep(b.name, undefined) // input still streaming; the finished message fills in the target
                : null;
        if (step) this.apply(step, msg.parent_tool_use_id);
        return;
      }
      case 'assistant': {
        const blocks = (msg.message.content ?? []) as { type: string; name?: string; input?: Record<string, any> }[];
        const call = blocks.filter((b) => b.type === 'tool_use' && b.name).pop();
        if (call) this.apply(this.toolStep(call.name!, call.input), msg.parent_tool_use_id);
        return;
      }
      case 'user': {
        // Tool results are back on the main thread: the model is now reading them.
        const content = msg.message.content;
        const results = Array.isArray(content) && content.some((b) => b.type === 'tool_result');
        if (results && !msg.parent_tool_use_id) this.set({ kind: 'thinking', label: 'Thinking' });
        return;
      }
      case 'system':
        if (msg.subtype === 'status') {
          if (msg.status === 'compacting') this.set({ kind: 'compacting', label: 'Compacting the conversation' });
          else if (this.current?.kind === 'compacting') this.set({ kind: 'thinking', label: 'Thinking' });
        } else if (msg.subtype === 'task_progress' && msg.summary && this.current?.kind === 'agent') {
          this.set({ ...this.current, detail: msg.summary });
        }
        return;
      case 'result':
        this.clear();
        return;
    }
  }

  clear() {
    if (!this.current) return;
    this.current = null;
    this.changed();
  }

  private toolStep(name: string, input: Record<string, any> | undefined): Step {
    return { kind: isAgentTool(name) ? 'agent' : 'tool', tool: name, ...describeTool(name, input, this.root()) };
  }

  /** A subagent's own steps become the detail line of the agent step that launched it. */
  private apply(step: Step, parentToolUseId: string | null) {
    if (!parentToolUseId) return this.set(step);
    if (this.current?.kind === 'agent') this.set({ ...this.current, detail: step.detail ? `${step.label} ${step.detail}` : step.label });
  }

  private set(step: Step) {
    const label = clip(step.label, MAX_LABEL) || 'Working';
    const detail = step.detail ? clip(step.detail, MAX_DETAIL) || undefined : undefined;
    const cur = this.current;
    if (cur && cur.kind === step.kind && cur.label === label && cur.detail === detail && cur.tool === step.tool) return;
    // Filling in the target of the same step (or a subagent moving on) keeps its clock running.
    const sameStep = cur && cur.kind === step.kind && cur.label === label && cur.tool === step.tool;
    this.current = { kind: step.kind, label, ...(detail ? { detail } : {}), ...(step.tool ? { tool: step.tool } : {}), since: sameStep ? cur.since : Date.now() };
    this.changed();
  }
}
