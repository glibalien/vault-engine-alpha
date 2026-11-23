// src/mcp/tools/rename-node.ts
//
// Rename machinery shared by update-node (set_title / set_directory) and
// batch-mutate. The standalone rename-node tool was retired in favor of
// update-node set_title.

import { createFieldMap } from '../../fields/field-map.js';
import type Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { existsSync, renameSync, mkdirSync } from 'node:fs';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import {
  assertToolMutationFilePresent,
  executeMutation,
  repairInboundLinks,
  StaleNodeError,
} from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import type { PipelineResult } from '../../pipeline/types.js';
import { readFileOrNull } from '../../pipeline/file-writer.js';
import { frontmatterKeyOrder } from '../../renderer/field-order.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import { readExplicitNullFields } from '../../fields/explicit-null.js';
import { readReferencePolicyVersion } from '../../db/reference-policy-version.js';
import { planTypedReferenceRename } from '../../resolver/rename-references.js';
import { readNodeResolutionIdentity, refreshTypedReferences, TYPED_REFERENCE_EDGE_SQL } from '../../resolver/typed-refresh.js';
import type { ReferenceDiagnostic } from '../../pipeline/diagnostics.js';
import { rewriteBodyWikiLinksWith } from '../../parser/wiki-links.js';
import { anchorNamingKeys, candidateKeysForNode, targetMatchesKeys, type CandidateKeys } from '../../resolver/candidate-keys.js';
import { anchoredLinkName, linkAnchor, resolveWholeTarget } from '../../resolver/resolve.js';
import { titleFromFilename } from '../../parser/parse.js';
import { cleanFieldValue } from '../../parser/frontmatter.js';
import { holdsMap, linksInWritten, relinkedRawText, renderedRawText } from '../../parser/raw-field-texts.js';
import { catalogIdentity, sameCatalogIdentity, shareCatalogs, type SharedCatalogs } from '../../pipeline/shared-catalogs.js';

/**
 * A pending filesystem mutation that should be reversed if the surrounding
 * DB transaction throws.
 */
export interface FsRollback {
  push(undo: () => void): void;
}

interface RenameReferenceChange {
  nodeId: string;
  filePath: string;
  title: string;
  types: string[];
  fields: Record<string, unknown>;
  rawFieldTexts?: Record<string, string>;
  body: string;
}

/**
 * Capture a pre-mutation undo snapshot for a node whose identity is about to
 * be changed out-of-band (file_path or title) before executeMutation runs.
 *
 * Mirrors the capture shape in `src/pipeline/execute.ts` exactly. Uses
 * INSERT OR IGNORE so a later executeMutation snapshot under the same
 * operation_id silently skips — keeping the pre-state authoritative.
 *
 * Safe to call only when the node already exists in `nodes`.
 */
export function captureRenameSnapshot(
  db: Database.Database,
  operation_id: string,
  nodeId: string,
): void {
  const nodeRow = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?')
    .get(nodeId) as { file_path: string; title: string | null; body: string | null } | undefined;
  if (!nodeRow) return;

  const typesArr = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
    .all(nodeId) as Array<{ schema_type: string }>).map(r => r.schema_type);
  const fieldsRows = db.prepare(
    'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text, source FROM node_fields WHERE node_id = ?'
  ).all(nodeId);
  const relRows = db.prepare(
    'SELECT target, rel_type, context FROM relationships WHERE source_id = ?'
  ).all(nodeId);
  const explicitNullFields = [...readExplicitNullFields(db, nodeId)];

  db.prepare(`
    INSERT OR IGNORE INTO undo_snapshots (
      operation_id, node_id, file_path, title, body, types, fields, relationships,
      explicit_null_fields, was_deleted, post_mutation_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
  `).run(
    operation_id,
    nodeId,
    nodeRow.file_path,
    nodeRow.title,
    nodeRow.body,
    JSON.stringify(typesArr),
    JSON.stringify(fieldsRows),
    JSON.stringify(relRows),
    JSON.stringify(explicitNullFields),
  );
}

