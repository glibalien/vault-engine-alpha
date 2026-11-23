// allow: SIZE_OK — curator projection scenarios intentionally share one direct-SQL fixture vocabulary.
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { parseSinceMs, buildProjectEvidence } from '../../src/wiki/evidence.js';
import { setStoredSettings } from '../../src/settings/store.js';

function seedNode(db: ReturnType<typeof createTestDb>, id: string, path: string, title: string, mtime: number, types: string[]): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, path, title, '', id, mtime, mtime);
  for (const type of types) db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, type);
}
function rel(db: ReturnType<typeof createTestDb>, source: string, target: string, type: string, resolved: string | null): void {
  db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)')
    .run(source, target, type, null, resolved);
}
function field(db: ReturnType<typeof createTestDb>, nodeId: string, name: string, value: string): void {
  db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)')
    .run(nodeId, name, value, 'frontmatter');
}

function seedConv(db: ReturnType<typeof createTestDb>): void {
  const t = 1_700_000_000_000;
  seedNode(db, 'p1', 'Project.md', 'Project', t, ['project']);
  seedNode(db, 't1', 'Tasks/T1.md', 'T1', t, ['task']);
  field(db, 't1', 'status', 'open');
  field(db, 't1', 'due', '2030-06-01');
  seedNode(db, 'n1', 'Notes/N1.md', 'N1', t, ['note']);
  seedNode(db, 'dPast', '2026-05-01.md', '2026-05-01', t, ['daily-note']);
  seedNode(db, 'm1', 'Meetings/M1.md', 'M1', t, ['meeting']);
  rel(db, 't1', 'Project', 'project', 'p1');
  rel(db, 'n1', 'Project', 'wiki-link', 'p1');
  rel(db, 'm1', 'Project', 'project', 'p1');
  rel(db, 'm1', '2026-05-01', 'date', 'dPast');
}
function addDoneTask(db: ReturnType<typeof createTestDb>, mtime: number): void {
  seedNode(db, 'd1', 'Tasks/Done1.md', 'Done1', mtime, ['task']);
  field(db, 'd1', 'status', 'done');
  rel(db, 'd1', 'Project', 'project', 'p1');
}

describe('parseSinceMs', () => {
  it('parses ISO 8601 to epoch ms', () => {
    expect(parseSinceMs('2026-06-01T00:00:00.000Z')).toBe(Date.parse('2026-06-01T00:00:00.000Z'));
    expect(parseSinceMs('2026-06-01')).toBe(Date.parse('2026-06-01'));
  });
  it('parses an epoch-ms numeric string', () => {
    expect(parseSinceMs('1750000000000')).toBe(1750000000000);
  });
  it('returns null for undefined, empty, or unparseable input', () => {
    expect(parseSinceMs(undefined)).toBeNull();
    expect(parseSinceMs('')).toBeNull();
    expect(parseSinceMs('   ')).toBeNull();
    expect(parseSinceMs('not a date')).toBeNull();
  });
});

function seedDeltaGraph(db: ReturnType<typeof createTestDb>): { old: number; cut: number; fresh: number } {
  const old = 1_000_000;
  const cut = 2_000_000;
  const fresh = 3_000_000;
  seedNode(db, 'p1', 'Project.md', 'Project', fresh, ['project']);
  seedNode(db, 't-old', 'Tasks/Old.md', 'Old Task', old, ['task']);
  seedNode(db, 't-new', 'Tasks/New.md', 'New Task', fresh, ['task']);
  seedNode(db, 'n-new', 'Notes/New.md', 'New Note', fresh, ['note']);
  seedNode(db, 'w-new', 'Wikis/Project Wiki.md', 'Project Wiki', fresh, ['wiki']);
  rel(db, 't-old', 'Project', 'project', 'p1');
  rel(db, 't-new', 'Project', 'project', 'p1');
  rel(db, 'n-new', 'Project', 'wiki-link', 'p1');
  rel(db, 'w-new', 'Project', 'wiki_for', 'p1');
  return { old, cut, fresh };
}

