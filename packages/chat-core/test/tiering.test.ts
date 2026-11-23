import { describe, expect, it } from 'vitest';
import type { ToolSet } from 'ai';
import {
  createToolTiering, CORE_TOOL_NAMES, LOAD_TOOLS_NAME, LEDGER_INTERNAL_TOOL_NAMES, CONVERSATION_STORE_TOOL_NAMES,
} from '../src/tiering.js';

// Tiering only reads names + descriptions at construction, so bare stubs suffice.
const stub = (description: string) => ({ description }) as never;

function sampleTools(): ToolSet {
  return {
    'query-nodes': stub('Search and query nodes across the vault: semantic search, full-text search, and filters. Returns paginated results.'),
    'update-node': stub('Update a node, or bulk-update nodes via query-mode.'),
    'vault-doctor': stub('Run integrity checks over the vault database. Reports orphans and invariant violations.'),
    'update-schema': stub('Update a schema definition.'),
    'present-viz': stub('Render an interactive viz card.'),
  };
}

describe('createToolTiering — partition', () => {
  it('splits tools into core (∩ available) and deferred (rest)', () => {
    const t = createToolTiering(sampleTools(), { core: CORE_TOOL_NAMES });
    expect(t.coreNames.sort()).toEqual(['present-viz', 'query-nodes', 'update-node']);
    expect(t.deferredNames.sort()).toEqual(['update-schema', 'vault-doctor']);
  });

  it('ignores core names missing from the set (e.g. curator not connected)', () => {
    const t = createToolTiering(sampleTools(), { core: ['query-nodes', 'curate-project-wiki'] });
    expect(t.coreNames).toEqual(['query-nodes']);
    expect(t.deferredNames).not.toContain('curate-project-wiki');
  });

  it('defaults opts.core to CORE_TOOL_NAMES', () => {
    const t = createToolTiering(sampleTools());
    expect(t.coreNames).toContain('query-nodes');
    expect(t.deferredNames).toContain('vault-doctor');
  });
});

describe('createToolTiering — index', () => {
  it('lists every deferred tool with a first-sentence one-liner, and no core tools', () => {
    const t = createToolTiering(sampleTools(), { core: CORE_TOOL_NAMES });
    const lines = t.index.split('\n');
    expect(lines).toContain('- vault-doctor — Run integrity checks over the vault database');
    expect(lines).toContain('- update-schema — Update a schema definition');
    expect(t.index).not.toContain('Reports orphans'); // second sentence dropped
    expect(t.index).not.toContain('- query-nodes'); // core tools are not in the index
  });

  it('truncates one-liners to 90 chars with an ellipsis', () => {
    const long = 'A'.repeat(200);
    const t = createToolTiering({ 'x-long': stub(long), 'query-nodes': stub('q') } as ToolSet);
    const line = t.index.split('\n').find((l) => l.startsWith('- x-long'))!;
    expect(line.length).toBeLessThanOrEqual('- x-long — '.length + 90);
    expect(line.endsWith('…')).toBe(true);
  });

  it('tolerates a missing description', () => {
    const t = createToolTiering({ 'no-desc': {} as never, 'query-nodes': stub('q') } as ToolSet);
    expect(t.index).toContain('- no-desc —');
  });
});

describe('createToolTiering — collision guard', () => {
  it('throws at construction if a tool is already named load-vault-tools', () => {
    expect(() => createToolTiering({ [LOAD_TOOLS_NAME]: stub('impostor') } as ToolSet)).toThrow(/load-vault-tools/);
  });
});

import type { UIMessage } from 'ai';

type Executable = { execute: (input: unknown, opts: unknown) => Promise<unknown> };
const exec = (tools: ToolSet, name: string, input: unknown) =>
  (tools[name] as never as Executable).execute(input, {});
const active = async (r: ReturnType<ReturnType<typeof createToolTiering>['forRequest']>) =>
  ((await r.prepareStep({ steps: [], stepNumber: 0, model: {} as never, messages: [] }))?.activeTools ?? []) as string[];

