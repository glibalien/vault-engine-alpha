// tests/sync/watcher-embed-error-logging.test.ts
//
// T0.3: the watcher no longer pumps the embedding queue itself — it just
// enqueues, and the indexer self-drains (src/search/indexer.ts). So the
// embed-error "never swallow" guarantee (originally T0.1) now lives in the
// indexer and is pinned by tests/search/indexer.test.ts ("logs embed failures
// during drain"). What remains the watcher's responsibility, and what these
// tests pin: (1) the changed node is forwarded to enqueue() and
// processFileChange does not throw, and (2) pipeline errors inside
// executeMutation on the watcher path are logged, not swallowed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { processFileChange } from '../../src/sync/watcher.js';
import type { EmbeddingIndexer } from '../../src/search/indexer.js';

describe('watcher embedding-error logging (T0.1)', () => {
  let db: Database.Database;
  let dir: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    dir = mkdtempSync(join(tmpdir(), 've-watch-log-'));
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function recordingIndexer(): { indexer: EmbeddingIndexer; calls: string[] } {
    const calls: string[] = [];
    const indexer = {
      enqueue: (item: { node_id: string }) => { calls.push(item.node_id); },
      processOne: () => Promise.resolve(false),
      drain: () => Promise.resolve(),
    } as unknown as EmbeddingIndexer;
    return { indexer, calls };
  }

  it('forwards the changed node to the embedding queue without throwing', async () => {
    const relPath = 'note.md';
    writeFileSync(join(dir, relPath), '---\n---\nhello world\n');
    const { indexer, calls } = recordingIndexer();

    expect(() =>
      processFileChange(join(dir, relPath), relPath, db, new WriteLockManager(), dir, undefined, indexer),
    ).not.toThrow();

    // Any async embedding work the indexer schedules must not surface as an
    // unhandled rejection on the watcher path.
    await new Promise((r) => setTimeout(r, 10));

    expect(calls.length).toBe(1);
  });

  it('logs pipeline errors on the watcher path instead of swallowing them', () => {
    const relPath = 'note2.md';
    writeFileSync(join(dir, relPath), '---\n---\nhello again\n');

    // Inject a failure inside executeMutation (which runs inside the try
    // block): proxy the db so its transaction() returns a throwing runner.
    const failingDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'transaction') {
          return () => () => {
            throw new Error('injected pipeline failure');
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Database.Database;

    expect(() =>
      processFileChange(join(dir, relPath), relPath, failingDb, new WriteLockManager(), dir, undefined, undefined),
    ).not.toThrow();

    const logged = errorSpy.mock.calls.some(
      (args: unknown[]) =>
        String(args[0]).includes('[watcher]') && args.some((a: unknown) => String(a).includes('injected pipeline failure')),
    );
    expect(logged).toBe(true);
  });
});
