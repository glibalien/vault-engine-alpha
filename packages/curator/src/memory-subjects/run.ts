import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { budgetRefusalDetail, isBudgetRefusal } from '../budget.js';
import { vaultOf, type Config } from '../config.js';
import { recordOnDemandRunOperation, type OnDemandRunRow } from '../db/on-demand-runs.js';
import type { RunTrigger } from '../db/runs.js';
import { answeredNone, recordNoSubjects } from '../db/subject-verdicts.js';
import type { SubjectPassMemory, SubjectPassResult } from '../engine.js';
import type { JsonSchema } from '../llm/types.js';
import { ownerLine, ownerName } from '../memory-extract.js';
import { runCeiling, type RunCeiling } from '../on-demand/ceiling.js';
import { metered, sampleEstimate } from '../on-demand/cost.js';
import {
  ON_DEMAND_LIMITS,
  OnDemandError,
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
import { catalogPricing } from '../pricing.js';
import { parseSubjects } from '../synthesize.js';

/**
 * Subjects for memories by a model, on demand (#554, slice 2): the second half of the owner's
 * "free match, then model" (2026-11-20). The Engine's `backfill-memory-subjects` gave memories the
 * notes their text names in full, with no model. This asks a model about the live memories that
 * still have none, and those whose only subjects are the free match's, for the names it missed
 * (owner, 2026-11-20: "Dana Whitfield is the Acme account lead" had Dana Whitfield and not Acme), 20 to a call, with the model the nightly memory sweep writes subjects with,
 * and writes its names through the Engine (`memory-subject-pass`), which resolves them as it does
 * the sweeps' (one-word people only through the source note, the owner left out) and marks them
 * `set_by: 'model'`.
 *
 * What the model is shown with each memory: the title of the note it was drawn from, and the
 * people, companies and projects that note is or links to, so "Dana" can be written "Dana
 * Whitfield". A memory the model names no one in is kept in `subject_run_verdicts` and not asked
 * again until what it would be shown changes.
 *
 * The owner asked for it sample-first: the preview tries the model on up to 100 memories spread
 * through the set, writes nothing, and shows how each name would resolve.
 *
 * What a run shares with every other on-demand job is `../on-demand/run.ts`. This file is the job.
 */

export const SUBJECT_RUN_LIMITS = {
  ...ON_DEMAND_LIMITS,
  /** Memories a preview tries the model on, by default and at most. */
  defaultSample: 20,
  maxSample: 100,
  /** Memories per model call, and per turn of a run in the queue. */
  perCall: 20,
  /**
   * The least room a call gets for its answer, whatever memorySweepMaxTokens says. That setting
   * sizes one note's extraction; a call here answers for 20 memories, and on the owner's vault
   * Qwen 3.7 Plus reasoned for about 3,500 tokens before answering, so 2 of the first 7 calls hit
   * 4,000 and were cut off (2026-11-20). A call is billed for what it uses, not for this room.
   */
  minMaxTokens: 8_000,
  /** Memories per page when listing the scope. */
  scanPage: 500,
  /** Most memories one run takes on; the rest wait for the next run. */
  maxMemories: 20_000,
} as const;

export const SUBJECT_RUN_JOB = 'guess-memory-subjects' as const;

/** The job as the shared runner sees it. The model is the nightly memory sweep's: `memorySweepModel`, or `model` when that is not set. */
export function subjectRunJob(config: Pick<Config, 'memorySweepModel'>): OnDemandJobSpec {
  return {
    job: SUBJECT_RUN_JOB, noun: 'subject', modelSetting: config.memorySweepModel ? 'memorySweepModel' : 'model', journalFn: 'memory-sweep',
    undo: undoRecordedSubjects,
  };
}

function modelOf(deps: OnDemandDeps): { model: string; provider: string | null } {
  const model = deps.config.memorySweepModel ?? deps.config.model;
  return { model, provider: deps.config.modelProviders?.[model] ?? null };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export const SUBJECTS_TOOL: { name: string; description: string; schema: JsonSchema } = {
  name: 'name_subjects',
  description: 'Name who or what each memory is about.',
  schema: {
    type: 'object',
    properties: {
      memories: {
        type: 'array',
        description: 'One entry for every memory given, by its id.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: 'The memory\'s id, as given in brackets.' },
            subjects: {
              type: 'array', items: { type: 'string' },
              description: 'The people, companies and projects the memory is about, each by its full name; never the owner. Empty when it is only about the owner, or about no particular person, company or project.',
            },
          },
          required: ['id', 'subjects'],
        },
      },
    },
    required: ['memories'],
  },
};

