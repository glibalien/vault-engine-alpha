import { unlinkSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type Database from 'better-sqlite3';
import { normalizeBody } from '../duplicates/text.js';
import { readExplicitNullFields } from '../fields/explicit-null.js';
import { readReferencePolicyVersion } from '../db/reference-policy-version.js';
import { createFieldMap } from '../fields/field-map.js';
import { isUnrenderedField } from '../fields/unrendered.js';
import { sha256 } from '../indexer/hash.js';
import { rewrittenRawFieldText } from '../mcp/tools/rename-node.js';
import { userNotesWhere } from '../notes/user-notes.js';
import { cleanFieldValue } from '../parser/frontmatter.js';
import { titleFromFilename } from '../parser/parse.js';
import { holdsMap, relinkedRawText } from '../parser/raw-field-texts.js';
import { rewriteBodyWikiLinksWith } from '../parser/wiki-links.js';
import { reconstructValue } from '../pipeline/classify-value.js';
import { executeDeletion } from '../pipeline/delete.js';
import type { ReferenceDiagnostic } from '../pipeline/diagnostics.js';
import { ContentHashMismatchError, executeMutation } from '../pipeline/execute.js';
import { readFileIfExists } from '../pipeline/file-writer.js';
import { keptFileFields, readFileFields } from '../pipeline/kept-file-fields.js';
import { safeVaultPath } from '../pipeline/safe-path.js';
import { loadSchemaContext } from '../pipeline/schema-context.js';
import { catalogIdentity, sameCatalogIdentity, shareCatalogs, type SharedCatalogs } from '../pipeline/shared-catalogs.js';
import { PipelineError } from '../pipeline/types.js';
import { anchorNamingKeys, candidateKeysForNode } from '../resolver/candidate-keys.js';
import { linkKey } from '../resolver/near-miss.js';
import { refreshOnCreate } from '../resolver/refresh.js';
import { captureLinkBindings } from '../undo/link-bindings.js';
import { captureMemorySubjects } from '../undo/memory-subjects.js';
import { resolveTarget, resolveWholeTarget } from '../resolver/resolve.js';
import { getVaultSettings } from '../settings/vault.js';
import type { SyncLogger } from '../sync/sync-logger.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import { validateProposedState } from '../validation/validate.js';
import { bindNameMatches, moveSubjects } from '../memories/subjects.js';

/**
 * Merging notes (#645): one note is kept and one or more others are folded into it and removed.
 * Two notes for the same person, or a copy `find-duplicate-nodes` found, become one note that
 * every link points at, in one undo.
 *
 * The owner's decisions (2026-11-18):
 *
 * - **The kept note wins a field both hold.** A field only a merged note holds is carried over,
 *   lists are combined, and a conflict is shown with both values; `set_fields` overrides.
 * - **A merged note's title becomes an alias of the kept note** unless the caller turns that off.
 * - **Several notes into one per call,** as one undo.
 *
 * What a merge does, in one transaction:
 *
 * 1. Rows that point at a merged note by id (memories, board and conversation links, a
 *    transcript's note) are pointed at the kept note. Deleting a note expires its memories;
 *    a merged note's text lives on, so its memories do too.
 * 2. The merged notes are deleted from the database. Their files are removed after the commit,
 *    so a failed merge leaves them in place.
 * 3. The kept note is written once, with the folded fields, types and body, and with every
 *    link to a merged note (its own, and those in the text it took over) naming itself.
 * 4. Every other note that linked to a merged note is written once, with those links naming
 *    the kept note. Links are found by their stored binding, never by matching text.
 *
 * `planMerge` reads and decides; `runMerge` writes. A dry run runs the same writes against the
 * database only and rolls them back, so it reports what the real run would refuse.
 */

export const MERGE_LIMITS = {
  /** Notes folded into the kept one per call. */
  maxMerged: 10,
  /** Rewritten notes named in the result. */
  shownNotes: 20,
} as const;

/** The heading a merged note's text goes under in the kept note. */
export const MERGED_HEADING = 'Merged from';

export class MergeError extends Error {
  override readonly name = 'MergeError';
  constructor(readonly code: 'INVALID_PARAMS' | 'NOT_FOUND', message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export interface MergeRequest {
  /** Id of the note to keep. */
  keep: string;
  /** Ids of the notes folded into it and removed. */
  merge: string[];
  /** Field values for the merged note: the answer to a conflict, or any other change. null removes a field. */
  set_fields?: Record<string, unknown>;
  /** The merged note's text, in place of the notes' texts joined. */
  body?: string;
  /** false: do not keep the merged notes' titles as aliases of the kept note. */
  keep_titles_as_aliases?: boolean;
}

/** A field as stored: its value, and the text an unclaimed field with links is written from. */
interface Held { value: unknown; raw: string | null }

interface NoteState {
  id: string;
  file_path: string;
  title: string;
  body: string;
  content_hash: string | null;
  types: string[];
  fields: Map<string, Held>;
}

interface NoteWrite {
  note: NoteState;
  types: string[];
  fields: Record<string, unknown>;
  rawFieldTexts: Record<string, string>;
  touched: string[];
  body: string;
}

export interface MergeNoteRef { id: string; title: string; path: string }

export interface MergeFieldConflict {
  field: string;
  /** The kept note's value. */
  kept: unknown;
  /** The merged notes' differing values. */
  others: Array<{ note: string; value: unknown }>;
  /** kept: the kept note's value stays. set_fields: the caller's value replaces both. */
  resolved_by: 'kept' | 'set_fields';
}

export interface MergeReport {
  kept: MergeNoteRef;
  merged: MergeNoteRef[];
  fields: {
    /** Fields only a merged note held, now on the kept note. */
    carried: Array<{ field: string; from: string }>;
    /** List fields both held: the merged note's items the kept note lacked were added. */
    combined: Array<{ field: string; from: string; added: number }>;
    /** Fields both held with different values. */
    conflicts: MergeFieldConflict[];
    /** Fields the caller set. */
    set: string[];
  };
  types_added: string[];
  aliases_added: string[];
  body: {
    /** The merged note's text was supplied by the caller. */
    supplied: boolean;
    /** Merged notes whose text was added under a heading. */
    joined: string[];
    /** Merged notes whose text the merged note already holds, and merged notes with no text. */
    same_text: string[];
    empty: string[];
  };
  links: {
    /** Other notes whose links to a merged note now name the kept note. */
    notes: number;
    examples: MergeNoteRef[];
    /** How the kept note is named in those links: its title, or its vault path when another note shares the title. */
    written_as: string;
    /**
     * Fields that link to a merged note and were not rewritten, because their note's file holds
     * text there that the Engine did not take. The stored link is left naming the merged note.
     */
    fields_left_alone: Array<{ id: string; path: string; field: string }>;
  };
  /** Rows that pointed at a merged note by id and now point at the kept note. Undo does not move them back. */
  moved: { memories: number; board_links: number; conversation_links: number; transcripts: number };
}

export interface MergePlan {
  kept: NoteState;
  merged: NoteState[];
  /** The kept note's one write; null when the merge changes nothing in it. */
  keptWrite: NoteWrite | null;
  sourceWrites: NoteWrite[];
  report: MergeReport;
}

/** The board, conversation and transcript tables come from their own migrations: a database without the feature has none. */
const hasTable = (db: Database.Database, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
const holdsNothing = (value: unknown): boolean =>
  value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const refOf = (note: NoteState): MergeNoteRef => ({ id: note.id, title: note.title, path: note.file_path });

function readNote(db: Database.Database, id: string): NoteState | null {
  const row = db.prepare('SELECT id, file_path, title, body, content_hash FROM nodes WHERE id = ?').get(id) as
    | { id: string; file_path: string; title: string | null; body: string | null; content_hash: string | null } | undefined;
  if (!row) return null;
  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order, schema_type').all(id) as Array<{ schema_type: string }>)
    .map(type => type.schema_type);
  const fields = new Map<string, Held>();
  const rows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ? ORDER BY field_name').all(id) as Array<{
    field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null; value_raw_text: string | null;
  }>;
  for (const field of rows) fields.set(field.field_name, { value: reconstructValue(field), raw: field.value_raw_text });
  return { id: row.id, file_path: row.file_path, title: row.title ?? titleFromFilename(row.file_path), body: row.body ?? '', content_hash: row.content_hash, types, fields };
}

/** A list field's items as its raw text holds them, when the raw text is a list of the same length. */
function rawItems(held: Held): unknown[] | null {
  if (held.raw === null || !Array.isArray(held.value)) return null;
  try {
    const parsed: unknown = JSON.parse(held.raw);
    return Array.isArray(parsed) && parsed.length === held.value.length ? parsed : null;
  } catch {
    return null;
  }
}

/** A list with another value's items added: those it does not hold yet, in their order. */
function combined(kept: Held, other: Held): { held: Held; added: number } {
  const base = kept.value as unknown[];
  const incoming = Array.isArray(other.value) ? other.value : [other.value];
  const incomingRaw = Array.isArray(other.value) ? rawItems(other) : other.raw === null ? null : [other.raw];
  const seen = new Set(base.map(item => JSON.stringify(item)));
  const added: unknown[] = [];
  const addedRaw: unknown[] = [];
  incoming.forEach((item, index) => {
    const key = JSON.stringify(item);
    if (item === null || item === undefined || seen.has(key)) return;
    seen.add(key);
    added.push(item);
    addedRaw.push(incomingRaw?.[index] ?? item);
  });
  if (added.length === 0) return { held: kept, added: 0 };
  const baseRaw = rawItems(kept);
  const raw = baseRaw === null && incomingRaw === null ? null : JSON.stringify([...(baseRaw ?? base), ...addedRaw]);
  return { held: { value: [...base, ...added], raw }, added: added.length };
}

/**
 * A list without the repeats a repointing made: two names for one note become the same name
 * once both name the kept note, and the later one goes. An item the list already held twice
 * stays twice: that is how the note was written.
 */
function withoutNewRepeats(before: Held, after: Held): Held {
  if (!Array.isArray(after.value) || !Array.isArray(before.value) || before.value.length !== after.value.length) return after;
  const raw = rawItems(after);
  const first = new Map<string, number>();
  const keep: number[] = [];
  const changed = (index: number): boolean => !same((before.value as unknown[])[index], (after.value as unknown[])[index]);
  after.value.forEach((item, index) => {
    const key = JSON.stringify(item);
    const earlier = first.get(key);
    if (earlier !== undefined && (changed(index) || changed(earlier))) return;
    if (earlier === undefined) first.set(key, index);
    keep.push(index);
  });
  if (keep.length === after.value.length) return after;
  return { value: keep.map(index => (after.value as unknown[])[index]), raw: raw === null ? after.raw : JSON.stringify(keep.map(index => raw[index])) };
}

/** Raw text for a value a write changes, where the stored field had raw text: without it the write would render the old text. */
function plainRaw(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? JSON.stringify(value) : null;
}

/**
 * How the kept note is named in a link once the merged notes are gone: its file's name, or its
 * vault path when another remaining note also answers to that name.
 */
function keptLinkName(db: Database.Database, kept: NoteState, mergedIds: ReadonlySet<string>): string {
  const fold = (text: string): string => text.normalize('NFC').trim().toLowerCase();
  const name = basename(kept.file_path, '.md');
  const key = fold(name);
  const others = db.prepare('SELECT id, file_path, title FROM nodes').iterate() as IterableIterator<{ id: string; file_path: string; title: string | null }>;
  for (const other of others) {
    if (other.id === kept.id || mergedIds.has(other.id)) continue;
    if (fold(basename(other.file_path, '.md')) === key || (other.title !== null && fold(other.title) === key)) return kept.file_path;
  }
  return name;
}

function toWrite(note: NoteState, types: string[], fields: Map<string, Held>, changed: ReadonlySet<string>, body: string): NoteWrite {
  const values = createFieldMap<unknown>();
  const rawFieldTexts = createFieldMap<string>();
  for (const [field, held] of fields) {
    values[field] = held.value;
    if (!changed.has(field)) continue;
    // A changed field is written from its raw text when it has one; a stored raw text it no longer matches must be replaced.
    const raw = held.raw ?? (note.fields.get(field)?.raw != null ? plainRaw(held.value) : null);
    if (raw !== null) rawFieldTexts[field] = raw;
  }
  return { note, types, fields: values, rawFieldTexts, touched: [...changed], body };
}

/** The `rel_type` of a link in a note's text. A field can carry the same name. */
const BODY_LINK = 'wiki-link';

/** Where a note's links to merged notes are, and what each becomes: its own, found by their stored binding. */
interface OwnLinks { body: Map<string, string>; fields: Map<string, Map<string, string>> }

const FIELD_LINK = /\[\[([^\]|]+)(\|[^\]]+)?\]\]/g;

/**
 * A field rewritten through the text it is written from. An unclaimed field keeps its raw
 * text, links and all, and its value is that text with the brackets stripped: so a link inside
 * longer text (`Ask [[Dana W]]`, value "Ask Dana W") is no item of the value, and only the raw
 * text shows it. Each link naming a merged note is rewritten there, and the value read again
 * from the result. Null when the raw text does not describe the value, or holds no such link.
 */
/** A text with each `[[link]]` that names a merged note rewritten, its display text kept. */
function rewriteFieldLinks(text: string, targets: ReadonlyMap<string, string>): string {
  return text.replace(FIELD_LINK, (link, target: string, alias: string | undefined) =>
    (targets.has(target) ? `[[${targets.get(target)}${alias ?? ''}]]` : link));
}

function repointThroughRaw(held: Held, targets: ReadonlyMap<string, string>): Held | null {
  if (held.raw === null) return null;
  // A link inside a map is no item of the value (#670): the raw text is rewritten at any
  // depth, and the value read again from it.
  if (holdsMap(held.value)) return relinkedRawText(held.raw, held.value, targets);
  const rewrite = (text: string): string => rewriteFieldLinks(text, targets);
  if (Array.isArray(held.value)) {
    const items = rawItems(held);
    if (items === null) return null;
    const value = [...held.value];
    const raw = [...items];
    let changed = false;
    items.forEach((item, index) => {
      if (typeof item !== 'string' || cleanFieldValue(item) !== value[index]) return;
      const rewritten = rewrite(item);
      if (rewritten === item) return;
      raw[index] = rewritten;
      value[index] = cleanFieldValue(rewritten);
      changed = true;
    });
    return changed ? { value, raw: JSON.stringify(raw) } : null;
  }
  if (typeof held.value !== 'string' || cleanFieldValue(held.raw) !== held.value) return null;
  const rewritten = rewrite(held.raw);
  return rewritten === held.raw ? null : { value: cleanFieldValue(rewritten), raw: rewritten };
}

/** Raw text with the links in it rewritten: one text, or a list of them. */
function rewriteRawLinks(raw: string, targets: ReadonlyMap<string, string>): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return JSON.stringify(parsed.map(item => (typeof item === 'string' ? rewriteFieldLinks(item, targets) : item)));
  } catch {
    // One text, not a list.
  }
  return rewriteFieldLinks(raw, targets);
}

