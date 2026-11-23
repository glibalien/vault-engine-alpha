import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MODEL_PROVIDERS, PROVIDERS } from '@vault/settings-registry';
import {
  assertContained,
  assertEngineDistBuilt,
  disposeSandbox,
  engineSpawnSpec,
  isPathContained,
  prepareSandbox,
  sqlStringLiteral,
  type SandboxPaths,
} from './sandbox.js';

// --- fixture builders -------------------------------------------------
// All fixtures live under a throwaway temp dir created per-test. The source
// vault (a synthetic absolute path) and source DB are NEVER touched by this
// suite, per the task's safety rules — the one exception is the
// assertContained negative test below, which only reads (realpath) that
// path to prove it's correctly rejected, never writes to it.

function buildFixtureVault(root: string): { vaultDir: string; oldMtime: Date } {
  const vaultDir = join(root, 'source-vault');
  mkdirSync(join(vaultDir, 'Notes'), { recursive: true });
  mkdirSync(join(vaultDir, 'Attachments'), { recursive: true });
  mkdirSync(join(vaultDir, '.vault-engine', 'models'), { recursive: true });
  mkdirSync(join(vaultDir, '.obsidian'), { recursive: true });

  writeFileSync(join(vaultDir, 'Notes', 'a.md'), '# A\nhello world\n');
  const oldMtime = new Date('2020-01-01T00:00:00.000Z');
  utimesSync(join(vaultDir, 'Notes', 'a.md'), oldMtime, oldMtime);

  writeFileSync(join(vaultDir, 'Attachments', 'img.png'), 'fake-png-bytes');
  writeFileSync(join(vaultDir, '.vault-engine', 'models', 'weights.bin'), 'fake-onnx-weights');
  writeFileSync(join(vaultDir, '.obsidian', 'workspace.json'), '{}');

  return { vaultDir, oldMtime };
}

/** A real (writable) sqlite db at vaultDir/.vault-engine/vault.db,
 *  matching prod's real layout, with journal_mode=WAL and one committed
 *  row. Returns the db path and the still-open writer connection —
 *  callers must close it. */
function buildFixtureDb(vaultDir: string): { dbPath: string; writer: Database.Database } {
  const dbDir = join(vaultDir, '.vault-engine');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'vault.db');
  const writer = new Database(dbPath);
  writer.pragma('journal_mode = WAL');
  writer.exec('CREATE TABLE nodes (id INTEGER PRIMARY KEY, title TEXT)');
  writer.prepare('INSERT INTO nodes (title) VALUES (?)').run('wal-only-row');
  // Deliberately leave the writer connection OPEN and uncheckpointed —
  // 'wal-only-row' sits only in the -wal file, not the main .db file. This
  // is what makes the fixture actually exercise the WAL-safety property
  // (design fact #1), not just "some db file exists".
  return { dbPath, writer };
}

