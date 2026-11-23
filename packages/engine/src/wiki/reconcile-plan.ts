import { reconcileRequestDigest } from '../provenance/output-binding.js';
// allow: SIZE_OK — cohesive read-only reconciliation validation pipeline.
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { WikiConfig } from './config.js';
import { fetchExistingWiki, resolveProjectReference, type WikiCatalogPage } from './digest.js';
import type {
  ResolvedWikiReconcilePageOperation,
  ValidationResult,
  WikiReconcileInput,
  WikiReconcileTarget,
  WikiReconcileValidationIssue,
  WikiReconcileValidationMarker,
} from './reconcile-types.js';
import { parseWikiScope, serializeWikiScope } from './scope.js';
import { sameButForStatus } from './status-versions.js';
import { isValidWikiPageTitle, wikiTitleKey } from '@vault/contract';


type ExistingParticipation = {
  readonly nodeId: string;
  readonly expectedVersion: number;
  readonly operationIndex: number;
  readonly role: 'target' | 'source' | 'retire';
};

type Participation = Pick<ExistingParticipation, 'operationIndex' | 'role'>;

type MergeReplacement = {
  readonly sourceId: string;
  readonly target: string;
  readonly operationIndex: number;
};

type SourceReplacementResult =
  | { readonly kind: 'valid' }
  | { readonly kind: 'satisfied'; readonly marker: WikiReconcileValidationMarker }
  | { readonly kind: 'stale'; readonly issue: WikiReconcileValidationIssue };

