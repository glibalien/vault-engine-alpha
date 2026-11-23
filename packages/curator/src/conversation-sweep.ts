import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { flattenTranscript, type FlattenedTranscript, type TranscriptTurn } from '@vault/chat-core/transcript';
import { EXTRACT_TOOL, ownerLine, ownerName, parseExtractedFacts, parseUnsupportedIds, withDateLine } from './memory-extract.js';
import type { Engine } from './engine.js';
import { applyCreate } from './persist-memories.js';
import { vaultOf, type Config } from './config.js';
import type { CurationQueue } from './queue.js';
import type { UsageReporter } from './usage-reporter.js';
import type { ActionRecorder } from './journal/recorder.js';
import type { RunTrigger } from './db/runs.js';
import type { LlmClient } from './llm/types.js';
import type { ConversationMeta, Memory, MemoryWriteResult } from './types.js';
import {
  conversationLedgerHash, upsertConversationLedger,
  lastConversationSweepAt, setLastConversationSweepAt,
} from './db/conversation-sweep.js';
import { RejectionBreaker } from './rejection-breaker.js';

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

export const CONVERSATION_EXTRACT_SYSTEM_PROMPT = `You are the Vault Curator's conversation memory sweep. You read ONE finished chat conversation between the user and an AI assistant, and extract durable facts about the USER worth remembering across future sessions.

Extract ONLY what the user asserted or explicitly endorsed. The assistant's turns are context — they let you resolve what "yes, do that" refers to — but nothing the assistant said is itself a fact.

A durable fact is standalone and still true months from now: standing preferences and working habits, decisions and the reasoning the user gave for them, relationships and roles mentioned in passing, and corrections to something previously believed. Write each so it makes sense with no surrounding context ("Avery runs the curator on Qwen 3.7 Plus" — never "the model discussed above").

A standing rule the user gives on what may or may not be said, shared or claimed is durable too: a name or wording to use or avoid, a date or detail not to give, material to keep internal, a claim not to make. Give each one the category "rule". Use "preference" for the user's likes and habits, and "fact" for everything else.

For each fact, list in subjects the other people, companies and projects it is about, each by its full name as the conversation gives it (a person's first and last name when either side gives both). Never list the user. Leave subjects empty when the fact is only about the user.

Do NOT extract:
- Instructions to the assistant. "Attach the meeting summary to that node" is a request, not a fact. Most of this corpus is vault operations; expect nothing from them.
- Anything the assistant retrieved from the vault. Those facts are already recorded there and a separate process owns them. Content the assistant surfaced and the user merely read back is not a new fact.
- Anything the assistant reasoned, speculated, summarized, or researched.
- Tasks, todos, transient status, one-off logistics, past appointments.
- Anything listed under ALREADY KNOWN, or a trivial rewording of it.

Expect to emit NOTHING for most conversations — an empty facts array is the normal outcome.`;

/** Conversation extraction prompt + per-run date line. Blank override falls back
 *  to the built-in default. */
export function conversationSystem(
  now: Date = new Date(),
  systemPrompt: string = CONVERSATION_EXTRACT_SYSTEM_PROMPT,
  timeZone?: string,
): string {
  return withDateLine(systemPrompt, CONVERSATION_EXTRACT_SYSTEM_PROMPT, now, timeZone);
}

// ---------------------------------------------------------------------------
// Transcript rendering
// ---------------------------------------------------------------------------

/** Per-assistant-turn cap so one verbose answer cannot crowd out the exchange.
 *  A module constant, not a setting: the observed live maximum for a WHOLE
 *  conversation is 20,088 chars, so these are safety valves that never fire in
 *  practice and two more knobs would be noise. */
export const ASSISTANT_TURN_CHARS = 2000;
/** Whole-transcript backstop. */
export const TRANSCRIPT_CHARS = 40000;

const TRUNCATED = '\n…[truncated]';

/** Render flattened turns for the extraction prompt. User text is NEVER
 *  truncated — it is the only extractable material and the live median user
 *  contribution is 76 chars. */
export function renderTranscript(turns: readonly TranscriptTurn[]): string {
  const lines = turns.map((t) => {
    const text = t.role === 'assistant' && t.text.length > ASSISTANT_TURN_CHARS
      ? `${t.text.slice(0, ASSISTANT_TURN_CHARS)}${TRUNCATED}`
      : t.text;
    return `${t.role === 'user' ? 'USER' : 'ASSISTANT'}: ${text}`;
  });
  const out = lines.join('\n\n');
  return out.length > TRANSCRIPT_CHARS ? `${out.slice(0, TRANSCRIPT_CHARS)}${TRUNCATED}` : out;
}

