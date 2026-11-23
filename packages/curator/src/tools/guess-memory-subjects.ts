import { z } from 'zod';
import { withScope, type ToolHandler } from '../auth/with-scope.js';
import type { CoreDeps } from '../core.js';
import {
  SUBJECT_RUN_JOB,
  SUBJECT_RUN_LIMITS,
  previewSubjectRun,
  startSubjectRun,
  subjectRunStatus,
  undoSubjectRun,
  viewSubjectRun,
} from '../memory-subjects/run.js';
import { limitAdvice } from '../on-demand/ceiling.js';
import { otherJobsRun } from '../on-demand/run.js';
import { DAILY_CAP_NOTE, refusal, refuse, reply } from '../on-demand/tool.js';

export const GUESS_MEMORY_SUBJECTS_TOOL = SUBJECT_RUN_JOB;

/** Raw zod shape for registerTool. */
export const guessMemorySubjectsInput = {
  action: z.enum(['preview', 'start', 'status', 'undo']).default('preview')
    .describe('preview (default): count the memories, estimate the cost and show a sample. start: run it. status: follow a run or list recent ones. undo: take back the subjects a run gave.'),
  sample: z.number().int().min(0).max(SUBJECT_RUN_LIMITS.maxSample).optional()
    .describe(`preview: memories to try the model on (default ${SUBJECT_RUN_LIMITS.defaultSample}, at most ${SUBJECT_RUN_LIMITS.maxSample}; 0 for the count alone).`),
  limit_usd: z.number().positive().max(SUBJECT_RUN_LIMITS.maxLimitUsd).optional()
    .describe('start: the most this run may spend, in USD. Required. The preview suggests one.'),
  run_id: z.string().min(1).optional().describe('status: one run (omit to list recent runs). undo: the run to undo.'),
  dry_run: z.boolean().optional().describe('undo: true (default) reports what would be taken back; false does it.'),
};

type Args = {
  action: 'preview' | 'start' | 'status' | 'undo';
  sample?: number | undefined;
  limit_usd?: number | undefined;
  run_id?: string | undefined;
  dry_run?: boolean | undefined;
};

export const GUESS_MEMORY_SUBJECTS_DESCRIPTION =
  'Have a model name who or what each memory with no subjects is about: the people, companies and projects in it. '
  + 'A memory\'s subjects are what puts it in a person\'s, company\'s or project\'s set (list-memories subject_of). Memories written by the nightly sweeps get them as they are written; run the Engine\'s backfill-memory-subjects first for older ones, which needs no model, and use this for what it leaves: memories with none (a first name, a company named in one word, someone with no note yet), and names it missed in the memories it tagged. '
  + 'Every live memory with no subjects, or with only those backfill-memory-subjects gave, is in scope: for the latter the model adds the names the free match missed, and no subject is ever taken away. The model sees each memory with the subjects it has, the title of the note it came from and the people, companies and projects that note is or links to, so it can write a name in full; the Engine then links each name to the note that alone answers to it, keeps a name no note answers to yet and matches it once one does, and never links the vault owner (the vault map\'s ownerNote). A memory the model names no one in is not asked again until what it would be shown changes. What a run writes is marked set_by "model". '
  + 'Always preview first: it returns the memories in scope, the model and its provider, what the model would give a sample of memories spread through the set with how each name would resolve (real calls, 20 memories to a call, a fraction of a cent each on an inexpensive model, paid from today\'s cap; nothing is written), and an estimated cost and duration for the whole set. Show the user the sample and the estimate. The sample waits its turn if a wiki build is running. '
  + 'start needs limit_usd, the most the run may spend: that spend is the run\'s own and is not taken from the daily cap, so get the user\'s yes to the figure first. All on-demand runs in a day share a ceiling the owner sets (the curator setting runDailyBudgetCents, $5 unless changed): a limit must fit what is left of it, the preview says what is left, and raising the setting is the owner\'s decision, not yours. It replies at once with a run_id; the run goes on in the background and stops at the limit. Follow it with action "status". '
  + 'One run at a time, typing (type-notes) and field-filling (fill-fields) runs included. A run that stopped (its limit, a restart) continues when you start it again. '
  + 'undo takes back every subject one run gave, as one request (dry_run first); subjects set any other way stay. The model is the curator setting memorySweepModel, or model when that is not set. Requires the curate:trigger scope.';

