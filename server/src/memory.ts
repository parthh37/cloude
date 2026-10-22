import type { Memory, MemoryType } from '../../shared/protocol.js';
import { newId } from './crypto.js';
import { db, now } from './db.js';
import { ensureSchema } from './schema.js';
import { HttpError, slugify } from './util/paths.js';

/**
 * Long-term memory shared by every session of a project (and optionally by all
 * projects). Agents save facts with the memory tools; new sessions get a
 * compact *index* (name + one-line description) in their system prompt and
 * pull full entries on demand — so memory costs a few hundred tokens per
 * session instead of the whole store.
 */

ensureSchema(
  'memory-v1',
  `
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'project',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (project_id, name)
  );
  `,
);

export const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];
const INDEX_MAX_ENTRIES = 80;
const INDEX_MAX_CHARS = 6000;

interface MemoryRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  content: string;
  type: MemoryType;
  created_at: number;
  updated_at: number;
}

const toMemory = (r: MemoryRow): Memory => ({
  id: r.id,
  projectId: r.project_id || null,
  name: r.name,
  description: r.description,
  content: r.content,
  type: r.type,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

export const memory = {
  /** Project memories first, then global ones. `projectId` null = only global. */
  list(projectId: string | null): Memory[] {
    const rows = db
      .prepare("SELECT * FROM memories WHERE project_id = ? OR project_id = '' ORDER BY (project_id = '') ASC, updated_at DESC")
      .all(projectId ?? '') as unknown as MemoryRow[];
    return rows.map(toMemory);
  },

  get(projectId: string | null, nameOrId: string): Memory | null {
    const r = db
      .prepare("SELECT * FROM memories WHERE (id = ? OR name = ?) AND (project_id = ? OR project_id = '') ORDER BY (project_id = '') ASC LIMIT 1")
      .get(nameOrId, slugify(nameOrId), projectId ?? '') as unknown as MemoryRow | undefined;
    return r ? toMemory(r) : null;
  },

  /** Create or update by name (names are slugs, unique per scope). */
  save(input: { projectId: string | null; name: string; description: string; content: string; type?: MemoryType }): Memory {
    const name = slugify(input.name);
    if (!input.description?.trim()) throw new HttpError(400, 'A memory needs a one-line description');
    if (!input.content?.trim()) throw new HttpError(400, 'A memory needs content');
    const type = input.type && MEMORY_TYPES.includes(input.type) ? input.type : 'project';
    const t = now();
    db.prepare(
      `INSERT INTO memories (id, project_id, name, description, content, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, name) DO UPDATE SET description = excluded.description, content = excluded.content, type = excluded.type, updated_at = excluded.updated_at`,
    ).run(newId(), input.projectId ?? '', name, input.description.trim().slice(0, 300), input.content.trim().slice(0, 20_000), type, t, t);
    return this.get(input.projectId, name)!;
  },

  update(id: string, patch: Partial<Pick<Memory, 'name' | 'description' | 'content' | 'type'>>): Memory {
    const r = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as MemoryRow | undefined;
    if (!r) throw new HttpError(404, 'Memory not found');
    const next = { ...toMemory(r), ...patch };
    db.prepare('UPDATE memories SET name = ?, description = ?, content = ?, type = ?, updated_at = ? WHERE id = ?').run(
      slugify(next.name),
      next.description.trim().slice(0, 300),
      next.content.trim().slice(0, 20_000),
      MEMORY_TYPES.includes(next.type) ? next.type : 'project',
      now(),
      id,
    );
    return toMemory(db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as MemoryRow);
  },

  remove(id: string) {
    db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  },

  /** Keyword search, weighted toward names and descriptions. */
  search(projectId: string | null, query: string, limit = 8): Memory[] {
    const q = tokens(query);
    if (!q.length) return this.list(projectId).slice(0, limit);
    return this.list(projectId)
      .map((m) => {
        const name = tokens(m.name);
        const desc = tokens(m.description);
        const body = tokens(m.content);
        let score = 0;
        for (const t of q) {
          if (name.some((x) => x.startsWith(t))) score += 3;
          if (desc.some((x) => x.startsWith(t))) score += 2;
          score += Math.min(3, body.filter((x) => x.startsWith(t)).length) * 0.5;
        }
        return { m, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt)
      .slice(0, limit)
      .map((x) => x.m);
  },

  /** The compact index injected into new sessions' system prompts. */
  index(projectId: string): string {
    const lines: string[] = [];
    let size = 0;
    for (const m of this.list(projectId).slice(0, INDEX_MAX_ENTRIES)) {
      const line = `- ${m.name} [${m.type}${m.projectId ? '' : ', global'}] — ${m.description}`;
      if (size + line.length > INDEX_MAX_CHARS) break;
      lines.push(line);
      size += line.length + 1;
    }
    return lines.join('\n');
  },
};
