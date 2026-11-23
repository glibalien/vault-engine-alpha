import { estimateCostUsdWith, resolvePricing, type TokenUsage } from '@vault/pricing';
import { MODEL_PROVIDERS, resolveModelRef, type ModelCatalogEntry, type ModelProvider } from '@vault/settings-registry';
import { DEFAULT_CONSOLIDATION_MODEL } from '../mcp/tools/memory-consolidation.js';
import type { CostBasis, RecordedUsage, UsageEventInput, UsageRecorder } from '../usage/recorder.js';

// What `npm run eval:consolidation` needs beyond the cases (#570): which model to run, a usage
// count, and the result line for the root `eval:models` runner. The Curator's evals print the same
// line (`packages/curator/src/eval/result.ts`); the runner (`scripts/eval-models.ts`) checks it.

export const EVAL_RESULT_PREFIX = 'EVAL_RESULT ';

/** Calls made to one model: how many, how many failed, tokens, time and cost. */
export interface EvalCalls {
  model: string;
  label: string;
  provider: string | null;
  calls: number;
  failures: number;
  usage: TokenUsage;
  latencyMs: number;
  /** The provider's reported charge where it gave one, else estimated from rates; null when a
   *  call had neither. */
  costUsd: number | null;
}

export interface EvalResult {
  version: 1;
  eval: string;
  score: { kind: 'exact'; correct: number; total: number };
  failures: number;
  job: EvalCalls;
}

export interface ConsolidationEvalTarget {
  provider: ModelProvider;
  model: string;
  label: string;
}

export interface TargetOptions {
  /** `--provider`: run `model` as a raw provider id, without the catalog. */
  provider?: string | undefined;
  /** `--model`: a Settings/Models title (bare or [[linked]]) or an enabled entry's model id;
   *  with `provider`, a raw id. */
  model?: string | undefined;
  /** The Engine's model catalog, when the eval can read its database. */
  catalog?: ModelCatalogEntry[] | undefined;
  /** The configured `memoryConsolidationModel`, already resolved, when the database was read. */
  configured?: { provider: ModelProvider; model: string } | undefined;
}

/**
 * The model the eval runs on. `--provider` with `--model` runs a raw id, as before #570. A bare
 * `--model` is looked up in the catalog like the Curator evals' `--model`, and refused when it isn't
 * there (with no provider, the eval can't tell where to send it). With neither, the configured
 * model, else the built-in default.
 */
export function consolidationEvalTarget(opts: TargetOptions): ConsolidationEvalTarget {
  const catalog = opts.catalog ?? [];
  const titleOf = (model: string) => catalog.find((e) => e.enabled && e.model === model)?.title ?? model.split('/').pop() ?? model;
  if (opts.provider !== undefined) {
    if (!(MODEL_PROVIDERS as readonly string[]).includes(opts.provider)) throw new Error(`unknown --provider ${opts.provider}`);
    const model = opts.model ?? DEFAULT_CONSOLIDATION_MODEL;
    return { provider: opts.provider as ModelProvider, model, label: titleOf(model) };
  }
  if (opts.model !== undefined) {
    const entry = resolveModelRef(catalog, opts.model) ?? catalog.find((e) => e.enabled && e.model === opts.model) ?? null;
    if (entry === null) {
      throw new Error(opts.catalog === undefined
        ? `--model "${opts.model}" needs the model catalog: set DB_PATH or VAULT_PATH (or --db), or pass --provider with a raw model id`
        : `--model "${opts.model}" is not an enabled Settings/Models entry; pass --provider with a raw model id to run one`);
    }
    return { provider: entry.provider, model: entry.model, label: entry.title };
  }
  if (opts.configured !== undefined) return { ...opts.configured, label: titleOf(opts.configured.model) };
  return { provider: 'fireworks', model: DEFAULT_CONSOLIDATION_MODEL, label: titleOf(DEFAULT_CONSOLIDATION_MODEL) };
}

/**
 * A stand-in for the usage ledger that only counts: the consolidator records every call through
 * it, and nothing is written. The cost is the provider's reported charge, else the catalog entry's
 * rates, else the static table's.
 */
export class EvalUsageTally implements Pick<UsageRecorder, 'record'> {
  readonly calls: EvalCalls;
  constructor(target: ConsolidationEvalTarget, private readonly entryPricing?: ModelCatalogEntry['pricing']) {
    this.calls = {
      model: target.model, label: target.label, provider: target.provider, calls: 0, failures: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, latencyMs: 0, costUsd: 0,
    };
  }

  record(e: UsageEventInput): RecordedUsage {
    const usage: TokenUsage = {
      input: e.inputTokens ?? 0, output: e.outputTokens ?? 0, cacheRead: e.cacheReadTokens ?? 0, cacheWrite: e.cacheWriteTokens ?? 0,
    };
    const c = this.calls;
    c.calls += 1;
    c.latencyMs += e.latencyMs ?? 0;
    c.usage = {
      input: c.usage.input + usage.input, output: c.usage.output + usage.output,
      cacheRead: c.usage.cacheRead + usage.cacheRead, cacheWrite: c.usage.cacheWrite + usage.cacheWrite,
    };
    const rates = resolvePricing(c.model, this.entryPricing);
    const [costUsd, costBasis]: [number, CostBasis] = e.providerCostUsd !== undefined
      ? [e.providerCostUsd, 'provider-reported']
      : rates !== null ? [estimateCostUsdWith(rates, usage), 'computed'] : [0, 'unpriced'];
    c.costUsd = c.costUsd === null || costBasis === 'unpriced' ? null : c.costUsd + costUsd;
    return { id: 0, costUsd, costBasis };
  }

  /** A call with no usable answer. One that failed before the consolidator recorded it (the
   *  request itself threw) is counted here, with the time it took. */
  failed(recorded: boolean, latencyMs: number): void {
    this.calls.failures += 1;
    if (!recorded) {
      this.calls.calls += 1;
      this.calls.latencyMs += latencyMs;
    }
  }
}

export function resultLine(result: EvalResult): string {
  return `${EVAL_RESULT_PREFIX}${JSON.stringify(result)}`;
}
