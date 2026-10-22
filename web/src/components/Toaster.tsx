import clsx from 'clsx';
import { X } from 'lucide-react';
import { useNavigate } from 'react-router';
import { dismissToast, useStore } from '../lib/store';

export function Toaster() {
  const toasts = useStore((s) => s.toasts);
  const sessions = useStore((s) => s.sessions);
  const navigate = useNavigate();
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-[60] flex flex-col items-center gap-2 px-3 sm:top-auto sm:right-4 sm:bottom-4 sm:left-auto sm:items-end">
      {toasts.map((t) => {
        const session = t.sessionId ? sessions[t.sessionId] : undefined;
        return (
          <div
            key={t.id}
            role="status"
            className={clsx(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-surface px-4 py-3 shadow-cloud',
              t.level === 'error' && 'border-bad/40',
              t.level === 'warning' && 'border-break/50',
              t.level === 'success' && 'border-ok/40',
              t.level === 'info' && 'border-line',
            )}
          >
            <span
              className={clsx(
                'mt-1.5 size-2 shrink-0 rounded-full',
                t.level === 'error' ? 'bg-bad' : t.level === 'warning' ? 'bg-break' : t.level === 'success' ? 'bg-ok' : 'bg-sky',
              )}
            />
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => {
                if (session) navigate(`/p/${session.projectId}/s/${session.id}`);
                dismissToast(t.id);
              }}
            >
              <p className="text-sm font-semibold">{t.title}</p>
              {t.body && <p className="mt-0.5 line-clamp-2 text-[13px] text-ink-2">{t.body}</p>}
            </button>
            <button aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="text-ink-3 hover:text-ink">
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
