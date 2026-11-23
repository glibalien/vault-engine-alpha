import { z } from 'zod';
import { removeWiki, type CoreDeps } from '../core.js';
import { withScope, type ToolHandler } from '../auth/with-scope.js';

export const removeWikiInput = {
  topic: z.string().min(1).describe('Registered topic or project title to deregister — exactly as it appears in curator-status (not its "<title> Wiki" page).'),
};
type Args = { topic: string };

/** Build the curate:trigger-guarded remove-wiki handler. */
export function makeRemoveWikiHandler(deps: CoreDeps): ToolHandler<Args> {
  return withScope<Args>('curate:trigger', async (args) => {
    const res = await removeWiki(deps, { topic: args.topic });
    return {
      ...(res.ok ? {} : { isError: true }),
      content: [{ type: 'text', text: JSON.stringify(res) }],
    };
  });
}
