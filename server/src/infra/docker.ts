import fs from 'node:fs';
import path from 'node:path';
import { which } from '../config.js';
import { run, type ExecResult } from '../util/exec.js';
import { INSTANCE } from './store.js';

/**
 * Thin Docker CLI driver. The CLI (not the Engine API) keeps this dependency-free
 * and works the same against a local daemon, Docker Desktop, or the host socket
 * mounted into Cloude's own container.
 */

export const LABEL = {
  managed: 'cloude.managed',
  instance: 'cloude.instance',
  kind: 'cloude.kind',
  project: 'cloude.project',
  session: 'cloude.session',
  sandbox: 'cloude.sandbox',
} as const;

/** Label filter matching only objects created by THIS Cloude install. */
export const OWN = [`label=${LABEL.managed}=1`, `label=${LABEL.instance}=${INSTANCE}`];

export function labelArgs(labels: Record<string, string>): string[] {
  const all = { [LABEL.managed]: '1', [LABEL.instance]: INSTANCE, ...labels };
  return Object.entries(all).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
}

export function docker(args: string[], opts: { timeoutMs?: number; input?: string; cwd?: string } = {}): Promise<ExecResult> {
  return run('docker', args, { timeoutMs: opts.timeoutMs ?? 60_000, input: opts.input, cwd: opts.cwd });
}

/** Like docker() but throws with docker's own error message on failure. */
export async function dockerOk(args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<string> {
  const r = await docker(args, opts);
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').slice(-3).join('\n') || `docker ${args[0]} failed (${r.code})`);
  return r.stdout;
}

export interface EngineInfo {
  available: boolean;
  reason: string | null;
  version: string | null;
  os: string | null;
  runtimes: string[];
  storageDriver: string | null;
}

let engineCache: { at: number; value: EngineInfo } | null = null;

export async function engineInfo(force = false): Promise<EngineInfo> {
  if (!force && engineCache && Date.now() - engineCache.at < 60_000) return engineCache.value;
  let value: EngineInfo;
  if (!which('docker')) {
    value = { available: false, reason: 'The docker CLI is not installed on this server.', version: null, os: null, runtimes: [], storageDriver: null };
  } else {
    const r = await docker(['info', '--format', '{{json .}}'], { timeoutMs: 10_000 });
    if (r.code !== 0) {
      const msg = r.stderr.trim().split('\n').pop() ?? '';
      value = {
        available: false,
        reason: /permission denied/i.test(msg)
          ? 'No permission to use the Docker socket (add the Cloude user to the docker group).'
          : `The Docker daemon is not reachable${msg ? `: ${msg}` : ''}.`,
        version: null,
        os: null,
        runtimes: [],
        storageDriver: null,
      };
    } else {
      try {
        const info = JSON.parse(r.stdout) as { ServerVersion?: string; OperatingSystem?: string; Runtimes?: Record<string, unknown>; Driver?: string };
        value = {
          available: true,
          reason: null,
          version: info.ServerVersion ?? null,
          os: info.OperatingSystem ?? null,
          runtimes: Object.keys(info.Runtimes ?? {}),
          storageDriver: info.Driver ?? null,
        };
      } catch {
        value = { available: true, reason: null, version: null, os: null, runtimes: ['runc'], storageDriver: null };
      }
    }
  }
  engineCache = { at: Date.now(), value };
  return value;
}

export const hasKvm = () => fs.existsSync('/dev/kvm');

// ---- bind-mount path translation ------------------------------------------------------

let ownMounts: { source: string; destination: string }[] | null | undefined;

/**
 * When Cloude itself runs in a container, `docker run -v /data/x:/y` is resolved by
 * the HOST daemon, where /data/x doesn't exist. Find our own container's mounts and
 * translate the path to its host-side source. Returns null when it can't be mapped.
 */
export async function hostPath(local: string): Promise<string | null> {
  const abs = path.resolve(local);
  if (!fs.existsSync('/.dockerenv')) return abs; // not containerized: paths are host paths
  if (ownMounts === undefined) {
    ownMounts = null;
    try {
      const mountinfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
      const id = /\/containers\/([0-9a-f]{64})\//.exec(mountinfo)?.[1];
      if (id) {
        const out = await dockerOk(['inspect', id, '--format', '{{json .Mounts}}'], { timeoutMs: 10_000 });
        ownMounts = (JSON.parse(out) as { Source: string; Destination: string }[]).map((m) => ({ source: m.Source, destination: m.Destination }));
      }
    } catch {
      ownMounts = null;
    }
  }
  const match = ownMounts
    ?.filter((m) => abs === m.destination || abs.startsWith(m.destination + path.sep))
    .sort((a, b) => b.destination.length - a.destination.length)[0];
  return match ? path.join(match.source, abs.slice(match.destination.length)) : null;
}

// ---- sizes ------------------------------------------------------------------------------

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

/** Parse Docker's human sizes ("12.3MB", "1.04GiB", "0B"). */
export function parseSize(s: string | undefined | null): number | null {
  const m = /([\d.]+)\s*([a-z]+)/i.exec(s ?? '');
  if (!m) return null;
  const unit = UNITS[m[2]!.toLowerCase()];
  return unit ? Math.round(parseFloat(m[1]!) * unit) : null;
}

/** Writable-layer size of a container (what it costs on disk beyond its image). */
export async function containerSize(name: string): Promise<number | null> {
  const r = await docker(['inspect', '--size', '--format', '{{.SizeRw}}', name], { timeoutMs: 30_000 });
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isFinite(n) ? n : null;
}

export async function containerState(name: string): Promise<'running' | 'stopped' | 'missing'> {
  const r = await docker(['inspect', '--format', '{{.State.Running}}', name], { timeoutMs: 10_000 });
  if (r.code !== 0) return 'missing';
  return r.stdout.trim() === 'true' ? 'running' : 'stopped';
}

export async function ensureNetwork(name: string, labels: Record<string, string>, internal = false) {
  const r = await docker(['network', 'inspect', name, '--format', '{{.Name}}'], { timeoutMs: 10_000 });
  if (r.code === 0) return;
  const args = ['network', 'create', '--driver', 'bridge', ...labelArgs(labels)];
  if (internal) args.push('--internal');
  const c = await docker([...args, name], { timeoutMs: 20_000 });
  // A concurrent create of the same network is fine; anything else is a real error.
  if (c.code !== 0 && !/already exists/i.test(c.stderr)) throw new Error(c.stderr.trim() || `could not create network ${name}`);
}

/** Host ports Docker assigned for a container's published ports. */
export async function publishedPorts(name: string): Promise<{ container: number; host: number }[]> {
  const r = await docker(['port', name], { timeoutMs: 10_000 });
  const out: { container: number; host: number }[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^(\d+)\/tcp -> [^:]*:(\d+)$/.exec(line.trim());
    if (m && !out.some((p) => p.container === Number(m[1]))) out.push({ container: Number(m[1]), host: Number(m[2]) });
  }
  return out;
}