/** Parameters that belong to another action are a mistake worth naming, not ignoring. */
function strayParams(args: Args): string | null {
  const given = (name: keyof Args): boolean => args[name] !== undefined;
  const stray = (names: Array<keyof Args>): string[] => names.filter(given);
  switch (args.action) {
    case 'preview': {
      const extra = stray(['limit_usd', 'run_id', 'dry_run']);
      return extra.length > 0 ? `preview takes sample; not ${extra.join(', ')}.` : null;
    }
    case 'start': {
      const extra = stray(['sample', 'run_id', 'dry_run']);
      return extra.length > 0 ? `start takes limit_usd; not ${extra.join(', ')}.` : null;
    }
    case 'status': {
      const extra = stray(['sample', 'limit_usd', 'dry_run']);
      return extra.length > 0 ? `status takes run_id; not ${extra.join(', ')}.` : null;
    }
    case 'undo': {
      const extra = stray(['sample', 'limit_usd']);
      return extra.length > 0 ? `undo takes run_id and dry_run; not ${extra.join(', ')}.` : null;
    }
  }
}

/** What a start says about the run it returns. */
function startedDetail(run: { status: string; memories: number; detail: string | null }, started: boolean): string | null {
  if (!started) return 'A run is already in progress, so nothing was started. This is that run; follow it with action "status".';
  return run.status === 'queued' || run.status === 'running'
    ? `Queued a run over ${run.memories} memories. It goes on in the background; follow it with action "status" and this run_id. Do not start it again to check.`
    : run.detail;
}

/** Build the curate:trigger-guarded handler, closing over the shared deps. */
export function makeGuessMemorySubjectsHandler(deps: CoreDeps): ToolHandler<Args> {
  return withScope<Args>('curate:trigger', async (args) => {
    const stray = strayParams(args);
    if (stray !== null) return refuse('INVALID_PARAMS', stray);
    try {
      switch (args.action) {
        case 'preview': {
          const preview = await previewSubjectRun(deps, { sample: args.sample });
          const advice = limitAdvice(preview.estimated_cost_usd, preview.run_ceiling);
          return reply({
            ok: true,
            ...preview,
            ...(preview.sample_asked > 0 ? { daily_cap_note: DAILY_CAP_NOTE } : {}),
            ...(advice.run_ceiling_note === undefined ? {} : { run_ceiling_note: advice.run_ceiling_note }),
            // Present only when there is something to run and a figure to suggest.
            ...(preview.memories > 0 && advice.limit !== null ? {
              next: { tool: GUESS_MEMORY_SUBJECTS_TOOL, arguments: { action: 'start', limit_usd: advice.limit }, purpose: advice.purpose },
            } : {}),
          });
        }
        case 'start': {
          const { run, started } = await startSubjectRun(deps, { limitUsd: args.limit_usd, trigger: 'on-demand' });
          // The run in the way may be another job's: one run at a time, whatever the job.
          if (run.job !== SUBJECT_RUN_JOB) return reply({ ok: true, started: false, ...otherJobsRun(run) });
          const view = viewSubjectRun(deps.db!, run);
          return reply({ ok: true, started, ...view, detail: startedDetail(view, started) });
        }
        case 'status':
          return reply({ ok: true, ...subjectRunStatus(deps, args.run_id) });
        case 'undo':
          return reply({ ok: true, ...(await undoSubjectRun(deps, args.run_id, args.dry_run ?? true)) });
      }
    } catch (error) {
      return refusal(error);
    }
  });
}
