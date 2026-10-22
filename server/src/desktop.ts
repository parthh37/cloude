import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { WebSocket } from 'ws';
import type { DesktopStatus, WorkbenchSettings } from '../../shared/protocol.js';
import { config, which } from './config.js';
import { hub } from './hub.js';
import { extSettings } from './schema.js';
import { run } from './util/exec.js';
import { HttpError } from './util/paths.js';

/**
 * A virtual Linux desktop on the server, for building and testing GUI apps
 * (Electron, Tauri, .NET/Avalonia, Qt, GTK, headed browsers…).
 *
 *   Xvfb :99  ── x11vnc (localhost only, random password) ──► /ws/desktop (authenticated
 *                                   WebSocket ↔ TCP bridge) ──► noVNC in the browser
 *
 * The VNC port is also in config.reservedPorts, so the preview proxy and tunnels refuse
 * it; the per-start password is defence in depth for anything else that can reach it.
 *
 * While it runs, DISPLAY is exported to every process Cloude starts (sessions,
 * terminals, services), so GUI apps simply appear on it. Claude drives it with
 * the desktop_* tools (screenshots + xdotool input) — computer use, on a
 * machine that is nobody's real desktop.
 */

const DISPLAY_NUM = Number(process.env.CLOUDE_DESKTOP_DISPLAY ?? 99);
const DISPLAY = `:${DISPLAY_NUM}`;
const VNC_PORT = Number(process.env.CLOUDE_DESKTOP_VNC_PORT ?? 5900 + DISPLAY_NUM);
config.reservedPorts.add(VNC_PORT); // never reachable through the preview proxy

const REQUIRED = ['Xvfb', 'x11vnc', 'xdotool', 'import'];
const WINDOW_MANAGERS = ['fluxbox', 'openbox', 'xfwm4', 'matchbox-window-manager'];

export const DEFAULT_WORKBENCH: WorkbenchSettings = {
  compression: 'balanced',
  defaultIsolation: 'worktree',
  injectMemory: true,
  desktop: { width: 1280, height: 800, autoStart: false },
};

