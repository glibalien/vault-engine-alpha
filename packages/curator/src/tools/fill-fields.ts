import { z } from 'zod';
import { withScope, type ToolHandler } from '../auth/with-scope.js';
import type { CoreDeps } from '../core.js';
import {
  FIELD_FILL_LIMITS,
  fieldFillStatus,
  previewFieldFill,
  startFieldFill,
  undoFieldFill,
  viewFieldFillRun,
} from '../field-fill/run.js';
import { limitAdvice } from '../on-demand/ceiling.js';
import { otherJobsRun } from '../on-demand/run.js';
import { DAILY_CAP_NOTE, refusal, refuse, reply, startedDetail } from '../on-demand/tool.js';

export const FILL_FIELDS_TOOL = 'fill-fields';

/** Raw zod shape for registerTool. */
export const fillFieldsInput = {
  action: z.enum(['preview', 'start', 'status', 'undo']).default('preview')
    .describe('preview (default): count the notes, estimate the cost and show a sample. start: run it. status: follow a run or list recent ones. undo: put back what a run wrote.'),
  fields: z.array(z.string().min(1)).min(1).max(FIELD_FILL_LIMITS.maxFields).optional()
    .describe('preview and start: the fields to fill, e.g. ["date", "people"]. Each must be claimed by a type of the notes.'),
  query: z.record(z.string(), z.unknown()).optional()
    .describe('preview and start: which notes, as query-nodes filters without joins, e.g. {"types": ["meeting"]} or {"types": ["meeting"], "path_prefix": "Archive/"} or {"node_ids": [...]}. Omit for every note whose types claim a named field.'),
  sample: z.number().int().min(0).max(FIELD_FILL_LIMITS.maxSample).optional()
    .describe(`preview: notes to try the model on (default ${FIELD_FILL_LIMITS.defaultSample}; 0 for the count alone).`),
  replace_invalid: z.boolean().optional()
    .describe('preview and start: also replace a named field\'s value where it fails the field\'s type (a date field holding "TBD"). Off by default: such values are left as they are.'),
  limit_usd: z.number().positive().max(FIELD_FILL_LIMITS.maxLimitUsd).optional()
    .describe('start: the most this run may spend, in USD. Required. The preview suggests one.'),
  run_id: z.string().min(1).optional().describe('status: one run (omit to list recent runs). undo: the run to undo.'),
  dry_run: z.boolean().optional().describe('undo: true (default) reports what would be put back; false does it.'),
};

type Args = {
  action: 'preview' | 'start' | 'status' | 'undo';
  fields?: string[] | undefined;
  query?: Record<string, unknown> | undefined;
  sample?: number | undefined;
  replace_invalid?: boolean | undefined;
  limit_usd?: number | undefined;
  run_id?: string | undefined;
  dry_run?: boolean | undefined;
};

export const FILL_FIELDS_DESCRIPTION =
  'Fill empty fields on a chosen set of notes from each note\'s own text. '
  + 'A model reads each note and writes only what the note clearly gives. Use it after notes have a type: for example, fill date and people on every meeting, where the values sit in the notes\' text as "Date: ..." and "Attendees: ..." lines. '
  + 'Name the fields and the notes (query: query-nodes filters such as types, path_prefix or node_ids). A note is in scope when a named field holds no value. A field that already holds a value is not touched: a valid value never, and a value that fails the field\'s type (a date field holding "TBD", a status not on its list) only with replace_invalid: true, which replaces it where the note gives a value. The preview counts those values per field either way, and with replace_invalid shows the value now there beside the new one, so ask the user before turning it on. Undo puts such a value back as it was, text typed into the note included. '
  + 'Always preview first: it returns the notes in scope, each field\'s count, the model and its provider, what the model would write on a small sample (real calls, a fraction of a cent each on an inexpensive model, paid from today\'s cap), and an estimated cost and duration for the whole set. Show the user the sample and the estimate. The sample waits its turn if a wiki build is running. '
  + 'start needs limit_usd, the most the run may spend: that spend is the run\'s own and is not taken from the daily cap, so get the user\'s yes to the figure first. All on-demand runs in a day share a ceiling the owner sets (the curator setting runDailyBudgetCents, $5 unless changed): a limit must fit what is left of it, the preview says what is left, and raising the setting is the owner\'s decision, not yours. It replies at once with a run_id; the run goes on in the background, one note at a time, and stops at the limit. Follow it with action "status". '
  + 'The model leaves a field empty when the note does not clearly give the value. Those notes stay listed in the Engine\'s cleanup-report, and are not asked again until they change. '
  + 'One run at a time, typing runs (type-notes) included. A run that stopped (its limit, a restart) continues when you start it again: notes already filled are no longer in scope. '
  + 'undo puts back everything one run wrote, as one request (dry_run first): notes edited since are left alone and reported, and the Engine keeps undo records for a limited time (24 hours by default). '
  + 'The model is the curator setting fieldGuessModel. Requires the curate:trigger scope.';

