import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerSurveyNodes } from '../../src/mcp/tools/survey-nodes.js';
import { normalizeAt, seededRandom } from '../../src/survey/kmeans.js';
import { SUITE_NOTE_FIELD } from '../../src/notes/suite-notes.js';

const DIMS = 256;
const random = seededRandom(11);

/** A unit vector close to one axis, so notes sharing an axis form one clear cluster. */
function near(axis: number): Float32Array {
  const vector = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) vector[i] = (random() - 0.5) * 0.05;
  vector[axis] = 1;
  normalizeAt(vector, 0, DIMS);
  return vector;
}

interface Seed { id: string; path: string; body?: string; types?: string[]; fields?: Record<string, string>; vector?: Float32Array }

function seed(db: Database.Database, note: Seed): void {
  const title = note.path.split('/').pop()!.replace(/\.md$/, '');
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run(note.id, note.path, title, note.body ?? '');
  for (const type of note.types ?? []) db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(note.id, type);
  for (const [name, value] of Object.entries(note.fields ?? {})) {
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_text) VALUES (?, ?, ?)').run(note.id, name, value);
  }
  if (note.vector) {
    const meta = db.prepare(
      "INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at) VALUES (?, 'node', 'h', 0, NULL, '2026-01-01')",
    ).run(note.id);
    db.prepare('INSERT INTO embedding_vec (id, vector) VALUES (?, ?)')
      .run(BigInt(meta.lastInsertRowid), new Uint8Array(note.vector.buffer, note.vector.byteOffset, note.vector.byteLength));
  }
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Twenty meetings, twenty recipes and twenty journal entries with no type, plus notes the survey must leave out. */
function seedPile(db: Database.Database): void {
  for (let i = 0; i < 20; i++) {
    seed(db, {
      id: `m${pad(i)}`, path: `Export A/2021-03-${pad(i + 1)} Weekly sync.md`, vector: near(0),
      body: `Attendees: Dana, Lee\nDate: 2021-03-${pad(i + 1)}\n\n## Action items\n\n- send the notes\n`,
      fields: { source: 'desktop' },
    });
    seed(db, {
      id: `r${pad(i)}`, path: `Recipes/Soup number ${i}.md`, vector: near(1),
      body: '## Ingredients\n\n- 2 onions\n\n## Method\n\n1. Chop.\n',
    });
    seed(db, { id: `j${pad(i)}`, path: `Export B/Journal ${i}.md`, vector: near(2), body: 'Mood: calm\n\nWalked by the river.\n' });
  }
  seed(db, { id: 'typed', path: 'Tasks/Buy milk.md', types: ['task'], vector: near(0) });
  seed(db, { id: 'suite', path: 'Notes/Journal of the suite.md', fields: { [SUITE_NOTE_FIELD]: 'journal' }, vector: near(2) });
  seed(db, { id: 'setting', path: 'Settings/Engine.md', vector: near(1) });
  seed(db, { id: 'new1', path: 'Inbox/Not embedded yet.md' });
  seed(db, { id: 'new2', path: 'Inbox/Also not embedded.md' });
}

let db: Database.Database;
let server: McpServer;
let client: Client;

