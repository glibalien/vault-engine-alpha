import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { registerCleanupReport } from '../../src/mcp/tools/cleanup-report.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';
import { registerSurveyNodes } from '../../src/mcp/tools/survey-nodes.js';
import { SUITE_NOTE_FIELD } from '../../src/notes/suite-notes.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { setStoredSettings } from '../../src/settings/store.js';

let db: Database.Database;
let server: McpServer;
let client: Client;
let mtime = 1;

beforeEach(async () => {
  db = createTestDb();
  mtime = 1;
  server = new McpServer({ name: 'cleanup-test', version: '1' });
  registerCleanupReport(server, db, 'Settings');
  registerQueryNodes(server, db);
  registerSurveyNodes(server, db, 'Settings');
  client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  db.close();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

interface Seed { id: string; path: string; types?: string[]; fields?: Record<string, string>; links?: Array<{ target: string; field?: string; resolved?: string }> }

/** Later notes are newer, so examples come back last-seeded first. */
function seed(note: Seed): void {
  const title = note.path.split('/').pop()!.replace(/\.md$/, '');
  db.prepare('INSERT INTO nodes (id, file_path, title, body, file_mtime) VALUES (?, ?, ?, ?, ?)').run(note.id, note.path, title, '', mtime++);
  for (const type of note.types ?? []) db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(note.id, type);
  for (const [name, value] of Object.entries(note.fields ?? {})) {
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_text) VALUES (?, ?, ?)').run(note.id, name, value);
  }
  for (const link of note.links ?? []) {
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)')
      .run(note.id, link.target, link.field ?? 'wiki-link', link.field ?? null, link.resolved ?? null);
  }
}

/** The kinds and fields of a small organized vault; `claims` says which fields each kind claims. */
function seedSchemas(): void {
  for (const name of ['status', 'people involved', 'date', 'due']) createGlobalField(db, { name, field_type: 'string' });
  createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }, { field: 'due' }] });
  createSchemaDefinition(db, { name: 'project', field_claims: [{ field: 'status' }] });
  createSchemaDefinition(db, { name: 'meeting', field_claims: [{ field: 'people involved' }, { field: 'date' }] });
  createSchemaDefinition(db, { name: 'daily-note', field_claims: [] });
  createSchemaDefinition(db, { name: 'wiki', field_claims: [] });
}

type Row = { id: string; title: string; notes: number; out_of: number; why: string; examples: Array<Record<string, unknown>>; next: Array<{ tool: string; arguments: Record<string, unknown>; purpose: string }> };
const rowOf = (report: { data: { rows: Row[] } }, id: string): Row => report.data.rows.find(row => row.id === id)!;
const ROW_IDS = [
  'untyped', 'task-status-missing', 'project-status-missing', 'meeting-people-missing',
  'task-status-unknown', 'project-status-unknown', 'no-date', 'unclaimed-fields', 'missing-notes', 'duplicates',
];

