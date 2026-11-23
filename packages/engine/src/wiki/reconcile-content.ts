import type { ResolvedWikiReconcilePlan } from './reconcile-types.js';
import { calendarDate } from './today.js';

export function reconcileStamp(plan: ResolvedWikiReconcilePlan): string {
  return JSON.stringify({ v: 1, key: plan.reconcile_key, plan_digest: plan.plan_digest });
}

export function mergeLogEntry(
  plan: ResolvedWikiReconcilePlan,
  sourceTitles: readonly string[],
  targetTitle: string,
): string {
  return `- ${plan.home.curated_at}: Reconciliation \`${plan.reconcile_key}\` merged ${sourceTitles.map(title => `[[${title}]]`).join(', ')} into [[${targetTitle}]].`;
}

/** A retired or dormant page's Status line, dated with the build's day in `timeZone` (`wikiTimeZone`, #459). */
export function retirementStatus(
  plan: ResolvedWikiReconcilePlan,
  input: {
    readonly state: 'dormant' | 'retired';
    readonly reason: string;
    readonly targetTitle?: string;
  },
  timeZone: string,
): string {
  const target = input.targetTitle === undefined ? '' : ` Successor: [[${input.targetTitle}]].`;
  const curatedAt = Date.parse(plan.home.curated_at);
  const day = Number.isFinite(curatedAt) ? calendarDate(curatedAt, timeZone) : plan.home.curated_at.slice(0, 10);
  return `${input.state === 'dormant' ? 'Dormant' : 'Retired'} ${day} by reconciliation \`${plan.reconcile_key}\`: ${input.reason}${target}`;
}
