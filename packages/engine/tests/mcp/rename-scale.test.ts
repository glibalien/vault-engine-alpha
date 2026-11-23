// Renaming a heavily referenced note (#575), and undoing that (#589). Each reference rewrite,
// and each restore of an undo, used to rebuild the catalogs it resolves and canonicalizes
// links against from every node in the vault, so both cost their notes times the vault's
// size: tens of seconds on a large vault, and out of memory at 1,000 references. The writes
// of one rename, or of one undo, now share one set of catalogs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';
import { restoreOperation } from '../../src/undo/restore.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

const REFERENCES = 200;
// Other notes in the vault. Before #575 each of the 200 rewrites read all of them, once
// under reference policy 1 and twice under 2: 3 and 10 seconds on a fast desktop.
const OTHER_NOTES = 20_000;
// The rename now takes under half a second there, and about two seconds inside a loaded
// full test run. The budget only catches a gross slowdown on slow, busy machines; the
// count of whole-vault reads below is the exact check.
const BUDGET_MS = 10_000;
// Statements that read every node's identity, which the catalogs are built from: the
// canonicalizer, the policy 2 catalog and resolveTarget's scan, and the policy 1 lookup.
const CATALOG_SCANS = new Set(['SELECT id, file_path, title FROM nodes', 'SELECT rowid, id, file_path, title FROM nodes']);

let db: Database.Database;
let vaultPath: string;
let writeLock: WriteLockManager;
let catalogScans = 0;

beforeEach(() => {
  catalogScans = 0;
  db = createTestDb({
    verbose: sql => { if (typeof sql === 'string' && CATALOG_SCANS.has(sql.trim())) catalogScans++; },
  });
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-engine-rename-scale-'));
  writeLock = new WriteLockManager();
});

afterEach(() => {
  db.close();
  rmSync(vaultPath, { recursive: true, force: true });
});

function setPolicy(version: 1 | 2) {
  db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', ?)").run(String(version));
  createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
  createGlobalField(db, { name: 'related', field_type: 'list', list_item_type: 'reference' });
  createSchemaDefinition(db, { name: 'project', field_claims: [] });
  createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'project' }, { field: 'related' }] });
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
}

function write(relPath: string, content: string) {
  mkdirSync(dirname(join(vaultPath, relPath)), { recursive: true });
  writeFileSync(join(vaultPath, relPath), content);
}

function read(relPath: string) {
  return readFileSync(join(vaultPath, relPath), 'utf8');
}

function refPath(i: number) {
  return `Notes/Ref ${String(i).padStart(3, '0')}.md`;
}

async function callTool(register: (server: McpServer) => void, args: Record<string, unknown>) {
  let handler!: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
  const server = { tool: (_name: string, _description: string, _schema: unknown, fn: typeof handler) => { handler = fn; } } as unknown as McpServer;
  register(server);
  return JSON.parse((await handler(args, {})).content[0].text);
}

function updateNode(args: Record<string, unknown>) {
  return callTool(server => registerUpdateNode(server, db, writeLock, vaultPath), args);
}

function undoOperations(args: Record<string, unknown>) {
  return callTool(server => registerUndoOperations(server, db, writeLock, vaultPath), args);
}

function nodeId(filePath: string) {
  return (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(filePath) as { id: string }).id;
}

/** A note with REFERENCES notes linking to it, indexed from files; `extraLine` ends each one. */
function referencedNote(policy: 1 | 2, extraLine = ''): string {
  setPolicy(policy);
  write('Projects/Project Alpha.md', '---\ntypes:\n  - project\n---\nThe plan for Acme.\n');
  // A third each: a body link, a typed reference field, and both with a typed list.
  for (let i = 0; i < REFERENCES; i++) {
    const kind = i % 3;
    write(refPath(i), (kind === 0
      ? '---\ntypes:\n  - note\n---\nMet Northwind about [[Project Alpha]].\n'
      : kind === 1
        ? '---\ntypes:\n  - task\nproject: "[[Project Alpha]]"\n---\nFollow up.\n'
        : '---\ntypes:\n  - task\nproject: "[[Project Alpha]]"\nrelated:\n  - "[[Project Alpha]]"\n---\nSee [[Project Alpha|the plan]].\n')
      + extraLine);
  }
  fullIndex(vaultPath, db);
  return nodeId('Projects/Project Alpha.md');
}

