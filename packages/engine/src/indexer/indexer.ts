import { collectStoredReferenceDiagnostics, recheckInboundDiagnostics, type ReferenceDiagnostic } from '../pipeline/diagnostics.js';
import { logReferenceDiagnostics } from '../resolver/diagnostics.js';
import { createFieldMap } from '../fields/field-map.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { parseMarkdown } from '../parser/parse.js';
import { extractBodyWikiLinks } from '../parser/wiki-links.js';
import { extractRawFieldTexts } from '../parser/raw-field-texts.js';
import type { WikiLink, YamlValue } from '../parser/types.js';
import { sha256 } from './hash.js';
import { shouldIgnore } from './ignore.js';
import { ResolutionLookup, resolveTarget } from '../resolver/resolve.js';
import { buildReferenceCatalog, resolveRelationship } from '../resolver/relationship-policy.js';
import { readReferencePolicyVersion } from '../db/reference-policy-version.js';
import { listGlobalFields } from '../global-fields/crud.js';
import { deriveReferenceContexts } from '../pipeline/relationships.js';
import { readNodeResolutionIdentity, refreshTypedReferences, reconcileTypedReferences } from '../resolver/typed-refresh.js';
import { refreshOnRename } from '../resolver/refresh.js';
import { executeDeletion } from '../pipeline/delete.js';
import { buildFtsRow } from '../search/fts-row.js';
import { WriteLockManager } from '../sync/write-lock.js';
import { collectNewPathHashes, pairRenames, type MissingNode } from '../sync/rename-pairing.js';
import { explicitNullKeys, replaceExplicitNullFields } from '../fields/explicit-null.js';
import { typeKey } from '../parser/type-key.js';
import type { ParsedNode } from '../parser/types.js';
import { loadSchemaContext, type SchemaContext } from '../pipeline/schema-context.js';
import { fileFieldValues, storedUnrenderedValues, type RejectedValue } from '../pipeline/rejected-values.js';
import { buildDeviationEntries, writeEditsLogEntries } from '../pipeline/edits-log.js';
import { defaultedFieldsFrom, validateProposedState } from '../validation/validate.js';
import type { CoercedValue, ValidationResult } from '../validation/types.js';


const BATCH_SIZE = 100;

// ── Prepared statement cache (per call, not module-level) ──────────

interface Statements {
  getNodeByPath: Database.Statement;
  getNodeRowid: Database.Statement;
  upsertNode: Database.Statement;
  deleteFts: Database.Statement;
  insertFts: Database.Statement;
  deleteTypes: Database.Statement;
  insertType: Database.Statement;
  deleteFields: Database.Statement;
  insertField: Database.Statement;
  deleteRelationships: Database.Statement;
  insertRelationship: Database.Statement;
  insertEditLog: Database.Statement;
  allFilePaths: Database.Statement;
  getCreatedAt: Database.Statement;
  updateMtime: Database.Statement;
}

