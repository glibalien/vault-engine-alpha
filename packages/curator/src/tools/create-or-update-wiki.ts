import { z } from 'zod';
import { createOrUpdateWiki, type CoreDeps } from '../core.js';
import { withScope, type ToolHandler } from '../auth/with-scope.js';

const MAX_SOURCE_NODE_IDS = 20;

/** Non-blank stable node ids, at most 20 unique after trimming. */
function sourceIdList() {
  return z.array(
    z.string().refine(id => id.trim().length > 0, 'Source node IDs cannot be blank'),
  ).superRefine((ids, ctx) => {
    const uniqueIds = new Set(ids.map(id => id.trim()));
    if (uniqueIds.size > MAX_SOURCE_NODE_IDS) {
      ctx.addIssue({
        code: 'custom',
        message: `At most ${MAX_SOURCE_NODE_IDS} unique source node IDs are allowed`,
      });
    }
  });
}

export const createOrUpdateWikiInput = {
  topic: z.string().min(1).describe('Topic title to stand up — or update — a wiki for (e.g. "The 2026 Metro Owls"). Idempotent: re-call with an existing topic to change its settings.'),
  brief: z.string().optional().describe('1-3 sentences scoping the topic — steers evidence retrieval and synthesis. On an existing topic: omit to keep the current brief; "" clears it. Changing it triggers a re-curation.'),
  source: z.enum(['vault', 'vault+web']).optional().describe("'vault' = vault-only (default for new topics); 'vault+web' also pulls attributed web research, refreshed on a time cadence. On an existing topic: omit to keep the current source."),
  cadence: z.string().optional().describe('Refresh cadence for vault+web (e.g. "7d", "24h", "2w"); default 7d for new topics. On an existing topic: omit to keep the current cadence; "" resets to the default. A cadence-only change is cheap — no re-synthesis.'),
  source_node_ids: sourceIdList().optional().describe('Stable input evidence anchors, distinct from wiki output pages. On an existing topic: omit to preserve the configured list; an empty list clears it; a non-empty list replaces it after trim/deduplication (maximum 20 unique IDs). Changing membership forces a curation, queued.'),
  add_source_node_ids: sourceIdList().optional().describe('Add these to the sources the wiki has when the call runs, keeping the rest, so two additions never undo each other. Not with source_node_ids. On a new topic they are its first sources. Ids already present are skipped; adding any forces a curation, queued. The total stays at most 20.'),
  paused: z.boolean().optional().describe('Create only. true registers the new wiki paused: its first build is still queued now, then it changes only on request (set-wiki-paused resumes it). Given for a topic that already has a wiki, the call is refused (WIKI_EXISTS) and nothing changes, so a create never updates an existing wiki. Omit it to update one.'),
};
type Args = {
  topic: string;
  brief?: string;
  source?: 'vault' | 'vault+web';
  cadence?: string;
  source_node_ids?: string[];
  add_source_node_ids?: string[];
  paused?: boolean;
};

/** Build the curate:trigger-guarded create-or-update-wiki handler. */
export function makeCreateOrUpdateWikiHandler(deps: CoreDeps): ToolHandler<Args> {
  return withScope<Args>('curate:trigger', async (args, extra) => {
    const res = await createOrUpdateWiki(deps, {
      topic: args.topic, brief: args.brief, source: args.source, cadence: args.cadence,
      source_node_ids: args.source_node_ids,
      ...(args.add_source_node_ids === undefined ? {} : { add_source_node_ids: args.add_source_node_ids }),
      ...(args.paused === undefined ? {} : { paused: args.paused }),
      by: extra.authInfo?.clientId ?? null,
    });
    return {
      ...(res.ok ? {} : { isError: true }),
      content: [{ type: 'text', text: JSON.stringify(res) }],
    };
  });
}