/** A composed preview's simulated writes so far, by node. */
type RenamePreview = {
  diskHashes: Map<string, string>;
  keyOrders: Map<string, readonly string[]>;
  /** The simulated content, which a later render reads its kept fields from (#501). */
  contents?: Map<string, string>;
};

/** Carry a simulated write's hash, key order and content to the next op of a composed preview. */
function recordPreview(
  preview: RenamePreview,
  nodeId: string,
  result: PipelineResult,
): void {
  preview.diskHashes.set(nodeId, result.rendered_hash);
  if (result.rendered_key_order !== undefined) preview.keyOrders.set(nodeId, result.rendered_key_order);
  if (result.rendered_content !== undefined) preview.contents?.set(nodeId, result.rendered_content);
}

/**
 * Core rename logic: renames file on disk, updates DB, re-renders, and rewrites references.
 * Must be called inside a db.transaction().
 *
 * Returns the rewritten referencing node IDs alongside the count so callers
 * can enqueue embedding refreshes AFTER the enclosing transaction commits
 * (a rename rewrites those nodes' fields/bodies, which are embedding inputs).
 */
export function executeRename(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  node: { node_id: string; file_path: string; title: string },
  _requestedTitle: string,
  newFilePath: string,
  syncLogger?: SyncLogger,
  undoContext?: { operation_id: string },
  fsRollback?: FsRollback,
  expectedVersion?: number,
  preview?: RenamePreview,
  deferLinkRepair = false,
): { refsUpdated: number; changedNodeIds: string[]; inboundDiagnostics: ReferenceDiagnostic[] } {
  const oldTitle = node.title;
  const oldFilePath = node.file_path;
  // The stored title is the filename's, not the requested one (it may have
  // been sanitized — pipeline/execute.ts). References are rewritten to it so
  // they resolve from the files, not just the DB.
  const newTitle = titleFromFilename(newFilePath);

  // 0. Capture undo snapshot BEFORE mutating nodes row.
  //    executeMutation can't capture the correct pre-state later because
  //    the UPDATE below mutates file_path/title first. OR IGNORE by the
  //    composite PK means the subsequent executeMutation snapshot insert
  //    is a no-op when it fires under the same operation_id.
  if (undoContext) {
    captureRenameSnapshot(db, undoContext.operation_id, node.node_id);
  }

  if (expectedVersion !== undefined) {
    const row = db.prepare('SELECT version FROM nodes WHERE id = ?')
      .get(node.node_id) as { version: number } | undefined;
    if (row !== undefined && row.version !== expectedVersion) {
      throw new StaleNodeError(node.node_id, expectedVersion, row.version);
    }
  }

  const beforeIdentity = readNodeResolutionIdentity(db, node.node_id);
  const referenceChanges = planRenameReferenceChanges(db, node.node_id, oldTitle, newTitle, newFilePath);

  // 1. Rename file on disk (tracked for filesystem rollback).
  if (!preview && newFilePath !== oldFilePath) {
    const oldAbs = join(vaultPath, oldFilePath);
    const newAbs = safeVaultPath(vaultPath, newFilePath);
    if (existsSync(oldAbs)) {
      const newDirPath = dirname(newAbs);
      if (!existsSync(newDirPath)) mkdirSync(newDirPath, { recursive: true });
      renameSync(oldAbs, newAbs);
      fsRollback?.push(() => {
        // Best-effort: only restore if the file is still where we left it
        // and the original slot is free. The aim is to recover the common
        // case where executeMutation never reached its file-write stage.
        if (existsSync(newAbs) && !existsSync(oldAbs)) {
          renameSync(newAbs, oldAbs);
        }
      });
    }
  }

  // 2. Update the renamed node's DB state
  db.prepare('UPDATE nodes SET file_path = ?, title = ?, version = version + 1 WHERE id = ?').run(
    newFilePath, newTitle, node.node_id,
  );

  // 3. Re-render the renamed node at new path
  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
    .all(node.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);
  const fields = createFieldMap<unknown>();
  const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
    .all(node.node_id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
  for (const row of fieldRows) {
    fields[row.field_name] = reconstructValue(row);
  }
  const body = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.node_id) as { body: string }).body;

  const renamedResult = executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: node.node_id,
    file_path: newFilePath,
    title: newTitle,
    types,
    fields,
    body,
    // A preview does not move the file, so the order its keys keep is read
    // from where the file still is, unless an earlier preview op set it.
    ...(preview ? {
      db_only: true,
      previewDiskContentHash: preview.diskHashes.get(node.node_id),
      previewKeyOrder: preview.keyOrders.get(node.node_id)
        ?? frontmatterKeyOrder(readFileOrNull(safeVaultPath(vaultPath, oldFilePath))),
      previewContent: preview.contents?.get(node.node_id)
        ?? readFileOrNull(safeVaultPath(vaultPath, oldFilePath)) ?? undefined,
    } : {}),
  }, syncLogger, undoContext, fsRollback);
  if (preview) recordPreview(preview, node.node_id, renamedResult);
  // A pure rename or move renders the moved file unchanged, a no-op write that records no
  // post-operation hash. Record the file's, so an undo sees a later edit of the file as a
  // conflict instead of reverting it and removing the file (#509).
  if (undoContext && !preview) {
    db.prepare(`UPDATE undo_snapshots SET post_mutation_hash = ?
      WHERE operation_id = ? AND node_id = ? AND was_deleted = 0 AND post_mutation_hash IS NULL`)
      .run(renamedResult.rendered_hash, undoContext.operation_id, node.node_id);
  }

  // 4. Update references in referencing nodes
  let refsUpdated = 0;
  const changedNodeIds: string[] = [];
  // A rewritten source rebuilds its relationships, so a typed reference it keeps (such as a
  // list's other entry naming the new title) can lose its binding there, out of the final
  // refresh's sight. Keep those: unresolved now, resolved before the rewrite.
  const rewrittenUnbound: ReferenceDiagnostic[] = [];
  const boundTypedKeys = db.prepare(`SELECT rel_type, target FROM relationships
    WHERE source_id = ? AND resolved_target_id IS NOT NULL AND ${TYPED_REFERENCE_EDGE_SQL}`);
  // Each write would otherwise build the catalogs it resolves and canonicalizes links
  // against from every node in the vault, so a rename cost its references times the
  // vault's size (#575). A rewrite changes link targets only, so the rewrites share one
  // set, built when first needed. A note whose stored title its filename does not give,
  // which its write resets, builds its own, as before. After a rewrite that changed its
  // note's path, title, types or aliases, the next rewrites start a new set.
  let shared: SharedCatalogs | null = null;
  for (const change of referenceChanges) {
    const boundBefore = new Set((boundTypedKeys.all(change.nodeId) as Array<{ rel_type: string; target: string }>)
      .map(edge => JSON.stringify([edge.rel_type, edge.target])));
    const identityBefore = catalogIdentity(db, change.nodeId);
    const keepsName = identityBefore !== null
      && identityBefore.file_path === change.filePath
      && identityBefore.title === titleFromFilename(change.filePath);
    if (keepsName) shared ??= shareCatalogs(db);
    try {
      const result = executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: change.nodeId,
        file_path: change.filePath,
        title: change.title,
        types: change.types,
        fields: change.fields,
        raw_field_texts: change.rawFieldTexts,
        body: change.body,
        ...(keepsName && shared
          ? { linkCanonicalizer: shared.linkCanonicalizer, referenceCatalog: shared.referenceCatalog, targetLookup: shared.targetLookup }
          : {}),
        ...(preview ? {
          db_only: true,
          previewDiskContentHash: preview.diskHashes.get(change.nodeId),
          previewKeyOrder: preview.keyOrders.get(change.nodeId),
          previewContent: preview.contents?.get(change.nodeId),
        } : {}),
      }, syncLogger, undoContext, fsRollback);
      if (preview) recordPreview(preview, change.nodeId, result);
      for (const diagnostic of result.referenceDiagnostics) {
        if (diagnostic.sourceId === change.nodeId
          && boundBefore.has(JSON.stringify([diagnostic.request.context.field, diagnostic.request.rawTarget]))) {
          rewrittenUnbound.push(diagnostic);
        }
      }
    } catch (e) {
      if (e instanceof PipelineError) {
        (e as PipelineError & { node_file_path?: string }).node_file_path = change.filePath;
      }
      throw e;
    }
    if (!keepsName || !sameCatalogIdentity(identityBefore, catalogIdentity(db, change.nodeId))) shared = null;
    refsUpdated++;
    changedNodeIds.push(change.nodeId);
  }

  // Typed references elsewhere that the new name left unresolved, such as a same-title
  // target that is now ambiguous (#112).
  const inboundDiagnostics = [
    ...renamedResult.referenceDiagnostics,
    ...rewrittenUnbound,
    ...refreshTypedReferences(db, { kind: 'node', before: beforeIdentity, after: readNodeResolutionIdentity(db, node.node_id) }).unbound ?? [],
  ].filter(diagnostic => diagnostic.sourceId !== node.node_id);

  // Links written to the new name before it existed (e.g. with the `:` the
  // filename could not keep) did not resolve to this node, so were not
  // rewritten above. A caller that defers runs repairInboundLinks itself
  // after its outer transaction commits.
  if (!preview && !deferLinkRepair) {
    for (const repairedId of repairInboundLinks(db, writeLock, vaultPath, node.node_id, syncLogger, undoContext, fsRollback)) {
      if (!changedNodeIds.includes(repairedId)) changedNodeIds.push(repairedId);
    }
  }
  return { refsUpdated, changedNodeIds, inboundDiagnostics };
}

