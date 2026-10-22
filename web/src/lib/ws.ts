import type { ClientMessage, ServerMessage, Session } from '../../../shared/protocol';
import { api } from './api';
import { handleServerMessage, maxSeq, upsertSessions, useStore } from './store';

/**
 * One multiplexed socket for the whole app. Reconnects with backoff and, on
 * reconnect, re-subscribes each open session from the last seq it saw — the
 * server replays anything missed while a phone was asleep.
 */
class Socket {
  private ws: WebSocket | null = null;
  private subs = new Map<string, number>(); // sessionId -> refcount
  private watching: Record<'metrics' | 'processes', number> = { metrics: 0, processes: 0 };
  private retry = 0;
  private timer: number | null = null;
  private started = false;
  private openedBefore = false;

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && (!this.ws || this.ws.readyState > 1)) this.reconnectNow();
    });
    window.addEventListener('online', () => this.reconnectNow());
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  private reconnectNow() {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.retry = 0;
    this.connect();
  }

  private connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    useStore.setState({ connection: 'connecting' });
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      useStore.setState({ connection: 'open' });
      // Session broadcasts missed while offline (a turn ending, its live activity) aren't replayed; catch up.
      if (this.openedBefore) void api.get<{ sessions: Session[] }>('/api/sessions').then((r) => upsertSessions(r.sessions), () => {});
      this.openedBefore = true;
      for (const id of this.subs.keys()) this.send({ t: 'sub', sessionId: id, after: maxSeq(id) });
      for (const topic of ['metrics', 'processes'] as const) if (this.watching[topic] > 0) this.send({ t: 'watch', topic, on: true });
    };
    ws.onmessage = (e) => {
      try {
        handleServerMessage(JSON.parse(e.data) as ServerMessage);
      } catch (err) {
        console.error('bad ws message', err);
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      // 4401: this login was revoked or expired on the server.
      if (e.code === 4401) {
        this.stop();
        window.dispatchEvent(new Event('cloude:unauthorized'));
        return;
      }
      useStore.setState({ connection: 'closed' });
      if (!this.started) return;
      const delay = Math.min(15000, 500 * 2 ** this.retry++);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  /** Stream live server metrics ('processes' adds the per-process breakdown) while a view needs them. */
  watch(topic: 'metrics' | 'processes'): () => void {
    if (this.watching[topic]++ === 0) this.send({ t: 'watch', topic, on: true });
    return () => {
      if (--this.watching[topic] === 0) this.send({ t: 'watch', topic, on: false });
    };
  }

  subscribe(sessionId: string): () => void {
    const n = this.subs.get(sessionId) ?? 0;
    this.subs.set(sessionId, n + 1);
    if (n === 0) this.send({ t: 'sub', sessionId, after: maxSeq(sessionId) });
    return () => {
      const c = (this.subs.get(sessionId) ?? 1) - 1;
      if (c <= 0) {
        this.subs.delete(sessionId);
        this.send({ t: 'unsub', sessionId });
      } else this.subs.set(sessionId, c);
    };
  }
}

export const socket = new Socket();
