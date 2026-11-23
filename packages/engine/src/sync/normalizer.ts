// src/sync/normalizer.ts
//
// Periodic field normalizer: re-renders stale vault markdown from DB state
// on a cron schedule. Fixes frontmatter drift from direct Obsidian edits.
// Also exposes a one-shot sweep for CLI use (--normalize).

import { createFieldMap } from '../fields/field-map.js';
import { statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { Cron } from 'croner';
import type Database from 'better-sqlite3';
import { shouldIgnore } from '../indexer/ignore.js';
import { loadSchemaContext } from '../pipeline/schema-context.js';
import { mergeFieldClaims } from '../validation/merge.js';
import { reconstructValue } from '../pipeline/classify-value.js';
import { renderNode } from '../renderer/render.js';
import { computeFieldOrdering, frontmatterKeyOrder } from '../renderer/field-order.js';
import { readFileOrNull } from '../pipeline/file-writer.js';
import { readExplicitNullFields } from '../fields/explicit-null.js';
import { sha256 } from '../indexer/hash.js';
import { executeMutation } from '../pipeline/execute.js';
import { keptFileFields, readFileFields } from '../pipeline/kept-file-fields.js';
import { settingsNoteDomain } from '../settings/hook.js';
import type { WriteLockManager } from './write-lock.js';
import type { SyncLogger } from './sync-logger.js';

export interface NormalizerOptions {
  cronExpression: string;
  quiescenceMinutes?: number;
}

export interface SweepOptions {
  dryRun?: boolean;
  /** Skip quiescence check (default: true for one-shot, false for cron). */
  skipQuiescence?: boolean;
  quiescenceMs?: number;
}

export interface SweepStats {
  scanned: number;
  skipped_excluded: number;
  skipped_quiescent: number;
  skipped_canonical: number;
  skipped_missing: number;
  rewritten: number;
  errored: number;
  /** Files that would be rewritten (dry-run only). */
  would_rewrite: string[];
}

/**
 * Run a single normalizer sweep. Used by both the cron scheduler and --normalize CLI.
 */
export function runNormalizerSweep(
  vaultPath: string,
  db: Database.Database,
  writeLock: WriteLockManager,
  syncLogger?: SyncLogger,
  options?: SweepOptions,
): SweepStats {
  const dryRun = options?.dryRun ?? false;
  const skipQuiescence = options?.skipQuiescence ?? true;
  const quiescenceMs = options?.quiescenceMs ?? 0;

  const stats: SweepStats = {
    scanned: 0,
    skipped_excluded: 0,
    skipped_quiescent: 0,
    skipped_canonical: 0,
    skipped_missing: 0,
    rewritten: 0,
    errored: 0,
    would_rewrite: [],
  };

  const nodes = db.prepare(
    'SELECT id, file_path, content_hash, created_at FROM nodes ORDER BY file_path',
  ).all() as Array<{
    id: string;
    file_path: string;
    content_hash: string;
    created_at: number | null;
  }>;

  const now = Date.now();
  const mode = dryRun ? 'dry-run' : 'live';
  console.log(`[normalizer] Started (${mode}) — ${nodes.length} nodes to check`);

  for (const node of nodes) {
    stats.scanned++;

    // Skip excluded directories (same rules as indexer/watcher)
    if (shouldIgnore(node.file_path)) {
      stats.skipped_excluded++;
      continue;
    }

    try {
      // 1. Stat the file — skip if missing or quiescent
      const absPath = join(vaultPath, node.file_path);
      let mtime: number;
      try {
        const st = statSync(absPath);
        mtime = st.mtimeMs;
      } catch {
        stats.skipped_missing++;
        continue;
      }

      if (!skipQuiescence && quiescenceMs > 0 && now - mtime < quiescenceMs) {
        stats.skipped_quiescent++;
        continue;
      }

      // 2. Check for missing defaults that need backfilling
      const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
        .all(node.id) as Array<{ schema_type: string }>).map(t => t.schema_type);

      const fieldRows = db.prepare(
        'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ?',
      ).all(node.id) as Array<{
        field_name: string;
        value_text: string | null;
        value_number: number | null;
        value_date: string | null;
        value_json: string | null;
        value_raw_text: string | null;
      }>;

      const fields = createFieldMap<unknown>();
      const rawFieldTexts = createFieldMap<string>();
      for (const row of fieldRows) {
        fields[row.field_name] = reconstructValue(row);
        if (row.value_raw_text) rawFieldTexts[row.field_name] = row.value_raw_text;
      }

      // 3. Render from DB state for staleness check
      const renderedHash = renderFromDb(db, node.id, readFileOrNull(absPath));
      if (renderedHash === null) {
        stats.errored++;
        continue;
      }

      // 4. Staleness check — skip if canonical
      if (renderedHash === node.content_hash) {
        stats.skipped_canonical++;
        continue;
      }

      if (dryRun) {
        console.log(`[normalizer] Would rewrite: ${node.file_path}`);
        stats.would_rewrite.push(node.file_path);
        stats.rewritten++;
        continue;
      }

      // 5. Write through pipeline
      const nodeRow = db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.id) as {
        body: string;
      };
      const base = basename(node.file_path);
      const title = base.endsWith('.md') ? base.slice(0, -3) : base;

      executeMutation(db, writeLock, vaultPath, {
        source: 'normalizer',
        node_id: node.id,
        file_path: node.file_path,
        title,
        types,
        fields,
        body: nodeRow.body,
        raw_field_texts: rawFieldTexts,
      }, syncLogger);

      // Suppress the watcher's debounced fs event for this file
      writeLock.markRecentWrite(absPath);

      console.log(`[normalizer] Normalized: ${node.file_path}`);
      stats.rewritten++;
    } catch (err) {
      console.error(
        `[normalizer] Error normalizing ${node.file_path}:`,
        err instanceof Error ? err.message : err,
      );
      stats.errored++;
    }
  }

  console.log(
    `[normalizer] Complete: ${stats.scanned} scanned, ${stats.rewritten} ${dryRun ? 'would rewrite' : 'rewritten'}, ` +
    `${stats.skipped_canonical} already canonical, ${stats.skipped_excluded} excluded, ` +
    `${stats.skipped_quiescent} quiescent, ${stats.skipped_missing} missing, ${stats.errored} errors`,
  );

  if (!dryRun) {
    // Log summary to edits_log
    db.prepare(
      'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
    ).run(null, Date.now(), 'normalizer-sweep', JSON.stringify({
      scanned: stats.scanned,
      skipped_excluded: stats.skipped_excluded,
      skipped_quiescent: stats.skipped_quiescent,
      skipped_canonical: stats.skipped_canonical,
      skipped_missing: stats.skipped_missing,
      rewritten: stats.rewritten,
      errored: stats.errored,
    }));
  }

  return stats;
}

