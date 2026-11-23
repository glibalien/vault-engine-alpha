import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type Database from 'better-sqlite3';
import type { BackgroundBuilds } from '../background-builds.js';
import type { RunBudgetFactory } from '../budget.js';
import type { Config } from '../config.js';
import type { JournalFunction } from '../db/journal.js';
import {
  ON_DEMAND_ITEM,
  alreadyDone,
  ON_DEMAND_HEARTBEAT_MS,
  activeOnDemandRun,
  claimOnDemandRun,
  finishOnDemandRun,
  getOnDemandRun,
  interruptAbandonedOnDemandRuns,
  listOnDemandRuns,
  markOnDemandRunStarted,
  markOnDemandRunUndone,
  onDemandRunOperations,
  saveOnDemandRunProgress,
  touchOnDemandRun,
  type OnDemandJob,
  type OnDemandRunRow,
  type OnDemandRunStatus,
} from '../db/on-demand-runs.js';
import type { RunTrigger } from '../db/runs.js';
import { EngineError, type Engine } from '../engine.js';
import type { ActionRecorder } from '../journal/recorder.js';
import { writeJournalEntry } from '../journal/writer.js';
import type { LlmClient } from '../llm/types.js';
import { catalogPricing } from '../pricing.js';
import type { CurationQueue } from '../queue.js';
import type { UsageReporter } from '../usage-reporter.js';
import { overCeiling, runCeiling } from './ceiling.js';
import { roundUsd } from './cost.js';

/**
 * What every on-demand run shares (#644), whatever its job: a dollar limit of its own apart from
 * the daily cap, the owner's ceiling on all runs in a day, one run at a time across processes, a
 * turn in the curation queue a batch of notes at a time, an end that is always recorded, one
 * journal summary, and an undo of everything it wrote as one request.
 *
 * A job (field filling in `../field-fill/run.ts`, typing in `../type-notes/run.ts`) supplies what
 * is its own: how a request is read, which notes are in scope, the work on one note, its counts.
 */

export const ON_DEMAND_LIMITS = {
  /** Notes a preview asks the model about. */
  defaultSample: 5,
  maxSample: 10,
  /** Notes per turn in the curation queue. */
  batch: 20,
  /** Largest limit a request may state, in USD. */
  maxLimitUsd: 100,
  /** Runs listed by status. */
  recentRuns: 5,
  /** Notes in a row whose model call failed before a run gives up: a dead key or model fails them all. */
  failuresInARow: 5,
} as const;

/** The key under which a run is tracked as background work: one run at a time, whatever the job. */
export const ON_DEMAND_BUILD_KEY = 'on-demand-run';

export class OnDemandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'OnDemandError';
  }
}

export interface OnDemandDeps {
  engine: Engine;
  llm: LlmClient;
  config: Config;
  queue: CurationQueue;
  db?: Database.Database;
  usage?: UsageReporter;
  recorder?: ActionRecorder;
  /** Makes a run's budget. Absent where no run may be started. */
  runBudget?: RunBudgetFactory;
  /** Present on the server: a started run continues after its tool call has replied. */
  builds?: BackgroundBuilds;
  /** True once the server has begun shutting down. */
  stopping?: () => boolean;
  /**
   * Set by the runner on a run's own deps: charges the run's limit with a cost its calls did not
   * make but the ledger records under the run (the Engine's consolidation check of a memory the run
   * wrote, #659). Null is a cost not known, which reads the ledger again before the next call.
   */
  chargeRun?: (usd: number | null) => void;
  /** Set by the runner on a run's own deps: what is left of the run's limit, holds for calls in flight taken off. */
  runLeftUsd?: () => Promise<number>;
}

