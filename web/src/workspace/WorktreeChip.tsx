import { GitBranch, GitMerge, Minimize2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CompressionStats, Project, Session } from '../../../shared/protocol';
import { Badge, Button } from '../components/ui';
import { api } from '../lib/api';
import { WorktreeReview } from './WorktreeReview';

/** Approximate tokens from characters (Claude averages ~4 chars per token on code and logs). */
const tokens = (chars: number) => (chars >= 4000 ? `${Math.round(chars / 4000)}k` : String(Math.round(chars / 4)));

/** Header extras for a session: its branch + Review/land, and how many tokens compression saved. */
export function WorktreeChip({ session, project }: { session: Session; project: Project }) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<CompressionStats | null>(null);
  const wt = session.worktree;

  // Refresh after each turn rather than streaming: the number only changes when tools run.
  useEffect(() => {
    if (session.status !== 'idle') return;
    api
      .get<CompressionStats>(`/api/sessions/${session.id}/compression`)
      .then(setStats)
      .catch(() => {});
  }, [session.id, session.status]);

  const saved = stats ? stats.originalChars - stats.compressedChars : 0;
  return (
    <>
      {saved > 0 && (
        <span className="hidden sm:inline-flex" title={`Token compression trimmed ${stats!.calls} command outputs from ${tokens(stats!.originalChars)} to ${tokens(stats!.compressedChars)} tokens`}>
          <Badge tone="ok">
            <Minimize2 className="size-3" />−{tokens(saved)} tokens
          </Badge>
        </span>
      )}
      {wt && (
        <>
          <span className="hidden max-w-40 md:inline-flex" title={`Isolated worktree ${wt.path}`}>
            <Badge tone="dawn" className="max-w-full">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">{wt.branch}</span>
            </Badge>
          </span>
          <Button size="sm" variant="ghost" icon={<GitMerge className="size-3.5" />} onClick={() => setOpen(true)} title={`Review and merge into ${wt.baseBranch}`}>
            <span className="hidden sm:inline">Review</span>
          </Button>
          {open && <WorktreeReview project={project} worktree={wt} session={session} open onClose={() => setOpen(false)} />}
        </>
      )}
    </>
  );
}
