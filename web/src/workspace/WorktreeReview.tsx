import { GitBranch, GitMerge, GitPullRequest, RefreshCw, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Project, Session, Worktree, WorktreeStatus } from '../../../shared/protocol';
import { Badge, Button, Dialog, Field, Input, Spinner, Toggle } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { toast } from '../lib/store';
import { PatchView } from './DiffView';

const err = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

/** Split a multi-file `git diff` into per-file patches so each gets a header. */
function splitPatch(patch: string): { path: string; patch: string }[] {
  return patch
    .split(/^(?=diff --git )/m)
    .filter((p) => p.startsWith('diff --git '))
    .map((p) => ({ path: /^diff --git a\/(.+?) b\//.exec(p)?.[1] ?? 'file', patch: p }));
}

/**
 * Review and land a worktree branch: see everything it changes against its base,
 * bring the base in (Sync), then merge / squash it back, or push it as a PR.
 */
export function WorktreeReview({
  project,
  worktree,
  session,
  open,
  onClose,
}: {
  project: Project;
  worktree: Worktree;
  session?: Session;
  open: boolean;
  onClose: () => void;
}) {
  const base = `/api/projects/${project.id}/worktrees/${worktree.id}`;
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [squash, setSquash] = useState(false);
  const [removeAfter, setRemoveAfter] = useState(true);
  const [message, setMessage] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [prUrl, setPrUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [st, d] = await Promise.all([api.get<WorktreeStatus>(base), api.get<{ diff: string }>(`${base}/diff`)]);
      setStatus(st);
      setDiff(d.diff);
    } catch (e) {
      toast('error', 'Could not load the worktree', err(e));
    }
  }, [base]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    setMessage(`${session?.title ?? worktree.id} (${worktree.branch})`);
    setCommitMessage(`WIP: ${session?.title ?? worktree.id}`);
  }, [worktree.id, worktree.branch, session?.title]);

  /** Run an action; `fn` returns false when the worktree is gone afterwards (nothing left to reload). */
  async function act(label: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(label);
    try {
      const keep = await fn();
      if (success) toast('success', success);
      if (keep !== false) await load();
    } catch (e) {
      toast('error', `${label} failed`, err(e));
    } finally {
      setBusy(null);
    }
  }

  async function askClaudeToResolve() {
    if (!session || !status) return;
    await act('Ask Claude', () =>
      api.post(`/api/sessions/${session.id}/messages`, {
        text:
          `I merged \`${worktree.baseBranch}\` into your branch and these files now have merge conflicts:\n` +
          status.conflicts.map((f) => `- ${f}`).join('\n') +
          '\n\nResolve the conflicts (keep both sides’ intent), run the tests and type checks, and commit the merge.',
      }),
    );
    onClose();
  }

  const merge = () =>
    act(
      'Merge',
      async () => {
        await api.post(`${base}/merge`, {
          squash,
          message: message.trim() || undefined,
          commitMessage: status && status.dirty > 0 ? commitMessage.trim() || 'WIP' : undefined,
          remove: removeAfter,
        });
        if (!removeAfter || sessionOwned) return true;
        onClose();
        return false;
      },
      `Merged into ${worktree.baseBranch}`,
    );

  const changed = status?.files ?? [];
  // A session's transcript is tied to its worktree directory, so session worktrees are kept (reset to the base) instead of removed.
  const sessionOwned = worktree.ownerType === 'session';
  return (
    <Dialog open={open} onClose={onClose} title="Review & land" wide>
      {!status ? (
        <div className="grid place-items-center py-10 text-ink-3">
          <Spinner className="size-5" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="dawn">
              <GitBranch className="size-3" />
              {worktree.branch}
            </Badge>
            <span className="text-ink-3">→</span>
            <Badge>{worktree.baseBranch}</Badge>
            <span className="text-ink-2">
              {status.ahead} ahead · {status.behind} behind
            </span>
            {status.dirty > 0 && <Badge tone="break">{status.dirty} uncommitted</Badge>}
            {status.merged && status.ahead === 0 && status.dirty === 0 && <Badge tone="ok">merged</Badge>}
            <Button size="sm" variant="ghost" className="ml-auto" icon={<RefreshCw className="size-3.5" />} onClick={() => void load()}>
              Refresh
            </Button>
          </div>

          {status.conflicts.length > 0 && (
            <div className="rounded-xl border border-break/50 bg-break-soft p-3 text-sm text-break-ink">
              <p className="flex items-center gap-1.5 font-semibold">
                <TriangleAlert className="size-4" /> Merge conflicts in the worktree
              </p>
              <ul className="mt-1 list-disc pl-5 font-mono text-[12.5px]">
                {status.conflicts.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {session && (
                <Button size="sm" variant="attention" className="mt-2" icon={<Sparkles className="size-3.5" />} busy={busy === 'Ask Claude'} onClick={askClaudeToResolve}>
                  Ask Claude to resolve
                </Button>
              )}
            </div>
          )}

          <div>
            <p className="mb-1.5 text-[13px] font-medium text-ink-2">
              {changed.length} {changed.length === 1 ? 'file' : 'files'} committed on the branch
              {status.dirty > 0 && ' (the diff also includes uncommitted edits)'}
            </p>
            {changed.length > 0 && (
              <ul className="mb-2 max-h-32 overflow-y-auto rounded-lg border border-line text-[12.5px]">
                {changed.map((f) => (
                  <li key={f.path} className="flex items-center gap-2 border-b border-line px-2.5 py-1 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                    <span className="text-ok">+{f.added}</span>
                    <span className="text-bad">−{f.removed}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="max-h-[45vh] space-y-2 overflow-auto">
              {diff.trim() ? (
                splitPatch(diff).map((f) => (
                  <div key={f.path}>
                    <p className="sticky top-0 z-[1] truncate bg-surface py-1 font-mono text-[12px] text-ink-2">{f.path}</p>
                    <PatchView patch={f.patch} />
                  </div>
                ))
              ) : (
                <p className="text-sm text-ink-3">No changes yet.</p>
              )}
            </div>
          </div>

          <div className="grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-2">
            {status.dirty > 0 && (
              <Field label="Commit uncommitted changes as" hint="Committed on the branch right before merging.">
                <Input value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} />
              </Field>
            )}
            <Field label={squash ? 'Squash commit message' : 'Merge commit message'} hint="Fast-forwards don't need one.">
              <Input value={message} onChange={(e) => setMessage(e.target.value)} />
            </Field>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                Squash into one commit
                <span className="block text-xs text-ink-3">Keeps {worktree.baseBranch}'s history tidy.</span>
              </span>
              <Toggle checked={squash} onChange={setSquash} label="Squash" />
            </label>
            {sessionOwned ? (
              <p className="text-xs text-ink-3 sm:self-center">
                After merging, this session keeps working here on a branch reset to {worktree.baseBranch}, so you can give it the next task.
              </p>
            ) : (
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Remove the worktree afterwards
                  <span className="block text-xs text-ink-3">The branch is deleted once merged.</span>
                </span>
                <Toggle checked={removeAfter} onChange={setRemoveAfter} label="Remove after merge" />
              </label>
            )}
          </div>

          {prUrl && (
            <p className="text-sm">
              Pull request:{' '}
              <a href={prUrl} target="_blank" rel="noreferrer" className="text-sky underline">
                {prUrl}
              </a>
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              icon={<RefreshCw className="size-4" />}
              busy={busy === 'Sync'}
              disabled={status.behind === 0}
              onClick={() => act('Sync', () => api.post(`${base}/sync`), `Merged ${worktree.baseBranch} into the branch`)}
              title={`Merge ${worktree.baseBranch} into this branch (conflicts stay in the worktree)`}
            >
              Sync with {worktree.baseBranch}
            </Button>
            <Button
              variant="ghost"
              icon={<GitPullRequest className="size-4" />}
              busy={busy === 'Open PR'}
              onClick={() =>
                act('Open PR', async () => {
                  const r = await api.post<{ url: string }>(`${base}/pr`, { title: session?.title });
                  setPrUrl(r.url);
                })
              }
            >
              Push & open PR
            </Button>
            <Button
              variant="ghost"
              className="text-bad"
              icon={<Trash2 className="size-4" />}
              busy={busy === 'Remove'}
              onClick={() =>
                confirm(
                  `Remove the worktree? Uncommitted work is committed to ${worktree.branch} first, and the branch is kept unless it's merged.` +
                    (sessionOwned ? ' This session will start a fresh conversation (in the main checkout) on its next message.' : ''),
                ) &&
                act('Remove', async () => {
                  await api.del(`${base}`);
                  onClose();
                  return false;
                })
              }
            >
              Remove
            </Button>
            <Button
              variant="primary"
              className="ml-auto"
              icon={<GitMerge className="size-4" />}
              busy={busy === 'Merge'}
              disabled={status.conflicts.length > 0 || (status.ahead === 0 && status.dirty === 0)}
              onClick={merge}
            >
              Merge into {worktree.baseBranch}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
