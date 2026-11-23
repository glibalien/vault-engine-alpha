export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number; }

/** Wall-clock parts of an instant, read in the given IANA timezone. */
function partsInTz(date: Date, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  // legacy ICU guard: some older ICU builds emit '24' for midnight
  const hour = Number(map['hour']) === 24 ? 0 : Number(map['hour']);
  return {
    year: Number(map['year']), month: Number(map['month']), day: Number(map['day']),
    hour, minute: Number(map['minute']), second: Number(map['second']),
  };
}

/** Offset (ms) of tz at the given instant: localWallAsUTC − actualUTC. */
function tzOffsetMs(date: Date, tz: string): number {
  const p = partsInTz(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

/** Convert a wall-clock time in tz to the corresponding UTC instant (DST-aware). */
function zonedWallToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offset = tzOffsetMs(new Date(guess), tz);
  let ts = guess - offset;
  const offset2 = tzOffsetMs(new Date(ts), tz); // refine across a DST edge
  if (offset2 !== offset) ts = guess - offset2;
  return new Date(ts);
}

/** The UTC instant of the most recent local midnight in `tz` (DST-aware). */
export function startOfLocalDay(now: Date, tz: string): Date {
  const today = partsInTz(now, tz);
  return zonedWallToUtc(today.year, today.month, today.day, 0, 0, tz);
}

/**
 * The next instant whose wall-clock time in `tz` equals `hhmm` and is strictly
 * after `now`. DST-correct: recomputed from calendar parts, never `+24h` math,
 * so the next fire is never cached across a transition.
 */
export function computeNextRun(now: Date, hhmm: string, tz: string): Date {
  // h/m are `number | undefined` under noUncheckedIndexedAccess; the registry's
  // `hhmm` type (validated on every settings write) guarantees a valid HH:MM
  // reaches here, so the ?? 0 fallback is unreachable.
  const [h, m] = hhmm.split(':').map(Number);
  const today = partsInTz(now, tz);
  const base = new Date(Date.UTC(today.year, today.month - 1, today.day));
  for (let addDays = 0; addDays <= 2; addDays++) {
    const day = new Date(base);
    day.setUTCDate(day.getUTCDate() + addDays);
    const candidate = zonedWallToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h ?? 0, m ?? 0, tz);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  throw new Error('computeNextRun: no candidate found'); // unreachable for sane hhmm
}

export function needsCatchUp(hint: Date | null, now: Date, intervalMs: number): boolean {
  if (hint === null) return true;
  return now.getTime() - hint.getTime() > intervalMs;
}

export interface Clock { now(): Date; }
export interface TimerHandle { clear(): void; }
// cb may be async so tests can `await captured()` to drive a fire deterministically.
export type TimerFn = (cb: () => void | Promise<void>, ms: number) => TimerHandle;

export interface SchedulerOpts {
  /** Read fresh on every (re-)arm — sweepAt/tz changes take effect after the next run or restart. */
  schedule: () => { hhmm: string; tz: string };
  clock?: Clock;
  setTimer?: TimerFn;
  sweep: () => Promise<void>;
  onError?: (err: unknown) => void;
}

export interface SchedulerHandle { stop(): void; }

/**
 * Internal daily scheduler. On each fire it runs the sweep, then recomputes the
 * next fire from fresh wall-clock AND a fresh `schedule()` read and re-arms
 * (DST-correct by construction; sweepAt/tz edits during a run apply starting
 * with the next re-arm). If `onError` is omitted, a thrown sweep is swallowed
 * (the loop still re-arms); supply `onError` to log failures.
 */
export function startScheduler(opts: SchedulerOpts): SchedulerHandle {
  const clock: Clock = opts.clock ?? { now: () => new Date() };
  const setTimer: TimerFn = opts.setTimer ?? ((cb, ms) => {
    const t = setTimeout(cb, ms);
    return { clear: () => clearTimeout(t) };
  });

  let handle: TimerHandle | null = null;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;
    const now = clock.now();
    const { hhmm, tz } = opts.schedule();
    const next = computeNextRun(now, hhmm, tz);
    const delay = Math.max(0, next.getTime() - now.getTime());
    handle = setTimer(async () => {
      try { await opts.sweep(); } catch (err) { opts.onError?.(err); }
      arm();
    }, delay);
  };

  arm();
  return { stop: () => { stopped = true; handle?.clear(); } };
}
