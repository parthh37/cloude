import clsx from 'clsx';
import { Check, Download, ExternalLink, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentCli, CompressionLevel, CompressionStats, McpCatalogEntry, SecretEntry, WorkbenchSettings } from '../../../shared/protocol';
import { api, ApiError } from '../lib/api';
import { toast } from '../lib/store';
import { loadClis, useWorkbench } from '../lib/workbench';
import { Badge, Button, Dialog, Field, Input, Select, Spinner, Toggle } from './ui';

const err = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

function Section({ id, title, description, children }: { id?: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 rounded-2xl border border-line bg-surface p-5 shadow-cloud">
      <h2 className="font-display text-lg font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-ink-2">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Global secret names, to flag CLIs / MCP servers whose credentials are missing. */
function useSecretKeys() {
  const [keys, setKeys] = useState<Set<string> | null>(null);
  useEffect(() => {
    api
      .get<{ secrets: SecretEntry[] }>('/api/secrets')
      .then((r) => setKeys(new Set(r.secrets.map((s) => s.key))))
      .catch(() => setKeys(new Set()));
  }, []);
  return keys;
}

const LEVELS: { id: CompressionLevel; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Claude sees raw command output.' },
  { id: 'balanced', label: 'Balanced', hint: 'Strips colours, progress bars and repeats; trims huge logs to head, tail and errors.' },
  { id: 'aggressive', label: 'Aggressive', hint: 'Also drops passing tests, per-crate compile lines and deprecation spam. Largest savings.' },
];

export function WorkbenchSection() {
  const [s, setS] = useState<WorkbenchSettings | null>(null);
  const [stats, setStats] = useState<CompressionStats | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ settings: WorkbenchSettings; compression: CompressionStats }>('/api/workbench').then((r) => {
      setS(r.settings);
      setStats(r.compression);
    });
  }, []);
  if (!s) return null;

  async function save() {
    setBusy(true);
    try {
      const r = await api.put<{ settings: WorkbenchSettings }>('/api/workbench', s as never);
      setS(r.settings);
      useWorkbench.setState({ settings: r.settings });
      toast('success', 'Workbench settings saved', 'New sessions pick them up.');
    } catch (e) {
      toast('error', 'Could not save', err(e));
    } finally {
      setBusy(false);
    }
  }

  const saved = stats ? stats.originalChars - stats.compressedChars : 0;
  return (
    <Section id="workbench" title="Workbench" description="Parallel sessions, token compression, memory and the virtual desktop.">
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-ink-2">Token compression for command output</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {LEVELS.map((l) => (
              <button
                key={l.id}
                onClick={() => setS({ ...s, compression: l.id })}
                className={clsx('rounded-xl border p-3 text-left transition-colors', s.compression === l.id ? 'border-ink bg-surface-2' : 'border-line hover:border-line-strong')}
              >
                <span className="text-sm font-medium">{l.label}</span>
                <span className="mt-0.5 block text-xs text-ink-3">{l.hint}</span>
              </button>
            ))}
          </div>
          {stats && stats.calls > 0 && (
            <p className="mt-2 text-xs text-ink-2">
              So far: {stats.calls} outputs compressed, ~{Math.round(saved / 4).toLocaleString()} tokens saved (
              {Math.round((saved / Math.max(1, stats.originalChars)) * 100)}% smaller). Full outputs are kept in <span className="font-mono">.cloude/outputs/</span> for Claude to
              re-read.
            </p>
          )}
        </div>
        <label className="flex items-center justify-between gap-4 rounded-lg border border-line px-3 py-2.5">
          <span className="text-sm">
            <span className="font-medium">Isolate new sessions in git worktrees</span>
            <span className="block text-xs text-ink-3">Default for board cards. Each agent gets its own branch, so parallel work never conflicts; you review and merge.</span>
          </span>
          <Toggle checked={s.defaultIsolation === 'worktree'} onChange={(v) => setS({ ...s, defaultIsolation: v ? 'worktree' : 'shared' })} label="Isolate sessions" />
        </label>
        <label className="flex items-center justify-between gap-4 rounded-lg border border-line px-3 py-2.5">
          <span className="text-sm">
            <span className="font-medium">Long-term memory</span>
            <span className="block text-xs text-ink-3">Give new sessions the project's memory index and the tools to save what they learn.</span>
          </span>
          <Toggle checked={s.injectMemory} onChange={(v) => setS({ ...s, injectMemory: v })} label="Memory" />
        </label>
        <div className="grid gap-3 rounded-lg border border-line px-3 py-2.5 sm:grid-cols-3">
          <Field label="Desktop width">
            <Input type="number" min={800} max={3840} value={s.desktop.width} onChange={(e) => setS({ ...s, desktop: { ...s.desktop, width: Number(e.target.value) } })} />
          </Field>
          <Field label="Desktop height">
            <Input type="number" min={600} max={2160} value={s.desktop.height} onChange={(e) => setS({ ...s, desktop: { ...s.desktop, height: Number(e.target.value) } })} />
          </Field>
          <label className="flex items-end justify-between gap-2 pb-2 text-sm">
            <span>
              Start with the server
              <span className="block text-xs text-ink-3">Otherwise on first use.</span>
            </span>
            <Toggle checked={s.desktop.autoStart} onChange={(v) => setS({ ...s, desktop: { ...s.desktop, autoStart: v } })} label="Autostart desktop" />
          </label>
        </div>
        <div className="flex justify-end">
          <Button variant="primary" busy={busy} onClick={save}>
            Save workbench settings
          </Button>
        </div>
      </div>
    </Section>
  );
}

