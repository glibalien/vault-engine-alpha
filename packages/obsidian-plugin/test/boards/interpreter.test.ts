import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { makeBoardInterpreter, type BoardInterpreterDeps } from '../../src/boards/interpreter.js';

const env = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
const SPEC = { kind: 'table', title: 't', query: { types: ['task'] }, display_fields: ['status'] };
const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};
const CATALOG = [{ title: 'GPT-OSS 120B', provider: 'fireworks' as const, model: 'accounts/fireworks/models/gpt-oss-120b', enabled: true }];

function deps(over: Partial<BoardInterpreterDeps> = {}): BoardInterpreterDeps & { recordUsage: ReturnType<typeof vi.fn> } {
  return {
    engineCall: vi.fn(async (name: string) => {
      if (name === 'list-schemas') return env({ ok: true, data: [{ name: 'task', node_count: 3, has_schema: true }], warnings: [] });
      return env({ ok: true, data: { name: 'task', display_name: null, fields: [] }, warnings: [] });
    }),
    effective: async () => ({ settings: { vizModel: '[[GPT-OSS 120B]]' } as never, catalog: CATALOG }),
    keys: { fireworks: 'fk' },
    makeModel: () => new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: JSON.stringify(SPEC) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      }),
    }),
    recordUsage: vi.fn(),
    log: vi.fn(),
    ...over,
  } as BoardInterpreterDeps & { recordUsage: ReturnType<typeof vi.fn> };
}

describe('makeBoardInterpreter', () => {
  it('builds the prompt examples from the vault map, read on each request (#449)', async () => {
    const prompts: string[] = [];
    const model = () => new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return { content: [{ type: 'text', text: JSON.stringify(SPEC) }], finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [] };
      },
    });
    const names = { taskType: 'todo', taskStatusField: 'state', taskActiveStatuses: ['doing'], taskDoneStatuses: ['finished'],
      taskTickStatus: 'finished', taskUntickStatus: 'todo', dueField: null, dateField: null, scheduledField: null };
    let vault: typeof names | undefined;
    const interpret = makeBoardInterpreter(deps({ makeModel: model, vault: () => vault ?? { ...names, taskType: 'task', taskStatusField: 'status', taskActiveStatuses: ['open'], taskDoneStatuses: ['done'] } }));
    expect((await interpret('open tasks')).ok).toBe(true);
    expect(prompts[0]).toContain("e.g. 'tasks · status != done'");
    vault = names;
    expect((await interpret('open todos')).ok).toBe(true);
    expect(prompts[1]).toContain("e.g. 'todos · state != finished'");
    expect(prompts[1]).not.toContain('tasks · status');
  });

  it('resolves the model, interprets, and records viz-interpret spend (with latency)', async () => {
    const d = deps();
    const interpret = makeBoardInterpreter(d);
    const got = await interpret('open tasks');
    expect(got.ok).toBe(true);
    expect(d.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'viz-interpret', service: 'chat-plugin' }));
    const args = d.recordUsage.mock.calls[0]![0] as Record<string, unknown>;
    expect(typeof args.latency_ms).toBe('number');
    expect(args.latency_ms as number).toBeGreaterThanOrEqual(0);
  });

  it('unresolvable/disabled vizModel → catalog-config error naming the ref, model never built, nothing recorded', async () => {
    const d = deps({ effective: async () => ({ settings: { vizModel: '[[Nope]]' } as never, catalog: CATALOG }) });
    const got = await makeBoardInterpreter(d)('x');
    expect(got).toMatchObject({
      ok: false,
      error: expect.stringContaining('not in the model catalog'),
    });
    if (!got.ok) expect(got.error).toContain('[[Nope]]');
    expect(d.recordUsage).not.toHaveBeenCalled();
  });

  it('resolvable model but missing provider key → distinct API-key error naming the provider', async () => {
    const d = deps({ keys: {} });
    const got = await makeBoardInterpreter(d)('x');
    expect(got).toMatchObject({
      ok: false,
      error: expect.stringContaining('needs a fireworks API key'),
    });
    expect(d.recordUsage).not.toHaveBeenCalled();
  });

  it('an unexpected throw (e.g. effective() rejecting) → ok:false, never rejects (belt-and-braces outer catch)', async () => {
    const d = deps({ effective: async () => { throw new Error('settings blew up'); } });
    const interpret = makeBoardInterpreter(d);
    await expect(interpret('x')).resolves.toMatchObject({ ok: false, error: expect.stringContaining('settings blew up') });
    expect(d.recordUsage).not.toHaveBeenCalled();
  });

  it('caches the vocabulary across calls, and drops the cache on fetch failure', async () => {
    const d = deps();
    const interpret = makeBoardInterpreter(d);
    await interpret('a');
    await interpret('b');
    const listSchemasCalls = (d.engineCall as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'list-schemas');
    expect(listSchemasCalls).toHaveLength(1);

    const failing = deps({ engineCall: vi.fn(async () => env({ ok: false, error: { code: 'X', message: 'down' }, warnings: [] })) });
    const i2 = makeBoardInterpreter(failing);
    expect((await i2('x')).ok).toBe(false);
    await i2('y'); // second call re-attempts the fetch (cache dropped on rejection)
    const retries = (failing.engineCall as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'list-schemas');
    expect(retries).toHaveLength(2);
  });
});
