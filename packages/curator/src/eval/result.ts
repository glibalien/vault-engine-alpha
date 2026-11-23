import { estimateCostUsdWith } from '@vault/pricing';
import { addUsage, ZERO_USAGE } from '../pricing.js';
import type { PricingLookup } from '../pricing.js';
import type { LlmClient, StructuredCallRequest, StructuredCallResult } from '../llm/types.js';
import type { TokenUsage } from '../types.js';

/**
 * The line an eval prints with `--json`, for the root `eval:models` runner (#570). The Engine's
 * consolidation eval prints the same shape (`packages/engine/src/memories/consolidation-eval.ts`);
 * the runner (`scripts/eval-models.ts`) checks it and refuses another `version`.
 */
export const EVAL_RESULT_PREFIX = 'EVAL_RESULT ';

export type EvalScore =
  | { kind: 'exact'; correct: number; total: number }
  | { kind: 'judged'; coverage: number; precision: number; total: number };

/** Calls made to one model: how many, how many threw, tokens, time and estimated cost. */
export interface EvalCalls {
  model: string;
  label: string;
  provider: string | null;
  calls: number;
  failures: number;
  usage: TokenUsage;
  latencyMs: number;
  /** Estimated from the catalog's or the static table's rates; null when the model has none or a
   *  call's usage is unknown. */
  costUsd: number | null;
}

export interface EvalResult {
  version: 1;
  eval: string;
  score: EvalScore;
  /** Fixtures with no usable answer: the call threw or the answer couldn't be read. */
  failures: number;
  job: EvalCalls;
  /** The judge's calls, for the evals that judge the answers with a second call. */
  judge?: EvalCalls;
}

export interface EvalModelRef { model: string; label: string; provider: string | null }

/** Counts every structuredCall made through it; a call that throws counts as a failure. */
export class CallMeter {
  readonly calls: EvalCalls;
  constructor(ref: EvalModelRef, private readonly pricing: PricingLookup) {
    this.calls = { ...ref, calls: 0, failures: 0, usage: ZERO_USAGE, latencyMs: 0, costUsd: 0 };
  }

  /** `llm` with its structuredCall counted here; every other member is the client's own. */
  wrap(llm: LlmClient): LlmClient {
    const meter = this;
    return new Proxy(llm, {
      get(target, prop) {
        if (prop === 'structuredCall') return (req: StructuredCallRequest) => meter.measure(() => target.structuredCall(req));
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  private async measure(call: () => Promise<StructuredCallResult>): Promise<StructuredCallResult> {
    const started = Date.now();
    this.calls.calls += 1;
    try {
      const result = await call();
      // A provider that sent no usage left zeros: the call's cost is unknown, not $0.
      if (result.usageKnown === false) this.calls.costUsd = null;
      else this.add(result.usage);
      return result;
    } catch (err) {
      this.calls.failures += 1;
      const usage = (err as { usage?: TokenUsage } | null)?.usage;
      if (usage) this.add(usage);
      throw err;
    } finally {
      this.calls.latencyMs += Date.now() - started;
    }
  }

  private add(usage: TokenUsage): void {
    this.calls.usage = addUsage(this.calls.usage, usage);
    const rates = this.pricing(this.calls.model);
    this.calls.costUsd = rates === null || this.calls.costUsd === null ? null : estimateCostUsdWith(rates, this.calls.usage);
  }
}

/** True when the eval was asked for the runner's result line. */
export function wantsResultLine(argv: readonly string[]): boolean {
  return argv.includes('--json');
}

/** The value after `name`, or undefined. */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

export function resultLine(result: EvalResult): string {
  return `${EVAL_RESULT_PREFIX}${JSON.stringify(result)}`;
}

/** Mean coverage and precision over judged fixtures. */
export function judgedScore(scores: ReadonlyArray<{ coverage: number; precision: number }>, total: number): Extract<EvalScore, { kind: 'judged' }> {
  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  return { kind: 'judged', coverage: mean(scores.map(s => s.coverage)), precision: mean(scores.map(s => s.precision)), total };
}
