import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { RejectionBreaker, REJECTIONS_BEFORE_STOP } from '../src/rejection-breaker.js';
import { BudgetExhaustedError } from '../src/budget.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import type { StructuredCallRequest } from '../src/llm/types.js';

/** An OpenAI-SDK-shaped provider error, as OpenRouter returns it. */
function rejection(status: number, raw = '{"error":{"message":"bad schema"}}'): Error {
  return Object.assign(new Error(`${status} Provider returned error`), {
    status, error: { message: 'Provider returned error', metadata: { provider_name: 'Upstream', raw } },
  });
}

describe('RejectionBreaker', () => {
  it('stops at once on a budget refusal, even inside a rejection streak (#342)', () => {
    const b = new RejectionBreaker('org sweep typing', 'm');
    expect(b.failed(rejection(400))).toBeNull();
    expect(b.budgetStop(rejection(400))).toBeNull();
    const refusal = new Error('page synthesis failed', { cause: new BudgetExhaustedError('daily budget: $3.0000 spent of $3.00') });
    expect(b.budgetStop(refusal)).toBe('org sweep typing stopped: daily budget: $3.0000 spent of $3.00; the rest is retried next run');
    // The streak restarts after a budget stop.
    expect(b.failed(rejection(400))).toBeNull();
    expect(b.failed(rejection(400))).toBeNull();
  });

  it('stops on the third identical rejection, naming the stage, model and reason', () => {
    const b = new RejectionBreaker('memory sweep', 'some/model');
    expect(REJECTIONS_BEFORE_STOP).toBe(3);
    expect(b.failed(rejection(400))).toBeNull();
    expect(b.failed(rejection(400))).toBeNull();
    const stop = b.failed(rejection(400));
    expect(stop).toContain('memory sweep stopped after 3 identical rejections from model some/model');
    expect(stop).toContain('HTTP 400 from Upstream: bad schema');
  });

  it('a success or a different reason restarts the count', () => {
    const b = new RejectionBreaker('s', 'm');
    b.failed(rejection(400)); b.failed(rejection(400)); b.succeeded();
    expect(b.failed(rejection(400))).toBeNull();
    expect(b.failed(rejection(400, 'other reason'))).toBeNull();
    expect(b.failed(rejection(400, 'other reason'))).toBeNull();
    expect(b.failed(rejection(400, 'other reason'))).not.toBeNull();
  });

  it('never stops on rate limits, timeouts, conflicts, server errors or transport failures, and they reset the count', () => {
    const b = new RejectionBreaker('s', 'm');
    b.failed(rejection(400)); b.failed(rejection(400));
    for (const status of [429, 408, 409, 500, 503]) expect(b.failed(rejection(status))).toBeNull();
    expect(b.failed(new Error('socket hang up'))).toBeNull();
    expect(b.failed(rejection(400))).toBeNull(); // the count restarted
    for (let i = 0; i < 5; i++) expect(b.failed(rejection(503))).toBeNull();
  });

  it('identifies a fail-closed call\'s rejection by its diagnostics, without the provider text (#254)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let status = 400;
    const client = { chat: { completions: { create: async () => { throw rejection(status, 'quotes the prompt: secret'); } } } };
    const llm = new OpenAiCompatLlmClient(client as unknown as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
    const request: StructuredCallRequest = { model: 'm', maxTokens: 10, system: 's', user: 'u', toolName: 'emit',
      toolDescription: 'd', schema: { type: 'object' }, malformedOutputPolicy: 'fail-closed-redacted' };
    const failed = () => llm.structuredCall(request).then(() => { throw new Error('expected a failure'); }, (error: unknown) => error);
    const b = new RejectionBreaker('conversation capture (planner)', 'm');
    expect(b.failed(await failed())).toBeNull();
    expect(b.failed(await failed())).toBeNull();
    const stop = b.failed(await failed());
    expect(stop).toBe('conversation capture (planner) stopped after 3 identical rejections from model m '
      + '(HTTP 400 from Upstream); the rest is retried next run');
    expect(stop).not.toContain('secret');
    status = 429;
    expect(b.failed(await failed())).toBeNull();
    warn.mockRestore();
  });
});
