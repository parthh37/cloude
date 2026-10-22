import clsx from 'clsx';
import { ArrowLeft, FolderTree, GitBranch, MessageSquare, PanelRightClose, Plus, Rocket, SquareTerminal, X } from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Project, Session } from '../../../shared/protocol';
import { Button, Empty, IconButton, Spinner, StatusDot, Wordmark } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { money, timeAgo } from '../lib/format';
import { toast, upsertSessions, useStore } from '../lib/store';
import { AppsPanel } from '../workspace/AppsPanel';
import { ChatView } from '../workspace/ChatView';
import { GitPanel } from '../workspace/GitPanel';

// Editor (CodeMirror) and terminal (xterm) are the heaviest parts of the bundle; load them on first use.
const FilesPanel = lazy(() => import('../workspace/FilesPanel').then((m) => ({ default: m.FilesPanel })));
const TerminalPanel = lazy(() => import('../workspace/TerminalPanel').then((m) => ({ default: m.TerminalPanel })));

type Panel = 'files' | 'terminal' | 'apps' | 'git';
const PANELS: { id: Panel; label: string; icon: typeof FolderTree }[] = [
  { id: 'files', label: 'Files', icon: FolderTree },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'apps', label: 'Apps', icon: Rocket },
  { id: 'git', label: 'Git', icon: GitBranch },
];

