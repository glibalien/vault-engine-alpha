import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { fullIndex } from '../../src/indexer/indexer.js';

it('uses a bounded number of catalogs for full import, rename, deletion and failed files', () => {
  let scans = 0;
  const db = createTestDb({ verbose: sql => { if (String(sql) === 'SELECT id, file_path, title FROM nodes') scans++; } });
  const vault = mkdtempSync(join(tmpdir(), 'typed-bulk-'));
  try {
    db.prepare("INSERT INTO meta VALUES ('reference_resolution_policy_version', '2')").run();
    createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
    mkdirSync(join(vault, 'Projects')); mkdirSync(join(vault, 'Duplicate'));
    writeFileSync(join(vault, 'Projects/Same.md'), '---\ntypes: [project]\n---\n');
    for (let i = 0; i < 40; i++) writeFileSync(join(vault, `Task${i}.md`), '---\nproject: Same\n---\n');
    scans = 0;
    expect(fullIndex(vault, db)).toMatchObject({ indexed: 41, errors: 0 });
    expect(scans).toBeLessThanOrEqual(2);
    const project = (db.prepare("SELECT id FROM nodes WHERE file_path='Projects/Same.md'").get() as { id: string }).id;
    const targets = () => db.prepare('SELECT DISTINCT resolved_target_id FROM relationships').all();
    expect(targets()).toEqual([{ resolved_target_id: project }]);
    writeFileSync(join(vault, 'Duplicate/Same.md'), '---\ntypes: [project]\n---\nextra');
    expect(fullIndex(vault, db).errors).toBe(0);
    expect(targets()).toEqual([{ resolved_target_id: null }]);
    unlinkSync(join(vault, 'Duplicate/Same.md'));
    fullIndex(vault, db);
    expect(targets()).toEqual([{ resolved_target_id: project }]);
    renameSync(join(vault, 'Projects/Same.md'), join(vault, 'Projects/New.md'));
    expect(fullIndex(vault, db).renamed).toBe(1);
    expect(targets()).toEqual([{ resolved_target_id: null }]);
    writeFileSync(join(vault, 'Duplicate/Same.md'), '---\ntypes: [project]\n---\nextra');
    db.exec("CREATE TRIGGER injected_index_failure BEFORE INSERT ON nodes WHEN NEW.file_path='Broken.md' BEGIN SELECT RAISE(ABORT, 'injected'); END");
    writeFileSync(join(vault, 'Broken.md'), '---\ntypes: [project]\n---\n');
    expect(fullIndex(vault, db)).toMatchObject({ indexed: 1, errors: 1 });
    const duplicate = (db.prepare("SELECT id FROM nodes WHERE file_path='Duplicate/Same.md'").get() as { id: string }).id;
    expect(targets()).toEqual([{ resolved_target_id: duplicate }]);
    db.exec("DROP TRIGGER injected_index_failure");
    writeFileSync(join(vault, 'Projects/Same.md'), '---\ntypes: [project]\n---\nthird');
    db.exec("CREATE TRIGGER reconciliation_failure BEFORE UPDATE ON relationships BEGIN SELECT RAISE(ABORT, 'final reconciliation failed'); END");
    expect(() => fullIndex(vault, db)).toThrow('final reconciliation failed');
    db.exec('DROP TRIGGER reconciliation_failure');
    // Previously committed file batches are repaired on the next full pass,
    // even if every file is now skipped as unchanged.
    expect(fullIndex(vault, db).indexed).toBe(0);
    expect(targets()).toEqual([{ resolved_target_id: null }]);
  } finally { db.close(); rmSync(vault, { recursive: true, force: true }); }
});
