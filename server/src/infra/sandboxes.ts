import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import type {
  Project,
  Sandbox,
  SandboxCreateInput,
  SandboxExecResult,
  SandboxIsolation,
  SandboxIsolationInfo,
  SandboxLimits,
  SandboxMount,
  SandboxRuntimeInfo,
  SandboxSnapshot,
  SandboxStatus,
  TerminalInfo,
} from '../../../shared/protocol.js';
import { db, now } from '../db.js';
import { projects } from '../projects.js';
import { previewUrlForPort } from '../services/routes-store.js';
import { terminals } from '../terminal/terminals.js';
import { HttpError, safeJoin } from '../util/paths.js';
import { LABEL, containerSize, containerState, docker, dockerOk, engineInfo, ensureNetwork, hasKvm, hostPath, labelArgs, publishedPorts } from './docker.js';
import { INSTANCE, kv } from './store.js';

/**
 * Sandboxes: disposable machines on the Docker host that Claude controls
 * completely (root inside, any package, any service), for tests that need a
 * real OS — databases, system packages, systemd, Docker-in-Docker, other distros,
 * destructive experiments — without touching the server Cloude runs on.
 *
 * Conflict-free by construction:
 *   - names:    containers are `cloude-<instance>-<id>`; sandbox names are unique per project
 *   - ports:    published as 127.0.0.1::<port>, so Docker picks a free host port every time
 *   - network:  one private bridge per project — sandboxes reach each other by name, never other projects
 *   - files:    the default mount is a private copy of the project, so the checkout sessions edit is untouched
 *   - ownership: every object carries cloude.* labels incl. this install's instance tag; the cleaner
 *                never touches anything without them
 */

interface Spec {
  image: string; // what the container runs now (a snapshot image after restore/expose)
  baseImage: string; // what the user asked for
  isolation: SandboxIsolation;
  runtime: string;
  container: string;
  network: 'project' | 'isolated';
  ports: number[];
  hostPorts: { container: number; host: number }[];
  mount: SandboxMount;
  limits: SandboxLimits;
  env: Record<string, string>;
  caps: string[];
  shell: string;
}

interface Row {
  id: string;
  name: string;
  project_id: string;
  session_id: string | null;
  spec: string;
  status: SandboxStatus;
  error: string | null;
  pinned: number;
  ttl_minutes: number | null;
  size_bytes: number | null;
  last_active_at: number;
  created_at: number;
}

const ISOLATION_RUNTIMES: Record<SandboxIsolation, string[]> = {
  container: ['runc', 'io.containerd.runc.v2', 'crun'],
  gvisor: ['runsc', 'runsc-kvm'],
  system: ['sysbox-runc'],
  microvm: ['kata', 'kata-runtime', 'kata-qemu', 'kata-fc', 'kata-clh', 'io.containerd.kata.v2'],
};

const ISOLATION_NOTES: Record<SandboxIsolation, string> = {
  container: 'Standard container (runc). Root inside, shares the host kernel. Fastest.',
  gvisor: 'gVisor (runsc): a user-space kernel intercepts every syscall. Install gVisor and register the runsc runtime.',
  system: 'Sysbox: a full OS with systemd and Docker-in-Docker, without --privileged. Install sysbox-ce.',
  microvm: 'Kata Containers: a lightweight VM with its own kernel. Needs /dev/kvm and the kata runtime.',
};

export const IMAGE_PRESETS = [
  { image: 'ubuntu:24.04', label: 'Ubuntu 24.04 — general purpose' },
  { image: 'debian:bookworm-slim', label: 'Debian 12 (slim)' },
  { image: 'node:24-bookworm', label: 'Node.js 24' },
  { image: 'python:3.13-bookworm', label: 'Python 3.13' },
  { image: 'golang:1.26-bookworm', label: 'Go 1.26' },
  { image: 'rust:1-bookworm', label: 'Rust (stable)' },
  { image: 'mcr.microsoft.com/dotnet/sdk:9.0', label: '.NET 9 SDK' },
  { image: 'alpine:3', label: 'Alpine (tiny)' },
  { image: 'nestybox/ubuntu-jammy-systemd-docker', label: 'Ubuntu + systemd + Docker (system isolation)' },
];

