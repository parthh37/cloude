import clsx from 'clsx';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import type { PermissionRequest, Session } from '../../../shared/protocol';
import { span } from '../lib/format';
import { useNow } from '../lib/live';
import { useStore } from '../lib/store';
import { PermissionCard, respond, type Question } from '../workspace/PermissionCard';
import { Button, Dialog, StatusDot } from './ui';

/**
 * Live session state for views that summarise many sessions (board cards,
 * dashboard, session list). Everything here reads the broadcast `Session` and
 * `pending` state, so it works without subscribing to the session's stream.
 */

/** Ticks on its own so only live lines re-render every second. Hidden for the first few seconds of a step. */
function Elapsed({ since }: { since: number }) {
  const seconds = (useNow(1000) - since) / 1000;
  if (seconds < 3) return null;
  return (
    <span className="shrink-0 font-hud text-[11px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>
      {span(seconds)}
    </span>
  );
}

/** "Editing  web/src/App.tsx  12s": what Claude is doing in this session. Renders nothing unless Claude is working. */
export function ActivityLine({ session, dot = true, className }: { session: Session; dot?: boolean; className?: string }) {
  if (session.status !== 'running' && session.status !== 'starting') return null;
  const a = session.status === 'starting' ? null : session.activity;
  const label = session.status === 'starting' ? 'Starting Claude' : (a?.label ?? 'Working');
  return (
    <span className={clsx('flex min-w-0 items-center gap-1.5 text-[12.5px]', className)} title={a?.detail ? `${label} ${a.detail}` : label}>
      {dot && <StatusDot status={session.status} />}
      <span className="shrink-0 font-medium text-dawn-ink">{label}</span>
      {a?.detail && (
        <span className={clsx('min-w-0 truncate', a.tool === 'Bash' ? 'porthole px-1.5 py-px text-[11px]' : 'font-mono text-[11.5px] text-ink-2')}>{a.detail}</span>
      )}
      {a && <Elapsed since={a.since} />}
    </span>
  );
}

/** Last two path segments: on a narrow card the file name matters more than the directory. */
const tail = (p: unknown) => (typeof p === 'string' ? p.split('/').slice(-2).join('/') : undefined);

function describeAsk(req: PermissionRequest): { heading: string; text?: string; command?: string } {
  const i = req.input as Record<string, any>;
  if (req.kind === 'question') {
    const qs = (i.questions ?? []) as Question[];
    return { heading: qs.length > 1 ? `Claude has ${qs.length} questions` : 'Claude asks', text: qs[0]?.question };
  }
  if (req.kind === 'plan') return { heading: 'Plan ready for review' };
  if (req.kind === 'elicitation') return { heading: 'An MCP server needs input', text: req.title };
  const tool = req.toolName.startsWith('mcp__') ? req.toolName.split('__').slice(1).join(' · ') : req.toolName;
  return {
    heading: `Approve ${tool}?`,
    text: tail(i.file_path) ?? tail(i.notebook_path) ?? req.title ?? req.description,
    command: req.toolName === 'Bash' && typeof i.command === 'string' ? i.command : undefined,
  };
}

/** One question with single-choice options can be answered with one click; anything else opens the full card. */
function quickAnswers(req: PermissionRequest): Question | null {
  if (req.kind !== 'question') return null;
  const qs = ((req.input as any).questions ?? []) as Question[];
  return qs.length === 1 && !qs[0]!.multiSelect && qs[0]!.options?.length ? qs[0]! : null;
}

/** What Claude is blocked on in this session, with quick answers. Renders nothing when nothing is pending. */
export function PendingAsk({ sessionId, className }: { sessionId: string; className?: string }) {
  const requests = useStore((s) => s.pending[sessionId]);
  const projectId = useStore((s) => s.sessions[sessionId]?.projectId);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  if (!requests?.length) return null;

  const req = requests[0]!;
  const open = requests.find((r) => r.id === openId) ?? null; // closes by itself once the prompt is answered anywhere
  const ask = describeAsk(req);
  const quick = quickAnswers(req);

  async function answer(q: Question, label: string) {
    setSending(label);
    await respond(req, { decision: 'allow', answers: { [q.question]: label } });
    setSending(null);
  }

  return (
    // Cards around this are often clickable or draggable; answering here must not also open or move them.
    <div className={clsx('rounded-md border border-break/50 bg-break-soft px-2.5 py-2', className)} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1.5">
        <StatusDot status="awaiting_input" />
        <span className="hud-label text-break-ink">{ask.heading}</span>
        {requests.length > 1 && <span className="ml-auto text-[11.5px] text-break-ink">+{requests.length - 1} more</span>}
      </div>
      {ask.text && <p className="mt-1 line-clamp-3 text-[13px] font-medium text-ink">{ask.text}</p>}
      {ask.command && <pre className="porthole mt-1.5 line-clamp-2 px-2 py-1 text-[11.5px] whitespace-pre-wrap">{ask.command}</pre>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {quick?.options.map((o) => (
          <Button key={o.label} size="sm" title={o.description || undefined} busy={sending === o.label} disabled={!!sending} onClick={() => void answer(quick, o.label)}>
            {o.label}
          </Button>
        ))}
        <Button size="sm" variant={quick ? 'ghost' : 'attention'} onClick={() => setOpenId(req.id)}>
          {quick ? 'Other…' : req.kind === 'question' ? 'Answer…' : 'Review…'}
        </Button>
      </div>
      {open &&
        createPortal(
          <Dialog open onClose={() => setOpenId(null)} title="Claude is waiting on you" wide>
            <PermissionCard req={open} />
            {projectId && (
              <Link to={`/p/${projectId}/s/${sessionId}`} onClick={() => setOpenId(null)} className="mt-3 inline-block text-[13px] text-ink-2 hover:text-sky">
                Open the conversation →
              </Link>
            )}
          </Dialog>,
          document.body,
        )}
    </div>
  );
}

/** Drop-in for anything that summarises a session: the question if Claude is waiting on you, otherwise what it's doing. */
export function SessionLive({ sessionId, className }: { sessionId: string; className?: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const waiting = useStore((s) => (s.pending[sessionId]?.length ?? 0) > 0);
  if (!session) return null;
  return waiting ? <PendingAsk sessionId={sessionId} className={className} /> : <ActivityLine session={session} className={className} />;
}
