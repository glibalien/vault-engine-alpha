#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `Usage:
  node scripts/audit-wiki-reconciliation.mjs --before FILE --preview FILE
  node scripts/audit-wiki-reconciliation.mjs --before FILE --preview FILE --after FILE --second-run FILE

Inputs are read-only JSON artifacts:
  --before      Pre-run project-evidence/catalog snapshot.
  --preview     reconcile-wiki-pages dry-run response.
  --after       Combined post-run catalog + real reconcile-wiki-pages response.
  --second-run  Immediate unchanged real-mode response (must be skipped).

The full audit requires source_preservation entries in --after for every merged
or retired source, for example:
  {"node_id":"node-1","preserved_outside_managed_status":true}

The report never includes page bodies. Exit status is 0 when safe, 1 when an
audit invariant fails, and 2 for invalid arguments or unreadable artifacts.`;

export function auditArtifacts({ before: beforeRaw, preview: previewRaw, after: afterRaw, secondRun: secondRaw }) {
  const issues = [];
  const before = findCatalog(beforeRaw);
  const preview = findReconcileResult(previewRaw);
  if (before === null) throw new AuditInputError('The --before artifact contains no wiki catalog.');
  if (preview === null) throw new AuditInputError('The --preview artifact contains no reconcile-wiki-pages result.');

  auditPreview(before, preview, issues);
  let after = null;
  let post = null;
  let second = null;
  if (afterRaw !== undefined) {
    after = findCatalog(afterRaw);
    post = findReconcileResult(afterRaw);
    second = findReconcileResult(secondRaw);
    if (after === null) throw new AuditInputError('The --after artifact contains no wiki catalog.');
    if (post === null) throw new AuditInputError('The --after artifact contains no real reconcile-wiki-pages result.');
    if (second === null) throw new AuditInputError('The --second-run artifact contains no reconcile-wiki-pages result.');
    auditPostState(before, preview, after, post, findSourcePreservation(afterRaw), issues);
    auditConvergence(after, second, issues);
  }

  return {
    ok: issues.length === 0,
    mode: after === null ? 'preview' : 'post-run',
    summary: {
      before_pages: before.subpages.length,
      reviewed_pages: uniqueStrings(preview.reviewed_page_ids).length,
      planned_creates: finalActions(preview).filter(action => action.op === 'create').length,
      planned_merges: finalActions(preview).filter(action => action.op === 'merge').length,
      planned_retires: finalActions(preview).filter(action => action.op === 'retire').length,
      ...(after === null ? {} : { after_pages: after.subpages.length }),
    },
    issues,
  };
}

function auditPreview(before, preview, issues) {
  if (preview.dry_run !== true) addIssue(issues, 'PREVIEW_NOT_DRY_RUN', 'Preview artifact is not marked dry_run:true.');
  if (preview.catalog_health?.valid === false) addIssue(issues, 'INVALID_CATALOG', 'Preview reports an invalid wiki catalog.');

  const beforeIds = before.subpages.map(page => page.id);
  auditReviewedIds(beforeIds, preview.proposed_reviewed_page_ids, 'proposed_reviewed_page_ids', 'MISSING_PROPOSED_REVIEWED_ID', issues);
  auditReviewedIds(beforeIds, preview.reviewed_page_ids, 'reviewed_page_ids', 'MISSING_REVIEWED_ID', issues);

  const actions = finalActions(preview);
  for (const action of actions) {
    if (!['keep', 'refresh', 'reactivate', 'create', 'merge', 'retire'].includes(action.op)) {
      addIssue(issues, 'FORBIDDEN_OPERATION', `Unsupported or delete-like topology operation ${String(action.op)}.`);
    }
    if (action.op === 'retire') {
      const target = before.subpages.find(page => page.id === action.node_id);
      if (target?.wiki_pinned === true) addIssue(issues, 'PINNED_RETIRE', `Pinned page ${action.node_id} is planned for retirement.`, { node_id: action.node_id });
    }
  }
  auditCreateVerdicts(before, preview, actions, issues);
}

function auditReviewedIds(beforeIds, rawReviewed, field, missingCode, issues) {
  const reviewed = Array.isArray(rawReviewed) ? rawReviewed : [];
  const reviewedSet = new Set(reviewed);
  if (reviewed.length !== reviewedSet.size) addIssue(issues, 'DUPLICATE_REVIEWED_ID', `${field} contains duplicate reviewed page IDs.`, { field });
  for (const id of beforeIds) {
    if (!reviewedSet.has(id)) addIssue(issues, missingCode, `Catalog page ${id} is absent from ${field}.`, { node_id: id, field });
  }
  for (const id of reviewedSet) {
    if (!beforeIds.includes(id)) addIssue(issues, 'UNKNOWN_REVIEWED_ID', `Reviewed page ${id} in ${field} is absent from the pre-run catalog.`, { node_id: id, field });
  }
}

function auditCreateVerdicts(before, preview, actions, issues) {
  const creates = actions.filter(action => action.op === 'create');
  const merges = actions.filter(action => action.op === 'merge');
  const verdicts = Array.isArray(preview.adjudication_verdicts) ? preview.adjudication_verdicts : [];
  const requirePair = (leftKey, rightRef, label) => {
    const match = verdicts.find(verdict =>
      (verdict.candidate_plan_key === leftKey && sameRef(verdict.compared_to, rightRef))
      || ('plan_key' in rightRef && verdict.candidate_plan_key === rightRef.plan_key && sameRef(verdict.compared_to, { plan_key: leftKey })),
    );
    if (match === undefined) {
      addIssue(issues, 'MISSING_CREATE_VERDICT', `Create ${leftKey} lacks a complete-catalog verdict against ${label}.`, { plan_key: leftKey });
    } else if (match.relation !== 'distinct') {
      addIssue(issues, 'CREATE_NOT_DISTINCT', `Create ${leftKey} has non-distinct verdict ${String(match.relation)} against ${label}.`, { plan_key: leftKey });
    }
  };

  for (const candidate of creates) {
    for (const existing of before.subpages) requirePair(candidate.plan_key, { node_id: existing.id }, `node ${existing.id}`);
    for (const other of creates) {
      if (other.plan_key > candidate.plan_key) requirePair(candidate.plan_key, { plan_key: other.plan_key }, `create ${other.plan_key}`);
    }
    for (const merge of merges) {
      if ('plan_key' in merge.target && merge.target.plan_key === candidate.plan_key) continue;
      requirePair(candidate.plan_key, merge.target, `merge target ${refLabel(merge.target)}`);
    }
  }
}

function auditPostState(before, preview, after, post, preservation, issues) {
  if (post.dry_run !== false) addIssue(issues, 'POST_RESULT_NOT_REAL', 'Post-run reconciliation artifact is not marked dry_run:false.');
  if (post.outcome !== 'written') addIssue(issues, 'POST_RESULT_NOT_WRITTEN', 'Real reconciliation did not report outcome:written.');
  if (typeof post.undo_operation_id !== 'string' || post.undo_operation_id === '') {
    addIssue(issues, 'UNDO_OPERATION_MISSING', 'Real reconciliation did not report exactly one undo operation ID.');
  }

  auditApprovedPlan(preview, post, issues);
  const beforeIdsForRealRun = before.subpages.map(page => page.id);
  auditReviewedIds(beforeIdsForRealRun, post.proposed_reviewed_page_ids, 'real proposed_reviewed_page_ids', 'MISSING_PROPOSED_REVIEWED_ID', issues);
  auditReviewedIds(beforeIdsForRealRun, post.reviewed_page_ids, 'real reviewed_page_ids', 'MISSING_REVIEWED_ID', issues);

  const afterById = new Map(after.subpages.map(page => [page.id, page]));
  for (const prior of before.subpages) {
    const current = afterById.get(prior.id);
    if (current === undefined) {
      addIssue(issues, 'MISSING_PREEXISTING_PAGE', `Pre-existing page ${prior.id} is missing after reconciliation.`, { node_id: prior.id });
    } else if (current.file_path !== prior.file_path) {
      addIssue(issues, 'PREEXISTING_PATH_CHANGED', `Pre-existing page ${prior.id} moved from its original path.`, { node_id: prior.id });
    }
  }

  const beforeIds = new Set(before.subpages.map(page => page.id));
  const plannedTitles = new Set(finalActions(preview).filter(action => action.op === 'create').map(action => action.title));
  for (const created of after.subpages.filter(page => !beforeIds.has(page.id))) {
    if (!plannedTitles.has(created.title)) {
      addIssue(issues, 'UNEXPECTED_CREATE', `Post-run page ${created.id} (${created.title}) was not an accepted create.`, { node_id: created.id, title: created.title });
    }
  }

  auditActiveScopeUniqueness(after, issues);
  auditReplacementGraph(after, issues);
  auditPreservationAndPins(before, preview, post, after, preservation, issues);

  const homeHash = after.home?.wiki_topology_hash;
  if (typeof homeHash !== 'string' || homeHash !== after.topology_hash) {
    addIssue(issues, 'TOPOLOGY_HASH_MISMATCH', 'Post-run home topology stamp does not match the actual catalog topology hash.');
  }
  if (typeof post.post_topology_hash === 'string' && post.post_topology_hash !== after.topology_hash) {
    addIssue(issues, 'POST_RESULT_HASH_MISMATCH', 'Real reconciliation result hash does not match the post-run catalog hash.');
  }
}

function auditApprovedPlan(preview, post, issues) {
  if (typeof preview.expected_reconcile_key !== 'string' || preview.expected_reconcile_key === '') {
    addIssue(issues, 'PREVIEW_RECONCILE_KEY_MISSING', 'Approved preview has no expected reconcile key.');
  }
  if (preview.expected_reconcile_key !== post.expected_reconcile_key) {
    addIssue(issues, 'RECONCILE_KEY_CHANGED', 'Real reconciliation key differs from the approved preview.');
  }
  if (JSON.stringify(finalActions(preview)) !== JSON.stringify(finalActions(post))) {
    addIssue(issues, 'APPROVED_PLAN_CHANGED', 'Real reconciliation actions differ from the approved preview.');
  }
}

function auditActiveScopeUniqueness(catalog, issues) {
  const byScope = new Map();
  for (const page of catalog.subpages) {
    if (page.wiki_state !== 'active' || page.wiki_scope === undefined) continue;
    const key = scopeComparisonKey(page.wiki_scope);
    const ids = byScope.get(key) ?? [];
    ids.push(page.id);
    byScope.set(key, ids);
  }
  for (const ids of byScope.values()) {
    if (ids.length > 1) addIssue(issues, 'ACTIVE_DUPLICATE_SCOPE', `Active pages share one canonical scope: ${ids.join(', ')}.`, { node_ids: ids });
  }
}

function auditReplacementGraph(catalog, issues) {
  const byId = new Map(catalog.subpages.map(page => [page.id, page]));
  for (const page of catalog.subpages) {
    const replacement = page.wiki_replaced_by;
    if (replacement === undefined) continue;
    if (typeof replacement.id !== 'string' || !byId.has(replacement.id)) {
      addIssue(issues, 'BROKEN_REPLACEMENT', `Page ${page.id} has an unresolved replacement target.`, { node_id: page.id });
      continue;
    }
    const seen = new Set([page.id]);
    let cursor = replacement.id;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        addIssue(issues, 'REPLACEMENT_CYCLE', `Replacement chain from ${page.id} contains a cycle.`, { node_id: page.id });
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.wiki_replaced_by?.id;
    }
  }
}

function auditPreservationAndPins(before, preview, post, after, preservation, issues) {
  const affected = new Set();
  for (const action of [...finalActions(preview), ...finalActions(post)]) {
    if (action.op === 'merge') for (const source of action.sources ?? []) affected.add(source);
    if (action.op === 'retire') affected.add(action.node_id);
  }
  const preservationById = new Map(preservation.map(row => [row.node_id, row]));
  for (const id of affected) {
    if (preservationById.get(id)?.preserved_outside_managed_status !== true) {
      addIssue(issues, 'SOURCE_PRESERVATION_UNPROVEN', `Preservation outside managed Status is not proven for ${id}.`, { node_id: id });
    }
  }

  const afterById = new Map(after.subpages.map(page => [page.id, page]));
  for (const pinned of before.subpages.filter(page => page.wiki_pinned === true)) {
    let target = afterById.get(pinned.id);
    const seen = new Set();
    while (target?.wiki_replaced_by?.id !== undefined && !seen.has(target.id)) {
      seen.add(target.id);
      target = afterById.get(target.wiki_replaced_by.id);
    }
    if (target === undefined || target.wiki_pinned !== true) {
      addIssue(issues, 'PIN_NOT_TRANSFERRED', `Pinned intent from ${pinned.id} did not reach its canonical target.`, { node_id: pinned.id });
    }
  }
}

function auditConvergence(after, second, issues) {
  if (second.dry_run !== false) addIssue(issues, 'SECOND_RUN_NOT_REAL', 'Immediate unchanged second run is not marked dry_run:false.');
  if (second.outcome !== 'skipped') addIssue(issues, 'NON_CONVERGED_SECOND_RUN', 'Immediate unchanged second run was not skipped.');
  if (second.undo_operation_id !== null && second.undo_operation_id !== undefined) {
    addIssue(issues, 'SECOND_RUN_WRITE', 'Immediate second run reported a new undo operation.');
  }
  if (finalActions(second).length > 0 || second.page_preview !== null && second.page_preview !== undefined) {
    addIssue(issues, 'SECOND_RUN_WORK', 'Immediate second run reported planned page work.');
  }
  if (!zeroOrAbsentUsage(second.usage)) addIssue(issues, 'SECOND_RUN_LLM_USAGE', 'Immediate second run reported non-zero LLM usage.');
  if (typeof second.post_topology_hash === 'string' && second.post_topology_hash !== after.topology_hash) {
    addIssue(issues, 'SECOND_RUN_HASH_MISMATCH', 'Immediate second-run topology hash differs from the post-run catalog.');
  }
}

function finalActions(result) {
  return Array.isArray(result?.final_actions) ? result.final_actions : [];
}

function findCatalog(raw) {
  return findObject(raw, value => Array.isArray(value.subpages) && typeof value.topology_hash === 'string');
}

function findReconcileResult(raw) {
  return findObject(raw, value => Array.isArray(value.final_actions) && typeof value.outcome === 'string');
}

function findSourcePreservation(raw) {
  const holder = findObject(raw, value => Array.isArray(value.source_preservation));
  return holder?.source_preservation?.filter(row => isObject(row) && typeof row.node_id === 'string') ?? [];
}

function findObject(raw, predicate) {
  if (raw === undefined) return null;
  const queue = [raw];
  const seen = new Set();
  while (queue.length > 0) {
    const value = queue.shift();
    if (!isObject(value) || seen.has(value)) continue;
    seen.add(value);
    if (predicate(value)) return value;
    for (const child of Object.values(value)) {
      if (isObject(child)) queue.push(child);
      else if (Array.isArray(child)) queue.push(...child);
    }
  }
  return null;
}

function scopeComparisonKey(scope) {
  return JSON.stringify(lowerStrings(scope));
}

function lowerStrings(value) {
  if (typeof value === 'string') return value.trim().replace(/\s+/gu, ' ').toLowerCase();
  if (Array.isArray(value)) return value.map(lowerStrings).sort(compareStrings);
  if (!isObject(value)) return value;
  return Object.fromEntries(['v', 'subject', 'facet', 'timeframe', 'geography', 'entities', 'exclusions']
    .filter(key => value[key] !== undefined)
    .map(key => [key, lowerStrings(value[key])]));
}

function sameRef(left, right) {
  return isObject(left) && (('node_id' in right && left.node_id === right.node_id) || ('plan_key' in right && left.plan_key === right.plan_key));
}

function refLabel(ref) {
  return 'node_id' in ref ? ref.node_id : ref.plan_key;
}

function zeroOrAbsentUsage(usage) {
  return usage === null || usage === undefined || isObject(usage) && Object.values(usage).every(value => value === 0);
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(item => typeof item === 'string'))];
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addIssue(issues, code, message, details = {}) {
  issues.push({ code, message, ...details });
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class AuditInputError extends Error {
  name = 'AuditInputError';
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    const key = ({ '--before': 'before', '--preview': 'preview', '--after': 'after', '--second-run': 'secondRun' })[arg];
    if (key === undefined) throw new AuditInputError(`Unknown argument ${arg}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new AuditInputError(`${arg} requires a JSON file path.`);
    out[key] = value;
    index += 1;
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new AuditInputError(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help === true) {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }
    if (args.before === undefined || args.preview === undefined) throw new AuditInputError('--before and --preview are required.');
    if ((args.after === undefined) !== (args.secondRun === undefined)) {
      throw new AuditInputError('--after and --second-run must be supplied together.');
    }
    const report = auditArtifacts({
      before: readJson(args.before),
      preview: readJson(args.preview),
      ...(args.after === undefined ? {} : { after: readJson(args.after), secondRun: readJson(args.secondRun) }),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}\n`);
    return 2;
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main();
