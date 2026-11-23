import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { upgradeBoardLinksStore, upgradeBoardsStore } from '../../src/db/migrate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { registerMergeNodes } from '../../src/mcp/tools/merge-nodes.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';
import { MERGE_LIMITS } from '../../src/merge/service.js';
import { SUITE_NOTE_FIELD } from '../../src/notes/suite-notes.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let server: McpServer;

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
  server = new McpServer({ name: 'merge-test', version: '0' });
  registerMergeNodes(server, db, writeLock, vaultPath, undefined, undefined, 'Settings');
  registerUndoOperations(server, db, writeLock, vaultPath);
});

afterEach(() => {
  writeLock.clearRecentWrites();
  db.close();
  cleanup();
});

interface Envelope {
  ok: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  warnings: Array<{ code: string; message: string }>;
}

async function call(name: string, args: Record<string, unknown>): Promise<Envelope> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const result = await (tool.callback ? tool.callback(args) : tool.handler(args));
  return JSON.parse(result.content[0].text) as Envelope;
}
const merge = (args: Record<string, unknown>): Promise<Envelope> => call('merge-nodes', args);

interface Seed { types?: string[]; fields?: Record<string, unknown>; raw?: Record<string, string>; body?: string; asTyped?: boolean }

/** Create a note through the pipeline, so its file is written and its links are bound. Returns its id. */
function note(path: string, seed: Seed = {}): string {
  const title = path.split('/').pop()!.replace(/\.md$/, '');
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: path, title,
    types: seed.types ?? [], fields: seed.fields ?? {}, body: seed.body ?? '',
    ...(seed.raw ? { raw_field_texts: seed.raw } : {}),
    // asTyped: keep links as written, as a note typed in Obsidian has them.
    ...(seed.asTyped ? { canonicalizeLinks: false } : {}),
  }).node_id;
}

/** What the vault holds, table by table: a refused merge leaves every row as it was. */
const stored = (): unknown => ['nodes', 'node_types', 'node_fields', 'relationships', 'memories', 'undo_operations', 'undo_snapshots', 'edits_log']
  .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all());
/** Save a note's file as Obsidian would, and let the watcher read it. */
function typed(path: string, content: string): void {
  writeFileSync(join(vaultPath, path), content);
  processFileChange(join(vaultPath, path), path, db, writeLock, vaultPath);
}
const file = (path: string): string | null => (existsSync(join(vaultPath, path)) ? readFileSync(join(vaultPath, path), 'utf8') : null);
const boundTo = (source: string): Array<{ target: string; rel: string; to: string | null }> =>
  db.prepare('SELECT target, rel_type AS rel, resolved_target_id AS "to" FROM relationships WHERE source_id = ? ORDER BY rel_type, target').all(source) as Array<{ target: string; rel: string; to: string | null }>;
const field = (id: string, name: string): unknown => {
  const row = db.prepare('SELECT value_text, value_json FROM node_fields WHERE node_id = ? AND field_name = ?').get(id, name) as { value_text: string | null; value_json: string | null } | undefined;
  return row === undefined ? undefined : row.value_json !== null ? JSON.parse(row.value_json) : row.value_text;
};

