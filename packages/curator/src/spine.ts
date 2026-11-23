import type { WikiSubpageRef } from './types.js';

/** Project-qualify a sub-page node title; bare titles would collide on disk across projects. */
export function subpageTitle(projectTitle: string, label: string): string {
  return `${projectTitle} — ${label}`;
}

/**
 * Former spine labels — no longer planned. Their project-qualified titles stay
 * reserved so existing pages route to the one-time retirement migration in
 * curateProject (retire-don't-delete) instead of being misclassified as themed.
 */
export const RETIRED_SPINE_LABELS: readonly string[] = ['Task Board', 'Meetings', 'Contacts', 'Notes'];

/**
 * Split a project's existing sub-pages: retired-spine pages (Task Board / Meetings /
 * Contacts / Notes — migration targets; the deterministic spine is fully retired, so
 * `spine` is always []) and emergent themed pages (everything else). Themed pages are
 * the only group shown to the model to keep/retire. Pure — unit-tested.
 */
export function partitionSubpages(
  projectTitle: string,
  subpages: WikiSubpageRef[],
): { spine: WikiSubpageRef[]; themed: WikiSubpageRef[]; legacy: WikiSubpageRef[] } {
  const retired = new Set(RETIRED_SPINE_LABELS.map(label => subpageTitle(projectTitle, label)));
  const spine: WikiSubpageRef[] = [];
  const themed: WikiSubpageRef[] = [];
  const legacy: WikiSubpageRef[] = [];
  for (const sub of subpages) {
    (retired.has(sub.title) ? legacy : themed).push(sub);
  }
  return { spine, themed, legacy };
}

/**
 * @deprecated Display/qualification compatibility only. Requested-page identity
 * is decided by semantic scope through the reconciliation pipeline.
 */
export function resolveRequestedTitle(
  projectTitle: string,
  requested: string,
  existing: WikiSubpageRef[],
): { qualifiedTitle: string; existingId: string | null } {
  const qualified = subpageTitle(projectTitle, requested);
  for (const sub of existing) {
    if (sub.title === requested || sub.title === qualified) {
      return { qualifiedTitle: sub.title, existingId: sub.id };
    }
  }
  return { qualifiedTitle: qualified, existingId: null };
}
