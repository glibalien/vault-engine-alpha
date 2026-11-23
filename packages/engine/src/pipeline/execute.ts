// src/pipeline/execute.ts
//
// The write pipeline: single code path for all mutations.
// Section 5 of the Phase 3 spec.

import { createFieldMap } from '../fields/field-map.js';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { accessSync, constants, statSync, unlinkSync } from 'node:fs';
import { safeVaultPath } from './safe-path.js';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { validateProposedState, defaultedFieldsFrom, rejectedValueFields } from '../validation/validate.js';
import type { CoercedValue, ValidationResult, ConflictedFieldSet } from '../validation/types.js';
import { renderNode } from '../renderer/render.js';
import type { RenderInput } from '../renderer/types.js';
import { computeFieldOrdering, frontmatterKeyOrder } from '../renderer/field-order.js';
import { sha256 } from '../indexer/hash.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import type { SyncLogger } from '../sync/sync-logger.js';
import { loadSchemaContext } from './schema-context.js';
import { classifyValue, reconstructValue } from './classify-value.js';
import { UNRENDERED_FIELDS } from '../fields/unrendered.js';
import { deriveReferenceContexts } from './relationships.js';
import { buildDeviationEntries, writeEditsLogEntries, type EditsLogEntry } from './edits-log.js';
import { typeKey } from '../parser/type-key.js';
import { atomicCreateFile, atomicWriteFile, readFileIfExists, readFileOrNull } from './file-writer.js';
import type { ProposedMutation, PipelineResult, UndoContext, MutationEffects } from './types.js';
import { PipelineError } from './types.js';
import type { FileContext } from '../validation/resolve-default.js';
import { resolveTarget } from '../resolver/resolve.js';
import { buildReferenceCatalog, resolveRelationship } from '../resolver/relationship-policy.js';
import { readReferencePolicyVersion } from '../db/reference-policy-version.js';
import { getGlobalField } from '../global-fields/crud.js';
import { collectReferenceDiagnostics, type ReferenceDiagnostic } from './diagnostics.js';
import { readNodeResolutionIdentity, refreshTypedReferences } from '../resolver/typed-refresh.js';
import { refreshOnCreate, refreshOnRename } from '../resolver/refresh.js';
import { buildFtsRow } from '../search/fts-row.js';
import { notifyToolWrite, settingsNoteDomain } from '../settings/hook.js';
import { assertConversationAuthority } from '../conversations/authority.js';
import {
  overlayExplicitNullFields,
  readExplicitNullFields,
  replaceExplicitNullFields,
  restoreExplicitNullFields,
} from '../fields/explicit-null.js';
import { requestedFileHeld, verifyFieldGuessMutationGuard } from '../field-guess/mutation-guard.js';
import { titleFromFilename } from '../parser/parse.js';
import { LinkCanonicalizer, linksBoundThroughTitle } from '../resolver/file-link.js';
import { nearMissLinkSources } from '../resolver/near-miss.js';
import { canonicalizeBodyLinks, canonicalizeExplicitFieldLinks, canonicalizeReferenceFields } from './canonical-links.js';
import { carriedRawText } from './carried-raw-text.js';
import { loadNodeState } from './node-state.js';
import { captureFileOnlyFields, saveFileOnlyFields } from '../undo/file-only-fields.js';
import { keptFileFields, readFileFields, type FileField, type KeepRule } from './kept-file-fields.js';
import { fileFieldValues } from './rejected-values.js';

export class StaleNodeError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly expectedVersion: number,
    public readonly currentVersion: number,
  ) {
    super(`Node ${nodeId} was modified (v${expectedVersion} -> v${currentVersion}) since you read it`);
    this.name = 'StaleNodeError';
  }
}

export class ContentHashMismatchError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly expectedHash: string,
    public readonly currentHash: string | null,
  ) {
    super(`Node ${nodeId} content changed since you read it (expected ${expectedHash}, current ${currentHash ?? 'none'})`);
    this.name = 'ContentHashMismatchError';
  }
}

/**
 * Existing tool mutations must never recreate a temporarily missing indexed
 * Markdown file. Keep this check outside the mutation transaction so callers
 * can also run it before creating operation/undo bookkeeping.
 */
export function assertToolMutationFilePresent(
  db: Database.Database,
  vaultPath: string,
  mutation: Pick<ProposedMutation, 'source' | 'node_id' | 'file_path' | 'db_only'>,
): void {
  if (mutation.source !== 'tool') return;
  assertMutationFilePresent(db, vaultPath, mutation);
}

/**
 * Tool edits and schema propagation require an existing projection. Recovery
 * sources (normalizer, watcher, undo), creation, and DB-only previews retain
 * their intentional missing-file behavior.
 */
export function assertMutationFilePresent(
  db: Database.Database,
  vaultPath: string,
  mutation: Pick<ProposedMutation, 'source' | 'node_id' | 'file_path' | 'db_only'>,
): void {
  if ((mutation.source !== 'tool' && mutation.source !== 'propagation')
    || mutation.node_id === null || mutation.db_only) return;

  const row = db.prepare('SELECT content_hash FROM nodes WHERE id = ?').get(mutation.node_id) as
    | { content_hash: string | null }
    | undefined;
  if (!row) return;

  const absPath = safeVaultPath(vaultPath, mutation.file_path);
  if (mutation.source === 'propagation') {
    // Presence checks run at entry and under the write lock. Avoid reading the
    // full body here; Stage 5 already reads it for comparison and rollback.
    try {
      if (statSync(absPath).isFile()) {
        accessSync(absPath, constants.R_OK);
        return;
      }
    } catch {
      // Missing or unreadable projections fail closed below.
    }
  } else if (readFileIfExists(absPath) !== null) {
    return;
  }
  throw new ContentHashMismatchError(
    mutation.node_id,
    row.content_hash ?? 'indexed-file-present',
    null,
  );
}

/**
 * Execute a mutation through the full write pipeline.
 *
 * The pipeline is one function. The `source` field on ProposedMutation
 * controls Stage 3 behavior. Tool handlers call it and check for errors;
 * the watcher calls it and ignores validation results.
 *
 * Throws PipelineError on tool-path blocking errors.
 * Returns PipelineResult on success.
 */
export function executeMutation(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  mutation: ProposedMutation,
  syncLogger?: SyncLogger,
  undoContext?: UndoContext,
  fsRollback?: { push(undo: () => void): void },
  effects?: MutationEffects,
): PipelineResult {
  return runMutation(db, writeLock, vaultPath, mutation, syncLogger, undoContext, fsRollback, false, effects);
}

/** Run live preparation and guard ordering without applying any mutation or notification. */
export function assertMutationPreviewGuards(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  mutation: ProposedMutation,
): void {
  previewMutation(db, writeLock, vaultPath, mutation);
}

/** Return the exact validated/rendered preflight without persisting any effects. */
export function previewMutation(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  mutation: ProposedMutation,
): PipelineResult {
  return runMutation(db, writeLock, vaultPath, mutation, undefined, undefined, undefined, true);
}

export function assertExpectedNodeVersion(db: Database.Database, nodeId: string, expectedVersion?: number): void {
  if (expectedVersion === undefined) return;
  const row = db.prepare('SELECT version FROM nodes WHERE id = ?').get(nodeId) as { version: number } | undefined;
  if (row !== undefined && row.version !== expectedVersion) {
    throw new StaleNodeError(nodeId, expectedVersion, row.version);
  }
}