/** What a job tells the shared runner about itself. */
export interface OnDemandJobSpec {
  /** The job, which is also the name of the tool that runs it. */
  job: OnDemandJob;
  /** The job in queue labels, log lines and journal entries: "field fill" gives "field fill run". */
  noun: string;
  /** The curator setting that names the job's model. */
  modelSetting: string;
  /** The journal function its summary is filed under. */
  journalFn: JournalFunction;
  /**
   * How the job takes back what a run wrote, given the ids the run recorded, in place of the
   * Engine's undo of note operations: a job that writes no notes (memory subjects, #554).
   */
  undo?: (deps: OnDemandDeps, ids: readonly string[], dryRun: boolean) => Promise<RecordedUndo>;
}

/** What an undo of a run's recorded writes did: the Engine's undo-operations answer, as far as a job's own undo needs. */
export interface RecordedUndo {
  total_undone: number;
  conflicts: Array<{ node_id: string; reason: string }>;
  /** Recorded writes there was nothing left to undo for. */
  not_found: string[];
}

export function databaseOf(deps: Pick<OnDemandDeps, 'db'>): Database.Database {
  if (deps.db === undefined) throw new OnDemandError('UNAVAILABLE', 'The Curator database is unavailable, so a run could not be recorded.');
  return deps.db;
}

/** Whether a process on this machine still exists. Signal 0 tests for it and sends nothing. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // No permission to signal it means it is there.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Mark runs whose process is gone as interrupted (a server that restarted, a CLI stopped with
 * Ctrl-C), so they neither block the next run nor refuse an undo. Returns how many.
 */
export function releaseAbandonedRuns(db: Database.Database, now: Date = new Date()): number {
  return interruptAbandonedOnDemandRuns(db, { now, host: hostname(), alive: processAlive });
}

/** An Engine error's own words, without the client's "engine CODE:" prefix. */
export const engineWords = (error: EngineError): string => error.message.replace(/^engine [A-Z_]+: /, '');

/** An Engine refusal of the request itself (an unclaimed field, a malformed filter) is the caller's to fix. */
export function asRequestError(error: unknown): unknown {
  if (!(error instanceof EngineError)) return error;
  if (error.code === 'INVALID_PARAMS') return new OnDemandError('INVALID_PARAMS', engineWords(error));
  // The Engine's schema check answers outside its envelope, so the client reports it as unparsed text.
  const invalid = /Input validation error: (?:Invalid arguments for tool [\w-]+: )?(.*)$/s.exec(error.message);
  return invalid ? new OnDemandError('INVALID_PARAMS', `query: ${invalid[1]!.trim()}`) : error;
}

/** Refuse query filters a job does not take, before the Engine is asked. */
export function checkQueryKeys(query: Record<string, unknown> | undefined, allowed: readonly string[]): void {
  const unknown = Object.keys(query ?? {}).filter(key => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new OnDemandError('INVALID_PARAMS', `query: ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not taken here. `
      + `It takes ${allowed.join(', ')}.`);
  }
}

/** Why no call to the run's model can succeed, or null: its provider has no key on this Curator. */
export function missingKey(deps: Pick<OnDemandDeps, 'config'>, model: string, provider: string | null, modelSetting: string): string | null {
  if (provider === null) return null;
  const keys = deps.config.llmKeys?.keys as Record<string, string | undefined> | undefined;
  if (keys === undefined || keys[provider]) return null;
  return `the Curator has no key for ${provider}, the provider of ${model}. Add the key to the Curator's environment, `
    + `or point the ${modelSetting} setting at a model whose provider has one.`;
}

// ---------------------------------------------------------------------------
// How a run ends
// ---------------------------------------------------------------------------

export type RunEnd = { status: Exclude<OnDemandRunStatus, 'queued' | 'running'>; detail: string | null };

const again = (job: OnDemandJob): string => `${alreadyDone(job)} are not asked again`;

export function interrupted(job: OnDemandJob): RunEnd {
  return { status: 'interrupted', detail: `The run was stopped before it finished. Start it again to continue: ${again(job)}.` };
}

