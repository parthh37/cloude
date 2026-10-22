import fs from 'node:fs';
import os from 'node:os';
import type { HostInfo, MetricsSample, MetricsSnapshot, ProcessGroup } from '../../shared/protocol.js';
import { config } from './config.js';
import { hub } from './hub.js';
import { services } from './services/service-manager.js';
import { terminals } from './terminal/terminals.js';
import { run } from './util/exec.js';

/**
 * Server health sampler: one system sample every 5 s into a 1-hour ring buffer,
 * streamed to clients watching 'metrics' (the status bar). The per-process
 * breakdown (Claude agents, terminals, each app) is costlier, so it only runs
 * while someone watches 'processes' (the Monitor page).
 */

const INTERVAL_MS = 5000;
const HISTORY = 720;
const isLinux = process.platform === 'linux';

// ---- system counters -----------------------------------------------------------------

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function readNumber(file: string): number | null {
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    return /^\d+$/.test(v) ? Number(v) : null;
  } catch {
    return null;
  }
}

/**
 * macOS: os.freemem() excludes reclaimable file cache, so it reads ~100% on any
 * busy Mac. Use Activity Monitor's definition instead: app + wired + compressed.
 */
let darwinMemory: { used: number; total: number } | null = null;
async function refreshDarwinMemory() {
  const r = await run('vm_stat', [], { timeoutMs: 2000 });
  if (r.code !== 0) return;
  const page = Number(/page size of (\d+) bytes/.exec(r.stdout)?.[1] ?? 16384);
  const pages = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(r.stdout)?.[1] ?? 0);
  const app = pages('Anonymous pages') ? pages('Anonymous pages') - pages('Pages purgeable') : pages('Pages active');
  const used = (app + pages('Pages wired down') + pages('Pages occupied by compressor')) * page;
  darwinMemory = { used: Math.min(used, os.totalmem()), total: os.totalmem() };
}

/** Memory in use. On Linux, MemAvailable (not MemFree) — and the cgroup limit when Cloude runs in a capped container. */
function memory(): { used: number; total: number } {
  if (darwinMemory) return darwinMemory;
  if (isLinux) {
    const limit = readNumber('/sys/fs/cgroup/memory.max');
    const current = readNumber('/sys/fs/cgroup/memory.current');
    if (limit && current !== null && limit < os.totalmem()) {
      let inactive = 0;
      try {
        inactive = Number(/^inactive_file (\d+)/m.exec(fs.readFileSync('/sys/fs/cgroup/memory.stat', 'utf8'))?.[1] ?? 0);
      } catch {
        /* no stat file */
      }
      return { used: Math.max(0, current - inactive), total: limit };
    }
    try {
      const info = fs.readFileSync('/proc/meminfo', 'utf8');
      const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? 0) * 1024;
      const total = kb('MemTotal');
      if (total) return { used: total - kb('MemAvailable'), total };
    } catch {
      /* fall through */
    }
  }
  return { used: os.totalmem() - os.freemem(), total: os.totalmem() };
}

