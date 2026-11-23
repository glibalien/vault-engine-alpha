import type Database from 'better-sqlite3';
import { providerKeyRef } from '@vault/llm';
import { PROVIDERS } from '@vault/settings-registry';

/**
 * OpenRouter reconciliation (#328). Per-call charges already match OpenRouter's own, so the
 * value is in catching what the ledger never saw: quiet SDK retries, client timeouts OpenRouter
 * still billed, failed best-effort recording, and anything else spending on the same key.
 *
 * About once a day, at the first hourly tick after midnight UTC, the Engine reads
 * `GET /api/v1/key` with the OpenRouter key it already holds and stores the key's running
 * `usage` figure. The difference between two consecutive readings of the same key is
 * OpenRouter's spend between them; it is compared with the ledger's OpenRouter total over
 * exactly that span (`ts` > earlier reading, <= later reading), so a late or missed reading
 * only lengthens the interval and never creates a false gap. The ledger side is recomputed
 * whenever it is reported, since a call's row can arrive after the reading that closed its
 * interval; the stored ledger figures are the ones at the reading, kept for the log. Readings and intervals live in
 * their own tables; `usage_events` is never changed.
 *
 * Only rows this key paid for belong in the comparison (#345), and a row's service doesn't say
 * that: memory consolidation runs on the Engine's key but is recorded as the Curator's. So a row
 * carries its key's fingerprint, and rows of another key are left out and reported beside the
 * gap. A row with no fingerprint might be this key's and stays in. That covers older rows and
 * the plugin, which doesn't send one, so a separate plugin key shows as a negative gap. With one
 * key shared by every service, the installer's default, all rows match. This reads only the
 * Engine's key: a separately keyed Curator's spend is left out, not reconciled.
 */

const KEY_URL = `${PROVIDERS.openrouter.baseURL}/key`;
const TIMEOUT_MS = 10_000;
/** A reading is due at the first tick after midnight UTC once this long has passed... */
const MIN_HOURS_BETWEEN = 20;
/** ...or at any tick once this long has passed (a missed midnight). */
const OVERDUE_HOURS = 26;

type Fetch = typeof globalThis.fetch;

export interface OpenRouterReconcileOptions {
  apiKey: string;
  fetch?: Fetch;
  now?: () => Date;
}

export interface ReconcileInterval {
  start_at: string;
  end_at: string;
  provider_usd: number;
  ledger_usd: number;
  gap_usd: number;
  ledger_events: number;
  ledger_unpriced_events: number;
  ledger_by_service: Record<string, number>;
  /** The ledger's spend over the interval paid with another key, left out of the figures above. */
  ledger_other_keys_usd: number;
}

export type ReconcileOutcome =
  | { status: 'skipped' }
  | { status: 'first-reading'; usage_usd: number }
  | { status: 'reconciled'; interval: ReconcileInterval }
  | { status: 'usage-went-down'; usage_usd: number; previous_usd: number }
  | { status: 'failed'; reason: string };


/** OpenRouter's running usage (USD) from a `/key` body, or undefined if it has none. */
export function openRouterKeyUsage(body: unknown): number | undefined {
  const usage = (body as { data?: { usage?: unknown } } | null)?.data?.usage;
  return typeof usage === 'number' && Number.isFinite(usage) && usage >= 0 ? usage : undefined;
}

/** Whether a reading is due: none yet, the first tick after midnight UTC once 20 h have passed
 *  since the last one, or any tick once 26 h have. Midnight readings keep intervals close to
 *  UTC days. */
export function readingDue(now: Date, lastTakenAt: string | null): boolean {
  if (lastTakenAt === null) return true;
  const hours = (now.getTime() - Date.parse(lastTakenAt)) / 3_600_000;
  if (!Number.isFinite(hours)) return true;
  return hours >= OVERDUE_HOURS || (hours >= MIN_HOURS_BETWEEN && now.getUTCHours() === 0);
}

/** The latest reading of any key. An interval pairs a reading only with the one right before it,
 *  and only when both are of the same key: rows with no fingerprint count for any key, so an
 *  interval bridging readings of another key (A, B, B, A) would count them twice. */
function lastReading(db: Database.Database): { key_ref: string; taken_at: string; usage_usd: number } | undefined {
  return db.prepare(`
    SELECT key_ref, taken_at, usage_usd FROM provider_usage_readings
     WHERE provider = 'openrouter' ORDER BY taken_at DESC, id DESC LIMIT 1
  `).get() as { key_ref: string; taken_at: string; usage_usd: number } | undefined;
}

/** The ledger's OpenRouter spend over (start, end] for one key, in total and per service. A null
 *  `key` is an interval stored before keys were recorded, which compares against every row. */
