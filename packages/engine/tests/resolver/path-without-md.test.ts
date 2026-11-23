// A link written as a vault path without `.md` (`[[Projects/Project Alpha]]`) resolves to the
// note at that path, as Obsidian resolves it (#592). Before, the Engine matched a path only
// with `.md`, so such a link stayed unresolved, and a rename or move could not follow it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { pathTargetWithMd, resolveTarget } from '../../src/resolver/resolve.js';
import { candidateKeysForNode } from '../../src/resolver/candidate-keys.js';
import { backfillResolvedTargets, refreshOnCreate, refreshOnRename } from '../../src/resolver/refresh.js';

let db: Database.Database;
let vaultPath: string;
let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-engine-path-no-md-'));
  writeLock = new WriteLockManager();
});

afterEach(() => {
  db.close();
  rmSync(vaultPath, { recursive: true, force: true });
});

function setPolicy(version: 1 | 2) {
  db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', ?)").run(String(version));
  createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
  createSchemaDefinition(db, { name: 'project', field_claims: [] });
  createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'project' }] });
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
}

function write(relPath: string, content: string) {
  mkdirSync(dirname(join(vaultPath, relPath)), { recursive: true });
  writeFileSync(join(vaultPath, relPath), content);
}

function read(relPath: string) {
  return readFileSync(join(vaultPath, relPath), 'utf8');
}

function nodeId(filePath: string) {
  return (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(filePath) as { id: string }).id;
}

async function updateNode(args: Record<string, unknown>) {
  let handler!: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
  const server = { tool: (_name: string, _description: string, _schema: unknown, fn: typeof handler) => { handler = fn; } } as unknown as McpServer;
  registerUpdateNode(server, db, writeLock, vaultPath);
  return JSON.parse((await handler(args, {})).content[0].text);
}

function edgesFrom(filePath: string) {
  return db.prepare('SELECT target, rel_type, resolved_target_id FROM relationships WHERE source_id = ? ORDER BY rel_type, target')
    .all(nodeId(filePath)) as Array<{ target: string; rel_type: string; resolved_target_id: string | null }>;
}

describe('pathTargetWithMd and the candidate keys', () => {
  it('reads a target as a path only when it has a folder and no .md', () => {
    expect(pathTargetWithMd('Projects/Project Alpha')).toBe('Projects/Project Alpha.md');
    expect(pathTargetWithMd('Projects/Project Alpha.md')).toBeNull();
    expect(pathTargetWithMd('Project Alpha')).toBeNull();
  });

  it('gives a note in a folder its path without .md as a key, and a root note none', () => {
    expect(candidateKeysForNode({ file_path: 'Projects/Project Alpha.md', title: 'Project Alpha' }).pathStem).toBe('Projects/Project Alpha');
    expect(candidateKeysForNode({ file_path: 'Project Alpha.md', title: 'Project Alpha' }).pathStem).toBeNull();
  });
});

describe('resolveTarget', () => {
  beforeEach(() => {
    const insert = db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)');
    insert.run('a', 'Projects/Project Alpha.md', 'Project Alpha');
    insert.run('b', 'Archive/Project Alpha.md', 'Project Alpha');
    insert.run('c', 'Northwind.md', 'Northwind');
  });

  it('resolves a path written without .md to that exact note', () => {
    expect(resolveTarget(db, 'Projects/Project Alpha')).toEqual({ id: 'a', title: 'Project Alpha' });
    expect(resolveTarget(db, 'Archive/Project Alpha')).toEqual({ id: 'b', title: 'Project Alpha' });
  });

  it('leaves the other tiers as they were', () => {
    expect(resolveTarget(db, 'Projects/Project Alpha.md')).toEqual({ id: 'a', title: 'Project Alpha' });
    expect(resolveTarget(db, 'Northwind')).toEqual({ id: 'c', title: 'Northwind' });
    // A path that names no note does not fall back to the basename.
    expect(resolveTarget(db, 'Nowhere/Project Alpha')).toBeNull();
  });
});

