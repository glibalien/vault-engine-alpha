import { estimateCostUsdWith, type ModelPricing } from '@vault/pricing';
import type { UsagePurpose } from '@vault/contract';
import { catalogPricing } from './pricing.js';
import type { ModelProvider } from '@vault/settings-registry';
import type { Config } from './config.js';
import type { Engine } from './engine.js';
import { safeDiagnostics, type StructuredCallDiagnostics } from './llm/diagnostics.js';
import { providerForModel } from './llm/provider-for-model.js';
import { StructuredCallFailure } from './llm/types.js';
import type { LlmClient, StructuredCallRequest, StructuredCallResult } from './llm/types.js';
import { ProviderSpendLimitError, type ProviderLimits } from './provider-limits.js';
import { startOfLocalDay } from './scheduler.js';
import type { TokenUsage } from './types.js';

export class BudgetExhaustedError extends Error {
  override readonly name = 'BudgetExhaustedError';
  readonly code = 'DAILY_BUDGET_EXHAUSTED';
}

export class BudgetPricingUnknownError extends Error {
  override readonly name = 'BudgetPricingUnknownError';
  readonly code = 'DAILY_BUDGET_PRICING_UNKNOWN';
}

/** Today's spend could not be read, so no call can be admitted. */
export class BudgetUnavailableError extends Error {
  override readonly name = 'BudgetUnavailableError';
  readonly code = 'DAILY_BUDGET_UNAVAILABLE';
}

/** The server is shutting down, so no new model call is admitted (#405). */
export class CuratorShutdownError extends Error {
  override readonly name = 'CuratorShutdownError';
  readonly code = 'CURATOR_SHUTTING_DOWN';
  constructor() {
    super('the Curator is shutting down, so no new model call was made');
  }
}

/** The refusal that caused `error`, directly or through wrapped causes. */
function findBudgetRefusal(error: unknown): Error | null {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth++) {
    if (current instanceof BudgetExhaustedError || current instanceof BudgetPricingUnknownError
      || current instanceof BudgetUnavailableError || current instanceof ProviderSpendLimitError
      || current instanceof CuratorShutdownError) return current;
  }
  return null;
}

/**
 * A call refused before dispatch: by the daily cap, a provider key's own limit, or because the
 * server is shutting down. Nothing was sent, so callers stop the stage and leave the rest for a
 * later run rather than counting a failure (no failure hold).
 */
export function isBudgetRefusal(error: unknown): boolean {
  return findBudgetRefusal(error) !== null;
}

/** The refusal was the server shutting down, not a spend limit. */
export function isShutdownRefusal(error: unknown): boolean {
  return findBudgetRefusal(error) instanceof CuratorShutdownError;
}

/** The refusal message itself, even when wrapped by a stage error. */
export function budgetRefusalDetail(error: unknown): string {
  return findBudgetRefusal(error)?.message ?? (error instanceof Error ? error.message : String(error));
}

export interface DailyBudgetPolicy {
  /** Hard cap for the local day; null disables the budget. */
  readonly capUsd: number | null;
  /** What a refusal calls the cap; "daily budget" unless this is a run's own limit (#644). */
  readonly label?: string;
  readonly tz: string;
  readonly pricing: (model: string) => ModelPricing | null;
  /** The provider a model routes to, for the provider's own key limit (#342); null when unknown. */
  readonly provider?: (model: string) => ModelProvider | null;
  /** The providers the wiki stages call, checked before a wiki starts paid work. */
  readonly wikiProviders?: readonly ModelProvider[];
}

/** Charges the usage ledger never records (a failure billed at its worst case without
 *  reported usage), kept so a restart the same day still counts them. */
export interface BudgetChargeStore {
  /** Total of the charges recorded at or after `sinceIso`, in USD. */
  totalSince(sinceIso: string): number;
  record(atIso: string, usd: number): void;
}

/**
 * Process-wide spend tally for one local day. The first admission of each day
 * reads that day's recorded spend (so restarts keep counting): the usage ledger
 * plus the charges it never records. Afterwards every call this process makes is
 * added locally, ahead of the asynchronous ledger. Admitted calls hold their worst
 * case until they settle, so concurrent calls cannot jointly overrun the cap.
 */
