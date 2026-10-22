import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CleanerCategory, CleanerCategoryReport, CleanerItem, CleanerPolicy, CleanerRun, StorageReport } from '../../../shared/protocol.js';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { hub } from '../hub.js';
import { run } from '../util/exec.js';
import { OWN, docker, engineInfo, parseSize } from './docker.js';
import { sandboxes } from './sandboxes.js';
import { kv } from './store.js';

/**
 * The storage cleaner ("janitor"). Frees disk and memory once work is done, on a
 * schedule, and harder when the disk runs low.
 *
 * Safety model — the cleaner only removes things that are either
 *   (a) created by THIS Cloude install (labelled with its instance tag), or
 *   (b) rebuildable caches/artifacts, in categories that are opt-in when they
 *       could surprise you (host-wide Docker prune, project build artifacts).
 * Project source files, databases, secrets and deployments are never touched.
 */

const CONTAINERIZED = fs.existsSync('/.dockerenv');

export const DEFAULT_POLICY: CleanerPolicy = {
  enabled: true,
  intervalMinutes: 30,
  minFreePercent: 10,
  minFreeGb: 5,
  categories: {
    sandboxes: 'schedule',
    snapshots: 'schedule',
    docker: 'schedule',
    docker_global: 'off',
    // On a dev machine (not in the Cloude image) temp files and caches are shared with YOUR
    // other tools: leave them alone unless asked.
    tmp: CONTAINERIZED ? 'schedule' : 'off',
    caches: CONTAINERIZED ? 'pressure' : 'off',
    artifacts: 'off',
  },
  sandboxIdleStopMinutes: 30,
  sandboxIdleDestroyMinutes: 24 * 60,
  sessionDoneGraceMinutes: 30,
  snapshotKeep: 3,
  artifactIdleDays: 14,
  tmpMaxAgeHours: 24,
};

export function policy(): CleanerPolicy {
  const p = kv.get<CleanerPolicy>('cleaner.policy', DEFAULT_POLICY);
  return { ...p, categories: { ...DEFAULT_POLICY.categories, ...p.categories } };
}

export function setPolicy(patch: Partial<CleanerPolicy>): CleanerPolicy {
  const cur = policy();
  const next: CleanerPolicy = { ...cur, ...patch, categories: { ...cur.categories, ...(patch.categories ?? {}) } };
  next.intervalMinutes = Math.max(5, Math.round(next.intervalMinutes));
  next.minFreePercent = Math.min(90, Math.max(0, next.minFreePercent));
  next.snapshotKeep = Math.max(0, Math.round(next.snapshotKeep));
  kv.set('cleaner.policy', next);
  return next;
}

// ---- helpers ---------------------------------------------------------------------------

/** Directory size in bytes via `du` (native and fast); null when unknown. */
async function du(dir: string): Promise<number | null> {
  const r = await run('du', ['-sk', dir], { timeoutMs: 60_000 });
  const kb = Number(r.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) && r.stdout ? kb * 1024 : null;
}