function prepareStatements(db: Database.Database): Statements {
  return {
    getNodeByPath: db.prepare('SELECT id, content_hash, file_mtime FROM nodes WHERE file_path = ?'),
    getNodeRowid: db.prepare('SELECT rowid FROM nodes WHERE id = ?'),
    upsertNode: db.prepare(`
      INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, content_changed_at, indexed_at, created_at)
      VALUES (@id, @file_path, @title, @body, @content_hash, @file_mtime, @content_changed_at, @indexed_at, @created_at)
      ON CONFLICT(id) DO UPDATE SET
        file_path = @file_path,
        title = @title,
        body = @body,
        content_changed_at = CASE WHEN content_hash IS @content_hash THEN content_changed_at ELSE @content_changed_at END,
        content_hash = @content_hash,
        file_mtime = @file_mtime,
        indexed_at = @indexed_at
    `),
    deleteFts: db.prepare('DELETE FROM nodes_fts WHERE rowid = ?'),
    insertFts: db.prepare(
      `INSERT INTO nodes_fts (rowid, title, aliases, path, fields, links, body)
       VALUES (@rowid, @title, @aliases, @path, @fields, @links, @body)`
    ),
    deleteTypes: db.prepare('DELETE FROM node_types WHERE node_id = ?'),
    insertType: db.prepare('INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, ?)'),
    deleteFields: db.prepare('DELETE FROM node_fields WHERE node_id = ?'),
    insertField: db.prepare(`
      INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, value_raw_text, source)
      VALUES (@node_id, @field_name, @value_text, @value_number, @value_date, @value_json, @value_raw_text, @source)
    `),
    deleteRelationships: db.prepare('DELETE FROM relationships WHERE source_id = ?'),
    insertRelationship: db.prepare(
      'INSERT OR IGNORE INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)',
    ),
    insertEditLog: db.prepare(
      'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
    ),
    allFilePaths: db.prepare('SELECT id, file_path, content_hash FROM nodes'),
    getCreatedAt: db.prepare('SELECT created_at FROM nodes WHERE id = ?'),
    updateMtime: db.prepare('UPDATE nodes SET file_mtime = ? WHERE id = ?'),
  };
}

// ── Field value classification ─────────────────────────────────────

interface FieldColumns {
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
}

function classifyValue(v: YamlValue): FieldColumns {
  if (v === null || v === undefined) {
    return { value_text: null, value_number: null, value_date: null, value_json: JSON.stringify(null) };
  }
  if (v instanceof Date) {
    return { value_text: null, value_number: null, value_date: v.toISOString(), value_json: null };
  }
  if (typeof v === 'string') {
    return { value_text: v, value_number: null, value_date: null, value_json: null };
  }
  if (typeof v === 'number') {
    return { value_text: null, value_number: v, value_date: null, value_json: null };
  }
  // boolean, array, object
  return { value_text: null, value_number: null, value_date: null, value_json: JSON.stringify(v) };
}

// ── Core index logic for a single file ─────────────────────────────


interface FileValues {
  /** The validation of the file's values for the note's types (the watcher's). */
  validation: ValidationResult;
  /** By field, the value stored: as validation coerced it, a required field's default,
   * or the stored value kept in place of a rejected one. */
  fields: Record<string, unknown>;
  /** The raw link texts stored: the file's, but a kept value's own (or none). */
  rawTexts: Record<string, string>;
  /** By field, what is stored in place of a rejected value: the node's stored row, or none. */
  rejected: Map<string, RejectedValue>;
  /** The required fields the file leaves out, filled with their defaults (DB only). */
  defaulted: ReturnType<typeof defaultedFieldsFrom>;
}

/**
 * The note's fields as the watcher stores them for this file and database state
 * (`executeMutation`, source `watcher`, through `fileFieldValues`): each value as validation
 * coerces it, a required field's default where the file has none, and for a field
 * validation rejects (a value that fails, or a required field without a default that the
 * file leaves out or empty) the value the node already held, or none (#510, #515). Null
 * when the note's types claim no field: such a note is not validated at all, so a
 * brand-new install's first index, which runs before any schema exists, stores every value
 * as given.
 */
function readFileValues(
  db: Database.Database,
  stmts: Statements,
  nodeId: string | null,
  parsed: ParsedNode,
  rawFieldTexts: Record<string, string>,
  mtime: number,
  schemaFor: ((types: string[]) => SchemaContext) | undefined,
): FileValues | null {
  if (parsed.types.length === 0) return null;
  const context = schemaFor ? schemaFor(parsed.types) : loadSchemaContext(db, parsed.types);
  if (context.claimsByType.size === 0) return null;
  const proposed = createFieldMap<unknown>();
  for (const [field, value] of parsed.fields) proposed[field] = value;
  // As the watcher reads a date token in a default: the file's mtime, and the node's creation.
  const created = nodeId === null ? undefined : stmts.getCreatedAt.get(nodeId) as { created_at: number | null } | undefined;
  const validation = validateProposedState(proposed, parsed.types, context.claimsByType, context.globalFields,
    { fileCtx: { mtimeMs: mtime, createdAtMs: created?.created_at ?? null }, skipDefaults: false });
  const read = fileFieldValues(db, nodeId, validation, proposed, rawFieldTexts);
  return {
    validation,
    fields: read.fields,
    rawTexts: read.rawTexts,
    rejected: new Map(read.rejected.map(value => [value.field, value])),
    defaulted: defaultedFieldsFrom(validation),
  };
}

