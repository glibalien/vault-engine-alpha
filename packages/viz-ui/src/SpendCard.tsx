import React, { useCallback, useEffect, useState } from 'react';
import { useVizCall } from './viz-client-context.js';
import { readCardEnvelope } from './card-envelope.js';
import type { SpendCardSpec, SpendRange } from './board-card-spec.js';

interface UsageTotals {
  cost_usd?: number; events?: number;
  provider_reported_usd?: number; estimated_usd?: number;
  unpriced_events?: number; incomplete_usage_events?: number;
  confirmed_usd?: number; confirmed_events?: number; confirmed_ledger_usd?: number;
}
interface UsageGroup extends UsageTotals { day?: string; service?: string; purpose?: string }
/** OpenRouter's own figure against the ledger for the reading intervals in range (#328). */
interface Reconciliation { intervals: number; provider_usd: number; ledger_usd: number; gap_usd: number }
interface UsagePayload { groups: UsageGroup[]; group_count?: number; totals: UsageTotals; reconciliation?: Reconciliation }

/** What the view shows, all from one load. */
export interface SpendView {
  range: { label: string; since: string; days: string[] };
  totals: UsageTotals;
  days: Array<{ day: string; cost: number; calls: number }>;
  drivers: Array<{ service: string; purpose: string; cost: number; calls: number }>;
  driverCount: number;
  unpricedModels: string[];
  /** Unpriced models with no rate of their own (OpenRouter's Auto Router): a price on a model
   *  note can't fix them (#340). */
  providerPricedModels: string[];
  reconciliation: Reconciliation | null;
  /** `zone` is the time zone whose day the cap counts: Curator's `tz`, or the viewer's when unset. */
  curatorToday: { spent: number; capUsd: number | null; zone: string } | null;
}

