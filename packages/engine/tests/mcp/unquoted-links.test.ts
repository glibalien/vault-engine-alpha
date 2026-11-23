import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { parse } from 'yaml';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { indexFile } from '../../src/indexer/indexer.js';
import { registerMergeNodes } from '../../src/mcp/tools/merge-nodes.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

// Links in a field no kind defines, written in forms YAML does not read as text: an unquoted
// `[[link]]` as a list item, and a link inside a map. They must survive a tool write (#667).

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let server: McpServer;

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
  server = new McpServer({ name: 'unquoted-links-test', version: '0' });
  registerUpdateNode(server, db, writeLock, vaultPath);
  registerUndoOperations(server, db, writeLock, vaultPath);
  registerMergeNodes(server, db, writeLock, vaultPath, undefined, undefined, 'Settings');
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
}

async function call(name: string, args: Record<string, unknown>): Promise<Envelope> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const result = await (tool.callback ? tool.callback(args) : tool.handler(args));
  return JSON.parse(result.content[0].text) as Envelope;
}

function save(path: string, frontmatter: string[], body = 'Body.'): string {
  const absolute = join(vaultPath, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `---\n${frontmatter.join('\n')}\n---\n${body}\n`);
  return absolute;
}
/** Save a note's file as an editor would, and let the watcher read it. Returns the note's id. */
function typed(path: string, frontmatter: string[], body = 'Body.'): string {
  processFileChange(save(path, frontmatter, body), path, db, writeLock, vaultPath);
  return (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(path) as { id: string }).id;
}

const frontmatterOf = (path: string): Record<string, unknown> => parse(readFileSync(join(vaultPath, path), 'utf8').split('---\n')[1]!) as Record<string, unknown>;
const linksOf = (id: string, name: string): string[] =>
  (db.prepare('SELECT target FROM relationships WHERE source_id = ? AND rel_type = ? ORDER BY target').all(id, name) as Array<{ target: string }>).map(row => row.target);
const valueOf = (id: string, name: string): unknown => {
  const row = db.prepare('SELECT value_text, value_json FROM node_fields WHERE node_id = ? AND field_name = ?').get(id, name) as { value_text: string | null; value_json: string | null };
  return row.value_json !== null ? JSON.parse(row.value_json) : row.value_text;
};

const KICKOFF = 'Notes/Kickoff.md';
const FRONTMATTER = [
  'people:',
  '  - [[Dana W]]',
  '  - Lee Okafor',
  'contact:',
  '  who: "[[Acme]]"',
  '  phone: 555-0100',
  'mixed:',
  '  - "[[Northwind|NW]] (buyer)"',
  '  - [[Lee Okafor]]',
  '  - who: [[Acme]]',
];

