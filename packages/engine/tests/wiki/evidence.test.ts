import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { backfillResolvedTargets } from '../../src/resolver/refresh.js';
import { getWikiConfig } from '../../src/wiki/config.js';
import { fetchMeetings, fetchContacts, fetchUnlinkedContacts, computeEvidenceHash, computeEvidenceComponents, buildProjectEvidence, resolveAutoSinceMs, type EvidenceMeeting, type EvidenceContact } from '../../src/wiki/evidence.js';
import type { ProjectDigest, WikiCatalogPage } from '../../src/wiki/digest.js';
import { computeWikiTopologyHash } from '../../src/wiki/topology.js';
import { setStoredSettings } from '../../src/settings/store.js';

const TODAY = '2026-06-06';

function seedNode(db: ReturnType<typeof createTestDb>, id: string, path: string, title: string, mtime: number, types: string[]): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, path, title, '', id, mtime, mtime);
  for (const type of types) db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, type);
}
function rel(db: ReturnType<typeof createTestDb>, source: string, target: string, type: string, resolved: string): void {
  db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)')
    .run(source, target, type, null, resolved);
}

function seedProjectGraph(db: ReturnType<typeof createTestDb>): void {
  const now = Date.now();
  seedNode(db, 'p1', 'Project.md', 'Project', now, ['project']);
  // people
  seedNode(db, 'pA', 'Persons/A.md', 'Alice', now, ['person']);
  seedNode(db, 'pB', 'Persons/B.md', 'Bob', now, ['person']);
  seedNode(db, 'pC', 'Persons/C.md', 'Carol', now, ['person']);
  // companies
  seedNode(db, 'cX', 'Companies/X.md', 'Acme', now, ['company']);
  seedNode(db, 'cY', 'Companies/Y.md', 'Globex', now, ['company']);
  // daily notes for meeting dates
  seedNode(db, 'dPast', '2026-05-01.md', '2026-05-01', now, ['daily-note']);
  seedNode(db, 'dFut', '2026-07-01.md', '2026-07-01', now, ['daily-note']);
  // meetings
  seedNode(db, 'm1', 'Meetings/Kickoff.md', 'Kickoff', now - 5000, ['meeting']);
  seedNode(db, 'm2', 'Meetings/Future.md', 'Future Review', now, ['meeting']);
  seedNode(db, 'm3', 'Meetings/Undated.md', 'Undated Sync', now - 1000, ['meeting']);

  // project -> direct people + company
  rel(db, 'p1', 'Alice', 'people involved', 'pA');
  rel(db, 'p1', 'Bob', 'people involved', 'pB');
  rel(db, 'p1', 'Acme', 'company', 'cX');
  // Alice works at Globex
  rel(db, 'pA', 'Globex', 'company', 'cY');

  // meetings -> project, date, attendees
  rel(db, 'm1', 'Project', 'project', 'p1');
  rel(db, 'm1', '2026-05-01', 'date', 'dPast');
  rel(db, 'm1', 'Alice', 'people involved', 'pA');
  rel(db, 'm1', 'Carol', 'people involved', 'pC');

  rel(db, 'm2', 'Project', 'project', 'p1');
  rel(db, 'm2', '2026-07-01', 'date', 'dFut');
  rel(db, 'm2', 'Alice', 'people involved', 'pA');

  rel(db, 'm3', 'Project', 'project', 'p1');
  rel(db, 'm3', 'Carol', 'people involved', 'pC');
}