/** The run's limit, or a provider's own, refused a call. */
export function stoppedAtLimit(job: OnDemandJob, why: string): RunEnd {
  return {
    status: 'stopped',
    detail: `Stopped before every ${ON_DEMAND_ITEM[job].one} was reached: ${why}. Start it again with a new limit to continue: ${again(job)}.`,
  };
}

/** A dead key or model fails every call: give up rather than spend a run finding that out. */
export function stoppedAfterFailures(spec: OnDemandJobSpec, failedInARow: number, unit = 'notes'): RunEnd {
  return {
    status: 'stopped',
    detail: `Stopped: the model call failed for ${failedInARow} ${unit} in a row, so nothing more was asked. `
      + `The Curator's log has the reason; check the ${spec.modelSetting} setting and its provider, then start the run again.`,
  };
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/** The task that writes a finished run's journal entry. */
export type JournalTask = () => Promise<void>;

export interface StartedRun {
  run: OnDemandRunRow;
  /** False when a run, of this job or another, was already queued or running: that run is returned and nothing starts. */
  started: boolean;
}

/**
 * Accept a run and start it. On the server it continues in the background and this returns at
 * once; from the CLI it returns when the run has ended.
 *
 * The job has already read the request and resolved its model. `countScope` counts the notes in
 * scope, with no model call, and `execute` is the job's run.
 */
export async function startOnDemandRun(deps: OnDemandDeps, spec: OnDemandJobSpec, input: {
  request: object;
  /** The job's counts before anything is done. */
  counts: object;
  model: string;
  provider: string | null;
  limitUsd: number | undefined;
  trigger: RunTrigger;
  countScope(): Promise<number>;
  /** Why there is nothing to do, said when no note is in scope. */
  nothingToDo(): string;
  execute(runId: string): Promise<JournalTask | null>;
}): Promise<StartedRun> {
  const db = databaseOf(deps);
  if (deps.runBudget === undefined) throw new OnDemandError('UNAVAILABLE', 'This Curator cannot start a run with its own limit.');
  const limitUsd = input.limitUsd;
  if (limitUsd === undefined || !Number.isFinite(limitUsd) || limitUsd <= 0) {
    throw new OnDemandError('INVALID_PARAMS', 'limit_usd: state the most this run may spend, in USD. The preview gives an estimate.');
  }
  if (limitUsd > ON_DEMAND_LIMITS.maxLimitUsd) {
    throw new OnDemandError('INVALID_PARAMS', `limit_usd: at most ${ON_DEMAND_LIMITS.maxLimitUsd}. Run a narrower scope, or several runs.`);
  }
  // An early answer, before the scope is counted. The check that decides is made with the claim.
  const underCeiling = (): void => {
    const refused = overCeiling(runCeiling(deps), limitUsd);
    if (refused !== null) throw new OnDemandError('RUN_CEILING', refused);
  };
  underCeiling();
  const noKey = missingKey(deps, input.model, input.provider, spec.modelSetting);
  if (noKey !== null) throw new OnDemandError('NO_PROVIDER_KEY', `A run cannot start: ${noKey}`);
  if (catalogPricing(deps.config)(input.model) === null) {
    throw new OnDemandError('MODEL_UNPRICED', `The model ${input.model} has no price, so a limit cannot be kept. Add pricing to its Settings/Models note.`);
  }
  // A cheap look first, so a caller asking while a run is going gets it back without a scan.
  releaseAbandonedRuns(db);
  const running = activeOnDemandRun(db);
  if (running !== null) return { run: running, started: false };

  const notes = await input.countScope();
  if (notes === 0) throw new OnDemandError('NOTHING_TO_DO', input.nothingToDo());

  // The claim itself: another process may have started a run while the scope was counted.
  const id = randomUUID();
  const taken = claimOnDemandRun(db, {
    id, job: spec.job, request: input.request, counts: input.counts, limitUsd, model: input.model, provider: input.provider,
    trigger: input.trigger, notes, createdAt: new Date().toISOString(), owner: { host: hostname(), pid: process.pid },
  }, () => { releaseAbandonedRuns(db); }, underCeiling);
  if (taken !== null) return { run: taken, started: false };
  if (deps.builds !== undefined) {
    const builds = deps.builds;
    // The run holds the one-at-a-time key only until its row says how it ended. Its journal entry
    // waits its turn in the queue, perhaps behind a long wiki build, and is background work of
    // its own: a run that has ended must not keep the next one from starting.
    const work = async (): Promise<void> => {
      const journal = await input.execute(id);
      if (journal !== null) builds.start(`run-journal:${id}`, `${spec.noun} journal`, null, journal);
    };
    const queued = builds.start(ON_DEMAND_BUILD_KEY, `${spec.noun} run`, null, work, detail => {
      finishOnDemandRun(db, id, { status: 'interrupted', detail, at: new Date().toISOString() });
    });
    // The row check above already said no run was active; a build under the key means one is.
    if (!queued.started) {
      finishOnDemandRun(db, id, { status: 'failed', detail: 'Another run was already in progress.', at: new Date().toISOString() });
      throw new OnDemandError('CONFLICT', 'Another run is already in progress. Follow it with action "status".');
    }
  } else {
    const journal = await input.execute(id);
    await journal?.();
  }
  return { run: getOnDemandRun(db, id)!, started: true };
}

/** What a tool says when the run in the way belongs to another job, in place of that job's own view. */
export function otherJobsRun(run: OnDemandRunRow): Record<string, unknown> {
  return {
    run_id: run.id, job: run.job, status: run.status,
    detail: `A ${run.job} run is in progress, so nothing was started: one run at a time, whatever the job. `
      + `Follow it with the ${run.job} tool, action "status", and this run_id.`,
  };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** A job's side of a run in progress. */
export interface RunWork {
  /** What the run has done so far; saved after every turn. */
  counts: object;
  /** One turn in the curation queue, a batch of notes: how the run ended, or null to go on. */
  turn(): Promise<RunEnd | null>;
  /** The run's one journal line, and its figures. */
  summary(end: RunEnd, spentUsd: number): { line: string; stats: Record<string, unknown> };
}

/**
 * The run itself: turns in the curation queue until the job says it has ended, the limit refuses
 * a call, or the server stops. Never throws: every end is recorded on the run's row.
 *
 * `work` gets the deps with the run's own budgeted model client in place of the daily cap's, and
 * `chargeRun` for costs the ledger records under the run that its own calls did not make.
 *
 * Returns the task that writes the run's journal entry, for the caller to run after the run has
 * ended (null when there was no run). It is not awaited here: it queues behind other work, and
 * the run is over once its row says so.
 */
export async function executeOnDemandRun<Deps extends OnDemandDeps>(deps: Deps, spec: OnDemandJobSpec, runId: string,
  work: (worker: Deps, run: OnDemandRunRow) => RunWork): Promise<JournalTask | null> {
  const db = databaseOf(deps);
  const run = getOnDemandRun(db, runId);
  if (run === null || run.job !== spec.job || deps.runBudget === undefined) return null;
  const budget = deps.runBudget({ limitUsd: run.limit_usd, runRef: run.id });
  const job = work({
    ...deps, llm: budget.llm, chargeRun: usd => budget.charge(usd),
    runLeftUsd: async () => run.limit_usd - await budget.spentUsd(),
  }, run);
  let end: RunEnd | null = null;
  let spentUsd = 0;

  // Says this process still owns the run, whatever the run is waiting on: its turn in the queue
  // behind a long build, or a slow call. Without it another process would take the run for abandoned.
  const heartbeat = setInterval(() => {
    try { touchOnDemandRun(db, run.id, new Date().toISOString()); } catch { /* The next beat tries again. */ }
  }, ON_DEMAND_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    while (end === null) {
      if (deps.stopping?.()) { end = interrupted(spec.job); break; }
      end = await deps.queue.enqueue(`${spec.noun} run`, async () => {
        markOnDemandRunStarted(db, run.id, new Date().toISOString());
        const ended = await job.turn();
        spentUsd = await budget.spentUsd().catch(() => spentUsd);
        saveOnDemandRunProgress(db, run.id, job.counts, spentUsd);
        return ended;
      });
    }
  } catch (error) {
    end = { status: 'failed', detail: `The run failed: ${error instanceof Error ? error.message : String(error)}. Start it again to continue.` };
  } finally {
    clearInterval(heartbeat);
    budget.release();
  }

  try {
    spentUsd = await budget.spentUsd().catch(() => spentUsd);
    saveOnDemandRunProgress(db, run.id, job.counts, spentUsd);
    // An interruption recorded by shutdown itself stands.
    if (getOnDemandRun(db, run.id)?.status !== 'interrupted') {
      finishOnDemandRun(db, run.id, { ...end, at: new Date().toISOString() });
    }
  } catch (error) {
    console.warn(`[curator] ${spec.noun} run ${run.id}: outcome not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
  const ended = end;
  return () => journalRun(deps, spec, run, job.summary(ended, spentUsd));
}

/** One journal summary for the run, in place of a line per note. Best-effort. */
async function journalRun(deps: OnDemandDeps, spec: OnDemandJobSpec, run: OnDemandRunRow,
  summary: { line: string; stats: Record<string, unknown> }): Promise<void> {
  const { db, recorder } = deps;
  if (db === undefined || recorder === undefined) return;
  try {
    // This runs outside the queue, where another job may own the recorder's shared context:
    // the summary carries its own attribution and leaves that context alone.
    recorder.summaryWithContext({ runRef: run.id, trigger: run.trigger as RunTrigger, fn: spec.journalFn }, summary.line, summary.stats, false);
  } catch {
    console.warn(`[curator] ${spec.noun} run: journal summary failed`);
  }
  // The deterministic lede: a run's journal entry makes no model call.
  await deps.queue.enqueue(`${spec.noun} journal`, () => writeJournalEntry(
    { engine: deps.engine, llm: deps.llm, config: deps.config, db, recorder, usage: deps.usage },
    { kind: 'run-refs', runRefs: [run.id] }, `${spec.noun} run`, new Date(), { modelLede: false },
  )).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Following and undoing
// ---------------------------------------------------------------------------

/** What every job's view of a run shows, beside its own request and counts. */
export interface OnDemandRunFacts {
  run_id: string;
  status: OnDemandRunStatus;
  model: string;
  provider: string | null;
  /** Notes in scope when the run was accepted. */
  notes: number;
  spent_usd: number;
  limit_usd: number;
  detail: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  undone_at: string | null;
  /** Notes the run wrote that it can still try to undo. */
  undoable_notes: number;
}

export function runFacts(db: Database.Database, run: OnDemandRunRow<unknown, unknown>): OnDemandRunFacts {
  return {
    run_id: run.id,
    status: run.status,
    model: run.model,
    provider: run.provider,
    notes: run.notes,
    spent_usd: roundUsd(run.spent_usd),
    limit_usd: run.limit_usd,
    detail: run.detail,
    created_at: run.created_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
    undone_at: run.undone_at,
    undoable_notes: run.undone_at === null ? onDemandRunOperations(db, run.id).ids.length : 0,
  };
}

/** One of this job's runs by id. A run of another job is not this tool's to show or undo. */
function ownRun(db: Database.Database, spec: OnDemandJobSpec, runId: string, lister: string): OnDemandRunRow {
  const run = getOnDemandRun(db, runId);
  if (run === null) throw new OnDemandError('NOT_FOUND', `No run ${runId}. ${lister}`);
  if (run.job !== spec.job) {
    throw new OnDemandError('NOT_FOUND', `Run ${runId} is a ${run.job} run, not a ${spec.job} run. Use the ${run.job} tool for it.`);
  }
  return run;
}

/** One of the job's runs by id, or its most recent runs. */
export function onDemandStatus(deps: Pick<OnDemandDeps, 'db'>, spec: OnDemandJobSpec, runId?: string):
  { run: OnDemandRunRow } | { runs: OnDemandRunRow[] } {
  const db = databaseOf(deps);
  releaseAbandonedRuns(db);
  if (runId !== undefined) return { run: ownRun(db, spec, runId, 'Omit run_id to list recent runs.') };
  return { runs: listOnDemandRuns(db, ON_DEMAND_LIMITS.recentRuns, spec.job) };
}

export interface OnDemandUndo {
  run_id: string;
  dry_run: boolean;
  /** Notes put back as they were (or that would be, in a dry run). */
  restored: number;
  /** Notes edited since the run wrote them: left as they are. */
  conflicts: Array<{ node_id: string; reason: string }>;
  conflict_count: number;
  /** Writes the Engine no longer keeps an undo record for (it keeps them for a limited time). */
  no_longer_undoable: number;
}

const UNDO_CONFLICTS_SHOWN = 20;

/**
 * Undo everything a run wrote, as one request. A dry run by default: it reports what would be
 * restored. Notes edited since are conflicts and are left alone, and writes older than the
 * Engine's undo retention can no longer be undone; both are counted.
 */
export async function undoOnDemandRun(deps: OnDemandDeps, spec: OnDemandJobSpec, runId: string | undefined, dryRun: boolean):
  Promise<{ run: OnDemandRunRow; undo: OnDemandUndo }> {
  const db = databaseOf(deps);
  if (runId === undefined) throw new OnDemandError('INVALID_PARAMS', 'run_id: name the run to undo. Action "status" lists recent runs.');
  releaseAbandonedRuns(db);
  const run = ownRun(db, spec, runId, 'Action "status" lists recent runs.');
  if (run.status === 'queued' || run.status === 'running') {
    throw new OnDemandError('CONFLICT', 'The run is still in progress. Undo it once it has ended.');
  }
  if (run.undone_at !== null) throw new OnDemandError('CONFLICT', `The run was already undone at ${run.undone_at}.`);
  const { ids } = onDemandRunOperations(db, run.id);
  if (ids.length === 0) {
    return { run, undo: { run_id: run.id, dry_run: dryRun, restored: 0, conflicts: [], conflict_count: 0, no_longer_undoable: 0 } };
  }
  // In the queue, so an undo never interleaves with a build's writes.
  const undo = spec.undo;
  const undone: RecordedUndo = await deps.queue.enqueue(`${spec.noun} undo`,
    () => (undo === undefined ? deps.engine.undoOperations(ids, dryRun) : undo(deps, ids, dryRun)));
  // The Engine lists a conflict per reason, and one note can have two (edited since, and
  // changed by a later operation): count notes, since a run writes each note once.
  const reasons = new Map<string, string[]>();
  for (const conflict of undone.conflicts) {
    const known = reasons.get(conflict.node_id) ?? [];
    if (!known.includes(conflict.reason)) known.push(conflict.reason);
    reasons.set(conflict.node_id, known);
  }
  // A dry run restores nothing, so what it would restore is what is left of the run's writes.
  const restorable = ids.length - undone.not_found.length - reasons.size;
  if (!dryRun) markOnDemandRunUndone(db, run.id, new Date().toISOString());
  return {
    run,
    undo: {
      run_id: run.id,
      dry_run: dryRun,
      restored: dryRun ? Math.max(0, restorable) : undone.total_undone,
      conflicts: [...reasons].slice(0, UNDO_CONFLICTS_SHOWN).map(([node_id, why]) => ({ node_id, reason: why.join(', ') })),
      conflict_count: reasons.size,
      no_longer_undoable: undone.not_found.length,
    },
  };
}
