import clsx from 'clsx';
import { FolderGit2, FolderPlus, GitBranch, HardDrive, LogOut, Plus, Settings, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Project } from '../../../shared/protocol';
import { Badge, Button, Dialog, Empty, Field, Input, StatusDot, Wordmark } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { STATUS_LABEL, bytes, money, timeAgo } from '../lib/format';
import { useStore } from '../lib/store';
import { socket } from '../lib/ws';

export function TopBar({ children }: { children?: React.ReactNode }) {
  const navigate = useNavigate();
  return (
    <header className="flex h-14 items-center gap-3 border-b border-line bg-ground/80 px-4 backdrop-blur sm:px-6">
      <Link to="/" className="mr-auto">
        <Wordmark className="text-lg" />
      </Link>
      {children}
      <Link to="/settings" className="inline-flex size-9 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2" aria-label="Settings" title="Settings">
        <Settings className="size-[18px]" />
      </Link>
      <button
        className="inline-flex size-9 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2"
        aria-label="Sign out"
        title="Sign out"
        onClick={async () => {
          await api.post('/api/auth/logout');
          socket.stop();
          useStore.setState({ user: null });
          navigate('/login');
        }}
      >
        <LogOut className="size-[18px]" />
      </button>
    </header>
  );
}

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [source, setSource] = useState<'empty' | 'git' | 'path'>('empty');
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.post<{ project: Project }>('/api/projects', {
        name,
        ...(source === 'git' ? { gitUrl, branch: branch || undefined } : {}),
        ...(source === 'path' ? { existingPath: path } : {}),
      });
      useStore.setState((s) => ({ projects: [project, ...s.projects] }));
      onClose();
      navigate(`/p/${project.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const tabs = [
    { id: 'empty', label: 'Start fresh', icon: FolderPlus },
    { id: 'git', label: 'Clone a repo', icon: GitBranch },
    { id: 'path', label: 'Open a folder', icon: HardDrive },
  ] as const;

  return (
    <Dialog open={open} onClose={onClose} title="New project">
      <form onSubmit={create} className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {tabs.map((t) => (
            <button
              type="button"
              key={t.id}
              onClick={() => setSource(t.id)}
              className={clsx(
                'flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-[13px] transition-colors',
                source === t.id ? 'border-ink bg-surface-2 text-ink' : 'border-line text-ink-2 hover:border-line-strong',
              )}
            >
              <t.icon className="size-5" />
              {t.label}
            </button>
          ))}
        </div>
        {source === 'git' && (
          <>
            <Field label="Repository URL" hint="Private GitHub repos work once a GH_TOKEN secret is set in Settings.">
              <Input value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="https://github.com/you/app.git" required />
            </Field>
            <Field label="Branch (optional)">
              <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
            </Field>
          </>
        )}
        {source === 'path' && (
          <Field label="Folder on the server" hint="An absolute path to an existing directory.">
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/code/app" required />
          </Field>
        )}
        <Field label={source === 'empty' ? 'Name' : 'Name (optional)'}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app" required={source === 'empty'} />
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {source === 'git' ? 'Clone project' : 'Create project'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function Dashboard() {
  const { projects, sessions, status, services } = useStore();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const byProject = useMemo(() => {
    const m: Record<string, typeof list> = {};
    const list = Object.values(sessions).filter((s) => !s.archived);
    for (const s of list) (m[s.projectId] ??= []).push(s);
    return m;
  }, [sessions]);

  const needsYou = Object.values(sessions).filter((s) => s.status === 'awaiting_input');
  const working = Object.values(sessions).filter((s) => s.status === 'running' || s.status === 'starting');

  return (
    <div className="flex min-h-full flex-col">
      <TopBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-8 pb-16 sm:px-6">
        {status && !status.claudeAuth.configured && (
          <Link
            to="/settings#claude"
            className="mb-6 flex items-start gap-3 rounded-xl border border-break/50 bg-break-soft px-4 py-3 text-break-ink hover:border-break"
          >
            <TriangleAlert className="mt-0.5 size-5 shrink-0" />
            <span>
              <strong className="font-semibold">Claude isn't connected yet.</strong> Add an Anthropic API key or a Claude subscription token in Settings
              before starting a session.
            </span>
          </Link>
        )}

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[30px] leading-tight font-semibold tracking-[-0.015em]">Projects</h1>
            <p className="mt-1 text-ink-2">
              {working.length || needsYou.length
                ? [working.length && `${working.length} working`, needsYou.length && `${needsYou.length} waiting on you`].filter(Boolean).join(' · ')
                : 'All quiet on the server.'}
              {status?.disk && <span className="text-ink-3"> · {bytes(status.disk.free)} free</span>}
            </p>
          </div>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            New project
          </Button>
        </div>

        {needsYou.length > 0 && (
          <section className="mt-6 space-y-2" aria-label="Sessions waiting on you">
            {needsYou.map((s) => (
              <button
                key={s.id}
                onClick={() => navigate(`/p/${s.projectId}/s/${s.id}`)}
                className="flex w-full items-center gap-3 rounded-xl border border-break/50 bg-surface px-4 py-3 text-left hover:border-break"
              >
                <StatusDot status="awaiting_input" />
                <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
                <span className="text-sm text-break-ink">Needs you →</span>
              </button>
            ))}
          </section>
        )}

        {projects.length === 0 ? (
          <div className="mt-10 rounded-2xl border border-dashed border-line-strong">
            <Empty
              icon={<FolderGit2 className="size-8" />}
              title="No projects yet"
              action={
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
                  New project
                </Button>
              }
            >
              Start an empty project, clone a Git repository, or open a folder that's already on the server.
            </Empty>
          </div>
        ) : (
          <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => {
              const ps = (byProject[p.id] ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
              const live = ps.filter((s) => s.status !== 'idle' && s.status !== 'error');
              const cost = ps.reduce((n, s) => n + s.totalCostUsd, 0);
              const runningApps = services.filter((x) => x.projectId === p.id && x.status === 'running').length;
              const latest = ps[0];
              return (
                <li key={p.id}>
                  <Link
                    to={`/p/${p.id}`}
                    className="group flex h-full flex-col rounded-2xl border border-line bg-surface p-4 shadow-cloud transition-colors hover:border-line-strong"
                  >
                    <div className="flex items-center gap-2">
                      <h2 className="min-w-0 flex-1 truncate font-display text-[17px] font-semibold">{p.name}</h2>
                      {live.length > 0 && <StatusDot status={live.some((s) => s.status === 'awaiting_input') ? 'awaiting_input' : 'running'} />}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11.5px] text-ink-3">{p.path}</p>
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      <Badge>{ps.length} {ps.length === 1 ? 'session' : 'sessions'}</Badge>
                      {runningApps > 0 && <Badge tone="ok">{runningApps} running</Badge>}
                      {cost > 0 && <Badge>{money(cost)}</Badge>}
                    </div>
                    {latest && (
                      <p className="mt-3 truncate border-t border-line pt-3 text-[13px] text-ink-2">
                        <span className="text-ink-3">{STATUS_LABEL[latest.status]} · </span>
                        {latest.title}
                        <span className="text-ink-3"> · {timeAgo(latest.updatedAt)}</span>
                      </p>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
      <NewProjectDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
