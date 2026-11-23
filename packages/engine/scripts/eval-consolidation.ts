/**
 * Live memory-merge eval (#605): run every case through the Engine's consolidation call, the
 * production prompt and parser, and score the operation and target exactly. Writes nothing and
 * records no usage. Needs the provider's key in the environment (the Engine's env file). Run more
 * than once when comparing prompts (results vary run to run):
 *   npm run eval:consolidation [-- --model "<Settings/Models title>"] [--db <path>] [--json]
 *   npm run eval:consolidation -- --provider openrouter --model qwen/qwen3.7-plus
 * With the Engine's database (`--db`, else DB_PATH, else VAULT_PATH/.vault-engine/vault.db), read
 * only, `--model` names a catalog entry like the Curator evals' `--model`, and no `--model` runs
 * the configured memoryConsolidationModel. `--provider` runs a raw model id without the catalog.
 * `--json` adds one result line for `npm run eval:models` (#570).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createProviderClients, providerKeysFromEnv } from '@vault/llm';
import { effectiveSettings } from '@vault/settings-registry';
import { createConsolidator, ConsolidationError, type ConsolidationVerdict } from '../src/mcp/tools/memory-consolidation.js';
import { CONSOLIDATION_EVAL_CASES, scoreConsolidation } from '../src/memories/consolidation-eval.js';
import { consolidationEvalTarget, EvalUsageTally, resultLine } from '../src/memories/consolidation-eval-run.js';
import { ModelCatalog, resolveEngineModelEntry } from '../src/settings/models.js';
import { getStoredSettings } from '../src/settings/store.js';
import { wikiTimeZone } from '../src/wiki/today.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function engineDbPath(): string | undefined {
  const path = flag('--db') ?? process.env.DB_PATH ?? (process.env.VAULT_PATH ? join(process.env.VAULT_PATH, '.vault-engine', 'vault.db') : undefined);
  if (path === undefined) return undefined;
  if (!existsSync(path)) throw new Error(`no Engine database at ${path}`);
  return path;
}

async function main(): Promise<void> {
  const dbPath = engineDbPath();
  const db = dbPath === undefined ? null : new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const settingsDir = process.env.VAULT_SETTINGS_DIR?.trim().replace(/\/+$/, '') || 'Settings';
    const catalog = db === null ? null : new ModelCatalog(db, { settingsDir, env: process.env as Record<string, string | undefined> });
    const configuredRef = db === null ? undefined : effectiveSettings<{ memoryConsolidationModel: unknown }>('engine', getStoredSettings(db, 'engine')).memoryConsolidationModel;
    const target = consolidationEvalTarget({
      provider: flag('--provider'),
      model: flag('--model'),
      catalog: catalog?.entries(),
      configured: catalog === null ? undefined : resolveEngineModelEntry(catalog, configuredRef, 'memoryConsolidationModel', 'Qwen 3.7 Plus'),
    });
    const entry = catalog?.entries().find((e) => e.model === target.model && e.provider === target.provider);
    const tally = new EvalUsageTally(target, entry?.pricing);
    const consolidator = createConsolidator(
      createProviderClients(providerKeysFromEnv(process.env)),
      { provider: target.provider, model: target.model },
      tally,
      db === null ? undefined : () => wikiTimeZone(db),
    );

    const verdicts: Array<ConsolidationVerdict | null> = [];
    for (const c of CONSOLIDATION_EVAL_CASES) {
      const started = Date.now();
      try {
        const verdict = await consolidator.consolidate(c.input);
        verdicts.push(verdict);
        console.log(`## ${c.id}\n  got ${verdict.operation}${verdict.target_id === undefined ? '' : ` ${verdict.target_id}`} — ${verdict.reason}`);
      } catch (err) {
        // A ConsolidationError came back from the model and was recorded; any other error is the
        // request itself failing.
        tally.failed(err instanceof ConsolidationError, Date.now() - started);
        verdicts.push(null);
        console.log(`## ${c.id}\n  failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const { correct, total, mismatches } = scoreConsolidation(CONSOLIDATION_EVAL_CASES, verdicts);
    console.log(`\n== consolidation eval: ${correct}/${total} exact (${target.provider} ${target.model})`);
    for (const m of mismatches) console.log(`  MISMATCH ${m}`);
    if (process.argv.includes('--json')) {
      console.log(resultLine({
        version: 1, eval: 'consolidation', score: { kind: 'exact', correct, total },
        failures: verdicts.filter((v) => v === null).length, job: tally.calls,
      }));
    }
  } finally {
    db?.close();
  }
}

main().catch((err) => {
  console.error(`[eval-consolidation] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
