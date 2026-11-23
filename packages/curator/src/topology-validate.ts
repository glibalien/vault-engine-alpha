import { parseWikiScope, sameWikiScope } from './topology.js';
import {
  validatePathCompressionAcknowledgments,
  validateReplacementCycles,
} from './topology-validate-graph.js';
import { isPathCompressionAncestor } from './reconcile-write-plan.js';
import { MERGE_VS_REFRESH_RULE, SYNTHESIS_BRIEF_TARGET_CHARS } from './prompts/topology.js';
import { isValidWikiPageTitle, WIKI_TITLE_FORBIDDEN_CHARACTERS, wikiPageTitlePrefix, wikiTitleKey } from '@vault/contract';
import type {
  ExistingWiki,
  NodeRef,
  ThemedPageKind,
  TopologyAction,
  TopologyPlan,
  WikiCatalogPage,
} from './types.js';

const RESERVED_TITLES = new Set(['task board', 'contacts', 'meetings', 'notes']);
const THEMED_PAGE_KINDS = new Set<ThemedPageKind>([
  'workstream', 'decision-log', 'risk-register', 'timeline',
  'stakeholder-map', 'spotlight', 'freeform',
]);

export type TopologyPlanIssueCode =
  | 'UNKNOWN_EVIDENCE_ID'
  | 'INVALID_CATALOG'
  | 'DUPLICATE_REVIEWED_PAGE_ID'
  | 'UNKNOWN_REVIEWED_PAGE_ID'
  | 'MISSING_REVIEWED_PAGE_ID'
  | 'MISSING_NODE_ROLE'
  | 'NODE_ROLE_CONFLICT'
  | 'INVALID_INACTIVE_ACTION_STATE'
  | 'INVALID_REACTIVATION_STATE'
  | 'PINNED_RETIRE'
  | 'INVALID_SCOPE'
  | 'INVALID_PLAN_KEY'
  | 'DUPLICATE_PLAN_KEY'
  | 'INVALID_TITLE'
  | 'TITLE_COLLISION'
  | 'ROOT_TITLE_COLLISION'
  | 'RESERVED_TITLE'
  | 'INVALID_KIND'
  | 'UNKNOWN_NODE_ID'
  | 'UNKNOWN_MERGE_SOURCE'
  | 'UNKNOWN_MERGE_TARGET'
  | 'EMPTY_MERGE_SOURCES'
  | 'DUPLICATE_MERGE_SOURCE'
  | 'SOURCE_TARGET_CONFLICT'
  | 'NEW_REPLACEMENT_CYCLE'
  | 'PATH_COMPRESSION_PLAN_CONFLICT'
  | 'SYNTHESIS_BRIEF_TOO_LONG';

/** A brief still over SYNTHESIS_BRIEF_TARGET_CHARS after the planner was asked to shorten it is kept, with a
 *  warning, up to this length; past it, the too-long brief stays a plan error (#633). */
export const SYNTHESIS_BRIEF_HARD_LIMIT_CHARS = 8_000;

export type TopologyPlanIssue = {
  readonly code: TopologyPlanIssueCode;
  readonly message: string;
  readonly action_index?: number;
  readonly node_id?: string;
  readonly plan_key?: string;
};

export type TopologyPlanValidationResult =
  | { readonly ok: true; readonly plan: TopologyPlan }
  | { readonly ok: false; readonly issues: readonly TopologyPlanIssue[] };

type ValidationState = {
  readonly issues: TopologyPlanIssue[];
  readonly pages: ReadonlyMap<string, WikiCatalogPage>;
  readonly planKeys: ReadonlySet<string>;
  readonly rootTitle: string;
  readonly roles: Map<string, string[]>;
  readonly actions: readonly TopologyAction[];
};

type ExistingRoleAction = Extract<TopologyAction, { op: 'keep' | 'refresh' | 'reactivate' | 'retire' }>;