/** `fields` without one named like the type key; the same map when it has none. */
function withoutTypeKey(fields: Record<string, unknown>): Record<string, unknown> {
  const key = typeKey();
  if (!Object.hasOwn(fields, key)) return fields;
  const rest = createFieldMap(fields);
  delete rest[key];
  return rest;
}

interface StoredTypeKeyField {
  value: unknown;
  raw_text: string | null;
}

/**
 * The type key is never a field (#480). A tool that names it in the fields it sets is
 * refused at validation. Any other field of that name came from the node's stored state —
 * left by a tool write before #480, which accepted it as an orphan field — or from an undo
 * snapshot of that state: it is dropped here, and the write records the value in the edits
 * log (the stored row's, or else the dropped one). Without this, every write of such a note
 * would be refused.
 */
function withoutCarriedTypeKeyField(
  mutation: ProposedMutation,
): { mutation: ProposedMutation; dropped: StoredTypeKeyField | null } {
  const key = typeKey();
  if (mutation.source === 'watcher' || !Object.hasOwn(mutation.fields, key)) return { mutation, dropped: null };
  const setByCaller = mutation.source === 'tool'
    && (mutation.node_id === null || (mutation.touchedFields ?? []).includes(key));
  if (setByCaller) return { mutation, dropped: null };
  const rawText = mutation.raw_field_texts !== undefined && Object.hasOwn(mutation.raw_field_texts, key)
    ? mutation.raw_field_texts[key]
    : null;
  return {
    mutation: { ...mutation, fields: withoutTypeKey(mutation.fields) },
    dropped: { value: mutation.fields[key], raw_text: rawText },
  };
}

/**
 * The stored and dropped type-key values a write removes, each value once. A value carried
 * from the stored row comes without its raw text, so the stored record (which has it) stands.
 */
function distinctTypeKeyFields(
  stored: StoredTypeKeyField | null,
  dropped: StoredTypeKeyField | null,
): StoredTypeKeyField[] {
  if (stored === null) return dropped === null ? [] : [dropped];
  return dropped === null || isDeepStrictEqual(stored.value, dropped.value) ? [stored] : [stored, dropped];
}

function readStoredTypeKeyField(db: Database.Database, nodeId: string | null): StoredTypeKeyField | null {
  if (nodeId === null) return null;
  const row = db.prepare(
    'SELECT value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ? AND field_name = ?',
  ).get(nodeId, typeKey()) as {
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    value_json: string | null;
    value_raw_text: string | null;
  } | undefined;
  return row === undefined ? null : { value: reconstructValue(row), raw_text: row.value_raw_text };
}

/**
 * The edits-log record of a stored field named like the type key that a write removed. It is
 * a `value-removed` record, kept past the edits-log retention, so the value stays findable.
 */
function typeKeyFieldRemovedEntry(
  nodeId: string,
  source: ProposedMutation['source'],
  stored: StoredTypeKeyField,
  types: string[],
): EditsLogEntry {
  const key = typeKey();
  return {
    node_id: nodeId,
    event_type: 'value-removed',
    details: {
      source,
      trigger: `field named like the type key "${key}"`,
      field: key,
      removed_value: stored.value,
      ...(stored.raw_text !== null ? { removed_raw_text: stored.raw_text } : {}),
      reason: `"${key}" is the frontmatter key that holds the note's types, so it is not a field; this one was `
        + 'left by a write before #480, which accepted it as a field and wrote it over the types in the file.',
      node_types: types,
    },
  };
}

/** A node_fields row as an undo snapshot reads it. */
type StoredFieldRow = { field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null };

interface KeptFieldsState {
  /** The fields the render writes as the file shows them. */
  kept: Map<string, FileField>;
  /** The file's fields the decision read (none when no field can be kept). */
  fileFields: readonly FileField[];
}

/**
 * The fields a render of this write keeps as they are in the note's file: typed values the
 * watcher did not take, which the write leaves alone (#501, `keptFileFields`). None for the
 * watcher, which writes no file; for a note without a file yet; and for an engine-owned
 * projection (a settings note, the memories note), whose bytes are a render Engine reads back.
 */
function keptFieldsFor(
  db: Database.Database,
  mutation: ProposedMutation,
  existingContent: string | null,
  rule: Pick<KeepRule, 'stored' | 'explicitNull' | 'defaulted' | 'effectiveFields'>,
): KeptFieldsState {
  const none: KeptFieldsState = { kept: new Map(), fileFields: [] };
  // A composed preview's earlier simulated write stands in for the file: its content for the
  // fields, and its hash (as for the no-op check) for whether the database last wrote it.
  const content = mutation.db_only && mutation.previewContent !== undefined ? mutation.previewContent : existingContent;
  if (mutation.source === 'watcher' || mutation.node_id === null) return none;
  if (settingsNoteDomain(mutation.file_path) !== null || Object.hasOwn(rule.stored, 'vault_engine_projection')) {
    return none;
  }
  // Lines only the file held before the operation, from its snapshot (#656): each is kept
  // where the restored state does not hold it, whatever the restore changed. They stand in
  // for what the file shows now, which is the operation's.
  const restored = mutation.source === 'undo' && mutation.restoredFileFields !== undefined && mutation.restoredFileFields.length > 0
    ? keptFileFields(mutation.restoredFileFields, { ...rule, touched: [], keepUnstored: true })
    : new Map<string, FileField>();
  if (content === null) return { kept: restored, fileFields: [] };
  const fileFields = readFileFields(content);
  if (fileFields.length === 0) return { kept: restored, fileFields };
  // Undo names the fields it restores in touchedFields and its file render (undo/restore.ts)
  // decides the same way from the restored state; other writes also compare with what was
  // stored, which catches a field a write changes without naming it.
  const undo = mutation.source === 'undo';
  const indexed = db.prepare('SELECT content_hash FROM nodes WHERE id = ?').get(mutation.node_id) as
    | { content_hash: string | null }
    | undefined;
  const diskHash = mutation.db_only && mutation.previewDiskContentHash !== undefined
    ? mutation.previewDiskContentHash
    : sha256(content);
  const kept = keptFileFields(fileFields, {
    ...rule,
    ...(undo ? {} : { before: readStoredFieldValues(db, mutation.node_id) }),
    touched: mutation.touchedFields ?? [],
    keepUnstored: !undo && indexed?.content_hash != null && indexed.content_hash === diskHash,
  });
  for (const [name, field] of restored) kept.set(name, field);
  return { kept, fileFields };
}

function readStoredFieldValues(db: Database.Database, nodeId: string): Record<string, unknown> {
  const rows = db.prepare(
    'SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?',
  ).all(nodeId) as Array<{
    field_name: string;
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    value_json: string | null;
  }>;
  const values = createFieldMap<unknown>();
  for (const row of rows) values[row.field_name] = reconstructValue(row);
  return values;
}

/**
 * Whether the write leaves the stored value of every field the file shows other than as
 * stored. Such a field can render as the file shows it whether or not the database holds
 * it (a field kept as typed, #501), so equal hashes alone do not show that a write storing
 * it changes nothing. Any other field renders from what the write stores, so the hashes
 * already cover it.
 */
