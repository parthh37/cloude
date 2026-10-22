import { create } from 'zustand';
import type {
  AuthUser,
  HostInfo,
  MetricsSample,
  PermissionRequest,
  ProcessGroup,
  Project,
  Route,
  ServerMessage,
  ServiceState,
  Session,
  SessionEvent,
  SetupStatus,
  SystemStatus,
  Tunnel,
  UsageLive,
} from '../../../shared/protocol';

/** In-flight streaming text for a session, keyed by `${messageId}:${blockIndex}`. */
export interface DraftBlock {
  key: string;
  messageId: string;
  type: 'text' | 'thinking' | 'tool_use';
  text: string;
  toolName?: string;
  parentToolUseId: string | null;
}

export interface Toast {
  id: number;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body?: string;
  sessionId?: string;
}

export interface MetricsState {
  host: HostInfo | null;
  intervalMs: number;
  history: MetricsSample[];
  processes: ProcessGroup[];
}

interface State {
  user: AuthUser | null;
  authChecked: boolean;
  setup: SetupStatus | null;
  status: SystemStatus | null;
  projects: Project[];
  sessions: Record<string, Session>;
  events: Record<string, SessionEvent[]>;
  pending: Record<string, PermissionRequest[]>;
  drafts: Record<string, DraftBlock[]>;
  toolProgress: Record<string, Record<string, number>>; // sessionId -> toolUseId -> elapsed s
  suggestions: Record<string, string | null>;
  liveStatus: Record<string, string | null>; // e.g. "compacting"
  services: ServiceState[];
  routes: Route[];
  tunnels: Tunnel[];
  toasts: Toast[];
  connection: 'connecting' | 'open' | 'closed';
  usage: UsageLive | null;
  metrics: MetricsState;
  paletteOpen: boolean;
}

const initialState = (): State => ({
  user: null,
  authChecked: false,
  setup: null,
  status: null,
  projects: [],
  sessions: {},
  events: {},
  pending: {},
  drafts: {},
  toolProgress: {},
  suggestions: {},
  liveStatus: {},
  services: [],
  routes: [],
  tunnels: [],
  toasts: [],
  connection: 'connecting',
  usage: null,
  metrics: { host: null, intervalMs: 5000, history: [], processes: [] },
  paletteOpen: false,
});

export const useStore = create<State>(initialState);

/** Forget everything from the signed-out login: nothing lingers in memory or the tab title. */
export function resetStore() {
  useStore.setState({ ...initialState(), authChecked: true });
}

const set = useStore.setState;
const get = useStore.getState;

let toastId = 1;
export function toast(level: Toast['level'], title: string, body?: string, sessionId?: string) {
  const t: Toast = { id: toastId++, level, title, body, sessionId };
  set((s) => ({ toasts: [...s.toasts.slice(-4), t] }));
  setTimeout(() => dismissToast(t.id), level === 'error' ? 9000 : 5000);
}
export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function upsertSessions(list: Session[]) {
  set((s) => {
    const sessions = { ...s.sessions };
    for (const x of list) sessions[x.id] = x;
    return { sessions };
  });
}

export function maxSeq(sessionId: string): number {
  const ev = get().events[sessionId];
  return ev?.length ? ev[ev.length - 1]!.seq : 0;
}

function appendEvent(e: SessionEvent) {
  set((s) => {
    const list = s.events[e.sessionId] ?? [];
    const last = list.length ? list[list.length - 1]!.seq : 0;
    if (e.seq <= last) return {}; // replay de-dupe after resubscribe
    const next: Partial<State> = { events: { ...s.events, [e.sessionId]: [...list, e] } };

    // A completed assistant message supersedes the streaming draft for its blocks.
    if (e.kind === 'sdk' && e.data?.type === 'assistant') {
      const msgId = e.data.message?.id;
      const drafts = s.drafts[e.sessionId] ?? [];
      const blocks: any[] = e.data.message?.content ?? [];
      const remaining = [...drafts];
      for (const b of blocks) {
        const i = remaining.findIndex((d) => d.messageId === msgId && d.type === b.type);
        if (i >= 0) remaining.splice(i, 1);
      }
      next.drafts = { ...s.drafts, [e.sessionId]: remaining };
    }
    if (e.kind === 'sdk' && e.data?.type === 'result') {
      next.drafts = { ...s.drafts, [e.sessionId]: [] };
      next.toolProgress = { ...s.toolProgress, [e.sessionId]: {} };
    }
    return next;
  });
}