export function validateWikiReconcilePlan(
  db: Database.Database,
  config: WikiConfig,
  input: WikiReconcileInput,
): ValidationResult {
  if (input.home_refresh && (!input.project_id || input.pages.length || !input.home.provenance || input.home.expected_version === undefined)) {
    return invalid([{ code: 'HOME_REFRESH_INVALID', message: 'Home refresh requires an existing guarded captured home and no page operations.' }], []);
  }
  if (input.page_refresh) {
    const operation = input.pages[0];
    if (!input.project_id || input.home_refresh || input.provenance_mode !== 'project-subpage-v1' || input.pages.length !== 1
      || operation?.op !== 'upsert' || operation.target.mode !== 'existing' || operation.target.node_id !== input.page_refresh.page_node_id
      || !operation.provenance || !operation.sections?.length || input.home.provenance || input.home.sections.length) {
      return invalid([{ code: 'PAGE_REFRESH_INVALID', message: 'Page refresh requires one captured existing page, in project-subpage-v1 mode, with no home content.' }], []);
    }
  }
  const projectReference = resolveProjectReference(db, input.project, input.project_id);
  if (!projectReference.ok) {
    return invalid([projectReferenceIssue(input, projectReference.code)], []);
  }
  const project = projectReference.project;

  const catalog = fetchExistingWiki(db, project.id, config);
  const pageById = new Map(catalog.subpages.map(page => [page.id, page]));
  const issues: WikiReconcileValidationIssue[] = [];
  const markers: WikiReconcileValidationMarker[] = [];
  const participation = new Map<string, Participation[]>();
  const planKeyUses = new Map<string, number[]>();
  const titleUses = new Map<string, Array<{ readonly title: string; readonly operationIndex: number }>>();
  const replacements: MergeReplacement[] = [];
  const resolvedPages: ResolvedWikiReconcilePageOperation[] = [];

  if (input.reconcile_key.trim() === '') {
    issues.push({ code: 'RECONCILE_KEY_EMPTY', message: 'reconcile_key must be non-empty' });
  }
  if (!input.page_refresh) validateHome(db, catalog.home, input, issues);
  validateExistingReplacementGraph(catalog.subpages, pageById, issues);

  const inspectExisting = (reference: ExistingParticipation): WikiCatalogPage | undefined => {
    const uses = participation.get(reference.nodeId) ?? [];
    uses.push({ operationIndex: reference.operationIndex, role: reference.role });
    participation.set(reference.nodeId, uses);
    const page = pageById.get(reference.nodeId);
    if (page === undefined) {
      issues.push({
        code: 'NODE_NOT_IN_WIKI',
        message: `Node ${reference.nodeId} is not a sub-page of wiki home ${catalog.home_id ?? 'new'}`,
        operation_index: reference.operationIndex,
        node_id: reference.nodeId,
      });
      return undefined;
    }
    if (page.version !== reference.expectedVersion) {
      issues.push({
        code: 'EXPECTED_VERSION_MISMATCH',
        message: `Node ${reference.nodeId} was modified (v${reference.expectedVersion} -> v${page.version}) since it was read`,
        operation_index: reference.operationIndex,
        node_id: reference.nodeId,
        expected_version: reference.expectedVersion,
        current_version: page.version,
      });
    }
    return page;
  };

  const inspectTarget = (target: WikiReconcileTarget, operationIndex: number): WikiCatalogPage | undefined => {
    switch (target.mode) {
      case 'existing':
        return inspectExisting({
          nodeId: target.node_id,
          expectedVersion: target.expected_version,
          operationIndex,
          role: 'target',
        });
      case 'new': {
        const keyUses = planKeyUses.get(target.plan_key) ?? [];
        keyUses.push(operationIndex);
        planKeyUses.set(target.plan_key, keyUses);
        if (target.plan_key.trim() === '') {
          issues.push({
            code: 'INVALID_PLAN_KEY',
            message: 'New targets require a non-empty plan_key',
            operation_index: operationIndex,
            plan_key: target.plan_key,
          });
        }
        const titleKey = wikiTitleKey(target.title);
        const uses = titleUses.get(titleKey) ?? [];
        uses.push({ title: target.title, operationIndex });
        titleUses.set(titleKey, uses);
        if (!isValidWikiPageTitle(target.title)) {
          issues.push({
            code: 'INVALID_TITLE',
            message: `Invalid wiki page title: ${target.title}`,
            operation_index: operationIndex,
            plan_key: target.plan_key,
            title: target.title,
          });
        }
        return undefined;
      }
      default:
        return assertNever(target);
    }
  };

  input.pages.forEach((operation, operationIndex) => {
    const parsedScope = parseWikiScope(operation.scope);
    if (!parsedScope.ok) {
      issues.push({
        code: 'INVALID_SCOPE',
        message: `Invalid wiki scope: ${parsedScope.code}`,
        operation_index: operationIndex,
        scope_error: parsedScope.code,
      });
    }
    const scope = parsedScope.ok ? serializeWikiScope(parsedScope.scope) : undefined;
    switch (operation.op) {
      case 'upsert':
        inspectTarget(operation.target, operationIndex);
        if (scope !== undefined) resolvedPages.push({ ...operation, scope });
        break;
      case 'merge': {
        inspectTarget(operation.target, operationIndex);
        if (operation.sources.length === 0) {
          issues.push({
            code: 'EMPTY_MERGE_SOURCES',
            message: 'Merge operations require at least one source',
            operation_index: operationIndex,
          });
        }
        const target = operation.target.mode === 'existing'
          ? operation.target.node_id
          : `plan:${operation.target.plan_key}`;
        for (const source of operation.sources) {
          const sourcePage = inspectExisting({
            nodeId: source.node_id,
            expectedVersion: source.expected_version,
            operationIndex,
            role: 'source',
          });
          replacements.push({ sourceId: source.node_id, target, operationIndex });
          const replacementResult = inspectSourceReplacement(sourcePage, target, operationIndex);
          switch (replacementResult.kind) {
            case 'valid':
              break;
            case 'satisfied':
              markers.push(replacementResult.marker);
              break;
            case 'stale':
              issues.push(replacementResult.issue);
              break;
            default:
              assertNever(replacementResult);
          }
        }
        if (scope !== undefined) resolvedPages.push({ ...operation, scope });
        break;
      }
      case 'retire': {
        const page = inspectExisting({
          nodeId: operation.node_id,
          expectedVersion: operation.expected_version,
          operationIndex,
          role: 'retire',
        });
        if (page?.wiki_pinned === true) {
          issues.push({
            code: 'PINNED_RETIRE',
            message: `Pinned page ${operation.node_id} cannot be independently retired`,
            operation_index: operationIndex,
            node_id: operation.node_id,
          });
        }
        if (scope !== undefined) resolvedPages.push({ ...operation, scope });
        break;
      }
      default:
        assertNever(operation);
    }
  });

  validateParticipation(participation, issues);
  validatePlanKeys(planKeyUses, issues);
  validateTitles(project.title, catalog.subpages, titleUses, issues);
  validateReplacementCycles(catalog.subpages, replacements, issues);

  const planDigest = resolvedPages.length === input.pages.length
    ? computePlanDigest(project.id, resolvedPages, input.home, input.home_refresh, input.page_refresh)
    : undefined;
  if (
    planDigest !== undefined
    && hasReconcileKeyCollision(catalog.home?.wiki_reconcile_key, input.reconcile_key, planDigest)
  ) {
    issues.push({
      code: 'RECONCILE_KEY_COLLISION',
      message: `reconcile_key ${input.reconcile_key} is already paired with a different plan digest`,
    });
  }

  issues.sort(compareIssues);
  markers.sort(compareMarkers);
  if (issues.length > 0) return invalid(issues, markers, planDigest);
  if (planDigest === undefined) return invalid([], markers);
  return {
    ok: true,
    plan: {
      project,
      ...(input.provenance_mode ? { provenance_mode: input.provenance_mode } : {}),
      ...(input.home_refresh ? { home_refresh: input.home_refresh } : {}),
      ...(input.page_refresh ? { page_refresh: input.page_refresh } : {}),
      reconcile_key: input.reconcile_key,
      plan_digest: planDigest,
      ...(input.home.provenance || input.page_refresh ? { provenance_request_digest: reconcileRequestDigest(input) } : {}),
      pages: resolvedPages,
      // A home only status writes moved on since it was read is written at its current version (#547).
      home: {
        ...input.home,
        ...(catalog.home !== null && input.home.expected_version !== undefined && !input.page_refresh
          ? { expected_version: catalog.home.version } : {}),
        node_id: catalog.home_id,
      },
    },
    markers,
  };
}