export function validateTopologyPlan(
  plan: TopologyPlan,
  existingWiki: ExistingWiki,
  rootTitle: string,
  allowedEvidenceIds?: ReadonlySet<string>,
): TopologyPlanValidationResult {
  if (!existingWiki.catalog_valid) {
    return { ok: false, issues: [{ code: 'INVALID_CATALOG', message: 'Existing wiki catalog is invalid.' }] };
  }

  const pages = new Map(existingWiki.subpages.map(page => [page.id, page]));
  if (pages.size !== existingWiki.subpages.length) {
    return { ok: false, issues: [{ code: 'INVALID_CATALOG', message: 'Existing wiki catalog contains duplicate page IDs.' }] };
  }

  const issues: TopologyPlanIssue[] = [];
  if (allowedEvidenceIds) for (const action of plan.actions) {
    if ('evidence_ids' in action && action.evidence_ids?.some(id => !allowedEvidenceIds.has(id)))
      issues.push({ code: 'UNKNOWN_EVIDENCE_ID', message: 'Select evidence IDs only from the prepared source inventory.' });
  }
  validateReviewedPageIds(plan.reviewed_page_ids, pages, issues);
  const planKeys = collectPlanKeys(plan.actions, issues);
  const state: ValidationState = { issues, pages, planKeys, rootTitle, roles: new Map(), actions: plan.actions };
  plan.actions.forEach((action, index) => validateAction(action, index, state));
  validateCreateTitleCollisions(plan.actions, existingWiki.subpages, issues);
  validateRoles(state);
  issues.push(...validatePathCompressionAcknowledgments(plan.actions, existingWiki.subpages));
  issues.push(...validateReplacementCycles(plan.actions, existingWiki.subpages));

  return issues.length === 0 ? { ok: true, plan } : { ok: false, issues };
}

/** The rejected plan travels with its issues: their action_index values count its actions. */
/** Issues that come from using merge where refresh was meant (#257). */
const MERGE_MISUSE_CODES: ReadonlySet<TopologyPlanIssueCode> = new Set<TopologyPlanIssueCode>([
  'SOURCE_TARGET_CONFLICT', 'UNKNOWN_MERGE_TARGET', 'EMPTY_MERGE_SOURCES', 'NEW_REPLACEMENT_CYCLE', 'NODE_ROLE_CONFLICT',
]);

export function buildTopologyRepairPrompt(
  issues: readonly TopologyPlanIssue[],
  rejectedPlan: TopologyPlan,
  existingWiki: ExistingWiki,
  evidence: string,
  rootTitle: string,
  attempt = 1,
): string {
  const withoutAction = issues.flatMap(issue => issue.code === 'MISSING_NODE_ROLE' && issue.node_id !== undefined ? [issue.node_id] : []);
  const mergeMisused = issues.some(issue => MERGE_MISUSE_CODES.has(issue.code));
  return JSON.stringify({
    repair_attempt: attempt,
    issues,
    // The raw issue list did not move the 11-03 planner; say plainly what is missing (#323).
    ...(withoutAction.length > 0 ? {
      pages_without_action: withoutAction,
      repair_instruction: 'Every catalog page needs exactly one action: keep, refresh, reactivate or retire it, or name it in a merge as a source or the target. Return the complete plan again with an action for each page in pages_without_action, and fix every other issue listed.',
    } : {}),
    // Planners that merged where they meant refresh got further from a valid plan on each retry (#257).
    ...(mergeMisused ? { merge_instruction: MERGE_VS_REFRESH_RULE } : {}),
    rejected_plan: rejectedPlan,
    wiki_root_title: rootTitle,
    page_title_prefix: wikiPageTitlePrefix(rootTitle),
    evidence,
    existing_wiki: existingWiki,
  });
}

function validateReviewedPageIds(
  reviewedPageIds: readonly string[],
  pages: ReadonlyMap<string, WikiCatalogPage>,
  issues: TopologyPlanIssue[],
): void {
  const seen = new Set<string>();
  for (const nodeId of reviewedPageIds) {
    if (seen.has(nodeId)) issues.push(issue('DUPLICATE_REVIEWED_PAGE_ID', `Reviewed page ID "${nodeId}" is duplicated.`, { node_id: nodeId }));
    seen.add(nodeId);
    if (!pages.has(nodeId)) issues.push(issue('UNKNOWN_REVIEWED_PAGE_ID', `Reviewed page ID "${nodeId}" is not in the catalog.`, { node_id: nodeId }));
  }
  for (const nodeId of pages.keys()) {
    if (!seen.has(nodeId)) issues.push(issue('MISSING_REVIEWED_PAGE_ID', `Catalog page "${nodeId}" was not reviewed.`, { node_id: nodeId }));
  }
}