/** The variable user block: re-verify context, then dedup context, then the
 *  transcript. Mirrors buildExtractionUser's ordering in memory-sweep.ts. */
export function buildConversationUser(
  conv: { title: string },
  turns: readonly TranscriptTurn[],
  known: readonly Memory[],
  convCap: number,
  prior: readonly Memory[] = [],
  /** The vault owner's name (the vault map's `ownerNote`), never a subject (#554). */
  owner: string | null = null,
): string {
  const priorBlock = prior.length > 0
    ? `PREVIOUSLY EXTRACTED FROM THIS CONVERSATION (verify): re-check each against the CURRENT transcript below. Report the ids of any statement the conversation no longer supports in unsupported_ids; ids still supported are simply omitted.\n${prior.map(m => `- [id ${m.id}] ${m.content}`).join('\n')}\n\n`
    : '';
  const knownBlock = known.length > 0
    ? `ALREADY KNOWN (do not re-extract):\n${known.map(m => `- ${m.content}`).join('\n')}\n\n`
    : '';
  return `${priorBlock}${knownBlock}${ownerLine(owner)}CONVERSATION: ${conv.title}\nPER-CONVERSATION CAP: at most ${convCap} facts.\n\n${renderTranscript(turns)}`;
}

// ---------------------------------------------------------------------------
// FTS query + transcript hash
// ---------------------------------------------------------------------------

const FTS_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'you', 'your', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'can', 'will', 'would', 'should', 'new', 'chat', 'about',
]);

/**
 * Build an FTS5-safe OR query from free text. A `list-memories` query runs the string
 * through `memories_fts MATCH`, so raw titles would be a syntax hazard — an
 * engine title like `Limerick on Café-au-Lait Prices` or anything containing
 * `NEAR(`, `*`, or a stray quote returns INVALID_PARAMS.
 *
 * Tokens are alphanumeric-only by construction (the split discards everything
 * else), so no FTS5 operator can survive; the quoting is belt-and-braces.
 * Returns '' when nothing survives — callers skip the search entirely.
 */
export function ftsQuery(text: string, maxTerms = 12): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || FTS_STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    terms.push(`"${raw}"`);
    if (terms.length >= maxTerms) break;
  }
  return terms.join(' OR ');
}

/** Ledger key: hashed over the FLATTENED turns, not the raw message JSON, so
 *  tool-payload churn or a viz re-render does not read as a content change.
 *
 *  The separator MUST be the NUL escape `\u0000`, never a space. With a space,
 *  one turn {user, "x user y"} and two turns {user,"x"},{user,"y"} both feed
 *  the hash "user x user y " — a genuinely changed conversation would then hash
 *  equal to its ledgered predecessor and be skipped forever. Message text
 *  cannot contain NUL. Type the escape sequence; never paste a raw control byte. */