export function ledgerOver(db: Database.Database, start: string, end: string, key: string | null): Pick<ReconcileInterval,
  'ledger_usd' | 'ledger_events' | 'ledger_unpriced_events' | 'ledger_by_service' | 'ledger_other_keys_usd'> {
  const rows = db.prepare(`
    SELECT service, COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS events,
           COALESCE(SUM(cost_basis = 'unpriced'), 0) AS unpriced
      FROM usage_events
     WHERE provider = 'openrouter' AND ts > ? AND ts <= ?
       AND (? IS NULL OR key_ref IS NULL OR key_ref = ?)
     GROUP BY service ORDER BY service
  `).all(start, end, key, key) as Array<{ service: string; usd: number; events: number; unpriced: number }>;
  const others = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM usage_events
     WHERE provider = 'openrouter' AND ts > ? AND ts <= ? AND ? IS NOT NULL AND key_ref IS NOT NULL AND key_ref != ?
  `).get(start, end, key, key) as { usd: number };
  return {
    ledger_usd: rows.reduce((n, r) => n + r.usd, 0),
    ledger_events: rows.reduce((n, r) => n + r.events, 0),
    ledger_unpriced_events: rows.reduce((n, r) => n + r.unpriced, 0),
    ledger_by_service: Object.fromEntries(rows.map(r => [r.service, r.usd])),
    ledger_other_keys_usd: others.usd,
  };
}

/** Take a reading if one is due and, when there is an earlier reading of the same key, record
 *  the interval between them. Never throws for a provider failure. */
export async function reconcileOpenRouter(
  db: Database.Database,
  opts: OpenRouterReconcileOptions & { force?: boolean },
): Promise<ReconcileOutcome> {
  const now = (opts.now ?? (() => new Date()))();
  const ref = providerKeyRef(opts.apiKey);
  const latest = lastReading(db);
  // A different key's reading is no baseline for this one: start fresh now.
  const previous = latest?.key_ref === ref ? latest : undefined;
  if (!opts.force && previous && !readingDue(now, previous.taken_at)) return { status: 'skipped' };

  let usage: number | undefined;
  try {
    const res = await (opts.fetch ?? globalThis.fetch)(KEY_URL, {
      headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return { status: 'failed', reason: res.status === 401 || res.status === 403 ? `HTTP ${res.status}: key rejected` : `HTTP ${res.status}` };
    }
    usage = openRouterKeyUsage(await res.json());
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  if (usage === undefined) return { status: 'failed', reason: 'no usage figure in the response' };

  const takenAt = now.toISOString();
  return db.transaction((): ReconcileOutcome => {
    db.prepare(`INSERT INTO provider_usage_readings (provider, key_ref, taken_at, usage_usd) VALUES ('openrouter', ?, ?, ?)`)
      .run(ref, takenAt, usage);
    if (!previous) return { status: 'first-reading', usage_usd: usage };
    if (usage < previous.usage_usd) return { status: 'usage-went-down', usage_usd: usage, previous_usd: previous.usage_usd };
    const ledger = ledgerOver(db, previous.taken_at, takenAt, ref);
    const interval: ReconcileInterval = {
      start_at: previous.taken_at, end_at: takenAt,
      provider_usd: usage - previous.usage_usd,
      ...ledger,
      gap_usd: usage - previous.usage_usd - ledger.ledger_usd,
    };
    db.prepare(`
      INSERT OR REPLACE INTO provider_reconciliations
        (provider, start_at, end_at, provider_usd, ledger_usd, gap_usd, ledger_events, ledger_unpriced_events, ledger_by_service_json, key_ref)
      VALUES ('openrouter', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(interval.start_at, interval.end_at, interval.provider_usd, interval.ledger_usd, interval.gap_usd,
      interval.ledger_events, interval.ledger_unpriced_events, JSON.stringify(interval.ledger_by_service), ref);
    return { status: 'reconciled', interval };
  })();
}

export function formatReconcileOutcome(o: ReconcileOutcome): string | null {
  switch (o.status) {
    case 'skipped': return null;
    case 'first-reading': return `[usage] openrouter reconciliation: first reading, key usage $${o.usage_usd.toFixed(4)}`;
    case 'usage-went-down':
      return `[usage] openrouter reconciliation: key usage went down ($${o.previous_usd.toFixed(4)} → $${o.usage_usd.toFixed(4)}); no interval recorded`;
    case 'failed': return `[usage] openrouter reconciliation: reading failed (${o.reason}); retrying next hour`;
    case 'reconciled': {
      const i = o.interval;
      return `[usage] openrouter reconciliation: ${i.start_at} → ${i.end_at}: OpenRouter $${i.provider_usd.toFixed(4)}, `
        + `ledger $${i.ledger_usd.toFixed(4)} (${i.ledger_events} calls, ${i.ledger_unpriced_events} unpriced), gap $${i.gap_usd.toFixed(4)}`
        + (i.ledger_other_keys_usd > 0 ? `; $${i.ledger_other_keys_usd.toFixed(4)} on other keys left out` : '');
    }
  }
}

