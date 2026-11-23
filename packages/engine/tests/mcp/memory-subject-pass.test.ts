import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { makeMemoriesServer, callTool } from './memories.test.js';
import { setStoredSettings } from '../../src/settings/store.js';
import { SERVICE_ONLY_TOOL_NAMES } from '../../src/mcp/tool-surface.js';

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
    `INSERT INTO memories (source, scope, content, category, created_at, updated_at, valid_at, evidence_kind, evidence_node_id, evidence_hash, evidence_ref)
     VALUES ('curator', 'vault', ?, 'fact', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', ?, ?, ?, ?)`,
  ).run(content, evidenceNodeId ? 'note' : 'conversation', evidenceNodeId ?? null, evidenceNodeId ? 'h' : null, evidenceNodeId ? null : 'c#1').lastInsertRowid);
}

const link = (db: Database.Database, from: string, to: string): void => {
  db.prepare("INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES (?, ?, 'wiki-link', ?)").run(from, to, to);
};

function setup() {
  const made = makeMemoriesServer();
  cleanup.push(() => made.db.close());
  const { db } = made;
  note(db, 'dana', 'People/Dana Whitfield.md', ['person']);
  note(db, 'kim', 'People/Kim.md', ['person']);
  note(db, 'me', 'People/Avery Stone.md', ['person']);
  note(db, 'acme', 'Companies/Acme.md', ['company']);
  note(db, 'alex1', 'People/Sales/Alex Smith.md', ['person']);
  note(db, 'alex2', 'People/Support/Alex Smith.md', ['person']);
  note(db, 'call', 'Notes/Renewal call.md', []);
  note(db, 'other', 'Notes/Other.md', []);
  link(db, 'call', 'dana');
  link(db, 'call', 'acme');
  link(db, 'call', 'me');
  link(db, 'call', 'other');
  setStoredSettings(db, 'vault', { ownerNote: 'Avery Stone' });
  return made;
}

const rows = (db: Database.Database, id: number) =>
  db.prepare('SELECT name, node_id, set_by FROM memory_subjects WHERE memory_id = ? ORDER BY rowid').all(id) as Array<{ name: string; node_id: string | null; set_by: string }>;

