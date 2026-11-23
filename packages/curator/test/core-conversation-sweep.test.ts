import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../src/memory-sweep.js', () => ({
  runMemorySweep: vi.fn(async () => ({ ran: false })),
}));

vi.mock('../src/conversation-sweep.js', () => ({
  runConversationSweep: vi.fn(async () => ({ ran: false, dryRun: false })),
}));

vi.mock('../src/reconcile.js', () => ({
  runReconcile: vi.fn(async () => ({ ran: false })),
}));

import { runMemorySweep } from '../src/memory-sweep.js';
import { runConversationSweep } from '../src/conversation-sweep.js';
import { runReconcile } from '../src/reconcile.js';
import { runSweep, type CoreDeps } from '../src/core.js';
import { CurationQueue } from '../src/queue.js';
import type { Engine } from '../src/engine.js';
import type { Config } from '../src/config.js';
import type { LlmClient } from '../src/llm/types.js';

// Same deps builder as core-memory-sweep.test.ts, reused verbatim.
function makeDeps(): CoreDeps {
  const engine = {
    listActiveProjects: async () => [],           // no projects → no curations
  } as unknown as Engine;
  const llm = { structuredCall: async () => { throw new Error('unused'); } } as LlmClient;
  const config = {
    activeStatuses: ['open'],
    fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
    fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
  } as unknown as Config;
  return { engine, llm, config, queue: new CurationQueue() };
}

describe('runSweep → conversation sweep wiring (task 8)', () => {
  beforeEach(() => {
    vi.mocked(runMemorySweep).mockClear();
    vi.mocked(runConversationSweep).mockClear();
    vi.mocked(runReconcile).mockClear();
    // Restore each mock to its default (non-order-tracking, non-rejecting) implementation
    // so tests don't leak mockImplementationOnce/mockRejectedValueOnce state into each other.
    // Cast to the untyped `Mock` (not `vi.mocked`, which infers the real sweep-result
    // shape): these stub results only stand in for "the phase ran" and deliberately
    // don't model every field of MemorySweepResult/ConversationSweepResult/ReconcileResult.
    (runMemorySweep as Mock).mockImplementation(async () => ({ ran: false }));
    (runConversationSweep as Mock).mockImplementation(async () => ({ ran: false, dryRun: false }));
    (runReconcile as Mock).mockImplementation(async () => ({ ran: false }));
  });

  it('runs after the memory sweep and before reconciliation', async () => {
    const order: string[] = [];
    (runMemorySweep as Mock).mockImplementation(async () => {
      order.push('memory');
      return { ran: false };
    });
    (runConversationSweep as Mock).mockImplementation(async () => {
      order.push('conversation');
      return { ran: false, dryRun: false };
    });
    (runReconcile as Mock).mockImplementation(async () => {
      order.push('reconcile');
      return { ran: false };
    });

    await runSweep(makeDeps(), { dryRun: false, force: false, trigger: 'scheduled' });

    expect(order).toEqual(['memory', 'conversation', 'reconcile']);
  });

  it('forwards dryRun through to the conversation sweep under preview, and is skipped by a plain dry run', async () => {
    const deps = makeDeps();
    await runSweep(deps, { dryRun: true, preview: true, force: false, trigger: 'scheduled' });
    expect(runConversationSweep).toHaveBeenCalledTimes(1);
    expect(runConversationSweep).toHaveBeenCalledWith(deps, { dryRun: true, trigger: 'scheduled' });
    vi.mocked(runConversationSweep).mockClear();
    await runSweep(deps, { dryRun: true, force: false, trigger: 'scheduled' });
    expect(runConversationSweep).not.toHaveBeenCalled();
  });

  it('forwards a non-default trigger through to the conversation sweep', async () => {
    const deps = makeDeps();
    await runSweep(deps, { dryRun: false, force: false, trigger: 'cli' });
    expect(runConversationSweep).toHaveBeenCalledTimes(1);
    expect(runConversationSweep).toHaveBeenCalledWith(deps, { dryRun: false, trigger: 'cli' });
  });

  it('a throwing conversation sweep never fails the nightly run, and reconciliation still runs after it', async () => {
    vi.mocked(runConversationSweep).mockRejectedValueOnce(new Error('boom'));
    const order: string[] = [];
    (runReconcile as Mock).mockImplementation(async () => {
      order.push('reconcile');
      return { ran: false };
    });

    const results = await runSweep(makeDeps(), { dryRun: false, force: false, trigger: 'scheduled' });

    expect(results).toEqual([]); // resolves normally, does not throw
    // Proves the phase after the rejection actually executed — not merely that
    // runSweep resolved (which would also be true if the catch swallowed the
    // error AND skipped everything downstream).
    expect(order).toEqual(['reconcile']);
    expect(runReconcile).toHaveBeenCalledTimes(1);
  });
});
