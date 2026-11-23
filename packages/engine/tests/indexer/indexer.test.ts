import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { unlinkSync, writeFileSync, utimesSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex, indexFile, sha256, shouldIgnore, setExcludeDirs } from '../../src/indexer/index.js';
import { shouldIgnoreBuiltIn } from '../../src/indexer/ignore.js';
import { indexProgressLog } from '../../src/indexer/indexer.js';
import { addFileToVault, createTempVault } from '../helpers/vault.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

afterEach(() => {
  db.close();
  cleanup();
});

function snapshotIndexedNode(filePath: string, ftsTerm: string) {
  const node = db.prepare('SELECT * FROM nodes WHERE file_path = ?').get(filePath) as
    | Record<string, unknown>
    | undefined;
  if (!node) throw new Error(`Missing indexed node: ${filePath}`);
  const nodeId = node.id as string;
  return {
    node,
    explicitNullFields: db.prepare(
      'SELECT * FROM node_explicit_null_fields WHERE node_id = ? ORDER BY field_name',
    ).all(nodeId),
    types: db.prepare(
      'SELECT * FROM node_types WHERE node_id = ? ORDER BY sort_order, schema_type',
    ).all(nodeId),
    fields: db.prepare(
      'SELECT * FROM node_fields WHERE node_id = ? ORDER BY field_name',
    ).all(nodeId),
    relationships: db.prepare(
      'SELECT * FROM relationships WHERE source_id = ? ORDER BY id',
    ).all(nodeId),
    ftsRows: db.prepare(
      'SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?',
    ).all(ftsTerm),
    editLog: db.prepare(
      'SELECT node_id, timestamp, event_type, details FROM edits_log WHERE node_id = ? ORDER BY id',
    ).all(nodeId),
  };
}

/**
 * Makes indexing fail at a note's second type, after its node row is written. A type held
 * twice did this until #482; Engine now reads it as one type.
 */
function failIndexingAtType(type: string): void {
  db.exec(`CREATE TRIGGER fail_type_insert BEFORE INSERT ON node_types WHEN NEW.schema_type = '${type}'
    BEGIN SELECT RAISE(ABORT, 'type insert refused'); END`);
}

// ── sha256 ──────────────────────────────────────────────────────────

describe('sha256', () => {
  it('produces a 64-char hex string', () => {
    const hash = sha256('hello');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    expect(sha256('test')).toBe(sha256('test'));
  });
});

// ── shouldIgnore ────────────────────────────────────────────────────

