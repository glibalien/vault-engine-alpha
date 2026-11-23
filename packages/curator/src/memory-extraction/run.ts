import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RUN_CONSOLIDATION_SOURCE, budgetRefusalDetail, isBudgetRefusal } from '../budget.js';
import { vaultOf, type Config } from '../config.js';
import { stripCaptureBlocksForMemory } from '../conversation-capture-markers.js';
import { forgetLedgerHash, ledgerHash, upsertLedger } from '../db/memory-sweep.js';
import { recordOnDemandRunOperation, renameOnDemandRunOperation, type OnDemandRunRow } from '../db/on-demand-runs.js';
import type { RunTrigger } from '../db/runs.js';
import { EngineError, type Engine, type MemoryState } from '../engine.js';
import { isJournalNoteTitle } from '../journal/render.js';
import { SPEND_LIMIT_TEXT } from '../llm/diagnostics.js';
import { extractNoteFacts, parseUnsupportedIds } from '../memory-sweep.js';
import { runCeiling, type RunCeiling } from '../on-demand/ceiling.js';
import { metered, roundUsd, sampleEstimate } from '../on-demand/cost.js';
import {
  ON_DEMAND_LIMITS,
  OnDemandError,
  asRequestError,
  checkQueryKeys,
  databaseOf,
  executeOnDemandRun,
  interrupted,
  missingKey,
  onDemandStatus,
  runFacts,
  startOnDemandRun,
  stoppedAfterFailures,
  stoppedAtLimit,
  undoOnDemandRun,
  type JournalTask,
  type OnDemandDeps,
  type OnDemandJobSpec,
  type OnDemandRunFacts,
  type OnDemandUndo,
  type RecordedUndo,
  type RunEnd,
  type StartedRun,
} from '../on-demand/run.js';
import { isUnderPathPrefix } from '../org-sweep.js';
import { catalogPricing } from '../pricing.js';
import type { HashedNodeRef, Memory, MemoryProposal } from '../types.js';

/**
 * Memory extraction on demand (#659): read the notes a query selects for durable facts, as the
 * nightly memory sweep reads the notes that changed, over a set the caller chooses.
 *
 * The nightly sweep reads 50 notes a night and keeps 25 facts, sized for a vault that is caught
 * up; a newly organized vault of a few thousand notes would take months. A run is the sweep's
 * call per note (`extractNoteFacts`: the same prompt, ALREADY KNOWN block, owner line and
 * re-verify of the note's earlier facts) with these differences:
 *
 * - **Its own dollar limit, which pays for the Engine's share too** (owner, 2026-11-20). Each memory
 *   a run writes is checked against the memories already there by the Engine's consolidation model,
 *   on the Engine's key. The run names itself on each write (`RUN_CONSOLIDATION_SOURCE` and its ref),
 *   so the check's cost is charged to the run's limit and left out of the daily cap's tally, and the
 *   preview estimates it.
 * - **The sweep's allowlist bounds it when the owner has set one** (owner, 2026-11-20): a note is then
 *   read only when it is of a kind in `memorySweepTypes` or under a folder in `memorySweepPaths`, as at
 *   night. Both empty (a new install, where the installer turns the nightly sweep off) means the run's
 *   own query decides. Wiki pages, notes in the settings folder and the Curator's journal are never
 *   read either way (`neverRead`, the Engine's rule for the user's own notes): memories drawn from a
 *   wiki page would be the Curator's own writing read back as fact.
 * - **Facts per note** default to the sweep's `memorySweepNoteCap`; a request may raise it to
 *   `maxFactsPerNote` (owner, 2026-11-20). There is no cap on facts per run: the limit is the brake.
 * - **It shares the sweep's ledger.** A note the sweep or a run has read at its current text is not
 *   in scope, and a note a run reads is not read again at night until it changes.
 * - **Undo** (owner, 2026-11-20) retires the memories the run added, brings back the ones it replaced
 *   or retired as no longer supported by their note, and forgets that it read the notes it took
 *   memories from. A memory changed since (retired, replaced, or brought back by someone else) is
 *   left as it is and counted.
 *
 * What a run shares with every other on-demand job is `../on-demand/run.ts`. This file is the job.
 */

export const EXTRACTION_RUN_JOB = 'extract-memories' as const;

export const EXTRACTION_RUN_LIMITS = {
  ...ON_DEMAND_LIMITS,
  /** Notes per turn in the curation queue: one call each, often half a minute with reasoning. */
  batch: 5,
  /** Most facts a request may ask for from one note. */
  maxFactsPerNote: 10,
  /** Notes per page when listing a scope. */
  scanPage: 200,
  /** Most pages one listing reads. */
  maxScanPages: 2_500,
  /** Most notes one run takes on; the rest wait for the next run. */
  maxNotes: 20_000,
  /** Earlier facts of one note fetched for its re-verify, as at night. */
  priorFacts: 50,
  /** Days of the Engine's consolidation checks an estimate averages over. */
  checkCostDays: 30,
  /**
   * About how long the Engine takes to write one memory, its consolidation check included. A run
   * writes them one at a time after each note's model call, and the sample times only the calls,
   * so the time estimate adds this per expected fact (#707). Measured on the first two production
   * runs (2026-11-20): 14 and 26 seconds a memory.
   */
  engineWriteSeconds: 20,
} as const;

/** The Engine's consolidation checks, as the usage ledger records them: live writes and the
 *  nightly sweep under one purpose, a run's own checks under another (#659). */
const CHECK_PURPOSES = ['memory-consolidation', 'memory-consolidation-run'] as const;

/** The filters a run's query may use: query-nodes' own, without joins and without search. */
export const EXTRACTION_QUERY_KEYS: readonly string[] = [
  'types', 'without_types', 'node_ids', 'without_node_ids', 'path_prefix', 'without_path_prefix', 'path_dir',
  'title_eq', 'title_contains', 'without_titles', 'without_title_contains', 'references', 'modified_since', 'created_since',
];

/** The reason an undo gives the memories it retires and brings back. */
const UNDO_REASON = 'extraction-run-undone';
/** The reason the re-verify gives a memory its note no longer supports, as at night. */
const UNSUPPORTED_REASON = 'evidence-changed';