function applyLive(sessionId: string, data: any) {
  if (data?.type === 'stream_event') {
    const ev = data.event;
    const parent: string | null = data.parent_tool_use_id ?? null;
    if (ev.type === 'message_start') {
      currentMessage[sessionId + (parent ?? '')] = ev.message?.id ?? data.uuid;
      return;
    }
    set((s) => {
      const drafts = [...(s.drafts[sessionId] ?? [])];
      const msgId = currentMessage[sessionId + (parent ?? '')] ?? 'unknown';
      const key = `${msgId}:${ev.index}`;
      if (ev.type === 'content_block_start') {
        const cb = ev.content_block;
        if (cb?.type === 'text' || cb?.type === 'thinking' || cb?.type === 'tool_use') {
          drafts.push({ key, messageId: msgId, type: cb.type, text: cb.text ?? '', toolName: cb.name, parentToolUseId: parent });
        }
      } else if (ev.type === 'content_block_delta') {
        const i = drafts.findIndex((d) => d.key === key);
        if (i < 0) return {};
        const d = ev.delta;
        const piece = d?.text ?? d?.thinking ?? d?.partial_json ?? '';
        if (!piece) return {};
        drafts[i] = { ...drafts[i]!, text: drafts[i]!.text + piece };
      } else return {};
      return { drafts: { ...s.drafts, [sessionId]: drafts } };
    });
  } else if (data?.type === 'tool_progress') {
    set((s) => ({
      toolProgress: { ...s.toolProgress, [sessionId]: { ...(s.toolProgress[sessionId] ?? {}), [data.tool_use_id]: data.elapsed_time_seconds } },
    }));
  } else if (data?.type === 'prompt_suggestion') {
    set((s) => ({ suggestions: { ...s.suggestions, [sessionId]: data.suggestion } }));
  } else if (data?.type === 'system' && data.subtype === 'status') {
    set((s) => ({ liveStatus: { ...s.liveStatus, [sessionId]: data.status ?? null } }));
  }
}
const currentMessage: Record<string, string> = {};

/** Browser notification when the tab is in the background. */
function systemNotify(title: string, body?: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    new Notification(title, { body, icon: '/icon.svg', tag: title });
  } catch {
    /* some mobile browsers only allow notifications from a service worker */
  }
}

export function handleServerMessage(msg: ServerMessage) {
  switch (msg.t) {
    case 'event':
      appendEvent(msg.event);
      if (msg.event.kind === 'user') set((s) => ({ suggestions: { ...s.suggestions, [msg.event.sessionId]: null } }));
      break;
    case 'live':
      applyLive(msg.sessionId, msg.data);
      break;
    case 'session': {
      const prev = get().sessions[msg.session.id];
      upsertSessions([msg.session]);
      if (prev && prev.status !== 'idle' && msg.session.status === 'idle' && !msg.session.lastError) {
        systemNotify('Claude finished', msg.session.title);
      }
      break;
    }
    case 'session_deleted':
      set((s) => {
        const sessions = { ...s.sessions };
        delete sessions[msg.sessionId];
        return { sessions };
      });
      break;
    case 'pending':
      // Also sent right after a subscription's backlog, so it doubles as "history loaded".
      set((s) => ({
        pending: { ...s.pending, [msg.sessionId]: msg.requests },
        events: s.events[msg.sessionId] ? s.events : { ...s.events, [msg.sessionId]: [] },
      }));
      break;
    case 'services':
      set({ services: msg.services });
      break;
    case 'routes':
      set({ routes: msg.routes });
      break;
    case 'tunnels':
      set({ tunnels: msg.tunnels });
      break;
    case 'notify':
      toast(msg.level, msg.title, msg.body, msg.sessionId);
      systemNotify(msg.title, msg.body);
      break;
    case 'usage':
      set({ usage: msg.usage });
      break;
    case 'metrics':
      set((s) => {
        const history = [...s.metrics.history, msg.sample];
        if (history.length > 720) history.splice(0, history.length - 720);
        return { metrics: { ...s.metrics, history, processes: msg.processes } };
      });
      break;
    case 'error':
      toast('error', msg.message);
      break;
  }
}