/**
 * Assert that every existing projection a live rename would actually rewrite
 * is still present. Dry-run batch creates have no projection yet, so callers
 * can exclude those composed nodes without weakening checks for existing ones.
 */
export function assertRenameReferenceFilesPresent(
  db: Database.Database,
  vaultPath: string,
  nodeId: string,
  oldTitle: string,
  newTitle: string,
  excludedNodeIds: ReadonlySet<string> = new Set(),
  newFilePath?: string,
  projectionPaths?: ReadonlyMap<string, string>,
): void {
  const effectiveTitle = newFilePath === undefined ? newTitle : titleFromFilename(newFilePath);
  const changes = planRenameReferenceChanges(db, nodeId, oldTitle, effectiveTitle, newFilePath);
  for (const change of changes) {
    if (excludedNodeIds.has(change.nodeId)) continue;
    assertToolMutationFilePresent(db, vaultPath, {
      source: 'tool',
      node_id: change.nodeId,
      file_path: projectionPaths?.get(change.nodeId) ?? (change.nodeId === nodeId
        ? (db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(nodeId) as { file_path: string }).file_path
        : change.filePath),
    });
  }
}

/**
 * Build the exact reference mutations a rename will apply without changing DB
 * or filesystem state. Candidate discovery deliberately uses the indexed
 * resolved_target_id column shared by query/get expansion. This avoids the old
 * vault-wide target re-resolution path (~42s on an 11.7k-node vault), and must
 * run before the target identity changes so inbound edges still point at it.
 */
