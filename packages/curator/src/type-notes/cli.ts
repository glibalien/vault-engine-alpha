import { suggestedLimitUsd } from '../on-demand/ceiling.js';
import { limitLines, withInterrupts, type InterruptSource } from '../on-demand/cli.js';
import { previewTypeNotes, startTypeNotes, undoTypeNotes, viewTypeNotesRun, type TypeNotesDeps } from './run.js';

/** The CLI's typing flags (#644), as `src/run.ts` parses them. */
export interface TypeNotesCliArgs {
  dryRun: boolean;
  /** Paid model calls without writes; `--preview` also sets `dryRun`, as for every CLI command. */
  preview: boolean;
  typeNotes: boolean;
  /** `--types`: the types to offer; null offers every type. */
  offer: string[] | null;
  /** `--path`: the folder whose untyped notes are in scope; null means every untyped note. */
  path: string | null;
  limitUsd: number | null;
  sample: number | null;
  undoTypes: string | null;
}

/** Refuse flag combinations that would mean something other than what they say. */
export function checkTypeNotesArgs(args: TypeNotesCliArgs): void {
  if (args.limitUsd !== null && (!Number.isFinite(args.limitUsd) || args.limitUsd <= 0)) {
    throw new Error('--limit-usd must be a positive number of dollars');
  }
  if (args.sample !== null && (!Number.isInteger(args.sample) || args.sample < 0)) {
    throw new Error('--sample must be a whole number, 0 or more');
  }
  if (args.sample !== null && !args.preview) throw new Error('--sample goes with --preview: a sample is paid model calls');
}

/** What the flags ask for. `--dry-run` wins over a limit, as it does for every CLI command. */
export function typeNotesCliMode(args: TypeNotesCliArgs): 'undo' | 'count' | 'preview' | 'run' {
  if (args.undoTypes !== null) return 'undo';
  if (args.preview) return 'preview';
  if (args.dryRun || args.limitUsd === null) return 'count';
  return 'run';
}

/**
 * `--type-notes` and `--undo-types`: the count, preview, run and undo the type-notes tool gives.
 *
 * - Alone or with `--dry-run`: the untyped notes in scope and the types on offer, and no model call.
 * - `--preview`: the paid sample (from the daily cap) and the estimate.
 * - `--limit-usd`: the run. Ctrl-C ends it after the note in hand, recorded as interrupted.
 *
 * Returns whether the command failed.
 */
export async function typeNotesCli(
  deps: TypeNotesDeps,
  args: TypeNotesCliArgs,
  log: (line: string) => void,
  interrupts: InterruptSource = process,
  exit: (code: number) => void = code => process.exit(code),
): Promise<{ failed: boolean }> {
  const mode = typeNotesCliMode(args);
  if (mode === 'undo') {
    const undone = await undoTypeNotes(deps, args.undoTypes ?? undefined, args.dryRun);
    log(`${undone.dry_run ? 'would take the type back from' : 'took the type back from'} ${undone.restored} note(s); `
      + `${undone.conflict_count} edited since and left alone; ${undone.no_longer_undoable} no longer undoable`);
    return { failed: false };
  }
  const request = { ...(args.offer ? { types: args.offer } : {}), ...(args.path ? { query: { path_prefix: args.path } } : {}) };

  if (mode !== 'run') {
    const sample = mode === 'preview' ? (args.sample ?? undefined) : 0;
    const { preview } = await previewTypeNotes(deps, { ...request, ...(sample === undefined ? {} : { sample }) });
    log(`${preview.notes} untyped note(s) in scope; model ${preview.model}${preview.provider ? ` on ${preview.provider}` : ''}`);
    log(`  types on offer: ${preview.types_offered.join(', ')}`);
    if (preview.scope_note) log(`  ${preview.scope_note}`);
    if (preview.moves_note) log(`  ${preview.moves_note}`);
    for (const note of preview.sample) {
      log(`  sample "${note.title}" (${note.path}): ${note.type ?? 'no type'}${note.refused ? `; the Engine would refuse it: ${note.refused}` : ''}`
        + `${note.reason ? `; ${note.reason}` : ''}`);
    }
    if (preview.sample_note) log(`  ${preview.sample_note}`);
    for (const line of limitLines({
      ceiling: preview.run_ceiling, estimatedCostUsd: preview.estimated_cost_usd, estimatedMinutes: preview.estimated_minutes,
      suggestedLimit: suggestedLimitUsd(preview.estimated_cost_usd, preview.run_ceiling), countOnly: mode === 'count' && preview.notes > 0,
    })) log(line);
    return { failed: false };
  }

  const started = await withInterrupts(interrupts, exit, log, stopping =>
    startTypeNotes({ ...deps, stopping }, { ...request, limitUsd: args.limitUsd ?? undefined, trigger: 'cli' }));
  if (!started.started) {
    log(`a ${started.run.job} run is already in progress (${started.run.id}), so nothing was started`);
    return { failed: true };
  }
  const view = viewTypeNotesRun(deps.db!, started.run);
  const given = Object.entries(view.counts.by_type).map(([type, n]) => `${type} ${n}`).join(', ');
  log(`${view.status.toUpperCase()}  run ${view.run_id}: ${view.counts.typed} of ${view.notes} note(s) typed${given ? ` (${given})` : ''}, `
    + `${view.counts.left_untyped} left untyped, ${view.counts.refused} refused by the Engine, ${view.counts.already_asked} already asked, `
    + `${view.counts.changed} changed meanwhile, ${view.counts.errors} error(s); $${view.spent_usd.toFixed(4)} of $${view.limit_usd.toFixed(2)}`);
  if (view.detail) log(`  ${view.detail}`);
  if (view.undoable_notes > 0) log(`  undo it with --undo-types ${view.run_id}`);
  return { failed: view.status === 'failed' };
}
