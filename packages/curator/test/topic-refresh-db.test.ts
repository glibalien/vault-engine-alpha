import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  commitTopicRefreshBaseline,
  deleteTopicRefreshState,
  explicitTopicRefreshSources,
  observedTopicRefreshSources,
  replaceExplicitTopicRefreshSources,
  storeTopicProbeCache,
  topicRefreshState,
  type TopicCommittedSourceProjection,
  type TopicProbeCacheInput,
  type TopicRefreshCommitInput,
} from '../src/db/topic-refresh.js';
import { buildCanonicalWebProbe, type CanonicalWebProbe } from '../src/topic-refresh-evidence.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const T1 = '2026-08-30T12:00:00.000Z';
const T2 = '2026-08-30T13:00:00.000Z';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function projection(
  nodeId: string,
  overrides: Partial<TopicCommittedSourceProjection> = {},
): TopicCommittedSourceProjection {
  return {
    nodeId,
    titleAtCommit: `Title ${nodeId}`,
    evidenceState: 'present',
    bodyIncluded: 1,
    fingerprintVersion: 1,
    evidenceHash: HASH_A,
    capturedAt: T1,
    ...overrides,
  };
}

function missingProjection(nodeId: string): TopicCommittedSourceProjection {
  return projection(nodeId, {
    titleAtCommit: null,
    evidenceState: 'missing',
    bodyIncluded: 0,
  });
}

function probe(urls: readonly string[]): CanonicalWebProbe {
  const built = buildCanonicalWebProbe(urls.map((url, index) => ({
    url, title: `Result ${index}`, snippet: `Snippet ${index}`, published: null,
  })));
  if (!built.ok) throw new Error('test probe unexpectedly overflowed');
  return built.probe;
}

function cacheInput(rootTitle: string, webProbe: CanonicalWebProbe): TopicProbeCacheInput {
  return {
    rootTitle,
    probe: webProbe,
    assessment: { verdict: 'material', reasonCode: 'new_development', changedUrls: [webProbe.results[0]!.url] },
    assessedAt: T1,
  };
}

function commitInput(
  rootTitle: string,
  sourceProjections: readonly TopicCommittedSourceProjection[],
  observedSourceNodeIds: readonly string[],
  overrides: Partial<TopicRefreshCommitInput> = {},
): TopicRefreshCommitInput {
  return {
    rootTitle,
    sourceProjections,
    observedSourceNodeIds,
    sourceCommittedAt: T1,
    ...overrides,
  };
}

describe('topic refresh explicit membership', () => {
  it('replaces, deduplicates, preserves on repeat, clears, and marks only membership changes pending', () => {
    const db = freshDb();

    expect(replaceExplicitTopicRefreshSources(db, 'Topic', ['n2', 'n1', 'n2'])).toEqual({ changed: true });
    expect(explicitTopicRefreshSources(db, 'Topic').map(row => row.node_id)).toEqual(['n2', 'n1']);
    expect(topicRefreshState(db, 'Topic')?.pending_source_change).toBe(1);

    db.prepare('UPDATE topic_refresh_state SET pending_source_change = 0 WHERE root_title = ?').run('Topic');
    expect(replaceExplicitTopicRefreshSources(db, 'Topic', ['n2', 'n1'])).toEqual({ changed: false });
    expect(topicRefreshState(db, 'Topic')?.pending_source_change).toBe(0);

    expect(replaceExplicitTopicRefreshSources(db, 'Topic', [])).toEqual({ changed: true });
    expect(explicitTopicRefreshSources(db, 'Topic')).toEqual([]);
    expect(topicRefreshState(db, 'Topic')?.pending_source_change).toBe(1);
    db.close();
  });

  it('accepts 20 deduped explicit IDs and rejects the 21st before changing membership', () => {
    const db = freshDb();
    const twenty = Array.from({ length: 20 }, (_, index) => `n${index}`);
    replaceExplicitTopicRefreshSources(db, 'Topic', [...twenty, 'n0']);

    expect(explicitTopicRefreshSources(db, 'Topic')).toHaveLength(20);
    expect(() => replaceExplicitTopicRefreshSources(db, 'Topic', [...twenty, 'overflow'])).toThrow(/20/);
    expect(explicitTopicRefreshSources(db, 'Topic').map(row => row.node_id)).toEqual(twenty);
    db.close();
  });
});

