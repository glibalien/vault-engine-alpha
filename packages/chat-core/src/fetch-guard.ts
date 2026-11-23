import type { ToolSet } from 'ai';

/**
 * Which addresses the chat model may fetch (#548), enforced at the host's tool seam.
 *
 * Text the model reads (a clipping, a saved email, a fetched page) can tell it to fetch
 * `https://some-site/?d=<what it just read>`, and the address then carries vault content
 * to a third party. The Engine applies a known-addresses rule to clients that sign in
 * (#531), but a chat host holds a service token and the Engine cannot see the one other
 * place a legitimate address comes from: what the user typed. So the rule lives here.
 *
 * `fetch-url` runs only for an address in the host's `FetchAllowance`, which the host
 * fills from two things it witnessed itself:
 *   - text the user submitted (`noteUserText`), and
 *   - a `web-search` result that came back through this guard (`noteSearchResult`).
 * Any other address is refused without calling the Engine. Addresses are compared with
 * the fragment dropped and nothing else, because the path and the query string are where
 * data would ride.
 *
 * What must NOT fill it: a note, a fetched page, the model's own text, and stored
 * conversation history. The model can write all of those (a note with `update-node`, a
 * conversation with `save-conversation`), so an address found there proves nothing about
 * what the user asked for.
 */
export const UNKNOWN_FETCH_ADDRESS_MESSAGE =
  'fetch-url reads only an address the user gave in this chat session or one web-search returned in it. '
  + 'Search for the page first and pass a result\'s url unchanged, or ask the user to paste the address.';

type Executable = { execute?: (input: unknown, opts: unknown) => Promise<unknown> };
type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null;
}

/** The address as it is compared: parsed, fragment dropped. Null for text that is not an http(s) URL. */
export function fetchAddressKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  return url.href;
}

// Stops at whitespace and at the characters that cannot appear in an address unescaped.
// An apostrophe can, so it does not end one.
const URL_IN_TEXT = /https?:\/\/[^\s<>"`]+/gi;
/** Characters that may end a sentence or close a bracket around an address, or be part of it. */
const TRAILING = /[.,;:!?*'\]})>]$/;

/**
 * Every http(s) address written out in `text`. Text cannot say where an address ends:
 * in "see https://example.com/a." the full stop is the sentence's, in
 * "<https://example.com/search?q=why?>" the question mark is the address's. So each
 * address is returned as written and again with each trailing punctuation mark taken
 * off. All of these come from the same text, so knowing them all gives nothing away.
 */
export function addressesInText(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(URL_IN_TEXT)) {
    let candidate = match[0];
    found.add(candidate);
    while (TRAILING.test(candidate)) {
      candidate = candidate.slice(0, -1);
      found.add(candidate);
    }
  }
  return [...found];
}

/** The result addresses of one successful web-search envelope. */
function searchResultAddresses(output: unknown): string[] {
  if (!isRecord(output) || output.ok !== true || !isRecord(output.data)) return [];
  const results = output.data.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((r) => (isRecord(r) && typeof r.url === 'string' ? [r.url] : []));
}

/** The addresses one chat may fetch. The host keeps one per conversation, in memory. */
export interface FetchAllowance {
  /** Text the host itself saw the user submit. Never stored history, never anything a tool returned. */
  noteUserText(text: string): void;
  /** A web-search result envelope, as the tool returned it to the host. */
  noteSearchResult(output: unknown): void;
  allows(url: string): boolean;
}

const DEFAULT_MAX_ADDRESSES = 2_000;

/** An empty allowance that keeps its newest `maxAddresses` addresses. */
export function createFetchAllowance(maxAddresses = DEFAULT_MAX_ADDRESSES): FetchAllowance {
  const known = new Set<string>();
  const add = (address: string): void => {
    const key = fetchAddressKey(address);
    if (key === null) return;
    known.delete(key);
    known.add(key);
    while (known.size > maxAddresses) known.delete(known.values().next().value as string);
  };
  return {
    noteUserText: (text) => { for (const address of addressesInText(text)) add(address); },
    noteSearchResult: (output) => { for (const address of searchResultAddresses(output)) add(address); },
    allows: (url) => {
      const key = fetchAddressKey(url);
      return key !== null && known.has(key);
    },
  };
}

/**
 * Wrap `web-search` and `fetch-url` so the model can fetch only addresses in `allowance`.
 * A search made through the returned tools adds its results to it. Tools that are absent
 * are skipped, and every other tool is returned untouched.
 */
export function guardWebFetch(tools: ToolSet, allowance: FetchAllowance): ToolSet {
  const fetchTool = tools['fetch-url'] as (ToolSet[string] & Executable) | undefined;
  if (!fetchTool?.execute) return tools;
  const out: ToolSet = { ...tools };

  const searchTool = tools['web-search'] as (ToolSet[string] & Executable) | undefined;
  if (searchTool?.execute) {
    const search = searchTool.execute.bind(searchTool);
    out['web-search'] = {
      ...searchTool,
      execute: async (input: unknown, opts: unknown) => {
        const result = await search(input, opts);
        allowance.noteSearchResult(result);
        return result;
      },
    } as ToolSet[string];
  }

  const fetchUrl = fetchTool.execute.bind(fetchTool);
  out['fetch-url'] = {
    ...fetchTool,
    execute: async (input: unknown, opts: unknown) => {
      const url = isRecord(input) && typeof input.url === 'string' ? input.url : '';
      if (!allowance.allows(url)) {
        return { ok: false, error: { code: 'INVALID_PARAMS', message: UNKNOWN_FETCH_ADDRESS_MESSAGE }, warnings: [] };
      }
      return fetchUrl(input, opts);
    },
  } as ToolSet[string];
  return out;
}
