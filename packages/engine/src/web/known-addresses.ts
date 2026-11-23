// packages/engine/src/web/known-addresses.ts
import { isServiceClientId } from '../auth/service-client.js';

/**
 * Which callers may fetch only addresses that web-search returned (#531).
 *
 * A chat model that reads untrusted text (a clipping, a saved email, a fetched page) can
 * be told by that text to fetch `https://some-site/?d=<what it just read>`, and the query
 * string then carries vault content to a third party. A client that signs in through the
 * OAuth flow (claude.ai, Claude Code) is a model choosing the address, so it gets the rule
 * hosted chat clients apply to their own web fetch: the address must come from a search.
 *
 * Service-token callers and unauthenticated local ones are not restricted here. The
 * Curator fetches search results from code. A chat host that holds a service token knows
 * what its user typed, which the Engine cannot see, so its rule belongs at the host's own
 * tool seam.
 *
 * An address found in a vault note does not count as known: a model that can be told to
 * fetch can also be told to write the address into a note first.
 */
export function fetchesKnownAddressesOnly(clientId: string | undefined): clientId is string {
  return clientId !== undefined && !isServiceClientId(clientId);
}

/**
 * How an address is compared: parsed, with the fragment dropped (a fragment never leaves
 * the machine). Everything else must match, because the path and the query string are
 * exactly where data could ride. Null for text that is not an absolute URL.
 */
export function addressKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  url.hash = '';
  return url.href;
}

const DEFAULT_PER_CLIENT = 500;
const DEFAULT_MAX_CLIENTS = 100;

/**
 * The addresses web-search has returned to each restricted client, newest kept. Held per
 * client id, not per MCP session, because a client may open a new session between the
 * search and the fetch. In memory only: after a restart the client searches again.
 */
export class KnownWebAddresses {
  private readonly byClient = new Map<string, Set<string>>();

  constructor(
    private readonly perClient = DEFAULT_PER_CLIENT,
    private readonly maxClients = DEFAULT_MAX_CLIENTS,
  ) {}

  remember(clientId: string, urls: readonly string[]): void {
    let known = this.byClient.get(clientId);
    // Re-insert so the map's order is least recently used first.
    if (known) this.byClient.delete(clientId);
    else known = new Set<string>();
    this.byClient.set(clientId, known);
    for (const url of urls) {
      const key = addressKey(url);
      if (key === null) continue;
      known.delete(key);
      known.add(key);
    }
    while (known.size > this.perClient) known.delete(known.values().next().value as string);
    while (this.byClient.size > this.maxClients) this.byClient.delete(this.byClient.keys().next().value as string);
  }

  has(clientId: string, url: string): boolean {
    const key = addressKey(url);
    return key !== null && (this.byClient.get(clientId)?.has(key) ?? false);
  }
}
