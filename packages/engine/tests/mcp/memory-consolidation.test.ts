import { createProviderClients } from '@vault/llm';
import { describe, it, expect, vi } from 'vitest';
import type OpenAI from 'openai';
import {
  CONSOLIDATION_MAX_TOKENS,
  createConsolidator,
  currentDateLine,
  parseConsolidationResponse,
} from '../../src/mcp/tools/memory-consolidation.js';
import type { ConsolidationTarget } from '../../src/mcp/tools/memory-consolidation.js';
import Database from 'better-sqlite3';
import { addUsageEvents } from '../../src/db/migrate.js';
import { UsageRecorder } from '../../src/usage/recorder.js';
import { createTestDb } from '../helpers/db.js';
import { setStoredSettings } from '../../src/settings/store.js';
import { wikiTimeZone } from '../../src/wiki/today.js';

const HOST = Intl.DateTimeFormat().resolvedOptions().timeZone;
// 22:30 on Monday 9 March in New York, already Tuesday 10 March in UTC.
const NY_EVENING = new Date('2026-03-10T03:30:00Z');
// 05:30 on Tuesday 10 March in Tokyo, still Monday 9 March in UTC and in New York.
const TOKYO_MORNING = new Date('2026-03-09T20:30:00Z');

/** The line as the code before #459 wrote it: always the host's zone. */
function legacyDateLine(now: Date): string {
  return `Today is ${now.toLocaleDateString('en-US', { weekday: 'long' })}, ${now.toLocaleDateString('en-CA')} (${HOST}).`;
}

const ids = new Set([37, 42]);

describe('parseConsolidationResponse', () => {
  it('parses an add verdict (no target required)', () => {
    const v = parseConsolidationResponse('{"operation":"add","target_id":null,"valid_at":null,"reason":"new"}', ids);
    expect(v.operation).toBe('add');
    expect(v.target_id).toBeUndefined();
  });

  it('parses a contradict verdict with a valid target and inferred valid_at', () => {
    const v = parseConsolidationResponse(
      'Sure: {"operation":"contradict","target_id":37,"valid_at":"2026-02-01T00:00:00.000Z","reason":"stakeholder changed"}',
      ids,
    );
    expect(v.operation).toBe('contradict');
    expect(v.target_id).toBe(37);
    expect(v.valid_at).toBe('2026-02-01T00:00:00.000Z');
  });

  it('keeps valid_at only as a canonical UTC ISO timestamp (#300)', () => {
    const parse = (validAt: unknown) =>
      parseConsolidationResponse(JSON.stringify({ operation: 'add', target_id: null, valid_at: validAt, reason: 'r' }), ids).valid_at;
    expect(parse('null')).toBeUndefined();
    expect(parse('unknown')).toBeUndefined();
    expect(parse('last spring')).toBeUndefined();
    expect(parse('2026-13-45')).toBeUndefined();
    expect(parse(null)).toBeUndefined();
    expect(parse(20260201)).toBeUndefined();
    expect(parse('2026-02-01')).toBe('2026-02-01T00:00:00.000Z');
    expect(parse('2026-02-01T09:30:00+02:00')).toBe('2026-02-01T07:30:00.000Z');
    expect(parse('2026-02-01 09:30:00Z')).toBe('2026-02-01T09:30:00.000Z');
  });

  it('throws on an unknown operation', () => {
    expect(() => parseConsolidationResponse('{"operation":"merge","target_id":37}', ids)).toThrow();
  });

  it('throws when a non-add op targets an id not in the candidate set', () => {
    expect(() => parseConsolidationResponse('{"operation":"update","target_id":999,"reason":"x"}', ids)).toThrow();
  });

  it('throws when there is no JSON object at all', () => {
    expect(() => parseConsolidationResponse('I cannot help with that', ids)).toThrow();
  });
});

