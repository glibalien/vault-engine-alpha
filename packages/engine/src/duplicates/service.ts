import type Database from 'better-sqlite3';
import { LIKE_ESCAPE, literalPrefixPattern } from '../db/like-pattern.js';
import { readLinkCounts } from '../mcp/link-counts.js';
import { userNotesWhere } from '../notes/user-notes.js';
import { getVaultSettings } from '../settings/vault.js';
import { BANDS, TEXT_LIMITS, bandKey, bodyHash, normalizeBody, similarity, sketchOf, wordsOf, writeSignature, type TextSketch } from './text.js';

/**
 * Duplicate notes (#646): the notes whose text is the same as, or nearly the same as, another
 * note's, in groups. Read-only and stateless. What to do with a group stays with the caller.
 *
 * Only the user's own notes are compared (not the suite's notes, the settings folder or wiki
 * pages), and by default not transcripts or daily notes, which are alike by design. `text.ts`
 * says how two texts are compared.
 */

export const DUPLICATE_LIMITS = {
  /** Most notes one call reads; beyond it the first by id are read and the result says so. */
  maxNotes: 50_000,
  defaultGroups: 25,
  maxGroups: 100,
  /** Share of three-word runs two notes must have in common to be near duplicates. */
  defaultSimilarity: 0.7,
  /** Lowest a caller may set it. Below this, notes written from one template start to match. */
  minSimilarity: 0.5,
  /** A body shorter than this, in characters, is not called an exact copy: empty notes and one-line stubs are not duplicates. */
  minExactChars: 24,
  /** A note with fewer words is compared for an exact copy only: too little text to call two notes nearly the same. */
  minWords: 20,
  /** Notes that agree on a band are all compared with each other up to this many; a longer run is linked through its first note and in a chain. */
  cliqueRun: 8,
  /** Most pairs compared in full. Reaching it is reported, and means near groups may be missing. */
  maxCandidates: 2_000_000,
} as const;

