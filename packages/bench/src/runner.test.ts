import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { UIMessage } from 'ai';
import { SYSTEM_PROMPT, TIERING_SYSTEM_NOTE, LOAD_TOOLS_NAME } from '@vault/chat-core';
import type { Envelope } from '@vault/contract';
import { CHAT_DESCRIPTORS, type ModelCatalogEntry } from '@vault/settings-registry';
import type { BenchEngineClient } from './engine-client.js';
import type { CorpusTurn } from './corpus.js';
import type { SandboxPaths } from './sandbox.js';
import { runReplayTurn, scoreCalls, toEngineToolInfos, type TurnResult } from './runner.js';

// ---------------------------------------------------------------- fixtures

/** The engine tool surface the stub advertises. Small on purpose: one core
 *  read, one core write, one deferred read (so tiering has something to defer),
 *  and record-usage — the internal write-path tool createToolTiering must strip
 *  before the model ever sees it. */
const STUB_TOOLS = [
  { name: 'query-nodes', description: 'Query vault nodes.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get-node', description: 'Fetch one node.', inputSchema: { type: 'object', properties: {} } },
  { name: 'update-node', description: 'Update a node.', inputSchema: { type: 'object', properties: {} } },
  { name: 'vault-doctor', description: 'Integrity checks.', inputSchema: { type: 'object', properties: {} } },
  { name: 'record-usage', description: 'Record a spend event.', inputSchema: { type: 'object', properties: {} } },
];

/** The chat domain's real maxSteps default, read from the registry itself. */
const REGISTRY_MAX_STEPS = CHAT_DESCRIPTORS.find((d) => d.key === 'maxSteps')!.default as number;

const OK_QUERY: Envelope<unknown> = { ok: true, data: { nodes: [{ id: 'n1', title: 'Alpha' }], total: 1 }, warnings: [] };
const OK_EMPTY_MEMORIES: Envelope<unknown> = { ok: true, data: { memories: [] }, warnings: [] };

type Handler = (args: Record<string, unknown>) => Envelope<unknown>;

function makeStubClient(handlers: Record<string, Handler> = {}): {
  client: BenchEngineClient;
  calls: { name: string; args: Record<string, unknown> }[];
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const all: Record<string, Handler> = {
    'list-memories': () => OK_EMPTY_MEMORIES,
    'query-nodes': () => OK_QUERY,
    ...handlers,
  };
  const client: BenchEngineClient = {
    async callToolEnvelope(name, args) {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ name, args: a });
      const h = all[name];
      if (!h) return { ok: false, error: { code: 'NOT_FOUND', message: `stub: no handler for ${name}` }, warnings: [] };
      return h(a);
    },
    async listTools() {
      return STUB_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    },
    async modelCatalog() {
      return [];
    },
    async close() {
      /* no transport to close */
    },
  };
  return { client, calls };
}

function turnFixture(overrides: Partial<CorpusTurn> = {}): CorpusTurn {
  return {
    conversationId: 'conv-1',
    seq: 1,
    turnClass: 'single-read',
    history: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'what is open?' }] }] as UIMessage[],
    recordedCalls: [{ toolName: 'query-nodes', state: 'output-available' }],
    partial: false,
    unknownTools: [],
    modelRef: null,
    contextState: { doc: true, board: true, nodes: [] },
    conversationUpdatedAt: '2026-07-15T10:00:00.000Z',
    ...overrides,
  };
}

const ENTRY: ModelCatalogEntry = {
  title: 'Test Model',
  provider: 'fireworks',
  model: 'accounts/fireworks/models/qwen3p7-plus',
  enabled: true,
};

const USAGE_PRESENT = {
  inputTokens: { total: 100, noCache: 70, cacheRead: 30, cacheWrite: 10 },
  outputTokens: { total: 20, text: 20 },
};

const USAGE_ABSENT = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/** Structural stand-in for LanguageModelV4StreamPart — @ai-sdk/provider is a
 *  transitive dep, not one this package declares, so it is not imported here. */
type StreamPart = { type: string; [k: string]: unknown };

/** The mock's `doStream` return shape, with the part-type widening kept in one place. */
function partStream(parts: StreamPart[]): ReadableStream<never> {
  return convertArrayToReadableStream(parts as never[]);
}

function textStep(usage: unknown = USAGE_PRESENT): StreamPart[] {
  return [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: 'done' },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: 'stop', usage },
  ];
}

function toolStep(toolName: string, input: string, id: string, usage: unknown = USAGE_PRESENT): StreamPart[] {
  return [
    { type: 'tool-call', toolCallId: id, toolName, input },
    { type: 'finish', finishReason: 'tool-calls', usage },
  ];
}

