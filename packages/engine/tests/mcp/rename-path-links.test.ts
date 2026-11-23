// A link written as a vault path in a frontmatter field no schema claims follows its note when
// the note moves or is renamed, as body links and typed references do (#590). Before, only a
// field value equal to the old title was rewritten, so after a move these links named a path
// that no longer existed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { restoreOperation } from '../../src/undo/restore.js';

let db: Database.Database;
let vaultPath: string;
let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-engine-path-links-'));
  writeLock = new WriteLockManager();
});

afterEach(() => {
  db.close();
  rmSync(vaultPath, { recursive: true, force: true });
});

function setPolicy(version: 1 | 2) {
  db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', ?)").run(String(version));
  createSchemaDefinition(db, { name: 'project', field_claims: [] });
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
}

function write(relPath: string, content: string) {
  mkdirSync(dirname(join(vaultPath, relPath)), { recursive: true });
  writeFileSync(join(vaultPath, relPath), content);
}

function read(relPath: string) {
  return readFileSync(join(vaultPath, relPath), 'utf8');
}

async function updateNode(args: Record<string, unknown>) {
  let handler!: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
  const server = { tool: (_name: string, _description: string, _schema: unknown, fn: typeof handler) => { handler = fn; } } as unknown as McpServer;
  registerUpdateNode(server, db, writeLock, vaultPath);
  return JSON.parse((await handler(args, {})).content[0].text);
}

function nodeId(filePath: string) {
  return (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(filePath) as { id: string }).id;
}

/** Project Alpha, and a note linking to it from unclaimed fields in each written form. */
function seed() {
  write('Projects/Project Alpha.md', '---\ntypes:\n  - project\n---\nThe plan for Acme.\n');
  write('Notes/Kickoff.md', '---\ntypes:\n  - note\n'
    + 'related:\n  - "[[Projects/Project Alpha.md]]"\n  - "[[Northwind]]"\n'
    + 'source: "[[Projects/Project Alpha.md]]"\n'
    + 'see: "[[Project Alpha]]"\n'
    + 'topics:\n  - "[[Projects/Project Alpha.md]]"\n  - "Discuss [[Northwind|the customer]] and [[Acme]]"\n'
    + '---\nMet about [[Project Alpha]] and [[Projects/Project Alpha.md|the plan]].\n');
  write('Northwind.md', '---\ntypes:\n  - note\n---\nA customer.\n');
  fullIndex(vaultPath, db);
  return nodeId('Projects/Project Alpha.md');
}

function linksFromKickoff(targetId: string) {
  return db.prepare('SELECT target FROM relationships WHERE source_id = ? AND resolved_target_id = ? ORDER BY target')
    .all(nodeId('Notes/Kickoff.md'), targetId).map(row => (row as { target: string }).target);
}