describe('binding links that were waiting for the note', () => {
  beforeEach(() => {
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('src', 'Notes/Kickoff.md', 'Kickoff')").run();
    db.prepare("INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES ('src', 'Projects/Project Alpha', 'wiki-link', 'body', NULL)").run();
  });
  const bound = () => (db.prepare("SELECT resolved_target_id AS id FROM relationships WHERE source_id = 'src'").get() as { id: string | null }).id;

  it('binds when the note is created', () => {
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('a', 'Projects/Project Alpha.md', 'Project Alpha')").run();
    refreshOnCreate(db, 'a');
    expect(bound()).toBe('a');
  });

  it('binds when a note is renamed or moved to that path', () => {
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('a', 'Inbox/Project Alpha.md', 'Project Alpha')").run();
    expect(bound()).toBeNull();
    db.prepare("UPDATE nodes SET file_path = 'Projects/Project Alpha.md' WHERE id = 'a'").run();
    refreshOnRename(db, 'a');
    expect(bound()).toBe('a');
  });

  it('binds links left unresolved before this change at the next startup backfill', () => {
    // An existing install: the note was there all along, but the link was never bound.
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('a', 'Projects/Project Alpha.md', 'Project Alpha')").run();
    expect(bound()).toBeNull();
    expect(backfillResolvedTargets(db)).toMatchObject({ updated: 1 });
    expect(bound()).toBe('a');
  });
});

describe.each([1, 2] as const)('reference policy %i, indexed from files', policy => {
  function seed() {
    setPolicy(policy);
    write('Projects/Project Alpha.md', '---\ntypes:\n  - project\n---\nThe plan for Acme.\n');
    write('Notes/Kickoff.md', '---\ntypes:\n  - task\nproject: "[[Projects/Project Alpha]]"\nsee: "[[Projects/Project Alpha]]"\n---\n'
      + 'Met about [[Projects/Project Alpha|the plan]].\n');
    fullIndex(vaultPath, db);
    return nodeId('Projects/Project Alpha.md');
  }

  it('binds body, typed-field and unclaimed-field links written as a path without .md', () => {
    const target = seed();
    expect(edgesFrom('Notes/Kickoff.md')).toEqual([
      { target: 'Projects/Project Alpha', rel_type: 'project', resolved_target_id: target },
      { target: 'Projects/Project Alpha', rel_type: 'see', resolved_target_id: target },
      { target: 'Projects/Project Alpha', rel_type: 'wiki-link', resolved_target_id: target },
    ]);
  });

  it('a move rewrites them to the new path, in the same form, still bound', async () => {
    const target = seed();

    const result = await updateNode({ node_id: target, set_directory: 'Archive' });

    expect(result.ok).toBe(true);
    const text = read('Notes/Kickoff.md');
    // Under policy 2 a typed reference is rewritten to the exact new path with `.md` (#110).
    expect(text).toContain(policy === 2 ? 'project: "[[Archive/Project Alpha.md]]"' : 'project: "[[Archive/Project Alpha]]"');
    expect(text).toContain('see: "[[Archive/Project Alpha]]"');
    expect(text).toContain('Met about [[Archive/Project Alpha|the plan]].');
    expect(edgesFrom('Notes/Kickoff.md').map(edge => edge.resolved_target_id)).toEqual([target, target, target]);
  });

  it('a rename rewrites them to the renamed path, still bound', async () => {
    const target = seed();

    const result = await updateNode({ node_id: target, set_title: 'Project Alpha Renamed' });

    expect(result.ok).toBe(true);
    const text = read('Notes/Kickoff.md');
    expect(text).toContain(policy === 2 ? 'project: "[[Projects/Project Alpha Renamed.md]]"' : 'project: "[[Projects/Project Alpha Renamed]]"');
    expect(text).toContain('see: "[[Projects/Project Alpha Renamed]]"');
    expect(text).toContain('Met about [[Projects/Project Alpha Renamed|the plan]].');
    expect(edgesFrom('Notes/Kickoff.md').map(edge => edge.resolved_target_id)).toEqual([target, target, target]);
  });
});
