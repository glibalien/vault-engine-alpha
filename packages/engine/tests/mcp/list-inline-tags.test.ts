import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerCleanupReport } from '../../src/mcp/tools/cleanup-report.js';
import { registerListInlineTags } from '../../src/mcp/tools/list-inline-tags.js';
import { SUITE_NOTE_FIELD } from '../../src/notes/suite-notes.js';
import { TAG_LIMITS } from '../../src/tags/service.js';

let db: Database.Database;
let server: McpServer;
let client: Client;
let mtime = 1;

beforeEach(async () => {
  db = createTestDb();
  mtime = 1;
  server = new McpServer({ name: 'tags-test', version: '1' });
  registerListInlineTags(server, db, 'Settings');
  registerCleanupReport(server, db, 'Settings');
  client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  db.close();
});

async function call(args: Record<string, unknown> = {}, name = 'list-inline-tags') {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

interface Seed { id: string; path: string; body?: string; types?: string[]; fields?: Record<string, string | string[]> }

/** Later notes are newer. */
function seed(note: Seed): void {
  const title = note.path.split('/').pop()!.replace(/\.md$/, '');
  db.prepare('INSERT INTO nodes (id, file_path, title, body, file_mtime) VALUES (?, ?, ?, ?, ?)').run(note.id, note.path, title, note.body ?? '', mtime++);
  for (const type of note.types ?? []) db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(note.id, type);
  for (const [name, value] of Object.entries(note.fields ?? {})) {
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, value_json) VALUES (?, ?, ?, ?)')
      .run(note.id, name, typeof value === 'string' ? value : null, typeof value === 'string' ? null : JSON.stringify(value));
  }
}

