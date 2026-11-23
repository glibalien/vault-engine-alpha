import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { loadNodeState } from '../../src/pipeline/node-state.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { ensureWikiSchema } from '../../src/wiki/bootstrap.js';
import { DEFAULT_WIKI_CONFIG } from '../../src/wiki/config.js';
import { registerWikiStatus } from '../../src/mcp/tools/wiki-status.js';

function handler(server: McpServer, name: string): (args: Record<string, unknown>) => Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  return tool.callback ?? tool.handler;
}

function payload(result: unknown): Record<string, any> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe('wiki-status tool (#547)', () => {
  let db: Database.Database;
  let vaultPath: string;
  let cleanup: () => void;
  let writeLock: WriteLockManager;
  let call: (args: Record<string, unknown>) => Promise<Record<string, any>>;
  const homeFile = () => join(vaultPath, 'Wikis/Alpha Wiki.md');

  beforeEach(() => {
    db = createTestDb();
    ({ vaultPath, cleanup } = createTempVault());
    writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('project', 'Project', '[]')").run();
    ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
    mkdirSync(join(vaultPath, 'Wikis'), { recursive: true });
    const server = new McpServer({ name: 'test', version: '0' });
    registerWikiStatus(server, { db, writeLock, vaultPath });
    const tool = handler(server, 'wiki-status');
    call = async (args) => payload(await tool(args));
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  function create(filePath: string, types: string[], fields: Record<string, unknown>, body: string): string {
    return executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: filePath,
      title: filePath.replace(/^.*\//u, '').replace(/\.md$/u, ''), types, fields, body,
    }).node_id;
  }

  /** A wiki whose stamped hash ('ev-1' unless given) no longer matches its project's notes. */
  function wiki(status?: string, evidenceHash: string | null = 'ev-1'): { projectId: string; homeId: string } {
    const projectId = create('Alpha.md', ['project'], {}, 'Project note.\n');
    const homeId = create('Wikis/Alpha Wiki.md', ['wiki'], {
      wiki_for: 'Alpha',
      ...(evidenceHash === null ? {} : { wiki_evidence_hash: evidenceHash }),
      ...(status === undefined ? {} : { wiki_status: status }),
    }, 'Home prose.\n');
    return { projectId, homeId };
  }

  it('reads the status of the wiki whose root it is given', async () => {
    const { projectId, homeId } = wiki('current');

    const result = await call({ root: 'Alpha' });

    expect(result).toMatchObject({ ok: true, data: { root_id: projectId, home_node_id: homeId, status: 'current', built: true, written: false } });
  });

  it('writes a new status to the home and its file, and nothing when it is unchanged', async () => {
    const { homeId } = wiki('current');

    const written = await call({ root: 'Alpha', status: 'building' });
    const again = await call({ root: 'Alpha', status: 'building' });

    expect(written).toMatchObject({ ok: true, data: { home_node_id: homeId, previous_status: 'current', status: 'building', written: true } });
    expect(readFileSync(homeFile(), 'utf-8')).toMatch(/^wiki_status: building$/mu);
    expect(again.data).toMatchObject({ written: false, version: written.data.version });
  });

  it('writes behind for current, and paused-behind for paused, when the project\'s notes moved on', async () => {
    wiki('building');
    expect((await call({ root: 'Alpha', status: 'current' })).data).toMatchObject({ status: 'behind', written: true });
    expect((await call({ root: 'Alpha', status: 'paused' })).data).toMatchObject({ status: 'paused-behind', written: true });
  });

  it('writes a first status to a home that has none', async () => {
    wiki(undefined, null);
    const result = await call({ root: 'Alpha', status: 'paused' });
    expect(result.data).toMatchObject({ previous_status: null, status: 'paused', written: true });
  });

  it('leaves the links in the page as written', async () => {
    create('Beta.md', ['project'], { aliases: ['Bee'] }, 'Another project.\n');
    const projectId = create('Alpha.md', ['project'], {}, 'Project note.\n');
    const homeId = create('Wikis/Alpha Wiki.md', ['wiki'], { wiki_for: 'Alpha', wiki_status: 'current' }, 'Home prose.\n');
    db.prepare('UPDATE nodes SET body = ? WHERE id = ?').run('Home prose. See [[Bee]].\n', homeId);
    const state = loadNodeState(db, homeId)!;
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: homeId, file_path: state.file_path, title: state.title, types: state.types,
      fields: state.currentFields, body: 'Home prose. See [[Bee]].\n', canonicalizeLinks: false,
    });

    await call({ root: projectId, status: 'paused' });

    expect(loadNodeState(db, homeId)!.body).toBe('Home prose. See [[Bee]].\n');
  });

  it('refuses while the home has an edit the Engine has not read', async () => {
    wiki('current');
    const edited = readFileSync(homeFile(), 'utf-8').replace('Home prose.', 'Typed in Obsidian.');
    writeFileSync(homeFile(), edited, 'utf-8');

    const result = await call({ root: 'Alpha', status: 'paused' });

    expect(result.ok).toBe(false);
    expect(readFileSync(homeFile(), 'utf-8')).toBe(edited);
  });

  it('answers with no home for a root without a wiki, and NOT_FOUND for an unknown root', async () => {
    const projectId = create('Alpha.md', ['project'], {}, 'Project note.\n');

    expect((await call({ root: 'Alpha', status: 'paused' })).data).toEqual(
      { root_id: projectId, home_node_id: null, status: null, version: null, built: false, written: false },
    );
    expect(await call({ root: 'Nowhere' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
