import { z } from 'zod';
import { withScope, type ToolHandler } from '../auth/with-scope.js';
import type { CoreDeps } from '../core.js';
import { limitAdvice } from '../on-demand/ceiling.js';
import { otherJobsRun } from '../on-demand/run.js';
import { DAILY_CAP_NOTE, refusal, refuse, reply, startedDetail } from '../on-demand/tool.js';
import {
  TYPE_NOTES_LIMITS,
  previewTypeNotes,
  startTypeNotes,
  typeNotesStatus,
  undoTypeNotes,
  viewTypeNotesRun,
} from '../type-notes/run.js';

export const TYPE_NOTES_TOOL = 'type-notes';

/** Raw zod shape for registerTool. */
export const typeNotesInput = {
  action: z.enum(['preview', 'start', 'status', 'undo']).default('preview')
    .describe('preview (default): count the notes, estimate the cost and show a sample. start: run it. status: follow a run or list recent ones. undo: take back the types a run gave.'),
  query: z.record(z.string(), z.unknown()).optional()
    .describe('preview and start: which notes, as query-nodes filters without joins, e.g. {"path_prefix": "Inbox/"} or {"node_ids": [...]} (one group from survey-nodes, say). Only the untyped notes among them are in scope. Omit for every untyped note.'),
  types: z.array(z.string().min(1)).min(1).max(TYPE_NOTES_LIMITS.maxTypes).optional()
    .describe('preview and start: the types the model may choose among, e.g. ["meeting", "person"]. Omit to offer every type. Fewer types make a surer choice.'),
  sample: z.number().int().min(0).max(TYPE_NOTES_LIMITS.maxSample).optional()
    .describe(`preview: notes to try the model on (default ${TYPE_NOTES_LIMITS.defaultSample}; 0 for the count alone).`),
  limit_usd: z.number().positive().max(TYPE_NOTES_LIMITS.maxLimitUsd).optional()
    .describe('start: the most this run may spend, in USD. Required. The preview suggests one.'),
  run_id: z.string().min(1).optional().describe('status: one run (omit to list recent runs). undo: the run to undo.'),
  dry_run: z.boolean().optional().describe('undo: true (default) reports what would be put back; false does it.'),
};

type Args = {
  action: 'preview' | 'start' | 'status' | 'undo';
  query?: Record<string, unknown> | undefined;
  types?: string[] | undefined;
  sample?: number | undefined;
  limit_usd?: number | undefined;
  run_id?: string | undefined;
  dry_run?: boolean | undefined;
};

export const TYPE_NOTES_DESCRIPTION =
  'Give untyped notes a type each, chosen by a model from the note\'s own text. '
  + 'Use it on a folder or a set of notes that mixes kinds, where each note has to be read to tell what it is. When every note of a set is the same kind, give them the type with update-node instead: that needs no model. Create the types first (create-schema): a run can only choose among types that exist. '
  + 'Name the notes (query: query-nodes filters such as path_prefix or node_ids; omit for every untyped note) and, to make the choice surer, the types to offer (types; omit to offer all). Only notes with no type are in scope, and a note that has a type is never given another. '
  + 'The model sees each offered type\'s name, folder and fields, and picks one, or none when no type clearly fits. A note it picks none for stays untyped, stays listed in the Engine\'s cleanup-report, and is not asked again until it changes or the types on offer do. A run gives types and does nothing else: no note is moved, and no field is filled beyond the defaults a type sets (fill-fields fills fields, afterwards). '
  + 'Always preview first: it returns the untyped notes in scope, the types on offer, the model and its provider, the type the model would give each note of a small sample spread through the set, with its reason (real calls, a fraction of a cent each on an inexpensive model, paid from today\'s cap), and an estimated cost and duration for the whole set. Show the user the sample and the estimate: a sample with wrong types means the types on offer are too alike or too many. The sample waits its turn if a wiki build is running. '
  + 'start needs limit_usd, the most the run may spend: that spend is the run\'s own and is not taken from the daily cap, so get the user\'s yes to the figure first. All on-demand runs in a day share a ceiling the owner sets (the curator setting runDailyBudgetCents, $5 unless changed): a limit must fit what is left of it, the preview says what is left, and raising the setting is the owner\'s decision, not yours. It replies at once with a run_id; the run goes on in the background, one note at a time, and stops at the limit. Follow it with action "status". '
  + 'One run at a time, field-filling runs (fill-fields) included. A run that stopped (its limit, a restart) continues when you start it again: notes already typed are no longer in scope. '
  + 'undo takes back every type one run gave, as one request (dry_run first): notes edited since are left alone and reported, and the Engine keeps undo records for a limited time (24 hours by default). '
  + 'The owner\'s settings bound a run: a type in orgTypeExclude is never offered, and a note under orgTypeExcludePaths or in the settings folder is never typed. The model is the curator setting orgSweepModel, or model when that is not set. Requires the curate:trigger scope.';

