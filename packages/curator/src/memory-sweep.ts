import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Engine } from './engine.js';
import type { ChangedNodeRef, EngineNode } from './types.js';
import { vaultOf, type Config } from './config.js';
import type { CurationQueue } from './queue.js';
import type { UsageReporter } from './usage-reporter.js';
import type { ActionRecorder } from './journal/recorder.js';
import type { RunTrigger } from './db/runs.js';
import type { LlmClient } from './llm/types.js';
import type { Memory, MemoryWriteResult } from './types.js';
import { persistSweepMemories } from './persist-memories.js';
import { ledgerHash, upsertLedger, lastSweepAt, setLastSweepAt } from './db/memory-sweep.js';
import { EXTRACT_TOOL, ownerLine, ownerName, parseExtractedFacts, parseUnsupportedIds, withDateLine } from './memory-extract.js';
import { stripCaptureBlocksForMemory } from './conversation-capture-markers.js';
import { isJournalNoteTitle } from './journal/render.js';
import { RejectionBreaker } from './rejection-breaker.js';
import { SPEND_LIMIT_TEXT } from './llm/diagnostics.js';
import { fieldValue } from './evidence.js';
import { localDate } from './date-line.js';

export { EXTRACT_TOOL, parseExtractedFacts, parseUnsupportedIds } from './memory-extract.js';

// ---------------------------------------------------------------------------
// Extraction prompt + schema (v1.6 memory sweep)
// ---------------------------------------------------------------------------

export const EXTRACT_SYSTEM_PROMPT = `You are the Vault Curator's memory sweep. You read ONE vault note and extract durable facts worth remembering across future AI sessions.

A durable fact is a standalone, self-contained statement that will still be true and useful months from now: stable preferences, decisions, relationships, recurring obligations, biographical or organizational facts. Write each fact so it makes sense with no surrounding context ("Avery's dentist is Dr. Reyes at Lakeview Dental" — never "the dentist mentioned in this note").

A rule on what may or may not be said, shared or claimed is durable too: a name or wording to use or avoid, a date or detail not to give, material to keep internal, a claim not to make. Give each one the category "rule". Use "preference" for a person's likes and habits, and "fact" for everything else.

For each fact, list in subjects the people, companies and projects it is about, each by its full name as the note gives it (a person's first and last name when the note has both). Never list the vault's owner, named at the top when known. Leave subjects empty when the fact is only about the owner.

Do NOT extract:
- Summaries or restatements of what the note is about
- Ephemera: one-off logistics, past appointments, transient status, weather, meals
- Anything listed under ALREADY KNOWN, or a trivial rewording of it
- Speculation, open questions, or to-dos

NOTE DATE, when given, is when the note was written. A note from more than a year ago describes the past: put its year on any fact that may have changed since — where someone lives or works, their role, pets, the tools and services they use, ongoing projects ("As of 2020, Avery's team tracked its work in Trello"). A fact that cannot go stale needs no date: where someone grew up or studied, an event with its own date.

Expect to emit NOTHING for most notes — an empty facts array is the normal outcome.`;

/** Extraction system prompt + per-run date line: relative dates in notes
 *  ("next Tuesday") must anchor to absolute dates in durable facts. */
export function sweepSystem(now: Date = new Date(), systemPrompt: string = EXTRACT_SYSTEM_PROMPT, timeZone?: string): string {
  return withDateLine(systemPrompt, EXTRACT_SYSTEM_PROMPT, now, timeZone);
}

const ISO_DAY = /\d{4}-\d{2}-\d{2}/g;

function realDay(day: string): boolean {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

/** When a note was written: its date field (the vault map's `dateField`; null = none, the title
 *  only), else the last YYYY-MM-DD in its title ("Week in review 2020-10-24 to 2020-10-30" →
 *  2020-10-30). Never the file's mtime: old notes are often written up, or edited, long after the fact. */
export function noteDate(fields: Record<string, unknown> | undefined, title: string, dateField: string | null): string | null {
  const raw = dateField === null ? undefined : fieldValue(fields?.[dateField]);
  const fromField = typeof raw === 'string' ? raw.trim().slice(0, 10) : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromField) && realDay(fromField)) return fromField;
  const fromTitle = (title.match(ISO_DAY) ?? []).filter(realDay);
  return fromTitle.at(-1) ?? null;
}

