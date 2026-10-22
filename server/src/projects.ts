import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../../shared/protocol.js';
import { config } from './config.js';
import { newId } from './crypto.js';
import { db, now } from './db.js';
import { buildEnv } from './settings.js';
import { run } from './util/exec.js';
import { HttpError, slugify } from './util/paths.js';

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  path: string;
  git_url: string | null;
  created_at: number;
  updated_at: number;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  path: r.path,
  gitUrl: r.git_url,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function uniqueSlug(base: string): string {
  let slug = base;
  for (let i = 2; db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug); i++) slug = `${base}-${i}`;
  return slug;
}

export const projects = {
  list(): Project[] {
    return (db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as unknown as ProjectRow[]).map(toProject);
  },

  get(id: string): Project | null {
    const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined;
    return r ? toProject(r) : null;
  },

  require(id: string): Project {
    const p = this.get(id);
    if (!p) throw new HttpError(404, 'Project not found');
    return p;
  },

  /**
   * Create a project from one of three sources:
   *  - gitUrl: clone into the workspaces dir
   *  - existingPath: adopt a directory already on the server
   *  - neither: empty directory with `git init`
   */
  async create(input: { name: string; gitUrl?: string; existingPath?: string; branch?: string }): Promise<Project> {
    const name = input.name?.trim() || (input.gitUrl ? path.basename(input.gitUrl).replace(/\.git$/, '') : '');
    if (!name) throw new HttpError(400, 'Project name is required');
    const slug = uniqueSlug(slugify(name));

    let dir: string;
    if (input.existingPath) {
      dir = path.resolve(input.existingPath);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new HttpError(400, `Directory not found: ${dir}`);
    } else {
      dir = path.join(config.workspacesDir, slug);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) throw new HttpError(409, `Directory already exists: ${dir}`);
      if (input.gitUrl) {
        const args = ['clone', '--recurse-submodules'];
        if (input.branch) args.push('--branch', input.branch);
        args.push(input.gitUrl, dir);
        const r = await run('git', args, { env: buildEnv(null), timeoutMs: 10 * 60_000 });
        if (r.code !== 0) {
          fs.rmSync(dir, { recursive: true, force: true });
          throw new HttpError(400, `git clone failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
        }
      } else {
        fs.mkdirSync(dir, { recursive: true });
        await run('git', ['init', '-b', 'main'], { cwd: dir });
      }
    }

    const id = newId();
    const t = now();
    db.prepare('INSERT INTO projects (id, name, slug, path, git_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      name,
      slug,
      dir,
      input.gitUrl ?? null,
      t,
      t,
    );
    return this.require(id);
  },

  update(id: string, patch: { name?: string }): Project {
    this.require(id);
    if (patch.name?.trim()) db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(patch.name.trim(), now(), id);
    return this.require(id);
  },

  touch(id: string) {
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), id);
  },

  /** Removes the project record; files are only deleted when they live in Cloude's workspaces dir. */
  delete(id: string, deleteFiles: boolean) {
    const p = this.require(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    if (deleteFiles && p.path.startsWith(config.workspacesDir + path.sep)) {
      fs.rmSync(p.path, { recursive: true, force: true });
    }
  },
};
