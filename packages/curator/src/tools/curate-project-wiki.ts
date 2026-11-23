import { z } from 'zod';
import { startOnDemandCuration, triggerCuration, type CoreDeps } from '../core.js';
import { buildCurateReport } from '../report.js';
import { withScope, type ToolHandler } from '../auth/with-scope.js';

/** Raw zod shape for registerTool. */
export const curateProjectWikiInput = {
  project: z.string().min(1).optional()
    .describe('Project title to curate, or a registered topic wiki\'s name. Omit to sweep all active projects (CLI: omit --project).'),
  dry_run: z.boolean().default(false).describe('Report which wikis would be curated and why, with no model calls or writes'),
  preview: z.boolean().default(false).describe('With dry_run, run the paid model calls and return the generated result without writing'),
  force: z.boolean().default(false).describe('Re-curate even if the evidence fingerprint is unchanged, or the wiki is paused (it stays paused)'),
  limit: z.number().int().positive().optional()
    .describe('Sweep only (no project): cap how many active projects are curated this run (CLI: --limit). Ignored when project is set.'),
};

type Args = { project?: string; dry_run: boolean; preview?: boolean; force: boolean; limit?: number };

/** Build the curate:trigger-guarded handler, closing over the shared deps. */
export function makeCurateProjectWikiHandler(deps: CoreDeps): ToolHandler<Args> {
  return withScope<Args>('curate:trigger', async (args) => {
    const mode = args.project ? 'project' as const : 'sweep' as const;
    const trigger = {
      project: args.project ?? null, force: args.force, dryRun: args.dry_run,
      preview: args.dry_run && (args.preview ?? false), limit: args.limit ?? null,
    };
    // The server queues live runs and replies at once; on-demand curations take minutes.
    const started = deps.builds ? await startOnDemandCuration(deps, deps.builds, trigger, 'on-demand') : null;
    if (started !== null && !Array.isArray(started)) {
      return { content: [{ type: 'text', text: JSON.stringify({ mode, dry_run: args.dry_run, ...started }) }] };
    }
    const results = started ?? await triggerCuration(deps, trigger, 'on-demand');
    const report = buildCurateReport(results, { mode, dryRun: args.dry_run });
    return { content: [{ type: 'text', text: JSON.stringify(report) }] };
  });
}
