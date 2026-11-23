import type Database from 'better-sqlite3';

/**
 * Deepgram cost confirmation (#329). Every Deepgram ledger row is estimated from audio
 * seconds × our rate, and every one stores the response's `request_id`. Deepgram's request
 * log (`GET /v1/projects/{project}/requests/{request}`) reports what it actually charged
 * (`response.details.usd`). This job looks recent rows up and records that figure in
 * `usage_confirmations`, never in `usage_events.cost_usd`: the daily budget and past reports
 * keep their per-call estimates, and reports show the confirmed figure beside them.
 *
 * Read-only against Deepgram and best-effort: an auth failure, rate limit, outage or timeout
 * stops the run and the remaining rows are retried next time. Nothing here can fail a
 * transcription. The key needs `usage:read` to reach the log and `billing:read` to see the charge
 * in it. A Member-role key has only the first, and Deepgram then returns each request without
 * `usd` (#344).
 */

const API = 'https://api.deepgram.com/v1';
/** Deepgram keeps request logs for 90 days; a day of margin. */
const LOOKBACK_DAYS = 89;
/** Let a fresh request reach the log before the first lookup. */
const SETTLE_MS = 10 * 60_000;
/** A pending or missing request is looked up again after this long. */
const RETRY_AFTER_MS = 20 * 3_600_000;
/** Lookups per row before a pending or missing request is given up on. */
const MAX_ATTEMPTS = 5;
const DEFAULT_BATCH = 200;
const TIMEOUT_MS = 10_000;

type Fetch = typeof globalThis.fetch;

export interface DeepgramConfirmOptions {
  apiKey: string;
  fetch?: Fetch;
  now?: () => Date;
  batchLimit?: number;
}

export interface DeepgramConfirmResult {
  checked: number;
  confirmed: number;
  pending: number;
  notFound: number;
  /** Deepgram's charge for the rows confirmed this run, and our estimate for the same rows. */
  confirmedUsd: number;
  estimatedUsd: number;
  /** Why the run ended early, when it did. Unchecked rows are retried next run. */
  stopped?: string;
}

class StopRun extends Error {}

interface Candidate { id: number; request_id: string; cost_usd: number }

/** Deepgram's charge from a request-log body, or undefined while it has none. Accepts the
 *  current `{ request: {...} }` envelope and the older top-level shape. */
export function deepgramRequestUsd(body: unknown): number | undefined {
  const usd = requestDetails(body)?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : undefined;
}

/** A request with its details but no `usd` field: what a key without `billing:read` sees, whatever
 *  the request's age. A request that hasn't finished has no details yet. */
export function deepgramChargeHidden(body: unknown): boolean {
  const details = requestDetails(body);
  return details !== undefined && !('usd' in details);
}

function requestDetails(body: unknown): { usd?: unknown } | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const outer = body as { request?: unknown };
  const request = (outer.request !== null && typeof outer.request === 'object' ? outer.request : body) as {
    response?: { details?: unknown } | null;
  };
  const details = request.response?.details;
  return details !== null && typeof details === 'object' ? details as { usd?: unknown } : undefined;
}

