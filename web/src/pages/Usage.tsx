import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { AppSettings, UsageRange, UsageReport } from '../../../shared/protocol';
import { Legend, Meter, PageHeader, Panel, Segmented, StackedBars, StatTile, severityFor } from '../components/hud';
import { Page, Shell } from '../components/Shell';
import { Button, Field, Input, Toggle } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { MODEL_KEYS, changeVs, compact, modelName, modelSlot, span, timeAgo, usd, utcDay, utcTime } from '../lib/format';
import { toast, useStore } from '../lib/store';

const RANGES: { value: UsageRange; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
];

const tokensOf = (t: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;

const num = { fontVariantNumeric: 'tabular-nums' } as const;
/** $0 · $0.40 · $1.6 · $20 — axis ticks only. */
const usdAxis = (v: number) => (v === 0 ? '$0' : v >= 10 ? `$${Math.round(v)}` : v >= 1 ? `$${+v.toFixed(1)}` : `$${v.toFixed(2)}`);

function SpendChart({ report }: { report: UsageReport }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  // Fold models into their fixed slots (colour follows the model, never its rank).
  const buckets = useMemo(
    () =>
      report.series.map((s) => {
        const parts: Record<string, number> = {};
        for (const [model, cost] of Object.entries(s.byModel)) {
          const k = modelSlot(model).key;
          parts[k] = (parts[k] ?? 0) + cost;
        }
        return { t: s.t, parts, total: s.costUsd, tokens: s.tokens };
      }),
    [report],
  );
  const present = MODEL_KEYS.filter((k) => buckets.some((b) => (b.parts[k.key] ?? 0) > 0));
  const xFormat = report.bucket === 'hour' ? utcTime : utcDay;
  const empty = present.length === 0;

  return (
    <Panel
      label={`Spend by model · ${report.bucket === 'hour' ? 'hourly' : 'daily'} · UTC`}
      right={
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'chart', label: 'Chart' },
            { value: 'table', label: 'Table' },
          ]}
        />
      }
    >
      {empty ? (
        <p className="py-12 text-center text-[13px] text-ink-3">No spend in this range.</p>
      ) : view === 'chart' ? (
        <>
          <StackedBars buckets={buckets} keys={present} format={usd} axisFormat={usdAxis} xFormat={xFormat} label={`Spend by model, ${report.range}`} />
          <div className="mt-2">
            <Legend items={present} />
          </div>
        </>
      ) : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-left">
                <th className="hud-label py-1.5 pr-3 font-normal">{report.bucket === 'hour' ? 'Hour' : 'Day'}</th>
                {present.map((k) => (
                  <th key={k.key} className="hud-label py-1.5 pr-3 text-right font-normal">
                    {k.label}
                  </th>
                ))}
                <th className="hud-label py-1.5 text-right font-normal">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[...buckets].reverse().map((b) => (
                <tr key={b.t}>
                  <td className="py-1.5 pr-3 font-hud text-[12px] text-ink-2">{report.bucket === 'hour' ? `${utcDay(b.t)} ${utcTime(b.t)}` : utcDay(b.t)}</td>
                  {present.map((k) => (
                    <td key={k.key} className="py-1.5 pr-3 text-right font-hud text-[12px]" style={num}>
                      {b.parts[k.key] ? usd(b.parts[k.key]!) : '—'}
                    </td>
                  ))}
                  <td className="py-1.5 text-right font-hud text-[12px] text-ink" style={num}>
                    {b.total ? usd(b.total) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ShareRow({ label, color, cost, total, detail, to }: { label: string; color?: string; cost: number; total: number; detail: string; to?: string }) {
  const pct = total ? (cost / total) * 100 : 0;
  const name = (
    <span className="flex min-w-0 items-center gap-2">
      {color && <span className="size-2 shrink-0 rounded-[2px]" style={{ background: color }} aria-hidden />}
      <span className="truncate text-[13.5px]">{label}</span>
    </span>
  );
  return (
    <li className="py-2">
      <div className="flex items-center gap-3">
        {to ? (
          <Link to={to} className="min-w-0 flex-1 hover:text-sky">
            {name}
          </Link>
        ) : (
          <span className="min-w-0 flex-1">{name}</span>
        )}
        <span className="font-hud text-[12.5px]" style={num}>
          {usd(cost)}
        </span>
        <span className="w-10 text-right font-hud text-[11px] text-ink-3" style={num}>
          {Math.round(pct)}%
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        <div className="h-1 flex-1 overflow-hidden rounded-[1px] bg-surface-2">
          <div className="h-full rounded-[1px]" style={{ width: `${pct}%`, background: color ?? 'var(--sky)' }} />
        </div>
        <span className="w-40 truncate text-right text-[11.5px] text-ink-3">{detail}</span>
      </div>
    </li>
  );
}

function PlanLimits() {
  const limits = useStore((s) => s.usage?.limits);
  const source = useStore((s) => s.status?.claudeAuth.source);
  return (
    <Panel id="limits" label="Claude plan limits" right={limits?.updatedAt ? <span className="hud-label">updated {timeAgo(limits.updatedAt)}</span> : undefined}>
      {!limits?.available || limits.windows.length === 0 ? (
        <p className="text-[13.5px] text-ink-2">
          {source === 'api_key'
            ? 'You are on an API key, so there are no plan windows — spend is the limit. Set a budget below to cap it.'
            : 'Plan usage for Claude Pro and Max appears here after the next turn finishes. API-key accounts have no plan windows.'}
        </p>
      ) : (
        <ul className="space-y-4">
          {limits.windows.map((w) => (
            <li key={w.kind}>
              <div className="mb-1.5 flex items-baseline gap-3">
                <span className="text-[13.5px]">{w.label}</span>
                <span className="ml-auto font-hud text-[13px]" style={num}>
                  {w.percent === null ? '—' : `${Math.round(w.percent)}%`}
                </span>
              </div>
              <Meter percent={w.percent} severity={w.severity === 'normal' ? severityFor(w.percent) : w.severity} label={`${w.label} used`} />
              {w.resetsAt && <div className="mt-1 text-[11.5px] text-ink-3">Resets in {span((w.resetsAt - Date.now()) / 1000)}</div>}
            </li>
          ))}
          {limits.status === 'rejected' && <li className="text-[13px] text-bad">A plan limit is reached — Claude refuses new turns until the window resets.</li>}
        </ul>
      )}
    </Panel>
  );
}

function Budgets() {
  const budget = useStore((s) => s.usage?.budget);
  const [form, setForm] = useState<Pick<AppSettings, 'budgetDailyUsd' | 'budgetMonthlyUsd' | 'budgetWarnPercent' | 'budgetEnforce'> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ settings: AppSettings }>('/api/settings').then(({ settings: s }) =>
      setForm({ budgetDailyUsd: s.budgetDailyUsd, budgetMonthlyUsd: s.budgetMonthlyUsd, budgetWarnPercent: s.budgetWarnPercent, budgetEnforce: s.budgetEnforce }),
    );
  }, []);
  if (!form) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put('/api/settings', { ...form });
      toast('success', 'Budgets saved');
    } catch (err) {
      toast('error', 'Budgets not saved', err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const periods = budget ? [budget.day, budget.month] : [];
  return (
    <Panel id="budgets" label="Budgets">
      {periods.some((p) => p.limitUsd) && (
        <ul className="mb-5 space-y-4">
          {periods
            .filter((p) => p.limitUsd)
            .map((p) => (
              <li key={p.period}>
                <div className="mb-1.5 flex items-baseline gap-3">
                  <span className="text-[13.5px]">{p.period === 'day' ? 'Today' : 'This month'}</span>
                  {p.state !== 'ok' && (
                    <span className="annun" data-lit={p.state === 'over' ? 'warning' : 'caution'}>
                      {p.state === 'over' ? 'Over budget' : 'Near budget'}
                    </span>
                  )}
                  <span className="ml-auto font-hud text-[13px]" style={num}>
                    {usd(p.spentUsd)} / {usd(p.limitUsd!)}
                  </span>
                </div>
                <Meter percent={p.percent} severity={p.state === 'over' ? 'critical' : p.state === 'warn' ? 'warning' : 'normal'} marker={budget!.warnPercent} label={`${p.period} budget used`} />
                <div className="mt-1 text-[11.5px] text-ink-3">Resets in {span((p.resetsAt - Date.now()) / 1000)}</div>
              </li>
            ))}
        </ul>
      )}
      <form onSubmit={save} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Daily cap (USD)" hint="Per UTC day. Empty = no cap.">
            <Input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={form.budgetDailyUsd ?? ''}
              onChange={(e) => setForm({ ...form, budgetDailyUsd: e.target.value === '' ? null : Number(e.target.value) })}
              placeholder="No cap"
            />
          </Field>
          <Field label="Monthly cap (USD)" hint="Per UTC calendar month.">
            <Input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={form.budgetMonthlyUsd ?? ''}
              onChange={(e) => setForm({ ...form, budgetMonthlyUsd: e.target.value === '' ? null : Number(e.target.value) })}
              placeholder="No cap"
            />
          </Field>
          <Field label="Warn at (%)" hint="Notify once per period.">
            <Input type="number" min={1} max={100} value={form.budgetWarnPercent} onChange={(e) => setForm({ ...form, budgetWarnPercent: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-md border border-line px-3 py-2.5">
          <span className="text-[13.5px]">
            <span className="font-medium">Pause new messages at the cap</span>
            <span className="block text-[12px] text-ink-3">Turns already running finish. Off = warn only.</span>
          </span>
          <Toggle checked={form.budgetEnforce} onChange={(v) => setForm({ ...form, budgetEnforce: v })} label="Pause new messages at the cap" />
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" busy={busy}>
            Save budgets
          </Button>
        </div>
      </form>
    </Panel>
  );
}

export function UsagePage() {
  const [range, setRange] = useState<UsageRange>(() => (localStorage.getItem('cloude.usageRange') as UsageRange) || '7d');
  const [report, setReport] = useState<UsageReport | null>(null);
  const turns = useStore((s) => s.usage?.today.turns);

  useEffect(() => {
    localStorage.setItem('cloude.usageRange', range);
    api
      .get<UsageReport>(`/api/usage?range=${range}`)
      .then(setReport)
      .catch(() => {});
  }, [range, turns]);

  useEffect(() => {
    if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth' }), 80);
  }, []);

  const t = report?.totals;
  const p = report?.previous;
  const delta = (cur: number, prev: number, upIsGood = false) => {
    const text = changeVs(cur, prev);
    return text ? { text, good: cur === prev ? null : (cur > prev) === upIsGood } : null;
  };
  const cacheShare = t ? t.cacheReadTokens / Math.max(1, t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens) : 0;

  return (
    <Shell>
      <Page wide>
        <PageHeader
          title="Usage"
          subtitle="Claude spend and tokens, booked per turn and model. Estimates from Claude Code, in UTC."
          actions={<Segmented label="Range" value={range} onChange={setRange} options={RANGES} />}
        />

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Totals">
          <StatTile label={`Spend · ${range}`} value={t ? usd(t.costUsd) : '—'} delta={t && p ? delta(t.costUsd, p.costUsd) : null} sub="vs the previous period" />
          <StatTile label="Tokens processed" value={t ? compact(tokensOf(t)) : '—'} delta={t && p ? delta(tokensOf(t), tokensOf(p)) : null} sub={t ? `${compact(t.inputTokens)} in · ${compact(t.outputTokens)} out` : undefined} />
          <StatTile label="Read from cache" value={t ? `${Math.round(cacheShare * 100)}%` : '—'} sub={t ? `${compact(t.cacheReadTokens)} cached input tokens` : undefined} />
          <StatTile label="Turns" value={t ? compact(t.turns) : '—'} sub={t && t.turns ? `${usd(t.costUsd / t.turns)} per turn on average` : 'One per finished reply, per model'} />
        </section>

        {report && <SpendChart report={report} />}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Panel label="Models">
            {!report?.models.length ? (
              <p className="py-6 text-center text-[13px] text-ink-3">No usage in this range.</p>
            ) : (
              <ul className="divide-y divide-line">
                {report.models.map((m) => (
                  <ShareRow
                    key={m.model}
                    label={modelName(m.model)}
                    color={modelSlot(m.model).color}
                    cost={m.costUsd}
                    total={report.totals.costUsd}
                    detail={`${compact(m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens)} in · ${compact(m.outputTokens)} out`}
                  />
                ))}
              </ul>
            )}
          </Panel>
          <Panel label="Projects">
            {!report?.projects.length ? (
              <p className="py-6 text-center text-[13px] text-ink-3">No usage in this range.</p>
            ) : (
              <ul className="divide-y divide-line">
                {report.projects.map((pr) => (
                  <ShareRow
                    key={pr.projectId}
                    label={pr.name ?? 'Deleted project'}
                    cost={pr.costUsd}
                    total={report.totals.costUsd}
                    detail={`${compact(tokensOf(pr))} tokens · ${pr.turns} turns`}
                    to={pr.name ? `/p/${pr.projectId}` : undefined}
                  />
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <Panel label="Top sessions" bodyClassName="p-0">
          {!report?.sessions.length ? (
            <p className="px-3.5 py-6 text-center text-[13px] text-ink-3">No sessions used Claude in this range.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left">
                    <th className="hud-label px-3.5 py-2 font-normal">Session</th>
                    <th className="hud-label px-3 py-2 text-right font-normal">Turns</th>
                    <th className="hud-label px-3 py-2 text-right font-normal">Tokens</th>
                    <th className="hud-label px-3 py-2 text-right font-normal">Spend</th>
                    <th className="hud-label px-3.5 py-2 text-right font-normal">Last</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {report.sessions.map((s) => (
                    <tr key={s.sessionId} className="hover:bg-surface-2">
                      <td className="max-w-0 px-3.5 py-2">
                        {s.title ? (
                          <Link to={`/p/${s.projectId}/s/${s.sessionId}`} className="block truncate hover:text-sky">
                            {s.title}
                          </Link>
                        ) : (
                          <span className="text-ink-3">Deleted session</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-hud text-[12px] text-ink-2" style={num}>
                        {s.turns}
                      </td>
                      <td className="px-3 py-2 text-right font-hud text-[12px] text-ink-2" style={num}>
                        {compact(tokensOf(s))}
                      </td>
                      <td className="px-3 py-2 text-right font-hud text-[12px]" style={num}>
                        {usd(s.costUsd)}
                      </td>
                      <td className="px-3.5 py-2 text-right text-[12px] text-ink-3">{timeAgo(s.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <PlanLimits />
          <Budgets />
        </div>
      </Page>
    </Shell>
  );
}