function netCounters(): { rx: number; tx: number } | null {
  if (!isLinux) return null;
  try {
    let rx = 0;
    let tx = 0;
    for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
      const [iface, rest] = line.split(':');
      if (!rest || iface!.trim() === 'lo') continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0] ?? 0;
      tx += f[8] ?? 0;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

function disk(): { used: number; total: number } {
  try {
    const s = fs.statfsSync(config.workspacesDir);
    return { used: (s.blocks - s.bfree) * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return { used: 0, total: 0 };
  }
}

let prevCpu = cpuTimes();
let prevNet = netCounters();
let prevAt = Date.now();
const history: MetricsSample[] = [];

function sampleSystem(): MetricsSample {
  const t = Date.now();
  const cpu = cpuTimes();
  const dTotal = cpu.total - prevCpu.total;
  const busy = dTotal > 0 ? (1 - (cpu.idle - prevCpu.idle) / dTotal) * 100 : 0;
  const net = netCounters();
  const dt = Math.max(1, (t - prevAt) / 1000);
  const mem = memory();
  const d = disk();
  const sample: MetricsSample = {
    t,
    cpu: Math.round(Math.min(100, Math.max(0, busy)) * 10) / 10,
    load: os.loadavg().map((x) => Math.round(x * 100) / 100) as [number, number, number],
    memUsed: mem.used,
    memTotal: mem.total,
    diskUsed: d.used,
    diskTotal: d.total,
    netRx: net && prevNet ? Math.max(0, (net.rx - prevNet.rx) / dt) : null,
    netTx: net && prevNet ? Math.max(0, (net.tx - prevNet.tx) / dt) : null,
  };
  prevCpu = cpu;
  prevNet = net;
  prevAt = t;
  return sample;
}

// ---- per-process breakdown ---------------------------------------------------------------

interface Proc {
  ppid: number;
  rss: number;
  cpu: number; // % of one core since the previous scan
}

let clkTck = 100;
let pageSize = 4096;
if (isLinux) {
  void run('getconf', ['CLK_TCK']).then((r) => (clkTck = Number(r.stdout.trim()) || 100), () => {});
  void run('getconf', ['PAGESIZE']).then((r) => (pageSize = Number(r.stdout.trim()) || 4096), () => {});
}
let prevTicks = new Map<number, number>();
let prevScanAt = 0;

/** Linux: /proc/<pid>/stat gives instantaneous CPU via tick deltas. Elsewhere `ps` (a decaying average) is close enough. */
async function processTable(): Promise<Map<number, Proc>> {
  const out = new Map<number, Proc>();
  if (isLinux) {
    const t = Date.now();
    const dt = prevScanAt ? (t - prevScanAt) / 1000 : 0;
    const ticks = new Map<number, number>();
    const pids = (await fs.promises.readdir('/proc')).filter((d) => /^\d+$/.test(d));
    await Promise.all(
      pids.map(async (d) => {
        try {
          const stat = await fs.promises.readFile(`/proc/${d}/stat`, 'utf8');
          // comm (field 2) may contain spaces/parens; everything after the last ')' is fixed-format.
          const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          const pid = Number(d);
          const used = Number(f[11]) + Number(f[12]);
          ticks.set(pid, used);
          const prev = prevTicks.get(pid);
          out.set(pid, {
            ppid: Number(f[1]),
            rss: Number(f[21]) * pageSize,
            cpu: dt && prev !== undefined ? Math.max(0, ((used - prev) / clkTck / dt) * 100) : 0,
          });
        } catch {
          /* process exited mid-scan */
        }
      }),
    );
    prevTicks = ticks;
    prevScanAt = t;
    return out;
  }
  const r = await run('ps', ['-A', '-o', 'pid=,ppid=,rss=,pcpu=,comm='], { timeoutMs: 4000 });
  for (const line of r.stdout.split('\n')) {
    const [pid, ppid, rss, cpu, ...comm] = line.trim().split(/\s+/);
    if (!Number(pid) || /(^|\/)ps$/.test(comm.join(' '))) continue; // skip the ps we just spawned
    out.set(Number(pid), { ppid: Number(ppid) || 0, rss: (Number(rss) || 0) * 1024, cpu: Number(cpu) || 0 });
  }
  return out;
}

function descendants(root: number, children: Map<number, number[]>, claimed: Set<number>): number[] {
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    if (claimed.has(pid)) continue;
    claimed.add(pid);
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

async function processGroups(): Promise<ProcessGroup[]> {
  const table = await processTable();
  const children = new Map<number, number[]>();
  for (const [pid, p] of table) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid)!.push(pid);
  }
  const sum = (pids: number[]) =>
    pids.reduce(
      (acc, pid) => {
        const p = table.get(pid);
        if (p) {
          acc.cpu += p.cpu;
          acc.rss += p.rss;
          acc.processes++;
        }
        return acc;
      },
      { cpu: 0, rss: 0, processes: 0 },
    );

  // Claim the most specific trees first; whatever is left under Cloude is agents + MCP servers.
  const claimed = new Set<number>([process.pid]);
  const groups: ProcessGroup[] = [];
  for (const svc of services.list()) {
    if (svc.status !== 'running' || !svc.pid) continue;
    groups.push({ kind: 'service', label: svc.name, serviceId: svc.id, projectId: svc.projectId, ...sum(descendants(svc.pid, children, claimed)) });
  }
  const termPids = terminals.pids().flatMap((pid) => descendants(pid, children, claimed));
  groups.push({ kind: 'terminals', label: 'Terminals', ...sum(termPids) });
  claimed.delete(process.pid);
  const rest = descendants(process.pid, children, claimed).filter((pid) => pid !== process.pid);
  groups.unshift({ kind: 'agents', label: 'Claude agents & MCP', ...sum(rest) });
  const self = table.get(process.pid);
  groups.unshift({ kind: 'server', label: 'Cloude server', processes: 1, cpu: self?.cpu ?? 0, rss: self?.rss ?? process.memoryUsage().rss });
  for (const g of groups) g.cpu = Math.round(g.cpu * 10) / 10;
  return groups;
}

// ---- loop, alerts, snapshot -----------------------------------------------------------------

let lastProcesses: ProcessGroup[] = [];
let scanning = false;
const alerted = new Map<string, number>();

function alertOnce(key: string, everyMs: number, title: string, body: string) {
  const last = alerted.get(key) ?? 0;
  if (Date.now() - last < everyMs) return;
  alerted.set(key, Date.now());
  hub.broadcast({ t: 'notify', level: 'warning', title, body });
}

function checkHealth(s: MetricsSample) {
  if (s.diskTotal && s.diskUsed / s.diskTotal > 0.95) {
    alertOnce('disk', 60 * 60_000, 'Server disk is almost full', `${Math.round((s.diskUsed / s.diskTotal) * 100)}% used on the workspace volume`);
  }
  const recent = history.slice(-3);
  if (recent.length === 3 && recent.every((x) => x.memUsed / x.memTotal > 0.95)) {
    alertOnce('memory', 30 * 60_000, 'Server memory is nearly exhausted', 'Above 95% for 15 seconds — idle sessions pause after the idle timeout');
  }
}

async function tick() {
  if (process.platform === 'darwin') await refreshDarwinMemory();
  const sample = sampleSystem();
  history.push(sample);
  if (history.length > HISTORY) history.splice(0, history.length - HISTORY);
  checkHealth(sample);
  if (hub.watcherCount('processes') > 0 && !scanning) {
    scanning = true;
    try {
      lastProcesses = await processGroups();
    } catch {
      /* keep the previous breakdown */
    } finally {
      scanning = false;
    }
  }
  hub.toWatchers('metrics', { t: 'metrics', sample, processes: lastProcesses });
}

export function startMonitor() {
  setInterval(() => void tick(), INTERVAL_MS).unref();
}

function hostInfo(): HostInfo {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpus: cpus.length,
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    uptime: Math.round(os.uptime()),
    processUptime: Math.round(process.uptime()),
    nodeVersion: process.version,
  };
}

export async function metricsSnapshot(): Promise<MetricsSnapshot> {
  if (!lastProcesses.length && !scanning) lastProcesses = await processGroups().catch(() => []);
  return { host: hostInfo(), intervalMs: INTERVAL_MS, history, processes: lastProcesses };
}