describe('a link written in a form YAML does not read as text', () => {
  it('survives a tool write that does not name its field', async () => {
    const id = typed(KICKOFF, FRONTMATTER);
    expect(valueOf(id, 'people')).toEqual(['Dana W', 'Lee Okafor']);
    expect(linksOf(id, 'people')).toEqual(['Dana W']);
    expect(linksOf(id, 'contact')).toEqual(['Acme']);

    expect((await call('update-node', { node_id: id, set_body: 'New text.' })).ok).toBe(true);
    // Written as the Engine writes every link: quoted.
    expect(frontmatterOf(KICKOFF)).toMatchObject({
      people: ['[[Dana W]]', 'Lee Okafor'],
      contact: { who: '[[Acme]]', phone: '555-0100' },
      mixed: ['[[Northwind|NW]] (buyer)', '[[Lee Okafor]]', { who: '[[Acme]]' }],
    });
    expect(linksOf(id, 'people')).toEqual(['Dana W']);
    expect(linksOf(id, 'contact')).toEqual(['Acme']);
    expect(linksOf(id, 'mixed')).toEqual(['Acme', 'Lee Okafor', 'Northwind']);

    // Read again from the file, it is the same note.
    typed(KICKOFF, readFileSync(join(vaultPath, KICKOFF), 'utf8').split('---\n')[1]!.trimEnd().split('\n'), 'New text.');
    expect(valueOf(id, 'people')).toEqual(['Dana W', 'Lee Okafor']);
    expect(linksOf(id, 'people')).toEqual(['Dana W']);
  });

  it('survives when the note was read at startup', async () => {
    const absolute = save(KICKOFF, FRONTMATTER);
    const id = indexFile(absolute, vaultPath, db);
    await call('update-node', { node_id: id, set_body: 'New text.' });
    expect(frontmatterOf(KICKOFF)).toMatchObject({ people: ['[[Dana W]]', 'Lee Okafor'], contact: { who: '[[Acme]]', phone: '555-0100' } });
  });

  it('keeps the links of the items a write to its field leaves', async () => {
    const id = typed(KICKOFF, FRONTMATTER);
    await call('update-node', { node_id: id, set_fields: { people: ['Dana W', 'Lee Okafor', 'Priya Raman'] } });
    expect(frontmatterOf(KICKOFF).people).toEqual(['[[Dana W]]', 'Lee Okafor', 'Priya Raman']);
    expect(linksOf(id, 'people')).toEqual(['Dana W']);
  });

  it('is written as given when a write changes a map', async () => {
    const id = typed(KICKOFF, FRONTMATTER);
    await call('update-node', { node_id: id, set_fields: { contact: { who: 'Northwind', phone: '555-0100' } } });
    expect(frontmatterOf(KICKOFF).contact).toEqual({ who: 'Northwind', phone: '555-0100' });
    expect(linksOf(id, 'contact')).toEqual([]);
    // An unchanged map keeps its link through a later write.
    await call('update-node', { node_id: id, set_fields: { contact: { who: '[[Northwind]]', phone: '555-0100' } } });
    await call('update-node', { node_id: id, set_body: 'Later.' });
    expect(frontmatterOf(KICKOFF).contact).toEqual({ who: '[[Northwind]]', phone: '555-0100' });
    expect(linksOf(id, 'contact')).toEqual(['Northwind']);
  });

  it('keeps a text that starts like a map as a text', async () => {
    const id = typed(KICKOFF, ["note: '{see [[Dana W]]}'", 'json: \'{"who":"[[Dana W]]"}\'']);
    await call('update-node', { node_id: id, set_body: 'New text.' });
    expect(frontmatterOf(KICKOFF).note).toBe('{see [[Dana W]]}');
    expect(frontmatterOf(KICKOFF).json).toBe('{"who":"[[Dana W]]"}');
    expect(linksOf(id, 'json')).toEqual(['Dana W']);
    // A list made of it keeps its link.
    await call('update-node', { node_id: id, set_fields: { json: ['{"who":"Dana W"}', 'Lee Okafor'] } });
    expect(frontmatterOf(KICKOFF).json).toEqual(['{"who":"[[Dana W]]"}', 'Lee Okafor']);
  });

  it('reads a target with a quote in it as written', async () => {
    const id = typed(KICKOFF, ['people:', '  - [[Acme "West"]]', '  - Lee Okafor', 'contact:', '  who: \'[[Acme "West"|West]]\'']);
    expect(linksOf(id, 'people')).toEqual(['Acme "West"']);
    expect(linksOf(id, 'contact')).toEqual(['Acme "West"']);
    await call('update-node', { node_id: id, set_body: 'New text.' });
    expect(frontmatterOf(KICKOFF)).toMatchObject({ people: ['[[Acme "West"]]', 'Lee Okafor'], contact: { who: '[[Acme "West"|West]]' } });
    expect(linksOf(id, 'people')).toEqual(['Acme "West"']);
    expect(linksOf(id, 'contact')).toEqual(['Acme "West"']);
    // Written by a tool, brackets and all.
    await call('update-node', { node_id: id, set_fields: { contact: { who: '[[Northwind "East"]]' } } });
    expect(linksOf(id, 'contact')).toEqual(['Northwind "East"']);
  });

  it('follows the note it links to when that note is renamed', async () => {
    const dana = typed('People/Dana W.md', ['role: buyer']);
    const id = typed(KICKOFF, FRONTMATTER);
    expect((await call('update-node', { node_id: dana, set_title: 'Dana Whitfield' })).ok).toBe(true);
    expect(frontmatterOf(KICKOFF).people).toEqual(['[[Dana Whitfield]]', 'Lee Okafor']);
    expect(linksOf(id, 'people')).toEqual(['Dana Whitfield']);
  });

  it('follows the note it links to inside a map, at any depth, when that note is renamed (#670)', async () => {
    const acme = typed('Companies/Acme.md', ['role: vendor']);
    const id = typed(KICKOFF, FRONTMATTER);
    const renamed = await call('update-node', { node_id: acme, set_title: 'Acme Corp' });
    expect(renamed.ok).toBe(true);
    expect(frontmatterOf(KICKOFF)).toMatchObject({
      contact: { who: '[[Acme Corp]]', phone: '555-0100' },
      mixed: ['[[Northwind|NW]] (buyer)', '[[Lee Okafor]]', { who: '[[Acme Corp]]' }],
    });
    expect(valueOf(id, 'contact')).toEqual({ who: 'Acme Corp', phone: '555-0100' });
    expect(valueOf(id, 'mixed')).toEqual(['Northwind (buyer)', 'Lee Okafor', { who: 'Acme Corp' }]);
    expect(linksOf(id, 'contact')).toEqual(['Acme Corp']);
    expect(linksOf(id, 'mixed')).toEqual(['Acme Corp', 'Lee Okafor', 'Northwind']);

    // And comes back when the rename is undone.
    expect((await call('undo-operations', { operation_ids: [renamed.data.operation_id], dry_run: false })).ok).toBe(true);
    expect(frontmatterOf(KICKOFF)).toMatchObject({ contact: { who: '[[Acme]]', phone: '555-0100' } });
    expect(linksOf(id, 'contact')).toEqual(['Acme']);
  });

  it('keeps the links inside a map when a rename rewrites another item of its list (#670)', async () => {
    const lee = typed('People/Lee Okafor.md', ['role: buyer']);
    const id = typed(KICKOFF, FRONTMATTER);
    expect((await call('update-node', { node_id: lee, set_title: 'Lee Okafor-Hale' })).ok).toBe(true);
    expect(frontmatterOf(KICKOFF).mixed).toEqual(['[[Northwind|NW]] (buyer)', '[[Lee Okafor-Hale]]', { who: '[[Acme]]' }]);
    expect(linksOf(id, 'mixed')).toEqual(['Acme', 'Lee Okafor-Hale', 'Northwind']);
  });

  it('follows the note it links to inside a map under reference policy 2 (#670)', async () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', '2')").run();
    const acme = typed('Companies/Acme.md', ['role: vendor']);
    const id = typed(KICKOFF, FRONTMATTER);
    expect((await call('update-node', { node_id: acme, set_title: 'Acme Corp' })).ok).toBe(true);
    expect(frontmatterOf(KICKOFF)).toMatchObject({
      contact: { who: '[[Acme Corp]]', phone: '555-0100' },
      mixed: ['[[Northwind|NW]] (buyer)', '[[Lee Okafor]]', { who: '[[Acme Corp]]' }],
    });
    expect(valueOf(id, 'contact')).toEqual({ who: 'Acme Corp', phone: '555-0100' });
    expect(linksOf(id, 'mixed')).toEqual(['Acme Corp', 'Lee Okafor', 'Northwind']);
  });

  it('keeps display text and anchors inside a map, and leaves plain text alone (#670)', async () => {
    const acme = typed('Companies/Acme.md', ['role: vendor']);
    const id = typed('Notes/Deal.md', [
      'contact:',
      '  who: "[[Acme|the vendor]]"',
      '  terms: "see [[Acme#Pricing]] and [[Northwind]]"',
      '  named: Acme',
      '  nested:',
      '    - "[[Acme]]"',
    ]);
    expect((await call('update-node', { node_id: acme, set_title: 'Acme Corp' })).ok).toBe(true);
    expect(frontmatterOf('Notes/Deal.md').contact).toEqual({
      who: '[[Acme Corp|the vendor]]',
      terms: 'see [[Acme Corp#Pricing]] and [[Northwind]]',
      named: 'Acme',
      nested: ['[[Acme Corp]]'],
    });
    expect(valueOf(id, 'contact')).toEqual({
      who: 'Acme Corp', terms: 'see Acme Corp#Pricing and Northwind', named: 'Acme', nested: ['Acme Corp'],
    });
  });

  it('is repointed inside a map when the note it links to is merged into another (#670)', async () => {
    const kept = typed('Companies/Acme Corp.md', ['role: vendor']);
    const other = typed('Companies/Acme.md', ['phone: 555-0199']);
    const id = typed(KICKOFF, FRONTMATTER);
    const merged = await call('merge-nodes', { keep: kept, merge: [other], dry_run: false });
    expect(merged.ok).toBe(true);
    expect(frontmatterOf(KICKOFF)).toMatchObject({
      contact: { who: '[[Acme Corp]]', phone: '555-0100' },
      mixed: ['[[Northwind|NW]] (buyer)', '[[Lee Okafor]]', { who: '[[Acme Corp]]' }],
    });
    expect(valueOf(id, 'contact')).toEqual({ who: 'Acme Corp', phone: '555-0100' });
    expect(valueOf(id, 'mixed')).toEqual(['Northwind (buyer)', 'Lee Okafor', { who: 'Acme Corp' }]);
    expect(linksOf(id, 'contact')).toEqual(['Acme Corp']);
    expect(linksOf(id, 'mixed')).toEqual(['Acme Corp', 'Lee Okafor', 'Northwind']);
  });

  it('is repointed when the note it links to is merged into another', async () => {
    const kept = typed('People/Dana Whitfield.md', ['role: buyer']);
    const other = typed('People/Dana W.md', ['phone: 555-0100']);
    const id = typed(KICKOFF, FRONTMATTER);
    const merged = await call('merge-nodes', { keep: kept, merge: [other], dry_run: false });
    expect(merged.ok).toBe(true);
    expect(frontmatterOf(KICKOFF).people).toEqual(['[[Dana Whitfield]]', 'Lee Okafor']);
    expect(linksOf(id, 'people')).toEqual(['Dana Whitfield']);
  });

  it('comes back whole when a write is undone', async () => {
    const id = typed(KICKOFF, FRONTMATTER);
    const result = await call('update-node', { node_id: id, set_fields: { people: ['Priya Raman'] } });
    expect(frontmatterOf(KICKOFF).people).toEqual(['Priya Raman']);
    expect((await call('undo-operations', { operation_ids: [result.data.operation_id], dry_run: false })).ok).toBe(true);
    expect(frontmatterOf(KICKOFF).people).toEqual(['[[Dana W]]', 'Lee Okafor']);
    expect(linksOf(id, 'people')).toEqual(['Dana W']);
  });
});
