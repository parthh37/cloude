import type { WebSocket } from 'ws';
import type { ServerMessage } from '../../shared/protocol.js';

export interface HubClient {
  id: number;
  ws: WebSocket;
  subs: Set<string>;
}

/**
 * Fan-out for real-time updates. Global messages (session list, services, …) go
 * to every connected browser; session timelines only go to subscribers so a
 * phone watching one chat isn't flooded by five other busy sessions.
 */
class Hub {
  private clients = new Set<HubClient>();
  private nextId = 1;

  add(ws: WebSocket): HubClient {
    const client: HubClient = { id: this.nextId++, ws, subs: new Set() };
    this.clients.add(client);
    ws.on('close', () => this.clients.delete(client));
    return client;
  }

  send(client: HubClient, msg: ServerMessage) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage) {
    const payload = JSON.stringify(msg);
    for (const c of this.clients) if (c.ws.readyState === 1) c.ws.send(payload);
  }

  toSession(sessionId: string, msg: ServerMessage) {
    let payload: string | undefined;
    for (const c of this.clients) {
      if (!c.subs.has(sessionId) || c.ws.readyState !== 1) continue;
      payload ??= JSON.stringify(msg);
      c.ws.send(payload);
    }
  }

  get size() {
    return this.clients.size;
  }
}

export const hub = new Hub();