function planRenameReferenceChanges(
  db: Database.Database,
  nodeId: string,
  oldTitle: string,
  newTitle: string,
  newFilePath?: string,
): RenameReferenceChange[] {
  if (readReferencePolicyVersion(db) !== 2) return planLegacyRenameReferenceChanges(db, nodeId, oldTitle, newTitle, newFilePath);
  const before = readNodeResolutionIdentity(db, nodeId);
  if (!before) return [];
  const next = { ...before, title: newTitle, file_path: newFilePath ?? before.file_path };
  const anchored: AnchoredRename = { oldKeys: candidateKeysForNode(before), newFilePath: next.file_path, collides: collidesInDb(db, nodeId) };
  const typed = planTypedReferenceRename(db, nodeId, next);
  // Keep ordinary body/unconstrained rewrites separate from typed occurrences.
  const ordinary = db.prepare(`SELECT source_id, target, rel_type, context FROM relationships
    WHERE resolved_target_id = ? AND source_id != ? AND NOT (${TYPED_REFERENCE_EDGE_SQL})`)
    .all(nodeId, nodeId) as Array<{ source_id: string; target: string; rel_type: string; context: string | null }>;
  const sources = new Set([...typed.map(change => change.occurrence.sourceId), ...ordinary.map(edge => edge.source_id)]);
  const changes: RenameReferenceChange[] = [];
  for (const sourceId of sources) {
    const source = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?').get(sourceId) as { file_path: string; title: string; body: string };
    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order, schema_type').all(sourceId) as Array<{ schema_type: string }>).map(row => row.schema_type);
    const fields = createFieldMap<unknown>();
    const rows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ?').all(sourceId) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null; value_raw_text: string | null }>;
    for (const row of rows) fields[row.field_name] = reconstructValue(row);
    const replacements = new Map<string, Map<string, string>>();
    function add(field: string, raw: string, replacement: string) {
      const values = replacements.get(field) ?? new Map<string, string>();
      values.set(raw, replacement);
      replacements.set(field, values);
    }
    for (const { occurrence, replacement } of typed) {
      if (occurrence.sourceId === sourceId) add(occurrence.field, occurrence.rawTarget, replacement);
    }
    const ownOrdinary = ordinary.filter(edge => edge.source_id === sourceId);
    for (const edge of ownOrdinary) {
      if (edge.context !== edge.rel_type) continue;
      // The new title, or the new path for a link written as the note's vault path (#590).
      // These edges are bound to the note, so an anchored one keeps its anchor.
      const renamed = renamedFieldTarget(edge.target, oldTitle, newTitle, before.file_path, next.file_path, anchored);
      if (renamed !== null) add(edge.rel_type, edge.target, renamed);
    }
    const rawFieldTexts = createFieldMap<string>();
    let changed = false;
    for (const [name, values] of replacements) {
      const value = fields[name];
      const storedRaw = rows.find(row => row.field_name === name)?.value_raw_text ?? null;
      if (storedRaw !== null && holdsMap(value)) {
        // A link inside a map is no item of the value (#670): it is rewritten in the raw text,
        // at any depth, and the value is read again from it.
        const relinked = relinkedRawText(storedRaw, value, values);
        if (relinked === null) continue;
        fields[name] = relinked.value;
        rawFieldTexts[name] = relinked.raw;
        changed = true;
        continue;
      }
      const replace = (item: unknown) => typeof item === 'string' ? values.get(item) ?? item : item;
      const replacement = Array.isArray(value) ? value.map(replace) : replace(value);
      if (JSON.stringify(value) !== JSON.stringify(replacement)) {
        fields[name] = replacement;
        changed = true;
        const raw = rows.find(row => row.field_name === name)?.value_raw_text;
        if (raw !== null && raw !== undefined) rawFieldTexts[name] = rewrittenRawFieldText(raw, value, values);
      }
    }
    const bodyTargets = ownOrdinary.filter(edge => edge.rel_type === 'wiki-link').map(edge => edge.target);
    const body = rewriteBodyWikiLinks(source.body, bodyTargets, newTitle, { oldFilePath: before.file_path, newFilePath: next.file_path },
      anchored);
    if (body !== source.body) changed = true;
    if (changed) changes.push({ nodeId: sourceId, filePath: sourceId === nodeId ? next.file_path : source.file_path,
      title: sourceId === nodeId ? newTitle : source.title, types, fields, rawFieldTexts, body });
  }
  return changes;
}

