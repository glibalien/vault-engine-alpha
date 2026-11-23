import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { captureLinkBindings, restoreLinkBindings } from '../../src/undo/link-bindings.js';

// Bindings an operation records and a restore puts back (#665).

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
  db.prepare("INSERT INTO undo_operations (operation_id, timestamp, source_tool, description) VALUES ('op1', 1, 'merge-nodes', 'merge')").run();
});

afterEach(() => {
  db.close();
  cleanup();
});

function note(path: string, types: string[], fields: Record<string, unknown> = {}, body = ''): string {
  const title = path.split('/').pop()!.replace(/\.md$/, '');
  return executeMutation(db, writeLock, vaultPath, { source: 'tool', node_id: null, file_path: path, title, types, fields, body }).node_id;
}
const boundTo = (source: string): Array<{ rel: string; to: string | null }> =>
  db.prepare('SELECT rel_type AS rel, resolved_target_id AS "to" FROM relationships WHERE source_id = ? ORDER BY rel_type').all(source) as Array<{ rel: string; to: string | null }>;

/** A meeting whose `lead` field and text both link Sam; the two links are recorded, then unbound. */
function recordedAndUnbound(): { sam: string; meeting: string } {
  createSchemaDefinition(db, { name: 'person', field_claims: [] });
  createGlobalField(db, { name: 'lead', field_type: 'reference', reference_target: 'person' });
  // Policy 1 reads a reference only where one of the note's kinds claims the field.
  createSchemaDefinition(db, { name: 'meeting', field_claims: [{ field: 'lead' }] });
  const sam = note('People/Sam.md', ['person']);
  const meeting = note('Meetings/Kickoff.md', ['meeting'], { lead: 'Sam' }, 'With [[Sam]].');
  expect(boundTo(meeting)).toEqual([{ rel: 'lead', to: sam }, { rel: 'wiki-link', to: sam }]);
  captureLinkBindings(db, 'op1', [sam]);
  db.prepare('UPDATE relationships SET resolved_target_id = NULL WHERE source_id = ?').run(meeting);
  return { sam, meeting };
}

describe('restoreLinkBindings', () => {
  it('binds every recorded link back under reference policy 1', () => {
    const { sam, meeting } = recordedAndUnbound();
    expect(restoreLinkBindings(db, 'op1')).toBe(2);
    expect(boundTo(meeting)).toEqual([{ rel: 'lead', to: sam }, { rel: 'wiki-link', to: sam }]);
  });

  it('leaves a typed reference to the current rules under reference policy 2 (Codex, #680)', () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', '2')").run();
    const { sam, meeting } = recordedAndUnbound();
    // The field's definition may have changed since the operation; restoring a note recomputes
    // typed references against it, so the old binding is not put back.
    expect(restoreLinkBindings(db, 'op1')).toBe(1);
    expect(boundTo(meeting)).toEqual([{ rel: 'lead', to: null }, { rel: 'wiki-link', to: sam }]);
  });

  it('binds nothing to a note that is not there', () => {
    const { sam, meeting } = recordedAndUnbound();
    db.prepare('DELETE FROM nodes WHERE id = ?').run(sam);
    expect(restoreLinkBindings(db, 'op1')).toBe(0);
    expect(boundTo(meeting)).toEqual([{ rel: 'lead', to: null }, { rel: 'wiki-link', to: null }]);
  });
});