/** The job as the shared runner sees it. The model is the nightly sweep's: `memorySweepModel`, or `model`. */
export function extractionRunJob(config: Pick<Config, 'memorySweepModel'>): OnDemandJobSpec {
  return {
    job: EXTRACTION_RUN_JOB, noun: 'memory extraction', modelSetting: config.memorySweepModel ? 'memorySweepModel' : 'model',
    journalFn: 'memory-sweep', undo: undoRecordedExtraction,
  };
}

function modelOf(deps: OnDemandDeps): { model: string; provider: string | null } {
  const model = deps.config.memorySweepModel ?? deps.config.model;
  return { model, provider: deps.config.modelProviders?.[model] ?? null };
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface ExtractionRequest {
  /** query-nodes filters; absent means every note the sweep's allowlist takes in. */
  query?: Record<string, unknown>;
  /** Most facts kept from one note; absent means the sweep's `memorySweepNoteCap`. */
  facts_per_note?: number;
}

export function normalizeExtractionRequest(input: {
  query?: Record<string, unknown> | undefined; facts_per_note?: number | undefined;
}): ExtractionRequest {
  const query = input.query !== undefined && Object.keys(input.query).length > 0 ? input.query : undefined;
  checkQueryKeys(query, EXTRACTION_QUERY_KEYS);
  const perNote = input.facts_per_note;
  if (perNote !== undefined && (!Number.isInteger(perNote) || perNote < 1 || perNote > EXTRACTION_RUN_LIMITS.maxFactsPerNote)) {
    throw new OnDemandError('INVALID_PARAMS', `facts_per_note: a whole number from 1 to ${EXTRACTION_RUN_LIMITS.maxFactsPerNote}.`);
  }
  return { ...(query === undefined ? {} : { query }), ...(perNote === undefined ? {} : { facts_per_note: perNote }) };
}

function factsPerNote(config: Pick<Config, 'memorySweepNoteCap'>, request: ExtractionRequest): number {
  return request.facts_per_note ?? config.memorySweepNoteCap;
}

// ---------------------------------------------------------------------------
// The notes in scope
// ---------------------------------------------------------------------------

/** The kinds and folders the memory sweep reads, when the owner has named any. */
type Allowlist = { types: string[]; paths: string[] } | null;

/** The sweep's allowlist, or null when it names nothing: a new install, where the run's query alone decides. */
function allowlistOf(config: Pick<Config, 'memorySweepTypes' | 'memorySweepPaths'>): Allowlist {
  if (config.memorySweepTypes.length === 0 && config.memorySweepPaths.length === 0) return null;
  return { types: config.memorySweepTypes, paths: config.memorySweepPaths };
}

/** Whether the owner's allowlist takes in a note: one of its kinds, or under one of its folders. No allowlist takes in every note. */
function allowlisted(allow: Allowlist, note: { types: readonly string[]; file_path: string }): boolean {
  if (allow === null) return true;
  return note.types.some(type => allow.types.includes(type)) || allow.paths.some(prefix => isUnderPathPrefix(note.file_path, prefix));
}

/**
 * Notes a run never reads, whatever the allowlist: the suite's own writing. Wiki pages (the vault
 * map's wiki kind), notes in the settings folder, and the Curator's journal; the memory note and
 * the journal are also left out of every listing as suite notes. The Engine's `userNotesWhere`.
 */
function neverRead(config: Pick<Config, 'settingsDir' | 'vault'>, note: { title: string; types: readonly string[]; file_path: string }): boolean {
  const wikiType = vaultOf(config).wikiType;
  return isJournalNoteTitle(note.title)
    || (wikiType !== null && note.types.includes(wikiType))
    || isUnderPathPrefix(note.file_path, config.settingsDir?.trim() || 'Settings');
}

interface Scope {
  /** The notes a run would read, newest first. */
  notes: HashedNodeRef[];
  /** Notes the query selects that the allowlist keeps out. */
  outside: number;
  /** Notes the query selects that a run never reads: wiki pages, settings notes, the journal. */
  suite: number;
  /** Notes the query selects that the sweep or a run has already read at their current text. */
  alreadyRead: number;
  /** More notes were left than one run takes on. */
  truncated: boolean;
}

/** List a request's scope. No model call. Notes left out do not count toward the most one run takes on. */
async function scanScope(deps: OnDemandDeps, db: Database.Database, request: ExtractionRequest): Promise<Scope> {
  const allow = allowlistOf(deps.config);
  let outside = 0;
  let suite = 0;
  let alreadyRead = 0;
  let listed: Awaited<ReturnType<Engine['listNotesWithHashes']>>;
  try {
    listed = await deps.engine.listNotesWithHashes({
      ...(request.query === undefined ? {} : { filter: request.query }),
      pageLimit: EXTRACTION_RUN_LIMITS.scanPage, maxPages: EXTRACTION_RUN_LIMITS.maxScanPages, maxNodes: EXTRACTION_RUN_LIMITS.maxNotes,
      keep: note => {
        if (neverRead(deps.config, note)) { suite += 1; return false; }
        if (!allowlisted(allow, note)) { outside += 1; return false; }
        if (typeof note.content_hash === 'string' && ledgerHash(db, note.id) === note.content_hash) { alreadyRead += 1; return false; }
        return true;
      },
    });
  } catch (error) {
    throw asRequestError(error);
  }
  if (listed.truncated && listed.nodes.length < EXTRACTION_RUN_LIMITS.maxNotes) {
    throw new OnDemandError('SCOPE_TOO_LARGE', `More than ${(EXTRACTION_RUN_LIMITS.maxScanPages * EXTRACTION_RUN_LIMITS.scanPage).toLocaleString('en-US')} notes match. `
      + 'Narrow the scope: a kind with types, or a folder with path_prefix.');
  }
  return { notes: listed.nodes, outside, suite, alreadyRead, truncated: listed.truncated };
}

/** The memories the extraction prompt's ALREADY KNOWN block lists, as at night. Best-effort: none on a failed read. */
async function knownMemories(engine: Engine): Promise<Memory[]> {
  try {
    const [curator, owner] = await Promise.all([
      engine.listMemoriesWithTotal({ source: 'curator', scope: 'vault', limit: 100 }),
      engine.listMemoriesWithTotal({ source: 'owner', scope: 'vault', limit: 100 }),
    ]);
    return [...owner.memories, ...curator.memories];
  } catch (error) {
    warn('the known memories could not be read (notes are read without them)', error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// One note
// ---------------------------------------------------------------------------

/** What happened to one fact the model gave. */
type FactResult =
  /** Added as a new memory. */
  | { kind: 'created'; id: number }
  /** Written in place of older memories it updates or contradicts. */
  | { kind: 'replaced'; id: number; replaced: number[] }
  /** The Engine judged it already known: nothing written. */
  | { kind: 'already_known' }
  | { kind: 'duplicate' }
  | { kind: 'error' };

type NoteOutcome =
  /** Read. `results` are empty in a dry run, which writes nothing. */
  | { kind: 'read'; facts: MemoryProposal[]; results: FactResult[]; unsupported: number[]; expired: number; unmerged: number; engineKeySpent: boolean; writeErrors: number }
  | { kind: 'already_read' }
  /** No content hash, or capture markers it could not read: left for the owner, as at night. */
  | { kind: 'skipped' }
  /** Gone, or no longer in the allowlist, since the listing. */
  | { kind: 'changed' }
  | { kind: 'error'; asked: boolean; callFailed: boolean }
  /** The run's limit refused the call, or has no room for the Engine's checks of what it gave (`asked`). */
  | { kind: 'limit'; detail: string; asked?: true };

interface NoteWork {
  dryRun: boolean;
  runRef: string;
  purpose: 'memory-extraction-run' | 'memory-sweep';
  model: string;
  noteCap: number;
  known: readonly Memory[];
  /** Records one of the run's writes so its undo can take it back. Absent in a dry run. */
  record?: (operationId: string, nodeId: string) => void;
  /**
   * The run changed one of its own memories again (the Engine judged a later fact already known and
   * added that fact's subjects to it): its recorded last change moves too, so an undo does not take
   * the run's own change for someone else's. Absent in a dry run.
   */
  remark?: (memoryId: number) => Promise<void>;
  /** Where the Engine's consolidation check of a written memory is charged. */
  onSpend?: (usd: number | null) => void;
  /**
   * Whether the run's limit has room for the Engine's checks of this many facts, before any is
   * written: null when it has, else why not. The checks are charged only once made, so without
   * this a note of several facts could take a run past its limit (Codex, #705).
   */
  roomFor?: (facts: number) => Promise<string | null>;
}

function warn(message: string, error: unknown): void {
  console.warn(`[curator] memory extraction run: ${message}: ${error instanceof Error ? error.message : String(error)}`);
}

/** Write one fact as a vault memory drawn from the note, as the sweep does. Never throws. */
async function writeFact(deps: OnDemandDeps, work: NoteWork, fact: MemoryProposal, note: { id: string; hash: string }): Promise<FactResult & { consolidationFailure?: string }> {
  try {
    const written = await deps.engine.createMemory({
      source: 'curator', scope: 'vault', content: fact.content, category: fact.category,
      ...(fact.subjects && fact.subjects.length > 0 ? { subjects: fact.subjects } : {}),
      evidence: { kind: 'note', node_id: note.id, hash: note.hash },
      usage: { runRef: work.runRef, sourceRef: RUN_CONSOLIDATION_SOURCE, purpose: 'memory-consolidation-run' },
    }, { ...(work.onSpend === undefined ? {} : { onSpend: work.onSpend }), journal: false });
    const failure = written.consolidationFailure === undefined ? {} : { consolidationFailure: written.consolidationFailure };
    if (written.operation === 'noop') {
      await work.remark?.(written.id);
      return { kind: 'already_known', ...failure };
    }
    // The memory's last change as the run left it: an undo leaves alone a memory changed since.
    const at = written.updatedAt === undefined ? '' : `@${written.updatedAt}`;
    if (written.superseded.length > 0) {
      work.record?.(`memory:${written.id}:replaced:${written.superseded.join(',')}${at}`, note.id);
      return { kind: 'replaced', id: written.id, replaced: written.superseded, ...failure };
    }
    work.record?.(`memory:${written.id}${at}`, note.id);
    return { kind: 'created', id: written.id, ...failure };
  } catch (error) {
    if (error instanceof EngineError && error.code === 'DUPLICATE_MEMORY') return { kind: 'duplicate' };
    warn('a memory could not be written', error);
    return { kind: 'error' };
  }
}

/**
 * Read one note for durable facts and write them, as the nightly sweep does. Never throws.
 *
 * A note is marked read in the sweep's ledger only when everything it gave was written: a write
 * that failed leaves it to be read again, by the next run or at night once it changes.
 */
async function extractOneNote(deps: OnDemandDeps, db: Database.Database, work: NoteWork, ref: HashedNodeRef): Promise<NoteOutcome> {
  let node: Awaited<ReturnType<Engine['getNode']>>;
  try {
    node = await deps.engine.getNode(ref.id);
  } catch (error) {
    if (error instanceof EngineError && error.code === 'NOT_FOUND') return { kind: 'changed' };
    warn(`read failed for "${ref.title}"`, error);
    return { kind: 'error', asked: false, callFailed: false };
  }
  const hash = node.metadata?.content_hash;
  if (!hash) return { kind: 'skipped' };
  if (ledgerHash(db, ref.id) === hash) return { kind: 'already_read' };
  // The note as it is now: one that left the allowlist since the listing is not read.
  const shown = { title: node.title ?? ref.title, file_path: node.file_path ?? ref.file_path, types: node.types ?? ref.types };
  if (!allowlisted(allowlistOf(deps.config), shown) || neverRead(deps.config, shown)) return { kind: 'changed' };
  const stripped = stripCaptureBlocksForMemory(node.body ?? '');
  if (!stripped.ok) return { kind: 'skipped' };

  // The note's earlier facts, re-checked in the same call, as at night (§4a). Without them a note
  // that changed would be marked read and its stale facts never checked.
  let prior: Memory[] = [];
  if (deps.config.reverifyEnabled) {
    try {
      prior = await deps.engine.listMemories({ evidence_node_id: ref.id, limit: EXTRACTION_RUN_LIMITS.priorFacts });
    } catch (error) {
      warn(`the earlier facts of "${ref.title}" could not be read`, error);
      return { kind: 'error', asked: false, callFailed: false };
    }
  }

  let extracted: Awaited<ReturnType<typeof extractNoteFacts>>;
  try {
    const call = () => extractNoteFacts(deps.llm, deps.config, {
      model: work.model, note: { title: shown.title, file_path: shown.file_path, body: stripped.body, fields: node.fields },
      known: work.known, prior, noteCap: work.noteCap,
    });
    // Attributed in the call's own scope: a preview sends its calls side by side.
    const context = { project: EXTRACTION_RUN_JOB, runRef: work.runRef, purpose: work.purpose };
    extracted = await (deps.usage === undefined ? call() : deps.usage.withContext(context, call));
  } catch (error) {
    if (isBudgetRefusal(error)) return { kind: 'limit', detail: budgetRefusalDetail(error) };
    warn(`the model call failed for "${ref.title}"`, error);
    return { kind: 'error', asked: true, callFailed: true };
  }
  const unsupported = prior.length > 0 ? parseUnsupportedIds(extracted.output, new Set(prior.map(memory => memory.id))) : [];
  const read = { facts: extracted.facts, unsupported };
  if (work.dryRun) return { kind: 'read', ...read, results: [], expired: 0, unmerged: 0, engineKeySpent: false, writeErrors: 0 };
  // Nothing of the note is written when the limit cannot pay for its checks: it stays unread, for a later run.
  const refused = extracted.facts.length > 0 && work.roomFor !== undefined ? await work.roomFor(extracted.facts.length) : null;
  if (refused !== null) return { kind: 'limit', detail: refused, asked: true };

  // Retire the facts the note no longer supports first, so a reworded fact's replacement passes the
  // Engine's same-source dedup, as at night.
  let expired = 0;
  let writeErrors = 0;
  for (const id of unsupported) {
    try {
      const retired = await deps.engine.retireMemory(id, UNSUPPORTED_REASON);
      work.record?.(`retired:${id}${retired.updated_at === undefined ? '' : `@${retired.updated_at}`}`, ref.id);
      expired += 1;
    } catch (error) {
      writeErrors += 1;
      warn(`memory ${id}, no longer supported by "${ref.title}", could not be retired`, error);
    }
  }
  const results: FactResult[] = [];
  let unmerged = 0;
  let engineKeySpent = false;
  for (const fact of extracted.facts) {
    const result = await writeFact(deps, work, fact, { id: ref.id, hash });
    if (result.kind === 'error') writeErrors += 1;
    if (result.consolidationFailure !== undefined) {
      unmerged += 1;
      if (SPEND_LIMIT_TEXT.test(result.consolidationFailure)) engineKeySpent = true;
    }
    results.push(result);
  }
  if (writeErrors === 0) upsertLedger(db, ref.id, hash, new Date().toISOString());
  return { kind: 'read', ...read, results, expired, unmerged, engineKeySpent, writeErrors };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface ExtractionSampleNote {
  id: string;
  title: string;
  path: string;
  /** The facts the model would keep from the note: none is the usual answer. */
  facts: MemoryProposal[];
  /** Earlier facts from this note the model says its text no longer supports: a run retires them. */
  no_longer_supported: number;
}

/** What the Engine's consolidation checks would add to a run's cost, estimated from its recent checks. */
export interface EngineShare {
  /** At most this: each fact checked once, at the average cost of a check over the last days. Fewer are checked. */
  estimated_usd: number | null;
  /** The provider the Engine's recent checks went to. */
  provider: string | null;
  /** What one check cost on average. */
  per_check_usd: number | null;
  note: string;
}

export interface ExtractionPreview {
  /** Notes a run would read. */
  notes: number;
  /** Notes the query selects that the sweep or a run has already read at their current text: a run leaves them. */
  already_read: number;
  /** Notes the query selects that the allowlist keeps out. */
  outside_allowlist: number;
  /** Notes the query selects that a run never reads: wiki pages, notes in the settings folder, the Curator's journal. */
  never_read: number;
  /** The kinds and folders that bound every run; null when the owner has named none and the query alone decides. */
  allowlist: { types: string[]; paths: string[] } | null;
  facts_per_note: number;
  scope_note: string | null;
  model: string;
  provider: string | null;
  sample: ExtractionSampleNote[];
  sample_asked: number;
  /** What the sample cost, charged to the daily cap. */
  sample_cost_usd: number | null;
  /** The model's share of a run: the sample's average cost per note times the notes in scope. */
  estimated_cost_usd: number | null;
  /** The Engine's share: its consolidation checks of the memories written. */
  engine: EngineShare;
  /** Both shares together: what a run's limit has to cover. */
  estimated_total_usd: number | null;
  estimated_minutes: number | null;
  sample_note: string | null;
  run_ceiling: RunCeiling | null;
}

/** The notes a preview reads: spread evenly through the scope, not its first few. */
function sampleOf<T>(items: readonly T[], wanted: number): T[] {
  if (items.length <= wanted) return [...items];
  return Array.from({ length: wanted }, (_, index) => items[Math.floor((index * items.length) / wanted)]!);
}

function scopeNote(scope: Scope, allow: Allowlist, request: ExtractionRequest): string | null {
  const parts: string[] = [];
  // query-nodes reads several types as "has all of them", so two kinds usually match nothing (#707).
  const types = request.query?.['types'];
  if (Array.isArray(types) && types.length > 1 && scope.notes.length + scope.alreadyRead + scope.outside + scope.suite === 0) {
    parts.push(`No note has all of the kinds in types (${types.join(', ')}): types means every one of them, not any. `
      + 'Give one kind per request, or leave types out to take every kind the memory sweep reads.');
  }
  if (scope.outside > 0 && allow !== null) {
    const kinds = allow.types.length > 0 ? `kinds ${allow.types.join(', ')}` : null;
    const folders = allow.paths.length > 0 ? `folders ${allow.paths.join(', ')}` : null;
    parts.push(`${scope.outside} more note(s) match but are outside what the memory sweep reads (${[kinds, folders].filter(Boolean).join('; ')}: `
      + 'the curator settings memorySweepTypes and memorySweepPaths, which the owner sets), so they are not in scope.');
  }
  if (scope.suite > 0) {
    parts.push(`${scope.suite} more note(s) match but are wiki pages, notes in the settings folder or the Curator's journal, which are never read for memories.`);
  }
  if (scope.alreadyRead > 0) {
    parts.push(`${scope.alreadyRead} more note(s) match but were already read for memories at their current text, by the nightly sweep or a run, `
      + 'so they are not read again until they change.');
  }
  if (scope.truncated) {
    parts.push(`More than ${EXTRACTION_RUN_LIMITS.maxNotes.toLocaleString('en-US')} notes are left to read; one run takes the newest `
      + `${EXTRACTION_RUN_LIMITS.maxNotes.toLocaleString('en-US')}, and a run started after it takes the rest.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/** What the Engine's consolidation checks cost over the last days, on average, and where most went:
 *  live and nightly checks with runs' own (#707). Best-effort: null when unknown. */
async function recentChecks(deps: OnDemandDeps): Promise<{ perCheckUsd: number; provider: string | null } | null | 'unread'> {
  const since = new Date(Date.now() - EXTRACTION_RUN_LIMITS.checkCostDays * 86_400_000).toISOString();
  try {
    const reports = await Promise.all(CHECK_PURPOSES.map(purpose => deps.engine.usageReport({ purpose, since, group_by: ['provider'], limit: 10 })));
    let events = 0;
    let cost = 0;
    const byProvider = new Map<string, number>();
    for (const { data } of reports) {
      const purposeEvents = Number(data.totals['events'] ?? 0);
      if (!(purposeEvents > 0)) continue;
      const purposeCost = Number(data.totals['cost_usd'] ?? Number.NaN);
      if (!Number.isFinite(purposeCost)) return null;
      events += purposeEvents;
      cost += purposeCost;
      for (const group of data.groups) {
        if (typeof group['provider'] !== 'string') continue;
        byProvider.set(group['provider'], (byProvider.get(group['provider']) ?? 0) + Number(group['events'] ?? 0));
      }
    }
    if (!(events > 0)) return null;
    const top = [...byProvider.entries()].sort((a, b) => b[1] - a[1])[0];
    return { perCheckUsd: cost / events, provider: top?.[0] ?? null };
  } catch (error) {
    warn('the cost of the Engine\'s consolidation checks could not be read', error);
    return 'unread';
  }
}

/** The Engine's share of a run, from what its consolidation checks cost over the last days. */
async function engineShare(deps: OnDemandDeps, facts: number | null): Promise<EngineShare> {
  const recent = await recentChecks(deps);
  if (recent === 'unread') {
    return { estimated_usd: null, provider: null, per_check_usd: null, note: 'The cost of the Engine\'s consolidation checks could not be read. The run\'s limit still covers it.' };
  }
  if (recent === null) {
    return { estimated_usd: null, provider: null, per_check_usd: null, note: 'The Engine made no consolidation check in the last '
      + `${EXTRACTION_RUN_LIMITS.checkCostDays} days, so its share cannot be estimated. The run's limit still covers it.` };
  }
  return {
    estimated_usd: facts === null ? null : Math.ceil(recent.perCheckUsd * facts * 100) / 100,
    provider: recent.provider,
    per_check_usd: roundUsd(recent.perCheckUsd),
    note: 'The Engine checks each memory a run writes against the memories already there, with its consolidation model on the Engine\'s key. '
      + `This is an estimate, not a ceiling: the average check of the last ${EXTRACTION_RUN_LIMITS.checkCostDays} days for each fact the sample suggests. `
      + 'Only a memory close to an existing one is checked, but a check against many close memories (a busy project) costs more than the average. '
      + 'The run\'s limit pays for it: before a note\'s memories are written, the run makes sure what is left of its limit covers twice the average '
      + 'check for each.',
  };
}

/**
 * What a run would cover and cost: the notes in scope, the facts the model would keep from a few
 * notes spread through it, and an estimate of both shares of a run's cost. The sample's calls are
 * real and paid from the daily cap; nothing is written and no note is marked read.
 */
export async function previewExtraction(deps: OnDemandDeps, input: {
  query?: Record<string, unknown> | undefined; facts_per_note?: number | undefined; sample?: number | undefined;
}): Promise<{ request: ExtractionRequest; preview: ExtractionPreview }> {
  const request = normalizeExtractionRequest(input);
  const spec = extractionRunJob(deps.config);
  const { model, provider } = modelOf(deps);
  const db = databaseOf(deps);
  const allow = allowlistOf(deps.config);
  const scope = await scanScope(deps, db, request);
  const wanted = Math.min(input.sample ?? EXTRACTION_RUN_LIMITS.defaultSample, EXTRACTION_RUN_LIMITS.maxSample);
  const chosen = sampleOf(scope.notes, wanted);
  const noteCap = factsPerNote(deps.config, request);

  const sample: ExtractionSampleNote[] = [];
  const meter = metered(deps.llm, catalogPricing(deps.config));
  let sampleNote: string | null = null;
  let sampledFacts = 0;
  let sampledNotes = 0;
  const noKey = missingKey(deps, model, provider, spec.modelSetting);
  if (chosen.length > 0 && noKey !== null) {
    sampleNote = `No sample was run: ${noKey}`;
  } else if (chosen.length > 0) {
    const work: NoteWork = { dryRun: true, runRef: randomUUID(), purpose: 'memory-sweep', model, noteCap, known: await knownMemories(deps.engine) };
    let stopped: string | null = null;
    let failed = 0;
    // In the queue, like every model call. The sample's calls go out side by side: one after
    // another they could run past the 300 seconds an MCP client waits for a silent tool.
    await deps.queue.enqueue('memory extraction preview', async () => {
      const outcomes = await Promise.all(chosen.map(ref => extractOneNote({ ...deps, llm: meter.llm }, db, work, ref)));
      for (const [index, outcome] of outcomes.entries()) {
        const ref = chosen[index]!;
        if (outcome.kind === 'limit') stopped = outcome.detail;
        else if (outcome.kind === 'error' && outcome.callFailed) failed += 1;
        else if (outcome.kind === 'read') {
          sampledNotes += 1;
          sampledFacts += outcome.facts.length;
          sample.push({ id: ref.id, title: ref.title, path: ref.file_path, facts: outcome.facts, no_longer_supported: outcome.unsupported.length });
        }
      }
    });
    if (stopped !== null) {
      sampleNote = `The sample stopped early: ${stopped}. The sample is paid from the daily cap; a started run has its own limit.`;
    } else if (failed > 0) {
      sampleNote = `The model call failed for ${failed} of the ${chosen.length} sample notes. `
        + `The Curator's log has the reason; check the ${spec.modelSetting} setting and its provider.`;
    } else if (sample.length < chosen.length) {
      sampleNote = `${chosen.length - sample.length} of the ${chosen.length} sample notes gave no result (changed since the listing, or unreadable).`;
    }
  }

  const estimate = sampleEstimate(meter, scope.notes.length, catalogPricing(deps.config)(model) !== null);
  if (estimate.cost_unknown !== null) sampleNote = `${sampleNote === null ? '' : `${sampleNote} `}${estimate.cost_unknown}`;
  // The facts a run would write, from the sample's rate: each one may cost the Engine a check.
  const facts = sampledNotes > 0 ? Math.ceil((sampledFacts / sampledNotes) * scope.notes.length) : null;
  const engine = await engineShare(deps, facts);
  const total = estimate.estimated_cost_usd === null ? null
    : Math.ceil((estimate.estimated_cost_usd + (engine.estimated_usd ?? 0)) * 100) / 100;
  return {
    request,
    preview: {
      notes: scope.notes.length,
      already_read: scope.alreadyRead,
      outside_allowlist: scope.outside,
      never_read: scope.suite,
      allowlist: allow,
      facts_per_note: noteCap,
      scope_note: scopeNote(scope, allow, request),
      model,
      provider,
      sample,
      sample_asked: estimate.sample_asked,
      sample_cost_usd: estimate.sample_cost_usd,
      estimated_cost_usd: estimate.estimated_cost_usd,
      engine,
      estimated_total_usd: total,
      estimated_minutes: withEngineWrites(estimate.estimated_minutes, facts),
      sample_note: sampleNote,
      run_ceiling: runCeiling(deps),
    },
  };
}

/** The sample's model time with the Engine's writes added: a run writes each fact after its
 *  note's call, and the sample times only the calls (#707). */
function withEngineWrites(modelMinutes: number | null, facts: number | null): number | null {
  if (modelMinutes === null) return null;
  return modelMinutes + Math.ceil(((facts ?? 0) * EXTRACTION_RUN_LIMITS.engineWriteSeconds) / 60);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** What a run did. Notes are counted once each, facts once each. */
export interface ExtractionCounts {
  /** Notes a model call was made for. */
  asked: number;
  /** ...of which gave at least one fact. */
  with_facts: number;
  /** Notes skipped with no call: read at their current text since the listing. */
  already_read: number;
  /** Notes with no content hash or with capture markers that could not be read. */
  skipped: number;
  /** Notes gone, or out of the allowlist, since the listing. */
  changed: number;
  /** Notes whose read, call or a write failed. Such a note is not marked read. */
  errors: number;
  /** Facts the model gave. */
  facts: number;
  /** ...written as new memories. */
  created: number;
  /** ...written in place of older memories they update or contradict. */
  replaced: number;
  /** ...the Engine judged already known: nothing written. */
  already_known: number;
  duplicates: number;
  /** Memories the Engine added without checking them, because its check failed; they wait for replay-memory-consolidation. */
  unmerged: number;
  /** Earlier facts retired because their note no longer supports them. */
  retired: number;
  /** What the Engine's checks of the run's memories cost, as far as it reported: part of the run's spend. */
  engine_usd: number;
}

export const EMPTY_EXTRACTION_COUNTS: ExtractionCounts = {
  asked: 0, with_facts: 0, already_read: 0, skipped: 0, changed: 0, errors: 0,
  facts: 0, created: 0, replaced: 0, already_known: 0, duplicates: 0, unmerged: 0, retired: 0, engine_usd: 0,
};

export type ExtractionRunRow = OnDemandRunRow<ExtractionRequest, ExtractionCounts>;

function extractionRun(run: OnDemandRunRow<unknown, unknown>): ExtractionRunRow {
  return { ...run, request: { ...(run.request as ExtractionRequest) }, counts: { ...EMPTY_EXTRACTION_COUNTS, ...(run.counts as Partial<ExtractionCounts>) } };
}

/**
 * Accept a run and start it. On the server it continues in the background and this returns at
 * once; from the CLI it returns when the run has ended.
 */
export async function startExtraction(deps: OnDemandDeps, input: {
  query?: Record<string, unknown> | undefined; facts_per_note?: number | undefined; limitUsd?: number | undefined; trigger: RunTrigger;
}): Promise<StartedRun> {
  const request = normalizeExtractionRequest(input);
  const { model, provider } = modelOf(deps);
  const db = databaseOf(deps);
  let alreadyRead = 0;
  return startOnDemandRun(deps, extractionRunJob(deps.config), {
    request, counts: EMPTY_EXTRACTION_COUNTS, model, provider, limitUsd: input.limitUsd, trigger: input.trigger,
    countScope: async () => {
      const scope = await scanScope(deps, db, request);
      alreadyRead = scope.alreadyRead;
      return scope.notes.length;
    },
    nothingToDo: () => alreadyRead > 0
      ? `No note in scope is left to read: ${alreadyRead} were already read for memories at their current text. A note is read again once it changes.`
      : allowlistOf(deps.config) === null
        ? 'No note is in scope. Wiki pages, notes in the settings folder and the Curator\'s journal are never read.'
        : 'No note is in scope. A run reads only notes of the kinds and folders the memory sweep reads (the curator settings memorySweepTypes and '
          + 'memorySweepPaths, which the owner sets), and never wiki pages, settings notes or the Curator\'s journal.',
    execute: runId => runExtraction(deps, runId),
  });
}

function summaryLine(run: ExtractionRunRow, counts: ExtractionCounts, end: RunEnd, spentUsd: number): string {
  return `memory extraction run: ${end.status}; ${counts.asked} of ${run.notes} notes read, ${counts.with_facts} with facts; `
    + `${counts.facts} facts: ${counts.created} new memories, ${counts.replaced} replacing older ones, ${counts.already_known} already known, `
    + `${counts.duplicates} duplicate${counts.unmerged > 0 ? `, ${counts.unmerged} added without the Engine's check` : ''}; `
    + `${counts.retired} earlier facts retired; ${counts.already_read} already read, ${counts.changed} changed meanwhile, ${counts.skipped} skipped, `
    + `${counts.errors} errors; $${spentUsd.toFixed(4)} of $${run.limit_usd.toFixed(2)} ($${counts.engine_usd.toFixed(4)} of it the Engine's checks)`;
}

const ENGINE_KEY_SPENT: RunEnd = {
  status: 'stopped',
  detail: 'Stopped: the Engine\'s key for its consolidation model is out of budget, so new memories would be added without being checked against '
    + 'the ones already there. Memories already added that way wait for replay-memory-consolidation. Start the run again once the key has room.',
};

/**
 * The run itself: the scope is listed once, then read a batch of notes a turn. The shared runner
 * owns the loop and records the end. Returns the task that writes the run's journal entry.
 */
export function runExtraction(deps: OnDemandDeps, runId: string): Promise<JournalTask | null> {
  const spec = extractionRunJob(deps.config);
  return executeOnDemandRun(deps, spec, runId, (worker, stored) => {
    const db = databaseOf(deps);
    const run = extractionRun(stored);
    const counts: ExtractionCounts = { ...EMPTY_EXTRACTION_COUNTS };
    const stopped = interrupted(spec.job);
    let pending: HashedNodeRef[] | null = null;
    let known: Memory[] = [];
    let more = false;
    let failedInARow = 0;
    // What one Engine check is held at before a note's memories are written: twice the recent
    // average, or the dearest check this run has paid for when that is more. Unknown at first on a
    // vault whose Engine has made no check lately: the first note's checks then set it.
    /** The memories this run wrote, by id, with the operation id each is recorded under. */
    const ours = new Map<number, string>();
    let recentCheckUsd = 0;
    let dearestCheckUsd = 0;
    const checkHoldUsd = (): number => Math.max(2 * recentCheckUsd, dearestCheckUsd);

    const turn = async (): Promise<RunEnd | null> => {
      if (pending === null) {
        const scope = await scanScope(deps, db, run.request);
        pending = scope.notes;
        more = scope.truncated;
        known = await knownMemories(deps.engine);
        const recent = await recentChecks(deps);
        if (recent !== null && recent !== 'unread') recentCheckUsd = recent.perCheckUsd;
      }
      const work: NoteWork = {
        dryRun: false, runRef: run.id, purpose: 'memory-extraction-run', model: run.model,
        noteCap: factsPerNote(deps.config, run.request), known,
        record: (operationId, nodeId) => {
          recordOnDemandRunOperation(db, run.id, operationId, nodeId, new Date().toISOString());
          const write = recordedWrite(operationId);
          if (write?.kind === 'memory') ours.set(write.id, operationId);
        },
        remark: async memoryId => {
          const recorded = ours.get(memoryId);
          if (recorded === undefined) return;
          const state = await deps.engine.getMemoryState(memoryId).catch(() => null);
          if (state?.updated_at === undefined) return;
          const remarked = recorded.replace(/(?:@.*)?$/, `@${state.updated_at}`);
          renameOnDemandRunOperation(db, run.id, recorded, remarked);
          ours.set(memoryId, remarked);
        },
        onSpend: usd => {
          if (usd !== null) {
            counts.engine_usd = roundUsd(counts.engine_usd + usd);
            dearestCheckUsd = Math.max(dearestCheckUsd, usd);
          }
          worker.chargeRun?.(usd);
        },
        roomFor: async facts => {
          const hold = facts * checkHoldUsd();
          const left = worker.runLeftUsd === undefined ? null : await worker.runLeftUsd();
          if (left === null || hold <= 0 || left >= hold) return null;
          return `$${Math.max(0, left).toFixed(4)} is left of the run's limit, less than the Engine's checks of a note's ${facts} new memories may cost `
            + `($${hold.toFixed(4)} held, at $${checkHoldUsd().toFixed(4)} a check); that note was read but nothing of it was written`;
        },
      };
      for (const ref of pending.splice(0, EXTRACTION_RUN_LIMITS.batch)) {
        if (deps.stopping?.()) return stopped;
        const outcome = await extractOneNote(worker, db, work, ref);
        failedInARow = outcome.kind === 'error' && outcome.callFailed ? failedInARow + 1 : 0;
        switch (outcome.kind) {
          case 'read':
            counts.asked += 1;
            if (outcome.facts.length > 0) counts.with_facts += 1;
            counts.facts += outcome.facts.length;
            counts.retired += outcome.expired;
            counts.unmerged += outcome.unmerged;
            for (const result of outcome.results) {
              if (result.kind === 'created') counts.created += 1;
              else if (result.kind === 'replaced') counts.replaced += 1;
              else if (result.kind === 'already_known') counts.already_known += 1;
              else if (result.kind === 'duplicate') counts.duplicates += 1;
            }
            if (outcome.writeErrors > 0) counts.errors += 1;
            // The rest would be added unchecked too, so stop here, as the nightly sweep does.
            if (outcome.engineKeySpent) return ENGINE_KEY_SPENT;
            break;
          case 'already_read': counts.already_read += 1; break;
          case 'skipped': counts.skipped += 1; break;
          case 'changed': counts.changed += 1; break;
          case 'error':
            if (outcome.asked) counts.asked += 1;
            counts.errors += 1;
            if (failedInARow >= EXTRACTION_RUN_LIMITS.failuresInARow) return stoppedAfterFailures(spec, failedInARow);
            break;
          case 'limit':
            if (outcome.asked) counts.asked += 1;
            return deps.stopping?.() ? stopped : stoppedAtLimit(spec.job, outcome.detail);
        }
      }
      if (pending.length > 0) return null;
      return more
        ? { status: 'stopped', detail: `The run took on the newest ${EXTRACTION_RUN_LIMITS.maxNotes.toLocaleString('en-US')} notes left to read, which is the most one run does. Start it again for the rest: notes it read are not in the next run's scope.` }
        : { status: 'completed', detail: null };
    };

    return {
      counts,
      turn,
      summary: (end, spentUsd) => ({
        line: summaryLine(run, counts, end, spentUsd),
        stats: { run_id: run.id, status: end.status, notes: run.notes, ...counts, spent_usd: spentUsd, limit_usd: run.limit_usd },
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Following and undoing
// ---------------------------------------------------------------------------

export interface ExtractionRunView extends Omit<OnDemandRunFacts, 'undoable_notes'> {
  job: typeof EXTRACTION_RUN_JOB;
  query: Record<string, unknown> | null;
  facts_per_note: number | null;
  /** Memories the run wrote or retired that its undo can still try to take back or bring back. */
  undoable_memories: number;
  counts: ExtractionCounts;
}

export function viewExtractionRun(db: Database.Database, stored: OnDemandRunRow<unknown, unknown>): ExtractionRunView {
  const run = extractionRun(stored);
  const { undoable_notes, ...facts } = runFacts(db, run);
  return {
    ...facts, job: EXTRACTION_RUN_JOB, query: run.request.query ?? null, facts_per_note: run.request.facts_per_note ?? null,
    undoable_memories: undoable_notes, counts: run.counts,
  };
}

/** One run by id, or the most recent runs. */
export function extractionStatus(deps: Pick<OnDemandDeps, 'db' | 'config'>, runId?: string): { run: ExtractionRunView } | { runs: ExtractionRunView[] } {
  const db = databaseOf(deps);
  const found = onDemandStatus(deps, extractionRunJob(deps.config), runId);
  return 'run' in found ? { run: viewExtractionRun(db, found.run) } : { runs: found.runs.map(run => viewExtractionRun(db, run)) };
}

/**
 * A write a run recorded: a memory it wrote (with the ones it replaced), or an earlier fact it
 * retired, each with the memory's last change as the run left it (`at`, its `updated_at`).
 */
type RecordedWrite =
  | { kind: 'memory'; id: number; replaced: number[]; at: string | null }
  | { kind: 'retired'; id: number; at: string | null };

export function recordedWrite(operationId: string): RecordedWrite | null {
  const memory = /^memory:(\d+)(?::replaced:(\d+(?:,\d+)*))?(?:@(.+))?$/.exec(operationId);
  if (memory !== null) {
    return { kind: 'memory', id: Number(memory[1]), replaced: memory[2] === undefined ? [] : memory[2].split(',').map(Number), at: memory[3] ?? null };
  }
  const retired = /^retired:(\d+)(?:@(.+))?$/.exec(operationId);
  return retired === null ? null : { kind: 'retired', id: Number(retired[1]), at: retired[2] ?? null };
}

/** Whether a memory changed since the run left it: anything at all, retired and brought back, edited in place, given subjects. */
function changedSince(write: RecordedWrite, state: MemoryState): boolean {
  return write.at !== null && state.updated_at !== undefined && state.updated_at !== write.at;
}

/**
 * The job's undo. The memories the run wrote go first, newest first by id (ids only grow, while
 * the recorded order breaks ties within a millisecond by text), so a memory the run wrote and then
 * replaced comes back before it is retired itself; then the earlier facts it retired:
 *
 * - a memory the run wrote is retired, if it is still live and unchanged; the memories it replaced
 *   come back, if each is still retired in its favour; and the note it came from is no longer
 *   marked read, if the ledger still holds the text the run read;
 * - an earlier fact the run retired comes back, if it is still retired for that reason and unchanged.
 *
 * A memory changed since is left alone and reported as a conflict; one that no longer exists is
 * not found. What this undo itself brings back is no change since (Codex, #705): the memory it
 * restores is then retired in its turn. A dry run reads, changes nothing, and counts the same way.
 */
async function undoRecordedExtraction(deps: OnDemandDeps, ids: readonly string[], dryRun: boolean): Promise<RecordedUndo> {
  const db = databaseOf(deps);
  const result: RecordedUndo = { total_undone: 0, conflicts: [], not_found: [] };
  const conflict = (id: number, reason: string): void => { result.conflicts.push({ node_id: `memory:${id}`, reason }); };
  const writes: Array<{ operationId: string; write: RecordedWrite }> = [];
  for (const operationId of ids) {
    const write = recordedWrite(operationId);
    if (write === null) result.not_found.push(operationId);
    else writes.push({ operationId, write });
  }
  const order = (write: RecordedWrite): number => (write.kind === 'memory' ? 0 : 1);
  writes.sort((a, b) => order(a.write) - order(b.write) || b.write.id - a.write.id);
  // The memories this undo brought back (or, in a dry run, would): with their last change after
  // it, null in a dry run, which makes no change to compare.
  const restored = new Map<number, string | null>();
  const unchanged = (write: RecordedWrite, state: MemoryState): boolean => {
    if (!restored.has(write.id)) return !changedSince(write, state);
    const after = restored.get(write.id);
    return after === null || after === undefined || state.updated_at === undefined || state.updated_at === after;
  };

  for (const { operationId, write } of writes) {
    const state = await deps.engine.getMemoryState(write.id);
    if (state === null) { result.not_found.push(operationId); continue; }

    if (write.kind === 'retired') {
      if (state.expired_at === null || state.expire_reason !== UNSUPPORTED_REASON || state.superseded_by !== null || changedSince(write, state)) {
        conflict(write.id, 'brought back, or changed, since the run retired it');
        continue;
      }
      if (!dryRun) {
        try { await deps.engine.reactivateMemory(write.id, UNDO_REASON); }
        catch (error) { conflict(write.id, error instanceof Error ? error.message : String(error)); continue; }
      }
      result.total_undone += 1;
      continue;
    }

    // In a dry run a memory a later write of the run replaced is still retired: it would be back by now.
    const live = state.expired_at === null || (dryRun && restored.has(write.id));
    if (!live || !unchanged(write, state)) {
      conflict(write.id, 'changed since the run wrote it (retired, replaced, edited or given subjects), so it and what it replaced are left as they are');
      continue;
    }
    if (!dryRun) {
      try {
        await deps.engine.retireMemory(write.id, UNDO_REASON);
      } catch (error) {
        conflict(write.id, error instanceof Error ? error.message : String(error));
        continue;
      }
    }
    for (const old of write.replaced) {
      const before = await deps.engine.getMemoryState(old).catch(() => null);
      if (before === null || before.expired_at === null || before.superseded_by !== write.id) {
        conflict(old, `replaced by memory ${write.id}, but changed since, so it was not brought back`);
        continue;
      }
      if (dryRun) { restored.set(old, null); continue; }
      try {
        const back = await deps.engine.reactivateMemory(old, UNDO_REASON);
        restored.set(old, back.updated_at ?? null);
      } catch (error) { conflict(old, error instanceof Error ? error.message : String(error)); }
    }
    if (!dryRun && typeof state.evidence_node_id === 'string' && typeof state.evidence_hash === 'string') {
      forgetLedgerHash(db, state.evidence_node_id, state.evidence_hash);
    }
    result.total_undone += 1;
  }
  return result;
}

/** Undo everything a run wrote, as one request. A dry run by default. */
export async function undoExtraction(deps: OnDemandDeps, runId: string | undefined, dryRun: boolean): Promise<OnDemandUndo> {
  return (await undoOnDemandRun(deps, extractionRunJob(deps.config), runId, dryRun)).undo;
}
