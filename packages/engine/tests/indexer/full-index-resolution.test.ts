// #464: fullIndex resolves links through a ResolutionLookup instead of a
// resolveTarget table scan per link. The result must be the one per-link
// resolveTarget gives, row for row. Since #507 the pass binds links once every
// note is read, so that is resolveTarget against the complete table
// (full-index-link-binding.test.ts covers the walk order).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { searchWords } from '../helpers/search-words.js';
import { REFERENCE_POLICY_VERSION_KEY } from '../../src/db/reference-policy-version.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { backfillResolvedTargets } from '../../src/resolver/refresh.js';
import { ResolutionLookup, resolveTarget } from '../../src/resolver/resolve.js';

let vault: string;

function write(path: string, content: string): void {
  mkdirSync(dirname(join(vault, path)), { recursive: true });
  writeFileSync(join(vault, path), content);
}

const LINKS = [
  '[[Shared]]', '[[shared]]', '[[Topic]]', '[[topic]]', '[[Topic.md]]', '[[Notes/Topic.md]]', '[[Notes/Topic]]',
  '[[Cafe\u0301]]', '[[Missing Note]]', '[[Q1: Review]]', '[[Shared|shown text]]', '![[chart.png]]',
  '[[Fail First]]', '[[Fail Middle]]', '[[Fail Last]]',
  '[[Legacy Name]]', '[[Person One]]', '[[Launch Plan]]',
];

function linker(i: number): string {
  const body = LINKS.map((link, k) => (k + i) % 3 === 0 ? `See ${link}.` : `- ${link}`).join('\n');
  return `---\ntypes: [note]\nproject: "[[Launch Plan]]"\nowner: "[[Person One]]"\nattendees:\n  - "[[Person One]]"\n  - "[[Shared]]"\n---\n# Linker ${i}\n\n[[Linker ${i}]]\n${body}\n`;
}

// Fails after its node row is written (newDb refuses its second type), so the
// file's savepoint rolls back. Written first, midway and last, so that whatever
// order the directory walk takes, links are resolved both before and after a
// failure. A type held twice did this until #482; Engine now reads it as one type.
const FAILING_TYPE = 'refused-type';
const FAILING = `---\ntypes: [task, ${FAILING_TYPE}]\n---\n# Fails\n`;

function seedVault(): void {
  write('Fail First.md', FAILING);
  // Same-length duplicates tie on rowid; a longer one loses; case and NFC twins.
  write('Alpha/Shared.md', '# Shared A\n');
  write('Gamma/Shared.md', '# Shared G\n');
  write('Archive/Deep/Shared.md', '# Shared deep\n');
  write('Notes/Topic.md', '# Topic\n');
  write('Inbox/TOPIC.md', '# Topic upper\n');
  write('Notes/Caf\u00e9.md', '# Cafe\n');
  write('Notes/Q1 - Review.md', '# Review\n');
  write('Projects/Launch Plan.md', '---\ntypes: [project]\n---\n# Launch\n');
  write('People/Person One.md', '---\ntypes: [person]\n---\n# Person\n');
  const dirs = ['', 'a/', 'b/', 'c/d/', 'Notes/', 'Inbox/', 'z/'];
  for (let i = 0; i < 14; i++) {
    write(`${dirs[i % dirs.length]}Linker ${i}.md`, linker(i));
    if (i === 7) write('b/Fail Middle.md', FAILING);
  }
  write('Fail Last.md', FAILING);
}

function changeVault(): void {
  // Moved while Engine was down: pairs by content hash and keeps its id.
  mkdirSync(join(vault, 'Team'));
  renameSync(join(vault, 'People/Person One.md'), join(vault, 'Team/Person One.md'));
  write('Notes/Topic.md', '# Topic, edited\n[[Shared]] [[Person One]]\n');
  const future = new Date(Date.now() + 5000);
  utimesSync(join(vault, 'Notes/Topic.md'), future, future);
  write('Beta/Shared.md', '# Shared B, the shortest path\n');
  unlinkSync(join(vault, 'Gamma/Shared.md'));
  for (let i = 14; i < 20; i++) write(`New/Linker ${i}.md`, linker(i));
}

function newDb(policy: 1 | 2, typed: boolean): Database.Database {
  const db = createTestDb();
  db.exec(`CREATE TRIGGER fail_type_insert BEFORE INSERT ON node_types WHEN NEW.schema_type = '${FAILING_TYPE}'
    BEGIN SELECT RAISE(ABORT, 'type insert refused'); END`);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(REFERENCE_POLICY_VERSION_KEY, String(policy));
  if (typed) {
    createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
    createGlobalField(db, { name: 'attendees', field_type: 'list', list_item_type: 'reference', reference_target: 'person' });
  }
  return db;
}