describe('cleanup-report', () => {
  it('advertises a strict read-only tool whose first sentence fits a tool index', async () => {
    const tool = (await client.listTools()).tools.find(candidate => candidate.name === 'cleanup-report')!;
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(tool.inputSchema.properties!)).toEqual(['row', 'limit', 'offset', 'examples']);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
    expect(tool.description!.split('. ')[0]!.length).toBeLessThanOrEqual(90);
  });

  it('reports nothing to do on an empty vault', async () => {
    seedSchemas();
    const report = await call('cleanup-report');
    expect(report.ok).toBe(true);
    expect(report.data.notes).toBe(0);
    expect(report.data.rows).toEqual([]);
    expect(report.data.not_checked).toEqual([]);
    expect(report.data.clear.map((entry: { id: string }) => entry.id)).toEqual(ROW_IDS);
  });

  it('does not count Obsidian\'s own properties as fields a kind should claim', async () => {
    seedSchemas();
    // A merged person keeps its old titles as aliases; an export carries tags and styles.
    seed({ id: 'p1', path: 'People/Dana.md', types: ['meeting'], fields: { aliases: 'Dana W', tags: 'people', cssclasses: 'wide', source: 'import' } });
    seed({ id: 'p2', path: 'People/Lee.md', types: ['meeting'], fields: { alias: 'L. Okafor', tag: 'people' } });

    const report = await call('cleanup-report');
    expect(rowOf(report, 'unclaimed-fields')).toMatchObject({ notes: 1, examples: [{ value: 'source', notes: 1 }] });
  });

  it('lists each clean-up with its count, examples and calls, most notes affected first', async () => {
    seedSchemas();
    // Six notes with no kind, plus three of the suite's own, which the report leaves out even
    // though each links to a note that does not exist.
    for (let i = 0; i < 6; i++) seed({ id: `u${i}`, path: `Inbox/Loose ${i}.md` });
    seed({ id: 'suite', path: 'Wikis/Journal.md', fields: { [SUITE_NOTE_FIELD]: 'journal' }, links: [{ target: 'Nobody' }] });
    seed({ id: 'setting', path: 'Settings/Engine.md', links: [{ target: 'Model Note Title' }] });
    seed({ id: 'wiki', path: 'Wikis/Alpha Wiki.md', types: ['wiki'], fields: { generated: 'yes' }, links: [{ target: 'Invented Person' }] });
    // Five tasks: one with no status, two with a status the map does not know.
    seed({ id: 't0', path: 'Tasks/A.md', types: ['task'], fields: { status: 'open' } });
    seed({ id: 't1', path: 'Tasks/B.md', types: ['task'], fields: { status: 'done' } });
    seed({ id: 't2', path: 'Tasks/C.md', types: ['task'] });
    seed({ id: 't3', path: 'Tasks/D.md', types: ['task'], fields: { status: 'waiting' } });
    seed({ id: 't4', path: 'Tasks/E.md', types: ['task'], fields: { status: 'waiting' } });
    // A project with no status.
    seed({ id: 'p0', path: 'Projects/Alpha.md', types: ['project'] });
    // Four meetings: three with no people; one with no readable date. Each carries an unclaimed field.
    seed({ id: 'm0', path: 'Meetings/2026-01-05 Sync.md', types: ['meeting'], fields: { 'people involved': 'Dana', source: 'import' }, links: [{ target: 'Dana', field: 'people involved' }, { target: 'Project Alpha', resolved: 'p0' }] });
    seed({ id: 'm1', path: 'Meetings/2026-01-12 Sync.md', types: ['meeting'], fields: { source: 'import' }, links: [{ target: 'Dana' }, { target: 'Northwind' }] });
    seed({ id: 'm2', path: 'Meetings/Kickoff.md', types: ['meeting'], fields: { date: '2026-02-01', source: 'import' }, links: [{ target: 'dana.md' }, { target: 'diagram.png' }] });
    seed({ id: 'm3', path: 'Meetings/Undated chat.md', types: ['meeting'], fields: { source: 'import' } });
    // A daily note dated by its title.
    seed({ id: 'd0', path: 'Daily/2026-03-01.md', types: ['daily-note'] });

    const report = await call('cleanup-report');
    expect(report.ok).toBe(true);
    expect(report.data.notes).toBe(17);
    expect(report.data.rows.map((row: Row) => [row.id, row.notes, row.out_of])).toEqual([
      ['untyped', 6, 17],
      ['unclaimed-fields', 4, 17],
      ['meeting-people-missing', 3, 4],
      ['missing-notes', 3, 17],
      ['task-status-unknown', 2, 5],
      ['task-status-missing', 1, 5],
      ['project-status-missing', 1, 1],
      ['no-date', 1, 5],
    ]);
    expect(report.data.clear).toEqual([
      { id: 'project-status-unknown', title: 'project status values the vault map does not know' },
      { id: 'duplicates', title: 'Notes with the same text as another note' },
    ]);
    expect(report.data.not_checked).toEqual([]);

    const untyped = rowOf(report, 'untyped');
    expect(untyped.examples).toEqual([
      { id: 'u5', title: 'Loose 5', path: 'Inbox/Loose 5.md' },
      { id: 'u4', title: 'Loose 4', path: 'Inbox/Loose 4.md' },
      { id: 'u3', title: 'Loose 3', path: 'Inbox/Loose 3.md' },
    ]);
    expect(untyped.next[0]).toMatchObject({ tool: 'survey-nodes', arguments: {} });

    expect(rowOf(report, 'task-status-missing')).toMatchObject({ title: 'task notes with no status', examples: [{ id: 't2' }] });
    expect(rowOf(report, 'task-status-unknown').examples).toEqual([{ value: 'waiting', notes: 2 }]);
    expect(rowOf(report, 'unclaimed-fields').examples).toEqual([{ value: 'source', notes: 4, mostly_on: 'meeting' }]);
    // "Dana" and "dana.md" name one missing note; the attachment and the resolved link name none.
    const missing = rowOf(report, 'missing-notes');
    expect(missing.title).toBe('Links to notes that do not exist (2 missing notes)');
    expect(missing.examples).toEqual([{ value: 'Dana', notes: 3 }, { value: 'Northwind', notes: 1 }]);
    expect(rowOf(report, 'no-date')).toMatchObject({ title: 'meeting and daily-note notes with no date Vault can read', examples: [{ id: 'm3' }] });
  });

  it('lists exactly the notes each row counts, and its queries return the same notes', async () => {
    seedSchemas();
    for (let i = 0; i < 4; i++) seed({ id: `u${i}`, path: `Inbox/Loose ${i}.md` });
    seed({ id: 'setting', path: 'Settings/Engine.md', links: [{ target: 'Model Note Title' }] });
    seed({ id: 'suite', path: 'Wikis/Journal.md', fields: { [SUITE_NOTE_FIELD]: 'journal' }, links: [{ target: 'Nobody' }] });
    seed({ id: 'wiki', path: 'Wikis/Alpha Wiki.md', types: ['wiki'], links: [{ target: 'Invented Person' }] });
    seed({ id: 't0', path: 'Tasks/A.md', types: ['task'] });
    seed({ id: 't1', path: 'Tasks/B.md', types: ['task'], fields: { status: 'waiting', extra: 'x' } });
    seed({ id: 't2', path: 'Tasks/C.md', types: ['task'], fields: { status: 'someday' } });
    seed({ id: 'm0', path: 'Meetings/Kickoff.md', types: ['meeting'], links: [{ target: 'Dana' }] });
    const report = await call('cleanup-report');
    expect(report.data.rows.map((row: Row) => row.id).sort()).toEqual(
      ['meeting-people-missing', 'missing-notes', 'no-date', 'task-status-missing', 'task-status-unknown', 'unclaimed-fields', 'untyped'],
    );

    // The untyped count is the scope a survey with no arguments covers.
    const survey = await call('survey-nodes', rowOf(report, 'untyped').next[0]!.arguments);
    expect(survey.data.scope.notes).toBe(rowOf(report, 'untyped').notes);

    for (const row of report.data.rows as Row[]) {
      // Every row offers its own listing, and the listing is the row.
      const list = row.next.find(step => step.tool === 'cleanup-report')!;
      expect(list.arguments, row.id).toEqual({ row: row.id });
      const listed = await call('cleanup-report', list.arguments);
      expect(listed.ok, row.id).toBe(true);
      expect(listed.data, row.id).toMatchObject({ row: row.id, title: row.title, total: row.notes, offset: 0 });
      const listedIds = (listed.data.notes as Array<{ id: string }>).map(note => note.id);
      expect(listedIds, row.id).toHaveLength(row.notes);

      // A query a row offers returns those same notes.
      for (const query of row.next.filter(step => step.tool === 'query-nodes')) {
        const result = await call('query-nodes', query.arguments);
        expect(result.ok, `${row.id}: ${JSON.stringify(result.error)}`).toBe(true);
        expect((result.data.nodes as Array<{ id: string }>).map(node => node.id).sort(), row.id).toEqual([...listedIds].sort());
      }
    }
    // Only the rows whose notes a filter can express offer a query.
    expect((report.data.rows as Row[]).filter(row => row.next.some(step => step.tool === 'query-nodes')).map(row => row.id).sort())
      .toEqual(['meeting-people-missing', 'task-status-missing', 'task-status-unknown']);
  });

  it('pages a row and refuses a row it cannot list', async () => {
    seedSchemas();
    for (let i = 0; i < 5; i++) seed({ id: `u${i}`, path: `Inbox/Loose ${i}.md` });
    const first = await call('cleanup-report', { row: 'untyped', limit: 2 });
    expect(first.data).toMatchObject({ row: 'untyped', title: 'Notes with no kind', total: 5, offset: 0 });
    expect(first.data.notes).toEqual([
      { id: 'u4', title: 'Loose 4', path: 'Inbox/Loose 4.md' },
      { id: 'u3', title: 'Loose 3', path: 'Inbox/Loose 3.md' },
    ]);
    const last = await call('cleanup-report', { row: 'untyped', limit: 2, offset: 4 });
    expect(last.data.notes.map((note: { id: string }) => note.id)).toEqual(['u0']);
    expect((await call('cleanup-report', { row: 'task-status-missing' })).data).toMatchObject({ total: 0, notes: [] });

    const unknown = await call('cleanup-report', { row: 'nope' });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(unknown.error.message).toContain('untyped, task-status-missing');
    setStoredSettings(db, 'vault', { meetingType: null });
    const off = await call('cleanup-report', { row: 'meeting-people-missing' });
    expect(off).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(off.error.message).toContain('meetingType');
    expect(await call('cleanup-report', { limit: 5 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await call('cleanup-report', { row: 'untyped', examples: 5 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  });

  it('counts a note as undated when its date cannot be read, and lists it', async () => {
    seedSchemas();
    seed({ id: 'm0', path: 'Meetings/Kickoff.md', types: ['meeting'] });
    seed({ id: 'm1', path: 'Meetings/2026-01-05 Sync.md', types: ['meeting'] });
    seed({ id: 'm2', path: 'Meetings/Offsite.md', types: ['meeting'], fields: { date: 'TBD' } });
    seed({ id: 'd0', path: 'Daily/Monday.md', types: ['daily-note'] });
    seed({ id: 'd1', path: 'Daily/Tuesday.md', types: ['daily-note'], fields: { date: '2026-03-03' } });
    const row = rowOf(await call('cleanup-report'), 'no-date');
    expect(row).toMatchObject({ notes: 3, out_of: 5 });
    // No field filter can say "a date that cannot be read", so the row offers no query.
    expect(row.next.map(step => step.tool)).toEqual(['cleanup-report', 'recover-dates', 'update-node']);
    const listed = await call('cleanup-report', { row: 'no-date' });
    expect(listed.data.notes.map((note: { id: string }) => note.id)).toEqual(['d0', 'm2', 'm0']);
  });

  it('does not call a link missing when a note by that name exists', async () => {
    seedSchemas();
    createSchemaDefinition(db, { name: 'person', field_claims: [] });
    // Two people share a name, so a typed reference to it stays unresolved; so does one to a
    // note of another kind. Neither is a missing note.
    seed({ id: 'a1', path: 'People/Dana Whitfield.md', types: ['person'] });
    seed({ id: 'a2', path: 'Archive/Dana Whitfield.md', types: ['person'] });
    seed({ id: 'p0', path: 'Projects/Alpha.md', types: ['project'], fields: { status: 'open' } });
    seed({
      id: 'm0', path: 'Meetings/2026-01-05 Sync.md', types: ['meeting'], fields: { 'people involved': 'x' },
      links: [{ target: 'Dana Whitfield', field: 'people involved' }, { target: 'Alpha#Scope', field: 'people involved' }, { target: 'alpha.md' }],
    });
    seed({ id: 'm1', path: 'Meetings/2026-01-12 Sync.md', types: ['meeting'], fields: { 'people involved': 'x' }, links: [{ target: 'Lee Okafor' }, { target: 'Dana Whitfield' }] });

    const report = await call('cleanup-report');
    const missing = rowOf(report, 'missing-notes');
    expect(missing).toMatchObject({ title: 'Links to notes that do not exist (1 missing note)', notes: 1, examples: [{ value: 'Lee Okafor', notes: 1 }] });
    expect(missing.next.find(step => step.tool === 'create-node')!.arguments).toEqual({ title: 'Lee Okafor', types: ['<kind>'] });
    const listed = await call('cleanup-report', { row: 'missing-notes' });
    expect(listed.data.notes.map((note: { id: string }) => note.id)).toEqual(['m1']);
  });

  it('suggests creating a path-named missing note in its folder', async () => {
    seedSchemas();
    seed({ id: 'm0', path: 'Meetings/2026-01-05 Sync.md', types: ['meeting'], fields: { 'people involved': 'x' }, links: [{ target: 'People/Lee Okafor' }] });
    seed({ id: 'm1', path: 'Meetings/2026-01-12 Sync.md', types: ['meeting'], fields: { 'people involved': 'x' }, links: [{ target: 'People/Lee Okafor.md' }, { target: 'Northwind' }] });
    const missing = rowOf(await call('cleanup-report'), 'missing-notes');
    expect(missing.examples).toEqual([{ value: 'People/Lee Okafor', notes: 2 }, { value: 'Northwind', notes: 1 }]);
    // Created as a title, "People/Lee Okafor" would lose its slash and the link would stay unresolved.
    expect(missing.next.find(step => step.tool === 'create-node')!.arguments).toEqual({
      title: 'Lee Okafor', directory: 'People', override_default_directory: true, types: ['<kind>'],
    });
  });

  it('shrinks a row when its notes are fixed and moves it to clear when none are left', async () => {
    seedSchemas();
    seed({ id: 't0', path: 'Tasks/A.md', types: ['task'] });
    seed({ id: 't1', path: 'Tasks/B.md', types: ['task'] });
    expect(rowOf(await call('cleanup-report'), 'task-status-missing').notes).toBe(2);

    db.prepare("INSERT INTO node_fields (node_id, field_name, value_text) VALUES ('t0', 'status', 'open')").run();
    expect(rowOf(await call('cleanup-report'), 'task-status-missing').notes).toBe(1);

    db.prepare("INSERT INTO node_fields (node_id, field_name, value_text) VALUES ('t1', 'status', 'done')").run();
    const done = await call('cleanup-report');
    expect(done.data.rows).toEqual([]);
    expect(done.data.clear.map((entry: { id: string }) => entry.id)).toContain('task-status-missing');
  });

  it('reads the vault map: the user\'s own names, and none means not checked', async () => {
    createGlobalField(db, { name: 'state', field_type: 'string' });
    createSchemaDefinition(db, { name: 'todo', field_claims: [{ field: 'state' }] });
    setStoredSettings(db, 'vault', {
      taskType: 'todo', taskStatusField: 'state', taskActiveStatuses: ['doing'], taskDoneStatuses: ['shipped'],
      projectType: null, meetingType: null, dailyNoteType: null,
    });
    seed({ id: 't0', path: 'Todo/A.md', types: ['todo'], fields: { state: 'doing' } });
    seed({ id: 't1', path: 'Todo/B.md', types: ['todo'], fields: { state: 'open' } });
    seed({ id: 't2', path: 'Todo/C.md', types: ['todo'] });

    const report = await call('cleanup-report');
    expect(rowOf(report, 'task-status-missing')).toMatchObject({ title: 'todo notes with no state', notes: 1, out_of: 3 });
    const unknown = rowOf(report, 'task-status-unknown');
    expect(unknown).toMatchObject({ title: 'todo state values the vault map does not know', examples: [{ value: 'open', notes: 1 }] });
    expect(unknown.next.find(step => step.tool === 'update-settings')!.arguments).toEqual({ domain: 'vault', patch: { taskActiveStatuses: ['doing', 'open'] } });

    expect(report.data.not_checked.map((entry: { id: string }) => entry.id)).toEqual([
      'project-status-missing', 'meeting-people-missing', 'project-status-unknown', 'no-date',
    ]);
    expect(report.data.not_checked[0].reason).toContain('projectType');
  });

  it('takes a number of examples and refuses anything else', async () => {
    seedSchemas();
    for (let i = 0; i < 12; i++) seed({ id: `u${String(i).padStart(2, '0')}`, path: `Inbox/Loose ${i}.md` });
    expect(rowOf(await call('cleanup-report'), 'untyped').examples).toHaveLength(3);
    expect(rowOf(await call('cleanup-report', { examples: 10 }), 'untyped').examples).toHaveLength(10);
    expect(await call('cleanup-report', { examples: 11 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await call('cleanup-report', { kinds: ['task'] })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  });
});
