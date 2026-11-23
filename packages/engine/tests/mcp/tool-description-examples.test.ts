import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createTestDb } from '../helpers/db.js';
import { createServer } from '../../src/mcp/server.js';
import { setStoredSettings } from '../../src/settings/store.js';
import { migrateVaultSettings } from '../../src/settings/seed.js';
import { DEFAULT_EXAMPLE_NAMES, exampleNames } from '../../src/mcp/example-names.js';
import { vaultSettingsFrom } from '@vault/settings-registry';

// Registration never calls into these collaborators; stubs let every optional tool register.
const stub = new Proxy({}, { get: () => () => undefined }) as never;

async function connect(db: Database.Database): Promise<Client> {
  const server = createServer(db, {
    writeLock: stub, syncLogger: stub, vaultPath: '/nonexistent-vault', attachmentDir: '/nonexistent-vault/Attachments',
    extractorRegistry: stub, extractionCache: stub, embeddingIndexer: stub, embedder: stub,
    memoryNoteProjection: stub, transcriptStore: stub, webSearchProvider: stub, usageRecorder: stub,
    settingsService: stub, settingsNoteDeps: stub, modelCatalog: stub,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'description-test', version: '0' });
  await client.connect(clientSide);
  return client;
}

async function listTools(db: Database.Database): Promise<Tool[]> {
  const client = await connect(db);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

async function described(db: Database.Database) {
  const tools = await listTools(db);
  const tool = (name: string): Tool => {
    const found = tools.find(t => t.name === name);
    if (!found) throw new Error(`${name} is not registered`);
    return found;
  };
  const props = (name: string) => tool(name).inputSchema.properties as Record<string, { description?: string }>;
  return {
    queryNodes: tool('query-nodes').description ?? '',
    summarizeNodes: tool('summarize-nodes').description ?? '',
    readRollups: tool('read-rollups').description ?? '',
    readRollupsSchema: JSON.stringify(tool('read-rollups').inputSchema),
    createNode: tool('create-node').description ?? '',
    schemaName: props('create-schema').name?.description,
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('tool description examples: the default vault map', () => {
  it('names the default kinds, fields and statuses, as before the map', async () => {
    const d = await described(createTestDb());
    expect(d.queryNodes).toContain('Use include_fields to return field values inline (e.g. ["status","due"] or ["*"] for all).');
    expect(d.queryNodes).toContain('Example — open tasks whose linked project is done: {"types":["task"],"fields":{"status":{"eq":"open"}},"join_filters":[{"target":{"types":["project"],"fields":{"status":{"eq":"done"}}}}]}.');
    expect(d.queryNodes).toContain([
      'Common query recipes:',
      '- Open tasks: {"types":["task"],"fields":{"status":{"eq":"open"}}}',
      '- Tasks with multiple statuses: {"types":["task"],"fields":{"status":{"one_of":["open","in-progress"]}}}',
      '- Tasks in project X: {"types":["task"],"references":{"target":"X"}}',
      '- Overdue tasks: {"types":["task"],"fields":{"due":{"lt":"2026-04-20"},"status":{"ne":"done"}}}',
      '- Tasks with no project: {"types":["task"],"without_joins":[{"target":{"types":["project"]}}]}',
      '- Recently modified notes: {"types":["note"],"modified_since":"2026-04-13"}',
    ].join('\n'));
    expect(d.summarizeNodes).toContain('E.g. with "project" parents, an incoming relation through the field that links "task" nodes to them summarizes those per parent; with "task" parents, an outgoing one looks up their "project" nodes.');
    expect(d.readRollups).toContain('e.g. filter:{fields:{status:{ne:"done"}}}.');
    expect(d.readRollups).toContain('(e.g. status, due)');
    expect(d.readRollupsSchema).toContain('Additional scalar typed global fields, e.g. status and due.');
    expect(d.readRollupsSchema).toContain('e.g. {fields:{status:{ne:\\"done\\"}}};');
    expect(d.createNode).toContain('For general-purpose notes and reference material, use type note. File location');
    expect(d.schemaName).toBe('Unique schema name (e.g. "project", "person")');
  });

  it('no longer names a project link field or a status the map does not have', async () => {
    const { queryNodes, summarizeNodes } = await described(createTestDb());
    expect(queryNodes).not.toContain('pending');
    expect(queryNodes).not.toContain('"rel_type":"project"');
    expect(queryNodes).not.toContain('"without_fields":["project"]');
    expect(queryNodes).not.toContain('["project","status"]');
    expect(summarizeNodes).not.toContain('project-field');
  });
});

describe('tool description examples: the default recipes run', () => {
  it('each query-nodes example returns the nodes its label promises', async () => {
    const db = createTestDb();
    const node = db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, \'\', NULL, ?, NULL)');
    const type = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
    const field = db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, \'frontmatter\')');
    const link = db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)');
    const seed = (id: string, kind: string, fields: Record<string, string>, mtime: number | null = null) => {
      node.run(id, `${id}.md`, id, mtime);
      type.run(id, kind);
      for (const [name, value] of Object.entries(fields)) field.run(id, name, value);
    };
    seed('P1', 'project', { status: 'done' });
    seed('P2', 'project', { status: 'open' });
    seed('T1', 'task', { status: 'open', due: '2026-04-01' });
    seed('T2', 'task', { status: 'in-progress' });
    seed('T3', 'task', { status: 'done', due: '2026-04-01' });
    seed('N1', 'note', {}, Date.parse('2026-05-01T00:00:00Z'));
    // T1's project is linked through one field, T2's through another: membership is by any link.
    link.run('T1', 'P1', 'parent', 'P1');
    link.run('T2', 'P2', 'initiative', 'P2');

    const client = await connect(db);
    const description = (await client.listTools()).tools.find(t => t.name === 'query-nodes')!.description!;
    const examples = new Map<string, Record<string, unknown>>();
    for (const line of description.split('\n')) {
      const match = /^- ([^:]+): (\{.*\})$/.exec(line);
      if (match) examples.set(match[1]!, JSON.parse(match[2]!) as Record<string, unknown>);
    }
    const join = /Example — open tasks whose linked project is done: (\{.*?\})\. Differs/.exec(description);
    examples.set('join', JSON.parse(join![1]!) as Record<string, unknown>);
    const ids = async (args: Record<string, unknown>): Promise<string[]> => {
      const result = await client.callTool({ name: 'query-nodes', arguments: args });
      const envelope = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { ok: boolean; data: { nodes: Array<{ id: string }> } };
      expect(envelope.ok).toBe(true);
      return envelope.data.nodes.map(n => n.id).sort();
    };
    const inProject = JSON.parse(JSON.stringify(examples.get('Tasks in project X')).replace('"X"', '"P1"')) as Record<string, unknown>;

    expect(await ids(examples.get('Open tasks')!)).toEqual(['T1']);
    expect(await ids(examples.get('Tasks with multiple statuses')!)).toEqual(['T1', 'T2']);
    expect(await ids(inProject)).toEqual(['T1']);
    expect(await ids(examples.get('Overdue tasks')!)).toEqual(['T1']);
    expect(await ids(examples.get('Tasks with no project')!)).toEqual(['T3']);
    expect(await ids(examples.get('Recently modified notes')!)).toEqual(['N1']);
    expect(await ids(examples.get('join')!)).toEqual(['T1']);
    await client.close();
  });
});