function fileFieldsKeepStoredValues(
  db: Database.Database,
  nodeId: string,
  fileFields: readonly FileField[],
  finalFields: Record<string, unknown>,
): boolean {
  if (fileFields.length === 0) return true;
  const stored = readStoredFieldValues(db, nodeId);
  for (const field of fileFields) {
    const before = Object.hasOwn(stored, field.name) ? stored[field.name] : undefined;
    if (isDeepStrictEqual(before, field.value)) continue;
    const value = Object.hasOwn(finalFields, field.name) ? finalFields[field.name] : undefined;
    const after = value === null || value === undefined ? undefined : reconstructValue(classifyValue(value));
    if (!isDeepStrictEqual(before, after)) return false;
  }
  return true;
}

/**
 * Whether the write leaves every unrendered field (#547) as stored. Those never reach the
 * file, so equal hashes say nothing about them: a write that changes only one of them still
 * commits, to the database alone.
 */
function unrenderedFieldsKeepStoredValues(
  db: Database.Database,
  nodeId: string,
  finalFields: Record<string, unknown>,
): boolean {
  const stored = readStoredFieldValues(db, nodeId);
  for (const name of UNRENDERED_FIELDS) {
    const before = Object.hasOwn(stored, name) ? stored[name] : undefined;
    const value = Object.hasOwn(finalFields, name) ? finalFields[name] : undefined;
    const after = value === null || value === undefined ? undefined : reconstructValue(classifyValue(value));
    if (!isDeepStrictEqual(before, after)) return false;
  }
  return true;
}

/** `fields` with each kept field present, for key ordering only. */
function withKeptFieldNames(fields: Record<string, unknown>, kept: ReadonlyMap<string, FileField>): Record<string, unknown> {
  const names = createFieldMap(fields);
  for (const [name, field] of kept) {
    if (!Object.hasOwn(names, name)) names[name] = field.raw;
  }
  return names;
}

