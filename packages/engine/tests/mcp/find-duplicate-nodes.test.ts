import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { DUPLICATE_LIMITS, exactDuplicateIds, findDuplicates } from '../../src/duplicates/service.js';
import { registerCleanupReport } from '../../src/mcp/tools/cleanup-report.js';
import { registerFindDuplicateNodes } from '../../src/mcp/tools/find-duplicate-nodes.js';
import { SUITE_NOTE_FIELD } from '../../src/notes/suite-notes.js';
import { setStoredSettings } from '../../src/settings/store.js';
import { insertNotes, mixedExportNotes } from '../survey/mixed-export-fixture.js';

interface Seed { id: string; path: string; body: string; types?: string[]; fields?: Record<string, string>; mtime?: number; created?: number }

function seed(db: Database.Database, note: Seed): void {
  const title = note.path.split('/').pop()!.replace(/\.md$/, '');
  db.prepare('INSERT INTO nodes (id, file_path, title, body, file_mtime, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(note.id, note.path, title, note.body, note.mtime ?? null, note.created ?? null);
  for (const type of note.types ?? []) db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(note.id, type);
  for (const [name, value] of Object.entries(note.fields ?? {})) {
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_text) VALUES (?, ?, ?)').run(note.id, name, value);
  }
}

function link(db: Database.Database, from: string, to: string): void {
  db.prepare('INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES (?, ?, ?, ?)').run(from, to, 'body', to);
}

const MEETING = [
  '# Acme sync on renewal pricing',
  '',
  'Date: 2021-03-04',
  'Attendees: Dana Whitfield, Lee Okafor, Priya Raman',
  '',
  '## Discussion',
  '',
  'We talked through the renewal pricing and the onboarding rollout. Lee raised concerns about timing, and Priya asked for the numbers by region before anyone commits.',
  '',
  '## Action items',
  '',
  '- Dana to send the revised quote',
  '- Lee to confirm the timeline with legal',
  '- Priya to update the tracker',
].join('\n');

const RECIPE = '# Lentil soup\n\nServes: 4\nTime: 35 minutes\n\n## Ingredients\n\n- 2 onions\n- 3 cloves garlic\n- 250 ml stock\n- 1 tsp cumin\n\n## Method\n\n1. Soften the onions over a low heat.\n2. Add the liquid and simmer for twenty minutes.\n3. Season and taste.';

let db: Database.Database;
let server: McpServer;
let client: Client;