/**
 * A note's field values with its own links to merged notes repointed. Returns the fields it
 * changed. `isReference` says which fields are defined as references: there a value with no
 * brackets is the link itself. In any other field only what is written as a link is one, and
 * the same words beside it (`['Dana W', 'Ask [[Dana W]]']`) are plain text.
 */
function repointFields(held: Map<string, Held>, own: OwnLinks | undefined, isReference: (field: string) => boolean): string[] {
  const changed: string[] = [];
  for (const [field, targets] of own?.fields ?? []) {
    const current = held.get(field);
    if (!current || holdsNothing(current.value)) continue;
    let next = repointThroughRaw(current, targets);
    // A map's links are rewritten only through a raw text that reads as its value: matching
    // links in the map's JSON would change the raw text and leave the value as it was.
    if (next === null && current.raw !== null && holdsMap(current.value)) continue;
    if (next === null) {
      // No raw text, or raw text that no longer describes the value. A reference field's
      // value, or each item of it, is the link's target. A value written through a tool can
      // also carry its brackets itself (`Ask [[Dana W]]`): those links are rewritten where
      // they stand, in the value and in whatever raw text there is.
      const reference = isReference(field);
      const replace = (item: unknown): unknown => {
        if (typeof item !== 'string') return item;
        return (reference ? targets.get(item) : undefined) ?? (item.includes('[[') ? rewriteFieldLinks(item, targets) : item);
      };
      const value = Array.isArray(current.value) ? current.value.map(replace) : replace(current.value);
      const raw = current.raw === null ? null
        : reference ? rewrittenRawFieldText(current.raw, current.value, targets) : rewriteRawLinks(current.raw, targets);
      if (same(value, current.value) && raw === current.raw) continue;
      next = { value, raw };
    }
    held.set(field, withoutNewRepeats(current, next));
    changed.push(field);
  }
  return changed;
}

