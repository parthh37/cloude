import type { PermissionRequest, SessionEvent } from '../../../shared/protocol';

export interface ToolResult {
  content: unknown; // string | content blocks
  isError: boolean;
  structured?: unknown; // tool_use_result from the SDK (e.g. Edit's structured patch)
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
  result?: ToolResult;
  children: TimelineItem[]; // subagent activity
  permission?: { state: 'pending' | 'allowed' | 'denied'; message?: string; answers?: Record<string, string> };
}

export type TimelineItem =
  | { kind: 'user'; key: string; text: string; images: { mediaType: string; data?: string; name?: string }[]; uuid?: string; at: number }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool'; key: string; call: ToolCall }
  | { kind: 'marker'; key: string; tone: 'neutral' | 'warn' | 'bad'; label: string; detail?: string }
  | { kind: 'command_output'; key: string; text: string }
  | { kind: 'result'; key: string; ok: boolean; subtype: string; durationMs: number; costUsd: number; turns: number; text?: string }
  | { kind: 'error'; key: string; message: string };

const plainText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((b: any) => (b?.type === 'text' ? b.text : ''))
          .filter(Boolean)
          .join('\n')
      : '';

/** Strip the CLI's XML wrappers from slash-command output. */
function cleanCommandOutput(s: string) {
  return s.replace(/<\/?local-command-std(out|err)>/g, '').trim();
}

export function buildTimeline(events: SessionEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const calls = new Map<string, ToolCall>();
  const requests = new Map<string, PermissionRequest>();

  const target = (parent: string | null | undefined): TimelineItem[] => {
    if (parent) {
      const p = calls.get(parent);
      if (p) return p.children;
    }
    return items;
  };

  for (const e of events) {
    const d = e.data;
    const key = String(e.seq);

    if (e.kind === 'user') {
      items.push({ kind: 'user', key, text: d.text ?? '', images: d.images ?? [], uuid: d.uuid, at: e.createdAt });
      continue;
    }
    if (e.kind === 'error') {
      items.push({ kind: 'error', key, message: d.message });
      continue;
    }
    if (e.kind === 'permission_request') {
      const req = d as PermissionRequest;
      requests.set(req.id, req);
      const call = req.toolUseId ? calls.get(req.toolUseId) : undefined;
      if (call) call.permission = { state: 'pending' };
      continue;
    }
    if (e.kind === 'permission_resolved') {
      const req = requests.get(d.id);
      const call = req?.toolUseId ? calls.get(req.toolUseId) : undefined;
      if (call) call.permission = { state: d.decision === 'allow' ? 'allowed' : 'denied', message: d.message, answers: d.answers };
      else if (req?.kind === 'elicitation') {
        items.push({ kind: 'marker', key, tone: 'neutral', label: `${d.decision === 'allow' ? 'Accepted' : 'Declined'} request from ${req.toolName.replace(/^mcp:/, '')}` });
      }
      continue;
    }
    if (e.kind !== 'sdk') continue;

    switch (d.type) {
      case 'assistant': {
        const list = target(d.parent_tool_use_id);
        const content: any[] = d.message?.content ?? [];
        content.forEach((b, i) => {
          const k = `${key}:${i}`;
          if (b.type === 'text' && b.text?.trim()) list.push({ kind: 'text', key: k, text: b.text });
          else if (b.type === 'thinking' && b.thinking?.trim()) list.push({ kind: 'thinking', key: k, text: b.thinking });
          else if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
            const call: ToolCall = { id: b.id, name: b.name, input: b.input ?? {}, children: [] };
            calls.set(b.id, call);
            list.push({ kind: 'tool', key: k, call });
          }
        });
        break;
      }
      case 'user': {
        const content = d.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type !== 'tool_result') continue;
            const call = calls.get(b.tool_use_id);
            if (call) call.result = { content: b.content, isError: !!b.is_error, structured: d.tool_use_result };
          }
        }
        // Plain user-role text from the SDK (synthetic context, subagent prompts) is not shown.
        break;
      }
      case 'result':
        items.push({
          kind: 'result',
          key,
          ok: !d.is_error,
          subtype: d.subtype,
          durationMs: d.duration_ms ?? 0,
          costUsd: d.total_cost_usd ?? 0,
          turns: d.num_turns ?? 0,
          text: d.is_error ? (d.subtype === 'success' ? d.result : (d.errors ?? []).join('\n') || d.subtype) : undefined,
        });
        break;
      case 'system':
        switch (d.subtype) {
          case 'init':
            items.push({
              kind: 'marker',
              key,
              tone: 'neutral',
              label: `Claude started · ${d.model}`,
              detail: [
                `${(d.tools ?? []).length} tools`,
                (d.mcp_servers ?? []).length ? `MCP: ${(d.mcp_servers ?? []).map((m: any) => `${m.name} (${m.status})`).join(', ')}` : '',
                d.claude_code_version ? `Claude Code ${d.claude_code_version}` : '',
              ]
                .filter(Boolean)
                .join(' · '),
            });
            break;
          case 'compact_boundary':
            items.push({
              kind: 'marker',
              key,
              tone: 'neutral',
              label: `Conversation compacted (${d.compact_metadata?.trigger ?? 'auto'})`,
              detail: d.compact_metadata?.pre_tokens ? `${Math.round(d.compact_metadata.pre_tokens / 1000)}k tokens summarized` : undefined,
            });
            break;
          case 'local_command_output':
            items.push({ kind: 'command_output', key, text: cleanCommandOutput(String(d.content ?? '')) });
            break;
          case 'task_started':
            items.push({ kind: 'marker', key, tone: 'neutral', label: `Background task started: ${d.description}` });
            break;
          case 'task_notification':
            items.push({ kind: 'marker', key, tone: d.status === 'failed' ? 'bad' : 'neutral', label: `Background task ${d.status}`, detail: d.summary });
            break;
          case 'notification':
            items.push({ kind: 'marker', key, tone: 'neutral', label: d.text });
            break;
          case 'api_retry':
            items.push({ kind: 'marker', key, tone: 'warn', label: `API error (${d.error_status ?? d.error}); retrying ${d.attempt}/${d.max_retries}` });
            break;
          case 'permission_denied':
            items.push({ kind: 'marker', key, tone: 'warn', label: `${d.tool_name} was blocked by a permission rule` });
            break;
          case 'informational':
            if (d.content || d.text) items.push({ kind: 'marker', key, tone: 'neutral', label: String(d.content ?? d.text) });
            break;
          case 'conversation_reset':
            items.push({ kind: 'marker', key, tone: 'neutral', label: 'Conversation cleared' });
            break;
          case 'model_refusal_fallback':
          case 'model_refusal_no_fallback':
            items.push({ kind: 'marker', key, tone: 'warn', label: 'The model declined part of this request' });
            break;
        }
        break;
    }
  }
  return items;
}

export { plainText };