function runMutation(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  mutation: ProposedMutation,
  syncLogger?: SyncLogger,
  undoContext?: UndoContext,
  fsRollback?: { push(undo: () => void): void },
  previewGuards = false,
  effects?: MutationEffects,
): PipelineResult {
  assertMutationFilePresent(db, vaultPath, mutation);
  const absPath = safeVaultPath(vaultPath, mutation.file_path);

  // The title is the filename's, whatever a writer passed: the file cannot
  // carry any other title (parser/parse.ts), so a different one in the DB
  // makes links written from it resolve only here — and then stop resolving
  // here too, at the next watcher ingest of the file. The watcher's title is
  // the parser's already; undo restores its snapshot exactly. One exception:
  // a legacy stored title some link is still bound through (startup repair
  // could not rewrite that link) is kept while the file keeps its name, so an
  // ordinary edit never unbinds it.
  if (mutation.source !== 'watcher' && mutation.source !== 'undo' && !mutation.keepStoredTitle) {
    const stored = mutation.node_id === null
      ? undefined
      : db.prepare('SELECT file_path, title FROM nodes WHERE id = ?').get(mutation.node_id) as
        | { file_path: string; title: string | null }
        | undefined;
    const keepLegacyTitle = stored !== undefined && stored.title !== null
      && basename(stored.file_path) === basename(mutation.file_path)
      && linksBoundThroughTitle(db, mutation.node_id!, stored.title, stored.file_path);
    mutation = { ...mutation, title: keepLegacyTitle ? stored.title! : titleFromFilename(mutation.file_path) };
  }
  const carried = withoutCarriedTypeKeyField(mutation);
  mutation = carried.mutation;
  const linkCanonicalizer = (mutation.canonicalizeLinks ?? mutation.source === 'tool')
    ? mutation.linkCanonicalizer ?? new LinkCanonicalizer(db)
    : null;
  if (linkCanonicalizer) {
    mutation = { ...mutation, body: canonicalizeBodyLinks(mutation.body, linkCanonicalizer) };
  }
  // Set once the node's row is written under a new name (create or rename):
  // links elsewhere that miss that name by sanitization get repaired after.
  let repairInboundLinksAfter = false;

  // Build FileContext for date token resolution ($ctime, $mtime defaults)
  let fileCtx: FileContext | null = null;
  try {
    const st = statSync(absPath);
    // Read created_at from DB for existing nodes ($ctime source)
    let createdAtMs: number | null = null;
    if (mutation.node_id) {
      const row = db.prepare('SELECT created_at FROM nodes WHERE id = ?').get(mutation.node_id) as { created_at: number | null } | undefined;
      createdAtMs = row?.created_at ?? null;
    }
    fileCtx = { mtimeMs: st.mtimeMs, createdAtMs };
  } catch {
    // File doesn't exist yet (create-node) — tokens fall back to $now
  }

  const tmpDir = join(vaultPath, '.vault-engine', 'tmp');

  // ── DB Transaction spans Stages 1–6 ──────────────────────────────
  const txn = db.transaction(() => {
    // Capture writes are valid only while the conversation revision and its
    // complete link set still match the state the curator planned against.
    assertConversationAuthority(db, mutation.conversationAuthority);

    // ── Stage 1: Load schema context ────────────────────────────────
    const { claimsByType, globalFields } = loadSchemaContext(db, mutation.types);
    const verifiedFieldGuessState = mutation.fieldGuessGuard === undefined
      ? null
      : mutation.source !== 'tool' || mutation.node_id === null
        ? null
        : verifyFieldGuessMutationGuard(
            db,
            mutation.node_id,
            mutation.types,
            mutation.fields,
            mutation.touchedFields ?? [],
            mutation.fieldGuessGuard,
            { claimsByType, globalFields },
            requestedFileHeld(db, vaultPath, mutation.file_path, mutation.node_id, mutation.fieldGuessGuard),
          );
    if (mutation.fieldGuessGuard !== undefined && verifiedFieldGuessState === null) {
      throw new PipelineError('INVALID_PARAMS', 'Field guess guard requires an existing tool mutation');
    }

    // ── Undo snapshot capture (pre-mutation state) ──────────────────
    // Track whether THIS call actually inserted a snapshot row (vs. being
    // no-op'd by OR IGNORE because a snapshot for this (operation_id, node_id)
    // already existed — e.g. pre-captured by a tool handler before the out-of-
    // band UPDATE, or captured by a prior executeMutation call sharing the
    // same operation_id). Only the inserting call is allowed to DELETE the
    // snapshot on the no-op-write branch below.
    let capturedHere = false;
    if (undoContext && mutation.source !== 'undo') {
      if (mutation.node_id === null) {
        // Create: snapshot row with was_deleted = 1, other JSON columns null.
        // OR IGNORE: if a multi-call tool handler shares an operation_id, the
        // first snapshot is authoritative; subsequent inserts for the same
        // (operation_id, node_id) composite PK silently skip.
        const info = db.prepare(`
          INSERT OR IGNORE INTO undo_snapshots (
            operation_id, node_id, file_path, title, body, types, fields, relationships,
            explicit_null_fields, was_deleted, post_mutation_hash
          ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL)
        `).run(undoContext.operation_id, `pending:${mutation.file_path}`, mutation.file_path);
        capturedHere = info.changes > 0;
      } else {
        // Update: snapshot current DB state.
        // NB: if the node doesn't exist yet (caller-provided node_id for a
        // future undo-restore-delete), we skip capture here. Task 5 handles
        // the source='undo' create-with-id path explicitly.
        const nodeRow = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?')
          .get(mutation.node_id) as { file_path: string; title: string | null; body: string | null } | undefined;
        if (nodeRow) {
          const typesArr = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
            .all(mutation.node_id) as Array<{ schema_type: string }>).map(r => r.schema_type);
          const fieldsRows = db.prepare(
            'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text, source FROM node_fields WHERE node_id = ?'
          ).all(mutation.node_id);
          const relRows = db.prepare(
            'SELECT target, rel_type, context FROM relationships WHERE source_id = ?'
          ).all(mutation.node_id);
          const explicitNullFields = [...readExplicitNullFields(db, mutation.node_id)];

          // OR IGNORE: when multiple executeMutation calls share an
          // operation_id for the same node (e.g. update-node with set_title
          // that runs a mutation then executeRename on the same node), the
          // first snapshot is the authoritative pre-state.
          const info = db.prepare(`
            INSERT OR IGNORE INTO undo_snapshots (
              operation_id, node_id, file_path, title, body, types, fields, relationships,
              explicit_null_fields, was_deleted, post_mutation_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
          `).run(
            undoContext.operation_id,
            mutation.node_id,
            nodeRow.file_path,
            nodeRow.title,
            nodeRow.body,
            JSON.stringify(typesArr),
            JSON.stringify(fieldsRows),
            JSON.stringify(relRows),
            JSON.stringify(explicitNullFields),
          );
          capturedHere = info.changes > 0;
          // Text only the file holds is in no row above: keep its lines too (#656).
          if (capturedHere) {
            saveFileOnlyFields(db, undoContext.operation_id, mutation.node_id,
              captureFileOnlyFields(db, vaultPath, mutation.node_id, nodeRow.file_path, fieldsRows as StoredFieldRow[]));
          }
        }
      }
    }

    // ── Stage 2: Validate and coerce ────────────────────────────────
    const storedExplicitNullFields = mutation.node_id === null
      ? new Set<string>()
      : readExplicitNullFields(db, mutation.node_id);
    // A stored field named like the type key, which this write removes (#480).
    const storedTypeKeyField = readStoredTypeKeyField(db, mutation.node_id);
    const persistedExplicitNullFields = mutation.source === 'watcher' || mutation.source === 'undo'
      ? new Set(mutation.explicitNullFields ?? [])
      : verifiedFieldGuessState !== null
        ? verifiedFieldGuessState.explicitNullFields
      : mutation.node_id === null
        ? new Set<string>()
        : storedExplicitNullFields;
    const explicitNullOverlay = overlayExplicitNullFields(
      mutation.fields,
      persistedExplicitNullFields,
      mutation.source === 'tool' ? mutation.touchedFields : [],
      mutation.authoredNullFields ?? [],
    );
    const skipDefaults = mutation.source === 'normalizer'
      || mutation.source === 'propagation'
      || mutation.source === 'undo'
      || mutation.fieldGuessGuard !== undefined;
    const validation = validateProposedState(
      explicitNullOverlay.fields,
      mutation.types,
      claimsByType,
      globalFields,
      { fileCtx, skipDefaults },
    );
    const fieldGuessBaseline = verifiedFieldGuessState === null
      ? null
      : validateProposedState(
          overlayExplicitNullFields(
            withoutTypeKey(verifiedFieldGuessState.currentFields),
            verifiedFieldGuessState.explicitNullFields,
            [],
          ).fields,
          mutation.types,
          claimsByType,
          globalFields,
          { fileCtx, skipDefaults: true },
        );

    // ── Stage 3: Source-specific error handling ──────────────────────
    let finalFields: Record<string, unknown>;
    let finalRawFieldTexts = createFieldMap<string>();
    const retainedValues = createFieldMap<{ retained_value: unknown; rejected_value: unknown }>();
    if (mutation.source === 'tool' || mutation.source === 'normalizer' || mutation.source === 'propagation' || mutation.source === 'undo') {
      // Tool path: check for blocking errors. Normalizer, propagation, and undo
      // also tolerate REQUIRED_MISSING since they re-render / restore DB state
      // without backfilling defaults — pre-existing violations must not
      // block schema-driven re-renders or undo restorations.
      const isReRenderPath = mutation.source === 'normalizer' || mutation.source === 'propagation' || mutation.source === 'undo';
      const toleratedCodes = isReRenderPath
        ? new Set(['MERGE_CONFLICT', 'REQUIRED_MISSING'])
        : new Set(['MERGE_CONFLICT']);
      const baselineIssueKeys = new Set(
        fieldGuessBaseline?.issues
          .filter(issue => issue.severity === 'error')
          .map(fieldGuessIssueKey) ?? [],
      );
      const touchedFields = new Set(mutation.touchedFields ?? []);
      // A field named like the type key is never tolerated, an explicit null included:
      // rendered, it would overwrite the note's types. Its message says what to use.
      const typeKeyIssue = validation.issues.find(i => i.code === 'TYPE_KEY_FIELD');
      if (typeKeyIssue) throw new PipelineError('VALIDATION_FAILED', typeKeyIssue.message, validation);
      // Undo puts back a recorded state. A recorded value that fails validation
      // against the definitions now in force is kept as recorded, as the watcher
      // keeps a stored value it rejects, and logged below (#499). Refusing would
      // leave the note unrestorable; dropping it would delete the value.
      const keptUndoFields = new Set(mutation.source === 'undo'
        ? rejectedValueFields(validation, explicitNullOverlay.fields)
        : []);
      if (validation.issues.some(i => {
        if (i.severity !== 'error' || toleratedCodes.has(i.code)) return false;
        if (keptUndoFields.has(i.field)) return false;
        if (fieldGuessBaseline !== null) {
          return touchedFields.has(i.field) || !baselineIssueKeys.has(fieldGuessIssueKey(i));
        }
        return !(
          mutation.source === 'tool'
          && i.field !== undefined
          && explicitNullOverlay.explicitNullFields.has(i.field)
        );
      })) {
        throw new PipelineError('VALIDATION_FAILED', 'Validation failed', validation);
      }

      // Build final fields from coerced_state
      finalFields = createFieldMap<unknown>();
      for (const [fieldName, cv] of Object.entries(validation.coerced_state)) {
        finalFields[fieldName] = cv.value;
      }
      for (const fieldName of keptUndoFields) {
        const value = explicitNullOverlay.fields[fieldName];
        finalFields[fieldName] = value;
        retainedValues[fieldName] = { retained_value: value, rejected_value: value };
      }
      if (fieldGuessBaseline !== null) {
        const baselineIssueKeys = new Set(
          fieldGuessBaseline.issues
            .filter(issue => issue.severity === 'error')
            .map(fieldGuessIssueKey),
        );
        const touchedFields = new Set(mutation.touchedFields ?? []);
        for (const issue of validation.issues) {
          if (
            issue.severity === 'error'
            && !touchedFields.has(issue.field)
            && baselineIssueKeys.has(fieldGuessIssueKey(issue))
            && !explicitNullOverlay.explicitNullFields.has(issue.field)
            && Object.prototype.hasOwnProperty.call(mutation.fields, issue.field)
          ) {
            finalFields[issue.field] = mutation.fields[issue.field];
          }
        }
      }

    } else {
      // Watcher path: absorb what we can. Coerced values pass; a rejected field keeps
      // its DB value, or is omitted when it has none. The startup index reads a file
      // by the same rule (#510, #515).
      const read = fileFieldValues(db, mutation.node_id, validation, mutation.fields, mutation.raw_field_texts);
      finalFields = read.fields;
      finalRawFieldTexts = read.rawTexts;
      for (const rejected of read.rejected) {
        retainedValues[rejected.field] = {
          retained_value: rejected.retained_value,
          rejected_value: rejected.rejected_value,
        };
      }
    }

    // For existing nodes, carry forward DB value_raw_text for any orphan
    // field the caller didn't supply raw text for. Without this, every
    // tool re-render strips [[wikilink]] brackets off orphan fields
    // (the caller's `fields` map only has bare values from reconstructValue).
    // Undo supplies the snapshot raw map; absence must not inherit post-state raw text.
    // Nor does the watcher inherit it: it reads the raw text from the file, so a field
    // with none there holds no link now, whatever it held before. Carried into such a
    // field, the old text put the old link back at the next tool write (#663).
    // A field this write changed keeps only the links of what it left as it was
    // (carried-raw-text.ts): the stored text describes the old value, and rendering
    // from it would undo the change in the file while the database kept it (#663).
    if (mutation.source !== 'undo' && mutation.source !== 'watcher' && mutation.node_id && validation.orphan_fields.length > 0) {
      const missingRawText = validation.orphan_fields.filter(f =>
        !Object.hasOwn(finalRawFieldTexts, f) &&
        !(mutation.raw_field_texts && Object.hasOwn(mutation.raw_field_texts, f)),
      );
      if (missingRawText.length > 0) {
        const placeholders = missingRawText.map(() => '?').join(',');
        const rows = db.prepare(
          `SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text
           FROM node_fields WHERE node_id = ? AND field_name IN (${placeholders})`,
        ).all(mutation.node_id, ...missingRawText) as Array<{
          field_name: string;
          value_text: string | null;
          value_number: number | null;
          value_date: string | null;
          value_json: string | null;
          value_raw_text: string | null;
        }>;
        // Policy 2 reads a definition for a field none of the note's kinds claims.
        const readsDefinitions = readReferencePolicyVersion(db) === 2;
        for (const row of rows) {
          if (!row.value_raw_text) continue;
          const definition = readsDefinitions ? getGlobalField(db, row.field_name) : null;
          const carried = carriedRawText(reconstructValue(row), row.value_raw_text, finalFields[row.field_name], {
            listOfReferences: definition?.field_type === 'list' && definition.list_item_type === 'reference',
          });
          if (carried === null) continue;
          finalRawFieldTexts[row.field_name] = carried.raw;
          finalFields[row.field_name] = carried.value;
        }
      }
    }

    const defaultedFields = defaultedFieldsFrom(validation);

    const explicitNullFields = explicitNullOverlay.explicitNullFields;

    // ── Stage 4: Compute final state → RenderInput ──────────────────
    // The current file is read once: its unclaimed keys keep their order
    // (#447), and Stage 5 compares it with the render. A composed preview
    // passes the order of its earlier simulated write instead. Engine
    // projections keep the codepoint order their own renderers hash against.
    const existingContent = readFileIfExists(absPath);
    const effectiveFields = validation.effective_fields;
    // Typed values the watcher did not take stay in the file as typed (#501).
    const keptState = keptFieldsFor(db, mutation, existingContent, {
      stored: finalFields,
      explicitNull: explicitNullFields,
      defaulted: new Set(defaultedFields.map(d => d.field)),
      effectiveFields,
    });
    const keptFields = keptState.kept;
    const fieldOrdering = computeFieldOrdering(
      effectiveFields,
      keptFields.size === 0 ? validation.orphan_fields
        : [...validation.orphan_fields, ...[...keptFields.keys()].filter(f => !effectiveFields.has(f))],
      keptFields.size === 0 ? finalFields : withKeptFieldNames(finalFields, keptFields),
      Object.hasOwn(finalFields, 'vault_engine_projection') ? []
        : mutation.db_only && mutation.previewKeyOrder !== undefined ? mutation.previewKeyOrder
        : frontmatterKeyOrder(existingContent),
      explicitNullFields,
    );

    // Claims determine validation and ordering. All globally defined fields
    // present on the node determine v2 reference rendering and resolution.
    const policyVersion = readReferencePolicyVersion(db);
    const referenceDefinitions = new Map(globalFields);
    if (policyVersion === 2) {
      for (const fieldName of Object.keys(finalFields)) {
        if (referenceDefinitions.has(fieldName)) continue;
        const definition = getGlobalField(db, fieldName);
        if (definition) referenceDefinitions.set(fieldName, definition);
      }
    }

    const referenceFields = new Set<string>();
    const listReferenceFields = new Set<string>();
    for (const [name, gf] of referenceDefinitions) {
      if (gf.field_type === 'reference') referenceFields.add(name);
      if (gf.field_type === 'list' && gf.list_item_type === 'reference') listReferenceFields.add(name);
    }
    // Orphan raw values
    const orphanRawValues = createFieldMap<string>();
    for (const orphanField of validation.orphan_fields) {
      if (Object.hasOwn(finalRawFieldTexts, orphanField)) {
        orphanRawValues[orphanField] = finalRawFieldTexts[orphanField];
      } else if (mutation.raw_field_texts && Object.hasOwn(mutation.raw_field_texts, orphanField)) {
        orphanRawValues[orphanField] = mutation.raw_field_texts[orphanField];
      }
    }
    if (linkCanonicalizer) {
      // Explicit links first, raw text and value together — including an
      // unclaimed reference field's retained raw text, which the renderer
      // prefers over its value. Then bare reference values.
      const linkFields = Object.keys(finalFields).filter(f =>
        (!referenceFields.has(f) && !listReferenceFields.has(f)) || Object.hasOwn(orphanRawValues, f));
      const requiredTypes = new Map(policyVersion === 2
        ? [...referenceDefinitions].map(([name, gf]) => [name, gf.reference_target] as const)
        : []);
      for (const field of canonicalizeExplicitFieldLinks(finalFields, orphanRawValues, linkFields, linkCanonicalizer, requiredTypes)) {
        finalRawFieldTexts[field] = orphanRawValues[field];
      }
      canonicalizeReferenceFields(finalFields, referenceDefinitions, linkCanonicalizer, policyVersion === 2, orphanRawValues);
    }

    const renderInput: RenderInput = {
      types: mutation.types,
      fields: finalFields,
      body: mutation.body,
      fieldOrdering,
      referenceFields,
      listReferenceFields,
      orphanRawValues,
      explicitNullFields,
      ...(keptFields.size > 0 ? { keptFields } : {}),
    };

    // ── Stage 5: Render ─────────────────────────────────────────────
    const fileContent = renderNode(renderInput);
    const renderedHash = sha256(fileContent);
    const renderedKeyOrder = mutation.db_only && mutation.source === 'tool'
      ? { rendered_key_order: frontmatterKeyOrder(fileContent), rendered_content: fileContent }
      : {};

    // No-op write rule: identity, explicit-null markers, the on-disk hash, and
    // the DB content_hash must all match the desired state before rollback.
    // For new nodes (node_id is null), always commit.
    // Both must match: on-disk match alone is insufficient because the DB may have stale state
    // (watcher path: file edited, DB not yet updated).
    const dbIdentity = mutation.node_id
      ? (db.prepare('SELECT content_hash, file_path, title FROM nodes WHERE id = ?').get(mutation.node_id) as
          | { content_hash: string; file_path: string; title: string | null }
          | undefined)
      : undefined;
    const dbHash = dbIdentity?.content_hash;
    // Content-hash CAS: reject if the node's stored hash moved since the caller read it.
    // Checked BEFORE the no-op short-circuit so a stale save can never be swallowed as a no-op.
    // Inside the txn, so the throw rolls back (incl. any Stage-1 undo snapshot insert).
    if (mutation.expectedContentHash !== undefined && mutation.node_id !== null && dbHash !== mutation.expectedContentHash) {
      throw new ContentHashMismatchError(mutation.node_id, mutation.expectedContentHash, dbHash ?? null);
    }

    // Identity must match too: a rename/move changes only file_path + title
    // (title is filename-derived, never rendered into the file), so the hash
    // comparison alone cannot distinguish "unchanged" from "renamed intact".
    const identityUnchanged =
      dbIdentity !== undefined &&
      dbIdentity.file_path === mutation.file_path &&
      dbIdentity.title === mutation.title;
    const explicitNullStateUnchanged =
      storedExplicitNullFields.size === explicitNullFields.size &&
      [...storedExplicitNullFields].every(field => explicitNullFields.has(field));
    const comparisonDiskHash = mutation.db_only && mutation.previewDiskContentHash !== undefined
      ? mutation.previewDiskContentHash
      : existingContent === null ? null : sha256(existingContent);
    // A field named like the type key is never rendered, so a write that removes a stored one,
    // or drops one it was given (an undo snapshot's), commits even when the file would not
    // change: the row goes and the value is recorded. The watcher keeps its own no-op rule.
    const dropsTypeKeyField = (storedTypeKeyField !== null || carried.dropped !== null) && mutation.source !== 'watcher';
    const fileUnchanged = mutation.node_id !== null && identityUnchanged && explicitNullStateUnchanged && !dropsTypeKeyField
      && comparisonDiskHash === renderedHash && dbHash === renderedHash
      && fileFieldsKeepStoredValues(db, mutation.node_id, keptState.fileFields, finalFields);
    if (fileUnchanged && unrenderedFieldsKeepStoredValues(db, mutation.node_id!, finalFields)) {
      // The snapshot INSERT ran at Stage 1 before we knew this was a no-op.
      // Delete it here so the committing txn doesn't leave an orphan row
      // with post_mutation_hash = NULL polluting undo history. Only reachable
      // for non-null node_id per the outer guard, so no placeholder case.
      //
      // Guard: only delete if THIS call actually inserted the row. Otherwise
      // we might nuke a pre-state snapshot captured out-of-band (e.g. by
      // captureRenameSnapshot before the tool mutated nodes.file_path/title)
      // or by an earlier executeMutation call sharing this operation_id.
      if (undoContext && capturedHere) {
        db.prepare('DELETE FROM undo_snapshots WHERE operation_id = ? AND node_id = ?')
          .run(undoContext.operation_id, mutation.node_id);
      }
      syncLogger?.noop(mutation.file_path, mutation.source);
      // Complete no-op: no file write, no DB changes, no edits log
      return {
        node_id: mutation.node_id ?? '',
        file_path: mutation.file_path,
        validation,
        rendered_hash: renderedHash,
        ...renderedKeyOrder,
        edits_logged: 0,
        file_written: false,
        referenceDiagnostics: collectReferenceDiagnostics(db, mutation.node_id, finalFields, mutation.body,
          { ...mutation.raw_field_texts, ...orphanRawValues }, { file_path: mutation.file_path, title: mutation.title, types: mutation.types }),
        _noop: true,
      } as PipelineResult & { _noop: boolean };
    }

    if (mutation.node_id !== null) assertExpectedNodeVersion(db, mutation.node_id, mutation.expectedVersion);

    // ── Stage 6: Write (under write lock) ───────────────────────────
    return writeLock.withLockSync(absPath, () => {
      // db_only: update DB only, skip file write (watcher path).
      // A write that changes only unrendered fields (#547) leaves the file as it is.
      // Otherwise: write the file immediately.
      const shouldWriteFile = !mutation.db_only && !fileUnchanged;
      if (shouldWriteFile) {
        // Close the entry-preflight TOCTOU window. A watcher rename/unlink can
        // remove an existing node's projection while this mutation is waiting
        // to acquire the write lock; tool and propagation writes must fail
        // stale rather than recreate that path. Create, watcher, undo, and
        // db-only paths retain their semantics through the source guards.
        assertMutationFilePresent(db, vaultPath, mutation);
        // Disk CAS must live inside the write lock. The DB-content CAS above
        // protects against indexed changes; this protects a save that reached
        // disk after the caller read the node but before this write acquired
        // the lock (notably the daily Memories.md refresh).
        if (mutation.expectedDiskContentHash !== undefined) {
          const currentContent = readFileIfExists(absPath);
          const currentHash = currentContent === null ? null : sha256(currentContent);
          if (currentHash !== mutation.expectedDiskContentHash) {
            throw new ContentHashMismatchError(
              mutation.node_id ?? '',
              mutation.expectedDiskContentHash ?? 'none',
              currentHash,
            );
          }
        }
      }
      if (previewGuards) {
        return {
          node_id: mutation.node_id ?? '', file_path: mutation.file_path,
          validation, rendered_hash: renderedHash, edits_logged: 0, file_written: false,
          referenceDiagnostics: collectReferenceDiagnostics(db, mutation.node_id, finalFields, mutation.body,
            { ...mutation.raw_field_texts, ...orphanRawValues }, { file_path: mutation.file_path, title: mutation.title, types: mutation.types }),
        };
      }
      if (shouldWriteFile) {
        if (mutation.expectedDiskContentHash === null) {
          // The check above saw no file, but an external writer (Obsidian) is not held by
          // the write lock and may create one before this publish. Create-if-absent keeps
          // its bytes and fails the write as stale.
          if (!atomicCreateFile(absPath, fileContent, tmpDir)) {
            const winner = readFileOrNull(absPath);
            throw new ContentHashMismatchError(mutation.node_id ?? '', 'none', winner === null ? null : sha256(winner));
          }
        } else {
          atomicWriteFile(absPath, fileContent, tmpDir);
        }
        fsRollback?.push(() => {
          const currentContent = readFileOrNull(absPath);
          if (currentContent === null || sha256(currentContent) !== renderedHash) {
            return;
          }

          if (existingContent === null) {
            unlinkSync(absPath);
          } else {
            atomicWriteFile(absPath, existingContent, tmpDir);
          }
        });
        syncLogger?.fileWritten(mutation.file_path, mutation.source, renderedHash);
      }

      // Generate node_id for new nodes
      const nodeId = mutation.node_id ?? nanoid();
      const now = Date.now();

      // Capture prior identity BEFORE the UPSERT to detect rename.
      // (create = no prior row; rename = file_path or title changed.)
      // For source='undo', a caller-provided node_id that does not yet exist
      // in `nodes` counts as a create (undo may be restoring a previously
      // deleted node with its original id).
      const isCreate =
        mutation.node_id === null
        || (mutation.source === 'undo' && !db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(mutation.node_id));
      const referenceBefore = readNodeResolutionIdentity(db, nodeId);
      const prior = !isCreate
        ? (db.prepare('SELECT file_path, title FROM nodes WHERE id = ?').get(nodeId) as
            | { file_path: string; title: string | null }
            | undefined)
        : undefined;
      const isRename =
        !isCreate &&
        prior !== undefined &&
        (prior.file_path !== mutation.file_path || prior.title !== mutation.title);
      repairInboundLinksAfter = linkCanonicalizer !== null && !mutation.deferLinkRepair && shouldWriteFile && (isCreate || isRename);

      // When skipping file write, store the source file's hash so the
      // watcher recognizes the unchanged file and doesn't re-trigger.
      const contentHash = shouldWriteFile
        ? renderedHash
        : (mutation.source_content_hash ?? renderedHash);

      // Upsert nodes row (created_at set on INSERT only, preserved on UPDATE)
      db.prepare(`
        INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, content_changed_at, indexed_at, created_at, version)
        VALUES (@id, @file_path, @title, @body, @content_hash, @file_mtime, @content_changed_at, @indexed_at, @created_at, 1)
        ON CONFLICT(id) DO UPDATE SET
          file_path = @file_path,
          title = @title,
          body = @body,
          content_changed_at = CASE WHEN content_hash IS @content_hash THEN content_changed_at ELSE @content_changed_at END,
          content_hash = @content_hash,
          file_mtime = @file_mtime,
          indexed_at = @indexed_at,
          version = version + 1
      `).run({
        id: nodeId,
        file_path: mutation.file_path,
        title: mutation.title,
        body: mutation.body,
        content_hash: contentHash,
        file_mtime: now,
        content_changed_at: now,
        indexed_at: now,
        created_at: now,
      });

      // Delete and reinsert node_types
      db.prepare('DELETE FROM node_types WHERE node_id = ?').run(nodeId);
      const insertType = db.prepare('INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, ?)');
      mutation.types.forEach((t, idx) => {
        insertType.run(nodeId, t, idx);
      });

      // Delete and reinsert node_fields
      db.prepare('DELETE FROM node_fields WHERE node_id = ?').run(nodeId);
      const insertField = db.prepare(`
        INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, value_raw_text, source)
        VALUES (@node_id, @field_name, @value_text, @value_number, @value_date, @value_json, @value_raw_text, @source)
      `);
      for (const [fieldName, value] of Object.entries(finalFields)) {
        if (value === null || value === undefined) continue;
        const cols = classifyValue(value);
        const rawText = validation.orphan_fields.includes(fieldName)
          ? (finalRawFieldTexts[fieldName] ?? (mutation.raw_field_texts?.[fieldName] ?? null))
          : null;
        insertField.run({
          node_id: nodeId,
          field_name: fieldName,
          ...cols,
          value_raw_text: rawText,
          source: 'frontmatter',
        });
      }

      if (mutation.source === 'undo') {
        restoreExplicitNullFields(db, nodeId, explicitNullFields);
      } else {
        replaceExplicitNullFields(db, nodeId, explicitNullFields);
      }

      // Delete and reinsert relationships
      db.prepare('DELETE FROM relationships WHERE source_id = ?').run(nodeId);
      const insertRel = db.prepare(
        'INSERT OR IGNORE INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)'
      );
      const referenceDiagnostics: ReferenceDiagnostic[] = [];
      if (policyVersion === 1) {
        for (const rel of deriveReferenceContexts(finalFields, mutation.body, globalFields, orphanRawValues, false)) {
          const resolution = effects?.resolveReference?.({ rawTarget: rel.target, context: rel.referenceContext });
          const resolvedId = resolution
            ? resolution.status === 'resolved' ? resolution.targetId : null
            : (mutation.targetLookup ? mutation.targetLookup().resolve(rel.target) : resolveTarget(db, rel.target))?.id ?? null;
          insertRel.run(nodeId, rel.target, rel.rel_type, rel.context, resolvedId);
        }
      } else {
        const catalog = mutation.referenceCatalog?.() ?? buildReferenceCatalog(db);
        const rawReferenceTexts = { ...mutation.raw_field_texts, ...orphanRawValues };
        for (const rel of deriveReferenceContexts(finalFields, mutation.body, referenceDefinitions, rawReferenceTexts)) {
          const request = { rawTarget: rel.target, context: rel.referenceContext };
          const resolution = resolveRelationship(catalog, request, policyVersion);
          insertRel.run(nodeId, rel.target, rel.rel_type, rel.context,
            resolution.status === 'resolved' ? resolution.targetId : null);
          if (resolution.status === 'unresolved') referenceDiagnostics.push({ sourceId: nodeId, request, resolution });
        }
      }

      // Update FTS
      const rowInfo = db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(nodeId) as { rowid: number } | undefined;
      if (rowInfo) {
        db.prepare('DELETE FROM nodes_fts WHERE rowid = ?').run(rowInfo.rowid);
        db.prepare(
          `INSERT INTO nodes_fts (rowid, title, aliases, path, fields, links, body)
           VALUES (@rowid, @title, @aliases, @path, @fields, @links, @body)`
        ).run({ rowid: rowInfo.rowid, ...buildFtsRow(db, nodeId) });
      }

      // Write edits log entries
      const logEntries = buildDeviationEntries(
        nodeId,
        mutation.source,
        validation.coerced_state,
        validation.issues,
        mutation.types,
        Object.keys(retainedValues).length > 0 ? retainedValues : undefined,
        defaultedFields.length > 0 ? defaultedFields : undefined,
      );
      // The stored row's value, and one dropped from the fields this write was given when it
      // differs (an undo snapshot of an earlier state), so no value goes without a record.
      for (const removed of distinctTypeKeyFields(storedTypeKeyField, carried.dropped)) {
        logEntries.push(typeKeyFieldRemovedEntry(nodeId, mutation.source, removed, mutation.types));
      }
      const editsLogged = writeEditsLogEntries(db, logEntries);

      // Lifecycle-event refresh: keep resolved_target_id consistent across
      // other nodes. Runs AFTER this node's row is in the DB so other-node
      // edges resolving to our candidate keys can be picked up.
      const unbound = isCreate
        ? refreshOnCreate(db, nodeId)
        : isRename
          ? refreshOnRename(db, nodeId, referenceBefore)
          : refreshTypedReferences(db, { kind: 'node', before: referenceBefore, after: readNodeResolutionIdentity(db, nodeId) }).unbound ?? [];
      // Other nodes' typed references this write left unresolved (#112). This node's own
      // were diagnosed when its relationships were rebuilt above.
      referenceDiagnostics.push(...unbound.filter(diagnostic => diagnostic.sourceId !== nodeId));

      // ── Undo snapshot finalization (post-mutation hash) ─────────────
      if (undoContext && mutation.source !== 'undo') {
        if (isCreate) {
          // Swap placeholder node_id for the generated one and record hash
          db.prepare(`
            UPDATE undo_snapshots
            SET node_id = ?, post_mutation_hash = ?
            WHERE operation_id = ? AND node_id = ?
          `).run(nodeId, contentHash, undoContext.operation_id, `pending:${mutation.file_path}`);
        } else {
          db.prepare(`
            UPDATE undo_snapshots
            SET post_mutation_hash = ?
            WHERE operation_id = ? AND node_id = ?
          `).run(contentHash, undoContext.operation_id, nodeId);
        }
      }

      return {
        node_id: nodeId,
        file_path: mutation.file_path,
        validation,
        rendered_hash: contentHash,
        ...renderedKeyOrder,
        edits_logged: editsLogged,
        file_written: shouldWriteFile,
        referenceDiagnostics,
      };
    });
  });

  // Run the transaction
  const result: PipelineResult = txn();
  if (previewGuards) return result;

  // Handle no-op case (transaction committed with no file write or DB mutation)
  if ((result as PipelineResult & { _noop?: boolean })._noop) {
    return {
      node_id: mutation.node_id ?? '',
      file_path: mutation.file_path,
      validation: (result as PipelineResult).validation,
      rendered_hash: (result as PipelineResult).rendered_hash,
      ...(result.rendered_key_order !== undefined ? { rendered_key_order: result.rendered_key_order } : {}),
      ...(result.rendered_content !== undefined ? { rendered_content: result.rendered_content } : {}),
      edits_logged: 0,
      file_written: false,
      referenceDiagnostics: result.referenceDiagnostics,
    };
  }

  if (repairInboundLinksAfter) {
    result.links_repaired = repairInboundLinks(
      db, writeLock, vaultPath, result.node_id, syncLogger, undoContext, fsRollback,
    );
  }

  // Tool-path settings seam: a committed tool-source write may have changed a
  // Settings/Models/ note (the watcher path notifies via processFileChange, but
  // tool writes bypass the watcher). The wired handler filters to catalog paths;
  // non-catalog writes are a cheap no-op. Only fires for genuine (non-no-op)
  // writes, and never for the watcher/normalizer/undo paths. Isolated in
  // notifyToolWrite's own try/catch — a stale hook must never fail a tool write.
  if (mutation.source === 'tool' && !mutation.db_only) {
    const notify = () => notifyToolWrite(mutation.file_path);
    if (effects) effects.afterCommit.push(notify);
    else notify();
  }

  return result;
}

