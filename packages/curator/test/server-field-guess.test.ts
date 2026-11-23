import { describe, expect, it, vi } from 'vitest';
import type { CoreDeps } from '../src/core.js';
import type { FieldGuessSweepResult } from '../src/field-guess/types.js';
import { createProductionSweepRunner } from '../src/server-sweep.js';

function result(overrides: Partial<FieldGuessSweepResult> = {}): FieldGuessSweepResult {
  return {
    ran: true, dryRun: false, skipReason: null, scannedNodes: 1, modelCalls: 1,
    fieldsSet: 0, abstentions: 0, ledgerSkips: 0, missingHashSkips: 0,
    staleNodes: 0, deferredNodes: 0, referenceErrors: 0, providerErrors: 1,
    mutationErrors: 0, errors: 1, warnings: ['SECRET PROVIDER DETAIL'], actions: [],
    ...overrides,
  };
}

describe('createProductionSweepRunner', () => {
  it('installs one bounded observer on the shared scheduled/catch-up runner', async () => {
    const log = vi.fn();
    const deps = {} as CoreDeps;
    const freshDeps = vi.fn(async () => deps);
    const runSweep = vi.fn(async (_deps: CoreDeps, opts: {
      onFieldGuessResult?: (value: FieldGuessSweepResult) => void;
      trigger: string;
    }) => {
      opts.onFieldGuessResult?.(result());
      return [];
    });
    const run = createProductionSweepRunner(freshDeps, log, runSweep);

    await run();
    await run();

    expect(freshDeps).toHaveBeenCalledTimes(2);
    expect(runSweep).toHaveBeenCalledTimes(2);
    expect(runSweep.mock.calls.every(call => call[1]?.trigger === 'scheduled')).toBe(true);
    expect(log.mock.calls).toEqual([
      ['field guessing: 1 provider error'],
      ['field guessing: 1 operational warning'],
      ['field guessing: 1 provider error'],
      ['field guessing: 1 operational warning'],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  });

  it('does not log the intentional cap-zero disabled state', async () => {
    const log = vi.fn();
    const runSweep = vi.fn(async (_deps: CoreDeps, opts: {
      onFieldGuessResult?: (value: FieldGuessSweepResult) => void;
    }) => {
      opts.onFieldGuessResult?.(result({
        ran: false, skipReason: 'disabled', modelCalls: 0, providerErrors: 0,
        errors: 0, warnings: [],
      }));
      return [];
    });
    const run = createProductionSweepRunner(async () => ({} as CoreDeps), log, runSweep);

    await run();

    expect(log).not.toHaveBeenCalled();
  });
});