/** Capabilities a sandbox may add (for strace/gdb, iptables tests…). Never SYS_ADMIN, never --privileged. */
const ALLOWED_CAPS = new Set(['NET_ADMIN', 'NET_RAW', 'SYS_PTRACE', 'SYS_NICE', 'IPC_LOCK']);

/** Directories never copied into a sandbox (rebuilt inside) — keeps creation fast and the copy small. */
const COPY_EXCLUDES = ['node_modules', '.venv', 'venv', '__pycache__', 'target', '.next', '.nuxt', '.turbo', '.cache', 'dist', 'build', 'bin/Debug', 'obj', '.cloude', '.gradle'];

const DEFAULT_LIMITS: SandboxLimits = { cpus: 2, memoryMb: 2048, pids: 2048 };
export const QUOTA_DEFAULT = { perProject: 8, total: 24, maxCpus: 8, maxMemoryMb: 16384 };
const quota = () => kv.get('sandbox.quota', QUOTA_DEFAULT);

const OUTPUT_CAP = 120_000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

function networkName(projectId: string) {
  return `cloude-${INSTANCE}-net-${projectId.replace(/-/g, '').slice(0, 12)}`;
}

/** Run a command, keeping only the first+last part of huge outputs so a runaway build can't exhaust memory. */
function runCapped(cmd: string, args: string[], opts: { timeoutMs: number; input?: string }): Promise<SandboxExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const bufs = { stdout: '', stderr: '' };
    let truncated = false;
    const take = (key: 'stdout' | 'stderr') => (d: Buffer) => {
      bufs[key] += d.toString();
      if (bufs[key].length > OUTPUT_CAP * 2) {
        truncated = true;
        bufs[key] = `${bufs[key].slice(0, OUTPUT_CAP / 2)}\n… [output truncated by Cloude] …\n${bufs[key].slice(-OUTPUT_CAP)}`;
      }
    };
    child.stdout.on('data', take('stdout'));
    child.stderr.on('data', take('stderr'));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: bufs.stdout, stderr: bufs.stderr + e.message, durationMs: Date.now() - started, truncated });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stderr = timedOut ? `${bufs.stderr}\n[timed out after ${Math.round(opts.timeoutMs / 1000)}s — the command may still be running inside the sandbox]` : bufs.stderr;
      resolve({ code: code ?? -1, stdout: bufs.stdout, stderr, durationMs: Date.now() - started, truncated });
    });
    child.stdin.end(opts.input ?? '');
  });
}

