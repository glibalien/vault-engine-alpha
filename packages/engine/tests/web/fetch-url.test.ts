// packages/engine/tests/web/fetch-url.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  assertPublicHttpUrl,
  createPinnedFetch,
  extractReadableText,
  fetchReadableUrl,
  isBlockedAddress,
  publicOnlyConnectLookup,
  type LookupFn,
} from '../../src/web/fetch-url.js';
import { WebError } from '../../src/web/errors.js';

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup: LookupFn = async () => [{ address: '127.0.0.1', family: 4 }];
const html = (body: string, init?: ResponseInit) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init });

describe('assertPublicHttpUrl (syntactic pre-filter)', () => {
  it('accepts public https', () => {
    expect(assertPublicHttpUrl('https://example.com').hostname).toBe('example.com');
  });
  it.each([
    'http://localhost:3334', 'http://127.0.0.1/x', 'http://10.0.0.1/x', 'http://192.168.1.1',
    'http://172.16.0.9', 'http://[::1]/', 'http://engine.local', 'http://test.localhost:3334/',
    'ftp://example.com', 'not a url',
  ])('rejects %s with a WebError(INVALID_PARAMS)', (url) => {
    try {
      assertPublicHttpUrl(url);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WebError);
      expect((err as WebError).errorCode).toBe('INVALID_PARAMS');
    }
  });
});

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.9', '169.254.1.1', '0.0.0.0',
    '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1',
    '2130706433', '0x7f000001',
    'not-an-ip',
  ])('blocks %s', (a) => expect(isBlockedAddress(a)).toBe(true));

  // Ranges the address library calls unicast (#533).
  it.each([
    '198.18.0.1', '198.19.255.254', '::ffff:198.18.0.1', // benchmarking
    '::7f00:1', '::a00:1', '::808:808', // IPv4-compatible IPv6, whatever address it embeds
    '64:ff9b:1::7f00:1', // local-use NAT64
    '2001:2::1', // IPv6 benchmarking
  ])('blocks %s', (a) => expect(isBlockedAddress(a)).toBe(true));

  it.each([
    '93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:8.8.8.8',
    '198.17.255.255', '198.20.0.1', '2001:4860:4860::8888',
  ])(
    'allows public %s',
    (a) => expect(isBlockedAddress(a)).toBe(false),
  );
});

describe('publicOnlyConnectLookup', () => {
  const run = (lookup: LookupFn, options: { all?: boolean; family?: number }) =>
    new Promise<{ err: Error | null; address?: unknown; family?: number }>((resolve) => {
      publicOnlyConnectLookup(lookup)('host.example', options, (err, address, family) => resolve({ err, address, family }));
    });

  it('hands public addresses to the socket in the shape it asked for', async () => {
    const both: LookupFn = async () => [{ address: '2606:2800:220:1::1', family: 6 }, { address: '93.184.216.34', family: 4 }];
    expect(await run(both, { all: true })).toMatchObject({ err: null, address: [{ address: '2606:2800:220:1::1', family: 6 }, { address: '93.184.216.34', family: 4 }] });
    expect(await run(both, {})).toMatchObject({ err: null, address: '2606:2800:220:1::1', family: 6 });
    expect(await run(both, { family: 4 })).toMatchObject({ err: null, address: '93.184.216.34', family: 4 });
  });

  it('refuses the connection when any answer is not public', async () => {
    const mixed: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
    const { err } = await run(mixed, { all: true });
    expect(err).toBeInstanceOf(WebError);
    expect((err as WebError).errorCode).toBe('INVALID_PARAMS');
    expect(err?.message).toMatch(/non-public address \(10\.0\.0\.5\)/);
  });

  it('reports a name that does not resolve', async () => {
    expect((await run(async () => [], { all: true })).err).toMatchObject({ errorCode: 'UPSTREAM_ERROR' });
    expect((await run(async () => { throw new Error('ENOTFOUND'); }, { all: true })).err).toMatchObject({ errorCode: 'UPSTREAM_ERROR' });
  });
});