describe('prepareSandbox', () => {
  let scratch: string;
  let sandbox: SandboxPaths | undefined;
  let writer: Database.Database | undefined;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'sandbox-fixture-'));
  });

  afterEach(() => {
    writer?.close();
    if (sandbox) rmSync(sandbox.root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    sandbox = undefined;
    writer = undefined;
  });

  it('produces the expected tree shape: snapshot db, symlinked Attachments, preserved mtimes, .obsidian excluded', () => {
    const { vaultDir, oldMtime } = buildFixtureVault(scratch);
    const { dbPath: sourceDb, writer: w } = buildFixtureDb(vaultDir);
    writer = w;

    sandbox = prepareSandbox({ sourceVault: vaultDir, sourceDb });

    // Tree shape
    expect(sandbox.vaultPath).toBe(join(sandbox.root, 'vault'));
    expect(sandbox.dbPath).toBe(join(sandbox.vaultPath, '.vault-engine', 'vault.db'));
    expect(existsSync(sandbox.dbPath)).toBe(true);

    // Attachments is a symlink pointing at the source's Attachments dir
    const attachmentsPath = join(sandbox.vaultPath, 'Attachments');
    expect(lstatSync(attachmentsPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(attachmentsPath)).toBe(realpathSync(join(vaultDir, 'Attachments')));

    // .vault-engine/models is symlinked (present in the fixture)
    const modelsPath = join(sandbox.vaultPath, '.vault-engine', 'models');
    expect(lstatSync(modelsPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(modelsPath)).toBe(realpathSync(join(vaultDir, '.vault-engine', 'models')));

    // mtime preserved on the copied markdown file
    const copiedNote = join(sandbox.vaultPath, 'Notes', 'a.md');
    expect(existsSync(copiedNote)).toBe(true);
    expect(statSync(copiedNote).mtime.getTime()).toBe(oldMtime.getTime());
    expect(readFileSync(copiedNote, 'utf8')).toBe('# A\nhello world\n');

    // .obsidian excluded entirely
    expect(existsSync(join(sandbox.vaultPath, '.obsidian'))).toBe(false);
  });

  it('snapshots the DB via VACUUM INTO, capturing WAL-resident commits a raw file copy would lose', () => {
    const { vaultDir } = buildFixtureVault(scratch);
    const { dbPath: sourceDb, writer: w } = buildFixtureDb(vaultDir);
    writer = w;

    // Sanity: prove the row really is WAL-resident (a raw copy of just the
    // .db file, taken right now, would not see it — the CREATE TABLE
    // itself hasn't been checkpointed).
    const rawCopyPath = join(scratch, 'raw-copy.db');
    writeFileSync(rawCopyPath, readFileSync(sourceDb));
    const rawCopyDb = new Database(rawCopyPath, { readonly: true });
    expect(() => rawCopyDb.prepare('SELECT * FROM nodes').all()).toThrow(/no such table/);
    rawCopyDb.close();

    sandbox = prepareSandbox({ sourceVault: vaultDir, sourceDb });

    const snapshot = new Database(sandbox.dbPath, { readonly: true });
    const rows = snapshot.prepare('SELECT title FROM nodes').all();
    snapshot.close();
    expect(rows).toEqual([{ title: 'wal-only-row' }]);
  });

  it('prepares successfully into a destination path containing an apostrophe (TMPDIR override), proving VACUUM INTO quote-escaping works end-to-end', () => {
    const originalTmpdir = process.env.TMPDIR;
    const quoteDir = join(scratch, "o'brien-vault-store");
    mkdirSync(quoteDir, { recursive: true });
    process.env.TMPDIR = quoteDir;
    try {
      expect(tmpdir()).toBe(quoteDir); // sanity: os.tmpdir() really picked it up

      const { vaultDir } = buildFixtureVault(scratch);
      const { dbPath: sourceDb, writer: w } = buildFixtureDb(vaultDir);
      writer = w;

      sandbox = prepareSandbox({ sourceVault: vaultDir, sourceDb });

      expect(sandbox.dbPath).toContain("'"); // the destination path genuinely has an apostrophe in it
      expect(existsSync(sandbox.dbPath)).toBe(true);
      const snapshot = new Database(sandbox.dbPath, { readonly: true });
      expect(snapshot.prepare('SELECT title FROM nodes').all()).toEqual([{ title: 'wal-only-row' }]);
      snapshot.close();
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    }
  });

  it('omits the Attachments symlink and models symlink when the source lacks them', () => {
    const vaultDir = join(scratch, 'bare-vault');
    mkdirSync(join(vaultDir, 'Notes'), { recursive: true });
    writeFileSync(join(vaultDir, 'Notes', 'a.md'), 'hi');
    const dbDir = join(vaultDir, '.vault-engine');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, 'vault.db');
    const w = new Database(dbPath);
    w.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    w.close();

    sandbox = prepareSandbox({ sourceVault: vaultDir, sourceDb: dbPath });

    expect(existsSync(join(sandbox.vaultPath, 'Attachments'))).toBe(false);
    expect(existsSync(join(sandbox.vaultPath, '.vault-engine', 'models'))).toBe(false);
    // the db itself must still exist regardless
    expect(existsSync(sandbox.dbPath)).toBe(true);
  });

  it('returns paths that already pass assertContained (checked once here; the runner checks again)', () => {
    const { vaultDir } = buildFixtureVault(scratch);
    const { dbPath: sourceDb, writer: w } = buildFixtureDb(vaultDir);
    writer = w;

    sandbox = prepareSandbox({ sourceVault: vaultDir, sourceDb });
    expect(() => assertContained(sandbox!)).not.toThrow();
  });

  it('removes its own temp root if construction fails partway (nonexistent source DB, after mkdtempSync + cpSync already succeeded)', () => {
    const { vaultDir } = buildFixtureVault(scratch);
    const missingSourceDb = join(scratch, 'does-not-exist.db');
    expect(existsSync(missingSourceDb)).toBe(false);

    // Snapshot os.tmpdir()'s own 'vault-bench-*' entries before/after — this
    // is exactly where mkdtempSync creates `root`, and exactly what leaked
    // pre-fix: prepareSandbox threw (correctly) but left `root` behind
    // because nothing ever received `paths` to call disposeSandbox() with.
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('vault-bench-')).sort();

    expect(() => prepareSandbox({ sourceVault: vaultDir, sourceDb: missingSourceDb })).toThrow();

    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('vault-bench-')).sort();
    expect(after).toEqual(before);
  });
});

