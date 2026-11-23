import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { budgetRefusalDetail, isBudgetRefusal } from '../budget.js';
import type { Config } from '../config.js';
import { recordOnDemandRunOperation, type OnDemandRunRow } from '../db/on-demand-runs.js';
import type { RunTrigger } from '../db/runs.js';
import { recordTypeRefusal, refusedVersions, typeAlreadyRefused, type TypeQuestion } from '../db/type-verdicts.js';
import { EngineError } from '../engine.js';
import { runCeiling, type RunCeiling } from '../on-demand/ceiling.js';
import { metered, sampleEstimate } from '../on-demand/cost.js';
import {
  ON_DEMAND_LIMITS,
  OnDemandError,
  asRequestError,
  checkQueryKeys,
  databaseOf,
  engineWords,
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
  type RunEnd,
  type StartedRun,
} from '../on-demand/run.js';
import { buildClassifier, classifyNote, isUnderPathPrefix, noteAsShown, offerableTypes, type TypeClassifier } from '../org-sweep.js';
import { catalogPricing } from '../pricing.js';
import type { OrgNodeRef, SchemaRef } from '../types.js';

/**
 * On-demand typing (#644): give the untyped notes a query selects a type each, chosen by a model
 * from the note's own text, with the model the nightly organization sweep types with.
 *
 * The nightly sweep types 25 notes a night. This is the same call per note (`classifyNote`: one
 * type from a closed list, or none when unsure) over a set the caller chooses, with these
 * differences:
 *
 * - **The catalog also lists each type's fields.** A run is pointed at whole folders, often on a
 *   vault whose types were made minutes ago and sound alike; a name and a folder are little to
 *   tell "meeting" from "call" by. The nightly prompt is unchanged.
 * - **The caller may narrow the types on offer**, to the ones a folder could hold.
 * - **It has its own dollar limit**, like every on-demand run, and can be undone as one request.
 * - **Its "no type fits" verdicts are its own** (`type_run_verdicts`), keyed by the note and the
 *   catalog as the model was shown them, and the model, so a new type, a type that changed, or a
 *   note that was edited, renamed or moved is a new question.
 *
 * It types and nothing else: a note stays in its folder. The owner's rules on typing still hold:
 * no type in `orgTypeExclude` is offered, and no note under `orgTypeExcludePaths` (which always
 * includes the settings folder) is typed. `orgTypePaths` is the nightly sweep's scope and does not
 * bound a run, whose caller names the scope.
 *
 * What a run shares with every other on-demand job is `../on-demand/run.ts`. This file is the job.
 */

export const TYPE_NOTES_LIMITS = {
  ...ON_DEMAND_LIMITS,
  /** Types one request may narrow the offer to. */
  maxTypes: 50,
  /** Notes per page when listing a scope. */
  scanPage: 200,
  /** Most notes one run takes on; the rest wait for the next run. */
  maxNotes: 50_000,
  /** Most pages of untyped notes one listing reads to find them: beyond half a million notes, the scope is to be narrowed. */
  maxScanPages: 2_500,
  /** Field names sent for one type. */
  fieldsPerType: 15,
} as const;

/**
 * The filters a run's query may use: query-nodes' own, without those the job sets itself (a run
 * covers notes with no type, and never the suite's own notes) and without joins.
 */
export const TYPE_NOTES_QUERY_KEYS: readonly string[] = [
  'node_ids', 'without_node_ids', 'path_prefix', 'without_path_prefix', 'path_dir',
  'title_eq', 'title_contains', 'without_titles', 'without_title_contains', 'references',
  'modified_since', 'created_since',
];

export type TypeNotesDeps = OnDemandDeps;

/** The job as the shared runner sees it. The model is the nightly typing's: `orgSweepModel`, or `model` when that is not set. */
export function typeNotesJob(config: Pick<Config, 'orgSweepModel'>): OnDemandJobSpec {
  return { job: 'type-notes', noun: 'typing', modelSetting: config.orgSweepModel ? 'orgSweepModel' : 'model', journalFn: 'org-sweep' };
}

function modelOf(deps: TypeNotesDeps): { model: string; provider: string | null } {
  const model = deps.config.orgSweepModel ?? deps.config.model;
  return { model, provider: deps.config.modelProviders?.[model] ?? null };
}