describe('shouldIgnore', () => {
  it('accepts native-separator Markdown paths across platforms', () => {
    expect(shouldIgnore('note.md')).toBe(false);
    expect(shouldIgnore(join('folder', 'note.md'))).toBe(false);
  });

  it('ignores non-.md files', () => {
    expect(shouldIgnore('image.png')).toBe(true);
    expect(shouldIgnore('data.json')).toBe(true);
  });

  it('ignores dotfiles and dot-directories', () => {
    expect(shouldIgnore('.hidden.md')).toBe(true);
    expect(shouldIgnore(join('.obsidian', 'config.md'))).toBe(true);
  });

  it('keeps a POSIX filename containing a backslash as one legal path segment', () => {
    if (process.platform === 'win32') return;
    expect(shouldIgnore('notes\\.hidden.md')).toBe(false);
  });

  it('excludes nested hidden entries when given Analyzer slash-normalized paths', () => {
    expect(shouldIgnoreBuiltIn('notes/.hidden/note.md', {
      allowNonMarkdown: true,
      pathStyle: 'posix',
    })).toBe(true);
  });

  it('ignores .sync-conflict files', () => {
    expect(shouldIgnore('.sync-conflict-20260410.md')).toBe(true);
  });

  it('ignores known directories', () => {
    expect(shouldIgnore(join('.vault-engine', 'cache.md'))).toBe(true);
    expect(shouldIgnore(join('node_modules', 'pkg', 'readme.md'))).toBe(true);
    expect(shouldIgnore(join('.git', 'hooks', 'readme.md'))).toBe(true);
  });

  it('ignores custom excluded directories', () => {
    setExcludeDirs(['Templates', 'Archive/Old']);
    try {
      expect(shouldIgnore(join('Templates', 'Meeting Template.md'))).toBe(true);
      expect(shouldIgnore(join('Templates', 'sub', 'nested.md'))).toBe(true);
      expect(shouldIgnore(join('Archive', 'Old', 'legacy.md'))).toBe(true);
      // Non-excluded paths still allowed
      expect(shouldIgnore(join('Archive', 'New', 'note.md'))).toBe(false);
      expect(shouldIgnore(join('Notes', 'note.md'))).toBe(false);
      // Segment-based: "Templates" shouldn't match "MyTemplates"
      expect(shouldIgnore(join('MyTemplates', 'file.md'))).toBe(false);
    } finally {
      setExcludeDirs([]);
    }
  });

  // allowNonMarkdown opt-in (unlink handler for transcript retention)
  it('ignores non-.md files by default but lets them through with allowNonMarkdown', () => {
    expect(shouldIgnore(join('Attachments', 'rec.mp3'))).toBe(true);
    expect(shouldIgnore(join('Attachments', 'rec.mp3'), { allowNonMarkdown: true })).toBe(false);
  });

  it('still ignores dot-directories even with allowNonMarkdown', () => {
    expect(shouldIgnore(join('.vault-engine', 'x.mp3'), { allowNonMarkdown: true })).toBe(true);
  });

  it('still allows markdown with allowNonMarkdown (unchanged)', () => {
    expect(shouldIgnore(join('notes', 'page.md'))).toBe(false);
    expect(shouldIgnore(join('notes', 'page.md'), { allowNonMarkdown: true })).toBe(false);
  });

  it('still ignores custom-excluded dirs even with allowNonMarkdown', () => {
    setExcludeDirs(['Templates']);
    try {
      expect(shouldIgnore(join('Templates', 'a.mp3'), { allowNonMarkdown: true })).toBe(true);
    } finally {
      setExcludeDirs([]);
    }
  });
});

// ── fullIndex ───────────────────────────────────────────────────────

