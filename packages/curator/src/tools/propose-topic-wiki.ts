import { z } from 'zod';
import type { CoreDeps } from '../core.js';
import { proposeTopicWiki } from '../topic-inference.js';
import { withScope, type ToolHandler } from '../auth/with-scope.js';

export const proposeTopicWikiInput = {
  node_id: z.string().min(1).describe('Id of the note to propose a topic wiki from (from vault tools such as query-nodes or get-node). Not a wiki page.'),
  dry_run: z.boolean().default(false).describe('Run the free checks and name the model, with no model call.'),
};
type Args = { node_id: string; dry_run: boolean };

/** Build the curate:trigger-guarded propose-topic-wiki handler: one paid call, no writes. */
export function makeProposeTopicWikiHandler(deps: CoreDeps): ToolHandler<Args> {
  return withScope<Args>('curate:trigger', async (args) => {
    const res = await proposeTopicWiki(deps, { nodeId: args.node_id, dryRun: args.dry_run });
    return {
      ...(res.ok ? {} : { isError: true }),
      content: [{ type: 'text', text: JSON.stringify(res) }],
    };
  });
}
