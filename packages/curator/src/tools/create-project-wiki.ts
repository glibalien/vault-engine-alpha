import { z } from 'zod';
import { createProjectWiki, type CoreDeps } from '../core.js';
import { withScope, type ToolHandler } from '../auth/with-scope.js';

export const createProjectWikiInput = {
  project: z.string().min(1).describe('Title of the project note to keep a wiki for (not its "<project> Wiki" page).'),
  dry_run: z.boolean().default(false).describe('Report what would happen, with no writes or model calls.'),
};
type Args = { project: string; dry_run: boolean };

/** Build the curate:trigger-guarded create-project-wiki handler. */
export function makeCreateProjectWikiHandler(deps: CoreDeps): ToolHandler<Args> {
  return withScope<Args>('curate:trigger', async (args, extra) => {
    const res = await createProjectWiki(deps, { project: args.project, dryRun: args.dry_run, by: extra.authInfo?.clientId ?? null });
    return {
      ...(res.ok ? {} : { isError: true }),
      content: [{ type: 'text', text: JSON.stringify(res) }],
    };
  });
}