/** What a run did, in notes. A note is counted once. */
export interface TypeNotesCounts {
  /** Notes a model call was made for. */
  asked: number;
  /** ...of which were given a type. */
  typed: number;
  /** ...of which the model said no type on offer clearly fits. They stay untyped. */
  left_untyped: number;
  /** ...of which the Engine refused the type the model chose (a required field with no default, say). */
  refused: number;
  /** Notes skipped with no call: asked this question before, and their title, path and text are the same though the note was saved since. (An unchanged note is not in a run's scope at all.) */
  already_asked: number;
  /** Notes that got a type, changed or went away between the listing and the write; nothing was written. */
  changed: number;
  /** Notes whose call or write failed. */
  errors: number;
  /** Notes typed, by the type given. */
  by_type: Record<string, number>;
}

export const EMPTY_TYPE_NOTES_COUNTS: TypeNotesCounts = {
  asked: 0, typed: 0, left_untyped: 0, refused: 0, already_asked: 0, changed: 0, errors: 0, by_type: {},
};

export interface TypeNotesRequest {
  /** The types the caller narrowed the offer to; absent means every type that may be offered. */
  types?: string[];
  /** query-nodes filters; absent means every untyped note. */
  query?: Record<string, unknown>;
}

/** A request as a run keeps it: with the types that were on offer when it was accepted. */
export interface StoredTypeNotesRequest extends TypeNotesRequest {
  offered: string[];
}

export type TypeNotesRunRow = OnDemandRunRow<StoredTypeNotesRequest, TypeNotesCounts>;

function typeNotesRun(run: OnDemandRunRow<unknown, unknown>): TypeNotesRunRow {
  const request = run.request as Partial<StoredTypeNotesRequest>;
  const counts = run.counts as Partial<TypeNotesCounts>;
  return {
    ...run,
    request: { ...request, offered: request.offered ?? [] },
    counts: { ...EMPTY_TYPE_NOTES_COUNTS, ...counts, by_type: { ...counts.by_type } },
  };
}

export function normalizeTypeNotesRequest(input: {
  types?: readonly string[] | undefined; query?: Record<string, unknown> | undefined;
}): TypeNotesRequest {
  const types = input.types === undefined ? undefined : [...new Set(input.types.map(type => type.trim()).filter(type => type !== ''))];
  if (types !== undefined && types.length === 0) {
    throw new OnDemandError('INVALID_PARAMS', 'types: name at least one type to offer, or omit it to offer every type.');
  }
  if (types !== undefined && types.length > TYPE_NOTES_LIMITS.maxTypes) {
    throw new OnDemandError('INVALID_PARAMS', `types: at most ${TYPE_NOTES_LIMITS.maxTypes} types in one run.`);
  }
  const query = input.query !== undefined && Object.keys(input.query).length > 0 ? input.query : undefined;
  checkQueryKeys(query, TYPE_NOTES_QUERY_KEYS);
  return { ...(types === undefined ? {} : { types }), ...(query === undefined ? {} : { query }) };
}

// ---------------------------------------------------------------------------
// The types on offer
// ---------------------------------------------------------------------------

/** The types a run offers the model, and the question they make for the verdict ledger. */
interface Offer {
  offered: SchemaRef[];
  classifier: TypeClassifier;
  /**
   * Identifies everything about a typing call that is not the note: the catalog as the model is
   * shown it (every offered type's name, display name, folder and fields, and the instructions
   * around them) and the settings that shape the call (how much of a note's text is sent, the
   * room for an answer, the reasoning effort). A verdict holds only for the call it came from, so
   * a type whose fields changed, or a raised text cap, gets its "no type fits" notes asked again.
   *
   * The settings belong here and not only in the note's own hash: a run leaves answered notes out
   * of its scope by this hash and the note's version alone, before any note is read.
   */
  offeredHash: string;
}

