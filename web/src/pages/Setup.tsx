import clsx from 'clsx';
import { ArrowLeft, ArrowRight, Bell, Check, CheckCircle2, Globe, TriangleAlert, UserRound } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router';
import type { AppSettings, PermissionMode, SetupStatus } from '../../../shared/protocol';
import { bootstrap } from '../App';
import { ClaudeConnect, ClaudeStatusBanner } from '../components/ClaudeConnect';
import { Button, Field, Input, Select, Spinner, Wordmark } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { DEFAULT_MODELS, MODE_LABEL } from '../lib/format';
import { useStore } from '../lib/store';

type StepId = 'account' | 'claude' | 'workspace' | 'finish';

const STEP_LABEL: Record<StepId, string> = { account: 'Account', claude: 'Claude', workspace: 'Workspace', finish: 'Finish' };

const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server');

/** First-run wizard. Reached automatically until it's finished; see Gate in App.tsx. */
export function Setup() {
  const user = useStore((s) => s.user);
  const authChecked = useStore((s) => s.authChecked);
  const setup = useStore((s) => s.setup);
  if (!authChecked || !setup)
    return (
      <div className="hud-ground grid h-full place-items-center text-ink-3">
        <Spinner className="size-6" />
      </div>
    );
  if (!setup.needsAdmin && !user) return <Navigate to="/login?next=/setup" replace />;
  return <Wizard needsAdmin={setup.needsAdmin} />;
}

function Wizard({ needsAdmin }: { needsAdmin: boolean }) {
  // Fixed when the wizard opens: creating the account flips needsAdmin, and the
  // step list shouldn't shift under the user when it does.
  const [steps] = useState<StepId[]>(() => (needsAdmin ? ['account', 'claude', 'workspace', 'finish'] : ['claude', 'workspace', 'finish']));
  const [index, setIndex] = useState(0);
  const step = steps[index]!;
  const next = () => setIndex((i) => Math.min(i + 1, steps.length - 1));
  // You can't go back to the account step once the account exists.
  const back = index > 0 && steps[index - 1] !== 'account' ? () => setIndex((i) => i - 1) : undefined;

  return (
    <div className="hud-ground flex min-h-full flex-col items-center px-5 py-10">
      <div className="w-full max-w-lg">
        <Wordmark className="mb-8 text-2xl" />
        <ol className="mb-6 flex items-center gap-2" aria-label="Setup progress">
          {steps.map((s, i) => (
            <li key={s} className="flex flex-1 flex-col gap-1.5" aria-current={i === index ? 'step' : undefined}>
              <span className={clsx('h-1 rounded-full', i < index ? 'bg-ok' : i === index ? 'bg-sky' : 'bg-line')} />
              <span className={clsx('text-xs', i === index ? 'font-medium text-ink' : 'text-ink-3')}>{STEP_LABEL[s]}</span>
            </li>
          ))}
        </ol>
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-cloud sm:p-6">
          {step === 'account' && <AccountStep onDone={next} />}
          {step === 'claude' && <ClaudeStep onDone={next} onBack={back} />}
          {step === 'workspace' && <WorkspaceStep onDone={next} onBack={back} />}
          {step === 'finish' && <FinishStep onBack={back} />}
        </div>
      </div>
    </div>
  );
}

function StepHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-5">
      <h1 className="font-display text-[24px] leading-tight font-semibold tracking-[-0.015em]">{title}</h1>
      {children && <p className="mt-1.5 text-sm text-ink-2">{children}</p>}
    </div>
  );
}

