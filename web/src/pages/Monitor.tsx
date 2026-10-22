import { Bot, Server, SquareTerminal, Rocket } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import type { ProcessGroup } from '../../../shared/protocol';
import { Legend, LineChart, Meter, PageHeader, Panel, StatTile, severityFor } from '../components/hud';
import { Page, Shell } from '../components/Shell';
import { bytes, rate, span, utcTime } from '../lib/format';
import { useMetricsStream } from '../lib/live';
import { useStore } from '../lib/store';

const num = { fontVariantNumeric: 'tabular-nums' } as const;
const pct = (v: number) => `${Math.round(v)}%`;
const KIND_ICON = { server: Server, agents: Bot, terminals: SquareTerminal, service: Rocket } satisfies Record<ProcessGroup['kind'], unknown>;

export function MonitorPage() {
  useMetricsStream(true);
  const { host, history, processes } = useStore((s) => s.metrics);
  const projects = useStore((s) => s.projects);
  const last = history[history.length - 1];

  const series = useMemo(() => {
    const times = history.map((h) => h.t);
    return {
      times,
      cpu: history.map((h) => h.cpu),
      mem: history.map((h) => (h.memUsed / h.memTotal) * 100),
      rx: history.map((h) => h.netRx),
      tx: history.map((h) => h.netTx),
      load: history.map((h) => h.load[0]),
    };
  }, [history]);

  const memPct = last ? (last.memUsed / last.memTotal) * 100 : null;
  const diskPct = last && last.diskTotal ? (last.diskUsed / last.diskTotal) * 100 : null;
  const hasNet = last?.netRx !== null && last?.netRx !== undefined;
  const totalRss = processes.reduce((a, p) => a + p.rss, 0);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const windowLabel = history.length > 1 ? span((history[history.length - 1]!.t - history[0]!.t) / 1000) : null;

  return (
    <Shell>
      <Page wide>
        <PageHeader
          title="Monitor"
          subtitle={
            host ? (
              <>
                <span className="font-hud text-[13px] text-ink">{host.hostname}</span> · {host.platform} · {host.cpus} × {host.cpuModel.replace(/\s+/g, ' ')} · up {span(host.uptime)}
              </>
            ) : (
              'Connecting to the server…'
            )
          }
        />

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Current readings">
          <StatTile
            label="CPU · all cores"
            value={last ? pct(last.cpu) : '—'}
            sub={last ? `load ${last.load.map((l) => l.toFixed(2)).join(' · ')}` : undefined}
            footer={<Meter percent={last?.cpu ?? null} severity={severityFor(last?.cpu ?? null, 85, 97)} label="CPU busy" />}
          />
          <StatTile
            label="Memory"
            value={memPct !== null ? pct(memPct) : '—'}
            sub={last ? `${bytes(last.memUsed)} of ${bytes(last.memTotal)}` : undefined}
            footer={<Meter percent={memPct} severity={severityFor(memPct, 85, 95)} label="Memory used" />}
          />
          <StatTile
            label="Disk · workspaces"
            value={diskPct !== null ? pct(diskPct) : '—'}
            sub={last ? `${bytes(last.diskTotal - last.diskUsed)} free of ${bytes(last.diskTotal)}` : undefined}
            footer={<Meter percent={diskPct} severity={severityFor(diskPct, 85, 95)} label="Disk used" />}
          />
          <StatTile
            label="Network"
            value={hasNet ? rate((last!.netRx ?? 0) + (last!.netTx ?? 0)) : '—'}
            sub={hasNet ? `↓ ${rate(last!.netRx!)} · ↑ ${rate(last!.netTx!)}` : 'Per-interface counters are Linux-only'}
          />
        </section>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Panel label={`CPU · last ${windowLabel ?? 'hour'}`} right={last && <span className="font-hud text-[12px] text-ink-2">{pct(last.cpu)}</span>}>
            <LineChart times={series.times} series={[{ key: 'cpu', label: 'CPU', color: 'var(--series-1)', values: series.cpu }]} yMax={100} yFormat={pct} xFormat={utcTime} label="CPU usage over time" />
          </Panel>
          <Panel label={`Memory · last ${windowLabel ?? 'hour'}`} right={memPct !== null && <span className="font-hud text-[12px] text-ink-2">{pct(memPct)}</span>}>
            <LineChart times={series.times} series={[{ key: 'mem', label: 'Memory', color: 'var(--series-3)', values: series.mem }]} yMax={100} yFormat={pct} xFormat={utcTime} label="Memory usage over time" />
          </Panel>
          {hasNet && (
            <Panel label="Network throughput" right={<Legend items={[{ label: 'Download', color: 'var(--series-1)' }, { label: 'Upload', color: 'var(--series-2)' }]} />}>
              <LineChart
                times={series.times}
                series={[
                  { key: 'rx', label: 'Download', color: 'var(--series-1)', values: series.rx },
                  { key: 'tx', label: 'Upload', color: 'var(--series-2)', values: series.tx },
                ]}
                yFormat={(v) => rate(v)}
                xFormat={utcTime}
                label="Network throughput over time"
              />
            </Panel>
          )}
          <Panel label="Load average · 1 min" right={host && <span className="hud-label">{host.cpus} cores</span>}>
            <LineChart times={series.times} series={[{ key: 'load', label: 'Load (1m)', color: 'var(--series-4)', values: series.load }]} yFormat={(v) => v.toFixed(1)} xFormat={utcTime} label="Load average over time" />
          </Panel>
        </div>

        <Panel label="Processes Cloude runs" right={<span className="hud-label">refreshed every 5s</span>} bodyClassName="p-0">
          {processes.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-[13px] text-ink-3">Reading the process table…</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left">
                    <th className="hud-label px-3.5 py-2 font-normal">Group</th>
                    <th className="hud-label px-3 py-2 text-right font-normal">Processes</th>
                    <th className="hud-label px-3 py-2 text-right font-normal">CPU</th>
                    <th className="hud-label w-[30%] px-3.5 py-2 font-normal">Memory</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {processes.map((p) => {
                    const Icon = KIND_ICON[p.kind];
                    const share = totalRss ? (p.rss / totalRss) * 100 : 0;
                    return (
                      <tr key={`${p.kind}:${p.serviceId ?? p.label}`}>
                        <td className="px-3.5 py-2">
                          <span className="flex items-center gap-2">
                            <Icon className="size-4 shrink-0 text-ink-3" />
                            {p.kind === 'service' && p.projectId ? (
                              <Link to={`/p/${p.projectId}`} className="truncate hover:text-sky">
                                {p.label} <span className="text-ink-3">· {projectName.get(p.projectId) ?? 'project'}</span>
                              </Link>
                            ) : (
                              <span className="truncate">{p.label}</span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-hud text-[12px] text-ink-2" style={num}>
                          {p.processes}
                        </td>
                        <td className="px-3 py-2 text-right font-hud text-[12px]" style={num}>
                          {p.cpu.toFixed(1)}%
                        </td>
                        <td className="px-3.5 py-2">
                          <div className="flex items-center gap-3">
                            <div className="h-1 flex-1 overflow-hidden rounded-[1px] bg-surface-2">
                              <div className="h-full rounded-[1px] bg-sky" style={{ width: `${share}%` }} />
                            </div>
                            <span className="w-16 text-right font-hud text-[12px]" style={num}>
                              {bytes(p.rss)}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="border-t border-line px-3.5 py-2 text-[11.5px] text-ink-3">CPU is % of one core, summed per group. Docker deployments run outside this process tree.</p>
            </div>
          )}
        </Panel>
      </Page>
    </Shell>
  );
}
