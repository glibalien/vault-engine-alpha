// Cycle 4 coordinate sweep for RERANK_WEIGHTS (spec: 2026-07-09-search-rerank-blend-design.md).
// Snapshot once, memoize query embeddings, evaluate weight configs in-process
// (setRerankWeights), hybrid-only per config. Hard gate: known-item hybrid
// hit@1 = 100% AND MRR = 1.000 — violating configs are rejected. Objective
// (lexicographic): canonical hit@1 → precision MRR → topical recall@5 →
// canonical MRR; ties prefer the smaller-|weight| candidate (plateau-top).
import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/connection.js';
import { ensureMetaTable, upgradeToRicherFts } from '../src/db/migrate.js';
import { createSubprocessEmbedder } from '../src/search/embedder.js';
import type { Embedder } from '../src/search/embedder.js';
import { conceptualGoldenPath, generateKnownItem, loadConceptual } from '../src/search/bench/golden.js';
import { runSuite } from '../src/search/bench/runner.js';
import { RERANK_WEIGHTS, setRerankWeights, type RerankWeights } from '../src/search/search.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function memoizeEmbedder(inner: Embedder): Embedder {
  const cache = new Map<string, Float32Array>();
  return {
    embedDocument: (t: string) => inner.embedDocument(t),
    embedQuery: async (q: string) => {
      const hit = cache.get(q);
      if (hit) return hit;
      const v = await inner.embedQuery(q);
      cache.set(q, v);
      return v;
    },
    isReady: () => inner.isReady(),
  } as Embedder;
}

const SWEPT: Array<{ key: keyof RerankWeights; candidates: number[] }> = [
  { key: 'titleQueryCoverage', candidates: [0.15, 0.3, 0.5] },
  { key: 'titlePrecision', candidates: [0.1, 0.2, 0.4] },
  { key: 'wikiUnnamed', candidates: [-0.15, -0.3, -0.5] },
  { key: 'duplicateLoser', candidates: [-0.15, -0.3, -0.5] },
  { key: 'inboundLinks', candidates: [0, 0.1, 0.2] },
  { key: 'chatterType', candidates: [0, -0.1, -0.2] },
];

interface Objective { canonHit1: number; precMrr: number; topicalR5: number; canonMrr: number; ok: boolean }

function better(a: Objective, b: Objective, aWeight: number, bWeight: number): boolean {
  if (a.ok !== b.ok) return a.ok;
  for (const k of ['canonHit1', 'precMrr', 'topicalR5', 'canonMrr'] as const) {
    if (Math.abs(a[k] - b[k]) > 1e-9) return a[k] > b[k];
  }
  return Math.abs(aWeight) < Math.abs(bWeight); // plateau-top: least aggressive wins ties
}

