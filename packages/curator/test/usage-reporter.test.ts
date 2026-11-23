import { afterEach, describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import { providerKeyRef } from '@vault/llm';
import { openRouterKeyRef, UsageReporter } from '../src/usage-reporter.js';
import type { Engine } from '../src/engine.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { StructuredCallFailure } from '../src/llm/types.js';
import type { LlmClient, StructuredCallRequest } from '../src/llm/types.js';

function fakeLlm(): LlmClient {
  return {
    structuredCall: async (_req: StructuredCallRequest) => ({
      output: { ok: true },
      usage: { input: 1000, output: 200, cacheWrite: 0, cacheRead: 300 },
    }),
  };
}

const REQ: StructuredCallRequest = {
  model: 'accounts/fireworks/models/deepseek-v4-pro', maxTokens: 100,
  system: 's', user: 'u', toolName: 't', toolDescription: 'd', schema: {},
};

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected promise to reject');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UsageReporter', () => {
  it('accepts a restricted usage-only sink without the broader Engine client', async () => {
    const recordUsage = vi.fn(async (_event: Record<string, unknown>) => {});
    const reporter = new UsageReporter({ recordUsage }, { provider: 'fireworks', experiment: 'pilot', variant: 'source-first-v1' });
    await reporter.wrap(fakeLlm()).structuredCall(REQ);
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({ service: 'curator', purpose: 'wiki-synthesis', experiment: 'pilot' });
  });
  it('names the Engine\'s error code when it refuses a row, and nothing from the message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused = Object.assign(new Error('engine INVALID_PARAMS: SECRET-REQUEST-TEXT'), { code: 'INVALID_PARAMS' });
    const recordUsage = vi.fn(async () => { throw refused; });
    const reporter = new UsageReporter({ recordUsage }, { provider: 'fireworks', experiment: null, variant: null });
    await reporter.wrap(fakeLlm()).structuredCall(REQ);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls).toEqual([['[curator] usage persistence failed (INVALID_PARAMS)']]);
  });
  it('reports which OpenRouter key paid, and only for OpenRouter calls (#345)', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const provider = (model: string) => (model === 'or/model' ? 'openrouter' as const : 'fireworks' as const);
    const reporter = new UsageReporter({ recordUsage }, { provider, experiment: null, variant: null, openRouterKeyRef: 'abc' });
    const llm = reporter.wrap(fakeLlm());
    await llm.structuredCall({ ...REQ, model: 'or/model' });
    await llm.structuredCall(REQ);
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({ provider: 'openrouter', key_ref: 'abc' });
    expect(recordUsage.mock.calls[1]![0]).not.toHaveProperty('key_ref');
  });

  it('fingerprints the OpenRouter key the same way as the Engine, and sends nothing without one', () => {
    expect(openRouterKeyRef({ keys: { openrouter: 'sk-or-secret' }, baseURLs: {} })).toBe(providerKeyRef('sk-or-secret'));
    expect(openRouterKeyRef({ keys: { fireworks: 'fw' }, baseURLs: {} })).toBeUndefined();
  });

  it('does not claim capture support for an unsupported client', () => {
    const reporter = new UsageReporter({} as Engine, {
      provider: 'fireworks', experiment: null, variant: null,
    });
    expect(reporter.wrap(fakeLlm()).supportsPreparedCapture).toBeUndefined();
  });

  it('reports each structuredCall with tokens, context, and labels', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const reporter = new UsageReporter(
      { recordUsage } as unknown as Engine,
      { provider: 'fireworks', experiment: 'bench-1', variant: 'deepseek' },
    );
    reporter.setContext({ project: 'Vault Engine', runRef: 'run-abc' });

    const wrapped = reporter.wrap(fakeLlm());
    const res = await wrapped.structuredCall(REQ);
    expect(res.usage.input).toBe(1000); // passthrough intact

    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
    const args = recordUsage.mock.calls[0]![0] as Record<string, unknown>;
    expect(args).toMatchObject({
      provider: 'fireworks', service: 'curator', purpose: 'wiki-synthesis',
      model: 'accounts/fireworks/models/deepseek-v4-pro',
      input_tokens: 1000, output_tokens: 200, cache_read_tokens: 300, cache_write_tokens: 0,
      run_ref: 'run-abc', source_ref: 'Vault Engine',
      experiment: 'bench-1', variant: 'deepseek',
    });
    expect(typeof args.latency_ms).toBe('number');
  });

  it('omits context after setContext(null) and omits null labels', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const reporter = new UsageReporter(
      { recordUsage } as unknown as Engine,
      { provider: 'anthropic', experiment: null, variant: null },
    );
    reporter.setContext({ project: 'P', runRef: 'r' });
    reporter.setContext(null);
    await reporter.wrap(fakeLlm()).structuredCall(REQ);
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
    const args = recordUsage.mock.calls[0]![0] as Record<string, unknown>;
    expect(args).not.toHaveProperty('run_ref');
    expect(args).not.toHaveProperty('experiment');
  });

  it('swallows report failures (observer posture) and never fails the call', async () => {
    const recordUsage = vi.fn().mockRejectedValue(new Error('engine down'));
    const reporter = new UsageReporter(
      { recordUsage } as unknown as Engine,
      { provider: 'fireworks', experiment: null, variant: null },
    );
    await expect(reporter.wrap(fakeLlm()).structuredCall(REQ)).resolves.toBeTruthy();
  });

  it('records usage-bearing failed calls with current attribution and rethrows by identity', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const reporter = new UsageReporter(
      { recordUsage } as unknown as Engine,
      { provider: 'fireworks', experiment: 'field-rollout', variant: 'gpt-oss' },
    );
    reporter.setContext({
      project: 'field-guess-sweep',
      runRef: 'run-field-failure',
      purpose: 'field-guess',
    });
    const failure = new StructuredCallFailure('metadata-only failure', {
      input: 40,
      output: 20,
      cacheRead: 10,
      cacheWrite: 0,
    });
    const inner: LlmClient = {
      structuredCall: async () => { throw failure; },
    };

    await expect(reporter.wrap(inner).structuredCall(REQ)).rejects.toBe(failure);
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({
      provider: 'fireworks',
      service: 'curator',
      purpose: 'field-guess',
      model: REQ.model,
      input_tokens: 40,
      output_tokens: 20,
      cache_read_tokens: 10,
      cache_write_tokens: 0,
      run_ref: 'run-field-failure',
      source_ref: 'field-guess-sweep',
      experiment: 'field-rollout',
      variant: 'gpt-oss',
    });
    expect(typeof recordUsage.mock.calls[0]![0].latency_ms).toBe('number');
  });

  it('records prior response usage when a legacy application retry transport-fails', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const reporter = new UsageReporter(
      { recordUsage } as unknown as Engine,
      { provider: 'fireworks', experiment: null, variant: null },
    );
    reporter.setContext({
      project: 'legacy-synthesis',
      runRef: 'run-transport-after-response',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const create = vi.fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{malformed' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 90,
          completion_tokens: 25,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      })
      .mockRejectedValueOnce(new Error('transport failed after billed response'));
    const inner = new OpenAiCompatLlmClient({
      chat: { completions: { create } },
    } as unknown as OpenAI);

    const error = await (async () => {
      try {
        await reporter.wrap(inner).structuredCall(REQ);
      } catch (caught) {
        return caught;
      }
      throw new Error('Expected structured call to reject');
    })();

    expect(create).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({
      name: 'StructuredCallFailure',
      usage: { input: 50, output: 25, cacheWrite: 0, cacheRead: 40 },
    });
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({
      provider: 'fireworks',
      service: 'curator',
      purpose: 'wiki-synthesis',
      model: REQ.model,
      input_tokens: 50,
      output_tokens: 25,
      cache_read_tokens: 40,
      cache_write_tokens: 0,
      run_ref: 'run-transport-after-response',
      source_ref: 'legacy-synthesis',
    });
  });

  it('does not record usage for a pre-response transport failure', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const reporter = new UsageReporter(
      { recordUsage } as unknown as Engine,
      { provider: 'fireworks', experiment: null, variant: null },
    );
    const transportFailure = new Error('pre-response transport unavailable');
    const create = vi.fn().mockRejectedValueOnce(transportFailure);
    const inner = new OpenAiCompatLlmClient({
      chat: { completions: { create } },
    } as unknown as OpenAI);

    await expect(reporter.wrap(inner).structuredCall(REQ)).rejects.toBe(transportFailure);
    expect(create).toHaveBeenCalledTimes(1);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it.each([
    ['record rejection', false, '[curator] usage persistence failed'],
    ['provider resolver throw', true, '[curator] usage attribution failed'],
  ] as const)('never replaces a usage-bearing failure when the %s observer fails', async (_label, resolverThrows, warning) => {
    const recordUsage = vi.fn().mockRejectedValue(new Error('usage observer unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reporter = new UsageReporter(
      { recordUsage } as unknown as Engine,
      { provider: 'fireworks', experiment: null, variant: null },
    );
    const failure = new StructuredCallFailure('original structured failure', {
      input: 1, output: 2, cacheRead: 3, cacheWrite: 4,
    });
    const inner: LlmClient = { structuredCall: async () => { throw failure; } };
    const provider = resolverThrows
      ? () => { throw new Error('provider observer unavailable'); }
      : 'fireworks' as const;

    await expect(reporter.wrap(inner, provider).structuredCall(REQ)).rejects.toBe(failure);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn).toHaveBeenCalledWith(warning);
  });

  it('keeps fail-closed observer warnings static across attribution and persistence failures', async () => {
    const identifierMarker = 'VALID_OBSERVER_MARKER_42';
    const credentialMarker = 'FIXTURE-CREDENTIAL-MARKER-7ac4';
    const rawContentMarker = 'RAW-CONTENT-MARKER-f10d';
    const resolverErrorText = `RESOLVER-ERROR-TEXT ${identifierMarker} ${credentialMarker}`;
    const persistenceErrorText = `PERSISTENCE-ERROR-TEXT ${identifierMarker} ${credentialMarker}`;
    const warningAllowlist = [
      '[curator] usage attribution failed',
      '[curator] usage persistence failed',
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recordUsage = vi.fn().mockRejectedValue(
      new Error(persistenceErrorText),
    );
    const reporter = new UsageReporter(
      { recordUsage } as unknown as Engine,
      { provider: 'fireworks', experiment: null, variant: null },
    );
    const request: StructuredCallRequest = {
      ...REQ,
      model: `accounts/fireworks/models/${identifierMarker}`,
      toolName: `classify_${identifierMarker}`,
      malformedOutputPolicy: 'fail-closed-redacted',
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    const runMalformed = async (
      provider: 'fireworks' | ((model: string) => 'fireworks'),
    ): Promise<unknown> => {
      const create = vi.fn().mockResolvedValue({
        choices: [{
          message: { content: `{${rawContentMarker}` },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 7 },
        },
      });
      const adapter = new OpenAiCompatLlmClient({
        chat: { completions: { create } },
      } as unknown as OpenAI);
      let adapterFailure: unknown;
      const inner: LlmClient = {
        structuredCall: async req => {
          try {
            return await adapter.structuredCall(req);
          } catch (error) {
            adapterFailure = error;
            throw error;
          }
        },
      };

      const outward = await rejectionOf(reporter.wrap(inner, provider).structuredCall(request));
      expect(outward).toBe(adapterFailure);
      expect(outward).toMatchObject({
        name: 'StructuredCallFailure',
        usage: { input: 13, output: 5, cacheWrite: 0, cacheRead: 7 },
      });
      return outward;
    };

    try {
      const attributionFailure = await runMalformed(() => {
        throw new Error(resolverErrorText);
      });
      const persistenceFailure = await runMalformed('fireworks');

      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
      await new Promise(resolve => setImmediate(resolve));
      const warnings = warn.mock.calls.map(call => call.join(' '));
      const outwardDiagnostics = [attributionFailure, persistenceFailure]
        .map(error => error instanceof Error ? error.message : String(error));
      expect(warnings).toEqual(warningAllowlist);
      expect(warnings.every(message => message.length <= 64)).toBe(true);
      expect(JSON.stringify({ outwardDiagnostics, warnings }))
        .not.toContain(identifierMarker);
      expect(JSON.stringify({ outwardDiagnostics, warnings }))
        .not.toContain(credentialMarker);
      expect(JSON.stringify({ outwardDiagnostics, warnings }))
        .not.toContain(rawContentMarker);
      expect(warnings.join('\n')).not.toContain(resolverErrorText);
      expect(warnings.join('\n')).not.toContain(persistenceErrorText);
      expect(recordUsage).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('purpose attribution (v1.6)', () => {
  function setup() {
    const recorded: Array<Record<string, unknown>> = [];
    const engine = { recordUsage: async (args: Record<string, unknown>) => { recorded.push(args); } } as unknown as Engine;
    const reporter = new UsageReporter(engine, { provider: 'fireworks', experiment: null, variant: null });
    const inner: LlmClient = {
      structuredCall: async () => ({ output: {}, usage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 } }),
    };
    return { recorded, reporter, wrapped: reporter.wrap(inner) };
  }

  it('defaults purpose to wiki-synthesis', async () => {
    const { recorded, reporter, wrapped } = setup();
    reporter.setContext({ project: 'P', runRef: 'r1' });
    await wrapped.structuredCall({ model: 'm', maxTokens: 10, system: 's', user: 'u', toolName: 't', toolDescription: 'd', schema: {} });
    await new Promise(r => setTimeout(r, 0)); // report() is fire-and-forget
    expect(recorded[0]?.purpose).toBe('wiki-synthesis');
  });

  it('uses the context purpose when set', async () => {
    const { recorded, reporter, wrapped } = setup();
    reporter.setContext({ project: 'memory-sweep', runRef: 'r2', purpose: 'memory-sweep' });
    await wrapped.structuredCall({ model: 'm', maxTokens: 10, system: 's', user: 'u', toolName: 't', toolDescription: 'd', schema: {} });
    await new Promise(r => setTimeout(r, 0));
    expect(recorded[0]?.purpose).toBe('memory-sweep');
  });

  it('withContext labels only its own calls, leaving a running curation\'s slot alone (#387)', async () => {
    const { recorded, reporter, wrapped } = setup();
    const req = { model: 'm', maxTokens: 10, system: 's', user: 'u', toolName: 't', toolDescription: 'd', schema: {} };
    reporter.setContext({ project: 'Curating', runRef: 'queued-run' });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const scoped = reporter.withContext({ project: 'topic-inference', runRef: 'proposal', purpose: 'topic-inference' }, async () => {
      await held;
      return wrapped.structuredCall(req);
    });
    // The curation's call, made while the scoped call is in flight, keeps the curation's context.
    await wrapped.structuredCall(req);
    release();
    await scoped;
    await wrapped.structuredCall(req);
    await vi.waitFor(() => expect(recorded).toHaveLength(3));
    expect(recorded.map(r => [r.source_ref, r.run_ref, r.purpose])).toEqual([
      ['Curating', 'queued-run', 'wiki-synthesis'],
      ['topic-inference', 'proposal', 'topic-inference'],
      ['Curating', 'queued-run', 'wiki-synthesis'],
    ]);
  });
});

describe('function-form provider (per-call dispatch labels)', () => {
  it('resolves the provider label per call from the routed model', async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const engine = { recordUsage: async (args: Record<string, unknown>) => { recorded.push(args); } } as unknown as Engine;
    const providerFor = (model: string): 'anthropic' | 'fireworks' => (model.startsWith('claude') ? 'anthropic' : 'fireworks');
    const reporter = new UsageReporter(engine, { provider: providerFor, experiment: null, variant: null });
    reporter.setContext({ project: 'P', runRef: 'r' });

    const wrapped = reporter.wrap(fakeLlm());
    await wrapped.structuredCall({ ...REQ, model: 'claude-sonnet-4-6' });
    await wrapped.structuredCall({ ...REQ, model: 'accounts/fireworks/models/deepseek-v4-pro' });

    await vi.waitFor(() => expect(recorded).toHaveLength(2));
    expect(recorded[0]?.provider).toBe('anthropic');
    expect(recorded[0]?.model).toBe('claude-sonnet-4-6');
    expect(recorded[1]?.provider).toBe('fireworks');
    expect(recorded[1]?.model).toBe('accounts/fireworks/models/deepseek-v4-pro');
  });

  it('a fixed literal label still compiles and stamps every call the same way', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const reporter = new UsageReporter(
      { recordUsage } as unknown as Engine,
      { provider: 'anthropic', experiment: null, variant: null },
    );
    await reporter.wrap(fakeLlm()).structuredCall(REQ);
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({ provider: 'anthropic' });
  });

  it('lets each next-use wrapper replace a long-lived reporter\'s stale provider map', async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const engine = {
      recordUsage: async (args: Record<string, unknown>) => { recorded.push(args); },
    } as unknown as Engine;
    const reporter = new UsageReporter(engine, {
      provider: () => 'anthropic',
      experiment: null,
      variant: null,
    });
    const nextRuntimeProvider = (model: string): 'fireworks' | 'openrouter' =>
      model === MODEL_AFTER_REFRESH ? 'openrouter' : 'fireworks';

    const MODEL_AFTER_REFRESH = 'provider/model-after-settings-refresh';
    const wrapped = reporter.wrap(fakeLlm(), nextRuntimeProvider);
    await wrapped.structuredCall({ ...REQ, model: MODEL_AFTER_REFRESH });

    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]).toMatchObject({
      model: MODEL_AFTER_REFRESH,
      provider: 'openrouter',
    });
  });

  it('contains a synchronous refreshed-provider resolver failure after the paid call succeeds', async () => {
    const reporter = new UsageReporter(
      { recordUsage: vi.fn() } as unknown as Engine,
      { provider: 'anthropic', experiment: null, variant: null },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wrapped = reporter.wrap(fakeLlm(), () => {
      throw new Error('refreshed provider map unavailable');
    });

    await expect(wrapped.structuredCall(REQ)).resolves.toEqual(callResultForAssertion());
    expect(warn).toHaveBeenCalledWith('[curator] usage attribution failed');
  });
});

describe('UsageReporter.flush (#386)', () => {
  function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('waits for the last call\'s ledger write, which the call itself does not wait for', async () => {
    const write = deferred();
    const recordUsage = vi.fn(() => write.promise);
    const reporter = new UsageReporter({ recordUsage }, { provider: 'fireworks', experiment: null, variant: null });
    await reporter.wrap(fakeLlm()).structuredCall(REQ);
    expect(recordUsage).toHaveBeenCalledOnce();

    let flushed = false;
    const flush = reporter.flush().then(() => { flushed = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(flushed).toBe(false);
    write.resolve();
    await flush;
    expect(flushed).toBe(true);
  });

  it('waits for a write started while it waits, and returns at once with nothing pending', async () => {
    const reporter = new UsageReporter({ recordUsage: vi.fn(async () => {}) }, { provider: 'fireworks', experiment: null, variant: null });
    await expect(reporter.flush()).resolves.toBeUndefined();

    const first = deferred();
    const second = deferred();
    const recordUsage = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const busy = new UsageReporter({ recordUsage }, { provider: 'fireworks', experiment: null, variant: null });
    const llm = busy.wrap(fakeLlm());
    await llm.structuredCall(REQ);
    let flushed = false;
    const flush = busy.flush().then(() => { flushed = true; });
    await llm.structuredCall(REQ);
    first.resolve();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(flushed).toBe(false);
    second.resolve();
    await flush;
    expect(flushed).toBe(true);
  });

  it('never throws when a write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const write = deferred();
    const reporter = new UsageReporter({ recordUsage: vi.fn(() => write.promise) }, { provider: 'fireworks', experiment: null, variant: null });
    await reporter.wrap(fakeLlm()).structuredCall(REQ);
    const flush = reporter.flush();
    write.reject(new Error('transport closed'));
    await expect(flush).resolves.toBeUndefined();
    expect(warn.mock.calls).toEqual([['[curator] usage persistence failed']]);
  });

  it('gives up on a hung write at the deadline, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reporter = new UsageReporter({ recordUsage: vi.fn(() => new Promise<void>(() => {})) },
      { provider: 'fireworks', experiment: null, variant: null });
    await reporter.wrap(fakeLlm()).structuredCall(REQ);
    const started = Date.now();
    await expect(reporter.flush(30)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warn.mock.calls).toEqual([['[curator] usage flush timed out; 1 write(s) still pending']]);
  });
});

function callResultForAssertion() {
  return {
    output: { ok: true },
    usage: { input: 1000, output: 200, cacheWrite: 0, cacheRead: 300 },
  };
}
