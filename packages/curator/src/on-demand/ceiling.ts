import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { onDemandSpentSince } from '../db/on-demand-runs.js';
import { startOfLocalDay } from '../scheduler.js';
import { roundUsd } from './cost.js';

/**
 * The owner's ceiling for all on-demand runs in a day, and what is left of it. A run's limit is a
 * number its caller states, and its caller is usually a model: the ceiling is the bound the owner
 * sets, in settings, on what such callers can spend between them, whatever the job. Null when
 * there is none.
 */
export interface RunCeiling {
  daily_usd: number;
  spent_today_usd: number;
  remaining_usd: number;
}

export const RUN_CEILING_SETTING = 'runDailyBudgetCents';

export function runCeiling(deps: { db?: Database.Database | undefined; config: Config }, now: Date = new Date()): RunCeiling | null {
  const cents = deps.config.runDailyBudgetCents;
  if (cents === undefined || cents === null || deps.db === undefined) return null;
  const spent = onDemandSpentSince(deps.db, startOfLocalDay(now, deps.config.curatorTz).toISOString());
  const daily = cents / 100;
  return { daily_usd: daily, spent_today_usd: roundUsd(spent), remaining_usd: Math.max(0, Math.floor((daily - spent) * 100) / 100) };
}

/** Why a run asking for `limitUsd` cannot start under the day's ceiling, or null when it can. */
export function overCeiling(ceiling: RunCeiling | null, limitUsd: number): string | null {
  if (ceiling === null || limitUsd <= ceiling.remaining_usd) return null;
  const setting = `The ceiling is the curator setting ${RUN_CEILING_SETTING}, which the owner sets.`;
  if (ceiling.daily_usd === 0) return `On-demand runs are turned off (${RUN_CEILING_SETTING} is 0). ${setting}`;
  const day = `Today's ceiling for on-demand runs is $${ceiling.daily_usd.toFixed(2)} and $${ceiling.spent_today_usd.toFixed(2)} of it is spent`;
  return ceiling.remaining_usd <= 0
    ? `${day}, so no run can start today. ${setting}`
    : `${day}, so this run may be given at most $${ceiling.remaining_usd.toFixed(2)}. ${setting}`;
}

/**
 * A limit with room over the estimate: half as much again, at least five cents, and no more than
 * what is left of the day's ceiling. Null with no estimate, or nothing left.
 */
export function suggestedLimitUsd(estimatedCostUsd: number | null, ceiling: RunCeiling | null = null): number | null {
  if (estimatedCostUsd === null) return null;
  const roomy = Math.max(0.05, Math.ceil(estimatedCostUsd * 1.5 * 100) / 100);
  if (ceiling === null) return roomy;
  return ceiling.remaining_usd <= 0 ? null : Math.min(roomy, ceiling.remaining_usd);
}

/**
 * What a preview tells its caller about the limit to start with: the figure to suggest, what the
 * day's ceiling leaves, and why to start with that figure.
 */
export interface LimitAdvice {
  /** The limit to suggest; null when there is no estimate, or nothing is left of the day. */
  limit: number | null;
  /** The owner's bound on what callers like this one can spend between them in a day; absent with no ceiling. */
  run_ceiling_note?: string;
  /** What the suggested start call is for. */
  purpose: string;
}

export function limitAdvice(estimatedCostUsd: number | null, ceiling: RunCeiling | null): LimitAdvice {
  const limit = suggestedLimitUsd(estimatedCostUsd, ceiling);
  const short = ceiling !== null && estimatedCostUsd !== null && estimatedCostUsd > ceiling.remaining_usd;
  const purpose = short
    ? `Start the run once the user agrees to the sample and the cost. ${limit} is what is left of today's ceiling; the run stops there, short of the whole set.`
    : `Start the run once the user agrees to the sample and the cost. ${limit} is the estimate and half as much again; the run stops there.`;
  if (ceiling === null) return { limit, purpose };
  const day = `$${ceiling.daily_usd.toFixed(2)}, the curator setting ${RUN_CEILING_SETTING}`;
  return {
    limit,
    purpose,
    run_ceiling_note: ceiling.remaining_usd <= 0
      ? `Today's ceiling for on-demand runs (${day}) is spent${ceiling.daily_usd === 0 ? ': on-demand runs are turned off' : ''}, so no run can start today.`
      : short
        ? `The estimate is more than what is left of today's ceiling for on-demand runs ($${ceiling.remaining_usd.toFixed(2)} of ${day}). A run can do part of the set today and be started again another day, or the owner can raise the ceiling.`
        : `$${ceiling.remaining_usd.toFixed(2)} is left of today's ceiling for on-demand runs (${day}). A run's limit must fit it.`,
  };
}
