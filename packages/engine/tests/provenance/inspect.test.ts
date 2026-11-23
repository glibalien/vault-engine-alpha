import { inspectionFixture } from './inspection-fixture.js';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { encodeCursor, inputPosition, inspectProvenance } from '../../src/provenance/inspect.js';
import { findAffectedOutputs } from '../../src/provenance/impact.js';
import { observeNode } from '../../src/provenance/observations.js';
import { canonicalJson, digestJson } from '../../src/provenance/canonical.js';

const dbs: ReturnType<typeof createTestDb>[] = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));
function fixture() { const f = inspectionFixture(); dbs.push(f.db); return f; }
describe('bounded provenance inspection', () => {
  it('separates metadata from retained text, and reports restore uncertainty', () => {
    const { db } = fixture();
    const status = inspectProvenance(db, { select: 'status' });
    expect(status).toMatchObject({ capability_version: 1, capture_features: ['project-subpage-v1', 'multi-output-reconcile-v1'], purge_restore_verification: 'unverified' });
    const result = inspectProvenance(db, { select: 'output', output_revision_id: 'output' });
    expect(result).toMatchObject({ output: { currentness: 'matches' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE SOURCE');
    expect(JSON.stringify(result)).not.toContain('aé😀z');
    expect(JSON.stringify(result)).not.toContain('Generated');
  });
  it('reports where each input begins in the request, so a reader can list them in order (#551)', () => {
    const { db } = fixture();
    const stored = db.prepare('SELECT spans FROM provenance_inputs').all() as Array<{ spans: string }>;
    const result = inspectProvenance(db, { select: 'output', output_revision_id: 'output' });
    if (result.select !== 'output') throw new Error('wrong variant');
    expect(result.inputs.map(input => input.position)).toEqual(stored.map(row => inputPosition(row.spans)));
    expect(result.inputs.every(input => input.position != null && Number.isInteger(input.position.start))).toBe(true);
    expect(JSON.stringify(result.inputs)).not.toContain('"spans"');
    // Spans are dropped by a purge; the position goes with them.
    db.prepare('UPDATE provenance_inputs SET spans=NULL').run();
    const purged = inspectProvenance(db, { select: 'output', output_revision_id: 'output' });
    if (purged.select !== 'output') throw new Error('wrong variant');
    expect(purged.inputs.map(input => input.position)).toEqual(purged.inputs.map(() => null));
  });
  it('takes the earliest start in the first span\'s field, and ignores spans it cannot read', () => {
    expect(inputPosition(JSON.stringify([{ end: 9, field: 'evidence', start: 7 }, { end: 3, field: 'system', start: 1 },
      { end: 5, field: 'evidence', start: 4 }]))).toEqual({ field: 'evidence', start: 4 });
    expect(inputPosition(null)).toBeNull();
    expect(inputPosition('[]')).toBeNull();
    expect(inputPosition('not json')).toBeNull();
  });
  it('pages retained UTF-8 text without splitting code points', () => {
    const { db } = fixture();
    const payload = db.prepare("SELECT id FROM provenance_payloads WHERE kind='request'").get() as { id: string };
    const expected = (db.prepare('SELECT text FROM provenance_payloads WHERE id=?').get(payload.id) as { text: string }).text;
    let cursor: string | undefined; let text = '';
    do {
      const page = inspectProvenance(db, { select: 'text', payload_id: payload.id, max_bytes: 4, ...(cursor ? { cursor } : {}) });
      if (page.select !== 'text') throw new Error('wrong variant');
      expect(page.end - page.start).toBeLessThanOrEqual(4);
      text += page.text; cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(text).toBe(expected);
    expect(() => inspectProvenance(db, { select: 'text', payload_id: payload.id, cursor: 'bad' })).toThrow();
  });
  it('finds changed or deleted direct sources without claiming the output is false', () => {
    const { db, source } = fixture();
    expect(findAffectedOutputs(db, { sources: [source] }).outputs).toEqual([]);
    db.prepare("UPDATE nodes SET content_hash='two',version=2,body=COALESCE(body,'')||' (edited)' WHERE id='source'").run();
    const changed = findAffectedOutputs(db, { sources: [source] });
    expect(changed.outputs).toHaveLength(1);
    expect(changed.outputs[0]!.inputs[0]!.comparison).toBe('changed');
    expect(changed.coverage).toBe('captured_direct_dependencies_only');
    db.prepare("DELETE FROM nodes WHERE id='source'").run();
    expect(findAffectedOutputs(db, { sources: [source] }).outputs[0]!.inputs[0]!.comparison).toBe('missing');
    expect(inspectProvenance(db, { select: 'output', output_revision_id: 'output' })).toMatchObject({ output: { availability: 'retained' } });
  });
  it('finds offline source renames even when content hash and version are unchanged', () => {
    const { db, source } = fixture();
    db.prepare("UPDATE nodes SET title='Renamed',file_path='Renamed.md' WHERE id='source'").run();
    expect(findAffectedOutputs(db, { sources: [source] }).outputs[0]?.inputs[0]?.comparison).toBe('changed');
  });
  it('does not claim unchanged for legacy node observations without rename coverage', () => {
    const { db, source } = fixture();
    db.prepare("UPDATE provenance_observations SET projection='node-token-v1'").run();
    expect(findAffectedOutputs(db, { sources: [source] }).outputs[0]?.inputs[0]?.comparison).toBe('comparison_unknown');
  });
  it.each([
    '<!-- ve:managed:Now -->\nConflict\n<!-- /ve:managed:Now -->',
    '<!-- ve:managed:Broken -->\nUnclosed',
    '<!-- /ve:managed:Missing -->',
  ])('marks structurally invalid current bodies unknown: %s', suffix => {
    const { db } = fixture();
    db.prepare("UPDATE nodes SET body=body || ? WHERE id='home'").run('\n\n' + suffix);
    expect(inspectProvenance(db, { select: 'output', output_revision_id: 'output' })).toMatchObject({ output: { currentness: 'unknown' } });
  });
  it('suppresses the expected home self-transition and ignores unrelated live or human text', () => {
    const { db } = fixture();
    const old = observeNode(db, 'home');
    const source = db.prepare("SELECT id FROM provenance_sources").get() as { id: string };
    db.prepare("UPDATE provenance_sources SET native_id='home',live_node_id='home' WHERE id=?").run(source.id);
    db.prepare('UPDATE provenance_observations SET observation_digest=?').run(old.observation_digest);
    db.prepare("UPDATE nodes SET version=2 WHERE id='home'").run();
    db.prepare('UPDATE provenance_outputs SET post_commit_observation=?').run(canonicalJson(observeNode(db, 'home') as never));
    expect(findAffectedOutputs(db, { sources: [old.source] }).outputs).toEqual([]);
    db.prepare("UPDATE nodes SET body=body || '\nHuman text outside managed sections' WHERE id='home'").run();
    expect(inspectProvenance(db, { select: 'node', node_id: 'home' })).toMatchObject({ current_provenance: 'captured' });
    db.prepare("UPDATE nodes SET version=3 WHERE id='home'").run();
    expect(findAffectedOutputs(db, { sources: [old.source] }).outputs[0]?.inputs[0]?.comparison).toBe('changed');
  });
  it('marks unknown legacy and subsequent uncaptured changes distinctly', () => {
    const { db } = fixture();
    expect(inspectProvenance(db, { select: 'node', node_id: 'source' })).toMatchObject({ current_provenance: 'unknown_legacy' });
    expect(inspectProvenance(db, { select: 'node', node_id: 'home' })).toMatchObject({ current_provenance: 'captured' });
    db.prepare("UPDATE nodes SET body='Human replacement' WHERE id='home'").run();
    expect(inspectProvenance(db, { select: 'node', node_id: 'home' })).toMatchObject({ current_provenance: 'not_recorded' });
  });
  it('rejects legacy history cursors and restarts in committed node-version order', () => {
    const { db } = fixture();
    const derivation = db.prepare('SELECT * FROM provenance_derivations').get() as Record<string, unknown>;
    const output = db.prepare('SELECT * FROM provenance_outputs').get() as Record<string, unknown>;
    const contribution = db.prepare("SELECT * FROM provenance_payloads WHERE kind='contribution'").get() as Record<string, unknown>;
    const newerDerivationId = randomUUID();
    const olderId = 'f0000000-0000-4000-8000-000000000001';
    const newerId = '10000000-0000-4000-8000-000000000002';
    function insert(table: string, row: Record<string, unknown>) {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]));
    }
    db.transaction(() => {
      db.prepare("UPDATE provenance_outputs SET id=?,committed_at='2026-09-21T12:00:00.000Z'").run(olderId);
      db.prepare("UPDATE provenance_derivations SET availability='purged'").run();
      insert('provenance_derivations', { ...derivation, id: newerDerivationId, attempt_key: randomUUID(), availability: 'retained' });
      insert('provenance_payloads', { ...contribution, id: randomUUID(), derivation_id: newerDerivationId });
      insert('provenance_outputs', { ...output, id: newerId, derivation_id: newerDerivationId, node_version: 2,
        committed_at: '2026-09-21T12:00:00.000Z', reconcile_key: randomUUID() });
    })();
    // The pre-upgrade order returns the older version first when timestamps tie.
    const legacyFirst = db.prepare(`SELECT id,committed_at,node_version FROM provenance_outputs
      WHERE node_id='home' ORDER BY committed_at DESC,id DESC LIMIT 1`).get() as
      { id: string; committed_at: string; node_version: number };
    expect(legacyFirst).toEqual({ id: olderId, committed_at: '2026-09-21T12:00:00.000Z', node_version: 1 });
    const legacyCursor = encodeCursor('node:home', [legacyFirst.committed_at, legacyFirst.id]);
    // Translating this anchor would silently skip the unseen newer version.
    expect(() => inspectProvenance(db, { select: 'node', node_id: 'home', limit: 1, cursor: legacyCursor }))
      .toThrow('PROVENANCE_LIMIT');
    // Restart without a cursor, then follow the new cursor through every output.
    const first = inspectProvenance(db, { select: 'node', node_id: 'home', limit: 1 });
    expect(first).toMatchObject({ current_provenance: 'captured', outputs: [{ receipt: { output_revision_id: newerId } }] });
    if (first.select !== 'node' || !first.next_cursor) throw new Error('missing history cursor');
    expect(inspectProvenance(db, { select: 'node', node_id: 'home', limit: 1, cursor: first.next_cursor }))
      .toMatchObject({ current_provenance: 'captured', outputs: [{ receipt: { output_revision_id: olderId } }], next_cursor: null });
    const missingAnchor = encodeCursor('node:home', ['2026-09-21T12:00:00.001Z', newerId]);
    expect(() => inspectProvenance(db, { select: 'node', node_id: 'home', limit: 1, cursor: missingAnchor }))
      .toThrow('PROVENANCE_LIMIT');
  });
  it('distinguishes a new untracked home after project activation from unknown history', () => {
    const { db } = fixture();
    db.prepare("INSERT INTO provenance_flow_activations VALUES ('source','project-home-v1','2026-09-17T00:00:00Z')").run();
    db.prepare("INSERT INTO nodes(id,file_path,created_at) VALUES ('newhome','New.md',?)").run(Date.parse('2026-09-18T00:00:00Z'));
    db.exec("INSERT INTO schemas(name,display_name,field_claims) VALUES ('wiki','Wiki','[]'),('project','Project','[]'); INSERT INTO node_types(node_id,schema_type) VALUES ('newhome','wiki'),('source','project');");
    db.prepare("INSERT INTO relationships(source_id,target,resolved_target_id,rel_type) VALUES ('newhome','Source','source','wiki_for')").run();
    expect(inspectProvenance(db, { select: 'node', node_id: 'newhome' })).toMatchObject({ current_provenance: 'not_recorded' });
    db.prepare("UPDATE nodes SET created_at=NULL WHERE id='newhome'").run();
    expect(inspectProvenance(db, { select: 'node', node_id: 'newhome' })).toMatchObject({ current_provenance: 'unknown_legacy' });
  });
  it('advances the work cursor even when currentness filtering returns no outputs', () => {
    const { db, source } = fixture();
    const original = db.prepare('SELECT * FROM provenance_derivations').get() as Record<string, unknown>;
    const observation = db.prepare('SELECT * FROM provenance_observations').get() as Record<string, unknown>;
    const input = db.prepare('SELECT * FROM provenance_inputs').get() as Record<string, unknown>;
    const output = db.prepare('SELECT * FROM provenance_outputs').get() as Record<string, unknown>;
    const payload = db.prepare("SELECT * FROM provenance_payloads WHERE kind='contribution'").get() as Record<string, unknown>;
    function insert(table: string, row: Record<string, unknown>) {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k]));
    }
    db.transaction(() => {
      for (let group = 0; group < 3; group++) {
        const derivation = randomUUID(); const obs = randomUUID();
        insert('provenance_derivations', { ...original, id: derivation, attempt_key: randomUUID() });
        insert('provenance_observations', { ...observation, id: obs, derivation_id: derivation });
        insert('provenance_outputs', { ...output, id: `output-${group}`, derivation_id: derivation, reconcile_key: randomUUID() });
        insert('provenance_payloads', { ...payload, id: randomUUID(), derivation_id: derivation });
        for (let index = 0; index < 400; index++) insert('provenance_inputs', {
          ...input, id: randomUUID(), derivation_id: derivation, observation_id: obs, item_key: String(index),
        });
      }
    })();
    db.prepare("UPDATE nodes SET content_hash='two',version=2,body=COALESCE(body,'')||' (edited)' WHERE id='source'").run();
    const first = findAffectedOutputs(db, { sources: [source], currentness: 'historical' });
    expect(first.outputs).toEqual([]);
    expect(first.comparisons).toBe(1000);
    expect(first.next_cursor).not.toBeNull();
    const next = findAffectedOutputs(db, { sources: [source], currentness: 'historical', cursor: first.next_cursor! });
    expect(next.comparisons).toBe(201);
    expect(next.next_cursor).toBeNull();
    const all = findAffectedOutputs(db, { sources: [source], limit: 1 });
    expect(all.outputs).toHaveLength(1);
    expect(all.next_cursor).not.toBeNull();
  });
});
it('classifies homes and subpages using their separate activation rows and actual wiki identity', () => {
  const { db } = fixture();
  db.exec(`INSERT INTO schemas(name,display_name,field_claims) VALUES ('wiki','Wiki','[]'),('project','Project','[]');
    INSERT INTO node_types(node_id,schema_type) VALUES ('source','project'),('home','wiki');
    INSERT INTO nodes(id,file_path,created_at) VALUES ('page','Page.md',1790726400000),('uncaptured-home','New home.md',1790726400000),('ordinary','Ordinary.md',1790726400000);
    INSERT INTO node_types(node_id,schema_type) VALUES ('page','wiki'),('uncaptured-home','wiki');
    INSERT INTO relationships(source_id,target,resolved_target_id,rel_type) VALUES
      ('home','Source','source','wiki_for'),('page','Source','source','wiki_for'),
      ('page','Home','home','wiki_parent'),('uncaptured-home','Source','source','wiki_for'),('ordinary','Source','source','wiki_for');
    INSERT INTO provenance_flow_activations VALUES ('source','project-home-v1','2026-09-17T00:00:00Z');`);
  const read = (id: string) => inspectProvenance(db, { select: 'node', node_id: id });
  expect(read('page')).toMatchObject({ current_provenance: 'unknown_legacy' });
  expect(read('uncaptured-home')).toMatchObject({ current_provenance: 'not_recorded' });
  expect(read('ordinary')).toMatchObject({ current_provenance: 'unknown_legacy' });
  db.prepare("INSERT INTO provenance_flow_activations VALUES ('source','project-subpage-v1','2026-09-18T00:00:00Z')").run();
  expect(read('page')).toMatchObject({ current_provenance: 'not_recorded' });
  db.prepare("UPDATE nodes SET created_at=NULL WHERE id='page'").run();
  expect(read('page')).toMatchObject({ current_provenance: 'unknown_legacy' });
  db.prepare("DELETE FROM provenance_flow_activations WHERE flow='project-home-v1'").run();
  expect(read('uncaptured-home')).toMatchObject({ current_provenance: 'unknown_legacy' });
});
it.each([-1, 0, 1])('preserves legacy classification at %i milliseconds from first flow activation', delta => {
  const { db } = fixture(); const activation = '2026-09-25T00:00:00.500Z';
  db.exec(`INSERT INTO schemas(name,display_name,field_claims) VALUES ('wiki','Wiki','[]'),('project','Project','[]');
    INSERT INTO node_types(node_id,schema_type) VALUES ('source','project');
    INSERT INTO nodes(id,file_path) VALUES ('page','Page.md');
    INSERT INTO node_types(node_id,schema_type) VALUES ('page','wiki');
    INSERT INTO relationships(source_id,target,resolved_target_id,rel_type) VALUES ('page','Source','source','wiki_for'),('page','Home','home','wiki_parent');`);
  db.prepare("INSERT INTO provenance_flow_activations VALUES ('source','project-subpage-v1',?)").run(activation);
  db.prepare("UPDATE nodes SET created_at=? WHERE id='page'").run(Date.parse(activation) + delta);
  expect(inspectProvenance(db, { select: 'node', node_id: 'page' })).toMatchObject({ current_provenance: delta > 0 ? 'not_recorded' : 'unknown_legacy' });
});
