import { z } from 'zod';
import { withScope, type ToolHandler, type ToolResult } from '../auth/with-scope.js';
import type { CoreDeps } from '../core.js';
import { DossierError } from '../dossier/evidence.js';
import { removeDossier } from '../dossier/remove.js';
import { EngineError } from '../engine.js';
import { refuse, reply } from '../on-demand/tool.js';

export const REMOVE_DOSSIER_TOOL = 'remove-dossier';

/** Raw zod shape for registerTool. */
export const removeDossierInput = {
  node_id: z.string().min(1).optional().describe('The person\'s or company\'s note, or the dossier page itself, by id.'),
  title: z.string().min(1).optional().describe('The note or the page by its exact title, in place of node_id.'),
  dry_run: z.boolean().default(true).describe('true (default): say what would be deleted. false: delete it.'),
};

type Args = { node_id?: string | undefined; title?: string | undefined; dry_run: boolean };

export const REMOVE_DOSSIER_DESCRIPTION =
  'Remove a dossier (a page made by build-dossier): delete its page through the Engine and forget the Curator\'s record of it. '
  + 'Give the person\'s or company\'s note, or the page itself, as node_id or title. '
  + 'dry_run (the default) says which page would go and writes nothing; show that to the user first. '
  + 'dry_run false deletes it as one undo operation and returns its operation_id with the undo-operations call that brings the page back. '
  + 'Refused for a page that is not a dossier (a project or topic wiki: remove-wiki deregisters those) and while a build of the dossier is queued or running. '
  + 'The note\'s "dossier" field is left as it is. Requires the curate:trigger scope.';

function refusal(error: unknown): ToolResult {
  if (error instanceof DossierError) return refuse(error.code, error.message);
  if (error instanceof EngineError) return refuse(error.code, error.message.slice(0, 500));
  return refuse('INTERNAL_ERROR', (error instanceof Error ? error.message : String(error)).slice(0, 500));
}

export function makeRemoveDossierHandler(deps: CoreDeps): ToolHandler<Args> {
  return withScope<Args>('curate:trigger', async (args) => {
    try {
      return reply({ ok: true, ...(await removeDossier(deps, { node_id: args.node_id, title: args.title }, { dryRun: args.dry_run })) });
    } catch (error) {
      return refusal(error);
    }
  });
}