function collectPlanKeys(
  actions: readonly TopologyAction[],
  issues: TopologyPlanIssue[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  actions.forEach((action, index) => {
    if (action.op !== 'create') return;
    if (!validToken(action.plan_key)) issues.push(issue('INVALID_PLAN_KEY', 'Create plan_key must be a trimmed non-empty string.', { action_index: index, plan_key: action.plan_key }));
    if (keys.has(action.plan_key)) issues.push(issue('DUPLICATE_PLAN_KEY', `Plan key "${action.plan_key}" is duplicated.`, { action_index: index, plan_key: action.plan_key }));
    keys.add(action.plan_key);
  });
  return keys;
}

function validateAction(action: TopologyAction, index: number, state: ValidationState): void {
  if (!parseWikiScope(action.scope).ok) state.issues.push(issue('INVALID_SCOPE', 'Action scope is invalid.', { action_index: index }));
  validateBriefLength(action, index, state.issues);
  switch (action.op) {
    case 'keep':
    case 'refresh': {
      const page = addExistingRole(action, index, state);
      if (page !== undefined && page.wiki_state !== 'active'
        && (action.op === 'refresh'
          || ((page.wiki_scope === undefined || page.wiki_scope_error !== undefined || !sameWikiScope(page.wiki_scope, action.scope))
            && !isPathCompressionAncestor(page.id, state.actions, state.pages)))) {
        state.issues.push(issue('INVALID_INACTIVE_ACTION_STATE', `Inactive page "${action.node_id}" requires reactivate, merge, or retire.`, { action_index: index, node_id: action.node_id }));
      }
      return;
    }
    case 'reactivate': {
      const page = addExistingRole(action, index, state);
      if (page?.wiki_state === 'active') state.issues.push(issue('INVALID_REACTIVATION_STATE', `Active page "${action.node_id}" cannot be reactivated.`, { action_index: index, node_id: action.node_id }));
      return;
    }
    case 'retire': {
      const page = addExistingRole(action, index, state);
      if (page?.wiki_pinned) state.issues.push(issue('PINNED_RETIRE', `Pinned page "${action.node_id}" cannot be retired.`, { action_index: index, node_id: action.node_id }));
      return;
    }
    case 'create':
      validateCreate(action, index, state.rootTitle, state.issues);
      return;
    case 'merge':
      validateMerge(action, index, state);
      return;
    default:
      return assertNever(action);
  }
}

/** A brief over the target goes back to the planner to shorten (#633); the schema sent to the model no longer
 *  limits its length, since a provider enforcing that limit cut briefs off mid-word. */
function validateBriefLength(action: TopologyAction, index: number, issues: TopologyPlanIssue[]): void {
  if (!('synthesis_brief' in action) || action.synthesis_brief.length <= SYNTHESIS_BRIEF_TARGET_CHARS) return;
  const target = action.op === 'create' ? { plan_key: action.plan_key } : action.op === 'merge' ? action.target : { node_id: action.node_id };
  issues.push(issue('SYNTHESIS_BRIEF_TOO_LONG', `synthesis_brief is ${action.synthesis_brief.length} characters, over the `
    + `${SYNTHESIS_BRIEF_TARGET_CHARS}-character limit. Shorten it to ${SYNTHESIS_BRIEF_TARGET_CHARS} characters or fewer, keeping the coverage it names.`,
  { action_index: index, ...target }));
}

function validateCreate(
  action: Extract<TopologyAction, { op: 'create' }>,
  index: number,
  rootTitle: string,
  issues: TopologyPlanIssue[],
): void {
  const title = action.title.trim();
  // The Engine's rule (#557), checked here so the repair loop fixes a title before any page is paid for.
  if (!isValidWikiPageTitle(action.title)) {
    issues.push(issue('INVALID_TITLE', `Create title "${action.title}" is not a valid page title: it must be trimmed and non-empty, not "." or "..", and contain none of ${WIKI_TITLE_FORBIDDEN_CHARACTERS}.`, { action_index: index, plan_key: action.plan_key }));
  }
  if (wikiTitleKey(action.title) === wikiTitleKey(rootTitle)) {
    issues.push(issue('ROOT_TITLE_COLLISION', `Create title collides with wiki root "${rootTitle}".`, { action_index: index, plan_key: action.plan_key }));
  }
  if (RESERVED_TITLES.has(title.toLowerCase())) issues.push(issue('RESERVED_TITLE', `Create title "${title}" is reserved.`, { action_index: index, plan_key: action.plan_key }));
  if (!THEMED_PAGE_KINDS.has(action.kind)) issues.push(issue('INVALID_KIND', `Create kind "${action.kind}" is invalid.`, { action_index: index, plan_key: action.plan_key }));
}

/** Two new pages can't share a title, and a new page can't take an existing page's title (#557). */
function validateCreateTitleCollisions(
  actions: readonly TopologyAction[],
  subpages: readonly WikiCatalogPage[],
  issues: TopologyPlanIssue[],
): void {
  const existing = new Map(subpages.map(page => [wikiTitleKey(page.title), page]));
  const created = new Set<string>();
  actions.forEach((action, index) => {
    if (action.op !== 'create') return;
    const key = wikiTitleKey(action.title);
    if (created.has(key)) {
      issues.push(issue('TITLE_COLLISION', `Create title "${action.title}" is used by another new page in this plan; give each new page its own title.`, { action_index: index, plan_key: action.plan_key }));
    }
    created.add(key);
    const page = existing.get(key);
    if (page !== undefined) {
      issues.push(issue('TITLE_COLLISION', `Create title "${action.title}" is the title of existing page "${page.id}"; refresh, reactivate or merge that page, or choose another title.`, { action_index: index, plan_key: action.plan_key, node_id: page.id }));
    }
  });
}

function validateMerge(
  action: Extract<TopologyAction, { op: 'merge' }>,
  index: number,
  state: ValidationState,
): void {
  if (action.sources.length === 0) state.issues.push(issue('EMPTY_MERGE_SOURCES', 'Merge must name at least one source.', { action_index: index }));
  const targetNodeId = nodeIdOf(action.target);
  if (targetNodeId !== undefined) addMergeTargetRole(targetNodeId, index, state);
  const targetPlanKey = planKeyOf(action.target);
  if (targetPlanKey !== undefined && (!validToken(targetPlanKey) || !state.planKeys.has(targetPlanKey))) {
    state.issues.push(issue('UNKNOWN_MERGE_TARGET', `Merge target plan key "${targetPlanKey}" is not defined.`, { action_index: index, plan_key: targetPlanKey }));
  }

  const seenSources = new Set<string>();
  for (const source of action.sources) {
    if (seenSources.has(source)) state.issues.push(issue('DUPLICATE_MERGE_SOURCE', `Merge source "${source}" is duplicated.`, { action_index: index, node_id: source }));
    seenSources.add(source);
    const page = state.pages.get(source);
    if (page === undefined) state.issues.push(issue('UNKNOWN_MERGE_SOURCE', `Merge source "${source}" is not in the catalog.`, { action_index: index, node_id: source }));
    else addRole(source, 'merge-source', state.roles);
    if (source === targetNodeId) state.issues.push(issue('SOURCE_TARGET_CONFLICT', `Page "${source}" cannot be its own merge target.`, { action_index: index, node_id: source }));
  }
}

function addExistingRole(
  action: ExistingRoleAction,
  index: number,
  state: ValidationState,
): WikiCatalogPage | undefined {
  const page = state.pages.get(action.node_id);
  if (page === undefined) {
    state.issues.push(issue('UNKNOWN_NODE_ID', `Action node "${action.node_id}" is not in the catalog.`, { action_index: index, node_id: action.node_id }));
    return undefined;
  }
  addRole(action.node_id, action.op, state.roles);
  return page;
}

function addMergeTargetRole(nodeId: string, index: number, state: ValidationState): void {
  if (!state.pages.has(nodeId)) {
    state.issues.push(issue('UNKNOWN_MERGE_TARGET', `Merge target "${nodeId}" is not in the catalog.`, { action_index: index, node_id: nodeId }));
    return;
  }
  addRole(nodeId, 'merge-target', state.roles);
}

function validateRoles(state: ValidationState): void {
  for (const nodeId of state.pages.keys()) {
    const roles = state.roles.get(nodeId) ?? [];
    if (roles.length === 0) state.issues.push(issue('MISSING_NODE_ROLE', `Catalog page "${nodeId}" has no terminal role.`, { node_id: nodeId }));
    if (roles.length > 1) state.issues.push(issue('NODE_ROLE_CONFLICT', `Catalog page "${nodeId}" has incompatible roles: ${roles.join(', ')}.`, { node_id: nodeId }));
  }
}

function addRole(nodeId: string, role: string, roles: Map<string, string[]>): void {
  const existing = roles.get(nodeId);
  if (existing === undefined) roles.set(nodeId, [role]);
  else existing.push(role);
}

function validToken(value: string): boolean {
  return value !== '' && value.trim() === value;
}

function nodeIdOf(ref: NodeRef): string | undefined {
  return 'node_id' in ref ? ref.node_id : undefined;
}

function planKeyOf(ref: NodeRef): string | undefined {
  return 'plan_key' in ref ? ref.plan_key : undefined;
}

function issue(
  code: TopologyPlanIssueCode,
  message: string,
  context: Omit<TopologyPlanIssue, 'code' | 'message'> = {},
): TopologyPlanIssue {
  return { code, message, ...context };
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected topology action: ${JSON.stringify(value)}`);
}