function validateHome(
  db: Database.Database,
  home: ReturnType<typeof fetchExistingWiki>['home'],
  input: WikiReconcileInput,
  issues: WikiReconcileValidationIssue[],
): void {
  if (home === null) return;
  if (input.home.expected_version === undefined) {
    issues.push({ code: 'HOME_EXPECTED_VERSION_REQUIRED', message: `Home ${home.id} requires expected_version`, node_id: home.id });
  } else if (!sameButForStatus(db, home.id, input.home.expected_version, home.version)) {
    issues.push({
      code: 'HOME_EXPECTED_VERSION_MISMATCH',
      message: `Home ${home.id} was modified (v${input.home.expected_version} -> v${home.version}) since it was read`,
      node_id: home.id,
      expected_version: input.home.expected_version,
      current_version: home.version,
    });
  }
}

function validateExistingReplacementGraph(
  pages: readonly WikiCatalogPage[],
  pageById: ReadonlyMap<string, WikiCatalogPage>,
  issues: WikiReconcileValidationIssue[],
): void {
  for (const page of pages) {
    const replacement = page.wiki_replaced_by;
    if (replacement !== undefined && (replacement.id === undefined || !pageById.has(replacement.id))) {
      issues.push({
        code: 'BROKEN_REPLACEMENT_CHAIN',
        message: `Page ${page.id} has an unresolved replacement: ${replacement.title}`,
        node_id: page.id,
        target: replacement.id ?? replacement.title,
      });
    }
  }
}

function inspectSourceReplacement(
  source: WikiCatalogPage | undefined,
  target: string,
  operationIndex: number,
): SourceReplacementResult {
  const replacement = source?.wiki_replaced_by;
  if (source === undefined || replacement === undefined) return { kind: 'valid' };
  if (replacement.id === target) {
    return {
      kind: 'satisfied',
      marker: {
        code: 'REPLACEMENT_ALREADY_SATISFIED',
        operation_index: operationIndex,
        node_id: source.id,
        target,
      },
    };
  }
  return {
    kind: 'stale',
    issue: {
      code: 'STALE_REPLACEMENT',
      message: `Merge source ${source.id} already points to unrelated replacement ${replacement.id ?? replacement.title}`,
      operation_index: operationIndex,
      node_id: source.id,
      target,
    },
  };
}

