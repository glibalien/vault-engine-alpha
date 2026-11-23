// Sandbox: snapshots a copy of the real vault + DB into a disposable temp
// dir, and produces the spawn specification for an engine subprocess that
// runs against that copy. This module never spawns anything — Task 7 owns
// the spawn (the MCP SDK's StdioClientTransport takes {command, args, env}
// and spawns the child itself).
//
// Safety: the source vault (/srv/example-vault) and source DB
// (/srv/example-vault/.vault-engine/vault.db) are read-only inputs
// here. The real DB is WAL-mode with a live writer — copying the .db file
// alone loses WAL frames and yields a corrupt/stale snapshot, so the DB
// snapshot MUST go through VACUUM INTO from a `{ readonly: true }`
// connection (design fact #1), never a raw file copy.
//
// assertContained is the last line of defence against a benchmark run
// silently scoring (or, worse, disposeSandbox deleting) against real vault
// data — see ambiguity rulings #1 and #3 in the task brief. Treat it as
// security-critical, not as a lint.

import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { MODEL_PROVIDERS, PROVIDERS } from '@vault/settings-registry';

export interface SandboxPaths {
  root: string; // mkdtemp dir
  vaultPath: string; // root/vault
  dbPath: string; // root/vault/.vault-engine/vault.db
}

export interface PrepareOpts {
  sourceVault: string;
  sourceDb: string;
}

// This module lives at packages/bench/src/sandbox.ts — three levels below
// the repo root (src -> bench -> packages -> root). Derived from the
// module's own location (not process.cwd()), so it's correct regardless of
// where the bench CLI is invoked from.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..', '..');
const ENGINE_DIST_PATH = join(REPO_ROOT, 'packages', 'engine', 'dist', 'index.js');

/** Escapes a path for embedding as a single-quoted SQL string literal
 *  (single quotes doubled), for `VACUUM INTO '<path>'`. Exported so the
 *  escaping itself is directly unit-testable, independent of any real
 *  filesystem path happening to contain an apostrophe. */
