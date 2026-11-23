import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ConsolidationError,
  type ConsolidationVerdict,
  type MemoryCandidate,
  type MemoryConsolidator,
} from '../mcp/tools/memory-consolidation.js';
import {
  MEMORY_DEDUP_K,
  MEMORY_NEAR_DUP,
  MEMORY_UNRELATED,
  clearConsolidationPending,
  consolidationFailureReason,
  decideTier,
  expireMemoryRow,
  getMemoryRow,
  noteDateBlock,
  noteDatedValidAt,
  markConsolidationPending,
  memoryNoteContext,
  recordMemoryHistory,
  type MemoryService,
} from './service.js';
import type { MemoryRow } from './types.js';
import { carrySubjects } from './subjects.js';
import { SubjectGuard, linkedNotesOf } from './subject-guard.js';

/**
 * Consolidation replay (#346): re-run create-memory's merge decision for live memories that
 * were added without it, and apply what create would have done.
 *
 * create-memory asks the consolidation model about a new memory whose nearest same-source,
 * same-scope neighbour sits in the gray band (0.06–0.35). When that call fails (a spent key,
 * an outage, an unusable answer) create adds the memory anyway and flags it in
 * `memory_consolidation_pending`. The replay takes those memories, or every live memory
 * created in a time window, in id order, and compares each one against the OLDER live
 * memories of its source and scope — the ones that existed when it was created — using its
 * stored vector. Then:
 *
 * - nothing near (add tier), or the model says "add": kept, taking the verdict's valid_at;
 * - a neighbour below 0.06 ("duplicate", which create would have refused) or the model says
 *   "noop": this memory is expired as `duplicate-of:<id>`, superseded by the neighbour;
 * - "update": the older memory is expired as `superseded-by-update`, superseded by this one,
 *   which inherits a category or metadata it lacks (create would have versioned the older
 *   memory into a new row carrying this memory's content);
 * - "contradict": the older memory is expired as `contradicted`, superseded by this one,
 *   which takes the verdict's valid_at;
 * - "update" or "contradict" from an earlier-dated note than the older memory, or "contradict" from
 *   one of the same date: both stay, counted as `kept_both` (#349, #351). The sweep works newest
 *   note first, so a low id is often the later word.
 *
 * Every expiry is reversible with `expire-memory reactivate:true`, and an edit to the surviving
 * row keeps what it replaced in `memory_history`. A dry run makes the same paid model calls and
 * changes nothing; it treats what a live run would expire as gone and what it would edit as
 * edited, so later verdicts see the same store. The job runs in the background, one per
 * MemoryService, and stops after CONSECUTIVE_FAILURES_BEFORE_STOP failed calls in a row
 * (a spent key fails every call). The spend is recorded on the Engine's own account.
 */

export const CONSECUTIVE_FAILURES_BEFORE_STOP = 3;
/** Examples kept per outcome in the status, so a dry run can be judged by eye. */
export const SAMPLES_PER_OUTCOME = 10;
export const REPLAY_MAX_LIMIT = 5000;

export type ReplayOutcome = 'unchanged' | 'kept_both' | 'duplicate' | 'noop' | 'update' | 'contradict' | 'skipped' | 'failed';

export interface ConsolidationReplaySelection {
  /** Only memories flagged after a failed consolidation call. */
  pending: boolean;
  /** Only memories created at or after this ISO time. */
  created_since?: string | undefined;
  /** Only memories created before this ISO time. */
  created_until?: string | undefined;
  source?: string | undefined;
  /** Resume cursor: only memories with a higher id. */
  after_id?: number | undefined;
  limit: number;
}

export interface ConsolidationReplaySample {
  id: number;
  content: string;
  outcome: Exclude<ReplayOutcome, 'unchanged'>;
  target_id?: number;
  target_content?: string;
  reason?: string;
}

