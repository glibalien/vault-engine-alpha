import { z } from 'zod';
import { withScope, type ToolHandler } from '../auth/with-scope.js';
import type { CoreDeps } from '../core.js';
import {
  EXTRACTION_RUN_JOB,
  EXTRACTION_RUN_LIMITS,
  extractionStatus,
  previewExtraction,
  startExtraction,
  undoExtraction,
  viewExtractionRun,
} from '../memory-extraction/run.js';
import { limitAdvice } from '../on-demand/ceiling.js';
import { otherJobsRun } from '../on-demand/run.js';
import { DAILY_CAP_NOTE, refusal, refuse, reply } from '../on-demand/tool.js';

export const EXTRACT_MEMORIES_TOOL = EXTRACTION_RUN_JOB;

/** Raw zod shape for registerTool. */
export const extractMemoriesInput = {
  action: z.enum(['preview', 'start', 'status', 'undo']).default('preview')
    .describe('preview (default): count the notes, estimate the cost and show a sample. start: run it. status: follow a run or list recent ones. undo: take back what a run wrote.'),
  query: z.record(z.string(), z.unknown()).optional()
    .describe('preview, start: query-nodes filters choosing the notes: types, without_types, node_ids, without_node_ids, path_prefix, without_path_prefix, path_dir, '
      + 'title_eq, title_contains, without_titles, without_title_contains, references, modified_since, created_since. types means a note has every kind listed, '
      + 'so give one kind, or leave types out to take every kind the memory sweep reads. Omit for every note a run may read.'),
  facts_per_note: z.number().int().min(1).max(EXTRACTION_RUN_LIMITS.maxFactsPerNote).optional()
    .describe(`preview, start: most facts kept from one note (default the curator setting memorySweepNoteCap, at most ${EXTRACTION_RUN_LIMITS.maxFactsPerNote}).`),
  sample: z.number().int().min(0).max(EXTRACTION_RUN_LIMITS.maxSample).optional()
    .describe(`preview: notes to try the model on (default ${EXTRACTION_RUN_LIMITS.defaultSample}, at most ${EXTRACTION_RUN_LIMITS.maxSample}; 0 for the count alone).`),
  limit_usd: z.number().positive().max(EXTRACTION_RUN_LIMITS.maxLimitUsd).optional()
    .describe('start: the most this run may spend, in USD, the Engine\'s checks of its memories included. Required. The preview suggests one.'),
  run_id: z.string().min(1).optional().describe('status: one run (omit to list recent runs). undo: the run to undo.'),
  dry_run: z.boolean().optional().describe('undo: true (default) reports what would be taken back; false does it.'),
};

type Args = {
  action: 'preview' | 'start' | 'status' | 'undo';
  query?: Record<string, unknown> | undefined;
  facts_per_note?: number | undefined;
  sample?: number | undefined;
  limit_usd?: number | undefined;
  run_id?: string | undefined;
  dry_run?: boolean | undefined;
};

export const EXTRACT_MEMORIES_DESCRIPTION =
  'Read a chosen set of notes for durable facts and keep them as memories, as the nightly memory sweep does with the notes that changed, '
  + 'for a vault with more notes to read than the sweep\'s nightly caps reach (a newly organized one, say). '
  + 'Same model and instructions as the sweep: facts worth remembering months from now, each with the people, companies and projects it is about; most notes give none. '
  + 'Each note\'s earlier facts are checked against its text too, and those it no longer supports are retired. '
  + 'When the owner has named the kinds or folders the memory sweep reads (the curator settings memorySweepTypes and memorySweepPaths), a run reads only those notes; with none named, the query decides. '
  + 'Wiki pages, notes in the settings folder and the Curator\'s journal are never read. '
  + 'A note already read at its current text, by the sweep or a run, is left out, and a note a run reads is not read again until it changes. '
  + 'Always preview first: it returns the notes in scope, the model and its provider, the facts the model would keep from a few notes spread through the set (real calls, paid from today\'s cap; nothing is written), '
  + 'and an estimate of both shares of a run\'s cost: the model\'s, and the Engine\'s, whose consolidation model checks each new memory against the ones already there (an estimate from the average check, which a busy project can exceed), and the minutes a run should take, the Engine\'s writes included. Show the user the sample and the estimate. '
  + 'start needs limit_usd, the most the run may spend, the Engine\'s checks included: that spend is the run\'s own and is not taken from the daily cap, so get the user\'s yes to the figure first. '
  + 'All on-demand runs in a day share a ceiling the owner sets (the curator setting runDailyBudgetCents, $5 unless changed): a limit must fit what is left of it, the preview says what is left, and raising the setting is the owner\'s decision, not yours. '
  + 'It replies at once with a run_id; the run goes on in the background and stops at the limit. Follow it with action "status". '
  + 'One run at a time, whatever the job (fill-fields, type-notes, guess-memory-subjects). A run that stopped (its limit, a restart) continues when you start it again. '
  + 'undo takes back what one run did, as one request (dry_run first): the memories it wrote are retired, the ones they replaced and the earlier facts it retired come back, '
  + 'and the notes it took memories from are read again by a later run; a memory changed since is left alone. '
  + 'The model is the curator setting memorySweepModel, or model when that is not set. Requires the curate:trigger scope.';