export interface OpenRouterReconcileSchedule {
  tickMs?: number;
  initialDelayMs?: number;
  log?: (line: string) => void;
  /** Called after a run that stored anything, so the CSV mirrors catch up. */
  onChanged?: () => void;
}

/** Ticks shortly after boot and then hourly; each tick takes a reading only when one is due.
 *  Never overlaps itself and never throws. */
export function startOpenRouterReconciliation(
  db: Database.Database,
  opts: OpenRouterReconcileOptions & OpenRouterReconcileSchedule,
): { stop: () => void } {
  const log = opts.log ?? ((line: string) => console.log(line));
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const outcome = await reconcileOpenRouter(db, opts);
      const line = formatReconcileOutcome(outcome);
      if (line) log(line);
      if (outcome.status !== 'skipped' && outcome.status !== 'failed') opts.onChanged?.();
    } catch (err) {
      log(`[usage] openrouter reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  let interval: ReturnType<typeof setInterval> | null = null;
  const initial = setTimeout(() => {
    void tick();
    interval = setInterval(() => void tick(), opts.tickMs ?? 3_600_000);
    interval.unref?.();
  }, opts.initialDelayMs ?? 5 * 60_000);
  initial.unref?.();
  return {
    stop: () => {
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    },
  };
}

export interface ReconciliationSummary {
  provider: 'openrouter';
  /** Intervals attributed (by midpoint) to UTC days in the requested range. */
  intervals: number;
  first_start: string | null;
  last_end: string | null;
  provider_usd: number;
  ledger_usd: number;
  gap_usd: number;
}

/** The ledger's OpenRouter total over an interval, recomputed from `usage_events` at read time.
 *  The stored `ledger_usd` is only the figure at the reading: a call that spanned the reading is
 *  timestamped at its start but recorded on completion, so its row can land inside an interval
 *  after that interval was stored. Reports always use this live figure. */
const LIVE_LEDGER_USD = `(SELECT COALESCE(SUM(e.cost_usd), 0) FROM usage_events e
    WHERE e.provider = 'openrouter' AND e.ts > r.start_at AND e.ts <= r.end_at
      AND (r.key_ref IS NULL OR e.key_ref IS NULL OR e.key_ref = r.key_ref))`;

/** Intervals whose midpoint falls in [since, until], summed, with the ledger side recomputed.
 *  Each interval counts toward the UTC day it mostly covers, and its own span may reach a little
 *  outside the range. */
export function reconciliationSummary(db: Database.Database, since?: string, until?: string): ReconciliationSummary {
  const mid = `strftime('%Y-%m-%dT%H:%M:%fZ', (julianday(r.start_at) + julianday(r.end_at)) / 2)`;
  const conditions = ["r.provider = 'openrouter'"];
  const params: string[] = [];
  if (since !== undefined) { conditions.push(`${mid} >= ?`); params.push(since); }
  if (until !== undefined) { conditions.push(`${mid} <= ?`); params.push(until); }
  const row = db.prepare(`
    SELECT COUNT(*) AS intervals, MIN(start_at) AS first_start, MAX(end_at) AS last_end,
           COALESCE(SUM(provider_usd), 0) AS provider_usd, COALESCE(SUM(ledger_usd), 0) AS ledger_usd
      FROM (SELECT r.start_at, r.end_at, r.provider_usd, ${LIVE_LEDGER_USD} AS ledger_usd
              FROM provider_reconciliations r WHERE ${conditions.join(' AND ')})
  `).get(...params) as Omit<ReconciliationSummary, 'provider' | 'gap_usd'>;
  return { provider: 'openrouter', ...row, gap_usd: row.provider_usd - row.ledger_usd };
}

/** Every stored interval with its ledger side recomputed from `usage_events` (see LIVE_LEDGER_USD). */
export function reconciliationIntervals(db: Database.Database): ReconcileInterval[] {
  const rows = db.prepare(`SELECT start_at, end_at, provider_usd, key_ref FROM provider_reconciliations
     WHERE provider = 'openrouter' ORDER BY start_at ASC`).all() as Array<{ start_at: string; end_at: string; provider_usd: number; key_ref: string | null }>;
  return rows.map(r => {
    const ledger = ledgerOver(db, r.start_at, r.end_at, r.key_ref);
    return { start_at: r.start_at, end_at: r.end_at, provider_usd: r.provider_usd, ...ledger,
      gap_usd: r.provider_usd - ledger.ledger_usd };
  });
}