describe('sqlStringLiteral', () => {
  it('wraps a plain path in single quotes', () => {
    expect(sqlStringLiteral('/tmp/vault-bench-abc/vault/.vault-engine/vault.db')).toBe(
      "'/tmp/vault-bench-abc/vault/.vault-engine/vault.db'"
    );
  });

  it('doubles an embedded single quote so it cannot terminate the SQL string literal early', () => {
    expect(sqlStringLiteral("/tmp/o'brien/vault.db")).toBe("'/tmp/o''brien/vault.db'");
  });

  it('doubles multiple embedded single quotes', () => {
    expect(sqlStringLiteral("/tmp/o'br'ien/vault.db")).toBe("'/tmp/o''br''ien/vault.db'");
  });
});

describe('isPathContained (pure segment-based comparison)', () => {
  it('accepts a path nested under the root', () => {
    expect(isPathContained('/tmp/vault-bench-abc123/vault', '/tmp')).toBe(true);
  });

  it('accepts the root itself', () => {
    expect(isPathContained('/tmp', '/tmp')).toBe(true);
  });

  it('rejects a sibling-prefix path ("<tmpdir>x") that a naive startsWith check would wrongly accept', () => {
    // The bug this guards against: '/tmpx'.startsWith('/tmp') === true.
    expect('/tmpx'.startsWith('/tmp')).toBe(true); // documents the trap
    expect(isPathContained('/tmpx', '/tmp')).toBe(false);
    expect(isPathContained('/tmpx/vault', '/tmp')).toBe(false);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isPathContained('/srv/example-vault', '/tmp')).toBe(false);
  });

  it('rejects upward escape via ".."', () => {
    expect(isPathContained('/tmp/../etc', '/tmp')).toBe(false);
  });
});