/** A model that plays the given scripted steps in order, one per doStream call. */
function scriptedModel(steps: StreamPart[][]): { model: MockLanguageModelV4; systems: string[]; attempts: () => number } {
  const systems: string[] = [];
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const sys = (options.prompt as Array<{ role: string; content: unknown }>).find((m) => m.role === 'system');
      if (sys) systems.push(typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content));
      const step = steps[Math.min(call, steps.length - 1)];
      call += 1;
      return { stream: partStream(step ?? textStep()) };
    },
  });
  return { model, systems, attempts: () => call };
}

let paths: SandboxPaths;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'bench-runner-test-'));
  const vaultPath = join(root, 'vault');
  mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
  paths = { root, vaultPath, dbPath: join(vaultPath, '.vault-engine', 'vault.db') };
});

afterAll(() => {
  rmSync(paths.root, { recursive: true, force: true });
});

async function run(opts: {
  steps: StreamPart[][];
  handlers?: Record<string, Handler>;
  turn?: Partial<CorpusTurn>;
  entry?: ModelCatalogEntry;
  chatSettings?: { systemPrompt: string | null; tieringNote: string | null; maxSteps: number | null };
  model?: MockLanguageModelV4;
  timeoutMs?: number;
}): Promise<{ result: TurnResult; calls: { name: string; args: Record<string, unknown> }[]; systems: string[]; attempts: () => number }> {
  const { client, calls } = makeStubClient(opts.handlers);
  const scripted = scriptedModel(opts.steps);
  const model = opts.model ?? scripted.model;
  const result = await runReplayTurn({
    turn: turnFixture(opts.turn),
    modelEntry: opts.entry ?? ENTRY,
    keys: { fireworks: 'test-key' },
    client,
    toolInfos: toEngineToolInfos(await client.listTools()),
    chatSettings: opts.chatSettings ?? { systemPrompt: null, tieringNote: null, maxSteps: null },
    paths,
    makeModel: () => model,
    sleep: async () => {
      /* no real backoff in tests */
    },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return { result, calls, systems: scripted.systems, attempts: scripted.attempts };
}

// ------------------------------------------------------------------- tests

describe('scoreCalls (order-independent aggregate)', () => {
  it('is FAIL when any read verdict is FAIL, wherever it sits', () => {
    const fail = { kind: 'read', verdict: 'FAIL', envelope: OK_QUERY } as const;
    const pass = { kind: 'read', verdict: 'PASS', envelope: OK_QUERY } as const;
    expect(scoreCalls([fail, pass])).toBe('FAIL');
    expect(scoreCalls([pass, fail])).toBe('FAIL');
  });

  it('is FAIL when any dry-run verdict is INVALID', () => {
    expect(
      scoreCalls([
        { kind: 'read', verdict: 'PASS', envelope: OK_QUERY },
        { kind: 'write-validated', verdict: 'INVALID', envelope: OK_QUERY },
      ]),
    ).toBe('FAIL');
  });

  it('is WEAK when any verdict is WEAK and none FAIL/INVALID', () => {
    expect(
      scoreCalls([
        { kind: 'read', verdict: 'PASS', envelope: OK_QUERY },
        { kind: 'read', verdict: 'WEAK', envelope: OK_QUERY },
      ]),
    ).toBe('WEAK');
  });

  it('is PASS for no calls, and for coverage-only kinds', () => {
    expect(scoreCalls([])).toBe('PASS');
    expect(scoreCalls([{ kind: 'write-unvalidatable' }, { kind: 'suppressed' }])).toBe('PASS');
  });
});

describe('runReplayTurn — scripted single read', () => {
  it('scores PASS, records latency, and reports emitted vs recorded call counts', async () => {
    const { result, calls } = await run({
      steps: [toolStep('query-nodes', '{"limit":5}', 'c1'), textStep()],
    });

    expect(result.outcome).toBe('PASS');
    expect(result.conversationId).toBe('conv-1');
    expect(result.seq).toBe(1);
    expect(result.turnClass).toBe('single-read');
    expect(result.calls).toEqual([{ kind: 'read', verdict: 'PASS', envelope: OK_QUERY }]);
    expect(result.truncatedAtWrite).toBe(false);
    expect(result.unvalidatable).toBe(0);
    expect(result.emittedCallCount).toBe(1);
    expect(result.recordedCallCount).toBe(1);
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
    // the model's query-nodes reached the sandboxed engine verbatim (no dry_run smuggled in)
    expect(calls.filter((c) => c.name === 'query-nodes')).toEqual([{ name: 'query-nodes', args: { limit: 5 } }]);
  });

  it('assembles the production system prompt: base + tiering note + date line + working context', async () => {
    const { systems, calls } = await run({
      steps: [toolStep('query-nodes', '{}', 'c1'), textStep()],
      handlers: { 'list-memories': () => ({ ok: true, data: { memories: [{ id: 1, content: 'Avery prefers terse replies', category: 'preference', scope: 'vault', node_id: null, created_at: '2026-07-01T00:00:00.000Z' }] }, warnings: [] }) },
    });

    expect(systems.length).toBeGreaterThan(0);
    const system = systems[0]!;
    expect(system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(system).toContain(TIERING_SYSTEM_NOTE.trim());
    // rule 2: the date line comes from conversationUpdatedAt, not replay-day
    expect(system).toContain('2026-07-15');
    expect(system).toContain('## Working context');
    expect(system).toContain('Avery prefers terse replies');
    // context assembly runs host-side against the sandbox, exactly as production does
    expect(calls.some((c) => c.name === 'list-memories')).toBe(true);
  });

  it("assembles context from the conversation's persisted client_state, not from defaults", async () => {
    const { systems, calls } = await run({
      turn: { contextState: { doc: true, board: true, nodes: ['pinned-1'], activeBoardId: 'board-42' } },
      steps: [textStep()],
      handlers: {
        'get-board': () => ({
          ok: true,
          // `query` is required — chat-core's vizArgs reads spec.query.limit unguarded
          data: { cards: [{ spec: { kind: 'table', title: 'Sprint', query: { types: ['task'] }, display_fields: ['title'] } }] },
          warnings: [],
        }),
        'query-nodes': () => ({ ok: true, data: { nodes: [{ title: 'Ship the runner' }], total: 1 }, warnings: [] }),
        'get-node': () => ({ ok: true, data: { title: 'Pinned Note', types: ['project'], body: 'pinned body text' }, warnings: [] }),
      },
    });

    const system = systems[0]!;
    // nodesProvider fired off the persisted pinned-node ids
    expect(calls.some((c) => c.name === 'get-node' && c.args['node_id'] === 'pinned-1')).toBe(true);
    expect(system).toContain('### Pinned nodes');
    expect(system).toContain('Pinned Note');
    // boardProvider fired off the persisted board choice
    expect(calls.some((c) => c.name === 'get-board' && c.args['id'] === 'board-42')).toBe(true);
    expect(system).toContain('### Board');
    expect(system).toContain('Ship the runner');
  });

  it('honours chat-domain settings overrides for the system prompt and tiering note', async () => {
    const { systems } = await run({
      steps: [textStep()],
      chatSettings: { systemPrompt: 'CUSTOM BASE', tieringNote: '\n\nCUSTOM TIERING', maxSteps: null },
    });
    expect(systems[0]!.startsWith('CUSTOM BASE\n\nCUSTOM TIERING')).toBe(true);
  });

  it('offers the production tool surface: core tools + load-vault-tools, deferred hidden', async () => {
    const offered: string[][] = [];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        offered.push(((options.tools ?? []) as Array<{ name: string }>).map((t) => t.name));
        return { stream: partStream(textStep()) };
      },
    });
    await run({ steps: [textStep()], model });

    expect(offered).toHaveLength(1);
    const names = offered[0]!;
    expect(names).toContain('query-nodes');
    expect(names).toContain('update-node');
    expect(names).toContain('present-viz');
    expect(names).toContain(LOAD_TOOLS_NAME);
    expect(names).not.toContain('vault-doctor'); // deferred until loaded
    // record-usage is an internal write-path tool: createToolTiering strips it
    // from both tiers, so it can never be offered nor loaded on demand.
    expect(names).not.toContain('record-usage');
  });

  it('never exposes record-usage, even after load-vault-tools is asked for it', async () => {
    const offered: string[][] = [];
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        offered.push(((options.tools ?? []) as Array<{ name: string }>).map((t) => t.name));
        call += 1;
        if (call === 1) {
          return { stream: partStream(toolStep(LOAD_TOOLS_NAME, '{"names":["record-usage"]}', 'l1')) };
        }
        return { stream: partStream(textStep()) };
      },
    });
    await run({ steps: [textStep()], model });

    // guard against this test going vacuous if the stub surface is ever trimmed
    expect(STUB_TOOLS.map((t) => t.name)).toContain('record-usage');
    expect(offered).toHaveLength(2);
    expect(offered[0]).not.toContain('record-usage');
    expect(offered[1]).not.toContain('record-usage'); // "loading" it is a no-op — it is not a deferred tool
  });
});

