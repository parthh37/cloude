import type { PermissionMode, SessionStatus } from '../../../shared/protocol';

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export const money = (usd: number) => (usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`);

export function duration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: 'Idle',
  starting: 'Starting',
  running: 'Working',
  awaiting_input: 'Needs you',
  error: 'Error',
};

/** Models offered as the default for new sessions. */
export const DEFAULT_MODELS = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
];

export const MODE_LABEL: Record<PermissionMode, { label: string; hint: string }> = {
  default: { label: 'Ask first', hint: 'Approve edits and commands in the browser' },
  acceptEdits: { label: 'Auto-edit', hint: 'File edits apply automatically; commands still ask' },
  plan: { label: 'Plan', hint: 'Claude researches and proposes a plan without changing anything' },
  auto: { label: 'Auto', hint: 'A classifier approves routine actions and asks about risky ones' },
  bypassPermissions: { label: 'Full access', hint: 'Everything runs without asking (publishing still asks)' },
  dontAsk: { label: 'Never ask', hint: 'Anything not pre-approved is denied instead of asking' },
};

export function shortPath(p: string, root?: string) {
  let s = p;
  if (root && s.startsWith(root + '/')) s = s.slice(root.length + 1);
  return s;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// ---- telemetry formatting ---------------------------------------------------------

/** 1,284 · 12.9K · 3.4M · 1.2B */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a < 1000) return Math.round(n).toLocaleString();
  const [d, s] = a < 1e6 ? [1e3, 'K'] : a < 1e9 ? [1e6, 'M'] : [1e9, 'B'];
  const v = n / d;
  return `${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}${s}`;
}

/** Dollar amounts with precision that matches their size: $123 · $4.82 · $0.034 */
export function usd(n: number): string {
  if (n === 0) return '$0';
  const a = Math.abs(n);
  if (a >= 100) return `$${n.toFixed(0)}`;
  if (a >= 0.1) return `$${n.toFixed(2)}`;
  if (a >= 0.001) return `$${n.toFixed(3)}`;
  return '<$0.001';
}

export const rate = (bytesPerSec: number) => `${bytes(Math.round(bytesPerSec))}/s`;

/** Seconds → "3d 4h" / "5h 12m" / "12m" / "40s" */
export function span(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/** Signed % change vs the previous period. */
export function changeVs(cur: number, prev: number): string | null {
  if (!prev) return cur ? 'new' : null;
  const p = ((cur - prev) / prev) * 100;
  if (Math.abs(p) < 0.5) return '±0%';
  return `${p > 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(Math.abs(p) < 10 ? 1 : 0)}%`;
}

export const utcTime = (t: number) => new Date(t).toISOString().slice(11, 16);
export const utcDay = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Chrome on macOS" */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

// ---- model identity (fixed colour slots, never by rank) ----------------------------

const MODEL_SLOTS = [
  { key: 'opus-5-5', test: /opus-5-5/, label: 'Opus 5.5', color: 'var(--series-1)' },
  { key: 'sonnet-5-5', test: /sonnet-5-5/, label: 'Sonnet 5.5', color: 'var(--series-2)' },
  { key: 'haiku-5-5', test: /haiku-5-5/, label: 'Haiku 5.5', color: 'var(--series-3)' },
  { key: 'fable-5-1', test: /fable-5-1/, label: 'Fable 5.1', color: 'var(--series-4)' },
];
export const OTHER_MODEL = { key: 'other', label: 'Other models', color: 'var(--series-other)' };
export const MODEL_KEYS = [...MODEL_SLOTS.map(({ key, label, color }) => ({ key, label, color })), OTHER_MODEL];

export function modelSlot(model: string): { key: string; label: string; color: string } {
  const m = MODEL_SLOTS.find((s) => s.test.test(model));
  return m ? { key: m.key, label: m.label, color: m.color } : OTHER_MODEL;
}

/** Human name for any model id: claude-sonnet-5 → Sonnet 5 */
export function modelName(model: string): string {
  const slot = MODEL_SLOTS.find((s) => s.test.test(model));
  if (slot) return slot.label;
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : model;
}
