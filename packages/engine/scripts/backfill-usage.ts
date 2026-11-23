// One-time curator-runs → usage_events backfill. Run once at deploy:
//
//   npx tsx packages/engine/scripts/backfill-usage.ts \
//     --curator-db <path to curator.db> \
//     --engine-db  <path to the engine DB (prod: vault.db)> \
//     --era 2026-01-01T00:00:00Z=anthropic/claude-sonnet-4-6 \
//     --era 2026-06-29T00:00:00Z=fireworks/accounts/fireworks/models/deepseek-v4-pro
//
// Eras map time ranges to the model the curator actually ran (runs rows have
// no model column). An era's value is provider/model, split on the FIRST '/'.
// Idempotent — safe to re-run.
import Database from 'better-sqlite3';
import { backfillRuns, type BackfillEra } from '../src/usage/backfill.js';

function parseCliArgs(argv: string[]): { curatorDb: string; engineDb: string; eras: BackfillEra[] } {
  let curatorDb = '';
  let engineDb = '';
  const eras: BackfillEra[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--curator-db') curatorDb = argv[++i] ?? '';
    else if (a === '--engine-db') engineDb = argv[++i] ?? '';
    else if (a === '--era') {
      const raw = argv[++i] ?? '';
      const eq = raw.indexOf('=');
      const slash = raw.indexOf('/', eq + 1);
      if (eq < 0 || slash < 0) throw new Error(`--era expects <ISO>=<provider>/<model>, got: ${raw}`);
      const provider = raw.slice(eq + 1, slash);
      if (provider !== 'anthropic' && provider !== 'fireworks') {
        throw new Error(`--era provider must be anthropic|fireworks, got: ${provider}`);
      }
      eras.push({ since: raw.slice(0, eq), provider, model: raw.slice(slash + 1) });
    }
  }
  if (!curatorDb || !engineDb || eras.length === 0) {
    throw new Error('usage: --curator-db <path> --engine-db <path> --era <ISO>=<provider>/<model> [--era ...]');
  }
  return { curatorDb, engineDb, eras };
}

const { curatorDb, engineDb, eras } = parseCliArgs(process.argv.slice(2));
const curator = new Database(curatorDb, { readonly: true });
const engine = new Database(engineDb);
try {
  const stats = backfillRuns(curator, engine, eras);
  console.log(`backfill complete: ${stats.inserted} inserted, ${stats.skipped} already present, ${stats.unpriced} unpriced`);
} finally {
  curator.close();
  engine.close();
}