/** "NOTE DATE: 2020-10-30 (about 6 years before today)" — the age is spelled out so
 *  the model need not do date arithmetic to tell an old note from a recent one. */
export function noteDateLine(date: string, now: Date = new Date(), timeZone?: string): string {
  const today = localDate(now, timeZone); // as in the date line
  const years = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / (365.25 * 86_400_000));
  return years >= 1
    ? `NOTE DATE: ${date} (about ${years} year${years === 1 ? '' : 's'} before today)`
    : `NOTE DATE: ${date}`;
}

/** The variable user block: known-memory dedup context first, then the note.
 *  `bodyCharCap` mirrors the evidence builder's truncation knob (null = unlimited).
 *  `prior` (§4a re-verify) is the set of memories previously extracted FROM this
 *  note — present only when the caller is re-checking a changed note. */
export function buildExtractionUser(
  note: { title: string; file_path: string; body: string; date?: string | null },
  known: readonly Memory[],
  noteCap: number,
  bodyCharCap: number | null,
  prior: readonly Memory[] = [],
  now: Date = new Date(),
  timeZone?: string,
  /** The vault owner's name (the vault map's `ownerNote`), never a subject (#554). */
  owner: string | null = null,
): string {
  const body = bodyCharCap !== null && note.body.length > bodyCharCap
    ? `${note.body.slice(0, bodyCharCap)}\n…[truncated]`
    : note.body;
  const priorBlock = prior.length > 0
    ? `PREVIOUSLY EXTRACTED FROM THIS NOTE (verify): re-check each against the CURRENT note text below. Report the ids of any statement the note no longer supports in unsupported_ids; ids still supported are simply omitted.\n${prior.map(m => `- [id ${m.id}] ${m.content}`).join('\n')}\n\n`
    : '';
  const knownBlock = known.length > 0
    ? `ALREADY KNOWN (do not re-extract):\n${known.map(m => `- ${m.content}`).join('\n')}\n\n`
    : '';
  const dateLine = note.date ? `${noteDateLine(note.date, now, timeZone)}\n` : '';
  return `${priorBlock}${knownBlock}${ownerLine(owner)}NOTE: ${note.title}\nPATH: ${note.file_path}\n${dateLine}PER-NOTE CAP: at most ${noteCap} facts.\n\n${body}`;
}

/**
 * The extraction call for one note: the sweep's prompt, its ALREADY KNOWN block and the note's
 * date, owner and re-verify block. Shared by the nightly sweep and an on-demand extraction run
 * (#659), so the two send the same request; only `noteCap` may differ. Throws when the call fails.
 */
export async function extractNoteFacts(llm: LlmClient, config: Config, input: {
  model: string;
  note: { title: string; file_path: string; body: string; fields: Record<string, unknown> | undefined };
  known: readonly Memory[];
  prior: readonly Memory[];
  noteCap: number;
  now?: Date;
}): Promise<{ facts: ReturnType<typeof parseExtractedFacts>; output: unknown }> {
  const now = input.now ?? new Date();
  const { output } = await llm.structuredCall({
    model: input.model,
    maxTokens: config.memorySweepMaxTokens,
    system: sweepSystem(now, config.curatorMemorySweepPrompt ?? EXTRACT_SYSTEM_PROMPT, config.curatorTz),
    user: buildExtractionUser(
      { title: input.note.title, file_path: input.note.file_path, body: input.note.body, date: noteDate(input.note.fields, input.note.title, vaultOf(config).dateField) },
      input.known, input.noteCap, config.bodyCharCap, input.prior, now, config.curatorTz,
      ownerName(vaultOf(config).ownerNote),
    ),
    toolName: EXTRACT_TOOL.name,
    toolDescription: EXTRACT_TOOL.description,
    schema: EXTRACT_TOOL.schema,
  });
  return { facts: parseExtractedFacts(output, input.noteCap), output };
}

// ---------------------------------------------------------------------------
// Sweep orchestration (v1.6)
// ---------------------------------------------------------------------------

