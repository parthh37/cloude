import type { Options, Query, SDKControlGetContextUsageResponse, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionContext } from '../../../shared/protocol.js';
import { hub } from '../hub.js';
import { settings } from '../settings.js';

/**
 * Conversation compaction.
 *
 * Claude Code compacts on its own: as the context window nears its limit it
 * summarises the conversation and carries on from the summary (auto-compact),
 * and `/compact` does the same on demand. Cloude doesn't re-implement any of it;
 * this module makes it controllable and visible from the browser:
 *
 *  - applyCompaction(): the Settings switch and compaction window, applied to
 *    every new Claude process.
 *  - CompactionWatcher: keeps the SessionContext snapshot behind the context
 *    meter, puts a failed compaction in the timeline (the SDK only reports it on
 *    a live-only status message), and tells the session when a compaction ends.
 *
 * Cloude's own event log is never compacted: the browser keeps the whole
 * conversation, only what the model sees is summarised.
 */

/**
 * Precedence, as measured against the CLI: env > flag-layer settings > settings
 * files. So the global window set here still yields to a routing provider's
 * `extraEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW }` (a gateway model with another
 * window), while the on/off switch is made authoritative by also fixing the env.
 */
export function applyCompaction(options: Options) {
  const s = settings.get();
  const env = { ...options.env };
  if (s.autoCompact) delete env.DISABLE_AUTO_COMPACT;
  else env.DISABLE_AUTO_COMPACT = '1'; // `/compact` keeps working; only DISABLE_COMPACT would stop that
  options.env = env;
  if (typeof options.settings === 'string') return; // a settings file path: not ours to merge into
  options.settings = {
    ...options.settings,
    autoCompactEnabled: s.autoCompact,
    ...(s.autoCompactWindow ? { autoCompactWindow: s.autoCompactWindow } : {}),
  };
}

/** While Claude works, the context meter is refreshed at most this often. */
const REFRESH_MS = 10_000;
/** A compaction that never reported its end (process died mid-way) stops blocking idle shutdown after this. */
const STUCK_MS = 10 * 60_000;

export interface CompactionHost {
  id(): string;
  query(): Query | null;
  /** Put a failure in the session's timeline. */
  fail(message: string): void;
  /** The context snapshot changed visibly: rebroadcast the session (coalesced). */
  changed(): void;
  /** A compaction just ended, successfully or not. */
  settled(): void;
}

const pct = (c: SessionContext) => Math.round((c.tokens / Math.max(1, c.window)) * 100);

export class CompactionWatcher {
  context: SessionContext | null = null;
  private since = 0;
  private inflight = false;
  private again = false;
  private lastRefresh = 0;

  constructor(private host: CompactionHost) {}

  /** Claude Code is compacting right now, so its process must not be stopped for being idle. */
  get busy() {
    return this.since > 0 && Date.now() - this.since < STUCK_MS;
  }

  observe(msg: SDKMessage) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'status') {
          if (msg.status === 'compacting') this.since ||= Date.now();
          else if (this.since) this.end();
          if (msg.compact_result === 'failed') this.failed(msg.compact_error);
        } else if (msg.subtype === 'init' || msg.subtype === 'compact_boundary') {
          this.refresh(true);
        }
        return;
      case 'assistant':
        if (!msg.parent_tool_use_id) this.refresh(false); // subagents have windows of their own
        return;
      case 'result':
      case 'conversation_reset':
        this.refresh(true);
        return;
    }
  }

  private end() {
    this.since = 0;
    this.refresh(true);
    this.host.settled();
  }

  private failed(error: string | undefined) {
    const message =
      `Compaction failed${error ? `: ${error}` : ''}.\n` +
      'The conversation is still close to the context limit. Send /compact to try again, or /clear to start over (the history above stays here).';
    this.host.fail(message);
    hub.broadcast({ t: 'notify', level: 'warning', title: 'Compaction failed', body: error, sessionId: this.host.id() });
  }

  /** `summary` answers from the last response's usage plus local estimates: no API call, so it is free and works behind gateways. */
  private refresh(force: boolean) {
    const q = this.host.query();
    if (!q) return;
    if (this.inflight) {
      this.again ||= force;
      return;
    }
    if (!force && Date.now() - this.lastRefresh < REFRESH_MS) return;
    this.inflight = true;
    this.lastRefresh = Date.now();
    q.getContextUsage({ detail: 'summary' })
      .then((u) => this.update(u), () => {}) // an older CLI or a closing process: keep the last snapshot
      .finally(() => {
        this.inflight = false;
        if (this.again) {
          this.again = false;
          this.refresh(true);
        }
      });
  }

  private update(u: SDKControlGetContextUsageResponse) {
    const next: SessionContext = {
      tokens: u.totalTokens,
      window: u.rawMaxTokens,
      autoCompact: u.isAutoCompactEnabled,
      compactAt: u.isAutoCompactEnabled ? (u.autoCompactThreshold ?? null) : null,
      model: u.model,
      at: Date.now(),
    };
    const prev = this.context;
    this.context = next;
    // Every browser gets the rebroadcast, so skip it unless something visible moved.
    const same =
      prev && pct(prev) === pct(next) && prev.window === next.window && prev.compactAt === next.compactAt && prev.autoCompact === next.autoCompact;
    if (!same) this.host.changed();
  }
}
