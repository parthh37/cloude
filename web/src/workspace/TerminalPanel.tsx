import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import clsx from 'clsx';
import { Plus, Sparkles, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Project, TerminalInfo } from '../../../shared/protocol';
import { Button, Empty } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { toast } from '../lib/store';

const THEME = {
  background: '#0f141c',
  foreground: '#c9d3e0',
  cursor: '#e2774f',
  cursorAccent: '#0f141c',
  selectionBackground: '#2b3a52',
  black: '#1b2129',
  red: '#e06a6a',
  green: '#5db98c',
  yellow: '#f0b354',
  blue: '#7fa9db',
  magenta: '#c49be8',
  cyan: '#6cc4c9',
  white: '#c9d3e0',
  brightBlack: '#5b6779',
  brightRed: '#f08b8b',
  brightGreen: '#7fd3a8',
  brightYellow: '#f6c878',
  brightBlue: '#a0c2ea',
  brightMagenta: '#d7b8f2',
  brightCyan: '#8fd8dc',
  brightWhite: '#eef2f7',
};

const isTouch = typeof window !== 'undefined' && matchMedia('(pointer: coarse)').matches;

function TermView({ info, active }: { info: TerminalInfo; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: isTouch ? 12 : 13,
      theme: THEME,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host.current!);
    termRef.current = term;
    fitRef.current = fit;

    let ws: WebSocket;
    let closed = false;
    let retry = 0;
    const send = (msg: unknown) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal/${info.id}`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        term.reset();
        try {
          fit.fit();
        } catch {
          /* hidden */
        }
        send({ t: 'resize', cols: term.cols, rows: term.rows });
      };
      ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '');
      ws.onclose = (e) => {
        if (closed || e.code === 4404) return;
        setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
      };
    };
    connect();

    const dataSub = term.onData((d) => {
      if (ctrlRef.current && d.length === 1) {
        const code = d.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) d = String.fromCharCode(code - 64);
        setCtrl(false);
      }
      send({ t: 'in', d });
    });
    const resizeSub = term.onResize(({ cols, rows }) => send({ t: 'resize', cols, rows }));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* not visible */
      }
    });
    ro.observe(host.current!);

    return () => {
      closed = true;
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      ws?.close();
      term.dispose();
    };
  }, [info.id]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      if (!isTouch) termRef.current?.focus();
    });
  }, [active]);

  const key = (seq: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'in', d: seq }));
    termRef.current?.focus();
  };

  return (
    <div className={clsx('flex h-full min-h-0 flex-col', !active && 'hidden')}>
      <div className="min-h-0 flex-1 bg-port" ref={host} />
      {isTouch && (
        <div className="flex gap-1 overflow-x-auto border-t border-port-line bg-port-2 px-1.5 py-1.5">
          {[
            ['Esc', '\x1b'],
            ['Tab', '\t'],
            ['↑', '\x1b[A'],
            ['↓', '\x1b[B'],
            ['←', '\x1b[D'],
            ['→', '\x1b[C'],
            ['^C', '\x03'],
            ['^D', '\x04'],
            ['/', '/'],
            ['|', '|'],
            ['~', '~'],
          ].map(([label, seq]) => (
            <button key={label} onClick={() => key(seq!)} className="h-8 min-w-9 rounded-md bg-port px-2 font-mono text-xs text-port-ink active:bg-port-line">
              {label}
            </button>
          ))}
          <button
            onClick={() => setCtrl(!ctrl)}
            className={clsx('h-8 min-w-11 rounded-md px-2 font-mono text-xs', ctrl ? 'bg-dawn text-white' : 'bg-port text-port-ink')}
            aria-pressed={ctrl}
          >
            Ctrl
          </button>
        </div>
      )}
    </div>
  );
}

export function TerminalPanel({ project, visible }: { project: Project; visible: boolean }) {
  const [terms, setTerms] = useState<TerminalInfo[] | null>(null);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ terminals: TerminalInfo[] }>(`/api/projects/${project.id}/terminals`).then((r) => {
      setTerms(r.terminals);
      setActive(r.terminals[0]?.id ?? null);
    });
  }, [project.id]);

  async function create(command?: string, title?: string) {
    try {
      const { terminal } = await api.post<{ terminal: TerminalInfo }>(`/api/projects/${project.id}/terminals`, { command, title });
      setTerms((t) => [...(t ?? []), terminal]);
      setActive(terminal.id);
    } catch (e) {
      toast('error', 'Could not open a terminal', e instanceof ApiError ? e.message : String(e));
    }
  }

  async function close(id: string) {
    await api.del(`/api/terminals/${id}`).catch(() => {});
    setTerms((t) => {
      const next = (t ?? []).filter((x) => x.id !== id);
      if (active === id) setActive(next[next.length - 1]?.id ?? null);
      return next;
    });
  }

  if (!terms) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-line bg-surface px-2 py-1.5">
        {terms.map((t) => (
          <div
            key={t.id}
            className={clsx('group flex h-8 shrink-0 items-center gap-1 rounded-lg pr-1 pl-2.5 text-[13px]', t.id === active ? 'bg-ink text-ground' : 'text-ink-2 hover:bg-surface-2')}
          >
            <button onClick={() => setActive(t.id)} className={clsx('max-w-36 truncate', !t.alive && 'line-through opacity-70')}>
              {t.title}
            </button>
            <button aria-label={`Close ${t.title}`} onClick={() => close(t.id)} className="rounded p-0.5 opacity-60 hover:opacity-100">
              <X className="size-3.5" />
            </button>
          </div>
        ))}
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => create()}>
          Shell
        </Button>
        <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" />} onClick={() => create('claude', 'Claude CLI')} title="Interactive Claude Code CLI">
          Claude CLI
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {terms.length === 0 ? (
          <Empty
            icon={<SquareTerminal className="size-8" />}
            title="No terminals open"
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => create()}>
                Open a shell
              </Button>
            }
          >
            Terminals keep running on the server when you close the tab, so long builds and REPLs survive your phone locking.
          </Empty>
        ) : (
          terms.map((t) => <TermView key={t.id} info={t} active={visible && t.id === active} />)
        )}
      </div>
    </div>
  );
}
