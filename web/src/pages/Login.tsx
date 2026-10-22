import { browserSupportsWebAuthn, startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { Fingerprint, KeyRound, LockKeyhole } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import type { LoginResponse } from '../../../shared/protocol';
import { bootstrap } from '../App';
import { Button, Input, Mark } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useNow } from '../lib/live';
import { useStore } from '../lib/store';

type Step = { kind: 'password' } | { kind: 'mfa'; ticket: string; methods: NonNullable<LoginResponse['mfa']>['methods']; mode: 'totp' | 'recovery' | 'passkey' };

const canPasskey = typeof window !== 'undefined' && browserSupportsWebAuthn();

/** Passkey prompts the user dismissed aren't errors worth shouting about. */
const isCancel = (e: unknown) => e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError');

export function Login() {
  const user = useStore((s) => s.user);
  const needsAdmin = useStore((s) => s.setup?.needsAdmin);
  const [params] = useSearchParams();
  const next = params.get('next') || '/';
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [busy, setBusy] = useState<'password' | 'code' | 'passkey' | null>(null);
  const now = useNow(1000);
  const codeRef = useRef<HTMLInputElement>(null);
  const locked = lockedUntil !== null && lockedUntil > now;

  useEffect(() => {
    if (step.kind === 'mfa') codeRef.current?.focus();
  }, [step]);

  if (needsAdmin) return <Navigate to="/setup" replace />;
  if (user) {
    // /api/* "next" targets (preview hand-off) are server routes, not SPA routes.
    if (next.startsWith('/api/')) window.location.href = next;
    else return <Navigate to={next} replace />;
  }

  async function finish(res: LoginResponse) {
    if (res.mfa) {
      const m = res.mfa.methods;
      setStep({ kind: 'mfa', ticket: res.mfa.ticket, methods: m, mode: m.totp ? 'totp' : m.passkey && canPasskey ? 'passkey' : 'recovery' });
      setPassword('');
      return;
    }
    if (next.startsWith('/api/')) {
      window.location.href = next;
      return;
    }
    useStore.setState({ user: res.user! });
    await bootstrap();
  }

  function fail(err: unknown) {
    if (isCancel(err)) return;
    if (err instanceof ApiError) {
      setError(err.message);
      if (err.retryAfter) setLockedUntil(Date.now() + err.retryAfter * 1000);
      // An expired second-factor ticket means starting over.
      if (err.status === 401 && /password again/.test(err.message)) setStep({ kind: 'password' });
    } else setError(err instanceof Error ? err.message : 'Could not reach the server');
  }

  async function run(kind: NonNullable<typeof busy>, fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  const submitPassword = (e: React.FormEvent) => {
    e.preventDefault();
    void run('password', async () => finish(await api.post<LoginResponse>('/api/auth/login', { username, password })));
  };

  const submitCode = (value = code) => {
    if (step.kind !== 'mfa' || step.mode === 'passkey') return;
    void run('code', async () => {
      try {
        await finish(await api.post<LoginResponse>('/api/auth/mfa', { ticket: step.ticket, method: step.mode, code: value }));
      } finally {
        setCode('');
      }
    });
  };

  const passkey = () =>
    run('passkey', async () => {
      if (step.kind === 'mfa') {
        const { options } = await api.post<{ options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/mfa/passkey/options', { ticket: step.ticket });
        const response = await startAuthentication({ optionsJSON: options });
        await finish(await api.post<LoginResponse>('/api/auth/mfa/passkey', { ticket: step.ticket, response }));
      } else {
        const { options, challengeId } = await api.post<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }>('/api/auth/passkey/options');
        const response = await startAuthentication({ optionsJSON: options });
        await finish(await api.post<LoginResponse>('/api/auth/passkey', { challengeId, response }));
      }
    });

  const lockNote = locked && (
    <p className="flex items-center gap-2 rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad" role="alert">
      <LockKeyhole className="size-4 shrink-0" />
      Sign-in is paused for {Math.ceil((lockedUntil! - now) / 1000)}s after too many failed attempts.
    </p>
  );

  return (
    <div className="hud-ground flex min-h-full flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex items-center gap-3">
          <Mark className="size-9" />
          <div className="min-w-0">
            <div className="font-display text-lg leading-tight font-bold">Cloude</div>
            <div className="hud-label truncate">{location.host}</div>
          </div>
        </div>

        <div className="rounded-xl border border-line bg-surface p-5 shadow-cloud">
          {step.kind === 'password' ? (
            <>
              <h1 className="font-display text-[20px] font-bold">Sign in</h1>
              <p className="mt-1 text-[14px] text-ink-2">This workbench controls the whole server. Sessions keep running while you're away.</p>
              <form onSubmit={submitPassword} className="mt-5 space-y-3">
                <label className="block">
                  <span className="hud-label mb-1.5 block">Username</span>
                  <Input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
                </label>
                <label className="block">
                  <span className="hud-label mb-1.5 block">Password</span>
                  <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
                </label>
                {lockNote || (error && <p className="text-[13px] text-bad" role="alert">{error}</p>)}
                <Button type="submit" variant="primary" className="w-full" busy={busy === 'password'} disabled={locked || !!busy}>
                  Sign in
                </Button>
              </form>
              {canPasskey && (
                <>
                  <div className="my-4 flex items-center gap-3">
                    <span className="h-px flex-1 bg-line" />
                    <span className="hud-label">or</span>
                    <span className="h-px flex-1 bg-line" />
                  </div>
                  <Button className="w-full" icon={<Fingerprint className="size-4" />} onClick={() => void passkey()} busy={busy === 'passkey'} disabled={locked || !!busy}>
                    Sign in with a passkey
                  </Button>
                </>
              )}
            </>
          ) : (
            <>
              <div className="hud-label mb-2 flex items-center gap-1.5 text-sky">
                <KeyRound className="size-3.5" /> Step 2 of 2
              </div>
              <h1 className="font-display text-[20px] font-bold">{step.mode === 'totp' ? 'Enter your code' : step.mode === 'passkey' ? 'Confirm with your passkey' : 'Use a recovery code'}</h1>
              <p className="mt-1 text-[14px] text-ink-2">
                {step.mode === 'totp'
                  ? 'Open your authenticator app and enter the 6-digit code for Cloude.'
                  : step.mode === 'passkey'
                    ? 'Use Face ID, Touch ID, Windows Hello or your security key.'
                    : 'Each recovery code works once. Generate new ones in Security after you sign in.'}
              </p>
              {step.mode === 'passkey' ? (
                <div className="mt-5 space-y-3">
                  {lockNote || (error && <p className="text-[13px] text-bad" role="alert">{error}</p>)}
                  <Button variant="primary" className="w-full" icon={<Fingerprint className="size-4" />} onClick={() => void passkey()} busy={busy === 'passkey'} disabled={locked || !!busy}>
                    Use passkey
                  </Button>
                </div>
              ) : (
              <form
                className="mt-5 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitCode();
                }}
              >
                <Input
                  ref={codeRef}
                  aria-label={step.mode === 'totp' ? 'Authentication code' : 'Recovery code'}
                  value={code}
                  autoComplete="one-time-code"
                  inputMode={step.mode === 'totp' ? 'numeric' : 'text'}
                  maxLength={step.mode === 'totp' ? 6 : 16}
                  placeholder={step.mode === 'totp' ? '000000' : 'xxxxx-xxxxx'}
                  className="h-12 text-center font-hud text-xl tracking-[0.35em]"
                  onChange={(e) => {
                    const v = step.mode === 'totp' ? e.target.value.replace(/\D/g, '') : e.target.value;
                    setCode(v);
                    if (step.mode === 'totp' && v.length === 6 && !busy) submitCode(v);
                  }}
                />
                {lockNote || (error && <p className="text-[13px] text-bad" role="alert">{error}</p>)}
                <Button type="submit" variant="primary" className="w-full" busy={busy === 'code'} disabled={locked || !!busy || !code}>
                  Verify
                </Button>
              </form>
              )}
              <div className="mt-4 space-y-1.5 border-t border-line pt-3.5 text-[13px]">
                {step.mode !== 'passkey' && step.methods.passkey && canPasskey && (
                  <button className="flex items-center gap-2 text-sky hover:underline" onClick={() => void passkey()} disabled={!!busy}>
                    <Fingerprint className="size-4" /> Use a passkey instead
                  </button>
                )}
                {step.mode !== 'recovery' && step.methods.recovery && (
                  <button className="block text-ink-2 hover:text-ink" onClick={() => setStep({ ...step, mode: 'recovery' })}>
                    Lost your phone? Use a recovery code
                  </button>
                )}
                {step.mode !== 'totp' && step.methods.totp && (
                  <button className="block text-ink-2 hover:text-ink" onClick={() => setStep({ ...step, mode: 'totp' })}>
                    Use the authenticator app
                  </button>
                )}
                <button
                  className="block text-ink-3 hover:text-ink"
                  onClick={() => {
                    setStep({ kind: 'password' });
                    setError(null);
                  }}
                >
                  ← Start over
                </button>
              </div>
            </>
          )}
        </div>

        <p className="mt-5 text-[12px] leading-relaxed text-ink-3">
          Forgot your password? Set <code className="font-mono">CLOUDE_ADMIN_PASSWORD</code> and <code className="font-mono">CLOUDE_RESET_ADMIN_PASSWORD=true</code>{' '}
          on the server and restart Cloude.
        </p>
      </div>
    </div>
  );
}