/** The catalog a run chooses from: the vault's types, without the ones the owner keeps out of typing. */
async function typesOnOffer(deps: TypeNotesDeps, wanted: readonly string[] | undefined): Promise<SchemaRef[]> {
  const catalog = await deps.engine.listSchemas();
  const offerable = offerableTypes(catalog, deps.config);
  if (wanted === undefined) {
    if (offerable.length === 0) {
      throw new OnDemandError('NO_TYPES', 'The vault has no type to offer. Create the types first (create-schema), then type notes with them.');
    }
    return offerable;
  }
  const known = new Set(catalog.map(type => type.name));
  const unknown = wanted.filter(type => !known.has(type));
  if (unknown.length > 0) {
    throw new OnDemandError('INVALID_PARAMS', `types: no such type: ${unknown.join(', ')}. list-schemas shows the vault's types; create-schema makes one.`);
  }
  const allowed = new Set(offerable.map(type => type.name));
  const withheld = wanted.filter(type => !allowed.has(type));
  if (withheld.length > 0) {
    throw new OnDemandError('INVALID_PARAMS', `types: ${withheld.join(', ')} ${withheld.length === 1 ? 'is' : 'are'} kept out of typing `
      + 'by the curator setting orgTypeExclude, which the owner sets. A model may not assign it.');
  }
  return offerable.filter(type => wanted.includes(type.name));
}

/** The offer with each type's fields read from the Engine, ready to ask with. */
async function offerOf(deps: TypeNotesDeps, model: string, offered: readonly SchemaRef[]): Promise<Offer> {
  const fields = new Map<string, string[]>();
  for (const type of offered) {
    // A type whose fields cannot be read is still offered, by its name and folder.
    const names = await deps.engine.schemaFieldNames(type.name).catch(() => []);
    fields.set(type.name, names.slice(0, TYPE_NOTES_LIMITS.fieldsPerType));
  }
  const classifier = buildClassifier(offered, model, fields);
  const call = JSON.stringify({
    system: classifier.system, bodyCharCap: deps.config.bodyCharCap ?? null, maxTokens: deps.config.orgSweepMaxTokens,
    reasoningEffort: deps.config.reasoningEffort ?? null,
  });
  return { offered: [...offered], classifier, offeredHash: createHash('sha256').update(call).digest('hex') };
}

// ---------------------------------------------------------------------------
// The notes in scope
// ---------------------------------------------------------------------------

interface Scope {
  /** The untyped notes a run would ask about, newest first. */
  notes: OrgNodeRef[];
  /** Untyped notes the query selects that the owner's settings keep out of typing. */
  withheld: number;
  /** Untyped notes the query selects that were already asked this question and are unchanged. */
  alreadyAsked: number;
  /** More notes were there than one run takes on. */
  truncated: boolean;
}

/** Whether the owner's settings keep a note at this path out of typing. */
function keptOutOfTyping(config: Pick<Config, 'orgTypeExcludePaths'>, filePath: string): boolean {
  return (config.orgTypeExcludePaths ?? []).some(prefix => isUnderPathPrefix(filePath, prefix));
}

/**
 * List a request's scope. No model call.
 *
 * Notes a run would not ask about are left out as the listing is read, and do not count toward
 * the most one run takes on: the notes under a folder kept out of typing, and the notes already
 * answered "no type fits" for this offer that are still at the version they were asked at.
 * Otherwise such notes, which stay untyped, would fill the newest end of every later run's scope,
 * and the notes behind them would never be reached.
 */
async function scanScope(deps: TypeNotesDeps, request: TypeNotesRequest, offer: Pick<Offer, 'offeredHash' | 'classifier'>): Promise<Scope> {
  const answered = deps.db === undefined ? new Map<string, number>()
    : refusedVersions(deps.db, { offeredHash: offer.offeredHash, model: offer.classifier.model });
  let withheld = 0;
  let alreadyAsked = 0;
  let listed: Awaited<ReturnType<TypeNotesDeps['engine']['listUntypedNodes']>>;
  try {
    listed = await deps.engine.listUntypedNodes({
      pathPrefixes: [], pageLimit: TYPE_NOTES_LIMITS.scanPage, maxPages: TYPE_NOTES_LIMITS.maxScanPages, maxNodes: TYPE_NOTES_LIMITS.maxNotes,
      keep: note => {
        if (keptOutOfTyping(deps.config, note.file_path)) { withheld += 1; return false; }
        if (answered.get(note.id) === note.version) { alreadyAsked += 1; return false; }
        return true;
      },
      ...(request.query === undefined ? {} : { filter: request.query }),
    });
  } catch (error) {
    throw asRequestError(error);
  }
  // The listing gave up before it had a run's worth of notes: there are too many to read through.
  if (listed.truncated && listed.nodes.length < TYPE_NOTES_LIMITS.maxNotes) {
    throw new OnDemandError('SCOPE_TOO_LARGE', `More than ${(TYPE_NOTES_LIMITS.maxScanPages * TYPE_NOTES_LIMITS.scanPage).toLocaleString('en-US')} untyped notes match. `
      + 'Narrow the scope: a folder with path_prefix, or one survey-nodes group at a time with node_ids.');
  }
  return { notes: listed.nodes, withheld, alreadyAsked, truncated: listed.truncated };
}