describe('changed_since_curation', () => {
  it('buckets nodes changed after `since` by type, excluding project + wiki nodes', () => {
    const db = createTestDb();
    const { cut } = seedDeltaGraph(db);
    const ev = buildProjectEvidence(db, { project: 'p1', since: new Date(cut).toISOString() });
    expect(ev.changed_since_curation).toBeDefined();
    const buckets = ev.changed_since_curation!.buckets;
    expect(Object.keys(buckets).sort()).toEqual(['note', 'task']);
    expect(buckets.task.map(n => n.id)).toEqual(['t-new']); // t-old is below the cut
    expect(buckets.note.map(n => n.id)).toEqual(['n-new']);
    expect(buckets.task[0].modified).toBe(new Date(3_000_000).toISOString());
    expect(buckets.task[0].type).toBe('task');
  });

  it('omits changed_since_curation entirely when since is absent', () => {
    const db = createTestDb();
    seedDeltaGraph(db);
    const ev = buildProjectEvidence(db, { project: 'p1' });
    expect(ev.changed_since_curation).toBeUndefined();
  });

  it('omits changed_since_curation when since is unparseable', () => {
    const db = createTestDb();
    seedDeltaGraph(db);
    const ev = buildProjectEvidence(db, { project: 'p1', since: 'garbage' });
    expect(ev.changed_since_curation).toBeUndefined();
  });

  it('places a multi-type node under each of its types, and excludes it entirely when one type is wiki', () => {
    const db = createTestDb();
    const fresh = 3_000_000;
    const cut = 2_000_000;
    seedNode(db, 'p1', 'Project.md', 'Project', fresh, ['project']);
    // a node carrying two non-excluded types appears under both buckets
    seedNode(db, 'multi', 'Notes/Multi.md', 'Multi', fresh, ['task', 'note']);
    // a node carrying wiki + a normal type is dropped entirely (NOT EXISTS excludes the whole node)
    seedNode(db, 'wikitask', 'Wikis/WikiTask.md', 'WikiTask', fresh, ['wiki', 'task']);
    rel(db, 'multi', 'Project', 'project', 'p1');
    rel(db, 'wikitask', 'Project', 'project', 'p1');

    const ev = buildProjectEvidence(db, { project: 'p1', since: new Date(cut).toISOString() });
    const buckets = ev.changed_since_curation!.buckets;
    expect(buckets.task.map(n => n.id)).toEqual(['multi']);
    expect(buckets.note.map(n => n.id)).toEqual(['multi']);
    // wikitask appears in no bucket — its wiki type excludes the whole node
    expect(Object.values(buckets).flat().some(n => n.id === 'wikitask')).toBe(false);
  });
});

function seedSignalsGraph(db: ReturnType<typeof createTestDb>): void {
  const now = Date.now();
  seedNode(db, 'p1', 'Project.md', 'Project', now, ['project']);
  // daily notes for meeting dates
  seedNode(db, 'dPast', '2026-05-01.md', '2026-05-01', now, ['daily-note']);
  seedNode(db, 'dFut', '2026-12-01.md', '2026-12-01', now, ['daily-note']);
  // overdue + blocked task (both) — due in the past
  seedNode(db, 't-ob', 'Tasks/Blocked.md', 'Blocked+Overdue', now, ['task']);
  field(db, 't-ob', 'status', 'blocked');
  field(db, 't-ob', 'due', '2020-01-01');
  field(db, 't-ob', 'priority', 'high');
  field(db, 't-ob', 'scheduled', '2019-12-15');
  // a plain open task with a future due date (timeline only, not a risk proxy)
  seedNode(db, 't-future', 'Tasks/Future.md', 'Future Task', now, ['task']);
  field(db, 't-future', 'status', 'open');
  field(db, 't-future', 'due', '2099-01-01');
  // a meeting with a date
  seedNode(db, 'm1', 'Meetings/Kickoff.md', 'Kickoff', now, ['meeting']);
  rel(db, 't-ob', 'Project', 'project', 'p1');
  rel(db, 't-future', 'Project', 'project', 'p1');
  rel(db, 'm1', 'Project', 'project', 'p1');
  rel(db, 'm1', '2026-05-01', 'date', 'dPast');
}

