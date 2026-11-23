import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, runMigrations } from '../src/db/migrate.js';
import { commitTopicRefreshBaseline, observedTopicRefreshSources } from '../src/db/topic-refresh.js';
import { topicVaultSourceFingerprint } from '../src/topic-refresh-evidence.js';
import { admitTopicRefresh } from '../src/topic-refresh-admission.js';
const ts = '2026-09-27T00:00:00.000Z';
describe('excerpt baseline freshness', () => {
  it('persists selection and compares full reads without a refresh loop', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const read = { nodeId: 'n', state: 'present' as const, title: 'Source', types: ['note'], renderedBody: 'start\n\nold end' };
    const fingerprint = () => topicVaultSourceFingerprint({ nodeId: read.nodeId, title: read.title, types: read.types, renderedBody: read.renderedBody, bodyIncluded: true });
    const commit = () => {
      const f = fingerprint();
      commitTopicRefreshBaseline(db, { rootTitle: 'Topic', sourceCommittedAt: ts, observedSourceNodeIds: ['n'],
        sourceProjections: [{ nodeId: 'n', titleAtCommit: 'Source', evidenceState: 'present', bodyIncluded: 1,
          fingerprintVersion: 1, evidenceHash: 'e'.repeat(64), capturedAt: ts,
          selection: { version: 1, freshnessVersion: 1, freshnessHash: f.hash, inputHash: 'e'.repeat(64),
            policyVersion: 1, bodyCharCap: null, spans: [{ startByte: 0, endByte: 5 }],
            spansTruncated: false, originalBytes: Buffer.byteLength(read.renderedBody), retainedBytes: 5 } }] });
    };
    const admit = () => admitTopicRefresh({ scheduled: true, force: false, cadenceDue: false,
      earlyRefreshEnabled: true, persistProbeCache: false }, {
      loadState: () => ({ pendingSourceChange: false, pendingBaselineRetry: false, sourceCommittedAt: ts,
        committedSources: observedTopicRefreshSources(db, 'Topic') }),
      readCommittedSources: async () => ({ results: [read] }),
      probeWeb: async () => ({ ok: false, reason: 'web_probe_overflow' as const }),
      assessWeb: async () => { throw new Error('no assessment expected'); },
      budget: { tryConsumeNovelCall: () => false, remaining: () => 0 },
    });
    commit();
    expect(observedTopicRefreshSources(db, 'Topic')[0]).toMatchObject({ freshness_hash: fingerprint().hash,
      freshness_version: 1, selection_json: expect.any(String) });
    expect((await admit()).changedSourceNodeIds).toEqual([]);
    read.renderedBody += '\nnew relevant end';
    expect((await admit()).changedSourceNodeIds).toEqual(['n']);
    commit();
    expect((await admit()).changedSourceNodeIds).toEqual([]);
    db.close();
  });
  it('rolls back all new migration columns and version if the transaction fails', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(m => m.version <= 19));
    const m = MIGRATIONS.find(m => m.version === 20)!;
    expect(m).toBeDefined();
    expect(() => runMigrations(db, [{ ...m, up: database => { m.up(database); throw new Error('injected'); } }])).toThrow('injected');
    expect(db.pragma('user_version', { simple: true })).toBe(19);
    expect((db.pragma('table_info(topic_refresh_sources)') as { name: string }[]).map(r => r.name)).not.toContain('selection_json');
    runMigrations(db); runMigrations(db); expect(db.pragma('user_version', { simple: true })).toBe(41);
    db.close();
  });
});
