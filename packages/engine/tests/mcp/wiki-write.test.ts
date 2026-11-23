import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { registerWikiWrite } from '../../src/mcp/tools/wiki-write.js';
import { REFERENCE_POLICY_VERSION_KEY } from '../../src/db/reference-policy-version.js';
import { setStoredSettings } from '../../src/settings/store.js';
import { DEFAULT_TYPE_KEY, setTypeKey } from '../../src/parser/type-key.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;

beforeEach(() => {
  db = createTestDb();
  const vault = createTempVault();
  vaultPath = vault.vaultPath;
  cleanup = vault.cleanup;
  seedNode('p1', 'Project.md', 'Project', ['project']);
  seedNode('t1', 'Task.md', 'Task', ['task']);
  field('t1', 'status', 'open');
  rel('t1', 'Project', 'project', 'p1');
});

afterEach(() => {
  cleanup();
});

describe('wiki-write tool', () => {
  it('refuses to write when the vault map sets the wiki page kind to none', async () => {
    setStoredSettings(db, 'vault', { wikiType: null });
    const result = parseResult(await getWriteHandler()({ project: 'Project', refresh_live: true }) as any) as any;
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('wikiType is none') } });
    expect(db.prepare("SELECT 1 FROM nodes WHERE title = 'Project Wiki'").get()).toBeUndefined();
  });

  it.each([true, false])('rejects marker-bearing content without schema, database, or file writes (dry_run=%s)', async dry_run => {
    const result = parseResult(await getWriteHandler()({
      project: 'Project', dry_run, refresh_live: false,
      sections: [{ name: 'Summary', content: '<!-- ve:managed:Summary -->nested<!-- /ve:managed:Summary -->' }],
    }) as any) as any;
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(db.prepare("SELECT 1 FROM schemas WHERE name = 'wiki'").get()).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM undo_operations').all()).toEqual([]);
    expect(db.prepare("SELECT 1 FROM nodes WHERE title = 'Project Wiki'").get()).toBeUndefined();
    expect(existsSync(`${vaultPath}/Wikis/Project Wiki.md`)).toBe(false);
  });

  it.each([true, false])('rejects padded section names before any writes (dry_run=%s)', async dry_run => {
    const result = parseResult(await getWriteHandler()({
      project: 'Project', dry_run, refresh_live: false,
      sections: [{ name: ' Summary', content: 'Narrative' }],
    }) as any) as any;
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', message: expect.stringContaining('invalid section name') } });
    expect(db.prepare("SELECT 1 FROM schemas WHERE name = 'wiki'").get()).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM undo_operations').all()).toEqual([]);
    expect(db.prepare("SELECT 1 FROM nodes WHERE title = 'Project Wiki'").get()).toBeUndefined();
    expect(existsSync(`${vaultPath}/Wikis/Project Wiki.md`)).toBe(false);
  });

  it('keeps implicit home and subpage wiki_for relationships on a stable-ID-selected duplicate-title project', async () => {
    seedNode('duplicate-project', 'P.md', 'Project', ['project']);
    const handler = getWriteHandler();

    const created = parseResult(await handler({
      project: 'p1',
      target: 'subpage',
      subpage_title: 'Project — Notes',
    }) as any) as any;

    expect(created.ok).toBe(true);
    const wikiFor = db.prepare(`
      SELECT r.target, r.resolved_target_id
      FROM relationships r
      JOIN node_types nt ON nt.node_id = r.source_id AND nt.schema_type = 'wiki'
      WHERE r.rel_type = 'wiki_for'
      ORDER BY r.source_id
    `).all() as Array<{ target: string; resolved_target_id: string | null }>;
    expect(wikiFor).toHaveLength(2);
    expect(wikiFor).toEqual([
      { target: 'Project.md', resolved_target_id: 'p1' },
      { target: 'Project.md', resolved_target_id: 'p1' },
    ]);
  });

  it('dry_run previews without bootstrapping schema', async () => {
    const handler = getWriteHandler();
    const body = parseResult(await handler({ project: 'Project', dry_run: true }) as any) as any;
    expect(body.ok).toBe(true);
    expect(body.data.dry_run).toBe(true);
    expect(body.data.narrative_status).toBe('live_only');
    expect(body.warnings.map((w: any) => w.code)).toContain('WIKI_NARRATIVE_EMPTY');
    expect(body.data.would_bootstrap.created_schemas).toEqual(['wiki']);
    expect(existsSync(`${vaultPath}/${body.data.file_path}`)).toBe(false);
    const schema = db.prepare("SELECT name FROM schemas WHERE name = 'wiki'").get();
    expect(schema).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM nodes WHERE title = 'Project Wiki'").get()).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM undo_operations').all()).toEqual([]);
  });

  it.each([
    ['types', /^---\ntypes:\n {2}- wiki\n/],
    ['kind', /^---\nkind:\n {2}- wiki\n/],
  ])('writes the page\'s types under the type key (%s, #445)', async (key, start) => {
    setTypeKey(key);
    try {
      const created = parseResult(await getWriteHandler()({ project: 'Project', sections: [{ name: 'Now', content: 'Snapshot' }] }) as any) as any;
      expect(created.ok).toBe(true);
      const text = readFileSync(`${vaultPath}/${created.data.file_path}`, 'utf8');
      expect(text).toMatch(start);
      expect(text.match(/^(types|kind):/gm)).toEqual([`${key}:`]);
    } finally {
      setTypeKey(DEFAULT_TYPE_KEY);
    }
  });

  it('dry_run rejects an existing wiki whose projected file is absent', async () => {
    const handler = getWriteHandler();
    const created = parseResult(await handler({ project: 'Project' }) as any) as any;
    expect(created.ok).toBe(true);
    const absPath = `${vaultPath}/${created.data.file_path}`;
    const beforeNode = db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(created.data.node_id);
    const beforeCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM schema_field_claims) AS schema_field_claims,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get();
    unlinkSync(absPath);

    const result = parseResult(await handler({
      project: 'Project',
      refresh_live: true,
      dry_run: true,
    }) as any) as any;

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONTENT_HASH_MISMATCH');
    expect(result.error.details.current_content_hash).toBeNull();
    expect(existsSync(absPath)).toBe(false);
    expect(db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(created.data.node_id)).toEqual(beforeNode);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM schema_field_claims) AS schema_field_claims,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
  });

  it('creates and updates a home wiki while preserving human text', async () => {
    const handler = getWriteHandler();
    const created = parseResult(await handler({
      project: 'Project',
      sections: [{ name: 'Now', content: 'Initial snapshot' }],
    }) as any) as any;
    expect(created.ok).toBe(true);
    expect(created.data.created).toBe(true);
    expect(created.data.narrative_status).toBe('managed');
    expect(created.warnings.map((w: any) => w.code)).not.toContain('WIKI_NARRATIVE_EMPTY');
    expect(created.data.title).toBe('Project Wiki');
    expect(created.data.sections_written).toContain('managed:Now');

    const current = db.prepare('SELECT body FROM nodes WHERE id = ?')
      .get(created.data.node_id) as { body: string };
    db.prepare('UPDATE nodes SET body = ? WHERE id = ?').run(
      `Human intro\n\n${current.body}`,
      created.data.node_id,
    );

    const updated = parseResult(await handler({ project: 'Project', refresh_live: true }) as any) as any;
    expect(updated.ok).toBe(true);
    expect(updated.data.created).toBe(false);
    expect(updated.warnings.map((w: any) => w.code)).not.toContain('WIKI_NARRATIVE_EMPTY');
    const row = db.prepare('SELECT body, version FROM nodes WHERE id = ?').get(created.data.node_id) as { body: string; version: number };
    expect(row.body).toContain('Human intro');
    expect(row.body).toContain('[[Task]]');
    expect(readFileSync(`${vaultPath}/${updated.data.file_path}`, 'utf8')).toContain('Human intro');
  });

  it('canonicalizes links in supplied sections but never in human text', async () => {
    seedNode('q4', 'Notes/Q4- Pricing.md', 'Q4- Pricing', ['note']);
    const handler = getWriteHandler();
    const created = parseResult(await handler({ project: 'Project', sections: [{ name: 'Now', content: 'Snapshot' }] }) as any) as any;
    const current = db.prepare('SELECT body FROM nodes WHERE id = ?').get(created.data.node_id) as { body: string };
    db.prepare('UPDATE nodes SET body = ? WHERE id = ?').run(`Human intro on [[Q4: Pricing]]\n\n${current.body}`, created.data.node_id);

    await handler({ project: 'Project', refresh_live: true });
    expect((db.prepare('SELECT body FROM nodes WHERE id = ?').get(created.data.node_id) as { body: string }).body)
      .toContain('Human intro on [[Q4: Pricing]]');

    await handler({ project: 'Project', sections: [{ name: 'Now', content: 'Waiting on [[Q4: Pricing]]' }] });
    const body = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(created.data.node_id) as { body: string }).body;
    expect(body).toContain('Human intro on [[Q4: Pricing]]');
    expect(body).toContain('Waiting on [[Q4- Pricing|Q4: Pricing]]');
  });

  it('a live-only refresh keeps the home\'s own title and extra types', async () => {
    const handler = getWriteHandler();
    const created = parseResult(await handler({ project: 'Project', sections: [{ name: 'Now', content: 'Snapshot' }] }) as any) as any;
    expect(created.ok).toBe(true);
    // A user rename moves the file; the title is the filename's.
    const hubPath = created.data.file_path.replace(/[^/]+\.md$/, 'Project Hub.md');
    renameSync(`${vaultPath}/${created.data.file_path}`, `${vaultPath}/${hubPath}`);
    db.prepare("UPDATE nodes SET title = 'Project Hub', file_path = ? WHERE id = ?").run(hubPath, created.data.node_id);
    db.prepare("INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, 'dashboard', 1)").run(created.data.node_id);
    seedNode('t2', 'Task 2.md', 'Task 2', ['task']);
    field('t2', 'status', 'open');
    rel('t2', 'Project', 'project', 'p1');

    const refreshed = parseResult(await handler({ project: 'Project', refresh_live: true }) as any) as any;
    expect(refreshed.ok).toBe(true);
    expect(refreshed.data).toMatchObject({ node_id: created.data.node_id, created: false, title: 'Project Hub' });
    expect(db.prepare('SELECT title, body FROM nodes WHERE id = ?').get(created.data.node_id))
      .toMatchObject({ title: 'Project Hub', body: expect.stringContaining('[[Task 2]]') });
    expect((db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order, schema_type')
      .all(created.data.node_id) as Array<{ schema_type: string }>).map(row => row.schema_type)).toEqual(['wiki', 'dashboard']);
  });

  it('finds a subpage again by a title its filename had to sanitize', async () => {
    const handler = getWriteHandler();
    const args = { project: 'Project', target: 'subpage', subpage_title: 'Project — Pricing: Q4', sections: [{ name: 'Now', content: 'First' }] };
    const created = parseResult(await handler(args) as any) as any;
    expect(created.data).toMatchObject({ created: true, title: 'Project — Pricing- Q4' });

    const again = parseResult(await handler({ ...args, sections: [{ name: 'Now', content: 'Second' }] }) as any) as any;
    expect(again.data).toMatchObject({ node_id: created.data.node_id, created: false });
  });

  it('create_only writes a missing page and leaves an existing one untouched', async () => {
    const handler = getWriteHandler();
    const placeholder = [{ name: 'Now', content: 'Placeholder' }];
    const created = parseResult(await handler({ project: 'Project', create_only: true, sections: placeholder }) as any) as any;
    expect(created.data).toMatchObject({ created: true });
    await handler({ project: 'Project', sections: [{ name: 'Now', content: 'Curated narrative' }] });
    const before = db.prepare('SELECT body, version FROM nodes WHERE id = ?').get(created.data.node_id) as { body: string; version: number };

    const again = parseResult(await handler({ project: 'Project', create_only: true, sections: placeholder }) as any) as any;
    expect(again).toMatchObject({ ok: true, data: { node_id: created.data.node_id, created: false, unchanged: true } });
    expect(db.prepare('SELECT body, version FROM nodes WHERE id = ?').get(created.data.node_id)).toEqual(before);
    expect(before.body).toContain('Curated narrative');
  });

  it('warns when creating a live-only wiki', async () => {
    const handler = getWriteHandler();
    const created = parseResult(await handler({ project: 'Project' }) as any) as any;
    expect(created.ok).toBe(true);
    expect(created.data.created).toBe(true);
    expect(created.data.narrative_status).toBe('live_only');
    expect(created.warnings.map((w: any) => w.code)).toContain('WIKI_NARRATIVE_EMPTY');
  });

  it('returns STALE_NODE for stale expected_version', async () => {
    const handler = getWriteHandler();
    const created = parseResult(await handler({ project: 'Project' }) as any) as any;
    // A write that changes the page: one that changes nothing succeeds whatever version it names
    // (below). This used to pass with no sections only because the new home listed itself under
    // related notes on the second write (#724).
    const stale = parseResult(await handler({ project: 'Project', expected_version: 99,
      sections: [{ name: 'Now', content: 'Changed narrative' }] }) as any) as any;
    expect(created.ok).toBe(true);
    expect(stale.ok).toBe(false);
    expect(stale.error.code).toBe('STALE_NODE');
  });

  it('rejects stale body-changing previews just like live writes without preview side effects', async () => {
    const handler = getWriteHandler();
    const created = parseResult(await handler({ project: 'Project', refresh_live: false }) as any) as any;
    const params = {
      project: 'Project', refresh_live: false, expected_version: 99,
      sections: [{ name: 'Now', content: 'Changed narrative' }],
    };
    const beforeDb = db.serialize();
    const beforeFile = readFileSync(`${vaultPath}/${created.data.file_path}`, 'utf8');
    const preview = parseResult(await handler({ ...params, dry_run: true }) as any) as any;
    expect(preview).toMatchObject({ ok: false, error: { code: 'STALE_NODE' } });
    expect(db.serialize()).toEqual(beforeDb);
    expect(readFileSync(`${vaultPath}/${created.data.file_path}`, 'utf8')).toBe(beforeFile);
    const live = parseResult(await handler(params) as any) as any;
    expect(live).toMatchObject({ ok: false, error: { code: 'STALE_NODE' } });
  });

  it('keeps true no-op previews and writes successful with a stale expected version', async () => {
    const handler = getWriteHandler();
    const params = { project: 'Project', refresh_live: false, sections: [{ name: 'Now', content: 'Stable narrative' }] };
    const created = parseResult(await handler(params) as any) as any;
    // The first update settles creation-only defaults before the byte-identical retry.
    expect((parseResult(await handler(params) as any) as any).ok).toBe(true);
    const beforeNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(created.data.node_id);
    const beforeDb = db.serialize();
    const beforeFile = readFileSync(`${vaultPath}/${created.data.file_path}`, 'utf8');
    const preview = parseResult(await handler({ ...params, expected_version: 99, dry_run: true }) as any) as any;
    expect(preview.ok).toBe(true);
    expect(db.serialize()).toEqual(beforeDb);
    const live = parseResult(await handler({ ...params, expected_version: 99 }) as any) as any;
    expect(live.ok).toBe(true);
    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get(created.data.node_id)).toEqual(beforeNode);
    expect(readFileSync(`${vaultPath}/${created.data.file_path}`, 'utf8')).toBe(beforeFile);
  });

  it('previews a true no-op using the same bootstrapped claims as live writes', async () => {
    const handler = getWriteHandler();
    const params = { project: 'Project', refresh_live: false, sections: [{ name: 'Now', content: 'Stable narrative' }] };
    const created = parseResult(await handler(params) as any) as any;
    expect((parseResult(await handler(params) as any) as any).ok).toBe(true);
    db.prepare("DELETE FROM schema_field_claims WHERE schema_name = 'wiki'").run();
    const beforeDb = db.serialize();
    const beforeNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(created.data.node_id);
    const beforeFile = readFileSync(`${vaultPath}/${created.data.file_path}`, 'utf8');

    const preview = parseResult(await handler({ ...params, expected_version: 99, dry_run: true }) as any) as any;

    expect(preview.ok).toBe(true);
    expect(preview.data.would_bootstrap.added_schema_claims).toContain('wiki_for');
    expect(db.serialize()).toEqual(beforeDb);
    expect(readFileSync(`${vaultPath}/${created.data.file_path}`, 'utf8')).toBe(beforeFile);
    const live = parseResult(await handler({ ...params, expected_version: 99 }) as any) as any;
    expect(live.ok).toBe(true);
    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get(created.data.node_id)).toEqual(beforeNode);
    expect(readFileSync(`${vaultPath}/${created.data.file_path}`, 'utf8')).toBe(beforeFile);
  });

  it.each([true, false])('rejects an occupied creation destination before any side effects (dry_run=%s)', async dry_run => {
    mkdirSync(`${vaultPath}/Wikis`, { recursive: true });
    const path = `${vaultPath}/Wikis/Project Wiki.md`;
    writeFileSync(path, 'Unindexed owner content');
    const beforeDb = db.serialize();
    const result = parseResult(await getWriteHandler()({ project: 'Project', dry_run }) as any) as any;
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(db.serialize()).toEqual(beforeDb);
    expect(readFileSync(path, 'utf8')).toBe('Unindexed owner content');
  });

  it('returns retryable missing-file state before schema, undo, or node side effects', async () => {
    const handler = getWriteHandler();
    const created = parseResult(await handler({ project: 'Project' }) as any) as any;
    expect(created.ok).toBe(true);
    const absPath = `${vaultPath}/${created.data.file_path}`;
    const beforeNode = db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(created.data.node_id);
    const beforeCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM schema_field_claims) AS schema_field_claims,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get();
    unlinkSync(absPath);

    const result = parseResult(await handler({
      project: 'Project',
      refresh_live: true,
    }) as any) as any;

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONTENT_HASH_MISMATCH');
    expect(result.error.details.current_content_hash).toBeNull();
    expect(existsSync(absPath)).toBe(false);
    expect(db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(created.data.node_id)).toEqual(beforeNode);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM schema_field_claims) AS schema_field_claims,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
  });

  it('rolls back schema bootstrap when the target disappears inside the write lock', async () => {
    const created = parseResult(await getWriteHandler()({ project: 'Project' }) as any) as any;
    expect(created.ok).toBe(true);
    const absPath = `${vaultPath}/${created.data.file_path}`;
    db.prepare("DELETE FROM schemas WHERE name = 'wiki'").run();
    const beforeNode = db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(created.data.node_id);
    const beforeCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM schema_field_claims) AS schema_field_claims,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get();

    class DeleteOnLock extends WriteLockManager {
      private deleted = false;

      override withLockSync<T>(filePath: string, fn: () => T): T {
        if (!this.deleted && filePath === absPath) {
          this.deleted = true;
          unlinkSync(filePath);
        }
        return super.withLockSync(filePath, fn);
      }
    }

    // A write that changes the page (see the STALE_NODE test above, #724).
    const result = parseResult(await getWriteHandler(new DeleteOnLock())({
      project: 'Project',
      refresh_live: true,
      sections: [{ name: 'Now', content: 'Changed narrative' }],
    }) as any) as any;

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONTENT_HASH_MISMATCH');
    expect(result.error.details.current_content_hash).toBeNull();
    expect(existsSync(absPath)).toBe(false);
    expect(db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(created.data.node_id)).toEqual(beforeNode);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM schema_field_claims) AS schema_field_claims,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
  });

  it('does not replay filesystem rollback after a post-commit embedding failure', async () => {
    const result = parseResult(await getWriteHandler(
      new WriteLockManager({ recentWriteTtlMs: 1 }),
      { enqueue: () => { throw new Error('index unavailable'); } } as any,
    )({ project: 'Project' }) as any) as any;

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INTERNAL_ERROR');
    const wiki = db.prepare("SELECT id, file_path FROM nodes WHERE title = 'Project Wiki'")
      .get() as { id: string; file_path: string } | undefined;
    expect(wiki).toBeDefined();
    expect(existsSync(`${vaultPath}/${wiki!.file_path}`)).toBe(true);
  });
});

