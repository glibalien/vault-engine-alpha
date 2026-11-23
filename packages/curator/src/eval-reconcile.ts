import { loadRuntimeConfig } from './settings.js';
import { createDispatchingLlmClient } from './llm/index.js';
import { providerForModel } from './llm/provider-for-model.js';
import { currentDateLine } from './date-line.js';
import { buildReconcileUser, parseReconcileVerdict, RECONCILE_MAX_TOKENS, RECONCILE_SYSTEM_PROMPT, RECONCILE_TOOL } from './reconcile.js';
import { RECONCILE_FIXTURES, scoreReconcile } from './eval/reconcile-fixtures.js';
import { evalModel, evalPricing } from './eval/model-ref.js';
import { CallMeter, flagValue, resultLine, wantsResultLine } from './eval/result.js';

/**
 * Live reconcile eval (#605): run every fixture pair through the memory reconciler's prompt, with
 * the production request, and score the verdict and survivor exactly. Writes nothing. Run on the
 * production model after a reconciler-prompt change, more than once (results vary run to run):
 *   npm run eval:reconcile [-- --model "<ref>"] [--json]
 * `--json` adds one result line for `npm run eval:models` (#570).
 */
async function main(): Promise<void> {
  const { bootstrap, config, engine, catalog } = await loadRuntimeConfig();
  try {
    const argv = process.argv.slice(2);
    const llm = createDispatchingLlmClient(bootstrap.llmKeys, providerForModel(config.modelProviders), { reasoningEffort: config.reasoningEffort });
    const target = evalModel(catalog, config.modelProviders, config.reconcileModel ?? config.model, flagValue(argv, '--model'));
    const meter = new CallMeter(target, evalPricing(config.modelPricing, catalog));
    const job = meter.wrap(llm);
    const system = `${RECONCILE_SYSTEM_PROMPT}\n\n${currentDateLine(new Date(), config.curatorTz)}`;

    const verdicts: Array<ReturnType<typeof parseReconcileVerdict>> = [];
    for (const fixture of RECONCILE_FIXTURES) {
      try {
        const { output } = await job.structuredCall({
          model: target.model, maxTokens: RECONCILE_MAX_TOKENS, system, user: buildReconcileUser(fixture.pair),
          toolName: RECONCILE_TOOL.name, toolDescription: RECONCILE_TOOL.description, schema: RECONCILE_TOOL.schema,
        });
        const verdict = parseReconcileVerdict(output, fixture.pair.a.id, fixture.pair.b.id);
        verdicts.push(verdict);
        const reason = output && typeof output === 'object' ? (output as Record<string, unknown>).reason : undefined;
        console.log(`## ${fixture.id}\n  got ${verdict === null ? 'unparseable' : `${verdict.verdict}${verdict.survivorId === undefined ? '' : ` (keep ${verdict.survivorId})`}`}${typeof reason === 'string' ? ` — ${reason}` : ''}`);
      } catch (err) {
        verdicts.push(null);
        console.log(`## ${fixture.id}\n  failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const { correct, total, mismatches } = scoreReconcile(RECONCILE_FIXTURES, verdicts);
    console.log(`\n== reconcile eval: ${correct}/${total} exact (model ${target.model})`);
    for (const m of mismatches) console.log(`  MISMATCH ${m}`);
    if (wantsResultLine(argv)) {
      console.log(resultLine({
        version: 1, eval: 'reconcile', score: { kind: 'exact', correct, total },
        failures: verdicts.filter(v => v === null).length, job: meter.calls,
      }));
    }
  } finally {
    await engine.close();
  }
}

main().catch((err) => {
  console.error(`[eval-reconcile] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
