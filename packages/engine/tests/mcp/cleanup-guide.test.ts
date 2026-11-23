import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { NOTHING_LEFT_STEPS, ORGANIZING_STEPS } from '../../src/cleanup/guide.js';
import { ORGANIZE_PROMPT_NAME } from '../../src/mcp/prompts.js';
import { createServer } from '../../src/mcp/server.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { normalizeAt, seededRandom } from '../../src/survey/kmeans.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

// Registration never calls into these collaborators; stubs let every optional tool register.
const stub = new Proxy({}, { get: () => () => undefined }) as never;

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect(server: McpServer): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'guide-test', version: '0' });
  await client.connect(clientSide);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return client;
}

const ALL_STEPS = [...ORGANIZING_STEPS, ...NOTHING_LEFT_STEPS].join('\n');

describe('the organizing steps', () => {
  it('name only tools a signed-in client has, and arguments those tools take', async () => {
    const db = createTestDb();
    cleanups.push(() => { db.close(); });
    // The external surface is what Claude Code and claude.ai see.
    const client = await connect(createServer(db, {
      writeLock: stub, syncLogger: stub, vaultPath: '/nonexistent-vault', attachmentDir: '/nonexistent-vault/Attachments',
      extractorRegistry: stub, extractionCache: stub, embeddingIndexer: stub, embedder: stub,
      memoryNoteProjection: stub, transcriptStore: stub, webSearchProvider: stub, usageRecorder: stub,
      settingsService: stub, settingsNoteDeps: stub, modelCatalog: stub,
      surface: 'external',
    }));
    const tools = new Map((await client.listTools()).tools.map(tool => [tool.name, tool]));

    const named = [...new Set(ALL_STEPS.match(/\b[a-z]+(?:-[a-z]+)+\b/g) ?? [])];
    expect(named.filter(name => !tools.has(name))).toEqual([]);
    expect(named).toEqual(expect.arrayContaining(['cleanup-report', 'survey-nodes', 'create-schema', 'update-node', 'undo-operations']));

    const takes = (tool: string): string => JSON.stringify(tools.get(tool)!.inputSchema);
    const expected: Record<string, string[]> = {
      'cleanup-report': ['row'],
      'survey-nodes': ['within', 'members_of'],
      'update-node': ['query', 'node_ids', 'add_types', 'dry_run'],
    };
    for (const [tool, parameters] of Object.entries(expected)) {
      for (const parameter of parameters) {
        expect(ALL_STEPS, `${parameter} is named in the steps`).toContain(parameter);
        expect(takes(tool), `${tool} takes ${parameter}`).toContain(`"${parameter}"`);
      }
    }
  });

  it('are also served as a prompt the user picks, on every tool surface', async () => {
    for (const surface of ['external', 'full'] as const) {
      const db = createTestDb();
      cleanups.push(() => { db.close(); });
      const client = await connect(createServer(db, { surface }));
      expect((await client.listPrompts()).prompts).toEqual([
        expect.objectContaining({ name: ORGANIZE_PROMPT_NAME, title: 'Organize my vault' }),
      ]);
      const prompt = await client.getPrompt({ name: ORGANIZE_PROMPT_NAME });
      // One message, in the user's voice, that starts the session and carries every step.
      expect(prompt.messages).toHaveLength(1);
      const [message] = prompt.messages;
      expect(message!.role).toBe('user');
      const text = (message!.content as { type: string; text: string }).text;
      expect(text.startsWith('Help me organize my vault. Call cleanup-report first')).toBe(true);
      ORGANIZING_STEPS.forEach((step, index) => expect(text).toContain(`${index + 1}. ${step}`));
    }
  });

  it('stay short enough to send with every report', () => {
    expect(ORGANIZING_STEPS.join(' ').length).toBeLessThan(2400);
    expect(ORGANIZING_STEPS.length).toBeLessThanOrEqual(8);
  });
});

const DIMS = 256;
const random = seededRandom(7);

/** A unit vector close to one axis, so notes sharing an axis form one clear cluster. */
function near(axis: number): Float32Array {
  const vector = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) vector[i] = (random() - 0.5) * 0.05;
  vector[axis] = 1;
  normalizeAt(vector, 0, DIMS);
  return vector;
}

