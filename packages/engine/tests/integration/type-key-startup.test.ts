/**
 * #445: an existing installation upgrades with nothing to do. Its database was built with
 * `types` and records no type key, and no VAULT_TYPE_KEY is set: Engine starts as before,
 * reads every note's types, rewrites nothing, and records `types`. Started with another
 * key, it refuses before reading a note.
 */
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { TYPE_KEY_META } from '../../src/db/type-key.js';

/** Each test starts a real Engine once or more; the default 5 s is too short when the whole suite runs. */
const STARTUP_TIMEOUT_MS = 40_000;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NOTES: Record<string, string> = {
  'Meetings/Sync.md': '---\ntypes:\n  - meeting\npeople involved:\n  - "[[Ann Example]]"\nstatus: open\n---\nNotes from the call.\n',
  'People/Ann Example.md': '---\ntypes:\n  - person\n---\n',
  'Projects/Alpha.md': '---\ntypes:\n  - project\nstatus: in-progress\ntype: initiative\n---\nThe plan.\n',
  'Inbox.md': '# Inbox\n',
};

function makeVault(): { vault: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'type-key-startup-')); dirs.push(dir);
  const vault = join(dir, 'vault');
  for (const [path, content] of Object.entries(NOTES)) {
    mkdirSync(dirname(join(vault, path)), { recursive: true });
    writeFileSync(join(vault, path), content);
  }
  return { vault, dbPath: join(dir, 'vault.db') };
}

/** One-shot `--normalize` start: migrations, the type key check, a full index, schema render, normalizer sweep. */
function start(vault: string, dbPath: string, env: Record<string, string> = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'VAULT_TYPE_KEY'));
  return spawnSync(process.execPath, ['--import', 'tsx', resolve('src/index.ts'), dbPath, '--normalize'], {
    cwd: process.cwd(), env: { ...base, VAULT_PATH: vault, DOTENV_CONFIG_QUIET: 'true', ...env }, encoding: 'utf8', timeout: 120_000,
  });
}

function files(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== '.vault-engine') walk(path); continue; }
      out[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root);
  return out;
}

function snapshot(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      types: db.prepare('SELECT n.file_path, t.schema_type FROM node_types t JOIN nodes n ON n.id = t.node_id ORDER BY 1, 2').all(),
      fields: db.prepare('SELECT n.file_path, f.field_name, f.value_text, f.value_json FROM node_fields f JOIN nodes n ON n.id = f.node_id ORDER BY 1, 2').all(),
      nodes: db.prepare('SELECT id, file_path, content_hash, version FROM nodes ORDER BY file_path').all(),
      key: (db.prepare('SELECT value FROM meta WHERE key = ?').get(TYPE_KEY_META) as { value: string } | undefined)?.value ?? null,
    };
  } finally {
    db.close();
  }
}

it('starts an existing database without a recorded key on types and changes nothing', () => {
  const { vault, dbPath } = makeVault();
  // The previous version's state: a built database, and no recorded key (no Engine before
  // #445 wrote one).
  const first = start(vault, dbPath);
  expect(first.status, first.stderr + first.stdout).toBe(0);
  const db = new Database(dbPath);
  db.prepare('DELETE FROM meta WHERE key = ?').run(TYPE_KEY_META);
  db.close();
  const filesBefore = files(vault);
  const before = snapshot(dbPath);
  expect(before.key).toBeNull();
  expect(before.types).toContainEqual({ file_path: 'Meetings/Sync.md', schema_type: 'meeting' });
  expect(before.fields).toContainEqual(expect.objectContaining({ file_path: 'Projects/Alpha.md', field_name: 'type', value_text: 'initiative' }));

  const upgraded = start(vault, dbPath);

  expect(upgraded.status, upgraded.stderr + upgraded.stdout).toBe(0);
  expect(upgraded.stdout + upgraded.stderr).not.toMatch(/VAULT_TYPE_KEY|frontmatter key/);
  expect(files(vault)).toEqual(filesBefore);
  const after = snapshot(dbPath);
  expect({ ...after, key: null }).toEqual(before);
  expect(after.key).toBe('types');
  // Neither start rewrote a note Engine had rendered.
  for (const path of ['Meetings/Sync.md', 'People/Ann Example.md', 'Projects/Alpha.md']) {
    expect(readFileSync(join(vault, path), 'utf8')).toBe(NOTES[path]);
  }
}, STARTUP_TIMEOUT_MS);

it('refuses another type key on that database before reading or writing a note', () => {
  const { vault, dbPath } = makeVault();
  expect(start(vault, dbPath).status).toBe(0);
  const filesBefore = files(vault);
  const before = snapshot(dbPath);

  const refused = start(vault, dbPath, { VAULT_TYPE_KEY: 'type' });

  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('VAULT_TYPE_KEY is "type", but this database\'s notes were indexed with "types"');
  expect(refused.stdout).not.toContain('Indexing vault');
  expect(files(vault)).toEqual(filesBefore);
  expect(snapshot(dbPath)).toEqual(before);
}, STARTUP_TIMEOUT_MS);

it('builds a new database with a designated key and reads types from it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'type-key-startup-')); dirs.push(dir);
  const vault = join(dir, 'vault');
  mkdirSync(join(vault, 'Meetings'), { recursive: true });
  writeFileSync(join(vault, 'Meetings', 'Sync.md'), '---\nkind: meeting\ntypes: kept\n---\nNotes.\n');
  const dbPath = join(dir, 'vault.db');

  const result = start(vault, dbPath, { VAULT_TYPE_KEY: 'kind' });

  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain('Note types are read from the "kind" frontmatter key');
  const after = snapshot(dbPath);
  expect(after.key).toBe('kind');
  expect(after.types).toEqual([{ file_path: 'Meetings/Sync.md', schema_type: 'meeting' }]);
  expect(after.fields).toEqual([expect.objectContaining({ file_path: 'Meetings/Sync.md', field_name: 'types', value_text: 'kept' })]);
  // A key Engine writes in its own notes is refused.
  const reserved = start(vault, join(dir, 'other.db'), { VAULT_TYPE_KEY: 'source' });
  expect(reserved.status).toBe(1);
  expect(reserved.stderr).toContain('VAULT_TYPE_KEY cannot be "source"');
}, STARTUP_TIMEOUT_MS);
