import { describe, it, expect } from 'vitest';
import { synthesize, SPEC_A_SYSTEM_PROMPT } from '../../src/synthesize.js';
import { baselineProfile, resolveProfiles, VARIANT_FACTORIES } from '../../src/eval/profile.js';
import type { LlmClient, StructuredCallRequest } from '../../src/llm/types.js';
import type { Config } from '../../src/config.js';

function captureLlm(output: unknown): { llm: LlmClient; reqs: StructuredCallRequest[] } {
  const reqs: StructuredCallRequest[] = [];
  return { reqs, llm: { structuredCall: async (req) => { reqs.push(req); return { output, usage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 } }; } } };
}
const cfg = {
  wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0,
  wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit',
  model: 'm-home', homeMaxTokens: 4321, bodyCharCap: 999, semanticGapFill: false,
  fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
  fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
} as unknown as Config;
const HOME = { now: 'n', focus: [{ title: 'f' }], open_threads: [{ title: 'o' }], log_entry: 'l' };

describe('synthesize system-prompt seam', () => {
  it('defaults system to the project home prompt with date line appended', async () => {
    const { llm, reqs } = captureLlm(HOME);
    await synthesize(llm, 'm', 'EVID', 100);
    expect(reqs[0]?.system.startsWith(SPEC_A_SYSTEM_PROMPT)).toBe(true);
    expect(reqs[0]?.system).toMatch(/\n\nToday is [A-Z][a-z]+day, \d{4}-\d{2}-\d{2} \(.+\)\.$/);
  });
  it('passes a custom system through with date line appended', async () => {
    const { llm, reqs } = captureLlm(HOME);
    await synthesize(llm, 'm', 'EVID', 100, 'CUSTOM PROMPT');
    expect(reqs[0]?.system.startsWith('CUSTOM PROMPT')).toBe(true);
    expect(reqs[0]?.system).toMatch(/\n\nToday is [A-Z][a-z]+day, \d{4}-\d{2}-\d{2} \(.+\)\.$/);
  });
});
describe('profiles', () => {
  it('baselineProfile maps config fields', () => {
    const p = baselineProfile(cfg);
    expect(p).toMatchObject({ id: 'baseline', systemPrompt: SPEC_A_SYSTEM_PROMPT, maxTokens: 4321, bodyCharCap: 999, gapFill: false });
  });
  it('baselineProfile uses the home prompt override when one is set', () => {
    expect(baselineProfile({ ...cfg, curatorProjectHomePrompt: 'OWNER HOME' } as Config).systemPrompt).toBe('OWNER HOME');
  });
  it('resolveProfiles resolves known ids and throws on unknown', () => {
    expect(resolveProfiles(['baseline'], cfg).map(p => p.id)).toEqual(['baseline']);
    expect(() => resolveProfiles(['nope'], cfg)).toThrow(/unknown profile/i);
  });
});
describe('project home prompt', () => {
  it('encodes the standup + reconciliation + budget directives', () => {
    const p = SPEC_A_SYSTEM_PROMPT.toLowerCase();
    expect(p).toContain('at a glance');
    expect(p).toContain('standup');
    expect(p).toContain('ground truth');
    expect(p).toMatch(/callout|table/);
  });
});
