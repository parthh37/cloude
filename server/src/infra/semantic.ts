import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SemanticHit } from '../../../shared/protocol.js';
import { db } from '../db.js';
import { projects } from '../projects.js';
import { run } from '../util/exec.js';
import { cosine, embeddings } from './embeddings.js';

/**
 * Semantic code search over a project: files are chunked, embedded with the
 * auto-configured model, and stored in SQLite. Re-indexing is incremental by
 * content hash, so a search after a small edit only embeds what changed.
 */

const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|fs|c|h|cc|cpp|hpp|m|mm|swift|rb|php|scala|sql|sh|bash|zsh|ps1|lua|dart|ex|exs|erl|clj|vue|svelte|astro|html|css|scss|less|md|mdx|txt|rst|toml|ya?ml|json|graphql|gql|proto|tf|hcl|dockerfile|gradle|cmake|ini|env\.example)$/i;
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|target|\.next|\.nuxt|\.venv|venv|__pycache__|vendor|coverage|\.cloude|bin|obj|\.turbo|\.cache)(\/|$)/;
const MAX_FILE = 256 * 1024;
const MAX_FILES = 4000;
const MAX_CHUNKS = 25_000;
const CHUNK_LINES = 60;
const OVERLAP = 12;

interface Chunk {
  startLine: number;
  endLine: number;
  text: string;
}

function chunk(content: string, file: string): Chunk[] {
  const lines = content.split('\n');
  const out: Chunk[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - OVERLAP) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const body = lines.slice(start, end).join('\n').trim();
    // The path is part of the text: "auth/login.ts" is a strong signal on its own.
    if (body) out.push({ startLine: start + 1, endLine: end, text: `${file}\n${body}`.slice(0, 4000) });
    if (end === lines.length) break;
  }
  return out;
}

async function listFiles(root: string): Promise<string[]> {
  const git = await run('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, timeoutMs: 20_000 });
  let files: string[];
  if (git.code === 0) {
    files = git.stdout.split('\n').filter(Boolean);
  } else {
    files = [];
    const walk = (dir: string, rel: string) => {
      if (files.length > MAX_FILES * 2) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIR.test(r)) walk(path.join(dir, e.name), r);
        } else if (e.isFile()) files.push(r);
      }
    };
    walk(root, '');
  }
  return files.filter((f) => !SKIP_DIR.test(f) && (TEXT_EXT.test(f) || /(^|\/)(Dockerfile|Makefile|README)$/.test(f))).slice(0, MAX_FILES);
}

const toBlob = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

class SemanticIndex {
  private jobs = new Map<string, Promise<{ files: number; embedded: number }>>();
  private freshAt = new Map<string, number>();
  private cache = new Map<string, { model: string; rows: { path: string; start: number; end: number; text: string; v: Float32Array }[] }>();

  /** Bring the project's index up to date. Concurrent callers share one job. */
  index(projectId: string): Promise<{ files: number; embedded: number }> {
    const running = this.jobs.get(projectId);
    if (running) return running;
    const job = this.build(projectId).finally(() => this.jobs.delete(projectId));
    this.jobs.set(projectId, job);
    return job;
  }

  private async build(projectId: string) {
    const project = projects.require(projectId);
    await embeddings.embed(['warmup'], 'document'); // ensures a model is configured before we start
    const model = embeddings.modelKey!;
    const files = await listFiles(project.path);
    const known = new Map(
      (db.prepare('SELECT DISTINCT path, file_hash FROM infra_chunks WHERE project_id = ? AND model = ?').all(projectId, model) as { path: string; file_hash: string }[]).map((r) => [
        r.path,
        r.file_hash,
      ]),
    );
    let embedded = 0;
    let total = (db.prepare('SELECT COUNT(*) AS n FROM infra_chunks WHERE project_id = ? AND model = ?').get(projectId, model) as { n: number }).n;
    const present = new Set<string>();
    for (const file of files) {
      const full = path.join(project.path, file);
      let content: string;
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || st.size > MAX_FILE) continue;
        content = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\u0000')) continue; // binary
      present.add(file);
      const hash = crypto.createHash('sha1').update(content).digest('hex');
      if (known.get(file) === hash) continue;
      const chunks = chunk(content, file);
      if (total + chunks.length > MAX_CHUNKS) break;
      const vectors = await embeddings.embed(
        chunks.map((c) => c.text),
        'document',
      );
      const del = db.prepare('DELETE FROM infra_chunks WHERE project_id = ? AND model = ? AND path = ?');
      const ins = db.prepare('INSERT OR REPLACE INTO infra_chunks (project_id, path, start_line, end_line, file_hash, model, text, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      db.exec('BEGIN');
      try {
        total -= (db.prepare('SELECT COUNT(*) AS n FROM infra_chunks WHERE project_id = ? AND model = ? AND path = ?').get(projectId, model, file) as { n: number }).n;
        del.run(projectId, model, file);
        chunks.forEach((c, i) => ins.run(projectId, file, c.startLine, c.endLine, hash, model, c.text, toBlob(vectors[i]!)));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      total += chunks.length;
      embedded += chunks.length;
    }
    // Forget files that were deleted, and vectors from models no longer in use.
    for (const p of known.keys()) if (!present.has(p)) db.prepare('DELETE FROM infra_chunks WHERE project_id = ? AND model = ? AND path = ?').run(projectId, model, p);
    db.prepare('DELETE FROM infra_chunks WHERE project_id = ? AND model != ?').run(projectId, model);
    this.cache.delete(projectId);
    this.freshAt.set(projectId, Date.now());
    return { files: present.size, embedded };
  }

  async search(projectId: string, query: string, k = 8, under?: string): Promise<SemanticHit[]> {
    if (!query.trim()) return [];
    // Incremental refresh at most every 30s keeps search fast while staying current.
    if (Date.now() - (this.freshAt.get(projectId) ?? 0) > 30_000) await this.index(projectId);
    const model = embeddings.modelKey!;
    let cached = this.cache.get(projectId);
    if (!cached || cached.model !== model) {
      const rows = db.prepare('SELECT path, start_line, end_line, text, vector FROM infra_chunks WHERE project_id = ? AND model = ?').all(projectId, model) as {
        path: string;
        start_line: number;
        end_line: number;
        text: string;
        vector: Uint8Array;
      }[];
      cached = { model, rows: rows.map((r) => ({ path: r.path, start: r.start_line, end: r.end_line, text: r.text, v: fromBlob(r.vector) })) };
      this.cache.set(projectId, cached);
    }
    const [q] = await embeddings.embed([query], 'query');
    const prefix = under?.replace(/^\.?\/+/, '');
    return cached.rows
      .filter((r) => !prefix || r.path.startsWith(prefix))
      .map((r) => ({ r, score: cosine(q!, r.v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(k, 1), 30))
      .map(({ r, score }) => ({
        path: r.path,
        startLine: r.start,
        endLine: r.end,
        score: Math.round(score * 1000) / 1000,
        preview: r.text.split('\n').slice(1, 9).join('\n'),
      }));
  }

  forget(projectId: string) {
    db.prepare('DELETE FROM infra_chunks WHERE project_id = ?').run(projectId);
    this.cache.delete(projectId);
    this.freshAt.delete(projectId);
  }
}

export const semantic = new SemanticIndex();