describe('list-inline-tags', () => {
  it('is a read-only tool that takes no unknown arguments', async () => {
    const tool = (await client.listTools()).tools.find(entry => entry.name === 'list-inline-tags')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(await call({ nope: 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await call({ limit: TAG_LIMITS.maxTags + 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await call({ tag: 'meeting', prefix: 'm' })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  });

  it('lists each tag with the notes that carry it, most notes first', async () => {
    seed({ id: 'm1', path: 'Imported/Kickoff.md', body: 'Notes. #meeting #acme' });
    seed({ id: 'm2', path: 'Imported/Review.md', body: '#Meeting\n\nText.', types: ['meeting'] });
    seed({ id: 'm3', path: 'Imported/Retro.md', body: 'No tag in the text.', fields: { tags: ['meeting', 'retro'] } });
    seed({ id: 'm4', path: 'Imported/Plan.md', body: '#meeting again', fields: { tags: '#meeting' } });
    seed({ id: 'r1', path: 'Imported/Soup.md', body: '# Soup\n\n#recipe' });
    seed({ id: 'n1', path: 'Imported/Plain.md', body: 'Issue #123, [[Note#Part]] and `#code`.' });

    const found = await call();
    expect(found.ok).toBe(true);
    expect(found.data).toMatchObject({ scope: { notes: 6, tagged: 5 }, total_tags: 4, offset: 0 });
    expect(found.data.tags[0]).toEqual({
      tag: 'meeting', notes: 4, inline: 3, in_field: 2, untyped: 3, nested_only: 0,
      types: [{ type: 'meeting', notes: 1 }],
      examples: [
        { id: 'm4', title: 'Plan', path: 'Imported/Plan.md' },
        { id: 'm3', title: 'Retro', path: 'Imported/Retro.md' },
        { id: 'm2', title: 'Review', path: 'Imported/Review.md' },
      ],
    });
    expect(found.data.tags.slice(1).map((row: { tag: string; notes: number }) => [row.tag, row.notes])).toEqual([['acme', 1], ['recipe', 1], ['retro', 1]]);
  });

  it('lists exactly the notes of one tag, with where each holds it', async () => {
    seed({ id: 'm1', path: 'Imported/Kickoff.md', body: 'Notes. #meeting' });
    seed({ id: 'm2', path: 'Imported/Review.md', body: 'Text.', types: ['meeting'], fields: { tags: ['Meeting'] } });
    seed({ id: 'm3', path: 'Imported/Plan.md', body: '#meeting', fields: { tag: 'meeting' } });
    seed({ id: 'x1', path: 'Imported/Other.md', body: '#meetings are long' });

    const listed = await call({ tag: '#Meeting' });
    expect(listed.data).toEqual({
      tag: 'meeting', total: 3, offset: 0,
      notes: [
        { id: 'm3', title: 'Plan', path: 'Imported/Plan.md', types: [], inline: true, in_field: true, nested_only: false },
        { id: 'm2', title: 'Review', path: 'Imported/Review.md', types: ['meeting'], inline: false, in_field: true, nested_only: false },
        { id: 'm1', title: 'Kickoff', path: 'Imported/Kickoff.md', types: [], inline: true, in_field: false, nested_only: false },
      ],
    });
    expect((await call({ tag: 'meeting', limit: 1, offset: 1 })).data).toMatchObject({ total: 3, offset: 1, notes: [{ id: 'm2' }] });
    expect(await call({ tag: 'nope' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('narrows by prefix, count, folder and to notes with no kind', async () => {
    seed({ id: 'a', path: 'Work/A.md', body: '#project/alpha #meeting' });
    seed({ id: 'b', path: 'Work/B.md', body: '#project/beta #meeting', types: ['meeting'] });
    seed({ id: 'c', path: 'Home/C.md', body: '#recipe' });

    const tags = async (args: Record<string, unknown>): Promise<string[]> => ((await call(args)).data.tags as Array<{ tag: string }>).map(row => row.tag);
    expect(await tags({ prefix: 'project/' })).toEqual(['project/alpha', 'project/beta']);
    expect(await tags({ min_notes: 2 })).toEqual(['meeting', 'project']);
    expect(await tags({ path_prefix: 'Home/' })).toEqual(['recipe']);
    expect(await tags({ untyped_only: true })).toEqual(['meeting', 'project', 'project/alpha', 'recipe']);
    expect((await call({ untyped_only: true, tag: 'meeting' })).data.notes.map((note: { id: string }) => note.id)).toEqual(['a']);
    expect((await call({ limit: 1, offset: 1 })).data).toMatchObject({ total_tags: 5, offset: 1 });
  });

  it('counts a nested tag for the tags it is nested under', async () => {
    seed({ id: 'a', path: 'Work/A.md', body: '#project/alpha/q1' });
    seed({ id: 'b', path: 'Work/B.md', body: '#project', fields: { tags: ['project/beta'] } });
    const found = await call();
    expect((found.data.tags as Array<{ tag: string; notes: number; nested_only: number }>).map(row => [row.tag, row.notes, row.nested_only])).toEqual([
      ['project', 2, 1], ['project/alpha', 1, 1], ['project/alpha/q1', 1, 0], ['project/beta', 1, 0],
    ]);
    const listed = await call({ tag: 'project' });
    expect(listed.data.notes).toMatchObject([
      { id: 'b', inline: true, in_field: true, nested_only: false },
      { id: 'a', inline: true, in_field: false, nested_only: true },
    ]);
  });

  it('reads only the user\'s notes', async () => {
    seed({ id: 'setting', path: 'Settings/Engine.md', body: '#setting' });
    seed({ id: 'suite', path: 'Wikis/Journal.md', body: '#journal', fields: { [SUITE_NOTE_FIELD]: 'journal' } });
    seed({ id: 'wiki', path: 'Wikis/Alpha Wiki.md', body: '#wiki', types: ['wiki'] });
    seed({ id: 'mine', path: 'Notes/Mine.md', body: '#mine' });
    const found = await call();
    expect(found.data).toMatchObject({ scope: { notes: 1, tagged: 1 }, total_tags: 1 });
    expect(found.data.tags[0].tag).toBe('mine');
  });

  it('is what the clean-up report\'s row for notes with no kind points at', async () => {
    seed({ id: 'a', path: 'Imported/A.md', body: '#meeting' });
    seed({ id: 'b', path: 'Imported/B.md', body: '#meeting', types: ['meeting'] });
    const report = await call({}, 'cleanup-report');
    const row = report.data.rows.find((entry: { id: string }) => entry.id === 'untyped');
    const step = row.next.find((entry: { tool: string }) => entry.tool === 'list-inline-tags');
    expect(row.next.map((entry: { tool: string }) => entry.tool)).toEqual(['survey-nodes', 'list-inline-tags', 'cleanup-report']);
    const found = await call(step.arguments);
    expect(found.data.tags).toMatchObject([{ tag: 'meeting', notes: 1, untyped: 1 }]);
    // The tag's notes are among the row's.
    const listed = await call({ ...step.arguments, tag: 'meeting' });
    const rowNotes = await call({ row: 'untyped' }, 'cleanup-report');
    const rowIds = new Set((rowNotes.data.notes as Array<{ id: string }>).map(note => note.id));
    expect((listed.data.notes as Array<{ id: string }>).every(note => rowIds.has(note.id))).toBe(true);
  });
});