beforeEach(async () => {
  db = createTestDb();
  server = new McpServer({ name: 'duplicates-test', version: '1' });
  registerFindDuplicateNodes(server, db, 'Settings');
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

async function call(args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name: 'find-duplicate-nodes', arguments: args });
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

type Note = { id: string; title: string; path: string; types: string[]; words: number; modified_at: string | null; created_at: string | null; inlink_count: number; outlink_count: number; body_hash: string };
type Group = { kind: 'exact' | 'near'; similarity: number; notes: Note[] };
const idsOf = (group: Group): string[] => group.notes.map(note => note.id).sort();

describe('find-duplicate-nodes', () => {
  it('advertises a strict, read-only tool that says what it does in its first sentence', async () => {
    const tool = (await client.listTools()).tools.find(entry => entry.name === 'find-duplicate-nodes')!;
    expect(tool.name).toBe('find-duplicate-nodes');
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
    expect(Object.keys(tool.inputSchema.properties!)).toEqual(['types', 'path_prefix', 'min_similarity', 'exact_only', 'limit', 'offset']);
    expect(tool.description!.split('. ')[0]!.length).toBeLessThanOrEqual(90);
  });

  it('finds the same note exported twice, whatever its title and folder, with what tells the copies apart', async () => {
    seed(db, { id: 'a', path: 'Evernote Export/Acme sync 20210304.md', body: MEETING, mtime: Date.UTC(2021, 2, 4), created: Date.UTC(2026, 10, 1) });
    seed(db, { id: 'b', path: 'Notion/Acme sync on renewal pricing 9f3c.md', body: `${MEETING.replace(/\n/g, '\r\n')}\r\n\r\n`, types: ['meeting'], mtime: Date.UTC(2023, 5, 1), created: Date.UTC(2026, 10, 2) });
    seed(db, { id: 'other', path: 'Notion/Lentil soup.md', body: RECIPE });
    seed(db, { id: 'p1', path: 'Projects/Renewal.md', body: 'See the sync notes for the renewal decision and the numbers that were asked for by region.' });
    seed(db, { id: 'p2', path: 'Projects/Onboarding.md', body: 'The rollout plan, as agreed at the sync, with the owners named for each of the steps it has.' });
    link(db, 'p1', 'b');
    link(db, 'p2', 'b');
    link(db, 'a', 'p1');

    const result = await call();
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      // The two project notes are under twenty words: too little text to be compared for near copies.
      scope: { notes: 5, compared: 3, left_out_types: ['transcript', 'daily-note'], truncated: false, near_incomplete: false },
      min_similarity: 0.7, total_groups: 1, total_notes: 2, offset: 0,
    });
    const [group] = result.data.groups as Group[];
    expect(group).toMatchObject({ kind: 'exact', similarity: 1 });
    // The copy other notes point at comes first.
    expect(group!.notes).toEqual([
      { id: 'b', title: 'Acme sync on renewal pricing 9f3c', path: 'Notion/Acme sync on renewal pricing 9f3c.md', types: ['meeting'], words: group!.notes[0]!.words,
        modified_at: '2023-06-01T00:00:00.000Z', created_at: '2026-11-02T00:00:00.000Z', inlink_count: 2, outlink_count: 0, body_hash: group!.notes[1]!.body_hash },
      { id: 'a', title: 'Acme sync 20210304', path: 'Evernote Export/Acme sync 20210304.md', types: [], words: group!.notes[0]!.words,
        modified_at: '2021-03-04T00:00:00.000Z', created_at: '2026-11-01T00:00:00.000Z', inlink_count: 0, outlink_count: 1, body_hash: group!.notes[0]!.body_hash },
    ]);
    expect(group!.notes[0]!.words).toBeGreaterThan(50);
    expect(group!.notes[0]!.body_hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('finds an edited copy and a copy in another app\'s markup as near duplicates, and says how alike', async () => {
    seed(db, { id: 'a', path: 'Evernote Export/Acme sync.md', body: MEETING });
    seed(db, { id: 'edited', path: 'Bear Notes/Acme sync (2).md', body: `${MEETING}\n- Dana to book the follow-up for next week` });
    seed(db, { id: 'remarked', path: 'Notion/Acme sync.md', body: MEETING.replace(/^## (.+)$/gm, '**$1**').replace(/^- /gm, '* ') });
    seed(db, { id: 'soup', path: 'Notion/Lentil soup.md', body: RECIPE });
    seed(db, { id: 'soup2', path: 'Bear Notes/Lentil soup.md', body: RECIPE.replace('35 minutes', '40 minutes') });

    const { data } = await call();
    expect(data.total_groups).toBe(2);
    const groups = data.groups as Group[];
    expect(groups.every(group => group.kind === 'near')).toBe(true);
    // The most alike group first.
    expect(groups[0]!.similarity).toBeGreaterThanOrEqual(groups[1]!.similarity);
    const soup = groups.find(group => idsOf(group).join() === 'soup,soup2')!;
    const sync = groups.find(group => idsOf(group).join() === 'a,edited,remarked')!;
    // One word of the recipe changed.
    expect(soup.similarity).toBeGreaterThan(0.8);
    expect(soup.similarity).toBeLessThan(1);
    // The same words in other markup is the same text, though the bodies differ: the group's
    // similarity is its weakest tie, the edited copy's.
    expect(sync.similarity).toBeGreaterThanOrEqual(0.7);
    expect(sync.similarity).toBeLessThan(1);
    expect(new Set(sync.notes.map(note => note.body_hash)).size).toBe(3);

    // Asked for exact copies only, there are none: no two bodies are the same.
    expect((await call({ exact_only: true })).data).toMatchObject({ total_groups: 0, scope: { compared: 0 } });
    // A stricter measure keeps only the pair with the very same words.
    const strict = (await call({ min_similarity: 0.95 })).data;
    expect(strict.groups.map((group: Group) => [group.kind, group.similarity, idsOf(group)])).toEqual([['near', 1, ['a', 'remarked']]]);
  });

  it('keeps exact copies together inside a near group', async () => {
    seed(db, { id: 'a', path: 'A/Sync.md', body: MEETING });
    seed(db, { id: 'b', path: 'B/Sync.md', body: MEETING });
    seed(db, { id: 'c', path: 'C/Sync.md', body: `${MEETING}\n- One more thing was added to this copy` });
    const { data } = await call();
    expect(data).toMatchObject({ total_groups: 1, total_notes: 3 });
    const [group] = data.groups as Group[];
    expect(group!.kind).toBe('near');
    const hashes = Object.fromEntries(group!.notes.map(note => [note.id, note.body_hash]));
    expect(hashes.a).toBe(hashes.b);
    expect(hashes.c).not.toBe(hashes.a);
  });

  it('leaves different notes written from one template alone', async () => {
    // 180 fictional notes from three apps, five kinds, twelve of each per app: every note of a
    // kind shares its labels, headings and stock phrases with the others, and none is a copy.
    const notes = mixedExportNotes(12);
    insertNotes(db, notes);
    expect((await call()).data).toMatchObject({ scope: { notes: 180, compared: 180 }, total_groups: 0 });

    // Three of them then get a second copy: one as it is, one with a line added, one in other markup.
    const [first, second, third] = [notes[0]!, notes[70]!, notes[130]!];
    seed(db, { id: 'copy-1', path: `Archive/${first.title}.md`, body: first.body });
    seed(db, { id: 'copy-2', path: `Archive/${second.title}.md`, body: `${second.body}\n\nAdded later: one more line on this copy.` });
    seed(db, { id: 'copy-3', path: `Archive/${third.title}.md`, body: third.body.replace(/^### /gm, '## ').replace(/^- /gm, '* ') });
    const { data } = await call();
    expect(data).toMatchObject({ scope: { notes: 183 }, total_groups: 3, total_notes: 6 });
    expect((data.groups as Group[]).map(group => [group.kind, idsOf(group)])).toEqual(expect.arrayContaining([
      ['exact', ['copy-1', first.id].sort()], ['near', ['copy-2', second.id].sort()], ['near', ['copy-3', third.id].sort()],
    ]));
    // Looser than the default, look-alikes from one template start to match: the lowest setting is a floor for a reason.
    expect((await call({ min_similarity: DUPLICATE_LIMITS.minSimilarity })).data.total_groups).toBeGreaterThan(3);
  });

  it('ties a chain of copies into one group, and a large family of them too', async () => {
    // Each copy adds a line to the one before: the first and the last are no longer alike, their neighbours are.
    let body = MEETING;
    for (let i = 0; i < 6; i++) {
      seed(db, { id: `v${i}`, path: `Versions/Sync v${i}.md`, body });
      body += `\n- Added in version ${i + 1}: a further point that was raised afterwards by someone on the team`;
    }
    const chain = (await call()).data;
    expect(chain.total_groups).toBe(1);
    expect(idsOf(chain.groups[0])).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5']);
    expect(chain.groups[0].similarity).toBeLessThan(0.9);

    // Forty copies that differ in one word each: more than are compared pair by pair.
    for (let i = 0; i < 40; i++) seed(db, { id: `f${String(i).padStart(2, '0')}`, path: `Family/Soup ${i}.md`, body: RECIPE.replace('35 minutes', `${10 + i} minutes`) });
    const family = (await call({ path_prefix: 'Family/' })).data;
    expect(family).toMatchObject({ total_groups: 1, total_notes: 40, scope: { near_incomplete: false } });
  });

  it('does not call empty notes, stubs or one-liners copies of each other', async () => {
    for (let i = 0; i < 5; i++) seed(db, { id: `empty${i}`, path: `People/Person ${i}.md`, body: '' });
    for (let i = 0; i < 5; i++) seed(db, { id: `stub${i}`, path: `Stubs/Stub ${i}.md`, body: '# Notes\n' });
    seed(db, { id: 'short1', path: 'A/Reminder.md', body: 'Call the dentist about the appointment on Tuesday.' });
    seed(db, { id: 'short2', path: 'B/Reminder.md', body: 'Call the dentist about the appointment on Tuesday.\n' });
    seed(db, { id: 'short3', path: 'C/Reminder.md', body: 'Call the dentist about the appointment on Friday.' });
    const { data } = await call();
    // A whole short note twice is a copy; a short note that differs is too little text to call nearly the same.
    expect(data).toMatchObject({ scope: { notes: 13, compared: 0 }, total_groups: 1 });
    expect(data.groups[0]).toMatchObject({ kind: 'exact' });
    expect(idsOf(data.groups[0])).toEqual(['short1', 'short2']);
  });

  it('compares the user\'s own notes: not the suite\'s, settings, wiki pages, transcripts or daily notes', async () => {
    seed(db, { id: 'a', path: 'Notes/Sync.md', body: MEETING });
    seed(db, { id: 'suite', path: 'Notes/Curator Journal.md', body: MEETING, fields: { [SUITE_NOTE_FIELD]: 'journal' } });
    seed(db, { id: 'setting', path: 'Settings/Sync.md', body: MEETING });
    seed(db, { id: 'wiki', path: 'Wikis/Sync Wiki.md', body: MEETING, types: ['wiki'] });
    seed(db, { id: 't1', path: 'Transcripts/Call 1.md', body: MEETING, types: ['transcript'] });
    seed(db, { id: 't2', path: 'Transcripts/Call 2.md', body: MEETING, types: ['transcript'] });
    seed(db, { id: 'd1', path: 'Daily/2024-03-01.md', body: MEETING, types: ['daily-note'] });
    seed(db, { id: 'd2', path: 'Daily/2024-03-02.md', body: MEETING, types: ['daily-note'] });
    expect((await call()).data).toMatchObject({ scope: { notes: 1, left_out_types: ['transcript', 'daily-note'] }, total_groups: 0 });

    // Named, a kind left out by default is compared.
    const daily = (await call({ types: ['daily-note'] })).data;
    expect(daily).toMatchObject({ scope: { notes: 2, left_out_types: [] }, total_groups: 1 });
    expect(idsOf(daily.groups[0])).toEqual(['d1', 'd2']);
    // A vault map that names no such kinds leaves none out.
    setStoredSettings(db, 'vault', { transcriptType: null, dailyNoteType: null });
    expect((await call()).data).toMatchObject({ scope: { notes: 5, left_out_types: [] }, total_groups: 1, total_notes: 5 });
  });

  it('narrows to a folder, pages its groups, and refuses what it cannot do', async () => {
    for (let i = 0; i < 3; i++) {
      seed(db, { id: `x${i}a`, path: `One/Note ${i}.md`, body: `${MEETING}\nUnique to pair number ${i} is this closing line of several words.` });
      seed(db, { id: `x${i}b`, path: `Two/Note ${i}.md`, body: `${MEETING}\nUnique to pair number ${i} is this closing line of several words.` });
    }
    const all = (await call({ min_similarity: 1 })).data;
    expect(all).toMatchObject({ total_groups: 3, total_notes: 6 });
    const first = (await call({ min_similarity: 1, limit: 2 })).data;
    const rest = (await call({ min_similarity: 1, limit: 2, offset: 2 })).data;
    expect(first.groups).toHaveLength(2);
    expect(rest).toMatchObject({ total_groups: 3, offset: 2 });
    expect([...first.groups, ...rest.groups].map(idsOf)).toEqual(all.groups.map(idsOf));
    // Within one folder, no note has its copy.
    expect((await call({ path_prefix: 'One/', min_similarity: 1 })).data).toMatchObject({ scope: { notes: 3 }, total_groups: 0 });

    expect(await call({ types: ['recipe'] })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_TYPE', details: { unknown_types: ['recipe'] } } });
    expect(await call({ min_similarity: 0.3 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await call({ group: 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  });

  it('is the clean-up report\'s row: the report counts the notes the exact groups hold', async () => {
    seed(db, { id: 'a', path: 'A/Sync.md', body: MEETING, mtime: 1_000 });
    seed(db, { id: 'b', path: 'B/Sync.md', body: MEETING, mtime: 3_000 });
    seed(db, { id: 'c', path: 'C/Sync.md', body: `${MEETING}\n- a near copy, which the report leaves to the tool`, mtime: 2_000 });
    seed(db, { id: 's1', path: 'A/Soup.md', body: RECIPE, mtime: 500 });
    seed(db, { id: 's2', path: 'B/Soup.md', body: RECIPE, mtime: 400 });
    seed(db, { id: 'd1', path: 'Daily/2024-03-01.md', body: MEETING, types: ['daily-note'] });
    seed(db, { id: 'd2', path: 'Daily/2024-03-02.md', body: MEETING, types: ['daily-note'] });

    const report = JSON.parse(((await client.callTool({ name: 'cleanup-report', arguments: {} })).content as Array<{ text: string }>)[0]!.text);
    const row = report.data.rows.find((entry: { id: string }) => entry.id === 'duplicates');
    expect(row).toMatchObject({ title: 'Notes with the same text as another note', notes: 4, out_of: 7 });
    expect(row.next.map((step: { tool: string }) => step.tool)).toEqual(['find-duplicate-nodes', 'cleanup-report', 'merge-nodes']);

    // The row's own listing, newest first, is the notes of the tool's exact copies.
    const listed = JSON.parse(((await client.callTool({ name: 'cleanup-report', arguments: row.next[1].arguments })).content as Array<{ text: string }>)[0]!.text);
    expect(listed.data.notes.map((note: { id: string }) => note.id)).toEqual(['b', 'a', 's1', 's2']);
    const found = (await call(row.next[0].arguments)).data;
    const sameBody = (found.groups as Group[]).flatMap(group => {
      const byHash = new Map<string, string[]>();
      for (const note of group.notes) byHash.set(note.body_hash, [...(byHash.get(note.body_hash) ?? []), note.id]);
      return [...byHash.values()].filter(ids => ids.length > 1).flat();
    });
    expect(sameBody.sort()).toEqual(['a', 'b', 's1', 's2']);
    // The tool also finds the near copy, in the meeting's group.
    expect(found.total_notes).toBe(5);
  });

  it('counts every exact copy in the report row, past the most notes the tool reads', () => {
    // The tool reads the first notes by id and says it stopped; the row has nowhere to say so, and reads them all.
    seed(db, { id: 'a', path: 'A/Sync.md', body: MEETING, mtime: 2_000 });
    seed(db, { id: 'b', path: 'B/Soup.md', body: RECIPE, mtime: 1_000 });
    seed(db, { id: 'c', path: 'C/Sync.md', body: MEETING, mtime: 3_000 });
    seed(db, { id: 'd', path: 'D/Soup.md', body: RECIPE, mtime: 4_000 });

    const capped = findDuplicates(db, {}, { settingsDir: 'Settings', maxNotes: 2 });
    expect(capped).toMatchObject({ scope: { notes: 2, truncated: true }, total_groups: 0 });
    expect(exactDuplicateIds(db, 'Settings')).toEqual(['d', 'c', 'a', 'b']);
    expect(findDuplicates(db, {}, { settingsDir: 'Settings' })).toMatchObject({ scope: { notes: 4, truncated: false }, total_groups: 2, total_notes: 4 });
  });

  it('puts a large family of near copies in one group', () => {
    // Each note is the meeting with one more line: distinct texts, so the family is built member by member.
    const size = 600;
    for (let i = 0; i < size; i++) seed(db, { id: `m${String(i).padStart(4, '0')}`, path: `Sync/Copy ${i}.md`, body: `${MEETING}\n- point ${i}` });
    const family = findDuplicates(db, { limit: 1 }, { settingsDir: 'Settings' });
    expect(family).toMatchObject({ total_groups: 1, total_notes: size, scope: { near_incomplete: false } });
    expect(family.groups[0]!.notes).toHaveLength(size);
  });

  it('gives the same answer every time', async () => {
    insertNotes(db, mixedExportNotes(4));
    seed(db, { id: 'a', path: 'A/Sync.md', body: MEETING });
    seed(db, { id: 'b', path: 'B/Sync.md', body: `${MEETING}\n- and one more point` });
    expect(await call({ min_similarity: 0.5 })).toEqual(await call({ min_similarity: 0.5 }));
  });
});
