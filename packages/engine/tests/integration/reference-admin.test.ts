import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from '../../src/transport/args.js';
import { createSchema } from '../../src/db/schema.js';
import { ensureMetaTable } from '../../src/db/migrate.js';
import { previewReferenceActivation, applyReferenceActivation } from '../../src/resolver/activation.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'reference-admin-')); dirs.push(dir);
  const path = join(dir, 'vault.db'); const db = new Database(path);
  createSchema(db); ensureMetaTable(db);
  db.exec("INSERT INTO nodes (id,file_path,title) VALUES ('s','s.md','Source')");
  return { dir, path, db };
}
it.each([
  ['--reference-resolution'], ['--reference-resolution','other'],
  ['--reference-resolution','apply'], ['--reference-resolution','apply','--offline'],
  ['--reference-resolution','apply','--preview-fingerprint','a'.repeat(64)],
  ['--reference-resolution','preview','--normalize'], ['--reference-resolution','preview','--reindex-search'],
  ['--reference-resolution','preview','--transport','stdio'], ['--reference-resolution','preview','--port','3333'],
  ['--reference-resolution','preview','--dry-run'], ['--preview-fingerprint','a'.repeat(64)], ['--offline'],
  ['--reference-resolution','apply','--preview-fingerprint','A'.repeat(64),'--offline'],
  ['--reference-resolution','preview','--preview-fingerprint','a'.repeat(64)],
])('rejects invalid or conflicting administrative argv %j', (...argv) => expect(() => parseArgs(argv)).toThrow());
it('parses guarded apply', () => {
  expect(parseArgs(['db.sqlite','--reference-resolution','apply','--preview-fingerprint','a'.repeat(64),'--offline']))
    .toMatchObject({ dbPath: 'db.sqlite', referenceResolution: 'apply', previewFingerprint: 'a'.repeat(64), offline: true });
});
it('preview subprocess bypasses normal bootstrap and preserves DB and vault bytes', () => {
  const { dir, path, db } = fixture(); db.close();
  mkdirSync(join(dir, 'Settings')); writeFileSync(join(dir, 'Settings','Engine.md'), 'unchanged settings');
  writeFileSync(join(dir,'offline.md'), 'must not index');
  // A real entrypoint must never even load the ordinary bootstrap dependencies.
  const guard = join(dir,'guard.mjs');
  writeFileSync(guard, `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
 if (/\\/(?:db\\/(?:connection|schema|migrate)|indexer\\/indexer|settings\\/seed|extraction\\/setup|search\\/embedder|mcp\\/server)\\.(?:js|ts)$/.test(specifier)) throw new Error('BOOTSTRAP SIDE EFFECT SEAM: '+specifier);
 return next(specifier, context);
} });`);
  const before = readFileSync(path); const names = readdirSync(dir);
  const result = spawnSync(process.execPath, ['--import','tsx','--import',guard,resolve('src/index.ts'),path,'--reference-resolution','preview'], {
    cwd: process.cwd(), env: { ...process.env, VAULT_PATH: dir, DOTENV_CONFIG_QUIET: 'true', VAULT_ATTACHMENT_DIR: '../../blocked' }, encoding:'utf8', timeout:20000,
  });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ from_policy: 1, to_policy: 2, counts: { scanned: 0 } });
  expect(readFileSync(path)).toEqual(before); expect(readdirSync(dir)).toEqual(names);
  expect(readFileSync(join(dir,'Settings','Engine.md'),'utf8')).toBe('unchanged settings');
  expect(readFileSync(join(dir,'offline.md'),'utf8')).toBe('must not index');
});
it('fails closed on concurrent writer ownership without changing marker', () => {
  const { path, db } = fixture(); const preview = previewReferenceActivation(db);
  const writer = new Database(path); writer.exec('BEGIN IMMEDIATE'); db.pragma('busy_timeout=1');
  try { expect(() => applyReferenceActivation(db, preview.fingerprint)).toThrow(/locked/); }
  finally { writer.exec('ROLLBACK'); writer.close(); }
  expect(db.prepare('SELECT * FROM meta').all()).toEqual([]); db.close();
});
it('apply subprocess preserves journaling, raw data, files and unrelated metadata', () => {
  const { dir, path, db } = fixture();
  db.exec("INSERT INTO meta(key,value) VALUES ('provenance_witness','retained'); INSERT INTO node_fields(node_id,field_name,value_json) VALUES ('s','empty','[]')");
  const preview = previewReferenceActivation(db);
  const rows = db.prepare('SELECT * FROM nodes').all();
  db.close();
  writeFileSync(join(dir,'s.md'),'source file');
  const result = spawnSync(process.execPath, ['--import','tsx',resolve('src/index.ts'),path,'--reference-resolution','apply','--preview-fingerprint',preview.fingerprint,'--offline'], {
    env: { ...process.env, VAULT_PATH: dir }, encoding:'utf8', timeout:20000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ from_policy: 1, to_policy: 2, noop: false });
  const verify = new Database(path, { readonly: true });
  expect(verify.pragma('journal_mode', { simple: true })).toBe('delete');
  expect(verify.prepare('SELECT * FROM nodes').all()).toEqual(rows);
  expect(verify.prepare("SELECT value_json FROM node_fields WHERE field_name='empty'").get()).toEqual({ value_json: '[]' });
  expect(verify.prepare("SELECT value FROM meta WHERE key='provenance_witness'").get()).toEqual({ value: 'retained' });
  expect(readFileSync(join(dir,'s.md'),'utf8')).toBe('source file'); verify.close();
});
it('preview of a missing database fails without creating files or directories', () => {
  const dir = mkdtempSync(join(tmpdir(),'reference-missing-')); dirs.push(dir);
  const result = spawnSync(process.execPath, ['--import','tsx',resolve('src/index.ts'),join(dir,'missing','vault.db'),'--reference-resolution','preview'], {
    env: { ...process.env, VAULT_PATH: dir }, encoding:'utf8', timeout:20000,
  });
  expect(result.status).toBe(1); expect(readdirSync(dir)).toEqual([]);
});
it('holds one read snapshot across a concurrent committed identity change', () => {
  const { path, db } = fixture();
  db.pragma('journal_mode=WAL');
  const before = previewReferenceActivation(db);
  let changed = false;
  const reader = new Database(path, { readonly: true, fileMustExist: true, verbose: sql => {
    if (!changed && String(sql).includes('FROM node_types')) {
      changed = true;
      db.exec("UPDATE nodes SET title='Concurrent' WHERE id='s'");
    }
  } });
  try {
    expect(previewReferenceActivation(reader).fingerprint).toBe(before.fingerprint);
    expect(changed).toBe(true);
    expect(previewReferenceActivation(db).fingerprint).not.toBe(before.fingerprint);
    expect(() => applyReferenceActivation(db, before.fingerprint)).toThrow(/stale/i);
  } finally { reader.close(); db.close(); }
});