describe('fetchMeetings', () => {
  it('splits recent vs upcoming by date and attaches attendees', () => {
    const db = createTestDb();
    seedProjectGraph(db);
    const { recent, upcoming } = fetchMeetings(db, 'p1', getWikiConfig(db), TODAY, { recent: 12, upcoming: 8 });

    expect(upcoming.map(m => m.id)).toEqual(['m2']);
    expect(upcoming[0].date).toBe('2026-07-01');
    // recent holds the dated past meeting and the undated one
    expect(recent.map(m => m.id).sort()).toEqual(['m1', 'm3']);
    const m1 = recent.find(m => m.id === 'm1')!;
    expect(m1.date).toBe('2026-05-01');
    expect(m1.attendees.sort()).toEqual(['Alice', 'Carol']);
  });

  it('dates a meeting by a plain date value when no daily note is linked', () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'meeting-dates-'));
    const db = createTestDb();
    try {
      const write = (path: string, text: string) => writeFileSync(join(vaultPath, path), text);
      const meeting = (title: string, date: string) =>
        write(`${title}.md`, `---\ntypes:\n  - meeting\nproject: "[[Project]]"\ndate: ${date}\n---\n`);
      write('Project.md', '---\ntypes:\n  - project\n---\n');
      mkdirSync(join(vaultPath, 'Daily'));
      write('Daily/2026-05-01.md', 'Daily note\n');
      meeting('Linked', '"[[2026-05-01]]"');
      meeting('Missing daily note', '"[[2026-05-05]]"');
      meeting('Plain', '2026-05-20');
      meeting('Timed', '2026-05-21T14:30');
      meeting('Later', '2026-06-20');
      meeting('Someday', 'soon');
      // As at startup: the backfill resolves links indexed before their targets.
      fullIndex(vaultPath, db);
      backfillResolvedTargets(db);
      const project = db.prepare("SELECT id FROM nodes WHERE title = 'Project'").get() as { id: string };

      const { recent, upcoming } = fetchMeetings(db, project.id, getWikiConfig(db), TODAY, { recent: 12, upcoming: 8 });

      expect(Object.fromEntries([...recent, ...upcoming].map(m => [m.title, m.date]))).toEqual({
        Linked: '2026-05-01', 'Missing daily note': '2026-05-05', Plain: '2026-05-20', Timed: '2026-05-21',
        Later: '2026-06-20', Someday: null,
      });
      expect(upcoming.map(m => m.title)).toEqual(['Later']);
    } finally {
      db.close();
      rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  it('prefers the daily-note link over a plain date value', () => {
    const db = createTestDb();
    seedProjectGraph(db);
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_text) VALUES ('m1', 'date', '2026-05-09')").run();
    const { recent } = fetchMeetings(db, 'p1', getWikiConfig(db), TODAY, { recent: 12, upcoming: 8 });
    expect(recent.find(m => m.id === 'm1')?.date).toBe('2026-05-01');
  });
});

describe('fetchMeetings and the vault map\'s date field', () => {
  it('reads the designated date field in both readings, and none leaves meetings undated', () => {
    const db = createTestDb();
    seedProjectGraph(db);
    // m1 is dated through `date`; give m1 and m3 a `held on` field instead.
    rel(db, 'm1', '2026-05-02', 'held on', 'dPast'); // a link to a note titled with the date
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_text) VALUES ('m3', 'held on', '2026-05-03')").run();
    db.prepare("UPDATE nodes SET title = '2026-05-02' WHERE id = 'dPast'").run();
    const dates = () => {
      const { recent, upcoming } = fetchMeetings(db, 'p1', getWikiConfig(db), TODAY, { recent: 12, upcoming: 8 });
      return Object.fromEntries([...recent, ...upcoming].map(m => [m.id, m.date]));
    };

    // Default map: `date` only, so m3's `held on` value is not a date.
    expect(dates()).toEqual({ m1: '2026-05-02', m2: '2026-07-01', m3: null });
    setStoredSettings(db, 'vault', { dateField: 'held on' });
    expect(dates()).toEqual({ m1: '2026-05-02', m2: null, m3: '2026-05-03' });
    setStoredSettings(db, 'vault', { dateField: null });
    expect(dates()).toEqual({ m1: null, m2: null, m3: null });
  });
});

