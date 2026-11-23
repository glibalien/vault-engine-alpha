import { describe, expect, it, vi } from 'vitest';
import OpenAIClient from 'openai';
import type OpenAI from 'openai';
import { estimateCostUsdWith, type ModelPricing } from '@vault/pricing';
import {
  BudgetExhaustedError, BudgetPricingUnknownError, BudgetUnavailableError, CuratorShutdownError, DailyBudget, budgetGate,
  budgetRefusalDetail, createRunBudget, dailyBudgetPolicy, isBudgetRefusal, isShutdownRefusal, ledgerSpend, withDailyBudget,
  RUN_BUDGET_PURPOSES,
  type DailyBudgetPolicy,
} from '../src/budget.js';
import { startOfLocalDay } from '../src/scheduler.js';
import { StructuredCallFailure, type LlmClient, type StructuredCallRequest } from '../src/llm/types.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { budgetChargeStore } from '../src/db/budget-charges.js';

const PRICE: ModelPricing = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1 }; // USD per million tokens
const policy = (capUsd: number | null, pricing: ModelPricing | null = PRICE): DailyBudgetPolicy =>
  ({ capUsd, tz: 'UTC', pricing: () => pricing });
const request = (patch: Partial<StructuredCallRequest> = {}): StructuredCallRequest => ({
  model: 'm', maxTokens: 10_000, system: 's'.repeat(300), user: 'u'.repeat(2_700), toolName: 't', toolDescription: 'd',
  schema: {}, malformedOutputPolicy: 'fail-closed-redacted', ...patch,
});
// 3,004 UTF-8 bytes (system + user + tool name + description + "{}") + 512 framing → 3,516 input tokens at most;
// output allowance 10,000.
const WORST = estimateCostUsdWith(PRICE, { input: 3_516, output: 10_000, cacheRead: 0, cacheWrite: 0 });
const USAGE = { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0 };
const ACTUAL = estimateCostUsdWith(PRICE, USAGE);

function client(result: () => Promise<unknown> = async () => ({ output: {}, usage: USAGE })) {
  return { structuredCall: vi.fn(result) } as unknown as LlmClient & { structuredCall: ReturnType<typeof vi.fn> };
}