/**
 * Text a merged note's file holds for a field that the database does not: a value the watcher
 * refused stays in the file as typed and is stored nowhere (#501). Removing the note would lose
 * it, and no undo could bring it back, so such a note is not merged until the text is dealt with.
 */
function fileOnlyFields(db: Database.Database, vaultPath: string, note: NoteState): Map<string, unknown> {
  const fileFields = readFileFields(readFileIfExists(safeVaultPath(vaultPath, note.file_path)));
  if (fileFields.length === 0) return new Map();
  const stored = createFieldMap<unknown>();
  for (const [field, held] of note.fields) stored[field] = held.value;
  const context = loadSchemaContext(db, note.types);
  const effectiveFields = validateProposedState(stored, note.types, context.claimsByType, context.globalFields, { skipDefaults: true }).effective_fields;
  const kept = keptFileFields(fileFields, {
    stored, touched: [], explicitNull: readExplicitNullFields(db, note.id), effectiveFields, keepUnstored: true,
  });
  return new Map([...kept].map(([field, inFile]) => [field, inFile.value]));
}

/**
 * Decide the merge without writing anything: the kept note's new fields, types and text, and
 * every other note's rewritten links.
 */
export function planMerge(db: Database.Database, vaultPath: string, request: MergeRequest, settingsDir: string | undefined): MergePlan {
  const ids = [...new Set(request.merge)];
  if (ids.length !== request.merge.length) throw new MergeError('INVALID_PARAMS', 'merge: a note is listed twice.');
  if (ids.includes(request.keep)) throw new MergeError('INVALID_PARAMS', 'merge: the note to keep cannot also be merged into itself.');
  if (ids.length === 0 || ids.length > MERGE_LIMITS.maxMerged) {
    throw new MergeError('INVALID_PARAMS', `merge: between 1 and ${MERGE_LIMITS.maxMerged} notes.`);
  }
  const user = userNotesWhere({ vault: getVaultSettings(db), settingsDir });
  const isUserNote = db.prepare<string[], { found: number }>(`SELECT 1 AS found FROM nodes n WHERE n.id = ? AND ${user.sql}`);
  const load = (id: string, role: string): NoteState => {
    const note = readNote(db, id);
    if (!note) throw new MergeError('NOT_FOUND', `${role}: no note has the id "${id}".`, { node_id: id });
    if (isUserNote.get(id, ...user.params) === undefined) {
      throw new MergeError('INVALID_PARAMS', `${role}: "${note.file_path}" is one of the suite's own notes (a wiki page, a settings note, the memory note or the journal) and cannot be merged.`, { node_id: id });
    }
    return note;
  };
  const kept = load(request.keep, 'keep');
  const merged = ids.map(id => load(id, 'merge'));
  const mergedIds = new Set(ids);
  for (const note of merged) {
    const fileOnly = [...fileOnlyFields(db, vaultPath, note).keys()];
    if (fileOnly.length > 0) {
      throw new MergeError('INVALID_PARAMS',
        `merge: "${note.file_path}" holds text in ${fileOnly.map(field => `"${field}"`).join(', ')} that the Engine did not take, because it fails the field's rules, and that is kept only in the file. Removing the note would lose it: correct or clear ${fileOnly.length === 1 ? 'that value' : 'those values'} first.`,
        { node_file_path: note.file_path, fields: fileOnly });
    }
  }

  // ── Links: every link bound to a merged note names the kept note. Read before anything changes.
  const keptName = keptLinkName(db, kept, mergedIds);
  const keysOf = new Map(merged.map(note => [note.id, candidateKeysForNode({ file_path: note.file_path, title: note.title })]));
  const edges = db.prepare(
    `SELECT source_id AS source, target, rel_type AS rel, context, resolved_target_id AS bound FROM relationships
     WHERE resolved_target_id IN (${ids.map(() => '?').join(', ')})`,
  ).all(...ids) as Array<{ source: string; target: string; rel: string; context: string | null; bound: string }>;
  // A link in a note's text reads the same wherever it is written, so one map serves every text.
  // A field value is a link only where that note's own field holds one: the same words in
  // another note's field may be plain text, and are left alone.
  const bodyTargets = new Map<string, string>();
  const ownLinks = new Map<string, OwnLinks>();
  const anchored = new Map<string, string>();
  const withAnchor = (anchor: string): string => {
    if (anchor === '') return keptName;
    let text = anchored.get(anchor);
    if (text === undefined) {
      // A link is read whole before it is read as a note and a heading, so `Alpha#Goals` names
      // a note of that very name where there is one. The kept note's path with `.md` names
      // only the kept note (as a rename and link repair write it, #613).
      const whole = resolveWholeTarget(db, keptName + anchor);
      text = whole !== null && whole.id !== kept.id && !mergedIds.has(whole.id) ? kept.file_path + anchor : keptName + anchor;
      anchored.set(anchor, text);
    }
    return text;
  };
  for (const edge of edges) {
    // A link to a heading or block in the merged note keeps its anchor: the text it points into moves with the note.
    const replacement = withAnchor(anchorNamingKeys(edge.target, keysOf.get(edge.bound)!));
    let own = ownLinks.get(edge.source);
    if (!own) ownLinks.set(edge.source, own = { body: new Map(), fields: new Map() });
    // A link in a note's text is stored under `wiki-link`. So is a link in a field of that very
    // name, and its row is told apart by its context: the field's name, where a text link
    // carries its paragraph. When a note has both, the field's row stands for the two.
    const inField = edge.rel !== BODY_LINK || edge.context === BODY_LINK;
    // The same words can name another note in a note's text than in a typed field. A field's
    // row says nothing of the text, so the text is asked: a link written this way there is
    // rewritten only if it would bind to the merged note too.
    const inText = edge.rel === BODY_LINK && (!inField || resolveTarget(db, edge.target)?.id === edge.bound);
    if (inText) {
      bodyTargets.set(edge.target, replacement);
      own.body.set(edge.target, replacement);
    }
    if (inField) {
      let targets = own.fields.get(edge.rel);
      if (!targets) own.fields.set(edge.rel, targets = new Map());
      targets.set(edge.target, replacement);
    }
  }
  // Which fields hold a link as a bare value, for a note of given kinds, as the pipeline decides
  // it: a field defined as a reference, and under the older reference policy only where one of
  // the note's kinds claims it. Anywhere else the field is the note's own text.
  const references = new Set((db.prepare(
    "SELECT name FROM global_fields WHERE field_type = 'reference' OR (field_type = 'list' AND list_item_type = 'reference')",
  ).all() as Array<{ name: string }>).map(row => row.name));
  const everyNote = readReferencePolicyVersion(db) === 2;
  const claimedBy = new Map<string, ReadonlyMap<string, unknown>>();
  const referencesOf = (noteTypes: readonly string[]) => (field: string): boolean => {
    if (!references.has(field)) return false;
    if (everyNote) return true;
    const key = JSON.stringify(noteTypes);
    let claimed = claimedBy.get(key);
    if (!claimed) claimedBy.set(key, claimed = loadSchemaContext(db, [...noteTypes]).globalFields);
    return claimed.has(field);
  };
  const repointBody = (text: string): string => {
    if (bodyTargets.size === 0 || text === '') return text;
    return rewriteBodyWikiLinksWith(text, ({ target, written, embed, inTableCell }) => {
      const replacement = bodyTargets.get(target);
      if (replacement === undefined) return null;
      const bar = inTableCell ? '\\|' : '|';
      if (embed) {
        // An embed with any extension but `.md` is read as an attachment, so a dotted note
        // name (`Report.v2`) keeps its `.md`, as link repair writes it. An embed's second half
        // is a size or caption, never display text.
        const hash = replacement.indexOf('#');
        const name = hash < 0 ? replacement : replacement.slice(0, hash);
        const ref = (extname(name) !== '' && !name.endsWith('.md') ? `${name}.md` : name) + (hash < 0 ? '' : replacement.slice(hash));
        return written.alias === null ? `[[${ref}]]` : `[[${ref}${bar}${written.alias}]]`;
      }
      if (written.alias !== null) return `[[${replacement}${bar}${written.alias}]]`;
      // A link written as a path reads as the path: show the note's name in its place.
      return replacement.startsWith(kept.file_path) ? `[[${replacement}${bar}${kept.title}]]` : `[[${replacement}]]`;
    });
  };

  // ── Fields: the kept note wins, lists are combined, what only a merged note holds is carried.
  // Each note's own links are repointed first, so two names for one note compare as the same value.
  const fields = new Map(kept.fields);
  // Text the kept note's file holds that the database does not (a value the watcher refused,
  // #501) is the kept note's value all the same, whether the database holds nothing for the
  // field or the value from before the refused edit. Writing the field would replace typed text
  // that no undo could put back, so such a field is left alone: its own links are not
  // repointed, nothing is carried into it or combined with it, and a merged note's different
  // value shows as a conflict the kept note wins. Only `set_fields` writes it.
  const fileHeld = fileOnlyFields(db, vaultPath, kept);
  const ownKept = ownLinks.get(kept.id);
  const changed = new Set<string>(repointFields(fields, ownKept === undefined ? undefined
    : { body: ownKept.body, fields: new Map([...ownKept.fields].filter(([field]) => !fileHeld.has(field))) }, referencesOf(kept.types)));
  const carried: MergeReport['fields']['carried'] = [];
  const combinedFields: MergeReport['fields']['combined'] = [];
  const conflicts = new Map<string, MergeFieldConflict>();
  for (const note of merged) {
    const theirs = new Map(note.fields);
    repointFields(theirs, ownLinks.get(note.id), referencesOf(note.types));
    for (const [field, held] of theirs) {
      if (isUnrenderedField(field) || holdsNothing(held.value)) continue;
      const mine = fields.get(field);
      if (fileHeld.has(field)) {
        if (same(fileHeld.get(field), held.value)) continue;
        const conflict = conflicts.get(field) ?? { field, kept: fileHeld.get(field), others: [], resolved_by: 'kept' as const };
        conflict.others.push({ note: note.id, value: held.value });
        conflicts.set(field, conflict);
      } else if (!mine || holdsNothing(mine.value)) {
        fields.set(field, held);
        changed.add(field);
        carried.push({ field, from: note.id });
      } else if (same(mine.value, held.value)) {
        continue;
      } else if (Array.isArray(mine.value)) {
        const next = combined(mine, held);
        if (next.added === 0) continue;
        fields.set(field, next.held);
        changed.add(field);
        combinedFields.push({ field, from: note.id, added: next.added });
      } else {
        const conflict = conflicts.get(field) ?? { field, kept: mine.value, others: [], resolved_by: 'kept' as const };
        conflict.others.push({ note: note.id, value: held.value });
        conflicts.set(field, conflict);
      }
    }
  }

  // ── Aliases: a merged note's title still finds the kept note.
  const aliasesAdded: string[] = [];
  if (request.keep_titles_as_aliases !== false) {
    const held = fields.get('aliases');
    const current: unknown[] = !held || holdsNothing(held.value) ? [] : Array.isArray(held.value) ? held.value : [held.value];
    const known = new Set([linkKey(kept.title), linkKey(basename(kept.file_path, '.md')), ...current.map(alias => linkKey(String(alias)))]);
    for (const note of merged) {
      const key = linkKey(note.title);
      if (key === '' || known.has(key)) continue;
      known.add(key);
      aliasesAdded.push(note.title);
    }
    // An aliases field holding text only the file has is left as it is, like any other such field.
    if (fileHeld.has('aliases')) aliasesAdded.length = 0;
    if (aliasesAdded.length > 0) {
      const base: Held = { value: current, raw: held && Array.isArray(held.value) ? held.raw : null };
      fields.set('aliases', combined(base, { value: aliasesAdded, raw: null }).held);
      changed.add('aliases');
    }
  }

  // ── Types: the merged note is every kind its notes were.
  const types = [...kept.types];
  const typesAdded: string[] = [];
  for (const note of merged) {
    for (const type of note.types) {
      if (types.includes(type)) continue;
      types.push(type);
      typesAdded.push(type);
    }
  }

  // ── Text: the kept note's, then each merged note's own text under a heading.
  const joined: string[] = [];
  const sameText: string[] = [];
  const empty: string[] = [];
  let body = kept.body;
  if (request.body !== undefined) {
    body = request.body;
  } else {
    // Texts are compared with line endings and trailing spaces set aside, as the duplicate finder
    // compares them. What is carried over is the text as written: two spaces at a line's end
    // are a line break in Markdown.
    const held = new Set([normalizeBody(kept.body)]);
    for (const note of merged) {
      const key = normalizeBody(note.body);
      if (key === '') { empty.push(note.id); continue; }
      if (held.has(key)) { sameText.push(note.id); continue; }
      held.add(key);
      joined.push(note.id);
      const text = note.body.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
      // An empty note takes the first text as its own; after that, each text says where it came from.
      body = normalizeBody(body) === '' ? text : `${body.replace(/\s+$/, '')}\n\n## ${MERGED_HEADING} ${note.title}\n\n${text}`;
    }
    if (joined.length > 0) body += '\n';
  }

  // ── The caller's values: the answer to a conflict, or any other change.
  const set = Object.keys(request.set_fields ?? {});
  for (const field of set) {
    const value = request.set_fields![field] ?? null;
    // An unclaimed field that holds a link is written from its raw text, and only text or a
    // list can replace that text here; any other value would be written and then lose to it.
    if (value !== null && plainRaw(value) === null && kept.fields.get(field)?.raw != null) {
      throw new MergeError('INVALID_PARAMS',
        `set_fields: "${field}" holds a link in the kept note, and a merge can replace it only with text or a list. Pass null to remove it here, then set it with update-node.`,
        { field });
    }
    fields.set(field, { value, raw: null });
    changed.add(field);
    const conflict = conflicts.get(field);
    if (conflict) conflict.resolved_by = 'set_fields';
  }
  // The caller's own list of aliases stands as given.
  if (set.includes('aliases')) aliasesAdded.length = 0;

  const keptBody = repointBody(body);
  // A kept note the merge leaves as it is (an exact copy folded into it) is not written at all.
  const keptWrite = changed.size > 0 || typesAdded.length > 0 || keptBody !== kept.body ? toWrite(kept, types, fields, changed, keptBody) : null;

  const sourceWrites: NoteWrite[] = [];
  const leftAlone: MergeReport['links']['fields_left_alone'] = [];
  for (const [id, own] of ownLinks) {
    if (id === kept.id || mergedIds.has(id)) continue;
    const source = readNote(db, id);
    if (!source) continue;
    const held = new Map(source.fields);
    // A linking note's field can hold text only its file has, too: the watcher refused an edit
    // and kept the stored link to the merged note. Rewriting the field would replace what was
    // typed, so it is left as it is and named in the result; the note's other links are rewritten.
    const linkedFields = [...own.fields.keys()].filter(field => source.fields.has(field));
    const fileOnly = linkedFields.length === 0 ? new Map<string, unknown>() : fileOnlyFields(db, vaultPath, source);
    const writable = new Map([...own.fields].filter(([field]) => !fileOnly.has(field)));
    for (const field of linkedFields) if (fileOnly.has(field)) leftAlone.push({ id, path: source.file_path, field });
    const rewritten = new Set(repointFields(held, { body: own.body, fields: writable }, referencesOf(source.types)));
    const text = own.body.size === 0 ? source.body : repointBody(source.body);
    // A link whose text already reads as the kept note's name needs no rewrite; `runMerge` binds it.
    if (rewritten.size === 0 && text === source.body) continue;
    sourceWrites.push(toWrite(source, source.types, held, rewritten, text));
  }
  sourceWrites.sort((a, b) => (a.note.file_path < b.note.file_path ? -1 : a.note.file_path > b.note.file_path ? 1 : 0));

  const placeholders = ids.map(() => '?').join(', ');
  const count = (sql: string, params: readonly string[] = ids): number => (db.prepare(sql).get(...params) as { count: number }).count;
  const countIn = (table: string, column: string): number =>
    hasTable(db, table) ? count(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IN (${placeholders})`) : 0;
  return {
    kept,
    merged,
    keptWrite,
    sourceWrites,
    report: {
      kept: refOf(kept),
      merged: merged.map(refOf),
      fields: { carried, combined: combinedFields, conflicts: [...conflicts.values()], set },
      types_added: typesAdded,
      aliases_added: aliasesAdded,
      body: { supplied: request.body !== undefined, joined, same_text: sameText, empty },
      links: {
        notes: sourceWrites.length,
        examples: sourceWrites.slice(0, MERGE_LIMITS.shownNotes).map(write => refOf(write.note)),
        written_as: keptName,
        fields_left_alone: leftAlone.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.field < b.field ? -1 : 1)),
      },
      moved: {
        memories: count(`SELECT COUNT(*) AS count FROM memories WHERE node_id IN (${placeholders}) OR evidence_node_id IN (${placeholders})`, [...ids, ...ids]),
        board_links: countIn('board_links', 'doc_node_id'),
        conversation_links: countIn('conversation_links', 'doc_node_id'),
        transcripts: countIn('attachment_transcripts', 'materialized_node_id'),
      },
    },
  };
}

/**
 * Refuse a merge while a file it would rewrite or remove holds text the Engine has not read,
 * or is missing: the merge works from the database, so that text would be lost. The watcher
 * reads an edit within seconds, and the caller tries again. Checked for the kept note, the
 * merged notes and every note whose links are rewritten, in a preview too.
 */
export function assertFilesAsIndexed(vaultPath: string, plan: MergePlan): void {
  for (const note of [plan.kept, ...plan.merged, ...plan.sourceWrites.map(write => write.note)]) {
    const content = readFileIfExists(safeVaultPath(vaultPath, note.file_path));
    // A file that is gone is a change the Engine has not read either. The kept note matters
    // most: an exact copy folded into it needs no write, so no write would notice, and the
    // merge would remove the last file left.
    if (content === null) throw new ContentHashMismatchError(note.id, note.content_hash ?? 'a file', null);
    if (note.content_hash === null) continue;
    const onDisk = sha256(content);
    if (onDisk !== note.content_hash) throw new ContentHashMismatchError(note.id, note.content_hash, onDisk);
  }
}

export interface MergeDeps {
  db: Database.Database;
  writeLock: WriteLockManager;
  vaultPath: string;
  syncLogger?: SyncLogger;
}

export interface MergeRun {
  /** Notes written: the kept note, when the merge changed it, and every note whose links were rewritten. */
  changedNodeIds: string[];
  /** Typed references the merge leaves unresolved. */
  referenceDiagnostics: ReferenceDiagnostic[];
}

class PreviewRollback extends Error {
  constructor(readonly run: MergeRun) {
    super('merge preview');
  }
}

/** Point rows that name a merged note by id at the kept note. Runs before the notes are deleted, which would expire their memories. */
function moveRows(db: Database.Database, keptId: string, mergedIds: readonly string[]): void {
  const links = ['board_links', 'conversation_links'].filter(table => hasTable(db, table));
  const transcripts = hasTable(db, 'attachment_transcripts');
  for (const id of mergedIds) {
    db.prepare('UPDATE memories SET node_id = ? WHERE node_id = ?').run(keptId, id);
    db.prepare('UPDATE memories SET evidence_node_id = ? WHERE evidence_node_id = ?').run(keptId, id);
    // A memory about a merged note is about the kept note now (#554).
    if (hasTable(db, 'memory_subjects')) moveSubjects(db, keptId, id);
    // A board or conversation linked to both notes keeps its one link to the kept note.
    for (const table of links) {
      db.prepare(`UPDATE OR IGNORE ${table} SET doc_node_id = ? WHERE doc_node_id = ?`).run(keptId, id);
      db.prepare(`DELETE FROM ${table} WHERE doc_node_id = ?`).run(id);
    }
    if (transcripts) db.prepare('UPDATE attachment_transcripts SET materialized_node_id = ? WHERE materialized_node_id = ?').run(keptId, id);
  }
}

/**
 * Apply a plan in one transaction. A dry run writes to the database only and rolls back.
 * A live run's file writes are queued on `fsRollback` for the caller to reverse if this throws.
 */
export function runMerge(
  deps: MergeDeps,
  plan: MergePlan,
  options: { dryRun: boolean; operationId?: string; fsRollback?: { push(undo: () => void): void } },
): MergeRun {
  const { db, writeLock, vaultPath } = deps;
  const { dryRun } = options;
  const undo = options.operationId === undefined ? undefined : { operation_id: options.operationId };
  const logger = dryRun ? undefined : deps.syncLogger;

  const transaction = db.transaction((): MergeRun => {
    // Where each link to a merged note is bound now, for an undo to bind it there again (#665).
    if (undo) captureLinkBindings(db, undo.operation_id, plan.merged.map(note => note.id));
    // Subjects that reach a merged note only by name are linked to it first, so they move with it (#554).
    bindNameMatches(db, plan.merged.map(note => note.id));
    // The memory subjects linked to the merged notes, for an undo to put back (#554).
    if (undo) captureMemorySubjects(db, undo.operation_id, plan.kept.id, plan.merged.map(note => note.id));
    moveRows(db, plan.kept.id, plan.merged.map(note => note.id));
    for (const note of plan.merged) {
      executeDeletion(db, writeLock, vaultPath, {
        source: 'tool', node_id: note.id, file_path: note.file_path, unlink_file: false, reason: `merged into ${plan.kept.id}`,
      }, undo, { suppressObservers: dryRun });
    }

    const diagnostics: ReferenceDiagnostic[] = [];
    const write = (change: NoteWrite, shared: SharedCatalogs | null): void => {
      try {
        const result = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id: change.note.id,
          file_path: change.note.file_path,
          title: change.note.title,
          types: change.types,
          fields: change.fields,
          touchedFields: change.touched,
          raw_field_texts: change.rawFieldTexts,
          body: change.body,
          ...(shared ? { linkCanonicalizer: shared.linkCanonicalizer, referenceCatalog: shared.referenceCatalog, targetLookup: shared.targetLookup } : {}),
          // The file is checked again as it is written: an edit since the check above is kept, and the merge refused.
          ...(dryRun ? { db_only: true } : change.note.content_hash === null ? {} : { expectedDiskContentHash: change.note.content_hash }),
        }, logger, undo, options.fsRollback);
        diagnostics.push(...result.referenceDiagnostics);
      } catch (error) {
        // Say which note's write was refused: a merge writes many.
        if (error instanceof PipelineError) (error as PipelineError & { node_file_path?: string }).node_file_path = change.note.file_path;
        throw error;
      }
    };

    if (plan.keptWrite) write(plan.keptWrite, null);
    // A link whose text already names the kept note (`[[Sam]]`, bound to a same-titled copy that
    // is now gone) is not rewritten, so no write binds it again. Bind every such link as a
    // newly created note binds the links waiting for it.
    //
    // An undo binds these back from the bindings recorded above (#665): its note restores
    // write nothing for a note the merge left unchanged, and a restored note takes only links
    // bound to nothing.
    diagnostics.push(...refreshOnCreate(db, plan.kept.id));
    // The rewrites change link targets only, so they share one set of catalogs, built after the
    // kept note has its final types and aliases (as a rename's rewrites do, #575). A note whose
    // write changes what it puts in the catalogs builds its own, and the next ones start a new set.
    let shared: SharedCatalogs | null = null;
    for (const change of plan.sourceWrites) {
      const before = catalogIdentity(db, change.note.id);
      const keepsName = before !== null && before.file_path === change.note.file_path && before.title === titleFromFilename(change.note.file_path);
      if (keepsName) shared ??= shareCatalogs(db);
      write(change, keepsName ? shared : null);
      if (!keepsName || !sameCatalogIdentity(before, catalogIdentity(db, change.note.id))) shared = null;
    }

    const run: MergeRun = {
      changedNodeIds: [...(plan.keptWrite ? [plan.kept.id] : []), ...plan.sourceWrites.map(change => change.note.id)],
      referenceDiagnostics: diagnostics,
    };
    if (dryRun) throw new PreviewRollback(run);
    return run;
  });

  try {
    return transaction();
  } catch (error) {
    if (error instanceof PreviewRollback) return error.run;
    throw error;
  }
}

export interface KeptFile {
  path: string;
  /**
   * changed: the file was saved while the merge ran, so its text is newer than what was merged.
   * kept_note_missing: the kept note's file is gone, so this file may be the only copy left.
   */
  why: 'changed' | 'kept_note_missing' | 'error';
  error?: string;
}

/**
 * Remove the merged notes' files, once the merge has committed. A file is read again first: one
 * saved since the merge began (by Obsidian, which no Engine lock holds back) holds text the
 * merge never saw, so it is left in place and reported. Returns the files that were kept.
 */
export function removeMergedFiles(deps: MergeDeps, plan: MergePlan): KeptFile[] {
  const kept: KeptFile[] = [];
  // The kept note's file was there when the merge began. If it has gone since, the merged
  // notes' files may be the only text left, and none is removed.
  if (readFileIfExists(safeVaultPath(deps.vaultPath, plan.kept.file_path)) === null) {
    return plan.merged.map(note => ({ path: note.file_path, why: 'kept_note_missing' as const }));
  }
  for (const note of plan.merged) {
    const absolute = safeVaultPath(deps.vaultPath, note.file_path);
    deps.writeLock.withLockSync(absolute, () => {
      try {
        const content = readFileIfExists(absolute);
        if (content === null) return;
        if (note.content_hash !== null && sha256(content) !== note.content_hash) {
          kept.push({ path: note.file_path, why: 'changed' });
          return;
        }
        unlinkSync(absolute);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') kept.push({ path: note.file_path, why: 'error', error: `${code ?? 'UNKNOWN'}: ${(error as Error).message}` });
      }
    });
  }
  return kept;
}