describe('topic refresh source baselines', () => {
  it('round-trips complete present and missing groups without storing bodies', () => {
    const db = freshDb();
    replaceExplicitTopicRefreshSources(db, 'Topic', ['present', 'missing']);
    commitTopicRefreshBaseline(db, commitInput('Topic', [projection('present'), missingProjection('missing')], []));

    expect(explicitTopicRefreshSources(db, 'Topic')).toEqual([
      {
        root_title: 'Topic', node_id: 'present', source_kind: 'explicit', title_at_commit: 'Title present',
        evidence_state: 'present', body_included: 1, fingerprint_version: 1,
        evidence_hash: HASH_A, captured_at: T1, freshness_version: null, freshness_hash: null, selection_json: null,
      },
      {
        root_title: 'Topic', node_id: 'missing', source_kind: 'explicit', title_at_commit: null,
        evidence_state: 'missing', body_included: 0, fingerprint_version: 1,
        evidence_hash: HASH_A, captured_at: T1, freshness_version: null, freshness_hash: null, selection_json: null,
      },
    ]);
    expect((db.prepare('PRAGMA table_info(topic_refresh_sources)').all() as Array<{ name: string }>).map(row => row.name)).not.toContain('body');
    db.close();
  });

  it('accepts the empty bounded title produced by a present canonical source projection', () => {
    const db = freshDb();

    commitTopicRefreshBaseline(db, commitInput(
      'Topic',
      [projection('present-empty-title', { titleAtCommit: '' })],
      ['present-empty-title'],
    ));

    expect(observedTopicRefreshSources(db, 'Topic')[0]?.title_at_commit).toBe('');
    db.close();
  });

  it.each([
    ['incomplete group', { evidenceHash: null }],
    ['invalid state', { evidenceState: 'gone' }],
    ['invalid body flag', { bodyIncluded: 2 }],
    ['missing body flag', { evidenceState: 'missing', titleAtCommit: null, bodyIncluded: 1 }],
    ['invalid hash', { evidenceHash: 'ABC' }],
    ['invalid version', { fingerprintVersion: 2 }],
    ['overlong title', { titleAtCommit: 'x'.repeat(2_001) }],
    ['invalid timestamp', { capturedAt: 'yesterday' }],
  ])('rejects %s before any source or state changes', (_label, overrides) => {
    const db = freshDb();
    replaceExplicitTopicRefreshSources(db, 'Topic', ['stable']);
    db.prepare('UPDATE topic_refresh_state SET pending_source_change = 0 WHERE root_title = ?').run('Topic');
    const input = commitInput('Topic', [projection('stable'), projection('bad', overrides as never)], ['bad']);

    expect(() => commitTopicRefreshBaseline(db, input)).toThrow();
    expect(observedTopicRefreshSources(db, 'Topic')).toEqual([]);
    expect(explicitTopicRefreshSources(db, 'Topic')[0]?.evidence_state).toBeNull();
    expect(topicRefreshState(db, 'Topic')?.source_committed_at).toBeNull();
    db.close();
  });

  it('deduplicates observed IDs, accepts 50, and rejects 51 without replacing the old set', () => {
    const db = freshDb();
    const fifty = Array.from({ length: 50 }, (_, index) => `n${index}`);
    commitTopicRefreshBaseline(db, commitInput('Topic', fifty.map(id => projection(id)), [...fifty, 'n0']));
    expect(observedTopicRefreshSources(db, 'Topic')).toHaveLength(50);

    const fiftyOne = [...fifty, 'overflow'];
    expect(() => commitTopicRefreshBaseline(
      db,
      commitInput('Topic', fiftyOne.map(id => projection(id)), fiftyOne),
    )).toThrow(/50/);
    expect(observedTopicRefreshSources(db, 'Topic').map(row => row.node_id)).toEqual(fifty);
    db.close();
  });
});

