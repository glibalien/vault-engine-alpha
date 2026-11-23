import type Database from 'better-sqlite3';
import { fetchExistingWiki } from '../wiki/digest.js';
import { serializeWikiScope } from '../wiki/scope.js';
import { getWikiConfig } from '../wiki/config.js';
import { outputCurrentness } from './output-binding.js';
import { contentVersion, sameButForStatus } from '../wiki/status-versions.js';
import { ProvenanceStore } from './store.js';
import { ProvenanceError } from './limits.js';
import type { Contribution, RefreshTargetData } from './types.js';
import type { ResolvedWikiReconcilePlan } from '../wiki/reconcile-types.js';

/** Caller supplies a receipt identity; ownership is resolved from Engine records. */
export function readHomeRefreshTarget(db: Database.Database, outputId: string): RefreshTargetData {
  const store = new ProvenanceStore(db);
  const row = db.prepare(`SELECT o.node_id,o.derivation_id,d.project_id,d.availability,d.state
    FROM provenance_outputs o JOIN provenance_derivations d ON d.id=o.derivation_id WHERE o.id=?`).get(outputId) as
    { node_id: string; derivation_id: string; project_id: string; availability: string; state: string } | undefined;
  const result: RefreshTargetData = { select: 'refresh_target', eligible: false, reasons: [], vault_namespace: store.namespace(),
    output_revision_id: outputId, latest_output_revision_id: null, target_kind: 'home', page_node_id: null, page_title: null,
    page_path: null, page_version: null, project_id: row?.project_id ?? null,
    project_title: null, home_node_id: row?.node_id ?? null, home_title: null, home_path: null, home_version: null,
    topology_hash: null, currentness: 'unknown', availability: row?.availability as RefreshTargetData['availability'] ?? null };
  if (!row) { result.reasons.push('OUTPUT_UNAVAILABLE'); return result; }
  const project = db.prepare('SELECT title,file_path FROM nodes WHERE id=?').get(row.project_id) as { title: string | null; file_path: string } | undefined;
  result.project_title = project?.title ?? project?.file_path ?? null;
  const config = getWikiConfig(db);
  const isProject = db.prepare('SELECT 1 FROM node_types WHERE node_id=? AND schema_type=?').get(row.project_id, config.projectType);
  const catalog = fetchExistingWiki(db, row.project_id, config);
  result.topology_hash = catalog.topology_hash;
  const homes = db.prepare(`SELECT DISTINCT n.id FROM nodes n JOIN node_types t ON t.node_id=n.id AND t.schema_type=?
    JOIN relationships r ON r.source_id=n.id AND r.rel_type='wiki_for' AND r.resolved_target_id=?
    WHERE NOT EXISTS(SELECT 1 FROM relationships p WHERE p.source_id=n.id AND p.rel_type='wiki_parent')`).all(config.wikiType, row.project_id) as Array<{ id: string }>;
  const owners = db.prepare("SELECT DISTINCT resolved_target_id FROM relationships WHERE source_id=? AND rel_type='wiki_for'").all(row.node_id) as Array<{ resolved_target_id: string | null }>;
  const page = catalog.subpages.find(candidate => candidate.id === row.node_id);
  const nodeFacts = (id: string) => db.prepare('SELECT title,file_path,version FROM nodes WHERE id=?').get(id) as { title: string | null; file_path: string; version: number } | undefined;
  if (page) {
    const stored = nodeFacts(page.id);
    result.target_kind = 'page';
    result.page_node_id = page.id;
    if (stored) { result.page_title = stored.title ?? stored.file_path; result.page_path = stored.file_path; result.page_version = stored.version; }
    result.home_node_id = catalog.home_id;
    if (page.wiki_state !== 'active') result.reasons.push('PAGE_NOT_ACTIVE');
  }
  const home = result.home_node_id ? nodeFacts(result.home_node_id) : undefined;
  // Status writes (#547) since the home was built leave the guard as it was.
  if (home) { result.home_title = home.title ?? home.file_path; result.home_path = home.file_path; result.home_version = contentVersion(db, result.home_node_id!, home.version); }
  if (!project || !isProject || homes.length !== 1 || homes[0]?.id !== result.home_node_id || owners.length !== 1 || owners[0]?.resolved_target_id !== row.project_id) result.reasons.push('HOME_OWNERSHIP_CHANGED');
  if (!home) result.reasons.push('HOME_MISSING');
  if (!catalog.catalog_valid || catalog.subpages.some(p => !p.wiki_scope)) result.reasons.push('INVALID_CATALOG');
  const latest = db.prepare(`SELECT id FROM provenance_outputs WHERE node_id=?
    ORDER BY node_version DESC,committed_at DESC,id DESC LIMIT 1`).get(row.node_id) as { id: string } | undefined;
  result.latest_output_revision_id = latest?.id ?? null;
  if (latest?.id !== outputId) result.reasons.push('HISTORICAL_OUTPUT');
  if (row.availability !== 'retained' || row.state !== 'committed') result.reasons.push('OUTPUT_UNAVAILABLE');
  const contribution = store.payload(row.derivation_id, 'contribution');
  result.currentness = outputCurrentness(db, row.node_id, row.availability === 'retained' && contribution ? JSON.parse(contribution) as Contribution : null);
  if (result.currentness !== 'matches') result.reasons.push('MANAGED_CONTENT_CHANGED');
  result.eligible = result.reasons.length === 0;
  return result;
}

/** Must also run inside the publication transaction, before its first write. A page refresh keeps
 *  everything but the page's own text, so its identity must match what's stored: otherwise this
 *  would be a topology change, or a pin change, which only a full curation may make. */
export function assertPageRefresh(db: Database.Database, plan: ResolvedWikiReconcilePlan): void {
  const guard = plan.page_refresh;
  if (!guard) return;
  const target = readHomeRefreshTarget(db, guard.expected_output_revision_id);
  const operation = plan.pages[0];
  if (plan.pages.length !== 1 || operation?.op !== 'upsert' || operation.target.mode !== 'existing' || plan.home.provenance
    || !target.eligible || target.target_kind !== 'page' || target.project_id !== plan.project.id
    || target.page_node_id !== guard.page_node_id || operation.target.node_id !== guard.page_node_id
    || target.page_version !== operation.target.expected_version || target.topology_hash !== guard.expected_topology_hash) {
    throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
  }
  const page = fetchExistingWiki(db, plan.project.id, getWikiConfig(db)).subpages.find(candidate => candidate.id === guard.page_node_id);
  if (!page?.wiki_scope || serializeWikiScope(page.wiki_scope) !== operation.scope || (page.wiki_kind ?? 'freeform') !== operation.kind
    || page.wiki_origin !== operation.origin || page.wiki_pinned !== operation.pinned) {
    throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
  }
}

/** Must also run inside the publication transaction, before its first write. */
export function assertHomeRefresh(db: Database.Database, plan: ResolvedWikiReconcilePlan): void {
  const guard = plan.home_refresh;
  if (!guard) return;
  const target = readHomeRefreshTarget(db, guard.expected_output_revision_id);
  if (plan.pages.length || !plan.home.provenance || !target.eligible || target.target_kind !== 'home' || target.project_id !== plan.project.id
    || target.home_node_id !== guard.home_node_id || plan.home.node_id !== guard.home_node_id
    || target.home_version === null || plan.home.expected_version === undefined
    || !sameButForStatus(db, guard.home_node_id, target.home_version, plan.home.expected_version)
    || target.topology_hash !== guard.expected_topology_hash) {
    throw new ProvenanceError('PROVENANCE_KEY_CONFLICT');
  }
}
