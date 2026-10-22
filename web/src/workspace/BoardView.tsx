import clsx from 'clsx';
import { Bot, CircleCheck, CircleX, GitBranch, GitMerge, Menu, MessageSquare, Pencil, Play, Plus, Sparkles, Square, SquareTerminal, Trash2 } from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { AgentCli, BoardCard, BoardColumn, BoardPriority, Project, Session, TerminalInfo, Worktree } from '../../../shared/protocol';
import { Badge, Button, Dialog, Field, IconButton, Input, Select, Spinner, Textarea, Toggle } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { timeAgo } from '../lib/format';
import { toast, upsertSessions, useStore } from '../lib/store';
import { loadBoard, loadClis, useWorkbench } from '../lib/workbench';
import { WorktreeReview } from './WorktreeReview';

// xterm stays out of the board chunk until a CLI run is opened.
const TermView = lazy(() => import('./TerminalPanel').then((m) => ({ default: m.TermView })));

const COLUMNS: { id: BoardColumn; label: string; hint: string }[] = [
  { id: 'backlog', label: 'Backlog', hint: 'Ideas and later' },
  { id: 'todo', label: 'To do', hint: 'Ready to start' },
  { id: 'in_progress', label: 'In progress', hint: 'An agent is on it' },
  { id: 'review', label: 'Review', hint: 'Agent finished — check and merge' },
  { id: 'done', label: 'Done', hint: 'Merged' },
];
const PRIORITY_TONE: Record<BoardPriority, 'neutral' | 'sky' | 'break' | 'bad'> = { low: 'neutral', medium: 'sky', high: 'break', urgent: 'bad' };
const err = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
const EMPTY: BoardCard[] = [];

function RunChip({ card, session }: { card: BoardCard; session?: Session }) {
  const s = session?.status === 'awaiting_input' ? 'needs_input' : card.runStatus;
  if (!s) return null;
  if (s === 'running')
    return (
      <Badge tone="sky">
        <Spinner className="size-3" /> Running
      </Badge>
    );
  if (s === 'needs_input') return <Badge tone="break">Needs you</Badge>;
  if (s === 'succeeded')
    return (
      <Badge tone="ok">
        <CircleCheck className="size-3" /> Finished
      </Badge>
    );
  if (s === 'failed')
    return (
      <Badge tone="bad">
        <CircleX className="size-3" /> Failed
      </Badge>
    );
  return <Badge>Stopped</Badge>;
}

