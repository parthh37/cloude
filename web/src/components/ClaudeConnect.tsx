import clsx from 'clsx';
import { CheckCircle2, ExternalLink, KeyRound, LogIn, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { ClaudeCredentialKind, ClaudeLoginStart, SystemStatus } from '../../../shared/protocol';
import { api, ApiError } from '../lib/api';
import { Button, Field, Input } from './ui';

type ClaudeAuth = SystemStatus['claudeAuth'];

const SOURCE_LABEL: Record<ClaudeAuth['source'], string> = {
  api_key: 'an Anthropic API key',
  oauth_token: 'a Claude subscription',
  cli_login: 'the Claude CLI login on the server',
  none: '',
};

const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server');

export function ClaudeStatusBanner({ auth }: { auth: ClaudeAuth | null | undefined }) {
  return (
    <div className={clsx('flex items-center gap-2 rounded-md px-3 py-2 text-sm', auth?.configured ? 'bg-ok-soft text-ok' : 'bg-break-soft text-break-ink')}>
      {auth?.configured ? <CheckCircle2 className="size-4 shrink-0" /> : <TriangleAlert className="size-4 shrink-0" />}
      {auth?.configured ? `Connected with ${SOURCE_LABEL[auth.source]}` : 'Not connected yet'}
    </div>
  );
}

/**
 * Connect Claude from the browser: sign in with a subscription (the server runs
 * `claude setup-token` and we relay the code), or paste a token / API key.
 */
export function ClaudeConnect({ onConnected }: { onConnected: (auth: ClaudeAuth) => void }) {
  const [plan, setPlan] = useState<'subscription' | 'api_key'>('subscription');
  const [login, setLogin] = useState<ClaudeLoginStart | null>(null);
  const [code, setCode] = useState('');
  const [pasteToken, setPasteToken] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const start = () => run(async () => setLogin(await api.post<ClaudeLoginStart>('/api/claude/login')));

  const cancel = () => {
    if (login) void api.del(`/api/claude/login/${login.id}`).catch(() => {});
    setLogin(null);
    setCode('');
    setError(null);
  };

  const finish = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      try {
        const r = await api.post<{ claudeAuth: ClaudeAuth }>(`/api/claude/login/${login!.id}`, { code });
        setLogin(null);
        setCode('');
        onConnected(r.claudeAuth);
      } catch (err) {
        setLogin(null); // the CLI run is over either way; the next try needs a fresh link
        setCode('');
        throw err;
      }
    });
  };

  const save = (kind: ClaudeCredentialKind) => (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.put<{ claudeAuth: ClaudeAuth }>('/api/claude/credential', { kind, value });
      setValue('');
      onConnected(r.claudeAuth);
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ['subscription', 'Claude subscription', 'Pro / Max plan'],
            ['api_key', 'API key', 'Pay as you go'],
          ] as const
        ).map(([k, label, sub]) => (
          <button
            type="button"
            key={k}
            aria-pressed={plan === k}
            onClick={() => {
              setPlan(k);
              setError(null);
            }}
            className={clsx('rounded-md border px-3 py-2.5 text-left', plan === k ? 'border-sky bg-sky-soft' : 'border-line hover:border-line-strong')}
          >
            <span className="block text-sm font-medium">{label}</span>
            <span className="block text-xs text-ink-3">{sub}</span>
          </button>
        ))}
      </div>

      {plan === 'subscription' && !pasteToken && !login && (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">You'll approve access on claude.com, then paste back the code it shows you. The token lasts a year.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" busy={busy} onClick={start} icon={<LogIn className="size-4" />}>
              Sign in with Claude
            </Button>
            <Button variant="ghost" onClick={() => setPasteToken(true)}>
              I have a token
            </Button>
          </div>
        </div>
      )}

      {plan === 'subscription' && login && (
        <form onSubmit={finish} className="space-y-3">
          <ol className="space-y-3 text-sm">
            <li className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold">1</span>
              <span className="min-w-0 flex-1">
                <a
                  href={login.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-medium text-sky underline-offset-2 hover:underline"
                >
                  Open claude.com and approve access <ExternalLink className="size-3.5" />
                </a>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold">2</span>
              <span className="min-w-0 flex-1 space-y-2">
                <span className="block">Copy the code it shows and paste it here.</span>
                <Input
                  aria-label="Code from claude.com"
                  autoComplete="off"
                  spellCheck={false}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Paste code"
                  className="font-mono"
                />
              </span>
            </li>
          </ol>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={!code.trim()} busy={busy}>
              Connect
            </Button>
            <Button variant="ghost" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {plan === 'subscription' && pasteToken && !login && (
        <form onSubmit={save('CLAUDE_CODE_OAUTH_TOKEN')} className="space-y-3">
          <Field
            label="Subscription token"
            hint={
              <>
                From <code className="font-mono">claude setup-token</code> on any computer.{' '}
                <button type="button" className="text-sky hover:underline" onClick={() => setPasteToken(false)}>
                  Sign in here instead
                </button>
              </>
            }
          >
            <Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="sk-ant-oat…" />
          </Field>
          <Button type="submit" variant="primary" disabled={!value.trim()} busy={busy} icon={<KeyRound className="size-4" />}>
            Save token
          </Button>
        </form>
      )}

      {plan === 'api_key' && (
        <form onSubmit={save('ANTHROPIC_API_KEY')} className="space-y-3">
          <Field label="Anthropic API key" hint="Create one in the Claude Console under API keys.">
            <Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="sk-ant-…" />
          </Field>
          <Button type="submit" variant="primary" disabled={!value.trim()} busy={busy} icon={<KeyRound className="size-4" />}>
            Save key
          </Button>
        </form>
      )}

      {error && <p className="text-sm text-bad">{error}</p>}
      <p className="text-xs text-ink-3">Encrypted at rest and never shown again. Saving one replaces the other.</p>
    </div>
  );
}
