import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { observeNode, observeMemory, validateObservations, observeEvidenceNodes } from '../../src/provenance/observations.js';

const dbs: ReturnType<typeof createTestDb>[] = [];
function fixture() {
  const db = createTestDb(); dbs.push(db);
  db.prepare('INSERT INTO nodes(id,file_path,title,body,content_hash,version) VALUES (?,?,?,?,?,?)').run('note', 'Note.md', 'Note', 'before', 'hash1', 1);
  return db;
}
afterEach(() => dbs.splice(0).forEach(db => db.close()));
describe('source observation tokens', () => {
  it('detects changed version/hash and missing identity without retaining read history', () => {
    const db = fixture(); const observed = observeNode(db, 'note');
    expect(observed.source.native_id).toBe('note');
    expect(observed.hash_semantics).toBe('engine_content_hash');
    expect(() => validateObservations(db, [observed])).not.toThrow();
    db.prepare('UPDATE nodes SET content_hash=? WHERE id=?').run('hash2', 'note');
    expect(() => validateObservations(db, [observed])).toThrow('PROVENANCE_OBSERVATION_CHANGED');
    const after = observeNode(db, 'note');
    db.prepare('DELETE FROM nodes WHERE id=?').run('note');
    db.prepare('INSERT INTO nodes(id,file_path,body) VALUES (?,?,?)').run('replacement', 'Note.md', 'before');
    expect(() => validateObservations(db, [after])).toThrow('PROVENANCE_OBSERVATION_CHANGED');
    expect(db.prepare('SELECT count(*) AS n FROM provenance_sources').get()).toEqual({ n: 0 });
  });
  it.each(['title', 'file_path'])('detects an offline %s change without a version/hash bump', field => {
    const db = fixture(); const observed = observeNode(db, 'note');
    db.prepare(`UPDATE nodes SET ${field}=? WHERE id='note'`).run('Renamed.md');
    expect(observeNode(db, 'note').source).toEqual(observed.source);
    expect(observeNode(db, 'note').observation_digest).not.toBe(observed.observation_digest);
    expect(() => validateObservations(db, [observed])).toThrow('PROVENANCE_OBSERVATION_CHANGED');
  });
  it('uses a selected memory projection and detects lifecycle changes', () => {
    const db = fixture();
    db.prepare("INSERT INTO memories(id,source,scope,content,category,created_at,updated_at) VALUES (1,'owner','vault','Remember','facts','2026-01-01','2026-01-01')").run();
    const observed = observeMemory(db, 1);
    expect(observed.native_version).toBeNull();
    expect(() => validateObservations(db, [observed])).not.toThrow();
    db.prepare("UPDATE memories SET expired_at='2026-09-17' WHERE id=1").run();
    expect(() => validateObservations(db, [observed])).toThrow('PROVENANCE_OBSERVATION_CHANGED');
  });
  it('cannot downgrade an Engine source to caller attestation', () => {
    const db = fixture(); const observed = observeNode(db, 'note');
    expect(() => validateObservations(db, [{ ...observed, authority: 'caller' }])).toThrow();
    expect(() => validateObservations(db, [{ ...observed, source: { ...observed.source, namespace: 'foreign' } }])).toThrow();
  });
});


it('prioritizes explicitly selected represented IDs over unrendered evidence, keeping the metadata cap', () => {
  const db = fixture();
  const other = Array.from({ length: 513 }, (_, i) => ({ id: `a${i}` }));
  for (const { id } of other) db.prepare('INSERT INTO nodes(id,file_path,title) VALUES (?,?,?)').run(id, `${id}.md`, id);
  const evidence = { project: { id: 'note' }, tasks: other };
  expect(observeEvidenceNodes(db, evidence).nodes.note).toBeUndefined();
  const selected = observeEvidenceNodes(db, evidence, ['note', 'a0', 'not-represented']);
  expect(Object.keys(selected.nodes)).toEqual(['note', 'a0']);
  expect(selected.nodes.note).toEqual(observeNode(db, 'note', selected.nodes.note!.observed_at));
  expect(() => observeEvidenceNodes(db, evidence, other.map(n => n.id))).toThrow('PROVENANCE_LIMIT');
});
