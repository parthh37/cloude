import clsx from 'clsx';
import { Archive, Brain, History, Menu, MoreHorizontal, Power, Trash2, TriangleAlert } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { EffortLevel, PermissionMode, Project, Session } from '../../../shared/protocol';
import { Badge, IconButton, Select, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { MODE_LABEL, STATUS_LABEL, duration, money } from '../lib/format';
import { toast, useStore, type DraftBlock } from '../lib/store';
import { buildTimeline, type TimelineItem } from '../lib/timeline';
import { socket } from '../lib/ws';
import { Composer } from './Composer';
import { Markdown } from './Markdown';
import { PermissionCard } from './PermissionCard';
import { ToolCard } from './ToolCard';
import { WorktreeChip } from './WorktreeChip';

const MODELS = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
];
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const EFFORTS: (EffortLevel | '')[] = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

async function patchSession(id: string, body: Record<string, unknown>) {
  try {
    await api.patch(`/api/sessions/${id}`, body);
  } catch (e) {
    toast('error', 'Could not update the session', e instanceof ApiError ? e.message : String(e));
  }
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[13.5px] text-ink-3">
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1.5 hover:text-ink-2">
        <Brain className="size-3.5" /> {live ? 'Thinking…' : 'Thought'} {open ? '' : '· show'}
      </button>
      {open && <p className="mt-1 border-l-2 border-line pl-3 whitespace-pre-wrap italic">{text}</p>}
    </div>
  );
}

