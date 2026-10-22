import type { WebSocket } from 'ws';
import * as pty from '@lydell/node-pty';
import type { TerminalInfo } from '../../../shared/protocol.js';
import { config } from '../config.js';
import { newId } from '../crypto.js';
import { now } from '../db.js';
import { projects } from '../projects.js';
import { buildEnv } from '../settings.js';
import { HttpError, safeJoin } from '../util/paths.js';

const SCROLLBACK_BYTES = 256 * 1024;

interface Term {
  info: TerminalInfo;
  proc: pty.IPty;
  buffer: string;
  sockets: Set<WebSocket>;
}

/**
 * Persistent PTYs. A terminal outlives the browser tab: reconnecting replays
 * scrollback, so a `claude` CLI, build or REPL started from a phone keeps
 * running after the screen locks.
 */
class TerminalManager {
  private terms = new Map<string, Term>();

  list(projectId?: string): TerminalInfo[] {
    return [...this.terms.values()].map((t) => t.info).filter((t) => !projectId || t.projectId === projectId);
  }

  create(projectId: string, opts: { cwd?: string; command?: string; title?: string; cols?: number; rows?: number }): TerminalInfo {
    const project = projects.require(projectId);
    const cwd = safeJoin(project.path, opts.cwd ?? '.');
    const env = buildEnv(projectId, { TERM: 'xterm-256color', COLORTERM: 'truecolor' });
    const args = opts.command ? ['-lc', opts.command] : ['-l'];
    const proc = pty.spawn(config.shell, args, { name: 'xterm-256color', cwd, env, cols: opts.cols ?? 120, rows: opts.rows ?? 32 });
    const info: TerminalInfo = {
      id: newId(),
      projectId,
      title: opts.title ?? (opts.command ? opts.command.split(' ')[0]! : `Terminal ${this.list(projectId).length + 1}`),
      cwd,
      createdAt: now(),
      alive: true,
    };
    const term: Term = { info, proc, buffer: '', sockets: new Set() };
    proc.onData((data) => {
      term.buffer += data;
      if (term.buffer.length > SCROLLBACK_BYTES) term.buffer = term.buffer.slice(-SCROLLBACK_BYTES);
      for (const ws of term.sockets) if (ws.readyState === 1) ws.send(data);
    });
    proc.onExit(({ exitCode }) => {
      info.alive = false;
      const msg = `\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`;
      term.buffer += msg;
      for (const ws of term.sockets) if (ws.readyState === 1) ws.send(msg);
    });
    this.terms.set(info.id, term);
    return info;
  }

  attach(id: string, ws: WebSocket) {
    const term = this.terms.get(id);
    if (!term) {
      ws.close(4404, 'terminal not found');
      return;
    }
    term.sockets.add(ws);
    if (term.buffer) ws.send(term.buffer);
    ws.on('message', (raw) => {
      let msg: { t: 'in'; d: string } | { t: 'resize'; cols: number; rows: number };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!term.info.alive) return;
      if (msg.t === 'in' && typeof msg.d === 'string') term.proc.write(msg.d);
      else if (msg.t === 'resize' && msg.cols > 0 && msg.rows > 0) term.proc.resize(Math.min(msg.cols, 500), Math.min(msg.rows, 200));
    });
    ws.on('close', () => term.sockets.delete(ws));
  }

  kill(id: string) {
    const term = this.terms.get(id);
    if (!term) throw new HttpError(404, 'Terminal not found');
    if (term.info.alive) term.proc.kill();
    for (const ws of term.sockets) ws.close();
    this.terms.delete(id);
  }

  rename(id: string, title: string) {
    const term = this.terms.get(id);
    if (!term) throw new HttpError(404, 'Terminal not found');
    term.info.title = title.slice(0, 60);
    return term.info;
  }

  killAll() {
    for (const id of [...this.terms.keys()]) this.kill(id);
  }

  killProject(projectId: string) {
    for (const t of this.list(projectId)) this.kill(t.id);
  }
}

export const terminals = new TerminalManager();