describe('fullIndex', () => {
  it('indexes all 13 fixture files', () => {
    const stats = fullIndex(vaultPath, db);
    expect(stats.indexed).toBe(13);
    expect(stats.errors).toBe(0);

    const count = db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number };
    expect(count.c).toBe(13);
  });

  it('preserves node IDs on re-index', () => {
    fullIndex(vaultPath, db);
    const idsBefore = (db.prepare('SELECT id, file_path FROM nodes ORDER BY file_path').all() as { id: string; file_path: string }[]);

    // Touch all files to force mtime change, then re-index
    for (const row of idsBefore) {
      const absPath = join(vaultPath, row.file_path);
      const future = new Date(Date.now() + 5000);
      utimesSync(absPath, future, future);
    }

    fullIndex(vaultPath, db);
    const idsAfter = (db.prepare('SELECT id, file_path FROM nodes ORDER BY file_path').all() as { id: string; file_path: string }[]);

    expect(idsAfter.length).toBe(idsBefore.length);
    for (let i = 0; i < idsBefore.length; i++) {
      expect(idsAfter[i].id).toBe(idsBefore[i].id);
      expect(idsAfter[i].file_path).toBe(idsBefore[i].file_path);
    }
  });

  it('stores types in node_types', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'multi-type.md'").get() as { id: string };
    const types = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY schema_type').all(node.id) as { schema_type: string }[];
    expect(types.map(t => t.schema_type)).toEqual(['meeting', 'note']);
  });

  it('stores string fields in value_text', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'frontmatter-wikilinks.md'").get() as { id: string };
    const field = db.prepare("SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = 'company'").get(node.id) as { value_text: string };
    expect(field.value_text).toBe('Acme Corp');
  });

  it('stores numeric fields in value_number', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'multi-type.md'").get() as { id: string };
    const field = db.prepare("SELECT value_number FROM node_fields WHERE node_id = ? AND field_name = 'priority'").get(node.id) as { value_number: number };
    expect(field.value_number).toBe(1);
  });

  it('stores relationships with correct rel_types', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'multi-type.md'").get() as { id: string };
    const rels = db.prepare('SELECT target, rel_type FROM relationships WHERE source_id = ? ORDER BY target').all(node.id) as { target: string; rel_type: string }[];
    expect(rels.length).toBeGreaterThan(0);

    // Body wiki-link to SQLite should have rel_type 'wiki-link'
    const sqliteRel = rels.find(r => r.target === 'SQLite');
    expect(sqliteRel).toBeDefined();
    expect(sqliteRel!.rel_type).toBe('wiki-link');
  });

  it('stores frontmatter references with field name as rel_type', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'multi-type.md'").get() as { id: string };
    const rels = db.prepare('SELECT target, rel_type FROM relationships WHERE source_id = ?').all(node.id) as { target: string; rel_type: string }[];

    // project field link → rel_type should be 'project'
    const projectRel = rels.find(r => r.target === 'Vault Engine');
    expect(projectRel).toBeDefined();
    expect(projectRel!.rel_type).toBe('project');
  });

  it('detects deleted files on re-index', () => {
    fullIndex(vaultPath, db);
    const countBefore = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    expect(countBefore).toBe(13);

    // Delete a file from disk
    unlinkSync(join(vaultPath, 'plain-no-frontmatter.md'));

    const stats = fullIndex(vaultPath, db);
    expect(stats.deleted).toBe(1);

    const countAfter = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    expect(countAfter).toBe(12);
  });

  it('skips unchanged files on re-index', () => {
    fullIndex(vaultPath, db);

    const nodesBefore = db.prepare('SELECT id, indexed_at FROM nodes ORDER BY id').all() as { id: string; indexed_at: number }[];

    // Re-index without changes — all should be skipped (same mtime)
    const stats = fullIndex(vaultPath, db);
    expect(stats.skipped).toBe(13);
    expect(stats.indexed).toBe(0);

    const nodesAfter = db.prepare('SELECT id, indexed_at FROM nodes ORDER BY id').all() as { id: string; indexed_at: number }[];
    for (let i = 0; i < nodesBefore.length; i++) {
      expect(nodesAfter[i].indexed_at).toBe(nodesBefore[i].indexed_at);
    }
  });

  it('writes edits_log entries for file-indexed events', () => {
    fullIndex(vaultPath, db);
    const logs = db.prepare("SELECT COUNT(*) as c FROM edits_log WHERE event_type = 'file-indexed'").get() as { c: number };
    expect(logs.c).toBe(13);
  });

  it('populates FTS5 index', () => {
    fullIndex(vaultPath, db);
    // Search for a term we know exists in multi-type.md body
    const results = db.prepare("SELECT COUNT(*) as c FROM nodes_fts WHERE nodes_fts MATCH 'SQLite'").get() as { c: number };
    expect(results.c).toBeGreaterThan(0);
  });

  it('populates value_raw_text for fields containing wiki-links', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'frontmatter-wikilinks.md'").get() as { id: string };

    // project: "[[Vault Engine]]" — single string with wiki-link
    const projectField = db.prepare(
      'SELECT value_text, value_raw_text FROM node_fields WHERE node_id = ? AND field_name = ?'
    ).get(node.id, 'project') as { value_text: string; value_raw_text: string | null };
    expect(projectField.value_text).toBe('Vault Engine'); // stripped
    expect(projectField.value_raw_text).toBe('[[Vault Engine]]');

    // people: ["[[Alice]]", "[[Bob]]"] — array with wiki-links
    const peopleField = db.prepare(
      'SELECT value_json, value_raw_text FROM node_fields WHERE node_id = ? AND field_name = ?'
    ).get(node.id, 'people') as { value_json: string; value_raw_text: string | null };
    expect(JSON.parse(peopleField.value_json)).toEqual(['Alice', 'Bob']); // stripped
    expect(peopleField.value_raw_text).not.toBeNull();
    const rawPeople = JSON.parse(peopleField.value_raw_text!);
    expect(rawPeople).toEqual(['[[Alice]]', '[[Bob]]']);
  });

  it('value_raw_text is null for fields without wiki-links', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'multi-type.md'").get() as { id: string };

    // status should be a plain string without wiki-links
    const field = db.prepare(
      'SELECT value_raw_text FROM node_fields WHERE node_id = ? AND field_name = ?'
    ).get(node.id, 'status') as { value_raw_text: string | null } | undefined;
    if (field) {
      expect(field.value_raw_text).toBeNull();
    }
  });

  it('handles malformed YAML without crashing', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT title FROM nodes WHERE file_path = 'malformed-yaml.md'").get() as { title: string };
    // Should fall back to filename-based title
    expect(node.title).toBe('malformed-yaml');
  });

  it('rolls back every row for a failed fullIndex update', () => {
    const filePath = 'rollback-existing.md';
    addFileToVault(
      vaultPath,
      filePath,
      '---\ntypes: [note]\ncontext:\nstatus: active\nproject: "[[Old Target]]"\n---\nRollbackOriginalToken\n',
    );
    expect(fullIndex(vaultPath, db).errors).toBe(0);
    const before = snapshotIndexedNode(filePath, 'RollbackOriginalToken');
    expect(before.explicitNullFields).toEqual([
      { node_id: before.node.id, field_name: 'context' },
    ]);
    expect(before.types).toEqual([
      { node_id: before.node.id, schema_type: 'note', sort_order: 0 },
    ]);
    expect(before.fields).toHaveLength(2);
    expect(before.fields.map(field => (field as { field_name: string }).field_name))
      .toEqual(['project', 'status']);
    expect(before.relationships).toHaveLength(1);
    expect(before.relationships[0]).toMatchObject({
      source_id: before.node.id,
      target: 'Old Target',
      rel_type: 'project',
    });
    expect(before.ftsRows).toHaveLength(1);
    expect(before.editLog).toHaveLength(1);

    failIndexingAtType('broken');
    writeFileSync(
      join(vaultPath, filePath),
      '---\ntypes: [task, broken]\ncontext: project scope\nstatus:\nproject: "[[New Target]]"\n---\nRollbackCorruptToken\n',
      'utf-8',
    );
    const future = new Date(Date.now() + 5000);
    utimesSync(join(vaultPath, filePath), future, future);
    const indexedNodeIds: string[] = [];

    const stats = fullIndex(vaultPath, db, {
      onNodeIndexed: (nodeId) => indexedNodeIds.push(nodeId),
    });

    expect(stats.errors).toBe(1);
    expect(stats.indexed).toBe(0);
    expect(indexedNodeIds).toEqual([]);
    expect(snapshotIndexedNode(filePath, 'RollbackOriginalToken')).toEqual(before);
    expect(db.prepare(
      'SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?',
    ).all('RollbackCorruptToken')).toEqual([]);
    expect(db.prepare(
      "SELECT details FROM edits_log WHERE event_type = 'index-error' AND details LIKE ?",
    ).all(`${filePath}:%`)).toHaveLength(1);
  });

  it('rolls back a failed fullIndex addition and continues the batch', () => {
    fullIndex(vaultPath, db);
    const nodesBefore = (db.prepare('SELECT COUNT(*) AS count FROM nodes').get() as { count: number }).count;
    failIndexingAtType('broken');
    addFileToVault(
      vaultPath,
      'rollback-addition.md',
      '---\ntypes: [task, broken]\ncontext:\n---\nFailedAdditionToken\n',
    );
    addFileToVault(
      vaultPath,
      'successful-addition.md',
      '---\ntypes: [note]\n---\nSuccessfulAdditionToken\n',
    );
    const indexedNodeIds: string[] = [];

    const stats = fullIndex(vaultPath, db, {
      onNodeIndexed: (nodeId) => indexedNodeIds.push(nodeId),
    });

    expect(stats.errors).toBe(1);
    expect(stats.indexed).toBe(1);
    expect(db.prepare("SELECT * FROM nodes WHERE file_path = 'rollback-addition.md'").get())
      .toBeUndefined();
    expect(db.prepare("SELECT body FROM nodes WHERE file_path = 'successful-addition.md'").get())
      .toEqual({ body: 'SuccessfulAdditionToken\n' });
    expect((db.prepare('SELECT COUNT(*) AS count FROM nodes').get() as { count: number }).count)
      .toBe(nodesBefore + 1);
    expect(db.prepare(
      'SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?',
    ).all('FailedAdditionToken')).toEqual([]);
    expect(db.prepare(
      "SELECT details FROM edits_log WHERE event_type = 'index-error' AND details LIKE ?",
    ).all('rollback-addition.md:%')).toHaveLength(1);
    expect(indexedNodeIds).toHaveLength(1);
  });

  it('reports progress after each batch of 100 notes', () => {
    for (let i = 0; i < 237; i++) addFileToVault(vaultPath, `bulk/note-${i}.md`, `# Note ${i}\n`);
    const progress: Array<[number, number]> = [];

    fullIndex(vaultPath, db, { onProgress: (done, total) => progress.push([done, total]) });

    expect(progress).toEqual([[100, 250], [200, 250], [250, 250]]);
  });
});

