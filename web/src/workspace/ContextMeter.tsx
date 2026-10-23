import clsx from 'clsx';
import { useState } from 'react';
import type { Session, SessionContext } from '../../../shared/protocol';
import { Button } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { compact } from '../lib/format';
import { toast } from '../lib/store';

/** How loudly the meter speaks: plain ink, `break` amber ("needs you"), or `bad` red. */
export type ContextTone = 'calm' | 'filling' | 'critical';

/**
 * When should the context meter ask for attention?
 *
 * `ctx.tokens / ctx.window` is how full the window is; `ctx.compactAt` is where
 * Claude Code will compact by itself (null when auto-compact is off, see
 * `ctx.autoCompact`). Amber and red mean "you may need to act", so they should
 * only light up when the user actually has a decision to make.
 */
export function contextTone(ctx: SessionContext): ContextTone {
  // TODO(you): map the fill level to a tone. See the trade-offs in the chat.
  void ctx;
  return 'calm';
}

const TONE_CLASS: Record<ContextTone | 'compacting', string> = {
  calm: 'text-ink-3 hover:text-ink-2',
  filling: 'text-break-ink',
  critical: 'text-bad',
  compacting: 'text-dawn-ink',
};

const R = 7;
const C = 2 * Math.PI * R;

/** Point `share` of the way round the ring, clockwise like the arc; the SVG is turned -90° so 0 shows at the top. */
const onRing = (share: number, r: number) => [9 + r * Math.cos(share * 2 * Math.PI), 9 + r * Math.sin(share * 2 * Math.PI)];

export function ContextMeter({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const ctx = session.context;
  if (!ctx || ctx.window <= 0) return null;

  const share = ctx.tokens / ctx.window;
  const percent = Math.round(share * 100);
  const at = ctx.compactAt ? ctx.compactAt / ctx.window : null;
  const compacting = session.activity?.kind === 'compacting';
  const tone = compacting ? 'compacting' : contextTone(ctx);
  // Mid-turn it would only queue behind the running turn, so offer it between turns.
  const canCompact = !compacting && !sending && (session.status === 'idle' || session.status === 'error');

  async function compactNow() {
    setSending(true);
    try {
      await api.post(`/api/sessions/${session.id}/messages`, { text: '/compact' });
      setOpen(false);
    } catch (e) {
      toast('error', 'Could not compact', e instanceof ApiError ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  const [x1, y1] = at === null ? [0, 0] : onRing(at, R - 2.5);
  const [x2, y2] = at === null ? [0, 0] : onRing(at, R + 2);

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`Context ${percent}% full`}
        title={compacting ? 'Compacting the conversation' : `Context ${percent}% full`}
        className={clsx('inline-flex h-8 items-center gap-1 rounded-lg px-1.5 font-mono text-[12px] tabular-nums', TONE_CLASS[tone])}
      >
        <svg viewBox="0 0 18 18" className={clsx('size-[18px] -rotate-90', compacting && 'motion-safe:animate-spin')} aria-hidden>
          <circle cx="9" cy="9" r={R} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth="2" />
          <circle cx="9" cy="9" r={R} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${Math.min(1, share) * C} ${C}`} />
          {at !== null && <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth="1.25" />}
        </svg>
        <span className="hidden sm:inline">{percent}%</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 z-30 mt-1 w-72 space-y-3 rounded-xl border border-line bg-surface p-3 shadow-cloud">
            <div>
              <p className="text-xs font-medium text-ink-2">Context window</p>
              <p className="mt-0.5 font-mono text-sm tabular-nums">
                {compact(ctx.tokens)} / {compact(ctx.window)} tokens · {percent}%
              </p>
              <div className="relative mt-2 h-1.5 rounded-full bg-line">
                <div className={clsx('h-full rounded-full bg-current', TONE_CLASS[tone])} style={{ width: `${Math.min(100, share * 100)}%` }} />
                {at !== null && <div className="absolute -top-0.5 h-2.5 w-px bg-ink-2" style={{ left: `${at * 100}%` }} title="Auto-compact point" />}
              </div>
            </div>
            <p className="text-xs text-ink-3">
              {compacting
                ? 'Compacting now: Claude is summarising the conversation so far.'
                : ctx.autoCompact && ctx.compactAt
                  ? `Compacts by itself at ${compact(ctx.compactAt)} tokens (${Math.round((at ?? 0) * 100)}%).`
                  : 'Auto-compact is off (Settings → New session defaults), so once the window is full Claude can’t continue until you compact.'}{' '}
              Compacting summarises older turns so Claude can keep going; the full history stays here.
            </p>
            <Button size="sm" onClick={compactNow} disabled={!canCompact} busy={sending} className="w-full">
              Compact now
            </Button>
            {!canCompact && !compacting && !sending && <p className="text-xs text-ink-3">Available once Claude finishes this turn.</p>}
          </div>
        </>
      )}
    </div>
  );
}