describe('topic web baseline and probe cache', () => {
  it('requires the committed web probe and timestamp group to be all omitted or all set', () => {
    const db = freshDb();
    const webProbe = probe(['https://example.com/a']);
    expect(() => commitTopicRefreshBaseline(db, {
      ...commitInput('Topic', [], []), webProbe,
    } as TopicRefreshCommitInput)).toThrow(/web/i);
    expect(() => commitTopicRefreshBaseline(db, {
      ...commitInput('Topic', [], []), webCommittedAt: T1,
    } as TopicRefreshCommitInput)).toThrow(/web/i);
    expect(topicRefreshState(db, 'Topic')).toBeUndefined();
    db.close();
  });

  it('requires every last-probe field and replaces the complete cache atomically', () => {
    const db = freshDb();
    const first = probe(['https://example.com/a']);
    expect(() => storeTopicProbeCache(db, {
      rootTitle: 'Topic', probe: first, assessedAt: T1,
    } as TopicProbeCacheInput)).toThrow(/probe|assessment/i);

    storeTopicProbeCache(db, cacheInput('Topic', first));
    const second = probe(['https://example.com/b']);
    storeTopicProbeCache(db, {
      rootTitle: 'Topic', probe: second,
      assessment: { verdict: 'uncertain', reasonCode: 'insufficient_evidence', changedUrls: [] },
      assessedAt: T2,
    });

    expect(topicRefreshState(db, 'Topic')).toMatchObject({
      last_probe_hash: second.hash,
      last_probe_snapshot_json: second.snapshotJson,
      last_probe_verdict: 'uncertain',
      last_probe_reason_code: 'insufficient_evidence',
      last_probe_changed_urls_json: '[]',
      last_probe_assessed_at: T2,
    });
    db.close();
  });

  it.each([
    ['invalid verdict', { verdict: 'yes', reasonCode: 'new_development', changedUrls: [] }],
    ['invalid reason', { verdict: 'material', reasonCode: 'because', changedUrls: [] }],
    ['non-array changed URLs', { verdict: 'material', reasonCode: 'new_development', changedUrls: '{}' }],
    ['non-string changed URL', { verdict: 'material', reasonCode: 'new_development', changedUrls: [1] }],
  ])('rejects %s before writing probe cache', (_label, assessment) => {
    const db = freshDb();
    const webProbe = probe(['https://example.com/a']);

    expect(() => storeTopicProbeCache(db, {
      rootTitle: 'Topic', probe: webProbe, assessment, assessedAt: T1,
    } as never)).toThrow();
    expect(topicRefreshState(db, 'Topic')).toBeUndefined();
    db.close();
  });

  it('rejects invalid probe and committed-web timestamps before writes', () => {
    const db = freshDb();
    const webProbe = probe(['https://example.com/a']);

    expect(() => storeTopicProbeCache(db, {
      ...cacheInput('Topic', webProbe), assessedAt: 'not-a-timestamp',
    })).toThrow(/timestamp/i);
    expect(() => commitTopicRefreshBaseline(db, commitInput('Topic', [], [], {
      webProbe, webCommittedAt: 'not-a-timestamp',
    }))).toThrow(/timestamp/i);
    expect(topicRefreshState(db, 'Topic')).toBeUndefined();
    db.close();
  });

  it('rejects an impossible calendar timestamp instead of accepting Date.parse rollover', () => {
    const db = freshDb();

    expect(() => commitTopicRefreshBaseline(db, commitInput('Topic', [], [], {
      sourceCommittedAt: '2026-02-30T12:00:00.000Z',
    }))).toThrow(/timestamp/i);
    expect(topicRefreshState(db, 'Topic')).toBeUndefined();
    db.close();
  });

  it('rejects a valid UTC timestamp that omits canonical milliseconds', () => {
    const db = freshDb();

    expect(() => commitTopicRefreshBaseline(db, commitInput('Topic', [], [], {
      sourceCommittedAt: '2026-08-30T12:00:00Z',
    }))).toThrow(/timestamp/i);
    expect(topicRefreshState(db, 'Topic')).toBeUndefined();
    db.close();
  });

  it.each([
    ['overlong snapshot', (valid: CanonicalWebProbe) => ({ ...valid, snapshotJson: 'x'.repeat(64_001) })],
    ['noncanonical snapshot shape', (valid: CanonicalWebProbe) => ({ ...valid, snapshotJson: '{"version":1,"results":[],"extra":true}' })],
    ['invalid digest', (valid: CanonicalWebProbe) => ({ ...valid, hash: HASH_B })],
  ])('rejects %s before writing probe cache', (_label, mutate) => {
    const db = freshDb();
    const valid = probe(['https://example.com/a']);
    expect(() => storeTopicProbeCache(db, cacheInput('Topic', mutate(valid)))).toThrow();
    expect(topicRefreshState(db, 'Topic')).toBeUndefined();
    db.close();
  });

  it('rejects changed URLs outside both snapshots and more than 20 URLs', () => {
    const db = freshDb();
    const committed = probe(['https://example.com/committed']);
    commitTopicRefreshBaseline(db, commitInput('Topic', [], [], {
      webProbe: committed, webCommittedAt: T1,
    }));
    const current = probe(Array.from({ length: 20 }, (_, index) => `https://example.com/${index}`));

    expect(() => storeTopicProbeCache(db, {
      ...cacheInput('Topic', current),
      assessment: { verdict: 'material', reasonCode: 'new_development', changedUrls: ['https://outside.example/x'] },
    })).toThrow(/URL/i);
    expect(() => storeTopicProbeCache(db, {
      ...cacheInput('Topic', current),
      assessment: {
        verdict: 'material', reasonCode: 'new_development',
        changedUrls: [...current.results.map(result => result.url), committed.results[0]!.url],
      },
    })).toThrow(/20/);
    expect(topicRefreshState(db, 'Topic')?.last_probe_hash).toBeNull();
    db.close();
  });
});