/**
 * A field's retained raw text with its link targets in `values` rewritten. Indexed unclaimed
 * fields keep a separate raw scalar/JSON-list representation, which is what the file is written
 * from, so a rewrite of the value alone leaves the file naming the old target. Only governed
 * targets change; brackets, aliases, untouched items, list order and duplicates are kept.
 */
export function rewrittenRawFieldText(raw: string, value: unknown, values: ReadonlyMap<string, string>): string {
  const replace = (item: unknown) => typeof item === 'string' ? values.get(item) ?? item : item;
  const replaceRaw = (item: unknown): unknown => typeof item !== 'string' ? item
    : values.get(item) ?? item.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g,
      (link, target: string, alias: string | undefined) => values.has(target)
        ? `[[${values.get(target)}${alias ?? ''}]]` : link);
  // A field-kind change can coerce the value without updating retained
  // raw text. Decode that representation independently, then reuse only
  // items that still describe the corresponding current value.
  let rawItems: unknown[] = [raw];
  try {
    const decoded: unknown = JSON.parse(raw);
    if (Array.isArray(decoded)) rawItems = decoded;
  } catch {
    // Raw scalar wikilinks are not JSON.
  }
  const retainedTarget = (retained: unknown): unknown => typeof retained === 'string'
    ? retained.trim().match(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/)?.[1] ?? retained
    : retained;
  // Retained text that is more than one link (text around a link, or several links) still
  // describes its value when it cleans to it, as the indexer cleans: it is kept as written,
  // never wrapped whole in brackets, which would lose its aliases and link to its whole text.
  const describes = (retained: unknown, item: unknown): boolean => retainedTarget(retained) === item
    || (typeof retained === 'string' && cleanFieldValue(retained) === item);
  const compatibleRaw = (item: unknown, index: number): unknown => {
    const retained = rawItems[index];
    if (retainedTarget(retained) === item) return replaceRaw(retained);
    if (describes(retained, item)) return retained;
    const nextItem = replace(item);
    return typeof nextItem === 'string' ? `[[${nextItem}]]` : nextItem;
  };
  if (Array.isArray(value)) return JSON.stringify(value.map(compatibleRaw));
  return compatibleRaw(value, rawItems.findIndex(item => describes(item, value))) as string;
}

