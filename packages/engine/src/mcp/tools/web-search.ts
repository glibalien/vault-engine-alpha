// packages/engine/src/mcp/tools/web-search.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import type { WebSearchProvider } from '../../web/provider.js';
import { WebError } from '../../web/errors.js';
import { fetchesKnownAddressesOnly, type KnownWebAddresses } from '../../web/known-addresses.js';

/**
 * Registered only when a provider exists (EXA_API_KEY set). See registerAllTools.
 * The result addresses a restricted client gets are remembered in `known`, which is what
 * lets that client fetch them afterwards (src/web/known-addresses.ts).
 */
export function registerWebSearch(server: McpServer, provider: WebSearchProvider, known?: KnownWebAddresses): void {
  server.tool(
    'web-search',
    'Search the public web. Returns ranked results with title, url, snippet, and published date. Use fetch-url to read a result in full.',
    {
      query: z.string().describe('Search query'),
      num_results: z.number().optional().describe('Max results (default 5, clamped to 1..10)'),
    },
    async ({ query, num_results }, extra) => {
      if (!query.trim()) return fail('INVALID_PARAMS', 'query must be a non-empty string');
      const numResults = Math.min(Math.max(num_results ?? 5, 1), 10);
      try {
        const results = await provider.search(query, { numResults });
        const clientId = extra?.authInfo?.clientId;
        if (fetchesKnownAddressesOnly(clientId)) known?.remember(clientId, results.map((r) => r.url));
        return ok({ results });
      } catch (err) {
        if (err instanceof WebError) return fail(err.errorCode, err.message);
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