export const SUBJECTS_SYSTEM_PROMPT = `You name who or what memories are about. A memory is one short fact a vault keeps about its owner's work and life.

For each memory, list in subjects the people, companies and projects it is about, each by its full name (a person's first and last name when you can tell both). A memory may say who it is already about ("has:"): list only the ones missing there, and leave subjects empty when none is missing. A memory may come with the note it was drawn from and the names that note holds. Those names are only there to spell out a name the memory gives in part: when the memory says "Dana" and the note lists "Dana Whitfield", write "Dana Whitfield". Never list a name from there that the memory itself does not mention: the people and companies of the note it came from are not what the memory is about. Otherwise write each name as the memory gives it.

Never list the vault's owner, named at the top when known: every memory is theirs. List only people, companies and projects: not products, places, teams or topics. Leave subjects empty when the memory is only about the owner, or about no particular person, company or project. Do not guess: a name the memory does not give or clearly mean is not a subject.

Answer for every memory, by its id.`;

/** A memory as the model is shown it. */
export function memoryAsShown(memory: SubjectPassMemory): string {
  const has = (memory.subjects ?? []).length > 0 ? `\n  has: ${memory.subjects!.join('; ')}` : '';
  const source = memory.source_title === null ? ''
    : `\n  from: "${memory.source_title}"${memory.source_names.length > 0 ? `; names there: ${memory.source_names.join('; ')}` : ''}`;
  return `[${memory.id}] ${memory.content.replace(/\s+/g, ' ').trim()}${has}${source}`;
}

export function buildSubjectsUser(memories: readonly SubjectPassMemory[], owner: string | null): string {
  return `${ownerLine(owner)}MEMORIES:\n${memories.map(memoryAsShown).join('\n')}`;
}

const ARTICLES = new Set(['the', 'a', 'an']);
const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word !== '');

/**
 * Whether a name the model gave is one the memory itself mentions: its first word (after "the",
 * "a" or "an") is a word of the memory's text. "Tomas Lind" passes for a memory that says
 * "Tomas"; a meeting's attendee the memory never mentions does not, nor "Ruth Okafor" for a
 * memory that names only "Sam Okafor". On the owner's vault the model copied the source note's
 * names onto memories about something else: 12 of 100 in the first sample (2026-11-20).
 */
export function namedInMemory(name: string, content: string): boolean {
  const words = wordsOf(name);
  while (words.length > 1 && ARTICLES.has(words[0]!)) words.shift();
  const first = words[0];
  return first !== undefined && wordsOf(content).includes(first);
}

/** The model's names by memory id, for the memories that were asked about only. */
export function parseSubjectAnswers(output: unknown, asked: ReadonlySet<number>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const entries = output && typeof output === 'object' ? (output as Record<string, unknown>).memories : undefined;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, subjects } = entry as Record<string, unknown>;
    const memoryId = typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id;
    if (typeof memoryId !== 'number' || !asked.has(memoryId) || out.has(memoryId)) continue;
    // No list is no answer, not "no one": an empty answer is kept and not asked again (Codex, #695).
    if (!Array.isArray(subjects)) continue;
    out.set(memoryId, parseSubjects(subjects));
  }
  return out;
}

/** What one call is, apart from its memories: the instructions, the owner and the settings that shape it. */
interface Call {
  model: string;
  owner: string | null;
  callHash: string;
}