describe('startOfLocalDay', () => {
  it('returns local midnight as a UTC instant, across daylight-saving changes', () => {
    expect(startOfLocalDay(new Date('2026-10-25T03:00:00Z'), 'America/New_York').toISOString()).toBe('2026-10-24T04:00:00.000Z');
    expect(startOfLocalDay(new Date('2026-11-01T12:00:00Z'), 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(startOfLocalDay(new Date('2026-11-02T12:00:00Z'), 'America/New_York').toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(startOfLocalDay(new Date('2026-10-25T03:00:00Z'), 'UTC').toISOString()).toBe('2026-10-25T00:00:00.000Z');
  });
});

describe('DailyBudget', () => {
  it('reads recorded spend once per local day and adds local spend', async () => {
    let now = new Date('2026-10-25T10:00:00Z');
    const read = vi.fn(async () => 0.4);
    const budget = new DailyBudget(read, () => now);
    expect(await budget.spent('UTC')).toEqual({ day: '2026-10-25T00:00:00.000Z', spentUsd: 0.4 });
    budget.record(0.1);
    budget.record(-5);
    expect((await budget.spent('UTC')).spentUsd).toBeCloseTo(0.5, 10);
    expect(read).toHaveBeenCalledTimes(1);
    now = new Date('2026-10-26T00:00:01Z');
    expect((await budget.spent('UTC')).spentUsd).toBe(0.4);
    expect(read).toHaveBeenLastCalledWith('2026-10-26T00:00:00.000Z');
  });

  it('counts an Engine-side charge on the Curator account at once, or re-reads the ledger when its cost is unknown (#298)', async () => {
    let ledger = 0.9;
    const read = vi.fn(async () => ledger);
    const budget = new DailyBudget(read, () => new Date('2026-10-25T10:00:00Z'));
    await budget.admit(0, policy(1));
    budget.charge(0.08);
    await expect(budget.admit(0.05, policy(1))).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(read).toHaveBeenCalledTimes(1);
    ledger = 0.99; // the ledger holds the unknown-cost call
    budget.charge(null);
    expect((await budget.spent('UTC')).spentUsd).toBe(0.99);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('refuses to admit anything when recorded spend cannot be read', async () => {
    const budget = new DailyBudget(async () => { throw new Error('engine down'); });
    const error = await budget.admit(0, policy(1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetUnavailableError);
    expect(isBudgetRefusal(error)).toBe(true);
    await expect(new DailyBudget(async () => Number.NaN).admit(0, policy(1))).rejects.toBeInstanceOf(BudgetUnavailableError);
  });

  it('reports remaining allowance through a gate, net of calls in flight, or null without a cap', async () => {
    const budget = new DailyBudget(async () => 0.25);
    expect(await budgetGate(budget, policy(1)).remainingUsd()).toBeCloseTo(0.75, 10);
    const held = await budget.admit(0.5, policy(1));
    expect(await budgetGate(budget, policy(1)).remainingUsd()).toBeCloseTo(0.25, 10);
    budget.settle(held, 0.1);
    expect(await budgetGate(budget, policy(1)).remainingUsd()).toBeCloseTo(0.65, 10);
    expect(await budgetGate(budget, policy(null)).remainingUsd()).toBeNull();
  });

  it('holds admitted worst cases until they settle, so concurrent calls cannot jointly overrun', async () => {
    const budget = new DailyBudget(async () => 0);
    const first = await budget.admit(0.6, policy(1));
    await expect(budget.admit(0.6, policy(1))).rejects.toThrow(/in flight/);
    budget.settle(first, 0.2);
    expect(budget.reservedUsd).toBe(0);
    await expect(budget.admit(0.6, policy(1))).resolves.toBe(0.6);
  });

  it('re-reads the ledger after a call of unknown cost', async () => {
    const read = vi.fn(async () => 0.3);
    const budget = new DailyBudget(read);
    budget.settle(await budget.admit(0, policy(1)), null);
    await budget.spent('UTC');
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('withDailyBudget', () => {
  it('admits a call whose worst case fits and records its actual cost', async () => {
    const budget = new DailyBudget(async () => 0);
    const inner = client();
    await withDailyBudget(inner, budget, policy(1)).structuredCall(request());
    expect(inner.structuredCall).toHaveBeenCalledOnce();
    expect((await budget.spent('UTC')).spentUsd).toBeCloseTo(ACTUAL, 12);
  });

  it('refuses before dispatch when spend plus the worst case would exceed the cap', async () => {
    const budget = new DailyBudget(async () => 1 - WORST + 1e-9);
    const inner = client();
    const error = await withDailyBudget(inner, budget, policy(1)).structuredCall(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect(inner.structuredCall).not.toHaveBeenCalled();
    expect(budgetRefusalDetail(new Error('page synthesis failed', { cause: error }))).toMatch(/^daily budget: /);
  });

  it('holds one attempt up front, even for calls that may retry', async () => {
    const budget = new DailyBudget(async () => 1 - WORST * 1.5);
    const inner = client();
    await withDailyBudget(inner, budget, policy(1)).structuredCall(request({ malformedOutputPolicy: undefined }));
    expect(inner.structuredCall).toHaveBeenCalledOnce();
    expect((await budget.spent('UTC')).spentUsd).toBeCloseTo(1 - WORST * 1.5 + ACTUAL, 12);
  });

  /** The real adapter, answering malformed output first so it retries. */
  function retryingAdapter() {
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: USAGE.input, completion_tokens: USAGE.output } })
      .mockResolvedValueOnce({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: USAGE.input, completion_tokens: USAGE.output } });
    const adapter = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI,
      { provider: 'openrouter', fireworksExtensions: false });
    return { adapter, create };
  }

  it('admits a retry when the adapter is about to make it, and charges both attempts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { adapter, create } = retryingAdapter();
      const budget = new DailyBudget(async () => 0);
      const admit = vi.spyOn(budget, 'admit');
      await withDailyBudget(adapter, budget, policy(1)).structuredCall(request({ malformedOutputPolicy: undefined }));
      expect(create).toHaveBeenCalledTimes(2);
      expect(admit.mock.calls.map(([worstCase]) => worstCase)).toEqual([WORST, WORST]);
      expect((await budget.spent('UTC')).spentUsd).toBeCloseTo(2 * ACTUAL, 12);
      expect(budget.reservedUsd).toBe(0);
    } finally { warn.mockRestore(); }
  });

  it('ends the call when the retry does not fit, charging only the first attempt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { adapter, create } = retryingAdapter();
      const budget = new DailyBudget(async () => 1 - WORST * 1.5);
      const error = await withDailyBudget(adapter, budget, policy(1))
        .structuredCall(request({ malformedOutputPolicy: undefined })).catch((e: unknown) => e);
      expect(create).toHaveBeenCalledOnce();
      expect(error).toBeInstanceOf(StructuredCallFailure);
      expect((error as StructuredCallFailure).usage).toEqual(USAGE);
      expect(isBudgetRefusal(error)).toBe(true);
      expect((await budget.spent('UTC')).spentUsd).toBeCloseTo(1 - WORST * 1.5 + ACTUAL, 12);
      expect(budget.reservedUsd).toBe(0);
    } finally { warn.mockRestore(); }
  });

  it('prefers provider-reported charges when every response carries one', async () => {
    const budget = new DailyBudget(async () => 0);
    const inner = client(async () => ({ output: {}, usage: USAGE, diagnostics: { version: 1, adapterAttempts: 1, sdkAttempts: 1,
      responses: [{ attempt: 1, contentKind: 'object', usageKnown: true, providerCostUsd: 0.0123 }] } }));
    await withDailyBudget(inner, budget, policy(1)).structuredCall(request());
    expect((await budget.spent('UTC')).spentUsd).toBeCloseTo(0.0123, 12);
  });

  it('records billed failures, and the worst case when a failure has no usage', async () => {
    const billed = new DailyBudget(async () => 0);
    await expect(withDailyBudget(client(async () => { throw new StructuredCallFailure('bad', USAGE); }), billed, policy(1))
      .structuredCall(request())).rejects.toBeInstanceOf(StructuredCallFailure);
    expect((await billed.spent('UTC')).spentUsd).toBeCloseTo(ACTUAL, 12);
    const unknown = new DailyBudget(async () => 0);
    await expect(withDailyBudget(client(async () => { throw new StructuredCallFailure('lost'); }), unknown, policy(1))
      .structuredCall(request())).rejects.toBeInstanceOf(StructuredCallFailure);
    expect((await unknown.spent('UTC')).spentUsd).toBeCloseTo(WORST, 12);
  });

  it('charges an attempt that left no usage-bearing response at its worst case', async () => {
    const budget = new DailyBudget(async () => 0);
    const partial = new StructuredCallFailure('retry timed out', USAGE, 'provider_transport_failed',
      { version: 1, adapterAttempts: 2, sdkAttempts: null, responses: [{ attempt: 0, contentKind: 'string', usageKnown: true }] });
    await expect(withDailyBudget(client(async () => { throw partial; }), budget, policy(1))
      .structuredCall(request({ malformedOutputPolicy: undefined }))).rejects.toBe(partial);
    expect((await budget.spent('UTC')).spentUsd).toBeCloseTo(ACTUAL + WORST, 12);
  });

  it('charges the worst case for an ambiguous transport failure, and nothing for a provider HTTP error', async () => {
    const lost = new DailyBudget(async () => 0);
    await expect(withDailyBudget(client(async () => { throw new Error('socket hang up'); }), lost, policy(1))
      .structuredCall(request())).rejects.toThrow('socket hang up');
    expect((await lost.spent('UTC')).spentUsd).toBeCloseTo(WORST, 12);
    const answered = new DailyBudget(async () => 0);
    await expect(withDailyBudget(client(async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); }),
      answered, policy(1)).structuredCall(request())).rejects.toThrow('rate limited');
    expect((await answered.spent('UTC')).spentUsd).toBe(0);
    expect(answered.reservedUsd).toBe(0);
  });

  it('releases a fail-closed call the provider answered with an HTTP error, and charges a lost connection', async () => {
    const answeredDiagnostics = { version: 1 as const, adapterAttempts: 1, sdkAttempts: 1, responses: [],
      failure: { attempt: 0, kind: 'http' as const, status: 502, errorType: 'InternalServerError' } };
    const answered = new DailyBudget(async () => 0);
    const projected = new StructuredCallFailure('failed', undefined, 'provider_transport_failed', answeredDiagnostics);
    await expect(withDailyBudget(client(async () => { throw projected; }), answered, policy(1)).structuredCall(request()))
      .rejects.toBe(projected);
    expect((await answered.spent('UTC')).spentUsd).toBe(0);
    expect(answered.reservedUsd).toBe(0);
    const lost = new DailyBudget(async () => 0);
    const dropped = new StructuredCallFailure('failed', undefined, 'provider_transport_failed', { ...answeredDiagnostics,
      failure: { attempt: 0, kind: 'connection', errorType: 'APIConnectionError', code: 'UND_ERR_SOCKET' } });
    await expect(withDailyBudget(client(async () => { throw dropped; }), lost, policy(1)).structuredCall(request()))
      .rejects.toBe(dropped);
    expect((await lost.spent('UTC')).spentUsd).toBeCloseTo(WORST, 12);
    const read = vi.fn(async () => 0);
    const unpriced = new DailyBudget(read);
    await expect(withDailyBudget(client(async () => { throw projected; }), unpriced, policy(null, null))
      .structuredCall(request())).rejects.toBe(projected);
    await unpriced.spent('UTC');
    expect(read).toHaveBeenCalledOnce();
  });

  it('does not charge a retry the provider answered with an HTTP error', async () => {
    const retried = (responses: Array<Record<string, unknown>>) => new StructuredCallFailure('retry failed', USAGE,
      'provider_transport_failed', { version: 1, adapterAttempts: 2, sdkAttempts: null, responses: responses as never,
        failure: { attempt: 1, kind: 'http', status: 503 } });
    const estimated = new DailyBudget(async () => 0);
    const first = retried([{ attempt: 0, contentKind: 'string', usageKnown: true }]);
    await expect(withDailyBudget(client(async () => { throw first; }), estimated, policy(1))
      .structuredCall(request({ malformedOutputPolicy: undefined }))).rejects.toBe(first);
    expect((await estimated.spent('UTC')).spentUsd).toBeCloseTo(ACTUAL, 12);
    const reported = new DailyBudget(async () => 0);
    const second = retried([{ attempt: 0, contentKind: 'string', usageKnown: true, providerCostUsd: 0.0123 }]);
    await expect(withDailyBudget(client(async () => { throw second; }), reported, policy(1))
      .structuredCall(request({ malformedOutputPolicy: undefined }))).rejects.toBe(second);
    expect((await reported.spent('UTC')).spentUsd).toBeCloseTo(0.0123, 12);
  });

  it('settles real adapter failures by what the provider returned', async () => {
    const settle = async (thrown: unknown) => {
      const create = vi.fn().mockRejectedValue(thrown);
      const adapter = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI,
        { provider: 'openrouter', fireworksExtensions: false });
      const budget = new DailyBudget(async () => 0);
      await expect(withDailyBudget(adapter, budget, policy(1)).structuredCall(request()))
        .rejects.toMatchObject({ reason: 'provider_transport_failed' });
      return (await budget.spent('UTC')).spentUsd;
    };
    expect(await settle(new OpenAIClient.InternalServerError(502, { message: 'upstream' }, 'upstream', new Headers()))).toBe(0);
    expect(await settle(new OpenAIClient.APIConnectionError({ message: 'terminated' }))).toBeCloseTo(WORST, 12);
  });

  it('releases the hold without spend when the adapter refused before dispatch', async () => {
    const budget = new DailyBudget(async () => 0);
    const undispatched = new StructuredCallFailure('prompt too large', undefined, 'provider_prompt_too_large',
      { version: 1, adapterAttempts: 0, sdkAttempts: 0, responses: [] });
    await expect(withDailyBudget(client(async () => { throw undispatched; }), budget, policy(1)).structuredCall(request()))
      .rejects.toBe(undispatched);
    expect((await budget.spent('UTC')).spentUsd).toBe(0);
    expect(budget.reservedUsd).toBe(0);
  });

  it('bounds input by UTF-8 bytes of every request field, so dense text cannot slip under the cap', async () => {
    const dense = request({ system: '', user: '漢'.repeat(1_000), toolName: 'tool', toolDescription: 'describe' });
    const bound = estimateCostUsdWith(PRICE, { input: 512 + 3_000 + 4 + 8 + 2, output: 10_000, cacheRead: 0, cacheWrite: 0 });
    const fits = new DailyBudget(async () => 1 - bound);
    await withDailyBudget(client(), fits, policy(1)).structuredCall(dense);
    const over = new DailyBudget(async () => 1 - bound + 1e-9);
    await expect(withDailyBudget(client(), over, policy(1)).structuredCall(dense)).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it('keeps counting uncapped calls, so a cap restored the same day sees them', async () => {
    const read = vi.fn(async () => 0);
    const budget = new DailyBudget(read);
    await withDailyBudget(client(), budget, policy(1)).structuredCall(request());
    await withDailyBudget(client(), budget, policy(null)).structuredCall(request());
    expect((await budget.spent('UTC')).spentUsd).toBeCloseTo(2 * ACTUAL, 12);
    expect(read).toHaveBeenCalledTimes(1);
    await withDailyBudget(client(), budget, policy(null, null)).structuredCall(request());
    await budget.spent('UTC');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('refuses unpriced models while capped, and passes everything through without a cap', async () => {
    const read = vi.fn(async () => 0);
    const inner = client();
    await expect(withDailyBudget(inner, new DailyBudget(read), policy(1, null)).structuredCall(request()))
      .rejects.toBeInstanceOf(BudgetPricingUnknownError);
    expect(inner.structuredCall).not.toHaveBeenCalled();
    await withDailyBudget(inner, new DailyBudget(read), policy(null, null)).structuredCall(request());
    expect(inner.structuredCall).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses every call once admission closes for shutdown, capped or not, including a retry (#405)', async () => {
    const budget = new DailyBudget(async () => 0);
    let retried: Promise<void> | undefined;
    const inner = client(async () => ({ output: {}, usage: USAGE }));
    inner.structuredCall.mockImplementationOnce(async (req: StructuredCallRequest) => {
      budget.closeAdmission(); // SIGTERM arrives while the first attempt is in flight
      retried = req.beforeRetry!();
      await retried.catch(() => {});
      return { output: {}, usage: USAGE };
    });
    await withDailyBudget(inner, budget, policy(null)).structuredCall(request());
    await expect(retried).rejects.toBeInstanceOf(CuratorShutdownError);
    for (const cap of [null, 1]) {
      const refused = await withDailyBudget(inner, budget, policy(cap)).structuredCall(request()).catch(e => e);
      expect(refused).toBeInstanceOf(CuratorShutdownError);
      expect(isBudgetRefusal(new Error('stage failed', { cause: refused }))).toBe(true);
      expect(isShutdownRefusal(refused)).toBe(true);
      expect(budgetRefusalDetail(refused)).toBe('the Curator is shutting down, so no new model call was made');
    }
    expect(inner.structuredCall).toHaveBeenCalledTimes(1);
    expect(budget.reservedUsd).toBe(0);
    await expect(budgetGate(budget, policy(null)).remainingUsd()).rejects.toBeInstanceOf(CuratorShutdownError);
    expect(isShutdownRefusal(new BudgetExhaustedError('spent'))).toBe(false);
  });

  it('keeps the budget on reconfigured stage clients', async () => {
    const reconfigured = client();
    const base = { ...client(), withConfiguration: vi.fn(() => reconfigured) } as unknown as LlmClient;
    const budget = new DailyBudget(async () => 1);
    const stage = withDailyBudget(base, budget, policy(1)).withConfiguration!({ provider: 'openrouter', reasoningEffort: 'low' });
    await expect(stage.structuredCall(request())).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect((reconfigured as unknown as { structuredCall: ReturnType<typeof vi.fn> }).structuredCall).not.toHaveBeenCalled();
  });
});

describe('dailyBudgetPolicy and ledgerSpend', () => {
  it('converts cents, prefers catalog pricing and falls back to the static table', () => {
    const p = dailyBudgetPolicy({ dailyBudgetCents: 150, curatorTz: 'America/New_York',
      modelPricing: { 'z-ai/custom': PRICE, unknown: null } });
    expect([p.capUsd, p.tz]).toEqual([1.5, 'America/New_York']);
    expect(p.pricing('z-ai/custom')).toEqual(PRICE);
    expect(p.pricing('claude-sonnet-4-6')).toMatchObject({ input: 3, output: 15 });
    expect(p.pricing('unknown')).toBeNull();
    expect(dailyBudgetPolicy({ dailyBudgetCents: null, curatorTz: 'UTC' }).capUsd).toBeNull();
  });

  it('reads the Curator known-cost subtotal since local midnight, without what runs paid from their own limits (#644)', async () => {
    const groups = [
      { purpose: 'wiki-synthesis', cost_usd: 0.2 }, { purpose: 'field-fill-run', cost_usd: 0.06 }, { purpose: 'field-guess', cost_usd: 0.05 },
      // A typing run's calls, and the nightly typing's: only the nightly's are the day's.
      { purpose: 'type-notes-run', cost_usd: 0.04 }, { purpose: 'org-sweep', cost_usd: 0.01 },
      // A subject run's calls (#554) are its own too.
      { purpose: 'memory-subjects-run', cost_usd: 0.03 },
      // An extraction run's calls and the Engine's checks of the memories it wrote (#659), and the nightly sweep's checks.
      { purpose: 'memory-extraction-run', cost_usd: 0.02 },
      { purpose: 'memory-consolidation-run', cost_usd: 0.015 },
      { purpose: 'memory-consolidation', cost_usd: 0.007 },
    ];
    const usageReport = vi.fn(async () => ({ data: { groups, group_count: 9, totals: { cost_usd: 0.432 } }, warnings: [] }));
    expect(await ledgerSpend({ usageReport })('2026-10-25T04:00:00.000Z')).toBeCloseTo(0.267, 10);
    // One report, so the day's spend and the runs' share come from the same moment: read apart, a
    // run's charge landing between the reads would be subtracted from spend it was never part of.
    expect(usageReport).toHaveBeenCalledTimes(1);
    expect(usageReport).toHaveBeenCalledWith({ service: 'curator', since: '2026-10-25T04:00:00.000Z', group_by: ['purpose'], limit: 1000 });
    expect(RUN_BUDGET_PURPOSES).toEqual(['field-fill-run', 'type-notes-run', 'memory-subjects-run', 'memory-extraction-run', 'memory-consolidation-run']);
    expect(await ledgerSpend({ usageReport: async () => ({ data: { groups: [], totals: { cost_usd: 0 } }, warnings: [] }) })('x')).toBe(0);
  });

  it('refuses a report it cannot add up, so no call is admitted on a guess', async () => {
    const report = (data: Record<string, unknown>) => ledgerSpend({ usageReport: async () => ({ data: data as never, warnings: [] }) })('x');
    await expect(report({ groups: [], totals: {} })).rejects.toThrow('cost_usd');
    await expect(report({ groups: [{ purpose: 'field-guess' }], totals: { cost_usd: 1 } })).rejects.toThrow('cost_usd');
    await expect(report({ groups: [{ purpose: 'field-guess', cost_usd: 1 }], group_count: 2, totals: { cost_usd: 2 } })).rejects.toThrow('left out');
  });
});

describe('a run\'s own limit (#644)', () => {
  const runLedger = (spent: number) => vi.fn(async (_filter: Record<string, unknown>) => ({ data: { groups: [], totals: { cost_usd: spent } }, warnings: [] }));

  it('admits calls against the stated limit, starting from what the ledger holds for the run', async () => {
    const usageReport = runLedger(0.02);
    const llm = client();
    const budgets = new Set<DailyBudget>();
    const run = createRunBudget({ llm, policy: policy(0.01), engine: { usageReport }, limitUsd: 0.02 + WORST + ACTUAL / 2, runRef: 'run-1', budgets });
    expect(budgets.size).toBe(1);

    await run.llm.structuredCall(request());
    // The daily cap in the policy ($0.01) is not this run's cap: the call above would not fit it.
    expect(llm.structuredCall).toHaveBeenCalledTimes(1);
    expect(usageReport).toHaveBeenCalledWith({ service: 'curator', run_ref: 'run-1', limit: 1 });
    expect(await run.spentUsd()).toBeCloseTo(0.02 + ACTUAL, 10);

    // The next call's worst case no longer fits, and the refusal names the run's limit.
    const refused = await run.llm.structuredCall(request()).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(BudgetExhaustedError);
    expect(isBudgetRefusal(refused)).toBe(true);
    expect(budgetRefusalDetail(refused)).toMatch(/^this run's limit: \$0\.0260 spent of \$/);
    expect(llm.structuredCall).toHaveBeenCalledTimes(1);

    run.release();
    expect(budgets.size).toBe(0);
  });

  it('is a lifetime tally: local midnight resets nothing, and charges the ledger never records are kept', async () => {
    let now = new Date('2026-10-25T23:50:00Z');
    // The first call times out: it may have been billed, so it is charged at its worst case, which the ledger never sees.
    const llm = client(async () => { throw new Error('socket hang up'); });
    const usageReport = runLedger(0);
    const limitUsd = WORST * 1.5;
    const run = createRunBudget({ llm, policy: policy(1), engine: { usageReport }, limitUsd, runRef: 'run-3', now: () => now });
    await expect(run.llm.structuredCall(request())).rejects.toThrow('socket hang up');
    expect(await run.spentUsd()).toBeCloseTo(WORST, 10);
    await expect(run.llm.structuredCall(request())).rejects.toBeInstanceOf(BudgetExhaustedError);

    // Past local midnight the same call is still refused: the run's limit is not a day's.
    now = new Date('2026-10-26T00:10:00Z');
    await expect(run.llm.structuredCall(request())).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(await run.spentUsd()).toBeCloseTo(WORST, 10);
    expect(llm.structuredCall).toHaveBeenCalledTimes(1);
    // The ledger was read once, at the first admission.
    expect(usageReport).toHaveBeenCalledTimes(1);
  });

  it('counts calls that may have been billed at their worst case, on top of what the ledger holds for the run', async () => {
    const results: Array<() => Promise<unknown>> = [
      async () => { throw new Error('socket hang up'); },
      // A reply that reports no usage.
      async () => ({ output: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usageKnown: false }),
    ];
    const llm = client(async () => results.shift()!());
    const run = createRunBudget({ llm, policy: policy(1), engine: { usageReport: runLedger(0.01) }, limitUsd: 1, runRef: 'run-4' });
    await expect(run.llm.structuredCall(request())).rejects.toThrow('socket hang up');
    expect(await run.spentUsd()).toBeCloseTo(0.01 + WORST, 10);
    await run.llm.structuredCall(request());
    expect(await run.spentUsd()).toBeCloseTo(0.01 + 2 * WORST, 10);
  });

  it('leaves the daily tally alone, and stops with it at shutdown', async () => {
    const daily = new DailyBudget(async () => 0);
    const llm = client();
    const budgets = new Set<DailyBudget>();
    const run = createRunBudget({ llm, policy: policy(1), engine: { usageReport: runLedger(0) }, limitUsd: 1, runRef: 'run-2', budgets });
    await run.llm.structuredCall(request());
    expect((await daily.spent('UTC')).spentUsd).toBe(0);

    for (const budget of budgets) budget.closeAdmission();
    const refused = await run.llm.structuredCall(request()).catch((error: unknown) => error);
    expect(isShutdownRefusal(refused)).toBe(true);
  });
});

describe('charges the usage ledger never records', () => {
  const now = new Date('2026-10-25T18:00:00Z');
  const clock = () => now;
  function chargeDb() { const db = new Database(':memory:'); runMigrations(db); return db; }

  it('adds stored charges to the ledger when a day loads, counting only that day', async () => {
    const db = chargeDb();
    const store = budgetChargeStore(db);
    store.record('2026-10-24T23:00:00.000Z', 0.5);
    store.record('2026-10-25T10:00:00.000Z', 0.25);
    const budget = new DailyBudget(async () => 0.1, clock, store);
    expect((await budget.spent('UTC')).spentUsd).toBeCloseTo(0.35, 12);
  });

  it('keeps the worst-case charge of an unreported failure across a restart', async () => {
    const db = chargeDb();
    const ledger = async () => 0; // the failed call wrote nothing to the ledger
    const first = new DailyBudget(ledger, clock, budgetChargeStore(db));
    await expect(withDailyBudget(client(async () => { throw new StructuredCallFailure('lost'); }), first, policy(1))
      .structuredCall(request())).rejects.toBeInstanceOf(StructuredCallFailure);
    expect((await first.spent('UTC')).spentUsd).toBeCloseTo(WORST, 12);

    const restarted = new DailyBudget(ledger, clock, budgetChargeStore(db));
    expect((await restarted.spent('UTC')).spentUsd).toBeCloseTo(WORST, 12);
  });

  it('persists only what the ledger will not record', async () => {
    const charged = async (thrown: unknown, patch: Partial<StructuredCallRequest> = {}) => {
      const db = chargeDb();
      const budget = new DailyBudget(async () => 0, clock, budgetChargeStore(db));
      await withDailyBudget(client(async () => { throw thrown; }), budget, policy(1)).structuredCall(request(patch)).catch(() => {});
      return budgetChargeStore(db).totalSince('2026-10-25T00:00:00.000Z');
    };
    expect(await charged(new Error('socket hang up'))).toBeCloseTo(WORST, 12);
    expect(await charged(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(0);
    expect(await charged(new StructuredCallFailure('bad', USAGE))).toBe(0);
    // A retry with no usage-bearing response is charged, and persisted, at one attempt's worst case.
    expect(await charged(new StructuredCallFailure('retry timed out', USAGE, 'provider_transport_failed',
      { version: 1, adapterAttempts: 2, sdkAttempts: null, responses: [{ attempt: 0, contentKind: 'string', usageKnown: true }] }),
    { malformedOutputPolicy: undefined })).toBeCloseTo(WORST, 12);

    const db = chargeDb();
    const budget = new DailyBudget(async () => 0, clock, budgetChargeStore(db));
    await withDailyBudget(client(), budget, policy(1)).structuredCall(request());
    expect(budgetChargeStore(db).totalSince('2026-10-25T00:00:00.000Z')).toBe(0);
  });

  it('settles a failure without token usage at its provider charge, which the ledger records', async () => {
    const db = chargeDb();
    const budget = new DailyBudget(async () => 0, clock, budgetChargeStore(db));
    const failure = new StructuredCallFailure('structured call failed (reason=truncated)', undefined, 'truncated',
      { version: 1, adapterAttempts: 1, sdkAttempts: 1, responses: [{ attempt: 0, contentKind: 'string', usageKnown: false, providerCostUsd: 0.0042 }] });
    await expect(withDailyBudget(client(async () => { throw failure; }), budget, policy(1)).structuredCall(request())).rejects.toBe(failure);
    expect((await budget.spent('UTC')).spentUsd).toBeCloseTo(0.0042, 12);
    expect(budgetChargeStore(db).totalSince('2026-10-25T00:00:00.000Z')).toBe(0);

    // When an attempt was answered with an HTTP error, the reporter cannot record the charge, so it persists.
    const partial = chargeDb();
    const answered = new StructuredCallFailure('retry failed', undefined, 'provider_transport_failed',
      { version: 1, adapterAttempts: 2, sdkAttempts: null, responses: [{ attempt: 0, contentKind: 'string', usageKnown: false, providerCostUsd: 0.0042 }],
        failure: { attempt: 1, kind: 'http', status: 503 } });
    await withDailyBudget(client(async () => { throw answered; }), new DailyBudget(async () => 0, clock, budgetChargeStore(partial)), policy(1))
      .structuredCall(request({ malformedOutputPolicy: undefined })).catch(() => {});
    expect(budgetChargeStore(partial).totalSince('2026-10-25T00:00:00.000Z')).toBeCloseTo(0.0042, 12);
  });

  it('refuses calls when stored charges cannot be read, and only warns when one cannot be written', async () => {
    const failing = { totalSince: () => { throw new Error('db locked'); }, record: () => { throw new Error('db locked'); } };
    await expect(new DailyBudget(async () => 0, clock, failing).spent('UTC')).rejects.toBeInstanceOf(BudgetUnavailableError);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const budget = new DailyBudget(async () => 0, clock, { totalSince: () => 0, record: failing.record });
      await budget.spent('UTC');
      expect(() => budget.settle(0, WORST, WORST)).not.toThrow();
      expect((await budget.spent('UTC')).spentUsd).toBeCloseTo(WORST, 12);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('budget charge not persisted'));
    } finally { warn.mockRestore(); }
  });

  it('prunes charges older than two days as it records', () => {
    const db = chargeDb();
    const store = budgetChargeStore(db);
    store.record('2026-10-22T12:00:00.000Z', 1);
    store.record('2026-10-25T12:00:00.000Z', 0.5);
    expect(db.prepare('SELECT COUNT(*) AS c FROM budget_charges').get()).toEqual({ c: 1 });
    expect(store.totalSince('2026-01-01T00:00:00.000Z')).toBe(0.5);
  });
});