const DRIVER_LIMIT = 6;
const money = (v: number | undefined): string => `$${(v ?? 0).toFixed(2)}`;
const count = (v: number | undefined): string => (v ?? 0).toLocaleString('en-US');
const pad = (n: number): string => String(n).padStart(2, '0');
const localDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The range's local start, its label and every local day in it up to today, computed at load:
 *  a view saved as "this month" stays this month (#281). */
export function resolveSpendRange(range: SpendRange, now = new Date()): SpendView['range'] {
  const start = range === 'month'
    ? new Date(now.getFullYear(), now.getMonth(), 1)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
  const days: string[] = [];
  for (let d = new Date(start); d <= now; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(localDay(d));
  const label = range === 'month'
    ? `This month (${start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})`
    : 'Last 30 days';
  return { label, since: start.toISOString(), days };
}

const localMidnight = (day: string): Date => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

/** Runs of consecutive range days that share a UTC offset at their local midnight. A range that
 *  crosses a daylight-saving change gets one run per offset, so each run is bucketed into local
 *  days with its own offset instead of today's. */
export function offsetSegments(days: string[]): Array<{ days: string[]; offset: number }> {
  const out: Array<{ days: string[]; offset: number }> = [];
  for (const day of days) {
    const offset = -localMidnight(day).getTimezoneOffset();
    const last = out[out.length - 1];
    if (last && last.offset === offset) last.days.push(day);
    else out.push({ days: [day], offset });
  }
  return out;
}

/** Midnight today in `tz`, as an instant: the start of the day Curator's daily cap counts
 *  (`startOfLocalDay` in Curator's scheduler). */
export function startOfDayInZone(now: Date, tz: string): Date {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const wall = (d: Date) => {
    const parts = fmt.formatToParts(d);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
  };
  const today = wall(now);
  const midnightWall = Date.UTC(today.y, today.m - 1, today.d);
  // Correct a UTC-midnight guess by the zone's offset at the guess; twice, for a DST change near it.
  let guess = midnightWall;
  for (let i = 0; i < 2; i++) {
    const w = wall(new Date(guess));
    guess = midnightWall - (Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - guess);
  }
  return new Date(guess);
}

const sumTotals = (all: UsageTotals[]): UsageTotals => {
  const keys = ['cost_usd', 'events', 'provider_reported_usd', 'estimated_usd', 'unpriced_events', 'incomplete_usage_events',
    'confirmed_usd', 'confirmed_events', 'confirmed_ledger_usd'] as const;
  return Object.fromEntries(keys.map((k) => [k, all.reduce((n, t) => n + (t[k] ?? 0), 0)])) as UsageTotals;
};

/** Load everything the view shows: the range by day and by service/purpose, and Curator's spend
 *  for its current day against its daily cap. No model calls. */
export async function loadSpendView(
  call: ReturnType<typeof useVizCall>, range: SpendRange, now = new Date(),
): Promise<{ ok: true; view: SpendView } | { ok: false; message: string }> {
  const r = resolveSpendRange(range, now);
  const usage = async (args: Record<string, unknown>) => readCardEnvelope(await call({ name: 'usage-report', arguments: args }));
  // One by-day query per run of days sharing a UTC offset (signed: EDT → -240), each bounded to
  // its own days, so a daylight-saving change can't shift spend onto the wrong day.
  const segments = offsetSegments(r.days);
  const byDay = await Promise.all(segments.map((seg, i) => {
    const next = i + 1 < segments.length ? localMidnight(segments[i + 1]!.days[0]!) : null;
    return usage({
      since: localMidnight(seg.days[0]!).toISOString(),
      ...(next ? { until: new Date(next.getTime() - 1).toISOString() } : {}),
      group_by: ['day'], utc_offset_minutes: seg.offset, limit: 62,
    });
  }));
  const failed = byDay.find((e) => !e.ok);
  if (failed) return { ok: false, message: failed.error?.message ?? 'usage-report failed' };
  const drivers = await usage({ since: r.since, group_by: ['service', 'purpose'], limit: DRIVER_LIMIT });
  if (!drivers.ok) return { ok: false, message: drivers.error?.message ?? 'usage-report failed' };

  // Curator counts its cap per day in its own time zone (`tz`; empty means its host's zone,
  // which only Curator knows, so the viewer's stands in). Optional: a failure only hides the tile.
  let curatorToday: SpendView['curatorToday'] = null;
  try {
    const settings = readCardEnvelope(await call({ name: 'get-settings', arguments: { domain: 'curator' } }));
    if (settings.ok) {
      const effective = (settings.data as { domains?: { curator?: { effective?: { dailyBudgetCents?: unknown; tz?: unknown } } } })
        ?.domains?.curator?.effective;
      const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      let zone = typeof effective?.tz === 'string' && effective.tz.trim() !== '' ? effective.tz.trim() : viewerZone;
      let dayStart: Date;
      try { dayStart = startOfDayInZone(now, zone); } catch { zone = viewerZone; dayStart = startOfDayInZone(now, zone); }
      const today = await usage({ since: dayStart.toISOString(), service: 'curator' });
      if (today.ok) {
        const cents = effective?.dailyBudgetCents;
        curatorToday = {
          spent: (today.data as UsagePayload).totals.cost_usd ?? 0,
          capUsd: typeof cents === 'number' ? cents / 100 : null,
          zone,
        };
      }
    }
  } catch { /* the tile is optional */ }

  // Merge the runs. A bucket outside the range (an edge hour) joins the nearest day in it, so the
  // chart never drops spend the totals count.
  const perDay = new Map<string, { cost: number; calls: number }>(r.days.map((d) => [d, { cost: 0, calls: 0 }]));
  for (const env of byDay) {
    for (const g of (env.data as UsagePayload).groups) {
      const raw = g.day ?? '';
      const day = perDay.has(raw) ? raw : raw < r.days[0]! ? r.days[0]! : r.days[r.days.length - 1]!;
      const slot = perDay.get(day)!;
      slot.cost += g.cost_usd ?? 0;
      slot.calls += g.events ?? 0;
    }
  }
  const driverPayload = drivers.data as UsagePayload;
  const unpricedModels = new Set<string>();
  const providerPricedModels = new Set<string>();
  for (const env of byDay) {
    const w = env.warnings?.find((x) => x.code === 'UNPRICED_MODELS') as { details?: { unpriced?: Array<{ model?: unknown; provider_priced?: unknown }> } } | undefined;
    for (const u of w?.details?.unpriced ?? []) {
      if (!u.model) continue;
      unpricedModels.add(String(u.model));
      if (u.provider_priced === true) providerPricedModels.add(String(u.model));
    }
  }
  // OpenRouter's own figure per reading interval, summed across the runs (#328).
  let reconciliation: Reconciliation | null = null;
  for (const env of byDay) {
    const rec = (env.data as UsagePayload).reconciliation;
    if (!rec || !(rec.intervals > 0)) continue;
    reconciliation ??= { intervals: 0, provider_usd: 0, ledger_usd: 0, gap_usd: 0 };
    reconciliation.intervals += rec.intervals;
    reconciliation.provider_usd += rec.provider_usd;
    reconciliation.ledger_usd += rec.ledger_usd;
    reconciliation.gap_usd += rec.gap_usd;
  }
  return { ok: true, view: {
    range: r,
    totals: sumTotals(byDay.map((e) => (e.data as UsagePayload).totals)),
    days: r.days.map((day) => ({ day, cost: perDay.get(day)!.cost, calls: perDay.get(day)!.calls })),
    drivers: driverPayload.groups.map((g) => ({ service: g.service ?? '—', purpose: g.purpose ?? '—', cost: g.cost_usd ?? 0, calls: g.events ?? 0 })),
    driverCount: driverPayload.group_count ?? driverPayload.groups.length,
    unpricedModels: [...unpricedModels],
    providerPricedModels: [...providerPricedModels],
    reconciliation,
    curatorToday,
  } };
}

/** Curator's spend today as a share of its cap: accent, then warning from 80%, then error at the cap. */
function CapMeter({ spent, capUsd }: { spent: number; capUsd: number }): React.ReactElement {
  const share = capUsd > 0 ? spent / capUsd : 1;
  const tone = share >= 1 ? 'over' : share >= 0.8 ? 'near' : 'ok';
  return (
    <div className="vz-spend-meter" role="meter" aria-valuemin={0} aria-valuemax={capUsd} aria-valuenow={spent}
      aria-label={`Curator today: ${money(spent)} of its ${money(capUsd)} daily cap`}>
      <div className={`vz-spend-meter-fill ${tone}`} style={{ width: `${Math.min(share, 1) * 100}%` }} />
    </div>
  );
}

/** Daily spend as columns, one per day in the range; hover or focus a column for its value. */
function DailyBars({ days }: { days: SpendView['days'] }): React.ReactElement {
  const max = Math.max(...days.map((d) => d.cost), 0);
  const label = (d: SpendView['days'][number]) => {
    const date = new Date(`${d.day}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${date}: ${money(d.cost)} · ${count(d.calls)} calls`;
  };
  return (
    <figure className="vz-spend-trend">
      <figcaption>Spend per day{max > 0 ? <span className="vz-spend-trend-max">peak {money(max)}</span> : null}</figcaption>
      <div className="vz-spend-bars" role="list">
        {days.map((d) => (
          <div key={d.day} className="vz-spend-bar-slot" role="listitem" tabIndex={0} title={label(d)} aria-label={label(d)}>
            <div className="vz-spend-bar" style={{ height: max > 0 ? `${Math.max((d.cost / max) * 100, d.cost > 0 ? 2 : 0)}%` : '0%' }} />
          </div>
        ))}
      </div>
      <div className="vz-spend-axis">
        <span>{days[0]?.day.slice(5)}</span>
        <span>{days[days.length - 1]?.day.slice(5)}</span>
      </div>
    </figure>
  );
}

/**
 * Usage and cost: a fixed view with no model call (#281). It shows, for this month or the last
 * 30 days (computed when it loads), the total with provider-reported and estimated cost apart,
 * Curator's spend today against its daily cap, spend per day, the top drivers by service and
 * purpose, and the calls the total can't count.
 */
export function SpendCard({ spec, actions, onSpecChange }: {
  spec: SpendCardSpec; actions?: React.ReactNode; onSpecChange?: (next: SpendCardSpec) => void;
}): React.ReactElement {
  const call = useVizCall();
  const [view, setView] = useState<SpendView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const range = spec.range;

  const load = useCallback(async () => {
    try {
      const res = await loadSpendView(call, range);
      if (!res.ok) { setError(res.message); return; }
      setError(null);
      setView(res.view);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [call, range]);
  useEffect(() => { void load(); }, [load, tick]);

  const t = view?.totals;
  return (
    <div className="vz-spendcard">
      <div className="vz-card-head">
        <span className="vz-card-title">{spec.title}</span>
        {onSpecChange && (
          <select className="vz-spend-range" aria-label="date range" value={range}
            onChange={(e) => onSpecChange({ ...spec, range: e.target.value as SpendRange })}>
            <option value="month">This month</option>
            <option value="30d">Last 30 days</option>
          </select>
        )}
        {actions}
        <button type="button" aria-label="refresh" className="vz-card-refresh" onClick={() => setTick((n) => n + 1)}>↻</button>
      </div>
      {error && <div className="vz-card-error" role="alert">{error}</div>}
      {!error && view && t && (
        <>
          <div className="vz-spend-range-label">{view.range.label}</div>
          <div className="vz-stat-grid">
            <div className="vz-stat"><b>{money(t.cost_usd)}</b><span>spent · {count(t.events)} calls</span></div>
            <div className="vz-stat"><b>{money(t.provider_reported_usd)}</b><span>reported by providers</span></div>
            <div className="vz-stat"><b>{money(t.estimated_usd)}</b><span>estimated from prices</span></div>
            {view.curatorToday && (
              <div className="vz-stat vz-spend-cap">
                <b>{money(view.curatorToday.spent)}</b>
                <span title={`Curator's day in ${view.curatorToday.zone}`}>{view.curatorToday.capUsd === null ? 'Curator today · no daily cap' : `Curator today · cap ${money(view.curatorToday.capUsd)}`}</span>
                {view.curatorToday.capUsd !== null && <CapMeter spent={view.curatorToday.spent} capUsd={view.curatorToday.capUsd} />}
              </div>
            )}
          </div>
          {((t.unpriced_events ?? 0) > 0 || (t.incomplete_usage_events ?? 0) > 0 || (t.confirmed_events ?? 0) > 0 || view.reconciliation) && (
            <ul className="vz-spend-notes">
              {view.reconciliation && (
                <li>
                  OpenRouter reports {money(view.reconciliation.provider_usd)} over {count(view.reconciliation.intervals)} daily
                  {view.reconciliation.intervals === 1 ? ' reading' : ' readings'}; the ledger has {money(view.reconciliation.ledger_usd)} for the same hours
                  {Math.abs(view.reconciliation.gap_usd) >= 0.005
                    ? `, ${money(Math.abs(view.reconciliation.gap_usd))} ${view.reconciliation.gap_usd > 0 ? 'less' : 'more'}. A difference can come from calls the ledger missed, calls it estimated or couldn't price, or spend on another key`
                    : ''}. Card charges also include OpenRouter&apos;s 5.5% credit fee, which neither figure has.
                </li>
              )}
              {(t.confirmed_events ?? 0) > 0 && (
                <li>Providers&apos; own logs confirm {money(t.confirmed_usd)} for {count(t.confirmed_events)} calls we estimated at {money(t.confirmed_ledger_usd)}.</li>
              )}
              {(t.unpriced_events ?? 0) > 0 && (
                <li>
                  ⚠ {count(t.unpriced_events)} calls have no price{view.unpricedModels.length > 0 ? ` (${view.unpricedModels.join(', ')})` : ''}, so the total undercounts.
                  {view.unpricedModels.length === 0 || view.unpricedModels.some((m) => !view.providerPricedModels.includes(m))
                    ? ' Add a price to the model\'s note in Settings/Models.' : ''}
                  {view.providerPricedModels.length > 0
                    ? ` ${view.providerPricedModels.join(', ')} has no price of its own: these calls didn't report OpenRouter's charge, and there weren't yet enough charged calls to estimate them from.`
                    : ''}
                </li>
              )}
              {(t.incomplete_usage_events ?? 0) > 0 && (
                <li>{count(t.incomplete_usage_events)} calls reported incomplete usage, so their cost may be low.</li>
              )}
            </ul>
          )}
          <DailyBars days={view.days} />
          {view.drivers.length > 0 && (
            <>
              <table className="vz-spend-table">
                <caption>Top drivers</caption>
                <thead><tr><th>service</th><th>purpose</th><th>cost</th><th>calls</th></tr></thead>
                <tbody>
                  {view.drivers.map((d) => (
                    <tr key={`${d.service}/${d.purpose}`}>
                      <td>{d.service}</td><td>{d.purpose}</td><td>{money(d.cost)}</td><td>{count(d.calls)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {view.driverCount > view.drivers.length && (
                <div className="vz-spend-foot">top {view.drivers.length} of {view.driverCount}</div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