interface KeptRelationship {
  target: string;
  rel_type: string;
  context: string | null;
}

/**
 * The relationships of each field whose stored row is kept in place of a rejected value.
 * They were derived from that stored value when it was written, so they stay the note's,
 * links nested inside the value included, which its stored form no longer shows (#510).
 * A field's relationships are the ones named after it.
 */
function keptFieldRelationships(
  db: Database.Database,
  nodeId: string | null,
  read: FileValues | null,
): KeptRelationship[] {
  if (nodeId === null || read === null) return [];
  const kept = [...read.rejected.values()].filter(value => value.stored !== null);
  if (kept.length === 0) return [];
  const select = db.prepare('SELECT target, rel_type, context FROM relationships WHERE source_id = ? AND rel_type = ? ORDER BY id');
  return kept.flatMap(value => select.all(nodeId, value.field) as KeptRelationship[]);
}

/**
 * The coercions as the startup index logs them: one that leaves the value stored as the
 * file wrote it is not logged (validation marks even a strict ISO date coerced, and the
 * watcher logs it); one that changes what is stored is (#515).
 */
function storedCoercions(coercedState: Record<string, CoercedValue>): Record<string, CoercedValue> {
  const logged = createFieldMap<CoercedValue>();
  for (const [field, coerced] of Object.entries(coercedState)) {
    const unchanged = coerced.changed && coerced.source === 'provided'
      && sameColumns(classifyValue(coerced.original as YamlValue), classifyValue(coerced.value as YamlValue));
    logged[field] = unchanged ? { ...coerced, changed: false } : coerced;
  }
  return logged;
}

function sameColumns(a: FieldColumns, b: FieldColumns): boolean {
  return a.value_text === b.value_text && a.value_number === b.value_number
    && a.value_date === b.value_date && a.value_json === b.value_json;
}

/** A body link or untyped reference `fullIndex` stored unbound, to bind once every note is read. */
interface PendingLink {
  /** The relationship row. */
  id: number;
  sourceId: string;
  target: string;
}

interface IndexOptions {
  /** Who reads the file, as the edits log names it. */
  source: 'fullIndex' | 'indexFile';
  /** Full indexing binds typed references once, after every file. */
  deferTypedReferences: boolean;
  /** Collects other nodes' typed references this index left unresolved. */
  inbound?: ReferenceDiagnostic[];
  /** `fullIndex`: body links and untyped references are stored unbound and collected
   * here, to be bound once every note is read (#507). A single file binds its own. */
  pendingLinks?: PendingLink[];
  /** `fullIndex`'s schema definitions for a note's types, read once for each set of types;
   * a single file reads its own. */
  schemaFor?: (types: string[]) => SchemaContext;
}