/** Structural subset of CoreDeps — declared here (not imported) to avoid a
 *  module cycle with core.ts, which imports runMemorySweep. */
export interface MemorySweepDeps {
  engine: Engine;
  llm: LlmClient;
  config: Config;
  queue: CurationQueue;
  db?: Database.Database;
  usage?: UsageReporter;
  recorder?: ActionRecorder;
}

export interface SweepNoteOutcome {
  note: string;
  results: MemoryWriteResult[];
}

export interface MemorySweepResult {
  /** false = gated off before doing anything (disabled / no allowlist / no db). */
  ran: boolean;
  detail?: string;
  dryRun: boolean;
  scanned: number;
  skippedLedger: number;
  /** Notes with no content_hash — unledgerable, warn-once skip (never an error: an
   *  error would pin the watermark and re-warn nightly until the note ages out). */
  skippedNoHash: number;
  /** Notes with malformed capture markers are skipped without exposing generated content to the model. */
  skippedMalformedCaptureMarkers: number;
  deferred: number;
  errors: number;
  /** Set when the stage stopped early because its model kept rejecting the request (#254). */
  stopped?: string;
  written: number;
  /** Facts the Engine's consolidation model judged already known: nothing written (#298). */
  alreadyKnown: number;
  /** Memories the Engine added without merging because its consolidation call failed; it
   *  flags them for replay-memory-consolidation (#346). */
  unmerged: number;
  /** All memories still flagged for that replay, from any run and any writer; null when unknown (#354). */
  pendingMerge: number | null;
  duplicates: number;
  previews: number;
  /** Live vault-scoped curator memory count (stock observability), when known. */
  liveMemoryTotal: number | null;
  notes: SweepNoteOutcome[];
  /** §4a: notes for which prior facts were fetched (had at least one). */
  reverifiedNotes: number;
  /** §4a: prior facts expired as unsupported by the current note text. */
  expired: number;
}

