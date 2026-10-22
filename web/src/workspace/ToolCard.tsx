import clsx from 'clsx';
import {
  Bot,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  ListTodo,
  Map as MapIcon,
  MessageCircleQuestion,
  MonitorPlay,
  Rocket,
  Search,
  Server,
  Sparkles,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge, Spinner } from '../components/ui';
import type { TimelineItem, ToolCall } from '../lib/timeline';
import { StringDiff } from './DiffView';
import { Markdown } from './Markdown';

interface Meta {
  icon: ReactNode;
  verb: string;
  target?: string;
  open?: boolean;
}

const ic = (C: typeof Wrench) => <C className="size-4" />;

function rel(p: unknown, root?: string): string {
  const s = String(p ?? '');
  return root && s.startsWith(root + '/') ? s.slice(root.length + 1) : s;
}

function describe(call: ToolCall, root?: string): Meta {
  const i = call.input;
  const n = call.name;
  if (n === 'Bash') return { icon: ic(SquareTerminal), verb: i.description || 'Ran a command', target: undefined };
  if (n === 'Read') return { icon: ic(FileText), verb: 'Read', target: rel(i.file_path, root) };
  if (n === 'Write') return { icon: ic(FilePlus), verb: 'Wrote', target: rel(i.file_path, root) };
  if (n === 'Edit' || n === 'MultiEdit') return { icon: ic(FilePen), verb: 'Edited', target: rel(i.file_path, root), open: true };
  if (n === 'NotebookEdit') return { icon: ic(FilePen), verb: 'Edited notebook', target: rel(i.notebook_path, root) };
  if (n === 'Glob') return { icon: ic(Search), verb: 'Found files', target: i.pattern };
  if (n === 'Grep') return { icon: ic(Search), verb: 'Searched', target: i.pattern };
  if (n === 'WebFetch') return { icon: ic(Globe), verb: 'Fetched', target: i.url };
  if (n === 'WebSearch') return { icon: ic(Globe), verb: 'Searched the web', target: i.query };
  if (n === 'TodoWrite') return { icon: ic(ListTodo), verb: 'Updated the plan', open: true };
  if (n === 'Agent' || n === 'Task') return { icon: ic(Bot), verb: i.subagent_type ? `Agent · ${i.subagent_type}` : 'Agent', target: i.description };
  if (n === 'AskUserQuestion') return { icon: ic(MessageCircleQuestion), verb: 'Asked you', open: true };
  if (n === 'ExitPlanMode') return { icon: ic(MapIcon), verb: 'Proposed a plan', open: true };
  if (n === 'Skill') return { icon: ic(Sparkles), verb: 'Used skill', target: i.skill ?? i.name };
  if (n.startsWith('mcp__playwright__')) {
    const action = n.slice('mcp__playwright__browser_'.length).replace(/_/g, ' ');
    return { icon: ic(MonitorPlay), verb: `Browser · ${action}`, target: i.url ?? i.element ?? i.text };
  }
  if (n.startsWith('mcp__cloude__')) {
    const action = n.slice('mcp__cloude__'.length);
    const deploy = ['publish', 'deploy', 'open_tunnel'].includes(action);
    return { icon: ic(deploy ? Rocket : Server), verb: action.replace(/_/g, ' '), target: i.name ?? (i.port ? `port ${i.port}` : undefined) };
  }
  if (n.startsWith('mcp__')) {
    const [, server, ...tool] = n.split('__');
    return { icon: ic(Wrench), verb: `${server} · ${tool.join('__')}` };
  }
  return { icon: ic(Wrench), verb: n };
}

