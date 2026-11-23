import { estimateCostUsdWith } from '@vault/pricing';
import { isBudgetRefusal } from '../budget.js';
import { safeDiagnostics } from '../llm/diagnostics.js';
import { StructuredCallFailure, type LlmClient } from '../llm/types.js';
import type { catalogPricing } from '../pricing.js';

/** What a preview's sample calls cost, so the whole set can be estimated from them. */

type Pricing = ReturnType<ReturnType<typeof catalogPricing>>;

export const roundUsd = (usd: number): number => Math.round(usd * 10_000) / 10_000;

/** What one answered call cost: the provider's own charge when every response carries one, else
 *  its token usage at the model's price. Null when neither is known: a reply with no usage
 *  reported has zeroed counters, which are not a free call. */
function callCostUsd(result: Awaited<ReturnType<LlmClient['structuredCall']>>, pricing: Pricing): number | null {
  const responses = safeDiagnostics(result.diagnostics)?.responses ?? [];
  if (responses.length > 0 && responses.every(response => response.providerCostUsd !== undefined)) {
    return responses.reduce((sum, response) => sum + response.providerCostUsd!, 0);
  }
  if (result.usageKnown === false || pricing === null) return null;
  return estimateCostUsdWith(pricing, result.usage);
}

/**
 * What a failed call cost, as far as can be told. A failure is not always free: a completion the
 * adapter rejected (cut off, malformed) was sent and billed.
 *
 * - `sent: false`: refused before it left (the budget, an oversized prompt), so no charge.
 * - A known charge: the usage or provider charge the failure carries, or zero when the provider
 *   answered with an HTTP error.
 * - `usd: null`: it was sent and nothing says what it cost (a timeout, a dropped connection).
 */
function failedCallCost(error: unknown, pricing: Pricing): { sent: boolean; usd: number | null } {
  if (isBudgetRefusal(error)) return { sent: false, usd: 0 };
  const httpStatus = typeof (error as { status?: unknown } | null)?.status === 'number';
  if (!(error instanceof StructuredCallFailure)) return { sent: true, usd: httpStatus ? 0 : null };
  const diagnostics = safeDiagnostics(error.diagnostics);
  if (error.usage === undefined && diagnostics?.adapterAttempts === 0) return { sent: false, usd: 0 };
  const responses = diagnostics?.responses ?? [];
  if (responses.length > 0 && responses.every(response => response.providerCostUsd !== undefined)) {
    return { sent: true, usd: responses.reduce((sum, response) => sum + response.providerCostUsd!, 0) };
  }
  if (error.usage !== undefined) return { sent: true, usd: pricing === null ? null : estimateCostUsdWith(pricing, error.usage) };
  // The provider's own HTTP error answer, and nothing else: it billed nothing.
  const answeredOnly = diagnostics !== undefined && responses.length === 0 && diagnostics.adapterAttempts === 1
    && diagnostics.failure?.status !== undefined;
  return { sent: true, usd: answeredOnly ? 0 : null };
}

export interface CallMeter {
  llm: LlmClient;
  /** Calls that were answered. */
  calls(): number;
  /** Calls that failed after they were sent. */
  failed(): number;
  /** What the calls cost; null once any call's cost is unknown. */
  costUsd(): number | null;
  costUnknownAfterFailure(): boolean;
  /** How long the answered calls took together. */
  ms(): number;
}

/**
 * Counts what the wrapped client's calls cost and how long the answered ones took. A call that
 * failed after it was sent counts too. The cost is null once any call's is unknown.
 */
export function metered(llm: LlmClient, price: (model: string) => Pricing): CallMeter {
  let calls = 0;
  let failed = 0;
  let cost: number | null = 0;
  let unknownAfterFailure = false;
  let ms = 0;
  return {
    llm: {
      ...llm,
      structuredCall: async request => {
        const started = Date.now();
        let result: Awaited<ReturnType<LlmClient['structuredCall']>>;
        try {
          result = await llm.structuredCall(request);
        } catch (error) {
          const charge = failedCallCost(error, price(request.model));
          if (charge.sent) {
            failed += 1;
            if (charge.usd === null) unknownAfterFailure = true;
            cost = charge.usd === null || cost === null ? null : cost + charge.usd;
          }
          throw error;
        }
        calls += 1;
        ms += Date.now() - started;
        const callCost = callCostUsd(result, price(request.model));
        cost = callCost === null || cost === null ? null : cost + callCost;
        return result;
      },
    },
    calls: () => calls,
    failed: () => failed,
    costUsd: () => cost,
    costUnknownAfterFailure: () => unknownAfterFailure,
    ms: () => ms,
  };
}

/** A sample's figures, and the whole set's estimated from them. */
export interface SampleEstimate {
  /** Sample calls that were sent, answered or not: a failed one may have been billed. */
  sample_asked: number;
  /** What the sample cost, charged to the daily cap. Null when it is not known. */
  sample_cost_usd: number | null;
  /** The sample's average cost times the notes in scope. Null without a priced sample. */
  estimated_cost_usd: number | null;
  /** The sample's average time times the notes in scope. Null without an answered call. */
  estimated_minutes: number | null;
  /** Why the cost is not known, when calls were sent and it is not. */
  cost_unknown: string | null;
}

/**
 * `notes` is the scope. A job whose call covers several items (memories, 20 to a call) passes how
 * many items the sample's calls covered, `perCall`, so the estimate is per item and not per call.
 */
export function sampleEstimate(meter: CallMeter, notes: number, modelPriced: boolean, perCall?: { sent: number; answered: number }): SampleEstimate {
  const answered = meter.calls();
  const asked = answered + meter.failed();
  const sampleCost = meter.costUsd();
  const sentItems = perCall?.sent ?? asked;
  const answeredItems = perCall?.answered ?? answered;
  const perNote = sentItems > 0 && sampleCost !== null ? sampleCost / sentItems : null;
  return {
    sample_asked: asked,
    sample_cost_usd: asked > 0 && sampleCost !== null ? roundUsd(sampleCost) : null,
    estimated_cost_usd: perNote === null ? null : Math.ceil(perNote * notes * 100) / 100,
    estimated_minutes: answered > 0 && answeredItems > 0 ? Math.max(1, Math.round((meter.ms() / answeredItems) * notes / 60_000)) : null,
    cost_unknown: asked === 0 || sampleCost !== null ? null
      : !modelPriced
        ? 'The model has no price in its Settings/Models note, so no cost can be estimated, and a run cannot start until it has one.'
        : meter.costUnknownAfterFailure()
          ? 'A sample call failed after it was sent and may have been billed, so the sample\'s cost is not known and no cost can be estimated.'
          : 'The provider did not report what a sample call used, so no cost can be estimated. A run still stops at the limit you give it.',
  };
}