export class DuplicateError extends Error {
  override readonly name = 'DuplicateError';
  constructor(readonly code: 'INVALID_PARAMS' | 'UNKNOWN_TYPE', message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export interface DuplicateRequest {
  /** Only notes of these types. Omit for every note of the user's, except transcripts and daily notes. */
  types?: string[];
  path_prefix?: string;
  min_similarity?: number;
  /** Exact copies only: skip the search for near ones. */
  exact_only?: boolean;
  limit?: number;
  offset?: number;
}

export interface DuplicateNote {
  id: string;
  title: string;
  path: string;
  types: string[];
  /** Words in the body. */
  words: number;
  /** When the file was last changed, and when the Engine first indexed the note. */
  modified_at: string | null;
  created_at: string | null;
  /** Notes that link to this one, and notes it links to. */
  inlink_count: number;
  outlink_count: number;
  /** Notes of a group with the same value here have the same body. */
  body_hash: string;
}

export interface DuplicateGroup {
  /** exact: every note has the same body. near: the texts are nearly the same. */
  kind: 'exact' | 'near';
  /** 1 for an exact group. For a near group, the lowest similarity among the pairs that tie it together. */
  similarity: number;
  /** The most linked-to note first, then the longest. */
  notes: DuplicateNote[];
}

export interface DuplicateResult {
  scope: {
    /** Notes read. */
    notes: number;
    /** Notes with enough text to be compared for near duplicates. */
    compared: number;
    /** Kinds left out because their notes are alike by design; empty when the request named types. */
    left_out_types: string[];
    /** More notes were in scope than one call reads. */
    truncated: boolean;
    /** The search for near duplicates stopped at its limit of pairs: some near groups may be missing. */
    near_incomplete: boolean;
  };
  min_similarity: number;
  /** Groups found, and the notes in them. */
  total_groups: number;
  total_notes: number;
  offset: number;
  /** Exact groups first, then near groups, the most alike first. */
  groups: DuplicateGroup[];
}

interface Row { id: string; title: string | null; file_path: string; body: string | null; file_mtime: number | null; created_at: number | null }

interface Read {
  id: string;
  title: string;
  path: string;
  words: number;
  modified: number | null;
  created: number | null;
  /** Hash of the normalized body. */
  hash: string;
  /** Whether the body is long enough to be called an exact copy of another. */
  exactable: boolean;
  sketch: TextSketch | null;
}

function unknownTypes(db: Database.Database, types: readonly string[]): string[] {
  const known = db.prepare<[string, string], { found: number }>(
    'SELECT EXISTS (SELECT 1 FROM schemas WHERE name = ?) OR EXISTS (SELECT 1 FROM node_types WHERE schema_type = ?) AS found',
  );
  return types.filter(type => known.get(type, type)?.found !== 1);
}

/** The notes in scope, as conditions on `nodes n`. */
function scopeOf(db: Database.Database, request: DuplicateRequest, settingsDir: string | undefined): { where: string; params: string[]; leftOut: string[] } {
  const vault = getVaultSettings(db);
  const user = userNotesWhere({ vault, settingsDir });
  const where = [user.sql];
  const params: string[] = [...user.params];
  let leftOut: string[] = [];
  if (request.types && request.types.length > 0) {
    const missing = unknownTypes(db, request.types);
    if (missing.length > 0) {
      throw new DuplicateError('UNKNOWN_TYPE', `No such type: ${missing.join(', ')}. list-schemas shows the types in use.`, { unknown_types: missing });
    }
    where.push(`EXISTS (SELECT 1 FROM node_types nt WHERE nt.node_id = n.id AND nt.schema_type IN (${request.types.map(() => '?').join(', ')}))`);
    params.push(...request.types);
  } else {
    // Alike by design: a transcript repeats its recording's boilerplate, and one day's note is the next day's template.
    leftOut = [vault.transcriptType, vault.dailyNoteType].filter((type): type is string => type !== null);
    for (const type of leftOut) {
      where.push('NOT EXISTS (SELECT 1 FROM node_types alike WHERE alike.node_id = n.id AND alike.schema_type = ?)');
      params.push(type);
    }
  }
  if (request.path_prefix) {
    where.push(`n.file_path LIKE ? ${LIKE_ESCAPE}`);
    params.push(literalPrefixPattern(request.path_prefix));
  }
  return { where: where.join(' AND '), params, leftOut };
}

/** The notes in scope, read and reduced to what comparing them needs: at most `maxNotes`, the first by id. */
function readScope(
  db: Database.Database, request: DuplicateRequest, settingsDir: string | undefined, maxNotes: number,
): { notes: Read[]; leftOut: string[]; truncated: boolean } {
  const { where, params, leftOut } = scopeOf(db, request, settingsDir);
  const rows = db.prepare<string[], Row>(
    `SELECT n.id, n.title, n.file_path, n.body, n.file_mtime, n.created_at FROM nodes n
     WHERE ${where} ORDER BY n.id LIMIT ${maxNotes + 1}`,
  );
  const notes: Read[] = [];
  let truncated = false;
  for (const row of rows.iterate(...params)) {
    if (notes.length === maxNotes) { truncated = true; break; }
    const normalized = normalizeBody(row.body ?? '');
    const words = wordsOf(normalized);
    notes.push({
      id: row.id,
      title: row.title ?? '',
      path: row.file_path,
      words: words.length,
      modified: row.file_mtime,
      created: row.created_at,
      hash: bodyHash(normalized),
      exactable: normalized.length >= DUPLICATE_LIMITS.minExactChars,
      sketch: request.exact_only === true || words.length < DUPLICATE_LIMITS.minWords ? null : sketchOf(words),
    });
  }
  return { notes, leftOut, truncated };
}

/** Disjoint sets over indices, with the lowest similarity that joined each set. */
class Sets {
  private readonly parent: Int32Array;
  private readonly weakest: Float64Array;
  constructor(size: number) {
    this.parent = Int32Array.from({ length: size }, (_, index) => index);
    this.weakest = new Float64Array(size).fill(1);
  }
  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root]!;
    while (this.parent[index] !== root) {
      const next = this.parent[index]!;
      this.parent[index] = root;
      index = next;
    }
    return root;
  }
  join(a: number, b: number, score: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    // The lower index stays the root, so a set's root does not depend on the order pairs arrive in.
    const [keep, fold] = rootA <= rootB ? [rootA, rootB] : [rootB, rootA];
    this.weakest[keep] = Math.min(this.weakest[keep]!, this.weakest[fold]!, score);
    this.parent[fold] = keep;
  }
  weakestOf(index: number): number {
    return this.weakest[this.find(index)]!;
  }
}

