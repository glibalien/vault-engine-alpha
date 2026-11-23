import type { Config } from './config.js';

/**
 * Should a project be auto-moved to the stale/backlog status after a sweep? True
 * only when its wiki was curated longer ago than `staleProjectDays` AND its current
 * status is not already terminal/backlog (`staleSkipStatuses`). A null/undefined or
 * unparseable `curatedAt` means "no wiki / never curated" → exempt (false). Pure;
 * `now` is injected so the predicate is deterministic in tests.
 */
export function isStale(
  curatedAt: string | null | undefined,
  status: string | null,
  config: Config,
  now: Date,
): boolean {
  if (!curatedAt) return false;
  const t = Date.parse(curatedAt);
  if (Number.isNaN(t)) return false;
  if (status !== null && config.staleSkipStatuses.includes(status)) return false;
  const ageDays = (now.getTime() - t) / 86_400_000;
  return ageDays > config.staleProjectDays;
}
