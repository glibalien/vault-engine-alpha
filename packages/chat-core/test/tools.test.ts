import { describe, expect, it, vi } from 'vitest';
import { parseEnvelope, wrapEngineTools, mergeToolSets, type EngineToolInfo } from '../src/tools.js';

type Executable = { execute: (input: unknown, opts: unknown) => Promise<unknown> };

const TOOLS: EngineToolInfo[] = [
  { name: 'query-nodes', description: 'Query nodes', inputSchema: { type: 'object', properties: { types: { type: 'array', items: { type: 'string' } } } } },
  { name: 'get-node', description: undefined, inputSchema: { type: 'object' } },
];

describe('parseEnvelope', () => {
  it('parses the text envelope', () => {
    const env = parseEnvelope({ content: [{ type: 'text', text: '{"ok":true,"data":{"total":1},"warnings":[]}' }] });
    expect(env).toEqual({ ok: true, data: { total: 1 }, warnings: [] });
  });
  it('returns a BAD_JSON envelope on non-JSON text', () => {
    const env = parseEnvelope({ content: [{ type: 'text', text: 'nope' }] }) as { ok: boolean; error: { code: string } };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('BAD_JSON');
  });
  it('returns an EMPTY_RESULT envelope when no text content', () => {
    const env = parseEnvelope({ content: [] }) as { ok: boolean; error: { code: string } };
    expect(env.error.code).toBe('EMPTY_RESULT');
  });
});

describe('wrapEngineTools', () => {
  it('wraps every tool and executes through the caller, stamping _ms', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const set = wrapEngineTools(TOOLS, async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: '{"ok":true,"data":{"nodes":[]},"warnings":[]}' }] };
    });
    expect(Object.keys(set)).toEqual(['query-nodes', 'get-node']);
    const tool = set['query-nodes'] as never as Executable;
    const out = (await tool.execute({ types: ['task'] }, {})) as { ok: boolean; _ms: number };
    expect(out.ok).toBe(true);
    expect(typeof out._ms).toBe('number');
    expect(calls).toEqual([{ name: 'query-nodes', args: { types: ['task'] } }]);
  });

  it('surfaces caller failures as a failed envelope instead of throwing', async () => {
    const set = wrapEngineTools(TOOLS, async () => { throw new Error('engine down'); });
    const tool = set['get-node'] as never as Executable;
    const out = (await tool.execute({}, {})) as { ok: boolean; error: { code: string; message: string } };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('TOOL_CALL_FAILED');
    expect(out.error.message).toMatch(/engine down/);
  });
});

describe('mergeToolSets', () => {
  // mergeToolSets only does key bookkeeping + identity, so a minimal stand-in is fine.
  const tool = (id: string) => ({ description: id }) as never;

  it('merges disjoint sets', () => {
    const merged = mergeToolSets({ a: tool('a') }, { b: tool('b') });
    expect(Object.keys(merged).sort()).toEqual(['a', 'b']);
  });

  it('keeps the FIRST definition on collision (engine wins) and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engineTool = tool('engine');
    const merged = mergeToolSets({ dup: engineTool }, { dup: tool('curator') });
    expect(merged.dup).toBe(engineTool);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dup'));
    warn.mockRestore();
  });
});