function validateParticipation(
  participation: ReadonlyMap<string, readonly Participation[]>,
  issues: WikiReconcileValidationIssue[],
): void {
  for (const [nodeId, uses] of participation) {
    if (uses.length < 2) continue;
    const operationIndex = Math.min(...uses.map(use => use.operationIndex));
    issues.push({
      code: 'DUPLICATE_NODE_PARTICIPATION',
      message: `Node ${nodeId} participates more than once in the batch`,
      operation_index: operationIndex,
      node_id: nodeId,
    });
    const hasSource = uses.some(use => use.role === 'source');
    const hasTarget = uses.some(use => use.role !== 'source');
    if (hasSource && hasTarget) {
      issues.push({
        code: 'SOURCE_TARGET_CONFLICT',
        message: `Node ${nodeId} is both a merge source and another operation target`,
        operation_index: operationIndex,
        node_id: nodeId,
      });
    }
  }
}

function validatePlanKeys(
  planKeyUses: ReadonlyMap<string, readonly number[]>,
  issues: WikiReconcileValidationIssue[],
): void {
  for (const [planKey, uses] of planKeyUses) {
    if (uses.length < 2) continue;
    issues.push({
      code: 'DUPLICATE_PLAN_KEY',
      message: `plan_key ${planKey} is used more than once`,
      operation_index: Math.min(...uses),
      plan_key: planKey,
    });
  }
}

function validateTitles(
  rootTitle: string,
  pages: readonly WikiCatalogPage[],
  titleUses: ReadonlyMap<string, readonly { readonly title: string; readonly operationIndex: number }[]>,
  issues: WikiReconcileValidationIssue[],
): void {
  const existingTitles = new Set(pages.map(page => wikiTitleKey(page.title)));
  for (const [titleKey, uses] of titleUses) {
    const first = uses[0];
    if (first === undefined) continue;
    if (titleKey === wikiTitleKey(rootTitle)) {
      issues.push({
        code: 'ROOT_TITLE_COLLISION',
        message: `New wiki page title collides with root: ${first.title}`,
        operation_index: first.operationIndex,
        title: first.title,
      });
    }
    if (uses.length > 1 || existingTitles.has(titleKey)) {
      issues.push({
        code: 'TITLE_COLLISION',
        message: `New title collides within the wiki: ${first.title}`,
        operation_index: first.operationIndex,
        title: first.title,
      });
    }
  }
}

function projectReferenceIssue(
  input: WikiReconcileInput,
  code: 'PROJECT_NOT_FOUND' | 'PROJECT_ID_MISMATCH' | 'AMBIGUOUS_PROJECT',
): WikiReconcileValidationIssue {
  switch (code) {
    case 'PROJECT_NOT_FOUND':
      return { code, message: `Project not found: ${input.project_id ?? input.project}` };
    case 'PROJECT_ID_MISMATCH':
      return { code, message: `Project reference ${input.project} does not match project_id ${input.project_id ?? ''}` };
    case 'AMBIGUOUS_PROJECT':
      return { code, message: `Project title is ambiguous: ${input.project}` };
    default:
      return assertNever(code);
  }
}

function validateReplacementCycles(
  pages: readonly WikiCatalogPage[],
  replacements: readonly MergeReplacement[],
  issues: WikiReconcileValidationIssue[],
): void {
  const edges = new Map<string, string>();
  for (const page of pages) {
    if (page.wiki_replaced_by?.id !== undefined) edges.set(page.id, page.wiki_replaced_by.id);
  }
  for (const replacement of replacements) edges.set(replacement.sourceId, replacement.target);
  const signatures = new Set<string>();
  const nodes = [...edges.keys()].sort();
  for (const start of nodes) {
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && edges.has(current)) {
      const index = pathIndex.get(current);
      if (index !== undefined) {
        const cycle = path.slice(index).sort();
        const signature = cycle.join('\u0000');
        if (!signatures.has(signature)) {
          signatures.add(signature);
          issues.push({
            code: 'REPLACEMENT_CYCLE',
            message: `Replacement cycle detected: ${cycle.join(' -> ')}`,
            node_id: cycle[0],
          });
        }
        break;
      }
      pathIndex.set(current, path.length);
      path.push(current);
      current = edges.get(current);
    }
  }
}