/**
 * Re-save, with link canonicalization, every other note holding a link that
 * names `nodeId` only up to filename sanitization — typically written before
 * the note existed, from the title it was then created under. Runs after the
 * node's own write. Best-effort: a note that cannot be re-saved keeps its
 * link, and vault-doctor keeps reporting it. Returns the notes rewritten.
 */
export function repairInboundLinks(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  nodeId: string,
  syncLogger?: SyncLogger,
  undoContext?: UndoContext,
  fsRollback?: { push(undo: () => void): void },
): string[] {
  const repaired: string[] = [];
  for (const sourceId of nearMissLinkSources(db, nodeId)) {
    if (resaveWithCanonicalLinks(db, writeLock, vaultPath, sourceId, syncLogger, undoContext, fsRollback)) {
      repaired.push(sourceId);
    }
  }
  return repaired;
}

/**
 * Re-render a node from its stored state with link canonicalization. Uses the
 * propagation source so a repair never backfills defaults or fails on
 * pre-existing REQUIRED_MISSING, and never recreates a missing file; a file
 * that differs from its indexed hash is skipped. The stored title is kept
 * (link repair only; titles are reset by repairVaultLinks). Returns whether the file
 * changed; failures are logged and swallowed. Pass `linkCanonicalizer` to
 * resolve against one catalog snapshot across several re-saves.
 */