describe('runReplayTurn — step budget', () => {
  /** A model that never stops calling a read tool, so the step cap is what ends the loop. */
  function loopingModel(): { model: MockLanguageModelV4; steps: () => number } {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        return { stream: partStream(toolStep('query-nodes', '{}', `c${call}`)) };
      },
    });
    return { model, steps: () => call };
  }

  it('honours the chat domain maxSteps setting rather than a hardcoded constant', async () => {
    const { model, steps } = loopingModel();
    await run({ steps: [textStep()], model, chatSettings: { systemPrompt: null, tieringNote: null, maxSteps: 2 } });
    expect(steps()).toBe(2);
  });

  it('falls back to the settings-registry default (10), not to a bench-local number', async () => {
    expect(REGISTRY_MAX_STEPS).toBe(10); // pin: if the registry default moves, this test tells us
    const { model, steps } = loopingModel();
    await run({ steps: [textStep()], model, chatSettings: { systemPrompt: null, tieringNote: null, maxSteps: null } });
    expect(steps()).toBe(REGISTRY_MAX_STEPS);
  });
});

describe('runReplayTurn — per-turn timeout', () => {
  it('returns outcome ERROR naming the timeout when the provider never settles', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: () => {
        call += 1;
        return new Promise(() => {
          /* never settles — a hung provider */
        });
      },
    });
    const { result } = await run({ steps: [textStep()], model, timeoutMs: 25 });

    expect(result.outcome).toBe('ERROR');
    expect(result.error).toMatch(/timed out/i);
    expect(result.error).toContain('25');
    expect(result.usage).toBeNull();
    expect(result.costUsd).toBeNull();
    // a timeout is terminal, not retried: retrying a hang would triple the stall
    // this timeout exists to prevent.
    expect(call).toBe(1);
  });

  it('does not time out a turn that finishes inside the budget', async () => {
    const { result } = await run({ steps: [toolStep('query-nodes', '{}', 'c1'), textStep()], timeoutMs: 10_000 });
    expect(result.outcome).toBe('PASS');
  });
});

