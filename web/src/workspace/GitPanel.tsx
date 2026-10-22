import clsx from 'clsx';
import { ArrowDownToLine, ArrowUpFromLine, GitBranch, GitCommitHorizontal, Minus, Plus, RefreshCw, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { GitStatus, Project } from '../../../shared/protocol';
import { Button, Empty, IconButton, Select, Textarea } from '../components/ui';
import { api, ApiError, q } from '../lib/api';
import { timeAgo } from '../lib/format';
import { toast } from '../lib/store';
import { PatchView } from './DiffView';

interface Commit {
  hash: string;
  short: string;
  author: string;
  date: number;
  subject: string;
}

const err = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

function code(f: GitStatus['files'][number]) {
  if (f.index === '?') return { label: 'U', tone: 'text-ok', title: 'Untracked' };
  const c = f.index !== '.' ? f.index : f.worktree;
  const map: Record<string, [string, string]> = {
    M: ['text-break-ink', 'Modified'],
    A: ['text-ok', 'Added'],
    D: ['text-bad', 'Deleted'],
    R: ['text-sky', 'Renamed'],
    U: ['text-bad', 'Conflict'],
  };
  const [tone, title] = map[c] ?? ['text-ink-3', c];
  return { label: c, tone, title };
}

export function GitPanel({ project, visible }: { project: Project; visible: boolean }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
  const [diff, setDiff] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [branches, setBranches] = useState<{ name: string; current: boolean }[]>([]);
  const base = `/api/projects/${project.id}/git`;

  const load = useCallback(async () => {
    try {
      const [s, l, b] = await Promise.all([
        api.get<GitStatus>(`${base}/status`),
        api.get<{ commits: Commit[] }>(`${base}/log`),
        api.get<{ branches: { name: string; current: boolean }[] }>(`${base}/branches`),
      ]);
      setStatus(s);
      setCommits(l.commits);
      setBranches(b.branches);
    } catch (e) {
      toast('error', 'Git status failed', err(e));
    }
  }, [base]);

  useEffect(() => {
    if (!visible) return;
    void load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [visible, load]);

  useEffect(() => {
    if (!selected) return setDiff('');
    api
      .get<{ diff: string }>(`${base}/diff${q({ path: selected.path, staged: selected.staged })}`)
      .then((r) => setDiff(r.diff))
      .catch(() => setDiff(''));
  }, [selected, base, status]);

  async function run(label: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(label);
    try {
      const r: any = await fn();
      if (success) toast('success', success, typeof r?.output === 'string' ? r.output.split('\n').slice(-2).join(' ') : undefined);
      await load();
    } catch (e) {
      toast('error', `${label} failed`, err(e));
    } finally {
      setBusy(null);
    }
  }

  if (!status) return null;
  if (!status.isRepo)
    return (
      <Empty icon={<GitBranch className="size-8" />} title="Not a Git repository">
        Ask Claude to run <code className="font-mono">git init</code>, or open a terminal.
      </Empty>
    );

  const staged = status.files.filter((f) => f.index !== '.' && f.index !== '?');
  const unstaged = status.files.filter((f) => f.worktree !== '.' || f.index === '?');

  const FileRow = ({ f, isStaged }: { f: GitStatus['files'][number]; isStaged: boolean }) => {
    const c = code(f);
    const active = selected?.path === f.path && selected.staged === isStaged;
    return (
      <li className={clsx('group flex items-center gap-2 rounded-md px-2 py-1', active ? 'bg-surface-2' : 'hover:bg-surface-2')}>
        <span className={clsx('w-3 font-mono text-xs font-semibold', c.tone)} title={c.title}>
          {c.label}
        </span>
        <button onClick={() => setSelected({ path: f.path, staged: isStaged })} className="min-w-0 flex-1 truncate text-left font-mono text-[12.5px]">
          {f.path}
        </button>
        {isStaged ? (
          <IconButton label="Unstage" className="size-6" onClick={() => run('Unstage', () => api.post(`${base}/unstage`, { paths: [f.path] }))}>
            <Minus className="size-3.5" />
          </IconButton>
        ) : (
          <>
            <IconButton
              label="Discard changes"
              className="size-6"
              onClick={() => confirm(`Discard changes to ${f.path}?`) && run('Discard', () => api.post(`${base}/discard`, { paths: [f.path] }))}
            >
              <Undo2 className="size-3.5" />
            </IconButton>
            <IconButton label="Stage" className="size-6" onClick={() => run('Stage', () => api.post(`${base}/stage`, { paths: [f.path] }))}>
              <Plus className="size-3.5" />
            </IconButton>
          </>
        )}
      </li>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5">
        <GitBranch className="ml-1 size-4 text-ink-3" />
        <Select
          value={status.branch ?? ''}
          className="h-8 max-w-44 text-[13px]"
          aria-label="Branch"
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__new') {
              const name = prompt('New branch name');
              if (name) void run('Create branch', () => api.post(`${base}/checkout`, { branch: name, create: true }));
            } else void run('Checkout', () => api.post(`${base}/checkout`, { branch: v }));
          }}
        >
          {branches
            .filter((b) => !b.name.startsWith('origin/'))
            .map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          <option value="__new">+ New branch…</option>
        </Select>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="text-xs text-ink-3">
            {status.ahead > 0 && `↑${status.ahead}`} {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" icon={<ArrowDownToLine className="size-3.5" />} busy={busy === 'Pull'} onClick={() => run('Pull', () => api.post(`${base}/pull`), 'Pulled')}>
            Pull
          </Button>
          <Button size="sm" variant="ghost" icon={<ArrowUpFromLine className="size-3.5" />} busy={busy === 'Push'} onClick={() => run('Push', () => api.post(`${base}/push`), 'Pushed')}>
            Push
          </Button>
          <IconButton label="Refresh" onClick={load}>
            <RefreshCw className="size-4" />
          </IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3 p-2">
          <div>
            <Textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message" className="text-[13px]" />
            <Button
              className="mt-1.5 w-full"
              variant="primary"
              size="sm"
              icon={<GitCommitHorizontal className="size-4" />}
              disabled={!message.trim() || status.files.length === 0}
              busy={busy === 'Commit'}
              onClick={() =>
                run(
                  'Commit',
                  async () => {
                    await api.post(`${base}/commit`, { message, all: staged.length === 0 });
                    setMessage('');
                  },
                  'Committed',
                )
              }
            >
              {staged.length ? `Commit ${staged.length} staged` : `Commit all ${status.files.length} changes`}
            </Button>
          </div>

          {staged.length > 0 && (
            <section>
              <h4 className="px-2 pb-1 text-xs font-semibold tracking-wide text-ink-3 uppercase">Staged</h4>
              <ul>{staged.map((f) => <FileRow key={'s' + f.path} f={f} isStaged />)}</ul>
            </section>
          )}
          <section>
            <h4 className="flex items-center px-2 pb-1 text-xs font-semibold tracking-wide text-ink-3 uppercase">
              Changes
              {unstaged.length > 0 && (
                <button className="ml-auto text-[11px] font-medium normal-case text-sky" onClick={() => run('Stage', () => api.post(`${base}/stage`, { paths: [] }))}>
                  Stage all
                </button>
              )}
            </h4>
            {unstaged.length === 0 ? <p className="px-2 text-sm text-ink-3">Working tree clean.</p> : <ul>{unstaged.map((f) => <FileRow key={'u' + f.path} f={f} isStaged={false} />)}</ul>}
          </section>

          {selected && (
            <section>
              <h4 className="truncate px-2 pb-1 font-mono text-xs text-ink-2">{selected.path}</h4>
              <PatchView patch={diff} />
            </section>
          )}

          <section>
            <h4 className="px-2 pb-1 text-xs font-semibold tracking-wide text-ink-3 uppercase">History</h4>
            <ul>
              {commits.slice(0, 30).map((c) => (
                <li key={c.hash} className="flex items-baseline gap-2 px-2 py-1 text-[13px]">
                  <span className="font-mono text-xs text-ink-3">{c.short}</span>
                  <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                  <span className="shrink-0 text-xs text-ink-3">{timeAgo(c.date)}</span>
                </li>
              ))}
              {commits.length === 0 && <li className="px-2 text-sm text-ink-3">No commits yet.</li>}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