describe('merge-nodes', () => {
  it('previews by default and changes nothing', async () => {
    const kept = note('People/Dana Whitfield.md', { fields: { email: 'dana@acme.example', role: 'Buyer' }, body: 'Met at the trade fair.' });
    const other = note('People/Dana W.md', { fields: { phone: '555-0100', role: 'Head of buying' }, body: 'Prefers email.' });
    const meeting = note('Meetings/Kickoff.md', { body: 'With [[Dana W]] and [[Dana Whitfield]].' });
    const before = db.serialize();
    const files = ['People/Dana Whitfield.md', 'People/Dana W.md', 'Meetings/Kickoff.md'].map(file);

    const preview = await merge({ keep: kept, merge: [other] });
    expect(preview.ok).toBe(true);
    expect(preview.data).toMatchObject({
      dry_run: true,
      kept: { id: kept, title: 'Dana Whitfield', path: 'People/Dana Whitfield.md' },
      merged: [{ id: other, title: 'Dana W', path: 'People/Dana W.md' }],
      fields: {
        carried: [{ field: 'phone', from: other }],
        combined: [],
        conflicts: [{ field: 'role', kept: 'Buyer', others: [{ note: other, value: 'Head of buying' }], resolved_by: 'kept' }],
        set: [],
      },
      types_added: [],
      aliases_added: ['Dana W'],
      body: { supplied: false, joined: [other], same_text: [], empty: [] },
      links: { notes: 1, examples: [{ id: meeting, title: 'Kickoff', path: 'Meetings/Kickoff.md' }], written_as: 'Dana Whitfield', fields_left_alone: [] },
    });
    expect(preview.data.operation_id).toBeUndefined();
    expect(preview.warnings.map(warning => warning.code)).toEqual(['MERGE_CONFLICT']);
    expect(db.serialize()).toEqual(before);
    expect(['People/Dana Whitfield.md', 'People/Dana W.md', 'Meetings/Kickoff.md'].map(file)).toEqual(files);
  });

  it('folds a note into another: fields, text, alias, and every link', async () => {
    const kept = note('People/Dana Whitfield.md', { fields: { email: 'dana@acme.example', role: 'Buyer', tags: ['client'] }, body: 'Met at the trade fair.' });
    const other = note('People/Dana W.md', { fields: { phone: '555-0100', role: 'Head of buying', tags: ['client', 'vip'] }, body: '## Role\n\nPrefers email.' });
    const meeting = note('Meetings/Kickoff.md', {
      fields: { attendees: ['Dana W', 'Lee Okafor'], lead: 'Dana W' },
      raw: { attendees: JSON.stringify(['[[Dana W]]', 'Lee Okafor']), lead: '[[Dana W]]' },
      body: 'With [[Dana W]], [[Dana W|Dana]] and [[Dana W#Role]].\n\n| who |\n| --- |\n| [[Dana W\\|D]] |\n\n`[[Dana W]]` in code stays.',
    });
    const untouched = note('Meetings/Other.md', { body: 'Only [[Dana Whitfield]] here.' });
    const untouchedFile = file('Meetings/Other.md');

    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    expect(done.data).toMatchObject({ dry_run: false, fields: { carried: [{ field: 'phone', from: other }], combined: [{ field: 'tags', from: other, added: 1 }] }, links: { notes: 1 } });
    expect(typeof done.data.operation_id).toBe('string');

    // The merged note is gone, file and all.
    expect(db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(other)).toBeUndefined();
    expect(file('People/Dana W.md')).toBeNull();

    // The kept note has what both held; its own value won the conflict.
    expect(field(kept, 'email')).toBe('dana@acme.example');
    expect(field(kept, 'phone')).toBe('555-0100');
    expect(field(kept, 'role')).toBe('Buyer');
    expect(field(kept, 'tags')).toEqual(['client', 'vip']);
    expect(field(kept, 'aliases')).toEqual(['Dana W']);
    const keptFile = file('People/Dana Whitfield.md')!;
    expect(keptFile.endsWith('Met at the trade fair.\n\n## Merged from Dana W\n\n## Role\n\nPrefers email.\n')).toBe(true);
    expect(keptFile).toContain('phone: 555-0100');
    expect(keptFile).toMatch(/aliases:\n {2}- Dana W\n/);

    // Every link names the kept note, in the form it was written in.
    const meetingFile = file('Meetings/Kickoff.md')!;
    expect(meetingFile).toContain('With [[Dana Whitfield]], [[Dana Whitfield|Dana]] and [[Dana Whitfield#Role]].');
    expect(meetingFile).toContain('| [[Dana Whitfield\\|D]] |');
    expect(meetingFile).toContain('`[[Dana W]]` in code stays.');
    expect(meetingFile).toContain('lead: "[[Dana Whitfield]]"');
    expect(meetingFile).toMatch(/attendees:\n {2}- "\[\[Dana Whitfield\]\]"\n {2}- Lee Okafor\n/);
    expect(field(meeting, 'attendees')).toEqual(['Dana Whitfield', 'Lee Okafor']);
    for (const edge of boundTo(meeting)) {
      if (edge.target.startsWith('Dana Whitfield')) expect(edge.to).toBe(kept);
    }
    expect(boundTo(meeting).some(edge => edge.target.startsWith('Dana W') && !edge.target.startsWith('Dana Whitfield'))).toBe(false);
    // A note that never named the merged note is not rewritten.
    expect(file('Meetings/Other.md')).toBe(untouchedFile);
    expect(boundTo(untouched)).toEqual([{ target: 'Dana Whitfield', rel: 'wiki-link', to: kept }]);
  });

  it('is one undo: the removed note, the kept note and every rewritten link come back', async () => {
    const kept = note('People/Dana Whitfield.md', { fields: { role: 'Buyer' }, body: 'Met at the trade fair.' });
    const other = note('People/Dana W.md', { fields: { phone: '555-0100' }, body: 'Prefers email.' });
    const meeting = note('Meetings/Kickoff.md', { fields: { lead: 'Dana W' }, raw: { lead: '[[Dana W]]' }, body: 'With [[Dana W]].' });
    const paths = ['People/Dana Whitfield.md', 'People/Dana W.md', 'Meetings/Kickoff.md'];
    const before = paths.map(file);

    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    expect(paths.map(file)).not.toEqual(before);

    const undone = await call('undo-operations', { operation_ids: [done.data.operation_id], dry_run: false });
    expect(undone.ok).toBe(true);
    expect(paths.map(file)).toEqual(before);
    expect(db.prepare('SELECT title FROM nodes WHERE id = ?').get(other)).toEqual({ title: 'Dana W' });
    expect(field(kept, 'phone')).toBeUndefined();
    expect(field(kept, 'aliases')).toBeUndefined();
    expect(boundTo(meeting)).toEqual([{ target: 'Dana W', rel: 'lead', to: other }, { target: 'Dana W', rel: 'wiki-link', to: other }]);
  });

  it('moves memory subjects to the kept note, and its undo puts them back (#554)', async () => {
    const kept = note('People/Dana Whitfield.md');
    const other = note('People/Dana W.md');
    const memory = (content: string): number => Number(db.prepare(
      `INSERT INTO memories (source, scope, content, created_at, updated_at, valid_at, evidence_kind, evidence_ref)
       VALUES ('chat', 'vault', ?, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'conversation', 'c#1')`,
    ).run(content).lastInsertRowid);
    const subject = db.prepare(
      "INSERT INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, ?, ?, ?, 'tool', '2026-11-01T00:00:00.000Z')",
    );
    const onlyOther = memory('About the copy');
    subject.run(onlyOther, 'Dana W', 'dana w', other);
    const both = memory('About both');
    subject.run(both, 'Dana Whitfield', 'dana whitfield', kept);
    subject.run(both, 'Dana W', 'dana w', other);
    const subjects = (id: number) => db.prepare('SELECT name, node_id FROM memory_subjects WHERE memory_id = ? ORDER BY name').all(id);

    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    expect(subjects(onlyOther)).toEqual([{ name: 'Dana W', node_id: kept }]);
    expect(subjects(both)).toEqual([{ name: 'Dana Whitfield', node_id: kept }]);

    const undone = await call('undo-operations', { operation_ids: [done.data.operation_id], dry_run: false });
    expect(undone.ok).toBe(true);
    expect(subjects(onlyOther)).toEqual([{ name: 'Dana W', node_id: other }]);
    expect(subjects(both)).toEqual([{ name: 'Dana W', node_id: other }, { name: 'Dana Whitfield', node_id: kept }]);
    // The restore moved both memories' revisions, as any subject change does.
    expect((db.prepare('SELECT updated_at FROM memories WHERE id = ?').get(both) as { updated_at: string }).updated_at > '2026-11-01T00:00:00.000Z').toBe(true);
  });

  it('moves a subject that reached a merged note only by name, aliases or not (#554)', async () => {
    createSchemaDefinition(db, { name: 'person', field_claims: [] });
    const kept = note('People/Dana Whitfield.md', { types: ['person'] });
    const other = note('People/Dana W.md', { types: ['person'] });
    const id = Number(db.prepare(
      `INSERT INTO memories (source, scope, content, created_at, updated_at, valid_at, evidence_kind, evidence_ref)
       VALUES ('chat', 'vault', 'Named before the note existed', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'conversation', 'c#1')`,
    ).run().lastInsertRowid);
    // Stored with no note: it reaches "Dana W" only by name.
    db.prepare("INSERT INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, 'Dana W', 'dana w', NULL, 'tool', '2026-11-01T00:00:00.000Z')").run(id);

    const done = await merge({ keep: kept, merge: [other], keep_titles_as_aliases: false, dry_run: false });
    expect(done.ok).toBe(true);
    expect(db.prepare('SELECT node_id FROM memory_subjects WHERE memory_id = ?').get(id)).toEqual({ node_id: kept });

    const undone = await call('undo-operations', { operation_ids: [done.data.operation_id], dry_run: false });
    expect(undone.ok).toBe(true);
    expect(db.prepare('SELECT node_id FROM memory_subjects WHERE memory_id = ?').get(id)).toEqual({ node_id: other });
  });

  it('puts back on undo every subject a merge of several notes dropped (#554)', async () => {
    const kept = note('People/Dana Whitfield.md');
    const b = note('People/Dana W.md');
    const c = note('People/D Whitfield.md');
    const id = Number(db.prepare(
      `INSERT INTO memories (source, scope, content, created_at, updated_at, valid_at, evidence_kind, evidence_ref)
       VALUES ('chat', 'vault', 'About the two copies', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'conversation', 'c#1')`,
    ).run().lastInsertRowid);
    const subject = db.prepare(
      "INSERT INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, ?, ?, ?, 'tool', '2026-11-01T00:00:00.000Z')",
    );
    subject.run(id, 'Dana W', 'dana w', b);
    subject.run(id, 'D Whitfield', 'd whitfield', c);
    const subjects = () => db.prepare('SELECT name, node_id FROM memory_subjects WHERE memory_id = ? ORDER BY name').all(id);

    const done = await merge({ keep: kept, merge: [b, c], dry_run: false });
    expect(done.ok).toBe(true);
    expect(subjects()).toHaveLength(1);
    expect((subjects()[0] as { node_id: string }).node_id).toBe(kept);

    const undone = await call('undo-operations', { operation_ids: [done.data.operation_id], dry_run: false });
    expect(undone.ok).toBe(true);
    expect(subjects()).toEqual([{ name: 'D Whitfield', node_id: c }, { name: 'Dana W', node_id: b }]);
  });

  it('leaves on undo a memory subject edited since the merge (#554)', async () => {
    const kept = note('People/Dana Whitfield.md');
    const other = note('People/Dana W.md');
    const third = note('People/Dana Ward.md');
    const memory = (content: string): number => Number(db.prepare(
      `INSERT INTO memories (source, scope, content, created_at, updated_at, valid_at, evidence_kind, evidence_ref)
       VALUES ('chat', 'vault', ?, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'conversation', 'c#1')`,
    ).run(content).lastInsertRowid);
    const subject = db.prepare(
      "INSERT INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, ?, ?, ?, 'tool', '2026-11-01T00:00:00.000Z')",
    );
    const repointed = memory('Repointed after the merge');
    subject.run(repointed, 'Dana W', 'dana w', other);
    const readded = memory('About both, then edited');
    subject.run(readded, 'Dana Whitfield', 'dana whitfield', kept);
    subject.run(readded, 'Dana W', 'dana w', other);

    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    // After the merge: one subject is pointed at a third note, the other's dropped name is added back by hand.
    db.prepare('UPDATE memory_subjects SET node_id = ? WHERE memory_id = ?').run(third, repointed);
    subject.run(readded, 'Dana W', 'dana w', third);

    const undone = await call('undo-operations', { operation_ids: [done.data.operation_id], dry_run: false });
    expect(undone.ok).toBe(true);
    const subjects = (id: number) => db.prepare('SELECT name, node_id FROM memory_subjects WHERE memory_id = ? ORDER BY name').all(id);
    expect(subjects(repointed)).toEqual([{ name: 'Dana W', node_id: third }]);
    expect(subjects(readded)).toEqual([{ name: 'Dana W', node_id: third }, { name: 'Dana Whitfield', node_id: kept }]);
  });

  it('lets the caller choose a conflict\'s value, set other fields and supply the text', async () => {
    const kept = note('People/Dana Whitfield.md', { fields: { role: 'Buyer', city: 'Leeds', fax: '555-0199' }, body: 'Old text.' });
    const other = note('People/Dana W.md', { fields: { role: 'Head of buying', city: 'York' }, body: 'Other text.' });

    const preview = await merge({ keep: kept, merge: [other], set_fields: { role: 'Head of buying', fax: null, note: 'merged by hand' }, body: 'One text.' });
    expect(preview.data.fields).toMatchObject({
      conflicts: [
        { field: 'city', kept: 'Leeds', others: [{ note: other, value: 'York' }], resolved_by: 'kept' },
        { field: 'role', kept: 'Buyer', resolved_by: 'set_fields' },
      ],
      set: ['role', 'fax', 'note'],
    });
    expect(preview.data.body).toEqual({ supplied: true, joined: [], same_text: [], empty: [] });

    const done = await merge({ keep: kept, merge: [other], set_fields: { role: 'Head of buying', fax: null, note: 'merged by hand' }, body: 'One text.', dry_run: false });
    expect(done.ok).toBe(true);
    expect(field(kept, 'role')).toBe('Head of buying');
    expect(field(kept, 'city')).toBe('Leeds');
    expect(field(kept, 'fax')).toBeUndefined();
    expect(field(kept, 'note')).toBe('merged by hand');
    expect(file('People/Dana Whitfield.md')).toMatch(/---\nOne text\.\n?$/);
  });

  it('folds several notes into one, skipping text the note already holds', async () => {
    const kept = note('Notes/Lentil soup.md', { body: '' });
    const copy = note('Imported/Lentil soup 1.md', { fields: { serves: 4 }, body: 'Soften the onions.\n' });
    const sameText = note('Imported/Lentil soup 2.md', { fields: { serves: 6, time: '35 minutes' }, body: 'Soften the onions.' });
    const longer = note('Imported/Lentil soup 3.md', { body: 'Soften the onions, then add the stock.' });
    const blank = note('Imported/Lentil soup 4.md', { body: '   \n' });
    const index = note('Index.md', { body: '[[Lentil soup 1]] [[Lentil soup 2]] [[Lentil soup 3]] [[Lentil soup 4]]' });

    const done = await merge({ keep: kept, merge: [copy, sameText, longer, blank], dry_run: false });
    expect(done.ok).toBe(true);
    expect(done.data).toMatchObject({
      body: { joined: [copy, longer], same_text: [sameText], empty: [blank] },
      aliases_added: ['Lentil soup 1', 'Lentil soup 2', 'Lentil soup 3', 'Lentil soup 4'],
      fields: { carried: [{ field: 'serves', from: copy }, { field: 'time', from: sameText }], conflicts: [{ field: 'serves', kept: 4, others: [{ note: sameText, value: 6 }] }] },
    });
    // An empty note takes the first text as its own; the next says where it came from.
    expect(file('Notes/Lentil soup.md')).toMatch(/---\nSoften the onions\.\n\n## Merged from Lentil soup 3\n\nSoften the onions, then add the stock\.\n?$/);
    expect(file('Index.md')).toContain('[[Lentil soup]] [[Lentil soup]] [[Lentil soup]] [[Lentil soup]]');
    expect(boundTo(index).every(edge => edge.to === kept)).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS count FROM nodes').get() as { count: number }).count).toBe(2);
  });

  it('names the kept note by its path where another note shares its name', async () => {
    const kept = note('People/Sam Ortiz.md', { body: 'The buyer.' });
    const copy = note('Archive/Sam Ortiz.md', { body: 'The buyer.' });
    note('Clients/Sam Ortiz.md', { body: 'Another Sam.' });
    const keptFile = file('People/Sam Ortiz.md');
    const keptVersion = db.prepare('SELECT version FROM nodes WHERE id = ?').get(kept);
    const meeting = note('Meetings/Kickoff.md', { body: 'With [[Archive/Sam Ortiz]] and [[Archive/Sam Ortiz|Sam]].' });
    expect(boundTo(meeting).every(edge => edge.to === copy)).toBe(true);

    const done = await merge({ keep: kept, merge: [copy], dry_run: false });
    expect(done.ok).toBe(true);
    // Same title: no alias to add, and the name alone would be ambiguous.
    expect(done.data).toMatchObject({ aliases_added: [], links: { written_as: 'People/Sam Ortiz.md' }, body: { same_text: [copy] } });
    expect(file('Meetings/Kickoff.md')).toContain('With [[People/Sam Ortiz.md|Sam Ortiz]] and [[People/Sam Ortiz.md|Sam]].');
    expect(boundTo(meeting).every(edge => edge.to === kept)).toBe(true);
    // The kept note took nothing from its exact copy, so it was not written.
    expect(file('People/Sam Ortiz.md')).toBe(keptFile);
    expect(db.prepare('SELECT version FROM nodes WHERE id = ?').get(kept)).toEqual(keptVersion);
    expect(file('Archive/Sam Ortiz.md')).toBeNull();
  });

  it('repairs a link that named the merged note only up to its spelling', async () => {
    const kept = note('Companies/Acme West Ltd.md');
    const other = note('Companies/Acme - West.md');
    // A file name cannot hold the colon, so this link never resolved to the note it means.
    const meeting = note('Meetings/Kickoff.md', { body: 'With [[Acme: West]].', asTyped: true });
    expect(boundTo(meeting)).toEqual([{ target: 'Acme: West', rel: 'wiki-link', to: null }]);

    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    // The kept note answers to the old name by its alias now, and the link is written to say so.
    expect(file('Meetings/Kickoff.md')).toContain('With [[Acme West Ltd|Acme: West]].');
    expect(boundTo(meeting)).toEqual([{ target: 'Acme West Ltd', rel: 'wiki-link', to: kept }]);

    const undone = await call('undo-operations', { operation_ids: [done.data.operation_id], dry_run: false });
    expect(undone.ok).toBe(true);
    expect(file('Meetings/Kickoff.md')).toContain('With [[Acme: West]].');
    // Bound to nothing, as before the merge: undo binds back only what was bound.
    expect(boundTo(meeting)).toEqual([{ target: 'Acme: West', rel: 'wiki-link', to: null }]);
  });

  it('leaves the merged titles out of the aliases when asked', async () => {
    const kept = note('People/Dana Whitfield.md', { fields: { aliases: ['D. Whitfield'] } });
    const other = note('People/Dana W.md', { fields: { aliases: ['Dana'] } });
    const done = await merge({ keep: kept, merge: [other], keep_titles_as_aliases: false, dry_run: false });
    expect(done.data.aliases_added).toEqual([]);
    // The merged note's own aliases are a list field like any other.
    expect(field(kept, 'aliases')).toEqual(['D. Whitfield', 'Dana']);
  });

  it('gives the merged note every kind its notes had, and repoints a typed reference', async () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', '2') ON CONFLICT(key) DO UPDATE SET value = '2'").run();
    createGlobalField(db, { name: 'owner', field_type: 'reference', reference_target: 'person' });
    createGlobalField(db, { name: 'people', field_type: 'list', list_item_type: 'reference', reference_target: 'person' });
    createSchemaDefinition(db, { name: 'person', field_claims: [] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'owner' }, { field: 'people' }] });
    const kept = note('People/Dana Whitfield.md');
    const other = note('People/Dana W.md', { types: ['person'] });
    const task = note('Tasks/Send quote.md', { types: ['task'], fields: { owner: 'Dana W', people: ['Dana W', 'Dana Whitfield'] } });
    expect(boundTo(task).find(edge => edge.rel === 'owner')).toEqual({ target: 'Dana W', rel: 'owner', to: other });

    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    expect(done.data.types_added).toEqual(['person']);
    expect(db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(kept)).toEqual([{ schema_type: 'person' }]);
    expect(field(task, 'owner')).toBe('Dana Whitfield');
    // Two names for one note are one name now.
    expect(field(task, 'people')).toEqual(['Dana Whitfield']);
    expect(boundTo(task).filter(edge => edge.rel !== 'wiki-link')).toEqual([
      { target: 'Dana Whitfield', rel: 'owner', to: kept },
      { target: 'Dana Whitfield', rel: 'people', to: kept },
    ]);
    expect(done.warnings).toEqual([]);
  });

  it('moves memories and board links to the kept note', async () => {
    upgradeBoardsStore(db);
    upgradeBoardLinksStore(db);
    const kept = note('People/Dana Whitfield.md');
    const other = note('People/Dana W.md');
    const memory = (scope: string, nodeId: string | null, evidence: string | null): number => Number(db.prepare(
      `INSERT INTO memories (source, scope, node_id, content, created_at, updated_at, evidence_node_id) VALUES ('curator', ?, ?, 'Dana prefers email.', '2026-01-01', '2026-01-01', ?)`,
    ).run(scope, nodeId, evidence).lastInsertRowid);
    const scoped = memory('node', other, null);
    const drawn = memory('vault', null, other);
    db.prepare("INSERT INTO boards (id, name, cards_json, created_at, updated_at) VALUES ('b1', 'Board', '[]', 1, 1)").run();
    db.prepare("INSERT INTO board_links (board_id, doc_node_id, created_at) VALUES ('b1', ?, 1), ('b1', ?, 1)").run(kept, other);

    const preview = await merge({ keep: kept, merge: [other] });
    expect(preview.data.moved).toEqual({ memories: 2, board_links: 1, conversation_links: 0, transcripts: 0 });
    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    // Deleting a note expires its memories; a merged note's are kept, on the kept note.
    expect(db.prepare('SELECT node_id, evidence_node_id, expired_at FROM memories WHERE id = ?').get(scoped)).toEqual({ node_id: kept, evidence_node_id: null, expired_at: null });
    expect(db.prepare('SELECT node_id, evidence_node_id, expired_at FROM memories WHERE id = ?').get(drawn)).toEqual({ node_id: null, evidence_node_id: kept, expired_at: null });
    expect(db.prepare('SELECT doc_node_id FROM board_links').all()).toEqual([{ doc_node_id: kept }]);
  });

  it('refuses what cannot be merged', async () => {
    const kept = note('People/Dana Whitfield.md');
    const other = note('People/Dana W.md');
    const journal = note('Wikis/Journal.md', { fields: { [SUITE_NOTE_FIELD]: 'journal' } });
    const setting = note('Settings/Engine.md');
    const many = Array.from({ length: MERGE_LIMITS.maxMerged + 1 }, (_, index) => `n${index}`);

    expect(await merge({ keep: kept, merge: [kept] })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await merge({ keep: kept, merge: [other, other] })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await merge({ keep: kept, merge: [] })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await merge({ keep: kept, merge: many })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await merge({ keep: kept, merge: ['nope'] })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', details: { node_id: 'nope' } } });
    expect(await merge({ keep: 'nope', merge: [other] })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await merge({ keep: kept, merge: [journal] })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await merge({ keep: setting, merge: [other] })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await merge({ keep: kept, merge: [other], extra: true })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect((db.prepare('SELECT COUNT(*) AS count FROM undo_operations').get() as { count: number }).count).toBe(0);
  });

  it('refuses while a note has an edit the Engine has not read', async () => {
    const kept = note('People/Dana Whitfield.md', { body: 'Met at the trade fair.' });
    const other = note('People/Dana W.md', { body: 'Prefers email.' });
    writeFileSync(join(vaultPath, 'People/Dana W.md'), 'Prefers email. And a line typed a second ago.\n');
    for (const dryRun of [true, false]) {
      const refused = await merge({ keep: kept, merge: [other], dry_run: dryRun });
      expect(refused).toMatchObject({ ok: false, error: { code: 'CONTENT_HASH_MISMATCH', details: { node_file_path: 'People/Dana W.md' } } });
      expect(refused.error!.message).toContain('has an edit the Engine has not read yet');
    }
    expect(file('People/Dana W.md')).toBe('Prefers email. And a line typed a second ago.\n');
    expect(db.prepare('SELECT 1 AS found FROM nodes WHERE id = ?').get(other)).toEqual({ found: 1 });
  });

  it('refuses while a note that links to a merged note has an unread edit', async () => {
    const kept = note('People/Dana Whitfield.md');
    const other = note('People/Dana W.md');
    note('Meetings/Kickoff.md', { body: 'With [[Dana W]].' });
    writeFileSync(join(vaultPath, 'Meetings/Kickoff.md'), 'With [[Dana W]]. And a line typed a second ago.\n');
    for (const dryRun of [true, false]) {
      expect(await merge({ keep: kept, merge: [other], dry_run: dryRun })).toMatchObject({
        ok: false, error: { code: 'CONTENT_HASH_MISMATCH', details: { node_file_path: 'Meetings/Kickoff.md' } },
      });
    }
    expect(file('Meetings/Kickoff.md')).toBe('With [[Dana W]]. And a line typed a second ago.\n');
    expect(file('People/Dana W.md')).not.toBeNull();
  });

  it('puts every file back when a later write is refused', async () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'done'], required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    const kept = note('People/Dana Whitfield.md', { body: 'Met at the trade fair.' });
    const other = note('People/Dana W.md', { fields: { phone: '555-0100' }, body: 'Prefers email.' });
    // A task typed in Obsidian without its required status: the watcher takes it, a tool write does not.
    const task = executeMutation(db, writeLock, vaultPath, {
      source: 'watcher', node_id: null, file_path: 'Tasks/Call.md', title: 'Call', types: ['task'], fields: {}, body: 'Call [[Dana W]].',
    }).node_id;
    writeFileSync(join(vaultPath, 'Tasks/Call.md'), '---\ntypes:\n  - task\n---\nCall [[Dana W]].\n');
    db.prepare('UPDATE nodes SET content_hash = NULL WHERE id = ?').run(task);
    const paths = ['People/Dana Whitfield.md', 'People/Dana W.md', 'Tasks/Call.md'];
    const before = paths.map(file);
    const state = stored();

    // The kept note is written first and the task's rewrite is refused after it.
    const refused = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(refused).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { node_file_path: 'Tasks/Call.md' } } });
    expect(paths.map(file)).toEqual(before);
    expect(stored()).toEqual(state);
    expect(boundTo(task)).toEqual([{ target: 'Dana W', rel: 'wiki-link', to: other }]);
    // The preview says so before anything is tried.
    expect(await merge({ keep: kept, merge: [other] })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('does not remove a note whose file holds text the Engine did not take', async () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'done'] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    const kept = note('Tasks/Send quote.md', { types: ['task'], fields: { status: 'open' } });
    const other = note('Tasks/Send the quote.md', { types: ['task'], fields: { status: 'open' } });
    // "someday" is no status, so the watcher stores nothing new for it: the text is in the file alone.
    typed('Tasks/Send the quote.md', '---\ntypes:\n  - task\nstatus: someday\n---\nToday.\n');
    expect(field(other, 'status')).toBe('open');

    for (const dryRun of [true, false]) {
      expect(await merge({ keep: kept, merge: [other], dry_run: dryRun })).toMatchObject({
        ok: false, error: { code: 'INVALID_PARAMS', details: { node_file_path: 'Tasks/Send the quote.md', fields: ['status'] } },
      });
    }
    expect(file('Tasks/Send the quote.md')).toContain('status: someday');
  });

  it('keeps text the kept note\'s file holds that the Engine did not take', async () => {
    createGlobalField(db, { name: 'due', field_type: 'date' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'due' }] });
    const kept = note('Tasks/Send quote.md', { types: ['task'] });
    const other = note('Tasks/Send the quote.md', { types: ['task'], fields: { due: '2026-12-01' } });
    // "when legal agrees" is no date: the database holds no due date for the kept note, the file does.
    typed('Tasks/Send quote.md', '---\ntypes:\n  - task\ndue: when legal agrees\n---\nSend it.\n');
    expect(field(kept, 'due')).toBeUndefined();

    const preview = await merge({ keep: kept, merge: [other] });
    expect(preview.data.fields).toMatchObject({
      carried: [],
      conflicts: [{ field: 'due', kept: 'when legal agrees', others: [{ note: other }], resolved_by: 'kept' }],
    });
    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    // The typed text is still there, and no date was written over it.
    expect(file('Tasks/Send quote.md')).toContain('due: when legal agrees');
    expect(field(kept, 'due')).toBeUndefined();
  });

  it('leaves a list alone when its file holds an item the Engine did not take', async () => {
    createGlobalField(db, { name: 'scores', field_type: 'list', list_item_type: 'number' });
    createSchemaDefinition(db, { name: 'review', field_claims: [{ field: 'scores' }] });
    const kept = note('Reviews/Q1.md', { types: ['review'], fields: { scores: [1] } });
    const other = note('Reviews/Q1 copy.md', { types: ['review'], fields: { scores: [2] } });
    // "TBD" is no number: the watcher keeps the stored [1], and the file alone holds what was typed.
    typed('Reviews/Q1.md', '---\ntypes:\n  - review\nscores:\n  - 1\n  - TBD\n---\n');
    expect(field(kept, 'scores')).toEqual([1]);

    const preview = await merge({ keep: kept, merge: [other] });
    expect(preview.data.fields).toMatchObject({ combined: [], conflicts: [{ field: 'scores', kept: [1, 'TBD'], others: [{ note: other, value: [2] }], resolved_by: 'kept' }] });
    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    expect(file('Reviews/Q1.md')).toContain('scores:\n  - 1\n  - TBD\n');
    expect(field(kept, 'scores')).toEqual([1]);
  });

  it('leaves a linking note\'s field alone when its file holds text the Engine did not take', async () => {
    createGlobalField(db, { name: 'owner', field_type: 'reference' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'owner' }] });
    const kept = note('People/Dana Whitfield.md');
    const other = note('People/Dana W.md');
    const task = note('Tasks/Send quote.md', { types: ['task'], fields: { owner: 'Dana W' }, body: 'Ask [[Dana W]].' });
    // A mapping is no reference: the watcher keeps the stored link, and the file alone holds what was typed.
    typed('Tasks/Send quote.md', '---\ntypes:\n  - task\nowner:\n  name: Dana\n  team: Buying\n---\nAsk [[Dana W]].\n');
    expect(field(task, 'owner')).toBe('Dana W');

    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    expect(done.data.links).toMatchObject({ notes: 1, fields_left_alone: [{ id: task, path: 'Tasks/Send quote.md', field: 'owner' }] });
    expect(done.warnings.map(warning => warning.code)).toContain('PENDING_REFERENCES');
    // The typed text is still in the file; the link in the note's text was rewritten.
    expect(file('Tasks/Send quote.md')).toContain('owner:\n  name: Dana\n  team: Buying\n');
    expect(file('Tasks/Send quote.md')).toContain('Ask [[Dana Whitfield]].');
  });

  it('names the kept note by its path where a heading link would name another note whole', async () => {
    const kept = note('Projects/Alpha.md', { body: 'The plan.' });
    const other = note('Projects/Beta.md', { body: '## Goals\n\nShip it.' });
    // A note whose own name holds a #: a link is read whole first, so [[Alpha#Goals]] is this note.
    const namesake = note('Other/Alpha#Goals.md', { body: 'Unrelated.' });
    const meeting = note('Meetings/Kickoff.md', { body: 'See [[Beta#Goals]], [[Beta#Goals|the goals]] and [[Beta]].' });

    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    expect(file('Meetings/Kickoff.md')).toContain('See [[Projects/Alpha.md#Goals|Alpha]], [[Projects/Alpha.md#Goals|the goals]] and [[Alpha]].');
    expect(boundTo(meeting).every(edge => edge.to === kept)).toBe(true);
    expect(boundTo(meeting).some(edge => edge.to === namesake)).toBe(false);
  });

  it('keeps .md on an embed of a note whose name has a dot', async () => {
    const kept = note('Notes/Report.v2.md', { body: 'Final.' });
    const other = note('Notes/Old Report.md', { body: 'Draft.' });
    note('Notes/Summary.md', { body: '![[Old Report]]\n\n![[Old Report|200]]\n\n![[Old Report#Intro]]\n\nSee [[Old Report]].' });

    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    // An embed with another extension is read as an attachment; a plain link is not.
    expect(file('Notes/Summary.md')).toContain('![[Report.v2.md]]\n\n![[Report.v2.md|200]]\n\n![[Report.v2.md#Intro]]\n\nSee [[Report.v2]].');
  });

  it('refuses when a file is missing, the kept note\'s above all', async () => {
    const kept = note('People/Sam Ortiz.md', { body: 'The buyer.' });
    const copy = note('Sam Ortiz.md', { body: 'The buyer.' });
    // Deleted in Obsidian a moment ago: the watcher has not read the removal yet. The copy is
    // exact, so nothing would be written to the kept note, and no write would notice.
    rmSync(join(vaultPath, 'People/Sam Ortiz.md'));
    for (const dryRun of [true, false]) {
      const refused = await merge({ keep: kept, merge: [copy], dry_run: dryRun });
      expect(refused).toMatchObject({ ok: false, error: { code: 'CONTENT_HASH_MISMATCH', details: { node_file_path: 'People/Sam Ortiz.md' } } });
      expect(refused.error!.message).toContain('is missing');
    }
    expect(file('Sam Ortiz.md')).not.toBeNull();
    expect(db.prepare('SELECT 1 AS found FROM nodes WHERE id = ?').get(copy)).toEqual({ found: 1 });
  });

  it('takes a field by any name in set_fields', async () => {
    const kept = note('People/Dana Whitfield.md');
    const other = note('People/Dana W.md');
    const done = await merge({ keep: kept, merge: [other], set_fields: JSON.parse('{"__proto__": "kept", "constructor": "also kept"}'), dry_run: false });
    expect(done.ok).toBe(true);
    expect(done.data.fields.set).toEqual(['__proto__', 'constructor']);
    expect(field(kept, '__proto__')).toBe('kept');
    expect(field(kept, 'constructor')).toBe('also kept');
  });

  it('rewrites a field value only where that note holds it as a link', async () => {
    const kept = note('People/Dana Whitfield.md', { fields: { contact: 'Dana W' } });
    const other = note('People/Dana W.md', { fields: { contact: 'Dana W' }, raw: { contact: '[[Dana W]]' } });
    // One note links the merged note in the field; another holds the same words as plain text.
    const linked = note('Meetings/A.md', { fields: { contact: 'Dana W' }, raw: { contact: '[[Dana W]]' } });
    const plain = note('Meetings/B.md', { fields: { contact: 'Dana W' }, body: 'See [[Dana W]].' });

    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    expect(field(linked, 'contact')).toBe('Dana Whitfield');
    expect(file('Meetings/A.md')).toContain('contact: "[[Dana Whitfield]]"');
    // Plain text is not a link: the note is rewritten for its body link only.
    expect(field(plain, 'contact')).toBe('Dana W');
    expect(file('Meetings/B.md')).toContain('contact: Dana W\n');
    expect(file('Meetings/B.md')).toContain('See [[Dana Whitfield]].');
    // The kept note's own plain text stays too.
    expect(field(kept, 'contact')).toBe('Dana W');
  });

  it('refuses a value that the field\'s link text would override', async () => {
    const kept = note('People/Dana Whitfield.md', { fields: { contact: 'Lee Okafor' }, raw: { contact: '[[Lee Okafor]]' } });
    const other = note('People/Dana W.md');
    expect(await merge({ keep: kept, merge: [other], set_fields: { contact: 42 } })).toMatchObject({
      ok: false, error: { code: 'INVALID_PARAMS', details: { field: 'contact' } },
    });
    // Text, a list, and removal all replace the link.
    const done = await merge({ keep: kept, merge: [other], set_fields: { contact: 'Priya Raman' }, dry_run: false });
    expect(done.ok).toBe(true);
    expect(field(kept, 'contact')).toBe('Priya Raman');
    expect(file('People/Dana Whitfield.md')).toContain('contact: Priya Raman\n');
  });

  it('keeps a merged note\'s file that was saved while the merge ran', async () => {
    const kept = note('People/Dana Whitfield.md', { body: 'Met at the trade fair.' });
    const other = note('People/Dana W.md', { body: 'Prefers email.' });
    const saved = 'Prefers email. And a line saved just as the merge ran.\n';
    // The check before the merge passes; the save lands before the file is removed.
    const lock = writeLock.withLockSync.bind(writeLock);
    writeLock.withLockSync = ((path: string, work: () => unknown) => {
      if (path.endsWith('Dana W.md') && existsSync(path) && readFileSync(path, 'utf8') !== saved) writeFileSync(path, saved);
      return lock(path, work);
    }) as typeof writeLock.withLockSync;

    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    expect(done.data.files_kept).toEqual(['People/Dana W.md']);
    expect(done.warnings.map(warning => warning.code)).toEqual(['UNDO_FILE_KEPT']);
    expect(file('People/Dana W.md')).toBe(saved);
    expect(db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(other)).toBeUndefined();
  });

  it('binds a link whose text already names the kept note', async () => {
    const kept = note('People/Sam Ortiz.md', { body: 'The buyer.' });
    const copy = note('Sam Ortiz.md', { body: 'The buyer.' });
    const meeting = note('Meetings/Kickoff.md', { fields: { lead: 'Sam Ortiz' }, raw: { lead: '[[Sam Ortiz]]' }, body: 'With [[Sam Ortiz]] and [[Sam Ortiz#Role]].' });
    // Of two notes by the name, the links were bound to the copy at the vault's root.
    expect(boundTo(meeting).every(edge => edge.to === copy)).toBe(true);
    const meetingFile = file('Meetings/Kickoff.md');

    const done = await merge({ keep: kept, merge: [copy], dry_run: false });
    expect(done.ok).toBe(true);
    // Nothing to rewrite: the same words name the kept note now. The links must still be bound to it.
    expect(done.data.links).toMatchObject({ notes: 0, written_as: 'Sam Ortiz' });
    expect(file('Meetings/Kickoff.md')).toBe(meetingFile);
    expect(boundTo(meeting)).toEqual([
      { target: 'Sam Ortiz', rel: 'lead', to: kept },
      { target: 'Sam Ortiz', rel: 'wiki-link', to: kept },
      { target: 'Sam Ortiz#Role', rel: 'wiki-link', to: kept },
    ]);

    // Undo brings the copy back. The meeting was never rewritten, so it has nothing to restore,
    // and its links are bound to the copy again, as before the merge (#665).
    expect((await call('undo-operations', { operation_ids: [done.data.operation_id], dry_run: false })).ok).toBe(true);
    expect(file('Sam Ortiz.md')).not.toBeNull();
    expect(file('Meetings/Kickoff.md')).toBe(meetingFile);
    expect(boundTo(meeting)).toEqual([
      { target: 'Sam Ortiz', rel: 'lead', to: copy },
      { target: 'Sam Ortiz', rel: 'wiki-link', to: copy },
      { target: 'Sam Ortiz#Role', rel: 'wiki-link', to: copy },
    ]);
  });

  it('leaves a link alone on undo when its note no longer holds it (#665)', async () => {
    const kept = note('People/Sam Ortiz.md', { body: 'The buyer.' });
    const copy = note('Sam Ortiz.md', { body: 'The buyer.' });
    const meeting = note('Meetings/Kickoff.md', { body: 'With [[Sam Ortiz]] and [[Dana W]].' });
    const done = await merge({ keep: kept, merge: [copy], dry_run: false });
    expect(done.ok).toBe(true);
    // Edited in Obsidian after the merge: the link to Sam is gone.
    typed('Meetings/Kickoff.md', 'With [[Dana W]].\n');

    expect((await call('undo-operations', { operation_ids: [done.data.operation_id], dry_run: false })).ok).toBe(true);
    expect(file('Sam Ortiz.md')).not.toBeNull();
    expect(boundTo(meeting)).toEqual([{ target: 'Dana W', rel: 'wiki-link', to: null }]);
  });

  it('rewrites a link inside longer text in a field', async () => {
    const kept = note('People/Dana Whitfield.md');
    const other = note('People/Dana W.md');
    const meeting = note('Meetings/Kickoff.md', {
      fields: { contact: 'Ask Dana W or Lee Okafor', owners: ['Dana W (lead)', 'Lee Okafor'] },
      raw: { contact: 'Ask [[Dana W|Dana]] or [[Lee Okafor]]', owners: JSON.stringify(['[[Dana W]] (lead)', 'Lee Okafor']) },
    });
    expect(boundTo(meeting).filter(edge => edge.to === other).map(edge => edge.rel)).toEqual(['contact', 'owners']);

    const done = await merge({ keep: kept, merge: [other], keep_titles_as_aliases: false, dry_run: false });
    expect(done.ok).toBe(true);
    expect(done.data.links.notes).toBe(1);
    expect(file('Meetings/Kickoff.md')).toContain('contact: Ask [[Dana Whitfield|Dana]] or [[Lee Okafor]]');
    expect(file('Meetings/Kickoff.md')).toContain('- "[[Dana Whitfield]] (lead)"');
    expect(field(meeting, 'contact')).toBe('Ask Dana Whitfield or Lee Okafor');
    expect(field(meeting, 'owners')).toEqual(['Dana Whitfield (lead)', 'Lee Okafor']);
    expect(boundTo(meeting).filter(edge => edge.to === kept).map(edge => edge.rel)).toEqual(['contact', 'owners']);
  });

  it('rewrites a link a field\'s value carries in its own text', async () => {
    const kept = note('People/Dana Whitfield.md');
    const other = note('People/Dana W.md');
    // Written through a tool with the brackets in the value, and no raw text beside it.
    const meeting = note('Meetings/Kickoff.md', { fields: { contact: 'Ask [[Dana W|Dana]] first', owners: ['[[Dana W]] (lead)', 'Lee Okafor'] } });
    expect(boundTo(meeting).filter(edge => edge.to === other).map(edge => edge.rel)).toEqual(['contact', 'owners']);

    const done = await merge({ keep: kept, merge: [other], keep_titles_as_aliases: false, dry_run: false });
    expect(done.ok).toBe(true);
    expect(done.data.links.notes).toBe(1);
    expect(file('Meetings/Kickoff.md')).toContain('[[Dana Whitfield|Dana]] first');
    expect(file('Meetings/Kickoff.md')).toContain('[[Dana Whitfield]] (lead)');
    expect(file('Meetings/Kickoff.md')).not.toContain('Dana W]]');
    expect(boundTo(meeting).filter(edge => edge.to === kept).map(edge => edge.rel)).toEqual(['contact', 'owners']);
  });

  it('rewrites a link in a field that is named like a link in the text', async () => {
    const kept = note('People/Dana Whitfield.md');
    const other = note('People/Dana W.md');
    // A field called wiki-link is stored under the name the text's links are stored under.
    const fieldOnly = note('Meetings/A.md', { fields: { 'wiki-link': 'Dana W' }, raw: { 'wiki-link': '[[Dana W]]' } });
    const both = note('Meetings/B.md', { fields: { 'wiki-link': 'Dana W' }, raw: { 'wiki-link': '[[Dana W]]' }, body: 'And [[Dana W]] in the text.' });

    const done = await merge({ keep: kept, merge: [other], keep_titles_as_aliases: false, dry_run: false });
    expect(done.ok).toBe(true);
    expect(done.data.links.notes).toBe(2);
    expect(file('Meetings/A.md')).toContain('wiki-link: "[[Dana Whitfield]]"');
    expect(file('Meetings/B.md')).toContain('wiki-link: "[[Dana Whitfield]]"');
    expect(file('Meetings/B.md')).toContain('And [[Dana Whitfield]] in the text.');
    expect(boundTo(fieldOnly)).toEqual([{ target: 'Dana Whitfield', rel: 'wiki-link', to: kept }]);
    expect(boundTo(both)).toEqual([{ target: 'Dana Whitfield', rel: 'wiki-link', to: kept }]);
  });

  it('does not take a typed field\'s link for a link in another note\'s text', async () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', '2') ON CONFLICT(key) DO UPDATE SET value = '2'").run();
    createGlobalField(db, { name: 'wiki-link', field_type: 'reference', reference_target: 'person' });
    createSchemaDefinition(db, { name: 'person', field_claims: [] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'wiki-link' }] });
    const kept = note('People/Dana Whitfield.md', { types: ['person'] });
    const person = note('People/Beta.md', { types: ['person'] });
    const unrelated = note('Beta.md');
    // The same word names the person in the typed field, and the note at the root in a text.
    const task = note('Tasks/Call.md', { types: ['task'], fields: { 'wiki-link': 'Beta' } });
    const meeting = note('Meetings/Kickoff.md', { body: 'About [[Beta]].' });
    expect(boundTo(task)).toEqual([{ target: 'Beta', rel: 'wiki-link', to: person }]);
    expect(boundTo(meeting)).toEqual([{ target: 'Beta', rel: 'wiki-link', to: unrelated }]);
    const meetingFile = file('Meetings/Kickoff.md');

    const done = await merge({ keep: kept, merge: [person], dry_run: false });
    expect(done.ok).toBe(true);
    expect(done.data.links).toMatchObject({ notes: 1, examples: [{ id: task }] });
    expect(field(task, 'wiki-link')).toBe('Dana Whitfield');
    expect(boundTo(task)).toEqual([{ target: 'Dana Whitfield', rel: 'wiki-link', to: kept }]);
    expect(file('Meetings/Kickoff.md')).toBe(meetingFile);
    expect(boundTo(meeting)).toEqual([{ target: 'Beta', rel: 'wiki-link', to: unrelated }]);
  });

  it('leaves plain words in a field of that name alone', async () => {
    const kept = note('People/Dana Whitfield.md');
    const other = note('People/Dana W.md');
    // The field holds the same words as plain text; the link is in the note's text only.
    const plain = note('Meetings/C.md', { fields: { 'wiki-link': 'Dana W' }, body: 'With [[Dana W]].' });
    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    expect(field(plain, 'wiki-link')).toBe('Dana W');
    expect(file('Meetings/C.md')).toContain('wiki-link: Dana W\n');
    expect(file('Meetings/C.md')).toContain('With [[Dana Whitfield]].');
  });

  it('leaves plain words alone that stand beside a link in the same field', async () => {
    const kept = note('People/Dana Whitfield.md');
    const other = note('People/Dana W.md');
    // Only the second item is a link. The first is the same words as plain text.
    const meeting = note('Meetings/Kickoff.md', { fields: { refs: ['Dana W', 'Ask [[Dana W]]'] } });
    expect(boundTo(meeting)).toEqual([{ target: 'Dana W', rel: 'refs', to: other }]);

    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    expect(field(meeting, 'refs')).toEqual(['Dana W', 'Ask [[Dana Whitfield]]']);
    expect(boundTo(meeting)).toEqual([{ target: 'Dana Whitfield', rel: 'refs', to: kept }]);
  });

  it('drops only the repeat that a rewrite made', async () => {
    createGlobalField(db, { name: 'people', field_type: 'list', list_item_type: 'reference' });
    const kept = note('People/Dana Whitfield.md');
    const other = note('People/Dana W.md');
    note('People/Lee Okafor.md');
    // Lee is listed twice as written; Dana is listed under two names.
    createSchemaDefinition(db, { name: 'meeting', field_claims: [{ field: 'people' }] });
    const meeting = note('Meetings/Kickoff.md', { types: ['meeting'], fields: { people: ['Lee Okafor', 'Dana Whitfield', 'Lee Okafor', 'Dana W'] } });
    // A note of no kind holds the same field as its own text: there only a written link is one.
    const loose = note('Notes/Loose.md', { fields: { people: ['Dana W', 'with [[Dana W]]'] } });
    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(field(loose, 'people')).toEqual(['Dana W', 'with [[Dana Whitfield]]']);
    expect(done.ok).toBe(true);
    expect(field(meeting, 'people')).toEqual(['Lee Okafor', 'Dana Whitfield', 'Lee Okafor']);
  });

  it('carries text over as written, line breaks and all', async () => {
    const kept = note('Notes/Poem.md', { body: 'First verse.' });
    // Two spaces at a line's end are a line break in Markdown.
    const other = note('Notes/Poem draft.md', { body: '\n\nRoses are red,  \nviolets are blue.  \n\n' });
    const done = await merge({ keep: kept, merge: [other], dry_run: false });
    expect(done.ok).toBe(true);
    expect(file('Notes/Poem.md')!.endsWith('First verse.\n\n## Merged from Poem draft\n\nRoses are red,  \nviolets are blue.\n')).toBe(true);
  });

  it('changes nothing when a write is refused', async () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'done'] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    const kept = note('Tasks/Send quote.md', { types: ['task'], fields: { status: 'open' }, body: 'Send it.' });
    const other = note('Tasks/Send the quote.md', { body: 'Today.' });
    const linking = note('Index.md', { body: '[[Send the quote]]' });
    const paths = ['Tasks/Send quote.md', 'Tasks/Send the quote.md', 'Index.md'];
    const before = paths.map(file);
    const state = stored();

    for (const dryRun of [true, false]) {
      const refused = await merge({ keep: kept, merge: [other], set_fields: { status: 'someday' }, dry_run: dryRun });
      expect(refused).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { node_file_path: 'Tasks/Send quote.md' } } });
    }
    expect(paths.map(file)).toEqual(before);
    expect(stored()).toEqual(state);
    expect(boundTo(linking)).toEqual([{ target: 'Send the quote', rel: 'wiki-link', to: other }]);
  });
});
