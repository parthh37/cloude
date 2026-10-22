import { CheckCircle2, KeyRound, Moon, Sun, SunMoon, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AppSettings, EffortLevel, PermissionMode, SecretEntry, SystemStatus } from '../../../shared/protocol';
import { Badge, Button, Field, Input, Select, Textarea, Toggle } from '../components/ui';
import { api, ApiError, q } from '../lib/api';
import { MODE_LABEL, bytes, timeAgo } from '../lib/format';
import { toast, useStore } from '../lib/store';
import { themePref, setThemePref, type ThemePref } from '../lib/theme';
import { PageHeader, Panel } from '../components/hud';
import { Page, Shell } from '../components/Shell';

const err = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

function Section({ id, title, description, children }: { id?: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Panel id={id} label={title}>
      {description && <p className="mb-4 text-sm text-ink-2">{description}</p>}
      {children}
    </Panel>
  );
}

function Appearance() {
  const [pref, setPref] = useState<ThemePref>(themePref());
  const options: { value: ThemePref; label: string; hint: string; icon: typeof Moon }[] = [
    { value: 'night', label: 'Night', hint: 'Dark instrument panel', icon: Moon },
    { value: 'day', label: 'Day', hint: 'Light, for sunlight', icon: Sun },
    { value: 'auto', label: 'Auto', hint: 'Follow this device', icon: SunMoon },
  ];
  return (
    <Section title="Appearance" description="Saved in this browser.">
      <div className="grid grid-cols-3 gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => {
              setThemePref(o.value);
              setPref(o.value);
            }}
            aria-pressed={pref === o.value}
            className={`flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left ${pref === o.value ? 'border-sky bg-sky-soft' : 'border-line hover:border-line-strong'}`}
          >
            <o.icon className={`size-4 ${pref === o.value ? 'text-sky' : 'text-ink-3'}`} />
            <span className="text-sm font-medium">{o.label}</span>
            <span className="text-xs text-ink-3">{o.hint}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

