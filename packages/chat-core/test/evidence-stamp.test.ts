import { describe, expect, it } from 'vitest';
import { wrapEngineTools, type EngineToolInfo } from '../src/tools.js';
import { CHAT_MODEL_META_KEY, stampMemoryEvidence } from '../src/evidence-stamp.js';

type Executable = { execute: (input: unknown, opts: unknown) => Promise<unknown> };

const TOOLS: EngineToolInfo[] = [
  { name: 'create-memory', description: 'c', inputSchema: { type: 'object' } },
  { name: 'update-memory', description: 'u', inputSchema: { type: 'object' } },
  { name: 'query-nodes', description: 'q', inputSchema: { type: 'object' } },
];

function harness() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const base = wrapEngineTools(TOOLS, async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: 'text', text: '{"ok":true,"data":{"id":1},"warnings":[]}' }] };
  });
  const stamped = stampMemoryEvidence(base, { conversationId: 'conv-1', messageIndex: 4 });
  return { calls, base, stamped };
}

describe('CHAT_MODEL_META_KEY', () => {
  it('is the key the Engine reads (CHAT_MODEL_META_KEY in its src/auth/client-label.ts)', () => {
    expect(CHAT_MODEL_META_KEY).toBe('vault-engine/chat-model');
  });
});

describe('stampMemoryEvidence', () => {
  it('OVERWRITES model-supplied evidence on create-memory (anti-confabulation, spec E2E smoke)', async () => {
    const { calls, stamped } = harness();
    await (stamped['create-memory'] as never as Executable).execute(
      { source: 'chat', content: 'fact', evidence: { kind: 'note', node_id: 'nX', hash: 'hX' } },
      {},
    );
    expect(calls[0]?.args.evidence).toEqual({ kind: 'conversation', ref: 'conv-1#4' });
    expect(calls[0]?.args.content).toBe('fact'); // other args untouched
  });

  it('stamps create-memory when the model supplied no evidence', async () => {
    const { calls, stamped } = harness();
    await (stamped['create-memory'] as never as Executable).execute({ source: 'chat', content: 'fact' }, {});
    expect(calls[0]?.args.evidence).toEqual({ kind: 'conversation', ref: 'conv-1#4' });
  });

  it('stamps update-memory only when content is present; strips evidence otherwise', async () => {
    const { calls, stamped } = harness();
    const update = stamped['update-memory'] as never as Executable;
    await update.execute({ id: 3, content: 'new text', evidence: { kind: 'note', node_id: 'n', hash: 'h' } }, {});
    expect(calls[0]?.args.evidence).toEqual({ kind: 'conversation', ref: 'conv-1#4' });
    await update.execute({ id: 3, category: 'preference', evidence: { kind: 'conversation', ref: 'fake#9' } }, {});
    expect(calls[1]?.args).toEqual({ id: 3, category: 'preference' }); // stripped, not stamped
  });

  it('leaves non-memory tools untouched by reference and tolerates absent memory tools', () => {
    const { base, stamped } = harness();
    expect(stamped['query-nodes']).toBe(base['query-nodes']);
    const none = wrapEngineTools([TOOLS[2]!], async () => ({ content: [] }));
    expect(() => stampMemoryEvidence(none, { conversationId: 'c', messageIndex: 0 })).not.toThrow();
  });

  it('attributes create-memory spend to the chat service and conversation, dropping model-supplied usage (#298)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const base = wrapEngineTools(TOOLS, async (_name, args) => {
      calls.push(args);
      return { content: [{ type: 'text', text: '{"ok":true,"data":{"id":1},"warnings":[]}' }] };
    });
    const stamped = stampMemoryEvidence(base, { conversationId: 'conv-1', messageIndex: 4, service: 'chat-plugin' });
    await (stamped['create-memory'] as never as Executable).execute({ source: 'chat', content: 'fact', usage: { service: 'curator' } }, {});
    expect(calls[0]?.usage).toEqual({ service: 'chat-plugin', conversation_id: 'conv-1' });
    await (stamped['update-memory'] as never as Executable).execute({ id: 3, content: 'x', usage: { service: 'curator' } }, {});
    expect(calls[1]).not.toHaveProperty('usage');
    const { calls: unattributed, stamped: noService } = harness();
    await (noService['create-memory'] as never as Executable).execute({ source: 'chat', content: 'fact', usage: { service: 'curator' } }, {});
    expect(unattributed[0]?.args).not.toHaveProperty('usage');
  });

  it('tolerates a null/undefined input object', async () => {
    const { calls, stamped } = harness();
    await (stamped['create-memory'] as never as Executable).execute(undefined, {});
    expect(calls[0]?.args.evidence).toEqual({ kind: 'conversation', ref: 'conv-1#4' });
  });
});
