import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { makeMemoriesServer, callTool } from './memories.test.js';
import { setStoredSettings } from '../../src/settings/store.js';
import { vaultNameIssues, getVaultSettings } from '../../src/settings/vault.js';
import { moveSubjects, subjectName } from '../../src/memories/subjects.js';

const EV = { kind: 'conversation', ref: 'chat#1' };
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));

function note(db: Database.Database, id: string, filePath: string, types: string[], aliases?: string[]): void {
  const title = filePath.replace(/^.*\//, '').replace(/\.md$/, '');
  db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)').run(id, filePath, title, '', `h-${id}`);
  for (const type of types) db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, type);
  if (aliases) db.prepare("INSERT INTO node_fields (node_id, field_name, value_json) VALUES (?, 'aliases', ?)").run(id, JSON.stringify(aliases));
}

function server() {
  const made = makeMemoriesServer();
  cleanup.push(() => made.db.close());
  const { db } = made;
  note(db, 'dana', 'People/Dana Whitfield.md', ['person'], ['Dana W']);
  note(db, 'acme', 'Companies/Acme Corp.md', ['company'], ['Acme']);
  note(db, 'lee1', 'People/Lee Okafor.md', ['person'], ['Lee']);
  note(db, 'lee2', 'People/Lee Park.md', ['person'], ['Lee']);
  note(db, 'mtg', 'Meetings/Kickoff.md', ['meeting']);
  return made;
}

type Subject = { name: string; node_id: string | null; title: string | null; status: string; set_by: string };
const subjectsOf = (res: { data: { subjects: Subject[] } }) => res.data.subjects.map(s => [s.name, s.node_id, s.status]);
const subjectWarnings = (res: { warnings: Array<{ code: string; message: string }> }) =>
  res.warnings.filter(w => w.code === 'MEMORY_SUBJECT_UNRESOLVED').map(w => w.message);

