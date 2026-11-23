// src/mcp/tools/repoint-embeds.ts
//
// Repoint embed references to a materialized transcript node. Given the embed
// ref/path strings an attachment was embedded as, find every node whose body
// embeds it and rewrite `![[ref]]` -> `![[newTitle]]` (embed preserved), then
// re-render through the single mutation pipeline. Embeds are found via the
// relationships table: `![[x]]` indexes as target='x', rel_type='wiki-link'.
//
// `refs` elements may be null (callers pass [embed_ref, row.vault_path] and
// vault_path may be null); nulls are filtered out before querying.
//
// Intended to be called inside an enclosing `db.transaction()` (with a shared
// `fsRollback`) so the re-renders are atomic with the caller's other mutations
// — same pattern as `executeRename`.

import { createFieldMap } from '../../fields/field-map.js';
import type Database from 'better-sqlite3';
import { assertToolMutationFilePresent, executeMutation } from '../../pipeline/execute.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import { rewriteBodyWikiLinks } from './rename-node.js';
import { PipelineError } from '../../pipeline/types.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';

type RepointEmbedTarget = {
  readonly nodeId: string;
  readonly filePath: string;
  readonly title: string;
  readonly newBody: string;
};

function planRepointEmbedTargets(
  db: Database.Database,
  refs: Array<string | null>,
  newTitle: string,
  excludeNodeId: string | null,
): RepointEmbedTarget[] {
  const distinct = Array.from(new Set(refs.filter((r): r is string => !!r)));
  if (distinct.length === 0) return [];

  const placeholders = distinct.map(() => '?').join(',');
  const excludeClause = excludeNodeId === null ? '' : ' AND source_id != ?';
  const args = excludeNodeId === null ? distinct : [...distinct, excludeNodeId];
  const referencing = db.prepare(
    `SELECT DISTINCT source_id FROM relationships WHERE target IN (${placeholders}) AND rel_type = 'wiki-link'${excludeClause}`,
  ).all(...args) as Array<{ source_id: string }>;

  const targets: RepointEmbedTarget[] = [];
  for (const { source_id } of referencing) {
    const node = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?')
      .get(source_id) as { file_path: string; title: string | null; body: string } | undefined;
    if (!node) continue;

    const newBody = rewriteBodyWikiLinks(node.body, distinct, newTitle);
    if (newBody === node.body) continue;
    targets.push({
      nodeId: source_id,
      filePath: node.file_path,
      title: node.title ?? '',
      newBody,
    });
  }
  return targets;
}

/**
 * Read-only parity guard for a future repoint. It checks only nodes selected by
 * the same relationship query and body-rewrite predicate as the live path.
 */
export function preflightRepointEmbedRefs(
  db: Database.Database,
  vaultPath: string,
  refs: Array<string | null>,
  newTitle: string,
): number {
  const targets = planRepointEmbedTargets(db, refs, newTitle, null);
  for (const target of targets) {
    assertToolMutationFilePresent(db, vaultPath, {
      source: 'tool',
      node_id: target.nodeId,
      file_path: target.filePath,
    });
  }
  return targets.length;
}

export function repointEmbedRefs(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  refs: Array<string | null>,
  newTitle: string,
  excludeNodeId: string,
  syncLogger?: SyncLogger,
  undoContext?: { operation_id: string },
  fsRollback?: { push(undo: () => void): void },
): { updated: number; changedNodeIds: string[] } {
  let updated = 0;
  const changedNodeIds: string[] = [];
  for (const target of planRepointEmbedTargets(db, refs, newTitle, excludeNodeId)) {
    // Load types and fields only when a mutation will actually occur.
    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(target.nodeId) as Array<{ schema_type: string }>).map(t => t.schema_type);
    const fields = createFieldMap<unknown>();
    const fieldRows = db.prepare(
      'SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?'
    ).all(target.nodeId) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
    for (const r of fieldRows) fields[r.field_name] = reconstructValue(r);

    // executeMutation re-reads value_raw_text for orphan fields from the DB,
    // so passing reconstructed bare values does not strip orphan wikilinks.
    try {
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: target.nodeId,
        file_path: target.filePath,
        title: target.title,
        types,
        fields,
        body: target.newBody,
      }, syncLogger, undoContext, fsRollback);
    } catch (e) {
      if (e instanceof PipelineError) {
        (e as PipelineError & { node_file_path?: string }).node_file_path = target.filePath;
      }
      throw e;
    }
    updated++;
    changedNodeIds.push(target.nodeId);
  }
  return { updated, changedNodeIds };
}