function ResultContent({ content, isError, collapsedLines = 14 }: { content: unknown; isError: boolean; collapsedLines?: number }) {
  const blocks: any[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  return (
    <div className="space-y-2">
      {blocks.map((b, i) =>
        b?.type === 'image' && b.source?.data ? (
          <img
            key={i}
            src={`data:${b.source.media_type};base64,${b.source.data}`}
            alt="Tool output"
            className="max-h-[420px] rounded-lg border border-line"
          />
        ) : b?.type === 'text' && b.text ? (
          <Output key={i} text={b.text} isError={isError} collapsedLines={collapsedLines} />
        ) : null,
      )}
    </div>
  );
}

function Output({ text, isError, collapsedLines }: { text: string; isError?: boolean; collapsedLines: number }) {
  const [full, setFull] = useState(false);
  const clean = text.replace(/<\/?tool_use_error>/g, '');
  const lines = clean.split('\n');
  const long = lines.length > collapsedLines;
  return (
    <div className={clsx('porthole overflow-hidden', isError && 'border-bad/60')}>
      <pre className={clsx('overflow-x-auto px-3 py-2 whitespace-pre-wrap', isError && 'text-[#f2c4c4]')}>
        {long && !full ? lines.slice(0, collapsedLines).join('\n') : clean}
      </pre>
      {long && (
        <button onClick={() => setFull(!full)} className="w-full border-t border-port-line px-3 py-1.5 text-left text-xs text-port-dim hover:text-port-ink">
          {full ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

function Todos({ todos }: { todos: { content: string; status: string; activeForm?: string }[] }) {
  return (
    <ul className="space-y-1">
      {todos.map((t, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          {t.status === 'completed' ? (
            <Check className="mt-0.5 size-4 shrink-0 text-ok" />
          ) : t.status === 'in_progress' ? (
            <CircleDot className="mt-0.5 size-4 shrink-0 text-dawn" />
          ) : (
            <Circle className="mt-0.5 size-4 shrink-0 text-ink-3" />
          )}
          <span className={clsx(t.status === 'completed' && 'text-ink-3 line-through', t.status === 'in_progress' && 'font-medium')}>
            {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Body({ call, root, renderChildren }: { call: ToolCall; root?: string; renderChildren: (items: TimelineItem[]) => ReactNode }) {
  const i = call.input;
  const r = call.result;
  switch (call.name) {
    case 'Bash':
      return (
        <div className="space-y-2">
          <div className="porthole overflow-x-auto px-3 py-2">
            <span className="text-dawn select-none">$ </span>
            <span className="whitespace-pre-wrap">{i.command}</span>
          </div>
          {r && <ResultContent content={r.content} isError={r.isError} />}
        </div>
      );
    case 'Edit':
      return (
        <div className="space-y-2">
          <StringDiff before={String(i.old_string ?? '')} after={String(i.new_string ?? '')} />
          {r?.isError && <ResultContent content={r.content} isError />}
        </div>
      );
    case 'MultiEdit':
      return (
        <div className="space-y-2">
          {(i.edits ?? []).map((e: any, k: number) => (
            <StringDiff key={k} before={String(e.old_string ?? '')} after={String(e.new_string ?? '')} />
          ))}
        </div>
      );
    case 'Write':
      return (
        <div className="space-y-2">
          <Output text={String(i.content ?? '')} collapsedLines={18} />
          {r?.isError && <ResultContent content={r.content} isError />}
        </div>
      );
    case 'Read':
      return r ? <ResultContent content={r.content} isError={r.isError} collapsedLines={10} /> : null;
    case 'TodoWrite':
      return <Todos todos={i.todos ?? []} />;
    case 'ExitPlanMode':
      return <Markdown text={String(i.plan ?? '')} className="rounded-lg border border-line bg-surface-2 p-3 text-sm" />;
    case 'AskUserQuestion': {
      const answers = call.permission?.answers ?? {};
      return (
        <div className="space-y-2.5">
          {(i.questions ?? []).map((q: any, k: number) => (
            <div key={k} className="text-sm">
              <p className="font-medium">{q.question}</p>
              <p className="mt-0.5 text-ink-2">→ {answers[q.question] ?? (call.permission?.state === 'denied' ? 'Not answered' : '…')}</p>
            </div>
          ))}
        </div>
      );
    }
    case 'Agent':
    case 'Task':
      return (
        <div className="space-y-2">
          {i.prompt && (
            <details className="text-sm">
              <summary className="cursor-pointer text-ink-3">Instructions</summary>
              <p className="mt-1 whitespace-pre-wrap text-ink-2">{i.prompt}</p>
            </details>
          )}
          {call.children.length > 0 && <div className="space-y-1.5 border-l-2 border-line pl-3">{renderChildren(call.children)}</div>}
          {r && <ResultContent content={r.content} isError={r.isError} collapsedLines={20} />}
        </div>
      );
    default: {
      const hasInput = i && Object.keys(i).length > 0;
      return (
        <div className="space-y-2">
          {hasInput && <Output text={JSON.stringify(i, null, 2)} collapsedLines={12} />}
          {r && <ResultContent content={r.content} isError={r.isError} />}
        </div>
      );
    }
  }
}

export function ToolCard({
  call,
  root,
  progress,
  renderChildren,
}: {
  call: ToolCall;
  root?: string;
  progress?: number;
  renderChildren: (items: TimelineItem[]) => ReactNode;
}) {
  const meta = describe(call, root);
  const pending = call.permission?.state === 'pending';
  const denied = call.permission?.state === 'denied';
  const failed = call.result?.isError && !denied;
  const done = !!call.result;
  const [open, setOpen] = useState<boolean>(!!meta.open);
  const expanded = open || pending || (failed && call.name !== 'Read');

  return (
    <div className={clsx('rounded-xl border bg-surface', pending ? 'border-break' : failed ? 'border-bad/40' : 'border-line')}>
      <button onClick={() => setOpen(!expanded)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left" aria-expanded={expanded}>
        <span className={clsx('shrink-0', pending ? 'text-break-ink' : failed ? 'text-bad' : 'text-ink-3')}>{meta.icon}</span>
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-medium">{meta.verb}</span>
          {meta.target && <span className="ml-1.5 font-mono text-[12.5px] text-ink-2">{meta.target}</span>}
          {call.name === 'Bash' && !expanded && <span className="ml-1.5 font-mono text-[12.5px] text-ink-3">{String(call.input.command ?? '').split('\n')[0]}</span>}
        </span>
        {pending && <Badge tone="break">Waiting for you</Badge>}
        {denied && <Badge tone="bad">Declined</Badge>}
        {failed && <Badge tone="bad">Failed</Badge>}
        {!done && !pending && !denied && (
          <span className="flex items-center gap-1.5 text-xs text-ink-3">
            {progress ? `${Math.round(progress)}s` : null}
            <Spinner className="size-3.5" />
          </span>
        )}
        {done && !failed && !denied && <Check className="size-4 shrink-0 text-ok" />}
        <ChevronRight className={clsx('size-4 shrink-0 text-ink-3 transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded && (
        <div className="border-t border-line px-3 py-2.5">
          <Body call={call} root={root} renderChildren={renderChildren} />
          {denied && call.permission?.message && <p className="mt-2 text-xs text-ink-3">Your note: {call.permission.message}</p>}
        </div>
      )}
    </div>
  );
}