describe('currentDateLine', () => {
  it('formats weekday, local ISO date, and timezone', () => {
    expect(currentDateLine(new Date(2026, 6, 10))).toMatch(/^Today is Friday, 2026-07-10 \(.+\)\.$/);
  });
  it('defaults to now', () => {
    expect(currentDateLine()).toMatch(/^Today is [A-Z][a-z]+day, \d{4}-\d{2}-\d{2} \(.+\)\.$/);
  });
  it('takes the date and weekday in the given zone (#459)', () => {
    expect(currentDateLine(NY_EVENING, 'America/New_York')).toBe('Today is Monday, 2026-03-09 (America/New_York).');
    expect(currentDateLine(NY_EVENING, 'UTC')).toBe('Today is Tuesday, 2026-03-10 (UTC).');
    expect(currentDateLine(TOKYO_MORNING, 'Asia/Tokyo')).toBe('Today is Tuesday, 2026-03-10 (Asia/Tokyo).');
  });
  it('is byte-identical to the old host-zone line on an installation whose tz is stored empty', () => {
    const db = createTestDb();
    setStoredSettings(db, 'curator', {
      activeStatuses: ['open', 'in-progress', 'next'], wikiReconciliationMode: 'live', tz: '', topicDir: null,
      memorySweepTypes: ['meeting', 'daily-note', 'note'], orgTypeExclude: ['wiki', 'transcript'],
    });
    for (const now of [NY_EVENING, TOKYO_MORNING, new Date('2026-07-01T12:00:00Z'), new Date('2026-11-01T05:30:00Z')]) {
      expect(currentDateLine(now, wikiTimeZone(db))).toBe(legacyDateLine(now));
      expect(currentDateLine(now)).toBe(legacyDateLine(now));
    }
  });
});

