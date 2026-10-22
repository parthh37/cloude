import path from 'node:path';
import type { Route } from '../../../shared/protocol.js';
import { config, originFor } from '../config.js';
import { newId } from '../crypto.js';
import { db, now } from '../db.js';
import { hub } from '../hub.js';
import { HttpError } from '../util/paths.js';

interface RouteRow {
  id: string;
  label: string;
  hostname: string | null;
  target_type: 'port' | 'static';
  port: number | null;
  static_dir: string | null;
  is_public: number;
  project_id: string | null;
  created_at: number;
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** URL a browser uses to reach a raw port through the authenticated preview proxy. */
export function previewUrlForPort(port: number): string {
  if (config.previewDomain) return `${originFor(`p-${port}.${config.previewDomain}`)}/`;
  return `${config.publicUrl}/preview/${port}/`;
}

export function urlForRoute(r: { label: string; hostname: string | null }): string {
  if (r.hostname) return `${config.secure ? 'https' : 'http'}://${r.hostname}/`; // custom domains sit behind the TLS proxy
  if (config.previewDomain) return `${originFor(`${r.label}.${config.previewDomain}`)}/`;
  return `${config.publicUrl}/apps/${r.label}/`;
}

const toRoute = (r: RouteRow): Route => ({
  id: r.id,
  label: r.label,
  hostname: r.hostname,
  targetType: r.target_type,
  port: r.port,
  staticDir: r.static_dir,
  isPublic: !!r.is_public,
  projectId: r.project_id,
  createdAt: r.created_at,
  url: urlForRoute(r),
});

export const routes = {
  list(): Route[] {
    return (db.prepare('SELECT * FROM routes ORDER BY created_at DESC').all() as unknown as RouteRow[]).map(toRoute);
  },
  byLabel(label: string): Route | null {
    const r = db.prepare('SELECT * FROM routes WHERE label = ?').get(label) as unknown as RouteRow | undefined;
    return r ? toRoute(r) : null;
  },
  byHostname(hostname: string): Route | null {
    const r = db.prepare('SELECT * FROM routes WHERE hostname = ?').get(hostname.toLowerCase()) as unknown as RouteRow | undefined;
    return r ? toRoute(r) : null;
  },
  get(id: string): Route | null {
    const r = db.prepare('SELECT * FROM routes WHERE id = ?').get(id) as unknown as RouteRow | undefined;
    return r ? toRoute(r) : null;
  },

  /** Create or replace the route with this label. */
  upsert(input: {
    label: string;
    hostname?: string | null;
    targetType: 'port' | 'static';
    port?: number | null;
    staticDir?: string | null;
    isPublic: boolean;
    projectId?: string | null;
    projectRoot?: string;
  }): Route {
    const label = input.label.toLowerCase();
    if (!LABEL_RE.test(label)) throw new HttpError(400, 'Name must be a valid subdomain label (a-z, 0-9, -)');
    if (/^p-\d+$/.test(label)) throw new HttpError(400, '"p-<port>" names are reserved for private previews');
    if (input.targetType === 'port' && (!input.port || config.reservedPorts.has(input.port))) {
      throw new HttpError(400, 'A valid, non-reserved port is required');
    }
    let staticDir: string | null = null;
    if (input.targetType === 'static') {
      if (!input.staticDir) throw new HttpError(400, 'staticDir is required');
      staticDir = path.resolve(input.projectRoot ?? '/', input.staticDir);
      const within = (dir: string, root: string) => dir === root || dir.startsWith(root + path.sep);
      // A project's published folder must stay inside the project...
      if (input.projectRoot && !within(staticDir, path.resolve(input.projectRoot))) {
        throw new HttpError(400, 'The folder to publish must be inside the project');
      }
      // ...and Cloude's own state (database, secret key) is never servable.
      if (within(staticDir, config.dataDir) && !within(staticDir, config.workspacesDir)) {
        throw new HttpError(400, "Cloude's data directory can't be published");
      }
    }
    const hostname = input.hostname?.trim().toLowerCase() || null;
    const existing = this.byLabel(label);
    if (existing) {
      db.prepare(
        'UPDATE routes SET hostname = ?, target_type = ?, port = ?, static_dir = ?, is_public = ?, project_id = ? WHERE id = ?',
      ).run(hostname, input.targetType, input.port ?? null, staticDir, input.isPublic ? 1 : 0, input.projectId ?? null, existing.id);
    } else {
      db.prepare(
        'INSERT INTO routes (id, label, hostname, target_type, port, static_dir, is_public, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(newId(), label, hostname, input.targetType, input.port ?? null, staticDir, input.isPublic ? 1 : 0, input.projectId ?? null, now());
    }
    this.broadcast();
    return this.byLabel(label)!;
  },

  setPublic(id: string, isPublic: boolean): Route {
    db.prepare('UPDATE routes SET is_public = ? WHERE id = ?').run(isPublic ? 1 : 0, id);
    this.broadcast();
    const r = this.get(id);
    if (!r) throw new HttpError(404, 'Route not found');
    return r;
  },

  delete(id: string) {
    db.prepare('DELETE FROM routes WHERE id = ?').run(id);
    this.broadcast();
  },

  deleteByLabel(label: string) {
    db.prepare('DELETE FROM routes WHERE label = ?').run(label.toLowerCase());
    this.broadcast();
  },

  broadcast() {
    hub.broadcast({ t: 'routes', routes: this.list() });
  },
};
