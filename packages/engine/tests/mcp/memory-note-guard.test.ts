/**
 * #532: an edit to the memory note is read as the owner's own, and a `new:` block in it
 * becomes a memory with source `owner`. A signed-in chat client therefore cannot write
 * the note as a node; it changes memories through the memory tools. The suite's own
 * callers are not refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { setMemoryNotePath } from '../../src/settings/hook.js';
import { memoryNotePath } from '../../src/memories/note-format.js';
import { memoryNoteEditRefusal } from '../../src/mcp/tools/resolve-identity.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { processFileChange } from '../../src/sync/watcher.js';

const NOTE = memoryNotePath('Settings');
const CHAT_CLIENT = '3f8a5c2e-0000-4000-8000-000000000000';
const asChat = { authInfo: { token: 't', clientId: CHAT_CLIENT, scopes: [] } };
const asService = { authInfo: { token: 't', clientId: 'service-plugin', scopes: [] } };
// The same service token, on a call the host marks as its chat model's.
const asHostsModel = { ...asService, _meta: { 'vault-engine/chat-model': 'Obsidian chat' } };
const DRAFT = '<!-- ve:memory:new:11111111-1111-4111-8111-111111111111 revision="" base="" -->';

let db: Database.Database; let vaultPath: string; let cleanup: () => void; let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
  setMemoryNotePath(NOTE);
});
afterEach(() => {
  setMemoryNotePath(null);
  db.close();
  cleanup();
});

type Handler = (args: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<{ ok: boolean; error?: { code: string; message: string } }>;
function handlers(): Record<string, Handler> {
  const captured: Record<string, Handler> = {};
  const fake = {
    tool: (name: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured[name] = async (args, extra = {}) =>
        JSON.parse(((await h(args, extra)) as { content: Array<{ text: string }> }).content[0]!.text);
      return undefined;
    },
  } as unknown as McpServer;
  registerUpdateNode(fake, db, writeLock, vaultPath);
  registerBatchMutate(fake, db, writeLock, vaultPath);
  registerCreateNode(fake, db, writeLock, vaultPath);
  return captured;
}

/** Puts a memory note on disk and in the index, as a refresh would have. */
function existingNote(): string {
  mkdirSync(join(vaultPath, 'Settings'), { recursive: true });
  writeFileSync(join(vaultPath, NOTE), '---\nvault_engine_projection: memories\n---\n\n# Memories\n');
  processFileChange(join(vaultPath, NOTE), NOTE, db, writeLock, vaultPath);
  return readFileSync(join(vaultPath, NOTE), 'utf8');
}

describe('memoryNoteEditRefusal', () => {
  it('refuses a signed-in chat client on the memory note only', () => {
    expect(memoryNoteEditRefusal(vaultPath, NOTE, CHAT_CLIENT)).toMatch(/update-memory/);
    expect(memoryNoteEditRefusal(vaultPath, 'Notes/Plan.md', CHAT_CLIENT)).toBeNull();
    expect(memoryNoteEditRefusal(vaultPath, 'Settings/Memories 2.md', CHAT_CLIENT)).toBeNull();
    expect(memoryNoteEditRefusal(vaultPath, NOTE, 'service-plugin')).toBeNull();
    expect(memoryNoteEditRefusal(vaultPath, NOTE, undefined)).toBeNull();
  });

  it('goes by where a path lands, not by how it is spelled', () => {
    mkdirSync(join(vaultPath, 'Settings'), { recursive: true });
    symlinkSync(join(vaultPath, 'Settings'), join(vaultPath, 'Shortcut'));
    for (const spelled of [
      'Settings/./Memories.md', 'Settings//Memories.md', './Settings/Memories.md', 'Notes/../Settings/Memories.md',
      'settings/memories.MD', 'Settings/Memories.md.', 'Settings\\Memories.md', 'Shortcut/Memories.md',
    ]) {
      expect(memoryNoteEditRefusal(vaultPath, spelled, CHAT_CLIENT), spelled).toMatch(/update-memory/);
    }
    expect(memoryNoteEditRefusal(vaultPath, '../Settings/Memories.md', CHAT_CLIENT)).toBeNull(); // outside the vault: not this note
  });

  it('refuses nothing when no memory note is set', () => {
    setMemoryNotePath(null);
    expect(memoryNoteEditRefusal(vaultPath, NOTE, CHAT_CLIENT)).toBeNull();
  });
});

