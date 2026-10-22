import clsx from 'clsx';
import { Boxes, Camera, ExternalLink, History, Pin, PinOff, Play, Plus, Square, SquareTerminal, TerminalSquare, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { Sandbox, SandboxCreateInput, SandboxExecResult, SandboxIsolation, SandboxMount, SandboxRuntimeInfo } from '../../../shared/protocol';
import { Badge, Button, Dialog, Field, IconButton, Input, Select, Textarea, Toggle } from '../components/ui';
import { api } from '../lib/api';
import { bytes, timeAgo } from '../lib/format';
import { toast, useStore } from '../lib/store';
import { Card, Dot, Hint, err, usePoll } from './shared';

const ISOLATION_LABEL: Record<SandboxIsolation, string> = { container: 'Container', gvisor: 'gVisor', system: 'System (systemd + Docker)', microvm: 'MicroVM' };
const MOUNT_LABEL: Record<SandboxMount, string> = { copy: 'Private copy of the project', ro: 'Live project, read-only', rw: 'Live project, read-write', none: 'Empty machine' };

export function CreateSandboxDialog({ open, onClose, runtime, projectId, onCreated }: { open: boolean; onClose: () => void; runtime: SandboxRuntimeInfo | null; projectId?: string; onCreated: () => void }) {
  const projects = useStore((s) => s.projects);
  const [form, setForm] = useState({
    projectId: projectId ?? '',
    name: '',
    image: 'ubuntu:24.04',
    customImage: '',
    isolation: 'container' as SandboxIsolation,
    ports: '',
    mount: 'copy' as SandboxMount,
    network: 'project' as 'project' | 'isolated',
    cpus: '2',
    memoryMb: '2048',
    ttlMinutes: '',
    pinned: false,
    init: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const pid = projectId ?? form.projectId;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: SandboxCreateInput = {
        projectId: pid,
        name: form.name.trim().toLowerCase(),
        image: form.image === 'custom' ? form.customImage.trim() : form.image,
        isolation: form.isolation,
        ports: form.ports
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number),
        mount: form.mount,
        network: form.network,
        cpus: Number(form.cpus) || undefined,
        memoryMb: Number(form.memoryMb) || undefined,
        ttlMinutes: form.ttlMinutes ? Number(form.ttlMinutes) : null,
        pinned: form.pinned,
        init: form.init.trim() || undefined,
      };
      const r = await api.post<{ sandbox: Sandbox; init?: SandboxExecResult }>('/api/infra/sandboxes', { ...body });
      if (r.init && r.init.code !== 0) toast('warning', `${r.sandbox.name} created, but setup failed`, (r.init.stderr || r.init.stdout).slice(-300));
      else toast('success', `Sandbox ${r.sandbox.name} is running`);
      onCreated();
      onClose();
      set({ name: '', init: '', ports: '' });
    } catch (e2) {
      setError(err(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="New sandbox" wide>
      <form onSubmit={create} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {!projectId && (
            <Field label="Project">
              <Select value={form.projectId} onChange={(e) => set({ projectId: e.target.value })} required>
                <option value="">Choose…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Name" hint="Other sandboxes in the project reach it by this name">
            <Input value={form.name} onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="pg-test" required maxLength={31} />
          </Field>
          <Field label="Image">
            <Select value={form.image} onChange={(e) => set({ image: e.target.value })}>
              {runtime?.images.map((i) => (
                <option key={i.image} value={i.image}>
                  {i.label}
                </option>
              ))}
              <option value="custom">Other image…</option>
            </Select>
          </Field>
          {form.image === 'custom' && (
            <Field label="Image reference">
              <Input value={form.customImage} onChange={(e) => set({ customImage: e.target.value })} placeholder="fedora:41" required />
            </Field>
          )}
          <Field label="Isolation">
            <Select value={form.isolation} onChange={(e) => set({ isolation: e.target.value as SandboxIsolation })}>
              {runtime?.isolations.map((i) => (
                <option key={i.id} value={i.id} disabled={!i.available}>
                  {ISOLATION_LABEL[i.id]}
                  {i.available ? '' : ' — not installed'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Project files">
            <Select value={form.mount} onChange={(e) => set({ mount: e.target.value as SandboxMount })}>
              {(Object.keys(MOUNT_LABEL) as SandboxMount[]).map((m) => (
                <option key={m} value={m}>
                  {MOUNT_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Ports to publish" hint="Each gets a free host port + preview URL">
            <Input value={form.ports} onChange={(e) => set({ ports: e.target.value })} placeholder="3000, 5432" />
          </Field>
          <Field label="Network">
            <Select value={form.network} onChange={(e) => set({ network: e.target.value as 'project' | 'isolated' })}>
              <option value="project">Project network (internet + peers)</option>
              <option value="isolated">Isolated (no network)</option>
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="CPUs">
              <Input type="number" min={0.25} step={0.25} value={form.cpus} onChange={(e) => set({ cpus: e.target.value })} />
            </Field>
            <Field label="Memory MB">
              <Input type="number" min={128} step={128} value={form.memoryMb} onChange={(e) => set({ memoryMb: e.target.value })} />
            </Field>
            <Field label="Idle TTL (min)">
              <Input type="number" min={5} value={form.ttlMinutes} onChange={(e) => set({ ttlMinutes: e.target.value })} placeholder="policy" />
            </Field>
          </div>
        </div>
        <Field label="Setup command (optional)" hint="Runs once after boot, as root">
          <Textarea value={form.init} onChange={(e) => set({ init: e.target.value })} rows={2} className="font-mono text-[13px]" placeholder="apt-get update && apt-get install -y postgresql" />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Toggle checked={form.pinned} onChange={(v) => set({ pinned: v })} label="Pinned" />
          Pinned — never reclaimed automatically
        </label>
        {error && <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!pid || !form.name}>
            Create sandbox
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Console({ sandbox }: { sandbox: Sandbox }) {
  const [cmd, setCmd] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<{ cmd: string; r: SandboxExecResult }[]>([]);
  return (
    <div className="mt-2 space-y-2">
      {log.length > 0 && (
        <div className="porthole max-h-72 overflow-auto px-3 py-2">
          {log.map((l, i) => (
            <div key={i} className="mb-2">
              <div className="text-[#7fa9db]">
                # {l.cmd} <span className="text-port-dim">→ {l.r.code}</span>
              </div>
              {l.r.stdout && <pre className="whitespace-pre-wrap">{l.r.stdout}</pre>}
              {l.r.stderr && <pre className="whitespace-pre-wrap text-[#f2c4c4]">{l.r.stderr}</pre>}
            </div>
          ))}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!cmd.trim()) return;
          setBusy(true);
          try {
            const { result } = await api.post<{ result: SandboxExecResult }>(`/api/infra/sandboxes/${sandbox.id}/exec`, { command: cmd });
            setLog((l) => [...l, { cmd, r: result }].slice(-30));
            setCmd('');
          } catch (e2) {
            toast('error', 'Command failed', err(e2));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="uname -a" className="font-mono text-[13px]" />
        <Button type="submit" busy={busy}>
          Run
        </Button>
      </form>
    </div>
  );
}

function SandboxRow({ s, projectName, sessionTitle, onChange }: { s: Sandbox; projectName?: string; sessionTitle?: string; onChange: () => void }) {
  const [showConsole, setShowConsole] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (action: string, body: Record<string, unknown> = {}, ok?: string) => {
    setBusy(action);
    try {
      const r = await api.post<{ terminal?: { title: string } }>(`/api/infra/sandboxes/${s.id}/${action}`, body);
      if (ok) toast('success', ok);
      if (r.terminal) toast('success', `Opened “${r.terminal.title}”`, `In ${projectName ?? 'the project'}'s Terminal panel`);
      onChange();
    } catch (e) {
      toast('error', `${action} failed`, err(e));
    } finally {
      setBusy(null);
    }
  };
  const tone = s.status === 'running' ? 'ok' : s.status === 'error' ? 'bad' : s.status === 'stopped' ? 'idle' : 'busy';

  return (
    <li className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <Dot tone={tone} />
        <span className="font-mono text-sm font-semibold">{s.name}</span>
        {projectName && <span className="text-xs text-ink-3">{projectName}</span>}
        <Badge>{s.image}</Badge>
        {s.isolation !== 'container' && <Badge tone="dawn">{ISOLATION_LABEL[s.isolation]}</Badge>}
        {s.mount !== 'copy' && <Badge tone={s.mount === 'rw' ? 'break' : 'neutral'}>{s.mount === 'none' ? 'empty' : `live ${s.mount}`}</Badge>}
        {s.network === 'isolated' && <Badge>no network</Badge>}
        {s.pinned && <Badge tone="sky">pinned</Badge>}
        <span className="ml-auto flex items-center gap-0.5">
          {s.status === 'running' ? (
            <IconButton label="Stop (keeps files)" onClick={() => act('stop')} disabled={!!busy}>
              <Square className="size-4" />
            </IconButton>
          ) : (
            <IconButton label="Start" onClick={() => act('start')} disabled={!!busy || s.status === 'creating'}>
              <Play className="size-4" />
            </IconButton>
          )}
          <IconButton label="Command console" onClick={() => setShowConsole(!showConsole)}>
            <TerminalSquare className={clsx('size-4', showConsole && 'text-sky')} />
          </IconButton>
          <IconButton label="Open a root shell in the Terminal panel" onClick={() => act('shell')} disabled={!!busy}>
            <SquareTerminal className="size-4" />
          </IconButton>
          <IconButton
            label="Snapshot"
            onClick={() => {
              const label = prompt('Snapshot label', `snapshot ${s.snapshots.length + 1}`);
              if (label !== null) void act('snapshot', { label }, 'Snapshot saved');
            }}
            disabled={!!busy}
          >
            <Camera className="size-4" />
          </IconButton>
          <IconButton label={s.pinned ? 'Unpin' : 'Pin (never auto-reclaim)'} onClick={() => api.patch(`/api/infra/sandboxes/${s.id}`, { pinned: !s.pinned }).then(onChange)}>
            {s.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          </IconButton>
          <IconButton
            label="Destroy"
            onClick={() => confirm(`Destroy sandbox ${s.name} and its snapshots? Its files are deleted.`) && act('destroy', {}, `Destroyed ${s.name}`)}
            disabled={!!busy}
          >
            <Trash2 className="size-4" />
          </IconButton>
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 pl-5 text-xs text-ink-3">
        <span>
          {s.status}
          {busy && ` · ${busy}…`}
        </span>
        <span>
          {s.limits.cpus} CPU · {s.limits.memoryMb} MB
        </span>
        {s.sizeBytes !== null && <span>{bytes(s.sizeBytes)} on disk</span>}
        <span>used {timeAgo(s.lastActiveAt)}</span>
        <span>{sessionTitle ? `by “${sessionTitle}”` : s.sessionId ? 'by a deleted session' : 'created by you'}</span>
        {s.ports.map((p) => (
          <a key={p.container} href={p.previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky underline">
            :{p.container} <ExternalLink className="size-3" />
          </a>
        ))}
        {s.snapshots.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <History className="size-3.5" />
            <select
              className="rounded border border-line bg-surface px-1 py-0.5 text-xs text-ink-2"
              value=""
              aria-label="Restore a snapshot"
              onChange={(e) => e.target.value && confirm('Restore this snapshot? Running processes restart.') && act('restore', { snapshotId: e.target.value }, 'Restored')}
            >
              <option value="">{s.snapshots.length} snapshot(s) — restore…</option>
              {s.snapshots.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label} · {timeAgo(x.createdAt)}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>
      {s.error && <p className="mt-1.5 pl-5 text-xs text-bad">{s.error}</p>}
      {showConsole && <Console sandbox={s} />}
    </li>
  );
}

/** Sandboxes, optionally for one project. Used by the control center and the workspace Apps panel. */
export function SandboxList({ projectId, compact }: { projectId?: string; compact?: boolean }) {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const names = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p.name])), [projects]);
  const [creating, setCreating] = useState(false);
  const { data, reload } = usePoll(() => api.get<{ sandboxes: Sandbox[] }>(`/api/infra/sandboxes${projectId ? `?projectId=${projectId}` : ''}`), 5000, [projectId]);
  const { data: rt } = usePoll(() => api.get<{ runtime: SandboxRuntimeInfo }>('/api/infra/runtime'), 0);
  const list = data?.sandboxes ?? [];

  return (
    <div>
      <div className={clsx('flex items-center justify-between gap-2', compact ? 'mb-2' : 'mb-3')}>
        {compact ? <h3 className="font-display text-[15px] font-semibold">Sandboxes</h3> : <span className="text-sm text-ink-2">{list.length} sandbox(es)</span>}
        <span className="flex items-center gap-1">
          {compact && (
            <Link to="/infra?tab=sandboxes" className="text-xs text-sky hover:underline">
              Control center
            </Link>
          )}
          <Button size="sm" variant={compact ? 'ghost' : 'primary'} icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)} disabled={rt?.runtime.available === false}>
            {compact ? 'New' : 'New sandbox'}
          </Button>
        </span>
      </div>
      {rt?.runtime.available === false && <p className="mb-2 rounded-lg bg-break-soft px-3 py-2 text-sm text-break-ink">Sandboxes need Docker: {rt.runtime.reason}</p>}
      {list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong px-3 py-4 text-sm text-ink-2">
          No sandboxes. Ask Claude to “test this in a clean Ubuntu sandbox”, or create one. Sandboxes are disposable machines with full root access — idle ones are cleaned up automatically.
        </p>
      ) : (
        <ul className="space-y-2">
          {list.map((s) => (
            <SandboxRow key={s.id} s={s} projectName={projectId ? undefined : names[s.projectId]} sessionTitle={s.sessionId ? sessions[s.sessionId]?.title : undefined} onChange={reload} />
          ))}
        </ul>
      )}
      <CreateSandboxDialog open={creating} onClose={() => setCreating(false)} runtime={rt?.runtime ?? null} projectId={projectId} onCreated={reload} />
    </div>
  );
}

export function SandboxesTab() {
  // Re-poll so the quota counter follows creations; "Re-detect" re-probes Docker's runtimes.
  const { data, reload } = usePoll(() => api.get<{ runtime: SandboxRuntimeInfo }>('/api/infra/runtime'), 5000);
  const rt = data?.runtime;
  return (
    <div className="space-y-5">
      <Card
        title={
          <span className="flex items-center gap-2">
            <Boxes className="size-5 text-dawn" /> Sandboxes
          </span>
        }
        description="Disposable machines Claude controls completely — root access, any package, databases, systemd, Docker — without touching this server. Each gets its own name, a free host port per published port, and a private project network, so nothing ever collides."
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => api.get('/api/infra/runtime?refresh=1').then(reload, (e) => toast('error', 'Docker check failed', err(e)))}
          >
            Re-detect
          </Button>
        }
      >
        {rt ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Dot tone={rt.available ? 'ok' : 'bad'} />
                {rt.available ? <span>{rt.engine}</span> : <span className="text-bad">{rt.reason}</span>}
                {rt.kvm && <Badge tone="ok">KVM</Badge>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {rt.isolations.map((i) => (
                  <span key={i.id} title={i.note}>
                    <Badge tone={i.available ? 'ok' : 'neutral'}>
                      {ISOLATION_LABEL[i.id]} {i.available ? `· ${i.runtime}` : '· not installed'}
                    </Badge>
                  </span>
                ))}
              </div>
              {rt.isolations.some((i) => !i.available) && (
                <Hint>Stronger isolation levels appear automatically once their runtime is registered with Docker (gVisor: runsc · full OS: sysbox-runc · microVM: Kata + /dev/kvm).</Hint>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:text-right">
              <dt className="text-ink-3">In use</dt>
              <dd>
                {rt.quota.used} / {rt.quota.total}
              </dd>
              <dt className="text-ink-3">Per project</dt>
              <dd>{rt.quota.perProject}</dd>
              <dt className="text-ink-3">Instance tag</dt>
              <dd className="font-mono text-xs">{rt.instance}</dd>
            </dl>
          </div>
        ) : (
          'Checking Docker…'
        )}
      </Card>
      <Card>
        <SandboxList />
      </Card>
    </div>
  );
}
