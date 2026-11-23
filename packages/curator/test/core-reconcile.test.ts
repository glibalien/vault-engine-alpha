import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../src/reconcile.js', () => ({
  runReconcile: vi.fn(async () => ({ ran: false })),
}));

import { runReconcile } from '../src/reconcile.js';
import { runSweep, type CoreDeps } from '../src/core.js';
import { CurationQueue } from '../src/queue.js';
import type { Engine } from '../src/engine.js';
import type { Config } from '../src/config.js';
import type { LlmClient } from '../src/llm/types.js';

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

describe('runSweep → reconcile wiring', () => {
  beforeEach(() => vi.mocked(runReconcile).mockClear());

  it('runs reconcile as a final phase (after the org sweep) with the sweep dryRun flag under preview, and is skipped by a plain dry run', async () => {
    const deps = makeDeps();
    await runSweep(deps, { dryRun: true, preview: true, force: false, trigger: 'scheduled' });
    expect(runReconcile).toHaveBeenCalledTimes(1);
    expect(runReconcile).toHaveBeenCalledWith(deps, { dryRun: true, trigger: 'scheduled' });
    vi.mocked(runReconcile).mockClear();
    await runSweep(deps, { dryRun: true, force: false, trigger: 'scheduled' });
    expect(runReconcile).not.toHaveBeenCalled();
  });

  it('a reconcile rejection never fails the run', async () => {
    vi.mocked(runReconcile).mockRejectedValueOnce(new Error('reconcile exploded'));
    const results = await runSweep(makeDeps(), { dryRun: false, force: false, trigger: 'scheduled' });
    expect(results).toEqual([]); // resolves normally
  });
});
