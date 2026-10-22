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
