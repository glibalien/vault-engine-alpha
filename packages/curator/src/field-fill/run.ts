import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { recordOnDemandRunOperation, type OnDemandRunRow } from '../db/on-demand-runs.js';
import type { RunTrigger } from '../db/runs.js';
import { emptyFieldGuessResult, guessFieldsForCandidate } from '../field-guess/sweep.js';
import type {
  FieldGuessNodeCandidate,
  FieldGuessNoteOutcome,
  FieldGuessSweepResult,
} from '../field-guess/types.js';
import { runCeiling, type RunCeiling } from '../on-demand/ceiling.js';
import { metered, sampleEstimate } from '../on-demand/cost.js';
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
  type RunEnd,
  type StartedRun,
} from '../on-demand/run.js';
import { catalogPricing } from '../pricing.js';

/**
 * On-demand field filling (#644): fill the named fields on the notes a query selects, from each
 * note's own text, with the model the nightly field sweep uses.
 *
 * The nightly sweep fills only what the owner marked AI-guessable and required, 25 notes a night.
 * This is the same per-note work (`guessFieldsForCandidate`: the ledger, the prompt, the checks,
 * the Engine's guarded write) over a set the caller chooses, with three differences:
 *
 * - **The fields are named in the request.** Naming them is the consent, for this run, so they
 *   need no AI-guessable mark and need not be required. The Engine lists and rechecks them by its
 *   `requested` rule.
 * - **It has its own dollar limit**, stated in the request and apart from the daily cap. The
 *   preview's few sample calls are the exception: they run under the daily cap.
 * - **It can be undone as one request**: the run keeps the Engine undo operation of every note
 *   it wrote.
 *
 * A run takes the curation queue a batch of notes at a time, so a wiki build queued behind it
 * waits for one batch, not for the run.
 *
 * What a run shares with every other on-demand job (its limit, the day's ceiling, one run at a
 * time, its end, its journal line, its undo) is `../on-demand/run.ts`. This file is the job.
 */

export const FIELD_FILL_JOB: OnDemandJobSpec = {
  job: 'fill-fields', noun: 'field fill', modelSetting: 'fieldGuessModel', journalFn: 'field-guess-sweep',
};

export const FIELD_FILL_LIMITS = {
  ...ON_DEMAND_LIMITS,
  /** Fields one run may name; the Engine's own cap. */
  maxFields: 20,
  /** Notes per page when counting a scope. */
  scanPage: 200,
} as const;

/** The filters a run's query may use: the Engine's, which are query-nodes' without joins. */
export const FIELD_FILL_QUERY_KEYS: readonly string[] = [
  'types', 'without_types', 'node_ids', 'without_node_ids', 'path_prefix', 'without_path_prefix', 'path_dir',
  'fields', 'without_fields', 'title_eq', 'title_contains', 'without_titles', 'without_title_contains', 'references',
  'modified_since', 'created_since',
];

/** What a run did, in notes. A note is counted once, under the first line that fits. */
export interface FieldFillCounts {
  /** Notes a model call was made for. */
  asked: number;
  /** ...of which at least one field was written. */
  filled: number;
  /** ...of which nothing was written: the model left every offered field empty. */
  left_empty: number;
  /** Notes skipped with no call: already asked with this model and unchanged since. */
  already_asked: number;
  /** Notes that changed between the listing and the write; nothing was written. */
  changed: number;
  /** Notes whose call or write failed. */
  errors: number;
  /** Fields written. */
  fields_set: number;
  /** ...of which replaced a value that failed the field's type (only when the run asked to). */
  fields_replaced: number;
  /** Fields offered and left as they were. */
  fields_left: number;
}

export const EMPTY_FIELD_FILL_COUNTS: FieldFillCounts = {
  asked: 0, filled: 0, left_empty: 0, already_asked: 0, changed: 0, errors: 0, fields_set: 0, fields_replaced: 0, fields_left: 0,
};

export interface FieldFillRequest {
  fields: string[];
  /** query-nodes filters; absent means every note whose kinds claim a named field. */
  query?: Record<string, unknown>;
  /** Also replace a named field's value where it fails the field's type. Absent: such values are left as they are. */
  replace_invalid?: boolean;
}

export type FieldFillRunRow = OnDemandRunRow<FieldFillRequest, FieldFillCounts>;

