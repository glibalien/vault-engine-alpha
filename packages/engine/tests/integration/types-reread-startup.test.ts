/**
 * #482 upgrade: a database the previous Engine built, whose notes it read with the narrower
 * reading of `types` (an unquoted `[[project]]` was no type), started under this Engine. The
 * full server start reads those notes again once: they gain their types, nothing else in the
 * database changes, and no file in the vault is written.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { sharedTestModelsDir } from '../helpers/test-models-dir.js';
import { TYPES_REREAD_META_KEY } from '../../src/indexer/types-reread.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NOTES: Record<string, string> = {
  'Projects/Alpha.md': '---\ntypes: [[project]]\nstatus: active\n---\nThe plan.\n',
  'Meetings/Sync.md': '---\ntypes:\n  - meeting\npeople involved:\n  - "[[Ann Example]]"\n---\nNotes.\n',
  'People/Ann Example.md': '---\ntypes:\n  - person\n---\n',
  'Saved.md': '---\ntypes:\nstatus: open\n---\nSaved by Engine already.\n',
  'Mapping.md': '---\ntypes:\n  category: meeting\n---\n',
};

/** A full server start on stdio, stopped once it answers MCP's initialize: its whole start ran. */
async function start(vault: string, dbPath: string): Promise<string> {
  const engineDir = resolve(import.meta.dirname, '../..');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'VAULT_TYPE_KEY'));
  const child = spawn(resolve(engineDir, '../../node_modules/.bin/tsx'), [join(engineDir, 'src', 'index.ts'), '--transport', 'stdio'], {
    cwd: engineDir,
    env: {
      ...env, VAULT_PATH: vault, DB_PATH: dbPath, DOTENV_CONFIG_QUIET: 'true', EMBEDDER_MODELS_DIR: sharedTestModelsDir(),
      FIREWORKS_API_KEY: '', OPENROUTER_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', EXA_API_KEY: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { logs += chunk.toString(); });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'upgrade-test', version: '0' } },
  })}\n`);
  try {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`Engine did not start\n${logs}`)), 60_000);
      const poll = setInterval(() => {
        if (!/"id":1\b/.test(logs)) return;
        clearInterval(poll); clearTimeout(timer); done();
      }, 25);
      child.once('exit', code => { clearInterval(poll); clearTimeout(timer); fail(new Error(`Engine exited ${code}\n${logs}`)); });
    });
  } finally {
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    child.kill('SIGTERM');
    await exited;
  }
  return logs;
}

function files(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== '.vault-engine') walk(path); continue; }
      // A note's mtime too: no write at all. (Every start rewrites .schemas/ with the same bytes.)
      const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
      out[relative(root, path)] = name.endsWith('.md') ? `${hash} ${statSync(path).mtimeMs}` : hash;
    }
  };
  walk(root);
  return out;
}

function snapshot(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      types: db.prepare('SELECT n.file_path, t.schema_type FROM node_types t JOIN nodes n ON n.id = t.node_id ORDER BY 1, t.sort_order').all(),
      fields: db.prepare('SELECT n.file_path, f.* FROM node_fields f JOIN nodes n ON n.id = f.node_id ORDER BY 1, f.field_name').all(),
      nodes: db.prepare('SELECT id, file_path, title, body, content_hash, file_mtime, content_changed_at, version FROM nodes ORDER BY file_path').all(),
      relationships: db.prepare('SELECT source_id, target, rel_type, resolved_target_id FROM relationships ORDER BY 1, 2, 3').all(),
    };
  } finally {
    db.close();
  }
}

it('reads the notes again at the first start: they gain their types, nothing else changes, no file is written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'types-reread-startup-')); dirs.push(dir);
  const vault = join(dir, 'vault');
  for (const [path, content] of Object.entries(NOTES)) {
    mkdirSync(dirname(join(vault, path)), { recursive: true });
    writeFileSync(join(vault, path), content);
  }
  const dbPath = join(dir, 'vault.db');
  // Two starts: the first writes Engine's own notes, the second records their files' mtimes.
  await start(vault, dbPath);
  await start(vault, dbPath);

  // As the previous Engine left the database: Alpha indexed with no type, and no check run.
  const db = new Database(dbPath);
  db.prepare("DELETE FROM node_types WHERE node_id = (SELECT id FROM nodes WHERE file_path = 'Projects/Alpha.md')").run();
  db.prepare('DELETE FROM meta WHERE key = ?').run(TYPES_REREAD_META_KEY);
  db.close();
  const filesBefore = files(vault);
  const before = snapshot(dbPath);
  expect(before.types).not.toContainEqual(expect.objectContaining({ file_path: 'Projects/Alpha.md' }));

  const logs = await start(vault, dbPath);

  expect(logs).toContain('[types] 1 note(s) read again');
  expect(logs).toContain('[types]   Projects/Alpha.md: (none) -> project');
  expect(files(vault)).toEqual(filesBefore);
  const after = snapshot(dbPath);
  expect(after.types).toEqual([...before.types, { file_path: 'Projects/Alpha.md', schema_type: 'project' }]
    .sort((a, b) => (a as { file_path: string }).file_path.localeCompare((b as { file_path: string }).file_path)));
  expect({ ...after, types: null }).toEqual({ ...before, types: null });
  // Still no type from a mapping, and nothing to recover for a note Engine already saved.
  expect(after.types).not.toContainEqual(expect.objectContaining({ file_path: 'Mapping.md' }));
  expect(after.types).not.toContainEqual(expect.objectContaining({ file_path: 'Saved.md' }));
  expect(readFileSync(join(vault, 'Projects/Alpha.md'), 'utf8')).toBe(NOTES['Projects/Alpha.md']);

  // Once: the next start reads nothing again.
  expect(await start(vault, dbPath)).not.toContain('[types]');
}, 200_000);
