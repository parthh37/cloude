import clsx from 'clsx';
import { CheckCircle2, CircleAlert, Pencil, Plus, Trash2, Waypoints } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { EffortLevel, ModelProvider, ModelRoute, ProviderCheck, ProviderKind, RoutingConfig, RoutingDecision, TaskKind, TaskKindInfo } from '../../../shared/protocol';
import { Badge, Button, Dialog, Field, IconButton, Input, Select, Toggle } from '../components/ui';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { toast, useStore } from '../lib/store';
import { Card, Hint, err } from './shared';

const EFFORTS: (EffortLevel | '')[] = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

const KIND_LABEL: Record<ProviderKind, string> = {
  anthropic: 'Anthropic',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
  gateway: 'Gateway (Anthropic-compatible)',
  ollama: 'Ollama',
};

const blank = (kind: ProviderKind, over: Partial<ModelProvider> = {}): ModelProvider => ({
  id: '',
  name: '',
  kind,
  baseUrl: null,
  authSecret: null,
  authStyle: 'bearer',
  region: null,
  cloudProject: null,
  resource: null,
  extraEnv: {},
  models: [],
  builtin: false,
  ...over,
});

const PRESETS: { label: string; provider: ModelProvider }[] = [
  { label: 'OpenRouter', provider: blank('gateway', { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', authSecret: 'OPENROUTER_API_KEY' }) },
  { label: 'LiteLLM proxy', provider: blank('gateway', { id: 'litellm', name: 'LiteLLM', baseUrl: 'http://localhost:4000', authSecret: 'LITELLM_API_KEY' }) },
  { label: 'Ollama', provider: blank('ollama', { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434' }) },
  {
    label: 'Amazon Bedrock',
    provider: blank('bedrock', { id: 'bedrock', name: 'Bedrock', region: 'us-east-1', authSecret: 'AWS_BEARER_TOKEN_BEDROCK', models: ['us.anthropic.claude-opus-5-5-v1:0'] }),
  },
  { label: 'Google Vertex AI', provider: blank('vertex', { id: 'vertex', name: 'Vertex AI', region: 'global', models: ['claude-opus-5-5'] }) },
  { label: 'Microsoft Foundry', provider: blank('foundry', { id: 'foundry', name: 'Foundry', authSecret: 'ANTHROPIC_FOUNDRY_API_KEY', models: ['claude-opus-5-5'] }) },
  { label: 'Custom gateway', provider: blank('gateway', { id: 'gateway', name: 'My gateway', baseUrl: 'https://' }) },
];

function ProviderDialog({ initial, existingIds, onSave, onClose }: { initial: ModelProvider | null; existingIds: string[]; onSave: (p: ModelProvider) => void; onClose: () => void }) {
  const [p, setP] = useState<ModelProvider | null>(initial);
  const [secretValue, setSecretValue] = useState('');
  const [check, setCheck] = useState<ProviderCheck | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setP(initial);
    setCheck(null);
    setSecretValue('');
  }, [initial]);
  if (!p) return null;
  const isNew = !existingIds.includes(initial?.id ?? '') || !initial?.id;
  const set = (patch: Partial<ModelProvider>) => setP({ ...p, ...patch });
  const needsUrl = p.kind === 'gateway' || p.kind === 'ollama';

  async function saveSecret() {
    if (secretValue.trim() && p?.authSecret) {
      await api.put('/api/secrets', { key: p.authSecret, value: secretValue.trim() });
      setSecretValue('');
    }
  }
  async function test() {
    setBusy(true);
    try {
      await saveSecret();
      const { check } = await api.post<{ check: ProviderCheck }>('/api/infra/routing/check', { ...p! });
      setCheck(check);
      if (check.ok && check.models.length && !p!.models.length) set({ models: check.models.slice(0, 50) });
    } catch (e) {
      setCheck({ ok: false, message: err(e), models: [] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={isNew ? 'Add provider' : `Edit ${p.name}`} wide>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (isNew && existingIds.includes(p.id)) return toast('error', `A provider with id "${p.id}" already exists`);
          try {
            await saveSecret();
            onSave(p);
          } catch (e2) {
            toast('error', 'Could not save the secret', err(e2));
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name">
            <Input value={p.name} onChange={(e) => set({ name: e.target.value })} required />
          </Field>
          <Field label="Id" hint="Used in routes; a-z, 0-9, -">
            <Input value={p.id} onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} required disabled={!isNew} />
          </Field>
          <Field label="Type">
            <Select value={p.kind} onChange={(e) => set({ kind: e.target.value as ProviderKind })}>
              {(Object.keys(KIND_LABEL) as ProviderKind[])
                .filter((k) => k !== 'anthropic')
                .map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
            </Select>
          </Field>
        </div>

        {(needsUrl || p.kind === 'foundry' || p.kind === 'bedrock' || p.kind === 'vertex') && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={needsUrl ? 'Base URL' : 'Base URL (optional override)'} hint={p.kind === 'gateway' ? 'Anthropic-compatible endpoint, without /v1' : undefined}>
              <Input value={p.baseUrl ?? ''} onChange={(e) => set({ baseUrl: e.target.value || null })} placeholder={p.kind === 'ollama' ? 'http://localhost:11434' : 'https://…'} required={p.kind === 'gateway'} />
            </Field>
            {(p.kind === 'bedrock' || p.kind === 'vertex') && (
              <Field label="Region">
                <Input value={p.region ?? ''} onChange={(e) => set({ region: e.target.value || null })} placeholder={p.kind === 'bedrock' ? 'us-east-1' : 'global'} />
              </Field>
            )}
            {p.kind === 'vertex' && (
              <Field label="GCP project id">
                <Input value={p.cloudProject ?? ''} onChange={(e) => set({ cloudProject: e.target.value || null })} />
              </Field>
            )}
            {p.kind === 'foundry' && (
              <Field label="Foundry resource">
                <Input value={p.resource ?? ''} onChange={(e) => set({ resource: e.target.value || null })} />
              </Field>
            )}
          </div>
        )}

        {p.kind !== 'vertex' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Credential secret name" hint="A Cloude secret (encrypted). Only the name is stored here.">
              <Input value={p.authSecret ?? ''} onChange={(e) => set({ authSecret: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') || null })} placeholder="MY_GATEWAY_KEY" />
            </Field>
            <Field label="Set its value (optional)" hint="Saved to Settings → Secrets">
              <Input type="password" value={secretValue} onChange={(e) => setSecretValue(e.target.value)} placeholder="paste to update" autoComplete="off" disabled={!p.authSecret} />
            </Field>
            {p.kind === 'gateway' && (
              <Field label="Auth header">
                <Select value={p.authStyle} onChange={(e) => set({ authStyle: e.target.value as ModelProvider['authStyle'] })}>
                  <option value="bearer">Authorization: Bearer</option>
                  <option value="x-api-key">x-api-key</option>
                </Select>
              </Field>
            )}
          </div>
        )}
        {p.kind === 'vertex' && <Hint>Vertex uses Google application credentials: add GOOGLE_APPLICATION_CREDENTIALS (a key file path on the server) as a secret.</Hint>}

        <Field label="Models" hint="One per line — offered in the route pickers. “Check” fills this from the provider when it can list models.">
          <textarea
            className="min-h-24 w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[13px] text-ink focus:border-sky focus:outline-none"
            value={p.models.join('\n')}
            onChange={(e) => set({ models: e.target.value.split('\n') })}
            placeholder={p.kind === 'ollama' ? 'qwen3-coder:30b' : 'anthropic/claude-opus-5.5'}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button type="button" onClick={test} busy={busy}>
            Check connection
          </Button>
          {check && (
            <span className={clsx('flex items-center gap-1.5 text-sm', check.ok ? 'text-ok' : 'text-bad')}>
              {check.ok ? <CheckCircle2 className="size-4" /> : <CircleAlert className="size-4" />}
              {check.message}
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!p.id || !p.name}>
              {isNew ? 'Add provider' : 'Save'}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function RouteEditor({ value, providers, onChange, allowInherit }: { value: ModelRoute | null; providers: ModelProvider[]; onChange: (r: ModelRoute | null) => void; allowInherit?: string }) {
  const provider = providers.find((p) => p.id === value?.providerId);
  const listId = useId();
  return (
    <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_7rem]">
      <Select
        aria-label="Provider"
        value={value?.providerId ?? ''}
        onChange={(e) => {
          const id = e.target.value;
          if (!id) return onChange(null);
          const p = providers.find((x) => x.id === id);
          onChange({ providerId: id, model: value?.providerId === id ? value.model : (p?.models[0] ?? ''), effort: value?.effort ?? null, fallbackModel: null });
        }}
      >
        {allowInherit !== undefined && <option value="">{allowInherit}</option>}
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      <Input
        aria-label="Model"
        list={listId}
        value={value?.model ?? ''}
        disabled={!value}
        placeholder={value ? 'model id' : '—'}
        onChange={(e) => value && onChange({ ...value, model: e.target.value })}
        className="font-mono text-[13px]"
      />
      <datalist id={listId}>{provider?.models.map((m) => <option key={m} value={m} />)}</datalist>
      <Select aria-label="Effort" value={value?.effort ?? ''} disabled={!value} onChange={(e) => value && onChange({ ...value, effort: (e.target.value || null) as EffortLevel | null })}>
        {EFFORTS.map((x) => (
          <option key={x} value={x}>
            {x ? `effort: ${x}` : 'effort: default'}
          </option>
        ))}
      </Select>
    </div>
  );
}

export function RoutingTab() {
  const [cfg, setCfg] = useState<RoutingConfig | null>(null);
  const [kinds, setKinds] = useState<TaskKindInfo[]>([]);
  const [decisions, setDecisions] = useState<RoutingDecision[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<ModelProvider | null>(null);
  const [checks, setChecks] = useState<Record<string, ProviderCheck | 'busy'>>({});
  const sessions = useStore((s) => s.sessions);

  const load = () =>
    api.get<{ routing: RoutingConfig; taskKinds: TaskKindInfo[]; decisions: RoutingDecision[] }>('/api/infra/routing').then((r) => {
      setCfg(r.routing);
      setKinds(r.taskKinds);
      setDecisions(r.decisions);
      setDirty(false);
    });
  useEffect(() => {
    load().catch((e) => toast('error', 'Could not load routing', err(e)));
  }, []);

  if (!cfg) return <Card title="Model routing">Loading…</Card>;
  const update = (patch: Partial<RoutingConfig>) => {
    setCfg({ ...cfg, ...patch });
    setDirty(true);
  };
  const external = cfg.providers.filter((p) => !p.builtin);

  async function save(next: RoutingConfig = cfg!) {
    setSaving(true);
    try {
      const { routing } = await api.put<{ routing: RoutingConfig }>('/api/infra/routing', { ...next, providers: next.providers.filter((p) => !p.builtin) });
      setCfg(routing);
      setDirty(false);
      toast('success', 'Routing saved', 'Applies to sessions the next time their Claude process starts.');
    } catch (e) {
      toast('error', 'Could not save routing', err(e));
    } finally {
      setSaving(false);
    }
  }

  async function checkProvider(p: ModelProvider) {
    setChecks((c) => ({ ...c, [p.id]: 'busy' }));
    try {
      const { check } = await api.post<{ check: ProviderCheck }>('/api/infra/routing/check', { ...p });
      setChecks((c) => ({ ...c, [p.id]: check }));
    } catch (e) {
      setChecks((c) => ({ ...c, [p.id]: { ok: false, message: err(e), models: [] } }));
    }
  }

  return (
    <div className="space-y-5">
      <Card
        title={
          <span className="flex items-center gap-2">
            <Waypoints className="size-5 text-dawn" /> Model routing
          </span>
        }
        description="Choose which provider and model handle each kind of task. Each Claude session is routed when its process starts; the decision is logged below."
        actions={
          <>
            <label className="flex items-center gap-2 text-sm font-medium">
              <Toggle checked={cfg.enabled} onChange={(v) => update({ enabled: v })} label="Routing enabled" />
              {cfg.enabled ? 'On' : 'Off'}
            </label>
            <Button variant="primary" busy={saving} disabled={!dirty} onClick={() => save()}>
              Save
            </Button>
          </>
        }
      >
        <div className="grid gap-3 rounded-xl border border-line bg-surface-2 p-3 text-sm text-ink-2 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <strong className="text-ink">How a session's task is decided:</strong> a task you set below for that session → a <code className="font-mono text-[12.5px]">#tag</code> in its first
            message (<code className="font-mono text-[12.5px]">#debug fix the login 500</code>) → the auto-classifier → <em>General</em>. Sessions where you picked a model by hand keep it.
          </div>
          <label className="flex items-center gap-2 whitespace-nowrap">
            <Toggle checked={cfg.autoClassify} onChange={(v) => update({ autoClassify: v })} label="Auto-classify" />
            Auto-classify
          </label>
        </div>

        <div className="mt-4 divide-y divide-line">
          {kinds.map((k) => (
            <div key={k.id} className="grid gap-2 py-3 lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-center">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  {k.label}
                  <code className="font-mono text-[11.5px] font-normal text-ink-3">#{k.id}</code>
                </div>
                <div className="text-xs text-ink-3">{k.hint}</div>
              </div>
              <RouteEditor
                value={cfg.routes[k.id] ?? null}
                providers={cfg.providers}
                allowInherit={k.id === 'general' ? undefined : 'Same as General'}
                onChange={(r) => update({ routes: { ...cfg.routes, [k.id]: r } })}
              />
            </div>
          ))}
        </div>
      </Card>

      <Card title="Inside each session" description="Models for work Claude delegates within a session. They apply when the session's main route uses the same provider.">
        <div className="space-y-3">
          {(
            [
              ['subagent', 'Subagents', 'Explore, plan and custom agents Claude spawns'],
              ['background', 'Background & quick calls', 'Titles, summaries, small helper requests'],
            ] as const
          ).map(([key, label, hint]) => {
            const role = cfg.roles[key];
            return (
              <div key={key} className="grid gap-2 lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-center">
                <div>
                  <div className="text-sm font-semibold">{label}</div>
                  <div className="text-xs text-ink-3">{hint}</div>
                </div>
                <RouteEditor
                  value={role ? { ...role, effort: null, fallbackModel: null } : null}
                  providers={cfg.providers}
                  allowInherit="Claude Code default"
                  onChange={(r) => update({ roles: { ...cfg.roles, [key]: r ? { providerId: r.providerId, model: r.model } : null } })}
                />
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        title="Providers"
        description="Where requests go. Anthropic uses the Claude account from Settings. For any other provider, your Anthropic key and subscription token are removed from that session's environment, so they are never sent to a third party."
        actions={
          <Select
            aria-label="Add provider"
            value=""
            onChange={(e) => {
              const preset = PRESETS.find((x) => x.label === e.target.value);
              if (!preset) return;
              let id = preset.provider.id;
              for (let n = 2; cfg.providers.some((p) => p.id === id); n++) id = `${preset.provider.id}-${n}`;
              setEditing({ ...preset.provider, id });
            }}
            className="w-44"
          >
            <option value="">+ Add provider…</option>
            {PRESETS.map((x) => (
              <option key={x.label}>{x.label}</option>
            ))}
          </Select>
        }
      >
        <ul className="space-y-2">
          {cfg.providers.map((p) => {
            const c = checks[p.id];
            const used = Object.values(cfg.routes).filter((r) => r?.providerId === p.id).length;
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-line px-3 py-2.5">
                <span className="font-medium">{p.name}</span>
                <Badge tone={p.builtin ? 'dawn' : 'neutral'}>{KIND_LABEL[p.kind]}</Badge>
                {p.baseUrl && <span className="min-w-0 truncate font-mono text-xs text-ink-3">{p.baseUrl}</span>}
                {used > 0 && <Badge tone="sky">{used} route{used > 1 ? 's' : ''}</Badge>}
                <span className="ml-auto flex items-center gap-1">
                  {c && c !== 'busy' && (
                    <span className={clsx('mr-1 flex max-w-xs items-center gap-1 truncate text-xs', c.ok ? 'text-ok' : 'text-bad')} title={c.message}>
                      {c.ok ? <CheckCircle2 className="size-3.5 shrink-0" /> : <CircleAlert className="size-3.5 shrink-0" />}
                      {c.message}
                    </span>
                  )}
                  <Button size="sm" variant="ghost" busy={c === 'busy'} onClick={() => checkProvider(p)}>
                    Check
                  </Button>
                  {!p.builtin && (
                    <>
                      <IconButton label="Edit provider" onClick={() => setEditing(p)}>
                        <Pencil className="size-4" />
                      </IconButton>
                      <IconButton
                        label="Remove provider"
                        onClick={() => {
                          if (used && !confirm(`${p.name} is used by ${used} route(s); they will fall back to General. Remove it?`)) return;
                          const routes = Object.fromEntries(Object.entries(cfg.routes).map(([k, r]) => [k, r?.providerId === p.id ? null : r])) as RoutingConfig['routes'];
                          void save({ ...cfg, routes, providers: cfg.providers.filter((x) => x.id !== p.id) });
                        }}
                      >
                        <Trash2 className="size-4" />
                      </IconButton>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {external.length === 0 && (
          <Hint>
            Only Anthropic is configured. Add a gateway (OpenRouter, LiteLLM, your own proxy), a cloud provider, or a local Ollama to route some tasks elsewhere.
          </Hint>
        )}
      </Card>

      <Card title="Recent routing decisions" description="Override a session's task here; it applies the next time that session's Claude process starts.">
        {decisions.length === 0 ? (
          <Hint>No sessions have been routed yet{cfg.enabled ? '' : ' — routing is off'}.</Hint>
        ) : (
          <ul className="divide-y divide-line">
            {decisions.map((d, i) => (
              <li key={`${d.sessionId}-${d.at}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className="w-20 shrink-0 text-xs text-ink-3">{timeAgo(d.at)}</span>
                <span className="min-w-0 flex-1 truncate">{d.sessionTitle ?? sessions[d.sessionId]?.title ?? d.sessionId.slice(0, 8)}</span>
                <Badge tone={d.applied ? 'sky' : 'neutral'}>{d.applied ? `${d.task} · ${d.source}` : 'kept'}</Badge>
                <span className="font-mono text-xs text-ink-2">{d.applied ? `${d.providerId} · ${d.model}` : d.reason}</span>
                <Select
                  aria-label="Set task for this session"
                  className="h-8 w-36 text-xs"
                  value=""
                  onChange={async (e) => {
                    const task = e.target.value as TaskKind | 'auto';
                    try {
                      await api.put(`/api/infra/routing/sessions/${d.sessionId}`, { task: task === 'auto' ? null : task });
                      toast('success', task === 'auto' ? 'Task reset to automatic' : `Task set to ${task}`, 'Applies when the session next starts.');
                    } catch (e2) {
                      toast('error', 'Could not set task', err(e2));
                    }
                  }}
                >
                  <option value="">Set task…</option>
                  <option value="auto">Automatic</option>
                  {kinds.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ProviderDialog
        initial={editing}
        existingIds={cfg.providers.map((p) => p.id)}
        onClose={() => setEditing(null)}
        onSave={(p) => {
          const exists = cfg.providers.some((x) => x.id === p.id);
          const providers = exists ? cfg.providers.map((x) => (x.id === p.id ? p : x)) : [...cfg.providers, p];
          setEditing(null);
          void save({ ...cfg, providers: providers.map((x) => ({ ...x, models: x.models.map((m) => m.trim()).filter(Boolean) })) });
        }}
      />
    </div>
  );
}