/**
 * Join the texts that are nearly the same. `texts` are distinct texts (one per group of exact
 * copies), each with a sketch. Returns whether the search stopped at its limit of pairs.
 */
function joinNear(texts: readonly TextSketch[], threshold: number, sets: Sets): boolean {
  const count = texts.length;
  if (count < 2) return false;
  const signatures = new Uint32Array(count * TEXT_LIMITS.hashes);
  for (let i = 0; i < count; i++) writeSignature(texts[i]!, signatures, i * TEXT_LIMITS.hashes);

  const compared = new Set<number>();
  let incomplete = false;
  const compare = (a: number, b: number): void => {
    if (incomplete) return;
    const [low, high] = a < b ? [a, b] : [b, a];
    const pair = low * count + high;
    if (compared.has(pair)) return;
    if (compared.size >= DUPLICATE_LIMITS.maxCandidates) { incomplete = true; return; }
    compared.add(pair);
    const x = texts[low]!;
    const y = texts[high]!;
    // Two texts cannot share more than the smaller one holds.
    if (Math.min(x.shingles, y.shingles) / Math.max(x.shingles, y.shingles) < threshold) return;
    const score = similarity(x, y);
    if (score >= threshold) sets.join(low, high, score);
  };

  const keys = new Uint32Array(count);
  const order = new Uint32Array(count);
  for (let band = 0; band < BANDS && !incomplete; band++) {
    for (let i = 0; i < count; i++) {
      keys[i] = bandKey(signatures, i * TEXT_LIMITS.hashes, band);
      order[i] = i;
    }
    order.sort((a, b) => keys[a]! - keys[b]! || a - b);
    for (let start = 0; start < count;) {
      let end = start + 1;
      while (end < count && keys[order[end]!] === keys[order[start]!]) end += 1;
      const run = end - start;
      if (run >= 2 && run <= DUPLICATE_LIMITS.cliqueRun) {
        for (let i = start; i < end; i++) for (let j = i + 1; j < end; j++) compare(order[i]!, order[j]!);
      } else if (run > DUPLICATE_LIMITS.cliqueRun) {
        // Many notes agreeing on a band are one big family of copies, or notes sharing a common
        // phrase. Comparing each with the first and with its neighbour ties a family together
        // without comparing every pair; notes that only share the phrase meet again in other bands.
        for (let i = start + 1; i < end; i++) {
          compare(order[start]!, order[i]!);
          compare(order[i - 1]!, order[i]!);
        }
      }
      start = end;
    }
  }
  return incomplete;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** Distinct texts: notes with the same body are one text. A body too short to be called a copy is a text of its own, however many notes share it. */
function textsOf(notes: readonly Read[]): number[][] {
  const textOf = new Map<string, number>();
  const members: number[][] = [];
  notes.forEach((note, index) => {
    const known = note.exactable ? textOf.get(note.hash) : undefined;
    if (known !== undefined) { members[known]!.push(index); return; }
    if (note.exactable) textOf.set(note.hash, members.length);
    members.push([index]);
  });
  return members;
}

/**
 * The notes that have an exact copy, newest first: the clean-up report's row. The same scope and
 * the same rule as `findDuplicates` with no arguments, so the row counts the notes its exact
 * groups hold. Near copies are left to the tool: finding them costs several times as much.
 *
 * It reads every note in scope, with no limit: a row is a complete count, and the report has
 * nowhere to say that notes were skipped. Only a hash per note is kept, so this stays small where
 * the tool, which keeps what it shows and compares, stops at `maxNotes`.
 */
export function exactDuplicateIds(db: Database.Database, settingsDir: string | undefined): string[] {
  const { where, params } = scopeOf(db, {}, settingsDir);
  const rows = db.prepare<string[], { id: string; body: string | null; modified: number | null }>(
    `SELECT n.id, n.body, n.file_mtime AS modified FROM nodes n WHERE ${where}`,
  );
  const byText = new Map<string, Array<{ id: string; modified: number }>>();
  for (const row of rows.iterate(...params)) {
    const normalized = normalizeBody(row.body ?? '');
    if (normalized.length < DUPLICATE_LIMITS.minExactChars) continue;
    const hash = bodyHash(normalized);
    const note = { id: row.id, modified: row.modified ?? 0 };
    const same = byText.get(hash);
    if (same) same.push(note);
    else byText.set(hash, [note]);
  }
  return [...byText.values()].filter(group => group.length >= 2).flat()
    .sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id)).map(note => note.id);
}