describe('indexProgressLog', () => {
  it('logs at most once per interval and never for the last batch', () => {
    let clock = 0;
    const lines: string[] = [];
    const report = indexProgressLog(line => lines.push(line), 5_000, () => clock);

    clock = 4_999;
    report(100, 900);
    clock = 5_000;
    report(200, 900);
    clock = 9_000;
    report(300, 900);
    clock = 10_000;
    report(400, 900);
    clock = 20_000;
    report(900, 900);

    expect(lines).toEqual(['Indexing: 200 of 900 notes', 'Indexing: 400 of 900 notes']);
  });
});

// ── indexFile ────────────────────────────────────────────────────────

describe('indexFile', () => {
  it('indexes a single file', () => {
    const absPath = join(vaultPath, 'multi-type.md');
    const nodeId = indexFile(absPath, vaultPath, db);
    expect(nodeId).toBeTruthy();
    expect(typeof nodeId).toBe('string');

    const count = db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('re-indexes preserving ID', () => {
    const absPath = join(vaultPath, 'multi-type.md');
    const id1 = indexFile(absPath, vaultPath, db);

    // Modify the file and re-index
    writeFileSync(absPath, '---\ntitle: Updated\ntypes:\n  - meeting\n---\nNew body.\n', 'utf-8');
    const id2 = indexFile(absPath, vaultPath, db);

    expect(id2).toBe(id1);

    const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get(id1) as { title: string };
    expect(node.title).toBe('multi-type');
  });

  it('keeps direct indexFile updates atomic when indexing fails', () => {
    const filePath = 'rollback-index-file.md';
    const absPath = join(vaultPath, filePath);
    addFileToVault(
      vaultPath,
      filePath,
      '---\ntypes: [note]\ncontext:\nstatus: active\nproject: "[[Old Target]]"\n---\nDirectOriginalToken\n',
    );
    indexFile(absPath, vaultPath, db);
    const before = snapshotIndexedNode(filePath, 'DirectOriginalToken');
    failIndexingAtType('broken');
    writeFileSync(
      absPath,
      '---\ntypes: [task, broken]\ncontext: project scope\nstatus:\nproject: "[[New Target]]"\n---\nDirectCorruptToken\n',
      'utf-8',
    );
    const indexedNodeIds: string[] = [];

    expect(() => indexFile(absPath, vaultPath, db, {
      onNodeIndexed: (nodeId) => indexedNodeIds.push(nodeId),
    })).toThrow(/type insert refused/);

    expect(indexedNodeIds).toEqual([]);
    expect(snapshotIndexedNode(filePath, 'DirectOriginalToken')).toEqual(before);
    expect(db.prepare(
      'SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?',
    ).all('DirectCorruptToken')).toEqual([]);
  });
});
