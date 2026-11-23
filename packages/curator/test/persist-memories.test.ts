import { describe, expect, it, vi } from 'vitest';
import { persistMemories, persistSweepMemories } from '../src/persist-memories.js';
import { Engine, EngineError } from '../src/engine.js';
import type { MemoryProposal } from '../src/types.js';

const props: MemoryProposal[] = [
  { content: 'Owner prefers terse standups.', category: 'preference' },
  { content: 'Ships on Fridays.', category: 'fact' },
];

/** persistMemories only calls engine.createMemory — a minimal fake suffices. */
function fakeEngine(createMemory: (args: Record<string, unknown>) => Promise<unknown>): Engine {
  return { createMemory } as unknown as Engine;
}

describe('persistMemories', () => {
  it('returns [] and makes no calls when disabled', async () => {
    const spy = vi.fn();
    const out = await persistMemories(fakeEngine(spy), 'home1', props, { enabled: false, cap: 3, dryRun: false, evidence: { runRef: 'run-abc', hash: 'hash-1' } });
    expect(out).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns [] when homeId is null (cannot node-scope)', async () => {
    const spy = vi.fn();
    const out = await persistMemories(fakeEngine(spy), null, props, { enabled: true, cap: 3, dryRun: false, evidence: { runRef: 'run-abc', hash: 'hash-1' } });
    expect(out).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('previews under dry-run with no engine calls', async () => {
    const spy = vi.fn();
    const out = await persistMemories(fakeEngine(spy), 'home1', props, { enabled: true, cap: 3, dryRun: true, evidence: { runRef: 'run-abc', hash: 'hash-1' } });
    expect(out).toEqual([
      { content: 'Owner prefers terse standups.', action: 'preview' },
      { content: 'Ships on Fridays.', action: 'preview' },
    ]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('creates node-scoped curator memories and records created', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const out = await persistMemories(
      fakeEngine(async (a) => { seen.push(a); return { id: 1 }; }),
      'home1', props, { enabled: true, cap: 3, dryRun: false, evidence: { runRef: 'run-abc', hash: 'hash-1' } },
    );
    expect(out.map(o => o.action)).toEqual(['created', 'created']);
    expect(seen[0]).toEqual({
      source: 'curator', scope: 'node', node_id: 'home1',
      content: 'Owner prefers terse standups.', category: 'preference',
      evidence: { kind: 'curation-run', ref: 'run-abc', node_id: 'home1', hash: 'hash-1' },
      usage: { runRef: 'run-abc' },
    });
  });

  it('puts the consolidation call under the run and project, and reports a noop as noop (#298)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const out = await persistMemories(
      fakeEngine(async (a) => { seen.push(a); return { id: 1, operation: seen.length === 1 ? 'noop' : 'contradict' }; }),
      'home1', props, { enabled: true, cap: 3, dryRun: false, evidence: { runRef: 'run-abc', hash: 'hash-1' }, sourceRef: 'Project X' },
    );
    expect(out.map(o => o.action)).toEqual(['noop', 'created']);
    expect(seen[0]?.usage).toEqual({ runRef: 'run-abc', sourceRef: 'Project X' });
  });

  it('classifies a DUPLICATE_MEMORY rejection as duplicate, not error', async () => {
    const out = await persistMemories(
      fakeEngine(async () => { throw new EngineError('DUPLICATE_MEMORY', 'dup'); }),
      'home1', [props[0]!], { enabled: true, cap: 3, dryRun: false, evidence: { runRef: 'run-abc', hash: 'hash-1' } },
    );
    expect(out).toEqual([{ content: 'Owner prefers terse standups.', action: 'duplicate' }]);
  });

  it('records other failures as error and never throws', async () => {
    const out = await persistMemories(
      fakeEngine(async () => { throw new EngineError('INTERNAL_ERROR', 'boom'); }),
      'home1', [props[0]!], { enabled: true, cap: 3, dryRun: false, evidence: { runRef: 'run-abc', hash: 'hash-1' } },
    );
    expect(out[0]).toMatchObject({ action: 'error', detail: expect.stringContaining('boom') });
  });

  it('caps at the configured cap', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const out = await persistMemories(
      fakeEngine(async (a) => { seen.push(a); return { id: 1 }; }),
      'home1', props, { enabled: true, cap: 1, dryRun: false, evidence: { runRef: 'run-abc', hash: 'hash-1' } },
    );
    expect(seen).toHaveLength(1);
    expect(out).toHaveLength(1);
  });
});

describe('persistSweepMemories (v1.6)', () => {
  const proposals = [
    { content: 'Fact one', category: 'fact' as const },
    { content: 'Fact two', category: 'preference' as const },
  ];
  const evidence = { node_id: 'n1', hash: 'h' };

  it('writes vault-scoped with provenance evidence and no node_id', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const engine = { createMemory: async (args: Record<string, unknown>) => { calls.push(args); return { id: 1 }; } } as unknown as Engine;
    const results = await persistSweepMemories(engine, proposals, { dryRun: false, evidence });
    expect(results.map(r => r.action)).toEqual(['created', 'created']);
    expect(calls[0]).toMatchObject({
      source: 'curator', scope: 'vault', content: 'Fact one',
      evidence: { kind: 'note', node_id: 'n1', hash: 'h' },
    });
    expect(calls[0]).not.toHaveProperty('node_id');
  });

  it('passes each fact\'s subjects to create-memory, and none when it has none (#554)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const engine = { createMemory: async (args: Record<string, unknown>) => { calls.push(args); return { id: 1 }; } } as unknown as Engine;
    await persistSweepMemories(engine, [
      { content: 'Dana leads the pilot', category: 'fact', subjects: ['Dana Okafor', 'Northwind'] },
      { content: 'Plain fact', category: 'fact' },
    ], { dryRun: false, evidence });
    expect(calls[0]).toMatchObject({ subjects: ['Dana Okafor', 'Northwind'] });
    expect(calls[1]).not.toHaveProperty('subjects');
  });

  it('dry-run previews without engine calls', async () => {
    let called = 0;
    const engine = { createMemory: async () => { called += 1; return { id: 1 }; } } as unknown as Engine;
    const results = await persistSweepMemories(engine, proposals, { dryRun: true, evidence });
    expect(results.map(r => r.action)).toEqual(['preview', 'preview']);
    expect(called).toBe(0);
  });

  it('classifies DUPLICATE_MEMORY as duplicate and other errors as error, never throwing', async () => {
    let call = 0;
    const engine = {
      createMemory: async () => {
        call += 1;
        if (call === 1) throw new EngineError('DUPLICATE_MEMORY', 'dup');
        throw new Error('boom');
      },
    } as unknown as Engine;
    const results = await persistSweepMemories(engine, proposals, { dryRun: false, evidence });
    expect(results[0]).toMatchObject({ action: 'duplicate' });
    expect(results[1]).toMatchObject({ action: 'error', detail: 'boom' });
  });

  it('does not cap — run-cap enforcement is the sweep job upstream', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ content: `F${i}`, category: 'fact' as const }));
    const engine = { createMemory: async () => ({ id: 1 }) } as unknown as Engine;
    const results = await persistSweepMemories(engine, many, { dryRun: false, evidence });
    expect(results).toHaveLength(12);
  });
});

describe('persistSweepMemories (#298)', () => {
  it("spends the consolidation call under the sweep's run", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const out = await persistSweepMemories(
      fakeEngine(async (a) => { seen.push(a); return { id: 1, operation: 'add' }; }),
      [props[0]!], { dryRun: false, evidence: { node_id: 'n1', hash: 'h1' }, runRef: 'sweep-run' },
    );
    expect(out).toEqual([{ content: 'Owner prefers terse standups.', action: 'created' }]);
    expect(seen[0]).toMatchObject({ scope: 'vault', evidence: { kind: 'note', node_id: 'n1', hash: 'h1' }, usage: { runRef: 'sweep-run', sourceRef: 'memory-sweep' } });
  });
});