beforeEach(async () => {
  db = createTestDb();
  server = new McpServer({ name: 'survey-test', version: '1' });
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

async function call(args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name: 'survey-nodes', arguments: args });
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

type Group = { group: number; notes: number; cohesion: number; nearest: { group: number; similarity: number } | null; samples: Array<{ id: string; title: string; path: string }>; shared: Record<string, Array<{ name: string; share: number }>> };
const groupWith = (groups: Group[], prefix: string): Group => groups.find(group => group.samples[0]!.id.startsWith(prefix))!;

describe('survey-nodes', () => {
  it('advertises a compact, strict, read-only tool', async () => {
    const tool = (await client.listTools()).tools[0]!;
    expect(tool.name).toBe('survey-nodes');
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
    expect(Object.keys(tool.inputSchema.properties!)).toEqual(['types', 'path_prefix', 'within', 'members_of', 'max_groups', 'samples', 'limit', 'offset']);
    // The group reference is defined once, referenced by within and members_of, and nothing else is hoisted.
    const advertised = tool.inputSchema as { definitions?: Record<string, { properties?: object }>; properties: Record<string, object> };
    expect(Object.keys(advertised.definitions ?? {})).toEqual(['SurveyGroupRef']);
    expect(Object.keys(advertised.definitions!.SurveyGroupRef!.properties!)).toEqual(['survey_id', 'group']);
    for (const name of ['within', 'members_of']) {
      expect(JSON.stringify(advertised.properties[name])).toContain('"$ref":"#/definitions/SurveyGroupRef"');
    }
    expect(JSON.stringify(advertised).match(/"\$ref"/g)).toHaveLength(2);
    // Chat hosts list a deferred tool by the first sentence of its description.
    expect(tool.description!.split('. ')[0]!.length).toBeLessThanOrEqual(90);
  });

  it('groups untyped notes and says what each group shares', async () => {
    seedPile(db);
    const result = await call({ max_groups: 3 });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.data.scope).toEqual({ kind: 'untyped', notes: 62, surveyed: 60, not_indexed: 2, truncated: false });
    expect(result.data.ungrouped.notes).toBe(0);

    const groups: Group[] = result.data.groups;
    expect(groups.map(group => group.notes)).toEqual([20, 20, 20]);
    expect(groups.map(group => group.group)).toEqual([1, 2, 3]);
    for (const group of groups) {
      expect(group.samples).toHaveLength(5);
      expect(new Set(group.samples.map(sample => sample.id[0])).size).toBe(1);
      expect(group.cohesion).toBeGreaterThan(0.9);
      expect(group.nearest!.group).not.toBe(group.group);
    }

    const meetings = groupWith(groups, 'm');
    expect(meetings.shared.folders).toEqual([{ name: 'Export A', share: 1 }]);
    expect(meetings.shared.title_patterns).toEqual([{ name: '<date> …', share: 1 }]);
    expect(meetings.shared.label_lines).toEqual([{ name: 'Attendees', share: 1 }, { name: 'Date', share: 1 }]);
    expect(meetings.shared.headings).toEqual([{ name: 'Action items', share: 1 }]);
    expect(meetings.shared.fields).toEqual([{ name: 'source', share: 1 }]);

    const recipes = groupWith(groups, 'r');
    expect(recipes.shared.headings.map(heading => heading.name)).toEqual(['Ingredients', 'Method']);
    expect(recipes.shared.title_patterns).toEqual([{ name: '… <n>', share: 1 }]);
    expect(groupWith(groups, 'j').shared.label_lines).toEqual([{ name: 'Mood', share: 1 }]);
  });

  it('gives the same groups and the same survey id for the same notes', async () => {
    seedPile(db);
    const first = await call({ max_groups: 3 });
    const second = await call({ max_groups: 3 });
    expect(second.data.survey_id).toBe(first.data.survey_id);
    expect(second.data.groups).toEqual(first.data.groups);
  });

  it('pages the notes of a group, whose ids drive a bulk change', async () => {
    seedPile(db);
    const survey = await call({ max_groups: 3 });
    const meetings = groupWith(survey.data.groups, 'm');
    const ref = { survey_id: survey.data.survey_id, group: meetings.group };

    const page = await call({ members_of: ref, limit: 15 });
    expect(page.data).toMatchObject({ survey_id: ref.survey_id, group: ref.group, total: 20, offset: 0 });
    expect(page.data.members).toHaveLength(15);
    const rest = await call({ members_of: ref, limit: 15, offset: 15 });
    const ids = [...page.data.members, ...rest.data.members].map((member: { id: string }) => member.id).sort();
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => `m${pad(i)}`));

    // The stored group survives the notes being typed, and drops a note deleted since.
    db.prepare("INSERT INTO node_types (node_id, schema_type) SELECT id, 'meeting' FROM nodes WHERE id LIKE 'm%'").run();
    db.prepare("DELETE FROM nodes WHERE id = 'm00'").run();
    const after = await call({ members_of: ref });
    expect(after.data.total).toBe(20);
    expect(after.data.members).toHaveLength(19);
  });

  it('surveys inside types, a folder, or one earlier group', async () => {
    seedPile(db);
    const typed = await call({ types: ['task'] });
    expect(typed.data.scope).toMatchObject({ kind: 'types', types: ['task'], notes: 1, surveyed: 1 });

    const folder = await call({ path_prefix: 'Recipes/' });
    expect(folder.data.scope).toMatchObject({ kind: 'untyped', path_prefix: 'Recipes/', notes: 20 });
    expect(folder.data.groups.reduce((sum: number, group: Group) => sum + group.notes, 0) + folder.data.ungrouped.notes).toBe(20);

    const survey = await call({ max_groups: 3 });
    const within = { survey_id: survey.data.survey_id, group: groupWith(survey.data.groups, 'j').group };
    const inner = await call({ within, max_groups: 2 });
    expect(inner.data.scope).toMatchObject({ kind: 'group', within, notes: 20, surveyed: 20 });
    expect(inner.data.groups.length).toBeLessThanOrEqual(2);
    for (const group of inner.data.groups as Group[]) expect(group.samples.every(sample => sample.id.startsWith('j'))).toBe(true);
  });

  it('reads a folder name literally, wildcard characters included', async () => {
    await server.close();
    await client.close();
    server = new McpServer({ name: 'survey-test', version: '1' });
    registerSurveyNodes(server, db, 'My_Settings');
    client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    for (let i = 0; i < 12; i++) {
      seed(db, { id: `u${pad(i)}`, path: `Export_A/Note ${i}.md`, vector: near(0) });
      seed(db, { id: `x${pad(i)}`, path: `ExportBA/Note ${i}.md`, vector: near(1) });
      seed(db, { id: `p${pad(i)}`, path: `100%/Note ${i}.md`, vector: near(2) });
    }
    seed(db, { id: 'own', path: 'My_Settings/Engine.md', vector: near(3) });
    seed(db, { id: 'near', path: 'MyXSettings/Plan.md', vector: near(3) });

    const underscore = await call({ path_prefix: 'Export_A/' });
    expect(underscore.data.scope.notes).toBe(12);
    expect(underscore.data.groups.flatMap((group: Group) => group.samples).every((sample: { id: string }) => sample.id.startsWith('u'))).toBe(true);
    expect((await call({ path_prefix: '100%/' })).data.scope.notes).toBe(12);
    expect((await call({ path_prefix: '100' })).data.scope.notes).toBe(12);
    expect((await call({ path_prefix: '%' })).data.scope.notes).toBe(0);

    // Only the settings folder itself is left out, not a folder its name would match as a pattern.
    expect((await call({ path_prefix: 'My' })).data.scope.notes).toBe(1);
    expect((await call({})).data.scope.notes).toBe(37);
  });

  it('forms fewer groups for a small scope and reports too few notes as ungrouped', async () => {
    for (let i = 0; i < 25; i++) seed(db, { id: `a${pad(i)}`, path: `Pile/Note ${i}.md`, vector: near(i % 5) });
    const small = await call({});
    // 25 notes allow two groups at most, whatever max_groups asks for.
    expect(small.data.groups.length).toBeLessThanOrEqual(2);

    db.prepare('DELETE FROM nodes').run();
    seed(db, { id: 'one', path: 'Pile/One.md', vector: near(0) });
    seed(db, { id: 'two', path: 'Pile/Two.md', vector: near(0) });
    const tiny = await call({});
    expect(tiny.data.groups).toEqual([]);
    expect(tiny.data.ungrouped).toMatchObject({ notes: 2 });
    const rest = await call({ members_of: { survey_id: tiny.data.survey_id, group: 0 } });
    expect(rest.data.members.map((member: { id: string }) => member.id)).toEqual(['one', 'two']);
  });

  it('returns an empty survey for an empty scope', async () => {
    const result = await call({});
    expect(result.ok).toBe(true);
    expect(result.data.scope).toMatchObject({ notes: 0, surveyed: 0, not_indexed: 0 });
    expect(result.data.groups).toEqual([]);
  });

  it('averages a long note\'s chunks and ignores attachment vectors', async () => {
    for (let i = 0; i < 12; i++) seed(db, { id: `a${pad(i)}`, path: `Pile/A ${i}.md`, vector: near(0) });
    for (let i = 0; i < 12; i++) seed(db, { id: `b${pad(i)}`, path: `Pile/B ${i}.md`, vector: near(1) });
    // A second chunk on the same axis keeps a00 with its group; an attachment vector on another axis must not move it.
    const insert = (chunk: number, sourceType: string, ref: string | null, vector: Float32Array): void => {
      const meta = db.prepare(
        "INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at) VALUES ('a00', ?, 'h', ?, ?, '2026-01-01')",
      ).run(sourceType, chunk, ref);
      db.prepare('INSERT INTO embedding_vec (id, vector) VALUES (?, ?)')
        .run(BigInt(meta.lastInsertRowid), new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
    };
    insert(1, 'node', null, near(0));
    insert(0, 'extraction', 'scan.pdf', near(1));
    const result = await call({ max_groups: 2 });
    const groupA = groupWith(result.data.groups, 'a');
    const members = await call({ members_of: { survey_id: result.data.survey_id, group: groupA.group } });
    expect(members.data.members.map((member: { id: string }) => member.id)).toContain('a00');
    expect(groupA.notes).toBe(12);
  });

  it('refuses unknown types, unknown surveys and arguments that do not go together', async () => {
    seedPile(db);
    const unknown = await call({ types: ['meeting', 'task'] });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'UNKNOWN_TYPE', details: { unknown_types: ['meeting'] } } });

    expect(await call({ members_of: { survey_id: 'nope', group: 1 } })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const survey = await call({ max_groups: 3 });
    const id = survey.data.survey_id;
    expect(await call({ members_of: { survey_id: id, group: 9 } })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await call({ within: { survey_id: id, group: 1 }, types: ['task'] })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await call({ members_of: { survey_id: id, group: 1 }, max_groups: 4 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await call({ limit: 10 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await call({ max_groups: 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await call({ folder: 'Recipes' })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  });

  it('keeps only the most recent surveys', async () => {
    seedPile(db);
    const first = await call({ max_groups: 3 });
    for (const prefix of ['Export A/', 'Export B/', 'Recipes/', 'Inbox/', 'Export', 'R', 'E', 'I']) await call({ path_prefix: prefix });
    expect(await call({ members_of: { survey_id: first.data.survey_id, group: 1 } })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