function embed(db: Database.Database, nodeId: string, vector: Float32Array): void {
  const meta = db.prepare(
    "INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at) VALUES (?, 'node', 'h', 0, NULL, '2026-01-01')",
  ).run(nodeId);
  db.prepare('INSERT INTO embedding_vec (id, vector) VALUES (?, ?)')
    .run(BigInt(meta.lastInsertRowid), new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
}

describe('following the organizing steps', () => {
  it('types a surveyed group after a preview, shrinks the row, and undoes it', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'vault-engine-guide-'));
    cleanups.push(() => rmSync(vaultPath, { recursive: true, force: true }));
    const db = createTestDb();
    cleanups.push(() => { db.close(); });
    const writeLock = new WriteLockManager();

    // A pile with no kinds: twenty meeting notes from one app, twenty recipes from another.
    const pad = (n: number): string => String(n + 1).padStart(2, '0');
    for (let i = 0; i < 20; i++) {
      const meeting = executeMutation(db, writeLock, vaultPath, {
        source: 'tool', node_id: null, file_path: `Export A/2021-03-${pad(i)} Weekly sync.md`, title: `2021-03-${pad(i)} Weekly sync`,
        types: [], fields: {}, body: `Attendees: Dana, Lee\n\n## Action items\n\n- send the notes\n`,
      });
      embed(db, meeting.node_id, near(0));
      const recipe = executeMutation(db, writeLock, vaultPath, {
        source: 'tool', node_id: null, file_path: `Export B/Soup number ${pad(i)}.md`, title: `Soup number ${pad(i)}`,
        types: [], fields: {}, body: '## Ingredients\n\n- 2 onions\n\n## Method\n\n1. Chop.\n',
      });
      embed(db, recipe.node_id, near(1));
    }

    const client = await connect(createServer(db, { writeLock, vaultPath }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    };
    const untypedRow = async (): Promise<{ notes: number } | undefined> => {
      const report = await call('cleanup-report');
      expect(report.ok).toBe(true);
      return (report.data.rows as Array<{ id: string; notes: number }>).find(row => row.id === 'untyped');
    };

    // Step 1: the report, with the steps ahead of its rows.
    const report = await call('cleanup-report');
    expect(report.data.guide).toEqual([...ORGANIZING_STEPS]);
    expect(Object.keys(report.data).indexOf('guide')).toBeLessThan(Object.keys(report.data).indexOf('rows'));
    expect(report.data.rows[0]).toMatchObject({ id: 'untyped', notes: 40 });

    // Steps 2 and 3: survey the untyped notes; one group is the meetings.
    const survey = await call('survey-nodes', { max_groups: 2 });
    expect(survey.ok).toBe(true);
    const groups = survey.data.groups as Array<{ group: number; notes: number; samples: Array<{ path: string }> }>;
    expect(groups.map(group => group.notes)).toEqual([20, 20]);
    const meetings = groups.find(group => group.samples[0]!.path.startsWith('Export A/'))!;
    const members = await call('survey-nodes', { members_of: { survey_id: survey.data.survey_id, group: meetings.group } });
    const ids = (members.data.members as Array<{ id: string }>).map(member => member.id);
    expect(ids).toHaveLength(20);

    // Step 4: the agreed kind, then its notes.
    expect((await call('create-schema', { name: 'meeting', field_claims: [] })).ok).toBe(true);
    const change = { query: { node_ids: ids }, add_types: ['meeting'] };

    // Step 5: with a query the call only previews until dry_run is false.
    const preview = await call('update-node', change);
    expect(preview.ok).toBe(true);
    expect(preview.data.dry_run).toBe(true);
    expect(await untypedRow()).toMatchObject({ notes: 40 });

    const applied = await call('update-node', { ...change, dry_run: false });
    expect(applied.ok).toBe(true);
    expect(readFileSync(join(vaultPath, 'Export A/2021-03-01 Weekly sync.md'), 'utf-8')).toMatch(/types:\s*\n\s*- meeting/);

    // Step 7: the row is smaller.
    expect(await untypedRow()).toMatchObject({ notes: 20 });

    // Step 6: the write is in the undo history, and undoing it restores the row.
    const history = await call('list-undo-history');
    const operation = (history.data.operations as Array<{ operation_id: string; source_tool: string; node_count: number }>)
      .find(entry => entry.source_tool === 'update-node');
    expect(operation).toMatchObject({ node_count: 20 });
    const undone = await call('undo-operations', { operation_ids: [operation!.operation_id], dry_run: false });
    expect(undone.ok).toBe(true);
    expect(await untypedRow()).toMatchObject({ notes: 40 });
  });

  it('says there is nothing to walk through when no row is left', async () => {
    const db = createTestDb();
    cleanups.push(() => { db.close(); });
    const client = await connect(createServer(db));
    const result = await client.callTool({ name: 'cleanup-report', arguments: {} });
    const report = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(report.data.rows).toEqual([]);
    expect(report.data.guide).toEqual([...NOTHING_LEFT_STEPS]);
  });
});
