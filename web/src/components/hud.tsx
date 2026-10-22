import clsx from 'clsx';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// Instrument-panel building blocks: panels, stat tiles, meters and hand-rolled
// SVG charts. Chart rules: 2px lines, ≤24px bars with a 4px rounded data end,
// a 2px surface gap between stacked segments, hairline solid grid, text in ink
// tokens (never the series colour), a legend for ≥2 series, hover + keyboard
// read-out on every plot.

// ---- layout ---------------------------------------------------------------------

export function Panel({
  label,
  right,
  children,
  className,
  bodyClassName,
  id,
}: {
  label: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section id={id} className={clsx('min-w-0 scroll-mt-20 rounded-lg border border-line bg-surface shadow-cloud', className)}>
      <header className="flex min-h-10 items-center gap-2 border-b border-line px-3.5 py-2">
        <h2 className="hud-label">{label}</h2>
        {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
      </header>
      <div className={clsx('p-3.5', bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-[26px] leading-tight font-bold tracking-[0.01em]">{title}</h1>
        {subtitle && <p className="mt-1 text-[14px] text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Segmented control (range pickers, chart/table toggles). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'h-7 rounded-[4px] px-2.5 font-hud text-[11px] tracking-[0.06em] uppercase transition-colors',
            value === o.value ? 'bg-sky-soft text-sky' : 'text-ink-3 hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- figures ----------------------------------------------------------------------

export interface Delta {
  text: string;
  /** true = good news, false = bad news, null = neutral */
  good: boolean | null;
}

export function StatTile({
  label,
  value,
  sub,
  delta,
  trend,
  trendColor = 'var(--sky)',
  footer,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  delta?: Delta | null;
  trend?: number[];
  trendColor?: string;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex min-w-0 flex-col rounded-lg border border-line bg-surface p-3.5 shadow-cloud', className)}>
      <div className="flex items-center gap-2">
        <span className="hud-label truncate">{label}</span>
        {delta && (
          <span className={clsx('ml-auto font-hud text-[11px] whitespace-nowrap', delta.good === null ? 'text-ink-3' : delta.good ? 'text-ok' : 'text-bad')}>
            {delta.text}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-end gap-3">
        <div className="min-w-0">
          <div className="hud-num truncate text-[26px] leading-none">{value}</div>
          {sub && <div className="mt-1.5 truncate text-[12.5px] text-ink-3">{sub}</div>}
        </div>
        {trend && trend.length > 1 && <Sparkline values={trend} color={trendColor} className="ml-auto h-9 w-24 shrink-0" />}
      </div>
      {footer && <div className="mt-3">{footer}</div>}
    </div>
  );
}

/** Trend in the de-emphasis ink, with the current value marked in the accent. */
export function Sparkline({ values, color = 'var(--sky)', className }: { values: number[]; color?: string; className?: string }) {
  const w = 96;
  const h = 36;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [2 + (i / (values.length - 1)) * (w - 8), 4 + (1 - (v - min) / span) * (h - 8)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  const [lx, ly] = pts[pts.length - 1]!;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} preserveAspectRatio="none" aria-hidden>
      <path d={`${d}L${lx} ${h - 2}L${pts[0]![0]} ${h - 2}Z`} fill={color} opacity={0.1} />
      <path d={d} fill="none" stroke="var(--ink-3)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lx} cy={ly} r={3} fill={color} stroke="var(--surface)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export type Severity = 'normal' | 'warning' | 'critical';
const SEVERITY_COLOR: Record<Severity, string> = { normal: 'var(--sky)', warning: 'var(--break)', critical: 'var(--bad)' };

/** Horizontal meter. Fill colour carries severity; the track is the same hue, dimmed. */
export function Meter({ percent, severity = 'normal', marker, label }: { percent: number | null; severity?: Severity; marker?: number; label: string }) {
  const p = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const color = SEVERITY_COLOR[severity];
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent === null ? undefined : Math.round(p)}
      className="relative h-2 w-full overflow-hidden rounded-[2px]"
      style={{ background: `color-mix(in oklab, ${color} 16%, var(--surface-2))` }}
    >
      <div className="absolute inset-y-0 left-0 rounded-[2px] transition-[width] duration-500" style={{ width: `${p}%`, background: color }} />
      {marker !== undefined && <div className="absolute inset-y-0 w-px bg-ink-2/70" style={{ left: `${marker}%` }} aria-hidden />}
    </div>
  );
}

export const severityFor = (pct: number | null, warnAt = 75, critAt = 95): Severity =>
  pct === null ? 'normal' : pct >= critAt ? 'critical' : pct >= warnAt ? 'warning' : 'normal';

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3.5 gap-y-1">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5 text-[12px] text-ink-2">
          <span className="size-2 rounded-[2px]" style={{ background: it.color }} aria-hidden />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

// ---- charts -------------------------------------------------------------------------

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A clean axis ceiling whose half is also clean (ticks are 0, ½, max). */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const step = [1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10].find((x) => f <= x + 1e-9) ?? 10;
  return step * exp;
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(160);
  useLayoutEffect(() => {
    const ow = ref.current?.offsetWidth;
    if (ow && ow !== w) setW(ow);
  });
  const left = Math.max(0, Math.min(width - w, x + 12 + w > width ? x - w - 12 : x + 12));
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-md border border-line-strong bg-surface-2 px-2.5 py-2 text-[12px] shadow-cloud"
      style={{ left }}
      role="status"
    >
      {children}
    </div>
  );
}

const PAD = { l: 44, r: 10, t: 10, b: 22 };

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
}

/** Time-series lines with a crosshair read-out. One y-scale only. */
export function LineChart({
  times,
  series,
  yMax: fixedMax,
  yFormat,
  axisFormat = yFormat,
  xFormat,
  height = 150,
  label,
}: {
  times: number[];
  series: LineSeries[];
  yMax?: number;
  yFormat: (v: number) => string;
  /** Tick labels, when they should be terser than read-out values. */
  axisFormat?: (v: number) => string;
  xFormat: (t: number) => string;
  height?: number;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const clipId = useId();
  const n = times.length;
  const plotW = Math.max(10, width - PAD.l - PAD.r);
  const plotH = height - PAD.t - PAD.b;
  const dataMax = Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const yMax = fixedMax ?? niceCeil(dataMax * 1.1);
  const x = (i: number) => PAD.l + (n <= 1 ? plotW : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.t + (1 - Math.min(v, yMax) / yMax) * plotH;
  const ticks = [0, yMax / 2, yMax];
  const xTicks = n > 1 ? [0, Math.floor((n - 1) / 2), n - 1] : [];

  function pathFor(values: (number | null)[]) {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setActive(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setActive((a) => Math.max(0, Math.min(n - 1, (a ?? n - 1) + (e.key === 'ArrowLeft' ? -1 : 1))));
  }

  const single = series.length === 1;
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && n > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          className="block overflow-visible focus-visible:outline-none"
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={PAD.l} y={PAD.t - 4} width={plotW} height={plotH + 8} />
            </clipPath>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={PAD.l + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={PAD.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-3 font-hud text-[10px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {axisFormat(t)}
              </text>
            </g>
          ))}
          {xTicks.map((i, k) => (
            <text key={i} x={x(i)} y={height - 6} textAnchor={k === 0 ? 'start' : k === xTicks.length - 1 ? 'end' : 'middle'} className="fill-ink-3 font-hud text-[10px]">
              {xFormat(times[i]!)}
            </text>
          ))}
          <g clipPath={`url(#${clipId})`}>
            {series.map((s) => {
              const d = pathFor(s.values);
              const first = s.values.findIndex((v) => v !== null);
              return (
                <g key={s.key}>
                  {single && d && first >= 0 && <path d={`${d}L${x(n - 1)} ${y(0)}L${x(first)} ${y(0)}Z`} fill={s.color} opacity={0.1} />}
                  <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                </g>
              );
            })}
          </g>
          {active !== null && (
            <g pointerEvents="none">
              <line x1={x(active)} x2={x(active)} y1={PAD.t} y2={PAD.t + plotH} stroke="var(--ink-3)" strokeWidth={1} shapeRendering="crispEdges" />
              {series.map((s) => {
                const v = s.values[active];
                return v === null || v === undefined ? null : <circle key={s.key} cx={x(active)} cy={y(v)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />;
              })}
            </g>
          )}
          <rect
            x={PAD.l}
            y={PAD.t}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
      )}
      {active !== null && width > 0 && (
        <Tooltip x={x(active)} width={width}>
          <div className="mb-1 font-hud text-[10.5px] text-ink-3">{xFormat(times[active]!)}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className="size-2 rounded-[2px]" style={{ background: s.color }} aria-hidden />
              <span className="text-ink-2">{s.label}</span>
              <span className="ml-auto pl-3 font-hud text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {s.values[active] === null || s.values[active] === undefined ? '—' : yFormat(s.values[active]!)}
              </span>
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

export interface StackKey {
  key: string;
  label: string;
  color: string;
}

/** Columns stacked by category, with a per-column read-out. */
export function StackedBars({
  buckets,
  keys,
  format,
  axisFormat = format,
  xFormat,
  height = 190,
  label,
}: {
  buckets: { t: number; parts: Record<string, number> }[];
  keys: StackKey[];
  format: (v: number) => string;
  axisFormat?: (v: number) => string;
  xFormat: (t: number) => string;
  height?: number;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const n = buckets.length;
  const plotW = Math.max(10, width - PAD.l - PAD.r);
  const plotH = height - PAD.t - PAD.b;
  const totals = buckets.map((b) => keys.reduce((a, k) => a + (b.parts[k.key] ?? 0), 0));
  const yMax = niceCeil(Math.max(...totals, 0) * 1.08);
  const slot = plotW / Math.max(1, n);
  const barW = Math.max(2, Math.min(24, slot * 0.62));
  const y = (v: number) => PAD.t + (1 - v / yMax) * plotH;
  const ticks = [0, yMax / 2, yMax];
  const labelEvery = Math.max(1, Math.ceil(52 / slot));

  function onKey(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setActive((a) => Math.max(0, Math.min(n - 1, (a ?? n - 1) + (e.key === 'ArrowLeft' ? -1 : 1))));
  }

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label} tabIndex={0} onKeyDown={onKey} onBlur={() => setActive(null)} className="block focus-visible:outline-none">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={PAD.l + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={PAD.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-3 font-hud text-[10px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {axisFormat(t)}
              </text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const cx = PAD.l + slot * i + slot / 2;
            let base = 0;
            const segs = keys
              .map((k) => ({ k, v: b.parts[k.key] ?? 0 }))
              .filter((s) => s.v > 0)
              .map((s, idx, arr) => {
                const y0 = y(base);
                base += s.v;
                const y1 = y(base);
                const top = idx === arr.length - 1;
                // 2px surface gap above each segment except the top one; 4px rounded data-end on top only.
                const h = Math.max(0, y0 - y1 - (top ? 0 : 2));
                const r = top ? Math.min(4, h, barW / 2) : 0;
                const x0 = cx - barW / 2;
                const yTop = top ? y1 : y1 + 2;
                const d = r
                  ? `M${x0} ${yTop + h}V${yTop + r}Q${x0} ${yTop} ${x0 + r} ${yTop}H${x0 + barW - r}Q${x0 + barW} ${yTop} ${x0 + barW} ${yTop + r}V${yTop + h}Z`
                  : `M${x0} ${yTop}h${barW}v${h}h${-barW}Z`;
                return <path key={s.k.key} d={d} fill={s.k.color} opacity={active === null || active === i ? 1 : 0.45} />;
              });
            return (
              <g key={b.t}>
                {segs}
                {i % labelEvery === 0 && (
                  <text x={cx} y={height - 6} textAnchor="middle" className="fill-ink-3 font-hud text-[10px]">
                    {xFormat(b.t)}
                  </text>
                )}
                <rect
                  x={PAD.l + slot * i}
                  y={PAD.t}
                  width={slot}
                  height={plotH}
                  fill="transparent"
                  onPointerEnter={() => setActive(i)}
                  onPointerDown={() => setActive(i)}
                  onPointerLeave={() => setActive(null)}
                />
              </g>
            );
          })}
        </svg>
      )}
      {active !== null && width > 0 && (
        <Tooltip x={PAD.l + slot * active + slot / 2} width={width}>
          <div className="mb-1 flex items-baseline gap-3 font-hud text-[10.5px] text-ink-3">
            {xFormat(buckets[active]!.t)}
            <span className="ml-auto text-ink">{format(totals[active]!)}</span>
          </div>
          {keys
            .filter((k) => (buckets[active]!.parts[k.key] ?? 0) > 0)
            .map((k) => (
              <div key={k.key} className="flex items-center gap-2">
                <span className="size-2 rounded-[2px]" style={{ background: k.color }} aria-hidden />
                <span className="text-ink-2">{k.label}</span>
                <span className="ml-auto pl-3 font-hud text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {format(buckets[active]!.parts[k.key]!)}
                </span>
              </div>
            ))}
          {totals[active] === 0 && <div className="text-ink-3">No usage</div>}
        </Tooltip>
      )}
    </div>
  );
}