const SWEEP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** No provider text: only the match on it leaves the failure (#342, #346). */
export const ENGINE_KEY_SPENT_STOP = "memory sweep stopped: the Engine's consolidation key is out of budget, so new memories "
  + 'would not be merged; the rest is retried next run, and memories already added unmerged wait for replay-memory-consolidation';

/** Default per-run cap on extraction calls (the memorySweepExtractionCap setting),
 *  one per changed note. Candidates arrive newest first, so new notes go first
 *  and a backlog drains over several runs instead of spending the day's budget in one. */
export const SWEEP_EXTRACTION_CAP = 50;

function emptyResult(dryRun: boolean, detail?: string): MemorySweepResult {
  return {
    ran: false, dryRun, scanned: 0, skippedLedger: 0, skippedNoHash: 0, skippedMalformedCaptureMarkers: 0, deferred: 0, errors: 0,
    written: 0, alreadyKnown: 0, unmerged: 0, pendingMerge: null, duplicates: 0, previews: 0, liveMemoryTotal: null, notes: [],
    reverifiedNotes: 0, expired: 0,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function warnSweep(msg: string, err: unknown): void {
  console.warn(`[curator] memory sweep: ${msg}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ''}`);
}

/**
 * The v1.6 automatic memory collection sweep. Final phase of the nightly run:
 * enumerates allowlisted nodes changed since the watermark, skips ledger-matched
 * content, LLM-extracts durable facts per note, and persists them as vault-scoped
 * curator memories with provenance. Serialized through the curation queue and
 * NEVER rejects — every failure is captured in the result and logged.
 */
export async function runMemorySweep(deps: MemorySweepDeps, opts: { dryRun: boolean; trigger: RunTrigger }): Promise<MemorySweepResult> {
  const { config, db } = deps;
  if (!config.memorySweepEnabled) return emptyResult(opts.dryRun);
  if (config.memorySweepTypes.length === 0 && config.memorySweepPaths.length === 0) {
    return emptyResult(opts.dryRun, 'no allowlist configured');
  }
  if (!db) return emptyResult(opts.dryRun, 'no curator db');

  return deps.queue.enqueue('memory-sweep', async () => {
    const runRef = randomUUID();
    deps.usage?.setContext({ project: 'memory-sweep', runRef, purpose: 'memory-sweep' });
    deps.recorder?.setContext({ runRef, trigger: opts.trigger, fn: 'memory-sweep' });
    try {
      const r = await sweep(deps, db, opts.dryRun, runRef);
      if (r.ran) r.pendingMerge = await pendingMerge(deps);
      emitMemorySummary(deps, r);
      return r;
    } catch (err) {
      warnSweep('failed', err);
      const r = { ...emptyResult(opts.dryRun, err instanceof Error ? err.message : String(err)), ran: true, errors: 1 };
      emitMemorySummary(deps, r);
      return r;
    } finally {
      deps.usage?.setContext(null);
      deps.recorder?.setContext(null);
    }
  });
}

async function sweep(deps: MemorySweepDeps, db: Database.Database, dryRun: boolean, runRef: string): Promise<MemorySweepResult> {
  const { engine, llm, config } = deps;
  const sweepStart = new Date().toISOString();
  const since = config.memorySweepSince
    ?? lastSweepAt(db)
    ?? new Date(Date.now() - SWEEP_LOOKBACK_MS).toISOString();

  const { nodes: changed, truncated } = await engine.listChangedNodes({
    types: config.memorySweepTypes,
    pathPrefixes: config.memorySweepPaths,
    modifiedSince: since,
  });
  // The curator's own journal is a log of its runs, not a source of facts, and
  // it changes every night.
  const candidates = changed.filter(ref => !isJournalNoteTitle(ref.title));

  // One fetch for both jobs: the extraction prompt's ALREADY KNOWN block and the
  // live-stock report line. Best-effort — extraction still works with no context.
  // Include owner memories in the ALREADY KNOWN block (Task 5) so the sweep does
  // not re-extract facts the owner has already curated into Settings/Memories.md.
  let known: Awaited<ReturnType<Engine['listMemoriesWithTotal']>> = { memories: [], total: null };
  try {
    const [curatorStock, ownerStock] = await Promise.all([
      engine.listMemoriesWithTotal({ source: 'curator', scope: 'vault', limit: 100 }),
      engine.listMemoriesWithTotal({ source: 'owner', scope: 'vault', limit: 100 }),
    ]);
    known = {
      memories: [...ownerStock.memories, ...curatorStock.memories],
      total: curatorStock.total, // report stays curator-specific by design
    };
  } catch (err) {
    warnSweep('known-memory fetch failed (extraction continues without dedup context)', err);
  }

  const result: MemorySweepResult = {
    ...emptyResult(dryRun), ran: true, scanned: candidates.length, liveMemoryTotal: known.total,
  };
  const model = config.memorySweepModel ?? config.model;
  let capLeft = config.memorySweepCap;
  let extractionsLeft = config.memorySweepExtractionCap ?? SWEEP_EXTRACTION_CAP;
  let halted = false; // fact cap hit — every later note needing extraction defers whole
  // The oldest file_mtime among notes this run leaves unprocessed; the watermark
  // may advance up to it, never past it.
  let unfinishedFloor = Number.POSITIVE_INFINITY;
  let unfinishedMtimeUnknown = false;
  const leaveUnfinished = (ref: ChangedNodeRef): void => {
    if (ref.file_mtime === undefined) unfinishedMtimeUnknown = true;
    else unfinishedFloor = Math.min(unfinishedFloor, ref.file_mtime);
  };

  const breaker = new RejectionBreaker('memory sweep', model);
  for (const ref of candidates) {
    let node: EngineNode;
    try {
      node = await engine.getNode(ref.id);
    } catch (err) {
      result.errors += 1;
      leaveUnfinished(ref);
      warnSweep(`read failed for "${ref.title}"`, err);
      continue;
    }
    const hash = node.metadata?.content_hash;
    if (!hash) {
      result.skippedNoHash += 1;
      warnSweep(`no content_hash for "${ref.title}" — skipped`, null);
      continue;
    }
    if (ledgerHash(db, ref.id) === hash) {
      result.skippedLedger += 1;
      continue;
    }

    const stripped = stripCaptureBlocksForMemory(node.body ?? '');
    if (!stripped.ok) {
      result.skippedMalformedCaptureMarkers += 1;
      warnSweep(`malformed capture markers for "${ref.title}" (${ref.file_path}) — skipped`, stripped.diagnostic);
      continue;
    }

    // Past either run cap, a note that needs extraction stays unledgered for a later run.
    if (halted || extractionsLeft <= 0) {
      result.deferred += 1;
      leaveUnfinished(ref);
      continue;
    }

    // §4a re-verify: this note's hash changed — fetch the live facts previously
    // extracted FROM it so the same LLM call can re-check them. A failed fetch
    // fails the note (unledgered → retry): extracting without the verify block
    // would ledger the new hash and permanently skip this change's re-check.
    let prior: Memory[] = [];
    if (config.reverifyEnabled) {
      try {
        prior = await engine.listMemories({ evidence_node_id: ref.id, limit: 50 });
      } catch (err) {
        result.errors += 1;
        leaveUnfinished(ref);
        warnSweep(`prior-facts fetch failed for "${ref.title}" — note deferred`, err);
        continue;
      }
      if (prior.length > 0) result.reverifiedNotes += 1;
    }

    let facts;
    let rawOutput: unknown;
    extractionsLeft -= 1; // the extraction call is the capped unit, whether it succeeds or fails
    try {
      const extracted = await extractNoteFacts(llm, config, {
        model, note: { title: ref.title, file_path: ref.file_path, body: stripped.body, fields: node.fields },
        known: known.memories, prior, noteCap: config.memorySweepNoteCap,
      });
      breaker.succeeded();
      rawOutput = extracted.output;
      facts = extracted.facts;
    } catch (err) {
      leaveUnfinished(ref);
      const budgetStop = breaker.budgetStop(err);
      if (budgetStop) {
        halted = true; result.deferred += 1; result.stopped = budgetStop; console.warn(`[curator] ${budgetStop}`);
        continue;
      }
      result.errors += 1;
      warnSweep(`extraction failed for "${ref.title}"`, err);
      const stop = breaker.failed(err);
      if (stop) { halted = true; result.stopped = stop; console.warn(`[curator] ${stop}`); }
      continue;
    }

    // Expire unsupported priors BEFORE the run-cap check and before persisting
    // new facts, so a re-worded fact retires first and its replacement passes
    // same-source dedup — and so a note the run cap defers still retires its
    // stale priors this run (deferral only withholds the NEW facts, not the
    // stale-prior cleanup). An expiry failure is a write error: the note stays
    // unledgered and retries.
    let expiryErrors = 0;
    if (!dryRun && prior.length > 0) {
      const unsupported = parseUnsupportedIds(rawOutput, new Set(prior.map(p => p.id)));
      for (const id of unsupported) {
        try {
          await engine.expireMemory({ id, reason: 'evidence-changed' });
          result.expired += 1;
        } catch (err) {
          expiryErrors += 1;
          warnSweep(`expiry of memory ${id} failed for "${ref.title}"`, err);
        }
      }
    }
    result.errors += expiryErrors;

    // Note-granular run cap: a note whose facts don't all fit is deferred WHOLE
    // (stays unledgered, retries next run), and no further notes are extracted.
    if (facts.length > capLeft) {
      result.deferred += 1;
      halted = true;
      leaveUnfinished(ref);
      continue;
    }

    const writes = await persistSweepMemories(engine, facts, {
      dryRun,
      evidence: { node_id: ref.id, hash },
      runRef,
    });
    capLeft -= facts.length;
    result.written += writes.filter(w => w.action === 'created').length;
    result.alreadyKnown += writes.filter(w => w.action === 'noop').length;
    result.duplicates += writes.filter(w => w.action === 'duplicate').length;
    result.previews += writes.filter(w => w.action === 'preview').length;
    const writeErrors = writes.filter(w => w.action === 'error').length;
    result.errors += writeErrors;
    if (writes.length > 0) result.notes.push({ note: ref.title, results: writes });

    // A spent Engine key fails every later merge too, and the Engine would keep adding memories
    // unmerged, so stop here as for the Curator's own key (#346). This note's facts are written,
    // so it is ledgered below; its unmerged memories wait for replay-memory-consolidation.
    const unmerged = writes.filter(w => w.consolidationFailure !== undefined);
    result.unmerged += unmerged.length;
    if (!halted && unmerged.some(w => SPEND_LIMIT_TEXT.test(w.consolidationFailure ?? ''))) {
      halted = true;
      result.stopped = ENGINE_KEY_SPENT_STOP;
      console.warn(`[curator] ${ENGINE_KEY_SPENT_STOP}`);
    }

    // Ledger only a fully-processed note in a live run. A write or expiry error
    // leaves it unledgered so it retries; a zero-fact note IS processed (ledgered).
    if (writeErrors > 0 || expiryErrors > 0) leaveUnfinished(ref);
    else if (!dryRun) upsertLedger(db, ref.id, hash, new Date().toISOString());
  }

  // Watermark advances to sweep-START on a complete pass, otherwise only up to
  // the oldest unprocessed note: deferred or errored notes are unledgered, so
  // they must stay inside the next run's (inclusive) modified_since window. An
  // unprocessed note with no known mtime, or a truncated candidate scan (unseen
  // nodes exist), keeps the watermark where it is.
  if (!dryRun && !truncated && !unfinishedMtimeUnknown) {
    setLastSweepAt(db, new Date(Math.min(Date.parse(sweepStart), unfinishedFloor)).toISOString());
  }

  logSummary(result, since);
  return result;
}

function logSummary(r: MemorySweepResult, since: string): void {
  console.log(
    `[curator] memory sweep${r.dryRun ? ' (dry-run)' : ''}: ${r.scanned} scanned since ${since}, ` +
    `${r.skippedLedger} unchanged, ${r.written} written, ${r.alreadyKnown} already known, ${r.previews} would-write, ` +
    `${r.duplicates} duplicate, ${r.deferred} deferred, ${r.errors} errors` +
    (r.unmerged > 0 ? `, ${r.unmerged} added without merging` : '') +
    (r.skippedNoHash > 0 ? `, ${r.skippedNoHash} skipped (no content_hash)` : '') +
    (r.skippedMalformedCaptureMarkers > 0 ? `, ${r.skippedMalformedCaptureMarkers} skipped (malformed capture markers)` : '') +
    (r.expired > 0 || r.reverifiedNotes > 0 ? `, ${r.expired} expired (re-verify)` : '') +
    (r.liveMemoryTotal !== null ? `; live curator vault memories: ${r.liveMemoryTotal}` : ''),
  );
  if (r.dryRun) {
    for (const n of r.notes) {
      for (const w of n.results) console.log(`[curator]   would persist (${n.note}): ${w.content}`);
    }
  }
}

/** The merge backlog, from every writer. Best-effort: a failure here must not touch the sweep. */
async function pendingMerge(deps: MemorySweepDeps): Promise<number | null> {
  try {
    return await deps.engine.consolidationPendingTotal();
  } catch (err) {
    warnSweep('pending merge count unavailable', err);
    return null;
  }
}

function emitMemorySummary(deps: MemorySweepDeps, r: MemorySweepResult): void {
  if (!r.ran) return;
  const line =
    `${r.scanned} scanned, ${r.written} written, ${r.alreadyKnown} already known, ${r.duplicates} duplicate, ` +
    `${r.deferred} deferred, ${r.errors} errors` +
    (r.unmerged > 0 ? `, ${r.unmerged} added without merging` : '') +
    (r.pendingMerge !== null && r.pendingMerge > 0 ? `, ${r.pendingMerge} waiting for replay-memory-consolidation` : '') +
    (r.liveMemoryTotal !== null ? `; live curator memories: ${r.liveMemoryTotal}` : '') +
    (r.stopped ? `; ${r.stopped}` : '');
  deps.recorder?.summary('memory-sweep', line, {
    written: r.written,
    alreadyKnown: r.alreadyKnown,
    unmerged: r.unmerged,
    ...(r.pendingMerge !== null ? { pendingMerge: r.pendingMerge } : {}),
    duplicates: r.duplicates,
    deferred: r.deferred,
    errors: r.errors,
    expired: r.expired,
    reverifiedNotes: r.reverifiedNotes,
    skippedMalformedCaptureMarkers: r.skippedMalformedCaptureMarkers,
  }, r.dryRun);
}