export class DailyBudget {
  private day: string | null = null;
  private spentUsd = 0;
  private reserved = 0;
  private admitting = true;

  constructor(private readonly readSpentUsd: (sinceIso: string) => Promise<number>,
    private readonly now: () => Date = () => new Date(),
    private readonly charges?: BudgetChargeStore,
    /** The providers' own key limits, checked beside the cap (#342). */
    readonly limits?: ProviderLimits) {}

  async spent(tz: string): Promise<{ day: string; spentUsd: number }> {
    const day = startOfLocalDay(this.now(), tz).toISOString();
    if (day !== this.day) {
      let spentUsd: number;
      try {
        spentUsd = await this.readSpentUsd(day) + (this.charges?.totalSince(day) ?? 0);
      } catch (error) {
        throw new BudgetUnavailableError('daily budget: today\'s recorded spend is unavailable', { cause: error });
      }
      if (!Number.isFinite(spentUsd) || spentUsd < 0) throw new BudgetUnavailableError('daily budget: recorded spend is invalid');
      // A concurrent read may have loaded the day already; keep its local additions.
      if (day !== this.day) {
        this.day = day;
        this.spentUsd = spentUsd;
      }
    }
    return { day, spentUsd: this.spentUsd };
  }

  /** Worst cases held by admitted calls that have not settled. */
  get reservedUsd(): number {
    return this.reserved;
  }

  /** Refuse every call from now on, capped or not: the server is shutting down (#405). A call
   *  already admitted finishes; the stage it belongs to stops at its next call. */
  closeAdmission(): void {
    this.admitting = false;
  }

  /** Throws once admission is closed. */
  assertAdmitting(): void {
    if (!this.admitting) throw new CuratorShutdownError();
  }

  /** Holds the call's worst case against the cap; returns the amount to pass to `settle`. */
  async admit(worstCaseUsd: number, policy: DailyBudgetPolicy): Promise<number> {
    this.assertAdmitting();
    if (policy.capUsd === null) return 0;
    const { spentUsd } = await this.spent(policy.tz);
    if (spentUsd + this.reserved + worstCaseUsd > policy.capUsd) {
      throw new BudgetExhaustedError(`${policy.label ?? 'daily budget'}: $${spentUsd.toFixed(4)} spent`
        + `${this.reserved > 0 ? ` and $${this.reserved.toFixed(4)} in flight` : ''} of $${policy.capUsd.toFixed(2)}; `
        + `this call could cost up to $${worstCaseUsd.toFixed(4)}`);
    }
    this.reserved += worstCaseUsd;
    return worstCaseUsd;
  }