describe('fetchContacts', () => {
  it('merges direct people with meeting attendees, ranks direct first, attaches companies', () => {
    const db = createTestDb();
    seedProjectGraph(db);
    const { people, companies } = fetchContacts(db, 'p1', getWikiConfig(db), 25);

    const byId = Object.fromEntries(people.map(p => [p.id, p]));
    // Alice: direct AND attends 2 meetings; Bob: direct only; Carol: meetings only
    expect(byId['pA'].direct).toBe(true);
    expect(byId['pA'].meeting_count).toBe(2);
    expect(byId['pA'].companies).toEqual(['Globex']);
    expect(byId['pB'].direct).toBe(true);
    expect(byId['pB'].meeting_count).toBe(0);
    expect(byId['pC'].direct).toBe(false);
    expect(byId['pC'].meeting_count).toBe(2);

    // direct contacts rank above meeting-only ones
    expect(people.findIndex(p => p.id === 'pA')).toBeLessThan(people.findIndex(p => p.id === 'pC'));
    expect(people.findIndex(p => p.id === 'pB')).toBeLessThan(people.findIndex(p => p.id === 'pC'));

    expect(companies.map(c => c.title)).toEqual(['Acme']);
  });

  it('lists people-field names that reach no note, named on the project first, then by meetings (#474)', () => {
    const db = createTestDb();
    seedProjectGraph(db);
    const unresolved = (source: string, target: string) =>
      db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, NULL)')
        .run(source, target, 'people involved', null);
    unresolved('p1', 'Dana Reyes');
    unresolved('m1', 'People/Evan Holt.md');
    unresolved('m3', 'evan holt#Notes');
    unresolved('m1', 'Dana Reyes|Dana');
    unresolved('m2', 'Frank Ito');
    // An empty list item is stored as "null"; it names no one.
    unresolved('m2', 'null');
    // Two spellings of one person in one meeting are one meeting.
    unresolved('m3', 'Frank Ito#Bio');
    unresolved('m2', 'frank ito|Frank');
    // Left unresolved although a note has the name (a note of another type, or two sharing it,
    // under the typed reference policy): the note exists, so it isn't listed.
    seedNode(db, 'tN', 'Topics/Henry Vale.md', 'Henry Vale', Date.now(), ['topic']);
    unresolved('m1', 'Henry Vale');
    seedNode(db, 'iN', 'Topics/Íris Duarte.md', 'Íris Duarte', Date.now(), ['topic']);
    unresolved('m1', 'ÍRIS DUARTE');
    // A link in another field, or on a note that isn't a project meeting, doesn't count.
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, NULL)')
      .run('m1', 'Some Doc', 'related', null);
    seedNode(db, 'nX', 'Notes/Other.md', 'Other', Date.now(), ['note']);
    unresolved('nX', 'Grace Pell');

    const { people } = fetchContacts(db, 'p1', getWikiConfig(db), 25);
    const unlinked = fetchUnlinkedContacts(db, 'p1', getWikiConfig(db), 25);
    expect(unlinked).toEqual([
      { name: 'Dana Reyes', direct: true, meeting_count: 1 },
      { name: 'Evan Holt', direct: false, meeting_count: 2 },
      { name: 'Frank Ito', direct: false, meeting_count: 2 },
    ]);
    // Contacts with notes are unchanged.
    expect(people.map(p => p.id).sort()).toEqual(['pA', 'pB', 'pC']);
    expect(fetchUnlinkedContacts(db, 'p1', getWikiConfig(db), 2).map(c => c.name)).toEqual(['Dana Reyes', 'Evan Holt']);
  });
});

