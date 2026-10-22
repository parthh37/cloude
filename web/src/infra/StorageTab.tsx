import clsx from 'clsx';
import { ChevronDown, ChevronRight, HardDrive, Sparkles, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CleanerCategory, CleanerPolicy, CleanerRun, CleanerTrigger, StorageReport } from '../../../shared/protocol';
import { Badge, Button, Field, Input, Select, Toggle } from '../components/ui';
import { api } from '../lib/api';
import { bytes, timeAgo } from '../lib/format';
import { toast } from '../lib/store';
import { Card, Hint, Meter, err, minutes, usePoll } from './shared';

const RISKY: CleanerCategory[] = ['docker_global', 'artifacts'];
const TRIGGER_LABEL: Record<CleanerTrigger, string> = { off: 'Off', schedule: 'On schedule', pressure: 'Only when disk is low' };

function RunRow({ r }: { r: CleanerRun }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-2 text-sm">
      <button className="flex w-full items-center gap-3 text-left" onClick={() => setOpen(!open)}>
        <span className="w-24 shrink-0 text-xs text-ink-3">{timeAgo(r.startedAt)}</span>
        <Badge tone={r.trigger === 'pressure' ? 'break' : r.trigger === 'manual' ? 'sky' : 'neutral'}>{r.trigger.replace('_', ' ')}</Badge>
        <span className="font-medium">{bytes(r.freedBytes)}</span>
        <span className="text-ink-3">{r.removed} item(s)</span>
        {r.errors.length > 0 && <Badge tone="bad">{r.errors.length} error(s)</Badge>}
        <span className="ml-auto text-ink-3">{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1 pl-28 text-xs text-ink-2">
          {Object.entries(r.byCategory).map(([c, b]) => (
            <div key={c}>
              {c}: {bytes(b ?? 0)}
            </div>
          ))}
          {r.errors.map((e, i) => (
            <div key={i} className="text-bad">
              {e}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function PolicyCard({ policy, onSaved }: { policy: CleanerPolicy; onSaved: (r: StorageReport) => void }) {
  const [p, setP] = useState(policy);
  const [busy, setBusy] = useState(false);
  useEffect(() => setP(policy), [policy]);
  const num = (k: keyof CleanerPolicy, label: string, hint?: string, unit?: string) => (
    <Field label={label} hint={hint ?? (unit === 'min' ? minutes(Number(p[k])) : undefined)}>
      <Input type="number" min={0} value={String(p[k])} onChange={(e) => setP({ ...p, [k]: Number(e.target.value) })} />
    </Field>
  );
  const dirty = JSON.stringify(p) !== JSON.stringify(policy);
  return (
    <Card
      title="Policy"
      description="When the cleaner runs and what “work done” means for sandboxes."
      actions={
        <>
          <label className="flex items-center gap-2 text-sm font-medium">
            <Toggle checked={p.enabled} onChange={(v) => setP({ ...p, enabled: v })} label="Automatic cleaning" />
            Automatic
          </label>
          <Button
            variant="primary"
            disabled={!dirty}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                onSaved(await api.put<StorageReport>('/api/infra/storage/policy', { ...p }));
                toast('success', 'Cleaner policy saved');
              } catch (e) {
                toast('error', 'Could not save', err(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {num('intervalMinutes', 'Run every (min)', undefined, 'min')}
        {num('minFreePercent', 'Disk is “low” below (%)')}
        {num('minFreeGb', '…or below (GB)')}
        {num('sessionDoneGraceMinutes', 'Session done after (min idle)', 'Then its sandboxes are stopped', 'min')}
        {num('sandboxIdleStopMinutes', 'Stop idle sandbox after (min)', 'Frees CPU & RAM; wakes on next use', 'min')}
        {num('sandboxIdleDestroyMinutes', 'Destroy unused sandbox after (min)', 'Frees disk — unless pinned', 'min')}
        {num('snapshotKeep', 'Snapshots kept per sandbox')}
        {num('tmpMaxAgeHours', 'Temp files older than (h)')}
        {num('artifactIdleDays', 'Project idle for (days)', 'Before its build artifacts count as reclaimable')}
      </div>
    </Card>
  );
}

export function StorageTab() {
  const [r, setReport] = useState<StorageReport | null>(null);
  const [busy, setBusy] = useState<'scan' | 'clean' | string | null>(null);
  const [open, setOpen] = useState<Set<CleanerCategory>>(new Set());
  const { data, reload } = usePoll(() => api.get<StorageReport>('/api/infra/storage'), 10_000);
  // Polls refresh disk, runs and policy; an automatic cleanup clears the server's scan cache,
  // so keep showing the last scan's categories until the next scan replaces them.
  useEffect(() => {
    if (data) setReport((prev) => (data.scannedAt || !prev?.scannedAt ? data : { ...data, categories: prev.categories, scannedAt: prev.scannedAt }));
  }, [data]);

  const scan = async () => {
    setBusy('scan');
    try {
      setReport(await api.post<StorageReport>('/api/infra/storage/scan'));
    } catch (e) {
      toast('error', 'Scan failed', err(e));
    } finally {
      setBusy(null);
    }
  };
  // First visit: measure what's reclaimable.
  useEffect(() => {
    void scan();
  }, []);

  const clean = async (categories?: CleanerCategory[]) => {
    setBusy(categories?.[0] ?? 'clean');
    try {
      const res = await api.post<{ run: CleanerRun | null; report: StorageReport }>('/api/infra/storage/clean', categories ? { categories } : {});
      setReport(res.report);
      toast(res.run?.errors.length ? 'warning' : 'success', res.run ? `Freed ${bytes(res.run.freedBytes)}` : 'Nothing to clean', res.run?.errors[0]);
      void reload();
    } catch (e) {
      toast('error', 'Cleanup failed', err(e));
    } finally {
      setBusy(null);
    }
  };

  const setTrigger = async (c: CleanerCategory, t: CleanerTrigger) => {
    if (!r) return;
    if (RISKY.includes(c) && t !== 'off' && !confirm(c === 'docker_global' ? 'This prunes dangling images and old build cache for the WHOLE Docker host, including projects outside Cloude. Enable?' : 'This deletes node_modules, virtualenvs, target/ etc. in projects idle past the threshold (never ones with deployments). Enable?')) return;
    try {
      setReport(await api.put<StorageReport>('/api/infra/storage/policy', { categories: { ...r.policy.categories, [c]: t } }));
    } catch (e) {
      toast('error', 'Could not save', err(e));
    }
  };

  if (!r) return <Card title="Storage">Loading…</Card>;
  const used = r.disk ? r.disk.total - r.disk.free : 0;
  const reclaimable = r.categories.reduce((n, c) => n + c.bytes, 0);

  return (
    <div className="space-y-5">
      <Card
        title={
          <span className="flex items-center gap-2">
            <HardDrive className="size-5 text-dawn" /> Storage cleaner
          </span>
        }
        description="Frees disk and memory automatically once work is done. It only removes what this Cloude install created or what is safe to rebuild — never your source code, databases, secrets or deployments."
        actions={
          <>
            <Button size="sm" onClick={scan} busy={busy === 'scan'}>
              Scan
            </Button>
            <Button size="sm" variant="primary" icon={<Sparkles className="size-3.5" />} onClick={() => clean()} busy={busy === 'clean'} disabled={!!busy || r.running}>
              Clean now
            </Button>
          </>
        }
      >
        {r.disk ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span>
                <strong className="font-semibold">{bytes(r.disk.free)}</strong> free of {bytes(r.disk.total)}
                {r.pressure && (
                  <Badge tone="break" className="ml-2">
                    <TriangleAlert className="size-3" /> low on space
                  </Badge>
                )}
              </span>
              <span className="text-ink-2">
                {r.scannedAt ? (
                  <>
                    <strong className="font-semibold">{bytes(reclaimable)}</strong> reclaimable · scanned {timeAgo(r.scannedAt)}
                  </>
                ) : busy === 'scan' ? (
                  'Scanning…'
                ) : (
                  'Not scanned yet'
                )}
              </span>
            </div>
            <Meter used={used} total={r.disk.total} warn={r.pressure} />
            <Hint>Measured on {r.disk.path}. Docker images and containers may live on a different disk (e.g. the Docker Desktop VM).</Hint>
          </div>
        ) : (
          <Hint>Disk usage is not available on this platform.</Hint>
        )}
      </Card>

      <Card title="What gets cleaned" description="Choose when each category is cleaned automatically. “Clean” on a row runs it now, whatever its setting.">
        <ul className="divide-y divide-line">
          {r.categories.map((c) => {
            const isOpen = open.has(c.category);
            const sandboxCat = c.category === 'sandboxes';
            return (
              <li key={c.category} className="py-3">
                <div className="flex flex-wrap items-start gap-3">
                  <button
                    className="mt-0.5 text-ink-3 disabled:opacity-30"
                    disabled={!c.items.length}
                    aria-label={isOpen ? 'Hide items' : 'Show items'}
                    onClick={() => setOpen((s) => (s.has(c.category) ? new Set([...s].filter((x) => x !== c.category)) : new Set([...s, c.category])))}
                  >
                    {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      {c.label}
                      {RISKY.includes(c.category) && <Badge tone="break">opt-in</Badge>}
                      <span className="font-normal text-ink-2">
                        {c.items.length ? `${bytes(c.bytes)} · ${c.items.length} item(s)` : r.scannedAt ? 'nothing to clean' : ''}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-3">{c.description}</p>
                  </div>
                  <Select
                    aria-label={`When to clean ${c.label}`}
                    className="h-8 w-48 text-[13px]"
                    value={sandboxCat ? (c.trigger === 'off' ? 'off' : 'schedule') : c.trigger}
                    onChange={(e) => setTrigger(c.category, e.target.value as CleanerTrigger)}
                  >
                    {sandboxCat ? (
                      <>
                        <option value="schedule">When work is done</option>
                        <option value="off">Off</option>
                      </>
                    ) : (
                      (Object.keys(TRIGGER_LABEL) as CleanerTrigger[]).map((t) => (
                        <option key={t} value={t}>
                          {TRIGGER_LABEL[t]}
                        </option>
                      ))
                    )}
                  </Select>
                  <Button size="sm" variant="ghost" busy={busy === c.category} disabled={!!busy || !c.items.length} onClick={() => clean([c.category])}>
                    Clean
                  </Button>
                </div>
                {isOpen && (
                  <ul className={clsx('mt-2 ml-7 space-y-1 rounded-lg border border-line bg-surface-2 p-2 text-xs')}>
                    {c.items.map((i) => (
                      <li key={i.id} className="flex gap-3">
                        <span className="min-w-0 flex-1 truncate font-mono" title={i.label}>
                          {i.label}
                        </span>
                        <span className="text-ink-3">{i.reason}</span>
                        <span className="w-20 text-right">{i.bytes ? bytes(i.bytes) : '—'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <PolicyCard policy={r.policy} onSaved={setReport} />

      <Card title="History">
        {r.runs.length === 0 ? (
          <Hint>No cleanups yet. Automatic runs appear here once they remove something.</Hint>
        ) : (
          <ul className="divide-y divide-line">
            {r.runs.map((run) => (
              <RunRow key={run.id} r={run} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
