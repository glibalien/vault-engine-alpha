import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { makeMemoriesServer, callTool } from './memories.test.js';
import { setStoredSettings } from '../../src/settings/store.js';
import { getVaultSettings, vaultNameIssues } from '../../src/settings/vault.js';
import { backfillMemorySubjects, clearMatchedSubjects } from '../../src/memories/subject-backfill.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));

function note(db: Database.Database, id: string, filePath: string, types: string[], aliases?: string[]): void {
  const title = filePath.replace(/^.*\//, '').replace(/\.md$/, '');
  db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)').run(id, filePath, title, '', `h-${id}`);
  for (const type of types) db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, type);
  if (aliases) db.prepare("INSERT INTO node_fields (node_id, field_name, value_json) VALUES (?, 'aliases', ?)").run(id, JSON.stringify(aliases));
}

function memory(db: Database.Database, content: string, evidenceNodeId?: string): number {
  return Number(db.prepare(
    `INSERT INTO memories (source, scope, content, created_at, updated_at, valid_at, evidence_kind, evidence_node_id, evidence_hash, evidence_ref)
     VALUES ('curator', 'vault', ?, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', ?, ?, ?, ?)`,
  ).run(content, evidenceNodeId ? 'note' : 'conversation', evidenceNodeId ?? null, evidenceNodeId ? 'h' : null, evidenceNodeId ? null : 'c#1').lastInsertRowid);
}

function setup() {
  const made = makeMemoriesServer();
  cleanup.push(() => made.db.close());
  const { db } = made;
  note(db, 'dana', 'People/Dana Whitfield.md', ['person'], ['Dana W']);
  note(db, 'kim', 'People/Kim.md', ['person']);
  note(db, 'me', 'People/Avery Stone.md', ['person']);
  note(db, 'acme', 'Companies/Acme Corp.md', ['company'], ['Acme']);
  note(db, 'apple', 'Companies/Apple.md', ['company']);
  note(db, 'alex1', 'People/Sales/Alex Smith.md', ['person']);
  note(db, 'alex2', 'People/Support/Alex Smith.md', ['person']);
  note(db, 'vault', 'Projects/Vault Engine.md', ['project']);
  note(db, 'call', 'Notes/Renewal call.md', []);
  db.prepare("INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES ('call', 'Apple', 'company', 'apple')").run();
  setStoredSettings(db, 'vault', { ownerNote: 'Avery Stone' });
  return made;
}

const rows = (db: Database.Database, id: number) =>
  db.prepare('SELECT name, node_id, set_by FROM memory_subjects WHERE memory_id = ? ORDER BY rowid').all(id) as Array<{ name: string; node_id: string; set_by: string }>;