function CardEditor({
  project,
  card,
  open,
  onClose,
  clis,
  initialColumn,
}: {
  project: Project;
  card: BoardCard | null;
  open: boolean;
  onClose: () => void;
  clis: AgentCli[];
  initialColumn: BoardColumn;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<BoardPriority>('medium');
  const [labels, setLabels] = useState('');
  const [agent, setAgent] = useState('claude');
  const [isolated, setIsolated] = useState(true);
  const [column, setColumn] = useState<BoardColumn>(initialColumn);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(card?.title ?? '');
    setDescription(card?.description ?? '');
    setPriority(card?.priority ?? 'medium');
    setLabels(card?.labels.join(', ') ?? '');
    setAgent(card?.agent ?? 'claude');
    setIsolated(card ? card.isolation === 'worktree' : true);
    setColumn(card?.column ?? initialColumn);
  }, [open, card, initialColumn]);

  async function save(start = false) {
    if (!title.trim()) return;
    setBusy(true);
    const body = {
      title,
      description,
      priority,
      labels: labels.split(',').map((l) => l.trim()).filter(Boolean),
      agent,
      isolation: isolated ? 'worktree' : 'shared',
      column,
    };
    try {
      const { card: saved } = card
        ? await api.patch<{ card: BoardCard }>(`/api/board/${card.id}`, body)
        : await api.post<{ card: BoardCard }>(`/api/projects/${project.id}/board`, body);
      if (start) await api.post(`/api/board/${saved.id}/start`, {});
      onClose();
    } catch (e) {
      toast('error', 'Could not save the card', err(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={card ? 'Edit card' : 'New card'}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Add password reset" autoFocus />
        </Field>
        <Field label="Description" hint="What done looks like — the agent gets this verbatim.">
          <Textarea rows={6} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={'Acceptance criteria:\n- …'} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as BoardPriority)} className="w-full">
              {(['low', 'medium', 'high', 'urgent'] as BoardPriority[]).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Column">
            <Select value={column} onChange={(e) => setColumn(e.target.value as BoardColumn)} className="w-full">
              {COLUMNS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Agent">
            <Select value={agent} onChange={(e) => setAgent(e.target.value)} className="w-full">
              <option value="claude">Claude (session)</option>
              {clis
                .filter((c) => c.headless)
                .map((c) => (
                  <option key={c.id} value={c.id} disabled={!c.installed}>
                    {c.name}
                    {c.installed ? '' : ' — not installed'}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <Field label="Labels" hint="Comma-separated">
          <Input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="ui, backend" />
        </Field>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5 text-sm">
          <span>
            Isolated worktree
            <span className="block text-xs text-ink-3">The agent works on its own branch, so parallel cards never collide.</span>
          </span>
          <Toggle checked={isolated} onChange={setIsolated} label="Isolated worktree" />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="submit" busy={busy} disabled={!title.trim()}>
            Save
          </Button>
          <Button type="button" variant="primary" icon={<Play className="size-4" />} busy={busy} disabled={!title.trim()} onClick={() => void save(true)}>
            Save & start
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PlanDialog({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  async function plan() {
    setBusy(true);
    try {
      const { session } = await api.post<{ session: Session }>(`/api/projects/${project.id}/sessions`, {
        title: `Plan: ${goal.slice(0, 60)}`,
        isolation: 'shared',
        message:
          `Plan the following goal as cards on this project's Cloude board.\n\nGoal: ${goal}\n\n` +
          'First read enough of the codebase to plan well. Then call mcp__workbench__board_add_card once per card: each card should be an ' +
          'independently mergeable change that one agent can finish in its own worktree, with concrete acceptance criteria in the description, ' +
          'a priority, and labels. Put cards that are ready in "todo" and the rest in "backlog". Do not implement anything. ' +
          'Finish with a short summary of the plan and the order you suggest.',
      });
      upsertSessions([session]);
      onClose();
      navigate(`/p/${project.id}/s/${session.id}`);
    } catch (e) {
      toast('error', 'Could not start planning', err(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Plan with Claude">
      <p className="mb-3 text-sm text-ink-2">Describe a goal. Claude studies the code and breaks it into cards you can run in parallel.</p>
      <Textarea rows={5} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Add team accounts with invites, roles and billing per seat" autoFocus />
      <div className="mt-3 flex justify-end">
        <Button variant="primary" icon={<Sparkles className="size-4" />} busy={busy} disabled={!goal.trim()} onClick={plan}>
          Plan it
        </Button>
      </div>
    </Dialog>
  );
}

function TerminalDialog({ projectId, terminalId, onClose }: { projectId: string; terminalId: string; onClose: () => void }) {
  const [info, setInfo] = useState<TerminalInfo | null | undefined>(undefined);
  useEffect(() => {
    api
      .get<{ terminals: TerminalInfo[] }>(`/api/projects/${projectId}/terminals`)
      .then((r) => setInfo(r.terminals.find((t) => t.id === terminalId) ?? null))
      .catch(() => setInfo(null));
  }, [projectId, terminalId]);
  return (
    <Dialog open onClose={onClose} title={info?.title ?? 'Agent run'} wide>
      <div className="h-[60vh] overflow-hidden rounded-lg">
        {info === undefined ? (
          <Spinner />
        ) : info === null ? (
          <p className="text-sm text-ink-3">This run's terminal is gone (the server restarted or it was closed).</p>
        ) : (
          <Suspense fallback={<Spinner />}>
            <TermView info={info} active />
          </Suspense>
        )}
      </div>
    </Dialog>
  );
}

export function BoardView({ project, onOpenSessions }: { project: Project; onOpenSessions: () => void }) {
  const cards = useWorkbench((s) => s.boards[project.id] ?? EMPTY);
  const clis = useWorkbench((s) => s.clis);
  const worktrees = useWorkbench((s) => s.worktrees[project.id]);
  const allSessions = useStore((s) => s.sessions);
  const [editing, setEditing] = useState<{ card: BoardCard | null; column: BoardColumn } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [reviewing, setReviewing] = useState<{ worktree: Worktree; session?: Session } | null>(null);
  const [terminal, setTerminal] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<BoardColumn | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void loadBoard(project.id).catch(() => {});
    if (!clis) void loadClis().catch(() => {});
    api
      .get<{ worktrees: Worktree[] }>(`/api/projects/${project.id}/worktrees`)
      .then((r) => useWorkbench.setState((s) => ({ worktrees: { ...s.worktrees, [project.id]: r.worktrees } })))
      .catch(() => {});
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const byColumn = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const out: Record<BoardColumn, BoardCard[]> = { backlog: [], todo: [], in_progress: [], review: [], done: [] };
    for (const c of cards) {
      if (f && !`${c.title} ${c.description} ${c.labels.join(' ')}`.toLowerCase().includes(f)) continue;
      out[c.column]?.push(c);
    }
    for (const k of Object.keys(out) as BoardColumn[]) out[k].sort((a, b) => a.position - b.position);
    return out;
  }, [cards, filter]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast('error', `${label.split(':')[0]} failed`, err(e));
    } finally {
      setBusy(null);
    }
  }

  function drop(column: BoardColumn, index: number) {
    const id = dragId;
    setDragId(null);
    setOverCol(null);
    if (!id) return;
    // Optimistic: reorder locally so the card doesn't jump back while the request is in flight.
    useWorkbench.setState((s) => ({
      boards: { ...s.boards, [project.id]: (s.boards[project.id] ?? []).map((c) => (c.id === id ? { ...c, column, position: index - 0.5 } : c)) },
    }));
    void act('Move', () => api.post(`/api/board/${id}/move`, { column, index }));
  }

  const wtFor = (c: BoardCard) => (c.worktreeId ? worktrees?.find((w) => w.id === c.worktreeId) : undefined);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <IconButton label="Sessions" className="lg:hidden" onClick={onOpenSessions}>
          <Menu className="size-[18px]" />
        </IconButton>
        <h1 className="font-display text-lg font-semibold">Board</h1>
        <span className="text-sm text-ink-3">{cards.length} cards</span>
        <div className="ml-auto w-40">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="h-8 text-[13px]" />
        </div>
        <Button size="sm" icon={<Sparkles className="size-3.5" />} onClick={() => setPlanning(true)}>
          Plan with Claude
        </Button>
        <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing({ card: null, column: 'todo' })}>
          New card
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto p-3">
        {COLUMNS.map((col) => (
          <section
            key={col.id}
            onDragOver={(e) => {
              e.preventDefault();
              setOverCol(col.id);
            }}
            onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              drop(col.id, byColumn[col.id].length);
            }}
            className={clsx(
              'flex w-[min(82vw,300px)] shrink-0 snap-start flex-col rounded-2xl border bg-ground transition-colors',
              overCol === col.id ? 'border-sky bg-sky-soft/40' : 'border-line',
            )}
          >
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5" title={col.hint}>
              <h2 className="text-[13px] font-semibold tracking-wide text-ink-2 uppercase">{col.label}</h2>
              <span className="text-xs text-ink-3">{byColumn[col.id].length}</span>
              <IconButton label={`Add to ${col.label}`} className="ml-auto size-7" onClick={() => setEditing({ card: null, column: col.id })}>
                <Plus className="size-3.5" />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {byColumn[col.id].map((c, i) => {
                const session = c.sessionId ? allSessions[c.sessionId] : undefined;
                const wt = wtFor(c);
                const running = c.runStatus === 'running' || c.runStatus === 'needs_input';
                return (
                  <article
                    key={c.id}
                    draggable
                    onDragStart={(e) => {
                      setDragId(c.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setDragId(null)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      drop(col.id, i);
                    }}
                    className={clsx('group rounded-xl border border-line bg-surface p-2.5 shadow-cloud', dragId === c.id && 'opacity-50')}
                  >
                    <div className="flex items-start gap-2">
                      <button className="min-w-0 flex-1 text-left text-sm font-medium" onClick={() => setEditing({ card: c, column: c.column })}>
                        {c.title}
                      </button>
                      <Badge tone={PRIORITY_TONE[c.priority]}>{c.priority}</Badge>
                    </div>
                    {c.description && <p className="mt-1 line-clamp-2 text-[12.5px] text-ink-3">{c.description}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      <RunChip card={c} session={session} />
                      {c.agent !== 'claude' && (
                        <Badge>
                          <Bot className="size-3" />
                          {clis?.find((x) => x.id === c.agent)?.name.split(' ')[0] ?? c.agent}
                        </Badge>
                      )}
                      {c.worktreeId && (
                        <Badge tone="dawn" className="max-w-full">
                          <GitBranch className="size-3" />
                          <span className="truncate">{c.worktreeId}</span>
                        </Badge>
                      )}
                      {c.labels.map((l) => (
                        <Badge key={l}>{l}</Badge>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-line pt-1.5">
                      {running ? (
                        <Button size="sm" variant="ghost" icon={<Square className="size-3.5" />} busy={busy === `Stop:${c.id}`} onClick={() => act(`Stop:${c.id}`, () => api.post(`/api/board/${c.id}/stop`))}>
                          Stop
                        </Button>
                      ) : (
                        c.column !== 'done' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Play className="size-3.5" />}
                            busy={busy === `Start:${c.id}`}
                            onClick={() => act(`Start:${c.id}`, () => api.post(`/api/board/${c.id}/start`, {}))}
                          >
                            {c.sessionId || c.terminalId ? 'Continue' : 'Start'}
                          </Button>
                        )
                      )}
                      {c.sessionId && session && (
                        <Link to={`/p/${project.id}/s/${c.sessionId}`} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] text-ink-2 hover:bg-surface-2">
                          <MessageSquare className="size-3.5" /> Chat
                        </Link>
                      )}
                      {c.terminalId && (
                        <Button size="sm" variant="ghost" icon={<SquareTerminal className="size-3.5" />} onClick={() => setTerminal(c.terminalId)}>
                          Output
                        </Button>
                      )}
                      {wt && c.column !== 'done' && (
                        <Button size="sm" variant="ghost" icon={<GitMerge className="size-3.5" />} onClick={() => setReviewing({ worktree: wt, session })}>
                          Review
                        </Button>
                      )}
                      <span className="ml-auto text-[11px] whitespace-nowrap text-ink-3 group-hover:hidden">{timeAgo(c.updatedAt)}</span>
                      <span className="ml-auto hidden gap-0.5 group-hover:flex">
                        <IconButton label="Edit" className="size-7" onClick={() => setEditing({ card: c, column: c.column })}>
                          <Pencil className="size-3.5" />
                        </IconButton>
                        <IconButton
                          label="Delete card"
                          className="size-7"
                          onClick={() => confirm(`Delete "${c.title}"? Its session and branch are kept.`) && act('Delete', () => api.del(`/api/board/${c.id}`))}
                        >
                          <Trash2 className="size-3.5" />
                        </IconButton>
                      </span>
                    </div>
                  </article>
                );
              })}
              {byColumn[col.id].length === 0 && <p className="px-2 py-6 text-center text-xs text-ink-3">{col.hint}</p>}
            </div>
          </section>
        ))}
      </div>

      <CardEditor
        project={project}
        card={editing?.card ?? null}
        open={!!editing}
        onClose={() => setEditing(null)}
        clis={clis ?? []}
        initialColumn={editing?.column ?? 'todo'}
      />
      <PlanDialog project={project} open={planning} onClose={() => setPlanning(false)} />
      {reviewing && <WorktreeReview project={project} worktree={reviewing.worktree} session={reviewing.session} open onClose={() => setReviewing(null)} />}
      {terminal && <TerminalDialog projectId={project.id} terminalId={terminal} onClose={() => setTerminal(null)} />}
    </div>
  );
}