describe('computeEvidenceHash', () => {
  const catalogPage = (overrides: Partial<WikiCatalogPage> = {}): WikiCatalogPage => ({
    id: 's1',
    title: 'P — Alpha',
    file_path: 'Wikis/P — Alpha.md',
    version: 1,
    content_hash: 'wiki-content',
    wiki_state: 'active',
    wiki_kind: 'workstream',
    wiki_origin: 'automatic',
    wiki_scope: { v: 1, subject: 'P', facet: 'Alpha' },
    wiki_pinned: false,
    ...overrides,
  });
  const digest = (taskStatus: string, subpage = catalogPage()): ProjectDigest => ({
    project: { id: 'p1', title: 'P', file_path: 'P.md' },
    config_used: {} as ProjectDigest['config_used'],
    windows: { today: '2026-05-25', time_zone: 'UTC', stale_days: 30, upcoming_days: 14, recent_days: 7 },
    tasks: { open: [{ id: 't1', title: 'T', file_path: 'T.md', file_mtime: 1, content_hash: null, status: taskStatus, due: null }], blocked: [], overdue: [], upcoming: [], done_recent: [], backlog: [] },
    // project_count is additive (#474): the formula below shows it never reaches the hash.
    notes: [{ id: 'n1', title: 'N', file_path: 'N.md', file_mtime: 2, content_hash: null, project_count: 3 }],
    signals: { overdue_count: 0, blocked_count: 0, stale: [], hot: [], churn_rate: 1 },
    neighborhood: { outgoing: {}, incoming: {} },
    existing_wiki: {
      home_id: 'w1',
      home: { id: 'w1', version: 1, wiki_evidence_hash: 'old-evidence' },
      topology_hash: computeWikiTopologyHash([subpage]),
      catalog_valid: true,
      subpages: [subpage],
    },
    synthesis_hints: { top_task_ids: [], top_note_ids: [], stale_task_ids: [], overdue_task_ids: [], recently_done_ids: [], suggested_reads: [] },
    generated_at: '',
  });
  const meetings = { recent: [{ id: 'm1', title: 'M', file_path: 'Meetings/M.md', date: '2026-05-01', file_mtime: 1, content_hash: null, attendees: [], project_count: 2 }] as EvidenceMeeting[], upcoming: [] as EvidenceMeeting[] };
  const contacts = { people: [{ id: 'pA', title: 'A', file_path: 'Persons/A.md', companies: [], direct: true, meeting_count: 2, last_seen: 1 }] as EvidenceContact[], companies: [{ id: 'cX', title: 'Acme', file_path: 'Companies and Organizations/Acme.md' }] };

  it('is stable for identical evidence', () => {
    expect(computeEvidenceHash('in-progress', digest('open'), meetings, contacts))
      .toBe(computeEvidenceHash('in-progress', digest('open'), meetings, contacts));
  });

  it('keeps the established hash formula', () => {
    const canonical = JSON.stringify({ status: 'in-progress', tasks: ['t1|open|'], notes: ['n1|'], meetings: ['m1|'],
      contacts: ['pA|2'], companies: ['cX'] });
    expect(computeEvidenceHash('in-progress', digest('open'), meetings, contacts))
      .toBe(createHash('sha256').update(canonical).digest('hex'));
  });

  it('reports which component changed', () => {
    const base = computeEvidenceComponents('in-progress', digest('open'), meetings, contacts);
    expect(computeEvidenceComponents('in-progress', digest('open'), meetings, contacts)).toEqual(base);
    const taskChange = computeEvidenceComponents('in-progress', digest('done'), meetings, contacts);
    expect(Object.keys(base).filter(k => base[k as keyof typeof base] !== taskChange[k as keyof typeof base])).toEqual(['tasks']);
    const edited = { ...digest('open'), notes: [{ id: 'n1', title: 'N', file_path: 'N.md', file_mtime: 2, content_hash: 'edited', project_count: 3 }] };
    const noteChange = computeEvidenceComponents('in-progress', edited, meetings, contacts);
    expect(Object.keys(base).filter(k => base[k as keyof typeof base] !== noteChange[k as keyof typeof base])).toEqual(['notes']);
    const statusChange = computeEvidenceComponents('done', digest('open'), meetings, contacts);
    expect(Object.keys(base).filter(k => base[k as keyof typeof base] !== statusChange[k as keyof typeof base])).toEqual(['status']);
  });

  it('changes when a task status changes', () => {
    expect(computeEvidenceHash('in-progress', digest('done'), meetings, contacts))
      .not.toBe(computeEvidenceHash('in-progress', digest('open'), meetings, contacts));
  });

  it('does NOT change when only churn_rate / hot moves (convergence guarantee)', () => {
    const base = digest('open');
    const churned = { ...base, signals: { ...base.signals, churn_rate: 99, hot: [{ id: 'x', title: 'x', file_path: 'x', file_mtime: 9, content_hash: null }] } };
    expect(computeEvidenceHash('in-progress', churned, meetings, contacts))
      .toBe(computeEvidenceHash('in-progress', base, meetings, contacts));
  });

  it('ignores wiki metadata while the topology hash changes for the same metadata', () => {
    const baselinePage = catalogPage();
    const changedPage = catalogPage({
      wiki_state: 'retired',
      wiki_kind: 'timeline',
      wiki_origin: 'requested',
      wiki_scope: { v: 1, subject: 'P', facet: 'Changed' },
      wiki_pinned: true,
      wiki_replaced_by: { id: 's2', title: 'P — Beta' },
    });

    expect(computeEvidenceHash('in-progress', digest('open', changedPage), meetings, contacts))
      .toBe(computeEvidenceHash('in-progress', digest('open', baselinePage), meetings, contacts));
    expect(computeWikiTopologyHash([changedPage])).not.toBe(computeWikiTopologyHash([baselinePage]));
  });
});

