import { suggestedLimitUsd } from '../on-demand/ceiling.js';
import { limitLines, withInterrupts, type InterruptSource } from '../on-demand/cli.js';
import {
  previewFieldFill,
  startFieldFill,
  undoFieldFill,
  viewFieldFillRun,
  type FieldFillDeps,
} from './run.js';

/** The CLI's field-filling flags (#644), as `src/run.ts` parses them. */
export interface FieldFillCliArgs {
  dryRun: boolean;
  /** Paid model calls without writes; `--preview` also sets `dryRun`, as for every CLI command. */
  preview: boolean;
  fillFields: string[] | null;
  fillTypes: string[] | null;
  fillPath: string | null;
  limitUsd: number | null;
  sample: number | null;
  undoFill: string | null;
  /** Also replace values that fail their field's type; off unless `--replace-invalid`. */
  replaceInvalid: boolean;
}

/** Refuse flag combinations that would mean something other than what they say. */
export function checkFieldFillArgs(args: FieldFillCliArgs): void {
  if (args.limitUsd !== null && (!Number.isFinite(args.limitUsd) || args.limitUsd <= 0)) {
    throw new Error('--limit-usd must be a positive number of dollars');
  }
  if (args.sample !== null && (!Number.isInteger(args.sample) || args.sample < 0)) {
    throw new Error('--sample must be a whole number, 0 or more');
  }
  if (args.fillFields !== null && args.fillFields.length === 0) throw new Error('--fill-fields needs a comma-separated list of field names');
  if (args.fillFields === null && (args.fillTypes !== null || args.fillPath !== null || args.limitUsd !== null || args.sample !== null || args.replaceInvalid)) {
    throw new Error('--types, --path, --limit-usd and --sample go with --fill-fields or --type-notes, and --replace-invalid with --fill-fields');
  }
  if (args.sample !== null && !args.preview) throw new Error('--sample goes with --preview: a sample is paid model calls');
}

/** What the flags ask for. `--dry-run` wins over a limit, as it does for every CLI command. */
export function fieldFillCliMode(args: FieldFillCliArgs): 'undo' | 'count' | 'preview' | 'run' {
  if (args.undoFill !== null) return 'undo';
  if (args.preview) return 'preview';
  if (args.dryRun || args.limitUsd === null) return 'count';
  return 'run';
}

/**
 * `--fill-fields` and `--undo-fill`: the count, preview, run and undo the fill-fields tool gives.
 *
 * - Alone or with `--dry-run`: the notes in scope, and no model call. `--dry-run` promises that
 *   for every command of this CLI.
 * - `--preview`: the paid sample (from the daily cap) and the estimate.
 * - `--limit-usd`: the run. Ctrl-C ends it after the note in hand, recorded as interrupted; a
 *   second one ends the process, and the run is then marked interrupted when runs are next read.
 *
 * Returns whether the command failed.
 */
export async function fieldFillCli(
  deps: FieldFillDeps,
  args: FieldFillCliArgs,
  log: (line: string) => void,
  interrupts: InterruptSource = process,
  exit: (code: number) => void = code => process.exit(code),
): Promise<{ failed: boolean }> {
  const mode = fieldFillCliMode(args);
  if (mode === 'undo') {
    const undone = await undoFieldFill(deps, args.undoFill ?? undefined, args.dryRun);
    log(`${undone.dry_run ? 'would put back' : 'put back'} ${undone.restored} note(s); ${undone.conflict_count} edited since and left alone; `
      + `${undone.no_longer_undoable} no longer undoable`);
    return { failed: false };
  }
  const query = { ...(args.fillTypes ? { types: args.fillTypes } : {}), ...(args.fillPath ? { path_prefix: args.fillPath } : {}) };
  const request = { fields: args.fillFields ?? [], query, replaceInvalid: args.replaceInvalid };

  if (mode !== 'run') {
    const sample = mode === 'preview' ? (args.sample ?? undefined) : 0;
    const { preview } = await previewFieldFill(deps, { ...request, ...(sample === undefined ? {} : { sample }) });
    log(`${preview.notes} note(s) in scope; model ${preview.model}${preview.provider ? ` on ${preview.provider}` : ''}`);
    for (const [field, count] of Object.entries(preview.fields)) {
      log(`  ${field}: empty on ${count.empty}${count.invalid > 0 ? `; ${count.invalid} hold a value that fails its type` : ''}`);
    }
    if (preview.invalid_values_note) log(`  ${preview.invalid_values_note.replace('Pass replace_invalid: true', 'Add --replace-invalid')}`);
    for (const note of preview.sample) {
      log(`  sample "${note.title}": ${JSON.stringify(note.set)}${note.replaces ? `; replaces ${JSON.stringify(note.replaces)}` : ''}`
        + `${note.left.length > 0 ? `; left ${note.left.map(left => left.field).join(', ')}` : ''}`);
    }
    if (preview.sample_note) log(`  ${preview.sample_note}`);
    for (const line of limitLines({
      ceiling: preview.run_ceiling, estimatedCostUsd: preview.estimated_cost_usd, estimatedMinutes: preview.estimated_minutes,
      suggestedLimit: suggestedLimitUsd(preview.estimated_cost_usd, preview.run_ceiling), countOnly: mode === 'count' && preview.notes > 0,
    })) log(line);
    return { failed: false };
  }

  const started = await withInterrupts(interrupts, exit, log, stopping =>
    startFieldFill({ ...deps, stopping }, { ...request, limitUsd: args.limitUsd ?? undefined, trigger: 'cli' }));
  if (!started.started) {
    log(`a ${started.run.job} run is already in progress (${started.run.id}), so nothing was started`);
    return { failed: true };
  }
  const view = viewFieldFillRun(deps.db!, started.run);
  log(`${view.status.toUpperCase()}  run ${view.run_id}: ${view.counts.filled} of ${view.notes} note(s) filled, ${view.counts.fields_set} field(s) set, `
    + `${view.counts.left_empty} left empty, ${view.counts.already_asked} already asked, ${view.counts.changed} changed meanwhile, `
    + `${view.counts.errors} error(s); $${view.spent_usd.toFixed(4)} of $${view.limit_usd.toFixed(2)}`);
  if (view.detail) log(`  ${view.detail}`);
  if (view.undoable_notes > 0) log(`  undo it with --undo-fill ${view.run_id}`);
  return { failed: view.status === 'failed' };
}
