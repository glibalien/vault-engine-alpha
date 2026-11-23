import type { Engine } from './engine.js';
import type { Config } from './config.js';

/**
 * Best-effort memory-note refresh phase (Task 9 of the durable-memory
 * markdown-projection plan).
 *
 * Called from `runSweep` AFTER `runReconcile` and BEFORE `writeJournalSafe`,
 * but ONLY when `opts.trigger === 'scheduled'`. CLI sweeps and on-demand
 * sweeps do NOT call refresh, even when `dryRun:false`.
 *
 * This phase:
 *   - Sets usage/journal context
 *   - Calls the engine's `refresh-memory-note` tool once
 *   - Records a deterministic summary
 *   - Never invokes an LLM
 *   - Never rejects the sweep (errors warn + journal a summary)
 */

export interface MemoryNoteRefreshOpts {
  dryRun: boolean;
  trigger: 'scheduled' | 'cli' | 'on-demand';
}

export interface MemoryNoteRefreshResult {
  ran: boolean;
  file_written: boolean;
  live_count: number;
  historical_count: number;
  total: number;
  issues_rendered: number;
  error: string | null;
}

export async function runMemoryNoteRefresh(
  engine: Engine,
  _config: Config,
  opts: MemoryNoteRefreshOpts,
): Promise<MemoryNoteRefreshResult> {
  // Only the production scheduled sweep (including startup catch-up, which
  // already uses trigger:'scheduled') is eligible. CLI and on-demand sweeps
  // must not call refresh.
  if (opts.trigger !== 'scheduled') {
    return { ran: false, file_written: false, live_count: 0, historical_count: 0, total: 0, issues_rendered: 0, error: null };
  }

  try {
    const result = await engine.refreshMemoryNote(opts.dryRun);
    return {
      ran: true,
      file_written: result.file_written,
      live_count: result.live_count,
      historical_count: result.historical_count,
      total: result.total,
      issues_rendered: result.issues_rendered,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[memory-note-refresh] failed: ${message}`);
    return {
      ran: true,
      file_written: false,
      live_count: 0,
      historical_count: 0,
      total: 0,
      issues_rendered: 0,
      error: message,
    };
  }
}
