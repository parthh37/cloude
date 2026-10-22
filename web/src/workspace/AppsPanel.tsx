import clsx from 'clsx';
import { ExternalLink, Globe, Lock, Monitor, Play, Plus, RefreshCw, RotateCw, Smartphone, Square, Trash2, Unplug, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ListeningPort, Project, ServiceState } from '../../../shared/protocol';
import { Badge, Button, Dialog, Field, IconButton, Input, Select, StatusDot, Toggle } from '../components/ui';
import { SandboxList } from '../infra/SandboxesTab';
import { api, ApiError } from '../lib/api';
import { timeAgo } from '../lib/format';
import { toast, useStore } from '../lib/store';

interface LogLine {
  i: number;
  t: number;
  s: 'out' | 'err' | 'sys';
  text: string;
}

const err = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

function Logs({ service }: { service: ServiceState }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const last = useRef(-1);
  useEffect(() => {
    last.current = -1;
    setLines([]);
    let stop = false;
    const tick = async () => {
      try {
        const r = await api.get<{ lines: LogLine[] }>(`/api/services/${service.id}/logs?after=${last.current}`);
        if (r.lines.length) {
          last.current = r.lines[r.lines.length - 1]!.i;
          setLines((cur) => [...cur, ...r.lines].slice(-2000));
        }
      } catch {
        /* service removed */
      }
      if (!stop) setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [service.id]);
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div ref={box} className="porthole max-h-72 overflow-auto px-3 py-2">
      {lines.length === 0 && <span className="text-port-dim">No output yet.</span>}
      {lines.map((l) => (
        <div key={l.i} className={clsx('whitespace-pre-wrap', l.s === 'err' && 'text-[#f2c4c4]', l.s === 'sys' && 'text-[#7fa9db]')}>
          {l.text || ' '}
        </div>
      ))}
    </div>
  );
}

function ServiceRow({ s, onPreview }: { s: ServiceState; onPreview: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (action: 'start' | 'stop' | 'restart') => {
    setBusy(true);
    await api.post(`/api/services/${s.id}/${action}`).catch((e) => toast('error', `Could not ${action} ${s.name}`, err(e)));
    setBusy(false);
  };
  const running = s.status === 'running' || s.status === 'starting' || s.status === 'building';
  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        {s.status === 'running' ? <span className="size-2.5 shrink-0 rounded-full bg-ok" aria-label="running" /> : <StatusDot status={s.status} />}
        <button onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{s.name}</span>
            {s.kind === 'deploy' && <Badge tone="dawn">deployment</Badge>}
            {s.port && <span className="font-mono text-xs text-ink-3">:{s.port}</span>}
          </span>
          <span className="block truncate font-mono text-[11.5px] text-ink-3">{s.strategy === 'static' ? `static · ${s.command}` : s.command || s.strategy}</span>
        </button>
        {s.urls.private && running && (
          <IconButton label="Preview" onClick={() => onPreview(s.urls.private!)}>
            <Monitor className="size-4" />
          </IconButton>
        )}
        {s.urls.public && (
          <a href={s.urls.public} target="_blank" rel="noreferrer" className="inline-flex size-8 items-center justify-center rounded-lg text-ok hover:bg-surface-2" title="Open public URL">
            <Globe className="size-4" />
          </a>
        )}
        {running ? (
          <>
            <IconButton label="Restart" disabled={busy} onClick={() => act('restart')}>
              <RotateCw className="size-4" />
            </IconButton>
            <IconButton label="Stop" disabled={busy} onClick={() => act('stop')}>
              <Square className="size-3.5 fill-current" />
            </IconButton>
          </>
        ) : (
          <IconButton label="Start" disabled={busy} onClick={() => act('start')}>
            <Play className="size-4 fill-current" />
          </IconButton>
        )}
      </div>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
            <span>Status: {s.status}</span>
            {s.startedAt && <span>started {timeAgo(s.startedAt)}</span>}
            {s.restarts > 0 && <span>{s.restarts} restarts</span>}
            {s.autoRestart && <span>auto-restarts</span>}
            {s.urls.private && (
              <a href={s.urls.private} target="_blank" rel="noreferrer" className="text-sky underline">
                private preview
              </a>
            )}
            {s.urls.public && (
              <a href={s.urls.public} target="_blank" rel="noreferrer" className="text-ok underline">
                {s.urls.public}
              </a>
            )}
            <button
              className="ml-auto inline-flex items-center gap-1 text-bad hover:underline"
              onClick={async () => {
                if (!confirm(`Remove ${s.name}? This stops it and deletes its definition.`)) return;
                await api.del(`/api/services/${s.id}`).catch((e) => toast('error', err(e)));
              }}
            >
              <Trash2 className="size-3.5" /> Remove
            </button>
          </div>
          <Logs service={s} />
        </div>
      )}
    </div>
  );
}

