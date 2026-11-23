// The watcher's parse-error fallback creates a minimal node via indexFile,
// which bypasses executeMutation's refreshOnCreate. Pre-existing unresolved
// edges pointing at the new file must still be re-resolved — otherwise the
// node becomes a permanent straggler (2026-06-12 triage, Cause C).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { processFileChange } from '../../src/sync/watcher.js';

describe('watcher parse-error fallback resolves inbound pending edges', () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    dir = mkdtempSync(join(tmpdir(), 've-watch-fallback-'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a pre-existing NULL edge targeting a new file created with broken YAML', () => {
    db.prepare(
      'INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)'
    ).run('src1', 'writer.md', 'Writer');
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, NULL)'
    ).run('src1', 'Broken Note', 'wiki-link');

    // Unclosed flow sequence → YAML parse error → fallback indexFile path.
    writeFileSync(join(dir, 'Broken Note.md'), '---\ntypes: [unclosed\n---\nbody text\n');
    processFileChange(join(dir, 'Broken Note.md'), 'Broken Note.md', db, new WriteLockManager(), dir);

    const created = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get('Broken Note.md') as { id: string } | undefined;
    expect(created).toBeDefined();

    const edge = db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ? AND target = ?'
    ).get('src1', 'Broken Note') as { resolved_target_id: string | null };
    expect(edge.resolved_target_id).toBe(created!.id);
  });
});