describe('backfill-memory-subjects (#554, slice 2)', () => {
  it('names the entity notes a memory\'s text names, its source note, and never the owner', async () => {
    const { server, db } = setup();
    const full = memory(db, "Dana Whitfield's team reviews on Tuesdays");
    const several = memory(db, 'Avery Stone met Dana W and Acme Corp about the Vault Engine pilot');
    const watch = memory(db, 'Avery has an Apple Watch');
    const renewal = memory(db, 'Apple signed the renewal for two years', 'call');
    const own = memory(db, 'She runs QA on Fridays', 'kim');
    const shared = memory(db, 'Alex Smith joined the call');
    const owner = memory(db, 'Avery Stone prefers short agendas');
    const already = memory(db, 'Dana Whitfield and Acme Corp signed');
    db.prepare("INSERT INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, 'Dana Whitfield', 'dana whitfield', 'dana', 'tool', 'x')").run(already);

    const preview = await callTool(server, 'backfill-memory-subjects', {});
    expect(preview.ok).toBe(true);
    expect(preview.data).toMatchObject({ dry_run: true, memories_read: 7, memories_matched: 4, subjects: 6 });
    expect(preview.data.top_notes[0]).toEqual({ node_id: 'dana', title: 'Dana Whitfield', memories: 2 });
    expect(preview.data.samples.find((sample: { memory_id: number }) => sample.memory_id === several).subjects)
      .toEqual(['Dana Whitfield', 'Acme Corp', 'Vault Engine']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_subjects WHERE set_by = 'match'").get()).toEqual({ n: 0 });

    const done = await callTool(server, 'backfill-memory-subjects', { dry_run: false });
    expect(done.data).toMatchObject({ dry_run: false, memories_matched: 4, subjects: 6 });
    expect(rows(db, full)).toEqual([{ name: 'Dana Whitfield', node_id: 'dana', set_by: 'match' }]);
    expect(rows(db, several).map(row => row.node_id)).toEqual(['dana', 'acme', 'vault']);
    // "Apple" is one word: named only through a source note that links Apple.
    expect(rows(db, watch)).toEqual([]);
    expect(rows(db, renewal).map(row => row.node_id)).toEqual(['apple']);
    // Drawn from Kim's own note.
    expect(rows(db, own).map(row => row.node_id)).toEqual(['kim']);
    // Two notes are called Alex Smith; the owner is never a subject.
    expect(rows(db, shared)).toEqual([]);
    expect(rows(db, owner)).toEqual([]);
    // Left alone: it had a subject.
    expect(rows(db, already)).toEqual([{ name: 'Dana Whitfield', node_id: 'dana', set_by: 'tool' }]);
    expect((db.prepare('SELECT updated_at FROM memories WHERE id = ?').get(full) as { updated_at: string }).updated_at > '2026-11-01').toBe(true);

    // Run again: only the memories still without subjects are read.
    const again = await callTool(server, 'backfill-memory-subjects', { dry_run: false });
    expect(again.data).toMatchObject({ memories_read: 3, memories_matched: 0, subjects: 0 });

    // clear takes back out only what the backfill wrote.
    const clearPreview = await callTool(server, 'backfill-memory-subjects', { clear: true });
    expect(clearPreview.data).toEqual({ dry_run: true, memories: 4, subjects: 6 });
    await callTool(server, 'backfill-memory-subjects', { clear: true, dry_run: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_subjects WHERE set_by = 'match'").get()).toEqual({ n: 0 });
    expect(rows(db, already)).toHaveLength(1);
  });

  it('matches names with punctuation, notes at the vault root, and keeps two same-titled notes apart (#693)', async () => {
    const { server, db } = setup();
    note(db, 'inc', 'Companies/Globex Inc..md', ['company']);
    db.prepare("UPDATE nodes SET title = 'Globex Inc.' WHERE id = 'inc'").run();
    note(db, 'paren', 'Projects/Project (Alpha).md', ['project']);
    note(db, 'root', 'Riley Chen.md', ['person']);
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_json) VALUES ('alex1', 'aliases', ?)").run(JSON.stringify(['Alex from Sales']));
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_json) VALUES ('alex2', 'aliases', ?)").run(JSON.stringify(['Alex from Support']));
    const punct = memory(db, 'Globex Inc. joined Project (Alpha) last week.');
    const atRoot = memory(db, 'Riley Chen leads the rollout');
    const twoAlexes = memory(db, 'Alex from Sales handed the account to Alex from Support');

    await callTool(server, 'backfill-memory-subjects', { dry_run: false });
    expect(rows(db, punct).map(row => row.node_id)).toEqual(['inc', 'paren']);
    expect(rows(db, atRoot).map(row => row.node_id)).toEqual(['root']);
    expect(rows(db, twoAlexes)).toEqual([
      { name: 'People/Sales/Alex Smith', node_id: 'alex1', set_by: 'match' },
      { name: 'People/Support/Alex Smith', node_id: 'alex2', set_by: 'match' },
    ]);
  });

  it('reads a possessive before punctuation, and marks a chat client\'s backfill on the memories it changes (#693)', () => {
    const { db } = setup();
    const quoted = memory(db, 'The rollout is "Dana Whitfield’s." call');
    const plain = memory(db, 'Riley wrote this down');
    const done = backfillMemorySubjects(db, { dryRun: false, changedBy: 'client 1234abcd "Chat"' });
    expect(done.memories_matched).toBe(1);
    expect(rows(db, quoted).map(row => row.node_id)).toEqual(['dana']);
    const marked = (id: number) => (db.prepare('SELECT changed_by FROM memories WHERE id = ?').get(id) as { changed_by: string | null }).changed_by;
    expect(marked(quoted)).toBe('client 1234abcd "Chat"');
    expect(marked(plain)).toBeNull();
    clearMatchedSubjects(db, { dryRun: false, changedBy: 'client 5678abcd "Other"' });
    expect(marked(quoted)).toBe('client 5678abcd "Other"');
  });

  it('never makes the owner a subject through a held one-word name, then or later (#693)', async () => {
    const { server, db } = setup();
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_json) VALUES ('me', 'aliases', ?)").run(JSON.stringify(['Avery']));
    note(db, 'src', 'Notes/Standup.md', []);
    const res = await callTool(server, 'create-memory', {
      evidence: { kind: 'note', node_id: 'src', hash: 'h-src' }, source: 'curator', content: 'Avery runs standup', subjects: ['Avery'],
    });
    expect(res.data.subjects).toEqual([]);
    // A name stored before ownerNote was set, then the source note links the owner: still no subject.
    db.prepare("INSERT INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, 'Avery', 'avery', NULL, 'tool', 'x')").run(res.data.id);
    db.prepare("INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES ('src', 'Avery Stone', 'wiki-link', 'me')").run();
    const got = await callTool(server, 'get-memory', { id: res.data.id });
    expect(got.data.subjects).toEqual([expect.objectContaining({ name: 'Avery', node_id: null, status: 'unresolved' })]);
    expect((await callTool(server, 'list-memories', { subject_of: 'me' })).data.memories).toEqual([]);
    // The owner's own edit links it.
    db.prepare("UPDATE memory_subjects SET set_by = 'owner' WHERE memory_id = ?").run(res.data.id);
    expect((await callTool(server, 'list-memories', { subject_of: 'me' })).data.memories).toHaveLength(1);
  });

  it('leaves the owner out of subjects a tool gives, and in when the owner names them', async () => {
    const { server } = setup();
    const res = await callTool(server, 'create-memory', {
      evidence: { kind: 'conversation', ref: 'c#2' }, source: 'chat', content: 'Avery and Dana talked',
      subjects: ['Avery Stone', 'Dana Whitfield'],
    });
    expect(res.data.subjects.map((subject: { node_id: string }) => subject.node_id)).toEqual(['dana']);
  });

  it('warns when ownerNote names no note', () => {
    const { db } = setup();
    expect(vaultNameIssues(db, getVaultSettings(db)).filter(issue => issue.key === 'ownerNote')).toEqual([]);
    setStoredSettings(db, 'vault', { ownerNote: 'Nobody Here' });
    const issues = vaultNameIssues(db, getVaultSettings(db)).filter(issue => issue.key === 'ownerNote');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('"Nobody Here"');
  });
});

