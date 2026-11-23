import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import {
  getStoredSettings, setStoredSettings, getSettingsVersion, isDomainSeeded, markDomainSeeded, readJson,
  getPromptDefaults, setPromptDefaults, getPromptDefaultHashes, setPromptDefaultHashes,
  getPromptOverrideHashes, setPromptOverrideHashes,
} from '../../src/settings/store.js';

describe('settings store', () => {
  it('round-trips a domain patch and bumps the version', () => {
    const db = createTestDb();
    expect(getStoredSettings(db, 'engine')).toEqual({});
    expect(getSettingsVersion(db, 'engine')).toBe(0);
    setStoredSettings(db, 'engine', { backupKeep: 3 });
    expect(getStoredSettings(db, 'engine')).toEqual({ backupKeep: 3 });
    expect(getSettingsVersion(db, 'engine')).toBe(1);
    setStoredSettings(db, 'engine', { backupKeep: 3, normalizeCron: '0 3 * * *' });
    expect(getSettingsVersion(db, 'engine')).toBe(2);
    expect(getSettingsVersion(db, 'wiki')).toBe(0);   // per-domain
  });

  it('tracks seeded flags per domain', () => {
    const db = createTestDb();
    expect(isDomainSeeded(db, 'engine')).toBe(false);
    markDomainSeeded(db, 'engine');
    expect(isDomainSeeded(db, 'engine')).toBe(true);
    expect(isDomainSeeded(db, 'wiki')).toBe(false);
  });

  it('markDomainSeeded is idempotent — the first-seed timestamp survives later calls (update-settings re-marks on every apply)', () => {
    const db = createTestDb();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
      markDomainSeeded(db, 'engine');
      const first = readJson<Record<string, string>>(db, 'settings.seeded', {})['engine'];
      expect(first).toBe('2026-07-13T00:00:00.000Z');
      vi.setSystemTime(new Date('2026-07-13T01:00:00Z'));
      markDomainSeeded(db, 'engine');
      expect(readJson<Record<string, string>>(db, 'settings.seeded', {})['engine']).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives malformed meta JSON: warns and serves the fallback instead of crashing boot', () => {
    const db = createTestDb();
    db.prepare(`INSERT INTO meta (key, value) VALUES ('settings.engine', 'not-json{')`).run();
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getStoredSettings(db, 'engine')).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    // a subsequent write repairs the row
    setStoredSettings(db, 'engine', { backupKeep: 3 });
    expect(getStoredSettings(db, 'engine')).toEqual({ backupKeep: 3 });
  });

  it('round-trips prompt defaults and hashes per domain', () => {
    const db = createTestDb();
    expect(getPromptDefaults(db, 'chat')).toEqual({});
    setPromptDefaults(db, 'chat', { chatSystemPrompt: 'base' });
    setPromptDefaultHashes(db, 'chat', { chatSystemPrompt: 'hash1' });
    setPromptOverrideHashes(db, 'chat', { chatSystemPrompt: 'hash1' });
    expect(getPromptDefaults(db, 'chat')).toEqual({ chatSystemPrompt: 'base' });
    expect(getPromptDefaultHashes(db, 'chat')).toEqual({ chatSystemPrompt: 'hash1' });
    expect(getPromptOverrideHashes(db, 'chat')).toEqual({ chatSystemPrompt: 'hash1' });
    expect(getPromptDefaults(db, 'curator')).toEqual({});
  });
});
