import clsx from 'clsx';
import { LogOut, Search } from 'lucide-react';
import { useEffect, useMemo, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { usd } from '../lib/format';
import { useMedia, useMetricsStream, useNow } from '../lib/live';
import { NAV, signOut } from '../lib/nav';
import { useStore } from '../lib/store';
import { CommandPalette } from './CommandPalette';
import { Mark } from './ui';

const openPalette = () => useStore.setState({ paletteOpen: true });

function Rail() {
  const navigate = useNavigate();
  return (
    <nav aria-label="Main" className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-ground py-3">
      <Link to="/" className="mb-3" aria-label="Cloude home">
        <Mark className="size-7" />
      </Link>
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          title={n.label}
          aria-label={n.label}
          className={({ isActive }) =>
            clsx(
              'relative flex size-10 items-center justify-center rounded-md transition-colors',
              isActive ? 'bg-sky-soft text-sky before:absolute before:top-2 before:bottom-2 before:-left-2 before:w-0.5 before:rounded-full before:bg-sky' : 'text-ink-3 hover:bg-surface-2 hover:text-ink',
            )
          }
        >
          <n.icon className="size-[18px]" />
        </NavLink>
      ))}
      <div className="mt-auto flex flex-col items-center gap-1">
        <button onClick={openPalette} title="Search & commands (⌘K)" aria-label="Search and commands" className="flex size-10 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink">
          <Search className="size-[18px]" />
        </button>
        <button onClick={() => void signOut(navigate)} title="Sign out" aria-label="Sign out" className="flex size-10 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink">
          <LogOut className="size-[18px]" />
        </button>
      </div>
    </nav>
  );
}

/**
 * The annunciator strip: a row of backlit cells, dark when all is well. A cell
 * lights amber (and NEEDS YOU flashes) when something wants your attention.
 */
function Annunciator() {
  useMetricsStream(false);
  const navigate = useNavigate();
  const now = useNow(1000);
  const connection = useStore((s) => s.connection);
  const sessions = useStore((s) => s.sessions);
  const usage = useStore((s) => s.usage);
  const last = useStore((s) => s.metrics.history[s.metrics.history.length - 1]);
  const version = useStore((s) => s.status?.version);

  const { waiting, flying } = useMemo(() => {
    const list = Object.values(sessions);
    return {
      waiting: list.filter((s) => s.status === 'awaiting_input').sort((a, b) => b.updatedAt - a.updatedAt),
      flying: list.filter((s) => s.status === 'running' || s.status === 'starting').length,
    };
  }, [sessions]);

  const fiveHour = usage?.limits.available ? usage.limits.windows.find((w) => w.kind === 'five_hour') : undefined;
  const day = usage?.budget.day;
  const memPct = last ? (last.memUsed / last.memTotal) * 100 : null;
  const lit = (pct: number | null | undefined, warn = 75, crit = 95) => (pct == null ? undefined : pct >= crit ? 'warning' : pct >= warn ? 'caution' : undefined);

  return (
    <footer className="flex h-9 shrink-0 items-center gap-1.5 overflow-x-auto border-t border-line bg-surface px-2.5" aria-label="Status">
      <span className="annun" data-lit={connection === 'open' ? 'ok' : connection === 'connecting' ? 'caution' : 'warning'} title="Live connection to the server">
        {connection === 'open' ? 'Link' : connection === 'connecting' ? 'Link…' : 'No link'}
      </span>
      <button
        className="annun"
        data-lit={waiting.length ? 'caution' : undefined}
        data-flash={waiting.length ? '' : undefined}
        disabled={!waiting.length}
        onClick={() => waiting[0] && navigate(`/p/${waiting[0].projectId}/s/${waiting[0].id}`)}
        title={waiting.length ? `Open "${waiting[0]!.title}"` : 'Nothing is waiting on you'}
      >
        Needs you <b>{waiting.length}</b>
      </button>
      <span className="annun" data-lit={flying ? 'active' : undefined} title="Sessions where Claude is working">
        Claude <b>{flying}</b>
      </span>
      {fiveHour && (
        <Link to="/usage#limits" className="annun" data-lit={lit(fiveHour.percent)} title={fiveHour.label}>
          Plan 5h <b>{fiveHour.percent === null ? '—' : `${Math.round(fiveHour.percent)}%`}</b>
        </Link>
      )}
      {day?.limitUsd ? (
        <Link to="/usage#budgets" className="annun" data-lit={day.state === 'over' ? 'warning' : day.state === 'warn' ? 'caution' : undefined} title="Daily budget used">
          Budget <b>{Math.round(day.percent ?? 0)}%</b>
        </Link>
      ) : null}
      {usage && (
        <Link to="/usage" className="annun" title="Spend today (UTC)">
          Today <b>{usd(usage.today.costUsd)}</b>
        </Link>
      )}
      {last && (
        <Link to="/monitor" className="annun" data-lit={lit(last.cpu, 85, 97)} title="Server CPU">
          CPU <b>{Math.round(last.cpu)}%</b>
        </Link>
      )}
      {memPct !== null && (
        <Link to="/monitor" className="annun" data-lit={lit(memPct, 85, 95)} title="Server memory">
          Mem <b>{Math.round(memPct)}%</b>
        </Link>
      )}
      <span className="ml-auto shrink-0 pl-3 font-hud text-[10.5px] tracking-[0.08em] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {version && <span className="mr-3">v{version}</span>}
        UTC {new Date(now).toISOString().slice(11, 19)}
      </span>
    </footer>
  );
}

