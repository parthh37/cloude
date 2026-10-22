import fs from 'node:fs';
import path from 'node:path';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type { CompressionLevel, CompressionStats } from '../../../shared/protocol.js';
import { db } from '../db.js';
import { ensureSchema } from '../schema.js';

/**
 * Token compression for tool output.
 *
 * Runs as a PostToolUse hook on Bash: the result is replaced (`updatedToolOutput`)
 * before it reaches the model, so every later turn re-reads the smaller version.
 * Nothing is lost for good — whenever lines are dropped, the full output is
 * written to `.cloude/outputs/<tool_use_id>.log` and the marker says where.
 *
 * Stages (each one only ever removes redundancy):
 *   1. strip ANSI colours / cursor codes
 *   2. resolve carriage-return progress bars to their final state
 *   3. drop pure-noise lines (download progress, spinner frames, …)
 *   4. collapse runs of repeated (or, when aggressive, near-identical) lines
 *   5. over budget → keep head + tail + the "signal" lines from the middle
 */

ensureSchema(
  'compression-v1',
  `
  CREATE TABLE compression_stats (
    session_id TEXT PRIMARY KEY,
    calls INTEGER NOT NULL DEFAULT 0,
    original_chars INTEGER NOT NULL DEFAULT 0,
    compressed_chars INTEGER NOT NULL DEFAULT 0
  );
  `,
);

