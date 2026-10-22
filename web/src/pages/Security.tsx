import {
  browserSupportsWebAuthn,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser';
import clsx from 'clsx';
import { Copy, Download, Fingerprint, KeyRound, Laptop, LogOut, Pencil, Shield, ShieldAlert, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppSettings, Passkey, SecurityEvent, SecurityEventType, SecurityOverview } from '../../../shared/protocol';
import { PageHeader, Panel, StatTile } from '../components/hud';
import { Page, Shell } from '../components/Shell';
import { Badge, Button, Dialog, Field, Input, Select } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { describeUserAgent, timeAgo } from '../lib/format';
import { toast } from '../lib/store';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
const isCancel = (e: unknown) => e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError');
const canPasskey = typeof window !== 'undefined' && browserSupportsWebAuthn();

// ---- password re-entry -------------------------------------------------------------
// Credential changes ask for the password again, so a borrowed or hijacked tab
// can't lock you out or add its own sign-in method.

function usePasswordPrompt() {
  const [req, setReq] = useState<{ title: string; action: string; resolve: (pw: string | null) => void } | null>(null);
  const [pw, setPw] = useState('');
  const ask = useCallback(
    (title: string, action: string) =>
      new Promise<string | null>((resolve) => {
        setPw('');
        setReq({ title, action, resolve });
      }),
    [],
  );
  const done = (value: string | null) => {
    req?.resolve(value);
    setReq(null);
  };
  const dialog = (
    <Dialog open={!!req} onClose={() => done(null)} title={req?.title ?? ''}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          done(pw);
        }}
      >
        <p className="text-[14px] text-ink-2">Enter your password to confirm.</p>
        <Input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Password" required />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => done(null)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!pw}>
            {req?.action}
          </Button>
        </div>
      </form>
    </Dialog>
  );
  return { ask, dialog };
}

// ---- pieces ---------------------------------------------------------------------------

/** QR rendered from the server's module matrix — dark on white, as scanners expect, in any theme. */
function QrCode({ matrix }: { matrix: boolean[][] }) {
  const n = matrix.length;
  let d = '';
  matrix.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
  return (
    <svg viewBox={`0 0 ${n} ${n}`} className="size-48 rounded-md bg-white p-1.5" shapeRendering="crispEdges" role="img" aria-label="QR code for your authenticator app">
      <path d={d} fill="#000" />
    </svg>
  );
}

