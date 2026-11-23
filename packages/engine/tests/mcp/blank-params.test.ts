/**
 * #558: many models fill in every optional parameter and send "" for the ones they don't mean
 * to set. A blank optional parameter counts as not given, for every tool, except where "" is a
 * real value (BLANK_IS_A_VALUE). These tests call tools through a real MCP client, so they also
 * fail if the SDK hook the rule rides on stops running.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestDb } from '../helpers/db.js';
import { createServer } from '../../src/mcp/server.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { TranscriptStore } from '../../src/extraction/transcript-store.js';
import { upgradeForAttachmentTranscripts } from '../../src/db/migrate.js';
import { MemoryService, quoteFtsPunctuatedTerms } from '../../src/memories/service.js';
import { BLANK_IS_A_VALUE, dropBlankOptionalParams } from '../../src/mcp/blank-params.js';
import { z } from 'zod';

const EV = { kind: 'conversation', ref: 'test#0' } as const;

let db: Database.Database;
let vault: string;
let client: Client;

async function call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: any; error?: { code: string; message: string } }> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0].text;
  // A schema rejection comes back as plain text with isError, not as an envelope.
  try { return JSON.parse(text); } catch { return { ok: false, error: { code: 'SCHEMA', message: text } }; }
}

beforeEach(async () => {
  db = createTestDb();
  upgradeForAttachmentTranscripts(db);
  vault = mkdtempSync(join(tmpdir(), 'blank-params-'));
  const server = createServer(db, { vaultPath: vault, writeLock: new WriteLockManager(), transcriptStore: new TranscriptStore(db) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'blank-params-test', version: '1.0.0' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  db.close();
  rmSync(vault, { recursive: true, force: true });
});

describe('get-node with blank optional identifiers', () => {
  it('reads node_id when title and file_path are sent blank', async () => {
    const created = await call('create-node', { title: 'Northwind kickoff', body: 'Agenda' });
    expect(created.ok).toBe(true);
    const id = created.data.node_id as string;

    const got = await call('get-node', { node_id: id, title: '', file_path: '' });
    expect(got.ok).toBe(true);
    expect(got.data.title).toBe('Northwind kickoff');
  });

  it('names what it received when more than one identifier is given', async () => {
    const got = await call('get-node', { node_id: 'n1', title: 'Northwind kickoff' });
    expect(got.ok).toBe(false);
    expect(got.error?.code).toBe('INVALID_PARAMS');
    expect(got.error?.message).toBe('Exactly one of node_id, file_path, or title is required; got node_id and title');
  });

  it('names that none was received when all three are blank', async () => {
    const got = await call('get-node', { node_id: '', title: '', file_path: '' });
    expect(got.error?.message).toBe('Exactly one of node_id, file_path, or title is required; got none');
  });
});

describe('list-memories with blank filters', () => {
  beforeEach(async () => {
    const memories = new MemoryService(db);
    for (const content of ['Prefers short status notes', 'The vault-engine deploy runs on Sundays', 'Acme renewal is due in March']) {
      const r = await memories.create({ content, source: 'chat', scope: 'vault', evidence: EV });
      expect(r.result.ok).toBe(true);
    }
  });

  it('ignores blank node_id and category instead of matching nothing', async () => {
    const all = await call('list-memories', {});
    expect(all.data.total).toBe(3);
    const blanks = await call('list-memories', { node_id: '', category: '', source: '', evidence_ref: '', as_of: '' });
    expect(blanks.ok).toBe(true);
    expect(blanks.data.total).toBe(3);
  });

  it('ignores a blank enum filter and a blank search instead of rejecting the call', async () => {
    const r = await call('list-memories', { scope: '', query: '' });
    expect(r.ok).toBe(true);
    expect(r.data.total).toBe(3);
  });

  it('searches a hyphenated word instead of failing with an internal error', async () => {
    const r = await call('list-memories', { query: 'vault-engine' });
    expect(r.ok).toBe(true);
    expect(r.data.memories.map((m: { content: string }) => m.content)).toEqual(['The vault-engine deploy runs on Sundays']);
  });

  it('still searches one column with a column filter', async () => {
    const memories = new MemoryService(db);
    await memories.create({ content: 'Keep replies concise', source: 'chat', scope: 'vault', category: 'preference', evidence: EV });
    const byCategory = await call('list-memories', { query: 'category:preference' });
    expect(byCategory.ok).toBe(true);
    expect(byCategory.data.memories.map((m: { content: string }) => m.content)).toEqual(['Keep replies concise']);
    const byContent = await call('list-memories', { query: 'content:concise' });
    expect(byContent.data.total).toBe(1);
  });

  it('searches a `word:` token', async () => {
    const r = await call('list-memories', { query: 'renewal:' });
    expect(r.ok).toBe(true);
    expect(r.data.total).toBe(1);
  });

  it('reports any other bad search string as invalid parameters, with a hint', async () => {
    const r = await call('list-memories', { query: 'deploy "Sundays' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_PARAMS');
    expect(r.error?.message).toMatch(/double quotes/);
  });
});

describe('quoteFtsPunctuatedTerms', () => {
  it('quotes bare terms with a hyphen or colon and keeps the rest of the syntax', () => {
    expect(quoteFtsPunctuatedTerms('vault-engine')).toBe('"vault-engine"');
    expect(quoteFtsPunctuatedTerms('status: open')).toBe('"status:" open');
    expect(quoteFtsPunctuatedTerms('deploy OR vault-eng*')).toBe('deploy OR "vault-eng"*');
    expect(quoteFtsPunctuatedTerms('"already-quoted" AND (a-b OR c)')).toBe('"already-quoted" AND ("a-b" OR c)');
    expect(quoteFtsPunctuatedTerms('NEAR(alpha beta)')).toBe('NEAR(alpha beta)');
  });

  it('keeps a filter on a real column, quoting only its term', () => {
    expect(quoteFtsPunctuatedTerms('category:preference')).toBe('category:preference');
    expect(quoteFtsPunctuatedTerms('content:concise OR -category:draft')).toBe('content:concise OR -category:draft');
    expect(quoteFtsPunctuatedTerms('content:vault-engine')).toBe('content:"vault-engine"');
    expect(quoteFtsPunctuatedTerms('category: preference')).toBe('category: preference');
    expect(quoteFtsPunctuatedTerms('status:open')).toBe('"status:open"');
  });
});

describe('where a blank is a real value', () => {
  it('query-nodes path_dir "" still means notes directly in the vault root', async () => {
    await call('create-node', { title: 'Root note' });
    await call('create-node', { title: 'Nested note', directory: 'Projects', override_default_directory: true });
    const r = await call('query-nodes', { path_dir: '', title_contains: '' });
    expect(r.ok).toBe(true);
    expect(r.data.nodes.map((n: { title: string }) => n.title)).toEqual(['Root note']);
  });

  it('update-node set_body "" still clears the body', async () => {
    const created = await call('create-node', { title: 'Scratch', body: 'Some text' });
    const id = created.data.node_id as string;
    const r = await call('update-node', { node_id: id, title: '', file_path: '', set_body: '' });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(vault, 'Scratch.md'), 'utf8')).not.toContain('Some text');
  });

  it('a blank required parameter is not dropped', async () => {
    const r = await call('save-conversation', { id: '', title: 'Kickoff' });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBe('id must be a non-empty string');
  });

  it('every listed exception names an optional parameter a registered tool advertises', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.inputSchema as { properties?: Record<string, unknown>; required?: string[] }]));
    for (const [tool, params] of Object.entries(BLANK_IS_A_VALUE)) {
      const schema = byName.get(tool);
      expect(schema, tool).toBeDefined();
      for (const param of params) {
        expect(Object.keys(schema!.properties ?? {}), `${tool}.${param}`).toContain(param);
        expect(schema!.required ?? [], `${tool}.${param}`).not.toContain(param);
      }
    }
  });
});

describe('dropBlankOptionalParams', () => {
  const tool = { inputSchema: z.object({ id: z.string(), filter: z.string().optional(), fields: z.record(z.string(), z.unknown()).optional() }) };

  it('drops blank and whitespace-only optional top-level values only', () => {
    expect(dropBlankOptionalParams('some-tool', tool, { id: '', filter: '  ', fields: { status: '' } }))
      .toEqual({ id: '', fields: { status: '' } });
  });

  it('returns the arguments unchanged when nothing is blank', () => {
    const args = { id: 'n1', filter: 'open' };
    expect(dropBlankOptionalParams('some-tool', tool, args)).toBe(args);
  });

  it('keeps a listed exception', () => {
    const updateNode = { inputSchema: z.object({ node_id: z.string().optional(), set_body: z.string().optional() }) };
    expect(dropBlankOptionalParams('update-node', updateNode, { node_id: '', set_body: '' })).toEqual({ set_body: '' });
  });
});
