import { observeMemory } from '../provenance/observations.js';
import type { SourceObservation } from '../provenance/types.js';
import type Database from 'better-sqlite3';
import type { Embedder } from '../search/embedder.js';
import { buildFtsMatchQuery } from '../search/search.js';
import { validateEvidence, type MemoryEvidence } from '../mcp/tools/memory-evidence.js';
import type {
  ConsolidationOp,
  ConsolidationVerdict,
  MemoryCandidate,
  MemoryConsolidator,
  MemoryNoteContext,
} from '../mcp/tools/memory-consolidation.js';
import { getWikiConfig } from '../wiki/config.js';
import { getVaultSettings } from '../settings/vault.js';
import { entityKinds } from '@vault/settings-registry';
import { ConsolidationError } from '../mcp/tools/memory-consolidation.js';
import { computeNearPairs, type NearPairsResult } from '../mcp/tools/memory-pairs.js';
import { SubjectGuard, linkedSubjects } from './subject-guard.js';
import { matchNewMemorySubjects } from './subject-backfill.js';
import {
  EntityIndex, MAX_SUBJECTS, addSubjects, allSubjectNames, carrySubjects, deleteSubjects, replaceSubjects,
  resolveSubjects, subjectOfCondition, subjectsOf, type ResolvedSubject, type SubjectSetBy,
} from './subjects.js';
import {
  type MemoryRow,
  type Memory,
  type CreateMemoryArgs,
  type CreateMemoryOk,
  type UpdateMemoryArgs,
  type UpdateMemoryOk,
  type ExpireMemoryArgs,
  type ExpireMemoryOk,
  type DeleteMemoryArgs,
  type DeleteMemoryOk,
  type GetMemoryArgs,
  type ListMemoriesArgs,
  type ListMemoriesOptions,
  type NearPairMember,
  type NearPairsArgs,
  type ServiceResult,
  type ServiceError,
  type MemoryWarning,
  type MemoryProjectionRow,
  type MemoryHistoryEntry,
  type VectorBackfillResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Canonical dedup constants + tiering (owned here; the MCP tool re-exports
// these from its own module for backwards-compat with existing test imports)
// ---------------------------------------------------------------------------

export const MEMORY_NEAR_DUP = 0.06;
export const MEMORY_UNRELATED = 0.35;
export const MEMORY_RECONCILE_REPORT_FAR = 0.15;

/**
 * How far a memory may be from a meaning-based search and still be returned (#560); without a
 * cut-off a topic with no memories still got a full page of the least unrelated ones. Measured with
 * the production embedder on 15 sample memories: the memory a question was about sat at 0.15-0.32,
 * other memories on the same client or project at 0.28-0.42, and the closest memory to an
 * off-topic question at 0.47 or more.
 */
export const MEMORY_SEARCH_MAX_DISTANCE = 0.45;

export type TierDecision =
  | { tier: 'duplicate' }
  | { tier: 'add' }
  | { tier: 'gray'; candidates: MemoryCandidate[] };

const ISO_DAY = /\d{4}-\d{2}-\d{2}/g;

function isRealDay(day: string): boolean {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

/**
 * The date a note can be read to have, from its date field's stored text and its title: the
 * field when it starts with a real YYYY-MM-DD day, else the last such day in the title. The one
 * rule behind `evidenceNoteDate`; date recovery (#647) reads many notes with it.
 */
export function readableNoteDate(fieldText: string | null | undefined, title: string | null | undefined): string | null {
  const fromField = fieldText?.trim().slice(0, 10) ?? '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromField) && isRealDay(fromField)) return fromField;
  return (title?.match(ISO_DAY) ?? []).filter(isRealDay).at(-1) ?? null;
}

/** When a memory's source note was written: its date field (the vault map's `dateField`; none
 *  reads only the title), else the last date in its title (the Curator's rule, #318), never the
 *  file time. Null with no note, or a note with no date. */
export function evidenceNoteDate(db: Database.Database, nodeId: string | null | undefined): string | null {
  if (!nodeId) return null;
  const dateField = getVaultSettings(db).dateField;
  const note = dateField === null
    ? db.prepare<[string], { title: string | null; field: string | null }>(
      'SELECT n.title, NULL AS field FROM nodes n WHERE n.id = ?',
    ).get(nodeId)
    : db.prepare<[string, string], { title: string | null; field: string | null }>(
      `SELECT n.title, COALESCE(f.value_date, f.value_text) AS field
       FROM nodes n LEFT JOIN node_fields f ON f.node_id = n.id AND f.field_name = ?
       WHERE n.id = ?`,
    ).get(dateField, nodeId);
  if (!note) return null;
  return readableNoteDate(note.field, note.title);
}

/**
 * When a memory drawn from a note became true (#706), or null for a memory not drawn from a note
 * with a readable date (`evidenceNoteDate`), whose date stays the verdict's or the write's. A fact
 * from a 2021 meeting read today is dated 2021, so it no longer pushes newer memories out of what
 * lists newest first. The consolidation verdict's date is kept when the model gave one, but never a
 * day later than the note's (owner, 2026-11-20): a plan's date in the future must not make a fact
 * look newer than its note. Otherwise it is the note's day, midnight UTC (the date-only convention
 * of `normalizeValidAt`). Either is never later than `now`: a note dated ahead is read today.
 */
export function noteDatedValidAt(
  db: Database.Database,
  evidence: { kind: string; node_id?: string | null | undefined },
  verdictValidAt: string | undefined,
  now: string,
): string | null {
  if (evidence.kind !== 'note') return null;
  const day = evidenceNoteDate(db, evidence.node_id);
  return day === null ? null : datedByNote(day, verdictValidAt, now);
}

/** `noteDatedValidAt`'s rule for a note day already read (`YYYY-MM-DD`); the date backfill reads
 *  many memories of one note with it. */
export function datedByNote(day: string, verdictValidAt: string | undefined, now: string): string {
  const dated = verdictValidAt !== undefined && verdictValidAt.slice(0, 10) <= day ? verdictValidAt : `${day}T00:00:00.000Z`;
  // A verdict's date as well as the note's: a date ahead would outrank today's facts (Codex, #708).
  return dated < now ? dated : now;
}

/**
 * A memory's source note as merge decisions see it (#352): its title, its date (`evidenceNoteDate`)
 * and the projects it is filed under (`filedProjects`). At most five projects. Null with no note.
 */
export function memoryNoteContext(db: Database.Database, nodeId: string | null | undefined): MemoryNoteContext | null {
  if (!nodeId) return null;
  const note = db.prepare<[string], { title: string | null }>('SELECT title FROM nodes WHERE id = ?').get(nodeId);
  if (!note) return null;
  const projects = [...new Set(filedProjects(db, nodeId).map(project => project.title))].slice(0, 5);
  return { title: note.title ?? nodeId, date: evidenceNoteDate(db, nodeId), projects };
}

/**
 * The projects a node is filed under (#352): the node itself when it is of the wiki project
 * type, then every node of that type it links to, from a field or from its body. That is the
 * rule project wikis use for their evidence (`fetchAssociatedRows` in `wiki/digest.ts`), so a
 * note behind a project's wiki also lends its memories to that project's set (#453). Projects
 * it links to from a field come before those it only mentions in its body, then by title, so a
 * caller that keeps only the first few keeps the ones the note is filed under by its metadata.
 */
export function filedProjects(db: Database.Database, nodeId: string): Array<{ id: string; title: string }> {
  const projectType = getWikiConfig(db).projectType;
  if (projectType === null) return []; // no project kind (none): nothing is filed under a project
  const own = db.prepare<[string, string], { id: string; title: string | null }>(
    `SELECT n.id, n.title FROM nodes n JOIN node_types t ON t.node_id = n.id AND t.schema_type = ? WHERE n.id = ?`,
  ).get(projectType, nodeId);
  const filed = db.prepare<[string, string], { id: string; title: string | null }>(
    `SELECT p.id, p.title FROM relationships r
     JOIN nodes p ON p.id = r.resolved_target_id
     JOIN node_types t ON t.node_id = p.id AND t.schema_type = ?
     WHERE r.source_id = ? AND p.id != r.source_id
     GROUP BY p.id
     ORDER BY MIN(r.rel_type = 'wiki-link'), p.title`,
  ).all(projectType, nodeId);
  return [...(own ? [own] : []), ...filed].map(row => ({ id: row.id, title: row.title ?? row.id }));
}

/**
 * Why the source notes' dates rule out a verdict that would replace the candidate, or null when
 * they don't. Callers keep both. "update" and "contradict" keep the new memory and expire the
 * candidate, which is only right when the new one is the later word. The memory sweep works newest
 * note first, so in a backfill the "new" memory is usually the older fact, and the model sees
 * neither date (#349). A "contradict" needs a strictly later note: the model can see that two
 * memories conflict but not which is right, and a date tie gives it nothing to go on (#351). An
 * "update" on the same date stands, because it must already cover everything the candidate says.
 * A new memory with no dated note leaves the verdict alone, so chat corrections still work. A
 * candidate drawn from a chat (the conversation sweep's) is dated by its write, which is when it
 * was said: a fact from an old note read today must not replace what a chat said last week.
 */
export function noteDateBlock(
  db: Database.Database,
  operation: 'update' | 'contradict',
  newNodeId: string | null | undefined,
  candidate: Pick<MemoryRow, 'evidence_kind' | 'evidence_node_id' | 'created_at'> | null | undefined,
): 'from an earlier note' | 'from a same-day note' | null {
  const newDate = evidenceNoteDate(db, newNodeId);
  const candidateDate = candidateSourceDay(db, candidate);
  if (newDate === null || candidateDate === null) return null;
  if (newDate < candidateDate) return 'from an earlier note';
  return operation === 'contradict' && newDate === candidateDate ? 'from a same-day note' : null;
}

/**
 * The day a candidate memory's source is from, for `noteDateBlock`: its note's date for a note
 * memory (null when the note has none), else the day it was written. A chat memory is written
 * hours after the chat, so its write is when it was said.
 */
function candidateSourceDay(
  db: Database.Database,
  candidate: Pick<MemoryRow, 'evidence_kind' | 'evidence_node_id' | 'created_at'> | null | undefined,
): string | null {
  if (!candidate) return null;
  if (candidate.evidence_kind === 'note') return evidenceNoteDate(db, candidate.evidence_node_id);
  return candidate.created_at.slice(0, 10);
}

/** candidates MUST be sorted ascending by distance. */
export function decideTier(
  candidates: MemoryCandidate[],
  nearDup: number = MEMORY_NEAR_DUP,
  unrelated: number = MEMORY_UNRELATED,
): TierDecision {
  if (candidates.length === 0) return { tier: 'add' };
  const nearest = candidates[0]!.distance;
  if (nearest < nearDup) return { tier: 'duplicate' };
  if (nearest > unrelated) return { tier: 'add' };
  return {
    tier: 'gray',
    candidates: candidates.filter((c) => c.distance >= nearDup && c.distance <= unrelated),
  };
}

// Large k for the dedup KNN — see memories.ts for the rationale (needs every
// same-source neighbor within striking distance, not just the global top few).
const MEMORY_DEDUP_K = 200;
export { MEMORY_DEDUP_K };
// How many memories_fts candidates to inspect for the embedder-unavailable
// near-exact fallback check.
const FTS_DEDUP_CANDIDATES = 5;
/** With subjects given, the text-only check reads this many: copies kept apart (the same words
 *  about other companies) must not hide this one's duplicate behind them (Codex, #726). */
const FTS_DEDUP_CANDIDATES_WITH_SUBJECTS = 100;

// ---------------------------------------------------------------------------
// Pure helpers (kept module-level for reuse by tests + the projection path)
// ---------------------------------------------------------------------------

export function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    source: row.source,
    scope: row.scope === 'node' ? 'node' : 'vault',
    node_id: row.node_id,
    content: row.content,
    category: row.category,
    metadata: row.metadata_json !== null ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expired_at: row.expired_at,
    valid_at: row.valid_at,
    invalid_at: row.invalid_at,
    superseded_by: row.superseded_by,
    evidence_kind: row.evidence_kind,
    evidence_node_id: row.evidence_node_id,
    evidence_hash: row.evidence_hash,
    evidence_ref: row.evidence_ref,
    expire_reason: row.expire_reason,
    changed_by: row.changed_by ?? null,
  };
}

/**
 * Record the chat client that just wrote a memory row (#532). Call inside the write's
 * transaction, and only with a client: a write by the suite itself leaves the column alone.
 */
export function markChangedBy(db: Database.Database, memoryId: number, changedBy: string): void {
  db.prepare('UPDATE memories SET changed_by = ? WHERE id = ?').run(changedBy, memoryId);
}

/** Lowercase + collapse whitespace, for the embedder-unavailable near-exact dedup check. */
export function normalizeForDedup(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function floatsToBytes(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function sameScopeBucket(
  row: Pick<MemoryRow, 'scope' | 'node_id'>,
  scope: string,
  nodeId: string | undefined,
): boolean {
  if (scope === 'node') return row.scope === 'node' && row.node_id === (nodeId ?? null);
  return row.scope !== 'node';
}

interface VecDedupHit {
  id: number;
  content: string;
  category: string | null;
  source: string;
  scope: string;
  node_id: string | null;
  valid_at: string | null;
  expired_at: string | null;
  evidence_node_id: string | null;
  distance: number;
}

interface InsertMemoryInput {
  source: string;
  scope: string;
  node_id: string | null;
  content: string;
  category: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  valid_at: string;
  evidence_kind: string;
  evidence_node_id: string | null;
  evidence_hash: string | null;
  evidence_ref: string | null;
}

// ---------------------------------------------------------------------------
// Row-level operations (transactional helpers; kept as pure functions so the
// service and the receipt-backed ingest path can compose them inside one txn)
// ---------------------------------------------------------------------------

export function getMemoryRow(db: Database.Database, id: number): MemoryRow | undefined {
  return db.prepare<[number], MemoryRow>('SELECT * FROM memories WHERE id = ?').get(id);
}

export function insertMemoryRow(db: Database.Database, input: InsertMemoryInput): number {
  const result = db.prepare(
    `INSERT INTO memories (source, scope, node_id, content, category, metadata_json, created_at, updated_at, valid_at,
                           evidence_kind, evidence_node_id, evidence_hash, evidence_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.source,
    input.scope,
    input.node_id,
    input.content,
    input.category,
    input.metadata_json,
    input.created_at,
    input.updated_at,
    input.valid_at,
    input.evidence_kind,
    input.evidence_node_id,
    input.evidence_hash,
    input.evidence_ref,
  );
  return Number(result.lastInsertRowid);
}

export function insertMemoryVector(db: Database.Database, memoryId: number, vec: Float32Array): number {
  const result = db.prepare<[Uint8Array]>('INSERT INTO memory_embedding_vec (vector) VALUES (?)').run(floatsToBytes(vec));
  const vecId = Number(result.lastInsertRowid);
  db.prepare('UPDATE memories SET vec_id = ? WHERE id = ?').run(vecId, memoryId);
  return vecId;
}

/** Retire a live memory row. Returns false when it was already expired (no-op). */
export function expireMemoryRow(
  db: Database.Database,
  id: number,
  opts: { reason: string; supersededBy?: number | undefined; invalidAt?: string | undefined; now: string },
): boolean {
  const result = db.prepare(
    `UPDATE memories
     SET expired_at = ?, expire_reason = ?,
         invalid_at = COALESCE(?, invalid_at),
         superseded_by = COALESCE(?, superseded_by),
         updated_at = ?
     WHERE id = ? AND expired_at IS NULL`,
  ).run(opts.now, opts.reason, opts.invalidAt ?? null, opts.supersededBy ?? null, opts.now, id);
  return result.changes === 1;
}

/**
 * Version a live memory: mint a new row carrying the old row's identity
 * (source/scope/node_id, evidence unless overridden), then expire the old row
 * with superseded_by → new. The one lineage-preserving way content changes.
 * `vec` (if provided) must be embedded by the caller BEFORE calling — the
 * transaction callback must stay synchronous.
 */
export function versionMemory(
  db: Database.Database,
  old: MemoryRow,
  input: {
    content: string; category: string | null; metadataJson: string | null; evidence?: MemoryEvidence | undefined; now: string;
    /** The chat client whose edit this version is; never carried over from the old row. */
    changedBy?: string | undefined;
    /** When the new version became true; `now` without it. A create's update verdict passes its
     *  source note's date (`noteDatedValidAt`, #706). */
    validAt?: string | undefined;
  },
  vec?: Float32Array,
): number {
  const txn = db.transaction(() => {
    const newId = insertMemoryRow(db, {
      source: old.source,
      scope: old.scope,
      node_id: old.node_id,
      content: input.content,
      category: input.category,
      metadata_json: input.metadataJson,
      created_at: input.now,
      updated_at: input.now,
      valid_at: input.validAt ?? input.now,
      evidence_kind: input.evidence?.kind ?? old.evidence_kind,
      evidence_node_id: input.evidence ? input.evidence.node_id ?? null : old.evidence_node_id,
      evidence_hash: input.evidence ? input.evidence.hash ?? null : old.evidence_hash,
      evidence_ref: input.evidence ? input.evidence.ref ?? null : old.evidence_ref,
    });
    if (vec) insertMemoryVector(db, newId, vec);
    if (input.changedBy !== undefined) markChangedBy(db, newId, input.changedBy);
    // The new version is about what the old one was about (#554).
    carrySubjects(db, old.id, newId, input.now);
    if (!expireMemoryRow(db, old.id, { reason: 'superseded-by-update', supersededBy: newId, now: input.now })) {
      throw new Error(`memory ${old.id} was expired concurrently — versioning aborted`);
    }
    // An edit doesn't settle an open merge decision: the new version takes over the flag (#346).
    db.prepare('UPDATE memory_consolidation_pending SET memory_id = ? WHERE memory_id = ?').run(newId, old.id);
    return newId;
  });
  return txn();
}

export function addTemporalReadConditions(
  conditions: string[],
  args: unknown[],
  params: { include_superseded?: boolean | undefined; as_of?: string | undefined },
  qualifier = '',
): void {
  const p = qualifier ? `${qualifier}.` : '';
  if (params.as_of !== undefined) {
    conditions.push(`${p}created_at <= ?`);
    args.push(params.as_of);
    conditions.push(`(${p}expired_at IS NULL OR ${p}expired_at > ?)`);
    args.push(params.as_of);
    conditions.push(`(${p}valid_at IS NULL OR ${p}valid_at <= ?)`);
    args.push(params.as_of);
    conditions.push(`(${p}invalid_at IS NULL OR ${p}invalid_at > ?)`);
    args.push(params.as_of);
  } else if (params.include_superseded !== true) {
    conditions.push(`${p}expired_at IS NULL`);
  }
}

export function lineageOf(db: Database.Database, id: number): MemoryRow[] {
  const byId = db.prepare<[number], MemoryRow>('SELECT * FROM memories WHERE id = ?');
  const bySupersededBy = db.prepare<[number], MemoryRow>(
    'SELECT * FROM memories WHERE superseded_by = ? ORDER BY id DESC LIMIT 1',
  );
  const requested = byId.get(id);
  if (!requested) return [];

  const seen = new Set<number>();
  const chain: MemoryRow[] = [requested];
  seen.add(requested.id);

  let cur: MemoryRow | undefined = requested;
  while (cur) {
    const previous = bySupersededBy.get(cur.id);
    if (!previous || seen.has(previous.id)) break;
    seen.add(previous.id);
    chain.unshift(previous);
    cur = previous;
  }

  let nextId = requested.superseded_by;
  while (nextId !== null && !seen.has(nextId)) {
    const next = byId.get(nextId);
    if (!next) break;
    seen.add(next.id);
    chain.push(next);
    nextId = next.superseded_by;
  }

  return chain;
}

/** A failed consolidation call's reason for callers and the pending row: the provider's text
 *  with URLs removed (a provider's key-management link names the key) and its length capped. */
export function consolidationFailureReason(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/** Flag a memory added without consolidation for replay (#346). Call inside its insert's transaction. */
export function markConsolidationPending(db: Database.Database, memoryId: number, reason: string, now: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO memory_consolidation_pending (memory_id, failed_at, reason) VALUES (?, ?, ?)',
  ).run(memoryId, now, reason);
}

/** Drop a memory's replay flag; a no-op when it has none. */
export function clearConsolidationPending(db: Database.Database, memoryId: number): void {
  db.prepare('DELETE FROM memory_consolidation_pending WHERE memory_id = ?').run(memoryId);
}

function parseMetadata(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Append one in-place change to a memory's history (#300). Call inside the change's transaction. */
export function recordMemoryHistory(
  db: Database.Database,
  memoryId: number,
  change: MemoryHistoryEntry['change'],
  reason: string | null,
  previous: Record<string, unknown>,
  now: string,
): void {
  db.prepare(
    'INSERT INTO memory_history (memory_id, changed_at, change, reason, previous_json) VALUES (?, ?, ?, ?, ?)',
  ).run(memoryId, now, change, reason, JSON.stringify(previous));
}

/** A memory's in-place changes, oldest first. */
export function memoryHistory(db: Database.Database, memoryId: number): MemoryHistoryEntry[] {
  const rows = db.prepare<[number], { changed_at: string; change: string; reason: string | null; previous_json: string }>(
    'SELECT changed_at, change, reason, previous_json FROM memory_history WHERE memory_id = ? ORDER BY id ASC',
  ).all(memoryId);
  return rows.map((r) => ({
    changed_at: r.changed_at,
    change: r.change as MemoryHistoryEntry['change'],
    reason: r.reason,
    previous: parseMetadata(r.previous_json),
  }));
}

function err(code: string, message: string, details?: Record<string, unknown>): ServiceError {
  return details ? { code, message, details } : { code, message };
}

function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface MemoryServiceDeps {
  embedder?: Embedder | undefined;
  consolidator?: MemoryConsolidator | undefined;
}

/** SQLite errors a bad FTS5 query string raises; a hyphen or `word:` reads as a column filter. */
/** Newest first by when each memory became true (#706), so a fact from an old note read today
 *  ranks with its note's day rather than ahead of newer facts. `created_at` only breaks ties and
 *  stands in where a row has no `valid_at`. */
const NEWEST_FIRST = 'COALESCE(m.valid_at, m.created_at) DESC, m.created_at DESC, m.id DESC';

const FTS_QUERY_ERROR = /fts5|no such column|syntax error|unterminated string|unknown special query/i;

/** The columns of `memories_fts`, which a search may name as a column filter (`category:preference`). */
const MEMORY_FTS_COLUMNS: ReadonlySet<string> = new Set(['content', 'category']);

/**
 * The search string with each bare term that contains a hyphen or a colon put in double quotes
 * (#558). FTS5 reads `vault-engine` and `word:` as column filters, so they failed with "no such
 * column"; quoted, the term matches as a phrase, as the tokenizer splits it. A filter on a real
 * column (`category:preference`, `-content:draft`, `category:`) is kept, with only its term quoted
 * when that has punctuation. Quoted phrases, AND/OR/NOT/NEAR, parentheses and a trailing `*` prefix
 * marker are kept too.
 */
export function quoteFtsPunctuatedTerms(query: string): string {
  return query.replace(/"[^"]*"?|[^\s"()]+/g, (token) => {
    if (token.startsWith('"')) return token;
    const column = /^(-?)([^:]+):(.*)$/u.exec(token);
    if (column && MEMORY_FTS_COLUMNS.has(column[2]!.toLowerCase())) {
      const term = column[3]!;
      return `${column[1]}${column[2]}:${term === '' ? '' : quoteTerm(term)}`;
    }
    return quoteTerm(token);
  });
}

/** One bare term, quoted when it has a hyphen or a colon; a trailing `*` stays outside the quotes. */
function quoteTerm(term: string): string {
  if (!/[-:]/.test(term)) return term;
  const prefix = term.endsWith('*');
  const body = prefix ? term.slice(0, -1) : term;
  return `"${body}"${prefix ? '*' : ''}`;
}

export class MemoryService {
  private readonly db: Database.Database;
  private readonly embedder?: Embedder;
  private readonly consolidator?: MemoryConsolidator;

  private readonly stmtGetById: Database.Statement<[number], MemoryRow>;
  private readonly stmtDeleteVec: Database.Statement<[number]>;
  private readonly stmtVecDedupKnn: Database.Statement<[Uint8Array, number], VecDedupHit>;
  private readonly stmtFtsDedupCandidates: Database.Statement<[string, string, number], MemoryRow>;
  private readonly stmtDeleteMemory: Database.Statement<[number]>;

  constructor(db: Database.Database, deps: MemoryServiceDeps = {}) {
    this.db = db;
    this.embedder = deps.embedder;
    this.consolidator = deps.consolidator;
    this.stmtGetById = db.prepare<[number], MemoryRow>('SELECT * FROM memories WHERE id = ?');
    this.stmtDeleteVec = db.prepare<[number]>('DELETE FROM memory_embedding_vec WHERE id = ?');
    this.stmtVecDedupKnn = db.prepare<[Uint8Array, number], VecDedupHit>(
      `SELECT m.id, m.content, m.category, m.source, m.scope, m.node_id, m.valid_at, m.expired_at, m.evidence_node_id, v.distance
       FROM memory_embedding_vec v
       JOIN memories m ON m.vec_id = v.id
       WHERE v.vector MATCH ? AND k = ?`,
    );
    this.stmtFtsDedupCandidates = db.prepare<[string, string, number], MemoryRow>(
      `SELECT m.*
       FROM memories_fts f
       JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ? AND m.source = ? AND m.expired_at IS NULL
       ORDER BY rank
       LIMIT ?`,
    );
    this.stmtDeleteMemory = db.prepare<[number]>('DELETE FROM memories WHERE id = ?');
  }

  get database(): Database.Database {
    return this.db;
  }

  get hasEmbedder(): boolean {
    return this.embedder !== undefined;
  }

  /** The consolidation model seam create-memory uses; replay-memory-consolidation reuses it (#346). */
  get consolidation(): MemoryConsolidator | undefined {
    return this.consolidator;
  }

  /** Memories with their subjects (#554). */
  withSubjects<T extends Memory>(memories: T[]): T[] {
    const subjects = subjectsOf(this.db, memories.map(memory => memory.id));
    return memories.map(memory => ({ ...memory, subjects: subjects.get(memory.id) ?? [] }));
  }

  private withSubjectsOf<T extends Memory>(memory: T): T {
    return this.withSubjects([memory])[0]!;
  }

  /**
   * Caller input resolved to subjects, with a warning for names no note answers to yet and
   * names several do (#554). An error when there are too many.
   */
  private resolveSubjectInput(
    inputs: readonly string[] | undefined, warnings: MemoryWarning[],
    opts: { setBy: SubjectSetBy; evidenceNodeId: string | null | undefined },
  ): ResolvedSubject[] | ServiceError | undefined {
    if (inputs === undefined) return undefined;
    if (inputs.length > MAX_SUBJECTS) return err('INVALID_PARAMS', `subjects takes at most ${MAX_SUBJECTS} names`);
    const index = EntityIndex.build(this.db);
    const resolved = resolveSubjects(this.db, index, inputs, opts);
    const held = resolved.filter(subject => subject.held).map(subject => `"${subject.name}"`);
    const unresolved = resolved.filter(subject => subject.status === 'unresolved' && !subject.held).map(subject => `"${subject.name}"`);
    if (held.length > 0) {
      warnings.push({
        code: 'MEMORY_SUBJECT_UNRESOLVED', severity: 'warning',
        message: `${held.join(', ')}: a one-word name links to a person's note only when the memory's source note links that note, so ${held.length === 1 ? 'it is' : 'they are'} kept as ${held.length === 1 ? 'a name' : 'names'}. Give the full name, or the note's title or vault path.`,
      });
    }
    const ambiguous = resolved.filter(subject => subject.status === 'ambiguous').map(subject => `"${subject.name}"`);
    if (unresolved.length > 0) {
      const kinds = entityKinds(getVaultSettings(this.db));
      warnings.push({
        code: 'MEMORY_SUBJECT_UNRESOLVED', severity: 'warning',
        message: kinds.length === 0
          ? `no kind of note is set for memories to be about (the vault map's entityTypes, or its person, company and project kinds, are none), so ${unresolved.join(', ')} ${unresolved.length === 1 ? 'is' : 'are'} kept as names only`
          : `no ${kinds.join(', ')} note answers to ${unresolved.join(', ')} yet: kept as ${unresolved.length === 1 ? 'a name' : 'names'}, matched once such a note does`,
      });
    }
    if (ambiguous.length > 0) {
      warnings.push({
        code: 'MEMORY_SUBJECT_UNRESOLVED', severity: 'warning',
        message: `several notes answer to ${ambiguous.join(', ')}: kept as ${ambiguous.length === 1 ? 'a name linked to none of them' : 'names linked to none of them'}. Name the note by its title or vault path to link it.`,
      });
    }
    return resolved;
  }

  // -------------------------------------------------------------------------
  // vector backfill (#300)
  // -------------------------------------------------------------------------

  /**
   * Embed live memories that have no vector — created while the Engine ran without an
   * embedder — so vector dedup and near-pairs can see them. Walks them in id order in
   * small batches, attaches a vector only to a row that still lacks one, and stops after
   * three consecutive embed failures (the embedder is down; the next start retries).
   * Content never changes in place, so a vector embedded outside the transaction still
   * matches its row.
   */
  async backfillVectors(opts: { batchSize?: number } = {}): Promise<VectorBackfillResult> {
    const countRemaining = () => (this.db.prepare(
      'SELECT COUNT(*) AS c FROM memories WHERE expired_at IS NULL AND vec_id IS NULL',
    ).get() as { c: number }).c;
    if (!this.embedder) return { embedded: 0, failed: 0, remaining: countRemaining() };
    const batchSize = opts.batchSize ?? 50;
    const nextBatch = this.db.prepare<[number, number], { id: number; content: string }>(
      'SELECT id, content FROM memories WHERE expired_at IS NULL AND vec_id IS NULL AND id > ? ORDER BY id LIMIT ?',
    );
    let lastId = 0;
    let embedded = 0;
    let failed = 0;
    let consecutiveFailures = 0;
    for (;;) {
      const rows = nextBatch.all(lastId, batchSize);
      if (rows.length === 0) break;
      for (const row of rows) {
        lastId = row.id;
        let vec: Float32Array;
        try {
          vec = await this.embedder.embedQuery(row.content);
        } catch (e) {
          failed += 1;
          consecutiveFailures += 1;
          console.warn(`[memories] vector backfill: memory ${row.id} not embedded: ${e instanceof Error ? e.message : String(e)}`);
          if (consecutiveFailures >= 3) return { embedded, failed, remaining: countRemaining() };
          continue;
        }
        consecutiveFailures = 0;
        const attached = this.db.transaction(() => {
          const current = getMemoryRow(this.db, row.id);
          if (!current || current.vec_id !== null || current.content !== row.content) return false;
          insertMemoryVector(this.db, row.id, vec);
          return true;
        })();
        if (attached) embedded += 1;
      }
    }
    return { embedded, failed, remaining: countRemaining() };
  }

  // -------------------------------------------------------------------------
  // create-memory
  // -------------------------------------------------------------------------

  /**
   * The write, then the free match (#738) for the memory it wrote or kept when that memory has no
   * subjects: chat, wiki builds and the memory note's new blocks name none, and a subject set should
   * hold their memories without anyone starting the backfill. Best effort: a match that fails is
   * logged and the write stands.
   */
  async create(params: CreateMemoryArgs): Promise<{ result: ServiceResult<CreateMemoryOk>; warnings: MemoryWarning[] }> {
    const written = await this.createUnmatched(params);
    if (!written.result.ok) return written;
    const data = written.result.data;
    try {
      if (matchNewMemorySubjects(this.db, data.id) > 0) {
        const row = this.stmtGetById.get(data.id);
        if (row) {
          const fresh = this.withSubjectsOf(toMemory(row));
          return { ...written, result: ok({ ...data, subjects: fresh.subjects, updated_at: fresh.updated_at }) };
        }
      }
    } catch (error) {
      console.warn(`[memories] subject match for memory ${data.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return written;
  }

  private async createUnmatched(params: CreateMemoryArgs): Promise<{ result: ServiceResult<CreateMemoryOk>; warnings: MemoryWarning[] }> {
    const warnings: MemoryWarning[] = [];
    try {
      if (params.scope === 'node' && !params.node_id) {
        return { result: { ok: false, error: err('INVALID_PARAMS', 'node_id is required when scope is "node"') }, warnings };
      }
      if (!params.evidence) {
        return {
          result: {
            ok: false,
            error: err(
              'INVALID_PARAMS',
              'evidence is required: kind "note" needs evidence.node_id + evidence.hash; kinds "conversation" and "curation-run" need evidence.ref (chat and curator clients stamp this automatically — do not fabricate it)',
            ),
          },
          warnings,
        };
      }
      const evidenceError = validateEvidence(params.evidence);
      if (evidenceError) return { result: { ok: false, error: err('INVALID_PARAMS', evidenceError) }, warnings };
      const setBy = params.subjects_set_by ?? 'tool';
      const subjects = this.resolveSubjectInput(params.subjects, warnings, { setBy, evidenceNodeId: params.evidence.node_id });
      if (subjects !== undefined && !Array.isArray(subjects)) return { result: { ok: false, error: subjects }, warnings };
      const evidenceFields = {
        evidence_kind: params.evidence.kind,
        evidence_node_id: params.evidence.node_id ?? null,
        evidence_hash: params.evidence.hash ?? null,
        evidence_ref: params.evidence.ref ?? null,
      };

      let vec: Float32Array | undefined;
      let verdict: ConsolidationVerdict = { operation: 'add', reason: 'no similar memories' };
      // Why the consolidation call failed, when it did: the memory is then added unmerged and
      // flagged for replay-memory-consolidation (#346).
      let consolidationFailure: string | undefined;
      // The consolidation call's cost, once one is made (#298); see CreateMemoryOk.
      let consolidationCost: number | null | undefined;
      // Look-alikes left out of the comparison because their subjects keep them apart (#718).
      let keptApart: number[] = [];
      const costed = <T extends object>(data: T): T => ({
        ...data,
        ...(consolidationCost === undefined ? {} : { consolidation_cost_usd: consolidationCost }),
        ...(keptApart.length === 0 ? {} : { kept_apart: keptApart }),
      });

      const ownLinked = linkedSubjects(subjects);
      if (this.embedder) {
        vec = await this.embedder.embedQuery(params.content);
        const bytes = floatsToBytes(vec);
        const rows = this.stmtVecDedupKnn.all(bytes, MEMORY_DEDUP_K);
        const sameBucket = rows.filter((r) => r.source === params.source && r.expired_at === null && sameScopeBucket(r, params.scope, params.node_id));
        // A look-alike about a different thing of the same kind is a different fact: it is never a
        // duplicate of this one and never offered for a merge verdict (#718).
        const apart = ownLinked.length > 0 ? SubjectGuard.build(this.db).keptApart(ownLinked, sameBucket.map((r) => r.id)) : new Set<number>();
        keptApart = sameBucket.filter((r) => apart.has(r.id) && r.distance <= MEMORY_UNRELATED).map((r) => r.id);
        const live = sameBucket.filter((r) => !apart.has(r.id));
        const sourceNotes = new Map(live.map((r) => [r.id, r.evidence_node_id]));
        const candidates = live
          .map((r): MemoryCandidate => ({
            id: r.id,
            content: r.content,
            category: r.category,
            valid_at: r.valid_at,
            distance: r.distance,
          }))
          .sort((a, b) => a.distance - b.distance);
        const nearDup = params.dedup_threshold ?? MEMORY_NEAR_DUP;
        const unrelated = MEMORY_UNRELATED;
        const decision = decideTier(candidates, nearDup, unrelated);
        if (decision.tier === 'duplicate') {
          const best = candidates[0]!;
          return {
            result: {
              ok: false,
              error: err('DUPLICATE_MEMORY', `A near-duplicate memory already exists in source "${params.source}" (cosine distance ${best.distance.toFixed(4)})`, {
                existing_id: best.id,
                content: best.content,
                distance: best.distance,
                dedup_method: 'vector',
              }),
            },
            warnings,
          };
        }
        if (decision.tier === 'gray') {
          try {
            verdict = this.consolidator
              ? await this.consolidator.consolidate({
                  content: params.content,
                  category: params.category ?? null,
                  // Each memory's source note, so different contexts read as different facts (#352).
                  note: memoryNoteContext(this.db, params.evidence.node_id),
                  candidates: decision.candidates.map((c) => ({ ...c, note: memoryNoteContext(this.db, sourceNotes.get(c.id)) })),
                }, params.usage && {
                  service: params.usage.service,
                  runRef: params.usage.run_ref,
                  sourceRef: params.usage.source_ref,
                  conversationId: params.usage.conversation_id,
                  purpose: params.usage.purpose,
                })
              : { operation: 'add', reason: 'no consolidator' };
            if (this.consolidator) consolidationCost = verdict.costUsd ?? null;
            // A candidate's subjects can change while the model call runs: ask the guard again on
            // what is stored now, before any merge is applied (Codex, #726). Nothing awaits between
            // here and the write.
            if (verdict.operation !== 'add' && verdict.target_id !== undefined && ownLinked.length > 0) {
              const guard = SubjectGuard.build(this.db);
              if (guard.apart(ownLinked, guard.linkedOf([verdict.target_id]).get(verdict.target_id) ?? [])) {
                keptApart = [...new Set([...keptApart, verdict.target_id])];
                verdict = {
                  operation: 'add',
                  reason: `subjects now keep it apart from candidate ${verdict.target_id}; both kept`,
                  ...(verdict.valid_at !== undefined ? { valid_at: verdict.valid_at } : {}),
                };
              }
            }
            if ((verdict.operation === 'update' || verdict.operation === 'contradict') && verdict.target_id !== undefined) {
              const candidate = getMemoryRow(this.db, verdict.target_id);
              const blocked = candidate && noteDateBlock(this.db, verdict.operation, params.evidence.node_id, candidate);
              if (candidate && blocked) {
                verdict = {
                  operation: 'add',
                  reason: `${blocked} (candidate ${candidate.id}); both kept`,
                  ...(verdict.valid_at !== undefined ? { valid_at: verdict.valid_at } : {}),
                };
              }
            }
          } catch (e) {
            console.warn(`[memories] consolidation failed; falling back to add: ${e instanceof Error ? e.message : String(e)}`);
            verdict = { operation: 'add', reason: 'consolidation-failed' };
            if (e instanceof ConsolidationError) consolidationCost = e.costUsd;
            consolidationFailure = consolidationFailureReason(e);
            warnings.push({
              code: 'MEMORY_CONSOLIDATION_FAILED',
              severity: 'warning',
              message: `consolidation failed, so this memory was added without merging and queued for replay-memory-consolidation: ${consolidationFailure}`,
            });
          }
        }
      } else {
        const matchQuery = buildFtsMatchQuery(params.content);
        const candidates = matchQuery
          ? this.stmtFtsDedupCandidates.all(matchQuery, params.source,
            ownLinked.length > 0 ? FTS_DEDUP_CANDIDATES_WITH_SUBJECTS : FTS_DEDUP_CANDIDATES).filter((r) => sameScopeBucket(r, params.scope, params.node_id))
          : [];
        const normalizedNew = normalizeForDedup(params.content);
        // The same subject rule without an embedder (Codex, #726): the same words about another
        // company are another fact.
        const textApart = ownLinked.length > 0 ? SubjectGuard.build(this.db).keptApart(ownLinked, candidates.map((r) => r.id)) : new Set<number>();
        const sameText = candidates.filter((r) => normalizeForDedup(r.content) === normalizedNew);
        keptApart = sameText.filter((r) => textApart.has(r.id)).map((r) => r.id);
        const exactHit = sameText.find((r) => !textApart.has(r.id));
        if (exactHit) {
          return {
            result: {
              ok: false,
              error: err('DUPLICATE_MEMORY', `A near-exact duplicate memory already exists in source "${params.source}"`, {
                existing_id: exactHit.id,
                content: exactHit.content,
                dedup_method: 'fts',
              }),
            },
            warnings,
          };
        }
        warnings.push({
          code: 'MEMORY_DEDUP_DEGRADED',
          severity: 'warning',
          message: 'dedup_degraded: no embedder available — dedup used a normalized exact-text/FTS check only, not semantic similarity.',
        });
      }

      const now = new Date().toISOString();
      // A memory drawn from a dated note is dated by it (#706); any other keeps the verdict's date or now.
      const noteValidAt = noteDatedValidAt(this.db, params.evidence, verdict.valid_at, now);
      const validAt = noteValidAt ?? verdict.valid_at ?? now;
      const metadataJson = params.metadata !== undefined ? JSON.stringify(params.metadata) : null;

      if (verdict.operation === 'noop' && verdict.target_id !== undefined) {
        const existing = getMemoryRow(this.db, verdict.target_id);
        if (existing) {
          // The same fact: what this create says it is about, the existing memory is about too (#554).
          if (subjects && subjects.length > 0) this.db.transaction(() => addSubjects(this.db, existing.id, subjects, setBy, now))();
          return {
            result: ok(costed({ ...this.withSubjectsOf(toMemory(existing)), dedup_checked: true, embedding: this.hasEmbedder, operation: 'noop', superseded: [], valid_at: existing.valid_at ?? existing.created_at })),
            warnings,
          };
        }
      }

      if (verdict.operation === 'update' && verdict.target_id !== undefined) {
        const target = getMemoryRow(this.db, verdict.target_id);
        if (target && target.expired_at === null) {
          const newId = this.db.transaction(() => {
            const id = versionMemory(this.db, target, {
              content: params.content,
              category: params.category ?? target.category,
              metadataJson: metadataJson ?? target.metadata_json,
              evidence: params.evidence,
              now,
              ...(noteValidAt !== null ? { validAt: noteValidAt } : {}),
            }, vec);
            if (subjects) addSubjects(this.db, id, subjects, setBy, now);
            return id;
          })();
          const created = getMemoryRow(this.db, newId);
          if (!created) return { result: { ok: false, error: err('INTERNAL_ERROR', `memory ${newId} vanished during update`) }, warnings };
          return {
            result: ok(costed({ ...this.withSubjectsOf(toMemory(created)), operation: 'update', superseded: [{ id: target.id, content: target.content, reason: 'superseded-by-update' }], valid_at: created.valid_at ?? created.created_at })),
            warnings,
          };
        }
      }

      if (verdict.operation === 'contradict' && verdict.target_id !== undefined) {
        const loser = getMemoryRow(this.db, verdict.target_id);
        let superseded: Array<{ id: number; content: string; reason: string }> = [];
        const newId = this.db.transaction(() => {
          const id = insertMemoryRow(this.db, {
            source: params.source,
            scope: params.scope,
            node_id: params.node_id ?? null,
            content: params.content,
            category: params.category ?? null,
            metadata_json: metadataJson,
            created_at: now,
            updated_at: now,
            valid_at: validAt,
            ...evidenceFields,
          });
          if (vec) insertMemoryVector(this.db, id, vec);
          if (subjects) addSubjects(this.db, id, subjects, setBy, now);
          if (loser) {
            const changed = expireMemoryRow(this.db, loser.id, { reason: 'contradicted', supersededBy: id, invalidAt: validAt, now });
            if (changed) superseded = [{ id: loser.id, content: loser.content, reason: verdict.reason }];
            // What replaces a memory is about what it was about (#554).
            if (changed) carrySubjects(this.db, loser.id, id, now);
          }
          return id;
        })();
        const created = getMemoryRow(this.db, newId);
        if (!created) return { result: { ok: false, error: err('INTERNAL_ERROR', `memory ${newId} vanished during contradict`) }, warnings };
        const op: ConsolidationOp = superseded.length > 0 ? 'contradict' : 'add';
        return {
          result: ok(costed({ ...this.withSubjectsOf(toMemory(created)), dedup_checked: true, embedding: this.hasEmbedder, operation: op, superseded, valid_at: validAt })),
          warnings,
        };
      }

      const txn = this.db.transaction(() => {
        const newId = insertMemoryRow(this.db, {
          source: params.source,
          scope: params.scope,
          node_id: params.node_id ?? null,
          content: params.content,
          category: params.category ?? null,
          metadata_json: metadataJson,
          created_at: now,
          updated_at: now,
          valid_at: validAt,
          ...evidenceFields,
        });
        if (vec) insertMemoryVector(this.db, newId, vec);
        if (consolidationFailure !== undefined) markConsolidationPending(this.db, newId, consolidationFailure, now);
        if (subjects) addSubjects(this.db, newId, subjects, setBy, now);
        return newId;
      });
      const id = txn();
      const created = getMemoryRow(this.db, id);
      if (!created) return { result: { ok: false, error: err('INTERNAL_ERROR', `memory ${id} vanished during create`) }, warnings };
      return {
        result: ok(costed({ ...this.withSubjectsOf(toMemory(created)), dedup_checked: true, embedding: this.hasEmbedder, operation: 'add', superseded: [], valid_at: validAt })),
        warnings,
      };
    } catch (e) {
      return { result: { ok: false, error: err('INTERNAL_ERROR', e instanceof Error ? e.message : String(e)) }, warnings };
    }
  }

  // -------------------------------------------------------------------------
  // update-memory
  // -------------------------------------------------------------------------

  async update(params: UpdateMemoryArgs): Promise<{ result: ServiceResult<UpdateMemoryOk>; warnings: MemoryWarning[] }> {
    const warnings: MemoryWarning[] = [];
    try {
      const existing = this.stmtGetById.get(params.id);
      if (!existing) return { result: { ok: false, error: err('NOT_FOUND', `no memory ${params.id}`) }, warnings };

      if (params.evidence) {
        const evidenceError = validateEvidence(params.evidence);
        if (evidenceError) return { result: { ok: false, error: err('INVALID_PARAMS', evidenceError) }, warnings };
      }

      const contentChanging = params.content !== undefined && params.content !== existing.content;
      const setBy = params.subjects_set_by ?? 'tool';
      // The source note the memory will have: a content change's new evidence, else its own.
      const evidenceNodeId = contentChanging && params.evidence ? params.evidence.node_id : existing.evidence_node_id;
      const subjects = this.resolveSubjectInput(params.subjects, warnings, { setBy, evidenceNodeId });
      if (subjects !== undefined && !Array.isArray(subjects)) return { result: { ok: false, error: subjects }, warnings };

      if (params.evidence && params.content === undefined) {
        return {
          result: { ok: false, error: err('INVALID_PARAMS', 'evidence requires a content change — it attaches to the new version (omit evidence for category/metadata-only updates)') },
          warnings,
        };
      }

      if (contentChanging && !params.evidence) {
        return {
          result: {
            ok: false,
            error: err(
              'INVALID_PARAMS',
              'evidence is required for a content change — it attaches to the new version: kind "note" needs evidence.node_id + evidence.hash; kinds "conversation" and "curation-run" need evidence.ref (chat clients stamp this automatically)',
            ),
          },
          warnings,
        };
      }

      if (contentChanging) {
        if (existing.expired_at !== null) {
          return {
            result: { ok: false, error: err('INVALID_PARAMS', `memory ${params.id} is expired — reactivate it first (expire-memory reactivate:true) or create a new memory`) },
            warnings,
          };
        }
        let vec: Float32Array | undefined;
        if (this.embedder) vec = await this.embedder.embedQuery(params.content as string);
        const now = new Date().toISOString();
        const newId = this.db.transaction(() => {
          const id = versionMemory(this.db, existing, {
            content: params.content as string,
            category: params.category !== undefined ? params.category : existing.category,
            metadataJson: params.metadata !== undefined ? JSON.stringify(params.metadata) : existing.metadata_json,
            evidence: params.evidence,
            now,
            changedBy: params.changed_by,
          }, vec);
          // The new version carries the old one's subjects; given ones replace them (#554).
          if (subjects) replaceSubjects(this.db, id, subjects, setBy, now);
          return id;
        })();
        const created = this.stmtGetById.get(newId);
        if (!created) return { result: { ok: false, error: err('INTERNAL_ERROR', `memory ${newId} vanished during update`) }, warnings };
        return {
          result: ok({ ...this.withSubjectsOf(toMemory(created)), operation: 'update', superseded: [{ id: existing.id, content: existing.content, reason: 'superseded-by-update' }] }),
          warnings,
        };
      }

      const now = new Date().toISOString();
      const txn = this.db.transaction(() => {
        // Keep the values an in-place edit replaces (#300); content changes version instead.
        const previous: Record<string, unknown> = {};
        if (params.category !== undefined && params.category !== existing.category) previous.category = existing.category;
        if (params.metadata !== undefined && JSON.stringify(params.metadata) !== existing.metadata_json) {
          previous.metadata = existing.metadata_json !== null ? parseMetadata(existing.metadata_json) : null;
        }
        // Subjects change in place too, keeping the names they replace (#554).
        const previousSubjects = subjects ? replaceSubjects(this.db, existing.id, subjects, setBy, now) : null;
        if (previousSubjects !== null) previous.subjects = previousSubjects;
        const changed = Object.keys(previous).length > 0;
        if (changed) {
          recordMemoryHistory(this.db, existing.id, 'edited', params.changed_by !== undefined ? `edited by ${params.changed_by}` : null, previous, now);
        }
        const sets: string[] = [];
        const args: unknown[] = [];
        // Only an edit that changed something makes the client the row's last writer.
        if (changed && params.changed_by !== undefined) {
          sets.push('changed_by = ?');
          args.push(params.changed_by);
        }
        if (params.category !== undefined) {
          sets.push('category = ?');
          args.push(params.category);
        }
        if (params.metadata !== undefined) {
          sets.push('metadata_json = ?');
          args.push(JSON.stringify(params.metadata));
        }
        sets.push('updated_at = ?');
        args.push(now);
        args.push(params.id);
        this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...args);
      });
      txn();

      const updated = this.stmtGetById.get(params.id);
      if (!updated) return { result: { ok: false, error: err('INTERNAL_ERROR', `memory ${params.id} vanished during update`) }, warnings };
      return { result: ok({ ...this.withSubjectsOf(toMemory(updated)), operation: 'update', superseded: [] }), warnings };
    } catch (e) {
      return { result: { ok: false, error: err('INTERNAL_ERROR', e instanceof Error ? e.message : String(e)) }, warnings };
    }
  }

  // -------------------------------------------------------------------------
  // expire-memory
  // -------------------------------------------------------------------------

  async expire(params: ExpireMemoryArgs): Promise<{ result: ServiceResult<ExpireMemoryOk>; warnings: MemoryWarning[] }> {
    const warnings: MemoryWarning[] = [];
    try {
      const existing = this.stmtGetById.get(params.id);
      if (!existing) return { result: { ok: false, error: err('NOT_FOUND', `no memory ${params.id}`) }, warnings };
      const now = new Date().toISOString();

      if (params.reactivate) {
        if (params.superseded_by !== undefined || params.invalid_at !== undefined) {
          return { result: { ok: false, error: err('INVALID_PARAMS', 'reactivate cannot be combined with superseded_by or invalid_at') }, warnings };
        }
        if (existing.expired_at === null) {
          return { result: ok({ ...toMemory(existing), already_live: true, reason: params.reason } as ExpireMemoryOk & { reason: string }), warnings };
        }
        // A memory retired before it had a vector comes back live without one; embed it now so
        // vector dedup and near-pairs see it (#300). Best-effort: the startup backfill retries.
        let vec: Float32Array | undefined;
        if (this.embedder && existing.vec_id === null) {
          try {
            vec = await this.embedder.embedQuery(existing.content);
          } catch (e) {
            console.warn(`[memories] reactivated memory ${existing.id} left unembedded: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // Re-read inside the transaction: the embed above awaited, so another call may have
        // purged, reactivated, or reactivated-and-re-expired (e.g. superseded) the row meanwhile.
        // Only the expiry this call read is reactivated.
        const outcome = this.db.transaction((): 'reactivated' | 'gone' | 'live' | 'changed' => {
          const current = getMemoryRow(this.db, existing.id);
          if (!current) return 'gone';
          if (current.expired_at === null) return 'live';
          if (current.expired_at !== existing.expired_at || current.expire_reason !== existing.expire_reason
            || current.superseded_by !== existing.superseded_by) return 'changed';
          // Keep the expiry the reactivation clears (#300).
          recordMemoryHistory(this.db, current.id, 'reactivated', params.reason, {
            expired_at: current.expired_at,
            expire_reason: current.expire_reason,
            superseded_by: current.superseded_by,
            invalid_at: current.invalid_at,
          }, now);
          this.db.prepare(
            'UPDATE memories SET expired_at = NULL, invalid_at = NULL, expire_reason = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?',
          ).run(now, params.id);
          if (params.changed_by !== undefined) markChangedBy(this.db, current.id, params.changed_by);
          if (vec && current.vec_id === null) insertMemoryVector(this.db, current.id, vec);
          return 'reactivated';
        })();
        if (outcome === 'gone') return { result: { ok: false, error: err('NOT_FOUND', `no memory ${params.id}`) }, warnings };
        if (outcome === 'changed') {
          return { result: { ok: false, error: err('CONFLICT', `memory ${params.id} was retired again while it was being reactivated — read it and retry`) }, warnings };
        }
        const row = this.stmtGetById.get(params.id);
        if (!row) return { result: { ok: false, error: err('INTERNAL_ERROR', `memory ${params.id} vanished during reactivate`) }, warnings };
        if (outcome === 'live') return { result: ok({ ...toMemory(row), already_live: true, reason: params.reason } as ExpireMemoryOk & { reason: string }), warnings };
        return { result: ok({ ...toMemory(row), reactivated: true, reason: params.reason } as ExpireMemoryOk & { reason: string }), warnings };
      }

      if (params.superseded_by !== undefined) {
        if (params.superseded_by === params.id) {
          return { result: { ok: false, error: err('INVALID_PARAMS', 'a memory cannot supersede itself') }, warnings };
        }
        const winner = this.stmtGetById.get(params.superseded_by);
        if (!winner) return { result: { ok: false, error: err('INVALID_PARAMS', `superseded_by ${params.superseded_by} does not exist`) }, warnings };
        if (winner.expired_at !== null) {
          return { result: { ok: false, error: err('INVALID_PARAMS', `superseded_by ${params.superseded_by} is expired — the superseding memory must be live`) }, warnings };
        }
      }

      if (existing.expired_at !== null) {
        return { result: ok({ ...toMemory(existing), already_expired: true }), warnings };
      }
      const apart = this.db.transaction((): boolean => {
        if (params.unless_subjects_apart && params.superseded_by !== undefined) {
          const guard = SubjectGuard.build(this.db);
          const linked = guard.linkedOf([params.id, params.superseded_by]);
          if (guard.apart(linked.get(params.id) ?? [], linked.get(params.superseded_by) ?? [])) return true;
        }
        const expired = expireMemoryRow(this.db, params.id, { reason: params.reason, supersededBy: params.superseded_by, invalidAt: params.invalid_at, now });
        if (expired && params.changed_by !== undefined) markChangedBy(this.db, params.id, params.changed_by);
        // The memory that replaces it is about what it was about (#554).
        if (expired && params.superseded_by !== undefined) carrySubjects(this.db, params.id, params.superseded_by, now);
        return false;
      })();
      if (apart) {
        return { result: { ok: false, error: err('CONFLICT', `memories ${params.id} and ${params.superseded_by} are about different things of one kind, so neither replaces the other; nothing was changed`,
          { subjects_apart: true }) }, warnings };
      }
      const row = this.stmtGetById.get(params.id);
      if (!row) return { result: { ok: false, error: err('INTERNAL_ERROR', `memory ${params.id} vanished during expire`) }, warnings };
      return { result: ok(toMemory(row)), warnings };
    } catch (e) {
      return { result: { ok: false, error: err('INTERNAL_ERROR', e instanceof Error ? e.message : String(e)) }, warnings };
    }
  }

  // -------------------------------------------------------------------------
  // delete-memory
  // -------------------------------------------------------------------------

  async delete(params: DeleteMemoryArgs): Promise<{ result: ServiceResult<DeleteMemoryOk>; warnings: MemoryWarning[] }> {
    const warnings: MemoryWarning[] = [];
    try {
      const existing = this.stmtGetById.get(params.id);
      if (!existing) return { result: { ok: false, error: err('NOT_FOUND', `no memory ${params.id}`) }, warnings };

      if (!params.purge) {
        if (existing.expired_at !== null) {
          return { result: ok({ ...toMemory(existing), already_expired: true }), warnings };
        }
        const now = new Date().toISOString();
        expireMemoryRow(this.db, params.id, { reason: 'deleted', now });
        const row = this.stmtGetById.get(params.id);
        if (!row) return { result: { ok: false, error: err('INTERNAL_ERROR', `memory ${params.id} vanished during delete`) }, warnings };
        return { result: ok({ ...toMemory(row), operation: 'expired' }), warnings };
      }

      if (!params.confirm) {
        return { result: { ok: false, error: err('CONFIRMATION_REQUIRED', 'purge permanently deletes this memory, its vector, and any lineage links pointing at it — pass confirm: true to proceed') }, warnings };
      }
      const txn = this.db.transaction(() => {
        if (existing.vec_id !== null) this.stmtDeleteVec.run(existing.vec_id);
        this.db.prepare('DELETE FROM memory_history WHERE memory_id = ?').run(params.id);
        deleteSubjects(this.db, params.id);
        clearConsolidationPending(this.db, params.id);
        this.stmtDeleteMemory.run(params.id);
      });
      txn();
      // A purge leaves no row to carry the mark, so the log line is its only record.
      if (params.changed_by !== undefined) {
        console.warn(`[memories] memory ${existing.id} (source ${JSON.stringify(existing.source)}) purged by ${params.changed_by}`);
      }
      return { result: ok({ deleted: { id: existing.id, content: existing.content } }), warnings };
    } catch (e) {
      return { result: { ok: false, error: err('INTERNAL_ERROR', e instanceof Error ? e.message : String(e)) }, warnings };
    }
  }

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  get(params: GetMemoryArgs): ServiceResult<Memory & { lineage?: Memory[]; history?: MemoryHistoryEntry[] }> {
    try {
      const row = this.stmtGetById.get(params.id);
      if (!row) return { ok: false, error: err('NOT_FOUND', `no memory ${params.id}`) };
      return ok({
        ...this.withSubjectsOf(toMemory(row)),
        ...(params.include_lineage ? { lineage: this.withSubjects(lineageOf(this.db, params.id).map(toMemory)) } : {}),
        ...(params.include_history ? { history: memoryHistory(this.db, params.id) } : {}),
      });
    } catch (e) {
      return { ok: false, error: err('INTERNAL_ERROR', e instanceof Error ? e.message : String(e)) };
    }
  }

  /**
   * The vector a meaning-based memory search compares memories with (#560): the query embedded the
   * way memory content is, so the two sit in the same space. Null without an embedder; throws when
   * the embedder fails.
   */
  async embedSearchQuery(query: string): Promise<Float32Array | null> {
    return this.embedder ? this.embedder.embedQuery(query) : null;
  }

  listWithProvenance(params: ListMemoriesArgs, opts: ListMemoriesOptions = {}): ServiceResult<{ memories: Array<Memory & { distance?: number; provenance_observation: SourceObservation }>; total: number; query?: string; search_mode?: 'semantic' }> {
    return this.db.transaction(() => {
      const result = this.list(params, opts);
      if (!result.ok) return result;
      const at = new Date().toISOString();
      return ok({ ...result.data, memories: result.data.memories.map(memory => ({
        ...memory, provenance_observation: observeMemory(this.db, memory.id, at),
      })) });
    }).deferred();
  }

  /**
   * List memories newest first, or rank full-text matches when `query` is set
   * (FTS5 over content and category). Every filter, offset and the total apply
   * either way. With `opts.queryVector` (from `embedSearchQuery`), memories rank by how close
   * their meaning is instead (#560): cosine distance, closest first, returned as `distance`, up to
   * `opts.maxDistance` (default `MEMORY_SEARCH_MAX_DISTANCE`). Memories without a vector are left
   * out of that ranking.
   */
  list(params: ListMemoriesArgs, opts: ListMemoriesOptions = {}): ServiceResult<{ memories: Array<Memory & { distance?: number }>; total: number; query?: string; search_mode?: 'semantic' }> {
    const vector = opts.queryVector;
    const search = params.query !== undefined && vector === undefined;
    try {
      const conditions: string[] = [];
      const args: unknown[] = [];
      if (search) { conditions.push('memories_fts MATCH ?'); args.push(quoteFtsPunctuatedTerms(params.query!)); }
      if (params.source !== undefined) { conditions.push('m.source = ?'); args.push(params.source); }
      if (params.scope !== undefined) { conditions.push('m.scope = ?'); args.push(params.scope); }
      if (params.node_id !== undefined) { conditions.push('m.node_id = ?'); args.push(params.node_id); }
      if (params.category !== undefined) { conditions.push('m.category = ?'); args.push(params.category); }
      if (params.evidence_kind !== undefined) { conditions.push('m.evidence_kind = ?'); args.push(params.evidence_kind); }
      if (params.evidence_node_id !== undefined) { conditions.push('m.evidence_node_id = ?'); args.push(params.evidence_node_id); }
      if (params.ids !== undefined) {
        conditions.push(`m.id IN (${params.ids.map(() => '?').join(', ') || 'NULL'})`);
        args.push(...params.ids);
      }
      if (params.evidence_node_ids !== undefined) {
        conditions.push(`m.evidence_node_id IN (${params.evidence_node_ids.map(() => '?').join(', ') || 'NULL'})`);
        args.push(...params.evidence_node_ids);
      }
      if (params.evidence_ref !== undefined) { conditions.push('m.evidence_ref = ?'); args.push(params.evidence_ref); }
      // The projects `project_of` is filed under, when it is set.
      const projectIds = params.project_of !== undefined ? filedProjects(this.db, params.project_of).map(project => project.id) : [];
      const projectMarks = projectIds.map(() => '?').join(', ');
      if (params.project_of !== undefined) {
        // A project's memory set (#352): drawn from the project's own note or from a note that links,
        // from a field or its body, to one of those projects (#453, the rule `filedProjects` uses).
        // No project matches nothing.
        conditions.push(projectIds.length === 0 ? '0' : `(m.evidence_node_id IN (${projectMarks}) OR EXISTS (SELECT 1 FROM relationships r
          WHERE r.source_id = m.evidence_node_id AND r.resolved_target_id IN (${projectMarks})))`);
        args.push(...projectIds, ...projectIds);
      }
      if (params.subject_of !== undefined) {
        // The memories about a note (#554): a subject linked to it, or a name that now resolves to it alone.
        const condition = subjectOfCondition(this.db, params.subject_of);
        conditions.push(condition.sql);
        args.push(...condition.args);
      }
      if (params.evidence_conversation !== undefined) {
        // Chat stamps `<id>#<message>`, the conversation sweep the bare id (#300).
        const prefix = `${params.evidence_conversation}#`;
        conditions.push("m.evidence_kind = 'conversation' AND (m.evidence_ref = ? OR substr(m.evidence_ref, 1, ?) = ?)");
        args.push(params.evidence_conversation, prefix.length, prefix);
      }
      if (params.expire_reasons !== undefined) {
        // The memories another replaced, by why (#717): expired rows only, so the live-only rule is off.
        conditions.push(`m.expired_at IS NOT NULL AND m.expire_reason IN (${params.expire_reasons.map(() => '?').join(', ') || 'NULL'})`);
        args.push(...params.expire_reasons);
      }
      addTemporalReadConditions(conditions, args, params.expire_reasons !== undefined ? { ...params, include_superseded: true } : params, 'm');
      // A meaning-based search scans every vector the filters leave, not a vec0 KNN: the KNN's
      // top k is taken before the filters, so a narrow filter could find nothing. A scan of a few
      // thousand vectors is a few milliseconds (as consolidation replay does). Memories past the
      // cut-off are left out of the rows and the total alike.
      if (vector) {
        conditions.push('vec_distance_cosine(v.vector, ?) <= ?');
        args.push(floatsToBytes(vector), opts.maxDistance ?? MEMORY_SEARCH_MAX_DISTANCE);
      }
      const from = search ? 'memories_fts f JOIN memories m ON m.id = f.rowid'
        : vector ? 'memories m JOIN memory_embedding_vec v ON v.id = m.vec_id'
        : 'memories m';
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const totalRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM ${from} ${whereClause}`).get(...args) as { cnt: number };
      // A project's set lists the most specific memories first (#352): the project's own note, then
      // notes filed under the fewest projects, counted by the same rule as membership. A summary note
      // filed under a dozen projects lends its memories to every one of them, and newest-first let
      // those crowd out the project's own.
      const specificFirst = params.project_of !== undefined && projectIds.length > 0 && !search && !vector;
      const order = search ? 'rank'
        : vector ? 'distance ASC, m.id DESC'
        : specificFirst ? `m.evidence_node_id IN (${projectMarks}) DESC, (SELECT count(DISTINCT r2.resolved_target_id) FROM relationships r2
            JOIN node_types t2 ON t2.node_id = r2.resolved_target_id AND t2.schema_type = ?
            WHERE r2.source_id = m.evidence_node_id AND r2.resolved_target_id != r2.source_id) ASC, ${NEWEST_FIRST}`
        : NEWEST_FIRST;
      const orderArgs = specificFirst ? [...projectIds, getWikiConfig(this.db).projectType] : [];
      const select = vector ? 'm.*, vec_distance_cosine(v.vector, ?) AS distance' : 'm.*';
      const rows = this.db
        .prepare(`SELECT ${select} FROM ${from} ${whereClause} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...(vector ? [floatsToBytes(vector)] : []), ...args, ...orderArgs, params.limit, params.offset) as Array<MemoryRow & { distance?: number }>;
      if (vector) {
        return ok({
          memories: this.withSubjects(rows.map(row => ({ ...toMemory(row), distance: row.distance! }))),
          total: totalRow.cnt,
          ...(params.query !== undefined ? { query: params.query } : {}),
          search_mode: 'semantic' as const,
        });
      }
      return ok({ memories: this.withSubjects(rows.map(toMemory)), total: totalRow.cnt, ...(search ? { query: params.query } : {}) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (search && FTS_QUERY_ERROR.test(message)) {
        return { ok: false, error: err('INVALID_PARAMS', `Invalid FTS5 query syntax: ${message}. Put a term with punctuation in double quotes, e.g. "vault-engine".`) };
      }
      return { ok: false, error: err('INTERNAL_ERROR', message) };
    }
  }

  nearPairs(params: NearPairsArgs): { result: ServiceResult<{ pairs: Array<{ a: NearPairMember; b: NearPairMember; distance: number; subjects_apart: boolean }>; total_in_band: number; considered: number; skipped_unembedded: number }>; warnings: MemoryWarning[] } {
    const warnings: MemoryWarning[] = [];
    try {
      if (params.near >= params.far) return { result: { ok: false, error: err('INVALID_PARAMS', 'near must be less than far') }, warnings };
      const result: NearPairsResult = computeNearPairs(this.db, { near: params.near, far: params.far, limit: params.limit });
      if (result.truncated) {
        warnings.push({ code: 'RESULT_TRUNCATED', severity: 'warning', message: 'more live embedded memories than the pairwise cap — only the most recent were compared' });
      }
      const member = (row: MemoryRow): NearPairMember => {
        const note = memoryNoteContext(this.db, row.evidence_node_id);
        return { ...toMemory(row), note_date: note?.date ?? null, note_title: note?.title ?? null, note_projects: note?.projects ?? [] };
      };
      // Whether each pair's subjects keep it apart, as create and the replay ask (#718): the
      // Curator's reconcile ledgers such a pair without a model call and never merges it.
      const guard = SubjectGuard.build(this.db);
      const linked = guard.linkedOf(result.pairs.flatMap((p) => [p.a_id, p.b_id]));
      const pairs = result.pairs.map((p) => {
        const a = this.stmtGetById.get(p.a_id);
        const b = this.stmtGetById.get(p.b_id);
        return a && b ? { a: member(a), b: member(b), distance: p.distance,
          subjects_apart: guard.apart(linked.get(p.a_id) ?? [], linked.get(p.b_id) ?? []) } : null;
      }).filter((p): p is NonNullable<typeof p> => p !== null);
      return {
        result: ok({ pairs, total_in_band: result.total_in_band, considered: result.considered, skipped_unembedded: result.skipped_unembedded }),
        warnings,
      };
    } catch (e) {
      return { result: { ok: false, error: err('INTERNAL_ERROR', e instanceof Error ? e.message : String(e)) }, warnings };
    }
  }

  // -------------------------------------------------------------------------
  // Projection snapshot (Task 2 — full consistent stock read)
  // -------------------------------------------------------------------------

  snapshotAll(): MemoryProjectionRow[] {
    // One consistent read transaction: better-sqlite3 transactions are
    // serializable snapshot isolation in WAL mode, so the rows + the reverse
    // superseded_by map see the same DB state even if a concurrent writer
    // lands between the two reads.
    const txn = this.db.transaction((): MemoryProjectionRow[] => {
      const rows = this.db.prepare(
        `SELECT * FROM memories ORDER BY id ASC`,
      ).all() as MemoryRow[];
      const subjectNamesById = allSubjectNames(this.db);
      const supersededByMap = new Map<number, number[]>();
      for (const r of rows) {
        if (r.superseded_by !== null) {
          const list = supersededByMap.get(r.superseded_by);
          if (list) list.push(r.id);
          else supersededByMap.set(r.superseded_by, [r.id]);
        }
      }
      return rows.map((r): MemoryProjectionRow => {
        let metadata: Record<string, unknown> | null = null;
        if (r.metadata_json !== null) {
          try {
            metadata = JSON.parse(r.metadata_json) as Record<string, unknown>;
          } catch {
            metadata = {};
          }
        }
        return {
          id: r.id,
          source: r.source,
          scope: r.scope === 'node' ? 'node' : 'vault',
          node_id: r.node_id,
          content: r.content,
          category: r.category,
          metadata,
          created_at: r.created_at,
          updated_at: r.updated_at,
          expired_at: r.expired_at,
          valid_at: r.valid_at,
          invalid_at: r.invalid_at,
          superseded_by: r.superseded_by,
          predecessors: (supersededByMap.get(r.id) ?? []).sort((a, b) => a - b),
          evidence_kind: r.evidence_kind,
          evidence_node_id: r.evidence_node_id,
          evidence_hash: r.evidence_hash,
          evidence_ref: r.evidence_ref,
          expire_reason: r.expire_reason,
          changed_by: r.changed_by ?? null,
          embedded: r.vec_id !== null,
          subjects: subjectNamesById.get(r.id) ?? [],
        };
      });
    });
    return txn();
  }
}

// (decideTier is exported above; no local duplicate needed.)
