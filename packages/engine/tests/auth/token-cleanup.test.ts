import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createAuthSchema } from '../../src/auth/schema.js';
import { runTokenCleanup } from '../../src/auth/token-cleanup.js';

const DAY = 86_400; // unix SECONDS — oauth tables do not use ms
const FIXED_NOW_MS = Date.parse('2026-08-16T12:00:00.000Z');
const now = Math.floor(FIXED_NOW_MS / 1000);

describe('runTokenCleanup', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    db = new Database(':memory:');
    createAuthSchema(db);
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  function seedCode(code: string, expiresAt: number): void {
    db.prepare(
      "INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, created_at, expires_at) VALUES (?, 'c', 'http://x', 'ch', ?, ?)"
    ).run(code, now, expiresAt);
  }

  function seedToken(token: string, expiresAt: number, revoked = 0): void {
    db.prepare(
      "INSERT INTO oauth_tokens (token, type, client_id, created_at, expires_at, revoked) VALUES (?, 'access', 'c', ?, ?, ?)"
    ).run(token, now, expiresAt, revoked);
  }

  it('deletes expired codes, keeps live ones', () => {
    seedCode('dead', now - 60);
    seedCode('live', now + 600);
    const result = runTokenCleanup(db);
    expect(result.codesDeleted).toBe(1);
    expect(db.prepare("SELECT 1 FROM oauth_codes WHERE code = 'live'").get()).toBeDefined();
    expect(db.prepare("SELECT 1 FROM oauth_codes WHERE code = 'dead'").get()).toBeUndefined();
  });

  it('keeps tokens inside the 7-day post-expiry forensic grace window', () => {
    seedToken('expired-2d', now - 2 * DAY);
    runTokenCleanup(db);
    expect(db.prepare("SELECT 1 FROM oauth_tokens WHERE token = 'expired-2d'").get()).toBeDefined();
  });

  it('deletes tokens expired more than 7 days ago', () => {
    seedToken('expired-8d', now - 8 * DAY);
    const result = runTokenCleanup(db);
    expect(result.tokensDeleted).toBe(1);
  });

  it('deletes only past the exact 7-day grace boundary', () => {
    seedToken('at-boundary', now - 7 * DAY);       // exactly at deadline: kept (strict <)
    seedToken('past-boundary', now - 7 * DAY - 1); // one second past: deleted
    const result = runTokenCleanup(db);
    expect(result.tokensDeleted).toBe(1);
    expect(db.prepare("SELECT 1 FROM oauth_tokens WHERE token = 'at-boundary'").get()).toBeDefined();
    expect(db.prepare("SELECT 1 FROM oauth_tokens WHERE token = 'past-boundary'").get()).toBeUndefined();
  });

  it('deletes revoked tokens as soon as they are expired (no grace)', () => {
    seedToken('revoked-expired', now - 60, 1);
    seedToken('revoked-live', now + DAY, 1); // revoked but unexpired → kept (audit)
    const result = runTokenCleanup(db);
    expect(result.tokensDeleted).toBe(1);
    expect(db.prepare("SELECT 1 FROM oauth_tokens WHERE token = 'revoked-live'").get()).toBeDefined();
  });

  it('never touches long-lived service tokens (far-future expiry)', () => {
    seedToken('service', now + 36_500 * DAY); // issue-service-token.ts default ~100y
    runTokenCleanup(db);
    expect(db.prepare("SELECT 1 FROM oauth_tokens WHERE token = 'service'").get()).toBeDefined();
  });

  it('no-ops without throwing when oauth tables do not exist (stdio mode)', () => {
    const bare = new Database(':memory:');
    try {
      expect(() => runTokenCleanup(bare)).not.toThrow();
      expect(runTokenCleanup(bare)).toEqual({ codesDeleted: 0, tokensDeleted: 0 });
    } finally {
      bare.close();
    }
  });
});
