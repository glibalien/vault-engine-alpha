import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

// A field no kind defines that holds a link is stored as its value ("Dana W") and the text it
// was written from ("[[Dana W]]"). These follow a change to such a field to the file (#663).

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let server: McpServer;

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
  server = new McpServer({ name: 'unclaimed-links-test', version: '0' });
  registerUpdateNode(server, db, writeLock, vaultPath);
  registerBatchMutate(server, db, writeLock, vaultPath);
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
  warnings: Array<{ code: string; message: string }>;
}

async function call(name: string, args: Record<string, unknown>): Promise<Envelope> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const result = await (tool.callback ? tool.callback(args) : tool.handler(args));
  return JSON.parse(result.content[0].text) as Envelope;
}

/** Save a note's file as an editor would, and let the watcher read it. Returns the note's id. */
function typed(path: string, frontmatter: string[], body = 'Body.'): string {
  const absolute = join(vaultPath, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `---\n${frontmatter.join('\n')}\n---\n${body}\n`);
  processFileChange(absolute, path, db, writeLock, vaultPath);
  return (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(path) as { id: string }).id;
}

const file = (path: string): string => readFileSync(join(vaultPath, path), 'utf8');

interface Row { value: unknown; raw: string | null }
function stored(id: string, name: string): Row | undefined {
  const row = db.prepare('SELECT value_text, value_json, value_raw_text AS raw FROM node_fields WHERE node_id = ? AND field_name = ?')
    .get(id, name) as { value_text: string | null; value_json: string | null; raw: string | null } | undefined;
  return row === undefined ? undefined : { value: row.value_json !== null ? JSON.parse(row.value_json) : row.value_text, raw: row.raw };
}
const linksOf = (id: string, name: string): string[] =>
  (db.prepare('SELECT target FROM relationships WHERE source_id = ? AND rel_type = ? ORDER BY target').all(id, name) as Array<{ target: string }>).map(row => row.target);

const KICKOFF = 'Notes/Kickoff.md';
// The file as the Engine writes it (an empty types line and all), so an unchanged note's file can be compared whole.
const kickoff = (): string => typed(KICKOFF, [
  'types:',
  'lead: "[[Dana W]]"',
  'people involved:',
  '  - "[[Dana W]]"',
  '  - Lee Okafor',
  'place: Hall 2',
]);

