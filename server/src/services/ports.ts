import fs from 'node:fs';
import { config } from '../config.js';
import { run } from '../util/exec.js';

export interface RawPort {
  port: number;
  pid: number | null;
  command: string | null;
  address: string;
}

/** Parse /proc/net/tcp{,6} — sees every LISTEN socket in the network namespace (incl. docker-published ports). */
function procNetListeners(): RawPort[] {
  const out: RawPort[] = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== '0A') continue; // 0A = LISTEN
      const [addrHex, portHex] = cols[1]!.split(':');
      out.push({ port: parseInt(portHex!, 16), pid: null, command: null, address: addrHex!.replace(/^0+$/, '*') || '*' });
    }
  }
  return out;
}

/** lsof gives pid + command (macOS and Linux), but only for processes we can see. */
async function lsofListeners(): Promise<RawPort[]> {
  const r = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { timeoutMs: 5000 });
  if (r.code !== 0 && !r.stdout) return [];
  const out: RawPort[] = [];
  let pid: number | null = null;
  let command: string | null = null;
  for (const line of r.stdout.split('\n')) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') pid = Number(val);
    else if (tag === 'c') command = val;
    else if (tag === 'n') {
      const m = val.match(/^(.*):(\d+)$/);
      if (m) out.push({ port: Number(m[2]), pid, command, address: m[1]! });
    }
  }
  return out;
}

export async function listListeningPorts(): Promise<RawPort[]> {
  const byPort = new Map<number, RawPort>();
  for (const p of procNetListeners()) byPort.set(p.port, p);
  for (const p of await lsofListeners()) {
    const existing = byPort.get(p.port);
    if (!existing || existing.pid === null) byPort.set(p.port, p);
  }
  return [...byPort.values()]
    .filter((p) => !config.reservedPorts.has(p.port) && p.port >= 1024)
    .sort((a, b) => a.port - b.port);
}

/** Ports bound by a process tree (used to auto-detect what a service is serving). */
export async function portsForPids(pids: Set<number>): Promise<number[]> {
  const all = await lsofListeners();
  return [...new Set(all.filter((p) => p.pid !== null && pids.has(p.pid)).map((p) => p.port))];
}

/** All descendant pids of `root`, via `ps` (portable across macOS/Linux). */
export async function processTree(root: number): Promise<Set<number>> {
  const r = await run('ps', ['-A', '-o', 'pid=,ppid='], { timeoutMs: 5000 });
  const children = new Map<number, number[]>();
  for (const line of r.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  const seen = new Set<number>([root]);
  const stack = [root];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      stack.push(child);
    }
  }
  return seen;
}

/** Find a free TCP port by asking the OS. */
export async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
    srv.on('error', reject);
  });
}