/** The room a call gets for its answer: the memory sweep's setting, but never less than `minMaxTokens`. */
export function subjectCallMaxTokens(config: Pick<Config, 'memorySweepMaxTokens'>): number {
  return Math.max(config.memorySweepMaxTokens, SUBJECT_RUN_LIMITS.minMaxTokens);
}

function callOf(deps: OnDemandDeps, model: string): Call {
  const owner = ownerName(vaultOf(deps.config).ownerNote);
  const call = JSON.stringify({
    system: SUBJECTS_SYSTEM_PROMPT, tool: SUBJECTS_TOOL, owner, maxTokens: subjectCallMaxTokens(deps.config),
    reasoningEffort: deps.config.reasoningEffort ?? null,
  });
  return { model, owner, callHash: createHash('sha256').update(call).digest('hex') };
}

const shownHash = (memory: SubjectPassMemory): string => createHash('sha256').update(memoryAsShown(memory)).digest('hex');

// ---------------------------------------------------------------------------
// The memories in scope
// ---------------------------------------------------------------------------

interface Scope {
  /** The memories a run would ask about, oldest first. */
  memories: SubjectPassMemory[];
  /** Memories in scope that were already answered "none" with this call and model, and would be shown the same. */
  alreadyAsked: number;
  /** More memories were there than one run takes on. */
  truncated: boolean;
}

/** List the scope. No model call. Memories answered "none" before, and unchanged as shown, are left out as the listing is read. */
async function scanScope(deps: OnDemandDeps, call: Call): Promise<Scope> {
  const answered = deps.db === undefined ? new Map<number, string>() : answeredNone(deps.db, { callHash: call.callHash, model: call.model });
  const memories: SubjectPassMemory[] = [];
  let alreadyAsked = 0;
  let afterId = 0;
  for (;;) {
    const page = await deps.engine.listSubjectPassMemories(afterId, SUBJECT_RUN_LIMITS.scanPage);
    for (const memory of page.memories) {
      if (answered.get(memory.id) === shownHash(memory)) { alreadyAsked += 1; continue; }
      if (memories.length === SUBJECT_RUN_LIMITS.maxMemories) return { memories, alreadyAsked, truncated: true };
      memories.push(memory);
    }
    if (page.next_after_id === null) return { memories, alreadyAsked, truncated: false };
    afterId = page.next_after_id;
  }
}

// ---------------------------------------------------------------------------
// One call
// ---------------------------------------------------------------------------

type MemoryOutcome =
  /** Given subjects (or, in a dry run, would be). */
  | { kind: 'given'; memory: SubjectPassMemory; result: SubjectPassResult }
  /** The model named no one, or only the owner. */
  | { kind: 'none'; memory: SubjectPassMemory }
  /** The memory got subjects, was retired or went away meanwhile; nothing was written. */
  | { kind: 'changed'; memory: SubjectPassMemory }
  /** The model's answer left it out. */
  | { kind: 'unanswered'; memory: SubjectPassMemory }
  | { kind: 'error'; memory: SubjectPassMemory };

type CallOutcome =
  /** `dropped`: by memory, the names the model gave that the memory does not mention, left out. */
  | { kind: 'answered'; memories: MemoryOutcome[]; dropped: Map<number, string[]> }
  /** The call failed: every memory in it is an error. */
  | { kind: 'failed'; memories: MemoryOutcome[] }
  /** The limit refused the call: nothing more can be asked. */
  | { kind: 'limit'; detail: string };

interface CallWork {
  call: Call;
  dryRun: boolean;
  runRef: string;
  /** What the call is charged as: the run's own purpose, or the nightly sweep's for a preview's sample. */
  purpose: 'memory-subjects-run' | 'memory-sweep';
}

function warn(message: string, error: unknown): void {
  console.warn(`[curator] subject run: ${message}: ${error instanceof Error ? error.message : String(error)}`);
}