function useMedia(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

function SessionList({ project, sessions, activeId, onPick }: { project: Project; sessions: Session[]; activeId?: string; onPick: () => void }) {
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const visible = sessions.filter((s) => (showArchived ? s.archived : !s.archived)).sort((a, b) => b.updatedAt - a.updatedAt);

  async function create() {
    setCreating(true);
    try {
      const { session } = await api.post<{ session: Session }>(`/api/projects/${project.id}/sessions`, {});
      upsertSessions([session]);
      navigate(`/p/${project.id}/s/${session.id}`);
      onPick();
    } catch (e) {
      toast('error', 'Could not start a session', e instanceof ApiError ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pt-3">
        <Link to="/" className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink">
          <ArrowLeft className="size-3.5" /> All projects
        </Link>
        <h2 className="mt-2 truncate font-display text-lg font-semibold" title={project.path}>
          {project.name}
        </h2>
        <Button variant="primary" className="mt-3 w-full" icon={<Plus className="size-4" />} onClick={create} busy={creating}>
          New session
        </Button>
      </div>
      <nav className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Sessions">
        {visible.length === 0 && <p className="px-2 py-6 text-center text-sm text-ink-3">{showArchived ? 'No archived sessions.' : 'No sessions yet.'}</p>}
        {visible.map((s) => (
          <Link
            key={s.id}
            to={`/p/${project.id}/s/${s.id}`}
            onClick={onPick}
            className={clsx(
              'mb-0.5 flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors',
              s.id === activeId ? 'bg-surface shadow-cloud' : 'hover:bg-surface-2',
            )}
          >
            <StatusDot status={s.status} className="mt-1.5" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{s.title}</span>
              <span className="block text-xs text-ink-3">
                {s.status === 'awaiting_input' ? <span className="font-semibold text-break-ink">Needs you</span> : timeAgo(s.updatedAt)}
                {s.totalCostUsd > 0 && ` · ${money(s.totalCostUsd)}`}
              </span>
            </span>
          </Link>
        ))}
      </nav>
      <button onClick={() => setShowArchived(!showArchived)} className="border-t border-line px-4 py-2.5 text-left text-xs text-ink-3 hover:text-ink">
        {showArchived ? '← Back to active sessions' : 'Show archived'}
      </button>
    </div>
  );
}

export function Workspace() {
  const params = useParams();
  const projectId = params.projectId!;
  const sessionId = /^s\/([\w-]+)/.exec(params['*'] ?? '')?.[1];
  const navigate = useNavigate();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const allSessions = useStore((s) => s.sessions);
  const sessions = useMemo(() => Object.values(allSessions).filter((s) => s.projectId === projectId), [allSessions, projectId]);
  const session = sessionId ? allSessions[sessionId] : undefined;
  const desktop = useMedia('(min-width: 1024px)');

  const [mobileView, setMobileView] = useState<'chat' | Panel>('chat');
  const [sidePanel, setSidePanel] = useState<Panel | null>(() => (localStorage.getItem('cloude.sidePanel') as Panel | null) ?? 'files');
  const [visited, setVisited] = useState<Set<Panel>>(new Set());
  const [drawer, setDrawer] = useState(false);

  const activePanel: Panel | null = desktop ? sidePanel : mobileView === 'chat' ? null : mobileView;
  useEffect(() => {
    if (activePanel) setVisited((v) => (v.has(activePanel) ? v : new Set(v).add(activePanel)));
  }, [activePanel]);
  useEffect(() => {
    if (sidePanel) localStorage.setItem('cloude.sidePanel', sidePanel);
    else localStorage.removeItem('cloude.sidePanel');
  }, [sidePanel]);

  // Load the project's sessions (including archived) once.
  useEffect(() => {
    api
      .get<{ sessions: Session[] }>(`/api/projects/${projectId}/sessions?archived=true`)
      .then(({ sessions }) => upsertSessions(sessions))
      .catch(() => {});
    if (!project) {
      api
        .get<{ project: Project }>(`/api/projects/${projectId}`)
        .then(({ project }) => useStore.setState((s) => ({ projects: [...s.projects.filter((p) => p.id !== project.id), project] })))
        .catch(() => navigate('/'));
    }
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Land on the most recent session when none is selected.
  useEffect(() => {
    if (sessionId || !desktop) return;
    const latest = sessions.filter((s) => !s.archived).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) navigate(`/p/${projectId}/s/${latest.id}`, { replace: true });
  }, [sessionId, sessions.length, desktop]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project)
    return (
      <div className="grid h-full place-items-center text-ink-3">
        <Spinner className="size-6" />
      </div>
    );

  const sidebar = <SessionList project={project} sessions={sessions} activeId={sessionId} onPick={() => setDrawer(false)} />;

  const chat = session ? (
    <ChatView session={session} project={project} onOpenSessions={() => setDrawer(true)} />
  ) : (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 lg:hidden">
        <Link to="/">
          <Wordmark />
        </Link>
      </div>
      <div className="flex-1 overflow-y-auto">
        {desktop ? (
          <Empty title="Pick a session or start a new one">Each session is its own Claude conversation in this project. They run side by side.</Empty>
        ) : (
          sidebar
        )}
      </div>
    </div>
  );

  const panels = (
    <Suspense
      fallback={
        <div className="grid h-full place-items-center text-ink-3">
          <Spinner className="size-5" />
        </div>
      }
    >
      {PANELS.map(({ id }) =>
        visited.has(id) ? (
          <div key={id} className={clsx('h-full min-h-0', activePanel === id ? 'flex flex-col' : 'hidden')}>
            {id === 'files' && <FilesPanel project={project} />}
            {id === 'terminal' && <TerminalPanel project={project} visible={activePanel === 'terminal'} />}
            {id === 'apps' && <AppsPanel project={project} />}
            {id === 'git' && <GitPanel project={project} visible={activePanel === 'git'} />}
          </div>
        ) : null,
      )}
    </Suspense>
  );

  if (desktop) {
    return (
      <div className="flex h-full">
        <aside className="w-64 shrink-0 border-r border-line bg-ground">{sidebar}</aside>
        <main className="relative min-w-0 flex-1">{chat}</main>
        <section className={clsx('flex shrink-0 flex-col border-l border-line bg-surface', sidePanel ? 'w-[min(40vw,680px)]' : 'w-12')}>
          <div className={clsx('flex border-b border-line', sidePanel ? 'items-center gap-1 px-2 py-1.5' : 'flex-col items-center gap-1 py-2')}>
            {PANELS.map((p) => (
              <button
                key={p.id}
                onClick={() => setSidePanel(sidePanel === p.id ? null : p.id)}
                title={p.label}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors',
                  sidePanel ? 'h-8 px-2.5' : 'size-9 justify-center',
                  sidePanel === p.id ? 'bg-ink text-ground' : 'text-ink-2 hover:bg-surface-2',
                )}
              >
                <p.icon className="size-4" />
                {sidePanel && p.label}
              </button>
            ))}
            {sidePanel && (
              <IconButton label="Collapse panel" className="ml-auto" onClick={() => setSidePanel(null)}>
                <PanelRightClose className="size-[18px]" />
              </IconButton>
            )}
          </div>
          <div className="min-h-0 flex-1">{panels}</div>
        </section>
      </div>
    );
  }

  // ---- phone / tablet ----
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <div className={clsx('h-full', mobileView === 'chat' ? 'block' : 'hidden')}>{chat}</div>
        <div className={clsx('h-full bg-surface', mobileView === 'chat' && 'hidden')}>{panels}</div>
      </div>
      <nav className="pb-safe flex border-t border-line bg-ground" aria-label="Workspace">
        {[{ id: 'chat' as const, label: 'Chat', icon: MessageSquare }, ...PANELS].map((p) => (
          <button
            key={p.id}
            onClick={() => setMobileView(p.id)}
            className={clsx('flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium', mobileView === p.id ? 'text-ink' : 'text-ink-3')}
            aria-current={mobileView === p.id}
          >
            <p.icon className="size-5" />
            {p.label}
          </button>
        ))}
      </nav>
      {drawer && (
        <div className="fixed inset-0 z-40 flex" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-ink/30" />
          <aside className="relative h-full w-[82%] max-w-xs bg-ground shadow-cloud" onClick={(e) => e.stopPropagation()}>
            <IconButton label="Close" className="absolute top-2 right-2" onClick={() => setDrawer(false)}>
              <X className="size-4" />
            </IconButton>
            {sidebar}
          </aside>
        </div>
      )}
    </div>
  );
}
