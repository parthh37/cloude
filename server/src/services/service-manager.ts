import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ServiceDef, ServiceState } from '../../../shared/protocol.js';
import { newId } from '../crypto.js';
import { db, now } from '../db.js';
import { hub } from '../hub.js';
import { projects } from '../projects.js';
import { buildEnv } from '../settings.js';
import { run } from '../util/exec.js';
import { HttpError, safeJoin, slugify } from '../util/paths.js';
import { freePort, portsForPids, processTree } from './ports.js';
import { previewUrlForPort, routes } from './routes-store.js';

interface ServiceRow {
  id: string;
  project_id: string;
  name: string;
  kind: 'dev' | 'deploy';
  strategy: 'process' | 'docker' | 'static';
  command: string;
  cwd: string;
  port: number | null;
  env: string;
  auto_restart: number;
  created_at: number;
}

const toDef = (r: ServiceRow): ServiceDef => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  kind: r.kind,
  strategy: r.strategy,
  command: r.command,
  cwd: r.cwd,
  port: r.port,
  env: JSON.parse(r.env || '{}'),
  autoRestart: !!r.auto_restart,
  createdAt: r.created_at,
});

export interface LogLine {
  i: number;
  t: number;
  s: 'out' | 'err' | 'sys';
  text: string;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

class LogBuffer {
  lines: LogLine[] = [];
  private next = 0;
  private partial: Record<string, string> = {};
  constructor(private max = 3000) {}

  write(s: LogLine['s'], chunk: string) {
    const text = (this.partial[s] ?? '') + chunk.replace(ANSI_RE, '');
    const parts = text.split(/\r?\n/);
    this.partial[s] = parts.pop() ?? '';
    for (const p of parts) this.push(s, p);
  }

  push(s: LogLine['s'], text: string) {
    this.lines.push({ i: this.next++, t: now(), s, text: text.replace(/\r/g, '') });
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  since(after: number, limit: number): LogLine[] {
    const out = this.lines.filter((l) => l.i > after);
    return out.slice(-limit);
  }
}

interface Runtime {
  child: ChildProcess | null;
  status: ServiceState['status'];
  startedAt: number | null;
  exitCode: number | null;
  restarts: number;
  stopping: boolean;
  assignedPort: number | null;
  detectedPort: number | null;
  restartTimer: NodeJS.Timeout | null;
  log: LogBuffer;
}

const SHELL = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';

class ServiceManager {
  private runtimes = new Map<string, Runtime>();

  private rt(id: string): Runtime {
    let r = this.runtimes.get(id);
    if (!r) {
      r = {
        child: null,
        status: 'stopped',
        startedAt: null,
        exitCode: null,
        restarts: 0,
        stopping: false,
        assignedPort: null,
        detectedPort: null,
        restartTimer: null,
        log: new LogBuffer(),
      };
      this.runtimes.set(id, r);
    }
    return r;
  }

  // ---- definitions ---------------------------------------------------------

  defs(projectId?: string): ServiceDef[] {
    const rows = (
      projectId
        ? db.prepare('SELECT * FROM services WHERE project_id = ? ORDER BY created_at').all(projectId)
        : db.prepare('SELECT * FROM services ORDER BY created_at').all()
    ) as unknown as ServiceRow[];
    return rows.map(toDef);
  }

  def(id: string): ServiceDef {
    const r = db.prepare('SELECT * FROM services WHERE id = ?').get(id) as unknown as ServiceRow | undefined;
    if (!r) throw new HttpError(404, 'Service not found');
    return toDef(r);
  }

  byName(projectId: string, name: string): ServiceDef | null {
    const r = db.prepare('SELECT * FROM services WHERE project_id = ? AND name = ?').get(projectId, name) as unknown as
      | ServiceRow
      | undefined;
    return r ? toDef(r) : null;
  }