describe('runReplayTurn — write interception', () => {
  it('dry-run validates the first write, latches, and suppresses everything after it', async () => {
    const { result, calls } = await run({
      turn: { turnClass: 'single-write', recordedCalls: [{ toolName: 'update-node', state: 'output-available' }] },
      steps: [
        toolStep('update-node', '{"node_id":"n1","set":{"status":"done"}}', 'w1'),
        toolStep('query-nodes', '{}', 'c2'),
        textStep(),
      ],
      handlers: { 'update-node': () => ({ ok: true, data: { changed: 1 }, warnings: [] }) },
    });

    expect(result.truncatedAtWrite).toBe(true);
    expect(result.outcome).toBe('PASS'); // dryRunVerdict VALID
    expect(result.calls.map((c) => c.kind).sort()).toEqual(['suppressed', 'write-validated']);
    expect(result.emittedCallCount).toBe(2);
    // the write went to the engine with dry_run forced on; the post-write read never did
    expect(calls.find((c) => c.name === 'update-node')?.args).toEqual({ node_id: 'n1', set: { status: 'done' }, dry_run: true });
    expect(calls.some((c) => c.name === 'query-nodes')).toBe(false);
  });

  it('scores FAIL when the dry run reports error-severity warnings', async () => {
    const { result } = await run({
      turn: { turnClass: 'single-write', recordedCalls: [{ toolName: 'update-node', state: 'output-available' }] },
      steps: [toolStep('update-node', '{"node_id":"n1"}', 'w1'), textStep()],
      handlers: {
        'update-node': () => ({ ok: true, data: null, warnings: [{ code: 'VALUE_TYPE_MISMATCH', message: 'nope', severity: 'error' }] }) as Envelope<unknown>,
      },
    });
    expect(result.outcome).toBe('FAIL');
    expect(result.truncatedAtWrite).toBe(true);
  });
});