/** Parameters that belong to another action are a mistake worth naming, not ignoring. */
function strayParams(args: Args): string | null {
  const given = (name: keyof Args): boolean => args[name] !== undefined;
  const stray = (names: Array<keyof Args>): string[] => names.filter(given);
  switch (args.action) {
    case 'preview': {
      const extra = stray(['limit_usd', 'run_id', 'dry_run']);
      return extra.length > 0 ? `preview takes fields, query, sample and replace_invalid; not ${extra.join(', ')}.` : null;
    }
    case 'start': {
      const extra = stray(['sample', 'run_id', 'dry_run']);
      return extra.length > 0 ? `start takes fields, query, replace_invalid and limit_usd; not ${extra.join(', ')}.` : null;
    }
    case 'status': {
      const extra = stray(['fields', 'query', 'sample', 'replace_invalid', 'limit_usd', 'dry_run']);
      return extra.length > 0 ? `status takes run_id; not ${extra.join(', ')}.` : null;
    }
    case 'undo': {
      const extra = stray(['fields', 'query', 'sample', 'replace_invalid', 'limit_usd']);
      return extra.length > 0 ? `undo takes run_id and dry_run; not ${extra.join(', ')}.` : null;
    }
  }
}

/** Build the curate:trigger-guarded handler, closing over the shared deps. */
export function makeFillFieldsHandler(deps: CoreDeps): ToolHandler<Args> {
  return withScope<Args>('curate:trigger', async (args) => {
    const stray = strayParams(args);
    if (stray !== null) return refuse('INVALID_PARAMS', stray);
    try {
      switch (args.action) {
        case 'preview': {
          const { request, preview } = await previewFieldFill(deps, {
            fields: args.fields, query: args.query, sample: args.sample, replaceInvalid: args.replace_invalid,
          });
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
                tool: FILL_FIELDS_TOOL,
                arguments: {
                  action: 'start', fields: request.fields, ...(request.query ? { query: request.query } : {}),
                  ...(request.replace_invalid ? { replace_invalid: true } : {}), limit_usd: advice.limit,
                },
                purpose: advice.purpose,
              },
            } : {}),
          });
        }
        case 'start': {
          const { run, started } = await startFieldFill(deps, {
            fields: args.fields, query: args.query, limitUsd: args.limit_usd, replaceInvalid: args.replace_invalid, trigger: 'on-demand',
          });
          // The run in the way may be another job's: one run at a time, whatever the job.
          if (run.job !== 'fill-fields') return reply({ ok: true, started: false, ...otherJobsRun(run) });
          const view = viewFieldFillRun(deps.db!, run);
          return reply({ ok: true, started, ...view, detail: startedDetail(view, started) });
        }
        case 'status':
          return reply({ ok: true, ...fieldFillStatus(deps, args.run_id) });
        case 'undo':
          return reply({ ok: true, ...(await undoFieldFill(deps, args.run_id, args.dry_run ?? true)) });
      }
    } catch (error) {
      return refusal(error);
    }
  });
}