/** Parameters that belong to another action are a mistake worth naming, not ignoring. */
function strayParams(args: Args): string | null {
  const given = (name: keyof Args): boolean => args[name] !== undefined;
  const stray = (names: Array<keyof Args>): string[] => names.filter(given);
  switch (args.action) {
    case 'preview': {
      const extra = stray(['limit_usd', 'run_id', 'dry_run']);
      return extra.length > 0 ? `preview takes query, types and sample; not ${extra.join(', ')}.` : null;
    }
    case 'start': {
      const extra = stray(['sample', 'run_id', 'dry_run']);
      return extra.length > 0 ? `start takes query, types and limit_usd; not ${extra.join(', ')}.` : null;
    }
    case 'status': {
      const extra = stray(['query', 'types', 'sample', 'limit_usd', 'dry_run']);
      return extra.length > 0 ? `status takes run_id; not ${extra.join(', ')}.` : null;
    }
    case 'undo': {
      const extra = stray(['query', 'types', 'sample', 'limit_usd']);
      return extra.length > 0 ? `undo takes run_id and dry_run; not ${extra.join(', ')}.` : null;
    }
  }
}

/** Build the curate:trigger-guarded handler, closing over the shared deps. */
export function makeTypeNotesHandler(deps: CoreDeps): ToolHandler<Args> {
  return withScope<Args>('curate:trigger', async (args) => {
    const stray = strayParams(args);
    if (stray !== null) return refuse('INVALID_PARAMS', stray);
    try {
      switch (args.action) {
        case 'preview': {
          const { request, preview } = await previewTypeNotes(deps, { types: args.types, query: args.query, sample: args.sample });
          const advice = limitAdvice(preview.estimated_cost_usd, preview.run_ceiling);
          return reply({
            ok: true,
            ...preview,
            ...(preview.sample_asked > 0 ? { daily_cap_note: DAILY_CAP_NOTE } : {}),
            // The owner's bound on what callers like this one can spend between them in a day.
            ...(advice.run_ceiling_note === undefined ? {} : { run_ceiling_note: advice.run_ceiling_note }),
            // Present only when there is something to run and a figure to suggest.
            ...(preview.notes > 0 && advice.limit !== null ? {
              next: {
                tool: TYPE_NOTES_TOOL,
                arguments: {
                  action: 'start', ...(request.query ? { query: request.query } : {}), ...(request.types ? { types: request.types } : {}),
                  limit_usd: advice.limit,
                },
                purpose: advice.purpose,
              },
            } : {}),
          });
        }
        case 'start': {
          const { run, started } = await startTypeNotes(deps, { types: args.types, query: args.query, limitUsd: args.limit_usd, trigger: 'on-demand' });
          // The run in the way may be another job's: one run at a time, whatever the job.
          if (run.job !== 'type-notes') return reply({ ok: true, started: false, ...otherJobsRun(run) });
          const view = viewTypeNotesRun(deps.db!, run);
          return reply({ ok: true, started, ...view, detail: startedDetail(view, started) });
        }
        case 'status':
          return reply({ ok: true, ...typeNotesStatus(deps, args.run_id) });
        case 'undo':
          return reply({ ok: true, ...(await undoTypeNotes(deps, args.run_id, args.dry_run ?? true)) });
      }
    } catch (error) {
      return refusal(error);
    }
  });
}
