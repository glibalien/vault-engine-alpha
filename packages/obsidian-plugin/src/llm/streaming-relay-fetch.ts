/** Normalize any HeadersInit into a plain record (for JSON serialization). */
function toHeaderRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (h instanceof Headers) h.forEach((v, k) => { out[k] = v; });
  else if (Array.isArray(h)) for (const [k, v] of h) out[k] = v;
  else if (h) Object.assign(out, h);
  return out;
}

/** Derive the engine relay URL from the configured engine /mcp URL. */
export function relayUrlFromEngineUrl(engineUrl: string): string {
  const u = new URL(engineUrl);
  u.pathname = u.pathname.replace(/\/mcp\/?$/, '') + '/llm/stream';
  u.search = '';
  u.hash = '';
  return u.toString();
}

/**
 * A WHATWG-fetch-compatible function that streams the LLM response through the
 * engine relay (`POST /llm/stream`). It repackages the provider's `(url, init)`
 * into an envelope `{ url, headers, body }`, POSTs it to the relay with the engine
 * bearer token, and returns the relay's streaming `Response` verbatim — its `body`
 * is a live `ReadableStream` the AI SDK's SSE parser consumes token-by-token.
 *
 * Replaces the old buffered `requestUrl` LLM transport: Obsidian's `requestUrl` is
 * buffered, so the answer used to land all at once. The engine (a Node process) does
 * the real streaming; this shim only needs the renderer's native `fetch` to read a
 * streaming body from the engine. `fetchImpl` is injectable for tests.
 */
export function makeStreamingRelayFetch(opts: {
  relayUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): typeof globalThis.fetch {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headers = toHeaderRecord(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : init?.body == null ? undefined : String(init.body);
    return fetchImpl(opts.relayUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, headers, body }),
      signal: init?.signal ?? undefined,
    });
  }) as typeof globalThis.fetch;
}