function Footer({ onBack, children }: { onBack?: () => void; children: ReactNode }) {
  return (
    <div className="mt-6 flex items-center justify-between gap-2 border-t border-line pt-4">
      {onBack ? (
        <Button variant="ghost" onClick={onBack} icon={<ArrowLeft className="size-4" />}>
          Back
        </Button>
      ) : (
        <span />
      )}
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

/** The setup code arrives in the link's #fragment; read it once and drop it from the address bar. */
function useCodeFromLink() {
  const [code] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('code') ?? '');
  useEffect(() => {
    if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
  return code;
}

function AccountStep({ onDone }: { onDone: () => void }) {
  const linkCode = useCodeFromLink();
  const [code, setCode] = useState(linkCode);
  const [editCode, setEditCode] = useState(!linkCode);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("The passwords don't match");
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post<{ user: { id: string; username: string } }>('/api/setup/admin', { code, username, password });
      useStore.setState({ user, setup: { needsAdmin: false, completed: false } });
      await bootstrap();
      onDone();
    } catch (err) {
      setError(message(err));
      if (err instanceof ApiError && err.status === 403) setEditCode(true);
      if (err instanceof ApiError && err.status === 409) window.location.href = '/login';
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <StepHeader title="Welcome to Cloude">
        Create the account you'll use to sign in. It has full control of this server, so pick a strong password.
      </StepHeader>
      <div className="space-y-3">
        {editCode ? (
          <Field label="Setup code" hint="Printed by the installer and in the server log. It's also saved as setup-token.txt in Cloude's data folder.">
            <Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" required />
          </Field>
        ) : (
          <div className="flex items-center gap-2 rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">
            <CheckCircle2 className="size-4 shrink-0" />
            <span className="flex-1">Setup code included in your link</span>
            <button type="button" className="text-xs underline-offset-2 hover:underline" onClick={() => setEditCode(true)}>
              Change
            </button>
          </div>
        )}
        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required />
        </Field>
        <Field label="Password" hint="10+ characters. A passphrase of a few random words works well.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required autoFocus={!editCode} />
        </Field>
        <Field label="Confirm password">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
      </div>
      <Footer>
        <Button type="submit" variant="primary" busy={busy} icon={<UserRound className="size-4" />}>
          Create account
        </Button>
      </Footer>
    </form>
  );
}

function ClaudeStep({ onDone, onBack }: { onDone: () => void; onBack?: () => void }) {
  const auth = useStore((s) => s.status?.claudeAuth);
  return (
    <>
      <StepHeader title="Connect Claude">Sessions run Claude Code on this server with your Claude plan or an API key.</StepHeader>
      <div className="mb-4">
        <ClaudeStatusBanner auth={auth} />
      </div>
      <ClaudeConnect onConnected={(claudeAuth) => useStore.setState((s) => ({ status: s.status ? { ...s.status, claudeAuth } : s.status }))} />
      <Footer onBack={onBack}>
        {auth?.configured ? (
          <Button variant="primary" onClick={onDone} icon={<ArrowRight className="size-4" />}>
            Continue
          </Button>
        ) : (
          <Button variant="ghost" onClick={onDone}>
            Skip for now
          </Button>
        )}
      </Footer>
    </>
  );
}

const GIT_KEYS = { name: ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME'], email: ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL'] } as const;

function WorkspaceStep({ onDone, onBack }: { onDone: () => void; onBack?: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [gitName, setGitName] = useState('');
  const [gitEmail, setGitEmail] = useState('');
  const [ghToken, setGhToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ settings: AppSettings }>('/api/settings')
      .then((r) => setSettings(r.settings))
      .catch((e) => setError(message(e)));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/settings', { defaultModel: settings.defaultModel, defaultPermissionMode: settings.defaultPermissionMode });
      // Git reads these env vars, so commits made by Claude carry your name without touching ~/.gitconfig.
      const env: [string, string][] = [
        ...GIT_KEYS.name.map((k) => [k, gitName.trim()] as [string, string]),
        ...GIT_KEYS.email.map((k) => [k, gitEmail.trim()] as [string, string]),
        ['GH_TOKEN', ghToken.trim()],
      ];
      for (const [key, value] of env) if (value) await api.put('/api/secrets', { key, value });
      onDone();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  if (!settings)
    return error ? (
      <p className="text-sm text-bad">{error}</p>
    ) : (
      <div className="grid place-items-center py-10 text-ink-3">
        <Spinner className="size-5" />
      </div>
    );

  return (
    <form onSubmit={save}>
      <StepHeader title="Set up your workspace">Defaults for new sessions. You can change all of this later in Settings.</StepHeader>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Model">
          <Select value={settings.defaultModel} onChange={(e) => setSettings({ ...settings, defaultModel: e.target.value })} className="w-full">
            {DEFAULT_MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Permissions">
          <Select
            value={settings.defaultPermissionMode}
            onChange={(e) => setSettings({ ...settings, defaultPermissionMode: e.target.value as PermissionMode })}
            className="w-full"
          >
            {(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as PermissionMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m].label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <p className="mt-1 text-xs text-ink-3">{MODE_LABEL[settings.defaultPermissionMode]?.hint}</p>

      <h2 className="mt-6 mb-2 text-sm font-semibold">Git (optional)</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Commit name">
          <Input value={gitName} onChange={(e) => setGitName(e.target.value)} placeholder="Ada Lovelace" autoComplete="name" />
        </Field>
        <Field label="Commit email">
          <Input type="email" value={gitEmail} onChange={(e) => setGitEmail(e.target.value)} placeholder="ada@example.com" autoComplete="email" />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="GitHub token" hint="Lets Claude clone and push private repos and use gh. Fine-grained tokens with repo access work best.">
          <Input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder="github_pat_…" autoComplete="off" />
        </Field>
      </div>
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <Footer onBack={onBack}>
        <Button type="submit" variant="primary" busy={busy} icon={<ArrowRight className="size-4" />}>
          Continue
        </Button>
      </Footer>
    </form>
  );
}

function Row({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 py-3">
      <span className="mt-0.5 text-ink-3">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-sm text-ink-2">{children}</span>
      </span>
    </li>
  );
}

function FinishStep({ onBack }: { onBack?: () => void }) {
  const navigate = useNavigate();
  const user = useStore((s) => s.user);
  const status = useStore((s) => s.status);
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  const [busy, setBusy] = useState(false);

  async function finish() {
    setBusy(true);
    try {
      const setup = await api.post<SetupStatus>('/api/setup/complete');
      useStore.setState({ setup });
      navigate('/', { replace: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <StepHeader title="You're all set">Here's how this server is set up.</StepHeader>
      <ul className="divide-y divide-line">
        <Row icon={<UserRound className="size-4" />} title="Account">
          Signed in as <span className="font-medium">{user?.username}</span>
        </Row>
        <Row icon={status?.claudeAuth.configured ? <Check className="size-4 text-ok" /> : <TriangleAlert className="size-4 text-break" />} title="Claude">
          {status?.claudeAuth.configured ? 'Connected' : 'Not connected yet. You can do this later in Settings.'}
        </Row>
        <Row icon={<Globe className="size-4" />} title="Address">
          <span className="font-mono text-[13px] break-all">{status?.publicUrl}</span>
          <span className="mt-1 block text-xs text-ink-3">
            {status?.previewMode === 'subdomain' ? (
              <>
                Apps you run get private previews at <span className="font-mono">p-&lt;port&gt;.{status.previewDomain}</span> and can be published at{' '}
                <span className="font-mono">&lt;name&gt;.{status.previewDomain}</span>.
              </>
            ) : (
              <>
                Previews use <span className="font-mono">/preview/&lt;port&gt;/</span> paths. Some apps need a wildcard domain for previews to work fully (see
                README, "Deploy").
              </>
            )}
          </span>
        </Row>
        <Row icon={<Bell className="size-4" />} title="Notifications">
          {perm === 'granted' ? (
            'On in this browser.'
          ) : perm === 'denied' ? (
            "Blocked in this browser's site settings."
          ) : (
            <Button size="sm" className="mt-1" onClick={async () => setPerm(await Notification.requestPermission())}>
              Notify me when Claude needs me
            </Button>
          )}
        </Row>
      </ul>
      <Footer onBack={onBack}>
        <Button variant="primary" busy={busy} onClick={finish} icon={<ArrowRight className="size-4" />}>
          Open Cloude
        </Button>
      </Footer>
    </>
  );
}