function planLegacyRenameReferenceChanges(
  db: Database.Database,
  nodeId: string,
  oldTitle: string,
  newTitle: string,
  newFilePath?: string,
): RenameReferenceChange[] {
  const oldFilePath = (db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(nodeId) as { file_path: string } | undefined)?.file_path;
  // A field value naming the note by title gets the new title; one naming it by its vault path
  // gets the new path (#590). A link to a heading or block in it keeps its anchor, but only where
  // the value is a link bound to the note (#613): plain text like `Alpha#123` is not a reference.
  const renamedIn = (bound: ReadonlySet<string>, field: string) => (item: unknown): unknown =>
    typeof item === 'string'
      ? renamedFieldTarget(item, oldTitle, newTitle, oldFilePath, newFilePath, bound.has(`${field}\u0000${item}`) ? anchored : null) ?? item
      : item;
  const boundFieldTargets = db.prepare('SELECT rel_type, target FROM relationships WHERE source_id = ? AND resolved_target_id = ?');
  const anchored: AnchoredRename | null = oldFilePath === undefined ? null : {
    oldKeys: candidateKeysForNode({ file_path: oldFilePath, title: oldTitle }),
    newFilePath,
    collides: collidesInDb(db, nodeId),
  };
  const targetsPointingToNode = (db.prepare(
    'SELECT DISTINCT target FROM relationships WHERE resolved_target_id = ?'
  ).all(nodeId) as { target: string }[]).map((row) => row.target);
  const referencingNodeIds = (db.prepare(
    'SELECT DISTINCT source_id FROM relationships WHERE resolved_target_id = ? AND source_id != ?'
  ).all(nodeId, nodeId) as { source_id: string }[]).map((row) => row.source_id);
  const changes: RenameReferenceChange[] = [];

  for (const refNodeId of referencingNodeIds) {
    const refNode = db.prepare(
      'SELECT file_path, title, body FROM nodes WHERE id = ?'
    ).get(refNodeId) as { file_path: string; title: string; body: string };
    const refTypes = (db.prepare(
      'SELECT schema_type FROM node_types WHERE node_id = ?'
    ).all(refNodeId) as Array<{ schema_type: string }>).map((row) => row.schema_type);
    const refFields = createFieldMap<unknown>();
    const refFieldRows = db.prepare(
      'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ?'
    ).all(refNodeId) as Array<{
      field_name: string;
      value_text: string | null;
      value_number: number | null;
      value_date: string | null;
      value_json: string | null;
      value_raw_text: string | null;
    }>;
    for (const row of refFieldRows) {
      refFields[row.field_name] = reconstructValue(row);
    }

    let changed = false;
    const rawFieldTexts = createFieldMap<string>();
    const bound = new Set((boundFieldTargets.all(refNodeId, nodeId) as Array<{ rel_type: string; target: string }>)
      .map(row => `${row.rel_type}\u0000${row.target}`));
    for (const [fieldName, value] of Object.entries(refFields)) {
      const renamed = renamedIn(bound, fieldName);
      const raw = refFieldRows.find(row => row.field_name === fieldName)?.value_raw_text ?? null;
      if (raw !== null && holdsMap(value)) {
        // A link inside a map is no item of the value (#670). Each one bound to the note is
        // rewritten in the raw text, at any depth, and the value is read again from it. Only
        // a written link is one here: the same words as plain text in such a field are not.
        const targets = new Map<string, string>();
        for (const { target } of linksInWritten(renderedRawText(raw, value))) {
          if (!bound.has(`${fieldName}\u0000${target}`)) continue;
          const next = renamed(target);
          if (typeof next === 'string' && next !== target) targets.set(target, next);
        }
        const relinked = relinkedRawText(raw, value, targets);
        if (relinked === null) continue;
        refFields[fieldName] = relinked.value;
        rawFieldTexts[fieldName] = relinked.raw;
        changed = true;
        continue;
      }
      const items = Array.isArray(value) ? value : [value];
      const values = new Map<string, string>();
      for (const item of items) {
        const next = renamed(item);
        if (typeof item === 'string' && typeof next === 'string' && next !== item) values.set(item, next);
      }
      if (values.size === 0) continue;
      refFields[fieldName] = Array.isArray(value) ? value.map(renamed) : renamed(value);
      changed = true;
      // Also rewrite the raw text an unclaimed field is written from (#590).
      if (raw !== null) rawFieldTexts[fieldName] = rewrittenRawFieldText(raw, value, values);
    }

    const newBody = rewriteBodyWikiLinks(refNode.body, targetsPointingToNode, newTitle,
      oldFilePath !== undefined && newFilePath !== undefined ? { oldFilePath, newFilePath } : undefined,
      anchored ?? undefined);
    if (newBody !== refNode.body) changed = true;
    if (!changed) continue;

    changes.push({
      nodeId: refNodeId,
      filePath: refNode.file_path,
      title: refNode.title,
      types: refTypes,
      fields: refFields,
      rawFieldTexts,
      body: newBody,
    });
  }

  return changes;
}