describe('assertContained', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'contained-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes for a path inside os.tmpdir()', () => {
    const paths: SandboxPaths = { root: tmpDir, vaultPath: tmpDir, dbPath: join(tmpDir, 'x.db') };
    expect(() => assertContained(paths)).not.toThrow();
  });

  it('throws for a non-contained synthetic path /srv/example-vault (negative test, spelled exactly)', () => {
    const paths: SandboxPaths = {
      root: '/srv/example-vault',
      vaultPath: '/srv/example-vault',
      dbPath: '/srv/example-vault/.vault-engine/vault.db',
    };
    expect(() => assertContained(paths)).toThrow();
  });

  it('rejects vaultPath (Finding 2a): a symlink escape — textually under os.tmpdir() but resolving OUTSIDE it', () => {
    // We have no write access to create a real sibling of the system
    // os.tmpdir() (e.g. can't create /tmpx), so this test builds a
    // controlled "fake tmpdir" via a TMPDIR override instead: `fakeTmp`
    // plays the role of the current os.tmpdir(), and `outsideFakeTmp` is
    // a sibling directory that is textually unrelated to it but lives
    // under the same scratch root we do have write access to. vaultPath
    // is a symlink placed INSIDE fakeTmp that resolves OUT to
    // outsideFakeTmp — exactly the shape of the real-world macOS
    // /tmp -> /private/tmp trap, just constructed instead of relying on
    // a platform-specific symlink we don't control.
    const scratchRoot = mkdtempSync(join(tmpdir(), 'symlink-escape-'));
    const fakeTmp = join(scratchRoot, 'fake-tmp');
    const outsideFakeTmp = join(scratchRoot, 'outside-fake-tmp');
    mkdirSync(fakeTmp, { recursive: true });
    mkdirSync(outsideFakeTmp, { recursive: true });

    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = fakeTmp;
    try {
      expect(tmpdir()).toBe(fakeTmp); // sanity: os.tmpdir() really picked up the override

      const vaultPath = join(fakeTmp, 'vault'); // textually under the "current" tmpdir()
      symlinkSync(outsideFakeTmp, vaultPath, 'dir'); // but resolves OUTSIDE it

      const paths: SandboxPaths = { root: fakeTmp, vaultPath, dbPath: join(vaultPath, '.vault-engine', 'vault.db') };
      expect(() => assertContained(paths)).toThrow(/containment violation/);
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('rejects vaultPath (Finding 2b): a path that does not exist on disk — realpath ENOENT is a containment failure, not silently ignored', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'nonexistent-vaultpath-'));
    try {
      const vaultPath = join(scratchRoot, 'never-created', 'vault');
      const paths: SandboxPaths = { root: scratchRoot, vaultPath, dbPath: join(vaultPath, '.vault-engine', 'vault.db') };
      expect(existsSync(vaultPath)).toBe(false); // sanity: genuinely absent
      expect(() => assertContained(paths)).toThrow(/cannot resolve vaultPath/);
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('rejects root (Finding 1 companion): a path that does not exist on disk is a containment failure for root too', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'nonexistent-root-'));
    try {
      const badRoot = join(scratchRoot, 'never-created-root');
      const vaultPath = join(badRoot, 'vault');
      const paths: SandboxPaths = { root: badRoot, vaultPath, dbPath: join(vaultPath, '.vault-engine', 'vault.db') };
      expect(() => assertContained(paths)).toThrow(/cannot resolve root/);
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
});

describe('engineSpawnSpec', () => {
  it('builds command/args/env as pure data, without requiring packages/engine/dist to exist', () => {
    const paths: SandboxPaths = {
      root: '/tmp/vault-bench-xyz',
      vaultPath: '/tmp/vault-bench-xyz/vault',
      dbPath: '/tmp/vault-bench-xyz/vault/.vault-engine/vault.db',
    };
    const spec = engineSpawnSpec(paths);

    expect(spec.command).toBe(process.execPath);

    // args: [<engine dist path>, dbPath, '--transport', 'stdio']
    expect(spec.args).toHaveLength(4);
    expect(spec.args[0]).toMatch(/packages[/\\]engine[/\\]dist[/\\]index\.js$/);
    expect(spec.args[1]).toBe(paths.dbPath);
    expect(spec.args[2]).toBe('--transport');
    expect(spec.args[3]).toBe('stdio');

    // env: explicit override list, spend-proof
    expect(spec.env.VAULT_PATH).toBe(paths.vaultPath);
    expect(spec.env.VAULT_BACKUP_DISABLED).toBe('1');
    expect(spec.env.FIREWORKS_API_KEY).toBe('');
    expect(spec.env.ANTHROPIC_API_KEY).toBe('');
    expect(spec.env.OPENROUTER_API_KEY).toBe('');
    expect(spec.env.OPENAI_API_KEY).toBe('');
    // Every provider in the table, so a new one cannot be left to the Engine's own .env.
    for (const provider of MODEL_PROVIDERS) expect(spec.env[PROVIDERS[provider].apiKeyEnv]).toBe('');
    expect(spec.env.DEEPGRAM_API_KEY).toBe('');
    expect(spec.env.GEMINI_API_KEY).toBe('');
    expect(spec.env.TZ).toBeTruthy();
  });

  // The env is an OVERRIDE list, not an allowlist: any name the spec omits is
  // filled in by the engine's own dotenv load of packages/engine/.env. So every
  // path-shaped variable the engine reads has to be named here, or an operator's
  // .env silently redirects a sandboxed engine's writes outside the sandbox —
  // somewhere assertContained (which only validates root + vaultPath) cannot
  // see. VAULT_BACKUP_DIR is the one that bites: maintenance.ts uses it verbatim
  // and then unlinks/prunes inside it.
  it('pins every path-shaped engine env var to a sandbox-internal location', () => {
    const paths: SandboxPaths = {
      root: '/tmp/vault-bench-xyz',
      vaultPath: '/tmp/vault-bench-xyz/vault',
      dbPath: '/tmp/vault-bench-xyz/vault/.vault-engine/vault.db',
    };
    const spec = engineSpawnSpec(paths);

    // Absolute paths: must be inside paths.root (the tree disposeSandbox deletes).
    for (const name of ['VAULT_PATH', 'DB_PATH', 'VAULT_BACKUP_DIR'] as const) {
      const value = spec.env[name];
      expect(value, `${name} must be set, not left inheritable`).toBeDefined();
      expect(isAbsolute(value as string), `${name} must be absolute`).toBe(true);
      expect(isPathContained(value as string, paths.root), `${name} escapes the sandbox root`).toBe(true);
    }
    expect(spec.env.VAULT_BACKUP_DIR).toBe(join(paths.root, 'backups'));

    // Vault-relative folder names: set (so .env can't supply one), and free of
    // any traversal that would let the engine join its way out of the vault copy.
    for (const name of ['VAULT_ATTACHMENT_DIR', 'VAULT_SETTINGS_DIR'] as const) {
      const value = spec.env[name];
      expect(value, `${name} must be set, not left inheritable`).toBeDefined();
      expect(isAbsolute(value as string), `${name} must stay vault-relative`).toBe(false);
      expect(isPathContained(resolve(paths.vaultPath, value as string), paths.vaultPath)).toBe(true);
    }
    expect(spec.env.VAULT_ATTACHMENT_DIR).toBe('Attachments');
    expect(spec.env.VAULT_SETTINGS_DIR).toBe('Settings');
  });

  it('reports the process-resolved TZ rather than a fabricated default when TZ is unset', () => {
    const original = process.env.TZ;
    delete process.env.TZ;
    try {
      const paths: SandboxPaths = { root: '/tmp/r', vaultPath: '/tmp/r/vault', dbPath: '/tmp/r/vault/.vault-engine/vault.db' };
      expect(engineSpawnSpec(paths).env.TZ).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } finally {
      if (original !== undefined) process.env.TZ = original;
    }
  });

  it('passes EXA_API_KEY through from the real environment (the one deliberate external-read exception)', () => {
    const original = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = 'real-exa-key-for-test';
    try {
      const paths: SandboxPaths = { root: '/tmp/r', vaultPath: '/tmp/r/vault', dbPath: '/tmp/r/vault/.vault-engine/vault.db' };
      const spec = engineSpawnSpec(paths);
      expect(spec.env.EXA_API_KEY).toBe('real-exa-key-for-test');
    } finally {
      if (original === undefined) delete process.env.EXA_API_KEY;
      else process.env.EXA_API_KEY = original;
    }
  });

  it('defaults EXA_API_KEY to empty string when unset in the real environment', () => {
    const original = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    try {
      const paths: SandboxPaths = { root: '/tmp/r', vaultPath: '/tmp/r/vault', dbPath: '/tmp/r/vault/.vault-engine/vault.db' };
      const spec = engineSpawnSpec(paths);
      expect(spec.env.EXA_API_KEY).toBe('');
    } finally {
      if (original !== undefined) process.env.EXA_API_KEY = original;
    }
  });
});

describe('assertEngineDistBuilt', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'dist-preflight-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('does not throw when the file at args[0] exists', () => {
    const distPath = join(scratch, 'index.js');
    writeFileSync(distPath, '// dummy');
    expect(() => assertEngineDistBuilt({ args: [distPath] })).not.toThrow();
  });

  it('throws a loud, actionable error when the file at args[0] is missing', () => {
    const distPath = join(scratch, 'does-not-exist', 'index.js');
    expect(() => assertEngineDistBuilt({ args: [distPath] })).toThrow(
      /engine dist missing — run: npm run build -w vault-engine/
    );
  });
});