export function findDuplicates(
  db: Database.Database, request: DuplicateRequest = {},
  /** `maxNotes` lowers the most notes read, for tests. */
  options: { settingsDir?: string; maxNotes?: number } = {},
): DuplicateResult {
  const threshold = request.min_similarity ?? DUPLICATE_LIMITS.defaultSimilarity;
  if (!(threshold >= DUPLICATE_LIMITS.minSimilarity && threshold <= 1)) {
    throw new DuplicateError('INVALID_PARAMS', `min_similarity: between ${DUPLICATE_LIMITS.minSimilarity} and 1.`);
  }
  const { notes, leftOut, truncated } = readScope(db, request, options.settingsDir, options.maxNotes ?? DUPLICATE_LIMITS.maxNotes);

  const members = textsOf(notes);

  // Near duplicates, among the texts long enough to compare.
  const comparable = members.map((group, text) => ({ text, sketch: notes[group[0]!]!.sketch })).filter(
    (entry): entry is { text: number; sketch: TextSketch } => entry.sketch !== null && entry.sketch.shingles > 0);
  const sets = new Sets(comparable.length);
  const nearIncomplete = joinNear(comparable.map(entry => entry.sketch), threshold, sets);

  // A group is one text held by several notes, or several texts joined as near duplicates.
  const families = new Map<number, number[]>();
  comparable.forEach((entry, index) => {
    const root = sets.find(index);
    const family = families.get(root);
    if (family) family.push(entry.text);
    else families.set(root, [entry.text]);
  });
  const grouped = new Set<number>();
  const found: Array<{ kind: 'exact' | 'near'; similarity: number; notes: number[] }> = [];
  for (const [root, texts] of families) {
    if (texts.length < 2) continue;
    for (const text of texts) grouped.add(text);
    found.push({ kind: 'near', similarity: Math.round(sets.weakestOf(root) * 100) / 100, notes: texts.flatMap(text => members[text]!) });
  }
  members.forEach((group, text) => {
    if (group.length >= 2 && !grouped.has(text)) found.push({ kind: 'exact', similarity: 1, notes: group });
  });
  // Exact groups first, then the most alike; the larger group, then the lowest note id, settle a tie.
  const firstId = (group: { notes: number[] }): string => group.notes.map(index => notes[index]!.id).sort()[0]!;
  found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'exact' ? -1 : 1)
    || b.similarity - a.similarity || b.notes.length - a.notes.length || firstId(a).localeCompare(firstId(b)));

  const offset = request.offset ?? 0;
  const page = found.slice(offset, offset + (request.limit ?? DUPLICATE_LIMITS.defaultGroups));
  const shown = page.flatMap(group => group.notes.map(index => notes[index]!.id));
  const links = readLinkCounts(db, shown);
  const typesOf = db.prepare<[string], { schema_type: string }>('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order, schema_type');
  const view = (index: number): DuplicateNote => {
    const note = notes[index]!;
    const counts = links.get(note.id);
    return {
      id: note.id, title: note.title, path: note.path, types: typesOf.all(note.id).map(row => row.schema_type), words: note.words,
      modified_at: iso(note.modified), created_at: iso(note.created),
      inlink_count: counts?.incoming ?? 0, outlink_count: counts?.outgoing ?? 0, body_hash: note.hash.slice(0, 12),
    };
  };
  return {
    scope: {
      notes: notes.length,
      compared: comparable.reduce((sum, entry) => sum + members[entry.text]!.length, 0),
      left_out_types: leftOut,
      truncated,
      near_incomplete: nearIncomplete,
    },
    min_similarity: threshold,
    total_groups: found.length,
    total_notes: found.reduce((sum, group) => sum + group.notes.length, 0),
    offset,
    groups: page.map(group => ({
      kind: group.kind,
      similarity: group.similarity,
      notes: group.notes.map(view).sort((a, b) => b.inlink_count - a.inlink_count || b.words - a.words || a.path.localeCompare(b.path)),
    })),
  };
}
