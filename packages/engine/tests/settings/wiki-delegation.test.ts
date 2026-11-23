import { describe, expect, it } from 'vitest';
import { defaultsFor } from '@vault/settings-registry';
import { DEFAULT_WIKI_CONFIG, getWikiConfig, getStoredWikiConfig } from '../../src/wiki/config.js';
import { setStoredSettings, markDomainSeeded } from '../../src/settings/store.js';
import { SettingsService } from '../../src/settings/service.js';
import { createTestDb } from '../helpers/db.js';

describe('wiki config reads the wiki domain and the vault map', () => {
  it('has no defaults of its own: they are the registry\'s wiki and vault defaults', () => {
    expect(DEFAULT_WIKI_CONFIG).toEqual({ ...defaultsFor('wiki'), ...defaultsFor('vault') });
    expect(getWikiConfig(createTestDb())).toEqual(DEFAULT_WIKI_CONFIG);
  });

  it('reads settings.wiki and settings.vault', () => {
    const db = createTestDb();
    markDomainSeeded(db, 'wiki');
    setStoredSettings(db, 'wiki', { subpageCap: 9 });
    setStoredSettings(db, 'vault', { wikiDir: 'FromVault', projectType: null });
    const config = getWikiConfig(db);
    expect(config.subpageCap).toBe(9);
    expect(config.wikiDir).toBe('FromVault');
    expect(config.projectType).toBeNull();
  });

  it('sees a write through an old wiki key', () => {
    const db = createTestDb();
    markDomainSeeded(db, 'wiki');
    new SettingsService(db, { settingsDir: 'Settings' }).applyPatch('wiki', { wikiDir: 'W2', statusDone: ['closed'] });
    expect(getWikiConfig(db)).toMatchObject({ wikiDir: 'W2', taskDoneStatuses: ['closed'] });
  });

  it('getStoredWikiConfig reads the legacy meta.wiki_config blob while the wiki domain is unseeded', () => {
    const db = createTestDb();
    db.prepare(`INSERT INTO meta (key, value) VALUES ('wiki_config', ?)`)
      .run(JSON.stringify({ wikiDir: 'Legacy' }));
    expect(getStoredWikiConfig(db)).toEqual({ wikiDir: 'Legacy' });
  });
});
