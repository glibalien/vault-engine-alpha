import type { CoreDeps } from '../core.js';
import { vaultOf } from '../config.js';
import { forgetDossier, getDossier, getDossierByHome } from '../db/dossiers.js';
import { wikiRootFor } from '../db/wiki-roots.js';
import { EngineError } from '../engine.js';
import type { EngineNode } from '../types.js';
import { dossierBuildKey } from './build.js';
import { DossierError, type DossierTarget } from './evidence.js';
import { DOSSIER_FIELD, rebuildOf } from './freshness.js';

/**
 * `remove-dossier` (#723; owner, 2026-11-21: its own tool, dry run first). It deletes the dossier's
 * page through the Engine, as one undo operation it returns, and forgets the Curator's record of
 * it. It takes the person's or company's note, or the page itself. A page is a dossier when the
 * Curator recorded it, or, for one built before the record (#714), when its note has a home whose
 * title ends " Dossier" and no registered wiki; anything else is refused, so a project or topic
 * wiki is never deleted here. The note's `dossier` field is left as it is.
 */

async function nodeOf(deps: Pick<CoreDeps, 'engine'>, target: DossierTarget): Promise<EngineNode> {
  const given = [target.node_id, target.title].filter(value => value !== undefined && value.trim() !== '');
  if (given.length !== 1) throw new DossierError('INVALID_PARAMS', 'Give the note or the page as node_id or as title: one of the two.');
  let id = target.node_id?.trim();
  if (id === undefined) {
    const title = target.title!.trim();
    const found = await deps.engine.findNodesByExactTitle(title, 2);
    if (found.length === 0) throw new DossierError('NOT_FOUND', `No note is titled "${title}".`);
    if (found.length > 1) throw new DossierError('AMBIGUOUS_TITLE', `More than one note is titled "${title}"; give its node_id.`);
    id = found[0]!.id;
  }
  try {
    return await deps.engine.getNode(id, { includeEmbeds: false });
  } catch (error) {
    if (error instanceof EngineError && error.code === 'NOT_FOUND') throw new DossierError('NOT_FOUND', `No note has the id ${id}.`);
    throw error;
  }
}

interface Found {
  readonly subjectId: string;
  readonly subjectTitle: string | null;
  readonly page: { readonly node_id: string; readonly title: string; readonly path: string | null };
  readonly recorded: boolean;
}

async function findDossier(deps: Pick<CoreDeps, 'engine' | 'db' | 'config'>, target: DossierTarget): Promise<Found> {
  const node = await nodeOf(deps, target);
  const wikiType = vaultOf(deps.config).wikiType;
  const isPage = wikiType !== null && (node.types ?? []).includes(wikiType);
  const record = deps.db ? (isPage ? getDossierByHome(deps.db, node.id) : getDossier(deps.db, node.id)) : null;
  let subjectId = record?.nodeId ?? (isPage ? null : node.id);
  let homeId = record?.homeId ?? (isPage ? node.id : null);
  if (subjectId === null) {
    throw new DossierError('NOT_A_DOSSIER', `"${node.title ?? node.id}" is a wiki page the Curator has no dossier record of. Give the person's or company's note instead, or delete the page with delete-node.`);
  }
  if (homeId === null) {
    homeId = (await deps.engine.wikiStatus(subjectId)).home_node_id;
    if (homeId === null) throw new DossierError('NOT_FOUND', `"${node.title ?? node.id}" has no dossier.`);
  }
  const home = homeId === node.id ? node : await deps.engine.getNode(homeId, { includeEmbeds: false });
  const subject = subjectId === node.id ? node : await deps.engine.getNode(subjectId, { includeEmbeds: false }).catch(() => null);
  const title = home.title ?? homeId;
  // A note registered for a wiki since (a person note that became a project, say) has its home reused
  // by that wiki: never delete it here, recorded or not (Codex, #733).
  const registered = deps.db ? wikiRootFor(deps.db, subject?.title ?? '', subjectId) : null;
  if (registered) {
    throw new DossierError('NOT_A_DOSSIER', `"${title}" belongs to a registered wiki now (remove-wiki deregisters one), so it is not removed as a dossier.`);
  }
  // Built before the record (#714): only a home named for a dossier.
  if (!record && !title.endsWith(' Dossier')) throw new DossierError('NOT_A_DOSSIER', `"${title}" is not a dossier.`);
  return { subjectId, subjectTitle: subject?.title ?? null, page: { node_id: homeId, title, path: home.file_path ?? null }, recorded: record !== null };
}

function refuseWhileBuilding(deps: CoreDeps, found: Found): void {
  const building = deps.builds?.get(dossierBuildKey(found.subjectId))
    ?? (deps.db?.prepare('SELECT 1 FROM dossier_builds WHERE node_id = ?').get(found.subjectId) ? { since: 'another process' } : undefined);
  if (building) {
    throw new DossierError('IN_PROGRESS', `A build of "${found.page.title}" is queued or running (since ${building.since}); remove it once that build has ended.`);
  }
}

export async function removeDossier(deps: CoreDeps, target: DossierTarget, opts: { readonly dryRun: boolean }) {
  if (!opts.dryRun) {
    // A build already in flight refuses it now, never queueing behind that build to delete its fresh
    // page. Then, in the build lane, the one serialization point (AGENTS.md), every check is made
    // again: one admitted meanwhile is either seen there or runs after (Codex, #733).
    refuseWhileBuilding(deps, await findDossier(deps, target));
    return deps.queue.enqueue('remove dossier', () => removeDossierNow(deps, target, opts));
  }
  return removeDossierNow(deps, target, opts);
}

async function removeDossierNow(deps: CoreDeps, target: DossierTarget, opts: { readonly dryRun: boolean }) {
  const found = await findDossier(deps, target);
  refuseWhileBuilding(deps, found);
  const subject = await deps.engine.getNode(found.subjectId, { includeEmbeds: false }).catch(() => null);
  const mode = rebuildOf(subject?.fields?.[DOSSIER_FIELD]);
  const fieldNote = mode === 'on-change'
    ? `The note still says "${DOSSIER_FIELD}: on-change"; that is left as it is, so a dossier built again later is rebuilt nightly when behind.`
    : null;
  if (opts.dryRun) {
    return { dry_run: true as const, page: found.page, subject: { node_id: found.subjectId, title: subject?.title ?? found.subjectTitle },
      would: `Delete "${found.page.title}" (one undo operation, returned by the live call) and forget its record.`,
      ...(fieldNote ? { field_note: fieldNote } : {}),
      next: { tool: 'remove-dossier', arguments: { node_id: found.subjectId, dry_run: false }, purpose: `Delete "${found.page.title}".` } };
  }
  const { operationId } = await deps.engine.deleteNode(found.page.node_id, found.page.title);
  if (deps.db) forgetDossier(deps.db, found.subjectId);
  return { dry_run: false as const, removed: true, page: found.page, subject: { node_id: found.subjectId, title: subject?.title ?? found.subjectTitle },
    operation_id: operationId,
    ...(operationId ? { undo: { tool: 'undo-operations', arguments: { operation_ids: [operationId], dry_run: false },
      purpose: 'Bring the page back. Its record is not restored: the behind check covers it again from its next build.' } } : {}),
    ...(fieldNote ? { field_note: fieldNote } : {}) };
}
