import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../src/org-sweep.js', () => ({
  runOrgSweep: vi.fn(async () => ({ ran: false })),
}));

import { runOrgSweep } from '../src/org-sweep.js';
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

describe('runSweep → org sweep wiring', () => {
  beforeEach(() => vi.mocked(runOrgSweep).mockClear());

  it('runs the org sweep as a final phase with the sweep dryRun flag under preview, and is skipped by a plain dry run', async () => {
    const deps = makeDeps();
    await runSweep(deps, { dryRun: true, preview: true, force: false, trigger: 'scheduled' });
    expect(runOrgSweep).toHaveBeenCalledTimes(1);
    expect(runOrgSweep).toHaveBeenCalledWith(deps, { dryRun: true, trigger: 'scheduled' });
    vi.mocked(runOrgSweep).mockClear();
    await runSweep(deps, { dryRun: true, force: false, trigger: 'scheduled' });
    expect(runOrgSweep).not.toHaveBeenCalled();
  });

  it('an org-sweep rejection never fails the run', async () => {
    vi.mocked(runOrgSweep).mockRejectedValueOnce(new Error('sweep exploded'));
    const results = await runSweep(makeDeps(), { dryRun: false, force: false, trigger: 'scheduled' });
    expect(results).toEqual([]); // resolves normally
  });
});