/**
 * The link target a renamed or moved note's old vault path becomes: the new path, written the
 * same way (with or without `.md`). Null when `target` is not the old path, or the path is unchanged.
 */
function movedPathTarget(target: string, oldFilePath: string, newFilePath: string): string | null {
  if (oldFilePath === newFilePath) return null;
  if (target === oldFilePath) return newFilePath;
  // Without `.md`, a note at the vault root's path is just its name: a bare-title link, which
  // the title rules handle, not a path to carry into a folder (#591 review).
  if (!oldFilePath.includes('/')) return null;
  const stem = (path: string) => path.endsWith('.md') ? path.slice(0, -3) : path;
  return target === stem(oldFilePath) ? stem(newFilePath) : null;
}

/**
 * What a rename needs to rewrite links to a heading or block in the renamed note (#613): its
 * keys before the rename, which an anchored link may name it by at any resolver tier, its new
 * path, and whether some other note is named by a text as a whole.
 */
export interface AnchoredRename {
  oldKeys: CandidateKeys;
  newFilePath?: string;
  /** True when `text` as a whole names a note other than the renamed one. */
  collides(text: string): boolean;
}

/** `collides` from the database, read before the rename: another note named by the whole text. */
function collidesInDb(db: Database.Database, nodeId: string): (text: string) => boolean {
  return text => {
    const hit = resolveWholeTarget(db, text);
    return hit !== null && hit.id !== nodeId;
  };
}