function addOtherNotes() {
  const insert = db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < OTHER_NOTES; i++) insert.run(`other-${i}`, `Archive/Other ${i}.md`, `Other ${i}`);
  })();
}

describe.each([1, 2] as const)(`renaming a note with ${REFERENCES} references, reference policy %i`, policy => {
  it(`rewrites every reference within ${BUDGET_MS} ms, as one undoable operation`, async () => {
    const targetId = referencedNote(policy);
    addOtherNotes();

    catalogScans = 0;
    const start = performance.now();
    const result = await updateNode({ node_id: targetId, set_title: 'Project Alpha Renamed' });
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(true);
    expect(result.data.references_updated).toBe(REFERENCES);
    // A fixed number of whole-vault reads, not one or two per reference.
    expect(catalogScans).toBeLessThan(20);
    expect(elapsed).toBeLessThan(BUDGET_MS);

    for (let i = 0; i < REFERENCES; i++) {
      const text = read(refPath(i));
      expect(text).toContain('[[Project Alpha Renamed');
      expect(text).not.toContain('[[Project Alpha]]');
      expect(text).not.toContain('[[Project Alpha|');
    }
    expect(read(refPath(2))).toBe('---\ntypes:\n  - task\nproject: "[[Project Alpha Renamed]]"\nrelated:\n'
      + '  - "[[Project Alpha Renamed]]"\n---\nSee [[Project Alpha Renamed|the plan]].\n');
    expect(db.prepare("SELECT count(*) AS c FROM relationships WHERE target = 'Project Alpha'").get()).toEqual({ c: 0 });
    // Every body link, field and list item is still bound to the renamed note: one edge in
    // each of the first two kinds of note, three in the third.
    const third = Math.floor(REFERENCES / 3);
    expect(db.prepare('SELECT count(*) AS c FROM relationships WHERE resolved_target_id = ? AND source_id != ?').get(targetId, targetId))
      .toEqual({ c: (REFERENCES - third) + third * 3 });

    const operations = db.prepare('SELECT operation_id FROM undo_operations').all() as Array<{ operation_id: string }>;
    expect(operations).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS c FROM undo_snapshots WHERE operation_id = ?').get(operations[0].operation_id))
      .toEqual({ c: REFERENCES + 1 });
  });

  it('keeps a fixed number of whole-vault reads when the linking notes also link to a missing note', async () => {
    // Under policy 1 each rewrite resolved such a link by reading every node, and #590 sends
    // policy-1 bulk moves through this rename path too.
    const targetId = referencedNote(policy, '\nAsk about [[Budget Review]].\n');
    addOtherNotes();

    catalogScans = 0;
    const result = await updateNode({ node_id: targetId, set_title: 'Project Alpha Renamed' });

    expect(result.ok).toBe(true);
    expect(result.data.references_updated).toBe(REFERENCES);
    expect(catalogScans).toBeLessThan(20);
    expect(db.prepare("SELECT count(*) AS c FROM relationships WHERE target = 'Budget Review' AND resolved_target_id IS NULL").get())
      .toEqual({ c: REFERENCES });
  });

  it(`undoes it within ${BUDGET_MS} ms, putting every note back`, async () => {
    // A link to a note that does not exist, as many notes have: under policy 1 resolving it
    // read every node, in each restore (#589).
    const targetId = referencedNote(policy, '\nAsk about [[Budget Review]].\n');
    const paths = ['Projects/Project Alpha.md', ...Array.from({ length: REFERENCES }, (_, i) => refPath(i))];
    const edges = () => db.prepare('SELECT source_id, target, rel_type, resolved_target_id FROM relationships ORDER BY source_id, rel_type, target').all();
    const filesBefore = paths.map(read);
    const edgesBefore = edges();
    const renamed = await updateNode({ node_id: targetId, set_title: 'Project Alpha Renamed' });
    expect(renamed.ok).toBe(true);
    const { operation_id } = db.prepare('SELECT operation_id FROM undo_operations').get() as { operation_id: string };
    // Added after the rename: the undo is what this measures.
    addOtherNotes();

    catalogScans = 0;
    const start = performance.now();
    const result = await undoOperations({ operation_ids: [operation_id], dry_run: false });
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ total_undone: REFERENCES + 1, total_conflicts: 0, total_skipped: 0 });
    // A fixed number of whole-vault reads, not one per restored note.
    expect(catalogScans).toBeLessThan(20);
    expect(elapsed).toBeLessThan(BUDGET_MS);
    expect(paths.map(read)).toEqual(filesBefore);
    expect(edges()).toEqual(edgesBefore);
  });
});