function seedWikiHome(db: ReturnType<typeof createTestDb>, curatedAt?: string): void {
  seedNode(db, 'w1', 'Wiki/Project.md', 'Project Wiki', Date.now(), ['wiki']);
  rel(db, 'w1', 'Project', 'wiki_for', 'p1');
  if (curatedAt !== undefined) {
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_text) VALUES ('w1', 'wiki_curated_at', ?)").run(curatedAt);
  }
}

describe('the suite\'s own notes in project evidence (#600)', () => {
  it('leaves a marked note linked to the project out of notes, salience and changed-since', () => {
    const db = createTestDb();
    seedProjectGraph(db);
    seedWikiHome(db, '2026-01-01T00:00:00.000Z');
    const now = Date.now();
    seedNode(db, 'n1', 'Notes/Plan.md', 'Pilot plan', now, ['note']);
    rel(db, 'n1', 'Project', 'project', 'p1');
    seedNode(db, 'j1', 'Wikis/Curator Journal — 2026-09.md', 'Curator Journal — 2026-09', now, ['note']);
    rel(db, 'j1', 'Project', 'project', 'p1');
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_text) VALUES ('j1', 'vault_engine_projection', 'journal')").run();

    const ev = buildProjectEvidence(db, { project: 'Project', since: 'auto' });

    expect(ev.notes.map(note => note.id)).toContain('n1');
    expect(ev.notes.map(note => note.id)).not.toContain('j1');
    expect(ev.synthesis_hints.salience.map(entry => entry.id)).not.toContain('j1');
    const changed = Object.values(ev.changed_since_curation!.buckets).flat().map(node => node.id);
    expect(changed).toContain('n1');
    expect(changed).not.toContain('j1');
  });
});