describe('a tool write to a field no kind defines that holds a link', () => {
  it('changes the value in the file and in the database', async () => {
    const id = kickoff();
    const result = await call('update-node', { node_id: id, set_fields: { lead: 'Lee Okafor', 'people involved': ['Lee Okafor', 'Priya Raman'] } });
    expect(result.ok).toBe(true);

    expect(file(KICKOFF)).toContain('lead: Lee Okafor\n');
    expect(file(KICKOFF)).toContain('people involved:\n  - Lee Okafor\n  - Priya Raman\n');
    expect(file(KICKOFF)).not.toContain('Dana W');
    expect(stored(id, 'lead')).toEqual({ value: 'Lee Okafor', raw: null });
    expect(stored(id, 'people involved')).toEqual({ value: ['Lee Okafor', 'Priya Raman'], raw: null });
    expect(linksOf(id, 'lead')).toEqual([]);
    expect(linksOf(id, 'people involved')).toEqual([]);
  });

  it('writes a link where the caller writes one', async () => {
    const id = kickoff();
    await call('update-node', { node_id: id, set_fields: { lead: '[[Lee Okafor]]' } });
    expect(file(KICKOFF)).toContain('lead: "[[Lee Okafor]]"\n');
    expect(linksOf(id, 'lead')).toEqual(['Lee Okafor']);
  });

  it('keeps the links of the list items it leaves', async () => {
    const id = kickoff();
    // The caller read ["Dana W", "Lee Okafor"] and added a name.
    await call('update-node', { node_id: id, set_fields: { 'people involved': ['Dana W', 'Lee Okafor', 'Priya Raman'] } });
    expect(file(KICKOFF)).toContain('people involved:\n  - "[[Dana W]]"\n  - Lee Okafor\n  - Priya Raman\n');
    expect(stored(id, 'people involved')).toEqual({
      value: ['Dana W', 'Lee Okafor', 'Priya Raman'], raw: JSON.stringify(['[[Dana W]]', 'Lee Okafor', 'Priya Raman']),
    });
    expect(linksOf(id, 'people involved')).toEqual(['Dana W']);
    // The field it did not name is as it was.
    expect(file(KICKOFF)).toContain('lead: "[[Dana W]]"\n');

    // A name added as a link is a link, beside the one that was there.
    await call('update-node', { node_id: id, set_fields: { 'people involved': ['Dana W', '[[Priya Raman]]'] } });
    expect(file(KICKOFF)).toContain('people involved:\n  - "[[Dana W]]"\n  - "[[Priya Raman]]"\n');
    expect(stored(id, 'people involved')?.value).toEqual(['Dana W', 'Priya Raman']);
    expect(linksOf(id, 'people involved')).toEqual(['Dana W', 'Priya Raman']);
  });

  it('leaves a field alone when the write sets the value it already has', async () => {
    const id = kickoff();
    const before = file(KICKOFF);
    await call('update-node', { node_id: id, set_fields: { lead: 'Dana W', 'people involved': ['Dana W', 'Lee Okafor'] } });
    expect(file(KICKOFF)).toBe(before);
    expect(stored(id, 'lead')).toEqual({ value: 'Dana W', raw: '[[Dana W]]' });
  });

  it('keeps every link of the fields a write does not touch', async () => {
    const id = typed('Notes/Review.md', ['lead: "[[Dana W|Dana]]"', 'summary: met [[Dana W]] at [[Fair#Day 2]]', 'people:', '  - "[[Dana W]]"', '  - "[[Acme]] (buyer)"', 'place: Hall 2']);
    await call('update-node', { node_id: id, set_fields: { place: 'Hall 3' }, set_body: 'New text.' });
    const text = file('Notes/Review.md');
    expect(text).toContain('lead: "[[Dana W|Dana]]"\n');
    expect(text).toContain('summary: met [[Dana W]] at [[Fair#Day 2]]\n');
    expect(text).toContain('people:\n  - "[[Dana W]]"\n  - "[[Acme]] (buyer)"\n');
    expect(text).toContain('place: Hall 3\n');
  });

  it('clears the field when asked to', async () => {
    const id = kickoff();
    await call('update-node', { node_id: id, set_fields: { lead: null } });
    expect(file(KICKOFF)).not.toContain('lead:');
    expect(stored(id, 'lead')).toBeUndefined();
    expect(linksOf(id, 'lead')).toEqual([]);
  });

  it('previews the change it will make', async () => {
    kickoff();
    const before = file(KICKOFF);
    const preview = await call('update-node', { query: { path_prefix: 'Notes/' }, set_fields: { lead: 'Lee Okafor' } });
    expect(preview.data).toMatchObject({ dry_run: true, would_update: 1 });
    expect(file(KICKOFF)).toBe(before);
    const live = await call('update-node', { query: { path_prefix: 'Notes/' }, set_fields: { lead: 'Lee Okafor' }, dry_run: false });
    expect(live.data).toMatchObject({ dry_run: false, updated: 1 });
    expect(file(KICKOFF)).toContain('lead: Lee Okafor\n');
  });

  it('changes it through batch-mutate as well', async () => {
    const id = kickoff();
    const result = await call('batch-mutate', { operations: [{ op: 'update', params: { node_id: id, set_fields: { lead: 'Lee Okafor' } } }] });
    expect(result.ok).toBe(true);
    expect(file(KICKOFF)).toContain('lead: Lee Okafor\n');
  });

  it('undoes the change, links and all', async () => {
    const id = kickoff();
    const before = file(KICKOFF);
    const result = await call('update-node', { node_id: id, set_fields: { lead: 'Lee Okafor', 'people involved': ['Dana W', 'Priya Raman'] } });
    expect(file(KICKOFF)).not.toBe(before);
    const undone = await call('undo-operations', { operation_ids: [result.data.operation_id], dry_run: false });
    expect(undone.ok).toBe(true);
    expect(file(KICKOFF)).toBe(before);
    expect(stored(id, 'lead')).toEqual({ value: 'Dana W', raw: '[[Dana W]]' });
    expect(linksOf(id, 'people involved')).toEqual(['Dana W']);
  });
});

describe('an edit in the editor to a field no kind defines that held a link', () => {
  it('is not put back by the next tool write', async () => {
    const id = kickoff();
    // In the editor: another lead, and the brackets taken off a name in the list.
    typed(KICKOFF, ['lead: Lee Okafor', 'people involved:', '  - Dana W', '  - Lee Okafor', 'place: Hall 2']);
    expect(stored(id, 'lead')).toEqual({ value: 'Lee Okafor', raw: null });
    expect(stored(id, 'people involved')).toEqual({ value: ['Dana W', 'Lee Okafor'], raw: null });
    expect(linksOf(id, 'lead')).toEqual([]);

    await call('update-node', { node_id: id, set_fields: { place: 'Hall 3' } });
    const text = file(KICKOFF);
    expect(text).toContain('lead: Lee Okafor\n');
    expect(text).toContain('people involved:\n  - Dana W\n  - Lee Okafor\n');
    expect(text).toContain('place: Hall 3\n');
  });

  it('keeps the links the editor left, and takes the ones it wrote', async () => {
    const id = kickoff();
    typed(KICKOFF, ['lead: "[[Lee Okafor]]"', 'people involved:', '  - "[[Dana W]]"', '  - "[[Lee Okafor]]"', 'place: Hall 2']);
    expect(stored(id, 'lead')).toEqual({ value: 'Lee Okafor', raw: '[[Lee Okafor]]' });
    await call('update-node', { node_id: id, set_fields: { place: 'Hall 3' } });
    expect(file(KICKOFF)).toContain('lead: "[[Lee Okafor]]"\n');
    expect(file(KICKOFF)).toContain('people involved:\n  - "[[Dana W]]"\n  - "[[Lee Okafor]]"\n');
  });
});

