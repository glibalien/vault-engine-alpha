import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import { insertJournalEvent, type JournalFunction, type JournalTrigger } from '../db/journal.js';

export interface JournalRunContext {
  runRef: string | null;
  trigger: JournalTrigger;
  fn: JournalFunction;
  project?: string;
}

/**
 * Records curator actions and per-function run summaries into journal_events,
 * best-effort — recording must never fail curation. Holds ONE mutable run
 * context (the UsageReporter idiom; safe because the CurationQueue serializes
 * runs). A mutation recorded with no context is persisted anyway (run_ref null)
 * and warned — it means a new write path forgot setContext, never a silent drop.
 */
export class ActionRecorder {
  private ctx: JournalRunContext | null = null;
  private readonly suspension = new AsyncLocalStorage<boolean>();

  constructor(private readonly db: Database.Database) {}

  setContext(ctx: JournalRunContext | null): void {
    this.ctx = ctx;
  }

  record(e: { action: string; nodeId?: string; target?: string; detail: string; dryRun?: boolean; fn?: JournalFunction }): void {
    if (this.suspension.getStore() === true) return;
    if (!this.ctx) console.warn(`[curator] journal: "${e.action}" recorded with no run context — a write path is missing setContext`);
    this.insert({
      kind: 'action', action: e.action, fn: e.fn ?? this.ctx?.fn ?? 'unknown',
      node_id: e.nodeId ?? null, target: e.target ?? null, detail: e.detail,
      dry_run: e.dryRun ? 1 : 0,
    });
  }

  /** Persist an action with explicit attribution, for work that runs outside the curation queue
   *  and so must not touch the shared context. */
  recordWithContext(context: JournalRunContext,
    e: { action: string; nodeId?: string; target?: string; detail: string; dryRun?: boolean }): void {
    if (this.suspension.getStore() === true) return;
    this.insert({
      kind: 'action', action: e.action, fn: context.fn,
      node_id: e.nodeId ?? null, target: e.target ?? null, detail: e.detail,
      dry_run: e.dryRun ? 1 : 0,
    }, context);
  }

  summary(fn: JournalFunction, line: string, stats: Record<string, unknown>, dryRun: boolean): void {
    if (this.suspension.getStore() === true) return;
    this.insert({
      kind: 'summary', action: null, fn,
      node_id: null, target: null, detail: JSON.stringify({ line, stats }),
      dry_run: dryRun ? 1 : 0,
    });
  }

  /** Persist a summary with explicit attribution without disturbing a caller's active context. */
  summaryWithContext(
    context: JournalRunContext,
    line: string,
    stats: Record<string, unknown>,
    dryRun: boolean,
  ): void {
    if (this.suspension.getStore() === true) return;
    this.insert({
      kind: 'summary', action: null, fn: context.fn,
      node_id: null, target: null, detail: JSON.stringify({ line, stats }),
      dry_run: dryRun ? 1 : 0,
    }, context);
  }

  /** Run `work` with recording off — used ONLY by the journal writer so the
   *  journal never logs its own note writes. */
  suspend<T>(work: () => Promise<T>): Promise<T> {
    return this.suspension.run(true, work);
  }

  private insert(e: {
    kind: 'action' | 'summary'; action: string | null; fn: JournalFunction;
    node_id: string | null; target: string | null; detail: string; dry_run: number;
  }, context: JournalRunContext | null = this.ctx): void {
    try {
      insertJournalEvent(this.db, {
        ts: new Date().toISOString(),
        run_ref: context?.runRef ?? null,
        trigger: context?.trigger ?? null,
        function: e.fn,
        kind: e.kind, action: e.action, node_id: e.node_id, target: e.target,
        detail: e.detail, dry_run: e.dry_run,
      });
    } catch {
      console.warn('[curator] journal event not recorded');
    }
  }
}
