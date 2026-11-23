import type { CurateResult } from './types.js';
import { runSweep, type CoreDeps, type SweepOpts } from './core.js';
import { formatFieldGuessOperationalWarnings } from './report.js';

type SweepRunner = (deps: CoreDeps, opts: SweepOpts) => Promise<CurateResult[]>;

/** Build the one production full-sweep path shared by the scheduler and catch-up. */
export function createProductionSweepRunner(
  freshDeps: () => Promise<CoreDeps>,
  log: (line: string) => void,
  run: SweepRunner = runSweep,
): () => Promise<void> {
  return async () => {
    await run(await freshDeps(), {
      dryRun: false,
      force: false,
      trigger: 'scheduled',
      onFieldGuessResult: (result) => {
        for (const line of formatFieldGuessOperationalWarnings(result)) log(line);
      },
    });
  };
}