describe('a row an older watcher path left with the raw text of an earlier value (#668)', () => {
  // Until #663, the watcher kept a field's stored raw text when the file held none, so an edit
  // that took the links out of a field was stored beside the old link. Such rows are made here
  // by hand, as the Engine no longer makes them.
  function leaveRaw(id: string, name: string, value: unknown, raw: string): void {
    db.prepare('UPDATE node_fields SET value_text = ?, value_json = ?, value_raw_text = ? WHERE node_id = ? AND field_name = ?').run(
      Array.isArray(value) ? null : value, Array.isArray(value) ? JSON.stringify(value) : null, raw, id, name,
    );
  }

  it('writes the field from its value when the file still shows the edit', async () => {
    const id = kickoff();
    typed(KICKOFF, ['types:', 'lead: Lee Okafor', 'people involved:', '  - Lee Okafor', '  - Priya Raman', 'place: Hall 2']);
    leaveRaw(id, 'lead', 'Lee Okafor', '[[Dana W]]');
    leaveRaw(id, 'people involved', ['Lee Okafor', 'Priya Raman'], JSON.stringify(['[[Dana W]]', 'Lee Okafor']));

    await call('update-node', { node_id: id, set_fields: { place: 'Hall 3' } });
    const text = file(KICKOFF);
    expect(text).toContain('lead: Lee Okafor\n');
    expect(text).toContain('people involved:\n  - Lee Okafor\n  - Priya Raman\n');
    expect(text).not.toContain('Dana W');
    expect(stored(id, 'lead')).toEqual({ value: 'Lee Okafor', raw: null });
    expect(stored(id, 'people involved')).toEqual({ value: ['Lee Okafor', 'Priya Raman'], raw: null });
    expect(linksOf(id, 'lead')).toEqual([]);
  });

  it('writes the field from its value when a tool write already put the old link back', async () => {
    const id = kickoff();
    leaveRaw(id, 'lead', 'Lee Okafor', '[[Dana W]]');

    await call('update-node', { node_id: id, set_fields: { place: 'Hall 3' } });
    expect(file(KICKOFF)).toContain('lead: Lee Okafor\n');
    expect(stored(id, 'lead')).toEqual({ value: 'Lee Okafor', raw: null });
    expect(linksOf(id, 'lead')).toEqual([]);
    // The fields whose raw text fits their value keep their links.
    expect(file(KICKOFF)).toContain('people involved:\n  - "[[Dana W]]"\n  - Lee Okafor\n');
  });

  it('keeps the raw text of a value that holds its brackets itself', async () => {
    // As the Engine stores a settings note's model fields.
    const id = typed('Notes/Setup.md', ['types:', 'model: "[[Model A]]"', 'place: Hall 2']);
    leaveRaw(id, 'model', '[[Model A]]', '[[Model A]]');
    await call('update-node', { node_id: id, set_fields: { place: 'Hall 3' } });
    expect(file('Notes/Setup.md')).toContain('model: "[[Model A]]"\n');
    expect(stored(id, 'model')).toEqual({ value: '[[Model A]]', raw: '[[Model A]]' });
  });
});

describe('under reference policy 2, a field defined as a list of references that no kind of the note claims', () => {
  beforeEach(() => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', '2')").run();
    createGlobalField(db, { name: 'people', field_type: 'list', list_item_type: 'reference' });
  });

  it('writes an added name as a link, beside the links it leaves', async () => {
    const id = typed('Notes/Review.md', ['types:', 'people:', '  - "[[Dana W|Dana]]"', '  - "[[Acme]]"']);
    await call('update-node', { node_id: id, set_fields: { people: ['Dana W', 'Lee Okafor'] } });
    // The definition makes every item a link: with no raw text the renderer brackets them all,
    // and the item that was there keeps the name it is shown by.
    expect(file('Notes/Review.md')).toContain('people:\n  - "[[Dana W|Dana]]"\n  - "[[Lee Okafor]]"\n');
    expect(stored(id, 'people')?.value).toEqual(['Dana W', 'Lee Okafor']);
    expect(linksOf(id, 'people')).toEqual(['Dana W', 'Lee Okafor']);

    await call('update-node', { node_id: id, set_fields: { people: ['Priya Raman'] } });
    expect(file('Notes/Review.md')).toContain('people:\n  - "[[Priya Raman]]"\n');
    expect(stored(id, 'people')).toEqual({ value: ['Priya Raman'], raw: null });
  });
});