describe.each([1, 2] as const)('reference policy %i', policy => {
  it('a move rewrites path-form links in unclaimed fields to the new path', async () => {
    setPolicy(policy);
    const target = seed();

    const result = await updateNode({ node_id: target, set_directory: 'Archive' });

    expect(result.ok).toBe(true);
    const text = read('Notes/Kickoff.md');
    expect(text).toContain('  - "[[Archive/Project Alpha.md]]"\n  - "[[Northwind]]"\n');
    expect(text).toContain('source: "[[Archive/Project Alpha.md]]"\n');
    // A bare title still names the note after a move, so it is left as written.
    expect(text).toContain('see: "[[Project Alpha]]"\n');
    // An item that is more than one link keeps its text, aliases included (#591 review).
    expect(text).toContain('topics:\n  - "[[Archive/Project Alpha.md]]"\n');
    expect(text).toContain('  - Discuss [[Northwind|the customer]] and [[Acme]]\n');
    expect(text).not.toContain('Projects/Project Alpha');
    // A body link written as the path keeps the folder too; a bare title link is left as written.
    expect(text).toContain('Met about [[Project Alpha]] and [[Archive/Project Alpha.md|the plan]].');
    // Every link is still bound to the moved note.
    expect(linksFromKickoff(target)).toEqual(['Archive/Project Alpha.md', 'Archive/Project Alpha.md', 'Archive/Project Alpha.md', 'Archive/Project Alpha.md', 'Project Alpha', 'Project Alpha']);
  });

  it('a bulk move (query mode) does the same', async () => {
    setPolicy(policy);
    const target = seed();

    const before = read('Notes/Kickoff.md');

    const result = await updateNode({ query: { types: ['project'] }, set_directory: 'Archive', dry_run: false });

    expect(result.ok).toBe(true);
    const text = read('Notes/Kickoff.md');
    expect(text).toContain('  - "[[Archive/Project Alpha.md]]"\n');
    expect(text).toContain('source: "[[Archive/Project Alpha.md]]"\n');
    expect(text).not.toContain('Projects/Project Alpha');
    expect(linksFromKickoff(target)).toHaveLength(6);

    // The move and every rewrite are one undoable operation.
    const operations = db.prepare('SELECT operation_id FROM undo_operations').all() as Array<{ operation_id: string }>;
    expect(operations).toHaveLength(1);
    restoreOperation(db, writeLock, vaultPath, operations[0].operation_id, new Set([operations[0].operation_id]));
    // Same frontmatter and body; the renderer may drop optional quotes, as on any tool write.
    const [, restoredYaml, restoredBody] = read('Notes/Kickoff.md').split('---\n');
    const [, beforeYaml, beforeBody] = before.split('---\n');
    expect(parseYaml(restoredYaml)).toEqual(parseYaml(beforeYaml));
    expect(restoredBody).toBe(beforeBody);
    expect(db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(target)).toEqual({ file_path: 'Projects/Project Alpha.md' });
  });

  it('a body link written as a path keeps naming the moved note when another note shares its name', async () => {
    setPolicy(policy);
    write('Projects/Alpha.md', '---\ntypes:\n  - project\n---\nThe project.\n');
    write('Archive/Alpha.md', '---\ntypes:\n  - note\n---\nAn older note of the same name.\n');
    write('Notes/Status.md', '---\ntypes:\n  - note\n---\nTracking [[Projects/Alpha.md|the project]].\n');
    fullIndex(vaultPath, db);
    const project = nodeId('Projects/Alpha.md');

    const result = await updateNode({ query: { types: ['project'] }, set_directory: 'Active', dry_run: false });

    expect(result.ok).toBe(true);
    expect(read('Notes/Status.md')).toContain('Tracking [[Active/Alpha.md|the project]].');
    const bound = db.prepare('SELECT resolved_target_id FROM relationships WHERE source_id = ? AND rel_type = ?')
      .get(nodeId('Notes/Status.md'), 'wiki-link') as { resolved_target_id: string };
    expect(bound.resolved_target_id).toBe(project);
  });

  it('moving a note from the vault root leaves its bare-title links as written', async () => {
    setPolicy(policy);
    write('Alpha.md', '---\ntypes:\n  - project\n---\nAt the root.\n');
    write('Notes/Status.md', '---\ntypes:\n  - note\nsee: "[[Alpha]]"\nrelated:\n  - "[[Alpha.md]]"\n---\nTracking [[Alpha]] and [[Alpha|the project]].\n');
    fullIndex(vaultPath, db);
    const project = nodeId('Alpha.md');

    const result = await updateNode({ node_id: project, set_directory: 'Archive' });

    expect(result.ok).toBe(true);
    const text = read('Notes/Status.md');
    // "Alpha" names the note by title, not by a path to carry into the folder.
    expect(text).toContain('Tracking [[Alpha]] and [[Alpha|the project]].');
    expect(text).toContain('see: "[[Alpha]]"\n');
    // Written with ".md", it is a path, and follows.
    expect(text).toContain('  - "[[Archive/Alpha.md]]"\n');
    const unbound = db.prepare('SELECT target FROM relationships WHERE source_id = ? AND resolved_target_id IS NULL')
      .all(nodeId('Notes/Status.md'));
    expect(unbound).toEqual([]);
  });

  it('a rename rewrites a path-form link to the renamed path, keeping its form', async () => {
    setPolicy(policy);
    const target = seed();

    const result = await updateNode({ node_id: target, set_title: 'Project Alpha Renamed' });

    expect(result.ok).toBe(true);
    const text = read('Notes/Kickoff.md');
    expect(text).toContain('  - "[[Projects/Project Alpha Renamed.md]]"\n  - "[[Northwind]]"\n');
    expect(text).toContain('source: "[[Projects/Project Alpha Renamed.md]]"\n');
    expect(text).toContain('see: "[[Project Alpha Renamed]]"\n');
    expect(text).toContain('Met about [[Project Alpha Renamed]] and [[Projects/Project Alpha Renamed.md|the plan]].');
    expect(text).toContain('  - Discuss [[Northwind|the customer]] and [[Acme]]\n');
    expect(linksFromKickoff(target)).toHaveLength(6);
  });
});