function disk() {
  try {
    const s = fs.statfsSync(config.workspacesDir);
    return { path: config.workspacesDir, total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

function underPressure(p: CleanerPolicy): boolean {
  const d = disk();
  if (!d || !d.total) return false;
  return (d.free / d.total) * 100 < p.minFreePercent || d.free < p.minFreeGb * 1e9;
}

const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 90 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

// ---- sandbox retention ---------------------------------------------------------------------

export interface SandboxFacts {
  status: string;
  pinned: boolean;
  idleMs: number; // since the sandbox was last used
  ttlMinutes: number | null;
  /** The owning session: null when created from the UI; 'gone' when the session was deleted. */
  owner: null | 'gone' | { archived: boolean; active: boolean; idleMs: number };
}

export type Verdict = { action: 'keep' } | { action: 'stop' | 'destroy'; reason: string };

/**
 * Decide what happens to one sandbox. "Work done" means: the owning session was
 * deleted or archived, or has been quiet for the grace period. Stopping frees
 * CPU/RAM but keeps the disk (it wakes on next use); destroying frees the disk.
 */
export function retentionVerdict(f: SandboxFacts, p: CleanerPolicy): Verdict {
  if (f.pinned) return { action: 'keep' };
  if (f.status === 'error') return { action: 'destroy', reason: 'container is gone or broken' };
  if (f.owner === 'gone') return { action: 'destroy', reason: 'its session was deleted' };
  if (f.owner && f.owner.archived) return { action: 'destroy', reason: 'its session was archived' };
  if (f.owner && f.owner.active) return { action: 'keep' }; // Claude is mid-turn: never pull the rug
  const destroyAfter = (f.ttlMinutes ?? p.sandboxIdleDestroyMinutes) * 60_000;
  if (f.idleMs > destroyAfter) return { action: 'destroy', reason: `unused for ${ago(f.idleMs)}` };
  const grace = p.sessionDoneGraceMinutes * 60_000;
  if (f.owner && f.owner.idleMs > grace && f.idleMs > grace && f.status === 'running') {
    return { action: 'stop', reason: `session finished ${ago(f.owner.idleMs)} ago` };
  }
  if (f.status === 'running' && f.idleMs > p.sandboxIdleStopMinutes * 60_000) return { action: 'stop', reason: `idle for ${ago(f.idleMs)}` };
  return { action: 'keep' };
}

function sandboxFacts(sb: ReturnType<typeof sandboxes.list>[number]): SandboxFacts {
  let owner: SandboxFacts['owner'] = null;
  if (sb.sessionId) {
    const s = db.prepare('SELECT status, archived, updated_at FROM sessions WHERE id = ?').get(sb.sessionId) as
      | { status: string; archived: number; updated_at: number }
      | undefined;
    owner = s
      ? { archived: !!s.archived, active: ['running', 'starting', 'awaiting_input'].includes(s.status), idleMs: now() - s.updated_at }
      : 'gone';
  }
  return { status: sb.status, pinned: sb.pinned, idleMs: now() - sb.lastActiveAt, ttlMinutes: sb.ttlMinutes, owner };
}

// ---- reclaimers -------------------------------------------------------------------------------

interface Reclaimer {
  label: string;
  description: string;
  scan(p: CleanerPolicy): Promise<CleanerItem[]>;
  reclaim(item: CleanerItem, p: CleanerPolicy): Promise<number>; // bytes freed
}

const HOME = os.homedir();
const CACHE_DIRS: { dir: string; label: string }[] = [
  { dir: '.npm/_cacache', label: 'npm cache' },
  { dir: '.cache/pip', label: 'pip cache' },
  { dir: 'Library/Caches/pip', label: 'pip cache' },
  { dir: '.cache/uv', label: 'uv cache' },
  { dir: '.cache/go-build', label: 'Go build cache' },
  { dir: 'Library/Caches/go-build', label: 'Go build cache' },
  { dir: '.cache/yarn', label: 'Yarn cache' },
  { dir: 'Library/Caches/Yarn', label: 'Yarn cache' },
  { dir: '.bun/install/cache', label: 'Bun cache' },
  { dir: '.local/share/pnpm/store', label: 'pnpm store' },
  { dir: 'Library/pnpm/store', label: 'pnpm store' },
  { dir: '.cargo/registry/cache', label: 'Cargo download cache' },
  { dir: '.gradle/caches', label: 'Gradle caches' },
  { dir: '.nuget/packages', label: 'NuGet packages' },
];

// Cloude itself writes nothing to tmp; its sessions' browser testing (Playwright MCP) does.
const TMP_PREFIXES = /^(playwright-mcp-output|playwright-artifacts-|playwright_chromiumdev_profile-)/;

/** Never delete a path that is, contains, or lives inside Cloude's own state or a project. */
function isProtected(p: string): boolean {
  const roots = [config.dataDir, config.workspacesDir, ...(db.prepare('SELECT path FROM projects').all() as { path: string }[]).map((r) => r.path)];
  const abs = path.resolve(p);
  return roots.some((r) => abs === r || r.startsWith(abs + path.sep) || abs.startsWith(r + path.sep));
}

/** Rebuildable heavy directories, and the marker file that proves what they are. */
const ARTIFACT_DIRS: { name: string; marker?: string }[] = [
  { name: 'node_modules', marker: 'package.json' },
  { name: '.venv' },
  { name: 'venv', marker: 'pyvenv.cfg' },
  { name: '__pycache__' },
  { name: '.pytest_cache' },
  { name: '.next', marker: 'package.json' },
  { name: '.nuxt', marker: 'package.json' },
  { name: '.turbo' },
  { name: 'target', marker: 'Cargo.toml' },
  { name: 'obj' },
];

function findArtifacts(root: string, depth = 0, out: string[] = []): string[] {
  if (depth > 4) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.git' || e.name === '.cloude') continue;
    const full = path.join(root, e.name);
    const kind = ARTIFACT_DIRS.find((a) => a.name === e.name);
    // venv's marker lives inside it; the others' markers sit next to them.
    const ok = kind && (!kind.marker || fs.existsSync(path.join(kind.name === 'venv' ? full : root, kind.marker)));
    if (kind && (kind.name !== 'obj' || entries.some((x) => /\.(cs|fs|vb)proj$/.test(x.name)))) {
      if (ok) out.push(full);
      continue; // never descend into an artifact dir
    }
    findArtifacts(full, depth + 1, out);
  }
  return out;
}

const RECLAIMERS: Record<CleanerCategory, Reclaimer> = {
  sandboxes: {
    label: 'Finished sandboxes',
    description: 'Stops idle sandboxes (frees RAM/CPU) and destroys those whose session is done, deleted or archived, or that sat unused past their TTL. Pinned sandboxes are kept.',
    async scan(p) {
      await sandboxes.reconcile();
      const items: CleanerItem[] = [];
      for (const sb of sandboxes.list()) {
        const v = retentionVerdict(sandboxFacts(sb), p);
        if (v.action === 'keep') continue;
        items.push({
          category: 'sandboxes',
          id: `${v.action}:${sb.id}`,
          label: `${v.action === 'stop' ? 'Stop' : 'Destroy'} ${sb.name}`,
          bytes: v.action === 'destroy' ? (sb.sizeBytes ?? 0) + sb.snapshots.reduce((n, s) => n + (s.sizeBytes ?? 0), 0) : 0,
          reason: v.reason,
        });
      }
      return items;
    },
    async reclaim(item) {
      const [action, id] = item.id.split(':') as ['stop' | 'destroy', string];
      if (action === 'stop') {
        await sandboxes.stop(id);
        return 0;
      }
      return sandboxes.destroy(id);
    },
  },

  snapshots: {
    label: 'Old snapshots',
    description: 'Snapshot images beyond the keep count per sandbox, and images left behind by sandboxes that no longer exist.',
    async scan(p) {
      const items: CleanerItem[] = [];
      const live = new Set(sandboxes.list().map((s) => s.id));
      for (const sb of sandboxes.list()) {
        const inUse = sandboxes.currentImage(sb.id);
        const extra = sb.snapshots.filter((s) => s.image !== inUse).slice(0, Math.max(0, sb.snapshots.length - p.snapshotKeep));
        for (const s of extra) items.push({ category: 'snapshots', id: `snap:${sb.id}:${s.id}`, label: `${sb.name} · ${s.label}`, bytes: s.sizeBytes, reason: `more than ${p.snapshotKeep} snapshots` });
      }
      if ((await engineInfo()).available) {
        const r = await docker(['image', 'ls', ...OWN.flatMap((f) => ['--filter', f]), '--format', '{{json .}}']);
        for (const line of r.stdout.split('\n').filter(Boolean)) {
          const img = JSON.parse(line) as { Repository: string; Tag: string; ID: string; Size: string };
          const sid = /^([0-9a-f]{8})-/.exec(img.Tag)?.[1];
          if (sid && !live.has(sid)) items.push({ category: 'snapshots', id: `img:${img.ID}`, label: `${img.Repository}:${img.Tag}`, bytes: parseSize(img.Size), reason: 'its sandbox no longer exists' });
        }
      }
      return items;
    },
    async reclaim(item) {
      const [kind, a, b] = item.id.split(':');
      if (kind === 'snap') {
        await sandboxes.deleteSnapshot(a!, b!);
        return item.bytes ?? 0;
      }
      const r = await docker(['rmi', a!], { timeoutMs: 60_000 });
      return r.code === 0 ? (item.bytes ?? 0) : 0;
    },
  },

  docker: {
    label: 'Cloude Docker leftovers',
    description: "Containers and networks this Cloude install created but no longer tracks (after crashes or manual edits). Only objects carrying this install's labels.",
    async scan() {
      if (!(await engineInfo()).available) return [];
      const items: CleanerItem[] = [];
      const known = new Set(sandboxes.list().map((s) => s.container));
      const c = await docker(['ps', '-a', '--size', ...OWN.flatMap((f) => ['--filter', f]), '--format', '{{json .}}']);
      for (const line of c.stdout.split('\n').filter(Boolean)) {
        const ct = JSON.parse(line) as { Names: string; Size: string; Status: string };
        if (!known.has(ct.Names)) items.push({ category: 'docker', id: `ctr:${ct.Names}`, label: ct.Names, bytes: parseSize(ct.Size), reason: `untracked container (${ct.Status})` });
      }
      const n = await docker(['network', 'ls', ...OWN.flatMap((f) => ['--filter', f]), '--format', '{{.Name}}']);
      const usedNets = new Set(
        sandboxes
          .list()
          .filter((s) => s.network === 'project')
          .map((s) => s.projectId.replace(/-/g, '').slice(0, 12)),
      );
      for (const name of n.stdout.split('\n').filter(Boolean)) {
        if (![...usedNets].some((p) => name.endsWith(p))) items.push({ category: 'docker', id: `net:${name}`, label: name, bytes: 0, reason: 'network with no sandboxes' });
      }
      return items;
    },
    async reclaim(item) {
      const [kind, name] = item.id.split(/:(.*)/s) as [string, string];
      const r = kind === 'ctr' ? await docker(['rm', '-f', '-v', name], { timeoutMs: 60_000 }) : await docker(['network', 'rm', name], { timeoutMs: 20_000 });
      return r.code === 0 ? (item.bytes ?? 0) : 0;
    },
  },

  docker_global: {
    label: 'Host-wide Docker prune',
    description: 'Dangling images and build cache older than 3 days for the WHOLE Docker host — also affects projects outside Cloude. Never removes containers, tagged images or volumes.',
    async scan() {
      if (!(await engineInfo()).available) return [];
      const r = await docker(['system', 'df', '--format', '{{json .}}'], { timeoutMs: 60_000 });
      const items: CleanerItem[] = [];
      for (const line of r.stdout.split('\n').filter(Boolean)) {
        const row = JSON.parse(line) as { Type: string; Reclaimable: string };
        const bytes = parseSize(row.Reclaimable);
        if (!bytes) continue;
        if (row.Type === 'Images') items.push({ category: 'docker_global', id: 'images', label: 'Dangling images', bytes, reason: 'untagged image layers (upper bound)' });
        if (row.Type === 'Build Cache') items.push({ category: 'docker_global', id: 'builder', label: 'Build cache (>72h)', bytes, reason: 'reclaimable build cache (upper bound)' });
      }
      return items;
    },
    async reclaim(item) {
      const r =
        item.id === 'images'
          ? await docker(['image', 'prune', '-f'], { timeoutMs: 10 * 60_000 })
          : await docker(['builder', 'prune', '-f', '--filter', 'until=72h'], { timeoutMs: 10 * 60_000 });
      return parseSize(/Total reclaimed space:\s*(.+)/.exec(r.stdout)?.[1]) ?? 0;
    },
  },

  tmp: {
    label: 'Temporary files',
    description: 'Browser-testing (Playwright) profiles and output left in the temp directory, older than the max age.',
    async scan(p) {
      const items: CleanerItem[] = [];
      const cutoff = now() - p.tmpMaxAgeHours * 3600_000;
      for (const dir of new Set([os.tmpdir(), '/tmp'])) {
        let names: string[] = [];
        try {
          names = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names.filter((n) => TMP_PREFIXES.test(n))) {
          const full = path.join(dir, name);
          if (isProtected(full)) continue;
          try {
            const st = fs.lstatSync(full);
            if (st.mtimeMs > cutoff || st.uid !== process.getuid?.()) continue;
            items.push({ category: 'tmp', id: full, label: full, bytes: st.isDirectory() ? await du(full) : st.size, reason: `older than ${p.tmpMaxAgeHours}h` });
          } catch {
            /* vanished */
          }
        }
      }
      return items;
    },
    async reclaim(item) {
      if (isProtected(item.id)) throw new Error(`refusing to delete ${item.id}: it holds Cloude state or a project`);
      await fs.promises.rm(item.id, { recursive: true, force: true });
      return item.bytes ?? 0;
    },
  },

  caches: {
    label: 'Package caches',
    description: 'npm, pnpm, Yarn, Bun, pip, uv, Go, Cargo, Gradle and NuGet download caches. Safe to delete; the next install downloads again.',
    async scan() {
      const items: CleanerItem[] = [];
      for (const c of CACHE_DIRS) {
        const full = path.join(HOME, c.dir);
        if (!fs.existsSync(full)) continue;
        const bytes = await du(full);
        if (bytes && bytes > 1e6) items.push({ category: 'caches', id: full, label: `${c.label} (~/${c.dir})`, bytes, reason: 'rebuildable download cache' });
      }
      return items;
    },
    async reclaim(item) {
      if (isProtected(item.id)) throw new Error(`refusing to delete ${item.id}: it holds Cloude state or a project`);
      await fs.promises.rm(item.id, { recursive: true, force: true });
      return item.bytes ?? 0;
    },
  },

  artifacts: {
    label: 'Build artifacts in idle projects',
    description:
      'node_modules, virtualenvs, Rust target/, .NET obj/, framework caches in projects untouched for the idle period. Skips any project with a deployment, a published route, or a running service.',
    async scan(p) {
      const items: CleanerItem[] = [];
      const cutoff = now() - p.artifactIdleDays * 86_400_000;
      const rows = db.prepare('SELECT id, name, path, updated_at FROM projects WHERE updated_at < ?').all(cutoff) as { id: string; name: string; path: string; updated_at: number }[];
      for (const proj of rows) {
        const busy =
          db.prepare(`SELECT 1 FROM services WHERE project_id = ? AND kind = 'deploy'`).get(proj.id) ||
          db.prepare('SELECT 1 FROM routes WHERE project_id = ?').get(proj.id) ||
          db.prepare(`SELECT 1 FROM sessions WHERE project_id = ? AND updated_at > ?`).get(proj.id, cutoff);
        if (busy) continue;
        for (const dir of findArtifacts(proj.path)) {
          const bytes = await du(dir);
          if (bytes && bytes > 5e6) items.push({ category: 'artifacts', id: dir, label: `${proj.name}: ${path.relative(proj.path, dir)}`, bytes, reason: `project idle ${ago(now() - proj.updated_at)}` });
        }
      }
      return items;
    },
    async reclaim(item) {
      // Re-check the path is still inside a known project before deleting anything.
      const inside = (db.prepare('SELECT path FROM projects').all() as { path: string }[]).some((p) => item.id.startsWith(p.path + path.sep));
      if (!inside) throw new Error(`refusing to delete ${item.id}: not inside a project`);
      await fs.promises.rm(item.id, { recursive: true, force: true });
      return item.bytes ?? 0;
    },
  },
};

export const CATEGORY_ORDER = Object.keys(RECLAIMERS) as CleanerCategory[];

// ---- engine ------------------------------------------------------------------------------------

class Cleaner {
  private lastScan: { at: number; categories: CleanerCategoryReport[] } | null = null;
  private running = false;
  private lastScheduled = now();
  private lastPressureRun = 0;
  private timer: NodeJS.Timeout | null = null;

  async scan(categories: CleanerCategory[] = CATEGORY_ORDER): Promise<CleanerCategoryReport[]> {
    const p = policy();
    const reports: CleanerCategoryReport[] = [];
    for (const c of categories) {
      let items: CleanerItem[] = [];
      try {
        items = await RECLAIMERS[c].scan(p);
      } catch (e) {
        items = [];
        console.error(`[cleaner] scan ${c} failed:`, e);
      }
      reports.push({
        category: c,
        label: RECLAIMERS[c].label,
        description: RECLAIMERS[c].description,
        trigger: p.categories[c],
        bytes: items.reduce((n, i) => n + (i.bytes ?? 0), 0),
        items,
      });
    }
    if (categories.length === CATEGORY_ORDER.length) this.lastScan = { at: now(), categories: reports };
    return reports;
  }

  /** Scan and reclaim the given categories. Records a run when anything was attempted. */
  async clean(categories: CleanerCategory[], trigger: CleanerRun['trigger']): Promise<CleanerRun | null> {
    if (this.running) throw new Error('A cleanup is already running');
    this.running = true;
    const startedAt = now();
    const errors: string[] = [];
    const byCategory: Partial<Record<CleanerCategory, number>> = {};
    let freed = 0;
    let removed = 0;
    try {
      const p = policy();
      for (const report of await this.scan(categories)) {
        for (const item of report.items) {
          try {
            const bytes = await RECLAIMERS[item.category].reclaim(item, p);
            freed += bytes;
            removed++;
            byCategory[item.category] = (byCategory[item.category] ?? 0) + bytes;
          } catch (e) {
            errors.push(`${item.label}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    } finally {
      this.running = false;
    }
    if (!removed && !errors.length) return null;
    const res = db
      .prepare('INSERT INTO infra_cleaner_runs (started_at, finished_at, trigger, freed_bytes, removed, errors, by_category) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(startedAt, now(), trigger, freed, removed, JSON.stringify(errors.slice(0, 20)), JSON.stringify(byCategory));
    db.prepare('DELETE FROM infra_cleaner_runs WHERE id <= ?').run(Number(res.lastInsertRowid) - 50);
    if (freed > 100e6) hub.broadcast({ t: 'notify', level: 'success', title: `Cleaner freed ${(freed / 1e9).toFixed(freed > 1e9 ? 1 : 2)} GB`, body: `${removed} item(s), ${trigger.replace('_', ' ')}` });
    this.lastScan = null; // sizes changed
    return this.runs(1)[0] ?? null;
  }

  runs(limit = 20): CleanerRun[] {
    const rows = db.prepare('SELECT * FROM infra_cleaner_runs ORDER BY id DESC LIMIT ?').all(limit) as {
      id: number;
      started_at: number;
      finished_at: number | null;
      trigger: CleanerRun['trigger'];
      freed_bytes: number;
      removed: number;
      errors: string;
      by_category: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      trigger: r.trigger,
      freedBytes: r.freed_bytes,
      removed: r.removed,
      errors: JSON.parse(r.errors),
      byCategory: JSON.parse(r.by_category),
    }));
  }

  report(): StorageReport {
    const p = policy();
    return {
      disk: disk(),
      pressure: underPressure(p),
      scannedAt: this.lastScan?.at ?? null,
      categories:
        this.lastScan?.categories.map((c) => ({ ...c, trigger: p.categories[c.category] })) ??
        CATEGORY_ORDER.map((c) => ({ category: c, label: RECLAIMERS[c].label, description: RECLAIMERS[c].description, trigger: p.categories[c], bytes: 0, items: [] })),
      runs: this.runs(),
      running: this.running,
      policy: p,
    };
  }

  /**
   * Once a minute: apply the sandbox lifecycle ("work done" → stop/destroy), and
   * run the scheduled / disk-pressure passes when they are due.
   */
  private async tick() {
    const p = policy();
    if (!p.enabled || this.running) return;
    try {
      const pressure = underPressure(p);
      const due = now() - this.lastScheduled >= p.intervalMinutes * 60_000;
      if (pressure && now() - this.lastPressureRun > 10 * 60_000) {
        this.lastPressureRun = now();
        this.lastScheduled = now();
        await this.clean(CATEGORY_ORDER.filter((c) => p.categories[c] !== 'off'), 'pressure');
      } else if (due) {
        this.lastScheduled = now();
        await this.clean(CATEGORY_ORDER.filter((c) => p.categories[c] === 'schedule'), 'schedule');
      } else if (p.categories.sandboxes !== 'off') {
        await this.clean(['sandboxes'], 'work_done');
      }
    } catch (e) {
      console.error('[cleaner] tick failed:', e);
    }
  }

  start() {
    if (this.timer) return;
    void sandboxes.reconcile().catch(() => {});
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  get busy() {
    return this.running;
  }
}

export const cleaner = new Cleaner();