export async function confirmDeepgramCosts(
  db: Database.Database,
  opts: DeepgramConfirmOptions,
): Promise<DeepgramConfirmResult> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = (opts.now ?? (() => new Date()))();
  const result: DeepgramConfirmResult = { checked: 0, confirmed: 0, pending: 0, notFound: 0, confirmedUsd: 0, estimatedUsd: 0 };

  const candidates = db.prepare(`
    SELECT e.id, e.request_id, e.cost_usd
      FROM usage_events e
      LEFT JOIN usage_confirmations c ON c.usage_event_id = e.id
     WHERE e.provider = 'deepgram' AND e.request_id IS NOT NULL AND e.request_id != ''
       AND e.ts >= ? AND e.ts <= ?
       AND (c.usage_event_id IS NULL
            OR (c.status != 'confirmed' AND c.attempts < ? AND c.checked_at <= ?))
     ORDER BY c.checked_at IS NOT NULL, c.checked_at ASC, e.ts ASC
     LIMIT ?
  `).all(
    new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString(),
    new Date(now.getTime() - SETTLE_MS).toISOString(),
    MAX_ATTEMPTS,
    new Date(now.getTime() - RETRY_AFTER_MS).toISOString(),
    opts.batchLimit ?? DEFAULT_BATCH,
  ) as Candidate[];
  if (candidates.length === 0) return result;

  const get = async (path: string): Promise<Response> => {
    try {
      return await fetchFn(`${API}${path}`, {
        headers: { Authorization: `Token ${opts.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new StopRun(`request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const stopOn = (res: Response): never => {
    if (res.status === 401 || res.status === 403) {
      throw new StopRun(`HTTP ${res.status}: DEEPGRAM_API_KEY cannot read usage; replace it with a key that can transcribe and has the usage:read and billing:read scopes`);
    }
    throw new StopRun(`HTTP ${res.status}`);
  };

  const upsert = db.prepare(`
    INSERT INTO usage_confirmations (usage_event_id, status, confirmed_cost_usd, attempts, checked_at, detail)
    VALUES (@id, @status, @usd, 1, @checkedAt, @detail)
    ON CONFLICT(usage_event_id) DO UPDATE SET
      status = excluded.status, confirmed_cost_usd = excluded.confirmed_cost_usd,
      attempts = usage_confirmations.attempts + 1, checked_at = excluded.checked_at, detail = excluded.detail
  `);
  // A request with details but no charge spends no lookup: it would read the same on every lookup
  // until the key changes. It still rotates to the back of the queue, so a full batch of them can't
  // keep the job from reaching newer rows, and it ages out with the lookback.
  const markVisited = db.prepare(`
    INSERT INTO usage_confirmations (usage_event_id, status, confirmed_cost_usd, attempts, checked_at, detail)
    VALUES (@id, 'pending', NULL, 0, @checkedAt, NULL)
    ON CONFLICT(usage_event_id) DO UPDATE SET status = 'pending', checked_at = excluded.checked_at
  `);
  const checkedAt = now.toISOString();

  try {
    const projectsRes = await get('/projects');
    if (!projectsRes.ok) stopOn(projectsRes);
    const projects = ((await projectsRes.json()) as { projects?: Array<{ project_id?: unknown }> }).projects ?? [];
    const projectIds = projects.map(p => p.project_id).filter((id): id is string => typeof id === 'string' && id !== '');
    if (projectIds.length === 0) throw new StopRun('the key sees no Deepgram project');

    let hiddenCount = 0;
    for (const row of candidates) {
      let status: 'confirmed' | 'pending' | 'not_found' = 'not_found';
      let usd: number | null = null;
      let hidden = false;
      // A key usually sees one project; with several, try each and start with the last match.
      for (const projectId of [...projectIds]) {
        const res = await get(`/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(row.request_id)}`);
        if (res.status === 404 || res.status === 400) { void res.body?.cancel().catch(() => {}); continue; }
        if (!res.ok) stopOn(res);
        // A body that fails to arrive or parse is a failed lookup, not a pending request:
        // stop, so it doesn't spend one of the row's lookups.
        const body: unknown = await res.json().catch((err: unknown) => {
          throw new StopRun(`unreadable response: ${err instanceof Error ? err.message : String(err)}`);
        });
        const found = deepgramRequestUsd(body);
        status = found === undefined ? 'pending' : 'confirmed';
        usd = found ?? null;
        hidden = deepgramChargeHidden(body);
        projectIds.splice(projectIds.indexOf(projectId), 1);
        projectIds.unshift(projectId);
        break;
      }
      result.checked += 1;
      if (hidden) {
        markVisited.run({ id: row.id, checkedAt });
        hiddenCount += 1;
        result.pending += 1;
        continue;
      }
      upsert.run({ id: row.id, status, usd, checkedAt, detail: null });
      if (status === 'confirmed') {
        result.confirmed += 1;
        result.confirmedUsd += usd ?? 0;
        result.estimatedUsd += row.cost_usd;
      } else if (status === 'pending') {
        result.pending += 1;
      } else {
        result.notFound += 1;
      }
    }
    // A key that saw a charge can see them. With none seen at all, the key is the likely cause.
    if (hiddenCount > 0 && result.confirmed === 0) {
      result.stopped = `no charge visible on ${hiddenCount} request${hiddenCount === 1 ? '' : 's'}; DEEPGRAM_API_KEY may be missing the billing:read scope`;
    }
  } catch (err) {
    if (!(err instanceof StopRun)) throw err;
    result.stopped = err.message;
  }
  return result;
}

export function formatDeepgramConfirmResult(r: DeepgramConfirmResult): string {
  const parts = [`checked ${r.checked}`,
    `confirmed ${r.confirmed} ($${r.confirmedUsd.toFixed(4)} charged vs $${r.estimatedUsd.toFixed(4)} estimated)`,
    `pending ${r.pending}`, `not found ${r.notFound}`];
  return `[usage] deepgram confirmations: ${parts.join(', ')}${r.stopped ? `; stopped: ${r.stopped}` : ''}`;
}

export interface DeepgramConfirmSchedule {
  intervalMs?: number;
  initialDelayMs?: number;
  log?: (line: string) => void;
  /** Called after a run that recorded anything, so the CSV mirrors catch up. */
  onChanged?: () => void;
}

/** Runs the confirmation once shortly after boot, then daily. Never overlaps itself and never
 *  throws: a failed run is logged and retried on the next tick. */
export function startDeepgramConfirmations(
  db: Database.Database,
  opts: DeepgramConfirmOptions & DeepgramConfirmSchedule,
): { stop: () => void } {
  const log = opts.log ?? ((line: string) => console.log(line));
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const r = await confirmDeepgramCosts(db, opts);
      if (r.checked > 0 || r.stopped) log(formatDeepgramConfirmResult(r));
      if (r.checked > 0) opts.onChanged?.();
    } catch (err) {
      log(`[usage] deepgram confirmations failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  let interval: ReturnType<typeof setInterval> | null = null;
  const initial = setTimeout(() => {
    void run();
    interval = setInterval(() => void run(), opts.intervalMs ?? 24 * 3_600_000);
    interval.unref?.();
  }, opts.initialDelayMs ?? 10 * 60_000);
  initial.unref?.();
  return {
    stop: () => {
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    },
  };
}