describe('signals_detail', () => {
  it('lists blocked/overdue risk proxies with priority + scheduled', () => {
    const db = createTestDb();
    seedSignalsGraph(db);
    const ev = buildProjectEvidence(db, { project: 'p1' });
    const proxies = ev.signals_detail.risk_proxies;
    const ob = proxies.find(p => p.id === 't-ob')!;
    expect(ob).toBeDefined();
    expect(ob.bucket).toBe('overdue'); // overdue takes precedence
    expect(ob.blocked).toBe(true);
    expect(ob.priority).toBe('high');
    expect(ob.scheduled).toBe('2019-12-15');
    expect(ob.due).toBe('2020-01-01');
    // the future open task is not a risk proxy
    expect(proxies.some(p => p.id === 't-future')).toBe(false);
  });

  it('reads priority and scheduled from the vault map\'s fields; none reads nothing', () => {
    const db = createTestDb();
    seedSignalsGraph(db);
    field(db, 't-ob', 'urgency', 'p1');
    field(db, 't-ob', 'planned', '2019-12-20T09:00');
    const proxy = () => buildProjectEvidence(db, { project: 'p1' }).signals_detail.risk_proxies.find(p => p.id === 't-ob');

    setStoredSettings(db, 'vault', { priorityField: 'urgency', scheduledField: 'planned' });
    expect(proxy()).toMatchObject({ priority: 'p1', scheduled: '2019-12-20' });
    setStoredSettings(db, 'vault', { priorityField: null, scheduledField: 'scheduled' });
    expect(proxy()).toMatchObject({ priority: null, scheduled: '2019-12-15' });
    setStoredSettings(db, 'vault', { priorityField: null, scheduledField: null });
    expect(proxy()).toMatchObject({ priority: null, scheduled: null });
  });

  it('dates a meeting on the timeline by the vault map\'s date field', () => {
    const db = createTestDb();
    seedSignalsGraph(db);
    setStoredSettings(db, 'vault', { dateField: null });
    expect(buildProjectEvidence(db, { project: 'p1' }).signals_detail.timeline.some(t => t.type === 'meeting')).toBe(false);
  });

  it('builds a chronologically sorted timeline of due-dated tasks + dated meetings', () => {
    const db = createTestDb();
    seedSignalsGraph(db);
    const ev = buildProjectEvidence(db, { project: 'p1' });
    const timeline = ev.signals_detail.timeline;
    expect(timeline.map(t => `${t.date}:${t.type}:${t.id}`)).toEqual([
      '2020-01-01:task:t-ob',
      '2026-05-01:meeting:m1',
      '2099-01-01:task:t-future',
    ]);
  });

  it('breaks same-date timeline ties deterministically by type then id (meeting before task)', () => {
    const db = createTestDb();
    const now = Date.now();
    seedNode(db, 'p1', 'Project.md', 'Project', now, ['project']);
    seedNode(db, 'dSame', '2026-06-01.md', '2026-06-01', now, ['daily-note']);
    // two tasks + one meeting all on 2026-06-01 — ties resolve type asc (meeting<task), then id asc
    seedNode(db, 't-b', 'Tasks/B.md', 'B', now, ['task']);
    field(db, 't-b', 'status', 'open');
    field(db, 't-b', 'due', '2026-06-01');
    seedNode(db, 't-a', 'Tasks/A.md', 'A', now, ['task']);
    field(db, 't-a', 'status', 'open');
    field(db, 't-a', 'due', '2026-06-01');
    seedNode(db, 'm-same', 'Meetings/Same.md', 'Same', now, ['meeting']);
    rel(db, 't-b', 'Project', 'project', 'p1');
    rel(db, 't-a', 'Project', 'project', 'p1');
    rel(db, 'm-same', 'Project', 'project', 'p1');
    rel(db, 'm-same', '2026-06-01', 'date', 'dSame');

    const ev = buildProjectEvidence(db, { project: 'p1' });
    expect(ev.signals_detail.timeline.map(t => `${t.type}:${t.id}`)).toEqual([
      'meeting:m-same',
      'task:t-a',
      'task:t-b',
    ]);
  });
});

