import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { currentDateLine } from './date-line.js';
import { EngineError, type Engine, type NearPair } from './engine.js';
import type { Config } from './config.js';
import type { CurationQueue } from './queue.js';
import type { UsageReporter } from './usage-reporter.js';
import type { ActionRecorder } from './journal/recorder.js';
import type { RunTrigger } from './db/runs.js';
import type { JsonSchema, LlmClient } from './llm/types.js';
import { ledgerVerdict, upsertVerdict } from './db/reconcile.js';
import { RejectionBreaker } from './rejection-breaker.js';

// ---------------------------------------------------------------------------
// Verdict prompt + schema (§4c)
// ---------------------------------------------------------------------------

export const RECONCILE_SYSTEM_PROMPT = `You are the Vault Curator's memory reconciler. You compare exactly TWO durable memories whose embeddings are near each other and return ONE verdict:

- "duplicate": both state the same fact. survivor_id = the better-phrased / more complete one.
- "contradiction": they cannot both be true now (the world changed or one is wrong). survivor_id = the currently-true one.
- "distinct": related but independently useful facts. No survivor.

Survivor guidance (guidance, not hard rules): prefer the later note_date (when the memory's source note was written), or valid_at for a memory with no dated note; then stronger evidence — kind "note" (extracted from a vault note) over "conversation" on equal footing; then recency. Each memory may name its source note and the projects that note is filed under. Memories from notes filed under different projects, or about different accounts, people or products, usually state different facts even when they read alike: answer "distinct" unless they plainly state the same fact about the same subject. When unsure whether two facts truly conflict, answer "distinct": expiring is reversible but noisy, and most near pairs are just topical neighbors.`;

export const RECONCILE_TOOL: { name: string; description: string; schema: JsonSchema } = {
  name: 'adjudicate_pair',
  description: 'Emit the verdict for the two memories.',
  schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['duplicate', 'contradiction', 'distinct'] },
      survivor_id: { type: 'integer', description: 'REQUIRED for duplicate/contradiction: the id of the memory that survives. Omit for distinct.' },
      reason: { type: 'string', description: 'One short sentence.' },
    },
    required: ['verdict'],
  },
};

function memberBlock(label: string, m: NearPair['a']): string {
  const bits = [
    `id ${m.id}`, `source ${m.source}`, `scope ${m.scope}`,
    ...(m.category ? [`category ${m.category}`] : []),
    ...(m.note_date ? [`note_date ${m.note_date}`] : m.valid_at ? [`valid_at ${m.valid_at}`] : []),
    ...(m.evidence_kind ? [`evidence ${m.evidence_kind}`] : []),
    ...(m.note_title ? [`note ${JSON.stringify(m.note_title)}`] : []),
    ...(m.note_projects?.length ? [`filed under ${m.note_projects.join('; ')}`] : []),
  ];
  return `${label} [${bits.join(', ')}]\n${m.content}`;
}

export function buildReconcileUser(p: NearPair): string {
  return `${memberBlock('MEMORY A', p.a)}\n\n${memberBlock('MEMORY B', p.b)}\n\n(embedding distance ${p.distance.toFixed(3)})`;
}

/** survivor_id validated against the pair (consolidator target_id posture); anything malformed → null (skip, retry next run). */
export function parseReconcileVerdict(
  output: unknown, aId: number, bId: number,
): { verdict: 'duplicate' | 'contradiction' | 'distinct'; survivorId?: number } | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;
  const verdict = o.verdict;
  if (verdict === 'distinct') return { verdict };
  if (verdict !== 'duplicate' && verdict !== 'contradiction') return null;
  const survivor = o.survivor_id;
  if (survivor !== aId && survivor !== bId) return null;
  return { verdict, survivorId: survivor as number };
}

// ---------------------------------------------------------------------------
// Phase orchestration — mirrors org-sweep.ts
// ---------------------------------------------------------------------------

/** Not a §6 knob on purpose: the spec's table defines exactly four keys.
 *  4000 mirrors memorySweepMaxTokens' reasoning-headroom default. */
export const RECONCILE_MAX_TOKENS = 4000;
const SHORTLIST_LIMIT = 200;

/** Structural subset of CoreDeps — declared here (not imported) to avoid a
 *  module cycle with core.ts, which imports runReconcile. */
