import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { setStoredSettings } from '../../src/settings/store.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

interface BatchResponse {
  ok: boolean;
  data?: {
    results: Array<{ file_path: string; node_id?: string }>;
    [k: string]: unknown;
  };
  error?: { code: string; message: string; details?: Record<string, unknown> };
  warnings: Array<{ code: string; message: string; severity?: string; details?: unknown; op_index?: number }>;
}

function parseResult(result: unknown): BatchResponse {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as BatchResponse;
}

function getHandler(register: typeof registerBatchMutate = registerBatchMutate) {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  register(fakeServer, db, writeLock, vaultPath);
  return captured!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  writeLock = new WriteLockManager();

  createSchemaDefinition(db, { name: 'bare', field_claims: [] });
  // A schema whose filename derives from {date}-{title}.
  createSchemaDefinition(db, { name: 'dated', filename_template: '{date}-{title}.md', field_claims: [] });
  // A schema referencing a field var that must be supplied to resolve.
  createSchemaDefinition(db, { name: 'tmpl', filename_template: '{slug}.md', field_claims: [] });
});

afterEach(() => { vi.useRealTimers(); db.close(); cleanup(); });

/** 23:30 on 9 March in New York, already 10 March in UTC. */
function pinNewYorkEvening(): void {
  setStoredSettings(db, 'curator', { tz: 'America/New_York' });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-10T03:30:00Z'));
}

describe('batch-mutate create honors filename_template (t3)', () => {
  it('applies the schema filename_template instead of `${title}.md`, {date} in the tz setting (#497)', async () => {
    pinNewYorkEvening();
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Standup', types: ['dated'] } }],
    }));
    expect(result.ok).toBe(true);
    expect(result.data?.results[0].file_path).toBe('2026-03-09-Standup.md');
    expect(existsSync(join(vaultPath, '2026-03-09-Standup.md'))).toBe(true);
  });

  it('create-node expands {date} the same way (#497)', async () => {
    pinNewYorkEvening();
    const handler = getHandler(registerCreateNode);
    const result = parseResult(await handler({ title: 'Standup', types: ['dated'] })) as unknown as {
      ok: boolean; data?: { file_path: string; title: string };
    };
    expect(result.ok).toBe(true);
    expect(result.data?.file_path).toBe('2026-03-09-Standup.md');
    expect(result.data?.title).toBe('2026-03-09-Standup');
    expect(existsSync(join(vaultPath, '2026-03-09-Standup.md'))).toBe(true);
  });

  it('resolves template variables from fields', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Ignored', types: ['tmpl'], fields: { slug: 'my-slug' } } }],
    }));
    expect(result.ok).toBe(true);
    expect(result.data?.results[0].file_path).toBe('my-slug.md');
  });

  it('fails the batch when a template variable is unresolved', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'NoSlug', types: ['tmpl'] } }],
    }));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('BATCH_FAILED');
    expect(result.error?.message).toMatch(/unresolved variables/i);
  });
});

describe('batch-mutate tags warnings with op_index (t4)', () => {
  it('attributes a sanitization warning to the originating op', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [
        { op: 'create', params: { title: 'Clean', types: ['bare'] } },
        { op: 'create', params: { title: 'a/b', types: ['bare'] } }, // op index 1 sanitizes
      ],
    }));
    expect(result.ok).toBe(true);
    const sanitized = result.warnings.find(w => w.code === 'TITLE_FILENAME_SANITIZED');
    expect(sanitized).toBeDefined();
    expect(sanitized!.op_index).toBe(1);
  });

  it('tags the deprecated path-param warning with its op index', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [
        { op: 'create', params: { title: 'First', types: ['bare'] } },
        { op: 'create', params: { title: 'Second', types: ['bare'], path: 'Subdir' } }, // op index 1
      ],
    }));
    expect(result.ok).toBe(true);
    const deprecated = result.warnings.find(w => w.code === 'DEPRECATED_PARAM');
    expect(deprecated).toBeDefined();
    expect(deprecated!.op_index).toBe(1);
  });
});