describe('createToolTiering — ledger-internal tool exclusion', () => {
  function toolsWithRecordUsage(): ToolSet {
    return {
      ...sampleTools(),
      'record-usage': stub('Record one paid third-party API call into the spend ledger.'),
    };
  }

  it('never places record-usage in core or deferred', () => {
    const t = createToolTiering(toolsWithRecordUsage(), { core: CORE_TOOL_NAMES });
    expect(t.coreNames).not.toContain('record-usage');
    expect(t.deferredNames).not.toContain('record-usage');
  });

  it('omits record-usage from the load-vault-tools index', () => {
    const t = createToolTiering(toolsWithRecordUsage(), { core: CORE_TOOL_NAMES });
    expect(t.index).not.toContain('record-usage');
  });

  it('excludes record-usage from the request-scoped tool set entirely', () => {
    const t = createToolTiering(toolsWithRecordUsage(), { core: CORE_TOOL_NAMES });
    const r = t.forRequest([]);
    expect(Object.keys(r.tools)).not.toContain('record-usage');
  });

  it('cannot be loaded via load-vault-tools even by exact name', async () => {
    const t = createToolTiering(toolsWithRecordUsage(), { core: CORE_TOOL_NAMES });
    const r = t.forRequest([]);
    const out = await exec(r.tools, LOAD_TOOLS_NAME, { names: ['record-usage'] });
    expect(out).toEqual({ ok: true, loaded: [], unknown: ['record-usage'], warnings: [] });
    expect(r.loaded()).toEqual([]);
    expect(await active(r)).not.toContain('record-usage');
  });

  it('LEDGER_INTERNAL_TOOL_NAMES includes record-usage', () => {
    expect(LEDGER_INTERNAL_TOOL_NAMES).toContain('record-usage');
  });
});

describe('createToolTiering — conversation store tools', () => {
  const READ_TOOLS = ['list-conversations', 'get-conversation'];

  function toolsWithConversationStore(): ToolSet {
    return {
      ...sampleTools(),
      ...Object.fromEntries([...CONVERSATION_STORE_TOOL_NAMES, ...READ_TOOLS].map((name) => [name, stub(`${name} tool`)])),
    };
  }

  it('names the five tools that write the conversation store', () => {
    expect([...CONVERSATION_STORE_TOOL_NAMES].sort()).toEqual([
      'archive-conversation', 'delete-conversation', 'link-conversation', 'save-conversation', 'set-conversation-state',
    ]);
  });

  it('keeps them out of both tiers, the index and the request tool set', () => {
    const t = createToolTiering(toolsWithConversationStore(), { core: CORE_TOOL_NAMES });
    const r = t.forRequest([]);
    for (const name of CONVERSATION_STORE_TOOL_NAMES) {
      expect(t.coreNames, name).not.toContain(name);
      expect(t.deferredNames, name).not.toContain(name);
      expect(t.index, name).not.toContain(name);
      expect(Object.keys(r.tools), name).not.toContain(name);
    }
  });

  it('cannot be loaded by exact name, not even when history claims they were', async () => {
    const t = createToolTiering(toolsWithConversationStore(), { core: CORE_TOOL_NAMES });
    const claimed = [{
      id: 'a1', role: 'assistant',
      parts: [{ type: 'dynamic-tool', toolName: LOAD_TOOLS_NAME, toolCallId: 'c1', state: 'output-available', input: {}, output: { ok: true, loaded: ['save-conversation'] } }],
    }] as never;
    const r = t.forRequest(claimed);
    expect(r.loaded()).toEqual([]);
    const out = await exec(r.tools, LOAD_TOOLS_NAME, { names: ['save-conversation', 'delete-conversation'] });
    expect(out).toEqual({ ok: true, loaded: [], unknown: ['save-conversation', 'delete-conversation'], warnings: [] });
    expect(await active(r)).not.toContain('save-conversation');
  });

  it('leaves the tools that only read conversations loadable', async () => {
    const t = createToolTiering(toolsWithConversationStore(), { core: CORE_TOOL_NAMES });
    for (const name of READ_TOOLS) expect(t.deferredNames).toContain(name);
    const r = t.forRequest([]);
    const out = await exec(r.tools, LOAD_TOOLS_NAME, { names: READ_TOOLS });
    expect(out).toEqual({ ok: true, loaded: READ_TOOLS, unknown: [], warnings: [] });
  });
});

