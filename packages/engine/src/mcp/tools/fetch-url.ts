import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { fetchReadableUrl, type LookupFn } from '../../web/fetch-url.js';
import { WebError } from '../../web/errors.js';
import { fetchesKnownAddressesOnly, type KnownWebAddresses } from '../../web/known-addresses.js';

export const UNKNOWN_ADDRESS_REFUSAL =
  'fetch-url reads only an address that web-search returned to this client. Call web-search and pass a '
  + "result's url unchanged, or read this address with your own web fetch.";

/**
 * Always-on (no API key). The SSRF guard in fetchReadableUrl keeps it off private hosts.
 * A client that signed in through the OAuth flow may fetch only addresses web-search
 * returned to it (`known`); see src/web/known-addresses.ts.
 */
export function registerFetchUrl(server: McpServer, fetchImpl?: typeof fetch, lookup?: LookupFn, known?: KnownWebAddresses): void {
  server.tool(
    'fetch-url',
    'Fetch a public web page and return its readable text content. Rejects private/loopback hosts. Use after web-search to read a specific result in full. A signed-in chat client (claude.ai, Claude Code) can fetch only an address web-search returned to it: pass the result\'s url unchanged.',
    {
      url: z.string().describe('Absolute http(s) URL to fetch'),
    },
    async ({ url }, extra) => {
      const clientId = extra?.authInfo?.clientId;
      if (fetchesKnownAddressesOnly(clientId) && !known?.has(clientId, url)) {
        return fail('INVALID_PARAMS', UNKNOWN_ADDRESS_REFUSAL);
      }
      try {
        const result = await fetchReadableUrl(url, fetchImpl, lookup);
        return ok(result);
      } catch (err) {
        if (err instanceof WebError) return fail(err.errorCode, err.message);
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