export interface ConsolidationReplayStatus {
  state: 'idle' | 'running' | 'finished' | 'stopped';
  run_ref?: string;
  dry_run?: boolean;
  selection?: ConsolidationReplaySelection;
  started_at?: string;
  finished_at?: string;
  /** Set while a running job winds down after a stop request. */
  stop_requested?: boolean;
  selected: number;
  processed: number;
  /** Highest memory id handled; pass it as after_id to resume a stopped run. */
  last_id: number | null;
  outcomes: Record<ReplayOutcome, number>;
  model_calls: number;
  /** Memories that had a look-alike left out because their subjects keep them apart (#718). */
  kept_apart: number;
  /** Known cost of the model calls made; unpriced calls add nothing. */
  cost_usd: number;
  stop_reason?: string;
  samples: ConsolidationReplaySample[];
  /** Live memories flagged for replay right now. */
  pending_total: number;
}

/** A replay candidate with its source note, which the decision is shown (#352). */
type OlderCandidate = MemoryCandidate & { evidence_node_id: string | null };

interface SimulatedEdit {
  category?: string;
  valid_at?: string;
}

interface Job {
  status: ConsolidationReplayStatus;
  stopRequested: boolean;
  consecutiveFailures: number;
  lastFailure: string | null;
  /** Dry run only: the memories a live run would have expired by now. */
  wouldExpire: Set<number>;
  /** Dry run only: what a live run would have edited on surviving memories by now, for the
   *  fields a later memory's model call sees. Metadata inheritance isn't shown to the model. */
  wouldEdit: Map<number, SimulatedEdit>;
  /** Dry run only: the linked subject notes a live run would have carried onto surviving memories
   *  by now (`carrySubjects`), so the subject guard sees what a live run sees (Codex, #726). */
  wouldCarry: Map<number, Set<string>>;
  done: Promise<void>;
}

/** What `editSurvivor` would store on the memory being replayed, for a later candidate search. */
function simulatedEdit(
  row: MemoryRow,
  v: { outcome: ReplayOutcome; target?: MemoryCandidate | undefined; validAt?: string | undefined },
): SimulatedEdit | null {
  if (v.outcome === 'update') {
    return row.category === null && v.target?.category != null ? { category: v.target.category } : null;
  }
  if (v.outcome === 'unchanged' || v.outcome === 'kept_both' || v.outcome === 'contradict') {
    return v.validAt !== undefined ? { valid_at: v.validAt } : null;
  }
  return null;
}

const emptyOutcomes = (): Record<ReplayOutcome, number> => ({
  unchanged: 0, kept_both: 0, duplicate: 0, noop: 0, update: 0, contradict: 0, skipped: 0, failed: 0,
});

/** Thrown by `start` for a request it refuses; `code` is a tool error code. */
export class ConsolidationReplayRefusal extends Error {
  constructor(readonly code: 'CONFLICT' | 'UPSTREAM_ERROR', message: string) { super(message); }
}

const replays = new WeakMap<MemoryService, ConsolidationReplay>();

export class ConsolidationReplay {
  private job: Job | null = null;
  private readonly stmtOlderVault: Database.Statement<[Uint8Array, number, string, number], OlderCandidate>;
  private readonly stmtOlderNode: Database.Statement<[Uint8Array, number, string, string | null, number], OlderCandidate>;
  private readonly stmtVector: Database.Statement<[number], { vector: Buffer }>;
  private readonly stmtPendingTotal: Database.Statement<[], { c: number }>;

  /** The one replay for a MemoryService: every MCP session shares the production service, so
   *  they share its job and its status. */
  static for(service: MemoryService): ConsolidationReplay {
    let replay = replays.get(service);
    if (!replay) {
      replay = new ConsolidationReplay(service.database, () => service.consolidation);
      replays.set(service, replay);
    }
    return replay;
  }