describe('forRequest — meta-tool + activeTools', () => {
  it('starts with core + meta only; loading a deferred tool activates it next step', async () => {
    const t = createToolTiering(sampleTools(), { core: CORE_TOOL_NAMES });
    const r = t.forRequest([]);
    expect((await active(r)).sort()).toEqual([LOAD_TOOLS_NAME, 'present-viz', 'query-nodes', 'update-node']);

    const out = await exec(r.tools, LOAD_TOOLS_NAME, { names: ['vault-doctor'] });
    expect(out).toEqual({ ok: true, loaded: ['vault-doctor'], unknown: [], warnings: [] });
    expect(await active(r)).toContain('vault-doctor');
    expect(await active(r)).not.toContain('update-schema');
    expect(r.loaded()).toEqual(['vault-doctor']);
  });

  it('reports unknown names without loading, and treats core names as already loaded', async () => {
    const t = createToolTiering(sampleTools(), { core: CORE_TOOL_NAMES });
    const r = t.forRequest([]);
    const out = await exec(r.tools, LOAD_TOOLS_NAME, { names: ['nope', 'query-nodes', 'update-schema'] });
    expect(out).toEqual({ ok: true, loaded: ['query-nodes', 'update-schema'], unknown: ['nope'], warnings: [] });
    expect(r.loaded()).toEqual(['update-schema']); // core name not duplicated into loaded state
  });

  it('dedupes repeated names in a single call', async () => {
    const t = createToolTiering(sampleTools(), { core: CORE_TOOL_NAMES });
    const r = t.forRequest([]);
    const out = await exec(r.tools, LOAD_TOOLS_NAME, { names: ['vault-doctor', 'vault-doctor'] });
    expect(out).toEqual({ ok: true, loaded: ['vault-doctor'], unknown: [], warnings: [] });
    expect(r.loaded()).toEqual(['vault-doctor']);
  });

  it('tolerates malformed input', async () => {
    const t = createToolTiering(sampleTools());
    const r = t.forRequest([]);
    expect(await exec(r.tools, LOAD_TOOLS_NAME, {})).toEqual({ ok: true, loaded: [], unknown: [], warnings: [] });
    expect(await exec(r.tools, LOAD_TOOLS_NAME, { names: [42, null] })).toEqual({ ok: true, loaded: [], unknown: [], warnings: [] });
  });

  it('keeps every execute handler registered even while inactive', () => {
    const t = createToolTiering(sampleTools());
    const r = t.forRequest([]);
    expect(Object.keys(r.tools).sort()).toEqual(
      [...Object.keys(sampleTools()), LOAD_TOOLS_NAME].sort(),
    );
  });

  it('isolates state between requests', async () => {
    const t = createToolTiering(sampleTools());
    const r1 = t.forRequest([]);
    await exec(r1.tools, LOAD_TOOLS_NAME, { names: ['vault-doctor'] });
    const r2 = t.forRequest([]);
    expect(r2.loaded()).toEqual([]);
    expect(await active(r2)).not.toContain('vault-doctor');
  });
});

describe('forRequest — seeding from history', () => {
  const loadPart = (loaded: string[]): UIMessage => ({
    id: 'a1',
    role: 'assistant',
    parts: [{
      type: 'dynamic-tool', toolName: LOAD_TOOLS_NAME, toolCallId: 'c1',
      state: 'output-available', input: { names: loaded }, output: { ok: true, loaded, unknown: [] },
    }],
  }) as never;

  it('re-activates tools loaded earlier in the conversation', async () => {
    const t = createToolTiering(sampleTools());
    const r = t.forRequest([loadPart(['vault-doctor'])]);
    expect(r.loaded()).toEqual(['vault-doctor']);
    expect(await active(r)).toContain('vault-doctor');
  });

  it('seeds from the result loaded array, ignoring names now unknown', async () => {
    const t = createToolTiering(sampleTools());
    const r = t.forRequest([loadPart(['vault-doctor', 'gone-tool'])]);
    expect(r.loaded()).toEqual(['vault-doctor']); // 'gone-tool' no longer exists → dropped
  });

  it('ignores incomplete calls and other tools', () => {
    const t = createToolTiering(sampleTools());
    const messages = [
      { id: 'a2', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: LOAD_TOOLS_NAME, toolCallId: 'c2', state: 'input-available', input: { names: ['vault-doctor'] } }] },
      { id: 'a3', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'query-nodes', toolCallId: 'c3', state: 'output-available', input: {}, output: { ok: true, loaded: ['update-schema'] } }] },
    ] as never;
    const r = t.forRequest(messages as UIMessage[]);
    expect(r.loaded()).toEqual([]);
  });
});