class SandboxManager {
  /** Per-sandbox operation lock: lifecycle changes on one sandbox never interleave. */
  private locks = new Map<string, Promise<unknown>>();

  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }

  // ---- reading -------------------------------------------------------------------------

  private rows(projectId?: string): Row[] {
    return (
      projectId
        ? db.prepare('SELECT * FROM infra_sandboxes WHERE project_id = ? ORDER BY created_at').all(projectId)
        : db.prepare('SELECT * FROM infra_sandboxes ORDER BY created_at').all()
    ) as unknown as Row[];
  }

  private row(id: string): Row {
    const r = db.prepare('SELECT * FROM infra_sandboxes WHERE id = ?').get(id) as unknown as Row | undefined;
    if (!r) throw new HttpError(404, 'Sandbox not found');
    return r;
  }

  private snapshotsOf(sandboxId: string): SandboxSnapshot[] {
    const rows = db.prepare('SELECT * FROM infra_snapshots WHERE sandbox_id = ? ORDER BY created_at').all(sandboxId) as {
      id: string;
      sandbox_id: string;
      label: string;
      image: string;
      size_bytes: number | null;
      created_at: number;
    }[];
    return rows.map((s) => ({ id: s.id, sandboxId: s.sandbox_id, label: s.label, image: s.image, sizeBytes: s.size_bytes, createdAt: s.created_at }));
  }

  private toJSON(r: Row): Sandbox {
    const spec = JSON.parse(r.spec) as Spec;
    return {
      id: r.id,
      name: r.name,
      projectId: r.project_id,
      sessionId: r.session_id,
      image: spec.baseImage,
      isolation: spec.isolation,
      runtime: spec.runtime,
      status: r.status,
      error: r.error,
      container: spec.container,
      network: spec.network,
      ports: spec.hostPorts.map((p) => ({ ...p, previewUrl: previewUrlForPort(p.host) })),
      limits: spec.limits,
      mount: spec.mount,
      shell: spec.shell,
      pinned: !!r.pinned,
      ttlMinutes: r.ttl_minutes,
      lastActiveAt: r.last_active_at,
      createdAt: r.created_at,
      sizeBytes: r.size_bytes,
      snapshots: this.snapshotsOf(r.id),
    };
  }

  list(projectId?: string): Sandbox[] {
    return this.rows(projectId).map((r) => this.toJSON(r));
  }

  get(id: string): Sandbox {
    return this.toJSON(this.row(id));
  }

  /** Find a sandbox of a project by name (what Claude uses) or id (what the UI uses). */
  resolve(projectId: string, nameOrId: string): Sandbox {
    const r = db.prepare('SELECT * FROM infra_sandboxes WHERE project_id = ? AND (name = ? OR id = ?)').get(projectId, nameOrId, nameOrId) as unknown as
      | Row
      | undefined;
    if (!r) {
      const names = this.rows(projectId).map((x) => x.name);
      throw new HttpError(404, `No sandbox "${nameOrId}" in this project${names.length ? ` (existing: ${names.join(', ')})` : ''}`);
    }
    return this.toJSON(r);
  }

  /** The image the sandbox's container currently runs from (a snapshot after restore). */
  currentImage(id: string): string {
    return this.spec(id).image;
  }

  private spec(id: string): Spec {
    return JSON.parse(this.row(id).spec) as Spec;
  }

  private save(id: string, patch: Partial<Omit<Row, 'spec'>> & { spec?: Spec }) {
    const fields: Record<string, unknown> = { ...patch };
    if (patch.spec) fields.spec = JSON.stringify(patch.spec);
    const keys = Object.keys(fields);
    if (!keys.length) return;
    db.prepare(`UPDATE infra_sandboxes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(keys.map((k) => fields[k]) as never[]), id);
    this.changed();
  }

  touch(id: string) {
    db.prepare('UPDATE infra_sandboxes SET last_active_at = ? WHERE id = ?').run(now(), id);
  }

  /** Bumped on every change; the UI polls it cheaply. */
  version = 0;
  private changed() {
    this.version++;
  }

  // ---- runtime capabilities ------------------------------------------------------------

  async runtimeInfo(force = false): Promise<SandboxRuntimeInfo> {
    const engine = await engineInfo(force);
    const kvm = hasKvm();
    const isolations: SandboxIsolationInfo[] = (Object.keys(ISOLATION_RUNTIMES) as SandboxIsolation[]).map((id) => {
      const runtime = ISOLATION_RUNTIMES[id].find((r) => engine.runtimes.includes(r)) ?? null;
      const available = engine.available && !!runtime && (id !== 'microvm' || kvm);
      return { id, available, runtime, note: ISOLATION_NOTES[id] };
    });
    const q = quota();
    return {
      available: engine.available,
      reason: engine.reason,
      engine: engine.available ? `Docker ${engine.version ?? '?'}${engine.os ? ` on ${engine.os}` : ''}` : null,
      isolations,
      kvm,
      instance: INSTANCE,
      images: IMAGE_PRESETS,
      quota: { perProject: q.perProject, total: q.total, used: this.rows().length },
    };
  }

  // ---- lifecycle -----------------------------------------------------------------------

  async create(input: SandboxCreateInput): Promise<{ sandbox: Sandbox; init?: SandboxExecResult }> {
    const project = projects.require(input.projectId);
    const name = (input.name ?? '').trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new HttpError(400, 'Sandbox names are 1-31 chars of a-z, 0-9 and "-" (e.g. "pg-test")');

    const info = await this.runtimeInfo();
    if (!info.available) throw new HttpError(503, `Sandboxes need Docker: ${info.reason}`);
    const isolation = input.isolation ?? 'container';
    const iso = info.isolations.find((i) => i.id === isolation)!;
    if (!iso.available) {
      const ok = info.isolations.filter((i) => i.available).map((i) => i.id);
      throw new HttpError(400, `Isolation "${isolation}" is not available on this host. ${iso.note} Available: ${ok.join(', ') || 'none'}.`);
    }

    const q = quota();
    if (this.rows().length >= q.total) throw new HttpError(429, `Sandbox quota reached (${q.total} on this server). Destroy one first.`);
    if (this.rows(project.id).length >= q.perProject) throw new HttpError(429, `Sandbox quota reached (${q.perProject} per project). Destroy one first.`);

    const caps = (input as { caps?: string[] }).caps?.map((c) => c.toUpperCase()) ?? [];
    const badCap = caps.find((c) => !ALLOWED_CAPS.has(c));
    if (badCap) throw new HttpError(400, `Capability ${badCap} is not allowed (allowed: ${[...ALLOWED_CAPS].join(', ')})`);

    const ports = [...new Set((input.ports ?? []).map(Number))];
    if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw new HttpError(400, 'Ports must be 1-65535');

    const id = crypto.randomBytes(4).toString('hex');
    const image = (input.image ?? 'ubuntu:24.04').trim();
    const spec: Spec = {
      image,
      baseImage: image,
      isolation,
      runtime: iso.runtime!,
      container: `cloude-${INSTANCE}-${id}`,
      network: input.network ?? 'project',
      ports,
      hostPorts: [],
      mount: input.mount ?? 'copy',
      limits: {
        cpus: Math.min(Math.max(input.cpus ?? DEFAULT_LIMITS.cpus, 0.25), q.maxCpus),
        memoryMb: Math.min(Math.max(input.memoryMb ?? DEFAULT_LIMITS.memoryMb, 128), q.maxMemoryMb),
        pids: DEFAULT_LIMITS.pids,
      },
      env: input.env ?? {},
      caps,
      shell: 'sh',
    };

    // Reserve the name first: a concurrent create of the same name fails here, before any Docker work.
    const t = now();
    try {
      db.prepare(
        `INSERT INTO infra_sandboxes (id, name, project_id, session_id, spec, status, pinned, ttl_minutes, last_active_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?)`,
      ).run(id, name, project.id, input.sessionId ?? null, JSON.stringify(spec), input.pinned ? 1 : 0, input.ttlMinutes ?? null, t, t);
    } catch {
      throw new HttpError(409, `A sandbox named "${name}" already exists in this project`);
    }
    this.changed();

    return this.locked(id, async () => {
      try {
        await this.ensureImage(image);
        await this.runContainer(project, spec, { id, name });
        if (spec.mount === 'copy') await this.copyProjectIn(project, spec);
        // The answer comes from inside the (untrusted) image, so only two exact values are accepted.
        const probe = (await docker(['exec', spec.container, 'sh', '-c', 'command -v bash >/dev/null && echo bash || echo sh'])).stdout.trim();
        spec.shell = probe === 'bash' ? 'bash' : 'sh';
        spec.hostPorts = await publishedPorts(spec.container);
        this.save(id, { spec, status: 'running', error: null });
        let init: SandboxExecResult | undefined;
        if (input.init?.trim()) init = await this.exec(id, input.init, { timeoutSec: 900 });
        return { sandbox: this.get(id), init };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await docker(['rm', '-f', spec.container], { timeoutMs: 30_000 });
        db.prepare('DELETE FROM infra_sandboxes WHERE id = ?').run(id);
        this.changed();
        throw new HttpError(500, `Could not create sandbox "${name}": ${message}`);
      }
    });
  }

  private async ensureImage(image: string) {
    if ((await docker(['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: 15_000 })).code === 0) return;
    await dockerOk(['pull', image], { timeoutMs: 15 * 60_000 });
  }

  private async runContainer(project: Project, spec: Spec, meta: { id: string; name: string }) {
    const args = [
      'run',
      '-d',
      '--name',
      spec.container,
      '--hostname',
      meta.name,
      '--runtime',
      spec.runtime,
      '--cpus',
      String(spec.limits.cpus),
      '--memory',
      `${spec.limits.memoryMb}m`,
      '--pids-limit',
      String(spec.limits.pids),
      '--security-opt',
      'no-new-privileges',
      ...labelArgs({ [LABEL.kind]: 'sandbox', [LABEL.project]: project.id, [LABEL.sandbox]: meta.id }),
      '-e',
      `CLOUDE_SANDBOX=1`,
      '-w',
      '/workspace',
    ];
    for (const cap of spec.caps) args.push('--cap-add', cap);
    for (const [k, v] of Object.entries(spec.env)) args.push('-e', `${k}=${v}`);
    for (const p of spec.ports) args.push('-p', `127.0.0.1::${p}`); // Docker picks a free host port: no collisions, ever

    if (spec.network === 'isolated') {
      args.push('--network', 'none');
    } else {
      const net = networkName(project.id);
      await ensureNetwork(net, { [LABEL.kind]: 'network', [LABEL.project]: project.id });
      args.push('--network', net, '--network-alias', meta.name); // peers in the project reach it as http://<name>:<port>
    }

    if (spec.mount === 'ro' || spec.mount === 'rw') {
      const src = await hostPath(project.path);
      if (!src) throw new Error('Cloude runs in a container and could not map the project to a host path for a bind mount. Use mount "copy" instead.');
      args.push('-v', `${src}:/workspace:${spec.mount}`);
    }

    if (spec.isolation === 'system') {
      // System containers boot the image's own init (systemd) as PID 1.
      args.push(spec.image);
    } else {
      // Keep the machine alive with a tiny PID 1; everything else runs through exec.
      args.push('--init', '--entrypoint', 'sh', spec.image, '-c', 'mkdir -p /workspace; trap "exit 0" TERM INT; while :; do sleep 3600 & wait $!; done');
    }
    await dockerOk(args, { timeoutMs: 120_000 });
    if (spec.isolation === 'system') await docker(['exec', spec.container, 'mkdir', '-p', '/workspace']);
  }

  /** Stream the project into /workspace as a tar (skipping rebuildable dirs). */
  private copyProjectIn(project: Project, spec: Spec): Promise<void> {
    return new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-C', project.path, ...COPY_EXCLUDES.flatMap((e) => ['--exclude', `./${e}`]), '-cf', '-', '.'], {
        env: { ...process.env, COPYFILE_DISABLE: '1' }, // no macOS ._ resource-fork files
      });
      const ex = spawn('docker', ['exec', '-i', spec.container, 'tar', '-C', '/workspace', '-xf', '-']);
      tar.stdout.pipe(ex.stdin);
      let errText = '';
      tar.stderr.on('data', (d) => (errText += d));
      ex.stderr.on('data', (d) => (errText += d));
      const timer = setTimeout(() => {
        tar.kill('SIGKILL');
        ex.kill('SIGKILL');
      }, 10 * 60_000);
      tar.on('error', reject);
      ex.on('error', reject);
      ex.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`copying the project into the sandbox failed: ${errText.trim().slice(-400)}`));
      });
    });
  }

  async start(id: string): Promise<Sandbox> {
    return this.locked(id, async () => {
      const spec = this.spec(id);
      const state = await containerState(spec.container);
      if (state === 'missing') throw new HttpError(410, 'The sandbox container no longer exists. Restore a snapshot or destroy it.');
      if (state === 'stopped') await dockerOk(['start', spec.container]);
      spec.hostPorts = await publishedPorts(spec.container);
      this.save(id, { spec, status: 'running', error: null, last_active_at: now() });
      return this.get(id);
    });
  }

  async stop(id: string): Promise<Sandbox> {
    return this.locked(id, async () => {
      const spec = this.spec(id);
      await this.returnOwnership(spec);
      await docker(['stop', '-t', '5', spec.container], { timeoutMs: 30_000 });
      this.save(id, { status: 'stopped' });
      return this.get(id);
    });
  }

  /** Destroy the sandbox, its container and (unless kept) its snapshots. Returns bytes freed (best effort). */
  async destroy(id: string, opts: { keepSnapshots?: boolean } = {}): Promise<number> {
    return this.locked(id, async () => {
      const r = this.row(id);
      const spec = JSON.parse(r.spec) as Spec;
      this.save(id, { status: 'destroying' });
      let freed = r.size_bytes ?? (await containerSize(spec.container)) ?? 0;
      await this.returnOwnership(spec);
      const rm = await docker(['rm', '-f', '-v', spec.container], { timeoutMs: 60_000 });
      if (rm.code !== 0 && !/no such container/i.test(rm.stderr)) {
        this.save(id, { status: 'error', error: rm.stderr.trim() });
        throw new HttpError(500, rm.stderr.trim());
      }
      if (!opts.keepSnapshots) {
        for (const s of this.snapshotsOf(id)) freed += await this.removeImage(s.image, s.sizeBytes);
        db.prepare('DELETE FROM infra_snapshots WHERE sandbox_id = ?').run(id);
      }
      // Internal images (from expose_port / restore) belong to this sandbox only.
      if (spec.image !== spec.baseImage && !this.snapshotsOf(id).some((s) => s.image === spec.image)) freed += await this.removeImage(spec.image, null);
      db.prepare('DELETE FROM infra_sandboxes WHERE id = ?').run(id);
      this.changed();
      await this.pruneNetwork(r.project_id);
      return freed;
    });
  }

  private async removeImage(image: string, size: number | null): Promise<number> {
    const r = await docker(['rmi', image], { timeoutMs: 60_000 });
    return r.code === 0 ? (size ?? 0) : 0;
  }

  /** Remove the project network once no sandbox uses it. */
  private async pruneNetwork(projectId: string) {
    if (this.rows(projectId).some((r) => (JSON.parse(r.spec) as Spec).network === 'project')) return;
    await docker(['network', 'rm', networkName(projectId)], { timeoutMs: 20_000 });
  }

  /** Files a root-run sandbox created in a read-write bind mount would otherwise be root-owned on the host. */
  private async returnOwnership(spec: Spec) {
    if (spec.mount !== 'rw' || typeof process.getuid !== 'function') return;
    if ((await containerState(spec.container)) !== 'running') return;
    await docker(['exec', spec.container, 'chown', '-R', `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`, '/workspace'], { timeoutMs: 120_000 });
  }

  update(id: string, patch: { pinned?: boolean; ttlMinutes?: number | null }): Sandbox {
    const fields: Partial<Omit<Row, 'spec'>> = {};
    if (patch.pinned !== undefined) fields.pinned = patch.pinned ? 1 : 0;
    if (patch.ttlMinutes !== undefined) fields.ttl_minutes = patch.ttlMinutes;
    this.save(id, fields);
    return this.get(id);
  }

  // ---- working inside -------------------------------------------------------------------

  private async ensureRunning(id: string): Promise<Spec> {
    const r = this.row(id);
    if (r.status === 'creating' || r.status === 'destroying') throw new HttpError(409, `Sandbox is ${r.status}`);
    const spec = JSON.parse(r.spec) as Spec;
    const state = await containerState(spec.container);
    if (state === 'missing') {
      this.save(id, { status: 'error', error: 'Container disappeared (removed outside Cloude?)' });
      throw new HttpError(410, 'The sandbox container no longer exists. Restore a snapshot or destroy the sandbox.');
    }
    if (state === 'stopped') {
      await dockerOk(['start', spec.container]); // stopped by the idle policy: wake it transparently
      spec.hostPorts = await publishedPorts(spec.container);
      this.save(id, { spec, status: 'running', error: null });
    }
    this.touch(id);
    return spec;
  }

  async exec(
    id: string,
    command: string,
    opts: { cwd?: string; env?: Record<string, string>; timeoutSec?: number; background?: boolean; user?: string } = {},
  ): Promise<SandboxExecResult & { logFile?: string }> {
    const spec = await this.ensureRunning(id);
    const args = ['exec'];
    if (opts.cwd) args.push('-w', opts.cwd);
    if (opts.user) args.push('-u', opts.user);
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push('-e', `${k}=${v}`);
    if (opts.background) {
      const logFile = `/tmp/cloude-job-${Date.now().toString(36)}.log`;
      args.push('-d', spec.container, spec.shell, '-lc', `(${command}) > ${logFile} 2>&1`);
      const r = await runCapped('docker', args, { timeoutMs: 30_000 });
      return { ...r, logFile, stdout: r.code === 0 ? `Started in the background. Output: ${logFile}` : r.stdout };
    }
    args.push(spec.container, spec.shell, '-lc', command);
    const timeoutMs = Math.min(Math.max(opts.timeoutSec ?? 120, 1), 1800) * 1000;
    const r = await runCapped('docker', args, { timeoutMs });
    this.touch(id);
    return r;
  }

  async writeFile(id: string, file: string, content: string): Promise<void> {
    const spec = await this.ensureRunning(id);
    const r = await runCapped('docker', ['exec', '-i', spec.container, 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', file], {
      timeoutMs: 60_000,
      input: content,
    });
    if (r.code !== 0) throw new HttpError(400, r.stderr.trim() || 'write failed');
  }

  async readFile(id: string, file: string, maxBytes = 200_000): Promise<{ content: string; size: number; truncated: boolean }> {
    const spec = await this.ensureRunning(id);
    const size = await runCapped('docker', ['exec', spec.container, 'sh', '-c', 'wc -c < "$1"', 'sh', file], { timeoutMs: 15_000 });
    if (size.code !== 0) throw new HttpError(404, size.stderr.trim() || `${file}: not found`);
    const r = await runCapped('docker', ['exec', spec.container, 'sh', '-c', `head -c ${Math.max(1, Math.floor(maxBytes))} "$1"`, 'sh', file], { timeoutMs: 30_000 });
    const total = Number(size.stdout.trim()) || 0;
    return { content: r.stdout, size: total, truncated: total > maxBytes };
  }

  /** Copy between the project (host) and the sandbox. Copying OUT writes into the project, so callers gate it. */
  async copy(id: string, direction: 'in' | 'out', from: string, to: string): Promise<string> {
    const spec = await this.ensureRunning(id);
    const project = projects.require(this.row(id).project_id);
    if (direction === 'in') {
      const src = safeJoin(project.path, from);
      await dockerOk(['cp', src, `${spec.container}:${to}`], { timeoutMs: 10 * 60_000 });
      return `Copied ${from} → sandbox:${to}`;
    }
    const dest = safeJoin(project.path, to);
    await dockerOk(['cp', `${spec.container}:${from}`, dest], { timeoutMs: 10 * 60_000 });
    return `Copied sandbox:${from} → ${path.relative(project.path, dest) || '.'}`;
  }

  async stats(id: string) {
    const spec = await this.ensureRunning(id);
    const [s, size] = await Promise.all([
      docker(['stats', '--no-stream', '--format', '{{json .}}', spec.container], { timeoutMs: 15_000 }),
      containerSize(spec.container),
    ]);
    if (size !== null) this.save(id, { size_bytes: size });
    let parsed: Record<string, string> = {};
    try {
      parsed = JSON.parse(s.stdout.trim());
    } catch {
      /* stats unavailable */
    }
    return { cpu: parsed.CPUPerc ?? null, memory: parsed.MemUsage ?? null, net: parsed.NetIO ?? null, disk: parsed.BlockIO ?? null, pids: parsed.PIDs ?? null, sizeBytes: size };
  }

  /** Open an interactive root shell in the sandbox as a Cloude terminal (shows up in the project's Terminal panel). */
  async openShell(id: string): Promise<TerminalInfo> {
    const spec = await this.ensureRunning(id);
    const r = this.row(id);
    // Runs through the host shell: both parts are validated, never taken verbatim from the sandbox.
    const shell = spec.shell === 'bash' ? 'bash' : 'sh';
    if (!/^cloude-[0-9a-f]{8}-[0-9a-f]{8}$/.test(spec.container)) throw new HttpError(500, 'Unexpected container name');
    return terminals.create(r.project_id, { command: `docker exec -it ${spec.container} ${shell} -l`, title: `sandbox · ${r.name}` });
  }

  // ---- snapshots ----------------------------------------------------------------------------

  async snapshot(id: string, label?: string): Promise<SandboxSnapshot> {
    return this.locked(id, async () => {
      const spec = await this.ensureRunning(id);
      const r = this.row(id);
      const snapId = crypto.randomBytes(3).toString('hex');
      const image = `cloude-${INSTANCE}-snap:${id}-${snapId}`;
      await dockerOk(
        [
          'commit',
          '--change',
          `LABEL ${LABEL.managed}=1 ${LABEL.instance}=${INSTANCE} ${LABEL.kind}=snapshot ${LABEL.sandbox}=${id} ${LABEL.project}=${r.project_id}`,
          spec.container,
          image,
        ],
        { timeoutMs: 15 * 60_000 },
      );
      const size = Number((await docker(['image', 'inspect', '--format', '{{.Size}}', image])).stdout.trim()) || null;
      const snap: SandboxSnapshot = { id: snapId, sandboxId: id, label: label?.trim() || `snapshot ${this.snapshotsOf(id).length + 1}`, image, sizeBytes: size, createdAt: now() };
      db.prepare('INSERT INTO infra_snapshots (id, sandbox_id, project_id, label, image, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        snap.id,
        id,
        r.project_id,
        snap.label,
        image,
        size,
        snap.createdAt,
      );
      this.changed();
      return snap;
    });
  }

  async deleteSnapshot(id: string, snapshotId: string) {
    const snap = this.snapshotsOf(id).find((s) => s.id === snapshotId || s.label === snapshotId);
    if (!snap) throw new HttpError(404, 'Snapshot not found');
    if (this.spec(id).image === snap.image) throw new HttpError(409, 'The sandbox is running from this snapshot');
    await this.removeImage(snap.image, snap.sizeBytes);
    db.prepare('DELETE FROM infra_snapshots WHERE id = ? AND sandbox_id = ?').run(snap.id, id);
    this.changed();
  }

  /** Recreate the container from an image (snapshot restore, adding ports). Files come from the image; processes restart. */
  private async recreate(id: string, image: string, ports: number[]) {
    const r = this.row(id);
    const spec = JSON.parse(r.spec) as Spec;
    const project = projects.require(r.project_id);
    await this.returnOwnership(spec);
    await dockerOk(['rm', '-f', spec.container], { timeoutMs: 60_000 });
    const next: Spec = { ...spec, image, ports };
    // The project copy lives in the image already; bind mounts are re-attached by runContainer.
    await this.runContainer(project, next, { id, name: r.name });
    next.hostPorts = await publishedPorts(next.container);
    this.save(id, { spec: next, status: 'running', error: null, last_active_at: now() });
  }

  async restore(id: string, snapshotId: string): Promise<Sandbox> {
    return this.locked(id, async () => {
      const snap = this.snapshotsOf(id).find((s) => s.id === snapshotId || s.label === snapshotId);
      if (!snap) throw new HttpError(404, 'Snapshot not found');
      const spec = this.spec(id);
      const previous = spec.image;
      await this.recreate(id, snap.image, spec.ports);
      // Drop the internal image we were running from, unless it is a user snapshot.
      if (previous !== spec.baseImage && previous !== snap.image && !this.snapshotsOf(id).some((s) => s.image === previous)) await this.removeImage(previous, null);
      return this.get(id);
    });
  }

  /** Publish another container port. Docker can't add ports to a live container, so this commits and recreates it. */
  async exposePort(id: string, port: number): Promise<Sandbox> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Port must be 1-65535');
    return this.locked(id, async () => {
      const spec = await this.ensureRunning(id);
      if (spec.ports.includes(port)) return this.get(id);
      const image = `cloude-${INSTANCE}-snap:${id}-live${Date.now().toString(36)}`;
      await dockerOk(['commit', '--change', `LABEL ${LABEL.managed}=1 ${LABEL.instance}=${INSTANCE} ${LABEL.kind}=internal ${LABEL.sandbox}=${id}`, spec.container, image], {
        timeoutMs: 15 * 60_000,
      });
      const previous = spec.image;
      await this.recreate(id, image, [...spec.ports, port]);
      if (previous !== spec.baseImage && !this.snapshotsOf(id).some((s) => s.image === previous)) await this.removeImage(previous, null);
      return this.get(id);
    });
  }

  // ---- reconciliation -------------------------------------------------------------------------

  /** Bring rows in line with reality (after a server restart, or containers removed by hand). */
  async reconcile() {
    if (!(await engineInfo()).available) return;
    for (const r of this.rows()) {
      if (r.status === 'creating' || r.status === 'destroying') {
        // Interrupted by a restart: the operation can't be resumed.
        if (this.locks.has(r.id)) continue;
        const spec = JSON.parse(r.spec) as Spec;
        await docker(['rm', '-f', spec.container], { timeoutMs: 30_000 });
        db.prepare('DELETE FROM infra_sandboxes WHERE id = ?').run(r.id);
        this.changed();
        continue;
      }
      if (this.locks.has(r.id)) continue;
      const state = await containerState((JSON.parse(r.spec) as Spec).container);
      const status: SandboxStatus = state === 'running' ? 'running' : state === 'stopped' ? 'stopped' : 'error';
      if (status !== r.status) this.save(r.id, { status, error: state === 'missing' ? 'Container disappeared (removed outside Cloude?)' : null });
    }
  }

  async destroyAllFor(projectId: string) {
    for (const r of this.rows(projectId)) await this.destroy(r.id).catch(() => {});
  }
}

export const sandboxes = new SandboxManager();
