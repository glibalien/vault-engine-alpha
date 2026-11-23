import { describe, expect, it } from 'vitest';
import { describeAge, describeDestination } from '../../src/auth/provider.js';

describe('describeDestination', () => {
  it('names the host of a web redirect', () => {
    expect(describeDestination('https://claude.ai/api/mcp/auth_callback')).toBe('claude.ai');
    expect(describeDestination('https://elsewhere.example:8443/cb?x=1')).toBe('elsewhere.example:8443');
  });

  it('says a loopback redirect stays on this computer', () => {
    expect(describeDestination('http://localhost:33418/callback')).toBe('an app on this computer (localhost:33418)');
    expect(describeDestination('http://127.0.0.1:9/cb')).toBe('an app on this computer (127.0.0.1:9)');
    expect(describeDestination('http://[::1]:9/cb')).toBe('an app on this computer ([::1]:9)');
  });

  it('does not mistake a look-alike host for loopback', () => {
    expect(describeDestination('https://localhost.elsewhere.example/cb')).toBe('localhost.elsewhere.example');
  });

  it('names the scheme of an app link and passes an unparseable value through', () => {
    expect(describeDestination('cursor://anysphere.cursor/callback')).toBe('an app registered for cursor:// links');
    expect(describeDestination('not a url')).toBe('not a url');
  });
});

describe('describeAge', () => {
  it('rounds down to minutes, hours and days', () => {
    const now = 1_000_000;
    expect(describeAge(now - 5, now)).toBe('less than a minute ago');
    expect(describeAge(now - 60, now)).toBe('1 minute ago');
    expect(describeAge(now - 59 * 60, now)).toBe('59 minutes ago');
    expect(describeAge(now - 3600, now)).toBe('1 hour ago');
    expect(describeAge(now - 3 * 86400, now)).toBe('3 days ago');
  });

  it('treats a future time as now and an unknown time as unknown', () => {
    expect(describeAge(1_000_100, 1_000_000)).toBe('less than a minute ago');
    expect(describeAge(undefined, 1_000_000)).toBeUndefined();
  });
});
