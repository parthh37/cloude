import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry } from '../../shared/protocol.js';
import { HttpError, safeJoin } from './util/paths.js';

const MAX_READ_BYTES = 2 * 1024 * 1024;
const HIDDEN_BY_DEFAULT = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', '.next', 'dist', 'build', 'target', '.turbo', '.cache']);

export async function listDir(root: string, rel: string, showHidden = false): Promise<FileEntry[]> {
  const dir = safeJoin(root, rel);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    throw new HttpError(404, 'Directory not found');
  }
  const out: FileEntry[] = [];
  for (const e of entries) {
    if (!showHidden && HIDDEN_BY_DEFAULT.has(e.name)) continue;
    const full = path.join(dir, e.name);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue; // broken symlink
    }
    out.push({
      name: e.name,
      path: path.relative(root, full),
      type: e.isSymbolicLink() ? (stat.isDirectory() ? 'dir' : 'symlink') : stat.isDirectory() ? 'dir' : 'file',
      size: stat.size,
      mtime: stat.mtimeMs,
    });
  }
  return out.sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
}

function looksBinary(buf: Buffer) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function readFile(root: string, rel: string): Promise<{ path: string; content: string | null; binary: boolean; size: number; mtime: number }> {
  const file = safeJoin(root, rel);
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(file);
  } catch {
    throw new HttpError(404, 'File not found');
  }
  if (stat.isDirectory()) throw new HttpError(400, 'Path is a directory');
  if (stat.size > MAX_READ_BYTES) return { path: rel, content: null, binary: true, size: stat.size, mtime: stat.mtimeMs };
  const buf = await fsp.readFile(file);
  const binary = looksBinary(buf);
  return { path: rel, content: binary ? null : buf.toString('utf8'), binary, size: stat.size, mtime: stat.mtimeMs };
}

export async function writeFile(root: string, rel: string, content: string, expectedMtime?: number) {
  const file = safeJoin(root, rel);
  if (expectedMtime !== undefined && fs.existsSync(file)) {
    const stat = await fsp.stat(file);
    // Optimistic concurrency: Claude may have edited the file since the editor loaded it.
    if (Math.abs(stat.mtimeMs - expectedMtime) > 1) throw new HttpError(409, 'File changed on disk since you opened it');
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
  const stat = await fsp.stat(file);
  return { mtime: stat.mtimeMs, size: stat.size };
}

export async function makeDir(root: string, rel: string) {
  await fsp.mkdir(safeJoin(root, rel), { recursive: true });
}

export async function renamePath(root: string, from: string, to: string) {
  const src = safeJoin(root, from);
  const dst = safeJoin(root, to);
  if (fs.existsSync(dst)) throw new HttpError(409, 'Destination already exists');
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rename(src, dst);
}

export async function deletePath(root: string, rel: string) {
  const target = safeJoin(root, rel);
  if (path.resolve(target) === path.resolve(root)) throw new HttpError(400, 'Refusing to delete the project root');
  await fsp.rm(target, { recursive: true, force: true });
}

export async function saveUpload(root: string, relDir: string, filename: string, stream: NodeJS.ReadableStream) {
  const safeName = path.basename(filename).replace(/[\0/\\]/g, '_');
  const dest = safeJoin(root, path.join(relDir || '.', safeName));
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    stream.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    stream.on('error', reject);
  });
  return path.relative(root, dest);
}

/** Flat, gitignore-agnostic file search for the quick-open palette. */
export async function searchFiles(root: string, queryText: string, limit = 50): Promise<string[]> {
  const q = queryText.toLowerCase();
  const results: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (results.length >= limit || depth > 12) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= limit) return;
      if (HIDDEN_BY_DEFAULT.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (path.relative(root, full).toLowerCase().includes(q)) results.push(path.relative(root, full));
    }
  };
  await walk(root, 0);
  return results;
}
