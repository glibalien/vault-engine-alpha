import { z } from 'zod';
import { withScope, type ToolHandler, type ToolResult } from '../auth/with-scope.js';
import { budgetRefusalDetail, isBudgetRefusal } from '../budget.js';
import type { CoreDeps } from '../core.js';
import { previewDossier, startDossier } from '../dossier/build.js';
import { DossierError } from '../dossier/evidence.js';
import { EngineError } from '../engine.js';
import { refuse, reply } from '../on-demand/tool.js';

export const BUILD_DOSSIER_TOOL = 'build-dossier';

/** Raw zod shape for registerTool. */
export const buildDossierInput = {
  node_id: z.string().min(1).optional().describe('The person\'s or company\'s note, by id.'),
  title: z.string().min(1).optional().describe('The note by its exact title, in place of node_id.'),
  dry_run: z.boolean().default(true)
    .describe('true (default): the free preview. false: queue the paid build, after the preview has been shown to the user.'),
  rebuild: z.enum(['manual', 'on-change']).optional()
    .describe('How the dossier is kept, set on the person\'s or company\'s note as "dossier: on-change" (manual removes it) when a live build is queued. '
      + 'on-change: the nightly sweep rebuilds it when it is behind, at most 5 a night, from the daily cap. The dry run says the current mode.'),
};

type Args = { node_id?: string | undefined; title?: string | undefined; dry_run: boolean; rebuild?: 'manual' | 'on-change' | undefined };

export const BUILD_DOSSIER_DESCRIPTION =
  'Build or rebuild a dossier: one wiki page about a person or a company, named "<Name> Dossier", written from what the vault knows about them: '
  + 'the memories about them (their rules and preferences, then the 60 newest), their own note, and the meetings, notes and tasks that link to them. '
  + 'Live facts only: each line gives the day it became true and where it came from, a line that cites nothing is left out, '
  + 'and the page records every memory and note it was built from (inspect-provenance with select "output"). '
  + 'Give the note as node_id or title. '
  + 'dry_run (the default) is free: it says what would be read and what the limits leave out, the page it would create or rebuild, '
  + 'the model and its provider, the request size, an estimate of the paid calls and their worst case, and what is left of today\'s cap. Show that to the user first. '
  + 'dry_run false queues the build and replies at once with status "queued" ("in_progress" when one is already queued for this note): '
  + 'one call on the wiki home model, and a second that checks its lines against the subject\'s rules on what may be said when it has any (a line that breaks one is left out), '
  + 'paid from the daily cap, refused up front when the worst case does not fit. '
  + 'Follow it with curator-status, project set to the page title; do not call again to check. '
  + 'A rebuild replaces the page\'s text and keeps its title and path. The page\'s status says "behind" once a memory about the subject, or a note it read, has changed. '
  + 'It is rebuilt only when asked, unless the note says "dossier: on-change" (rebuild "on-change" sets it): then the nightly sweep rebuilds it when behind. '
  + 'Refused for a project (its dossier is its project wiki), a wiki page, a note of another kind, the vault owner\'s own note, and a note that already has a wiki. '
  + 'Requires the curate:trigger scope.';

/** A refusal or failure as the tool reports it. */
function dossierRefusal(error: unknown): ToolResult {
  if (error instanceof DossierError) return refuse(error.code, error.message);
  if (isBudgetRefusal(error)) return refuse('DAILY_BUDGET', budgetRefusalDetail(error));
  if (error instanceof EngineError) return refuse(error.code, error.message.slice(0, 500));
  return refuse('INTERNAL_ERROR', (error instanceof Error ? error.message : String(error)).slice(0, 500));
}

/** Build the curate:trigger-guarded handler, closing over the shared deps. */
export function makeBuildDossierHandler(deps: CoreDeps): ToolHandler<Args> {
  return withScope<Args>('curate:trigger', async (args) => {
    const target = { node_id: args.node_id, title: args.title };
    try {
      const opts = args.rebuild ? { rebuild: args.rebuild } : {};
      return reply({ ok: true, ...(args.dry_run ? await previewDossier(deps, target, opts) : await startDossier(deps, target, opts)) });
    } catch (error) {
      return dossierRefusal(error);
    }
  });
}