/** Parameters that belong to another action are a mistake worth naming, not ignoring. */
function strayParams(args: Args): string | null {
  const given = (name: keyof Args): boolean => args[name] !== undefined;
  const stray = (names: Array<keyof Args>): string[] => names.filter(given);
  switch (args.action) {
    case 'preview': {
      const extra = stray(['limit_usd', 'run_id', 'dry_run']);
      return extra.length > 0 ? `preview takes query, facts_per_note and sample; not ${extra.join(', ')}.` : null;
    }
    case 'start': {
      const extra = stray(['sample', 'run_id', 'dry_run']);
      return extra.length > 0 ? `start takes query, facts_per_note and limit_usd; not ${extra.join(', ')}.` : null;
    }
    case 'status': {
      const extra = stray(['query', 'facts_per_note', 'sample', 'limit_usd', 'dry_run']);
      return extra.length > 0 ? `status takes run_id; not ${extra.join(', ')}.` : null;
    }
    case 'undo': {
      const extra = stray(['query', 'facts_per_note', 'sample', 'limit_usd']);
      return extra.length > 0 ? `undo takes run_id and dry_run; not ${extra.join(', ')}.` : null;
    }
  }
}

/** What a start says about the run it returns. */
function startedDetail(run: { status: string; notes: number; detail: string | null }, started: boolean): string | null {
  if (!started) return 'A run is already in progress, so nothing was started. This is that run; follow it with action "status".';
  return run.status === 'queued' || run.status === 'running'
    ? `Queued a run over ${run.notes} notes. It goes on in the background; follow it with action "status" and this run_id. Do not start it again to check.`
    : run.detail;
}

/** Build the curate:trigger-guarded handler, closing over the shared deps. */
export function makeExtractMemoriesHandler(deps: CoreDeps): ToolHandler<Args> {
  return withScope<Args>('curate:trigger', async (args) => {
    const stray = strayParams(args);
    if (stray !== null) return refuse('INVALID_PARAMS', stray);
    try {
      switch (args.action) {
        case 'preview': {
          const { request, preview } = await previewExtraction(deps, { query: args.query, facts_per_note: args.facts_per_note, sample: args.sample });
          // The limit covers both shares, so it is suggested from their sum.
          const advice = limitAdvice(preview.estimated_total_usd, preview.run_ceiling);
          return reply({
            ok: true,
            ...preview,
            ...(preview.sample_asked > 0 ? { daily_cap_note: DAILY_CAP_NOTE } : {}),
            ...(advice.run_ceiling_note === undefined ? {} : { run_ceiling_note: advice.run_ceiling_note }),
            ...(preview.notes > 0 && advice.limit !== null ? {
              next: { tool: EXTRACT_MEMORIES_TOOL, arguments: { action: 'start', ...request, limit_usd: advice.limit }, purpose: advice.purpose },
            } : {}),
          });
        }
        case 'start': {
          const { run, started } = await startExtraction(deps, {
            query: args.query, facts_per_note: args.facts_per_note, limitUsd: args.limit_usd, trigger: 'on-demand',
          });
          if (run.job !== EXTRACTION_RUN_JOB) return reply({ ok: true, started: false, ...otherJobsRun(run) });
          const view = viewExtractionRun(deps.db!, run);
          return reply({ ok: true, started, ...view, detail: startedDetail(view, started) });
        }
        case 'status':
          return reply({ ok: true, ...extractionStatus(deps, args.run_id) });
        case 'undo':
          return reply({ ok: true, ...(await undoExtraction(deps, args.run_id, args.dry_run ?? true)) });
      }
    } catch (error) {
      return refusal(error);
    }
  });
}
