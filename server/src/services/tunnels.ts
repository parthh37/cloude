import { spawn, type ChildProcess } from 'node:child_process';
import type { Tunnel } from '../../../shared/protocol.js';
import { config } from '../config.js';
import { newId } from '../crypto.js';
import { now } from '../db.js';
import { hub } from '../hub.js';
import { HttpError } from '../util/paths.js';

/**
 * Cloudflare quick tunnels: an instant public https URL for a local port with
 * zero DNS setup (`*.trycloudflare.com`). Useful when the server has no wildcard
 * domain configured, or to share a preview with someone outside quickly.
 * Ephemeral by design — they die with the process and aren't persisted.
 */
interface TunnelRuntime extends Tunnel {
  child: ChildProcess | null;
}

class TunnelManager {
  private tunnels = new Map<string, TunnelRuntime>();

  list(): Tunnel[] {
    return [...this.tunnels.values()].map(({ child: _child, ...t }) => t);
  }

  private broadcast() {
    hub.broadcast({ t: 'tunnels', tunnels: this.list() });
  }

  /** Start (or reuse) a tunnel and wait until its public URL is known. */
  async open(port: number, timeoutMs = 30_000): Promise<Tunnel> {
    if (config.reservedPorts.has(port)) throw new HttpError(400, `Port ${port} belongs to Cloude and can't be tunnelled`);
    const existing = [...this.tunnels.values()].find((t) => t.port === port && t.status !== 'stopped' && t.status !== 'error');
    if (existing) return this.waitForUrl(existing, timeoutMs);

    const t: TunnelRuntime = { id: newId(), port, url: null, status: 'starting', error: null, createdAt: now(), child: null };
    this.tunnels.set(t.id, t);
    const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.child = child;
    const onData = (d: Buffer) => {
      const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !t.url) {
        t.url = m[0];
        t.status = 'running';
        this.broadcast();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      t.status = 'error';
      t.error = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'cloudflared is not installed on the server' : e.message;
      this.broadcast();
    });
    child.on('exit', () => {
      if (t.status !== 'error') t.status = 'stopped';
      t.child = null;
      this.broadcast();
    });
    this.broadcast();
    return this.waitForUrl(t, timeoutMs);
  }

  private async waitForUrl(t: TunnelRuntime, timeoutMs: number): Promise<Tunnel> {
    const deadline = now() + timeoutMs;
    while (!t.url && t.status === 'starting' && now() < deadline) await new Promise((r) => setTimeout(r, 250));
    if (t.status === 'error') throw new HttpError(500, t.error ?? 'Tunnel failed');
    const { child: _child, ...pub } = t;
    return pub;
  }

  close(id: string) {
    const t = this.tunnels.get(id);
    if (!t) return;
    t.child?.kill('SIGTERM');
    this.tunnels.delete(id);
    this.broadcast();
  }

  closeAll() {
    for (const id of this.tunnels.keys()) this.close(id);
  }
}

export const tunnels = new TunnelManager();