export function transcriptHash(turns: readonly TranscriptTurn[]): string {
  const h = createHash('sha256');
  for (const t of turns) h.update(`${t.role}\u0000${t.text}\u0000`);
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Sweep orchestration
// ---------------------------------------------------------------------------

/** Structural mirror of MemorySweepDeps — declared here, not imported, to avoid
 *  a module cycle with core.ts, which imports runConversationSweep. */
export interface ConversationSweepDeps {
  engine: Engine;
  llm: LlmClient;
  config: Config;
  queue: CurationQueue;
  db?: Database.Database;
  usage?: UsageReporter;
  recorder?: ActionRecorder;
}

export interface ConversationSweepResult {
  /** false = gated off before doing anything (disabled / no db). */
  ran: boolean;
  detail?: string;
  dryRun: boolean;
  /** Conversations surviving the watermark + settle gates. */
  scanned: number;
  skippedLedger: number;
  /** Below the prose floor — ledgered and skipped, no LLM call. */
  skippedShort: number;
  /** Shape-regression guard: flattened to zero turns despite dropped parts. */
  skippedNoText: number;
  deferred: number;
  errors: number;
  /** Set when the stage stopped early because its model kept rejecting the request (#254). */
  stopped?: string;
  written: number;
  /** Facts the Engine's consolidation model judged already known: nothing written (#298). */
  alreadyKnown: number;
  duplicates: number;
  previews: number;
  liveMemoryTotal: number | null;
  reverifiedConversations: number;
  expired: number;
  conversations: Array<{ conversation: string; results: MemoryWriteResult[] }>;
}

const HOUR_MS = 3600_000;
/** Conversation title + opening user message feed the ALREADY KNOWN search. */
const SEARCH_SEED_CHARS = 400;
const KNOWN_LIMIT = 20;
const FALLBACK_KNOWN_LIMIT = 100;
const PRIOR_LIMIT = 50;

function emptyResult(dryRun: boolean, detail?: string): ConversationSweepResult {
  return {
    ran: false, dryRun, scanned: 0, skippedLedger: 0, skippedShort: 0, skippedNoText: 0,
    deferred: 0, errors: 0, written: 0, alreadyKnown: 0, duplicates: 0, previews: 0, liveMemoryTotal: null,
    reverifiedConversations: 0, expired: 0, conversations: [],
    ...(detail !== undefined ? { detail } : {}),
  };
}

function warnSweep(msg: string, err: unknown): void {
  console.warn(`[curator] conversation sweep: ${msg}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ''}`);
}

/**
 * The conversation memory sweep. Runs as a phase of the nightly sweep, after
 * the note sweep and before reconciliation: enumerates SETTLED conversations
 * changed since the watermark, skips ledger-matched and sub-floor ones, extracts
 * user-asserted durable facts, and persists them as vault-scoped curator
 * memories with conversation provenance. Serialized through the curation queue
 * and NEVER rejects — every failure is captured in the result and logged.
 */
export async function runConversationSweep(
  deps: ConversationSweepDeps,
  opts: { dryRun: boolean; trigger: RunTrigger },
): Promise<ConversationSweepResult> {
  const { config, db } = deps;
  if (!config.conversationSweepEnabled) return emptyResult(opts.dryRun);
  if (!db) return emptyResult(opts.dryRun, 'no curator db');

  return deps.queue.enqueue('conversation-sweep', async () => {
    const runRef = randomUUID();
    deps.usage?.setContext({ project: 'conversation-sweep', runRef, purpose: 'conversation-sweep' });
    deps.recorder?.setContext({ runRef, trigger: opts.trigger, fn: 'conversation-sweep' });
    try {
      const r = await sweep(deps, db, opts.dryRun, runRef);
      emitSummary(deps, r);
      return r;
    } catch (err) {
      warnSweep('failed', err);
      const r = { ...emptyResult(opts.dryRun, err instanceof Error ? err.message : String(err)), ran: true, errors: 1 };
      emitSummary(deps, r);
      return r;
    } finally {
      deps.usage?.setContext(null);
      deps.recorder?.setContext(null);
    }
  });
}

async function sweep(
  deps: ConversationSweepDeps, db: Database.Database, dryRun: boolean, runRef: string,
): Promise<ConversationSweepResult> {
  const { engine, llm, config } = deps;
  const startMs = Date.now();
  const settleMs = config.conversationSweepSettleHours * HOUR_MS;
  // The watermark NEVER advances past this instant, so conversations still
  // inside the settle window stay in the next run's candidate range. Advancing
  // to sweepStart would step over them and lose them permanently.
  const settleCutoff = new Date(startMs - settleMs).toISOString();
  const since = config.conversationSweepSince
    ?? lastConversationSweepAt(db)
    ?? new Date(startMs).toISOString();   // cold start: no backfill

  let metas: ConversationMeta[];
  try {
    metas = await engine.listConversations({ includeArchived: true });
  } catch (err) {
    warnSweep('conversation list failed', err);
    return { ...emptyResult(dryRun, err instanceof Error ? err.message : String(err)), ran: true, errors: 1 };
  }

  const candidates = metas
    .filter(m => m.updated_at > since && m.updated_at <= settleCutoff)
    .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0));

  // One untargeted fetch: the live-stock report line, and the ALREADY KNOWN
  // fallback for any conversation whose targeted search fails.
  // Include owner memories (Task 5) so the sweep does not re-extract
  // owner-curated facts from Settings/Memories.md.
  let fallbackKnown: Memory[] = [];
  let liveMemoryTotal: number | null = null;
  try {
    const [curatorStock, ownerStock] = await Promise.all([
      engine.listMemoriesWithTotal({ source: 'curator', scope: 'vault', limit: FALLBACK_KNOWN_LIMIT }),
      engine.listMemoriesWithTotal({ source: 'owner', scope: 'vault', limit: FALLBACK_KNOWN_LIMIT }),
    ]);
    fallbackKnown = [...ownerStock.memories, ...curatorStock.memories];
    liveMemoryTotal = curatorStock.total; // report stays curator-specific
  } catch (err) {
    warnSweep('known-memory fetch failed (extraction continues without fallback dedup context)', err);
  }

  const result: ConversationSweepResult = {
    ...emptyResult(dryRun), ran: true, scanned: candidates.length, liveMemoryTotal,
  };
  const model = config.conversationSweepModel ?? config.model;
  let capLeft = config.conversationSweepCap;
  let halted = false;

  const breaker = new RejectionBreaker('conversation sweep', model);
  for (const meta of candidates) {
    if (halted) { result.deferred += 1; continue; }

    let messages: unknown[];
    try {
      ({ messages } = await engine.getConversation(meta.id));
    } catch (err) {
      result.errors += 1;
      warnSweep(`read failed for "${meta.title}"`, err);
      continue;
    }

    const flat: FlattenedTranscript = flattenTranscript(messages);
    const hash = transcriptHash(flat.turns);

    if (conversationLedgerHash(db, meta.id) === hash) {
      result.skippedLedger += 1;
      continue;
    }

    // Shape-regression guard: parts existed but none survived the allowlist.
    // A spike here means the AI SDK part shape changed; without it a regression
    // would silently read as "everyone was terse". Recovery is a re-sweep via
    // CURATOR_CONVERSATION_SWEEP_SINCE.
    if (flat.turns.length === 0 && flat.droppedParts > 0) {
      result.skippedNoText += 1;
      warnSweep(`"${meta.title}" flattened to zero turns from ${flat.droppedParts} dropped parts — AI SDK part shape may have changed`, null);
    }

    // Also catches the zero-turn case: with conversationSweepMinUserChars set to
    // 0 (the registry permits it), userChars < 0 is never true, so without the
    // turns.length check a genuinely empty conversation would sail past this
    // floor and reach the LLM with an empty transcript.
    if (flat.userChars < config.conversationSweepMinUserChars || flat.turns.length === 0) {
      result.skippedShort += 1;
      // Ledger it: never re-examined until it grows past the floor (which
      // changes the hash and brings it back).
      if (!dryRun) upsertConversationLedger(db, meta.id, hash, new Date().toISOString());
      continue;
    }

    // Relevance-targeted ALREADY KNOWN. A successful search wins even when it
    // returns nothing; only a FAILURE falls back to the untargeted list.
    // Search both curator and owner memories (Task 5) so owner-curated facts
    // are not re-extracted from conversations.
    let known = fallbackKnown;
    const seed = `${meta.title} ${flat.turns.find(t => t.role === 'user')?.text.slice(0, SEARCH_SEED_CHARS) ?? ''}`;
    const query = ftsQuery(seed);
    if (query !== '') {
      try {
        const [curatorHits, ownerHits] = await Promise.all([
          engine.searchMemories({ query, source: 'curator', limit: KNOWN_LIMIT }),
          engine.searchMemories({ query, source: 'owner', limit: KNOWN_LIMIT }),
        ]);
        known = [...ownerHits, ...curatorHits];
      } catch (err) {
        warnSweep(`known-memory search failed for "${meta.title}" (extraction continues on the untargeted list)`, err);
      }
    }

    // §4a re-verify: fetch the live facts previously extracted FROM this
    // conversation so the same call can re-check them. A failed fetch fails the
    // conversation (unledgered → retry): extracting without the verify block
    // would ledger the new hash and permanently skip this change's re-check.
    let prior: Memory[] = [];
    if (config.reverifyEnabled) {
      try {
        prior = await engine.listMemories({ evidence_ref: meta.id, limit: PRIOR_LIMIT });
      } catch (err) {
        result.errors += 1;
        warnSweep(`prior-facts fetch failed for "${meta.title}" — conversation deferred`, err);
        continue;
      }
      if (prior.length > 0) result.reverifiedConversations += 1;
    }

    let facts;
    let rawOutput: unknown;
    try {
      const { output } = await llm.structuredCall({
        model,
        maxTokens: config.conversationSweepMaxTokens,
        system: conversationSystem(new Date(), config.curatorConversationSweepPrompt ?? CONVERSATION_EXTRACT_SYSTEM_PROMPT, config.curatorTz),
        user: buildConversationUser(
          { title: meta.title }, flat.turns, known,
          config.conversationSweepPerConversationCap, prior, ownerName(vaultOf(config).ownerNote),
        ),
        toolName: EXTRACT_TOOL.name,
        toolDescription: EXTRACT_TOOL.description,
        schema: EXTRACT_TOOL.schema,
      });
      breaker.succeeded();
      rawOutput = output;
      facts = parseExtractedFacts(output, config.conversationSweepPerConversationCap);
    } catch (err) {
      const budgetStop = breaker.budgetStop(err);
      if (budgetStop) {
        halted = true; result.deferred += 1; result.stopped = budgetStop; console.warn(`[curator] ${budgetStop}`);
        continue;
      }
      result.errors += 1;
      warnSweep(`extraction failed for "${meta.title}"`, err);
      const stop = breaker.failed(err);
      if (stop) { halted = true; result.stopped = stop; console.warn(`[curator] ${stop}`); }
      continue;
    }

    // Expire unsupported priors BEFORE the run-cap check, so a conversation the
    // cap defers still retires its stale priors this run.
    let expiryErrors = 0;
    if (!dryRun && prior.length > 0) {
      for (const id of parseUnsupportedIds(rawOutput, new Set(prior.map(p => p.id)))) {
        try {
          await engine.expireMemory({ id, reason: 'evidence-changed' });
          result.expired += 1;
        } catch (err) {
          expiryErrors += 1;
          warnSweep(`expiry of memory ${id} failed for "${meta.title}"`, err);
        }
      }
    }
    result.errors += expiryErrors;

    if (facts.length > capLeft) {
      result.deferred += 1;
      halted = true;
      continue;
    }

    const writes: MemoryWriteResult[] = [];
    for (const f of facts) {
      writes.push(await applyCreate(engine, {
        source: 'curator', scope: 'vault',
        content: f.content, ...(f.category !== undefined ? { category: f.category } : {}),
        ...(f.subjects && f.subjects.length > 0 ? { subjects: f.subjects } : {}),
        evidence: { kind: 'conversation', ref: meta.id, hash },
        usage: { runRef, sourceRef: 'conversation-sweep' },
      }, dryRun, 'conversation memory'));
    }
    capLeft -= facts.length;
    result.written += writes.filter(w => w.action === 'created').length;
    result.alreadyKnown += writes.filter(w => w.action === 'noop').length;
    result.duplicates += writes.filter(w => w.action === 'duplicate').length;
    result.previews += writes.filter(w => w.action === 'preview').length;
    const writeErrors = writes.filter(w => w.action === 'error').length;
    result.errors += writeErrors;
    if (writes.length > 0) result.conversations.push({ conversation: meta.title, results: writes });

    if (!dryRun && writeErrors === 0 && expiryErrors === 0) {
      upsertConversationLedger(db, meta.id, hash, new Date().toISOString());
    }
  }

  // Clean, complete pass only — a deferred or errored conversation is
  // unledgered and must stay inside the next run's window.
  if (!dryRun && result.deferred === 0 && result.errors === 0) {
    setLastConversationSweepAt(db, settleCutoff);
  }

  logSummary(result, since);
  return result;
}