function doIndex(
  db: Database.Database,
  stmts: Statements,
  raw: string,
  filePath: string,
  absolutePath: string,
  mtime: number,
  contentHash: string,
  existingId: string | null,
  { source, deferTypedReferences, inbound, pendingLinks, schemaFor }: IndexOptions,
): string {
  const parsed = parseMarkdown(raw, filePath);
  const rawFieldTexts = extractRawFieldTexts(raw);
  const nodeId = existingId ?? nanoid();
  const referenceBefore = readNodeResolutionIdentity(db, nodeId);
  const now = Date.now();
  // Read before the node's old rows go: a value kept in place of a rejected one is the
  // stored one, with its relationships (#510, #515).
  const read = readFileValues(db, stmts, existingId, parsed, rawFieldTexts, mtime, schemaFor);
  const rejected = read?.rejected ?? new Map<string, RejectedValue>();
  const keptRelationships = keptFieldRelationships(db, existingId, read);
  // The Engine never writes these to the file, so the stored rows stand (#547).
  const unrendered = new Map(storedUnrenderedValues(db, existingId).map(value => [value.field, value]));

  // If re-indexing, clean up old dependent rows and FTS entry
  if (existingId !== null) {
    const rowInfo = stmts.getNodeRowid.get(existingId) as { rowid: number } | undefined;
    if (rowInfo) {
      stmts.deleteFts.run(rowInfo.rowid);
    }
    stmts.deleteTypes.run(existingId);
    stmts.deleteFields.run(existingId);
    stmts.deleteRelationships.run(existingId);
  }

  // Upsert node
  stmts.upsertNode.run({
    id: nodeId,
    file_path: filePath,
    title: parsed.title ?? null,
    body: parsed.body,
    content_hash: contentHash,
    file_mtime: mtime,
    content_changed_at: mtime,
    indexed_at: now,
    created_at: now,
  });
  replaceExplicitNullFields(db, nodeId, explicitNullKeys(parsed.fields));

  // Insert types
  parsed.types.forEach((t, idx) => {
    stmts.insertType.run(nodeId, t, idx);
  });

  // Insert fields: the file's, each as the watcher stores it (#515), then those the file
  // leaves out that are stored all the same.
  const fieldNames = new Set<string>();
  const insertValue = (fieldName: string, value: unknown, rawText: string | null): void => {
    fieldNames.add(fieldName);
    stmts.insertField.run({
      node_id: nodeId,
      field_name: fieldName,
      ...classifyValue(value as YamlValue),
      value_raw_text: rawText,
      source: 'frontmatter',
    });
  };
  // A rejected value is not stored: the node's stored row for the field stays as it was,
  // or the field has none (#510).
  const insertKept = (kept: RejectedValue): void => {
    if (kept.stored === null) return;
    fieldNames.add(kept.field);
    stmts.insertField.run({ node_id: nodeId, field_name: kept.field, ...kept.stored });
  };
  for (const [fieldName, value] of parsed.fields) {
    if (unrendered.has(fieldName)) continue;
    const kept = rejected.get(fieldName);
    if (kept !== undefined) {
      insertKept(kept);
      continue;
    }
    if (value === null) continue;
    if (read === null) {
      insertValue(fieldName, value, rawFieldTexts[fieldName] ?? null);
    } else if (Object.hasOwn(read.fields, fieldName)) {
      // Coerced as the watcher stores it; an unclaimed field as given.
      insertValue(fieldName, read.fields[fieldName], rawFieldTexts[fieldName] ?? null);
    }
  }
  if (read !== null) {
    // A required field the file leaves out keeps its stored value when it has no default,
    // and gets its default (in the database only) when it has one, as with the watcher.
    for (const kept of rejected.values()) {
      if (!parsed.fields.has(kept.field)) insertKept(kept);
    }
    for (const { field } of read.defaulted) insertValue(field, read.fields[field], null);
  }
  for (const kept of unrendered.values()) {
    if (!fieldNames.has(kept.field)) insertKept(kept);
  }

  // A body link or untyped reference. A single file binds it now, against every note, as
  // the watcher does. `fullIndex` binds it once every note is read (`bindPendingLinks`):
  // bound now, against the notes read so far, a link to a name several notes share would
  // go to whichever the directory walk reached first (#507).
  const insertLink = (target: string, relType: string, context: string | null): void => {
    if (pendingLinks === undefined) {
      stmts.insertRelationship.run(nodeId, target, relType, context, resolveTarget(db, target)?.id ?? null);
      return;
    }
    const inserted = stmts.insertRelationship.run(nodeId, target, relType, context, null);
    if (inserted.changes > 0) pendingLinks.push({ id: Number(inserted.lastInsertRowid), sourceId: nodeId, target });
  };

  // Parse/index and the normal mutation pipeline share typed origin semantics.
  // Single-file ingest resolves immediately. Full indexing defers typed edges
  // until the complete candidate population is available, before returning.
  const policyVersion = readReferencePolicyVersion(db);
  // Links in a value the note does not store are not its relationships; a stored value
  // kept in its place keeps its relationships (#510). parseMarkdown appends body links
  // after frontmatter. A required field the file leaves out or empty is rejected too
  // (#515), but holds no link to tell apart.
  const rejectsFileValue = [...rejected.values()].some(value => value.rejected_value !== null && value.rejected_value !== undefined);
  const frontmatterLinkCount = policyVersion === 1 && !rejectsFileValue
    ? 0
    : parsed.wikiLinks.length - extractBodyWikiLinks(parsed.body).length;
  const isRejectedValueLink = (link: WikiLink, index: number): boolean =>
    index < frontmatterLinkCount && rejected.has(link.context);
  // The note's fields and raw link texts as they are stored.
  const stored = read ?? { fields: Object.fromEntries(parsed.fields) as Record<string, unknown>, rawTexts: rawFieldTexts };
  if (policyVersion === 1) {
    parsed.wikiLinks.forEach((link, index) => {
      if (isRejectedValueLink(link, index)) return;
      const relType = fieldNames.has(link.context) ? link.context : 'wiki-link';
      insertLink(link.target, relType, link.context);
    });
    for (const rel of keptRelationships) {
      insertLink(rel.target, rel.rel_type, rel.context);
    }
    // A default the file does not hold, when it names a note in a reference field, as
    // the watcher records it (policy 2 derives it with the stored fields below).
    if (read !== null && read.defaulted.length > 0) {
      const defaults = Object.fromEntries(read.defaulted.map(({ field }) => [field, read.fields[field]]));
      const definitions = new Map([...read.validation.effective_fields].map(([field, ef]) => [field, ef.global_field]));
      for (const rel of deriveReferenceContexts(defaults, '', definitions, {}, false)) {
        insertLink(rel.target, rel.rel_type, rel.context);
      }
    }
  } else {
    const globalFields = new Map(listGlobalFields(db).map(field => [field.name, field]));
    const catalog = deferTypedReferences ? null : buildReferenceCatalog(db);
    const rels = [...deriveReferenceContexts(stored.fields, parsed.body, globalFields, stored.rawTexts)];
    // parseMarkdown retains links from nested frontmatter values even after it
    // strips their brackets from the stored object. Shared derivation cannot
    // recover those links from cleaned values, so add only the parser links it
    // did not already derive.
    const seen = new Set(rels.map(rel => JSON.stringify([rel.target, rel.rel_type])));
    for (const [index, link] of parsed.wikiLinks.slice(0, frontmatterLinkCount).entries()) {
      if (isRejectedValueLink(link, index)) continue;
      const key = JSON.stringify([link.target, link.context]);
      if (seen.has(key)) continue;
      seen.add(key);
      rels.push({ target: link.target, rel_type: link.context, context: link.context,
        referenceContext: { origin: 'orphan', field: link.context, requiredType: null } });
    }
    // A kept value's links its stored form cannot show, as for the parser links above.
    for (const rel of keptRelationships) {
      const key = JSON.stringify([rel.target, rel.rel_type]);
      if (seen.has(key)) continue;
      seen.add(key);
      rels.push({ target: rel.target, rel_type: rel.rel_type, context: rel.context ?? rel.rel_type,
        referenceContext: { origin: 'orphan', field: rel.rel_type, requiredType: null } });
    }
    for (const rel of rels) {
      if (catalog === null) {
        // Preserve legacy/unconstrained ingest order. Typed bindings are rebuilt
        // once after all files (including deletions and failed-file savepoints).
        if (rel.referenceContext.requiredType === null) insertLink(rel.target, rel.rel_type, rel.context);
        else stmts.insertRelationship.run(nodeId, rel.target, rel.rel_type, rel.context, null);
      } else {
        const resolution = resolveRelationship(catalog, { rawTarget: rel.target, context: rel.referenceContext }, policyVersion);
        stmts.insertRelationship.run(nodeId, rel.target, rel.rel_type, rel.context,
          resolution.status === 'resolved' ? resolution.targetId : null);
      }
    }
  }

  if (!deferTypedReferences) {
    const { unbound } = refreshTypedReferences(db, { kind: 'node', before: referenceBefore, after: readNodeResolutionIdentity(db, nodeId) });
    inbound?.push(...unbound ?? []);
  }

  // Insert FTS entry using rowid from nodes table after fields/relationships are persisted.
  const rowInfo = stmts.getNodeRowid.get(nodeId) as { rowid: number };
  stmts.insertFts.run({ rowid: rowInfo.rowid, ...buildFtsRow(db, nodeId) });

  // Log as the watcher logs this read (each rejected value, which the file keeps (#510),
  // each default, and each coercion), with `source` naming the index; but a coercion
  // that leaves the stored value as the file wrote it is not logged (#515).
  if (read !== null) {
    const retainedValues = createFieldMap<{ retained_value: unknown; rejected_value: unknown }>();
    for (const [field, value] of rejected) {
      retainedValues[field] = { retained_value: value.retained_value, rejected_value: value.rejected_value };
    }
    writeEditsLogEntries(db, buildDeviationEntries(
      nodeId, source, storedCoercions(read.validation.coerced_state), read.validation.issues, parsed.types,
      rejected.size > 0 ? retainedValues : undefined,
      read.defaulted.length > 0 ? read.defaulted : undefined,
    ));
  }
  stmts.insertEditLog.run(nodeId, now, 'file-indexed', filePath);

  return nodeId;
}