  /** Releases an admitted call's hold and adds what it cost; an unknown cost re-reads the ledger next time.
   *  `unledgeredUsd` is the part of the cost the usage ledger will not record; it is persisted. */
  settle(reservedUsd: number, costUsd: number | null, unledgeredUsd = 0): void {
    this.reserved = Math.max(0, this.reserved - reservedUsd);
    if (costUsd === null) this.day = null;
    else this.record(costUsd);
    if (costUsd === null || !this.charges || !Number.isFinite(unledgeredUsd) || unledgeredUsd <= 0) return;
    try {
      this.charges.record(this.now().toISOString(), unledgeredUsd);
    } catch (error) {
      // Only a restart later today could forget this charge.
      console.warn(`[curator] budget charge not persisted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  record(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.spentUsd += usd;
  }

  /** A charge made outside this process's admitted calls but recorded in the ledger under the
   *  Curator (the Engine's consolidation calls, #298): added now, or, when its cost is unknown,
   *  read back from the ledger at the next admission. */
  charge(usd: number | null): void {
    if (usd === null) this.day = null;
    else this.record(usd);
  }
}

type PolicyConfig = Pick<Config, 'dailyBudgetCents' | 'curatorTz' | 'modelPricing'>
  & Partial<Pick<Config, 'modelProviders' | 'model' | 'wikiPlanningModel' | 'wikiPageModel' | 'wikiHomeModel'>>;

/** The cap configured for one run: cents become dollars; catalog pricing first, then the static table. */
export function dailyBudgetPolicy(config: PolicyConfig): DailyBudgetPolicy {
  const cents = config.dailyBudgetCents ?? null;
  const route = providerForModel(config.modelProviders ?? {});
  const provider = (model: string): ModelProvider | null => {
    try {
      return route(model);
    } catch {
      return null;
    }
  };
  // Each wiki stage's effective model, as resolveWikiModel picks it: its override, else `model`.
  const wikiModels = [config.wikiPlanningModel, config.wikiPageModel, config.wikiHomeModel]
    .map(override => override ?? config.model)
    .filter((model): model is string => typeof model === 'string' && model.length > 0);
  return { capUsd: cents === null ? null : cents / 100, tz: config.curatorTz,
    pricing: catalogPricing(config), provider,
    wikiProviders: [...new Set(wikiModels.map(provider).filter((p): p is ModelProvider => p !== null))] };
}

/** Purposes paid from a run's own limit, stated in its request. They are recorded in the ledger
 *  like any call but are no part of the daily cap's tally (#644). */
export const RUN_BUDGET_PURPOSES: readonly UsagePurpose[] = [
  'field-fill-run', 'type-notes-run', 'memory-subjects-run', 'memory-extraction-run',
  // The Engine's consolidation check of a memory an extraction run wrote (#659): the run names this
  // purpose on its create-memory calls, and the Engine records the check under it and the run's ref.
  'memory-consolidation-run',
];

/** The source a memory extraction run (#659) names on its `create-memory` calls, for reports. */
export const RUN_CONSOLIDATION_SOURCE = 'memory-extraction-run';

async function ledgerTotal(engine: Pick<Engine, 'usageReport'>, filter: Record<string, unknown>): Promise<number> {
  const { data } = await engine.usageReport({ service: 'curator', ...filter, limit: 1 });
  const spent = data.totals['cost_usd'];
  if (typeof spent !== 'number') throw new Error('usage report omitted cost_usd');
  return spent;
}

/** More purposes than the ledger has; a report that still does not fit is refused, not trusted. */
const PURPOSE_GROUPS_LIMIT = 1000;

/**
 * Today's recorded Curator spend under the daily cap: the ledger's known subtotal of charges and
 * estimates, without what on-demand runs paid from their own limits.
 *
 * One report, grouped by purpose, so both sides come from the same moment. Reading the total and
 * the runs' share separately would let a run's charge land between the two reads: the share would
 * then hold a charge the total does not, the difference would understate the day's spend, and
 * the day's tally keeps what it first read.
 */
export function ledgerSpend(engine: Pick<Engine, 'usageReport'>): (sinceIso: string) => Promise<number> {
  return async sinceIso => {
    const { data } = await engine.usageReport({ service: 'curator', since: sinceIso, group_by: ['purpose'], limit: PURPOSE_GROUPS_LIMIT });
    if (typeof data.totals['cost_usd'] !== 'number') throw new Error('usage report omitted cost_usd');
    if ((data.group_count ?? data.groups.length) > data.groups.length) throw new Error('usage report left out some purposes');
    let spent = 0;
    for (const group of data.groups) {
      if (typeof group['cost_usd'] !== 'number') throw new Error('usage report omitted a purpose\'s cost_usd');
      if (!(RUN_BUDGET_PURPOSES as readonly unknown[]).includes(group['purpose'])) spent += group['cost_usd'];
    }
    return spent;
  };
}

/** A model client that spends against one run's own limit, and how much the run has spent. */
export interface RunBudget {
  readonly llm: LlmClient;
  /** Spent so far, with the worst case of any call in flight. */
  spentUsd(): Promise<number>;
  /** A cost the run caused outside its own model calls and that the ledger records under its ref (the
   *  Engine's consolidation check of a memory it wrote, #659): a dollar amount, or null when unknown,
   *  which reads the ledger again before the next call. */
  charge(usd: number | null): void;
  /** Stop tracking this budget for shutdown. */
  release(): void;
}

/** Makes a run's budget: `limitUsd` is the most its calls may cost, apart from the daily cap. */
export type RunBudgetFactory = (run: { limitUsd: number; runRef: string }) => RunBudget;

/**
 * A run's own limit (#644), built from the same admission as the daily cap: each call's worst case
 * is held against the limit before it is sent, a refusal stops the run, and the provider's key
 * limits and shutdown still apply. The tally starts from what the ledger already holds for the
 * run, and covers the run's whole life: unlike the daily cap it never starts again at local
 * midnight. `budgets` is the server's set of live run budgets, closed with the daily one at shutdown.
 */
export function createRunBudget(input: {
  llm: LlmClient;
  policy: DailyBudgetPolicy;
  engine: Pick<Engine, 'usageReport'>;
  limitUsd: number;
  runRef: string;
  limits?: ProviderLimits;
  budgets?: Set<DailyBudget>;
  now?: () => Date;
}): RunBudget {
  // A lifetime tally, not a day's. The clock is fixed at the run's start, so the "day" a
  // DailyBudget keys on never changes and local midnight resets nothing. Charges the ledger
  // never records (a call that may have been billed without reporting usage) are kept here and
  // added back whenever the ledger is read again, as the daily budget's stored charges are.
  const startedAt = (input.now ?? (() => new Date()))();
  let unledgeredUsd = 0;
  const charges: BudgetChargeStore = {
    totalSince: () => unledgeredUsd,
    record: (_at, usd) => { unledgeredUsd += usd; },
  };
  const budget = new DailyBudget(() => ledgerTotal(input.engine, { run_ref: input.runRef }), () => startedAt, charges, input.limits);
  const policy: DailyBudgetPolicy = { ...input.policy, capUsd: input.limitUsd, label: "this run's limit" };
  input.budgets?.add(budget);
  return {
    llm: withDailyBudget(input.llm, budget, policy),
    spentUsd: async () => (await budget.spent(policy.tz)).spentUsd + budget.reservedUsd,
    charge: usd => { budget.charge(usd); },
    release: () => { input.budgets?.delete(budget); },
  };
}

/** Remaining spend for a bound policy; null when no cap is set. */
export interface BudgetGate {
  remainingUsd(): Promise<number | null>;
  /** Why the wiki stages' providers can't be called now (a spent key limit); null when they can.
   *  A caller that uses fewer of them names its own, as a dossier names its home model's (#554). */
  providerSpent?(providers?: readonly ModelProvider[]): Promise<string | null>;
  /** Each wiki-stage provider's own key limit, for status. */
  providerLimits?(): Promise<Array<Record<string, string | number | null>>>;
}

export function budgetGate(budget: DailyBudget, policy: DailyBudgetPolicy): BudgetGate {
  const limits = budget.limits;
  return {
    remainingUsd: async () => {
      // A sweep checks this before each wiki, so a shutdown skips the rest without gathering evidence.
      budget.assertAdmitting();
      return policy.capUsd === null ? null
        : policy.capUsd - (await budget.spent(policy.tz)).spentUsd - budget.reservedUsd;
    },
    ...(limits ? {
      providerSpent: providers => limits.spentDetail(providers ?? policy.wikiProviders ?? []),
      providerLimits: () => limits.report(policy.wikiProviders ?? []),
    } : {}),
  };
}

/** The provider a call goes to: a bound configuration's (a resumed durable request keeps the
 *  provider it was frozen with), else the run's routing; null when unknown. */
function callProvider(llm: LlmClient, policy: DailyBudgetPolicy, model: string): ModelProvider | null {
  try {
    const bound = llm.configurationFor?.(model)?.provider;
    if (bound !== undefined) return bound;
  } catch {
    // Fall back to the run's routing.
  }
  return policy.provider?.(model) ?? null;
}

/** Message and tool framing that the request text does not include. */
const FRAMING_TOKENS = 512;

/** Upper bound on input tokens: byte-level tokenizers emit at most one token per UTF-8 byte. */
function inputTokenBound(req: StructuredCallRequest): number {
  return FRAMING_TOKENS + [req.system, req.user, req.toolName, req.toolDescription, JSON.stringify(req.schema)]
    .reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
}

function usageCost(pricing: ModelPricing, usage: TokenUsage): number {
  return estimateCostUsdWith(pricing, usage);
}

/** The most one attempt of `req` can cost, as the daily budget holds it before dispatch: bounded
 *  input plus the full output allowance. A preview that says whether a call fits uses this. */
export function worstCaseCallUsd(req: StructuredCallRequest, pricing: ModelPricing): number {
  return usageCost(pricing, { input: inputTokenBound(req), output: req.maxTokens, cacheRead: 0, cacheWrite: 0 });
}

const NO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** What a settled call cost, and the part of that the usage ledger will not record. */
type Charge = { readonly usd: number; readonly unledgeredUsd: number };

/** Provider-reported charges when every response carries one, else a rate-table estimate.
 *  `worstCaseUsd` covers every admitted attempt; `attemptUsd` is one attempt's worst case. */
function actualCost(pricing: ModelPricing, result: Pick<StructuredCallResult, 'usage' | 'usageKnown' | 'diagnostics'>,
  worstCaseUsd: number, attemptUsd: number): Charge {
  const diagnostics = safeDiagnostics(result.diagnostics);
  const responses = diagnostics?.responses ?? [];
  const answered = httpFailedAttempts(diagnostics);
  if (responses.length > 0 && responses.length + answered === diagnostics?.adapterAttempts
    && responses.every(response => response.providerCostUsd !== undefined)) {
    const usd = responses.reduce((sum, response) => sum + response.providerCostUsd!, 0);
    // The usage reporter records provider charges only when every attempt returned one; without
    // that or token usage it records nothing.
    return { usd, unledgeredUsd: result.usageKnown === false && responses.length !== diagnostics.adapterAttempts ? usd : 0 };
  }
  // Without usage or provider charges the usage reporter records nothing.
  if (result.usageKnown === false) return { usd: worstCaseUsd, unledgeredUsd: worstCaseUsd };
  // Attempts that left no usage-bearing response (e.g. a timed-out retry) may still have been billed.
  const unaccounted = diagnostics
    ? Math.max(0, diagnostics.adapterAttempts - responses.filter(r => r.usageKnown).length - answered) : 0;
  return { usd: usageCost(pricing, result.usage) + unaccounted * attemptUsd, unledgeredUsd: unaccounted * attemptUsd };
}

function hasHttpStatus(error: unknown): boolean {
  return typeof error === 'object' && error !== null && typeof (error as { status?: unknown }).status === 'number';
}

/** The failed attempt is unbilled when the provider answered it with an HTTP error response (0 or 1). */
function httpFailedAttempts(diagnostics: StructuredCallDiagnostics | undefined): number {
  return diagnostics?.failure?.status !== undefined && diagnostics.adapterAttempts > diagnostics.responses.length ? 1 : 0;
}

/**
 * Refuses a call before dispatch unless today's spend, the calls in flight and the
 * worst case of one attempt fit the cap: bounded input plus the full output allowance.
 * An adapter retry is admitted the same way just before it dispatches, so a refused
 * retry ends the call instead of overrunning the cap. Models without pricing are
 * refused while a cap is set. Uncapped calls still count, so a cap restored later
 * the same day starts from the true tally.
 */
export function withDailyBudget(llm: LlmClient, budget: DailyBudget, policy: DailyBudgetPolicy): LlmClient {
  return {
    supportsPreparedCapture: llm.supportsPreparedCapture,
    ...(llm.configurationFor ? { configurationFor: llm.configurationFor.bind(llm) } : {}),
    ...(llm.withConfiguration ? { withConfiguration: configuration =>
      withDailyBudget(llm.withConfiguration!(configuration), budget, policy) } : {}),
    ...(llm.previewStructuredCall ? { previewStructuredCall: llm.previewStructuredCall.bind(llm) } : {}),
    structuredCall: async req => {
      const pricing = policy.pricing(req.model);
      if (!pricing && policy.capUsd !== null) {
        throw new BudgetPricingUnknownError(`daily budget: no pricing for model ${req.model}; add pricing to its `
          + 'Settings/Models note or clear dailyBudgetCents');
      }
      // One attempt is held up front; a retry is admitted only when the adapter is about to make it.
      const attemptUsd = pricing ? worstCaseCallUsd(req, pricing) : 0;
      // The provider's own key limit is held beside the cap; either refusal ends the call before dispatch.
      const limits = budget.limits;
      const provider = limits ? callProvider(llm, policy, req.model) : null;
      const admitBoth = async (): Promise<{ cap: number; key: number }> => {
        const cap = await budget.admit(attemptUsd, policy);
        try {
          return { cap, key: limits ? await limits.admit(provider, attemptUsd) : 0 };
        } catch (error) {
          budget.settle(cap, 0);
          throw error;
        }
      };
      const first = await admitBoth();
      let held = first.cap;
      let keyHeld = first.key;
      let admitted = 1;
      const beforeRetry = async (): Promise<void> => {
        await req.beforeRetry?.();
        const next = await admitBoth();
        held += next.cap;
        keyHeld += next.key;
        admitted += 1;
      };
      const worstCaseUsd = (): number => admitted * attemptUsd;
      const settleKey = (costUsd: number | null): void => limits?.settle(provider, keyHeld, costUsd);
      try {
        const result = await llm.structuredCall({ ...req, beforeRetry });
        const charge = pricing ? actualCost(pricing, result, worstCaseUsd(), attemptUsd) : null;
        budget.settle(held, charge?.usd ?? null, charge?.unledgeredUsd);
        settleKey(charge?.usd ?? null);
        return result;
      } catch (error) {
        // Adapters report zero attempts when they refuse a request before dispatch (oversized prompt, failed capture).
        const undispatched = error instanceof StructuredCallFailure && error.usage === undefined
          && safeDiagnostics(error.diagnostics)?.adapterAttempts === 0;
        if (undispatched) {
          budget.settle(held, 0);
          settleKey(0);
        } else if (error instanceof StructuredCallFailure) {
          // Fail-closed adapters project provider errors to a reason; the diagnostics keep the HTTP status.
          const diagnostics = safeDiagnostics(error.diagnostics);
          const answeredOnly = error.usage === undefined && diagnostics !== undefined && diagnostics.responses.length === 0
            && diagnostics.adapterAttempts === 1 && httpFailedAttempts(diagnostics) === 1;
          // Without token usage, provider-reported charges still settle (and reach the ledger) as on success.
          const charge: Charge | null = answeredOnly ? { usd: 0, unledgeredUsd: 0 } : !pricing ? null
            : actualCost(pricing, error.usage === undefined
              ? { usage: NO_USAGE, usageKnown: false, diagnostics: error.diagnostics }
              : { usage: error.usage, diagnostics: error.diagnostics }, worstCaseUsd(), attemptUsd);
          budget.settle(held, charge?.usd ?? null, charge?.unledgeredUsd);
          settleKey(charge?.usd ?? null);
        } else {
          // A provider's HTTP error response is definitive; a timeout or lost connection may have been billed.
          if (hasHttpStatus(error)) {
            budget.settle(held, 0);
            settleKey(0);
          } else {
            budget.settle(held, pricing ? worstCaseUsd() : null, worstCaseUsd());
            settleKey(pricing ? worstCaseUsd() : null);
          }
        }
        // A spent key limit or empty account is a budget refusal, not a failure of this call's work.
        let refusal: ProviderSpendLimitError | null = null;
        try {
          refusal = limits ? await limits.classify(provider, error) : null;
        } catch {
          refusal = null;
        }
        if (refusal === null) throw error;
        // Callers account billed usage (an earlier attempt's) from a StructuredCallFailure; keep that
        // contract and carry the refusal as its cause, where isBudgetRefusal finds it.
        if (error instanceof StructuredCallFailure) {
          throw new StructuredCallFailure(error.message, error.usage, error.reason, error.diagnostics, { cause: refusal });
        }
        throw refusal;
      }
    },
  };
}