describe('a chat client writing the memory note as a node', () => {
  it('is refused by update-node and batch-mutate, and the note is unchanged', async () => {
    const before = existingNote();
    const h = handlers();

    for (const args of [
      { file_path: NOTE, append_body: `\n${DRAFT}\n` },
      { file_path: NOTE, set_body: DRAFT },
      { file_path: NOTE, set_body: DRAFT, dry_run: true },
    ]) {
      const refused = await h['update-node']!(args, asChat);
      expect(refused, JSON.stringify(args)).toMatchObject({
        ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('update-memory') },
      });
    }
    const batch = await h['batch-mutate']!({ operations: [{ op: 'update', params: { file_path: NOTE, append_body: DRAFT } }] }, asChat);
    expect(batch).toMatchObject({ ok: false, error: { code: 'BATCH_FAILED', message: expect.stringContaining('update-memory') } });

    // A bulk edit changes no body, but the note's types and fields decide what other
    // tools (wiki-write finds a page by type and wiki_for) may write into it.
    for (const dry_run of [true, false]) {
      const bulk = await h['update-node']!({ query: { title_eq: 'Memories' }, set_fields: { wiki_for: '[[Project Alpha]]' }, dry_run }, asChat);
      expect(bulk, `dry_run ${dry_run}`).toMatchObject({
        ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('update-memory') },
      });
    }

    expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toBe(before);
  });

  it('is refused when it would create the note', async () => {
    const h = handlers();
    const create = { title: 'Memories', directory: 'Settings', override_default_directory: true, body: DRAFT };

    expect(await h['create-node']!(create, asChat)).toMatchObject({
      ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('create-memory') },
    });
    const batch = await h['batch-mutate']!({ operations: [{ op: 'create', params: create }] }, asChat);
    expect(batch).toMatchObject({ ok: false, error: { code: 'BATCH_FAILED', message: expect.stringContaining('create-memory') } });
    // The same place under another spelling of the folder.
    for (const directory of ['Settings/.', 'Settings//', 'Notes/../Settings']) {
      const spelled = await h['create-node']!({ ...create, directory }, asChat);
      expect(spelled.ok, directory).toBe(false);
      expect(spelled.error?.message, directory).toContain('create-memory');
    }
    expect(existsSync(join(vaultPath, NOTE))).toBe(false);

    // The same call from the suite itself does create the note, so the refusals above
    // were for the caller and not for the request.
    expect((await h['create-node']!(create, asService)).ok).toBe(true);
    expect(existsSync(join(vaultPath, NOTE))).toBe(true);
  });
});

describe('a chat client moving another note onto the memory note\'s path', () => {
  /** A note holding a draft block, somewhere a rename or move could carry it from. */
  async function draftNote(h: Record<string, Handler>, title: string, directory: string) {
    const created = await h['create-node']!({ title, directory, override_default_directory: true, body: DRAFT }, asChat);
    expect(created.ok).toBe(true);
    return `${directory}/${title}.md`;
  }

  it('is refused by a rename, a move, a bulk move and a batch rename', async () => {
    const h = handlers();
    const elsewhere = await draftNote(h, 'Scratch', 'Notes');
    const sameName = await draftNote(h, 'Memories', 'Notes');
    const sameFolder = await draftNote(h, 'Drafts', 'Settings');
    const refusal = { ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('create-memory') } };

    expect(await h['update-node']!({ file_path: elsewhere, set_title: 'Memories', set_directory: 'Settings' }, asChat)).toMatchObject(refusal);
    expect(await h['update-node']!({ file_path: sameName, set_directory: 'Settings' }, asChat)).toMatchObject(refusal);
    expect(await h['update-node']!({ file_path: sameFolder, set_title: 'Memories' }, asChat)).toMatchObject(refusal);
    for (const dry_run of [true, false]) {
      expect(await h['update-node']!({ query: { title_eq: 'Memories' }, set_directory: 'Settings', dry_run }, asChat)).toMatchObject(refusal);
    }
    const batch = await h['batch-mutate']!({ operations: [{ op: 'update', params: { file_path: sameFolder, set_title: 'Memories' } }] }, asChat);
    expect(batch).toMatchObject({ ok: false, error: { code: 'BATCH_FAILED', message: expect.stringContaining('create-memory') } });

    expect(existsSync(join(vaultPath, NOTE))).toBe(false);
    for (const path of [elsewhere, sameName, sameFolder]) expect(existsSync(join(vaultPath, path)), path).toBe(true);

    // Not refused for the suite itself, so the refusals above were for the caller.
    expect((await h['update-node']!({ file_path: sameFolder, set_title: 'Memories' }, asService)).ok).toBe(true);
    expect(existsSync(join(vaultPath, NOTE))).toBe(true);
  });

  it('is not refused a rename or move anywhere else', async () => {
    const h = handlers();
    const note = await draftNote(h, 'Scratch', 'Notes');
    expect((await h['update-node']!({ file_path: note, set_title: 'Kept', set_directory: 'Archive' }, asChat)).ok).toBe(true);
    expect(existsSync(join(vaultPath, 'Archive/Kept.md'))).toBe(true);
  });
});

describe('a host\'s chat model writing the memory note', () => {
  it('is refused like a signed-in chat client, while the host\'s own calls are not', async () => {
    const before = existingNote();
    const h = handlers();
    const refusal = { ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('update-memory') } };

    expect(await h['update-node']!({ file_path: NOTE, append_body: DRAFT }, asHostsModel)).toMatchObject(refusal);
    expect(await h['update-node']!({ query: { title_eq: 'Memories' }, set_fields: { wiki_for: '[[Project Alpha]]' }, dry_run: false }, asHostsModel)).toMatchObject(refusal);
    const batch = await h['batch-mutate']!({ operations: [{ op: 'update', params: { file_path: NOTE, append_body: DRAFT } }] }, asHostsModel);
    expect(batch).toMatchObject({ ok: false, error: { code: 'BATCH_FAILED' } });
    expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toBe(before);

    expect((await h['update-node']!({ file_path: NOTE, append_body: 'From the plugin itself.' }, asService)).ok).toBe(true);
  });
});

describe('the suite\'s own callers', () => {
  it('still edit the note through update-node', async () => {
    existingNote();
    const h = handlers();
    expect((await h['update-node']!({ file_path: NOTE, append_body: 'From the plugin.' }, asService)).ok).toBe(true);
    expect((await h['update-node']!({ file_path: NOTE, append_body: 'From a local caller.' })).ok).toBe(true);
    expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toContain('From a local caller.');
  });

  it('are not refused another note, and neither is a chat client', async () => {
    const h = handlers();
    expect((await h['create-node']!({ title: 'Plan', body: 'A plan.' }, asChat)).ok).toBe(true);
    expect((await h['update-node']!({ title: 'Plan', append_body: 'More.' }, asChat)).ok).toBe(true);
  });
});
