import { loadRuntimeConfig } from './settings.js';
import { createDispatchingLlmClient } from './llm/index.js';
import { providerForModel } from './llm/provider-for-model.js';
import { sweepSystem, EXTRACT_TOOL, parseExtractedFacts, buildExtractionUser } from './memory-sweep.js';
import { EVAL_OWNER, judgeExtraction, subjectCheck } from './eval/extraction.js';
import { EXTRACTION_FIXTURES } from './eval/extraction-fixtures.js';
import { evalModel, evalPricing } from './eval/model-ref.js';
import { CallMeter, flagValue, judgedScore, resultLine, wantsResultLine } from './eval/result.js';
import type { MemoryProposal } from './types.js';

/**
 * Live extraction eval: run every fixture through the sweep's extraction prompt,
 * judge precision/coverage with a second LLM call, print a summary. Dev tool —
 * run before enabling the sweep in prod, and after any extraction-prompt change:
 *   npm run eval:extraction [-- --model "<ref>"] [--judge-model "<ref>"] [--json]
 * The judge is the model under test unless `--judge-model` names another; comparing models,
 * keep one judge for all. `--json` adds one result line for `npm run eval:models` (#570).
 */
async function main(): Promise<void> {
  const { bootstrap, config, engine, catalog } = await loadRuntimeConfig();
  try {
    const argv = process.argv.slice(2);
    const llm = createDispatchingLlmClient(bootstrap.llmKeys, providerForModel(config.modelProviders), { reasoningEffort: config.reasoningEffort });
    const target = evalModel(catalog, config.modelProviders, config.memorySweepModel ?? config.model, flagValue(argv, '--model'));
    const judgeTarget = evalModel(catalog, config.modelProviders, target.model, flagValue(argv, '--judge-model'), '--judge-model');
    const pricing = evalPricing(config.modelPricing, catalog);
    const meter = new CallMeter(target, pricing);
    const judgeMeter = new CallMeter(judgeTarget, pricing);
    const job = meter.wrap(llm);
    const judge = judgeMeter.wrap(llm);
    const scores: Array<{ coverage: number; precision: number }> = [];
    let failures = 0;

    for (const fixture of EXTRACTION_FIXTURES) {
      console.log(`\n## ${fixture.title}`);
      let facts: MemoryProposal[];
      try {
        const { output } = await job.structuredCall({
          model: target.model,
          maxTokens: config.memorySweepMaxTokens,
          system: sweepSystem(),
          user: buildExtractionUser(fixture, [], config.memorySweepNoteCap, config.bodyCharCap, [], new Date(), undefined, EVAL_OWNER),
          toolName: EXTRACT_TOOL.name,
          toolDescription: EXTRACT_TOOL.description,
          schema: EXTRACT_TOOL.schema,
        });
        facts = parseExtractedFacts(output, config.memorySweepNoteCap);
      } catch (err) {
        // No answer is a total miss.
        failures += 1;
        scores.push({ coverage: 0, precision: 0 });
        console.log(`failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const extracted = facts.map(f => f.content);
      console.log(`extracted (${extracted.length}): ${facts.map(f => `\n  - [${f.category}] ${f.content}${f.subjects?.length ? ` {${f.subjects.join('; ')}}` : ''}`).join('') || ' (nothing)'}`);
      // Subjects by full name, never the owner (#554). Not part of the judged score.
      const subjects = subjectCheck(fixture.subjects ?? [], facts.flatMap(f => f.subjects ?? []), EVAL_OWNER);
      console.log(`subjects: ${subjects.found}/${subjects.expected} expected named, owner named ${subjects.owner}, first name alone: ${subjects.firstNameOnly.join(', ') || 'none'}`);
      // Rules on what to say should come out labelled (#626). Not part of the judged score.
      console.log(`labelled rule: ${facts.filter(f => f.category === 'rule').length} (planted rules: ${fixture.rules ?? 0})`);
      try {
        const score = await judgeExtraction(judge, judgeTarget.model, fixture, extracted);
        scores.push(score);
        console.log(`coverage ${(score.coverage * 100).toFixed(0)}%  precision ${(score.precision * 100).toFixed(0)}%`);
        if (score.verdict.violations.length > 0) {
          console.log(`violations: ${score.verdict.violations.map(v => `\n  - ${v}`).join('')}`);
        }
      } catch (err) {
        // The judge's failure says nothing about the model under test: the fixture goes unscored.
        console.log(`judge failed, not scored: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const score = judgedScore(scores, scores.length);
    console.log(`\n== extraction eval: mean coverage ${(score.coverage * 100).toFixed(0)}%, mean precision ${(score.precision * 100).toFixed(0)}% over ${scores.length} fixtures (model ${target.model}, judge ${judgeTarget.model})`);
    if (wantsResultLine(argv)) {
      console.log(resultLine({ version: 1, eval: 'extraction', score, failures, job: meter.calls, judge: judgeMeter.calls }));
    }
  } finally {
    await engine.close();
  }
}

main().catch((err) => {
  console.error(`[eval-extraction] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