export function resaveWithCanonicalLinks(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  nodeId: string,
  syncLogger?: SyncLogger,
  undoContext?: UndoContext,
  fsRollback?: { push(undo: () => void): void },
  linkCanonicalizer?: LinkCanonicalizer,
): boolean {
  const resave = canonicalLinkResave(db, nodeId, linkCanonicalizer);
  if (!resave) return false;
  const writes: Array<() => void> = [];
  try {
    const result = executeMutation(db, writeLock, vaultPath, resave.mutation, syncLogger, undoContext,
      { push: undo => writes.push(undo) });
    for (const undo of writes) fsRollback?.push(undo);
    return result.file_written;
  } catch (err) {
    // The failed write's own transaction rolled back; put its file back too.
    for (let i = writes.length - 1; i >= 0; i--) {
      try {
        writes[i]();
      } catch {
        // Hash-guarded restore; a file changed since is left as it is.
      }
    }
    console.warn(`[links] could not repair links in ${resave.mutation.file_path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Whether `resaveWithCanonicalLinks` would change the node's file, found by a
 * preview that writes nothing (the report-only startup link repair, #447). A
 * re-save that would be skipped or fail counts as no change, as it does there.
 */
export function wouldResaveWithCanonicalLinks(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  nodeId: string,
  linkCanonicalizer?: LinkCanonicalizer,
): boolean {
  const resave = canonicalLinkResave(db, nodeId, linkCanonicalizer);
  if (!resave) return false;
  try {
    // The re-save keeps the stored identity and explicit-null markers, and the
    // file must match its indexed hash, so it writes exactly when the render differs.
    return previewMutation(db, writeLock, vaultPath, resave.mutation).rendered_hash !== resave.indexedHash;
  } catch {
    return false;
  }
}

/** The mutation a canonical-link re-save runs, or null for a node it never re-saves. */
function canonicalLinkResave(
  db: Database.Database,
  nodeId: string,
  linkCanonicalizer?: LinkCanonicalizer,
): { mutation: ProposedMutation; indexedHash: string | null } | null {
  const state = loadNodeState(db, nodeId);
  if (!state) return null;
  const indexed = db.prepare('SELECT content_hash FROM nodes WHERE id = ?').get(nodeId) as { content_hash: string | null };
  // Engine-owned projections are renders, not authored text: rewritten links
  // would read back as edits through settings or memory-note ingest.
  if (settingsNoteDomain(state.file_path) !== null || Object.hasOwn(state.currentFields, 'vault_engine_projection')) {
    return null;
  }
  return {
    indexedHash: indexed.content_hash,
    mutation: {
      source: 'propagation',
      canonicalizeLinks: true,
      keepStoredTitle: true,
      node_id: nodeId,
      file_path: state.file_path,
      title: state.title,
      types: state.types,
      fields: state.currentFields,
      body: state.body,
      raw_field_texts: state.rawFieldTexts,
      // The DB state is re-rendered, so the file must still be what was
      // indexed: an edit the watcher has not picked up yet is never overwritten.
      ...(indexed.content_hash !== null ? { expectedDiskContentHash: indexed.content_hash } : {}),
      ...(linkCanonicalizer ? { linkCanonicalizer } : {}),
    },
  };
}

function fieldGuessIssueKey(issue: { field: string; code: string; message: string; details?: unknown }): string {
  return JSON.stringify([issue.field, issue.code, issue.message, issue.details ?? null]);
}