/** Ask the model about one batch of memories and write its names. Never throws. */
async function askBatch(deps: OnDemandDeps, db: Database.Database, work: CallWork, batch: readonly SubjectPassMemory[]): Promise<CallOutcome> {
  const errors = (): MemoryOutcome[] => batch.map(memory => ({ kind: 'error', memory }));
  let answers: Map<number, string[]>;
  try {
    const call = () => deps.llm.structuredCall({
      model: work.call.model,
      maxTokens: subjectCallMaxTokens(deps.config),
      system: SUBJECTS_SYSTEM_PROMPT,
      user: buildSubjectsUser(batch, work.call.owner),
      toolName: SUBJECTS_TOOL.name,
      toolDescription: SUBJECTS_TOOL.description,
      schema: SUBJECTS_TOOL.schema,
    });
    // Attributed in the call's own async scope, not the shared setContext slot: a preview sends
    // its calls side by side, and one call ending must not take the next one's label away.
    const context = { project: SUBJECT_RUN_JOB, runRef: work.runRef, purpose: work.purpose };
    const { output } = await (deps.usage === undefined ? call() : deps.usage.withContext(context, call));
    answers = parseSubjectAnswers(output, new Set(batch.map(memory => memory.id)));
  } catch (error) {
    if (isBudgetRefusal(error)) return { kind: 'limit', detail: budgetRefusalDetail(error) };
    warn(`the model call failed for ${batch.length} memories`, error);
    return { kind: 'failed', memories: errors() };
  }

  // A name the memory does not mention is left out; a memory left with none was answered "no one".
  const dropped = new Map<number, string[]>();
  for (const memory of batch) {
    const names = answers.get(memory.id);
    if (names === undefined) continue;
    const kept = names.filter(name => namedInMemory(name, memory.content));
    if (kept.length < names.length) dropped.set(memory.id, names.filter(name => !kept.includes(name)));
    answers.set(memory.id, kept);
  }
  const named = batch.filter(memory => (answers.get(memory.id) ?? []).length > 0);
  let results = new Map<number, SubjectPassResult>();
  if (named.length > 0) {
    try {
      const written = await deps.engine.writeModelSubjects(named.map(memory => ({ memory_id: memory.id, subjects: answers.get(memory.id)! })), work.dryRun);
      results = new Map(written.results.map(result => [result.memory_id, result]));
    } catch (error) {
      warn(`the subjects of ${named.length} memories could not be written`, error);
      return { kind: 'answered', dropped, memories: batch.map(memory => (answers.has(memory.id) && answers.get(memory.id)!.length > 0
        ? { kind: 'error', memory } : outcomeWithoutWrite(memory, answers))) };
    }
  }
  const now = new Date().toISOString();
  const memories = batch.map((memory): MemoryOutcome => {
    const names = answers.get(memory.id);
    if (names === undefined || names.length === 0) return outcomeWithoutWrite(memory, answers);
    const result = results.get(memory.id);
    if (result === undefined) return { kind: 'error', memory };
    if (result.outcome === 'written') return { kind: 'given', memory, result };
    if (result.outcome === 'none') return { kind: 'none', memory };
    return { kind: 'changed', memory };
  });
  if (!work.dryRun) {
    // A memory the model named no one in is not asked again until what it would be shown changes.
    for (const outcome of memories) {
      if (outcome.kind !== 'none') continue;
      recordNoSubjects(db, { memoryId: outcome.memory.id, shownHash: shownHash(outcome.memory), callHash: work.call.callHash, model: work.call.model }, now);
    }
  }
  return { kind: 'answered', memories, dropped };
}