export const workbenchSettings = () => extSettings.get<WorkbenchSettings>('workbench', DEFAULT_WORKBENCH);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class DesktopManager {
  private procs: ChildProcess[] = [];
  private starting: Promise<void> | null = null;
  private error: string | null = null;
  /** VNC password for the current run; only ever returned to same-origin API callers. */
  private password: string | null = null;
  private size = { width: DEFAULT_WORKBENCH.desktop.width, height: DEFAULT_WORKBENCH.desktop.height };

  missing(): string[] {
    return REQUIRED.filter((b) => !which(b));
  }

  get running() {
    return this.procs.length > 0 && this.procs.every((p) => p.exitCode === null && !p.killed);
  }

  status(): DesktopStatus {
    const missing = this.missing();
    return {
      available: missing.length === 0,
      missing,
      running: this.running,
      display: this.running ? DISPLAY : null,
      width: this.size.width,
      height: this.size.height,
      error: this.error,
    };
  }

  private broadcast() {
    hub.broadcast({ t: 'desktop', status: this.status() });
  }

  async start(): Promise<DesktopStatus> {
    if (this.running) return this.status();
    if (this.starting) {
      await this.starting;
      return this.status();
    }
    const missing = this.missing();
    if (missing.length) throw new HttpError(400, `The virtual desktop needs ${missing.join(', ')} (install: sudo apt-get install -y xvfb x11vnc xdotool imagemagick fluxbox)`);
    this.starting = this.boot().finally(() => (this.starting = null));
    await this.starting;
    return this.status();
  }

  private async boot() {
    this.error = null;
    const { width, height } = workbenchSettings().desktop;
    this.size = { width, height };
    const env = { ...(process.env as Record<string, string>), DISPLAY };
    const track = (p: ChildProcess, name: string) => {
      p.on('exit', (code) => {
        if (!this.procs.includes(p)) return;
        this.error = `${name} exited (${code ?? 'signal'})`;
        void this.stop();
      });
      p.on('error', (e) => (this.error = `${name}: ${e.message}`));
      this.procs.push(p);
      return p;
    };

    // A stale lock from a crashed Xvfb would make the new one refuse to start.
    const lock = `/tmp/.X${DISPLAY_NUM}-lock`;
    if (fs.existsSync(lock)) {
      const pid = Number(fs.readFileSync(lock, 'utf8').trim());
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        /* dead */
      }
      if (!alive) fs.rmSync(lock, { force: true });
    }

    track(spawn('Xvfb', [DISPLAY, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-dpi', '96'], { stdio: 'ignore' }), 'Xvfb');
    for (let i = 0; i < 50 && !fs.existsSync(`/tmp/.X11-unix/X${DISPLAY_NUM}`); i++) await sleep(100);

    const wm = WINDOW_MANAGERS.find((b) => which(b));
    if (wm) track(spawn(wm, [], { env, stdio: 'ignore' }), wm);
    // VNC auth only uses 8 characters; x11vnc deletes the file after reading it (rm: prefix).
    this.password = crypto.randomBytes(9).toString('base64url').slice(0, 8);
    const pwFile = path.join(config.dataDir, `.desktop-vnc-${process.pid}`);
    fs.writeFileSync(pwFile, `${this.password}\n`, { mode: 0o600 });
    track(
      spawn(
        'x11vnc',
        // -rfbportv6: otherwise x11vnc also opens [::1]:5900, outside config.reservedPorts.
        ['-display', DISPLAY, '-rfbport', String(VNC_PORT), '-rfbportv6', String(VNC_PORT), '-localhost', '-forever', '-shared', '-passwdfile', `rm:${pwFile}`, '-quiet', '-noxdamage', '-xkb'],
        { env, stdio: 'ignore' },
      ),
      'x11vnc',
    );
    for (let i = 0; i < 50 && !(await this.vncReady()); i++) await sleep(100);

    process.env.DISPLAY = DISPLAY; // buildEnv() copies process.env, so every new child sees the desktop
    this.broadcast();
  }

  private vncReady(): Promise<boolean> {
    return new Promise((resolve) => {
      const s = net.connect(VNC_PORT, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
  }

  /** Credentials for the browser's noVNC client (served only by the authenticated, same-origin API). */
  credentials(): { password: string } | null {
    return this.running && this.password ? { password: this.password } : null;
  }

  async stop(): Promise<DesktopStatus> {
    const procs = this.procs;
    this.procs = [];
    this.password = null;
    for (const p of procs.reverse()) if (p.exitCode === null) p.kill('SIGTERM');
    if (process.env.DISPLAY === DISPLAY) delete process.env.DISPLAY;
    this.broadcast();
    return this.status();
  }

  /** Bridge an authenticated browser WebSocket to the local VNC server (noVNC speaks raw RFB over binary frames). */
  attach(ws: WebSocket) {
    if (!this.running) {
      ws.close(4409, 'desktop not running');
      return;
    }
    const tcp = net.connect(VNC_PORT, '127.0.0.1');
    tcp.on('data', (d) => ws.readyState === 1 && ws.send(d));
    tcp.on('close', () => ws.close());
    tcp.on('error', () => ws.close());
    ws.on('message', (d) => tcp.write(d as Buffer));
    ws.on('close', () => tcp.destroy());
  }

  // ---- computer use ----------------------------------------------------------------

  private async xdo(args: string[]) {
    await this.start();
    const r = await run('xdotool', args, { env: { ...(process.env as Record<string, string>), DISPLAY }, timeoutMs: 15_000 });
    if (r.code !== 0) throw new HttpError(400, r.stderr.trim() || `xdotool ${args[0]} failed`);
    return r.stdout.trim();
  }

  async screenshot(): Promise<string> {
    await this.start();
    const out = await new Promise<Buffer>((resolve, reject) => {
      const p = spawn('import', ['-window', 'root', 'png:-'], { env: { ...process.env, DISPLAY } });
      const chunks: Buffer[] = [];
      p.stdout.on('data', (d) => chunks.push(d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`screenshot failed (${code})`))));
    });
    return out.toString('base64');
  }

  click(x: number, y: number, button: 'left' | 'middle' | 'right' = 'left', clicks = 1) {
    const b = { left: '1', middle: '2', right: '3' }[button];
    return this.xdo(['mousemove', '--sync', String(Math.round(x)), String(Math.round(y)), 'click', '--repeat', String(clicks), '--delay', '80', b]);
  }

  drag(from: [number, number], to: [number, number]) {
    return this.xdo(['mousemove', '--sync', ...from.map(String), 'mousedown', '1', 'mousemove', '--sync', ...to.map(String), 'mouseup', '1']);
  }

  type(text: string) {
    return this.xdo(['type', '--delay', '12', '--', text]);
  }

  key(keys: string) {
    return this.xdo(['key', '--', ...keys.split(/\s+/).filter(Boolean)]);
  }

  scroll(x: number, y: number, direction: 'up' | 'down' | 'left' | 'right', amount = 3) {
    const b = { up: '4', down: '5', left: '6', right: '7' }[direction];
    return this.xdo(['mousemove', '--sync', String(Math.round(x)), String(Math.round(y)), 'click', '--repeat', String(Math.max(1, Math.min(amount, 30))), b]);
  }

  async windows(): Promise<string[]> {
    const ids = (await this.xdo(['search', '--onlyvisible', '--name', '.']).catch(() => '')).split('\n').filter(Boolean);
    const names = await Promise.all(ids.slice(0, 40).map((id) => this.xdo(['getwindowname', id]).catch(() => '')));
    return names.filter(Boolean);
  }

  get display() {
    return DISPLAY;
  }
}

export const desktop = new DesktopManager();