function computePlanDigest(
  projectId: string,
  pages: readonly ResolvedWikiReconcilePageOperation[],
  home: WikiReconcileInput['home'],
  homeRefresh?: WikiReconcileInput['home_refresh'],
  pageRefresh?: WikiReconcileInput['page_refresh'],
): string {
  const normalizedPages = pages.map(operation => {
    switch (operation.op) {
      case 'upsert':
        return {
          op: operation.op,
          target: normalizeTarget(operation.target),
          scope: operation.scope,
          kind: operation.kind,
          origin: operation.origin,
          pinned: operation.pinned,
          sections: operation.sections ?? [],
        };
      case 'merge':
        return {
          op: operation.op,
          target: normalizeTarget(operation.target),
          sources: operation.sources.map(source => source.node_id).sort(),
          scope: operation.scope,
          kind: operation.kind,
          origin: operation.origin,
          pinned: operation.pinned,
          reason: operation.reason,
          sections: operation.sections,
        };
      case 'retire':
        return {
          op: operation.op,
          node_id: operation.node_id,
          scope: operation.scope,
          state: operation.state,
          reason: operation.reason,
        };
      default:
        return assertNever(operation);
    }
  }).sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)));
  const canonical = JSON.stringify({
    v: 1,
    ...(homeRefresh ? { home_refresh: homeRefresh } : {}),
    ...(pageRefresh ? { page_refresh: pageRefresh } : {}),
    project_id: projectId,
    pages: normalizedPages,
    home: {
      sections: home.sections,
      evidence_hash: home.evidence_hash,
      refresh_live: home.refresh_live,
      ...(home.provenance ? { provenance: home.provenance } : {}),
      // Only when set, so every plan without it keeps the digest it always had.
      ...(home.title_suffix ? { title_suffix: home.title_suffix } : {}),
    },
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function normalizeTarget(target: WikiReconcileTarget): object {
  switch (target.mode) {
    case 'existing':
      return { mode: target.mode, node_id: target.node_id };
    case 'new':
      return { mode: target.mode, plan_key: target.plan_key, title: target.title };
    default:
      return assertNever(target);
  }
}

function hasReconcileKeyCollision(
  rawStamp: string | undefined,
  reconcileKey: string,
  planDigest: string,
): boolean {
  if (rawStamp === undefined) return false;
  const stamp = parseReconcileStamp(rawStamp);
  return stamp?.key === reconcileKey && stamp.planDigest !== planDigest;
}

function parseReconcileStamp(raw: string): { readonly key: string; readonly planDigest: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || !('v' in parsed)
    || parsed.v !== 1
    || !('key' in parsed)
    || typeof parsed.key !== 'string'
    || !('plan_digest' in parsed)
    || typeof parsed.plan_digest !== 'string'
  ) return null;
  return { key: parsed.key, planDigest: parsed.plan_digest };
}

function invalid(
  issues: readonly WikiReconcileValidationIssue[],
  markers: readonly WikiReconcileValidationMarker[],
  planDigest?: string,
): ValidationResult {
  return {
    ok: false,
    issues,
    markers,
    ...(planDigest === undefined ? {} : { plan_digest: planDigest }),
  };
}


function compareIssues(left: WikiReconcileValidationIssue, right: WikiReconcileValidationIssue): number {
  return compareStrings(issueKey(left), issueKey(right));
}

function issueKey(issue: WikiReconcileValidationIssue): string {
  return [
    issue.code,
    String(issue.operation_index ?? -1).padStart(10, '0'),
    issue.node_id ?? '',
    issue.plan_key ?? '',
    issue.title ?? '',
    issue.target ?? '',
  ].join('\u0000');
}

function compareMarkers(left: WikiReconcileValidationMarker, right: WikiReconcileValidationMarker): number {
  return compareStrings(
    `${String(left.operation_index).padStart(10, '0')}\u0000${left.node_id}\u0000${left.target}`,
    `${String(right.operation_index).padStart(10, '0')}\u0000${right.node_id}\u0000${right.target}`,
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected wiki reconcile variant: ${JSON.stringify(value)}`);
}