describe('tool description examples: renamed kinds, fields and statuses', () => {
  function renamedDb(): Database.Database {
    const db = createTestDb();
    setStoredSettings(db, 'vault', {
      taskType: 'action', projectType: 'initiative', journalType: 'entry', personType: 'contact',
      taskStatusField: 'state', projectStatusField: 'project phase', dueField: 'deadline',
      taskActiveStatuses: ['todo', 'doing'], taskDoneStatuses: ['finished'], taskBlockedStatuses: ['stuck'],
      projectDoneStatuses: ['shipped'],
    });
    return db;
  }

  it('builds every example from the designated names', async () => {
    const d = await described(renamedDb());
    expect(d.queryNodes).toContain('(e.g. ["state","deadline"] or ["*"] for all)');
    expect(d.queryNodes).toContain('{"types":["action"],"fields":{"state":{"eq":"todo"}},"join_filters":[{"target":{"types":["initiative"],"fields":{"project phase":{"eq":"shipped"}}}}]}');
    expect(d.queryNodes).toContain('- Open tasks: {"types":["action"],"fields":{"state":{"eq":"todo"}}}');
    expect(d.queryNodes).toContain('- Tasks with multiple statuses: {"types":["action"],"fields":{"state":{"one_of":["todo","doing"]}}}');
    expect(d.queryNodes).toContain('- Overdue tasks: {"types":["action"],"fields":{"deadline":{"lt":"2026-04-20"},"state":{"ne":"finished"}}}');
    expect(d.queryNodes).toContain('- Tasks with no project: {"types":["action"],"without_joins":[{"target":{"types":["initiative"]}}]}');
    expect(d.queryNodes).toContain('- Recently modified notes: {"types":["entry"],"modified_since":"2026-04-13"}');
    expect(d.summarizeNodes).toContain('with "initiative" parents, an incoming relation through the field that links "action" nodes to them');
    expect(d.readRollups).toContain('e.g. filter:{fields:{"project phase":{ne:"shipped"}}}.');
    expect(d.readRollups).toContain('(e.g. state, deadline)');
    expect(d.readRollupsSchema).toContain('Additional scalar typed global fields, e.g. state and deadline.');
    expect(d.readRollupsSchema).toContain('e.g. {fields:{\\"project phase\\":{ne:\\"shipped\\"}}};');
    expect(d.createNode).toContain('use type entry.');
    expect(d.schemaName).toBe('Unique schema name (e.g. "initiative", "contact")');
  });

  it('leaves no default name in an example', async () => {
    const d = await described(renamedDb());
    for (const text of [d.queryNodes, d.summarizeNodes, d.readRollups, d.readRollupsSchema]) {
      expect(text).not.toMatch(/"task"|"project"|"note"|"status"|"due"|"open"|"done"|\bstatus:|status, due|status and due/);
    }
    expect(d.createNode).not.toContain('type note');
  });
});

