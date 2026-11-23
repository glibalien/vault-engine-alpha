import { afterEach, describe, expect, it } from 'vitest';
import { executeMutation, previewMutation } from '../../src/pipeline/execute.js';
import { setToolWriteHook } from '../../src/settings/hook.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

afterEach(() => setToolWriteHook(null));
describe('pipeline composed effects', () => {
  it('returns preflight state without writes and publishes a composed write only when drained', () => {
    const db = createTestDb();
    const vault = createTempVault();
    const lock = new WriteLockManager();
    try {
      const mutation = { source: 'tool' as const, node_id: null, file_path: 'A.md', title: 'A', types: [], fields: {}, body: 'original' };
      const original = executeMutation(db, lock, vault.vaultPath, mutation);
      const proposed = { ...mutation, node_id: original.node_id, body: 'changed' };
      const observed: string[] = [];
      setToolWriteHook(path => { observed.push(path); });
      const preview = previewMutation(db, lock, vault.vaultPath, proposed);
      expect(preview.rendered_hash).not.toBe(original.rendered_hash);
      expect(preview.validation.valid).toBe(true);
      expect(readFileSync(join(vault.vaultPath, 'A.md'), 'utf8')).toContain('original');
      expect(observed).toEqual([]);
      const afterCommit: Array<() => void> = [];
      const committed = db.transaction(() => executeMutation(db, lock, vault.vaultPath, proposed,
        undefined, undefined, undefined, { afterCommit })).immediate();
      expect(committed.rendered_hash).toBe(preview.rendered_hash);
      expect(observed).toEqual([]);
      afterCommit.forEach(effect => effect());
      expect(observed).toEqual(['A.md']);
      const noop: Array<() => void> = [];
      executeMutation(db, lock, vault.vaultPath, proposed, undefined, undefined, undefined, { afterCommit: noop });
      expect(noop).toEqual([]);
    } finally { db.close(); vault.cleanup(); }
  });
});
