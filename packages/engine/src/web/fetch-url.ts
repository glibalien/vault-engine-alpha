// packages/engine/src/web/fetch-url.ts
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { WebError } from './errors.js';

// Cheap syntactic pre-filter: obvious private/loopback hostnames + protocol. NOT the only
// guard — assertResolvedPublic does the authoritative DNS + IP-range check.
const PRIVATE_HOST =
  /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$|169\.254\.|\[::1?\]$)|(\.local|\.localhost|\.internal|\.lan)$/i;

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_REDIRECTS = 5;

/** Resolve a hostname to candidate addresses. Injectable so tests never hit real DNS. */
export type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true });

/** Parse + protocol/textual-private pre-check. Throws WebError(INVALID_PARAMS). */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebError('INVALID_PARAMS', `Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebError('INVALID_PARAMS', 'Only http(s) URLs are allowed');
  if (PRIVATE_HOST.test(url.hostname)) throw new WebError('INVALID_PARAMS', 'URL points at a private host');
  return url;
}

/** Ranges ipaddr.js calls unicast that are not public destinations. */
const NON_PUBLIC_V4: Array<[ipaddr.IPv4, number]> = [
  [ipaddr.IPv4.parse('198.18.0.0'), 15], // benchmarking (RFC 2544)
];
const NON_PUBLIC_V6: Array<[ipaddr.IPv6, number]> = [
  [ipaddr.IPv6.parse('::'), 96], // IPv4-compatible IPv6 (deprecated): ::a.b.c.d reaches a.b.c.d on some stacks
  [ipaddr.IPv6.parse('64:ff9b:1::'), 48], // local-use NAT64 (RFC 8215)
  [ipaddr.IPv6.parse('2001:2::'), 48], // benchmarking (RFC 5180)
];

/** True if an IP string is anything other than a normal public unicast address.
 *  IPv4-mapped IPv6 is unwrapped so the embedded v4 address is judged. Unparseable → blocked. */
export function isBlockedAddress(address: string): boolean {
  let addr: ReturnType<typeof ipaddr.parse>;
  try {
    addr = ipaddr.parse(address);
  } catch {
    return true;
  }
  if (addr instanceof ipaddr.IPv6 && addr.isIPv4MappedAddress()) {
    addr = addr.toIPv4Address();
  }
  if (addr.range() !== 'unicast') return true;
  if (addr instanceof ipaddr.IPv6) {
    const v6 = addr;
    return NON_PUBLIC_V6.some((range) => v6.match(range));
  }
  const v4 = addr;
  return NON_PUBLIC_V4.some((range) => v4.match(range));
}

/** Guard before each hop: reject a URL whose host (literal or DNS-resolved) is not public
 *  unicast. Closes the encoded-IP, public-host-points-to-private, and IPv6 bypasses the
 *  textual regex misses, and gives a clear error before any connection is tried.
 *  A host name can answer differently a moment later, so this is not the last word for
 *  names: `createPinnedFetch` checks the addresses the connection actually uses. A literal
 *  address is never looked up again, so for literals this check is the whole guard. */
async function assertResolvedPublic(url: URL, lookup: LookupFn): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  let addresses: string[];
  if (ipaddr.isValid(host)) {
    addresses = [host];
  } else {
    let resolved: Array<{ address: string; family: number }>;
    try {
      resolved = await lookup(host);
    } catch {
      throw new WebError('UPSTREAM_ERROR', `Could not resolve host: ${host}`);
    }
    if (resolved.length === 0) throw new WebError('UPSTREAM_ERROR', `Could not resolve host: ${host}`);
    addresses = resolved.map((r) => r.address);
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) throw new WebError('INVALID_PARAMS', `URL resolves to a non-public address (${address})`);
  }
}

/**
 * A lookup for `net.connect` that resolves through `lookup` and refuses the connection
 * when any answer is a non-public address. It runs when the socket is opened, on the
 * very addresses the socket may use, so a name that resolved to a public address during
 * the earlier check cannot send the connection somewhere private (#531).
 */
export function publicOnlyConnectLookup(
  lookup: LookupFn,
  isBlocked: (address: string) => boolean = isBlockedAddress,
): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname).then(
      (resolved) => {
        const fail = (err: Error) => callback(err as NodeJS.ErrnoException, '', 0);
        if (resolved.length === 0) { fail(new WebError('UPSTREAM_ERROR', `Could not resolve host: ${hostname}`)); return; }
        const blocked = resolved.find((r) => isBlocked(r.address));
        if (blocked) { fail(new WebError('INVALID_PARAMS', `URL resolves to a non-public address (${blocked.address})`)); return; }
        const wanted = options.family === 4 || options.family === 6
          ? resolved.filter((r) => r.family === options.family)
          : resolved;
        const first = wanted[0];
        if (!first) { fail(new WebError('UPSTREAM_ERROR', `Could not resolve host: ${hostname}`)); return; }
        if (options.all) callback(null, wanted);
        else callback(null, first.address, first.family);
      },
      () => callback(new WebError('UPSTREAM_ERROR', `Could not resolve host: ${hostname}`) as NodeJS.ErrnoException, '', 0),
    );
  };
}

/**
 * A fetch whose connections go only to addresses `lookup` returns and `isBlocked` passes.
 * `close` drops its sockets; call it when the request is finished.
 */
export function createPinnedFetch(
  lookup: LookupFn = defaultLookup,
  isBlocked: (address: string) => boolean = isBlockedAddress,
): { fetch: typeof fetch; close: () => Promise<void> } {
  const agent = new Agent({ connect: { lookup: publicOnlyConnectLookup(lookup, isBlocked) } });
  const pinned = ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(input, { ...init, dispatcher: agent })) as unknown as typeof fetch;
  return { fetch: pinned, close: () => agent.destroy() };
}

/** The refusal a connect-time lookup raised, wherever the HTTP client wrapped it. */
function webErrorIn(err: unknown): WebError | undefined {
  for (let current = err, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    if (current instanceof WebError) return current;
  }
  return undefined;
}

export function extractReadableText(html: string, cap = MAX_TEXT_CHARS): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.slice(0, cap).trim();
}

/** Stream the body and stop at the cap — a slow-drip or huge response can't buffer unbounded heap. */
async function readBodyCapped(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, cap);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= cap) {
      void reader.cancel().catch(() => undefined);
      break;
    }
  }
  const merged = new Uint8Array(Math.min(total, cap));
  let offset = 0;
  for (const chunk of chunks) {
    const room = merged.length - offset;
    if (room <= 0) break;
    merged.set(room >= chunk.length ? chunk : chunk.subarray(0, room), offset);
    offset += Math.min(chunk.length, room);
  }
  return new TextDecoder().decode(merged);
}

export interface FetchUrlResult {
  url: string;
  content: string;
}

/** Fetch a public page and return its readable text. Validates the host (DNS + IP range)
 *  before every hop and follows redirects manually so each Location is re-validated.
 *  Without a `fetchImpl` the request goes through `createPinnedFetch`, which checks the
 *  addresses again as each connection opens.
 *  Throws WebError on bad/blocked URL (INVALID_PARAMS) or remote failure (UPSTREAM_ERROR). */
export async function fetchReadableUrl(
  rawUrl: string,
  fetchImpl?: typeof fetch,
  lookup: LookupFn = defaultLookup,
): Promise<FetchUrlResult> {
  if (fetchImpl) return fetchReadable(rawUrl, fetchImpl, lookup);
  const pinned = createPinnedFetch(lookup);
  try {
    return await fetchReadable(rawUrl, pinned.fetch, lookup);
  } finally {
    await pinned.close().catch(() => undefined);
  }
}

async function fetchReadable(rawUrl: string, fetchImpl: typeof fetch, lookup: LookupFn): Promise<FetchUrlResult> {
  let current = assertPublicHttpUrl(rawUrl);
  await assertResolvedPublic(current, lookup);

  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(current, {
        redirect: 'manual',
        headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const refusal = webErrorIn(err);
      if (refusal) throw refusal;
      throw new WebError('UPSTREAM_ERROR', err instanceof Error ? err.message : String(err));
    }

    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      if (hop >= MAX_REDIRECTS) throw new WebError('UPSTREAM_ERROR', 'Too many redirects');
      const location = res.headers.get('location') ?? '';
      try {
        await res.body?.cancel();
      } catch {
        // ignore — draining the redirect body is best-effort
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new WebError('UPSTREAM_ERROR', `Invalid redirect target: ${location}`);
      }
      current = assertPublicHttpUrl(next.href);
      await assertResolvedPublic(current, lookup);
      continue;
    }

    if (!res.ok) throw new WebError('UPSTREAM_ERROR', `HTTP ${res.status} fetching ${current.href}`);
    const body = await readBodyCapped(res, MAX_BODY_BYTES);
    const contentType = res.headers.get('content-type') ?? '';
    const content = contentType.includes('html') ? extractReadableText(body) : body.slice(0, MAX_TEXT_CHARS);
    return { url: current.href, content };
  }
}