/**
 * The renamed note's name with an anchor put back. Resolvers read a link whole first, so when
 * another note is named `Beta#Goals`, `[[Beta#Goals]]` would be its link: the new vault path
 * with `.md` (`Projects/Beta.md#Goals`) names the renamed note however others are named.
 */
function withAnchor(name: string, anchor: string, anchored: AnchoredRename): string {
  const text = name + anchor;
  return anchor !== '' && anchored.newFilePath !== undefined && anchored.collides(text) ? anchored.newFilePath + anchor : text;
}

/**
 * A field value that names the renamed note by its old title or vault path, as it reads after
 * the rename: the new title, or the new path in the same form (#590). A link to a heading or
 * block in the note (`Old#Intro`, or the note's name in another form the resolver accepts) keeps
 * its anchor (#613), but only when `anchored` is given: the value is a link bound to the note.
 * Null when it names neither.
 */
function renamedFieldTarget(
  item: string, oldTitle: string, newTitle: string, oldFilePath: string | undefined, newFilePath: string | undefined,
  anchored: AnchoredRename | null,
): string | null {
  const direct = (text: string): string | null => text === oldTitle ? newTitle
    : oldFilePath !== undefined && newFilePath !== undefined ? movedPathTarget(text, oldFilePath, newFilePath) : null;
  const whole = direct(item);
  if (whole !== null || anchored === null) return whole;
  const name = anchoredLinkName(item);
  if (name === null) return null;
  const named = direct(name) ?? (targetMatchesKeys(name, anchored.oldKeys) ? newTitle : null);
  return named === null ? null : withAnchor(named, linkAnchor(item), anchored);
}

/**
 * Rewrite wiki-links in body text using AST-aware traversal.
 * Only modifies wiki-links in text nodes — skips code blocks, inline code, and YAML.
 * Preserves aliases: [[old|alias]] → [[new|alias]].
 */
export function rewriteBodyWikiLinks(
  body: string,
  targets: string[],
  newTitle: string,
  /** A renamed or moved note's old and new path: a link written as its path keeps that form (#590). */
  paths?: { oldFilePath: string; newFilePath: string },
  /** Links to a heading or block in the renamed note keep their anchor (#613). */
  anchored?: AnchoredRename,
): string {
  if (targets.length === 0) return body;
  const targetSet = new Set(targets);
  return rewriteBodyWikiLinksWith(body, ({ target, written, inTableCell }) => {
    if (!targetSet.has(target)) return null;
    const anchor = anchored ? anchorNamingKeys(target, anchored.oldKeys) : '';
    const name = anchor === '' ? target : anchoredLinkName(target)!;
    // A link written as the note's path names the note even where another note shares its
    // name, so it keeps the folder: a bare title there could bind to the other note.
    const renamedName = (paths ? movedPathTarget(name, paths.oldFilePath, paths.newFilePath) : null) ?? newTitle;
    const replacement = anchored ? withAnchor(renamedName, anchor, anchored) : renamedName;
    // A table cell's alias separator stays escaped.
    return written.alias !== null ? `[[${replacement}${inTableCell ? '\\|' : '|'}${written.alias}]]` : `[[${replacement}]]`;
  });
}