/**
 * Bind the body links and untyped references `fullIndex` read, once every note is read:
 * each to what `resolveTarget` gives against the complete set of notes, so a link to a
 * name several notes share goes to the shortest of their paths whatever order the
 * directory walk took (#507). One lookup, loaded from `nodes` once, answers every link
 * (#464). Only the rows this pass wrote are bound: a link in a note whose file has not
 * changed keeps its binding.
 */
function bindPendingLinks(db: Database.Database, stmts: Statements, links: PendingLink[]): void {
  if (links.length === 0) return;
  const lookup = new ResolutionLookup(db);
  // A row already holding the answer is left alone (a moved note's refresh can bind a
  // pending row on the way, `refreshOnRename`).
  const bind = db.prepare(
    'UPDATE relationships SET resolved_target_id = @target WHERE id = @id AND resolved_target_id IS NOT @target',
  );
  const searchRowsToRewrite = new Set<string>();
  for (const link of links) {
    const target = lookup.resolve(link.target);
    bind.run({ id: link.id, target: target?.id ?? null });
    // The note's search row was written with the link unbound, which names it by its
    // raw target; a bound link is named by its target's title (`buildFtsRow`).
    if (target?.title?.trim() && target.title !== link.target) searchRowsToRewrite.add(link.sourceId);
  }
  for (const nodeId of searchRowsToRewrite) {
    const { rowid } = stmts.getNodeRowid.get(nodeId) as { rowid: number };
    stmts.deleteFts.run(rowid);
    stmts.insertFts.run({ rowid, ...buildFtsRow(db, nodeId) });
  }
}

