import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';

export const err = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));

export function Card({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={clsx('rounded-lg border border-line bg-surface p-4 shadow-cloud sm:p-5', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="font-display text-[17px] font-semibold">{title}</h2>}
            {description && <p className="mt-1 max-w-2xl text-sm text-ink-2">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children && <div className={clsx((title || actions) && 'mt-4')}>{children}</div>}
    </section>
  );
}

/** Load once, then re-load every `ms` while mounted (and on demand via the returned reload). */
export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []): { data: T | null; error: string | null; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e) {
      setError(err(e));
    }
  }, []);
  useEffect(() => {
    void reload();
    if (!ms) return;
    const t = setInterval(() => document.visibilityState === 'visible' && void reload(), ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, reload, ...deps]);
  return { data, error, reload };
}

export function Meter({ used, total, warn }: { used: number; total: number; warn?: boolean }) {
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={clsx('h-full rounded-full transition-[width]', warn || pct > 85 ? 'bg-break' : 'bg-sky')} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Dot({ tone }: { tone: 'ok' | 'idle' | 'bad' | 'busy' }) {
  return (
    <span
      className={clsx(
        'inline-block size-2.5 shrink-0 rounded-full',
        tone === 'ok' && 'bg-ok',
        tone === 'idle' && 'bg-line-strong',
        tone === 'bad' && 'bg-bad',
        tone === 'busy' && 'animate-pulse bg-sky',
      )}
    />
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-ink-3">{children}</p>;
}

export const minutes = (m: number) => (m < 60 ? `${m} min` : m % 1440 === 0 ? `${m / 1440} d` : m % 60 === 0 ? `${m / 60} h` : `${(m / 60).toFixed(1)} h`);