describe.each([1, 2])('topic wiki on reference policy v%i', policy => {
  beforeEach(() => {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(REFERENCE_POLICY_VERSION_KEY, String(policy));
    seedNode('topic1', 'Topics/Owls.md', 'Owls', ['topic']);
  });

  it('binds wiki_for to the topic root and finds the home again', async () => {
    const handler = getWriteHandler();
    const sections = [{ name: 'Now', content: 'Owls summary' }];

    const home = parseResult(await handler({ project: 'topic1', sections }) as any) as any;
    expect(home).toMatchObject({ ok: true, data: { created: true } });
    const subpage = parseResult(await handler({
      project: 'topic1', target: 'subpage', subpage_title: 'Owls — Notes', sections,
    }) as any) as any;
    expect(subpage).toMatchObject({ ok: true, data: { created: true } });

    const bindings = db.prepare(`
      SELECT source_id, rel_type, target, resolved_target_id FROM relationships
      WHERE source_id IN (?, ?) AND rel_type IN ('wiki_for', 'wiki_parent')
      ORDER BY source_id = ? DESC, rel_type
    `).all(home.data.node_id, subpage.data.node_id, home.data.node_id);
    expect(bindings).toEqual([
      { source_id: home.data.node_id, rel_type: 'wiki_for', target: 'Topics/Owls.md', resolved_target_id: 'topic1' },
      { source_id: subpage.data.node_id, rel_type: 'wiki_for', target: 'Topics/Owls.md', resolved_target_id: 'topic1' },
      { source_id: subpage.data.node_id, rel_type: 'wiki_parent', target: 'Owls Wiki', resolved_target_id: home.data.node_id },
    ]);

    const again = parseResult(await handler({ project: 'topic1', sections }) as any) as any;
    expect(again).toMatchObject({ ok: true, data: { node_id: home.data.node_id, created: false } });
  });
});


function getWriteHandler(
  writeLock = new WriteLockManager({ recentWriteTtlMs: 1 }),
  embeddingIndexer?: Parameters<typeof registerWikiWrite>[5],
) {
  let capturedHandler: (args: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedHandler = (args) => handler(args);
    },
  } as unknown as McpServer;
  registerWikiWrite(fakeServer, db, writeLock, vaultPath, undefined, embeddingIndexer);
  return capturedHandler!;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

function seedNode(id: string, path: string, title: string, types: string[]): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, path, title, '', id, Date.now(), Date.now());
  for (const type of types) db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, type);
}

function field(nodeId: string, name: string, value: string): void {
  db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)')
    .run(nodeId, name, value, 'frontmatter');
}

function rel(source: string, target: string, type: string, resolved: string): void {
  db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)')
    .run(source, target, type, null, resolved);
}
