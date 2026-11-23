// #507: the startup index binds a note's body links and untyped references once every
// note is read, so a link to a name several notes share goes to the shortest of their
// paths (what `resolveTarget` gives against the complete set of notes), whatever order
// the directory walk takes. It used to bind each link as its note was read, against the
// notes read so far, so `[[Plan]]` went to `Archive/Old/Plan.md` when the walk reached
// that file before `Projects/Plan.md`.
//
// Existing bindings stay: a restart changes no binding of a link in a note whose file
// has not changed. Only a note read again (changed while Engine was down) binds its
// links anew, as the watcher would.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { searchWords } from '../helpers/search-words.js';
import { REFERENCE_POLICY_VERSION_KEY } from '../../src/db/reference-policy-version.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { fullIndex, indexFile } from '../../src/indexer/indexer.js';
import { backfillResolvedTargets } from '../../src/resolver/refresh.js';
import { resolveTarget } from '../../src/resolver/resolve.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

// The directory walk's order, by name: the file system's own order when null.
const walk = vi.hoisted(() => ({ order: null as 'ascending' | 'descending' | null }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readdir = ((path: string, options?: unknown) => {
    const entries = (actual.readdirSync as (p: string, o?: unknown) => Array<string | { name: string }>)(path, options);
    if (walk.order === null) return entries;
    const name = (entry: string | { name: string }) => typeof entry === 'string' ? entry : entry.name;
    const sign = walk.order === 'ascending' ? 1 : -1;
    return [...entries].sort((a, b) => sign * (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
  }) as typeof actual.readdirSync;
  return { ...actual, readdirSync: readdir };
});

let vault: string;
const databases: Database.Database[] = [];

function write(path: string, content: string): void {
  mkdirSync(dirname(join(vault, path)), { recursive: true });
  writeFileSync(join(vault, path), content);
}

const linker = (name: string) => `---\ntypes: [note]\nrelated: "[[Plan]]"\nproject: "[[Plan]]"\n---\n`
  + `# ${name}\n\nSee [[Plan]], [[plan]], [[Plan.md]], [[Plan|the plan]] and [[Missing Note]].\n`;

/**
 * Three notes answer to `Plan`: `Projects/Plan.md` is the shortest of the two titled
 * `Plan`, and `Inbox/PLAN.md` the shortest of the three by case. The linkers sit before,
 * between and after them in either walk order: in ascending order `Archive` is read
 * before `Inbox` and `Projects`, in descending order after them.
 */
function seedVault(): void {
  write('Archive/Old/Plan.md', '# Old plan\n');
  write('Projects/Plan.md', '---\ntypes: [project]\n---\n# Plan\n');
  write('Inbox/PLAN.md', '# Plan, in capitals\n');
  for (const path of ['Archive/Old/Zed Linker.md', 'Archive/Linker.md', 'Inbox/Linker.md', 'Linker.md',
    'Projects/Linker.md', 'Projects/Zed Linker.md', 'Zeta/Linker.md']) {
    write(path, linker(path));
  }
}

function newDb(policy: 1 | 2, typed: boolean): Database.Database {
  const db = createTestDb();
  databases.push(db);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(REFERENCE_POLICY_VERSION_KEY, String(policy));
  if (typed) createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
  return db;
}

function pathOf(db: Database.Database, id: string | null): string | null {
  if (id === null) return null;
  return (db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(id) as { file_path: string }).file_path;
}

/** Each relationship and each search row, by path: node ids differ between databases. */
function bindings(db: Database.Database) {
  const relationships = (db.prepare(`SELECT n.file_path AS source, r.target, r.rel_type, r.context, r.resolved_target_id
    FROM relationships r JOIN nodes n ON n.id = r.source_id`).all() as Array<Record<string, string | null>>)
    .map(row => JSON.stringify({ ...row, resolved_target_id: pathOf(db, row.resolved_target_id) }))
    .sort();
  return { relationships, search: searchWords(db) };
}

/** Links bound by name (every one but a typed reference under policy 2), of the notes given or all. */
function legacyLinks(db: Database.Database, typed: boolean, sources?: string[]) {
  return (db.prepare(`SELECT n.file_path AS source, r.target, r.rel_type, r.resolved_target_id
    FROM relationships r JOIN nodes n ON n.id = r.source_id`).all() as
    Array<{ source: string; target: string; rel_type: string; resolved_target_id: string | null }>)
    .filter(row => !(typed && row.rel_type === 'project') && (sources === undefined || sources.includes(row.source)));
}

function index(db: Database.Database, order: 'ascending' | 'descending' | null = null) {
  walk.order = order;
  try {
    return fullIndex(vault, db);
  } finally {
    walk.order = null;
  }
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'full-index-link-binding-'));
  seedVault();
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  rmSync(vault, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const VARIANTS = [[1, false], [2, false], [2, true]] as const;
const name = (policy: number, typed: boolean) => `policy v${policy}${typed ? ', typed reference field' : ''}`;

describe('fullIndex binds links once every note is read (#507)', () => {
  it('reads the directory in the order asked (the test\'s premise)', () => {
    walk.order = 'descending';
    expect(readdirSync(vault)).toEqual(['Zeta', 'Projects', 'Linker.md', 'Inbox', 'Archive']);
    walk.order = null;
  });

  for (const [policy, typed] of VARIANTS) {
    it(`binds the same links whatever the walk order, cold and warm (${name(policy, typed)})`, () => {
      const ascending = newDb(policy, typed);
      const descending = newDb(policy, typed);
      expect(index(ascending, 'ascending')).toMatchObject({ indexed: 10, errors: 0 });
      expect(index(descending, 'descending')).toMatchObject({ indexed: 10, errors: 0 });
      expect(bindings(ascending)).toEqual(bindings(descending));

      // Each link is bound as resolveTarget binds it once every note is indexed.
      for (const link of legacyLinks(ascending, typed)) {
        expect({ target: link.target, bound: pathOf(ascending, link.resolved_target_id) })
          .toEqual({ target: link.target, bound: pathOf(ascending, resolveTarget(ascending, link.target)?.id ?? null) });
      }
      const boundTo = (target: string) => [...new Set(legacyLinks(ascending, typed)
        .filter(link => link.target === target).map(link => pathOf(ascending, link.resolved_target_id)))];
      expect(boundTo('Plan')).toEqual(['Projects/Plan.md']);
      expect(boundTo('plan')).toEqual(['Inbox/PLAN.md']);
      expect(boundTo('Plan.md')).toEqual(['Projects/Plan.md']);
      expect(boundTo('Missing Note')).toEqual([null]);

      // Warm: an edited linker, a new one, and the shortest `Plan` moved while Engine
      // was down (a move's refresh binds links on the way; the pass's end decides).
      write('Archive/Linker.md', `${linker('edited')}\nEdited.\n`);
      const future = new Date(Date.now() + 5000);
      utimesSync(join(vault, 'Archive/Linker.md'), future, future);
      write('Archive/Old/New Linker.md', linker('new'));
      mkdirSync(join(vault, 'Work'));
      renameSync(join(vault, 'Projects/Plan.md'), join(vault, 'Work/Plan.md'));
      expect(index(ascending, 'ascending')).toMatchObject({ indexed: 3, renamed: 1, errors: 0 });
      expect(index(descending, 'descending')).toMatchObject({ indexed: 3, renamed: 1, errors: 0 });
      expect(bindings(ascending)).toEqual(bindings(descending));
      for (const db of [ascending, descending]) {
        backfillResolvedTargets(db);
        // The notes read again; the others keep their bindings (`[[plan]]` stays with
        // `Inbox/PLAN.md` though the moved `Work/Plan.md` is shorter now).
        for (const link of legacyLinks(db, typed, ['Archive/Linker.md', 'Archive/Old/New Linker.md'])) {
          expect({ target: link.target, bound: pathOf(db, link.resolved_target_id) })
            .toEqual({ target: link.target, bound: pathOf(db, resolveTarget(db, link.target)?.id ?? null) });
        }
      }
      expect(bindings(ascending)).toEqual(bindings(descending));
    });
  }

  it('names a bound link in the note\'s search row by its target\'s title, as a single file\'s index does', () => {
    const db = newDb(1, false);
    index(db, 'descending');
    // Zeta/Linker.md is the first note read in descending order. Its links name `Plan`,
    // `PLAN` and `Missing Note`: `[[Plan.md]]` is named by its target's title.
    const read = searchWords(db, 'Zeta/Linker.md');
    expect(read['Zeta/Linker.md links']).toBe('plan plan missing note');
    indexFile(join(vault, 'Zeta/Linker.md'), vault, db);
    expect(searchWords(db, 'Zeta/Linker.md')).toEqual(read);
  });
});

describe('an existing installation keeps its bindings (#507)', () => {
  /** An installation whose `[[Plan]]` links an older Engine bound to the longer path. */
  function previousInstall(policy: 1 | 2, typed: boolean): Database.Database {
    const db = newDb(policy, typed);
    fullIndex(vault, db);
    backfillResolvedTargets(db);
    // As an older first index bound them when its walk read `Archive/Old/Plan.md`
    // before these notes and `Projects/Plan.md` after them.
    const archived = (db.prepare("SELECT id FROM nodes WHERE file_path = 'Archive/Old/Plan.md'").get() as { id: string }).id;
    const moved = db.prepare(`UPDATE relationships SET resolved_target_id = ? WHERE target = 'Plan'
      AND source_id IN (SELECT id FROM nodes WHERE file_path IN ('Linker.md', 'Zeta/Linker.md'))
      AND NOT (? AND rel_type = 'project')`).run(archived, typed ? 1 : 0);
    expect(moved.changes).toBe(typed ? 4 : 6);
    return db;
  }

  /** Every stored row a reader sees, the edits log included. */
  function everything(db: Database.Database) {
    const all = (sql: string) => db.prepare(sql).all();
    return {
      nodes: all('SELECT rowid, * FROM nodes ORDER BY rowid'),
      types: all('SELECT * FROM node_types ORDER BY node_id, sort_order'),
      fields: all('SELECT * FROM node_fields ORDER BY node_id, field_name'),
      relationships: all('SELECT * FROM relationships ORDER BY id'),
      search: searchWords(db),
      editsLog: all('SELECT * FROM edits_log ORDER BY id'),
    };
  }

  function restart(db: Database.Database): void {
    fullIndex(vault, db);
    backfillResolvedTargets(db);
  }

  const boundPaths = (db: Database.Database, source: string) => [...new Set((db.prepare(`SELECT r.resolved_target_id
    FROM relationships r JOIN nodes n ON n.id = r.source_id WHERE n.file_path = ? AND r.target = 'Plan' AND r.rel_type != 'project'`)
    .all(source) as Array<{ resolved_target_id: string }>).map(row => pathOf(db, row.resolved_target_id)))];

  for (const [policy, typed] of VARIANTS) {
    it(`a restart changes no stored row of a note whose file has not changed (${name(policy, typed)})`, () => {
      const db = previousInstall(policy, typed);
      const before = everything(db);
      restart(db);
      expect(everything(db)).toEqual(before);
      expect(boundPaths(db, 'Linker.md')).toEqual(['Archive/Old/Plan.md']);

      // Saved again without a change: only the recorded mtime moves.
      const future = new Date(Date.now() + 5000);
      utimesSync(join(vault, 'Zeta/Linker.md'), future, future);
      restart(db);
      const after = everything(db);
      const zeta = (before.nodes as Array<{ file_path: string; file_mtime: number }>).findIndex(node => node.file_path === 'Zeta/Linker.md');
      (before.nodes[zeta] as { file_mtime: number }).file_mtime = Math.floor(future.getTime());
      expect(after).toEqual(before);
      expect(boundPaths(db, 'Zeta/Linker.md')).toEqual(['Archive/Old/Plan.md']);
    });

    it(`a note changed while Engine was down binds its links as the watcher does (${name(policy, typed)})`, () => {
      const indexed = previousInstall(policy, typed);
      const watched = previousInstall(policy, typed);
      write('Linker.md', `${linker('edited')}\nEdited while Engine was down.\n`);
      const future = new Date(Date.now() + 5000);
      utimesSync(join(vault, 'Linker.md'), future, future);

      restart(indexed);
      processFileChange(join(vault, 'Linker.md'), 'Linker.md', watched, new WriteLockManager(), vault);

      expect(boundPaths(indexed, 'Linker.md')).toEqual(['Projects/Plan.md']);
      const linksOf = (db: Database.Database) => (db.prepare(`SELECT r.target, r.rel_type, r.resolved_target_id
        FROM relationships r JOIN nodes n ON n.id = r.source_id WHERE n.file_path = 'Linker.md' ORDER BY r.target, r.rel_type`)
        .all() as Array<{ target: string; rel_type: string; resolved_target_id: string | null }>)
        .map(row => ({ ...row, resolved_target_id: pathOf(db, row.resolved_target_id) }));
      expect(linksOf(indexed)).toEqual(linksOf(watched));
      // The other linker the older Engine bound to the longer path keeps it.
      expect(boundPaths(indexed, 'Zeta/Linker.md')).toEqual(['Archive/Old/Plan.md']);
    });
  }
});