function NewServiceDialog({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ name: '', command: '', cwd: '.', port: '', kind: 'dev', strategy: 'process' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Dialog open={open} onClose={onClose} title="Add a service">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api.post(`/api/projects/${project.id}/services`, {
              ...form,
              port: form.port ? Number(form.port) : null,
              autoRestart: form.kind === 'deploy',
            });
            onClose();
          } catch (er) {
            toast('error', 'Could not add the service', err(er));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input value={form.name} onChange={set('name')} placeholder="web" required />
          </Field>
          <Field label="Type">
            <Select value={form.kind} onChange={set('kind')} className="w-full">
              <option value="dev">Dev server</option>
              <option value="deploy">Deployment (auto-restart)</option>
            </Select>
          </Field>
        </div>
        <Field label="Run as">
          <Select value={form.strategy} onChange={set('strategy')} className="w-full">
            <option value="process">Command</option>
            <option value="docker">Dockerfile in folder</option>
            <option value="static">Static folder</option>
          </Select>
        </Field>
        <Field
          label={form.strategy === 'static' ? 'Folder to serve' : form.strategy === 'docker' ? 'Extra docker run arguments (optional)' : 'Command'}
          hint={form.strategy === 'process' ? '$PORT is set for the process.' : undefined}
        >
          <Input value={form.command} onChange={set('command')} placeholder={form.strategy === 'static' ? 'dist' : form.strategy === 'docker' ? '' : 'npm run dev'} required={form.strategy !== 'docker'} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Working folder">
            <Input value={form.cwd} onChange={set('cwd')} />
          </Field>
          <Field label="Port (optional)">
            <Input value={form.port} onChange={set('port')} inputMode="numeric" placeholder="auto" />
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Add and start
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PublishDialog({ project, port, onClose }: { project: Project; port: number | null; onClose: () => void }) {
  const [label, setLabel] = useState(project.slug);
  const [isPublic, setPublic] = useState(true);
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const previewDomain = useStore((s) => s.status?.previewDomain);
  return (
    <Dialog open={port !== null} onClose={onClose} title={`Publish port ${port}`}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api.post('/api/routes', { label, hostname: hostname || undefined, targetType: 'port', port, isPublic, projectId: project.id });
            toast('success', 'Published', previewDomain ? `${label}.${previewDomain}` : `/apps/${label}/`);
            onClose();
          } catch (er) {
            toast('error', 'Could not publish', err(er));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name" hint={previewDomain ? `Served at https://${label || '…'}.${previewDomain}` : `Served at /apps/${label || '…'}/ on this host`}>
          <Input value={label} onChange={(e) => setLabel(e.target.value.toLowerCase())} required pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?" />
        </Field>
        <Field label="Custom domain (optional)" hint="Point the domain's DNS at this server first.">
          <Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="app.example.com" />
        </Field>
        <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5">
          <span className="text-sm">
            <span className="font-medium">Anyone with the link</span>
            <span className="block text-xs text-ink-3">Off: only you, after signing in to Cloude.</span>
          </span>
          <Toggle checked={isPublic} onChange={setPublic} label="Public" />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Publish
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function AppsPanel({ project }: { project: Project }) {
  // Select the stable array and derive outside the selector: a selector that returns a fresh array
  // on every call makes zustand think the state changed and re-render forever.
  const allServices = useStore((s) => s.services);
  const services = useMemo(() => allServices.filter((x) => x.projectId === project.id), [allServices, project.id]);
  const routes = useStore((s) => s.routes);
  const tunnels = useStore((s) => s.tunnels);
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [phone, setPhone] = useState(false);
  const [adding, setAdding] = useState(false);
  const [publishPort, setPublishPort] = useState<number | null>(null);
  const [frameKey, setFrameKey] = useState(0);

  const loadPorts = () =>
    api
      .get<{ ports: ListeningPort[] }>('/api/ports')
      .then((r) => setPorts(r.ports))
      .catch(() => {});
  useEffect(() => {
    void loadPorts();
    const t = setInterval(loadPorts, 5000);
    return () => clearInterval(t);
  }, []);

  const projectRoutes = routes.filter((r) => r.projectId === project.id || r.projectId === null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {preview && (
        <div className="flex min-h-0 flex-[1.4] flex-col border-b border-line">
          <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">{preview}</span>
            <IconButton label={phone ? 'Desktop width' : 'Phone width'} onClick={() => setPhone(!phone)}>
              {phone ? <Monitor className="size-4" /> : <Smartphone className="size-4" />}
            </IconButton>
            <IconButton label="Reload" onClick={() => setFrameKey((k) => k + 1)}>
              <RefreshCw className="size-4" />
            </IconButton>
            <a href={preview} target="_blank" rel="noreferrer" className="inline-flex size-8 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2" title="Open in new tab">
              <ExternalLink className="size-4" />
            </a>
            <IconButton label="Close preview" onClick={() => setPreview(null)}>
              <X className="size-4" />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-surface-2 p-2">
            <iframe
              key={frameKey}
              src={preview}
              title="App preview"
              className={clsx('h-full rounded-lg border border-line bg-white', phone ? 'mx-auto w-[390px]' : 'w-full')}
            />
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-3">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-display text-[15px] font-semibold">Services</h3>
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
              Add
            </Button>
          </div>
          {services.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line-strong px-3 py-4 text-sm text-ink-2">
              No services yet. Ask Claude to “start the dev server”, or add one yourself. Services keep running and show their logs here.
            </p>
          ) : (
            <div className="space-y-2">
              {services.map((s) => (
                <ServiceRow key={s.id} s={s} onPreview={setPreview} />
              ))}
            </div>
          )}
        </section>

        <section>
          <SandboxList projectId={project.id} compact />
        </section>

        <section>
          <h3 className="mb-2 font-display text-[15px] font-semibold">Listening ports</h3>
          {ports.length === 0 ? (
            <p className="text-sm text-ink-3">Nothing is listening right now.</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {ports.map((p) => (
                <li key={p.port} className="flex items-center gap-2 px-3 py-2">
                  <span className="w-16 shrink-0 font-mono text-sm font-medium">:{p.port}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-3">{p.command ?? 'unknown process'}</span>
                  <Button size="sm" variant="ghost" icon={<Monitor className="size-3.5" />} onClick={() => setPreview(p.previewUrl)} aria-label="Preview" title="Preview">
                    <span className="hidden sm:inline">Preview</span>
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Globe className="size-3.5" />} onClick={() => setPublishPort(p.port)} aria-label="Publish" title="Publish">
                    <span className="hidden sm:inline">Publish</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Temporary public URL via Cloudflare"
                    aria-label="Open tunnel"
                    icon={<Unplug className="size-3.5" />}
                    onClick={async () => {
                      try {
                        const { tunnel } = await api.post<{ tunnel: { url: string } }>('/api/tunnels', { port: p.port });
                        toast('success', 'Tunnel open', tunnel.url);
                      } catch (e) {
                        toast('error', 'Tunnel failed', err(e));
                      }
                    }}
                  >
                    <span className="hidden sm:inline">Tunnel</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="mb-2 font-display text-[15px] font-semibold">Published</h3>
          {projectRoutes.length === 0 && tunnels.length === 0 ? (
            <p className="text-sm text-ink-3">Nothing is published. Publish a port above, or ask Claude to deploy the project.</p>
          ) : (
            <ul className="space-y-2">
              {projectRoutes.map((r) => (
                <li key={r.id} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
                  {r.isPublic ? <Globe className="size-4 shrink-0 text-ok" /> : <Lock className="size-4 shrink-0 text-ink-3" />}
                  <a href={r.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm text-sky underline">
                    {r.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                  </a>
                  <span className="hidden text-xs text-ink-3 sm:inline">{r.targetType === 'port' ? `:${r.port}` : 'static'}</span>
                  <Toggle
                    checked={r.isPublic}
                    label="Public"
                    onChange={(v) => api.patch(`/api/routes/${r.id}`, { isPublic: v }).catch((e) => toast('error', err(e)))}
                  />
                  <IconButton
                    label="Unpublish"
                    onClick={() => confirm(`Unpublish ${r.label}?`) && api.del(`/api/routes/${r.id}`).catch((e) => toast('error', err(e)))}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </li>
              ))}
              {tunnels.map((t) => (
                <li key={t.id} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
                  <Unplug className="size-4 shrink-0 text-dawn" />
                  {t.url ? (
                    <a href={t.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm text-sky underline">
                      {t.url.replace(/^https:\/\//, '')}
                    </a>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-3">{t.error ?? t.status}</span>
                  )}
                  <span className="text-xs text-ink-3">tunnel :{t.port}</span>
                  <IconButton label="Close tunnel" onClick={() => api.del(`/api/tunnels/${t.id}`)}>
                    <X className="size-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <NewServiceDialog project={project} open={adding} onClose={() => setAdding(false)} />
      <PublishDialog project={project} port={publishPort} onClose={() => setPublishPort(null)} />
    </div>
  );
}