describe('synthesis_hints.salience', () => {
  it('scores associated nodes by recency, link-degree, and task-urgency; deterministic order', () => {
    const db = createTestDb();
    const now = Date.now();
    seedNode(db, 'p1', 'Project.md', 'Project', now, ['project']);
    // Urgent task: overdue, and well-linked (high on all three axes)
    seedNode(db, 't-urgent', 'Tasks/Urgent.md', 'Urgent', now, ['task']);
    field(db, 't-urgent', 'status', 'open');
    field(db, 't-urgent', 'due', '2020-01-01');
    // A note that is recent but low-degree, zero urgency
    seedNode(db, 'n-quiet', 'Notes/Quiet.md', 'Quiet', now - 1000, ['note']);
    // A stale, isolated note (lowest on every axis)
    seedNode(db, 'n-stale', 'Notes/Stale.md', 'Stale', now - 90 * 86400000, ['note']);
    // wiki page — must be excluded from candidates
    seedNode(db, 'w1', 'Wikis/Project Wiki.md', 'Project Wiki', now, ['wiki']);

    rel(db, 't-urgent', 'Project', 'project', 'p1');
    rel(db, 'n-quiet', 'Project', 'wiki-link', 'p1');
    rel(db, 'n-stale', 'Project', 'wiki-link', 'p1');
    rel(db, 'w1', 'Project', 'wiki_for', 'p1');
    // extra links onto t-urgent to raise its degree
    rel(db, 'n-quiet', 'Urgent', 'wiki-link', 't-urgent');

    const ev = buildProjectEvidence(db, { project: 'p1' });
    const salience = ev.synthesis_hints.salience;
    const ids = salience.map(s => s.id);

    expect(ids).not.toContain('w1'); // wiki excluded
    expect(ids).not.toContain('p1'); // project excluded
    expect(ids[0]).toBe('t-urgent'); // highest on all axes
    // every entry has a numeric score in [0,1] and three components
    for (const s of salience) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
      expect(s.components).toHaveProperty('recency');
      expect(s.components).toHaveProperty('degree');
      expect(s.components).toHaveProperty('urgency');
    }
    // the urgent task scores above the stale isolated note
    const stale = salience.find(s => s.id === 'n-stale')!;
    expect(salience[0].score).toBeGreaterThan(stale.score);
    // n-quiet links to the overdue t-urgent, so the adjacency bonus lifts its urgency above 0
    expect(salience.find(s => s.id === 'n-quiet')!.components.urgency).toBeGreaterThan(0);
  });

  it('orders ties by id ascending (determinism)', () => {
    const db = createTestDb();
    const now = 5_000_000; // identical mtime → identical recency/degree/urgency
    seedNode(db, 'p1', 'Project.md', 'Project', now, ['project']);
    seedNode(db, 'n-b', 'Notes/B.md', 'B', now, ['note']);
    seedNode(db, 'n-a', 'Notes/A.md', 'A', now, ['note']);
    rel(db, 'n-b', 'Project', 'wiki-link', 'p1');
    rel(db, 'n-a', 'Project', 'wiki-link', 'p1');
    const ev = buildProjectEvidence(db, { project: 'p1' });
    expect(ev.synthesis_hints.salience.map(s => s.id)).toEqual(['n-a', 'n-b']);
  });
});