// ---- agent CLIs ----------------------------------------------------------------------

const BLANK: Partial<AgentCli> = { name: '', command: '', headless: '', install: '', bin: '', envKeys: [], description: '', docsUrl: '' };

function CliEditor({ cli, open, onClose }: { cli: Partial<AgentCli> | null; open: boolean; onClose: () => void }) {
  const [f, setF] = useState<Partial<AgentCli>>(BLANK);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setF(cli ?? BLANK);
  }, [open, cli]);
  const up = (k: keyof AgentCli, v: unknown) => setF({ ...f, [k]: v });
  async function save() {
    setBusy(true);
    try {
      const r = await api.put<{ clis: AgentCli[] }>('/api/clis', { ...f, envKeys: f.envKeys ?? [] } as never);
      useWorkbench.setState({ clis: r.clis });
      onClose();
    } catch (e) {
      toast('error', 'Could not save the agent', err(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title={cli?.id ? `Edit ${cli.name}` : 'Add an agent CLI'}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={f.name ?? ''} onChange={(e) => up('name', e.target.value)} placeholder="e.g. Llama via Ollama" />
          </Field>
          <Field label="Binary" hint="Looked up on PATH to detect installs">
            <Input value={f.bin ?? ''} onChange={(e) => up('bin', e.target.value)} placeholder="defaults to the command's first word" />
          </Field>
        </div>
        <Field label="Interactive command" hint="Opened in a terminal">
          <Input className="font-mono text-[13px]" value={f.command ?? ''} onChange={(e) => up('command', e.target.value)} placeholder="ollama run llama3.1" />
        </Field>
        <Field label="Headless command" hint="For board cards. {prompt} is replaced with the shell-quoted task.">
          <Input className="font-mono text-[13px]" value={f.headless ?? ''} onChange={(e) => up('headless', e.target.value)} placeholder="mycli --yes -p {prompt}" />
        </Field>
        <Field label="Install command">
          <Input className="font-mono text-[13px]" value={f.install ?? ''} onChange={(e) => up('install', e.target.value)} placeholder="npm install -g my-agent-cli" />
        </Field>
        <Field label="Credentials (secret names)" hint="Comma-separated; add the values under Secrets.">
          <Input value={(f.envKeys ?? []).join(', ')} onChange={(e) => up('envKeys', e.target.value.split(',').map((k) => k.trim()).filter(Boolean))} placeholder="OPENAI_API_KEY" />
        </Field>
        <Field label="Description">
          <Input value={f.description ?? ''} onChange={(e) => up('description', e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button variant="primary" busy={busy} disabled={!f.name?.trim() || !f.command?.trim()} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function AgentClisSection() {
  const clis = useWorkbench((s) => s.clis);
  const secretKeys = useSecretKeys();
  const [installing, setInstalling] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<AgentCli> | null>(null);
  const [log, setLog] = useState<{ name: string; ok: boolean; output: string } | null>(null);
  useEffect(() => {
    void loadClis(true).catch(() => {});
  }, []);

  async function install(c: AgentCli) {
    setInstalling(c.id);
    try {
      const r = await api.post<{ ok: boolean; output: string; clis: AgentCli[] }>(`/api/clis/${c.id}/install`);
      useWorkbench.setState({ clis: r.clis });
      setLog({ name: c.name, ok: r.ok, output: r.output });
      toast(r.ok ? 'success' : 'error', r.ok ? `${c.name} installed` : `Installing ${c.name} failed`);
    } catch (e) {
      toast('error', `Installing ${c.name} failed`, err(e));
    } finally {
      setInstalling(null);
    }
  }

  async function remove(c: AgentCli) {
    if (!confirm(c.builtin ? `Reset ${c.name} to its default commands?` : `Remove ${c.name}?`)) return;
    const r = await api.del<{ clis: AgentCli[] }>(`/api/clis/${c.id}`).catch((e) => toast('error', err(e)));
    if (r) useWorkbench.setState({ clis: r.clis });
  }

  return (
    <Section
      id="agents"
      title="Agent CLIs"
      description="Other coding agents you can open in a terminal or assign to board cards. Each run gets its own worktree. Add any CLI — local models via Ollama included."
    >
      {!clis ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {clis.map((c) => {
            const missing = secretKeys ? c.envKeys.filter((k) => !secretKeys.has(k)) : [];
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {c.name}
                    {c.installed ? <Badge tone="ok">{c.version ? c.version.slice(0, 28) : 'installed'}</Badge> : <Badge>not installed</Badge>}
                    {!c.builtin && <Badge tone="sky">custom</Badge>}
                    {!c.headless && <Badge>interactive only</Badge>}
                  </p>
                  <p className="text-xs text-ink-3">{c.description}</p>
                  {c.installed && missing.length > 0 && missing.length === c.envKeys.length && (
                    <p className="text-xs text-break-ink">Needs one of: {c.envKeys.join(', ')} (Secrets) — or sign in from its terminal.</p>
                  )}
                </div>
                {c.docsUrl && (
                  <a href={c.docsUrl} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-ink" title="Docs">
                    <ExternalLink className="size-4" />
                  </a>
                )}
                <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(c)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" icon={c.builtin ? <RotateCcw className="size-3.5" /> : <Trash2 className="size-3.5" />} onClick={() => remove(c)} title={c.builtin ? 'Reset to defaults' : 'Remove'} />
                {!c.installed && c.install && (
                  <Button size="sm" icon={<Download className="size-3.5" />} busy={installing === c.id} disabled={!!installing} onClick={() => install(c)}>
                    Install
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex justify-end">
        <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ ...BLANK })}>
          Add agent CLI
        </Button>
      </div>
      <CliEditor cli={editing} open={!!editing} onClose={() => setEditing(null)} />
      <Dialog open={!!log} onClose={() => setLog(null)} title={log ? `${log.name}: install ${log.ok ? 'finished' : 'failed'}` : ''} wide>
        <pre className="porthole max-h-[60vh] overflow-auto px-3 py-2 text-[12px] whitespace-pre-wrap">{log?.output || '(no output)'}</pre>
      </Dialog>
    </Section>
  );
}

// ---- MCP catalog (lives inside the Tools section and edits its JSON) -------------------------

export function McpCatalog({ value, onChange }: { value: string; onChange: (json: string) => void }) {
  const [catalog, setCatalog] = useState<McpCatalogEntry[] | null>(null);
  const [category, setCategory] = useState<string>('all');
  const secretKeys = useSecretKeys();
  useEffect(() => {
    api
      .get<{ catalog: McpCatalogEntry[] }>('/api/mcp/catalog')
      .then((r) => setCatalog(r.catalog))
      .catch(() => setCatalog([]));
  }, []);
  const current = useMemo(() => {
    try {
      return JSON.parse(value || '{}') as Record<string, unknown>;
    } catch {
      return null; // user is mid-edit with invalid JSON; don't touch it
    }
  }, [value]);
  if (!catalog?.length) return null;

  function toggle(entry: McpCatalogEntry) {
    if (!current) return toast('warning', 'Fix the JSON below first');
    const next = { ...current };
    if (next[entry.id]) delete next[entry.id];
    else next[entry.id] = entry.config;
    onChange(JSON.stringify(next, null, 2));
  }

  const categories = ['all', ...new Set(catalog.map((c) => c.category))];
  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-ink-2">Catalog — one click adds it below (then Save settings)</p>
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="h-8 text-[13px]">
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {catalog
          .filter((c) => category === 'all' || c.category === category)
          .map((c) => {
            const added = !!current?.[c.id];
            const missing = secretKeys ? c.envKeys.filter((k) => !secretKeys.has(k)) : [];
            return (
              <div key={c.id} className={clsx('rounded-xl border p-2.5', added ? 'border-ok/60 bg-ok-soft/40' : 'border-line')}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                  <a href={c.docsUrl} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-ink" title="Docs">
                    <ExternalLink className="size-3.5" />
                  </a>
                  <Button size="sm" variant={added ? 'ghost' : 'secondary'} icon={added ? <Check className="size-3.5" /> : <Plus className="size-3.5" />} onClick={() => toggle(c)}>
                    {added ? 'Added' : 'Add'}
                  </Button>
                </div>
                <p className="mt-0.5 text-xs text-ink-3">{c.description}</p>
                {missing.length > 0 && <p className="mt-1 text-xs text-break-ink">Add secret{missing.length > 1 ? 's' : ''}: {missing.join(', ')}</p>}
              </div>
            );
          })}
      </div>
    </div>
  );
}
