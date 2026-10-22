import RFB from '@novnc/novnc';
import clsx from 'clsx';
import { ClipboardPaste, Eye, MonitorOff, MonitorPlay, MousePointer2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DesktopStatus } from '../../../shared/protocol';
import { Badge, Button, Empty, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { toast } from '../lib/store';
import { useWorkbench } from '../lib/workbench';

const err = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

/**
 * The server's virtual desktop, streamed with noVNC over Cloude's authenticated
 * /ws/desktop bridge. GUI apps (Electron, Tauri, .NET, Qt, headed browsers…)
 * that Claude or a terminal starts show up here; Claude sees the same screen
 * through its desktop_* tools.
 */
export function DesktopPanel({ visible }: { visible: boolean }) {
  const status = useWorkbench((s) => s.desktop);
  const host = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [connected, setConnected] = useState(false);
  const [viewOnly, setViewOnly] = useState(false);
  const viewOnlyRef = useRef(viewOnly); // read by reconnects, so they keep the current mode
  viewOnlyRef.current = viewOnly;
  const [busy, setBusy] = useState(false);
  // The VNC password comes only from the API (broadcast status never carries it).
  const [password, setPassword] = useState<string | null>(null);

  useEffect(() => {
    if (status && !status.running) {
      setPassword(null);
      return;
    }
    api
      .get<DesktopStatus>('/api/desktop')
      .then(({ password: pw, ...s }) => {
        useWorkbench.setState({ desktop: s });
        setPassword(pw ?? null);
      })
      .catch(() => {});
  }, [status?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  // Connect while the desktop runs and the panel is on screen; reconnect if the stream drops.
  useEffect(() => {
    if (!status?.running || !visible || !host.current || !password) return;
    let closed = false;
    let retry = 0;
    let timer: number | undefined;
    const connect = () => {
      const rfb = new RFB(host.current!, `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/desktop`, { shared: true, credentials: { password } });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = 'var(--port)';
      rfb.qualityLevel = 6;
      rfb.compressionLevel = 2;
      rfb.viewOnly = viewOnlyRef.current;
      rfb.addEventListener('connect', () => {
        retry = 0;
        setConnected(true);
      });
      rfb.addEventListener('disconnect', () => {
        setConnected(false);
        if (rfbRef.current === rfb) rfbRef.current = null;
        if (!closed) timer = window.setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
      });
      rfbRef.current = rfb;
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      rfbRef.current?.disconnect();
      rfbRef.current = null;
      setConnected(false);
    };
  }, [status?.running, visible, password]);

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  async function power(on: boolean) {
    setBusy(true);
    try {
      const { password: pw, ...s } = await api.post<DesktopStatus>(`/api/desktop/${on ? 'start' : 'stop'}`);
      setPassword(pw ?? null);
      useWorkbench.setState({ desktop: s });
    } catch (e) {
      toast('error', on ? 'Could not start the desktop' : 'Could not stop the desktop', err(e));
    } finally {
      setBusy(false);
    }
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      rfbRef.current?.clipboardPasteFrom(text);
      toast('info', 'Clipboard sent', 'Paste it in the desktop app (Ctrl+V).');
    } catch {
      toast('warning', 'Clipboard access was blocked by the browser');
    }
  }

  if (!status)
    return (
      <div className="grid h-full place-items-center text-ink-3">
        <Spinner className="size-5" />
      </div>
    );

  if (!status.available)
    return (
      <Empty icon={<MonitorOff className="size-8" />} title="Virtual desktop unavailable">
        This server is missing <span className="font-mono">{status.missing.join(', ')}</span>. The Cloude Docker image includes them; elsewhere install with
        <code className="mt-2 block rounded-md bg-surface-2 px-2 py-1 font-mono text-xs">sudo apt-get install -y xvfb x11vnc xdotool imagemagick fluxbox</code>
      </Empty>
    );

  if (!status.running)
    return (
      <Empty
        icon={<MonitorPlay className="size-8" />}
        title="Virtual desktop"
        action={
          <Button variant="primary" icon={<MonitorPlay className="size-4" />} busy={busy} onClick={() => power(true)}>
            Start desktop
          </Button>
        }
      >
        A Linux desktop on the server for building and testing GUI apps. Claude can see and drive it too (computer use).
        {status.error && <span className="mt-2 block text-bad">Last run: {status.error}</span>}
      </Empty>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
        <Badge tone={connected ? 'ok' : 'break'}>
          {connected ? 'Live' : 'Connecting…'} · {status.display} · {status.width}×{status.height}
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          icon={viewOnly ? <Eye className="size-3.5" /> : <MousePointer2 className="size-3.5" />}
          onClick={() => setViewOnly(!viewOnly)}
          title={viewOnly ? 'Watching only — click to take control' : 'You can click and type — click to only watch'}
        >
          {viewOnly ? 'Watching' : 'Control'}
        </Button>
        <Button size="sm" variant="ghost" icon={<ClipboardPaste className="size-3.5" />} onClick={paste} disabled={!connected}>
          Paste
        </Button>
        <Button size="sm" variant="ghost" icon={<MonitorOff className="size-3.5" />} busy={busy} onClick={() => power(false)}>
          Stop
        </Button>
      </div>
      <div ref={host} className={clsx('min-h-0 flex-1 overflow-hidden bg-port', !connected && 'opacity-60')} />
    </div>
  );
}