describe('memory-subject-pass (#554, slice 2)', () => {
  it('is for services only', () => {
    expect(SERVICE_ONLY_TOOL_NAMES).toContain('memory-subject-pass');
  });

  it('lists the live memories with no subjects but the free match\'s, with their source note and the entity notes it links, never the owner', async () => {
    const { server, db } = setup();
    const fromCall = memory(db, 'Dana takes the renewal', 'call');
    const fromChat = memory(db, 'Prefers short agendas');
    // Its only subject is the free match's: listed, with that subject, for the names it missed.
    const matched = memory(db, 'Dana Whitfield signed with Acme');
    db.prepare("INSERT INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, 'Dana Whitfield', 'dana whitfield', 'dana', 'match', 'x')").run(matched);
    // A subject a writer gave: not listed.
    const given = memory(db, 'Dana Whitfield signed');
    db.prepare("INSERT INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, 'Dana Whitfield', 'dana whitfield', 'dana', 'tool', 'x')").run(given);
    const expired = memory(db, 'Old news', 'call');
    db.prepare("UPDATE memories SET expired_at = '2026-11-02' WHERE id = ?").run(expired);
    const fromDana = memory(db, 'Runs QA on Fridays', 'dana');

    const listed = await callTool(server, 'memory-subject-pass', { action: 'list' });
    expect(listed.ok).toBe(true);
    expect(listed.data).toEqual({
      total: 4,
      next_after_id: null,
      memories: [
        { id: fromCall, content: 'Dana takes the renewal', category: 'fact', source_title: 'Renewal call', source_names: ['Dana Whitfield', 'Acme'], subjects: [] },
        { id: fromChat, content: 'Prefers short agendas', category: 'fact', source_title: null, source_names: [], subjects: [] },
        { id: matched, content: 'Dana Whitfield signed with Acme', category: 'fact', source_title: null, source_names: [], subjects: ['Dana Whitfield'] },
        // A memory drawn from a person's own note: that person is among the names.
        { id: fromDana, content: 'Runs QA on Fridays', category: 'fact', source_title: 'Dana Whitfield', source_names: ['Dana Whitfield'], subjects: [] },
      ],
    });

    const first = await callTool(server, 'memory-subject-pass', { action: 'list', limit: 2 });
    expect(first.data).toMatchObject({ total: 4, next_after_id: fromChat });
    const rest = await callTool(server, 'memory-subject-pass', { action: 'list', after_id: fromChat });
    expect(rest.data).toMatchObject({ total: 2, next_after_id: null, memories: [{ id: matched }, { id: fromDana }] });
  });

  it('writes the names to memories that still have none, marked "model", as create-memory resolves them', async () => {
    const { server, db } = setup();
    const fromCall = memory(db, 'Dana and Acme agreed the renewal', 'call');
    const fromChat = memory(db, 'Dana asked about Acme pricing');
    const newcomer = memory(db, 'Jordan Lee joined the team', 'call');
    const owner = memory(db, 'Avery prefers short agendas');
    const shared = memory(db, 'Alex Smith joined the call');
    const taken = memory(db, 'Acme signed');
    db.prepare("INSERT INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, 'Acme', 'acme', 'acme', 'owner', 'x')").run(taken);
    const items = [
      { memory_id: fromCall, subjects: ['Dana Whitfield', 'Acme'] },
      // From a chat: "Kim" is a one-word person's name with no source note to link her, and "Dana" alone no note's name.
      { memory_id: fromChat, subjects: ['Kim', 'Dana', 'Acme'] },
      { memory_id: newcomer, subjects: ['Jordan Lee'] },
      // The owner, by full name and by first name alone, is never written.
      { memory_id: owner, subjects: ['Avery Stone', 'Avery'] },
      { memory_id: shared, subjects: ['Alex Smith'] },
      { memory_id: taken, subjects: ['Acme'] },
      { memory_id: 9999, subjects: ['Acme'] },
    ];

    const preview = await callTool(server, 'memory-subject-pass', { action: 'write', items, dry_run: true });
    expect(preview.ok).toBe(true);
    expect(preview.data).toMatchObject({ dry_run: true, memories: 4, subjects: 7 });
    expect(preview.data.results).toEqual([
      { memory_id: fromCall, outcome: 'written', written_at: expect.any(String), subjects: [
        { name: 'Dana Whitfield', status: 'linked', title: 'Dana Whitfield' }, { name: 'Acme', status: 'linked', title: 'Acme' },
      ] },
      { memory_id: fromChat, outcome: 'written', written_at: expect.any(String), subjects: [
        { name: 'Kim', status: 'unresolved', title: null, held: true }, { name: 'Dana', status: 'unresolved', title: null },
        { name: 'Acme', status: 'linked', title: 'Acme' },
      ] },
      { memory_id: newcomer, outcome: 'written', written_at: expect.any(String), subjects: [{ name: 'Jordan Lee', status: 'unresolved', title: null }] },
      { memory_id: owner, outcome: 'none', subjects: [] },
      { memory_id: shared, outcome: 'written', written_at: expect.any(String), subjects: [{ name: 'Alex Smith', status: 'ambiguous', title: null }] },
      { memory_id: taken, outcome: 'has_subjects', subjects: [] },
      { memory_id: 9999, outcome: 'not_found', subjects: [] },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_subjects').get()).toEqual({ n: 1 });

    const written = await callTool(server, 'memory-subject-pass', { action: 'write', items });
    expect(written.data).toMatchObject({ dry_run: false, memories: 4, subjects: 7 });
    expect(rows(db, fromCall)).toEqual([
      { name: 'Dana Whitfield', node_id: 'dana', set_by: 'model' }, { name: 'Acme', node_id: 'acme', set_by: 'model' },
    ]);
    expect(rows(db, fromChat)).toEqual([
      { name: 'Kim', node_id: null, set_by: 'model' }, { name: 'Dana', node_id: null, set_by: 'model' }, { name: 'Acme', node_id: 'acme', set_by: 'model' },
    ]);
    expect(rows(db, owner)).toEqual([]);
    expect((db.prepare('SELECT updated_at FROM memories WHERE id = ?').get(fromCall) as { updated_at: string }).updated_at > '2026-11-01').toBe(true);

    // A memory that has subjects now is left alone the second time.
    const again = await callTool(server, 'memory-subject-pass', { action: 'write', items: [{ memory_id: fromCall, subjects: ['Jordan Lee'] }] });
    expect(again.data.results).toEqual([{ memory_id: fromCall, outcome: 'has_subjects', subjects: [] }]);
    expect(rows(db, fromCall)).toHaveLength(2);

    // A retired memory is not written either.
    const retired = memory(db, 'Acme moved offices', 'call');
    db.prepare("UPDATE memories SET expired_at = '2026-11-02' WHERE id = ?").run(retired);
    const late = await callTool(server, 'memory-subject-pass', { action: 'write', items: [{ memory_id: retired, subjects: ['Acme'] }] });
    expect(late.data.results).toEqual([{ memory_id: retired, outcome: 'not_live', subjects: [] }]);
  });

  it('adds to a memory whose only subjects are the free match\'s, never naming one twice or taking one away', async () => {
    const { server, db } = setup();
    const id = memory(db, 'Dana Whitfield is the Acme account lead', 'call');
    db.prepare("INSERT INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, 'Dana Whitfield', 'dana whitfield', 'dana', 'match', 'x')").run(id);
    const nothingNew = memory(db, 'Dana Whitfield joined', 'call');
    db.prepare("INSERT INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, 'Dana Whitfield', 'dana whitfield', 'dana', 'match', 'x')").run(nothingNew);
    const owned = memory(db, 'Acme renewed', 'call');
    db.prepare("INSERT INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, 'Acme', 'acme', 'acme', 'owner', 'x')").run(owned);

    const written = await callTool(server, 'memory-subject-pass', { action: 'write', items: [
      // The model names the whole list; only Acme is new.
      { memory_id: id, subjects: ['Dana Whitfield', 'Acme'] },
      { memory_id: nothingNew, subjects: ['Dana Whitfield'] },
      { memory_id: owned, subjects: ['Dana Whitfield'] },
    ] });
    expect(written.data).toMatchObject({ memories: 1, subjects: 1 });
    expect(written.data.results).toEqual([
      { memory_id: id, outcome: 'written', written_at: expect.any(String), subjects: [{ name: 'Acme', status: 'linked', title: 'Acme' }] },
      { memory_id: nothingNew, outcome: 'none', subjects: [] },
      { memory_id: owned, outcome: 'has_subjects', subjects: [] },
    ]);
    expect(rows(db, id)).toEqual([
      { name: 'Dana Whitfield', node_id: 'dana', set_by: 'match' }, { name: 'Acme', node_id: 'acme', set_by: 'model' },
    ]);

    // Undo takes back the model's only; the free match's stays.
    await callTool(server, 'memory-subject-pass', { action: 'clear', writes: [{ memory_id: id, written_at: written.data.results[0].written_at }] });
    expect(rows(db, id)).toEqual([{ name: 'Dana Whitfield', node_id: 'dana', set_by: 'match' }]);
    // Once the model has added to it, it is out of the pass's scope.
    await callTool(server, 'memory-subject-pass', { action: 'write', items: [{ memory_id: id, subjects: ['Acme'] }] });
    const listed = await callTool(server, 'memory-subject-pass', { action: 'list' });
    expect((listed.data.memories as Array<{ id: number }>).map(each => each.id)).toEqual([nothingNew]);
  });

  it('clears only the subjects a write marked "model", named by memory and the time of the write', async () => {
    const { server, db } = setup();
    const one = memory(db, 'Dana and Acme agreed the renewal', 'call');
    const two = memory(db, 'Acme moved offices', 'call');
    const kept = memory(db, 'Acme hired Dana', 'call');
    const first = await callTool(server, 'memory-subject-pass', { action: 'write', items: [
      { memory_id: one, subjects: ['Dana Whitfield', 'Acme'] }, { memory_id: two, subjects: ['Acme'] }, { memory_id: kept, subjects: ['Acme'] },
    ] });
    const writes = (first.data.results as Array<{ memory_id: number; written_at: string }>)
      .filter(result => result.memory_id !== kept).map(({ memory_id, written_at }) => ({ memory_id, written_at }));
    expect(writes.every(write => typeof write.written_at === 'string')).toBe(true);
    // The owner adds one of their own to the first memory.
    db.prepare("INSERT INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, 'Jordan Lee', 'jordan lee', NULL, 'owner', 'x')").run(one);

    const preview = await callTool(server, 'memory-subject-pass', { action: 'clear', writes: [...writes, { memory_id: 9999, written_at: 'x' }], dry_run: true });
    expect(preview.data).toEqual({ dry_run: true, cleared: [one, two], subjects: 3 });
    expect(rows(db, one)).toHaveLength(3);

    const cleared = await callTool(server, 'memory-subject-pass', { action: 'clear', writes });
    expect(cleared.data).toEqual({ dry_run: false, cleared: [one, two], subjects: 3 });
    expect(rows(db, one)).toEqual([{ name: 'Jordan Lee', node_id: null, set_by: 'owner' }]);
    expect(rows(db, two)).toEqual([]);
    expect(rows(db, kept)).toHaveLength(1);
  });

  it('leaves a later write\'s subjects when an earlier write is cleared (Codex, #695)', async () => {
    const { server, db } = setup();
    const id = memory(db, 'Acme moved offices', 'call');
    const earlier = await callTool(server, 'memory-subject-pass', { action: 'write', items: [{ memory_id: id, subjects: ['Acme'] }] });
    const earlierWrite = { memory_id: id, written_at: earlier.data.results[0].written_at as string };
    // The owner removes them; a later run gives the memory new ones.
    db.prepare('DELETE FROM memory_subjects WHERE memory_id = ?').run(id);
    await new Promise(resolve => setTimeout(resolve, 5));
    await callTool(server, 'memory-subject-pass', { action: 'write', items: [{ memory_id: id, subjects: ['Dana Whitfield'] }] });

    const cleared = await callTool(server, 'memory-subject-pass', { action: 'clear', writes: [earlierWrite] });
    expect(cleared.data).toEqual({ dry_run: false, cleared: [], subjects: 0 });
    expect(rows(db, id)).toEqual([{ name: 'Dana Whitfield', node_id: 'dana', set_by: 'model' }]);
  });

  it('names what each action needs', async () => {
    const { server } = setup();
    expect((await callTool(server, 'memory-subject-pass', { action: 'write' })).error).toMatchObject({ code: 'INVALID_PARAMS', message: 'write takes items.' });
    expect((await callTool(server, 'memory-subject-pass', { action: 'clear' })).error).toMatchObject({ code: 'INVALID_PARAMS', message: 'clear takes writes.' });
  });
});
