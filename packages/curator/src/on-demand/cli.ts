/** What the CLI's on-demand commands (`--fill-fields`, `--type-notes`) share. */

/**
 * A flag's value, or a refusal when there is none. A flag at the end of the line, or followed by
 * another flag, has no value; read as absent it would drop the restriction it was meant to add,
 * and the command would act on more than was asked.
 */
export function flagValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '' || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

/** A flag's comma-separated value as names; at least one. */
export function flagList(flag: string, value: string | undefined): string[] {
  const names = flagValue(flag, value).split(',').map(name => name.trim()).filter(name => name !== '');
  if (names.length === 0) throw new Error(`${flag} needs a comma-separated list of names`);
  return names;
}

/** The process signals a run listens to; `process` in production. */
export interface InterruptSource {
  on(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

/**
 * Run `work` so that Ctrl-C ends it after the note in hand (`stopping` turns true, and the run is
 * recorded as interrupted). A second Ctrl-C ends the process; the run is then marked interrupted
 * when runs are next read.
 */
export async function withInterrupts<T>(
  interrupts: InterruptSource, exit: (code: number) => void, log: (line: string) => void,
  work: (stopping: () => boolean) => Promise<T>,
): Promise<T> {
  let stopRequested = false;
  const onInterrupt = (): void => {
    if (stopRequested) { exit(130); return; }
    stopRequested = true;
    log('stopping after the current note (Ctrl-C again to stop at once)');
  };
  interrupts.on('SIGINT', onInterrupt);
  try {
    return await work(() => stopRequested);
  } finally {
    interrupts.off('SIGINT', onInterrupt);
  }
}

/** The lines every on-demand preview ends with: what the day's ceiling leaves, and how to go on. */
export function limitLines(input: {
  ceiling: { remaining_usd: number; daily_usd: number } | null;
  estimatedCostUsd: number | null; estimatedMinutes: number | null; suggestedLimit: number | null;
  /** Whether no model was called and there is something to run. */
  countOnly: boolean;
}): string[] {
  const lines: string[] = [];
  if (input.ceiling !== null) {
    lines.push(`today's ceiling for on-demand runs: $${input.ceiling.remaining_usd.toFixed(2)} left of $${input.ceiling.daily_usd.toFixed(2)} (the curator setting runDailyBudgetCents)`);
  }
  if (input.estimatedCostUsd !== null) {
    lines.push(`estimated cost $${input.estimatedCostUsd.toFixed(2)}, about ${input.estimatedMinutes} minute(s); `
      + (input.suggestedLimit === null ? 'no run can start today under the ceiling' : `to run it use --limit-usd ${input.suggestedLimit} in place of --preview`));
  } else if (input.countOnly) {
    lines.push('no model was called; --preview tries it on a sample (paid, from the daily cap), and --limit-usd <n> runs it');
  }
  return lines;
}
