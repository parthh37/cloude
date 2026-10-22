import clsx from 'clsx';
import { CornerDownLeft, FolderGit2, LogOut, MessageSquare, Moon, Plus, Search, Sun, SunMoon, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { STATUS_LABEL, timeAgo } from '../lib/format';
import { useStore } from '../lib/store';
import { setThemePref } from '../lib/theme';
import { NAV, signOut } from '../lib/nav';

interface Item {
  id: string;
  group: 'Go to' | 'Sessions' | 'Projects' | 'Actions';
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
  attention?: boolean;
}

/** Every query word must appear somewhere in the label or hint. */
function matches(item: Item, q: string) {
  if (!q) return true;
  const hay = `${item.label} ${item.hint ?? ''} ${item.group}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const close = () => useStore.setState({ paletteOpen: false });

  useEffect(() => {
    if (open) {
      setQ('');
      setIndex(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => navigate(to);
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    const recent = Object.values(sessions)
      .filter((s) => !s.archived)
      .sort((a, b) => Number(b.status === 'awaiting_input') - Number(a.status === 'awaiting_input') || b.updatedAt - a.updatedAt)
      .slice(0, 40);
    return [
      ...NAV.map((n) => ({ id: `nav:${n.to}`, group: 'Go to' as const, label: n.label, icon: n.icon, run: go(n.to) })),
      ...recent.map((s) => ({
        id: `s:${s.id}`,
        group: 'Sessions' as const,
        label: s.title,
        hint: `${projectName.get(s.projectId) ?? 'Project'} · ${s.status === 'idle' ? timeAgo(s.updatedAt) : STATUS_LABEL[s.status]}`,
        icon: MessageSquare,
        attention: s.status === 'awaiting_input',
        run: go(`/p/${s.projectId}/s/${s.id}`),
      })),
      ...projects.map((p) => ({ id: `p:${p.id}`, group: 'Projects' as const, label: p.name, hint: p.path, icon: FolderGit2, run: go(`/p/${p.id}`) })),
      { id: 'a:new', group: 'Actions', label: 'New project', icon: Plus, run: go('/?new=project') },
      { id: 'a:night', group: 'Actions', label: 'Theme: Night', hint: 'dark instrument panel', icon: Moon, run: () => setThemePref('night') },
      { id: 'a:day', group: 'Actions', label: 'Theme: Day', hint: 'light, for sunlight', icon: Sun, run: () => setThemePref('day') },
      { id: 'a:auto', group: 'Actions', label: 'Theme: Auto', hint: 'follow the system', icon: SunMoon, run: () => setThemePref('auto') },
      { id: 'a:out', group: 'Actions', label: 'Sign out', icon: LogOut, run: () => void signOut(navigate) },
    ];
  }, [projects, sessions, navigate]);

  const visible = useMemo(() => items.filter((it) => matches(it, q)).slice(0, 60), [items, q]);
  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;

  function choose(it: Item | undefined) {
    if (!it) return;
    close();
    it.run();
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(visible.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(visible[index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-3 pt-[12vh] backdrop-blur-[2px]" onMouseDown={close}>
      <div
        role="dialog"
        aria-modal
        aria-label="Search and commands"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-line-strong bg-surface shadow-cloud"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-3.5">
          <Search className="size-4 shrink-0 text-ink-3" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Jump to a session, project or page…"
            aria-label="Search"
            aria-controls="palette-list"
            aria-activedescendant={visible[index] ? `palette-${visible[index].id}` : undefined}
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-ink placeholder:text-ink-3 focus:outline-none"
          />
          <kbd className="hud-label rounded-[3px] border border-line px-1.5 py-0.5">esc</kbd>
        </div>
        <ul ref={listRef} id="palette-list" role="listbox" className="max-h-[52vh] overflow-y-auto py-1.5">
          {visible.length === 0 && <li className="px-4 py-6 text-center text-sm text-ink-3">Nothing matches “{q}”.</li>}
          {visible.map((it, i) => {
            const header = it.group !== lastGroup;
            lastGroup = it.group;
            return (
              <li key={it.id} role="presentation">
                {header && <div className="hud-label px-4 pt-2.5 pb-1">{it.group}</div>}
                <div
                  id={`palette-${it.id}`}
                  role="option"
                  aria-selected={i === index}
                  data-index={i}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => choose(it)}
                  className={clsx('mx-1.5 flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2', i === index ? 'bg-sky-soft' : '')}
                >
                  <it.icon className={clsx('size-4 shrink-0', it.attention ? 'text-break' : i === index ? 'text-sky' : 'text-ink-3')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-ink">{it.label}</span>
                    {it.hint && <span className="block truncate text-[12px] text-ink-3">{it.hint}</span>}
                  </span>
                  {it.attention && <span className="annun" data-lit="caution">Needs you</span>}
                  {i === index && <CornerDownLeft className="size-3.5 shrink-0 text-ink-3" />}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
