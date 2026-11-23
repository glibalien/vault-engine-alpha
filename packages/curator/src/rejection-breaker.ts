import { budgetRefusalDetail, isBudgetRefusal } from './budget.js';
import { providerRejectionSummary } from './llm/openai-compat.js';
import { StructuredCallFailure } from './llm/types.js';

/** Identical provider rejections in a row that stop a sweep stage. */
export const REJECTIONS_BEFORE_STOP = 3;

/**
 * Stops a per-item sweep stage once its model keeps rejecting the request (#254).
 *
 * A 4xx rejection of an unchanged request won't succeed on retry. Before this, a stage
 * whose model rejected every call (the memory sweep's 57 identical 400s on 2026-10-27)
 * kept sending requests and logged one error per item, night after night. Feed each model
 * call's outcome in: after REJECTIONS_BEFORE_STOP identical rejections in a row,
 * `failed` returns one line naming the stage, the model and the provider's reason, and
 * the stage stops. Items it doesn't attempt stay unledgered, so the next run retries them.
 *
 * Only client rejections count: 408, 409 and 429, 5xx, and transport errors (no status)
 * reset the streak and stay on the stage's existing path.
 *
 * A fail-closed call (conversation capture) throws a projected failure that keeps none of the
 * provider's text, only its diagnostics' scalar status and upstream name. Those identify its
 * rejections instead; the provider's reason stays in the adapter's server-log line.
 */
export class RejectionBreaker {
  private streak: { key: string; count: number } | null = null;

  constructor(private readonly stage: string, private readonly model: string,
    private readonly limit = REJECTIONS_BEFORE_STOP) {}

  /** Record a failed model call. Returns the stop line when the stage should stop. */
  failed(error: unknown): string | null {
    const rejection = rejectionOf(error);
    const status = rejection?.status;
    if (rejection === null || status === undefined || status < 400 || status >= 500
      || status === 408 || status === 409 || status === 429) {
      this.streak = null;
      return null;
    }
    const key = rejection.key;
    this.streak = this.streak?.key === key ? { key, count: this.streak.count + 1 } : { key, count: 1 };
    if (this.streak.count < this.limit) return null;
    return `${this.stage} stopped after ${this.streak.count} identical rejections from model ${this.model} (${key}); `
      + 'the rest is retried next run';
  }

  /**
   * The stop line when a call was refused for budget: the Curator's daily cap or the provider's
   * own key limit (#342). Later calls would be refused the same way, so the stage stops at once
   * rather than refusing and counting an error per item; what it didn't reach stays for a later run.
   * Callers check this before counting the failure.
   */
  budgetStop(error: unknown): string | null {
    if (!isBudgetRefusal(error)) return null;
    this.streak = null;
    return `${this.stage} stopped: ${budgetRefusalDetail(error)}; the rest is retried next run`;
  }

  /** Record a successful model call. */
  succeeded(): void {
    this.streak = null;
  }
}

/** The HTTP status of a failed call and the key that makes two rejections identical, or null. */
function rejectionOf(error: unknown): { status: number; key: string } | null {
  try {
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === 'number') return { status, key: providerRejectionSummary(error) ?? `HTTP ${status}` };
    if (error instanceof StructuredCallFailure && error.reason === 'provider_transport_failed') {
      const failure = error.diagnostics?.failure;
      if (failure?.kind === 'http' && failure.status !== undefined) {
        return { status: failure.status, key: `HTTP ${failure.status}`
          + (failure.upstream ? ` from ${failure.upstream}` : '') + (failure.code ? ` (${failure.code})` : '') };
      }
    }
  } catch {
    // A hostile error object is not a rejection the breaker can identify.
  }
  return null;
}