  upsert(input: Omit<ServiceDef, 'id' | 'createdAt'> & { id?: string }): ServiceDef {
    if (!input.name?.trim()) throw new HttpError(400, 'Service name is required');
    if (!input.command?.trim() && input.strategy !== 'docker') throw new HttpError(400, 'command is required');
    const project = projects.require(input.projectId);
    safeJoin(project.path, input.cwd || '.'); // validate
    const existing = input.id ? this.def(input.id) : this.byName(input.projectId, input.name);
    const values = [
      input.name.trim(),
      input.kind,
      input.strategy,
      input.command ?? '',
      input.cwd || '.',
      input.port ?? null,
      JSON.stringify(input.env ?? {}),
      input.autoRestart ? 1 : 0,
    ] as const;
    if (existing) {
      db.prepare(
        'UPDATE services SET name = ?, kind = ?, strategy = ?, command = ?, cwd = ?, port = ?, env = ?, auto_restart = ? WHERE id = ?',
      ).run(...values, existing.id);
      this.broadcast();
      return this.def(existing.id);
    }
    const id = newId();
    db.prepare(
      'INSERT INTO services (name, kind, strategy, command, cwd, port, env, auto_restart, id, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(...values, id, input.projectId, now());
    this.broadcast();
    return this.def(id);
  }

  async remove(id: string) {
    await this.stop(id);
    db.prepare('DELETE FROM services WHERE id = ?').run(id);
    this.runtimes.delete(id);
    this.broadcast();
  }

  // ---- state -------------------------------------------------------------

  effectivePort(id: string, def?: ServiceDef): number | null {
    const r = this.runtimes.get(id);
    return r?.detectedPort ?? def?.port ?? r?.assignedPort ?? null;
  }

  state(def: ServiceDef): ServiceState {
    const r = this.rt(def.id);
    const port = this.effectivePort(def.id, def);
    const urls: ServiceState['urls'] = {};
    if (def.strategy === 'static') {
      const dir = this.staticDir(def);
      const route = routes.list().find((x) => x.targetType === 'static' && x.staticDir === dir);
      if (route) urls.public = route.url;
    } else if (port) {
      urls.private = previewUrlForPort(port);
      const route = routes.list().find((x) => x.targetType === 'port' && x.port === port);
      if (route) urls.public = route.url;
    }
    return {
      ...def,
      port,
      status: r.status,
      pid: r.child?.pid ?? null,
      startedAt: r.startedAt,
      exitCode: r.exitCode,
      restarts: r.restarts,
      urls,
    };
  }

  list(projectId?: string): ServiceState[] {
    return this.defs(projectId).map((d) => this.state(d));
  }

  logs(id: string, after = -1, limit = 500): LogLine[] {
    return this.rt(id).log.since(after, limit);
  }

  broadcast() {
    hub.broadcast({ t: 'services', services: this.list() });
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(id: string): Promise<ServiceState> {
    const def = this.def(id);
    const r = this.rt(id);
    if (r.child && (r.status === 'running' || r.status === 'starting' || r.status === 'building')) return this.state(def);
    if (r.restartTimer) clearTimeout(r.restartTimer);
    r.restartTimer = null;
    r.stopping = false;
    r.exitCode = null;
    r.detectedPort = null;

    const project = projects.require(def.projectId);
    const cwd = safeJoin(project.path, def.cwd || '.');

    if (def.strategy === 'static') {
      r.status = 'running';
      r.startedAt = now();
      r.log.push('sys', `Serving static files from ${def.command}`);
      this.broadcast();
      return this.state(def);
    }

    r.assignedPort = def.port ?? (await freePort());
    const env = buildEnv(def.projectId, { PORT: String(r.assignedPort), ...def.env });

    if (def.strategy === 'docker') {
      const image = `cloude-${project.slug}-${slugify(def.name)}`;
      r.status = 'building';
      r.startedAt = now();
      r.log.push('sys', `$ docker build -t ${image} .`);
      this.broadcast();
      const ok = await this.pipe(r, spawn('docker', ['build', '-t', image, '.'], { cwd, env }));
      if (!ok) {
        r.status = 'crashed';
        r.log.push('sys', 'docker build failed');
        this.broadcast();
        return this.state(def);
      }
      const p = r.assignedPort;
      const args = ['run', '--rm', '--name', this.containerName(def), '-p', `127.0.0.1:${p}:${p}`, '-e', `PORT=${p}`];
      for (const [k, v] of Object.entries(def.env)) args.push('-e', `${k}=${v}`);
      if (def.command.trim()) args.push(...def.command.trim().split(/\s+/));
      args.push(image);
      r.log.push('sys', `$ docker ${args.join(' ')}`);
      this.launch(def, r, spawn('docker', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }));
    } else {
      r.log.push('sys', `$ ${def.command}   (cwd: ${def.cwd || '.'}, PORT=${r.assignedPort})`);
      // detached => own process group, so stop() can kill the whole tree.
      this.launch(def, r, spawn(SHELL, ['-lc', def.command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    }
    return this.state(def);
  }

  private containerName(def: ServiceDef) {
    return `cloude-svc-${def.id.slice(0, 8)}`;
  }

  /** Stream a short-lived child's output into the log; resolves true on exit code 0. */
  private pipe(r: Runtime, child: ChildProcess): Promise<boolean> {
    child.stdout?.on('data', (d) => r.log.write('out', d.toString()));
    child.stderr?.on('data', (d) => r.log.write('err', d.toString()));
    return new Promise((resolve) => {
      child.on('error', (e) => {
        r.log.push('sys', String(e));
        resolve(false);
      });
      child.on('close', (code) => resolve(code === 0));
    });
  }

  private launch(def: ServiceDef, r: Runtime, child: ChildProcess) {
    r.child = child;
    r.status = 'starting';
    r.startedAt = now();
    child.stdout?.on('data', (d) => r.log.write('out', d.toString()));
    child.stderr?.on('data', (d) => r.log.write('err', d.toString()));
    child.on('error', (e) => r.log.push('sys', `spawn error: ${e.message}`));
    child.on('exit', (code, signal) => {
      r.child = null;
      r.exitCode = code;
      r.log.push('sys', `process exited (${signal ?? `code ${code}`})`);
      if (r.stopping) {
        r.status = 'stopped';
      } else {
        r.status = 'crashed';
        if (def.autoRestart) this.scheduleRestart(def, r);
      }
      this.broadcast();
    });
    this.broadcast();
    void this.detectPort(def, r, child);
  }

  /** Poll for the port the process tree actually bound — many tools ignore $PORT. */
  private async detectPort(def: ServiceDef, r: Runtime, child: ChildProcess) {
    for (const delay of [800, 1500, 2500, 4000, 6000, 10000]) {
      await new Promise((res) => setTimeout(res, delay));
      if (r.child !== child || !child.pid) return;
      const ports = await portsForPids(await processTree(child.pid));
      if (ports.length) {
        const preferred = ports.includes(r.assignedPort ?? -1) ? r.assignedPort! : Math.min(...ports);
        r.detectedPort = preferred;
        if (r.status === 'starting') r.status = 'running';
        this.broadcast();
        return;
      }
    }
    // No listening socket found: it's a worker / CLI-style process; still "running".
    if (r.child === child && r.status === 'starting') {
      r.status = 'running';
      this.broadcast();
    }
  }

  private scheduleRestart(def: ServiceDef, r: Runtime) {
    const uptime = r.startedAt ? now() - r.startedAt : 0;
    if (uptime > 60_000) r.restarts = 0; // healthy for a minute => reset backoff
    const delay = Math.min(30_000, 1000 * 2 ** r.restarts);
    r.restarts++;
    r.log.push('sys', `restarting in ${Math.round(delay / 1000)}s (attempt ${r.restarts})`);
    r.restartTimer = setTimeout(() => void this.start(def.id).catch((e) => r.log.push('sys', String(e))), delay);
  }

  async stop(id: string): Promise<void> {
    const r = this.runtimes.get(id);
    if (!r) return;
    if (r.restartTimer) clearTimeout(r.restartTimer);
    r.restartTimer = null;
    r.stopping = true;
    const def = this.def(id);
    if (def.strategy === 'static') {
      r.status = 'stopped';
      this.broadcast();
      return;
    }
    if (def.strategy === 'docker') await run('docker', ['stop', '-t', '10', this.containerName(def)], { timeoutMs: 20_000 });
    const child = r.child;
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            /* already gone */
          }
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    r.status = 'stopped';
    this.broadcast();
  }

  async restart(id: string) {
    await this.stop(id);
    return this.start(id);
  }

  /** Bring deployments back after a server restart. */
  async bootstrap() {
    for (const def of this.defs()) {
      if (def.kind === 'deploy' && def.autoRestart) {
        await this.start(def.id).catch((e) => console.error(`[services] failed to start ${def.name}:`, e));
      }
    }
  }

  async stopAll() {
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id).catch(() => {})));
  }

  /** Resolve a static deployment's directory for the proxy. */
  staticDir(def: ServiceDef): string {
    return path.resolve(projects.require(def.projectId).path, def.cwd || '.', def.command);
  }
}

export const services = new ServiceManager();