export function startNormalizer(
  vaultPath: string,
  db: Database.Database,
  writeLock: WriteLockManager,
  syncLogger?: SyncLogger,
  options?: NormalizerOptions,
): { stop: () => void } {
  if (!options?.cronExpression) {
    return { stop: () => {} };
  }

  const quiescenceMs = (options.quiescenceMinutes ?? 60) * 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const cron = new Cron(options.cronExpression);

  function scheduleNext(): void {
    if (stopped) return;
    const next = cron.nextRun();
    if (!next) return;

    const delayMs = next.getTime() - Date.now();
    if (delayMs < 0) return;

    timer = setTimeout(() => {
      if (stopped) return;
      runNormalizerSweep(vaultPath, db, writeLock, syncLogger, {
        skipQuiescence: false,
        quiescenceMs,
      });
      scheduleNext();
    }, delayMs);

    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  }

  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * Render a node from DB state and return the SHA256 hash of the rendered content.
 * Returns null if the node cannot be rendered (e.g. missing from DB). Unclaimed
 * keys take their order from the note's current content, as the pipeline does.
 */
function renderFromDb(db: Database.Database, nodeId: string, currentContent: string | null): string | null {
  const nodeRow = db.prepare('SELECT body, file_path, content_hash FROM nodes WHERE id = ?').get(nodeId) as {
    body: string;
    file_path: string;
    content_hash: string | null;
  } | undefined;
  if (!nodeRow) return null;
  const { file_path: filePath, content_hash: contentHash } = nodeRow;

  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
    .all(nodeId) as Array<{ schema_type: string }>).map(t => t.schema_type);

  const fieldRows = db.prepare(
    'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ?',
  ).all(nodeId) as Array<{
    field_name: string;
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    value_json: string | null;
    value_raw_text: string | null;
  }>;

  const fields = createFieldMap<unknown>();
  const rawTexts = createFieldMap<string>();
  for (const row of fieldRows) {
    fields[row.field_name] = reconstructValue(row);
    if (row.value_raw_text) rawTexts[row.field_name] = row.value_raw_text;
  }

  const ctx = loadSchemaContext(db, types);
  const mergeResult = mergeFieldClaims(types, ctx.claimsByType, ctx.globalFields);
  const effectiveFields = mergeResult.ok ? mergeResult.effective_fields : mergeResult.partial_fields;

  const claimedNames = new Set(effectiveFields.keys());
  const explicitNullFields = readExplicitNullFields(db, nodeId);
  // The fields the pipeline keeps as typed (#501): without them, every sweep would find a
  // note holding such a value stale.
  const projection = settingsNoteDomain(filePath) !== null || Object.hasOwn(fields, 'vault_engine_projection');
  const keptFields = projection ? new Map() : keptFileFields(readFileFields(currentContent), {
    stored: fields,
    before: fields,
    touched: [],
    explicitNull: explicitNullFields,
    effectiveFields,
    keepUnstored: currentContent !== null && contentHash !== null && sha256(currentContent) === contentHash,
  });
  const orderFields = createFieldMap(fields);
  for (const [name, field] of keptFields) {
    if (!Object.hasOwn(orderFields, name)) orderFields[name] = field.raw;
  }
  const fieldOrdering = computeFieldOrdering(
    effectiveFields,
    Object.keys(orderFields).filter(name => !claimedNames.has(name)),
    orderFields,
    Object.hasOwn(fields, 'vault_engine_projection') ? [] : frontmatterKeyOrder(currentContent),
    explicitNullFields,
  );

  const referenceFields = new Set<string>();
  const listReferenceFields = new Set<string>();
  for (const [name, gf] of ctx.globalFields) {
    if (gf.field_type === 'reference') referenceFields.add(name);
    if (gf.field_type === 'list' && gf.list_item_type === 'reference') listReferenceFields.add(name);
  }

  const orphanRawValues = createFieldMap<string>();
  for (const [name, raw] of Object.entries(rawTexts)) {
    if (!claimedNames.has(name)) orphanRawValues[name] = raw;
  }

  const rendered = renderNode({
    types,
    fields,
    body: nodeRow.body,
    fieldOrdering,
    referenceFields,
    listReferenceFields,
    orphanRawValues,
    explicitNullFields,
    ...(keptFields.size > 0 ? { keptFields } : {}),
  });

  return sha256(rendered);
}