// ── Walk directory ─────────────────────────────────────────────────

function walkDir(dir: string, vaultPath: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // Unreadable directory — skip
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(join(current, entry.name));
      } else if (entry.isFile()) {
        const absPath = join(current, entry.name);
        const relPath = relative(vaultPath, absPath);
        if (!shouldIgnore(relPath)) {
          results.push(relPath);
        }
      }
    }
  }

  walk(dir);
  return results;
}

// ── Public API ─────────────────────────────────────────────────────

export interface IndexStats {
  indexed: number;
  skipped: number;
  deleted: number;
  renamed: number;
  errors: number;
}

export interface IndexerOptions {
  onNodeIndexed?: (nodeId: string) => void;
  onNodeDeleted?: (nodeId: string) => void;
  /** `fullIndex` only: after each batch, the notes checked so far and the notes found. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * A progress line for a long startup index, at most once per `intervalMs`, so someone
 * following the log (the installer, while it waits for Engine to answer) sees it move.
 * An index shorter than one interval logs nothing.
 */
export function indexProgressLog(
  log: (line: string) => void = console.log,
  intervalMs = 5_000,
  now: () => number = Date.now,
): (done: number, total: number) => void {
  let last = now();
  return (done, total) => {
    if (done >= total || now() - last < intervalMs) return;
    last = now();
    log(`Indexing: ${done} of ${total} notes`);
  };
}

type FullIndexFileResult =
  | { outcome: 'skipped' }
  | { outcome: 'indexed'; nodeId: string; renamed: boolean };

/**
 * Full vault index: walk all files, detect deletions, batch-index changes.
 */
export function fullIndex(vaultPath: string, db: Database.Database, options?: IndexerOptions): IndexStats {
  const stmts = prepareStatements(db);
  const stats: IndexStats = { indexed: 0, skipped: 0, deleted: 0, renamed: 0, errors: 0 };
  const lockManager = new WriteLockManager();

  // 1. Walk vault
  const diskFiles = new Set(walkDir(vaultPath, vaultPath));

  // 2. Detect deletions — but first pair missing nodes with brand-new disk
  // paths by content hash: a file renamed while the engine was down must keep
  // its node id (board links, card-spec filters, and incoming edges are keyed
  // on it), not be deleted and re-created.
  const dbNodes = stmts.allFilePaths.all() as MissingNode[];
  const dbPaths = new Set(dbNodes.map(n => n.file_path));
  const missing = dbNodes.filter(n => !diskFiles.has(n.file_path));

  const renamedByPath = missing.length > 0
    ? pairRenames(missing, collectNewPathHashes(vaultPath, diskFiles, dbPaths))
    : new Map<string, MissingNode>();
  const renamedNodeIds = new Set([...renamedByPath.values()].map(n => n.id));

  const deleteTransaction = db.transaction(() => {
    for (const node of missing) {
      if (renamedNodeIds.has(node.id)) continue;
      executeDeletion(db, lockManager, vaultPath, {
        source: 'fullIndex',
        node_id: node.id,
        file_path: node.file_path,
        unlink_file: false,
      }, undefined, { deferTypedReferences: true });
      options?.onNodeDeleted?.(node.id);
      stats.deleted++;
    }
  });
  deleteTransaction();

  // 3. Index files in batches. Body links and untyped references are stored unbound and
  // bound after the last file (#507).
  const files = Array.from(diskFiles);
  const pendingLinks: PendingLink[] = [];
  // Schemas and fields do not change while the index runs: each set of note types reads
  // its claims and their fields once, as the watcher reads them for a note (#510).
  const schemas = new Map<string, SchemaContext>();
  const schemaFor = (types: string[]): SchemaContext => {
    const key = JSON.stringify(types);
    let context = schemas.get(key);
    if (context === undefined) {
      context = loadSchemaContext(db, types);
      schemas.set(key, context);
    }
    return context;
  };
  // Called inside each outer batch transaction. better-sqlite3 implements the
  // nested transaction as a savepoint, so a caught per-file failure rolls back
  // only that file while retaining the batch commit and continue-on-error flow.
  const fileTransaction = db.transaction((relPath: string, fileLinks: PendingLink[]): FullIndexFileResult => {
    const absPath = join(vaultPath, relPath);
    const st = statSync(absPath);
    const mtime = Math.floor(st.mtimeMs);

    // Check existing node
    const existing = stmts.getNodeByPath.get(relPath) as
      | { id: string; content_hash: string; file_mtime: number }
      | undefined;

    // Mtime-first change detection
    if (existing && existing.file_mtime === mtime) {
      return { outcome: 'skipped' };
    }

    // Mtime changed — read and hash
    const raw = readFileSync(absPath, 'utf-8');
    const hash = sha256(raw);

    if (existing && existing.content_hash === hash) {
      // Content unchanged — just update mtime
      stmts.updateMtime.run(mtime, existing.id);
      return { outcome: 'skipped' };
    }

    // Full re-index. A path paired as the target of a rename reuses the
    // missing node's id so doIndex updates it in place.
    const renamed = existing ? undefined : renamedByPath.get(relPath);
    const nodeId = doIndex(
      db,
      stmts,
      raw,
      relPath,
      absPath,
      mtime,
      hash,
      existing?.id ?? renamed?.id ?? null,
      { source: 'fullIndex', deferTypedReferences: true, pendingLinks: fileLinks, schemaFor },
    );
    if (renamed) {
      // Inbound edges resolved to this node may no longer match its new
      // title — re-resolve them, as the pre-fix delete + backfill did.
      refreshOnRename(db, nodeId, undefined, { deferTypedReferences: true });
      stmts.insertEditLog.run(
        nodeId,
        Date.now(),
        'file-renamed',
        JSON.stringify({ from: renamed.file_path, to: relPath, source: 'fullIndex' }),
      );
    }
    return { outcome: 'indexed', nodeId, renamed: renamed !== undefined };
  });
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const batchTransaction = db.transaction(() => {
      for (const relPath of batch) {
        const fileLinks: PendingLink[] = [];
        try {
          const result = fileTransaction(relPath, fileLinks);
          // Taken once the file's savepoint is released: a file whose index fails
          // leaves no rows to bind.
          for (const link of fileLinks) pendingLinks.push(link);
          if (result.outcome === 'skipped') {
            stats.skipped++;
            continue;
          }
          if (result.renamed) {
            stats.renamed++;
          }
          options?.onNodeIndexed?.(result.nodeId);
          stats.indexed++;
        } catch (err) {
          // Log error but don't block batch
          const msg = err instanceof Error ? err.message : String(err);
          stmts.insertEditLog.run(null, Date.now(), 'index-error', `${relPath}: ${msg}`);
          stats.errors++;
        }
      }
    });
    batchTransaction();
    options?.onProgress?.(i + batch.length, files.length);
  }