describe('connections go only to the checked addresses (#531)', () => {
  let server: Server | undefined;
  let requests = 0;

  /** A page served on this machine's loopback address: the "private" destination. */
  async function loopbackPage(): Promise<number> {
    requests = 0;
    server = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p>Loopback page</p>');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  const toLoopback: LookupFn = async () => [{ address: '127.0.0.1', family: 4 }];

  it('connects where the lookup says, so the check and the connection cannot differ', async () => {
    const port = await loopbackPage();
    // The address check is switched off here only to prove the request really goes to the
    // address the lookup returned and nowhere else.
    const pinned = createPinnedFetch(toLoopback, () => false);
    try {
      const res = await pinned.fetch(`http://page.example:${port}/a`);
      expect(await res.text()).toContain('Loopback page');
      expect(requests).toBe(1);
    } finally {
      await pinned.close();
    }
  });

  it('refuses to connect when the name resolves to a private address', async () => {
    const port = await loopbackPage();
    const pinned = createPinnedFetch(toLoopback);
    try {
      await expect(pinned.fetch(`http://page.example:${port}/a`)).rejects.toThrow();
      expect(requests).toBe(0);
    } finally {
      await pinned.close();
    }
  });

  it('stops a name that answers public for the check and private for the connection', async () => {
    const port = await loopbackPage();
    let lookups = 0;
    const rebinding: LookupFn = async () => (++lookups === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }]);
    await expect(fetchReadableUrl(`http://page.example:${port}/a`, undefined, rebinding)).rejects.toMatchObject({
      name: 'WebError', errorCode: 'INVALID_PARAMS', message: expect.stringMatching(/non-public address \(127\.0\.0\.1\)/),
    });
    expect(lookups).toBe(2);
    expect(requests).toBe(0);
  });
});

describe('extractReadableText', () => {
  it('strips scripts/styles/tags, keeps block breaks, caps length', () => {
    expect(extractReadableText('<style>.a{}</style><h1>Title</h1><p>One</p><p>Two</p>', 9)).toBe('Title\nOne');
  });
});

describe('fetchReadableUrl', () => {
  it('extracts readable text from an html response (public host)', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return html('<html><script>x()</script><body><p>Hello <b>world</b></p></body></html>');
    }) as typeof fetch;
    const out = await fetchReadableUrl('https://example.com/a', fakeFetch, publicLookup);
    expect(out.content).toContain('Hello world');
    expect(out.content).not.toContain('x()');
    expect(calls).toBe(1);
  });

  it('blocks a public hostname that resolves to a private IP (no fetch made)', async () => {
    let called = false;
    const fakeFetch = (async () => { called = true; return html('secret'); }) as typeof fetch;
    await expect(fetchReadableUrl('https://rebind.example/a', fakeFetch, privateLookup))
      .rejects.toMatchObject({ errorCode: 'INVALID_PARAMS' });
    expect(called).toBe(false);
  });

  it('blocks an IPv4-mapped-loopback literal via the range check (no fetch made)', async () => {
    let called = false;
    const fakeFetch = (async () => { called = true; return html('x'); }) as typeof fetch;
    // Not caught by the textual regex; must be caught by the resolved-IP range check.
    await expect(fetchReadableUrl('http://[::ffff:127.0.0.1]/x', fakeFetch, privateLookup))
      .rejects.toMatchObject({ errorCode: 'INVALID_PARAMS' });
    expect(called).toBe(false);
  });

  it('follows a redirect to a public host and returns the final url', async () => {
    const responses = [
      new Response(null, { status: 302, headers: { location: 'https://example.org/final' } }),
      html('<p>done</p>'),
    ];
    let i = 0;
    const fakeFetch = (async () => responses[i++]!) as typeof fetch;
    const out = await fetchReadableUrl('https://example.com/start', fakeFetch, publicLookup);
    expect(out.content).toContain('done');
    expect(out.url).toBe('https://example.org/final');
  });

  it('refuses a redirect that targets a private host; the target is never fetched', async () => {
    const fetched: string[] = [];
    const fakeFetch = (async (url: string | URL) => {
      fetched.push(String(url));
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3334/mcp' } });
    }) as typeof fetch;
    await expect(fetchReadableUrl('https://example.com/start', fakeFetch, publicLookup))
      .rejects.toMatchObject({ errorCode: 'INVALID_PARAMS' });
    expect(fetched).toEqual(['https://example.com/start']);
  });

  it('stops after too many redirects', async () => {
    const fakeFetch = (async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } })) as typeof fetch;
    await expect(fetchReadableUrl('https://example.com/start', fakeFetch, publicLookup))
      .rejects.toMatchObject({ errorCode: 'UPSTREAM_ERROR' });
  });

  it('maps a non-200 response to UPSTREAM_ERROR', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    await expect(fetchReadableUrl('https://example.com/a', fakeFetch, publicLookup))
      .rejects.toMatchObject({ errorCode: 'UPSTREAM_ERROR' });
  });

  it('maps a DNS resolution failure to UPSTREAM_ERROR (no fetch made)', async () => {
    let called = false;
    const fakeFetch = (async () => { called = true; return html('x'); }) as typeof fetch;
    const failingLookup: LookupFn = async () => { throw new Error('ENOTFOUND'); };
    await expect(fetchReadableUrl('https://nope.example/a', fakeFetch, failingLookup))
      .rejects.toMatchObject({ errorCode: 'UPSTREAM_ERROR' });
    expect(called).toBe(false);
  });
});