describe('disposeSandbox', () => {
  it('deletes the sandbox root when paths pass the containment guard', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'dispose-ok-'));
    const root = mkdtempSync(join(scratch, 'vault-bench-'));
    const vaultPath = join(root, 'vault');
    mkdirSync(vaultPath, { recursive: true });
    const paths: SandboxPaths = { root, vaultPath, dbPath: join(vaultPath, '.vault-engine', 'vault.db') };

    expect(existsSync(root)).toBe(true);
    disposeSandbox(paths);
    expect(existsSync(root)).toBe(false);

    rmSync(scratch, { recursive: true, force: true });
  });

  it('refuses (throws) rather than deletes when vaultPath fails the containment guard', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'dispose-bad-'));
    // `root` points at a real, harmless scratch dir we own — proving that
    // even though root itself would be "deletable", the vaultPath
    // containment check gates the whole call before rmSync ever runs.
    const paths: SandboxPaths = {
      root: scratch,
      vaultPath: '/srv/example-vault',
      dbPath: '/srv/example-vault/.vault-engine/vault.db',
    };

    expect(() => disposeSandbox(paths)).toThrow();
    // root must be untouched — rmSync was never reached.
    expect(existsSync(scratch)).toBe(true);

    rmSync(scratch, { recursive: true, force: true });
  });

  it('refuses (throws) rather than deletes when root fails the containment guard, even though vaultPath is legitimately inside tmpdir (Finding 1)', () => {
    // This is the exact gap Finding 1 flagged: assertContained used to
    // check only vaultPath, so a SandboxPaths whose root diverges from
    // vaultPath's ancestry (e.g. hand-constructed, or reconstructed from
    // a persisted run manifest) could sail through the guard and have its
    // `root` recursively deleted unchecked.
    //
    // We deliberately do NOT reuse the synthetic /srv/example-vault
    // path as `root` here (unlike the vaultPath test above) — if this
    // regression test is ever run against a build where the fix has
    // regressed, `root` is exactly what disposeSandbox passes to a
    // recursive `rmSync`, and we do not want that call to ever be capable
    // of targeting real user data even in a bug scenario. Instead we use a
    // TMPDIR override (same technique as the symlink-escape test above) to
    // construct a `root` that is genuinely outside the *current*
    // os.tmpdir() while still being our own disposable scratch directory.
    const scratchRoot = mkdtempSync(join(tmpdir(), 'dispose-root-bad-'));
    const fakeTmp = join(scratchRoot, 'fake-tmp');
    const outsideRoot = join(scratchRoot, 'outside-root'); // sibling of fakeTmp, NOT inside it
    mkdirSync(fakeTmp, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });

    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = fakeTmp;
    try {
      expect(tmpdir()).toBe(fakeTmp); // sanity: override took effect

      const vaultPath = join(fakeTmp, 'vault'); // legitimately inside the "current" tmpdir()
      mkdirSync(vaultPath, { recursive: true });

      const paths: SandboxPaths = {
        root: outsideRoot, // NOT inside the current tmpdir()
        vaultPath,
        dbPath: join(vaultPath, '.vault-engine', 'vault.db'),
      };

      expect(() => disposeSandbox(paths)).toThrow(/root/);
      // Nothing was deleted: neither the wrongly-targeted root nor vaultPath.
      expect(existsSync(outsideRoot)).toBe(true);
      expect(existsSync(vaultPath)).toBe(true);
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
});