describe('project counts in project evidence (#474)', () => {
  it('counts the projects each note and meeting is filed under, and leaves evidence_hash alone', () => {
    const db = createTestDb();
    seedProjectGraph(db);
    const now = Date.now();
    seedNode(db, 'n1', 'Notes/Plan.md', 'Pilot plan', now, ['note']);
    rel(db, 'n1', 'Project', 'project', 'p1');
    seedNode(db, 'x1', 'Notes/Northwind rollout.md', 'Northwind rollout', now, ['note']);
    rel(db, 'n1', 'Northwind rollout', 'wiki-link', 'x1');
    seedNode(db, 'p2', 'Projects/Beta.md', 'Project Beta', now, ['project']);
    rel(db, 'm1', 'Project Beta', 'project', 'p2');

    const before = buildProjectEvidence(db, { project: 'Project' });
    expect(before.notes.find(note => note.id === 'n1')?.project_count).toBe(1);
    const meetings = [...before.meetings.recent, ...before.meetings.upcoming];
    expect(Object.fromEntries(meetings.map(meeting => [meeting.id, meeting.project_count]))).toEqual({ m1: 2, m2: 1, m3: 1 });

    // The note n1 links to becomes a project: n1's count moves, but n1 is unchanged, so the hash holds.
    db.prepare("INSERT INTO node_types (node_id, schema_type) VALUES ('x1', 'project')").run();
    const after = buildProjectEvidence(db, { project: 'Project' });
    expect(after.notes.find(note => note.id === 'n1')?.project_count).toBe(2);
    expect(after.evidence_hash).toBe(before.evidence_hash);
    expect(after.evidence_components).toEqual(before.evidence_components);
  });

  it('reports people named without a note and leaves evidence_hash alone (#474)', () => {
    const db = createTestDb();
    seedProjectGraph(db);
    const before = buildProjectEvidence(db, { project: 'Project' });
    expect(before.contacts.unlinked).toEqual([]);
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, NULL)')
      .run('p1', 'Dana Reyes', 'people involved', null);
    const after = buildProjectEvidence(db, { project: 'Project' });
    expect(after.contacts.unlinked).toEqual([{ name: 'Dana Reyes', direct: true, meeting_count: 0 }]);
    expect(after.evidence_hash).toBe(before.evidence_hash);
    expect(after.evidence_components).toEqual(before.evidence_components);
  });
});

describe('resolveAutoSinceMs', () => {
  it('reads the wiki home\'s wiki_curated_at', () => {
    const db = createTestDb();
    seedProjectGraph(db);
    seedWikiHome(db, '2026-01-01T00:00:00.000Z');
    expect(resolveAutoSinceMs(db, 'w1')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });
  it('null when there is no wiki home', () => {
    expect(resolveAutoSinceMs(createTestDb(), null)).toBeNull();
  });
  it('null when the field is missing or unparseable', () => {
    const db = createTestDb();
    seedProjectGraph(db);
    seedWikiHome(db); // no field
    expect(resolveAutoSinceMs(db, 'w1')).toBeNull();
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_text) VALUES ('w1', 'wiki_curated_at', 'not-a-date')").run();
    expect(resolveAutoSinceMs(db, 'w1')).toBeNull();
  });
});

describe('buildProjectEvidence since:\'auto\'', () => {
  it('curated wiki home → changed_since_curation populated with the resolved ISO echo', () => {
    const db = createTestDb();
    seedProjectGraph(db);
    seedWikiHome(db, '2026-01-01T00:00:00.000Z');
    const ev = buildProjectEvidence(db, { project: 'Project', since: 'auto' });
    expect(Object.keys(ev.evidence_components).sort()).toEqual(['contacts', 'meetings', 'notes', 'status', 'tasks']);
    expect(ev.changed_since_curation).toBeDefined();
    expect(ev.changed_since_curation!.since).toBe(new Date(Date.parse('2026-01-01T00:00:00.000Z')).toISOString());
    // seedProjectGraph's meetings point at p1 with file_mtime ≈ now (> 2026-01-01) → non-empty buckets
    const total = Object.values(ev.changed_since_curation!.buckets).reduce((n, arr) => n + arr.length, 0);
    expect(total).toBeGreaterThan(0);
  });
  it('no wiki home → delta absent, no throw', () => {
    const db = createTestDb();
    seedProjectGraph(db);
    const ev = buildProjectEvidence(db, { project: 'Project', since: 'auto' });
    expect(ev.changed_since_curation).toBeUndefined();
  });
  it('wiki home without wiki_curated_at → delta absent', () => {
    const db = createTestDb();
    seedProjectGraph(db);
    seedWikiHome(db);
    const ev = buildProjectEvidence(db, { project: 'Project', since: 'auto' });
    expect(ev.changed_since_curation).toBeUndefined();
  });
  it('explicit since keeps working unchanged', () => {
    const db = createTestDb();
    seedProjectGraph(db);
    const ev = buildProjectEvidence(db, { project: 'Project', since: '2026-01-01T00:00:00.000Z' });
    expect(ev.changed_since_curation).toBeDefined();
  });
});
