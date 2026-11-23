import { afterEach, expect, it } from 'vitest';
import { inspectionFixture } from './inspection-fixture.js';
import { upgradeToProvenance } from '../../src/provenance/migrate.js';
import { findAffectedOutputs } from '../../src/provenance/impact.js';
import { textHashOf } from '../../src/notes/text-hash.js';

const fixtures: ReturnType<typeof inspectionFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.db.close()));

/** The fixture as a version 3 store: observations without text hashes. */
function atVersion3() {
  const f = inspectionFixture();
  fixtures.push(f);
  f.db.exec("ALTER TABLE provenance_observations DROP COLUMN text_hash; UPDATE meta SET value='3' WHERE key='provenance_schema_version'");
  return f;
}

const textHashes = (db: ReturnType<typeof inspectionFixture>['db']) =>
  db.prepare('SELECT text_hash FROM provenance_observations').all() as Array<{ text_hash: string | null }>;

it('gives an observation of a note still as observed its text hash (#332)', () => {
  const { db, source } = atVersion3();
  upgradeToProvenance(db);
  expect(db.prepare("SELECT value FROM meta WHERE key='provenance_schema_version'").get()).toEqual({ value: '4' });
  expect(textHashes(db)).toEqual([{ text_hash: textHashOf(db, 'source') }]);
  // So a link added after the upgrade is no change.
  db.prepare("UPDATE nodes SET content_hash='linked',version=2,body='[[PRIVATE SOURCE]]' WHERE id='source'").run();
  expect(findAffectedOutputs(db, { sources: [source] }).outputs).toEqual([]);
});

it('gives none to an observation whose note changed before the upgrade', () => {
  const { db, source } = atVersion3();
  db.prepare("UPDATE nodes SET content_hash='linked',version=2,body='[[PRIVATE SOURCE]]' WHERE id='source'").run();
  upgradeToProvenance(db);
  expect(textHashes(db)).toEqual([{ text_hash: null }]);
  expect(findAffectedOutputs(db, { sources: [source] }).outputs[0]?.inputs[0]?.comparison).toBe('changed');
});