describe('runReplayTurn — failing reads', () => {
  it('scores FAIL when a read returns ok:false', async () => {
    const { result } = await run({
      steps: [toolStep('get-node', '{"node_id":"nope"}', 'c1'), textStep()],
      handlers: { 'get-node': () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'no such node' }, warnings: [] }) },
    });
    expect(result.outcome).toBe('FAIL');
    expect(result.calls).toEqual([
      { kind: 'read', verdict: 'FAIL', envelope: { ok: false, error: { code: 'NOT_FOUND', message: 'no such node' }, warnings: [] } },
    ]);
  });

  it('scores WEAK when a collection read comes back empty', async () => {
    const { result } = await run({
      steps: [toolStep('query-nodes', '{}', 'c1'), textStep()],
      handlers: { 'query-nodes': () => ({ ok: true, data: { nodes: [], total: 0 }, warnings: [] }) },
    });
    expect(result.outcome).toBe('WEAK');
  });
});

describe('runReplayTurn — retries and ERROR', () => {
  it('retries a failing model twice and succeeds on the third attempt', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        if (call <= 2) throw new Error('boom-transport');
        return { stream: partStream(textStep()) };
      },
    });
    const { result } = await run({ steps: [textStep()], model });
    expect(call).toBe(3);
    expect(result.outcome).toBe('PASS');
    expect(result.error).toBeUndefined();
  });

  it('gives up after three attempts with outcome ERROR and the real provider message', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        throw new Error('boom-transport');
      },
    });
    const { result } = await run({ steps: [textStep()], model });
    expect(call).toBe(3);
    expect(result.outcome).toBe('ERROR');
    expect(result.error).toContain('boom-transport');
    expect(result.usage).toBeNull();
    expect(result.costUsd).toBeNull();
  });

  it('uses the injected backoff delays (2s then 8s)', async () => {
    const slept: number[] = [];
    const { client } = makeStubClient();
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        throw new Error('always');
      },
    });
    const result = await runReplayTurn({
      turn: turnFixture(),
      modelEntry: ENTRY,
      keys: { fireworks: 'k' },
      client,
      toolInfos: toEngineToolInfos(await client.listTools()),
      chatSettings: { systemPrompt: null, tieringNote: null, maxSteps: null },
      paths,
      makeModel: () => model,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(result.outcome).toBe('ERROR');
    expect(slept).toEqual([2000, 8000]);
  });

  it('does not carry call outcomes across retry attempts', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        if (call === 1) return { stream: partStream(toolStep('query-nodes', '{}', 'c1')) };
        if (call === 2) throw new Error('mid-run failure');
        if (call === 3) return { stream: partStream(toolStep('query-nodes', '{}', 'c1')) };
        return { stream: partStream(textStep()) };
      },
    });
    const { result } = await run({ steps: [textStep()], model });
    expect(result.outcome).toBe('PASS');
    expect(result.calls).toHaveLength(1); // attempt 1's outcome was discarded by reset()
  });
});

describe('runReplayTurn — usage and cost', () => {
  it('maps ai@7 nested usage details to TokenUsage and prices it from the catalog entry', async () => {
    const { result } = await run({
      steps: [textStep(USAGE_PRESENT)],
      entry: { ...ENTRY, pricing: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 4 } },
    });
    expect(result.usage).toEqual({ input: 70, output: 20, cacheRead: 30, cacheWrite: 10 });
    // (70*1 + 20*2 + 30*0.5 + 10*4) / 1e6
    expect(result.costUsd).toBeCloseTo((70 * 1 + 20 * 2 + 30 * 0.5 + 10 * 4) / 1_000_000, 12);
  });

  it('reports usage: null and costUsd: null when the provider reports nothing', async () => {
    const { result } = await run({ steps: [textStep(USAGE_ABSENT)] });
    expect(result.usage).toBeNull();
    expect(result.costUsd).toBeNull();
  });

  it('reports costUsd: null (never 0) for a model with no known pricing', async () => {
    const { result } = await run({
      steps: [textStep(USAGE_PRESENT)],
      entry: { title: 'Mystery', provider: 'openrouter', model: 'vendor/never-heard-of-it', enabled: true },
    });
    expect(result.usage).toEqual({ input: 70, output: 20, cacheRead: 30, cacheWrite: 10 });
    expect(result.costUsd).toBeNull();
  });
});

describe('runReplayTurn — sandbox containment guard', () => {
  it('refuses to run against paths outside os.tmpdir()', async () => {
    const { client } = makeStubClient();
    await expect(
      runReplayTurn({
        turn: turnFixture(),
        modelEntry: ENTRY,
        keys: { fireworks: 'k' },
        client,
        toolInfos: toEngineToolInfos(await client.listTools()),
        chatSettings: { systemPrompt: null, tieringNote: null, maxSteps: null },
        paths: { root: '/', vaultPath: '/', dbPath: '/vault.db' },
        makeModel: () => scriptedModel([textStep()]).model,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/containment/i);
  });
});
