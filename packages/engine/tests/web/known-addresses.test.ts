// packages/engine/tests/web/known-addresses.test.ts
import { describe, it, expect } from 'vitest';
import { KnownWebAddresses, addressKey, fetchesKnownAddressesOnly } from '../../src/web/known-addresses.js';

const OAUTH_CLIENT = '3f8a5c2e-0000-4000-8000-000000000000';

describe('fetchesKnownAddressesOnly', () => {
  it('restricts a client that signed in through the OAuth flow, and nobody else', () => {
    expect(fetchesKnownAddressesOnly(OAUTH_CLIENT)).toBe(true);
    expect(fetchesKnownAddressesOnly('service-curator')).toBe(false);
    expect(fetchesKnownAddressesOnly(undefined)).toBe(false);
  });
});

describe('addressKey', () => {
  it('drops the fragment and nothing else', () => {
    expect(addressKey('https://example.com/a#part')).toBe('https://example.com/a');
    expect(addressKey(' https://EXAMPLE.com/a ')).toBe('https://example.com/a');
    expect(addressKey('https://example.com/a?d=1')).not.toBe(addressKey('https://example.com/a'));
    expect(addressKey('https://example.com/a/')).not.toBe(addressKey('https://example.com/a'));
    expect(addressKey('http://example.com/a')).not.toBe(addressKey('https://example.com/a'));
  });

  it('is null for text that is not an absolute URL', () => {
    expect(addressKey('example.com/a')).toBeNull();
    expect(addressKey('')).toBeNull();
  });
});

describe('KnownWebAddresses', () => {
  it('knows an address only for the client it was returned to', () => {
    const known = new KnownWebAddresses();
    known.remember(OAUTH_CLIENT, ['https://example.com/a', 'not a url']);
    expect(known.has(OAUTH_CLIENT, 'https://example.com/a')).toBe(true);
    expect(known.has(OAUTH_CLIENT, 'https://example.com/a#top')).toBe(true);
    expect(known.has(OAUTH_CLIENT, 'https://example.com/a?d=secret')).toBe(false);
    expect(known.has(OAUTH_CLIENT, 'https://example.com/a/secret')).toBe(false);
    expect(known.has(OAUTH_CLIENT, 'not a url')).toBe(false);
    expect(known.has('another-client', 'https://example.com/a')).toBe(false);
  });

  it('keeps the newest addresses of a client when it reaches its limit', () => {
    const known = new KnownWebAddresses(2);
    known.remember(OAUTH_CLIENT, ['https://example.com/1', 'https://example.com/2']);
    known.remember(OAUTH_CLIENT, ['https://example.com/1']); // returned again: now the newest
    known.remember(OAUTH_CLIENT, ['https://example.com/3']);
    expect(known.has(OAUTH_CLIENT, 'https://example.com/1')).toBe(true);
    expect(known.has(OAUTH_CLIENT, 'https://example.com/2')).toBe(false);
    expect(known.has(OAUTH_CLIENT, 'https://example.com/3')).toBe(true);
  });

  it('forgets the client that searched longest ago when there are too many', () => {
    const known = new KnownWebAddresses(10, 2);
    known.remember('client-a', ['https://example.com/a']);
    known.remember('client-b', ['https://example.com/b']);
    known.remember('client-a', ['https://example.com/a2']); // client-a is now the most recent
    known.remember('client-c', ['https://example.com/c']);
    expect(known.has('client-a', 'https://example.com/a')).toBe(true);
    expect(known.has('client-b', 'https://example.com/b')).toBe(false);
    expect(known.has('client-c', 'https://example.com/c')).toBe(true);
  });
});
