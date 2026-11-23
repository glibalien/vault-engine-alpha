import { describe, expect, it } from 'vitest';
import { validateAuthEnv } from '../src/auth/env.js';

describe('validateAuthEnv', () => {
  it('accepts an https issuer with a password', () => {
    const cfg = validateAuthEnv('secret', 'https://curator.example.com');
    expect(cfg.ownerPassword).toBe('secret');
    expect(cfg.issuerUrl.href).toBe('https://curator.example.com/');
  });

  it('accepts http for localhost', () => {
    const cfg = validateAuthEnv('secret', 'http://localhost:3335');
    expect(cfg.issuerUrl.hostname).toBe('localhost');
  });

  it('accepts http for 127.0.0.1', () => {
    const cfg = validateAuthEnv('secret', 'http://127.0.0.1:3335');
    expect(cfg.issuerUrl.hostname).toBe('127.0.0.1');
  });

  it('rejects a missing password', () => {
    expect(() => validateAuthEnv(undefined, 'https://x.example.com')).toThrow(/OAUTH_OWNER_PASSWORD/);
  });

  it('rejects a missing issuer url', () => {
    expect(() => validateAuthEnv('secret', undefined)).toThrow(/OAUTH_ISSUER_URL/);
  });

  it('rejects a malformed issuer url', () => {
    expect(() => validateAuthEnv('secret', 'not a url')).toThrow(/not a valid URL/);
  });

  it('rejects non-https for a non-localhost host', () => {
    expect(() => validateAuthEnv('secret', 'http://curator.example.com')).toThrow(/must use HTTPS/);
  });
});
