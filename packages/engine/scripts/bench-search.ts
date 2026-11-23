// packages/engine/scripts/bench-search.ts
import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/connection.js';
import { ensureMetaTable, upgradeToRicherFts } from '../src/db/migrate.js';
import { createSubprocessEmbedder } from '../src/search/embedder.js';
import { conceptualGoldenPath, generateKnownItem, loadConceptual } from '../src/search/bench/golden.js';
import { assertConceptualGates, runSuite } from '../src/search/bench/runner.js';
import { buildBaseline, writeBaseline, loadBaseline, formatSummary, formatDiff } from '../src/search/bench/report.js';

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/engine/scripts

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  // Diff mode: compare two existing baseline files, no DB needed.
  if (flag('diff')) {
    const i = process.argv.indexOf('--diff');
    const beforePath = process.argv[i + 1];
    const afterPath = process.argv[i + 2];
    if (!beforePath || !afterPath) {
      console.error('Usage: npm run bench:search -- --diff <before.json> <after.json>');
      process.exit(1);
      return;
    }
    console.log(formatDiff(loadBaseline(beforePath), loadBaseline(afterPath)));
    return;
  }

  const vault = arg('vault') ?? process.env.VAULT_PATH;
  if (!vault) {
    console.error('Usage: npm run bench:search -- --vault <vaultPath> [--db <path>] [--out <path>] [--limit 20] [--no-semantic]');
    process.exit(1);
    return;
  }
  const liveDb = arg('db') ?? process.env.DB_PATH ?? resolve(vault, '.vault-engine', 'vault.db');
  const modelsDir = arg('models') ?? resolve(vault, '.vault-engine', 'models');
  const conceptualPath = arg('conceptual') ?? conceptualGoldenPath(resolve(HERE, '..', 'bench'));
  const outPath = arg('out') ?? resolve(HERE, '..', 'bench', 'baseline.json');
  const limit = Number(arg('limit') ?? '20');
  const includeSemantic = !flag('no-semantic');

  if (!existsSync(liveDb)) {
    console.error(`DB not found: ${liveDb}`);
    process.exit(1);
    return;
  }

  // 1. Online backup → consistent, read-only snapshot (never touch the live DB).
  const snapshot = resolve(HERE, '..', 'bench', 'snapshot.bench.db');
  console.error(`Snapshotting ${liveDb} -> ${snapshot} ...`);
  const src = new Database(liveDb, { readonly: true, fileMustExist: true });
  await src.backup(snapshot);
  src.close();

  let db: ReturnType<typeof openDatabase> | undefined;
  let embedder: ReturnType<typeof createSubprocessEmbedder> | undefined;
  try {
    // 2. Open snapshot + build the real subprocess embedder (worker compiled in dist/).
    db = openDatabase(snapshot);
    // The snapshot copies the live prod DB, which predates this cycle's FTS schema
    // change (nodes_fts is still title+body until Cycle 2 is deployed). Apply the FTS
    // migration so the bench measures THIS code's index (aliases/path/fields/links),
    // not the deployed one — otherwise #4a column weights tune against absent columns.
    ensureMetaTable(db);
    upgradeToRicherFts(db);
    const workerPath = resolve(HERE, '..', 'dist', 'search', 'embedder-worker.js');
    embedder = createSubprocessEmbedder({ modelsDir, workerPath });

    // 3. Build golden set.
    const known = generateKnownItem(db); // add { aliasFields: ['aliases'] } if your vault uses one
    const conceptual = loadConceptual(db, conceptualPath);
    const cases = [...known, ...conceptual];
    console.error(`Running ${cases.length} cases (${known.length} known-item, ${conceptual.length} conceptual)...`);

    // 4. Run.
    const suite = await runSuite(db, embedder, cases, { limit, includeSemantic });
    assertConceptualGates(suite.results);
    const baseline = buildBaseline(suite, liveDb, new Date().toISOString());

    // 5. Emit.
    writeBaseline(outPath, baseline);
    console.log(formatSummary(baseline));
    console.error(`\nBaseline written to ${outPath}`);
  } finally {
    await embedder?.shutdown();
    db?.close();
    // Clean up the snapshot + WAL/SHM sidecars.
    for (const suffix of ['', '-wal', '-shm']) {
      const p = snapshot + suffix;
      if (existsSync(p)) rmSync(p);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