// ---------------------------------------------------------------------------
// One note
// ---------------------------------------------------------------------------

type NoteOutcome =
  /** Typed (or, in a dry run, would be). `operationId` is the Engine's undo record of the write. */
  | { kind: 'typed'; type: string; reason: string; operationId: string | null }
  /** The model said no type on offer clearly fits. */
  | { kind: 'none'; reason: string }
  /** The Engine would not give the note the type the model chose. */
  | { kind: 'refused'; type: string; why: string }
  | { kind: 'already_asked' }
  /** The note got a type, changed or went away meanwhile. `asked`: a model call was made before that showed. */
  | { kind: 'changed'; asked: boolean }
  /** `asked`: a model call was made. `callFailed`: it was the call that failed, not a read or a write. */
  | { kind: 'error'; asked: boolean; callFailed: boolean }
  /** The limit refused the call: nothing more can be asked. */
  | { kind: 'limit'; detail: string };

interface NoteWork {
  offer: Offer;
  dryRun: boolean;
  runRef: string;
  /** What the call is charged as: the run's own purpose, or the nightly typing's for a preview's sample. */
  purpose: 'type-notes-run' | 'org-sweep';
}

function warn(message: string, error: unknown): void {
  console.warn(`[curator] typing run: ${message}: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * Read one note, ask the model which type fits, and give it that type. Never throws.
 *
 * The write names the version the note had when it was read with no type, so a note that changed
 * or was typed meanwhile is left as it is.
 */
async function typeOneNote(deps: TypeNotesDeps, db: Database.Database, work: NoteWork, ref: OrgNodeRef): Promise<NoteOutcome> {
  let node: Awaited<ReturnType<TypeNotesDeps['engine']['getNode']>>;
  try {
    node = await deps.engine.getNode(ref.id);
  } catch (error) {
    if (error instanceof EngineError && error.code === 'NOT_FOUND') return { kind: 'changed', asked: false };
    warn(`read failed for "${ref.title}"`, error);
    return { kind: 'error', asked: false, callFailed: false };
  }
  if (node.types.length > 0 || node.version === undefined) return { kind: 'changed', asked: false };
  // The note as it is now, not as it was listed: one moved into a folder kept out of typing since
  // is not read to a model, and is not typed there.
  const shown = { title: node.title ?? ref.title, file_path: node.file_path ?? ref.file_path, body: node.body ?? '' };
  if (keptOutOfTyping(deps.config, shown.file_path)) return { kind: 'changed', asked: false };
  // The answer on record is for the note as the model was shown it: its title and path as well as
  // its text. A rename or a move keeps the file's content hash and changes what the model reads.
  const question = {
    nodeId: ref.id, noteHash: createHash('sha256').update(noteAsShown(deps.config, shown)).digest('hex'), version: node.version,
    offeredHash: work.offer.offeredHash, model: work.offer.classifier.model,
  } satisfies TypeQuestion & { version: number };
  if (typeAlreadyRefused(db, question)) return { kind: 'already_asked' };

  let verdict: Awaited<ReturnType<typeof classifyNote>>;
  try {
    deps.usage?.setContext({ project: 'type-notes', runRef: work.runRef, purpose: work.purpose });
    verdict = await classifyNote(deps, work.offer.classifier, shown);
  } catch (error) {
    if (isBudgetRefusal(error)) return { kind: 'limit', detail: budgetRefusalDetail(error) };
    warn(`the model call failed for "${ref.title}"`, error);
    return { kind: 'error', asked: true, callFailed: true };
  } finally {
    deps.usage?.setContext(null);
  }
  if (verdict.type === null) {
    if (!work.dryRun) recordTypeRefusal(db, question, new Date().toISOString());
    return { kind: 'none', reason: verdict.reason };
  }
  try {
    const written = await deps.engine.addTypeCas({ nodeId: ref.id, type: verdict.type, expectedVersion: node.version, dryRun: work.dryRun });
    return { kind: 'typed', type: verdict.type, reason: verdict.reason, operationId: written.operationId };
  } catch (error) {
    if (error instanceof EngineError && (error.code === 'STALE_NODE' || error.code === 'NOT_FOUND')) return { kind: 'changed', asked: true };
    if (error instanceof EngineError && error.code === 'VALIDATION_FAILED') return { kind: 'refused', type: verdict.type, why: engineWords(error) };
    warn(`the type could not be written to "${ref.title}"`, error);
    return { kind: 'error', asked: true, callFailed: false };
  }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface TypeNotesSampleNote {
  id: string;
  title: string;
  path: string;
  /** The type the model would give; null when it says none on offer clearly fits. */
  type: string | null;
  /** The model's one-line reason. */
  reason: string;
  /** Present when the Engine would not give the note that type: why. */
  refused?: string;
}

export interface TypeNotesPreview {
  /** Untyped notes in scope: those a run would ask about. */
  notes: number;
  /** Untyped notes the query selects that were already asked this question and are unchanged: a run does not ask again. */
  already_asked: number;
  /** The types the model chooses among. */
  types_offered: string[];
  /** What bounds the scope beyond the request, when something does. */
  scope_note: string | null;
  /** Whether typed notes are later re-filed by the nightly sweep, when they may be. */
  moves_note: string | null;
  model: string;
  provider: string | null;
  sample: TypeNotesSampleNote[];
  /** Sample calls that were sent, answered or not. */
  sample_asked: number;
  /** What the sample cost, charged to the daily cap. Null when it is not known. */
  sample_cost_usd: number | null;
  /** The sample's average cost times the notes in scope. Null without a priced sample. */
  estimated_cost_usd: number | null;
  /** The sample's average time times the notes in scope. Null without a sample. */
  estimated_minutes: number | null;
  /** Why there is no sample, or a smaller one, when that is so. */
  sample_note: string | null;
  /** The day's ceiling for on-demand runs and what is left of it; null when the owner set none. */
  run_ceiling: RunCeiling | null;
}

/**
 * The notes a preview tries the model on: spread evenly through the scope, not its first few.
 * Notes that sit together in a listing are often alike (one import, one folder, one day), and a
 * sample of look-alikes would not show whether the model tells the kinds in the set apart.
 */
function sampleOf(notes: readonly OrgNodeRef[], wanted: number): OrgNodeRef[] {
  if (notes.length <= wanted) return [...notes];
  return Array.from({ length: wanted }, (_, index) => notes[Math.floor((index * notes.length) / wanted)]!);
}

function scopeNote(deps: TypeNotesDeps, scope: Scope): string | null {
  const parts: string[] = [];
  if (scope.withheld > 0) {
    parts.push(`${scope.withheld} more untyped note(s) match but sit under a folder kept out of typing `
      + `(${(deps.config.orgTypeExcludePaths ?? []).join(', ')}: the settings folder, and the curator setting orgTypeExcludePaths), so they are not in scope.`);
  }
  if (scope.alreadyAsked > 0) {
    parts.push(`${scope.alreadyAsked} more untyped note(s) match but were already asked this question (these types, this model) and are unchanged, `
      + 'so they are not asked again. Other types on offer, or a change to a type or a note, asks again.');
  }
  if (scope.truncated) {
    parts.push(`More than ${TYPE_NOTES_LIMITS.maxNotes.toLocaleString('en-US')} untyped notes are left to ask; one run takes the newest `
      + `${TYPE_NOTES_LIMITS.maxNotes.toLocaleString('en-US')}, and a run started after it takes the rest.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/** A typing run does not move a note. The nightly sweep may, later, when the owner has it re-file typed notes. */
function movesNote(config: Config): string | null {
  if (!config.orgSweepEnabled || config.orgMovePaths.length === 0) return null;
  const folders = config.orgMovePaths.map(folder => (folder === '/' ? 'the vault root' : folder)).join(', ');
  return 'A run gives notes a type and leaves them where they are. The nightly organization sweep is on, though, and it moves a typed note '
    + `that sits directly in ${folders} to its type's folder, up to ${config.orgMoveCap} a night (the curator settings orgMovePaths and orgMoveCap).`;
}

/**
 * What a run would cover and cost: the untyped notes in scope, the types on offer, and what the
 * model makes of a few notes spread through the scope. The sample is a dry run (the Engine checks each type and writes
 * nothing) of real, paid calls under the daily cap, a fraction of a cent each on an inexpensive model.
 */
export async function previewTypeNotes(deps: TypeNotesDeps, input: {
  types?: readonly string[] | undefined; query?: Record<string, unknown> | undefined; sample?: number | undefined;
}): Promise<{ request: TypeNotesRequest; preview: TypeNotesPreview }> {
  const request = normalizeTypeNotesRequest(input);
  const spec = typeNotesJob(deps.config);
  const { model, provider } = modelOf(deps);
  const db = databaseOf(deps);
  const offered = await typesOnOffer(deps, request.types);
  const offer = await offerOf(deps, model, offered);
  const scope = await scanScope(deps, request, offer);
  const wanted = Math.min(input.sample ?? TYPE_NOTES_LIMITS.defaultSample, TYPE_NOTES_LIMITS.maxSample);
  const first = sampleOf(scope.notes, wanted);

  const sample: TypeNotesSampleNote[] = [];
  const meter = metered(deps.llm, catalogPricing(deps.config));
  let sampleNote: string | null = null;
  const noKey = missingKey(deps, model, provider, spec.modelSetting);
  if (first.length > 0 && noKey !== null) {
    sampleNote = `No sample was run: ${noKey}`;
  } else if (first.length > 0) {
    const runRef = randomUUID();
    let stopped: string | null = null;
    let callsFailed = 0;
    let alreadyAsked = 0;
    // In the queue, like every model call: the usage context is one shared slot.
    await deps.queue.enqueue('typing preview', async () => {
      for (const ref of first) {
        if (stopped !== null) break;
        const outcome = await typeOneNote({ ...deps, llm: meter.llm }, db, { offer, dryRun: true, runRef, purpose: 'org-sweep' }, ref);
        const shown = { id: ref.id, title: ref.title, path: ref.file_path };
        if (outcome.kind === 'typed') sample.push({ ...shown, type: outcome.type, reason: outcome.reason });
        else if (outcome.kind === 'none') sample.push({ ...shown, type: null, reason: outcome.reason });
        else if (outcome.kind === 'refused') sample.push({ ...shown, type: outcome.type, reason: '', refused: outcome.why });
        else if (outcome.kind === 'limit') stopped = outcome.detail;
        else if (outcome.kind === 'already_asked') alreadyAsked += 1;
        else if (outcome.kind === 'error' && outcome.callFailed) callsFailed += 1;
      }
    });
    if (stopped !== null) {
      sampleNote = `The sample stopped early: ${stopped}. The sample is paid from the daily cap; a started run has its own limit.`;
    } else if (callsFailed > 0) {
      sampleNote = `The model call failed for ${callsFailed} of the ${first.length} sample notes. `
        + `The Curator's log has the reason; check the ${spec.modelSetting} setting and its provider.`;
    } else if (sample.length < first.length) {
      sampleNote = `${first.length - sample.length} of the ${first.length} sample notes gave no result`
        + `${alreadyAsked > 0 ? ' (some were already asked with this model and these types, and are unchanged)' : ''}.`;
    }
  }

  const estimate = sampleEstimate(meter, scope.notes.length, catalogPricing(deps.config)(model) !== null);
  if (estimate.cost_unknown !== null) sampleNote = `${sampleNote === null ? '' : `${sampleNote} `}${estimate.cost_unknown}`;
  return {
    request,
    preview: {
      notes: scope.notes.length,
      already_asked: scope.alreadyAsked,
      types_offered: offered.map(type => type.name),
      scope_note: scopeNote(deps, scope),
      moves_note: movesNote(deps.config),
      model,
      provider,
      sample,
      sample_asked: estimate.sample_asked,
      sample_cost_usd: estimate.sample_cost_usd,
      estimated_cost_usd: estimate.estimated_cost_usd,
      estimated_minutes: estimate.estimated_minutes,
      sample_note: sampleNote,
      run_ceiling: runCeiling(deps),
    },
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Accept a run and start it. On the server it continues in the background and this returns at
 * once; from the CLI it returns when the run has ended. When a run is already in progress,
 * whatever its job, that run comes back and nothing starts.
 */
export async function startTypeNotes(deps: TypeNotesDeps, input: {
  types?: readonly string[] | undefined; query?: Record<string, unknown> | undefined; limitUsd?: number | undefined; trigger: RunTrigger;
}): Promise<StartedRun> {
  const request = normalizeTypeNotesRequest(input);
  const { model, provider } = modelOf(deps);
  databaseOf(deps);
  const offered = await typesOnOffer(deps, request.types);
  const offer = await offerOf(deps, model, offered);
  const stored: StoredTypeNotesRequest = { ...request, offered: offered.map(type => type.name) };
  let alreadyAsked = 0;
  return startOnDemandRun(deps, typeNotesJob(deps.config), {
    request: stored, counts: EMPTY_TYPE_NOTES_COUNTS, model, provider, limitUsd: input.limitUsd, trigger: input.trigger,
    countScope: async () => {
      const scope = await scanScope(deps, request, offer);
      alreadyAsked = scope.alreadyAsked;
      return scope.notes.length;
    },
    nothingToDo: () => alreadyAsked > 0
      ? `No untyped note in scope is left to ask: ${alreadyAsked} were already asked this question (these types, this model) and are unchanged. `
        + 'Offer other types, or change a type or the notes, to have them asked again.'
      : 'No untyped note is in scope. Notes that already have a type are not retyped, and the settings folder is never typed.',
    execute: runId => runTypeNotes(deps, runId),
  });
}

function summaryLine(run: TypeNotesRunRow, counts: TypeNotesCounts, end: RunEnd, spentUsd: number): string {
  const given = Object.entries(counts.by_type).sort(([, a], [, b]) => b - a).map(([type, n]) => `${type} ${n}`).join(', ');
  return `typing run (${run.request.offered.length} type(s) on offer): ${end.status}; ${counts.typed} of ${run.notes} notes typed`
    + `${given === '' ? '' : ` (${given})`}, ${counts.left_untyped} left untyped, `
    + `${counts.refused > 0 ? `${counts.refused} refused by the Engine, ` : ''}${counts.already_asked} already asked, `
    + `${counts.changed} changed meanwhile, ${counts.errors} errors; $${spentUsd.toFixed(4)} of $${run.limit_usd.toFixed(2)}`;
}

/**
 * The run itself: the scope is listed once, before anything is typed (typing a note takes it out
 * of the untyped set, which would shift a listing read page by page), then worked through a batch
 * a turn. The shared runner owns the loop and records the end. Returns the task that writes the
 * run's journal entry (null when there was no run).
 */
export function runTypeNotes(deps: TypeNotesDeps, runId: string): Promise<JournalTask | null> {
  const spec = typeNotesJob(deps.config);
  return executeOnDemandRun(deps, spec, runId, (worker, stored) => {
    const db = databaseOf(deps);
    const run = typeNotesRun(stored);
    const counts: TypeNotesCounts = { ...EMPTY_TYPE_NOTES_COUNTS, by_type: {} };
    const stopped = interrupted(spec.job);
    let pending: OrgNodeRef[] | null = null;
    let offer: Offer | null = null;
    let more = false;
    let failedInARow = 0;

    const turn = async (): Promise<RunEnd | null> => {
      if (pending === null || offer === null) {
        // The types on offer are the ones the run was accepted with, as far as they still exist.
        const catalog = offerableTypes(await deps.engine.listSchemas(), deps.config);
        const offered = catalog.filter(type => run.request.offered.includes(type.name));
        if (offered.length === 0) return { status: 'failed', detail: 'None of the types this run was to offer exists any more.' };
        offer = await offerOf(deps, run.model, offered);
        const scope = await scanScope(deps, run.request, offer);
        pending = scope.notes;
        more = scope.truncated;
      }
      const work: NoteWork = { offer, dryRun: false, runRef: run.id, purpose: 'type-notes-run' };
      for (const ref of pending.splice(0, TYPE_NOTES_LIMITS.batch)) {
        if (deps.stopping?.()) return stopped;
        const outcome = await typeOneNote(worker, db, work, ref);
        failedInARow = outcome.kind === 'error' && outcome.callFailed ? failedInARow + 1 : 0;
        switch (outcome.kind) {
          case 'typed':
            counts.asked += 1;
            counts.typed += 1;
            counts.by_type[outcome.type] = (counts.by_type[outcome.type] ?? 0) + 1;
            if (outcome.operationId === null) {
              // An Engine from before a single write returned its undo record: the run could not
              // be undone as one request, so it goes no further.
              return {
                status: 'failed',
                detail: `The Engine gave no undo record for the type written to "${ref.title}", so this run stopped after that one note: `
                  + 'it could not have been undone as one request. Update the Engine to the Curator\'s release, then start the run again.',
              };
            }
            recordOnDemandRunOperation(db, run.id, outcome.operationId, ref.id, new Date().toISOString());
            break;
          case 'none': counts.asked += 1; counts.left_untyped += 1; break;
          case 'refused': counts.asked += 1; counts.refused += 1; break;
          case 'already_asked': counts.already_asked += 1; break;
          case 'changed':
            if (outcome.asked) counts.asked += 1;
            counts.changed += 1;
            break;
          case 'error':
            if (outcome.asked) counts.asked += 1;
            counts.errors += 1;
            if (failedInARow >= TYPE_NOTES_LIMITS.failuresInARow) return stoppedAfterFailures(spec, failedInARow);
            break;
          case 'limit':
            // A refusal while shutting down is the shutdown, not the limit.
            return deps.stopping?.() ? stopped : stoppedAtLimit(spec.job, outcome.detail);
        }
      }
      if (pending.length > 0) return null;
      return more
        ? { status: 'stopped', detail: `The run took on the newest ${TYPE_NOTES_LIMITS.maxNotes.toLocaleString('en-US')} untyped notes left to ask, which is the most one run does. Start it again for the rest: notes it typed, and notes it left untyped, are not in the next run's scope.` }
        : { status: 'completed', detail: null };
    };

    return {
      counts,
      turn,
      summary: (end, spentUsd) => ({
        line: summaryLine(run, counts, end, spentUsd),
        stats: { run_id: run.id, status: end.status, notes: run.notes, ...counts, spent_usd: spentUsd, limit_usd: run.limit_usd, errors: counts.errors },
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Following and undoing
// ---------------------------------------------------------------------------

export interface TypeNotesRunView extends OnDemandRunFacts {
  job: 'type-notes';
  /** The types the caller narrowed the offer to; null when it offered every type. */
  types: string[] | null;
  /** The types that were on offer. */
  types_offered: string[];
  query: Record<string, unknown> | null;
  counts: TypeNotesCounts;
}

export function viewTypeNotesRun(db: Database.Database, stored: OnDemandRunRow<unknown, unknown>): TypeNotesRunView {
  const run = typeNotesRun(stored);
  return {
    ...runFacts(db, run),
    job: 'type-notes',
    types: run.request.types ?? null,
    types_offered: run.request.offered,
    query: run.request.query ?? null,
    counts: run.counts,
  };
}

/** One run by id, or the most recent runs. */
export function typeNotesStatus(deps: Pick<TypeNotesDeps, 'db' | 'config'>, runId?: string): { run: TypeNotesRunView } | { runs: TypeNotesRunView[] } {
  const db = databaseOf(deps);
  const found = onDemandStatus(deps, typeNotesJob(deps.config), runId);
  return 'run' in found ? { run: viewTypeNotesRun(db, found.run) } : { runs: found.runs.map(run => viewTypeNotesRun(db, run)) };
}

/**
 * Undo everything a run wrote, as one request: each note it typed goes back to having no type,
 * and loses the field defaults the type gave it. A dry run by default.
 */
export async function undoTypeNotes(deps: TypeNotesDeps, runId: string | undefined, dryRun: boolean): Promise<OnDemandUndo> {
  return (await undoOnDemandRun(deps, typeNotesJob(deps.config), runId, dryRun)).undo;
}
