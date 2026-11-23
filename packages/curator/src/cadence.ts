const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
};

/**
 * Parse a cadence string ('7d' | '24h' | '90m' | '2w') to milliseconds.
 * null/undefined/blank → `defaultMs`. A malformed non-empty string throws,
 * so create-or-update-wiki can reject bad caller input at the edge.
 */
export function parseCadence(cadence: string | null | undefined, defaultMs: number): number {
  if (cadence === null || cadence === undefined || cadence.trim() === '') return defaultMs;
  const m = /^(\d+)\s*([mhdw])$/.exec(cadence.trim().toLowerCase());
  if (!m) throw new Error(`invalid cadence "${cadence}" — use e.g. "7d", "24h", "90m", "2w"`);
  const n = Number(m[1]);
  if (n < 1) throw new Error(`invalid cadence "${cadence}" — amount must be a positive integer (e.g. "7d")`);
  return n * UNIT_MS[m[2]!]!;
}

/**
 * True when a vault+web wiki is due for a time-based refresh: never curated
 * (null/unparseable prior) → due; otherwise due once its age reaches cadenceMs.
 * Pure — `now` is injected for deterministic tests.
 */
export function isCadenceDue(priorCuratedAt: string | null, cadenceMs: number, now: Date): boolean {
  if (!priorCuratedAt) return true;
  const t = Date.parse(priorCuratedAt);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t >= cadenceMs;
}