describe('a rename whose reference rewrites change another note’s identity', () => {
  it('lets later rewrites see a title an earlier rewrite reset', async () => {
    setPolicy(2);
    const node = (file_path: string, types: string[], fields: Record<string, unknown>, body: string) =>
      executeMutation(db, writeLock, vaultPath, { source: 'tool', node_id: null, file_path, title: '', types, fields, body }).node_id;
    const target = node('Projects/Project Alpha.md', ['project'], {}, 'The plan.');
    // Rewritten first (typed references come first), with a link that loads the shared
    // catalogs' name lookups before the note below resets its title.
    node('Notes/Acme Task.md', ['task'], { project: 'Project Alpha' }, 'Blocked on [[Nowhere Yet]].');
    const drifted = node('Notes/Northwind Task.md', ['task'], { project: 'Project Alpha' }, 'Next steps.');
    const linker = node('Notes/Status.md', ['note'], {}, 'Tracking [[Project Alpha]] and [[Northwind Legacy]].');
    // A title stored before titles followed filenames, with no link bound through it:
    // the rewrite resets it to the filename's.
    db.prepare("UPDATE nodes SET title = 'Northwind Legacy' WHERE id = ?").run(drifted);

    const result = await updateNode({ node_id: target, set_title: 'Project Alpha Renamed' });

    expect(result.ok).toBe(true);
    expect(result.data.references_updated).toBe(3);
    expect(db.prepare('SELECT title FROM nodes WHERE id = ?').get(drifted)).toEqual({ title: 'Northwind Task' });
    // No note is titled "Northwind Legacy" any more, so the link is left as written, as a
    // write after the reset would leave it.
    expect(db.prepare('SELECT body FROM nodes WHERE id = ?').get(linker))
      .toEqual({ body: 'Tracking [[Project Alpha Renamed]] and [[Northwind Legacy]].' });

    const { operation_id } = db.prepare('SELECT operation_id FROM undo_operations ORDER BY timestamp DESC LIMIT 1').get() as { operation_id: string };
    restoreOperation(db, writeLock, vaultPath, operation_id, new Set([operation_id]));
    expect(read('Notes/Status.md')).toContain('Tracking [[Project Alpha]] and [[Northwind Legacy]].');
    expect(db.prepare('SELECT title FROM nodes WHERE id = ?').get(drifted)).toEqual({ title: 'Northwind Legacy' });
  });

  it('resolves a note’s own links after the title its rewrite resets', async () => {
    setPolicy(2);
    // Indexed from files, so no write canonicalizes the links first.
    write('Projects/Project Alpha.md', '---\ntypes:\n  - project\n---\nThe plan.\n');
    write('Notes/Acme Task.md', '---\ntypes:\n  - task\nproject: "[[Project Alpha]]"\n---\nBlocked on [[Nowhere Yet]].\n');
    write('Notes/Northwind Task.md', '---\ntypes:\n  - task\nproject: "[[Project Alpha]]"\n---\nAs in [[Northwind Legacy]].\n');
    // Also answers to the old title, so the link stays as written (two notes it could mean).
    write('Notes/Northwind Archive.md', '---\ntypes:\n  - note\naliases:\n  - Northwind Legacy\n---\nOld notes.\n');
    fullIndex(vaultPath, db);
    const drifted = nodeId('Notes/Northwind Task.md');
    // A title stored before titles followed filenames. Its own link to it was indexed
    // unresolved, so no link is bound through it and the rewrite resets it.
    db.prepare("UPDATE nodes SET title = 'Northwind Legacy' WHERE id = ?").run(drifted);

    const result = await updateNode({ node_id: nodeId('Projects/Project Alpha.md'), set_title: 'Project Alpha Renamed' });

    expect(result.ok).toBe(true);
    expect(result.data.references_updated).toBe(2);
    expect(db.prepare('SELECT title, body FROM nodes WHERE id = ?').get(drifted))
      .toEqual({ title: 'Northwind Task', body: 'As in [[Northwind Legacy]].\n' });
    // Resolved against the reset title, as any later write of the note would: no note is
    // titled "Northwind Legacy" any more.
    expect(db.prepare("SELECT resolved_target_id FROM relationships WHERE source_id = ? AND target = 'Northwind Legacy'").get(drifted))
      .toEqual({ resolved_target_id: null });
  });
});
