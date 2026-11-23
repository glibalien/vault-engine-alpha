import { rewriteExactCreateMatches } from './adjudicate-transform.js';
import { wikiScopeComparisonKey } from './topology.js';
import type { ExistingWiki, ThemedPageKind, TopologyAction, TopologyPlan, WikiCatalogPage } from './types.js';

/** What a sub-page of one kind is for, and the outline its Summary follows. */
export interface PageTemplate {
  /** One line for the planner choosing a kind. */
  readonly description: string;
  /** `##` sections in order; a section with nothing supported is omitted, never padded. */
  readonly headings: readonly string[];
  readonly guidance: string;
}

export const PAGE_TEMPLATES: Readonly<Record<ThemedPageKind, PageTemplate>> = {
  workstream: {
    description: 'An ongoing stream of work: where it stands, what is next, what blocks it.',
    headings: ['Current state', 'Next steps', 'Blockers', 'History'],
    guidance: 'Describe current state, supported blockers and next actions, and linked history.',
  },
  'decision-log': {
    description: 'Decisions taken, with dates and rationale, kept apart from open questions.',
    headings: ['Decisions', 'Open questions', 'Superseded'],
    guidance: 'Keep dated decisions and their rationale; keep superseded history distinct from proposals.',
  },
  'risk-register': {
    description: 'Risks and issues that could affect the subject, current and resolved.',
    headings: ['Current risks', 'Mitigations', 'Resolved'],
    guidance: 'Distinguish current and resolved risks; do not reopen resolved items without evidence.',
  },
  timeline: {
    description: 'Dated events and milestones in order.',
    headings: ['Upcoming', 'Recent', 'Earlier'],
    guidance: 'Order dated events; label proposed, agreed and occurred events distinctly.',
  },
  'stakeholder-map': {
    description: 'The people and organizations involved and how they relate to the subject.',
    headings: ['People', 'Organizations', 'Relationships'],
    guidance: 'Describe sourced roles and relationships without inferred commitments.',
  },
  spotlight: {
    description: 'One focused subject (a deliverable, system, event or idea) and why it matters.',
    headings: ['Overview', 'Why it matters', 'Details'],
    guidance: 'Explain the scoped subject and its supported significance.',
  },
  freeform: {
    description: 'Anything that fits no other kind.',
    headings: [],
    guidance: 'Organize the page by what the evidence covers and keep useful supported history.',
  },
};

/** Planner-facing kind descriptions. */
export function pageKindDescriptions(): Record<ThemedPageKind, string> {
  return Object.fromEntries(Object.entries(PAGE_TEMPLATES).map(([kind, template]) => [kind, template.description])) as
    Record<ThemedPageKind, string>;
}

/** Caps on automatically created pages; requested pages are exempt. */
export interface PageLimits {
  readonly maxActivePages: number;
  readonly maxActivePerKind: number;
  readonly maxCreatesPerRun: number;
}

export interface DroppedCreate {
  readonly title: string;
  readonly kind: ThemedPageKind;
  readonly reason: 'creates-per-run' | 'active-pages' | 'active-per-kind';
}

function isActive(page: WikiCatalogPage): boolean {
  return page.wiki_state === undefined || page.wiki_state === 'active';
}

function activeKinds(existingWiki: ExistingWiki, leaving: ReadonlySet<string> = new Set()): ThemedPageKind[] {
  return existingWiki.subpages
    .filter(page => isActive(page) && !leaving.has(page.id))
    .map(page => page.wiki_kind ?? 'freeform');
}

/** What the planner is told about the limits for this wiki. */
export function pageLimitsPayload(limits: PageLimits, existingWiki: ExistingWiki) {
  const byKind: Partial<Record<ThemedPageKind, number>> = {};
  for (const kind of activeKinds(existingWiki)) byKind[kind] = (byKind[kind] ?? 0) + 1;
  return { max_active_pages: limits.maxActivePages, max_active_per_kind: limits.maxActivePerKind,
    max_creates_this_run: limits.maxCreatesPerRun, active_pages_by_kind: byKind };
}

/**
 * Keeps creates in plan order while they fit the limits, counting today's active pages.
 * Capacity is charged against the plan adjudication will write: `rewriteExactCreateMatches`
 * folds same-scope creates into one survivor and turns a create matching an existing page into
 * a refresh or reactivation of it (cancelling that page's retirement). Pages leaving through a
 * retirement or merge free capacity; pages coming back use it before any new page. Merge-target
 * creates are always kept (and counted): other actions reference them. The plan commits whole.
 */
export function enforcePageLimits(plan: TopologyPlan, existingWiki: ExistingWiki, limits: PageLimits):
  { plan: TopologyPlan; dropped: DroppedCreate[] } {
  const normalized = rewriteExactCreateMatches(plan, existingWiki).plan;
  const pageById = new Map(existingWiki.subpages.map(page => [page.id, page]));
  const leaving = new Set(normalized.actions.flatMap(action =>
    action.op === 'retire' ? [action.node_id] : action.op === 'merge' ? action.sources : []));
  const returning = normalized.actions.flatMap(action => {
    const page = action.op === 'reactivate' ? pageById.get(action.node_id) : undefined;
    return page && !isActive(page) && !leaving.has(page.id) ? [page.wiki_kind ?? 'freeform'] : [];
  });
  const mergeTargets = new Set(normalized.actions.flatMap(action =>
    action.op === 'merge' && 'plan_key' in action.target ? [action.target.plan_key] : []));
  // The create each scope folds into, when it still adds a page.
  const survivors = new Map<string, Extract<TopologyAction, { op: 'create' }>>();
  for (const action of normalized.actions) {
    if (action.op === 'create') survivors.set(wikiScopeComparisonKey(action.scope), action);
  }
  const byKind = new Map<ThemedPageKind, number>();
  const active = [...activeKinds(existingWiki, leaving), ...returning];
  for (const kind of active) byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  let total = active.length;
  let created = 0;
  const dropped: DroppedCreate[] = [];
  // Every create of a scope shares its survivor's verdict, so folding cannot revive a dropped page.
  const verdicts = new Map<string, boolean>();
  const actions = plan.actions.filter(action => {
    if (action.op !== 'create') return true;
    const key = wikiScopeComparisonKey(action.scope);
    const survivor = survivors.get(key);
    if (survivor === undefined) return true;
    const decided = verdicts.get(key);
    if (decided !== undefined) return decided;
    const kindCount = byKind.get(survivor.kind) ?? 0;
    const reason = mergeTargets.has(survivor.plan_key) ? null
      : created >= limits.maxCreatesPerRun ? 'creates-per-run'
      : total >= limits.maxActivePages ? 'active-pages'
      : kindCount >= limits.maxActivePerKind ? 'active-per-kind' : null;
    verdicts.set(key, reason === null);
    if (reason) {
      dropped.push({ title: survivor.title, kind: survivor.kind, reason });
      return false;
    }
    created += 1;
    total += 1;
    byKind.set(survivor.kind, kindCount + 1);
    return true;
  });
  return { plan: { ...plan, actions }, dropped };
}