export interface ReconcileDeps {
  engine: Engine;
  llm: LlmClient;
  config: Config;
  queue: CurationQueue;
  db?: Database.Database;
  usage?: UsageReporter;
  recorder?: ActionRecorder;
}

export interface ReconcileResult {
  ran: boolean;
  detail?: string;
  dryRun: boolean;
  bandTotal: number;
  considered: number;
  ledgerSkipped: number;
  adjudicated: number;
  duplicates: number;
  contradictions: number;
  distinct: number;
  /** Contradictions left alone because the survivor's note isn't later than the loser's (#351). */
  keptBoth: number;
  /** Pairs about different things of one kind, by their subjects: ledgered without a model call (#718). */
  keptApart: number;
  /** Pairs left for the next run because this run already changed one of their memories. */
  deferred: number;
  expired: number;
  previews: number;
  errors: number;
  /** Set when the stage stopped early because its model kept rejecting the request (#254). */
  stopped?: string;
}

function emptyReconcileResult(dryRun: boolean, detail?: string): ReconcileResult {
  return {
    ran: false, dryRun, bandTotal: 0, considered: 0, ledgerSkipped: 0, adjudicated: 0,
    duplicates: 0, contradictions: 0, distinct: 0, keptBoth: 0, keptApart: 0, deferred: 0, expired: 0, previews: 0, errors: 0,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * A contradiction expires a memory only when the survivor's note is strictly later than the
 * loser's. The sweep works newest note first, so in a backfill the later-extracted memory is often
 * the older fact, and a date tie gives nothing to choose by. A survivor with no dated note leaves
 * the verdict alone, so a chat's correction still wins. A loser drawn from a chat (the conversation
 * sweep's) is dated by its write, which is when it was said, so an old note's fact does not replace
 * it. This is the rule create-memory applies to its own "contradict" verdicts (#351).
 */
function keepsBoth(p: NearPair, verdict: NonNullable<ReturnType<typeof parseReconcileVerdict>>): boolean {
  if (verdict.verdict !== 'contradiction') return false;
  const [survivor, loser] = verdict.survivorId === p.a.id ? [p.a, p.b] : [p.b, p.a];
  const fromChat = loser.evidence_kind !== undefined && loser.evidence_kind !== 'note';
  const loserDate = fromChat ? loser.created_at.slice(0, 10) : loser.note_date;
  return !!survivor.note_date && !!loserDate && survivor.note_date <= loserDate;
}

function warnReconcile(msg: string, err: unknown): void {
  console.warn(`[curator] reconcile: ${msg}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ''}`);
}

/**
 * §4c nightly reconciliation: deterministic shortlist (near-pairs minus
 * ledgered-unchanged) → one bounded LLM verdict per pair → deterministic
 * action (expire loser with supersede link, or ledger 'distinct').
 * Serialized through the curation queue and NEVER rejects.
 */
export async function runReconcile(deps: ReconcileDeps, opts: { dryRun: boolean; trigger: RunTrigger }): Promise<ReconcileResult> {
  const { config, db } = deps;
  if (!config.reconcileEnabled) return emptyReconcileResult(opts.dryRun);
  if (!db) return emptyReconcileResult(opts.dryRun, 'no curator db');

  return deps.queue.enqueue('reconcile', async () => {
    const runRef = randomUUID();
    deps.usage?.setContext({ project: 'reconcile', runRef, purpose: 'reconcile' });
    deps.recorder?.setContext({ runRef, trigger: opts.trigger, fn: 'reconcile' });
    try {
      const r = await reconcile(deps, db, opts.dryRun);
      emitReconcileSummary(deps, r);
      return r;
    } catch (err) {
      warnReconcile('failed', err);
      const r = { ...emptyReconcileResult(opts.dryRun, err instanceof Error ? err.message : String(err)), ran: true, errors: 1 };
      emitReconcileSummary(deps, r);
      return r;
    } finally {
      deps.usage?.setContext(null);
      deps.recorder?.setContext(null);
    }
  });
}

async function reconcile(deps: ReconcileDeps, db: Database.Database, dryRun: boolean): Promise<ReconcileResult> {
  const { engine, llm, config } = deps;
  const result: ReconcileResult = { ...emptyReconcileResult(dryRun), ran: true };
  const model = config.reconcileModel ?? config.model;
  const system = `${RECONCILE_SYSTEM_PROMPT}\n\n${currentDateLine(new Date(), config.curatorTz)}`;

  const { pairs, total_in_band } = await engine.listMemoryNearPairs({ limit: SHORTLIST_LIMIT });
  result.bandTotal = total_in_band;
  result.considered = pairs.length;

  // Client-side ledger filter (an engine exclude param would grow unboundedly),
  // preserving distance-ascending order so likely-duplicates go first.
  const open: NearPair[] = [];
  for (const p of pairs) {
    const row = ledgerVerdict(db, p.a.id, p.b.id);
    const [uA, uB] = p.a.id < p.b.id ? [p.a.updated_at, p.b.updated_at] : [p.b.updated_at, p.a.updated_at];
    // A ledger row stands only while it agrees with the Engine's subject flag, which can change
    // without either memory's updated_at moving (a merge of two company notes redirects their
    // subjects in place): a kept-apart pair the flag no longer marks is adjudicated, and a pair the
    // flag marks now (a kept_both conflict from before #718, say) is ledgered kept apart (Codex, #726).
    const agrees = (row?.verdict === 'kept_apart') === (p.subjects_apart === true);
    if (row && row.updated_at_a === uA && row.updated_at_b === uB && agrees) {
      result.ledgerSkipped += 1;
      continue;
    }
    // About different things of one kind (#718): never merged, so no verdict is asked for. It is
    // ledgered under its own verdict, not 'kept_both', which wiki builds show as an open conflict;
    // a change to either memory (its subjects included) opens it again.
    if (p.subjects_apart === true) {
      result.keptApart += 1;
      if (!dryRun) {
        try {
          upsertVerdict(db, { idA: p.a.id, idB: p.b.id, updatedAtA: p.a.updated_at, updatedAtB: p.b.updated_at,
            verdict: 'kept_apart', adjudicatedAt: new Date().toISOString() });
        } catch (err) {
          result.errors += 1;
          warnReconcile(`ledger write failed for kept-apart pair ${p.a.id}/${p.b.id}`, err);
        }
      }
      continue;
    }
    if (open.length < config.reconcilePairCap) open.push(p);
  }

  const breaker = new RejectionBreaker('memory reconcile', model);
  // Memories this run expired or merged into: a later pair with one of them was flagged (subjects
  // included) before that change, so it waits for the next run's fresh listing (Codex, #726).
  const changed = new Set<number>();
  for (const p of open) {
    if (changed.has(p.a.id) || changed.has(p.b.id)) {
      result.deferred += 1;
      continue;
    }
    result.adjudicated += 1;
    let verdict: ReturnType<typeof parseReconcileVerdict>;
    try {
      const { output } = await llm.structuredCall({
        model, maxTokens: RECONCILE_MAX_TOKENS, system, user: buildReconcileUser(p),
        toolName: RECONCILE_TOOL.name, toolDescription: RECONCILE_TOOL.description, schema: RECONCILE_TOOL.schema,
      });
      breaker.succeeded();
      verdict = parseReconcileVerdict(output, p.a.id, p.b.id);
    } catch (err) {
      const budgetStop = breaker.budgetStop(err);
      if (budgetStop) {
        // The refused pair wasn't adjudicated; it and the rest stay unledgered for the next run.
        result.adjudicated -= 1; result.stopped = budgetStop; console.warn(`[curator] ${budgetStop}`);
        break;
      }
      result.errors += 1;
      warnReconcile(`verdict call failed for pair ${p.a.id}/${p.b.id}`, err);
      const stop = breaker.failed(err);
      // Pairs not attempted aren't ledgered, so the next run retries them.
      if (stop) { result.stopped = stop; console.warn(`[curator] ${stop}`); break; }
      continue; // not ledgered — retries next run
    }
    if (verdict === null) {
      result.errors += 1;
      warnReconcile(`unparseable verdict for pair ${p.a.id}/${p.b.id} — skipped (retries)`, null);
      continue;
    }

    const keptBoth = keepsBoth(p, verdict);
    if (dryRun) {
      result.previews += 1;
      const what = verdict.verdict === 'distinct' ? 'distinct' : keptBoth ? `contradiction: would keep both, ${verdict.survivorId}'s note is not later` : `${verdict.verdict}: would expire ${verdict.survivorId === p.a.id ? p.b.id : p.a.id} → ${verdict.survivorId}`;
      console.log(`[curator] reconcile (dry-run) pair ${p.a.id}/${p.b.id}: ${what}`);
      // A merge the live run would make defers later pairs with either memory there too (Codex, #726).
      if (verdict.verdict !== 'distinct' && !keptBoth) {
        changed.add(p.a.id);
        changed.add(p.b.id);
      }
      continue;
    }

    const stamp = {
      idA: p.a.id, idB: p.b.id, updatedAtA: p.a.updated_at, updatedAtB: p.b.updated_at,
      // Ledgered like 'distinct', so a kept pair doesn't take up the nightly cap again.
      verdict: keptBoth ? 'kept_both' : verdict.verdict, adjudicatedAt: new Date().toISOString(),
    };
    if (verdict.verdict === 'distinct' || keptBoth) {
      try {
        upsertVerdict(db, stamp);
        if (keptBoth) result.keptBoth += 1;
        else result.distinct += 1;
      } catch (err) {
        result.errors += 1;
        warnReconcile(`ledger write failed for ${stamp.verdict} pair ${p.a.id}/${p.b.id} — re-adjudicates next run`, err);
      }
      continue;
    }
    const survivor = verdict.survivorId as number;
    const loser = survivor === p.a.id ? p.b.id : p.a.id;
    try {
      await engine.expireMemory({
        id: loser,
        reason: verdict.verdict === 'duplicate' ? `duplicate-of:${survivor}` : 'contradicted',
        superseded_by: survivor,
        // Subjects can change while the model call runs: the Engine checks them as it writes (Codex, #726).
        unless_subjects_apart: true,
      });
      changed.add(loser);
      changed.add(survivor);
    } catch (err) {
      if (err instanceof EngineError && err.code === 'CONFLICT' && (err.details as { subjects_apart?: unknown } | undefined)?.subjects_apart === true) {
        result.keptApart += 1;
        try {
          upsertVerdict(db, { ...stamp, verdict: 'kept_apart' });
        } catch (ledgerErr) {
          result.errors += 1;
          warnReconcile(`ledger write failed for kept-apart pair ${p.a.id}/${p.b.id}`, ledgerErr);
        }
        continue;
      }
      result.errors += 1;
      warnReconcile(`expiry of ${loser} failed for pair ${p.a.id}/${p.b.id} — not ledgered (retries)`, err);
      continue;
    }
    // The expiry landed — count it regardless of whether the ledger write below succeeds.
    result.expired += 1;
    if (verdict.verdict === 'duplicate') result.duplicates += 1;
    else result.contradictions += 1;
    try {
      upsertVerdict(db, stamp); // only after the expiry landed
    } catch (err) {
      result.errors += 1;
      warnReconcile(`ledger write failed for pair ${p.a.id}/${p.b.id} AFTER expiry landed — pair re-adjudicates next run (engine expire-memory tolerates a no-op re-expire)`, err);
    }
  }

  console.log(
    `[curator] reconcile${dryRun ? ' (dry-run)' : ''}: band ${result.bandTotal}, ${result.considered} fetched, ` +
    `${result.ledgerSkipped} ledger-skipped, ${result.adjudicated} adjudicated → ` +
    `${result.duplicates} dup, ${result.contradictions} contra, ${result.distinct} distinct, ${result.keptBoth} kept both, ` +
    `${result.expired} expired, ${result.previews} previews, ${result.errors} errors`,
  );
  return result;
}

function emitReconcileSummary(deps: ReconcileDeps, r: ReconcileResult): void {
  if (!r.ran) return;
  const line =
    `band ${r.bandTotal}, ${r.adjudicated} adjudicated, ${r.duplicates} duplicate, ` +
    `${r.contradictions} contradiction, ${r.distinct} distinct, ${r.keptBoth} kept both, ` +
    `${r.keptApart > 0 ? `${r.keptApart} kept apart by subjects, ` : ''}${r.deferred > 0 ? `${r.deferred} left for the next run, ` : ''}` +
    `${r.expired} expired, ${r.errors} errors` +
    (r.stopped ? `; ${r.stopped}` : '');
  deps.recorder?.summary('reconcile', line, {
    bandTotal: r.bandTotal, adjudicated: r.adjudicated, expired: r.expired, errors: r.errors,
  }, r.dryRun);
}