function RecoveryCodes({ codes, onClose }: { codes: string[] | null; onClose: () => void }) {
  const text = codes?.join('\n') ?? '';
  return (
    <Dialog open={!!codes} onClose={onClose} title="Save your recovery codes">
      <p className="text-[14px] text-ink-2">
        If you lose your phone or passkey, each of these signs you in once. They won't be shown again — store them in a password manager.
      </p>
      <ol className="porthole mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 px-4 py-3 text-[14px]">
        {codes?.map((c) => (
          <li key={c} className="tracking-[0.06em]">
            {c}
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button icon={<Copy className="size-4" />} onClick={() => navigator.clipboard.writeText(text).then(() => toast('success', 'Copied'))}>
          Copy
        </Button>
        <Button
          icon={<Download className="size-4" />}
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([`Cloude recovery codes for ${location.host}\n\n${text}\n`], { type: 'text/plain' }));
            a.download = `cloude-recovery-codes-${location.hostname}.txt`;
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          Download
        </Button>
        <Button variant="primary" onClick={onClose}>
          I've saved them
        </Button>
      </div>
    </Dialog>
  );
}

function Row({ icon, title, meta, children }: { icon: ReactNode; title: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-ink-2">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px]">{title}</span>
        {meta && <span className="block truncate text-[12px] text-ink-3">{meta}</span>}
      </span>
      {children && <span className="flex shrink-0 items-center gap-1">{children}</span>}
    </li>
  );
}

// ---- sections ---------------------------------------------------------------------------

function TwoFactor({ data, reload, ask, showCodes }: { data: SecurityOverview; reload: () => void; ask: (t: string, a: string) => Promise<string | null>; showCodes: (c: string[]) => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: boolean[][]; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function start() {
    try {
      setSetup(await api.post('/api/auth/totp/setup'));
      setCode('');
      setPassword('');
    } catch (e) {
      toast('error', 'Could not start setup', errText(e));
    }
  }

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[]; signedOut: number }>('/api/auth/totp/enable', { code, password });
      setSetup(null);
      showCodes(r.recoveryCodes);
      toast('success', 'Two-factor authentication is on', r.signedOut ? `Signed out ${r.signedOut} other device${r.signedOut === 1 ? '' : 's'}.` : undefined);
      reload();
    } catch (err) {
      toast('error', 'Not turned on', errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function withPassword(title: string, action: string, url: string, after: (r: any) => void) {
    const pw = await ask(title, action);
    if (!pw) return;
    try {
      after(await api.post(url, { password: pw }));
      reload();
    } catch (e) {
      toast('error', `${action} failed`, errText(e));
    }
  }

  return (
    <Panel
      label="Two-factor authentication"
      right={data.totp ? <Badge tone="ok">On</Badge> : <Badge tone="break">Off</Badge>}
    >
      {data.totp ? (
        <div className="space-y-3">
          <p className="text-[14px] text-ink-2">
            Signing in needs your password and a code from your authenticator app (or a passkey).{' '}
            <span className={clsx(data.recoveryCodesLeft <= 3 && 'text-break-ink')}>{data.recoveryCodesLeft} of 10 recovery codes left.</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<KeyRound className="size-4" />} onClick={() => withPassword('New recovery codes', 'Generate', '/api/auth/recovery-codes', (r) => showCodes(r.recoveryCodes))}>
              New recovery codes
            </Button>
            <Button size="sm" variant="ghost" onClick={() => withPassword('Turn off two-factor authentication', 'Turn off', '/api/auth/totp/disable', () => toast('warning', 'Two-factor authentication is off'))}>
              Turn off
            </Button>
          </div>
        </div>
      ) : setup ? (
        <form onSubmit={enable} className="grid gap-5 sm:grid-cols-[auto_1fr]">
          <div className="flex flex-col items-center gap-2">
            <QrCode matrix={setup.qr} />
            <a href={setup.uri} className="text-[12px] text-sky hover:underline sm:hidden">
              Open in authenticator app
            </a>
          </div>
          <div className="space-y-3">
            <p className="text-[14px] text-ink-2">Scan the code with an authenticator app (1Password, Google Authenticator, Authy…), then enter the 6-digit code it shows.</p>
            <Field label="Or enter this key by hand">
              <div className="porthole flex items-center gap-2 px-3 py-2">
                <code className="min-w-0 flex-1 text-[13px] tracking-[0.08em] break-all">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
                <button type="button" aria-label="Copy key" className="text-port-dim hover:text-port-ink" onClick={() => navigator.clipboard.writeText(setup.secret).then(() => toast('success', 'Key copied'))}>
                  <Copy className="size-4" />
                </button>
              </div>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="6-digit code">
                <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" className="font-hud tracking-[0.3em]" required />
              </Field>
              <Field label="Your password">
                <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
            </div>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" busy={busy} disabled={code.length !== 6 || !password}>
                Turn on
              </Button>
              <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </div>
            <p className="text-[12px] text-ink-3">Turning this on signs out every other device.</p>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <p className="text-[14px] text-ink-2">Whoever signs in here controls the whole server. Add a second step so a leaked password isn't enough.</p>
          <Button variant="primary" icon={<ShieldCheck className="size-4" />} onClick={start}>
            Set up authenticator app
          </Button>
        </div>
      )}
    </Panel>
  );
}

function Passkeys({ data, reload, ask, showCodes }: { data: SecurityOverview; reload: () => void; ask: (t: string, a: string) => Promise<string | null>; showCodes: (c: string[]) => void }) {
  const [busy, setBusy] = useState(false);

  async function add() {
    const pw = await ask('Add a passkey', 'Continue');
    if (!pw) return;
    setBusy(true);
    try {
      const { options, challengeId } = await api.post<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }>('/api/auth/passkeys/options', { password: pw });
      const response = await startRegistration({ optionsJSON: options });
      const name = prompt('Name this passkey', describeUserAgent(navigator.userAgent))?.trim() || describeUserAgent(navigator.userAgent);
      const r = await api.post<{ passkey: Passkey; recoveryCodes?: string[]; signedOut: number }>('/api/auth/passkeys', { challengeId, response, name });
      toast('success', 'Passkey added', r.signedOut ? `${r.passkey.name} · signed out ${r.signedOut} other device${r.signedOut === 1 ? '' : 's'}` : r.passkey.name);
      if (r.recoveryCodes) showCodes(r.recoveryCodes);
      reload();
    } catch (e) {
      if (!isCancel(e)) toast('error', 'Passkey not added', errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function rename(p: Passkey) {
    const name = prompt('Rename passkey', p.name)?.trim();
    if (!name || name === p.name) return;
    await api.patch(`/api/auth/passkeys/${encodeURIComponent(p.id)}`, { name }).catch((e) => toast('error', 'Not renamed', errText(e)));
    reload();
  }

  async function remove(p: Passkey) {
    const pw = await ask(`Remove “${p.name}”`, 'Remove passkey');
    if (!pw) return;
    try {
      await api.post(`/api/auth/passkeys/${encodeURIComponent(p.id)}/remove`, { password: pw });
      toast('success', 'Passkey removed', p.name);
    } catch (e) {
      toast('error', 'Not removed', errText(e));
    }
    reload();
  }

  return (
    <Panel label={`Passkeys · ${data.passkeys.length}`} right={canPasskey && <Button size="sm" icon={<Fingerprint className="size-4" />} onClick={add} busy={busy}>Add</Button>}>
      {!canPasskey && <p className="mb-2 text-[13px] text-break-ink">This browser can't create passkeys. Passkeys also need HTTPS (or localhost).</p>}
      {data.passkeys.length === 0 ? (
        <p className="text-[14px] text-ink-2">Sign in with Face ID, Touch ID, Windows Hello or a security key — no password to type or phish. A passkey also counts as your second step.</p>
      ) : (
        <ul className="divide-y divide-line">
          {data.passkeys.map((p) => (
            <Row
              key={p.id}
              icon={<Fingerprint className="size-4" />}
              title={p.name}
              meta={`${p.deviceType === 'synced' ? 'Synced across devices' : 'This device only'} · added ${timeAgo(p.createdAt)} · ${p.lastUsedAt ? `used ${timeAgo(p.lastUsedAt)}` : 'never used'}`}
            >
              <button aria-label={`Rename ${p.name}`} className="rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink" onClick={() => rename(p)}>
                <Pencil className="size-4" />
              </button>
              <button aria-label={`Remove ${p.name}`} className="rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-bad" onClick={() => remove(p)}>
                <Trash2 className="size-4" />
              </button>
            </Row>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Devices({ data, reload }: { data: SecurityOverview; reload: () => void }) {
  const others = data.sessions.filter((s) => !s.current).length;
  async function revoke(id: string, current: boolean) {
    if (current && !confirm('Sign out of this browser?')) return;
    await api.del(`/api/auth/sessions/${id}`).catch((e) => toast('error', 'Not signed out', errText(e)));
    if (current) location.href = '/login';
    else reload();
  }
  return (
    <Panel
      label={`Signed-in devices · ${data.sessions.length}`}
      right={
        others > 0 && (
          <Button
            size="sm"
            variant="ghost"
            icon={<LogOut className="size-4" />}
            onClick={async () => {
              if (!confirm(`Sign out ${others} other device${others === 1 ? '' : 's'}?`)) return;
              await api.post('/api/auth/sessions/revoke-others').catch((e) => toast('error', 'Failed', errText(e)));
              reload();
            }}
          >
            Sign out others
          </Button>
        )
      }
    >
      <ul className="divide-y divide-line">
        {data.sessions.map((s) => {
          const mobile = /iPhone|Android|iPad/.test(s.userAgent ?? '');
          return (
            <Row
              key={s.id}
              icon={mobile ? <Smartphone className="size-4" /> : <Laptop className="size-4" />}
              title={
                <span className="flex items-center gap-2">
                  {describeUserAgent(s.userAgent)}
                  {s.current && <Badge tone="sky">This device</Badge>}
                </span>
              }
              meta={`${s.ip ?? 'unknown IP'} · ${s.method === 'password' ? 'password' : s.method === 'passkey' ? 'passkey' : s.method === 'totp' ? 'password + code' : 'recovery code'} · active ${timeAgo(s.lastSeenAt)} · signed in ${timeAgo(s.createdAt)}`}
            >
              <Button size="sm" variant="ghost" onClick={() => revoke(s.id, s.current)}>
                Sign out
              </Button>
            </Row>
          );
        })}
      </ul>
    </Panel>
  );
}

function Password({ changedAt }: { changedAt: number | null }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = again.length > 0 && again !== next;
  return (
    <Panel label="Password" right={changedAt && <span className="hud-label">changed {timeAgo(changedAt)}</span>}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (mismatch) return;
          setBusy(true);
          try {
            const r = await api.put<{ signedOut: number }>('/api/auth/password', { currentPassword: cur, newPassword: next });
            setCur('');
            setNext('');
            setAgain('');
            toast('success', 'Password changed', r.signedOut ? `Signed out ${r.signedOut} other device${r.signedOut === 1 ? '' : 's'}.` : undefined);
          } catch (er) {
            toast('error', 'Password not changed', errText(er));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} placeholder="Current password" aria-label="Current password" required />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password (10+ characters)" aria-label="New password" minLength={10} required />
          <Input
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            placeholder="Repeat new password"
            aria-label="Repeat new password"
            aria-invalid={mismatch}
            className={clsx(mismatch && 'border-bad')}
            required
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-3">{mismatch ? <span className="text-bad">The new passwords don't match.</span> : 'Changing it signs out every other device.'}</span>
          <Button type="submit" busy={busy} disabled={mismatch}>
            Change password
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function IdleTimeout() {
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    api.get<{ settings: AppSettings }>('/api/settings').then((r) => setDays(r.settings.sessionIdleDays));
  }, []);
  if (days === null) return null;
  return (
    <Panel label="Automatic sign-out">
      <Field label="Sign a device out after it has been inactive for" hint="Every login also expires 30 days after it was created.">
        <Select
          value={days}
          className="w-full sm:w-56"
          onChange={async (e) => {
            const v = Number(e.target.value);
            setDays(v);
            await api.put('/api/settings', { sessionIdleDays: v }).catch((er) => toast('error', 'Not saved', errText(er)));
            toast('success', 'Saved');
          }}
        >
          {[1, 3, 7, 14, 30].map((d) => (
            <option key={d} value={d}>
              {d === 1 ? '1 day' : `${d} days`}
            </option>
          ))}
        </Select>
      </Field>
    </Panel>
  );
}

const EVENT_TEXT: Record<SecurityEventType, { label: string; tone: 'ok' | 'bad' | 'break' | 'neutral' }> = {
  login_success: { label: 'Signed in', tone: 'ok' },
  passkey_login: { label: 'Signed in with a passkey', tone: 'ok' },
  login_failure: { label: 'Failed sign-in', tone: 'bad' },
  mfa_failure: { label: 'Wrong second-step code', tone: 'bad' },
  lockout: { label: 'Sign-in locked', tone: 'bad' },
  reauth_failure: { label: 'Wrong password on a settings change', tone: 'bad' },
  logout: { label: 'Signed out', tone: 'neutral' },
  session_revoked: { label: 'Device signed out', tone: 'neutral' },
  password_changed: { label: 'Password changed', tone: 'break' },
  totp_enabled: { label: 'Two-factor turned on', tone: 'ok' },
  totp_disabled: { label: 'Two-factor turned off', tone: 'break' },
  recovery_codes_generated: { label: 'New recovery codes', tone: 'break' },
  recovery_code_used: { label: 'Recovery code used', tone: 'break' },
  passkey_added: { label: 'Passkey added', tone: 'break' },
  passkey_removed: { label: 'Passkey removed', tone: 'break' },
  account_created: { label: 'Account created in setup', tone: 'break' },
};

function eventDetail(e: SecurityEvent): string | null {
  const d = e.detail ?? {};
  if (typeof d.username === 'string' && d.username) return `as “${d.username}”`;
  if (typeof d.name === 'string') return d.name;
  if (typeof d.ms === 'number') return `for ${Math.round(d.ms / 60000)} min`;
  if (typeof d.remaining === 'number') return `${d.remaining} left`;
  if (d.newDevice) return 'new device';
  return null;
}

function SecurityLog() {
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [more, setMore] = useState(true);
  const load = async (before?: number) => {
    const r = await api.get<{ events: SecurityEvent[] }>(`/api/auth/events?limit=50${before ? `&before=${before}` : ''}`);
    setEvents((cur) => (before ? [...cur, ...r.events] : r.events));
    setMore(r.events.length === 50);
  };
  useEffect(() => {
    void load();
  }, []);
  const failures24h = events.filter((e) => (e.type === 'login_failure' || e.type === 'mfa_failure') && Date.now() - e.createdAt < 86400_000).length;
  return (
    <Panel label="Security log" right={failures24h > 0 && <span className="annun" data-lit="caution">{failures24h} failed · 24h</span>} bodyClassName="p-0">
      <ul className="divide-y divide-line">
        {events.length === 0 && <li className="px-3.5 py-6 text-center text-[13px] text-ink-3">Nothing logged yet.</li>}
        {events.map((e) => {
          const t = EVENT_TEXT[e.type] ?? { label: e.type, tone: 'neutral' as const };
          const detail = eventDetail(e);
          return (
            <li key={e.id} className="flex items-center gap-3 px-3.5 py-2">
              <span className={clsx('size-1.5 shrink-0 rounded-full', t.tone === 'ok' ? 'bg-ok' : t.tone === 'bad' ? 'bg-bad' : t.tone === 'break' ? 'bg-break' : 'bg-line-strong')} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px]">
                  {t.label}
                  {detail && <span className="text-ink-3"> · {detail}</span>}
                </span>
                <span className="block truncate text-[11.5px] text-ink-3">
                  {e.ip ?? '—'} · {describeUserAgent(e.userAgent)}
                </span>
              </span>
              <span className="shrink-0 text-[12px] text-ink-3" title={new Date(e.createdAt).toLocaleString()}>
                {timeAgo(e.createdAt)}
              </span>
            </li>
          );
        })}
      </ul>
      {more && events.length > 0 && (
        <button className="w-full border-t border-line py-2.5 text-[12.5px] text-ink-3 hover:text-ink" onClick={() => void load(events[events.length - 1]!.id)}>
          Show older
        </button>
      )}
    </Panel>
  );
}

export function SecurityPage() {
  const [data, setData] = useState<SecurityOverview | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const { ask, dialog } = usePasswordPrompt();
  const mounted = useRef(true);
  const reload = useCallback(() => {
    api
      .get<SecurityOverview>('/api/auth/security')
      .then((d) => mounted.current && setData(d))
      .catch(() => {});
  }, []);
  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  const protectedBy = data ? [data.totp && 'authenticator app', data.passkeys.length > 0 && 'passkey'].filter(Boolean) : [];

  return (
    <Shell>
      <Page>
        <PageHeader title="Security" subtitle="Who can sign in to this server, how, and from where." />
        {data && (
          <>
            <section className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Status">
              <StatTile
                label="Second step"
                value={
                  <span className={clsx('flex items-center gap-2', protectedBy.length ? 'text-ok' : 'text-break')}>
                    {protectedBy.length ? <ShieldCheck className="size-6" /> : <ShieldAlert className="size-6" />}
                    {protectedBy.length ? 'On' : 'Off'}
                  </span>
                }
                sub={protectedBy.length ? protectedBy.join(' + ') : 'Password only'}
              />
              <StatTile label="Signed-in devices" value={data.sessions.length} sub={data.sessions.length > 1 ? `${data.sessions.length - 1} besides this one` : 'Just this one'} />
              <StatTile label="Passkeys" value={data.passkeys.length} sub={data.passkeys.length ? 'Phishing-resistant sign-in' : 'None yet'} />
            </section>
            <TwoFactor data={data} reload={reload} ask={ask} showCodes={setCodes} />
            <Passkeys data={data} reload={reload} ask={ask} showCodes={setCodes} />
            <Devices data={data} reload={reload} />
            <Password changedAt={data.passwordChangedAt} />
            <IdleTimeout />
            <SecurityLog />
          </>
        )}
        {!data && (
          <div className="flex items-center gap-2 text-ink-3">
            <Shield className="size-4" /> Loading…
          </div>
        )}
      </Page>
      {dialog}
      <RecoveryCodes codes={codes} onClose={() => setCodes(null)} />
    </Shell>
  );
}