describe('tool description examples: kinds and fields that are none', () => {
  function noneDb(): Database.Database {
    const db = createTestDb();
    setStoredSettings(db, 'vault', {
      taskType: null, projectType: null, journalType: null, personType: null,
      taskStatusField: null, projectStatusField: null, dueField: null,
      taskActiveStatuses: [], taskDoneStatuses: [], taskBlockedStatuses: [], taskBacklogStatuses: [],
      taskIgnoredStatuses: [], projectDoneStatuses: [],
    });
    return db;
  }

  it('uses neutral placeholders, never the default names', async () => {
    const d = await described(noneDb());
    expect(d.queryNodes).toContain('(e.g. ["<status field>","<due field>"] or ["*"] for all)');
    expect(d.queryNodes).toContain('- Open tasks: {"types":["<task type>"],"fields":{"<status field>":{"eq":"<open status>"}}}');
    expect(d.queryNodes).toContain('- Tasks with multiple statuses: {"types":["<task type>"],"fields":{"<status field>":{"one_of":["<status>","<other status>"]}}}');
    expect(d.queryNodes).toContain('- Overdue tasks: {"types":["<task type>"],"fields":{"<due field>":{"lt":"2026-04-20"},"<status field>":{"ne":"<done status>"}}}');
    expect(d.queryNodes).toContain('- Tasks with no project: {"types":["<task type>"],"without_joins":[{"target":{"types":["<project type>"]}}]}');
    expect(d.queryNodes).toContain('- Recently modified notes: {"types":["<note type>"],"modified_since":"2026-04-13"}');
    expect(d.summarizeNodes).toContain('with "<project type>" parents, an incoming relation through the field that links "<task type>" nodes');
    expect(d.readRollups).toContain('e.g. filter:{fields:{"<status field>":{ne:"<done status>"}}}.');
    expect(d.readRollups).toContain('(e.g. <status field>, <due field>)');
    for (const text of [d.queryNodes, d.summarizeNodes, d.readRollups, d.readRollupsSchema]) {
      expect(text).not.toMatch(/"task"|"project"|"note"|"status"|"due"|"open"|"done"|\bstatus:|status, due|status and due/);
    }
  });

  it('leaves out advice that names a kind the vault does not have', async () => {
    const d = await described(noneDb());
    expect(d.createNode).not.toContain('general-purpose notes');
    expect(d.createNode).toContain('call list-schemas to see available types. File location is derived');
    expect(d.schemaName).toBe('Unique schema name');
  });

  it('keeps a designated name beside a none one', async () => {
    const db = createTestDb();
    setStoredSettings(db, 'vault', { personType: null, taskActiveStatuses: ['open'] });
    const d = await described(db);
    expect(d.schemaName).toBe('Unique schema name (e.g. "project")');
    expect(d.queryNodes).toContain('{"one_of":["open","blocked"]}');
  });
});

describe('tool description examples: the existing installation', () => {
  it('lists exactly the default-map tools after the upgrade moves its stored names into the map', async () => {
    const before = await listTools(createTestDb());
    // The installation as the previous release left it: no vault domain, an empty wiki
    // domain, and curator project statuses that differ from the wiki's default task statuses.
    const db = createTestDb();
    setStoredSettings(db, 'curator', {
      activeStatuses: ['open', 'in-progress', 'next'], wikiReconciliationMode: 'live', tz: '', topicDir: null,
      memorySweepTypes: ['meeting', 'daily-note', 'note'], orgTypeExclude: ['wiki', 'transcript'],
    });
    migrateVaultSettings(db);
    expect(await listTools(db)).toEqual(before);
  });

  it('registers every tool with the default examples when the map cannot be read', async () => {
    const expected = await listTools(createTestDb());
    const db = createTestDb();
    db.exec('DROP TABLE meta');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await listTools(db)).toEqual(expected);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tool descriptions use the default vault names'));
  });
});

describe('exampleNames', () => {
  it('matches the defaults of the vault map', () => {
    expect(exampleNames(vaultSettingsFrom({}))).toEqual(DEFAULT_EXAMPLE_NAMES);
    expect(DEFAULT_EXAMPLE_NAMES).toMatchObject({
      task: 'task', project: 'project', note: 'note', taskStatus: 'status', projectStatus: 'status',
      due: 'due', open: 'open', done: 'done', projectDone: 'done', statusPair: ['open', 'in-progress'],
    });
  });
});