describe('memory subjects (#554)', () => {
  it('links names to notes of the entity kinds by title, alias, link or id, and keeps the rest as names', async () => {
    const { server: s } = server();
    const res = await callTool(s, 'create-memory', {
      evidence: EV, source: 'chat', content: 'Dana leads the Acme rollout',
      subjects: ['Dana Whitfield', 'Acme Corp', '[[Lee Park|Lee]]', 'mtg', 'Kickoff', 'Rowan Hale', 'Lee'],
    });
    expect(res.ok).toBe(true);
    expect(subjectsOf(res)).toEqual([
      ['Dana Whitfield', 'dana', 'linked'],
      ['Acme Corp', 'acme', 'linked'],
      ['Lee Park', 'lee2', 'linked'],
      // A meeting is not a kind memories are about by default: its id and title are only names.
      ['mtg', null, 'unresolved'],
      ['Kickoff', null, 'unresolved'],
      ['Rowan Hale', null, 'unresolved'],
      // Two people answer to "Lee": linked to neither.
      ['Lee', null, 'ambiguous'],
    ]);
    expect(res.data.subjects[0].title).toBe('Dana Whitfield');
    expect(res.data.subjects[0].set_by).toBe('tool');
    const unresolved = subjectWarnings(res);
    expect(unresolved).toHaveLength(2);
    expect(unresolved[0]!).toContain('"Rowan Hale"');
    expect(unresolved[1]!).toContain('"Lee"');
  });

  it('takes a note id for an entity note, and drops repeats of one note', async () => {
    const { server: s } = server();
    const res = await callTool(s, 'create-memory', {
      evidence: EV, source: 'chat', content: 'Dana prefers mornings', subjects: ['dana', 'Dana W', '[[Dana Whitfield]]', ' '],
    });
    expect(subjectsOf(res)).toEqual([['Dana Whitfield', 'dana', 'linked']]);
    expect(subjectWarnings(res)).toEqual([]);
  });

  it('refuses more than 20 subjects', async () => {
    const { server: s } = server();
    await expect(callTool(s, 'create-memory', {
      evidence: EV, source: 'chat', content: 'Too many', subjects: Array.from({ length: 21 }, (_, i) => `N${i}`),
    })).rejects.toThrow();
  });

  it('lists the memories about a note, by link and by a name that has come to answer to it', async () => {
    const { server: s, db } = server();
    const linked = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Dana runs the pilot', subjects: ['Dana W'] });
    const named = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Rowan joined in March', subjects: ['Rowan Hale'] });
    await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Lee is out Fridays', subjects: ['Lee'] });
    await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Nothing about anyone' });

    const about = async (id: string) => (await callTool(s, 'list-memories', { subject_of: id })).data.memories.map((m: { id: number }) => m.id);
    expect(await about('dana')).toEqual([linked.data.id]);
    expect(await about('rowan')).toEqual([]);
    // The ambiguous "Lee" belongs to neither until one is named.
    expect(await about('lee1')).toEqual([]);
    expect(await about('lee2')).toEqual([]);

    // A note answering to the kept name now exists: the memory is about it, with no rerun.
    note(db, 'rowan', 'People/Rowan Hale.md', ['person']);
    expect(await about('rowan')).toEqual([named.data.id]);
    const got = await callTool(s, 'get-memory', { id: named.data.id });
    expect(subjectsOf(got)).toEqual([['Rowan Hale', 'rowan', 'linked']]);
  });

  it('keeps a linked note through a rename, and reads a deleted note\'s subject by its name', async () => {
    const { server: s, db } = server();
    const res = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Dana likes tea', subjects: ['Dana Whitfield'] });
    db.prepare("UPDATE nodes SET title = 'Dana Whitfield-Ng', file_path = 'People/Dana Whitfield-Ng.md' WHERE id = 'dana'").run();
    let got = await callTool(s, 'get-memory', { id: res.data.id });
    expect(got.data.subjects[0]).toMatchObject({ name: 'Dana Whitfield', node_id: 'dana', title: 'Dana Whitfield-Ng', status: 'linked' });

    db.prepare("DELETE FROM nodes WHERE id = 'dana'").run();
    got = await callTool(s, 'get-memory', { id: res.data.id });
    expect(got.data.subjects[0]).toMatchObject({ name: 'Dana Whitfield', node_id: null, status: 'unresolved' });
    note(db, 'dana2', 'People/Dana Whitfield.md', ['person']);
    expect((await callTool(s, 'list-memories', { subject_of: 'dana2' })).data.memories).toHaveLength(1);
  });

  it('replaces subjects in place, keeping what they replaced and moving updated_at', async () => {
    const { server: s } = server();
    const res = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Dana and Acme signed', subjects: ['Dana W', 'Acme Corp'] });
    await new Promise(resolve => setTimeout(resolve, 5));
    const upd = await callTool(s, 'update-memory', { id: res.data.id, subjects: ['Acme Corp', 'Lee Okafor'] });
    expect(upd.data.id).toBe(res.data.id);
    expect(subjectsOf(upd)).toEqual([['Acme Corp', 'acme', 'linked'], ['Lee Okafor', 'lee1', 'linked']]);
    expect(upd.data.updated_at > res.data.updated_at).toBe(true);
    const got = await callTool(s, 'get-memory', { id: res.data.id, include_history: true });
    expect(got.data.history).toEqual([expect.objectContaining({ change: 'edited', previous: { subjects: ['Dana W', 'Acme Corp'] } })]);

    const cleared = await callTool(s, 'update-memory', { id: res.data.id, subjects: [] });
    expect(cleared.data.subjects).toEqual([]);
  });

  it('lets a note id or path pick one of several notes that share a title, and switch between them (#691)', async () => {
    const { server: s, db } = server();
    note(db, 'alex1', 'People/Sales/Alex Smith.md', ['person']);
    note(db, 'alex2', 'People/Support/Alex Smith.md', ['person']);
    const res = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Alex owns the renewal', subjects: ['Alex Smith'] });
    expect(subjectsOf(res)).toEqual([['Alex Smith', null, 'ambiguous']]);

    let upd = await callTool(s, 'update-memory', { id: res.data.id, subjects: ['alex1'] });
    expect(subjectsOf(upd)).toEqual([['Alex Smith', 'alex1', 'linked']]);
    upd = await callTool(s, 'update-memory', { id: res.data.id, subjects: ['People/Support/Alex Smith'] });
    expect(subjectsOf(upd)).toEqual([['People/Support/Alex Smith', 'alex2', 'linked']]);
    upd = await callTool(s, 'update-memory', { id: res.data.id, subjects: ['alex1'] });
    expect(subjectsOf(upd)).toEqual([['Alex Smith', 'alex1', 'linked']]);
    expect((await callTool(s, 'list-memories', { subject_of: 'alex1' })).data.memories).toHaveLength(1);
    expect((await callTool(s, 'list-memories', { subject_of: 'alex2' })).data.memories).toHaveLength(0);
    // The same name typed again keeps the note it is linked to.
    upd = await callTool(s, 'update-memory', { id: res.data.id, subjects: ['Alex Smith'] });
    expect(subjectsOf(upd)).toEqual([['Alex Smith', 'alex1', 'linked']]);
  });

  it('carries subjects to a new version, and to the memory that supersedes another', async () => {
    const { server: s } = server();
    const first = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Dana works at Acme', subjects: ['Dana W'] });
    const v2 = await callTool(s, 'update-memory', { id: first.data.id, content: 'Dana works at Acme as CTO', evidence: { kind: 'conversation', ref: 'chat#2' } });
    expect(v2.data.id).not.toBe(first.data.id);
    expect(subjectsOf(v2)).toEqual([['Dana W', 'dana', 'linked']]);

    const other = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Zed: the Acme CTO is Dana', subjects: ['Acme Corp'] });
    await callTool(s, 'expire-memory', { id: v2.data.id, reason: 'duplicate', superseded_by: other.data.id });
    const got = await callTool(s, 'get-memory', { id: other.data.id });
    expect(subjectsOf(got)).toEqual([['Acme Corp', 'acme', 'linked'], ['Dana W', 'dana', 'linked']]);

    // Earlier versions are about the note too, with include_superseded.
    const all = await callTool(s, 'list-memories', { subject_of: 'dana', include_superseded: true });
    expect(all.data.memories.map((m: { id: number }) => m.id).sort()).toEqual([first.data.id, v2.data.id, other.data.id].sort());
    const live = await callTool(s, 'list-memories', { subject_of: 'dana' });
    expect(live.data.memories.map((m: { id: number }) => m.id)).toEqual([other.data.id]);
  });

  it('lists the memories another replaced, by why, and never a live one (#717)', async () => {
    const { server: s } = server();
    const old = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Dana works at Acme', subjects: ['Dana W'] });
    const now = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Dana works at Contoso', subjects: ['Dana W'] });
    await callTool(s, 'expire-memory', { id: old.data.id, reason: 'contradicted', superseded_by: now.data.id, invalid_at: '2026-03-04' });
    const copy = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Dana is at Contoso now', subjects: ['Dana W'] });
    await callTool(s, 'expire-memory', { id: copy.data.id, reason: `duplicate-of:${now.data.id}`, superseded_by: now.data.id });
    const past = await callTool(s, 'list-memories', { subject_of: 'dana', expire_reasons: ['contradicted', 'superseded-by-update'] });
    expect(past.ok).toBe(true);
    expect(past.data.memories.map((m: { id: number; expire_reason: string }) => [m.id, m.expire_reason])).toEqual([[old.data.id, 'contradicted']]);
    expect(past.data.memories[0].invalid_at).toMatch(/^2026-03-04/);
    expect(past.data.total).toBe(1);
    const duplicates = await callTool(s, 'list-memories', { subject_of: 'dana', expire_reasons: [`duplicate-of:${now.data.id}`] });
    expect(duplicates.data.memories.map((m: { id: number }) => m.id)).toEqual([copy.data.id]);
    expect((await callTool(s, 'list-memories', { subject_of: 'dana' })).data.memories.map((m: { id: number }) => m.id)).toEqual([now.data.id]);
  });

  it('follows the vault map: a kind the owner adds, and none when the list is empty', async () => {
    const { server: s, db } = server();
    note(db, 'biscuit', 'Pets/Biscuit Brown.md', ['pet']);
    let res = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Biscuit hates baths', subjects: ['Biscuit Brown'] });
    expect(subjectsOf(res)).toEqual([['Biscuit Brown', null, 'unresolved']]);

    setStoredSettings(db, 'vault', { entityTypes: ['person', 'company', 'project', 'pet'] });
    expect((await callTool(s, 'list-memories', { subject_of: 'biscuit' })).data.memories).toHaveLength(1);
    res = await callTool(s, 'get-memory', { id: res.data.id });
    expect(subjectsOf(res)).toEqual([['Biscuit Brown', 'biscuit', 'linked']]);

    setStoredSettings(db, 'vault', { entityTypes: [] });
    const none = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Dana is away', subjects: ['Dana Whitfield'] });
    expect(subjectsOf(none)).toEqual([['Dana Whitfield', null, 'unresolved']]);
    expect(subjectWarnings(none)[0]).toContain('are none');
  });

  it('removes a purged memory\'s subjects, and points a merged note\'s at the kept note', async () => {
    const { server: s, db } = server();
    const a = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Alpha fact', subjects: ['Lee Okafor'] });
    const b = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Beta fact', subjects: ['Lee Okafor', 'Lee Park'] });
    const before = (await callTool(s, 'get-memory', { id: b.data.id })).data.updated_at;
    await new Promise(resolve => setTimeout(resolve, 5));
    moveSubjects(db, 'lee2', 'lee1');
    // B lost a name ("Lee Okafor"), so its revision moved, as the memory note needs (#691).
    expect((await callTool(s, 'get-memory', { id: b.data.id })).data.updated_at > before).toBe(true);
    expect(subjectsOf(await callTool(s, 'get-memory', { id: a.data.id }))).toEqual([['Lee Okafor', 'lee2', 'linked']]);
    expect(subjectsOf(await callTool(s, 'get-memory', { id: b.data.id }))).toEqual([['Lee Park', 'lee2', 'linked']]);

    await callTool(s, 'expire-memory', { id: a.data.id, purge: true, confirm: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_subjects WHERE memory_id = ?').get(a.data.id)).toEqual({ n: 0 });
  });

  it('warns when the vault map lists a kind no note has, and follows its person, company and project kinds unlisted', async () => {
    const { server: s, db } = server();
    setStoredSettings(db, 'vault', { entityTypes: ['person', 'vehicle'] });
    const issues = vaultNameIssues(db, getVaultSettings(db)).filter(issue => issue.key === 'entityTypes');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('"vehicle"');

    // Unlisted: the person kind is whatever the vault map calls it, and none is none.
    note(db, 'sam', 'Contacts/Sam Reyes.md', ['contact']);
    setStoredSettings(db, 'vault', { entityTypes: null, personType: 'contact', companyType: null });
    expect(vaultNameIssues(db, getVaultSettings(db)).filter(issue => issue.key === 'entityTypes')).toEqual([]);
    const res = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Sam visits Acme', subjects: ['Sam Reyes', 'Acme Corp'] });
    expect(subjectsOf(res)).toEqual([['Sam Reyes', 'sam', 'linked'], ['Acme Corp', null, 'unresolved']]);
  });

  it('links a one-word name to a person only when the memory\'s source note is that note or links to it (owner, 11-20)', async () => {
    const { server: s, db } = server();
    note(db, 'kim', 'People/Kim Lee.md', ['person'], ['Kim']);
    note(db, 'notes1', 'Notes/Kim call.md', []);
    db.prepare("INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES ('notes1', 'Kim Lee', 'people involved', 'kim')").run();
    note(db, 'notes2', 'Notes/Unrelated.md', []);
    const noteEv = (id: string) => ({ kind: 'note', node_id: id, hash: `h-${id}` });

    // From a chat: no source note, so "Kim" is held as a name, with a warning saying why.
    const chat = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Kim wants SSO', subjects: ['Kim'] });
    expect(subjectsOf(chat)).toEqual([['Kim', null, 'unresolved']]);
    expect(subjectWarnings(chat)[0]).toContain('one-word name');
    // From a note that links Kim Lee: linked.
    const linked = await callTool(s, 'create-memory', { evidence: noteEv('notes1'), source: 'curator', content: 'Kim renewed for two years', subjects: ['Kim'] });
    expect(subjectsOf(linked)).toEqual([['Kim', 'kim', 'linked']]);
    // From Kim Lee's own note: linked.
    const own = await callTool(s, 'create-memory', { evidence: noteEv('kim'), source: 'curator', content: 'Kim is based in Leeds', subjects: ['Kim'] });
    expect(subjectsOf(own)).toEqual([['Kim', 'kim', 'linked']]);
    // From a note that does not link her: held.
    const other = await callTool(s, 'create-memory', { evidence: noteEv('notes2'), source: 'curator', content: 'Kim has a new role', subjects: ['Kim'] });
    expect(subjectsOf(other)).toEqual([['Kim', null, 'unresolved']]);
    // A path is not held.
    const path = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Kim moved offices', subjects: ['People/Kim Lee'] });
    expect(subjectsOf(path)).toEqual([['People/Kim Lee', 'kim', 'linked']]);

    const about = (await callTool(s, 'list-memories', { subject_of: 'kim' })).data.memories.map((m: { id: number }) => m.id).sort();
    expect(about).toEqual([linked.data.id, own.data.id, path.data.id].sort());
  });

  it('carries a subject as it reads now, so a new version from a chat keeps a one-word person (#691)', async () => {
    const { server: s, db } = server();
    note(db, 'src', 'Notes/Pilot sync.md', []);
    const first = await callTool(s, 'create-memory', { evidence: { kind: 'note', node_id: 'src', hash: 'h-src' }, source: 'curator', content: 'Rowan joined the pilot', subjects: ['Rowan'] });
    note(db, 'rowan', 'People/Rowan.md', ['person']);
    db.prepare("INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES ('src', 'Rowan', 'wiki-link', 'rowan')").run();
    expect(subjectsOf(await callTool(s, 'get-memory', { id: first.data.id }))).toEqual([['Rowan', 'rowan', 'linked']]);

    // A new version from a chat has no source note; the subject still reaches Rowan.
    const v2 = await callTool(s, 'update-memory', { id: first.data.id, content: 'Rowan joined the pilot in March', evidence: EV });
    expect(subjectsOf(v2)).toEqual([['Rowan', 'rowan', 'linked']]);
    expect((await callTool(s, 'list-memories', { subject_of: 'rowan' })).data.memories.map((m: { id: number }) => m.id)).toEqual([v2.data.id]);
  });

  it('gives a superseding memory\'s unlinked name the note the retired memory reached by it (#691)', async () => {
    const { server: s, db } = server();
    note(db, 'src', 'Notes/Pilot sync.md', []);
    note(db, 'kim', 'People/Kim.md', ['person']);
    db.prepare("INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES ('src', 'Kim', 'wiki-link', 'kim')").run();
    const fromNote = await callTool(s, 'create-memory', { evidence: { kind: 'note', node_id: 'src', hash: 'h-src' }, source: 'curator', content: 'Kim runs QA', subjects: ['Kim'] });
    const fromChat = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Zz: Kim leads QA now', subjects: ['Kim'] });
    expect(subjectsOf(fromChat)).toEqual([['Kim', null, 'unresolved']]);
    await callTool(s, 'expire-memory', { id: fromNote.data.id, reason: 'duplicate', superseded_by: fromChat.data.id });
    expect(subjectsOf(await callTool(s, 'get-memory', { id: fromChat.data.id }))).toEqual([['Kim', 'kim', 'linked']]);
    expect((await callTool(s, 'list-memories', { subject_of: 'kim' })).data.memories.map((m: { id: number }) => m.id)).toEqual([fromChat.data.id]);
  });

  it('links a one-word company or project name from a chat: the rule is for people only', async () => {
    const { server: s, db } = server();
    const acme = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Acme wants SSO', subjects: ['Acme'] });
    expect(subjectsOf(acme)).toEqual([['Acme', 'acme', 'linked']]);
    expect(subjectWarnings(acme)).toEqual([]);
    // Kept, then matched later on its own once a project note answers to it.
    const phoenix = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Phoenix ships in May', subjects: ['Phoenix'] });
    note(db, 'phoenix', 'Projects/Phoenix.md', ['project']);
    expect((await callTool(s, 'list-memories', { subject_of: 'phoenix' })).data.memories.map((m: { id: number }) => m.id)).toEqual([phoenix.data.id]);
  });

  it('matches a kept one-word name later only through the memory\'s source note', async () => {
    const { server: s, db } = server();
    note(db, 'src', 'Notes/Pilot sync.md', []);
    const fromNote = await callTool(s, 'create-memory', { evidence: { kind: 'note', node_id: 'src', hash: 'h-src' }, source: 'curator', content: 'Rowan joined the pilot', subjects: ['Rowan'] });
    const fromChat = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Rowan likes tea', subjects: ['Rowan'] });
    // A Rowan note appears, and the source note now links it: only that memory joins its set.
    note(db, 'rowan', 'People/Rowan.md', ['person']);
    db.prepare("INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES ('src', 'Rowan', 'wiki-link', 'rowan')").run();
    const about = (await callTool(s, 'list-memories', { subject_of: 'rowan' })).data.memories.map((m: { id: number }) => m.id);
    expect(about).toEqual([fromNote.data.id]);
    expect(subjectsOf(await callTool(s, 'get-memory', { id: fromNote.data.id }))).toEqual([['Rowan', 'rowan', 'linked']]);
    expect(subjectsOf(await callTool(s, 'get-memory', { id: fromChat.data.id }))).toEqual([['Rowan', null, 'unresolved']]);
    // A two-word name matches later on its own, as before.
    const full = await callTool(s, 'create-memory', { evidence: EV, source: 'chat', content: 'Rowan Hale runs QA', subjects: ['Rowan Hale'] });
    note(db, 'hale', 'People/Rowan Hale.md', ['person']);
    expect((await callTool(s, 'list-memories', { subject_of: 'hale' })).data.memories.map((m: { id: number }) => m.id)).toEqual([full.data.id]);
  });

  it('reads a link\'s target as the name', () => {
    expect(subjectName('[[People/Dana Whitfield|Dana]]')).toBe('People/Dana Whitfield');
    expect(subjectName('[[Dana Whitfield#Role]]')).toBe('Dana Whitfield');
    expect(subjectName('  C# guild  ')).toBe('C# guild');
  });
});