  // Bind the links this pass read, now that every note is read (#507). Own the
  // complete-index consistency boundary, including unchanged/offline nodes. A
  // failed binding or reconciliation throws; never return a successful stale graph.
  db.transaction(() => {
    bindPendingLinks(db, stmts, pendingLinks);
    reconcileTypedReferences(db);
  })();

  // One bounded diagnostic record for the completed index, never one per file.
  logReferenceDiagnostics(collectStoredReferenceDiagnostics(db), 'indexer');
  return stats;
}

/**
 * Index a single file (for watcher-driven updates).
 * Always re-reads, hashes, and re-indexes — no mtime check.
 */
export function indexFile(absolutePath: string, vaultPath: string, db: Database.Database, options?: IndexerOptions): string {
  const stmts = prepareStatements(db);
  const relPath = relative(vaultPath, absolutePath);
  const raw = readFileSync(absolutePath, 'utf-8');
  const hash = sha256(raw);
  const st = statSync(absolutePath);
  const mtime = Math.floor(st.mtimeMs);

  const existing = stmts.getNodeByPath.get(relPath) as { id: string } | undefined;

  const inbound: ReferenceDiagnostic[] = [];
  const txn = db.transaction(() => {
    return doIndex(db, stmts, raw, relPath, absolutePath, mtime, hash, existing?.id ?? null,
      { source: 'indexFile', deferTypedReferences: false, inbound });
  });

  const nodeId = txn();
  logReferenceDiagnostics([...collectStoredReferenceDiagnostics(db, nodeId),
    ...recheckInboundDiagnostics(db, inbound, new Set([nodeId]))], 'indexer');
  options?.onNodeIndexed?.(nodeId);
  return nodeId;
}
