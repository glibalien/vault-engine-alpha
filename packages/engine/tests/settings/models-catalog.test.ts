import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { ModelCatalog } from '../../src/settings/models.js';

let db: Database.Database; let vaultPath: string; let cleanup: () => void; let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
  writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
});
afterEach(() => cleanup());

function modelNote(title: string, fields: Record<string, unknown>, body = 'user notes'): void {
  executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: `Settings/Models/${title}.md`,
    title, types: [], fields, body,
  });
}
const catalog = (env: Record<string, string | undefined> = {}) =>
  new ModelCatalog(db, { settingsDir: 'Settings', env });

describe('ModelCatalog', () => {
  it('assembles entries from Models/ nodes and resolves refs', () => {
    modelNote('Qwen 3.7 Plus', { provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p7-plus', enabled: true });
    modelNote('Claude Sonnet 4.6', { provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true });
    const c = catalog();
    expect(c.entries()).toHaveLength(2);
    expect(c.resolve('[[Qwen 3.7 Plus]]')!.model).toBe('accounts/fireworks/models/qwen3p7-plus');
    expect(c.resolve('Claude Sonnet 4.6')!.provider).toBe('anthropic');
    expect(c.resolve('[[Nope]]')).toBeNull();
  });

  // #649: the settings folder's name is read literally, so `_` does not match another folder.
  it('reads model notes only from its own settings folder', () => {
    const note = (dir: string, title: string): void => {
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool', node_id: null, file_path: `${dir}/Models/${title}.md`,
        title, types: [], fields: { provider: 'fireworks', model: `accounts/fireworks/models/${title.toLowerCase()}`, enabled: true }, body: '',
      });
    };
    note('My_Settings', 'Mine');
    note('MyXSettings', 'Other');
    const c = new ModelCatalog(db, { settingsDir: 'My_Settings', env: {} });
    expect(c.entries().map(entry => entry.title)).toEqual(['Mine']);
  });

  it('missing enabled defaults to true; disabled entries exist but do not resolve', () => {
    modelNote('Implicit', { provider: 'fireworks', model: 'accounts/fireworks/models/x' });
    modelNote('Off', { provider: 'fireworks', model: 'accounts/fireworks/models/y', enabled: false });
    const c = catalog();
    expect(c.resolve('Implicit')).not.toBeNull();
    expect(c.entries().find(e => e.title === 'Off')!.enabled).toBe(false);
    expect(c.resolve('Off')).toBeNull();
    expect(c.issues()).toEqual([]);
  });

  it('excludes invalid notes and reports issues without touching files', () => {
    modelNote('Bad Provider', { provider: 'mistral', model: 'mistral-large' });
    modelNote('No Model', { provider: 'fireworks' });
    modelNote('Good', { provider: 'fireworks', model: 'accounts/fireworks/models/z' });
    const c = catalog();
    expect(c.entries().map(e => e.title)).toEqual(['Good']);
    expect(c.issues()).toHaveLength(2);
    expect(c.issues()[0]!.path).toContain('Settings/Models/');
  });

  it('caches until invalidated, and version bumps persist', () => {
    modelNote('A', { provider: 'fireworks', model: 'accounts/fireworks/models/a' });
    const c = catalog();
    expect(c.entries()).toHaveLength(1);
    modelNote('B', { provider: 'fireworks', model: 'accounts/fireworks/models/b' });
    expect(c.entries()).toHaveLength(1);          // cached
    c.invalidate();
    expect(c.entries()).toHaveLength(2);          // reassembled
    expect(c.version()).toBe(0);
    c.bumpVersion();
    expect(c.version()).toBe(1);
    expect(catalog().version()).toBe(1);          // persisted in meta
  });

  it('handles() prefix-matches the Models folder only', () => {
    const c = catalog();
    expect(c.handles('Settings/Models/Qwen 3.7 Plus.md')).toBe(true);
    expect(c.handles('Settings/Engine.md')).toBe(false);
    expect(c.handles('Notes/Models/X.md')).toBe(false);
  });

  it('reports engine-side provider key presence as booleans', () => {
    expect(catalog({ FIREWORKS_API_KEY: 'k', GEMINI_API_KEY: ' ' }).providerKeys())
      .toEqual({ fireworks: true, anthropic: false, gemini: false, openrouter: false, openai: false });
  });

  it('parses capability + pricing frontmatter and accepts openrouter', () => {
    modelNote('Claude Sonnet 5 (OR)', {
      provider: 'openrouter', model: 'anthropic/claude-sonnet-5', enabled: true,
      vision: true, tools: true, context_length: 1000000,
      price_input: 2, price_output: 10, price_cache_read: 0.2, price_cache_write: 2.5,
    });
    const e = catalog().resolve('Claude Sonnet 5 (OR)')!;
    expect(e).toMatchObject({ provider: 'openrouter', vision: true, tools: true, contextLength: 1000000 });
    expect(e.pricing).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
  });

  it('drops malformed optional fields with an issue, keeps the entry', () => {
    modelNote('Weird', { provider: 'fireworks', model: 'm', vision: 'yes', price_input: 2 });
    const c = catalog();
    const e = c.resolve('Weird')!;
    expect(e.vision).toBeUndefined();
    expect(e.pricing).toBeUndefined();   // price_input without price_output
    expect(c.issues().length).toBeGreaterThanOrEqual(2);
  });

  it('reports openrouter key presence', () => {
    expect(catalog({ OPENROUTER_API_KEY: 'k' }).providerKeys().openrouter).toBe(true);
    expect(catalog({}).providerKeys().openrouter).toBe(false);
  });

  it('accepts openai entries with their pricing and reports the OpenAI key', () => {
    modelNote('GPT Test', {
      provider: 'openai', model: 'gpt-test', enabled: true, price_input: 1.25, price_output: 10,
    });
    const c = catalog({ OPENAI_API_KEY: 'k' });
    expect(c.resolve('GPT Test')).toMatchObject({ provider: 'openai', model: 'gpt-test' });
    expect(c.resolve('GPT Test')!.pricing).toEqual({ input: 1.25, output: 10 });
    expect(c.providerKeys().openai).toBe(true);
  });
});