describe('createConsolidator', () => {
  const input = {
    content: 'The operator prefers concise answers.',
    category: 'preference',
    candidates: [],
  };

  it('uses the selected provider endpoint, key, model, and usage attribution on each call', async () => {
    const clients: Array<{ apiKey: string; baseURL: string }> = [];
    const requests: Array<{ model: string }> = [];
    const createClient = vi.fn((options: { apiKey: string; baseURL: string }): OpenAI => {
      clients.push(options);
      return {
        chat: {
          completions: {
            create: vi.fn(async (request: { model: string }) => {
              requests.push(request);
              return {
                choices: [{ message: { content: '{"operation":"add","target_id":null,"valid_at":null,"reason":"new"}' } }],
                usage: { prompt_tokens: 11, completion_tokens: 7 },
              };
            }),
          },
        },
      } as unknown as OpenAI;
    });
    const record = vi.fn();
    const recorder = { record } as unknown as UsageRecorder;
    let target: ConsolidationTarget = {
      provider: 'fireworks',
      model: 'accounts/fireworks/models/kimi-k2p6',
    };
    const consolidator = createConsolidator(
      createProviderClients({ fireworks: 'fw-key', openrouter: 'or-key' }, { createOpenAi: createClient }),
      () => target,
      recorder,
    );

    await consolidator.consolidate(input);
    target = { provider: 'openrouter', model: 'openrouter/auto' };
    await consolidator.consolidate(input);

    expect(clients).toEqual([
      { apiKey: 'fw-key', baseURL: 'https://api.fireworks.ai/inference/v1' },
      { apiKey: 'or-key', baseURL: 'https://openrouter.ai/api/v1' },
    ]);
    expect(requests.map(request => request.model)).toEqual([
      'accounts/fireworks/models/kimi-k2p6',
      'openrouter/auto',
    ]);
    expect(record).toHaveBeenNthCalledWith(1, expect.objectContaining({
      provider: 'fireworks',
      model: 'accounts/fireworks/models/kimi-k2p6',
      purpose: 'memory-consolidation',
    }));
    expect(record).toHaveBeenNthCalledWith(2, expect.objectContaining({
      provider: 'openrouter',
      model: 'openrouter/auto',
      purpose: 'memory-consolidation',
    }));
  });

  it('limits update and contradict to the cases where discarding the candidate is safe (#349)', async () => {
    const create = vi.fn(async (_request: unknown) => ({
      choices: [{ message: { content: '{"operation":"add","target_id":null,"valid_at":null,"reason":"new"}' } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    }));
    const consolidator = createConsolidator(
      createProviderClients({ openrouter: 'or-key' }, { createOpenAi: vi.fn(() => ({ chat: { completions: { create } } }) as unknown as OpenAI) }),
      { provider: 'openrouter', model: 'qwen/qwen3.7-plus' },
    );
    await consolidator.consolidate(input);
    const request = JSON.stringify(create.mock.calls[0]![0]);
    expect(request).toContain('NEW says everything the candidate says');
    expect(request).toContain('missing from NEW');
    expect(request).toContain('both could be true at once');
    expect(request).toContain('When unsure');
    expect(request).not.toContain('refines/extends');
    // Each memory's note context, and what different contexts mean (#352).
    expect(request).toContain('Memories from notes filed under different projects');
  });

  it('tells the model today in the configured zone, read on each call (#459)', async () => {
    const create = vi.fn(async (_request: unknown) => ({
      choices: [{ message: { content: '{"operation":"add","target_id":null,"valid_at":null,"reason":"new"}' } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    }));
    let zone = 'Asia/Tokyo';
    const consolidator = createConsolidator(
      createProviderClients({ openrouter: 'or-key' }, { createOpenAi: vi.fn(() => ({ chat: { completions: { create } } }) as unknown as OpenAI) }),
      { provider: 'openrouter', model: 'qwen/qwen3.7-plus' },
      undefined,
      () => zone,
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(TOKYO_MORNING);
      await consolidator.consolidate(input);
      zone = 'America/New_York';
      await consolidator.consolidate(input);
    } finally { vi.useRealTimers(); }
    const systems = create.mock.calls.map(([request]) => JSON.stringify(request));
    expect(systems[0]).toContain('Today is Tuesday, 2026-03-10 (Asia/Tokyo).');
    expect(systems[1]).toContain('Today is Monday, 2026-03-09 (America/New_York).');
  });

  it("records the call on the caller's account when given one, else the Engine's (#298)", async () => {
    const record = vi.fn();
    const create = vi.fn(async () => ({
      choices: [{ message: { content: '{"operation":"add","target_id":null,"valid_at":null,"reason":"new"}' } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    }));
    const consolidator = createConsolidator(
      createProviderClients({ openrouter: 'or-key' }, { createOpenAi: vi.fn(() => ({ chat: { completions: { create } } }) as unknown as OpenAI) }),
      { provider: 'openrouter', model: 'qwen/qwen3.7-plus' },
      { record } as unknown as UsageRecorder,
    );
    await consolidator.consolidate(input, { service: 'curator', runRef: 'run-1', sourceRef: 'memory-sweep' });
    await consolidator.consolidate(input, { service: 'chat-plugin', conversationId: 'conv-9' });
    await consolidator.consolidate(input);
    // A Curator run paid from its own limit names its purpose, so the daily tally can leave it out (#659).
    await consolidator.consolidate(input, { service: 'curator', runRef: 'run-2', sourceRef: 'memory-extraction-run', purpose: 'memory-consolidation-run' });
    expect(record.mock.calls.map(([e]) => [e.service, e.runRef, e.sourceRef, e.conversationId, e.purpose])).toEqual([
      ['curator', 'run-1', 'memory-sweep', undefined, 'memory-consolidation'],
      ['chat-plugin', undefined, undefined, 'conv-9', 'memory-consolidation'],
      ['engine', undefined, undefined, undefined, 'memory-consolidation'],
      ['curator', 'run-2', 'memory-extraction-run', undefined, 'memory-consolidation-run'],
    ]);
  });

  it('returns what the call cost as recorded, null when unpriced, and carries it on an unusable answer', async () => {
    const answer = (content: string) => vi.fn(async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
    const make = (create: ReturnType<typeof answer>, recorded: unknown) => createConsolidator(
      createProviderClients({ openrouter: 'or-key' }, { createOpenAi: vi.fn(() => ({ chat: { completions: { create } } }) as unknown as OpenAI) }),
      { provider: 'openrouter', model: 'qwen/qwen3.7-plus' },
      { record: vi.fn(() => recorded) } as unknown as UsageRecorder,
    );
    const ok = '{"operation":"add","target_id":null,"valid_at":null,"reason":"new"}';
    expect((await make(answer(ok), { id: 1, costUsd: 0.0031, costBasis: 'computed' }).consolidate(input)).costUsd).toBe(0.0031);
    expect((await make(answer(ok), { id: 2, costUsd: 0, costBasis: 'unpriced' }).consolidate(input)).costUsd).toBeNull();
    expect((await make(answer(ok), null).consolidate(input)).costUsd).toBeNull();
    await expect(make(answer('no json here'), { id: 3, costUsd: 0.002, costBasis: 'computed' }).consolidate(input))
      .rejects.toMatchObject({ costUsd: 0.002 });
  });

  it("records OpenRouter's reported charge as the call's cost, and returns it (#320)", async () => {
    const db = new Database(':memory:');
    addUsageEvents(db);
    const create = vi.fn(async () => ({
      id: 'gen-abc',
      choices: [{ message: { content: '{"operation":"add","target_id":null,"valid_at":null,"reason":"new"}' } }],
      usage: { prompt_tokens: 5000, completion_tokens: 30, cost: 0.00071 },
    }));
    const consolidator = createConsolidator(
      createProviderClients({ openrouter: 'or-key' }, { createOpenAi: vi.fn(() => ({ chat: { completions: { create } } }) as unknown as OpenAI) }),
      { provider: 'openrouter', model: 'qwen/qwen3.7-plus' },
      new UsageRecorder(db),
    );
    const verdict = await consolidator.consolidate(input, { service: 'curator', runRef: 'run-1' });
    expect(verdict.costUsd).toBe(0.00071);
    expect(db.prepare('SELECT cost_usd, cost_basis, request_id, input_tokens FROM usage_events').get()).toEqual({
      cost_usd: 0.00071, cost_basis: 'provider-reported', request_id: 'gen-abc', input_tokens: 5000,
    });
  });

  function clientReturning(response: unknown, requests: Array<Record<string, unknown>> = []) {
    return vi.fn((): OpenAI => ({
      chat: {
        completions: {
          create: vi.fn(async (request: Record<string, unknown>) => {
            requests.push(request);
            return response;
          }),
        },
      },
    }) as unknown as OpenAI);
  }

  it('gives a reasoning model room to answer', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const consolidator = createConsolidator(
      createProviderClients({ openrouter: 'or-key' }, { createOpenAi: clientReturning({
        choices: [{ message: { content: '{"operation":"add","target_id":null,"valid_at":null,"reason":"new"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 900 },
      }, requests) }),
      { provider: 'openrouter', model: 'qwen/qwen3.7-plus' },
      undefined,
    );

    await expect(consolidator.consolidate(input)).resolves.toMatchObject({ operation: 'add' });
    expect(CONSOLIDATION_MAX_TOKENS).toBeGreaterThanOrEqual(4096);
    expect(requests[0]).toMatchObject({ max_tokens: CONSOLIDATION_MAX_TOKENS });
  });

  it('names a truncated response instead of reporting missing JSON', async () => {
    const consolidator = createConsolidator(
      createProviderClients({ openrouter: 'or-key' }, { createOpenAi: clientReturning({
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 11, completion_tokens: CONSOLIDATION_MAX_TOKENS },
      }) }),
      { provider: 'openrouter', model: 'qwen/qwen3.7-plus' },
      undefined,
    );

    await expect(consolidator.consolidate(input)).rejects.toThrow(
      `consolidation output truncated at ${CONSOLIDATION_MAX_TOKENS} tokens (model qwen/qwen3.7-plus)`,
    );
  });

  it('fails safely when the selected provider key is absent', async () => {
    const consolidator = createConsolidator(
      createProviderClients({ fireworks: 'fw-key' }, { createOpenAi: vi.fn() }),
      { provider: 'openrouter', model: 'openrouter/auto' },
      undefined,
    );

    await expect(consolidator.consolidate(input)).rejects.toThrow('OPENROUTER_API_KEY');
  });
});