async function main(): Promise<void> {
  const vault = arg('vault') ?? process.env.VAULT_PATH;
  if (!vault) {
    console.error('Usage: npx tsx scripts/sweep-rerank.ts --vault <path> --db <path> [--out <json>] [--rounds 2]');
    process.exit(1);
    return;
  }
  const liveDb = arg('db') ?? resolve(vault, '.vault-engine', 'vault.db'); // ALWAYS pass --db on prod: vault.db
  const outPath = arg('out') ?? resolve(HERE, '..', 'bench', 'sweep-rerank.json');
  const rounds = Number(arg('rounds') ?? '2');
  if (!Number.isInteger(rounds) || rounds < 1) {
    console.error('--rounds must be a positive integer, got: ' + arg('rounds'));
    process.exit(1);
  }

  const snapshot = resolve(HERE, '..', 'bench', 'sweep-rerank.bench.db');
  console.error(`Snapshotting ${liveDb} -> ${snapshot} ...`);
  const src = new Database(liveDb, { readonly: true, fileMustExist: true });
  await src.backup(snapshot);
  src.close();

  let db: ReturnType<typeof openDatabase> | undefined;
  let raw: ReturnType<typeof createSubprocessEmbedder> | undefined;
  const history: Array<{ config: RerankWeights; objective: Objective; ms: number }> = [];
  try {
    db = openDatabase(snapshot);
    ensureMetaTable(db);
    upgradeToRicherFts(db);
    raw = createSubprocessEmbedder({
      modelsDir: resolve(vault, '.vault-engine', 'models'),
      workerPath: resolve(HERE, '..', 'dist', 'search', 'embedder-worker.js'),
    });
    const embedder = memoizeEmbedder(raw);
    const known = generateKnownItem(db);
    const conceptual = loadConceptual(db, conceptualGoldenPath(resolve(HERE, '..', 'bench')));
    const cases = [...known, ...conceptual];
    console.error(`${cases.length} cases (${known.length} known-item, ${conceptual.length} conceptual)`);

    const memo = new Map<string, Objective>();

    async function evaluate(config: RerankWeights): Promise<Objective> {
      const memoKey = JSON.stringify(config);
      const memoHit = memo.get(memoKey);
      if (memoHit) {
        console.error(
          `cfg (memo) ${memoKey} -> ok=${memoHit.ok} canonHit1=${memoHit.canonHit1.toFixed(3)} precMrr=${memoHit.precMrr.toFixed(3)} topicalR5=${memoHit.topicalR5.toFixed(3)} canonMrr=${memoHit.canonMrr.toFixed(3)}`,
        );
        return memoHit;
      }
      const t0 = Date.now();
      setRerankWeights(config);
      const suite = await runSuite(db!, embedder, cases, { limit: 20, modes: ['hybrid'] });
      const m = suite.metrics;
      const o: Objective = {
        canonHit1: m.conceptualGroups.canonical.hybrid.hitAt1,
        precMrr: m.conceptualGroups.precision.hybrid.mrr,
        topicalR5: m.conceptualGroups.topical.hybrid.recallAt5,
        canonMrr: m.conceptualGroups.canonical.hybrid.mrr,
        ok: m.knownItem.hybrid.hitAt1 >= 1 - 1e-9 && m.knownItem.hybrid.mrr >= 1 - 1e-9,
      };
      memo.set(memoKey, o);
      history.push({ config, objective: o, ms: Date.now() - t0 });
      console.error(
        `cfg ${JSON.stringify(config)} -> ok=${o.ok} canonHit1=${o.canonHit1.toFixed(3)} precMrr=${o.precMrr.toFixed(3)} topicalR5=${o.topicalR5.toFixed(3)} canonMrr=${o.canonMrr.toFixed(3)} (${Math.round((Date.now() - t0) / 1000)}s)`,
      );
      return o;
    }

    let current: RerankWeights = { ...RERANK_WEIGHTS };
    let currentObj = await evaluate(current);
    for (let round = 1; round <= rounds; round++) {
      console.error(`=== round ${round} ===`);
      for (const { key, candidates } of SWEPT) {
        for (const cand of candidates) {
          if (cand === current[key]) continue;
          const cfg = { ...current, [key]: cand };
          const obj = await evaluate(cfg);
          if (better(obj, currentObj, Math.abs(cand), Math.abs(current[key] as number))) {
            current = cfg;
            currentObj = obj;
            console.error(`  -> ${String(key)} := ${cand}`);
          }
        }
      }
    }
    if (!currentObj.ok) {
      console.error('WARNING: NO evaluated config satisfied the known-item hard gate — winner is NOT ship-safe');
      process.exitCode = 1;
    }
    writeFileSync(outPath, JSON.stringify({ winner: current, objective: currentObj, history }, null, 2));
    console.log(JSON.stringify(current, null, 2));
    console.error(`Sweep complete. Winner + history written to ${outPath}`);
  } finally {
    setRerankWeights(null);
    await raw?.shutdown();
    db?.close();
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
