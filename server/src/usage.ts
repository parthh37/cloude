import type { ModelUsage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { BudgetPeriod, RateLimitState, RateLimitWindow, UsageEventRow, UsageLive, UsageRange, UsageReport, UsageTotals } from '../../shared/protocol.js';
import { db, kv, now, tx } from './db.js';
import { hub } from './hub.js';
import { settings } from './settings.js';
import { HttpError } from './util/paths.js';

/**
 * Usage ledger.
 *
 * The SDK reports `modelUsage` as running totals per query() process — and a
 * resumed process starts from whatever its transcript saved, while /clear
 * starts again from zero. So we never sum results: we keep the last cumulative
 * snapshot per session and write only the difference, treating any counter
 * that went *down* as a reset (the same rule Prometheus uses for counters).
 */

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

interface Counters {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  webSearches: number;
  cost: number;
}
type Snapshot = Record<string, Counters>;

const ZERO: Counters = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, cost: 0 };
const FIELDS = Object.keys(ZERO) as (keyof Counters)[];

function toSnapshot(modelUsage: Record<string, ModelUsage> | undefined): Snapshot {
  const out: Snapshot = {};
  for (const [model, u] of Object.entries(modelUsage ?? {})) {
    out[model] = {
      input: u.inputTokens ?? 0,
      output: u.outputTokens ?? 0,
      cacheRead: u.cacheReadInputTokens ?? 0,
      cacheWrite: u.cacheCreationInputTokens ?? 0,
      webSearches: u.webSearchRequests ?? 0,
      cost: u.costUSD ?? 0,
    };
  }
  return out;
}

function counterDelta(cur: Counters, prev: Counters | undefined): Counters {
  if (!prev) return cur;
  const reset = FIELDS.some((f) => cur[f] < prev[f] - 1e-9);
  if (reset) return cur;
  const d = { ...ZERO };
  for (const f of FIELDS) d[f] = cur[f] - prev[f];
  return d;
}

/**
 * Record one `result` for a session. Returns the new snapshot to persist on the
 * session row and the cost added by this turn.
 */