describe('memories written with no subjects get the free match (#738)', () => {
  const EV = { kind: 'conversation', ref: 'chat#1' };
  const subjectsOf = (res: { data: { subjects?: Array<{ name: string; node_id: string | null; set_by: string }> } }) =>
    (res.data.subjects ?? []).map(s => [s.name, s.node_id, s.set_by]);

  it('tags a chat memory that names someone, at once, and it is in their subject set', async () => {
    const { server: s } = setup();
    const res = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Dana Whitfield prefers short agendas for Acme Corp reviews.' });
    expect(res.ok).toBe(true);
    expect(subjectsOf(res)).toEqual([['Dana Whitfield', 'dana', 'match'], ['Acme Corp', 'acme', 'match']]);
    const about = await callTool(s, 'list-memories', { subject_of: 'dana' });
    expect(about.data.memories.map((m: { id: number }) => m.id)).toEqual([res.data.id]);
    // The same rules as the backfill: no one-word name without the source note's link, never the owner.
    const loose = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Kim and Avery Stone talked about Apple.' });
    expect(subjectsOf(loose)).toEqual([]);
  });

  it('leaves the subjects a writer gives as they are, and a memory that names no one alone', async () => {
    const { server: s, db } = setup();
    const given = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Dana Whitfield joined Acme Corp.', subjects: ['Dana W'] });
    expect(subjectsOf(given)).toEqual([['Dana W', 'dana', 'tool']]);
    const none = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Prefers tea to coffee.' });
    expect(subjectsOf(none)).toEqual([]);
    expect(rows(db, none.data.id)).toEqual([]);
    // What the match wrote, the backfill's clear takes back out.
    await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Acme Corp renews in March.' });
    expect(clearMatchedSubjects(db, { dryRun: true }).subjects).toBe(1);
  });

  it('replies with the subjects the match gave and the memory\'s new revision', async () => {
    const { server: s, db } = setup();
    const res = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Dana Whitfield moved to the platform team.' });
    const row = db.prepare('SELECT updated_at FROM memories WHERE id = ?').get(res.data.id) as { updated_at: string };
    expect(res.data.updated_at).toBe(row.updated_at);
    expect(rows(db, res.data.id)).toEqual([{ name: 'Dana Whitfield', node_id: 'dana', set_by: 'match' }]);
  });
});

