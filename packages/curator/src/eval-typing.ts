import { loadRuntimeConfig } from './settings.js';
import { createDispatchingLlmClient } from './llm/index.js';
import { providerForModel } from './llm/provider-for-model.js';
import { buildClassifySystem, buildClassifyTool, buildClassifyUser, parseTypeVerdict } from './org-sweep.js';
import { EVAL_CATALOG, TYPING_FIXTURES, scoreTyping } from './eval/typing-fixtures.js';
import { evalModel, evalPricing } from './eval/model-ref.js';
import { CallMeter, flagValue, resultLine, wantsResultLine } from './eval/result.js';

/**
 * Live typing eval: run every fixture through the org sweep's classification
 * prompt and score exact-match against the expected type. Dev tool — run
 * against the PROD model before enabling the sweep, and after prompt changes:
 *   npm run eval:typing [-- --model "<ref>"] [--json]
 * `--json` adds one result line for `npm run eval:models` (#570).
 */
async function main(): Promise<void> {
  const { bootstrap, config, engine, catalog } = await loadRuntimeConfig();
  try {
    const argv = process.argv.slice(2);
    const llm = createDispatchingLlmClient(bootstrap.llmKeys, providerForModel(config.modelProviders), { reasoningEffort: config.reasoningEffort });
    const target = evalModel(catalog, config.modelProviders, config.orgSweepModel ?? config.model, flagValue(argv, '--model'));
    const meter = new CallMeter(target, evalPricing(config.modelPricing, catalog));
    const job = meter.wrap(llm);
    const typeNames = EVAL_CATALOG.map(s => s.name);
    const system = buildClassifySystem(EVAL_CATALOG);
    const tool = buildClassifyTool(typeNames);

    // undefined: no usable answer (the call failed), scored as a miss.
    const verdicts: (string | null | undefined)[] = [];
    for (const fixture of TYPING_FIXTURES) {
      try {
        const { output } = await job.structuredCall({
          model: target.model,
          maxTokens: config.orgSweepMaxTokens,
          system,
          user: buildClassifyUser(fixture, config.bodyCharCap),
          toolName: tool.name,
          toolDescription: tool.description,
          schema: tool.schema,
        });
        const verdict = parseTypeVerdict(output, typeNames);
        verdicts.push(verdict.type);
        console.log(`## ${fixture.title}\n  expected ${fixture.expected ?? 'null'} — got ${verdict.type ?? 'null'}${verdict.reason ? ` (${verdict.reason})` : ''}`);
      } catch (err) {
        verdicts.push(undefined);
        console.log(`## ${fixture.title}\n  failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // A failed call never matches: no type is named "(call failed)".
    const { correct, total, mismatches } = scoreTyping(TYPING_FIXTURES, verdicts.map(v => (v === undefined ? '(call failed)' : v)));
    console.log(`\n== typing eval: ${correct}/${total} exact (model ${target.model})`);
    for (const m of mismatches) console.log(`  MISMATCH ${m}`);
    if (wantsResultLine(argv)) {
      console.log(resultLine({
        version: 1, eval: 'typing', score: { kind: 'exact', correct, total },
        failures: verdicts.filter(v => v === undefined).length, job: meter.calls,
      }));
    }
  } finally {
    await engine.close();
  }
}

main().catch((err) => {
  console.error(`[eval-typing] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
