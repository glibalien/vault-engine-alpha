import { afterEach, expect, it } from 'vitest';
import { inspectionFixture } from './inspection-fixture.js';
import { inspectProvenance } from '../../src/provenance/inspect.js';
import { findAffectedOutputs } from '../../src/provenance/impact.js';
const fixtures: ReturnType<typeof inspectionFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.db.close()));
const fixture = () => {
  const f = inspectionFixture();
  fixtures.push(f);
  return f;
};
it('compares the selected output without changing legacy metadata', () => {
  const { db, source } = fixture();
  const legacy = inspectProvenance(db, {
    select: 'output',
    output_revision_id: 'output',
  });
  expect(legacy).not.toHaveProperty('compared_at');
  if (legacy.select !== 'output') throw Error('selector');
  expect(legacy.inputs[0]).not.toHaveProperty('comparison');
  const read = () =>
    inspectProvenance(db, {
      select: 'output',
      output_revision_id: 'output',
      include_comparisons: true,
    });
  expect(read()).toMatchObject({
    inputs: [{ comparison: 'unchanged' }],
    compared_at: expect.any(String),
  });
  db.prepare(
    "UPDATE nodes SET content_hash='edited',version=2,body=COALESCE(body,'')||' (edited)' WHERE id='source'",
  ).run();
  expect(read()).toMatchObject({ inputs: [{ comparison: 'changed' }] });
  expect(
    findAffectedOutputs(db, { sources: [source] }).outputs[0]?.inputs[0]
      ?.comparison,
  ).toBe('changed');
  db.prepare("DELETE FROM nodes WHERE id='source'").run();
  expect(read()).toMatchObject({ inputs: [{ comparison: 'missing' }] });
  expect(JSON.stringify(read())).not.toContain('PRIVATE SOURCE');
});
it.each([
  "UPDATE provenance_observations SET authority='caller'",
  "UPDATE provenance_observations SET projection='node-token-v1'",
  'UPDATE provenance_observations SET observation_digest=NULL',
])('keeps incomparable observations unknown: %s', (sql) => {
  const { db } = fixture();
  db.prepare(sql).run();
  expect(
    inspectProvenance(db, {
      select: 'output',
      output_revision_id: 'output',
      include_comparisons: true,
    }),
  ).toMatchObject({ inputs: [{ comparison: 'comparison_unknown' }] });
});
it('advertises comparisons without changing capture protocol', () => {
  const { db } = fixture();
  expect(inspectProvenance(db, { select: 'status' })).toMatchObject({
    capability_version: 1,
    inspection_features: expect.arrayContaining([
      'output_input_comparisons_v1',
    ]),
  });
});
it('binds comparison cursors to the mode and exposes expected self transitions', () => {
  const { db } = fixture();
  const input = db.prepare('SELECT * FROM provenance_inputs').get() as Record<
    string,
    unknown
  >;
  const keys = Object.keys(input);
  db.prepare(
    `INSERT INTO provenance_inputs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
  ).run(
    ...keys.map((k) =>
      k === 'id' ? 'second' : k === 'item_key' ? 'second' : input[k],
    ),
  );
  const page = inspectProvenance(db, {
    select: 'output',
    output_revision_id: 'output',
    limit: 1,
    include_comparisons: true,
  });
  if (page.select !== 'output') throw Error('selector');
  expect(page.inputs).toHaveLength(1);
  expect(page.next_cursor).toBeTruthy();
  expect(() =>
    inspectProvenance(db, {
      select: 'output',
      output_revision_id: 'output',
      cursor: page.next_cursor!,
    }),
  ).toThrow('PROVENANCE_LIMIT');
  const next = inspectProvenance(db, {
    select: 'output',
    output_revision_id: 'output',
    limit: 1,
    include_comparisons: true,
    cursor: page.next_cursor!,
  });
  expect(next).toMatchObject({
    inputs: [{ comparison: 'unchanged' }],
    next_cursor: null,
  });
});
it('reports the expected self transition without flagging reverse impact', async () => {
  const { observeNode } = await import('../../src/provenance/observations.js');
  const { canonicalJson } = await import('../../src/provenance/canonical.js');
  const { db } = fixture();
  const old = observeNode(db, 'home');
  db.prepare(
    "UPDATE provenance_sources SET native_id='home',live_node_id='home'",
  ).run();
  db.prepare('UPDATE provenance_observations SET observation_digest=?').run(
    old.observation_digest,
  );
  db.prepare("UPDATE nodes SET version=2 WHERE id='home'").run();
  db.prepare('UPDATE provenance_outputs SET post_commit_observation=?').run(
    canonicalJson(observeNode(db, 'home') as never),
  );
  expect(
    inspectProvenance(db, {
      select: 'output',
      output_revision_id: 'output',
      include_comparisons: true,
    }),
  ).toMatchObject({ inputs: [{ comparison: 'expected_self_transition' }] });
  expect(findAffectedOutputs(db, { sources: [old.source] }).outputs).toEqual(
    [],
  );
});
it('compares metadata and live observations in one read snapshot', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'provenance-inspect-'));
  const { db } = fixture();
  const path = join(directory, 'test.db');
  await db.backup(path);
  const writer = new Database(path);
  writer.pragma('journal_mode=WAL');
  let edited = false;
  const reader = new Database(path, {
    verbose(sql) {
      if (
        !edited &&
        typeof sql === 'string' &&
        sql.startsWith('SELECT id FROM nodes')
      ) {
        edited = true;
        writer
          .prepare(
            "UPDATE nodes SET content_hash='new',version=2,body=COALESCE(body,'')||' (edited)' WHERE id='source'",
          )
          .run();
      }
    },
  });
  try {
    const req = {
      select: 'output' as const,
      output_revision_id: 'output',
      include_comparisons: true,
    };
    expect(inspectProvenance(reader, req)).toMatchObject({
      inputs: [{ comparison: 'unchanged' }],
    });
    expect(edited).toBe(true);
    expect(inspectProvenance(reader, req)).toMatchObject({
      inputs: [{ comparison: 'changed' }],
    });
  } finally {
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
it('uses a retained input transition for a changed merge source in inspection and impact', async () => {
  const { observeNode } = await import('../../src/provenance/observations.js');
  const { db, source } = fixture();
  db.prepare("UPDATE nodes SET version=2,body=COALESCE(body,'')||' (edited)' WHERE id='source'").run();
  db.prepare('UPDATE provenance_observations SET expected_post_commit_observation=?').run(JSON.stringify(observeNode(db, 'source')));
  expect(inspectProvenance(db, { select: 'output', output_revision_id: 'output', include_comparisons: true }))
    .toMatchObject({ inputs: [{ comparison: 'expected_self_transition' }] });
  expect(findAffectedOutputs(db, { sources: [source] }).outputs).toEqual([]);
  db.prepare("DELETE FROM nodes WHERE id='source'").run();
  expect(inspectProvenance(db, { select: 'output', output_revision_id: 'output', include_comparisons: true }))
    .toMatchObject({ inputs: [{ comparison: 'missing' }] });
});
it('does not compare an Engine-looking source from another vault', () => {
  const { db, source } = fixture();
  db.prepare("UPDATE provenance_sources SET namespace='other-vault'").run();
  expect(inspectProvenance(db, { select: 'output', output_revision_id: 'output', include_comparisons: true }))
    .toMatchObject({ inputs: [{ comparison: 'comparison_unknown' }] });
  expect(findAffectedOutputs(db, { sources: [{ ...source, namespace: 'other-vault' }] }).outputs[0]?.inputs[0]?.comparison)
    .toBe('comparison_unknown');
});
it.each(['namespace', 'identity', 'authority', 'projection', 'malformed'] as const)('does not suppress impact with an incompatible %s transition token', async field => {
  const { observeNode } = await import('../../src/provenance/observations.js');
  const { db, source } = fixture();
  db.prepare("UPDATE nodes SET version=2,body=COALESCE(body,'')||' (edited)' WHERE id='source'").run();
  const token = observeNode(db, 'source');
  if (field === 'namespace') token.source.namespace = 'other-vault';
  if (field === 'identity') token.source.native_id = 'other-node';
  if (field === 'authority') token.authority = 'caller';
  if (field === 'projection') token.observation_projection = 'node-token-v1';
  db.prepare('UPDATE provenance_observations SET expected_post_commit_observation=?').run(field === 'malformed' ? '{' : JSON.stringify(token));
  expect(inspectProvenance(db, { select: 'output', output_revision_id: 'output', include_comparisons: true }))
    .toMatchObject({ inputs: [{ comparison: 'changed' }] });
  expect(findAffectedOutputs(db, { sources: [source] }).outputs[0]?.inputs[0]?.comparison).toBe('changed');
});
it('reads a source that only gained links around its words as unchanged (#332)', () => {
  const { db, source } = fixture();
  db.prepare("UPDATE nodes SET content_hash='linked',version=2,body='[[PRIVATE SOURCE]]' WHERE id='source'").run();
  expect(inspectProvenance(db, { select: 'output', output_revision_id: 'output', include_comparisons: true }))
    .toMatchObject({ inputs: [{ comparison: 'unchanged' }] });
  expect(findAffectedOutputs(db, { sources: [source] }).outputs).toEqual([]);
  // A rename is still a change, links or not.
  db.prepare("UPDATE nodes SET title='Renamed',file_path='Renamed.md',version=3 WHERE id='source'").run();
  expect(findAffectedOutputs(db, { sources: [source] }).outputs[0]?.inputs[0]?.comparison).toBe('changed');
});
it('compares an observation from before text hashes as before (#332)', () => {
  const { db, source } = fixture();
  db.prepare('UPDATE provenance_observations SET text_hash=NULL').run();
  db.prepare("UPDATE nodes SET content_hash='linked',version=2,body='[[PRIVATE SOURCE]]' WHERE id='source'").run();
  expect(findAffectedOutputs(db, { sources: [source] }).outputs[0]?.inputs[0]?.comparison).toBe('changed');
});