function ClaudeAccount({ status, onChange }: { status: SystemStatus | null; onChange: () => void }) {
  const [kind, setKind] = useState<'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY'>('CLAUDE_CODE_OAUTH_TOKEN');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const auth = status?.claudeAuth;
  const sourceLabel = { api_key: 'Anthropic API key', oauth_token: 'Claude subscription token', cli_login: 'Claude CLI login on the server', none: '' };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put('/api/secrets', { key: kind, value: value.trim() });
      setValue('');
      toast('success', 'Claude credentials saved', 'New sessions will use them. Running sessions pick them up after they restart.');
      onChange();
    } catch (e) {
      toast('error', 'Could not save', err(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      id="claude"
      title="Claude account"
      description="Sessions run Claude Code on this server with these credentials. Keys are encrypted at rest and never shown again."
    >
      <div className={`mb-4 flex items-center gap-2 rounded-md px-3 py-2 text-sm ${auth?.configured ? 'bg-ok-soft text-ok' : 'bg-break-soft text-break-ink'}`}>
        {auth?.configured ? <CheckCircle2 className="size-4" /> : <TriangleAlert className="size-4" />}
        {auth?.configured ? `Connected with a ${sourceLabel[auth.source]}` : 'Not connected yet'}
      </div>
      <form onSubmit={save} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['CLAUDE_CODE_OAUTH_TOKEN', 'Claude subscription', 'Pro / Max plan'],
              ['ANTHROPIC_API_KEY', 'API key', 'Pay as you go'],
            ] as const
          ).map(([k, label, sub]) => (
            <button
              type="button"
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-md border px-3 py-2.5 text-left ${kind === k ? 'border-sky bg-sky-soft' : 'border-line hover:border-line-strong'}`}
            >
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-xs text-ink-3">{sub}</span>
            </button>
          ))}
        </div>
        <Field
          label={kind === 'ANTHROPIC_API_KEY' ? 'Anthropic API key' : 'Subscription token'}
          hint={
            kind === 'ANTHROPIC_API_KEY' ? (
              'Create one in the Claude Console under API keys.'
            ) : (
              <>
                Open any project's Terminal, run <code className="font-mono">claude setup-token</code>, follow the link to sign in, and paste the token it
                prints here.
              </>
            )
          }
        >
          <Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === 'ANTHROPIC_API_KEY' ? 'sk-ant-…' : 'sk-ant-oat…'} />
        </Field>
        <Button type="submit" variant="primary" disabled={!value.trim()} busy={busy} icon={<KeyRound className="size-4" />}>
          Save credentials
        </Button>
      </form>
    </Section>
  );
}

function Secrets() {
  const projects = useStore((s) => s.projects);
  const [scope, setScope] = useState<string>('');
  const [list, setList] = useState<SecretEntry[]>([]);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  const load = () =>
    api
      .get<{ secrets: SecretEntry[] }>(`/api/secrets${q({ projectId: scope || undefined })}`)
      .then((r) => setList(r.secrets))
      .catch(() => {});
  useEffect(() => {
    void load();
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Section
      title="Secrets & environment"
      description="Exported as environment variables to Claude, terminals and services. Project values override global ones. Add GH_TOKEN to clone and push private GitHub repos."
    >
      <Select value={scope} onChange={(e) => setScope(e.target.value)} className="mb-3 w-full sm:w-72" aria-label="Scope">
        <option value="">All projects (global)</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            Only {p.name}
          </option>
        ))}
      </Select>
      <ul className="divide-y divide-line rounded-md border border-line">
        {list.length === 0 && <li className="px-3 py-3 text-sm text-ink-3">No secrets in this scope.</li>}
        {list.map((s) => (
          <li key={s.key} className="flex items-center gap-3 px-3 py-2">
            <span className="font-mono text-[13px] font-medium">{s.key}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-3">{s.preview}</span>
            <span className="hidden text-xs text-ink-3 sm:inline">{timeAgo(s.updatedAt)}</span>
            <button
              aria-label={`Delete ${s.key}`}
              className="text-ink-3 hover:text-bad"
              onClick={async () => {
                if (!confirm(`Delete ${s.key}?`)) return;
                await api.del(`/api/secrets${q({ key: s.key, projectId: scope || undefined })}`).catch((e) => toast('error', err(e)));
                void load();
              }}
            >
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.put('/api/secrets', { key: key.trim(), value, projectId: scope || null });
            setKey('');
            setValue('');
            void load();
          } catch (er) {
            toast('error', 'Could not save secret', err(er));
          }
        }}
      >
        <Input value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="NAME" className="font-mono sm:w-56" required />
        <Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" required />
        <Button type="submit">Add</Button>
      </form>
    </Section>
  );
}

function Defaults() {
  const [s, setS] = useState<AppSettings | null>(null);
  const [mcpText, setMcpText] = useState('{}');
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ settings: AppSettings }>('/api/settings').then((r) => {
      setS(r.settings);
      setMcpText(JSON.stringify(r.settings.mcpServers ?? {}, null, 2));
    });
  }, []);
  if (!s) return null;

  async function save() {
    let mcpServers: Record<string, unknown>;
    try {
      mcpServers = JSON.parse(mcpText || '{}');
      if (typeof mcpServers !== 'object' || Array.isArray(mcpServers)) throw new Error('Must be a JSON object');
      setMcpError(null);
    } catch (e) {
      setMcpError(String((e as Error).message));
      return;
    }
    setBusy(true);
    try {
      const r = await api.put<{ settings: AppSettings }>('/api/settings', { ...s!, mcpServers } as any);
      setS(r.settings);
      toast('success', 'Settings saved', 'They apply to sessions started from now on.');
    } catch (e) {
      toast('error', 'Could not save settings', err(e));
    } finally {
      setBusy(false);
    }
  }

  const up = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setS({ ...s, [k]: v });

  return (
    <>
      <Section title="New session defaults">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Model">
            <Select value={s.defaultModel} onChange={(e) => up('defaultModel', e.target.value)} className="w-full">
              <option value="claude-opus-5-5">Opus 5.5</option>
              <option value="claude-fable-5-1">Fable 5.1</option>
              <option value="claude-sonnet-5-5">Sonnet 5.5</option>
              <option value="claude-haiku-5-5">Haiku 5.5</option>
            </Select>
          </Field>
          <Field label="Permissions" hint={MODE_LABEL[s.defaultPermissionMode]?.hint}>
            <Select value={s.defaultPermissionMode} onChange={(e) => up('defaultPermissionMode', e.target.value as PermissionMode)} className="w-full">
              {(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as PermissionMode[]).map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Effort">
            <Select value={s.defaultEffort ?? ''} onChange={(e) => up('defaultEffort', (e.target.value || null) as EffortLevel | null)} className="w-full">
              <option value="">Model default</option>
              {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pause idle sessions after (minutes)" hint="Frees memory; the conversation resumes on your next message. 0 keeps them running.">
            <Input type="number" min={0} value={s.idleTimeoutMinutes} onChange={(e) => up('idleTimeoutMinutes', Number(e.target.value))} />
          </Field>
        </div>
      </Section>

      <Section title="Tools" description="MCP servers available to every session, in addition to each project's own .mcp.json.">
        <div className="flex items-center justify-between gap-4 rounded-md border border-line px-3 py-2.5">
          <span className="text-sm">
            <span className="font-medium">Browser testing (Playwright)</span>
            <span className="block text-xs text-ink-3">Lets Claude open your apps in a headless browser, click through them and take screenshots.</span>
          </span>
          <Toggle checked={s.enablePlaywright} onChange={(v) => up('enablePlaywright', v)} label="Browser testing" />
        </div>
        <Field label="Extra MCP servers (JSON)" hint='Same shape as .mcp.json "mcpServers", e.g. { "github": { "type": "http", "url": "https://…" } }'>
          <Textarea rows={6} value={mcpText} onChange={(e) => setMcpText(e.target.value)} className="mt-3 font-mono text-[12.5px]" spellCheck={false} />
        </Field>
        {mcpError && <p className="mt-1 text-sm text-bad">{mcpError}</p>}
      </Section>

      <Section title="Instructions for Claude" description="Added to every session's system prompt — house rules, preferred stack, how to deploy.">
        <Textarea
          rows={5}
          value={s.appendSystemPrompt}
          onChange={(e) => up('appendSystemPrompt', e.target.value)}
          placeholder="e.g. Use pnpm. Prefer Postgres via docker compose. Always run the test suite before saying you're done."
        />
      </Section>

      <div className="flex justify-end">
        <Button variant="primary" busy={busy} onClick={save}>
          Save settings
        </Button>
      </div>
    </>
  );
}

function Server({ status }: { status: SystemStatus | null }) {
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  if (!status) return null;
  return (
    <Section title="Server">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-ink-3">Version</dt>
        <dd>Cloude {status.version}</dd>
        <dt className="text-ink-3">Address</dt>
        <dd className="font-mono text-[13px]">{status.publicUrl}</dd>
        <dt className="text-ink-3">App previews</dt>
        <dd>
          {status.previewMode === 'subdomain' ? (
            <span className="font-mono text-[13px]">*.{status.previewDomain}</span>
          ) : (
            <span>
              Path mode (<span className="font-mono text-[13px]">/preview/&lt;port&gt;/</span>). Set <span className="font-mono text-[13px]">CLOUDE_PREVIEW_DOMAIN</span> to
              a wildcard domain for full compatibility.
            </span>
          )}
        </dd>
        {status.disk && (
          <>
            <dt className="text-ink-3">Disk</dt>
            <dd>
              {bytes(status.disk.free)} free of {bytes(status.disk.total)}
            </dd>
          </>
        )}
        <dt className="text-ink-3">Notifications</dt>
        <dd>
          {perm === 'granted' ? (
            <Badge tone="ok">On in this browser</Badge>
          ) : perm === 'denied' ? (
            <span className="text-ink-3">Blocked in this browser's site settings</span>
          ) : (
            <Button size="sm" onClick={async () => setPerm(await Notification.requestPermission())}>
              Notify me when Claude needs me
            </Button>
          )}
        </dd>
      </dl>
      <h3 className="hud-label mt-5 mb-2">Installed toolchains</h3>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {Object.entries(status.toolchains).map(([k, v]) => (
          <li key={k} className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-[13px]">
            <span className={`size-1.5 rounded-full ${v ? 'bg-ok' : 'bg-line-strong'}`} />
            <span className="w-24 font-medium">{k}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-3">{v ?? 'not installed'}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function SettingsPage() {
  const [status, setStatus] = useState<SystemStatus | null>(useStore.getState().status);
  const refresh = () =>
    api.get<SystemStatus>('/api/status').then((s) => {
      setStatus(s);
      useStore.setState({ status: s });
    });
  useEffect(() => {
    void refresh();
    if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView(), 50);
  }, []);
  return (
    <Shell>
      <Page>
        <PageHeader title="Settings" subtitle="Claude account, session defaults, secrets and this server. Sign-in security lives in Security." />
        <ClaudeAccount status={status} onChange={refresh} />
        <Defaults />
        <Secrets />
        <Appearance />
        <Server status={status} />
      </Page>
    </Shell>
  );
}
