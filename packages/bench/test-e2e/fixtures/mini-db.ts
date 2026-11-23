// Builds the e2e suite's corpus/sandbox SOURCE: a copy of the 4-file
// fixture vault plus a real engine-built SQLite database for it.
//
// The DB is never hand-crafted (task-10 ambiguity ruling #2). The only thing
// that knows the engine's schema, its ~30 migrations, its indexer output and
// its first-boot settings seeding is the engine itself — so this helper boots
// the real engine once against a throwaway copy of the fixture vault with a
// fresh DB path, lets it index the 4 files, then shuts it down. What is left
// behind (a seeded vault + a real DB) is exactly what `prepareSandbox` wants
// as its `{ sourceVault, sourceDb }` input.
//
// The fixture vault under packages/bench/test-e2e/fixtures/mini-vault is
// COPIED first and never booted against directly: first boot writes
// Settings/*.md (and Settings/Models/*.md) into the vault it is pointed at,
// which would dirty the repo on every run.

import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { connectSandboxEngine } from '../../src/engine-client.js';
import { disposeSandbox, engineSpawnSpec, type SandboxPaths } from '../../src/sandbox.js';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

/** The pristine, committed 4-file vault. Read-only — always copied first. */
export const MINI_VAULT_SOURCE = join(FIXTURE_DIR, 'mini-vault');

/** Generous: a boot indexes 4 files but still runs every migration, seeds
 *  settings notes and starts the ONNX embedder subprocess. */
const SEED_BOOT_TIMEOUT_MS = 180_000;

/**
 * Copies the fixture vault to a throwaway directory, boots the engine against
 * it once with a fresh DB, and shuts it down. The returned paths are the
 * `{ sourceVault, sourceDb }` a `prepareSandbox` call consumes.
 *
 * The prefix deliberately is NOT `vault-bench-` — that prefix belongs to
 * `prepareSandbox`'s own sandboxes, and the leak assertions in pipeline.test.ts
 * scan os.tmpdir() for exactly that prefix. A seed directory sharing it would
 * make a real sandbox leak indistinguishable from this helper's own scratch
 * space.
 */
export async function buildMiniSource(): Promise<SandboxPaths> {
  const root = mkdtempSync(join(tmpdir(), 'bench-e2e-seed-'));
  const vaultPath = join(root, 'vault');
  const dbDir = join(vaultPath, '.vault-engine');
  const paths: SandboxPaths = { root, vaultPath, dbPath: join(dbDir, 'vault.db') };
  // Created BEFORE anything that can throw, so `paths` is a fully-realised
  // SandboxPaths (both `root` and `vaultPath` exist on disk) by the time the
  // catch below could ever run — which is what lets the cleanup go through
  // sandbox.ts's own guarded `disposeSandbox` instead of a bare recursive
  // rmSync. assertContained fails CLOSED on a path that doesn't resolve, so a
  // guard applied to a half-built tree would refuse to clean up at all.
  mkdirSync(dbDir, { recursive: true });
  try {
    cpSync(MINI_VAULT_SOURCE, vaultPath, { recursive: true });

    const client = await connectSandboxEngine(engineSpawnSpec(paths), SEED_BOOT_TIMEOUT_MS);
    // close() tears the whole child down (stdin end -> SIGTERM -> SIGKILL), so
    // by the time it resolves nothing is holding the DB open any more.
    await client.close();

    // The engine's own SIGTERM handler closes the DB (which checkpoints), but
    // a child that needed the SIGKILL escalation leaves a hot WAL behind, and
    // prepareSandbox's VACUUM INTO runs from a READONLY connection — which
    // cannot recover a WAL that needs it. One read-write checkpoint here folds
    // any residue into the main file so the snapshot path is never the thing
    // that fails.
    const db = new Database(paths.dbPath);
    try {
      seedReplayableTurn(db);
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }

    return paths;
  } catch (err) {
    disposeMiniSource(paths);
    throw err;
  }
}

/**
 * Writes ONE recorded chat turn into the freshly-built DB, so `extractTurns`
 * over this source returns a non-empty, replayable corpus.
 *
 * The engine builds everything else here, but it has no reason to create chat
 * history — nothing in a 4-file vault produces a conversation. Without a turn,
 * a `bench run` against this source samples zero turns, which `runBenchmark`
 * now (correctly) refuses before it prepares a sandbox. That refusal is the
 * right product behaviour and the wrong thing for the CLI failure-path tests in
 * pipeline.test.ts, which need a run that gets far enough to boot an engine so
 * they can interrupt it and assert the sandbox is cleaned up. So the corpus
 * gets a real turn rather than the guard getting an escape hatch.
 *
 * Shape: one user message, then one assistant message carrying a single
 * terminal (`output-available`) `query-nodes` call — `toolKind` 'read', so
 * `classifyTurn` returns 'single-read' and `replayable()` is true (not partial,
 * no unknown tools). Written straight to `conversations`/`messages` because
 * that is exactly what VEfO's `save-conversation` persists; the columns are the
 * engine's own (`upgradeConversationsStore`), and `message_json`/`client_state`
 * are opaque JSON blobs the engine never parses.
 */
function seedReplayableTurn(db: Database.Database): void {
  const now = new Date('2026-01-02T03:04:05.000Z').toISOString();
  db.prepare(
    'INSERT INTO conversations (id, title, created_at, updated_at, archived, client_state) VALUES (?, ?, ?, ?, 0, ?)',
  ).run('e2e-conv-1', 'e2e seeded turn', now, now, JSON.stringify({}));

  const insertMessage = db.prepare(
    'INSERT INTO messages (conversation_id, seq, role, message_json) VALUES (?, ?, ?, ?)',
  );
  insertMessage.run('e2e-conv-1', 1, 'user', JSON.stringify({
    id: 'e2e-msg-1',
    role: 'user',
    parts: [{ type: 'text', text: 'What notes are in this vault?' }],
  }));
  insertMessage.run('e2e-conv-1', 2, 'assistant', JSON.stringify({
    id: 'e2e-msg-2',
    role: 'assistant',
    parts: [
      {
        type: 'dynamic-tool',
        toolName: 'query-nodes',
        toolCallId: 'e2e-call-1',
        state: 'output-available',
        input: { limit: 5 },
        output: { ok: true, data: { nodes: [] }, warnings: [] },
      },
      { type: 'text', text: 'Here is what I found.' },
    ],
  }));
}

/**
 * Teardown for {@link buildMiniSource}'s directory.
 *
 * Routed through sandbox.ts's `disposeSandbox` rather than a bare recursive
 * `rmSync` so this delete gets the same `assertContained` guard every other
 * recursive delete in the package gets. These were the only two unguarded ones;
 * "the paths are always mkdtemp-derived so it's fine" is exactly the reasoning
 * that preceded disposeSandbox's own hardening, and this package has a
 * three-leak history in precisely this area. A containment violation here
 * SHOULD be loud — it means something is about to recursively delete outside
 * os.tmpdir() — so this deliberately does not swallow it.
 */
export function disposeMiniSource(paths: SandboxPaths): void {
  if (!existsSync(paths.root)) return; // already gone (double dispose)
  disposeSandbox(paths);
}