describe('content_hash projection', () => {
  it('surfaces content_hash on notes and meetings (seedNode stores content_hash = id)', () => {
    const db = createTestDb();
    seedConv(db);
    const ev = buildProjectEvidence(db, { project: 'p1' });
    expect(ev.notes.find(n => n.id === 'n1')?.content_hash).toBe('n1');
    const meetings = [...ev.meetings.recent, ...ev.meetings.upcoming];
    expect(meetings.find(m => m.id === 'm1')?.content_hash).toBe('m1');
  });

  it('passes the complete wiki catalog and home topology stamp through project evidence', () => {
    const db = createTestDb();
    seedConv(db);
    seedNode(db, 'w1', 'Wikis/Project Wiki.md', 'Project Wiki', 1, ['wiki']);
    seedNode(db, 's1', 'Wikis/Project — Alpha.md', 'Project — Alpha', 1, ['wiki']);
    db.prepare('UPDATE nodes SET version = 4 WHERE id = ?').run('w1');
    rel(db, 'w1', 'Project', 'wiki_for', 'p1');
    rel(db, 's1', 'Project', 'wiki_for', 'p1');
    rel(db, 's1', 'Project Wiki', 'wiki_parent', 'w1');
    field(db, 'w1', 'wiki_topology_hash', 'topology-1');
    field(db, 's1', 'wiki_kind', 'workstream');
    field(db, 's1', 'wiki_scope', '{"v":1,"subject":"Project","facet":"Alpha"}');

    const ev = buildProjectEvidence(db, { project: 'p1' });

    expect(ev.existing_wiki.home).toMatchObject({ id: 'w1', version: 4, wiki_topology_hash: 'topology-1' });
    expect(ev.existing_wiki.topology_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(ev.existing_wiki.catalog_valid).toBe(true);
    expect(ev.existing_wiki.subpages).toEqual([expect.objectContaining({
      id: 's1',
      version: 1,
      content_hash: 's1',
      wiki_kind: 'workstream',
      wiki_scope: { v: 1, subject: 'Project', facet: 'Alpha' },
    })]);
  });
});

describe('evidence_hash invariance', () => {
  function seedFull(db: ReturnType<typeof createTestDb>): void {
    // Fixed timestamp (NOT Date.now()): seedFull runs twice (dbA/dbB) and a
    // per-call clock would make the two DBs differ and defeat the byte-identical-hash
    // assertion. (The hash no longer keys on file_mtime directly, but the fixed
    // timestamp still matters for deterministic done_recent bucketing vs Date.now().)
    const now = 1_700_000_000_000;
    seedNode(db, 'p1', 'Project.md', 'Project', now, ['project']);
    seedNode(db, 't1', 'Tasks/T1.md', 'T1', now, ['task']);
    field(db, 't1', 'status', 'blocked');
    field(db, 't1', 'due', '2020-01-01');
    field(db, 't1', 'priority', 'high');
    seedNode(db, 'n1', 'Notes/N1.md', 'N1', now - 1000, ['note']);
    seedNode(db, 'dPast', '2026-05-01.md', '2026-05-01', now, ['daily-note']);
    seedNode(db, 'm1', 'Meetings/M1.md', 'M1', now, ['meeting']);
    rel(db, 't1', 'Project', 'project', 'p1');
    rel(db, 'n1', 'Project', 'wiki-link', 'p1');
    rel(db, 'm1', 'Project', 'project', 'p1');
    rel(db, 'm1', '2026-05-01', 'date', 'dPast');
  }

  it('the three new projections do not change evidence_hash, with or without since', () => {
    const dbA = createTestDb();
    seedFull(dbA);
    const baseline = buildProjectEvidence(dbA, { project: 'p1' });

    const dbB = createTestDb();
    seedFull(dbB);
    const withSince = buildProjectEvidence(dbB, { project: 'p1', since: '2000-01-01T00:00:00Z' });

    // Same DB state → identical hash, regardless of `since` (which only adds the
    // time-relative changed_since_curation field — explicitly excluded from the hash).
    expect(withSince.evidence_hash).toBe(baseline.evidence_hash);
    // And the new fields are actually populated (guards against "hash equal because empty").
    expect(withSince.changed_since_curation).toBeDefined();
    expect(withSince.signals_detail.risk_proxies.length).toBeGreaterThan(0);
    expect(withSince.synthesis_hints.salience.length).toBeGreaterThan(0);
  });

  it('omitting since keeps the response back-compatible (no changed_since_curation key)', () => {
    const db = createTestDb();
    seedFull(db);
    const ev = buildProjectEvidence(db, { project: 'p1' });
    expect('changed_since_curation' in ev).toBe(false);
  });
});

describe('evidence_hash convergence (file_mtime + done_recent)', () => {
  const hash = (db: ReturnType<typeof createTestDb>): string =>
    buildProjectEvidence(db, { project: 'p1' }).evidence_hash;

  it('is invariant to file_mtime changes on notes and actionable tasks', () => {
    const dbA = createTestDb(); seedConv(dbA);
    const dbB = createTestDb(); seedConv(dbB);
    dbB.prepare('UPDATE nodes SET file_mtime = file_mtime + 999999 WHERE id IN (?, ?)').run('n1', 't1');
    expect(hash(dbB)).toBe(hash(dbA));
  });

  it('is invariant to a completed task aging out of the done_recent window', () => {
    // Date.now() is intentional here (unlike seedFull's fixed timestamp): the
    // done_recent window is computed live against the clock inside the digest,
    // so the fixture must straddle it. The hash is NOT keyed on these mtimes,
    // so this does not make the assertion non-deterministic — do not "fix" it
    // to a fixed timestamp, which would neuter the test.
    const recent = Date.now() - 1000;             // inside the 7-day window
    const old = Date.now() - 30 * 86_400_000;     // aged out
    const dbA = createTestDb(); seedConv(dbA); addDoneTask(dbA, recent);
    const dbB = createTestDb(); seedConv(dbB); addDoneTask(dbB, old);
    expect(hash(dbB)).toBe(hash(dbA));
  });

  it('changes when a note\'s text changes', () => {
    const dbA = createTestDb(); seedConv(dbA);
    const dbB = createTestDb(); seedConv(dbB);
    dbB.prepare("UPDATE nodes SET content_hash = 'n1-edited', body = 'Edited text' WHERE id = 'n1'").run();
    expect(hash(dbB)).not.toBe(hash(dbA));
  });

  it('changes when a meeting\'s text changes', () => {
    const dbA = createTestDb(); seedConv(dbA);
    const dbB = createTestDb(); seedConv(dbB);
    dbB.prepare("UPDATE nodes SET content_hash = 'm1-edited', body = 'Edited text' WHERE id = 'm1'").run();
    expect(hash(dbB)).not.toBe(hash(dbA));
  });

  it('changes when a note\'s fields change', () => {
    const dbA = createTestDb(); seedConv(dbA);
    const dbB = createTestDb(); seedConv(dbB);
    field(dbB, 'n1', 'stage', 'proposal');
    dbB.prepare("UPDATE nodes SET content_hash = 'n1-edited' WHERE id = 'n1'").run();
    expect(hash(dbB)).not.toBe(hash(dbA));
  });

  it('stays when links are added around words already in a note or meeting (#332)', () => {
    const dbA = createTestDb(); seedConv(dbA);
    dbA.prepare("UPDATE nodes SET body = 'Call with Dana Whitfield about Acme' WHERE id IN ('n1', 'm1')").run();
    const dbB = createTestDb(); seedConv(dbB);
    dbB.prepare("UPDATE nodes SET body = 'Call with [[Dana Whitfield]] about [[Acme Inc|Acme]]', content_hash = id || '-linked', file_mtime = 1800000000000, version = version + 1 WHERE id IN ('n1', 'm1')").run();
    expect(hash(dbB)).toBe(hash(dbA));
  });

  it('stays when a link would bring a meeting into the recent ones by its file time (Codex, #696)', () => {
    const seedMany = (db: ReturnType<typeof createTestDb>) => {
      seedConv(db);
      // 14 meetings on one day: more than the 12 recent ones the evidence lists.
      for (let i = 0; i < 14; i++) {
        seedNode(db, `mt${i}`, `Meetings/MT${i}.md`, `MT${i}`, 1_700_000_000_000 + i, ['meeting']);
        db.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(1_600_000_000_000 + i, `mt${i}`);
        rel(db, `mt${i}`, 'Project', 'project', 'p1');
        rel(db, `mt${i}`, '2026-05-01', 'date', 'dPast');
      }
      db.prepare("UPDATE nodes SET body = 'Met Dana Whitfield' WHERE id = 'mt0'").run();
    };
    const dbA = createTestDb(); seedMany(dbA);
    const dbB = createTestDb(); seedMany(dbB);
    // The meeting saved longest ago gains a link and becomes the newest file of the day.
    dbB.prepare("UPDATE nodes SET body = 'Met [[Dana Whitfield]]', content_hash = 'mt0-linked', file_mtime = 1800000000000 WHERE id = 'mt0'").run();
    expect(buildProjectEvidence(dbB, { project: 'p1' }).meetings.recent.map(m => m.id)).toContain('mt0');
    expect(buildProjectEvidence(dbA, { project: 'p1' }).meetings.recent.map(m => m.id)).not.toContain('mt0');
    expect(hash(dbB)).toBe(hash(dbA));
  });

  it('stays when a link pushes an older note into the newest 50 (#332)', () => {
    const seedMany = (db: ReturnType<typeof createTestDb>) => {
      seedConv(db);
      for (let i = 0; i < 55; i++) {
        seedNode(db, `x${i}`, `Notes/X${i}.md`, `X${i}`, 1_700_000_000_000 + i, ['note']);
        rel(db, `x${i}`, 'Project', 'wiki-link', 'p1');
      }
      db.prepare("UPDATE nodes SET body = 'Met Dana Whitfield' WHERE id = 'x0'").run();
    };
    const dbA = createTestDb(); seedMany(dbA);
    const dbB = createTestDb(); seedMany(dbB);
    // The oldest note gains a link and becomes the newest file.
    dbB.prepare("UPDATE nodes SET body = 'Met [[Dana Whitfield]]', content_hash = 'x0-linked', file_mtime = 1800000000000 WHERE id = 'x0'").run();
    expect(hash(dbB)).toBe(hash(dbA));
  });

  it('changes when an actionable task becomes done (becoming-done is detected)', () => {
    const dbA = createTestDb(); seedConv(dbA);
    const dbB = createTestDb(); seedConv(dbB);
    dbB.prepare("UPDATE node_fields SET value_text = 'done' WHERE node_id = 't1' AND field_name = 'status'").run();
    expect(hash(dbB)).not.toBe(hash(dbA));
  });

  it('changes when an actionable task due date changes', () => {
    const dbA = createTestDb(); seedConv(dbA);
    const dbB = createTestDb(); seedConv(dbB);
    dbB.prepare("UPDATE node_fields SET value_text = '2030-01-01' WHERE node_id = 't1' AND field_name = 'due'").run();
    expect(hash(dbB)).not.toBe(hash(dbA));
  });
});

describe('closed_since', () => {
  it('lists tasks done since `since`, excludes old done tasks, omitted without `since`', () => {
    const db = createTestDb();
    const since = 2_000_000;
    seedNode(db, 'p1', 'Project.md', 'Project', 3_000_000, ['project']);
    // Done AFTER `since` → included.
    seedNode(db, 'd-new', 'Tasks/DNew.md', 'D New', 3_000_000, ['task']);
    field(db, 'd-new', 'status', 'done');
    db.prepare('UPDATE nodes SET content_changed_at = ? WHERE id = ?').run(2_500_000, 'd-new');
    rel(db, 'd-new', 'Project', 'project', 'p1');
    // Done BEFORE `since` → excluded.
    seedNode(db, 'd-old', 'Tasks/DOld.md', 'D Old', 1_000_000, ['task']);
    field(db, 'd-old', 'status', 'done');
    db.prepare('UPDATE nodes SET content_changed_at = ? WHERE id = ?').run(1_000_000, 'd-old');
    rel(db, 'd-old', 'Project', 'project', 'p1');
    // Open task → never in closed_since.
    seedNode(db, 't-open', 'Tasks/Open.md', 'Open', 3_000_000, ['task']);
    field(db, 't-open', 'status', 'open');
    rel(db, 't-open', 'Project', 'project', 'p1');

    const withSince = buildProjectEvidence(db, { project: 'p1', since: new Date(since).toISOString() });
    expect((withSince.closed_since ?? []).map(c => c.id)).toEqual(['d-new']);

    const noSince = buildProjectEvidence(db, { project: 'p1' });
    expect(noSince.closed_since).toBeUndefined();
  });

  it('does not affect evidence_hash (done state is excluded from the fingerprint)', () => {
    const db = createTestDb();
    seedNode(db, 'p1', 'Project.md', 'Project', 3_000_000, ['project']);
    const h1 = buildProjectEvidence(db, { project: 'p1' }).evidence_hash;
    seedNode(db, 'd-new', 'Tasks/DNew.md', 'D New', 3_000_000, ['task']);
    field(db, 'd-new', 'status', 'done');
    db.prepare('UPDATE nodes SET content_changed_at = ? WHERE id = ?').run(2_500_000, 'd-new');
    rel(db, 'd-new', 'Project', 'project', 'p1');
    const h2 = buildProjectEvidence(db, { project: 'p1' }).evidence_hash;
    expect(h2).toBe(h1); // adding a done task does not move the hash
  });

  it('returns closed_since in recency-DESC order (most recently closed first)', () => {
    const db = createTestDb();
    const since = 1_000_000;
    seedNode(db, 'p1', 'Project.md', 'Project', 5_000_000, ['project']);
    // d-early closed at 2_000_000, d-late closed at 4_000_000 — d-late should sort first
    seedNode(db, 'd-early', 'Tasks/DEarly.md', 'D Early', 2_000_000, ['task']);
    field(db, 'd-early', 'status', 'done');
    db.prepare('UPDATE nodes SET content_changed_at = ? WHERE id = ?').run(2_000_000, 'd-early');
    rel(db, 'd-early', 'Project', 'project', 'p1');
    seedNode(db, 'd-late', 'Tasks/DLate.md', 'D Late', 4_000_000, ['task']);
    field(db, 'd-late', 'status', 'done');
    db.prepare('UPDATE nodes SET content_changed_at = ? WHERE id = ?').run(4_000_000, 'd-late');
    rel(db, 'd-late', 'Project', 'project', 'p1');

    const ev = buildProjectEvidence(db, { project: 'p1', since: new Date(since).toISOString() });
    const ids = (ev.closed_since ?? []).map(c => c.id);
    expect(ids).toEqual(['d-late', 'd-early']); // DESC by closed_at
  });

  it('caps results at 25 (CLOSED_SINCE_CAP)', () => {
    const db = createTestDb();
    const since = 1_000_000;
    seedNode(db, 'p1', 'Project.md', 'Project', 5_000_000, ['project']);
    // Seed 26 done tasks, all closed after `since`
    for (let i = 0; i < 26; i++) {
      const id = `d-cap-${String(i).padStart(2, '0')}`;
      seedNode(db, id, `Tasks/Cap${i}.md`, `Cap ${i}`, 2_000_000 + i, ['task']);
      field(db, id, 'status', 'done');
      db.prepare('UPDATE nodes SET content_changed_at = ? WHERE id = ?').run(2_000_000 + i, id);
      rel(db, id, 'Project', 'project', 'p1');
    }

    const ev = buildProjectEvidence(db, { project: 'p1', since: new Date(since).toISOString() });
    expect((ev.closed_since ?? []).length).toBe(25);
  });
});

describe('salience uses content_changed_at, not file_mtime, for recency', () => {
  it('a touched-but-unchanged node does not outrank a genuinely-changed one', () => {
    const db = createTestDb();
    const base = 1_000_000;
    seedNode(db, 'p1', 'Project.md', 'Project', base, ['project']);
    // Old task whose file_mtime was bumped recently (Sync touch) but content unchanged.
    seedNode(db, 'touched', 'Tasks/Touched.md', 'Touched', base + 999_999, ['task']);
    field(db, 'touched', 'status', 'open');
    db.prepare('UPDATE nodes SET content_changed_at = ? WHERE id = ?').run(base, 'touched'); // content old
    // Task that genuinely changed recently.
    seedNode(db, 'changed', 'Tasks/Changed.md', 'Changed', base + 500_000, ['task']);
    field(db, 'changed', 'status', 'open');
    db.prepare('UPDATE nodes SET content_changed_at = ? WHERE id = ?').run(base + 500_000, 'changed');
    rel(db, 'touched', 'Project', 'project', 'p1');
    rel(db, 'changed', 'Project', 'project', 'p1');

    const ev = buildProjectEvidence(db, { project: 'p1' });
    const byId = new Map(ev.synthesis_hints.salience.map(s => [s.id, s.components.recency]));
    // 'changed' content is newer than 'touched' content → higher recency, despite touched's bumped file_mtime.
    expect(byId.get('changed')!).toBeGreaterThan(byId.get('touched')!);
  });
});
