import path from 'node:path';

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Resolve a user-supplied relative path inside `root`, rejecting traversal
 * (`../../etc/passwd`) and absolute paths that escape the project.
 */
export function safeJoin(root: string, rel: string | undefined): string {
  const cleaned = (rel ?? '').replace(/^\/+/, '');
  const full = path.resolve(root, cleaned);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    throw new HttpError(400, 'Path escapes the project directory');
  }
  return full;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'project'
  );
}