function logSummary(r: ConversationSweepResult, since: string): void {
  console.log(
    `[curator] conversation sweep${r.dryRun ? ' (dry-run)' : ''}: ${r.scanned} scanned since ${since}, ` +
    `${r.skippedLedger} unchanged, ${r.skippedShort} below prose floor, ${r.written} written, ` +
    `${r.alreadyKnown} already known, ${r.previews} would-write, ${r.duplicates} duplicate, ${r.deferred} deferred, ${r.errors} errors` +
    (r.skippedNoText > 0 ? `, ${r.skippedNoText} EMPTY AFTER FLATTEN (check the AI SDK part shape)` : '') +
    (r.expired > 0 || r.reverifiedConversations > 0 ? `, ${r.expired} expired (re-verify)` : '') +
    (r.liveMemoryTotal !== null ? `; live curator vault memories: ${r.liveMemoryTotal}` : ''),
  );
  if (r.dryRun) {
    for (const c of r.conversations) {
      for (const w of c.results) console.log(`[curator]   would persist (${c.conversation}): ${w.content}`);
    }
  }
}

function emitSummary(deps: ConversationSweepDeps, r: ConversationSweepResult): void {
  if (!r.ran) return;
  const line =
    `${r.scanned} scanned, ${r.written} written, ${r.alreadyKnown} already known, ${r.duplicates} duplicate, ` +
    `${r.skippedShort} below floor, ${r.deferred} deferred, ${r.errors} errors` +
    (r.liveMemoryTotal !== null ? `; live curator memories: ${r.liveMemoryTotal}` : '') +
    (r.stopped ? `; ${r.stopped}` : '');
  deps.recorder?.summary('conversation-sweep', line, {
    written: r.written, alreadyKnown: r.alreadyKnown, duplicates: r.duplicates, deferred: r.deferred, errors: r.errors,
    expired: r.expired, reverifiedConversations: r.reverifiedConversations,
    skippedNoText: r.skippedNoText,
  }, r.dryRun);
}