function outcomeWithoutWrite(memory: SubjectPassMemory, answers: ReadonlyMap<number, string[]>): MemoryOutcome {
  return answers.has(memory.id) ? { kind: 'none', memory } : { kind: 'unanswered', memory };
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface SubjectSampleMemory {
  id: number;
  content: string;
  source_title: string | null;
  /** What would be written, each name with how it resolves: `linked` to the note titled `title`, `unresolved` (kept, and matched once a note answers to it; `held` when a one-word person's name waits for the source note to link the person), or `ambiguous`. Empty when the model named no one. */
  subjects: SubjectPassResult['subjects'];
  /** `given`, `none`, `changed`, `unanswered` or `error`. */
  outcome: MemoryOutcome['kind'];
  /** Names the model gave that the memory does not mention, left out; present when there were any. */
  dropped?: string[];
}

export interface SubjectRunPreview {
  /** Live memories a run would ask about: those with no subjects but the free match's. */
  memories: number;
  /** Memories in scope already answered "none" with this model and these instructions, and shown the same: a run does not ask again. */
  already_asked: number;
  scope_note: string | null;
  model: string;
  provider: string | null;
  /** The vault owner, as the model is told (the vault map's ownerNote); null when it is not set. */
  owner: string | null;
  sample: SubjectSampleMemory[];
  /** Of the sample: memories that would get subjects, names that would link to a note, names that would be kept for later, names left out because the memory does not mention them. */
  sample_counts: { given: number; none: number; linked: number; unmatched: number; dropped: number };
  /** Sample calls that were sent, answered or not. */
  sample_asked: number;
  sample_cost_usd: number | null;
  /** The sample's average cost per memory times the memories in scope. Null without a priced sample. */
  estimated_cost_usd: number | null;
  estimated_minutes: number | null;
  sample_note: string | null;
  run_ceiling: RunCeiling | null;
}

/** The memories a preview tries: spread evenly through the scope, which is in id order, so old and new ones both show. */
function sampleOf<T>(items: readonly T[], wanted: number): T[] {
  if (items.length <= wanted) return [...items];
  return Array.from({ length: wanted }, (_, index) => items[Math.floor((index * items.length) / wanted)]!);
}

function scopeNote(scope: Scope): string | null {
  const parts: string[] = [];
  if (scope.alreadyAsked > 0) {
    parts.push(`${scope.alreadyAsked} more memories were already asked (this model, these instructions) and the model named no one, or no one new; `
      + 'they are not asked again until what they would be shown changes.');
  }
  if (scope.truncated) {
    parts.push(`More than ${SUBJECT_RUN_LIMITS.maxMemories.toLocaleString('en-US')} memories are left to ask; one run takes the oldest `
      + `${SUBJECT_RUN_LIMITS.maxMemories.toLocaleString('en-US')}, and a run started after it takes the rest.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

function shortened(text: string): string {
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * What a run would cover and cost: the memories in scope, and what the model makes of a sample of
 * them spread through the set. The sample is real, paid calls under the daily cap, and a dry run
 * at the Engine: nothing is written, and each name shows how it would resolve.
 */
export async function previewSubjectRun(deps: OnDemandDeps, input: { sample?: number | undefined }): Promise<SubjectRunPreview> {
  const spec = subjectRunJob(deps.config);
  const { model, provider } = modelOf(deps);
  const db = databaseOf(deps);
  const call = callOf(deps, model);
  const scope = await scanScope(deps, call);
  const wanted = Math.min(input.sample ?? SUBJECT_RUN_LIMITS.defaultSample, SUBJECT_RUN_LIMITS.maxSample);
  const chosen = sampleOf(scope.memories, wanted);

  const sample: SubjectSampleMemory[] = [];
  const counts = { given: 0, none: 0, linked: 0, unmatched: 0, dropped: 0 };
  const meter = metered(deps.llm, catalogPricing(deps.config));
  let sampleNote: string | null = null;
  let sent = 0;
  let answered = 0;
  const noKey = missingKey(deps, model, provider, spec.modelSetting);
  if (chosen.length > 0 && noKey !== null) {
    sampleNote = `No sample was run: ${noKey}`;
  } else if (chosen.length > 0) {
    const runRef = randomUUID();
    let stopped: string | null = null;
    let failed = 0;
    // In the queue, like every model call. The sample's calls go out side by side: one after
    // another, five calls of 20 memories took five minutes on the owner's vault, past the 300
    // seconds an MCP client waits for a silent tool (2026-11-20). A run still asks one call a turn.
    await deps.queue.enqueue('subject preview', async () => {
      const work: CallWork = { call, dryRun: true, runRef, purpose: 'memory-sweep' };
      const chunks = batches(chosen, SUBJECT_RUN_LIMITS.perCall);
      const outcomes = await Promise.all(chunks.map(batch => askBatch({ ...deps, llm: meter.llm }, db, work, batch)));
      for (const [index, outcome] of outcomes.entries()) {
        const batch = chunks[index]!;
        if (outcome.kind === 'limit') { stopped = outcome.detail; continue; }
        sent += batch.length;
        if (outcome.kind === 'failed') { failed += batch.length; continue; }
        answered += batch.length;
        for (const result of outcome.memories) {
          const subjects = result.kind === 'given' ? result.result.subjects : [];
          if (result.kind === 'given') counts.given += 1;
          if (result.kind === 'none') counts.none += 1;
          for (const subject of subjects) {
            if (subject.status === 'linked') counts.linked += 1;
            else counts.unmatched += 1;
          }
          const left = outcome.dropped.get(result.memory.id) ?? [];
          counts.dropped += left.length;
          sample.push({
            id: result.memory.id, content: shortened(result.memory.content), source_title: result.memory.source_title,
            subjects, outcome: result.kind, ...(left.length > 0 ? { dropped: left } : {}),
          });
        }
      }
    });
    if (stopped !== null) {
      sampleNote = `The sample stopped early: ${stopped}. The sample is paid from the daily cap; a started run has its own limit.`;
    } else if (failed > 0) {
      sampleNote = `The model call failed for ${failed} of the ${chosen.length} sample memories. `
        + `The Curator's log has the reason; check the ${spec.modelSetting} setting and its provider.`;
    }
  }

  const estimate = sampleEstimate(meter, scope.memories.length, catalogPricing(deps.config)(model) !== null, { sent, answered });
  if (estimate.cost_unknown !== null) sampleNote = `${sampleNote === null ? '' : `${sampleNote} `}${estimate.cost_unknown}`;
  return {
    memories: scope.memories.length,
    already_asked: scope.alreadyAsked,
    scope_note: scopeNote(scope),
    model,
    provider,
    owner: call.owner,
    sample,
    sample_counts: counts,
    sample_asked: estimate.sample_asked,
    sample_cost_usd: estimate.sample_cost_usd,
    estimated_cost_usd: estimate.estimated_cost_usd,
    estimated_minutes: estimate.estimated_minutes,
    sample_note: sampleNote,
    run_ceiling: runCeiling(deps),
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** What a run did, in memories. A memory is counted once. */
export interface SubjectRunCounts {
  /** Memories sent to the model. */
  asked: number;
  /** ...of which were given subjects. */
  given: number;
  /** ...of which the model named no one in (or only the owner). They are not asked again until what they would be shown changes. */
  none: number;
  /** ...of which got subjects, were retired or went away between the listing and the write; nothing was written. */
  changed: number;
  /** ...of which the model's answer left out. Asked again by the next run. */
  unanswered: number;
  /** Memories whose call or write failed. */
  errors: number;
  /** Subjects written, over all memories. */
  subjects: number;
  /** ...of which linked to a note. */
  linked: number;
  /** ...of which kept as a name no note answers to yet, or several do: matched once one alone does. */
  unmatched: number;
  /** Names the model gave that their memory does not mention, left out. */
  dropped: number;
}

export const EMPTY_SUBJECT_RUN_COUNTS: SubjectRunCounts = {
  asked: 0, given: 0, none: 0, changed: 0, unanswered: 0, errors: 0, subjects: 0, linked: 0, unmatched: 0, dropped: 0,
};

/** A run's request: there is nothing to choose but the limit. Kept for the shape every run row has. */
export type SubjectRunRequest = Record<string, never>;

export type SubjectRunRow = OnDemandRunRow<SubjectRunRequest, SubjectRunCounts>;

function subjectRun(run: OnDemandRunRow<unknown, unknown>): SubjectRunRow {
  return { ...run, request: {}, counts: { ...EMPTY_SUBJECT_RUN_COUNTS, ...(run.counts as Partial<SubjectRunCounts>) } };
}

/**
 * Accept a run and start it. On the server it continues in the background and this returns at
 * once; from the CLI it returns when the run has ended. When a run is already in progress,
 * whatever its job, that run comes back and nothing starts.
 */
export async function startSubjectRun(deps: OnDemandDeps, input: { limitUsd?: number | undefined; trigger: RunTrigger }): Promise<StartedRun> {
  const { model, provider } = modelOf(deps);
  databaseOf(deps);
  const call = callOf(deps, model);
  let alreadyAsked = 0;
  return startOnDemandRun(deps, subjectRunJob(deps.config), {
    request: {}, counts: EMPTY_SUBJECT_RUN_COUNTS, model, provider, limitUsd: input.limitUsd, trigger: input.trigger,
    countScope: async () => {
      const scope = await scanScope(deps, call);
      alreadyAsked = scope.alreadyAsked;
      return scope.memories.length;
    },
    nothingToDo: () => alreadyAsked > 0
      ? `No memory is left to ask: the ${alreadyAsked} live memories in scope were already asked with this model and these instructions, and the model named no one new in them.`
      : 'Every live memory has subjects beyond the free match\'s.',
    execute: runId => runSubjects(deps, runId),
  });
}

function summaryLine(run: SubjectRunRow, counts: SubjectRunCounts, end: RunEnd, spentUsd: number): string {
  return `subject run: ${end.status}; ${counts.given} of ${run.notes} memories given subjects (${counts.subjects} subjects: `
    + `${counts.linked} linked to a note, ${counts.unmatched} kept for later; ${counts.dropped} not in their memory, left out), ${counts.none} with no one named, `
    + `${counts.changed} changed meanwhile, ${counts.unanswered} unanswered, ${counts.errors} errors; $${spentUsd.toFixed(4)} of $${run.limit_usd.toFixed(2)}`;
}

/**
 * The run itself: the scope is listed once, before anything is written (a memory given subjects
 * leaves the set, which would shift a listing read page by page), then asked about one call a
 * turn. The shared runner owns the loop and records the end.
 */
export function runSubjects(deps: OnDemandDeps, runId: string): Promise<JournalTask | null> {
  const spec = subjectRunJob(deps.config);
  return executeOnDemandRun(deps, spec, runId, (worker, stored) => {
    const db = databaseOf(deps);
    const run = subjectRun(stored);
    const counts: SubjectRunCounts = { ...EMPTY_SUBJECT_RUN_COUNTS };
    const stopped = interrupted(spec.job);
    let pending: SubjectPassMemory[] | null = null;
    let call: Call | null = null;
    let more = false;
    let failedInARow = 0;

    const turn = async (): Promise<RunEnd | null> => {
      if (pending === null || call === null) {
        call = callOf(deps, run.model);
        const scope = await scanScope(deps, call);
        pending = scope.memories;
        more = scope.truncated;
      }
      if (deps.stopping?.()) return stopped;
      const batch = pending.splice(0, SUBJECT_RUN_LIMITS.perCall);
      if (batch.length > 0) {
        const outcome = await askBatch(worker, db, { call, dryRun: false, runRef: run.id, purpose: 'memory-subjects-run' }, batch);
        // A refusal while shutting down is the shutdown, not the limit.
        if (outcome.kind === 'limit') return deps.stopping?.() ? stopped : stoppedAtLimit(spec.job, outcome.detail);
        failedInARow = outcome.kind === 'failed' ? failedInARow + 1 : 0;
        const at = new Date().toISOString();
        if (outcome.kind === 'answered') for (const names of outcome.dropped.values()) counts.dropped += names.length;
        for (const result of outcome.memories) {
          if (outcome.kind === 'answered') counts.asked += 1;
          switch (result.kind) {
            case 'given':
              counts.given += 1;
              for (const subject of result.result.subjects) {
                counts.subjects += 1;
                if (subject.status === 'linked') counts.linked += 1;
                else counts.unmatched += 1;
              }
              if (result.result.written_at === undefined) {
                // An Engine from before writes were named: the run could not be undone, so it goes no further.
                return {
                  status: 'failed',
                  detail: 'The Engine did not say when it wrote a memory\'s subjects, so this run stopped: it could not have been undone. '
                    + 'Update the Engine to the Curator\'s release, then start the run again.',
                };
              }
              recordOnDemandRunOperation(db, run.id, `memory:${result.memory.id}@${result.result.written_at}`, '', at);
              break;
            case 'none': counts.none += 1; break;
            case 'changed': counts.changed += 1; break;
            case 'unanswered': counts.unanswered += 1; break;
            case 'error': counts.errors += 1; break;
          }
        }
        if (failedInARow >= SUBJECT_RUN_LIMITS.failuresInARow) return stoppedAfterFailures(spec, failedInARow, 'calls');
      }
      if (pending.length > 0) return null;
      return more
        ? { status: 'stopped', detail: `The run took on the oldest ${SUBJECT_RUN_LIMITS.maxMemories.toLocaleString('en-US')} memories left to ask, which is the most one run does. Start it again for the rest.` }
        : { status: 'completed', detail: null };
    };

    return {
      counts,
      turn,
      summary: (end, spentUsd) => ({
        line: summaryLine(run, counts, end, spentUsd),
        stats: { run_id: run.id, status: end.status, memories: run.notes, ...counts, spent_usd: spentUsd, limit_usd: run.limit_usd },
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Following and undoing
// ---------------------------------------------------------------------------

export interface SubjectRunView extends Omit<OnDemandRunFacts, 'notes' | 'undoable_notes'> {
  job: typeof SUBJECT_RUN_JOB;
  /** Memories in scope when the run was accepted. */
  memories: number;
  /** Memories the run gave subjects that it can still try to take them from. */
  undoable_memories: number;
  counts: SubjectRunCounts;
}

export function viewSubjectRun(db: Database.Database, stored: OnDemandRunRow<unknown, unknown>): SubjectRunView {
  const run = subjectRun(stored);
  const { notes, undoable_notes, ...facts } = runFacts(db, run);
  return { ...facts, job: SUBJECT_RUN_JOB, memories: notes, undoable_memories: undoable_notes, counts: run.counts };
}

/** One run by id, or the most recent runs. */
export function subjectRunStatus(deps: Pick<OnDemandDeps, 'db' | 'config'>, runId?: string): { run: SubjectRunView } | { runs: SubjectRunView[] } {
  const db = databaseOf(deps);
  const found = onDemandStatus(deps, subjectRunJob(deps.config), runId);
  return 'run' in found ? { run: viewSubjectRun(db, found.run) } : { runs: found.runs.map(run => viewSubjectRun(db, run)) };
}

/** A write a run recorded (`memory:<id>@<written_at>`), or null for an id of another shape. */
function recordedWrite(id: string): { memory_id: number; written_at: string } | null {
  const match = /^memory:(\d+)@(.+)$/.exec(id);
  return match === null ? null : { memory_id: Number(match[1]), written_at: match[2]! };
}

/**
 * The job's undo: take back out the subjects each of the run's writes gave, by memory and the time
 * of the write, so a later run's subjects on the same memory stay (Codex, #695). A memory with
 * none of them left (the owner removed them, or it was purged) is "not found".
 */
async function undoRecordedSubjects(deps: OnDemandDeps, ids: readonly string[], dryRun: boolean): Promise<RecordedUndo> {
  const writes = ids.flatMap(id => recordedWrite(id) ?? []);
  const cleared = new Set<number>();
  for (const chunk of batches(writes, 200)) {
    for (const id of (await deps.engine.clearModelSubjects(chunk, dryRun)).cleared) cleared.add(id);
  }
  return {
    total_undone: dryRun ? 0 : cleared.size,
    conflicts: [],
    not_found: ids.filter(id => {
      const write = recordedWrite(id);
      return write === null || !cleared.has(write.memory_id);
    }),
  };
}

/** Undo everything a run wrote, as one request: its memories lose the subjects it gave them. A dry run by default. */
export async function undoSubjectRun(deps: OnDemandDeps, runId: string | undefined, dryRun: boolean): Promise<OnDemandUndo> {
  return (await undoOnDemandRun(deps, subjectRunJob(deps.config), runId, dryRun)).undo;
}