export function sqlStringLiteral(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

/** Pure containment check: is `candidateReal` at or inside `rootReal`?
 *  Segment-based via path.relative — rejects any relative result that
 *  escapes upward (starts with '..') or is itself absolute (can happen
 *  cross-drive on Windows). Exported so the sibling-prefix trap (e.g.
 *  "<tmpdir>x" vs "<tmpdir>") can be unit-tested without needing write
 *  access to create a real sibling of the OS temp dir on disk — a naive
 *  `candidate.startsWith(root)` string check would wrongly accept that
 *  case; this does not. Both arguments are expected to already be resolved
 *  (realpath'd) absolute paths. */
export function isPathContained(candidateReal: string, rootReal: string): boolean {
  const rel = relative(rootReal, candidateReal);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Throws unless `candidate` resolves (symlink-free, via realpath) to a
 *  location inside `tmpRoot` (itself already realpath'd by the caller).
 *  `label` is only used to make the thrown message point at which
 *  SandboxPaths field failed. A path that does not exist on disk (realpath
 *  ENOENT) is treated as a containment failure too — fail closed, never
 *  silently ignored. */
function assertOnePathContained(candidate: string, tmpRoot: string, label: string): void {
  let candidateReal: string;
  try {
    candidateReal = realpathSync(candidate);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`sandbox containment check failed: cannot resolve ${label} "${candidate}": ${reason}`);
  }
  if (!isPathContained(candidateReal, tmpRoot)) {
    throw new Error(
      `sandbox containment violation: ${label} "${candidate}" (resolved "${candidateReal}") is not inside os.tmpdir() ("${tmpRoot}"). Refusing to proceed — this guard exists to stop a benchmark run from touching the real vault.`
    );
  }
}

/** Throws unless EVERY path in `paths` that a caller could delete or write
 *  through — `root` (deleted wholesale by `disposeSandbox`) and
 *  `vaultPath` (written into by `prepareSandbox`, read by the spawned
 *  engine) — resolves (symlink-free, via realpath) to a location inside
 *  `os.tmpdir()` (also realpath'd, since os.tmpdir() itself can be a
 *  symlink on macOS).
 *
 *  Checking only `vaultPath` is not enough: `disposeSandbox` calls
 *  `rmSync` on `paths.root`, a sibling field with no containment check of
 *  its own. That's safe today only because `prepareSandbox` always derives
 *  `vaultPath` from a freshly-minted `root` — nothing enforces that
 *  relationship for a caller who hand-constructs (or reconstructs from
 *  persisted state, e.g. a Task 9 run manifest) a `SandboxPaths`. So both
 *  fields are validated independently here.
 *
 *  This is the sandbox's hard containment guard — called once here at the
 *  end of `prepareSandbox`, again by `disposeSandbox` immediately before
 *  its recursive delete, and again by the Task 8 runner immediately
 *  before its first tool execution (design fact #8: checked twice — this
 *  file already checks it twice on its own, once per function). */
export function assertContained(paths: SandboxPaths): void {
  const tmpRoot = realpathSync(tmpdir());
  assertOnePathContained(paths.root, tmpRoot, 'root');
  assertOnePathContained(paths.vaultPath, tmpRoot, 'vaultPath');
}

/** Copy filter for the markdown tree: excludes the vault-root `Attachments`
 *  and `.vault-engine` directories (design fact #2 — these are replaced by
 *  a symlink and a VACUUM INTO snapshot respectively, never copied), and
 *  any `.obsidian` directory at any depth. */
function markdownCopyFilter(sourceVault: string): (src: string) => boolean {
  return (src: string): boolean => {
    const rel = relative(sourceVault, src);
    if (rel === '') return true; // the vault root itself
    const segments = rel.split(sep);
    if (segments[0] === 'Attachments') return false;
    if (segments[0] === '.vault-engine') return false;
    if (segments.includes('.obsidian')) return false;
    return true;
  };
}

/** Prepares a disposable sandbox: copies markdown (mtimes preserved,
 *  Attachments/.vault-engine/.obsidian excluded), snapshots the DB via
 *  VACUUM INTO, and symlinks Attachments + (if present) the local ONNX
 *  embedder weights directory. Never spawns anything. */
export function prepareSandbox(opts: PrepareOpts): SandboxPaths {
  const root = mkdtempSync(join(tmpdir(), 'vault-bench-'));
  // Everything below can fail partway (a bad sourceVault mid-copy, a
  // missing/corrupt sourceDb, even a containment violation from a
  // caller-supplied path) AFTER mkdtempSync has already created `root` on
  // disk. Before this try/catch, such a failure never returned `paths` to
  // the caller — who therefore had nothing to call disposeSandbox() with —
  // leaking `root` under os.tmpdir() forever. Same failure class as the
  // process.exit()-inside-try and missing-SIGINT-handler leaks fixed
  // elsewhere in this task, just reached through a constructor failure
  // instead of an early exit or an interrupt.
  try {
    const vaultPath = join(root, 'vault');
    const dbDir = join(vaultPath, '.vault-engine');
    const dbPath = join(dbDir, 'vault.db');

    // Design fact #2: mtime-preserving markdown copy, excluding the dirs
    // that get replaced by symlinks/snapshots below. fs.cpSync creates
    // `vaultPath` itself (the filter is called with rel === '' for the root
    // and must return true for that call, or nothing gets copied at all).
    cpSync(opts.sourceVault, vaultPath, {
      recursive: true,
      preserveTimestamps: true,
      filter: markdownCopyFilter(opts.sourceVault),
    });

    // Design fact #1: DB snapshot via VACUUM INTO from a readonly connection
    // — never a raw file copy. The source is WAL-mode with a live writer;
    // VACUUM INTO on a readonly connection still observes the full committed
    // state (including WAL-resident commits a byte copy of just the .db file
    // would miss), and produces one consistent single-file snapshot.
    mkdirSync(dbDir, { recursive: true });
    const sourceDb = new Database(opts.sourceDb, { readonly: true });
    try {
      sourceDb.exec(`VACUUM INTO ${sqlStringLiteral(dbPath)}`);
    } finally {
      sourceDb.close();
    }

    // Design fact #3: symlink Attachments — needed only by read-embedded;
    // never written because bench never commits writes.
    const sourceAttachments = join(opts.sourceVault, 'Attachments');
    if (existsSync(sourceAttachments)) {
      symlinkSync(sourceAttachments, join(vaultPath, 'Attachments'), 'dir');
    }

    // Design fact #4: symlink the local ONNX embedder weights if present —
    // without it the embedder tries a network download, fails
    // asynchronously, and semantic search silently degrades to FTS-only.
    const sourceModels = join(opts.sourceVault, '.vault-engine', 'models');
    if (existsSync(sourceModels)) {
      symlinkSync(sourceModels, join(dbDir, 'models'), 'dir');
    }

    const paths: SandboxPaths = { root, vaultPath, dbPath };
    assertContained(paths);
    return paths;
  } catch (err) {
    // Best-effort: force so a partially-written tree (or nothing at all,
    // if cpSync itself is what failed) never turns cleanup into a second
    // error that masks the original one.
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/** Builds (but does not validate the existence of) the engine spawn spec.
 *  Pure/data-only by design — the `packages/engine/dist/index.js`
 *  existence preflight (design fact #6) is a separate guard,
 *  `assertEngineDistBuilt`, so this function can be unit-tested without
 *  requiring the engine to have been built. Task 7 (which owns the actual
 *  spawn) is expected to call `assertEngineDistBuilt(spec)` immediately
 *  before spawning.
 *
 *  Env is an OVERRIDE list, NOT an allowlist (correcting design fact #7 as
 *  originally written). The child does not inherit this process's env — but
 *  a variable this spec does not name is not thereby "unset" either: it is
 *  merely absent at spawn, and `packages/engine/src/index.ts` immediately
 *  calls dotenv on `packages/engine/.env` WITHOUT `override`, which fills in
 *  every name the spec left out. So the only variables this spec actually
 *  controls are the ones it explicitly sets — and setting one to `''` counts
 *  as set, which is exactly why the provider keys below are spend-proof:
 *  dotenv skips a name that is already present, empty or not.
 *
 *  Everything that matters must therefore be named here, in three groups:
 *
 *  1. Provider keys, hardcoded to '' — reads as unset by every engine
 *     key-gate, so the sandboxed engine cannot spend on any of them.
 *     EXA_API_KEY passes through deliberately — web-search/fetch-url are
 *     external reads, not spend, and without it every such call would
 *     unfairly fail every replayed turn that used them.
 *
 *  2. Every path-shaped variable the engine reads, pinned to a
 *     sandbox-internal location. This is the containment property
 *     `assertContained` CANNOT enforce: it validates `paths.root` and
 *     `paths.vaultPath` only, so it is blind to a child that was handed an
 *     absolute path pointing somewhere else entirely. VAULT_BACKUP_DIR is
 *     the concrete case — `packages/engine/src/db/maintenance.ts` uses it
 *     verbatim, and an operator with `VAULT_BACKUP_DIR=<prod backups>` in
 *     `packages/engine/.env` (exactly the shape this repo's prod-checkout
 *     split invites) would have had every `bench run` write a ~258 MB
 *     snapshot into the REAL backup directory, unlink the day's existing
 *     real backup to overwrite it, and prune history past `backupKeep`.
 *     Note that `VAULT_BACKUP_DISABLED=1` does NOT prevent that: it is a
 *     seed-only env var, and backups are gated on the `backupsEnabled`
 *     SETTING, which rides along inside the VACUUM'd snapshot of an
 *     already-seeded production DB. Sandboxed engines really do run backups.
 *     It is kept below only as documentation of intent for a hypothetical
 *     unseeded DB.
 *
 *  3. TZ, pinned to the zone this process actually resolved, so the child's
 *     clock matches the one the replayed prompts were composed against
 *     (`Intl.DateTimeFormat().resolvedOptions().timeZone`, per
 *     `packages/chat-core/src/compose.ts`) rather than a fabricated default.
 *
 *  Deliberately NOT pinned: SYNC_LOG_RETENTION_HOURS (a number, and its only
 *  effect is how much sync-log history the sandbox's own throwaway DB keeps)
 *  and OAUTH_OWNER_PASSWORD/OAUTH_ISSUER_URL (read only on the `http`
 *  transport branch; this spec always spawns `--transport stdio`, and pinning
 *  them to '' would make `validateAuthEnv` throw for anyone who ever changed
 *  that, which is the fail-closed direction we want anyway). */
export function engineSpawnSpec(paths: SandboxPaths): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: process.execPath,
    args: [ENGINE_DIST_PATH, paths.dbPath, '--transport', 'stdio'],
    env: {
      // --- path-shaped: every one of these must resolve inside paths.root ---
      VAULT_PATH: paths.vaultPath,
      // Already passed positionally (args[1] wins over DB_PATH in the engine's
      // own precedence chain), so this is defence in depth: leaving the name
      // inheritable is the same class of hole as VAULT_BACKUP_DIR, and costs
      // nothing to close.
      DB_PATH: paths.dbPath,
      // Vault-RELATIVE folder names, but both are joined against the vault
      // root by their consumers, so a `../..`-shaped value in .env is a
      // containment question, not a cosmetic one. 'Attachments' is what
      // prepareSandbox itself symlinks (above) and 'Settings' is the engine's
      // own default — pinning both keeps the child consistent with the tree
      // this module actually built.
      VAULT_ATTACHMENT_DIR: 'Attachments',
      VAULT_SETTINGS_DIR: 'Settings',
      // Outside the vault copy on purpose: a stray 258 MB snapshot must never
      // land somewhere the indexer/watcher could see it, and `root` is what
      // disposeSandbox deletes.
      VAULT_BACKUP_DIR: join(paths.root, 'backups'),
      VAULT_BACKUP_DISABLED: '1', // inert (seed-only) — see the note above
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TZ: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      // --- spend-proofing: '' is SET, so dotenv will not fill these in ---
      // Every model provider's key, read from the provider table so a provider added there
      // is blanked here too (OPENAI_API_KEY was missed while this list was written by hand).
      ...Object.fromEntries(MODEL_PROVIDERS.map(provider => [PROVIDERS[provider].apiKeyEnv, ''])),
      DEEPGRAM_API_KEY: '',
      GEMINI_API_KEY: '',
      EXA_API_KEY: process.env.EXA_API_KEY ?? '',
    },
  };
}

/** Preflight guard (design fact #6): throws loudly if the engine hasn't
 *  been built, rather than letting the spawn silently fail or (worse)
 *  boot against the wrong db. Call immediately before spawning `spec`. */
export function assertEngineDistBuilt(spec: { args: string[] }): void {
  const distPath = spec.args[0];
  if (distPath === undefined || !existsSync(distPath)) {
    throw new Error('engine dist missing — run: npm run build -w vault-engine');
  }
}

/** Recursively deletes the sandbox root. Refuses (throws, via
 *  assertContained) rather than deletes when `paths` fails the
 *  containment guard — a recursive delete driven by a bad path is the
 *  worst failure mode in this file (ambiguity ruling #3). */
export function disposeSandbox(paths: SandboxPaths): void {
  assertContained(paths);
  rmSync(paths.root, { recursive: true, force: true });
}