/** Every table a full index writes, keyed by path instead of node id. */
function snapshot(db: Database.Database, warnings: string[]) {
  const pathOf = new Map((db.prepare('SELECT id, file_path FROM nodes').all() as Array<{ id: string; file_path: string }>)
    .map(row => [row.id, row.file_path]));
  // A deleted node's id survives only in edits_log; ids differ between databases.
  const path = (id: string | null) => id === null ? null : pathOf.get(id) ?? '<no longer a node>';
  const rows = (sql: string, idColumns: string[] = []) => (db.prepare(sql).all() as Array<Record<string, unknown>>)
    .map(row => JSON.stringify({ ...row, ...Object.fromEntries(idColumns.map(col => [col, path(row[col] as string | null)])) }))
    .sort();
  return {
    nodes: rows('SELECT file_path, title, body, content_hash, version FROM nodes'),
    types: rows('SELECT node_id, schema_type, sort_order FROM node_types', ['node_id']),
    fields: rows('SELECT node_id, field_name, value_text, value_number, value_date, value_json, value_raw_text, source FROM node_fields', ['node_id']),
    relationships: rows('SELECT source_id, target, rel_type, context, resolved_target_id FROM relationships', ['source_id', 'resolved_target_id']),
    // The words of each search row; a SELECT of nodes_fts's own columns reads NULL (#521).
    search: searchWords(db),
    editsLog: rows('SELECT node_id, event_type, details FROM edits_log', ['node_id']),
    warnings: warnings.map(line => line.replace(/"([A-Za-z0-9_-]{21})"/g, (match, id: string) => pathOf.has(id) ? `"<${pathOf.get(id)}>"` : match)),
  };
}

/** One startup's index: fullIndex, then the backfill startup runs after it. */
function index(db: Database.Database) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const stats = fullIndex(vault, db);
    const afterIndex = snapshot(db, warn.mock.calls.map(call => call.map(String).join(' ')));
    const backfill = backfillResolvedTargets(db);
    return { stats, afterIndex, backfill, afterBackfill: snapshot(db, []) };
  } finally {
    warn.mockRestore();
  }
}

/** Every link resolved by resolveTarget against the table as it stands, in place of the lookup. */
function indexPerLink(db: Database.Database) {
  let calls = 0;
  const spy = vi.spyOn(ResolutionLookup.prototype, 'resolve').mockImplementation((target: string) => {
    calls++;
    return resolveTarget(db, target);
  });
  try {
    return { ...index(db), calls };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'full-index-resolution-'));
  seedVault();
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('fullIndex link resolution (#464)', () => {
  for (const [policy, typed] of [[1, false], [1, true], [2, false], [2, true]] as const) {
    it(`matches per-link resolveTarget row for row, cold and warm (policy v${policy}${typed ? ', typed fields' : ''})`, () => {
      const viaLookup = newDb(policy, typed);
      const perLink = newDb(policy, typed);

      const cold = index(viaLookup);
      const coldReference = indexPerLink(perLink);
      expect(cold.stats).toEqual(coldReference.stats);
      expect(cold.stats.errors).toBe(3);
      expect(coldReference.calls).toBeGreaterThan(200);
      expect(cold.afterIndex).toEqual(coldReference.afterIndex);
      expect(cold.backfill).toEqual(coldReference.backfill);
      expect(cold.afterBackfill).toEqual(coldReference.afterBackfill);
      // The search rows compared above hold words, not NULL columns (#521).
      expect(cold.afterBackfill.search['Linker 0.md links']).toContain('launch plan');

      // A title that drifted from its filename (tier 2), as a legacy database can hold.
      for (const db of [viaLookup, perLink]) {
        db.prepare("UPDATE nodes SET title = 'Legacy Name' WHERE file_path = 'Notes/Caf\u00e9.md'").run();
      }
      changeVault();
      const warm = index(viaLookup);
      const warmReference = indexPerLink(perLink);
      expect(warm.stats).toEqual(warmReference.stats);
      expect(warm.stats).toMatchObject({ renamed: 1, deleted: 1 });
      expect(warm.afterIndex).toEqual(warmReference.afterIndex);
      expect(warm.afterBackfill).toEqual(warmReference.afterBackfill);

      viaLookup.close();
      perLink.close();
    });
  }

  it('reads the node table once per pass instead of once per link', () => {
    const statements: string[] = [];
    const db = createTestDb({ verbose: (sql) => statements.push(String(sql)) });
    statements.length = 0;
    fullIndex(vault, db);
    expect(statements.filter(sql => sql === 'SELECT rowid, id, file_path, title FROM nodes')).toHaveLength(1);
    // resolveTarget's statements (tiers 1, 2, then the whole table): none during a full index.
    expect(statements.filter(sql => sql.startsWith('SELECT id, title FROM nodes WHERE file_path ')
      || sql.startsWith('SELECT id, file_path, title FROM nodes WHERE title ')
      || sql === 'SELECT id, file_path, title FROM nodes')).toEqual([]);
    db.close();
  });
});
