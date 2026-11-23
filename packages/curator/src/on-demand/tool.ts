import type { ToolResult } from '../auth/with-scope.js';
import { EngineError } from '../engine.js';
import { OnDemandError, engineWords } from './run.js';

/** What the on-demand tools (fill-fields, type-notes) say the same way. */

export function reply(payload: Record<string, unknown>, isError = false): ToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export function refuse(code: string, message: string): ToolResult {
  return reply({ ok: false, error: { code, message } }, true);
}

/** A failed action as the tool's refusal. */
export function refusal(error: unknown): ToolResult {
  if (error instanceof OnDemandError) return refuse(error.code, error.message);
  if (error instanceof EngineError) return refuse(error.code, engineWords(error));
  return refuse('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
}

/** Said with a preview whose sample made paid calls. */
export const DAILY_CAP_NOTE = 'The sample was paid from today\'s cap. A started run is paid from its own limit and leaves the cap alone.';

/** What a start says about the run it returns. */
export function startedDetail(run: { status: string; notes: number; detail: string | null }, started: boolean): string | null {
  if (!started) return 'A run is already in progress, so nothing was started. This is that run; follow it with action "status".';
  return run.status === 'queued' || run.status === 'running'
    ? `Queued a run over ${run.notes} notes. It goes on in the background; follow it with action "status" and this run_id. Do not start it again to check.`
    : run.detail;
}
