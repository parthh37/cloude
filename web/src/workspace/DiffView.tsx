import clsx from 'clsx';
import { diffLines } from 'diff';
import { useMemo } from 'react';

/** Side-less unified diff of two strings (used for Edit tool calls). */
export function StringDiff({ before, after, maxLines = 400 }: { before: string; after: string; maxLines?: number }) {
  const rows = useMemo(() => {
    const out: { sign: ' ' | '+' | '-'; text: string }[] = [];
    for (const part of diffLines(before, after)) {
      const lines = part.value.replace(/\n$/, '').split('\n');
      for (const l of lines) out.push({ sign: part.added ? '+' : part.removed ? '-' : ' ', text: l });
    }
    return out;
  }, [before, after]);
  return <DiffRows rows={rows.slice(0, maxLines)} truncated={rows.length > maxLines} />;
}

/** Render `git diff` output. */
export function PatchView({ patch }: { patch: string }) {
  const rows = useMemo(
    () =>
      patch
        .split('\n')
        .filter((l) => !l.startsWith('diff --git') && !l.startsWith('index ') && !l.startsWith('--- ') && !l.startsWith('+++ '))
        .map((l) => ({
          sign: (l.startsWith('+') ? '+' : l.startsWith('-') ? '-' : l.startsWith('@@') ? '@' : ' ') as ' ' | '+' | '-' | '@',
          text: l.startsWith('@@') ? l : l.slice(1),
        })),
    [patch],
  );
  if (!patch.trim()) return <p className="p-3 text-sm text-ink-3">No changes.</p>;
  return <DiffRows rows={rows.slice(0, 3000)} truncated={rows.length > 3000} />;
}

function DiffRows({ rows, truncated }: { rows: { sign: ' ' | '+' | '-' | '@'; text: string }[]; truncated?: boolean }) {
  return (
    <div className="porthole overflow-x-auto py-1.5">
      <pre className="min-w-max">
        {rows.map((r, i) => (
          <div
            key={i}
            className={clsx(
              'px-3',
              r.sign === '+' && 'bg-[#1f3d2c] text-[#bfe8cf]',
              r.sign === '-' && 'bg-[#432325] text-[#f2c4c4]',
              r.sign === '@' && 'text-[#7fa9db]',
            )}
          >
            <span className="mr-3 inline-block w-3 text-port-dim select-none">{r.sign === '@' ? '' : r.sign}</span>
            {r.text || ' '}
          </div>
        ))}
        {truncated && <div className="px-3 text-port-dim">… diff truncated</div>}
      </pre>
    </div>
  );
}
