import { z } from 'zod';
import { requestWikiPage, type CoreDeps } from '../core.js';
import { withScope, type ToolHandler } from '../auth/with-scope.js';

/** Raw zod shape for registerTool. */
export const requestWikiPageInput = {
  project: z.string().min(1).describe('Project or topic title whose wiki gets the page (on a vault+web topic wiki the page is also refreshed from the web)'),
  title: z.string().min(1).describe('Requested page name (the curator project-qualifies it; an existing page title refreshes that page)'),
  brief: z.string().optional().describe('1-3 sentences of intended focus — steers synthesis and evidence retrieval'),
  mode: z.enum(['immediate', 'next-run']).default('immediate').describe('immediate: fulfill now (scoped single-page curation); next-run: queue for the next full run'),
};

type Args = { project: string; title: string; brief?: string; mode: 'immediate' | 'next-run' };

/** Build the curate:trigger-guarded handler, closing over the shared deps. */
export function makeRequestWikiPageHandler(deps: CoreDeps): ToolHandler<Args> {
  return withScope<Args>('curate:trigger', async (args, extra) => {
    const res = await requestWikiPage(deps, { ...args, requestedBy: extra.authInfo?.clientId });
    return {
      ...(res.ok ? {} : { isError: true }),
      content: [{ type: 'text', text: JSON.stringify(res) }],
    };
  });
}
