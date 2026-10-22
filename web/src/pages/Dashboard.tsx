import clsx from 'clsx';
import { FolderGit2, FolderPlus, GitBranch, HardDrive, Plus, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { Project, Session, UsageReport } from '../../../shared/protocol';
import { Meter, PageHeader, Panel, StatTile, severityFor } from '../components/hud';
import { ActivityLine, PendingAsk } from '../components/SessionLive';
import { Page, Shell } from '../components/Shell';
import { Button, Dialog, Empty, Field, Input } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { changeVs, compact, modelName, modelSlot, span, timeAgo, usd, utcTime } from '../lib/format';
import { useMetricsStream } from '../lib/live';
import { useStore } from '../lib/store';

const tokensOf = (t: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;

/** One dot per session: magenta = Claude working, amber = needs you, red = failed, dim = idle. */
function SessionDots({ sessions }: { sessions: Session[] }) {
  const shown = sessions.slice(0, 6);
  const working = sessions.filter((s) => s.status === 'running' || s.status === 'starting').length;
  const waiting = sessions.filter((s) => s.status === 'awaiting_input').length;
  return (
    <span className="flex items-center gap-1" aria-label={`${sessions.length} sessions: ${working} working, ${waiting} waiting on you`} title={`${working} working · ${waiting} waiting`}>
      {shown.map((s) => (
        <span
          key={s.id}
          className={clsx(
            'size-2 rounded-full',
            s.status === 'running' || s.status === 'starting' ? 'bg-dawn' : s.status === 'awaiting_input' ? 'bg-break' : s.status === 'error' ? 'bg-bad' : 'border border-line-strong',
          )}
        />
      ))}
      {sessions.length > shown.length && <span className="font-hud text-[10px] text-ink-3">+{sessions.length - shown.length}</span>}
    </span>
  );
}

function useReport24h() {
  const turns = useStore((s) => s.usage?.today.turns);
  const [report, setReport] = useState<UsageReport | null>(null);
  useEffect(() => {
    api
      .get<UsageReport>('/api/usage?range=24h')
      .then(setReport)
      .catch(() => {});
  }, [turns]);
  return report;
}

export function Dashboard() {
  useMetricsStream(false);
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const status = useStore((s) => s.status);
  const services = useStore((s) => s.services);
  const usage = useStore((s) => s.usage);
  const history = useStore((s) => s.metrics.history);
  const report = useReport24h();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(params.get('new') === 'project');

  useEffect(() => {
    if (params.get('new') === 'project') {
      setOpen(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const { byProject, needsYou, working } = useMemo(() => {
    const list = Object.values(sessions).filter((s) => !s.archived);
    const m: Record<string, Session[]> = {};
    for (const s of list) (m[s.projectId] ??= []).push(s);
    for (const k of Object.keys(m)) m[k]!.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      byProject: m,
      needsYou: list.filter((s) => s.status === 'awaiting_input'),
      working: list.filter((s) => s.status === 'running' || s.status === 'starting'),
    };
  }, [sessions]);

  const titles = useMemo(() => new Map(Object.values(sessions).map((s) => [s.id, s])), [sessions]);
  const last = history[history.length - 1];
  const cpuTrend = useMemo(() => history.slice(-60).map((h) => h.cpu), [history]);
  const fiveHour = usage?.limits.available ? usage.limits.windows.find((w) => w.kind === 'five_hour') : undefined;
  const day = usage?.budget.day;
  const t = report?.totals;

  const subtitle =
    working.length || needsYou.length
      ? [working.length && `${working.length} ${working.length === 1 ? 'session' : 'sessions'} working`, needsYou.length && `${needsYou.length} waiting on you`]
          .filter(Boolean)
          .join(' · ')
      : 'All quiet on the server.';

  return (
    <Shell>
      <Page wide>
        <PageHeader
          title="Ops"
          subtitle={subtitle}
          actions={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
              New project
            </Button>
          }
        />

        {status && !status.claudeAuth.configured && (
          <Link to="/settings#claude" className="flex items-start gap-3 rounded-lg border border-break/50 bg-break-soft px-4 py-3 text-break-ink hover:border-break">
            <TriangleAlert className="mt-0.5 size-5 shrink-0" />
            <span>
              <strong className="font-bold">Claude isn't connected yet.</strong> Add an Anthropic API key or a Claude subscription token in Settings before starting a
              session.
            </span>
          </Link>
        )}

        {needsYou.length > 0 && (
          <section className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2" aria-label="Sessions waiting on you">
            {needsYou.map((s) => (
              <div key={s.id} className="rounded-lg border border-break/50 bg-surface p-2.5">
                <Link to={`/p/${s.projectId}/s/${s.id}`} className="group flex items-center gap-3 px-1">
                  <span className="annun" data-lit="caution" data-flash="">
                    Needs you
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
                  <span className="text-[13px] text-break-ink group-hover:underline">Open →</span>
                </Link>
                <PendingAsk sessionId={s.id} className="mt-2" />
              </div>
            ))}
          </section>
        )}

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Telemetry">
          <StatTile
            label="Spend · last 24h"
            value={t ? usd(t.costUsd) : '—'}
            delta={t && changeVs(t.costUsd, report!.previous.costUsd) ? { text: changeVs(t.costUsd, report!.previous.costUsd)!, good: t.costUsd <= report!.previous.costUsd } : null}
            sub={usage ? `${usd(usage.month.costUsd)} this month (UTC)` : undefined}
            trend={report?.series.map((s) => s.costUsd)}
          />
          <StatTile
            label="Tokens · last 24h"
            value={t ? compact(tokensOf(t)) : '—'}
            sub={t && tokensOf(t) > 0 ? `${compact(t.outputTokens)} out · ${Math.round((t.cacheReadTokens / Math.max(1, t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens)) * 100)}% from cache` : 'Nothing booked yet'}
            trend={report?.series.map((s) => s.tokens)}
          />
          {fiveHour ? (
            <StatTile
              label="Plan · 5-hour window"
              value={fiveHour.percent === null ? '—' : `${Math.round(fiveHour.percent)}%`}
              sub={fiveHour.resetsAt ? `resets in ${span((fiveHour.resetsAt - Date.now()) / 1000)}` : usage?.limits.subscription ?? undefined}
              footer={<Meter percent={fiveHour.percent} severity={severityFor(fiveHour.percent)} label="5-hour plan usage" />}
            />
          ) : day?.limitUsd ? (
            <StatTile
              label="Budget · today (UTC)"
              value={`${Math.round(day.percent ?? 0)}%`}
              sub={`${usd(day.spentUsd)} of ${usd(day.limitUsd)}`}
              footer={<Meter percent={day.percent} severity={day.state === 'over' ? 'critical' : day.state === 'warn' ? 'warning' : 'normal'} marker={usage!.budget.warnPercent} label="Daily budget used" />}
            />
          ) : (
            <StatTile
              label="Plan limits"
              value="—"
              sub={status?.claudeAuth.source === 'api_key' ? 'API key: no plan limits. Set a budget in Usage.' : 'Appear after the next turn on a Pro/Max plan.'}
            />
          )}
          <StatTile
            label="Server · CPU"
            value={last ? `${Math.round(last.cpu)}%` : '—'}
            sub={last ? `mem ${Math.round((last.memUsed / last.memTotal) * 100)}% · load ${last.load[0].toFixed(2)}` : 'Sampling…'}
            trend={cpuTrend.length > 1 ? cpuTrend : undefined}
            trendColor="var(--ok)"
          />
        </section>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <Panel label={`Projects · ${projects.length}`} className="lg:col-span-2" bodyClassName="p-0">
            {projects.length === 0 ? (
              <Empty
                icon={<FolderGit2 className="size-8" />}
                title="No projects yet"
                action={
                  <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
                    New project
                  </Button>
                }
              >
                Start an empty project, clone a Git repository, or open a folder that's already on the server.
              </Empty>
            ) : (
              <ul className="divide-y divide-line">
                {projects.map((p) => {
                  const ps = byProject[p.id] ?? [];
                  const cost = ps.reduce((n, s) => n + s.totalCostUsd, 0);
                  const apps = services.filter((x) => x.projectId === p.id && x.status === 'running').length;
                  const latest = ps[0];
                  const flying = ps.find((s) => s.status === 'running' || s.status === 'starting');
                  return (
                    <li key={p.id}>
                      <Link to={`/p/${p.id}`} className="flex items-center gap-4 px-3.5 py-3 transition-colors hover:bg-surface-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-display text-[15px] font-bold">{p.name}</div>
                          {flying ? (
                            <ActivityLine session={flying} dot={false} />
                          ) : (
                            <div className="truncate text-[12.5px] text-ink-3">
                              {latest ? (
                                <>
                                  {latest.title} · {timeAgo(latest.updatedAt)}
                                </>
                              ) : (
                                <span className="font-mono text-[11.5px]">{p.path}</span>
                              )}
                            </div>
                          )}
                        </div>
                        <SessionDots sessions={ps} />
                        <div className="hidden w-20 text-right sm:block">
                          {apps > 0 ? (
                            <span className="annun" data-lit="ok">
                              Apps <b>{apps}</b>
                            </span>
                          ) : (
                            <span className="hud-label">no apps</span>
                          )}
                        </div>
                        <div className="w-16 text-right font-hud text-[12.5px] text-ink-2" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {cost > 0 ? usd(cost) : '—'}
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel label="Activity" right={<Link to="/usage" className="hud-label hover:text-sky">Usage →</Link>} bodyClassName="p-0">
            {!usage?.recent.length ? (
              <p className="px-3.5 py-8 text-center text-[13px] text-ink-3">No turns booked yet. Start a session in a project and its spend shows up here.</p>
            ) : (
              <ul className="divide-y divide-line">
                {usage.recent.map((r) => {
                  const slot = modelSlot(r.model);
                  const s = titles.get(r.sessionId);
                  return (
                    <li key={r.id}>
                      <Link to={s ? `/p/${r.projectId}/s/${r.sessionId}` : '/usage'} className="flex items-center gap-3 px-3.5 py-2 hover:bg-surface-2">
                        <span className="font-hud text-[11px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {utcTime(r.at)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px]">{r.title ?? s?.title ?? 'Deleted session'}</span>
                          <span className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                            <span className="size-1.5 rounded-[1px]" style={{ background: slot.color }} aria-hidden />
                            {modelName(r.model)} · {compact(r.tokens)} tok
                          </span>
                        </span>
                        <span className="font-hud text-[12px] text-ink-2" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          +{usd(r.costUsd)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>
      </Page>
      <NewProjectDialog open={open} onClose={() => setOpen(false)} />
    </Shell>
  );
}

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [source, setSource] = useState<'empty' | 'git' | 'path'>('empty');
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.post<{ project: Project }>('/api/projects', {
        name,
        ...(source === 'git' ? { gitUrl, branch: branch || undefined } : {}),
        ...(source === 'path' ? { existingPath: path } : {}),
      });
      useStore.setState((s) => ({ projects: [project, ...s.projects] }));
      onClose();
      navigate(`/p/${project.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const tabs = [
    { id: 'empty', label: 'Start fresh', icon: FolderPlus },
    { id: 'git', label: 'Clone a repo', icon: GitBranch },
    { id: 'path', label: 'Open a folder', icon: HardDrive },
  ] as const;

  return (
    <Dialog open={open} onClose={onClose} title="New project">
      <form onSubmit={create} className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {tabs.map((t) => (
            <button
              type="button"
              key={t.id}
              onClick={() => setSource(t.id)}
              className={clsx(
                'flex flex-col items-center gap-1.5 rounded-md border px-2 py-3 text-[13px] transition-colors',
                source === t.id ? 'border-sky bg-sky-soft text-ink' : 'border-line text-ink-2 hover:border-line-strong',
              )}
            >
              <t.icon className="size-5" />
              {t.label}
            </button>
          ))}
        </div>
        {source === 'git' && (
          <>
            <Field label="Repository URL" hint="Private GitHub repos work once a GH_TOKEN secret is set in Settings.">
              <Input value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="https://github.com/you/app.git" required />
            </Field>
            <Field label="Branch (optional)">
              <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
            </Field>
          </>
        )}
        {source === 'path' && (
          <Field label="Folder on the server" hint="An absolute path to an existing directory.">
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/code/app" required />
          </Field>
        )}
        <Field label={source === 'empty' ? 'Name' : 'Name (optional)'}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app" required={source === 'empty'} />
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {source === 'git' ? 'Clone project' : 'Create project'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