export function recordTurn(
  sessionId: string,
  projectId: string,
  snapshotRaw: string,
  modelUsage: Record<string, ModelUsage> | undefined,
): { snapshot: string; costDelta: number } {
  const cur = toSnapshot(modelUsage);
  const next = JSON.stringify(cur);
  // Sessions from before the ledger existed: their transcript totals were already
  // counted (migrated as one lump), so adopt them as the baseline silently.
  if (snapshotRaw === 'legacy') return { snapshot: next, costDelta: 0 };
  let prev: Snapshot = {};
  try {
    prev = JSON.parse(snapshotRaw || '{}');
  } catch {
    /* corrupt snapshot — treat as empty */
  }
  const t = now();
  let costDelta = 0;
  const ins = db.prepare(
    `INSERT INTO usage_events (created_at, session_id, project_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_searches, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  tx(() => {
    for (const [model, c] of Object.entries(cur)) {
      const d = counterDelta(c, prev[model]);
      if (FIELDS.every((f) => d[f] === 0)) continue;
      ins.run(t, sessionId, projectId, model, d.input, d.output, d.cacheRead, d.cacheWrite, d.webSearches, d.cost);
      costDelta += d.cost;
    }
  });
  if (costDelta > 0 || Object.keys(cur).length) schedulePush();
  return { snapshot: next, costDelta };
}

// ---- aggregation ----------------------------------------------------------------------

const TOTALS_SQL = `COALESCE(SUM(cost_usd), 0) AS costUsd, COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens, COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens, COUNT(*) AS turns`;

export const tokensOf = (t: Pick<UsageTotals, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>) =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;

function totalsBetween(from: number, to: number): UsageTotals {
  return db.prepare(`SELECT ${TOTALS_SQL} FROM usage_events WHERE created_at >= ? AND created_at < ?`).get(from, to) as unknown as UsageTotals;
}

const startOfUtcDay = (t: number) => Math.floor(t / DAY) * DAY;
function startOfUtcMonth(t: number) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function startOfNextUtcMonth(t: number) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

const RANGES: Record<UsageRange, { ms: number; bucket: 'hour' | 'day' }> = {
  '24h': { ms: DAY, bucket: 'hour' },
  '7d': { ms: 7 * DAY, bucket: 'day' },
  '30d': { ms: 30 * DAY, bucket: 'day' },
  '90d': { ms: 90 * DAY, bucket: 'day' },
};

export function usageReport(range: UsageRange): UsageReport {
  const spec = RANGES[range] ?? RANGES['7d'];
  const size = spec.bucket === 'hour' ? HOUR : DAY;
  // Whole UTC hours/days, ending with the bucket we're in now.
  const to = Math.floor(now() / size) * size + size;
  const from = to - spec.ms;
  const buckets = Math.round(spec.ms / size);

  const series = Array.from({ length: buckets }, (_, i) => ({ t: from + i * size, costUsd: 0, tokens: 0, byModel: {} as Record<string, number> }));
  const rows = db
    .prepare(
      `SELECT CAST((created_at - ?) / ? AS INTEGER) AS b, model, SUM(cost_usd) AS cost,
              SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens
       FROM usage_events WHERE created_at >= ? AND created_at < ? GROUP BY b, model`,
    )
    .all(from, size, from, to) as { b: number; model: string; cost: number; tokens: number }[];
  for (const r of rows) {
    const s = series[r.b];
    if (!s) continue;
    s.costUsd += r.cost;
    s.tokens += r.tokens;
    s.byModel[r.model] = (s.byModel[r.model] ?? 0) + r.cost;
  }

  const models = db
    .prepare(`SELECT model, ${TOTALS_SQL} FROM usage_events WHERE created_at >= ? AND created_at < ? GROUP BY model ORDER BY costUsd DESC`)
    .all(from, to) as unknown as UsageReport['models'];
  const projects = db
    .prepare(
      `SELECT u.project_id AS projectId, p.name AS name, ${TOTALS_SQL.replace(/\b(cost_usd|input_tokens|output_tokens|cache_read_tokens|cache_write_tokens)\b/g, 'u.$1')}
       FROM usage_events u LEFT JOIN projects p ON p.id = u.project_id
       WHERE u.created_at >= ? AND u.created_at < ? GROUP BY u.project_id ORDER BY costUsd DESC`,
    )
    .all(from, to) as unknown as UsageReport['projects'];
  const sessionRows = db
    .prepare(
      `SELECT u.session_id AS sessionId, u.project_id AS projectId, s.title AS title, MAX(u.created_at) AS lastAt,
              ${TOTALS_SQL.replace(/\b(cost_usd|input_tokens|output_tokens|cache_read_tokens|cache_write_tokens)\b/g, 'u.$1')}
       FROM usage_events u LEFT JOIN sessions s ON s.id = u.session_id
       WHERE u.created_at >= ? AND u.created_at < ? GROUP BY u.session_id ORDER BY costUsd DESC LIMIT 15`,
    )
    .all(from, to) as unknown as UsageReport['sessions'];

  return {
    range,
    from,
    to,
    bucket: spec.bucket,
    totals: totalsBetween(from, to),
    previous: totalsBetween(from - spec.ms, from),
    series,
    models,
    projects,
    sessions: sessionRows,
  };
}

export function recentUsage(limit = 15): UsageEventRow[] {
  return db
    .prepare(
      `SELECT u.id, u.created_at AS at, u.session_id AS sessionId, u.project_id AS projectId, s.title AS title, u.model,
              u.cost_usd AS costUsd, (u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) AS tokens
       FROM usage_events u LEFT JOIN sessions s ON s.id = u.session_id ORDER BY u.id DESC LIMIT ?`,
    )
    .all(Math.min(limit, 100)) as unknown as UsageEventRow[];
}

// ---- budgets ----------------------------------------------------------------------------

function period(kind: 'day' | 'month', spentUsd: number, limitUsd: number | null, warnPercent: number, resetsAt: number): BudgetPeriod {
  const percent = limitUsd ? (spentUsd / limitUsd) * 100 : null;
  const state = percent === null ? 'ok' : percent >= 100 ? 'over' : percent >= warnPercent ? 'warn' : 'ok';
  return { period: kind, spentUsd, limitUsd, percent, state, resetsAt };
}

export function budgetState(): UsageLive['budget'] {
  const s = settings.get();
  const t = now();
  const dayStart = startOfUtcDay(t);
  const monthStart = startOfUtcMonth(t);
  return {
    day: period('day', totalsBetween(dayStart, t + 1).costUsd, s.budgetDailyUsd, s.budgetWarnPercent, dayStart + DAY),
    month: period('month', totalsBetween(monthStart, t + 1).costUsd, s.budgetMonthlyUsd, s.budgetWarnPercent, startOfNextUtcMonth(t)),
    enforce: s.budgetEnforce,
    warnPercent: s.budgetWarnPercent,
  };
}

/** Called before a new user message. Turns already running are never interrupted. */
export function assertWithinBudget() {
  if (!settings.get().budgetEnforce) return;
  const b = budgetState();
  const over = [b.day, b.month].find((p) => p.state === 'over');
  if (!over) return;
  const which = over.period === 'day' ? 'Daily' : 'Monthly';
  const when = over.period === 'day' ? '00:00 UTC' : 'the 1st (UTC)';
  throw new HttpError(402, `${which} budget of $${over.limitUsd?.toFixed(2)} reached. Raise it in Usage → Budgets, or wait until ${when}.`);
}

/** One notification per period per state (warn, then over). */
function checkBudgetAlerts(b: UsageLive['budget']) {
  for (const p of [b.day, b.month]) {
    if (p.state === 'ok') continue;
    const key = `usage.alert.${p.period}`;
    const last = kv.get<{ resetsAt: number; state: string }>(key);
    if (last && last.resetsAt === p.resetsAt && (last.state === p.state || last.state === 'over')) continue;
    kv.set(key, { resetsAt: p.resetsAt, state: p.state });
    const label = p.period === 'day' ? 'Daily' : 'Monthly';
    hub.broadcast({
      t: 'notify',
      level: p.state === 'over' ? 'error' : 'warning',
      title: p.state === 'over' ? `${label} budget reached` : `${label} budget ${Math.floor(p.percent ?? 0)}% used`,
      body: `$${p.spentUsd.toFixed(2)} of $${p.limitUsd?.toFixed(2)}${p.state === 'over' && b.enforce ? ' · new messages are paused' : ''}`,
    });
  }
}

// ---- Claude plan limits (Pro / Max) ---------------------------------------------------------

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5-hour session',
  seven_day: 'Weekly · all models',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  seven_day_oauth_apps: 'Weekly · apps',
  seven_day_overage_included: 'Weekly · incl. extra usage',
  overage: 'Extra usage',
};

const EMPTY_LIMITS: RateLimitState = { available: false, subscription: null, status: null, windows: [], updatedAt: null };
let limits: RateLimitState = kv.get<RateLimitState>('usage.limits') ?? EMPTY_LIMITS;

const severityOf = (pct: number | null, status?: string): RateLimitWindow['severity'] =>
  status === 'rejected' || (pct ?? 0) >= 95 ? 'critical' : status === 'allowed_warning' || (pct ?? 0) >= 75 ? 'warning' : 'normal';

/** Epoch ms from seconds, ms, or an ISO string. */
function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function upsertWindow(w: RateLimitWindow) {
  const windows = limits.windows.filter((x) => x.kind !== w.kind).concat(w);
  const order = Object.keys(LIMIT_LABELS);
  windows.sort((a, b) => (order.indexOf(a.kind) + 1 || 99) - (order.indexOf(b.kind) + 1 || 99));
  limits = { ...limits, available: true, windows, updatedAt: now() };
}

function saveLimits() {
  kv.set('usage.limits', limits);
  schedulePush();
}

/** `rate_limit_event` from any session. Its `utilization` is a 0–1 fraction (usage reports use 0–100). */
export function ingestRateLimitEvent(info: SDKRateLimitInfo) {
  const kind = info.rateLimitType ?? 'five_hour';
  const prev = limits.windows.find((w) => w.kind === kind);
  const pct = typeof info.utilization === 'number' ? Math.min(100, info.utilization <= 1 ? info.utilization * 100 : info.utilization) : (prev?.percent ?? null);
  upsertWindow({ kind, label: LIMIT_LABELS[kind] ?? kind, percent: pct, resetsAt: toMs(info.resetsAt) ?? prev?.resetsAt ?? null, severity: severityOf(pct, info.status) });
  limits.status = info.status;
  saveLimits();
  if (info.status === 'rejected') {
    hub.broadcast({ t: 'notify', level: 'error', title: 'Claude plan limit reached', body: `${LIMIT_LABELS[kind] ?? kind} — resets ${new Date(toMs(info.resetsAt) ?? now()).toUTCString()}` });
  }
}

/**
 * The experimental /usage control request: authoritative plan utilisation.
 * Parsed defensively — its shape is explicitly unstable.
 */
export function ingestUsageResponse(resp: unknown) {
  const r = resp as { subscription_type?: string | null; rate_limits_available?: boolean; rate_limits?: Record<string, unknown> | null } | null;
  if (!r || typeof r !== 'object') return;
  if (r.rate_limits_available === false) {
    if (limits.available) {
      limits = { ...EMPTY_LIMITS, updatedAt: now() };
      saveLimits();
    }
    return;
  }
  limits.subscription = r.subscription_type ?? limits.subscription;
  for (const [kind, v] of Object.entries(r.rate_limits ?? {})) {
    const w = v as { utilization?: number | null; resets_at?: string | null } | null;
    if (!w || typeof w !== 'object' || !('utilization' in w)) continue;
    const pct = typeof w.utilization === 'number' ? Math.min(100, w.utilization) : null;
    upsertWindow({ kind, label: LIMIT_LABELS[kind] ?? kind.replace(/_/g, ' '), percent: pct, resetsAt: toMs(w.resets_at), severity: severityOf(pct, limits.status ?? undefined) });
  }
  saveLimits();
}

export const rateLimits = () => limits;

// ---- live push ----------------------------------------------------------------------------

export function usageLive(): UsageLive {
  const t = now();
  const budget = budgetState();
  return {
    today: totalsBetween(startOfUtcDay(t), t + 1),
    month: totalsBetween(startOfUtcMonth(t), t + 1),
    budget,
    limits,
    recent: recentUsage(12),
  };
}

let pushTimer: NodeJS.Timeout | null = null;
function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const live = usageLive();
    checkBudgetAlerts(live.budget);
    hub.broadcast({ t: 'usage', usage: live });
  }, 750);
}

/** Settings changed (e.g. a new budget): re-evaluate and push. */
export const refreshUsage = schedulePush;