function MobileTabs() {
  return (
    <nav className="pb-safe flex border-t border-line bg-ground" aria-label="Main">
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          className={({ isActive }) => clsx('flex flex-1 flex-col items-center gap-0.5 py-2 font-hud text-[10px] tracking-[0.06em] uppercase', isActive ? 'text-sky' : 'text-ink-3')}
        >
          <n.icon className="size-5" />
          {n.label}
        </NavLink>
      ))}
    </nav>
  );
}

function MobileHeader() {
  const waiting = useStore((s) => Object.values(s.sessions).some((x) => x.status === 'awaiting_input'));
  const connection = useStore((s) => s.connection);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-ground px-3">
      <Link to="/" aria-label="Cloude home" className="flex items-center gap-2 font-display font-bold">
        <Mark />
        Cloude
      </Link>
      <span className="ml-auto" />
      {waiting && (
        <span className="annun" data-lit="caution" data-flash="">
          Needs you
        </span>
      )}
      {connection !== 'open' && (
        <span className="annun" data-lit={connection === 'connecting' ? 'caution' : 'warning'}>
          {connection === 'connecting' ? 'Link…' : 'No link'}
        </span>
      )}
      <button onClick={openPalette} aria-label="Search and commands" className="flex size-9 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2">
        <Search className="size-[18px]" />
      </button>
    </header>
  );
}

function useCommandKey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useStore.setState((s) => ({ paletteOpen: !s.paletteOpen }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/**
 * App frame. `bare` is for the workspace, which brings its own full-height
 * layout (and its own mobile navigation).
 */
export function Shell({ children, bare }: { children: ReactNode; bare?: boolean }) {
  const desktop = useMedia('(min-width: 1024px)');
  useCommandKey();
  const palette = <CommandPalette />;

  if (desktop) {
    return (
      <div className="flex h-full">
        <Rail />
        <div className="flex min-w-0 flex-1 flex-col">
          {bare ? <div className="min-h-0 flex-1">{children}</div> : <main className="hud-ground min-h-0 flex-1 overflow-y-auto">{children}</main>}
          <Annunciator />
        </div>
        {palette}
      </div>
    );
  }
  if (bare)
    return (
      <>
        {children}
        {palette}
      </>
    );
  return (
    <div className="flex h-full flex-col">
      <MobileHeader />
      <main className="hud-ground min-h-0 flex-1 overflow-y-auto">{children}</main>
      <MobileTabs />
      {palette}
    </div>
  );
}

/** Standard page body width and padding. */
export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={clsx('mx-auto w-full space-y-5 px-4 pt-6 pb-16 sm:px-6 lg:pt-8', wide ? 'max-w-7xl' : 'max-w-4xl')}>{children}</div>;
}
