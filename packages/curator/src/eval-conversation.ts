import { loadRuntimeConfig } from './settings.js';
import { createDispatchingLlmClient } from './llm/index.js';
import { providerForModel } from './llm/provider-for-model.js';
import { buildConversationUser, conversationSystem, CONVERSATION_EXTRACT_SYSTEM_PROMPT } from './conversation-sweep.js';
import { EXTRACT_TOOL, parseExtractedFacts } from './memory-extract.js';
import { judgeConversation, subjectCheck } from './eval/extraction.js';
import { CONVERSATION_FIXTURES } from './eval/conversation-fixtures.js';
import { evalModel, evalPricing } from './eval/model-ref.js';
import { CallMeter, flagValue, judgedScore, resultLine, wantsResultLine } from './eval/result.js';
import type { MemoryProposal } from './types.js';

/**
 * Live conversation-sweep eval (#605): run every fixture chat through the conversation sweep's
 * prompt, with the production request, and judge the facts it keeps (coverage and precision). Each
 * fixture's expected list is complete, so any kept fact outside it costs precision. Writes nothing.
 * Run on the production model after a change to the conversation-sweep prompt, more than once
 * (results vary run to run):
 *   npm run eval:conversation [-- --model "<ref>"] [--judge-model "<ref>"] [--json]
 * The judge is the model under test unless `--judge-model` names another; comparing models,
 * keep one judge for all. `--json` adds one result line for `npm run eval:models` (#570).
 */
async function main(): Promise<void> {
  const { bootstrap, config, engine, catalog } = await loadRuntimeConfig();
  try {
    const argv = process.argv.slice(2);
    const llm = createDispatchingLlmClient(bootstrap.llmKeys, providerForModel(config.modelProviders), { reasoningEffort: config.reasoningEffort });
    const target = evalModel(catalog, config.modelProviders, config.conversationSweepModel ?? config.model, flagValue(argv, '--model'));
    const judgeTarget = evalModel(catalog, config.modelProviders, target.model, flagValue(argv, '--judge-model'), '--judge-model');
    const pricing = evalPricing(config.modelPricing, catalog);
    const meter = new CallMeter(target, pricing);
    const judgeMeter = new CallMeter(judgeTarget, pricing);
    const job = meter.wrap(llm);
    const judge = judgeMeter.wrap(llm);
    const cap = config.conversationSweepPerConversationCap;
    const scores: Array<{ coverage: number; precision: number }> = [];
    let failures = 0;

    for (const fixture of CONVERSATION_FIXTURES) {
      console.log(`\n## ${fixture.title}`);
      let facts: MemoryProposal[];
      try {
        const { output } = await job.structuredCall({
          model: target.model,
          maxTokens: config.conversationSweepMaxTokens,
          system: conversationSystem(new Date(), config.curatorConversationSweepPrompt ?? CONVERSATION_EXTRACT_SYSTEM_PROMPT, config.curatorTz),
          user: buildConversationUser({ title: fixture.title }, fixture.turns, [], cap),
          toolName: EXTRACT_TOOL.name,
          toolDescription: EXTRACT_TOOL.description,
          schema: EXTRACT_TOOL.schema,
        });
        facts = parseExtractedFacts(output, cap);
      } catch (err) {
        // No answer is a total miss.
        failures += 1;
        scores.push({ coverage: 0, precision: 0 });
        console.log(`failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const extracted = facts.map(f => f.content);
      console.log(`kept (${extracted.length}): ${facts.map(f => `\n  - [${f.category}] ${f.content}${f.subjects?.length ? ` {${f.subjects.join('; ')}}` : ''}`).join('') || ' (nothing)'}`);
      // Subjects by full name, never the user (#554). Not part of the judged score.
      const subjects = subjectCheck(fixture.subjects ?? [], facts.flatMap(f => f.subjects ?? []), null);
      console.log(`subjects: ${subjects.found}/${subjects.expected} expected named, first name alone: ${subjects.firstNameOnly.join(', ') || 'none'}, all: ${facts.flatMap(f => f.subjects ?? []).join('; ') || 'none'}`);
      // Rules on what to say should come out labelled (#626). Not part of the judged score.
      console.log(`labelled rule: ${facts.filter(f => f.category === 'rule').length} (planted rules: ${fixture.rules ?? 0})`);
      try {
        const score = await judgeConversation(judge, judgeTarget.model, fixture, extracted);
        scores.push(score);
        console.log(`coverage ${(score.coverage * 100).toFixed(0)}%  precision ${(score.precision * 100).toFixed(0)}%`);
        if (score.verdict.violations.length > 0) {
          console.log(`violations: ${score.verdict.violations.map(v => `\n  - ${v}`).join('')}`);
        }
      } catch (err) {
        // The judge's failure says nothing about the model under test: the chat goes unscored.
        console.log(`judge failed, not scored: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const score = judgedScore(scores, scores.length);
    console.log(`\n== conversation eval: mean coverage ${(score.coverage * 100).toFixed(0)}%, mean precision ${(score.precision * 100).toFixed(0)}% over ${scores.length} chats (model ${target.model}, judge ${judgeTarget.model})`);
    if (wantsResultLine(argv)) {
      console.log(resultLine({ version: 1, eval: 'conversation', score, failures, job: meter.calls, judge: judgeMeter.calls }));
    }
  } finally {
    await engine.close();
  }
}

main().catch((err) => {
  console.error(`[eval-conversation] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