const BUDGET: Record<Exclude<CompressionLevel, 'off'>, { chars: number; head: number; tail: number; signal: number }> = {
  balanced: { chars: 16_000, head: 60, tail: 80, signal: 120 },
  aggressive: { chars: 6_000, head: 25, tail: 40, signal: 60 },
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;

/** Lines that carry no information once the command has finished. */
const NOISE: RegExp[] = [
  /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏|/\\-]\s*$/, // bare spinner frames
  /^\s*\[?[#=>.\s-]*\]?\s*\d{1,3}(\.\d+)?%\s*(\||$)/, // "[=====>   ] 42%"
  /^\s*(Downloading|Downloaded|Fetching|Receiving objects|Resolving deltas|Counting objects|Compressing objects|Unpacking objects)\b.*\d+%/i,
  /^[a-f0-9]{12}: (Pulling fs layer|Waiting|Verifying Checksum|Download complete|Downloading|Extracting|Pull complete|Already exists)/,
  /^npm (http|timing|sill|verb) /,
  /^\s*Requirement already satisfied: /,
  /^\s*Using cached /,
  /^#\d+ (sha256:|\[internal\] load|DONE \d|CACHED)/, // buildkit chatter
];

/** Extra lines dropped only in aggressive mode. */
const AGGRESSIVE_NOISE: RegExp[] = [
  /^npm (WARN|warn) deprecated /,
  /^\s*(Compiling|Checking|Fresh|Downloaded) [\w-]+ v\d/, // cargo per-crate lines
  /^\s*warning: unused /,
  /^\s*at .+ \(node:internal\//, // Node internals in stack traces
  /^\s*✓ /, // passing test lines (failures are kept)
];

/**
 * Decide whether a line from the middle of a long output must survive
 * truncation. Head and tail are always kept; this picks what else Claude
 * gets to see from the part that would otherwise be dropped.
 *
 * Trade-off: everything you return true for costs tokens on *every* long
 * command (installs, builds, test runs); everything you return false for is
 * only reachable by Claude re-reading the saved log file.
 */
export function isSignalLine(line: string): boolean {
  // TODO(you): decide what counts as signal in YOUR projects' output (5-10 lines).
  // Ideas: errors/failures/panics, "file:line:col" locations, test summaries,
  // exit codes, assertion diffs (lines starting with + / -), stack frames of your own code.
  return /\b(error|fail(ed|ure)?)\b/i.test(line);
}

export function stripAnsi(s: string) {
  return s.replace(ANSI_RE, '');
}

function resolveCarriageReturns(line: string) {
  const i = line.lastIndexOf('\r');
  return i >= 0 && i < line.length - 1 ? line.slice(i + 1) : line.replace(/\r$/, '');
}

function collapseRuns(lines: string[], fuzzy: boolean): string[] {
  const out: string[] = [];
  const keyOf = (l: string) => (fuzzy ? l.replace(/\d+/g, '#').trim() : l);
  for (let i = 0; i < lines.length; ) {
    const key = keyOf(lines[i]!);
    let j = i + 1;
    while (j < lines.length && keyOf(lines[j]!) === key) j++;
    const run = j - i;
    if (run === 1) out.push(lines[i]!);
    else if (!fuzzy || lines.slice(i, j).every((l) => l === lines[i])) out.push(`${lines[i]}   [×${run}]`);
    else if (run <= 3) out.push(...lines.slice(i, j));
    else out.push(lines[i]!, `   … ${run - 2} similar lines …`, lines[j - 1]!);
    i = j;
  }
  return out;
}

export interface Compressed {
  text: string;
  elided: number; // informative lines dropped (0 = only lossless clean-up happened)
}

export function compressText(raw: string, level: CompressionLevel, fullOutputPath?: () => string | null): Compressed {
  if (level === 'off' || !raw) return { text: raw, elided: 0 };
  const budget = BUDGET[level];

  let lines = stripAnsi(raw).split('\n').map(resolveCarriageReturns);
  lines = lines.filter((l) => !NOISE.some((re) => re.test(l)));
  // Aggressive filters drop real (if low-value) information, so they count as elided: the full log gets saved.
  let dropped = lines.length;
  if (level === 'aggressive') lines = lines.filter((l) => !AGGRESSIVE_NOISE.some((re) => re.test(l)));
  dropped -= lines.length;
  lines = collapseRuns(lines, level === 'aggressive');
  // Squeeze blank-line runs.
  lines = lines.filter((l, i) => l.trim() !== '' || (i > 0 && lines[i - 1]!.trim() !== ''));

  const total = lines.length + dropped;
  const markerFor = (elided: number) => {
    const where = fullOutputPath?.();
    return `[Cloude compressed this output: ${elided} of ${total} lines omitted${where ? `; full output saved at ${where} — Read or Grep it if you need the omitted part` : ''}]`;
  };
  let text = lines.join('\n');
  if (text.length <= budget.chars || lines.length <= budget.head + budget.tail) {
    return dropped ? { text: `${text}\n${markerFor(dropped)}`, elided: dropped } : { text, elided: 0 };
  }

  const head = lines.slice(0, budget.head);
  const tail = lines.slice(-budget.tail);
  const middle = lines.slice(budget.head, lines.length - budget.tail);
  const kept: string[] = [];
  let skipped = 0;
  let elided = dropped;
  for (const l of middle) {
    if (kept.length < budget.signal && isSignalLine(l)) {
      if (skipped) kept.push(`   … ${skipped} lines omitted …`);
      kept.push(l);
      skipped = 0;
    } else {
      skipped++;
      elided++;
    }
  }
  if (skipped) kept.push(`   … ${skipped} lines omitted …`);
  text = [...head, ...kept, ...tail, markerFor(elided)].join('\n');
  return { text, elided };
}

// ---- persistence of full outputs & stats ----------------------------------------

const OUTPUTS_DIR = '.cloude/outputs';
const KEEP_OUTPUTS = 60;

function saveFullOutput(cwd: string, toolUseId: string, content: string): string | null {
  try {
    const dir = path.join(cwd, OUTPUTS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n'); // never committed, in any repo
    const file = path.join(dir, `${toolUseId.replace(/[^\w-]/g, '')}.log`);
    fs.writeFileSync(file, content);
    const logs = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of logs.slice(KEEP_OUTPUTS)) fs.rmSync(path.join(dir, old.f), { force: true });
    return path.relative(cwd, file);
  } catch {
    return null;
  }
}

function recordStats(sessionId: string, original: number, compressed: number) {
  db.prepare(
    `INSERT INTO compression_stats (session_id, calls, original_chars, compressed_chars) VALUES (?, 1, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET calls = calls + 1, original_chars = original_chars + excluded.original_chars,
       compressed_chars = compressed_chars + excluded.compressed_chars`,
  ).run(sessionId, original, compressed);
}

export function compressionStats(sessionId?: string): CompressionStats {
  const r = (
    sessionId
      ? db.prepare('SELECT calls, original_chars AS o, compressed_chars AS c FROM compression_stats WHERE session_id = ?').get(sessionId)
      : db.prepare('SELECT SUM(calls) AS calls, SUM(original_chars) AS o, SUM(compressed_chars) AS c FROM compression_stats').get()
  ) as { calls: number | null; o: number | null; c: number | null } | undefined;
  return { calls: r?.calls ?? 0, originalChars: r?.o ?? 0, compressedChars: r?.c ?? 0 };
}

/** PostToolUse hook that compresses Bash results for the model. */
export function compressionHooks(ctx: { sessionId: string; cwd: string; level: () => CompressionLevel }): Partial<Record<'PostToolUse', HookCallbackMatcher[]>> {
  return {
    PostToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'PostToolUse') return {};
            const level = ctx.level();
            const resp = input.tool_response as { stdout?: unknown; stderr?: unknown; isImage?: boolean } | undefined;
            if (level === 'off' || !resp || resp.isImage || typeof resp.stdout !== 'string') return {};
            const stdout = resp.stdout;
            const stderr = typeof resp.stderr === 'string' ? resp.stderr : '';
            const before = stdout.length + stderr.length;
            if (before < 400) return {}; // not worth it

            let saved: string | null | undefined;
            const full = () => (saved !== undefined ? saved : (saved = saveFullOutput(ctx.cwd, input.tool_use_id, `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`)));
            const out = compressText(stdout, level, full);
            const err = compressText(stderr, level, full);
            const after = out.text.length + err.text.length;
            if (after >= before) return {};
            recordStats(ctx.sessionId, before, after);
            return {
              hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                updatedToolOutput: { ...resp, stdout: out.text, stderr: err.text },
              },
            };
          },
        ],
      },
    ],
  };
}