function UserBubble({ item, sessionId }: { item: Extract<TimelineItem, { kind: 'user' }>; sessionId: string }) {
  const [menu, setMenu] = useState(false);
  async function rewind() {
    setMenu(false);
    if (!item.uuid || !confirm('Restore all files Claude changed after this message to how they were at this point?')) return;
    try {
      const { result } = await api.post<{ result: { canRewind?: boolean; error?: string; filesChanged?: string[] } }>(`/api/sessions/${sessionId}/rewind`, {
        uuid: item.uuid,
      });
      if (result?.error) toast('error', 'Rewind failed', result.error);
      else toast('success', 'Files restored', result?.filesChanged?.length ? `${result.filesChanged.length} files` : undefined);
    } catch (e) {
      toast('error', 'Rewind failed', e instanceof ApiError ? e.message : String(e));
    }
  }
  return (
    <div className="group flex justify-end">
      <div className="relative max-w-[88%]">
        {item.images.length > 0 && (
          <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
            {item.images.map((img, i) =>
              img.data ? <img key={i} src={`data:${img.mediaType};base64,${img.data}`} alt={img.name ?? ''} className="max-h-40 rounded-lg border border-line" /> : null,
            )}
          </div>
        )}
        {item.text && <div className="rounded-xl rounded-br-sm border border-sky/30 bg-sky-soft px-3.5 py-2 text-[15px] whitespace-pre-wrap text-ink">{item.text}</div>}
        {item.uuid && (
          <button
            aria-label="Message actions"
            onClick={() => setMenu(!menu)}
            className="absolute top-1 -left-8 rounded-md p-1 text-ink-3 opacity-0 group-hover:opacity-100 hover:text-ink focus:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </button>
        )}
        {menu && (
          <div className="absolute top-7 right-full z-10 mr-1 w-56 rounded-xl border border-line bg-surface p-1 shadow-cloud">
            <button onClick={rewind} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2">
              <History className="size-4" /> Restore files to this point
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const Item = memo(function Item({ item, root, sessionId, progress }: { item: TimelineItem; root: string; sessionId: string; progress: Record<string, number> }) {
  const renderChildren = (items: TimelineItem[]): ReactNode =>
    items.map((c) => <Item key={c.key} item={c} root={root} sessionId={sessionId} progress={progress} />);
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} sessionId={sessionId} />;
    case 'text':
      return <Markdown text={item.text} className="text-[15px]" />;
    case 'thinking':
      return <Thinking text={item.text} />;
    case 'tool':
      return <ToolCard call={item.call} root={root} progress={progress[item.call.id]} renderChildren={renderChildren} />;
    case 'command_output':
      return <pre className="porthole overflow-x-auto px-3 py-2 whitespace-pre-wrap">{item.text || '(no output)'}</pre>;
    case 'marker':
      return (
        <div className={clsx('flex items-center gap-3 py-1 text-xs', item.tone === 'bad' ? 'text-bad' : item.tone === 'warn' ? 'text-break-ink' : 'text-ink-3')}>
          <span className="h-px flex-1 bg-line" />
          <span className="max-w-[80%] text-center" title={item.detail}>
            {item.label}
            {item.detail && <span className="hidden sm:inline"> · {item.detail}</span>}
          </span>
          <span className="h-px flex-1 bg-line" />
        </div>
      );
    case 'result':
      return (
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-ink-3">
          {!item.ok && <span className="text-bad">{item.text || 'Turn ended with an error'} ·</span>}
          <span>
            {duration(item.durationMs)} · {item.turns} {item.turns === 1 ? 'step' : 'steps'}
          </span>
        </div>
      );
    case 'error':
      return (
        <div className="flex items-start gap-2 rounded-xl border border-bad/40 bg-bad-soft px-3 py-2 text-sm text-bad">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <pre className="font-sans whitespace-pre-wrap">{item.message}</pre>
        </div>
      );
  }
});

function Drafts({ drafts }: { drafts: DraftBlock[] }) {
  return (
    <>
      {drafts
        .filter((d) => !d.parentToolUseId)
        .map((d) =>
          d.type === 'text' ? (
            <Markdown key={d.key} text={d.text + ' ▍'} className="text-[15px]" />
          ) : d.type === 'thinking' ? (
            <Thinking key={d.key} text={d.text} live />
          ) : (
            <div key={d.key} className="flex items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-sm text-ink-3">
              <Spinner className="size-3.5" /> Preparing {d.toolName}
              {d.text.length > 200 && <span className="text-xs">· {Math.round(d.text.length / 1024)} KB</span>}
            </div>
          ),
        )}
    </>
  );
}

function SessionMenu({ session, onClose }: { session: Session; onClose: () => void }) {
  const navigate = useNavigate();
  const action = async (fn: () => Promise<unknown>) => {
    onClose();
    await fn().catch((e) => toast('error', e instanceof ApiError ? e.message : String(e)));
  };
  return (
    <div className="absolute top-full right-0 z-30 mt-1 w-60 rounded-xl border border-line bg-surface p-1 shadow-cloud" onMouseLeave={onClose}>
      <button
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2"
        onClick={() => action(() => api.post(`/api/sessions/${session.id}/stop`))}
        disabled={!session.alive}
      >
        <Power className="size-4" /> Stop Claude process
        <span className="ml-auto text-xs text-ink-3">resumes later</span>
      </button>
      <button
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2"
        onClick={() => action(() => api.patch(`/api/sessions/${session.id}`, { archived: !session.archived }))}
      >
        <Archive className="size-4" /> {session.archived ? 'Unarchive' : 'Archive'}
      </button>
      <button
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-bad hover:bg-bad-soft"
        onClick={() =>
          action(async () => {
            if (!confirm(`Delete "${session.title}" and its history? Files in the project are not affected.`)) return;
            await api.del(`/api/sessions/${session.id}`);
            navigate(`/p/${session.projectId}`);
          })
        }
      >
        <Trash2 className="size-4" /> Delete session
      </button>
    </div>
  );
}

/** One compact pill (model · permissions) that opens the full session controls. */
function SessionControls({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const model = MODELS.find((m) => m.value === session.model)?.label ?? session.model ?? 'Default model';
  const full = session.permissionMode === 'bypassPermissions';
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={clsx(
          'inline-flex h-8 max-w-[14rem] items-center gap-1.5 truncate rounded-lg border px-2.5 text-[13px]',
          full ? 'border-break text-break-ink' : 'border-line text-ink-2 hover:border-line-strong hover:text-ink',
        )}
      >
        <span className="truncate">{model}</span>
        <span className="text-ink-3">·</span>
        <span className="truncate">{MODE_LABEL[session.permissionMode]?.label}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 z-30 mt-1 w-72 space-y-3 rounded-xl border border-line bg-surface p-3 shadow-cloud">
            <label className="block text-xs font-medium text-ink-2">
              Model
              <Select value={session.model ?? ''} onChange={(e) => patchSession(session.id, { model: e.target.value })} className="mt-1 w-full">
                {!MODELS.some((m) => m.value === session.model) && session.model && <option value={session.model}>{session.model}</option>}
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block text-xs font-medium text-ink-2">
              Reasoning effort
              <Select value={session.effort ?? ''} onChange={(e) => patchSession(session.id, { effort: e.target.value || null })} className="mt-1 w-full">
                {EFFORTS.map((x) => (
                  <option key={x} value={x}>
                    {x || 'Model default'}
                  </option>
                ))}
              </Select>
            </label>
            <div>
              <p className="text-xs font-medium text-ink-2">Permissions</p>
              <div className="mt-1 space-y-1">
                {MODES.map((m) => (
                  <button
                    key={m}
                    onClick={() => patchSession(session.id, { permissionMode: m })}
                    className={clsx(
                      'block w-full rounded-lg border px-2.5 py-1.5 text-left',
                      session.permissionMode === m ? 'border-ink bg-surface-2' : 'border-transparent hover:bg-surface-2',
                    )}
                  >
                    <span className={clsx('text-sm font-medium', m === 'bypassPermissions' && 'text-break-ink')}>{MODE_LABEL[m].label}</span>
                    <span className="block text-xs text-ink-3">{MODE_LABEL[m].hint}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Header({ session, project, onOpenSessions }: { session: Session; project: Project; onOpenSessions: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [menu, setMenu] = useState(false);
  const liveStatus = useStore((s) => s.liveStatus[session.id]);
  useEffect(() => setTitle(session.title), [session.title]);

  return (
    <div className="border-b border-line bg-ground/90 backdrop-blur">
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2 sm:px-4">
        <IconButton label="Sessions" className="lg:hidden" onClick={onOpenSessions}>
          <Menu className="size-[18px]" />
        </IconButton>
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setEditing(false);
                if (title.trim() && title !== session.title) void patchSession(session.id, { title });
              }}
            >
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => setEditing(false)}
                className="w-full rounded-md bg-surface px-1.5 font-display text-[17px] font-semibold focus:outline-none"
              />
            </form>
          ) : (
            <button onClick={() => setEditing(true)} className="block max-w-full truncate text-left font-display text-[17px] font-semibold" title="Rename">
              {session.title}
            </button>
          )}
          <p className="truncate text-xs text-ink-3">
            <span className={clsx(session.status === 'awaiting_input' && 'font-semibold text-break-ink', session.status === 'error' && 'text-bad')}>
              {liveStatus === 'compacting' ? 'Compacting conversation…' : STATUS_LABEL[session.status]}
            </span>
            {session.totalCostUsd > 0 && ` · ${money(session.totalCostUsd)}`}
            {!session.alive && session.started && session.status === 'idle' && ' · resumes on your next message'}
          </p>
        </div>
        <WorktreeChip session={session} project={project} />
        <SessionControls session={session} />
        <div className="relative">
          <IconButton label="Session options" onClick={() => setMenu(!menu)}>
            <MoreHorizontal className="size-[18px]" />
          </IconButton>
          {menu && <SessionMenu session={session} onClose={() => setMenu(false)} />}
        </div>
      </div>
      <div className="drift" data-state={session.status} aria-hidden />
    </div>
  );
}

export function ChatView({ session, project, onOpenSessions }: { session: Session; project: Project; onOpenSessions: () => void }) {
  const events = useStore((s) => s.events[session.id]);
  const drafts = useStore((s) => s.drafts[session.id]) ?? [];
  const pending = useStore((s) => s.pending[session.id]) ?? [];
  const progress = useStore((s) => s.toolProgress[session.id]) ?? {};
  const items = useMemo(() => buildTimeline(events ?? []), [events]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const busy = session.status === 'running' || session.status === 'starting';

  useEffect(() => socket.subscribe(session.id), [session.id]);
  useEffect(() => {
    pinned.current = true;
  }, [session.id]);

  // Stay pinned to the bottom while new output arrives, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header session={session} project={project} onOpenSessions={onOpenSessions} />
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto max-w-3xl space-y-3.5 px-3 py-5 sm:px-5">
          {events === undefined ? (
            <div className="flex justify-center py-10 text-ink-3">
              <Spinner className="size-5" />
            </div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center">
              <p className="font-display text-xl font-semibold">What should Claude work on?</p>
              <p className="mx-auto mt-2 max-w-md text-sm text-ink-2">
                Claude works in <span className="font-mono text-[13px]">{project.path}</span>. It can install packages, run and test apps, and publish
                them — you approve anything risky from here.
              </p>
            </div>
          ) : (
            items.map((it) => <Item key={it.key} item={it} root={project.path} sessionId={session.id} progress={progress} />)
          )}
          <Drafts drafts={drafts} />
          {busy && drafts.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-ink-3">
              <Spinner className="size-3.5" /> {session.status === 'starting' ? 'Starting Claude…' : 'Working…'}
            </div>
          )}
          {session.lastError && session.status !== 'running' && (
            <div className="flex items-start gap-2 rounded-xl border border-bad/40 bg-bad-soft px-3 py-2.5 text-sm text-bad">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span className="whitespace-pre-wrap">{session.lastError}</span>
            </div>
          )}
        </div>
      </div>
      <div className="pb-safe border-t border-line bg-ground px-3 pt-2.5 pb-3 sm:px-5">
        <div className="mx-auto max-w-3xl space-y-2.5">
          {pending.length > 0 && (
            <div className="max-h-[55vh] space-y-2.5 overflow-y-auto">
              {pending.map((r) => (
                <PermissionCard key={r.id} req={r} root={project.path} />
              ))}
            </div>
          )}
          <Composer session={session} />
          {session.permissionMode === 'bypassPermissions' && (
            <p className="text-center text-xs text-break-ink">
              <Badge tone="break">Full access</Badge> Claude runs commands without asking. Publishing and deploying still ask.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
