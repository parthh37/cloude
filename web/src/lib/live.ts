import { useEffect, useState } from 'react';
import type { MetricsSnapshot } from '../../../shared/protocol';
import { api } from './api';
import { useStore } from './store';
import { socket } from './ws';

/** Load the metrics history once, then stream samples while mounted. */
export function useMetricsStream(withProcesses = false) {
  useEffect(() => {
    let cancelled = false;
    api
      .get<MetricsSnapshot>('/api/metrics')
      .then((m) => {
        if (!cancelled) useStore.setState({ metrics: { host: m.host, intervalMs: m.intervalMs, history: m.history, processes: m.processes } });
      })
      .catch(() => {});
    const offs = [socket.watch('metrics'), ...(withProcesses ? [socket.watch('processes')] : [])];
    return () => {
      cancelled = true;
      offs.forEach((off) => off());
    };
  }, [withProcesses]);
}

/** A clock that re-renders every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useMedia(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}