  constructor(private readonly db: Database.Database, private readonly consolidator: () => MemoryConsolidator | undefined) {
    // Not a vec0 KNN: create's top-k is taken over the whole store, and here the store already
    // holds this memory and everything newer. Those can fill the k and hide every older neighbour,
    // so rank only the rows the memory may be compared with. A scan of a few thousand vectors is
    // a few milliseconds.
    const olderLive = (scope: string) =>
      `SELECT m.id, m.content, m.category, m.valid_at, m.evidence_node_id, vec_distance_cosine(v.vector, ?) AS distance
       FROM memories m
       JOIN memory_embedding_vec v ON v.id = m.vec_id
       WHERE m.id < ? AND m.source = ? AND m.expired_at IS NULL AND ${scope}
       ORDER BY distance ASC, m.id ASC
       LIMIT ?`;
    this.stmtOlderVault = db.prepare<[Uint8Array, number, string, number], OlderCandidate>(olderLive("m.scope != 'node'"));
    this.stmtOlderNode = db.prepare<[Uint8Array, number, string, string | null, number], OlderCandidate>(olderLive("m.scope = 'node' AND m.node_id IS ?"));
    this.stmtVector = db.prepare<[number], { vector: Buffer }>('SELECT vector FROM memory_embedding_vec WHERE id = ?');
    this.stmtPendingTotal = db.prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM memory_consolidation_pending p
       JOIN memories m ON m.id = p.memory_id
       WHERE m.expired_at IS NULL`,
    );
  }

  status(): ConsolidationReplayStatus {
    const pending_total = this.stmtPendingTotal.get()?.c ?? 0;
    if (!this.job) {
      return { state: 'idle', selected: 0, processed: 0, last_id: null, outcomes: emptyOutcomes(),
        model_calls: 0, kept_apart: 0, cost_usd: 0, samples: [], pending_total };
    }
    const s = this.job.status;
    return {
      ...s,
      ...(s.state === 'running' && this.job.stopRequested ? { stop_requested: true } : {}),
      outcomes: { ...s.outcomes },
      samples: [...s.samples],
      cost_usd: Math.round(s.cost_usd * 1e6) / 1e6,
      pending_total,
    };
  }

  /** Select the memories and start the job in the background; returns its first status. */
  start(selection: ConsolidationReplaySelection, dryRun: boolean): ConsolidationReplayStatus {
    if (this.job?.status.state === 'running') {
      throw new ConsolidationReplayRefusal('CONFLICT', `a consolidation replay is already running (run ${this.job.status.run_ref}) — check status or stop it first`);
    }
    const consolidator = this.consolidator();
    if (!consolidator) {
      throw new ConsolidationReplayRefusal('UPSTREAM_ERROR', 'memory consolidation is not configured (no model provider key), so there is nothing to replay with');
    }
    const ids = this.select(selection);
    const status: ConsolidationReplayStatus = {
      state: 'running', run_ref: randomUUID(), dry_run: dryRun, selection,
      started_at: new Date().toISOString(), selected: ids.length, processed: 0, last_id: null,
      outcomes: emptyOutcomes(), model_calls: 0, kept_apart: 0, cost_usd: 0, samples: [], pending_total: 0,
    };
    const job: Job = { status, stopRequested: false, consecutiveFailures: 0, lastFailure: null, wouldExpire: new Set(), wouldEdit: new Map(), wouldCarry: new Map(), done: Promise.resolve() };
    this.job = job;
    job.done = this.run(job, ids, consolidator, dryRun);
    return this.status();
  }

  /** Ask a running job to stop after the memory in hand. */
  stop(): ConsolidationReplayStatus {
    if (this.job?.status.state === 'running') this.job.stopRequested = true;
    return this.status();
  }

  /** Resolves when the current job, if any, has ended. For tests and shutdown. */
  async settled(): Promise<void> {
    await this.job?.done;
  }

  private select(sel: ConsolidationReplaySelection): number[] {
    const conditions = ['m.expired_at IS NULL'];
    const args: Array<string | number> = [];
    if (sel.pending) conditions.push('m.id IN (SELECT memory_id FROM memory_consolidation_pending)');
    if (sel.created_since !== undefined) { conditions.push('m.created_at >= ?'); args.push(sel.created_since); }
    if (sel.created_until !== undefined) { conditions.push('m.created_at < ?'); args.push(sel.created_until); }
    if (sel.source !== undefined) { conditions.push('m.source = ?'); args.push(sel.source); }
    if (sel.after_id !== undefined) { conditions.push('m.id > ?'); args.push(sel.after_id); }
    args.push(sel.limit);
    return this.db.prepare<Array<string | number>, { id: number }>(
      `SELECT m.id FROM memories m WHERE ${conditions.join(' AND ')} ORDER BY m.id ASC LIMIT ?`,
    ).all(...args).map((r) => r.id);
  }

  private async run(job: Job, ids: number[], consolidator: MemoryConsolidator, dryRun: boolean): Promise<void> {
    const s = job.status;
    try {
      for (const id of ids) {
        if (job.stopRequested) {
          s.state = 'stopped';
          s.stop_reason = 'stopped on request';
          break;
        }
        await this.replayOne(job, id, consolidator, dryRun);
        s.processed += 1;
        s.last_id = id;
        if (job.consecutiveFailures >= CONSECUTIVE_FAILURES_BEFORE_STOP) {
          s.state = 'stopped';
          s.stop_reason = `stopped after ${job.consecutiveFailures} failed consolidation calls in a row (last: ${job.lastFailure ?? 'unknown'}); `
            + `resume with after_id ${id} once the model can be called`;
          break;
        }
        // A memory that needs no model call never leaves the microtask queue, and a long run of
        // them would starve the Engine's requests, so give the event loop a turn each time.
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
      if (s.state === 'running') s.state = 'finished';
    } catch (e) {
      s.state = 'stopped';
      s.stop_reason = `replay failed: ${e instanceof Error ? e.message : String(e)}`;
      console.warn(`[memories] consolidation replay ${s.run_ref} failed: ${s.stop_reason}`);
    } finally {
      s.finished_at = new Date().toISOString();
      const o = s.outcomes;
      console.log(
        `[memories] consolidation replay ${s.run_ref}${dryRun ? ' (dry run)' : ''} ${s.state}: ${s.processed} of ${s.selected} — `
        + `${o.unchanged} unchanged, ${o.kept_both} kept both, ${o.duplicate} duplicate, ${o.noop} already known, ${o.update} update, `
        + `${o.contradict} contradict, ${o.skipped} skipped, ${o.failed} failed; ${s.model_calls} model calls`
        + (s.stop_reason ? `; ${s.stop_reason}` : ''),
      );
    }
  }

  private async replayOne(job: Job, id: number, consolidator: MemoryConsolidator, dryRun: boolean): Promise<void> {
    const row = getMemoryRow(this.db, id);
    if (!row || row.expired_at !== null) {
      this.record(job, 'skipped', row ?? null, { reason: 'no longer live' });
      return;
    }
    const vector = row.vec_id !== null ? this.stmtVector.get(row.vec_id)?.vector : undefined;
    if (!vector) {
      this.record(job, 'skipped', row, { reason: 'no stored vector' });
      return;
    }

    // The nearest older live memories of this source and scope: what create compared it against.
    const limit = MEMORY_DEDUP_K + job.wouldExpire.size;
    const nearest = (row.scope === 'node'
      ? this.stmtOlderNode.all(vector, row.id, row.source, row.node_id, limit)
      : this.stmtOlderVault.all(vector, row.id, row.source, limit))
      .filter((c) => !job.wouldExpire.has(c.id))
      .slice(0, MEMORY_DEDUP_K);
    // As create does: a look-alike about a different thing of the same kind is never merged (#718).
    // A dry run adds the subjects a live run would have carried onto survivors by now.
    const guard = SubjectGuard.build(this.db);
    const linked = guard.linkedOf([row.id, ...nearest.map((c) => c.id)]);
    const subjectsOf = (id: number): string[] => [...(linked.get(id) ?? []), ...(job.wouldCarry.get(id) ?? [])];
    const own = subjectsOf(row.id);
    const apart = new Set(own.length === 0 ? [] : nearest.filter((c) => guard.apart(own, subjectsOf(c.id))).map((c) => c.id));
    if (nearest.some((c) => apart.has(c.id) && c.distance <= MEMORY_UNRELATED)) job.status.kept_apart += 1;
    const candidates = nearest.filter((c) => !apart.has(c.id)).map((c) => ({ ...c, ...job.wouldEdit.get(c.id) }));
    const decision = decideTier(candidates, MEMORY_NEAR_DUP, MEMORY_UNRELATED);
    const sourceNotes = new Map(candidates.map((c) => [c.id, c.evidence_node_id]));

    if (decision.tier === 'add') {
      this.applyOrCount(job, row, dryRun, { outcome: 'unchanged' });
      return;
    }
    if (decision.tier === 'duplicate') {
      const nearest = candidates[0]!;
      this.applyOrCount(job, row, dryRun, {
        outcome: 'duplicate', target: nearest,
        reason: `distance ${nearest.distance.toFixed(4)} is below the duplicate threshold`,
      });
      return;
    }

    let verdict: ConsolidationVerdict;
    job.status.model_calls += 1;
    try {
      verdict = await consolidator.consolidate(
        { content: row.content, category: row.category, note: memoryNoteContext(this.db, row.evidence_node_id),
          candidates: decision.candidates.map((c) => ({ id: c.id, content: c.content, category: c.category, valid_at: c.valid_at,
            distance: c.distance, note: memoryNoteContext(this.db, sourceNotes.get(c.id)) })) },
        { service: 'engine', runRef: job.status.run_ref, sourceRef: 'consolidation-replay' },
      );
    } catch (e) {
      if (e instanceof ConsolidationError && typeof e.costUsd === 'number') job.status.cost_usd += e.costUsd;
      job.consecutiveFailures += 1;
      const reason = consolidationFailureReason(e);
      job.lastFailure = reason;
      // A window-selected memory whose replay failed joins the pending queue for a later run.
      if (!dryRun) markConsolidationPending(this.db, row.id, reason, new Date().toISOString());
      this.record(job, 'failed', row, { reason });
      return;
    }
    job.consecutiveFailures = 0;
    if (typeof verdict.costUsd === 'number') job.status.cost_usd += verdict.costUsd;

    const target = verdict.target_id !== undefined ? decision.candidates.find((c) => c.id === verdict.target_id) : undefined;
    // A verdict's date is capped at the memory's note day, as create caps it (#706).
    const dated = verdict.valid_at === undefined ? undefined
      : noteDatedValidAt(this.db, { kind: row.evidence_kind, node_id: row.evidence_node_id }, verdict.valid_at, row.created_at) ?? verdict.valid_at;
    const validAt = dated !== undefined ? { validAt: dated } : {};
    if (verdict.operation === 'add' || !target) {
      this.applyOrCount(job, row, dryRun, { outcome: 'unchanged', ...validAt });
      return;
    }
    const blocked = verdict.operation !== 'noop'
      && noteDateBlock(this.db, verdict.operation, row.evidence_node_id, getMemoryRow(this.db, target.id));
    if (blocked) {
      this.applyOrCount(job, row, dryRun, {
        outcome: 'kept_both', target,
        reason: `${blocked}; the model said ${verdict.operation}: ${verdict.reason}`,
        ...validAt,
      });
      return;
    }
    this.applyOrCount(job, row, dryRun, { outcome: verdict.operation, target, reason: verdict.reason, ...validAt });
  }

  /** Apply one verdict (live run) and count it; a dry run only counts it. */
  private applyOrCount(
    job: Job,
    row: MemoryRow,
    dryRun: boolean,
    v: { outcome: 'unchanged' | 'kept_both' | 'duplicate' | 'noop' | 'update' | 'contradict'; target?: MemoryCandidate; reason?: string; validAt?: string },
  ): void {
    if (dryRun) {
      if (v.outcome === 'duplicate' || v.outcome === 'noop') job.wouldExpire.add(row.id);
      else if ((v.outcome === 'update' || v.outcome === 'contradict') && v.target) job.wouldExpire.add(v.target.id);
      if (v.target && v.outcome !== 'unchanged' && v.outcome !== 'kept_both') {
        // What the live run's carrySubjects would give the survivor.
        const [from, to] = v.outcome === 'duplicate' || v.outcome === 'noop' ? [row.id, v.target.id] : [v.target.id, row.id];
        const carried = job.wouldCarry.get(to) ?? new Set<string>();
        for (const id of linkedNotesOf(this.db, [from]).get(from) ?? []) carried.add(id);
        for (const id of job.wouldCarry.get(from) ?? []) carried.add(id);
        job.wouldCarry.set(to, carried);
      }
      const edit = simulatedEdit(row, v);
      if (edit) job.wouldEdit.set(row.id, edit);
      this.record(job, v.outcome, row, v);
      return;
    }
    const now = new Date().toISOString();
    const applied = this.db.transaction((): boolean => {
      // Re-read: a create, an expiry or a purge may have landed while the model call ran.
      const current = getMemoryRow(this.db, row.id);
      if (!current || current.expired_at !== null) return false;
      if (v.outcome === 'unchanged' || v.outcome === 'kept_both') {
        this.editSurvivor(current, { validAt: v.validAt }, now);
      } else {
        const target = v.target ? getMemoryRow(this.db, v.target.id) : undefined;
        if (!target || target.expired_at !== null) return false;
        // Subjects can change while the model call runs (an update-memory, a merge of two notes):
        // ask the guard again on what is stored now (Codex, #726).
        const guard = SubjectGuard.build(this.db);
        const linked = guard.linkedOf([current.id, target.id]);
        if (guard.apart(linked.get(current.id) ?? [], linked.get(target.id) ?? [])) return false;
        const changed = v.outcome === 'duplicate' || v.outcome === 'noop'
          ? expireMemoryRow(this.db, row.id, { reason: `duplicate-of:${target.id}`, supersededBy: target.id, now })
          : v.outcome === 'update'
            ? expireMemoryRow(this.db, target.id, { reason: 'superseded-by-update', supersededBy: row.id, now })
            : expireMemoryRow(this.db, target.id, {
              reason: 'contradicted', supersededBy: row.id, invalidAt: v.validAt ?? current.valid_at ?? now, now,
            });
        if (!changed) return false;
        // The memory that stays is about what the retired one was about (#554).
        if (v.outcome === 'duplicate' || v.outcome === 'noop') carrySubjects(this.db, row.id, target.id, now);
        else carrySubjects(this.db, target.id, row.id, now);
        if (v.outcome === 'update') {
          this.editSurvivor(current, { category: target.category, metadataJson: target.metadata_json }, now);
        } else if (v.outcome === 'contradict') {
          this.editSurvivor(current, { validAt: v.validAt }, now);
        }
      }
      clearConsolidationPending(this.db, row.id);
      return true;
    })();
    if (applied) this.record(job, v.outcome, row, v);
    else this.record(job, 'skipped', row, { reason: 'changed while the replay ran' });
  }

  /** Give the surviving row what create would have stored on it: a verdict's valid_at, and a
   *  category or metadata it lacks from the memory it replaces. Keeps what it replaces in
   *  `memory_history`. Call inside the verdict's transaction. */
  private editSurvivor(
    row: MemoryRow,
    from: { validAt?: string | undefined; category?: string | null; metadataJson?: string | null },
    now: string,
  ): void {
    const previous: Record<string, unknown> = {};
    const sets: string[] = [];
    const args: Array<string | number> = [];
    if (row.category === null && from.category != null) {
      previous.category = null;
      sets.push('category = ?');
      args.push(from.category);
    }
    if (row.metadata_json === null && from.metadataJson != null) {
      previous.metadata = null;
      sets.push('metadata_json = ?');
      args.push(from.metadataJson);
    }
    if (from.validAt !== undefined && from.validAt !== row.valid_at) {
      previous.valid_at = row.valid_at;
      sets.push('valid_at = ?');
      args.push(from.validAt);
    }
    if (sets.length === 0) return;
    recordMemoryHistory(this.db, row.id, 'edited', 'consolidation-replay', previous, now);
    this.db.prepare(`UPDATE memories SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now, row.id);
  }

  private record(
    job: Job,
    outcome: ReplayOutcome,
    row: MemoryRow | null,
    detail: { target?: MemoryCandidate | undefined; reason?: string | undefined },
  ): void {
    const s = job.status;
    s.outcomes[outcome] += 1;
    if (outcome === 'unchanged' || row === null) return;
    if (s.samples.filter((x) => x.outcome === outcome).length >= SAMPLES_PER_OUTCOME) return;
    s.samples.push({
      id: row.id,
      content: row.content,
      outcome,
      ...(detail.target ? { target_id: detail.target.id, target_content: detail.target.content } : {}),
      ...(detail.reason ? { reason: detail.reason } : {}),
    });
  }
}