/** A stored run read as a field-filling run, with any count a row saved before it existed. */
function fieldFillRun(run: OnDemandRunRow<unknown, unknown>): FieldFillRunRow {
  return {
    ...run,
    request: run.request as FieldFillRequest,
    counts: { ...EMPTY_FIELD_FILL_COUNTS, ...(run.counts as Partial<FieldFillCounts>) },
  };
}

export type FieldFillDeps = OnDemandDeps;

export interface FieldFillSampleNote {
  id: string;
  title: string;
  path: string;
  /** What the model would write. */
  set: Record<string, unknown>;
  /** Present when a write would replace a value that fails its field's type: the value now there. */
  replaces?: Record<string, unknown>;
  /** What it would leave empty, and why. */
  left: Array<{ field: string; reason: string }>;
}

export interface FieldFillPreview {
  /** Notes in scope: those a run would look at. */
  notes: number;
  /** For each named field: the notes where it is empty, and where it holds a value that fails its type. */
  fields: Record<string, FieldFillFieldCount>;
  /** Whether the request replaces values that fail their field's type. */
  replace_invalid: boolean;
  /** What happens to the values that fail their field's type, when there are any. */
  invalid_values_note: string | null;
  model: string;
  provider: string | null;
  sample: FieldFillSampleNote[];
  /** Sample calls that were sent, answered or not (fewer than requested when some notes were skipped). */
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

function modelOf(deps: FieldFillDeps): { model: string; provider: string | null } {
  const model = deps.config.fieldGuessModel;
  if (model === null) {
    throw new OnDemandError('MODEL_UNRESOLVED', deps.config.fieldGuessModelError
      ?? 'The fieldGuessModel setting names no enabled model. Set it in the curator settings.');
  }
  return { model, provider: deps.config.modelProviders?.[model] ?? null };
}

export function normalizeFieldFillRequest(input: {
  fields?: readonly string[] | undefined; query?: Record<string, unknown> | undefined; replaceInvalid?: boolean | undefined;
}): FieldFillRequest {
  const fields = [...new Set((input.fields ?? []).map(field => field.trim()).filter(field => field !== ''))];
  if (fields.length === 0) throw new OnDemandError('INVALID_PARAMS', 'fields: name at least one field to fill.');
  if (fields.length > FIELD_FILL_LIMITS.maxFields) {
    throw new OnDemandError('INVALID_PARAMS', `fields: at most ${FIELD_FILL_LIMITS.maxFields} fields in one run.`);
  }
  const query = input.query !== undefined && Object.keys(input.query).length > 0 ? input.query : undefined;
  checkQueryKeys(query, FIELD_FILL_QUERY_KEYS);
  return { fields, ...(query === undefined ? {} : { query }), ...(input.replaceInvalid === true ? { replace_invalid: true } : {}) };
}

/** For one named field: the notes where it is empty, and those where it holds a value that fails its type. */
export interface FieldFillFieldCount { empty: number; invalid: number }

interface Scope {
  /** Notes the request covers: a run would look at each. */
  notes: number;
  fields: Record<string, FieldFillFieldCount>;
  /** The newest notes in scope, for the preview's sample, offered exactly what a run would offer. */
  first: FieldGuessNodeCandidate[];
}

/**
 * Count a request's scope by paging the Engine's listing. No model call.
 *
 * `seeInvalid` lists the values that fail their field's type as well, whether or not the request
 * replaces them, so a preview can say how many there are. A request that does not replace them
 * still covers only the notes with an empty named field, and is offered only those fields.
 */
async function scanScope(deps: FieldFillDeps, request: FieldFillRequest, keep: number, seeInvalid: boolean): Promise<Scope> {
  const replaces = request.replace_invalid === true;
  const scope: Scope = { notes: 0, fields: Object.fromEntries(request.fields.map(field => [field, { empty: 0, invalid: 0 }])), first: [] };
  const listing = { ...request, ...(seeInvalid ? { replace_invalid: true } : {}) };
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    let listed: Awaited<ReturnType<FieldFillDeps['engine']['listFieldGuessCandidates']>>;
    try {
      listed = await deps.engine.listFieldGuessCandidates({
        limit: FIELD_FILL_LIMITS.scanPage, requested: listing, ...(cursor === undefined ? {} : { cursor }),
      });
    } catch (error) {
      throw asRequestError(error);
    }
    if (listed.warnings.some(issue => issue.code === 'FIELD_PRESENCE_BACKFILL_PENDING')) {
      throw new OnDemandError('NOT_READY', 'The Engine is still recording which fields are empty. Try again in a minute.');
    }
    for (const candidate of listed.page.candidates) {
      for (const field of candidate.fields) {
        const count = scope.fields[field.field] ??= { empty: 0, invalid: 0 };
        if (field.eligibility === 'invalid') count.invalid += 1;
        else count.empty += 1;
      }
      const offered = replaces ? candidate.fields : candidate.fields.filter(field => field.eligibility !== 'invalid');
      if (offered.length === 0) continue;
      scope.notes += 1;
      if (scope.first.length < keep) scope.first.push({ ...candidate, fields: offered });
    }
    const next = listed.page.next_cursor;
    if (next === null || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return scope;
}

function sampleNote(outcome: FieldGuessNoteOutcome): FieldFillSampleNote {
  return {
    id: outcome.node_id, title: outcome.title, path: outcome.file_path, set: outcome.set,
    ...(Object.keys(outcome.replaced).length > 0 ? { replaces: outcome.replaced } : {}),
    left: outcome.left.map(({ field, reason }) => ({ field, reason })),
  };
}

/**
 * What a run would cover and cost: the notes in scope, and what the model does with the newest
 * few. The sample is a dry run (the Engine checks each value and writes nothing) of real, paid
 * calls under the daily cap, a fraction of a cent each on an inexpensive model.
 */
export async function previewFieldFill(deps: FieldFillDeps, input: {
  fields?: readonly string[] | undefined; query?: Record<string, unknown> | undefined; sample?: number | undefined;
  replaceInvalid?: boolean | undefined;
}): Promise<{ request: FieldFillRequest; preview: FieldFillPreview }> {
  const request = normalizeFieldFillRequest(input);
  const { model, provider } = modelOf(deps);
  databaseOf(deps);
  const wanted = Math.min(input.sample ?? FIELD_FILL_LIMITS.defaultSample, FIELD_FILL_LIMITS.maxSample);
  const scope = await scanScope(deps, request, wanted, true);
  const replaces = request.replace_invalid === true;
  const invalid = Object.values(scope.fields).reduce((sum, count) => sum + count.invalid, 0);

  const sample: FieldFillSampleNote[] = [];
  const meter = metered(deps.llm, catalogPricing(deps.config));
  const result = emptyFieldGuessResult(true);
  let sampleNoteText: string | null = null;
  const noKey = missingKey(deps, model, provider, FIELD_FILL_JOB.modelSetting);
  if (wanted > 0 && scope.first.length > 0 && noKey !== null) {
    sampleNoteText = `No sample was run: ${noKey}`;
  } else if (wanted > 0 && scope.first.length > 0) {
    const runRef = randomUUID();
    // In the queue, like every model call: the usage context is one shared slot.
    await deps.queue.enqueue('field fill preview', async () => {
      for (const candidate of scope.first) {
        if (candidate.content_hash === null || result.stopped !== undefined) continue;
        try {
          await guessFieldsForCandidate({ ...deps, llm: meter.llm },
            { dryRun: true, runRef, trigger: 'on-demand', requested: true, replaceInvalid: replaces,
              onNote: outcome => { sample.push(sampleNote(outcome)); } },
            candidate, result);
        } catch {
          result.errors += 1;
        }
      }
    });
    if (result.stopped !== undefined) {
      sampleNoteText = `The sample stopped early: ${result.stoppedDetail ?? result.stopped}. The sample is paid from the daily cap; a started run has its own limit.`;
    } else if (result.providerErrors > 0) {
      sampleNoteText = `The model call failed for ${result.providerErrors} of the ${scope.first.length} sample notes. `
        + 'The Curator\'s log has the reason; check the fieldGuessModel setting and its provider.';
    } else if (meter.calls() + meter.failed() < scope.first.length) {
      sampleNoteText = `${scope.first.length - meter.calls()} of the ${scope.first.length} sample notes gave no result`
        + `${result.ledgerSkips > 0 ? ' (some were already asked with this model and are unchanged)' : ''}.`;
    }
  }

  const estimate = sampleEstimate(meter, scope.notes, catalogPricing(deps.config)(model) !== null);
  if (estimate.cost_unknown !== null) sampleNoteText = `${sampleNoteText === null ? '' : `${sampleNoteText} `}${estimate.cost_unknown}`;
  return {
    request,
    preview: {
      notes: scope.notes,
      fields: scope.fields,
      replace_invalid: replaces,
      invalid_values_note: invalid === 0 ? null : replaces
        ? `${invalid} value(s) fail their field's type and would be replaced where the note gives a value. A sample note shows the value now there under "replaces". ${REPLACED_UNDO}`
        : `${invalid} value(s) fail their field's type (a date field holding "TBD", say) and are left as they are. `
          + 'Pass replace_invalid: true to have them replaced where the note gives a value.',
      model,
      provider,
      sample,
      sample_asked: estimate.sample_asked,
      sample_cost_usd: estimate.sample_cost_usd,
      estimated_cost_usd: estimate.estimated_cost_usd,
      estimated_minutes: estimate.estimated_minutes,
      sample_note: sampleNoteText,
      run_ceiling: runCeiling(deps),
    },
  };
}

/**
 * Accept a run and start it. On the server it continues in the background and this returns at
 * once; from the CLI it returns when the run has ended. When a run is already in progress,
 * whatever its job, that run comes back and nothing starts.
 */
export async function startFieldFill(deps: FieldFillDeps, input: {
  fields?: readonly string[] | undefined; query?: Record<string, unknown> | undefined; limitUsd?: number | undefined; trigger: RunTrigger;
  replaceInvalid?: boolean | undefined;
}): Promise<StartedRun> {
  const request = normalizeFieldFillRequest(input);
  const { model, provider } = modelOf(deps);
  return startOnDemandRun(deps, FIELD_FILL_JOB, {
    request, counts: EMPTY_FIELD_FILL_COUNTS, model, provider, limitUsd: input.limitUsd, trigger: input.trigger,
    countScope: async () => (await scanScope(deps, request, 0, false)).notes,
    nothingToDo: () => request.replace_invalid
      ? 'No note in scope lacks a value in the named fields, or holds one that fails its type.'
      : 'No note in scope lacks a value in the named fields. Values that fail their field\'s type are left alone unless replace_invalid is true.',
    execute: runId => runFieldFill(deps, runId),
  });
}

type Counter = Pick<FieldGuessSweepResult, 'modelCalls' | 'ledgerSkips' | 'staleNodes' | 'errors' | 'providerErrors'>;

/** Add one note's outcome to the run's counts: a note is counted once. */
function tally(counts: FieldFillCounts, before: Counter, after: FieldGuessSweepResult, outcome: FieldGuessNoteOutcome | null): void {
  if (outcome !== null) {
    const set = Object.keys(outcome.set).length;
    counts.asked += 1;
    counts.fields_set += set;
    counts.fields_replaced += Object.keys(outcome.replaced).length;
    counts.fields_left += outcome.left.length;
    if (set > 0) counts.filled += 1;
    else counts.left_empty += 1;
    return;
  }
  // A refused call was admitted to the count but never sent.
  if (after.stopped !== undefined) return;
  if (after.modelCalls > before.modelCalls) counts.asked += 1;
  if (after.staleNodes > before.staleNodes) counts.changed += 1;
  else if (after.errors > before.errors) counts.errors += 1;
  else if (after.ledgerSkips > before.ledgerSkips) counts.already_asked += 1;
}

function summaryLine(run: FieldFillRunRow, counts: FieldFillCounts, end: RunEnd, spentUsd: number): string {
  return `field fill run (${run.request.fields.join(', ')}): ${end.status}; ${counts.filled} of ${run.notes} notes filled, `
    + `${counts.fields_set} fields set${counts.fields_replaced > 0 ? ` (${counts.fields_replaced} replacing a value that failed its type)` : ''}, `
    + `${counts.left_empty} left empty, ${counts.already_asked} already asked, `
    + `${counts.changed} changed meanwhile, ${counts.errors} errors; $${spentUsd.toFixed(4)} of $${run.limit_usd.toFixed(2)}`;
}

/**
 * The run itself: batches of notes through the curation queue until the scope is done, the limit
 * refuses a call, or the server stops. The shared runner owns the loop and records the end; this
 * is one batch. Returns the task that writes the run's journal entry (null when there was no run).
 */
export function runFieldFill(deps: FieldFillDeps, runId: string): Promise<JournalTask | null> {
  return executeOnDemandRun(deps, FIELD_FILL_JOB, runId, (worker, stored) => {
    const db = databaseOf(deps);
    const run = fieldFillRun(stored);
    const result = emptyFieldGuessResult(false);
    const counts: FieldFillCounts = { ...EMPTY_FIELD_FILL_COUNTS };
    const trigger = run.trigger as RunTrigger;
    const stopped = interrupted(FIELD_FILL_JOB.job);
    let cursor: string | undefined;
    let failedInARow = 0;

    const turn = async (): Promise<RunEnd | null> => {
      const listed = await deps.engine.listFieldGuessCandidates({
        limit: FIELD_FILL_LIMITS.batch, requested: run.request, ...(cursor === undefined ? {} : { cursor }),
      });
      if (listed.warnings.some(issue => issue.code === 'FIELD_PRESENCE_BACKFILL_PENDING')) {
        return { status: 'stopped', detail: 'The Engine is still recording which fields are empty. Start the run again in a minute.' };
      }
      for (const candidate of listed.page.candidates) {
        if (deps.stopping?.()) return stopped;
        if (candidate.content_hash === null) { counts.changed += 1; continue; }
        const before: Counter = { modelCalls: result.modelCalls, ledgerSkips: result.ledgerSkips, staleNodes: result.staleNodes,
          errors: result.errors, providerErrors: result.providerErrors };
        let outcome: FieldGuessNoteOutcome | null = null;
        try {
          await guessFieldsForCandidate(worker, {
            dryRun: false, runRef: run.id, trigger, requested: true, replaceInvalid: run.request.replace_invalid === true,
            purpose: 'field-fill-run', journalActions: false,
            onNote: noted => { outcome = noted; },
          }, candidate, result);
        } catch {
          result.errors += 1;
        }
        tally(counts, before, result, outcome);
        // A call that failed, as opposed to a note that changed or a write the Engine refused.
        failedInARow = result.providerErrors > before.providerErrors ? failedInARow + 1 : 0;
        if (failedInARow >= FIELD_FILL_LIMITS.failuresInARow) return stoppedAfterFailures(FIELD_FILL_JOB, failedInARow);
        const operationId = (outcome as FieldGuessNoteOutcome | null)?.operation_id;
        if (typeof operationId === 'string') recordOnDemandRunOperation(db, run.id, operationId, candidate.node_id, new Date().toISOString());
        if (result.stopped !== undefined) {
          // A refusal while shutting down is the shutdown, not the limit.
          return deps.stopping?.() ? stopped : stoppedAtLimit(FIELD_FILL_JOB.job, result.stoppedDetail ?? result.stopped);
        }
      }
      cursor = listed.page.next_cursor ?? undefined;
      return listed.page.next_cursor === null ? { status: 'completed', detail: null } : null;
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

export interface FieldFillRunView extends OnDemandRunFacts {
  job: 'fill-fields';
  fields: string[];
  query: Record<string, unknown> | null;
  /** Whether the run replaces values that fail their field's type. */
  replace_invalid: boolean;
  counts: FieldFillCounts;
}

export function viewFieldFillRun(db: Database.Database, stored: OnDemandRunRow<unknown, unknown>): FieldFillRunView {
  const run = fieldFillRun(stored);
  return {
    ...runFacts(db, run),
    job: 'fill-fields',
    fields: run.request.fields,
    query: run.request.query ?? null,
    replace_invalid: run.request.replace_invalid === true,
    counts: run.counts,
  };
}

/** One run by id, or the most recent runs. */
export function fieldFillStatus(deps: Pick<FieldFillDeps, 'db'>, runId?: string): { run: FieldFillRunView } | { runs: FieldFillRunView[] } {
  const db = databaseOf(deps);
  const found = onDemandStatus(deps, FIELD_FILL_JOB, runId);
  return 'run' in found ? { run: viewFieldFillRun(db, found.run) } : { runs: found.runs.map(run => viewFieldFillRun(db, run)) };
}

/**
 * What undo does for a run that replaced values, said where replacing is offered. Text the
 * Engine had refused for the field's type is in its undo snapshot too (Engine #656).
 */
export const REPLACED_UNDO = 'Undo puts every replaced value back as it was, text typed into the note included.';

export type FieldFillUndo = OnDemandUndo;

/**
 * Undo everything a run wrote, as one request. A dry run by default: it reports what would be
 * restored. Notes edited since are conflicts and are left alone, and writes older than the
 * Engine's undo retention can no longer be undone; both are counted.
 */
export async function undoFieldFill(deps: FieldFillDeps, runId: string | undefined, dryRun: boolean): Promise<FieldFillUndo> {
  const { undo } = await undoOnDemandRun(deps, FIELD_FILL_JOB, runId, dryRun);
  return undo;
}