describe('commitTopicRefreshBaseline transaction', () => {
  it('stamps explicit rows, replaces observed order independently, clears pending, and advances an empty baseline', () => {
    const db = freshDb();
    replaceExplicitTopicRefreshSources(db, 'Topic', ['shared', 'explicit-only']);
    commitTopicRefreshBaseline(db, commitInput(
      'Topic',
      [projection('shared'), missingProjection('explicit-only'), projection('observed-only')],
      ['shared', 'observed-only'],
    ));

    expect(explicitTopicRefreshSources(db, 'Topic').map(row => [row.node_id, row.evidence_state])).toEqual([
      ['shared', 'present'], ['explicit-only', 'missing'],
    ]);
    expect(observedTopicRefreshSources(db, 'Topic').map(row => row.node_id)).toEqual(['shared', 'observed-only']);
    expect(topicRefreshState(db, 'Topic')).toMatchObject({ pending_source_change: 0, source_committed_at: T1 });

    commitTopicRefreshBaseline(db, commitInput('Topic', [], [], { sourceCommittedAt: T2 }));
    expect(explicitTopicRefreshSources(db, 'Topic')).toHaveLength(2);
    expect(observedTopicRefreshSources(db, 'Topic')).toEqual([]);
    expect(topicRefreshState(db, 'Topic')).toMatchObject({ pending_source_change: 0, source_committed_at: T2 });
    db.close();
  });

  it('advances a successful web baseline and clears stale probe cache', () => {
    const db = freshDb();
    const oldProbe = probe(['https://example.com/old']);
    commitTopicRefreshBaseline(db, commitInput('Topic', [], [], { webProbe: oldProbe, webCommittedAt: T1 }));
    storeTopicProbeCache(db, {
      rootTitle: 'Topic', probe: probe(['https://example.com/new']),
      assessment: { verdict: 'material', reasonCode: 'changed_fact', changedUrls: ['https://example.com/new'] },
      assessedAt: T1,
    });
    const replacement = probe(['https://example.com/replacement']);

    commitTopicRefreshBaseline(db, commitInput('Topic', [], [], {
      sourceCommittedAt: T2, webProbe: replacement, webCommittedAt: T2,
    }));

    expect(topicRefreshState(db, 'Topic')).toMatchObject({
      committed_web_hash: replacement.hash,
      committed_web_snapshot_json: replacement.snapshotJson,
      web_committed_at: T2,
      last_probe_hash: null,
      last_probe_snapshot_json: null,
      last_probe_verdict: null,
      last_probe_reason_code: null,
      last_probe_changed_urls_json: null,
      last_probe_assessed_at: null,
    });
    db.close();
  });

  it('preserves the last successful web baseline when full-run search is unavailable', () => {
    const db = freshDb();
    const webProbe = probe(['https://example.com/stable']);
    commitTopicRefreshBaseline(db, commitInput('Topic', [], [], { webProbe, webCommittedAt: T1 }));

    commitTopicRefreshBaseline(db, commitInput('Topic', [], [], { sourceCommittedAt: T2 }));

    expect(topicRefreshState(db, 'Topic')).toMatchObject({
      committed_web_hash: webProbe.hash,
      committed_web_snapshot_json: webProbe.snapshotJson,
      web_committed_at: T1,
    });
    db.close();
  });

  it('validates a late invalid projection before committing any source or web change', () => {
    const db = freshDb();
    replaceExplicitTopicRefreshSources(db, 'Topic', ['explicit']);
    const originalWeb = probe(['https://example.com/original']);
    commitTopicRefreshBaseline(db, commitInput('Topic', [projection('explicit')], [], {
      webProbe: originalWeb, webCommittedAt: T1,
    }));
    const beforeSources = explicitTopicRefreshSources(db, 'Topic');
    const beforeState = topicRefreshState(db, 'Topic');
    const replacementWeb = probe(['https://example.com/replacement']);

    expect(() => commitTopicRefreshBaseline(db, commitInput(
      'Topic',
      [projection('explicit', { evidenceHash: HASH_B }), projection('late', { capturedAt: 'invalid' })],
      ['late'],
      { sourceCommittedAt: T2, webProbe: replacementWeb, webCommittedAt: T2 },
    ))).toThrow(/timestamp/i);

    expect(explicitTopicRefreshSources(db, 'Topic')).toEqual(beforeSources);
    expect(observedTopicRefreshSources(db, 'Topic')).toEqual([]);
    expect(topicRefreshState(db, 'Topic')).toEqual(beforeState);
    db.close();
  });

  it('rolls back source replacement when a late state write aborts the transaction', () => {
    const db = freshDb();
    const originalWeb = probe(['https://example.com/original']);
    commitTopicRefreshBaseline(db, commitInput('Topic', [projection('old')], ['old'], {
      webProbe: originalWeb, webCommittedAt: T1,
    }));
    const beforeSources = observedTopicRefreshSources(db, 'Topic');
    const beforeState = topicRefreshState(db, 'Topic');
    db.exec(`
      CREATE TRIGGER reject_late_topic_refresh
      BEFORE UPDATE OF source_committed_at ON topic_refresh_state
      WHEN NEW.source_committed_at = '${T2}'
      BEGIN
        SELECT RAISE(ABORT, 'late state failure');
      END;
    `);

    expect(() => commitTopicRefreshBaseline(db, commitInput('Topic', [projection('new')], ['new'], {
      sourceCommittedAt: T2,
      webProbe: probe(['https://example.com/replacement']),
      webCommittedAt: T2,
    }))).toThrow(/late state failure/);

    expect(observedTopicRefreshSources(db, 'Topic')).toEqual(beforeSources);
    expect(topicRefreshState(db, 'Topic')).toEqual(beforeState);
    db.close();
  });

  it('deletes source and state rows together and reports both counts', () => {
    const db = freshDb();
    replaceExplicitTopicRefreshSources(db, 'Topic', ['one']);
    commitTopicRefreshBaseline(db, commitInput('Topic', [projection('one'), projection('two')], ['two']));

    expect(deleteTopicRefreshState(db, 'Topic')).toEqual({ sources: 2, state: 1 });
    expect(explicitTopicRefreshSources(db, 'Topic')).toEqual([]);
    expect(observedTopicRefreshSources(db, 'Topic')).toEqual([]);
    expect(topicRefreshState(db, 'Topic')).toBeUndefined();
    db.close();
  });
});
