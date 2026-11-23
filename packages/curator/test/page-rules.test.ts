import { describe, expect, it, vi } from 'vitest';
import { checkPageRules, pageRules, RULES_HEADING, rulesInSection, rulesSectionText, withoutRulesSection, withRulesSection } from '../src/page-rules.js';
import { PageSynthesisError, synthesizeAcceptedPages } from '../src/page-synthesis.js';
import { pageEvidenceWithMemories, type PageSourceSelection } from '../src/provenance-page-evidence.js';
import { renderConflicts } from '../src/wiki-memories.js';
import type { LlmClient, StructuredCallRequest } from '../src/llm/types.js';
import type { EngineNode, ExistingWiki, Memory, TopologyPlan, WikiScopeV1 } from '../src/types.js';

const scope = (facet: string): WikiScopeV1 => ({ v: 1, subject: 'Atlas', facet });
const memory = (id: number, content: string, extra: Partial<Memory> = {}): Memory => ({ id, source: 'curator', scope: 'vault', node_id: null,
  content, category: 'preference', created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', ...extra });
const naming = memory(7, 'Call the Acme integration "native, embedded", never "headless".');
const dates = memory(9, 'Give Acme no date for the embedded release; say "early December" ($0 extra).');
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

describe('the rules section (#474 idea 4)', () => {
  it('writes each rule under the fixed heading with its memory, after the page, and replaces an older section', () => {
    const page = withRulesSection('## Summary\n\nThe pilot is live.', [naming, dates]);
    expect(page).toBe(`## Summary\n\nThe pilot is live.\n\n## ${RULES_HEADING}\n\n`
      + '- Call the Acme integration "native, embedded", never "headless". <!-- memory:7 -->\n'
      + '- Give Acme no date for the embedded release; say "early December" (\\$0 extra). <!-- memory:9 -->');
    expect(rulesInSection(page)).toEqual([7, 9]);
    expect(withRulesSection(page, [dates])).toBe(`## Summary\n\nThe pilot is live.\n\n## ${RULES_HEADING}\n\n`
      + '- Give Acme no date for the embedded release; say "early December" (\\$0 extra). <!-- memory:9 -->');
    expect(withRulesSection(page, [])).toBe('## Summary\n\nThe pilot is live.');
  });

  it('takes the section out from the middle of a page, and reads its ids only from the section', () => {
    const page = `## Summary\n\nSee <!-- memory:3 --> here.\n\n## ${RULES_HEADING}\n\n- One. <!-- memory:5 -->\n\n## History\n\nOld.`;
    expect(withoutRulesSection(page)).toBe('## Summary\n\nSee <!-- memory:3 --> here.\n\n## History\n\nOld.');
    expect(rulesInSection(page)).toEqual([5]);
    expect(rulesSectionText(page)).toBe(`## ${RULES_HEADING}\n\n- One. <!-- memory:5 -->`);
    expect(rulesSectionText('## Summary\n\nNone.')).toBeNull();
  });

  it('keeps a page\'s rules while the build still sees their memories, then adds the ones the planner marked', () => {
    const current = withRulesSection('## Summary\n\nText.', [dates, memory(11, 'Expired rule.')]);
    expect(pageRules([7, 404], current, [naming, dates]).map(rule => rule.id)).toEqual([9, 7]);
  });
});

describe('the rule check (#474 idea 4)', () => {
  const llm = (output: unknown): LlmClient & { calls: StructuredCallRequest[] } => {
    const calls: StructuredCallRequest[] = [];
    return { calls, structuredCall: async request => { calls.push(request); return { output, usage }; } };
  };

  it('returns the rules the page breaks, by number, and judges the page without its rules section', async () => {
    const client = llm({ broken: [{ rule: 2, words: 'ships on Dec 3' }, { rule: 9, words: 'made up' }] });
    const result = await checkPageRules(client, { model: 'm', maxTokens: 100, rules: [naming, dates],
      body: withRulesSection('## Summary\n\nThe embedded app ships on Dec 3.', [naming, dates]) });
    expect(result.broken).toEqual([{ rule: dates, words: 'ships on Dec 3' }]);
    const user = JSON.parse(client.calls[0]!.user);
    expect(user.rules).toEqual([`1. ${naming.content}`, `2. ${dates.content}`]);
    expect(user.page).toBe('## Summary\n\nThe embedded app ships on Dec 3.');
  });

  it('lets the page stand when the check gives no ruling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await checkPageRules(llm({ verdict: 'fine' }), { model: 'm', maxTokens: 100, rules: [naming], body: 'x' })).broken).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('a page with rules (#474 idea 4)', () => {
  const wiki: ExistingWiki = { home_id: 'home', home: { id: 'home', version: 1 }, topology_hash: 't', catalog_valid: true,
    subpages: [{ id: 'risks', title: 'Atlas — Risks', file_path: 'Wikis/Risks.md', version: 2, content_hash: 'h',
      wiki_state: 'active', wiki_kind: 'risk-register', wiki_origin: 'automatic', wiki_scope: scope('risks'), wiki_pinned: false }] };
  const note: EngineNode = { id: 'n1', title: 'Kickoff', types: ['meeting'], fields: {}, body: 'The embedded app ships on Dec 3.' };
  const create: TopologyPlan = { reviewed_page_ids: ['risks'], actions: [
    { op: 'create', plan_key: 'msg', title: 'Atlas — Messaging', kind: 'freeform', scope: scope('messaging'), synthesis_brief: 'Messaging.' },
  ] };
  const refresh: TopologyPlan = { reviewed_page_ids: ['risks'], actions: [
    { op: 'refresh', node_id: 'risks', scope: scope('risks'), synthesis_brief: 'Risks.' },
  ] };

  /** Page drafts in order, and the rule check's rulings in order. */
  function harness(drafts: string[], rulings: Array<Array<{ rule: number; words: string }>>, pageBody = '## Risks\n\nNone.') {
    const calls: StructuredCallRequest[] = [];
    const llm: LlmClient = { structuredCall: async request => {
      calls.push(request);
      if (request.toolName === 'emit_rule_check') return { output: { broken: rulings.shift() ?? [] }, usage };
      return { output: { body: drafts.shift() ?? '## Summary\n\nDraft.' }, usage };
    } };
    const reader = { getNode: async (id: string): Promise<EngineNode> =>
      ({ id, title: 'Atlas — Risks', types: ['wiki'], fields: {}, body: `<!-- ve:managed:Summary -->\n${pageBody}\n<!-- /ve:managed:Summary -->` }) };
    return { calls, llm, reader };
  }

  it('shows the writer its rules, checks the page, and writes the rules onto it', async () => {
    const h = harness(['## Summary\n\nWe call it native, embedded.'], [[]]);
    const result = await synthesizeAcceptedPages(h.llm, h.reader, { model: 'm', plan: create, existingWiki: wiki, evidenceNodes: [note],
      memories: [naming, dates], ruleIdsByTarget: { 'plan:msg': [7] }, checkRules: true });
    const [page, check] = h.calls;
    expect(JSON.parse(page!.user).evidence).toContain(`## RULES FOR THIS PAGE`);
    expect(JSON.parse(page!.user).evidence).toContain(`- ${naming.content}`);
    expect(check!.toolName).toBe('emit_rule_check');
    expect(result.pages[0]!.body).toBe(`## Summary\n\nWe call it native, embedded.\n\n## ${RULES_HEADING}\n\n- ${naming.content} <!-- memory:7 -->`);
    // The check is paid for like any page call.
    expect(result.usage.input).toBe(2);
  });

  it('shows the page the project\'s people with notes and the people named without one', async () => {
    const h = harness(['## Summary\n\nDraft.'], []);
    await synthesizeAcceptedPages(h.llm, h.reader, { model: 'm', plan: create, existingWiki: wiki, evidenceNodes: [note],
      contacts: { people: [{ id: 'p1', title: 'Dana Okafor', companies: [], direct: true, meeting_count: 0, last_seen: null }], companies: [],
        unlinked: [{ name: 'Sam Rivera', direct: false, meeting_count: 2 }] } });
    const evidence = JSON.parse(h.calls[0]!.user).evidence as string;
    expect(evidence).toContain('- Dana Okafor (project contact)\n\n## PEOPLE NAMED WITHOUT A NOTE');
    expect(evidence).toContain('- Sam Rivera (2 project meetings)');
  });

  it('gives a page that breaks a rule one more try, told which rule and where', async () => {
    const h = harness(['## Summary\n\nIt is headless.', '## Summary\n\nIt is native, embedded.'], [[{ rule: 1, words: 'It is headless.' }], []]);
    const result = await synthesizeAcceptedPages(h.llm, h.reader, { model: 'm', plan: create, existingWiki: wiki, evidenceNodes: [note],
      memories: [naming], ruleIdsByTarget: { 'plan:msg': [7] }, checkRules: true });
    expect(h.calls.map(call => call.toolName === 'emit_rule_check' ? 'check' : 'page')).toEqual(['page', 'check', 'page', 'check']);
    expect(h.calls[0]!.system).not.toContain('broke these rules');
    expect(h.calls[2]!.system).toContain('broke these rules');
    expect(h.calls[2]!.system).toContain('Your words: "It is headless."');
    expect(result.pages[0]!.body).toContain('It is native, embedded.');
  });

  it('holds a page that still breaks a rule, when asked, and goes on to the next page', async () => {
    const two: TopologyPlan = { reviewed_page_ids: ['risks'], actions: [...create.actions,
      { op: 'create', plan_key: 'next', title: 'Atlas — Next', kind: 'freeform', scope: scope('next'), synthesis_brief: 'Next.' }] };
    const h = harness(['## Summary\n\nIt is headless.', '## Summary\n\nStill headless.', '## Summary\n\nNext page.'],
      [[{ rule: 1, words: 'It is headless.' }], [{ rule: 1, words: 'Still headless.' }]]);
    const result = await synthesizeAcceptedPages(h.llm, h.reader, { model: 'm', plan: two, existingWiki: wiki, evidenceNodes: [note],
      memories: [naming], ruleIdsByTarget: { 'plan:msg': [7] }, checkRules: true, holdRuleBreaks: true });
    expect(result.held).toEqual([{ target: { plan_key: 'msg' }, title: 'Atlas — Messaging', detail: expect.stringMatching(/memory 7/) }]);
    expect(result.pages.map(page => page.target)).toEqual([{ plan_key: 'next' }]);
  });

  it('fails the call when the page still breaks a rule and holding is off (a single-page rebuild)', async () => {
    const h = harness(['## Summary\n\nIt is headless.', '## Summary\n\nStill headless.'],
      [[{ rule: 1, words: 'It is headless.' }], [{ rule: 1, words: 'Still headless.' }]]);
    const run = synthesizeAcceptedPages(h.llm, h.reader, { model: 'm', plan: create, existingWiki: wiki, evidenceNodes: [note],
      memories: [naming], ruleIdsByTarget: { 'plan:msg': [7] }, checkRules: true });
    await expect(run).rejects.toThrow(PageSynthesisError);
    await expect(run).rejects.toThrow(/breaks a rule on what to say: memory 7 \("Still headless\."\)/);
  });

  it('keeps the rules already on a page without the planner marking them again, and hides them from the writer', async () => {
    const onPage = withRulesSection('## Risks\n\nNone.', [naming]);
    const h = harness(['## Risks\n\nStill none.'], [[]], onPage);
    const result = await synthesizeAcceptedPages(h.llm, h.reader, { model: 'm', plan: refresh, existingWiki: wiki, evidenceNodes: [note],
      memories: [naming, dates], ruleIdsByTarget: {}, checkRules: true });
    expect(JSON.parse(h.calls[0]!.user).current_target.body).not.toContain(RULES_HEADING);
    expect(result.pages[0]!.body).toBe(`## Risks\n\nStill none.\n\n## ${RULES_HEADING}\n\n- ${naming.content} <!-- memory:7 -->`);
  });

  it('keeps a rule whose memory is live but outside the build\'s memories, and drops one whose memory is gone', async () => {
    const onPage = withRulesSection('## Risks\n\nNone.', [dates, naming]);
    const asked: number[][] = [];
    const h = harness(['## Risks\n\nStill none.'], [[]], onPage);
    const result = await synthesizeAcceptedPages(h.llm, h.reader, { model: 'm', plan: refresh, existingWiki: wiki, evidenceNodes: [note],
      memories: [memory(1, 'Some newer fact.')], ruleIdsByTarget: {}, checkRules: true,
      loadRuleMemories: async ids => { asked.push([...ids]); return [dates]; } });
    expect(asked).toEqual([[9, 7]]);
    expect(result.pages[0]!.body).toBe(withRulesSection('## Risks\n\nStill none.', [dates]));
  });

  it('writes a checkpointed page again when its rules rest on a memory outside the build\'s set', async () => {
    const reusedBody = withRulesSection('## Summary\n\nSaved.', [dates]);
    const reuse = () => ({ target: { plan_key: 'msg' }, body: reusedBody, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const outside = harness(['## Summary\n\nFresh.'], [[]]);
    const fresh = await synthesizeAcceptedPages(outside.llm, outside.reader, { model: 'm', plan: create, existingWiki: wiki, evidenceNodes: [note],
      memories: [naming], reuse, checkRules: true, loadRuleMemories: async () => [dates] });
    expect(outside.calls.length).toBeGreaterThan(0);
    expect(fresh.pages[0]!.body).toContain('Fresh.');
    const inside = harness([], []);
    const kept = await synthesizeAcceptedPages(inside.llm, inside.reader, { model: 'm', plan: create, existingWiki: wiki, evidenceNodes: [note],
      memories: [naming, dates], reuse, checkRules: true });
    expect(inside.calls).toHaveLength(0);
    expect(kept.pages[0]!.body).toBe(reusedBody);
  });

  it('carries the rules section as it is when the live check fails, and drops unseen rules without a loader', async () => {
    const onPage = withRulesSection('## Risks\n\nNone.', [dates]);
    const failing = harness(['## Risks\n\nStill none.'], [], onPage);
    const carried = await synthesizeAcceptedPages(failing.llm, failing.reader, { model: 'm', plan: refresh, existingWiki: wiki, evidenceNodes: [note],
      memories: [naming], loadRuleMemories: async () => { throw new Error('engine down'); } });
    expect(carried.pages[0]!.body).toBe(`## Risks\n\nStill none.\n\n${rulesSectionText(onPage)}`);
    const plain = harness(['## Risks\n\nStill none.'], [], onPage);
    const dropped = await synthesizeAcceptedPages(plain.llm, plain.reader, { model: 'm', plan: refresh, existingWiki: wiki, evidenceNodes: [note],
      memories: [naming] });
    expect(dropped.pages[0]!.body).toBe('## Risks\n\nStill none.');
  });

  it('carries a page\'s rules over as they are when the build has no memories, and checks nothing', async () => {
    const onPage = withRulesSection('## Risks\n\nNone.', [naming]);
    const h = harness(['## Risks\n\nStill none.'], [], onPage);
    const result = await synthesizeAcceptedPages(h.llm, h.reader, { model: 'm', plan: refresh, existingWiki: wiki, evidenceNodes: [note],
      memories: [], ruleIdsByTarget: {} });
    expect(h.calls).toHaveLength(1);
    expect(result.pages[0]!.body).toBe(`## Risks\n\nStill none.\n\n${rulesSectionText(onPage)}`);
  });

  it('keeps a page\'s rules on a single-page rebuild or requested page, which has no planner, and makes no extra call there', async () => {
    const onPage = withRulesSection('## Risks\n\nNone.', [naming]);
    const h = harness(['## Risks\n\nStill none.'], [], onPage);
    const result = await synthesizeAcceptedPages(h.llm, h.reader, { model: 'm', plan: refresh, existingWiki: wiki, evidenceNodes: [note],
      memories: [naming] });
    expect(h.calls).toHaveLength(1);
    expect(JSON.parse(h.calls[0]!.user).evidence).toContain('## RULES FOR THIS PAGE');
    expect(result.pages[0]!.body).toBe(`## Risks\n\nStill none.\n\n## ${RULES_HEADING}\n\n- ${naming.content} <!-- memory:7 -->`);
  });

  it('checks with the page call\'s own cap, which any reasoning budget on the page stage already fits', async () => {
    const h = harness(['## Summary\n\nNative, embedded.'], [[]]);
    await synthesizeAcceptedPages(h.llm, h.reader, { model: 'm', plan: create, existingWiki: wiki, evidenceNodes: [note],
      memories: [naming], ruleIdsByTarget: { 'plan:msg': [7] }, checkRules: true, maxTokens: 6_000 });
    expect(h.calls[1]!.toolName).toBe('emit_rule_check');
    expect(h.calls[1]!.maxTokens).toBe(6_000);
  });

  it('owns its heading on a project page: a section the writer wrote under it is dropped', async () => {
    const h = harness([`## Summary\n\nText.\n\n## ${RULES_HEADING}\n\n- Written by the model.`], []);
    const result = await synthesizeAcceptedPages(h.llm, h.reader, { model: 'm', plan: create, existingWiki: wiki, evidenceNodes: [note],
      memories: [naming] });
    expect(h.calls).toHaveLength(1);
    expect(result.pages[0]!.body).toBe('## Summary\n\nText.');
  });

  it('checks the page\'s new Log line too, since it is published with the page', async () => {
    const calls: StructuredCallRequest[] = [];
    const llm: LlmClient = { structuredCall: async request => {
      calls.push(request);
      return request.toolName === 'emit_rule_check' ? { output: { broken: [] }, usage }
        : { output: { body: '## Summary\n\nNative, embedded.', log_note: 'Renamed from headless.' }, usage };
    } };
    await synthesizeAcceptedPages(llm, { getNode: async () => { throw new Error('no reads'); } }, { model: 'm', plan: create, existingWiki: wiki,
      evidenceNodes: [note], memories: [naming], ruleIdsByTarget: { 'plan:msg': [7] }, checkRules: true });
    expect(JSON.parse(calls[1]!.user).log_note).toBe('Renamed from headless.');
  });

  it('carries the rules of the merged pages too when the build has no memories', async () => {
    const merge: TopologyPlan = { reviewed_page_ids: ['risks', 'old'], actions: [
      { op: 'merge', target: { plan_key: 'msg' }, sources: ['risks', 'old'], scope: scope('messaging'), reason: 'r', synthesis_brief: 'M' },
      { op: 'create', plan_key: 'msg', title: 'Atlas — Messaging', kind: 'freeform', scope: scope('messaging'), synthesis_brief: 'M' },
    ] };
    const twoPages: ExistingWiki = { ...wiki, subpages: [...wiki.subpages, { ...wiki.subpages[0]!, id: 'old', title: 'Atlas — Old' }] };
    const bodies: Record<string, string> = { risks: withRulesSection('## A\n\nA.', [naming]), old: withRulesSection('## B\n\nB.', [dates, naming]) };
    const calls: StructuredCallRequest[] = [];
    const llm: LlmClient = { structuredCall: async request => { calls.push(request); return { output: { body: '## Merged\n\nText.' }, usage }; } };
    const result = await synthesizeAcceptedPages(llm, { getNode: async (id: string) => ({ id, title: id, types: ['wiki'], fields: {}, body: bodies[id]! }) },
      { model: 'm', plan: merge, existingWiki: twoPages, evidenceNodes: [note], memories: [] });
    expect(result.pages[0]!.body).toBe(`## Merged\n\nText.\n\n## ${RULES_HEADING}\n\n- ${naming.content} <!-- memory:7 -->\n`
      + '- Give Acme no date for the embedded release; say "early December" (\\$0 extra). <!-- memory:9 -->');
  });
});

describe('a page\'s evidence with conflicts and rules (#474 idea 4)', () => {
  it('puts unsettled conflicts after the memories and still attributes each rule line to its memory', () => {
    const observed = (m: Memory): Memory => ({ ...m, provenance_observation: { authority: 'engine', source: { kind: 'memory', native_id: String(m.id) } } as never });
    const selection: PageSourceSelection = { generatedAt: new Date(), items: [], omissions: [] };
    const text = pageEvidenceWithMemories([], [], null, new Set(), [observed(naming)], selection, 'project', '', [observed(dates)], [],
      renderConflicts([{ a: memory(1, 'Headcount is 40.'), b: memory(2, 'Headcount is 55.') }]));
    expect(text).toContain('## UNSETTLED CONFLICTS');
    expect(text.indexOf('## UNSETTLED CONFLICTS')).toBeLessThan(text.indexOf('## RULES FOR THIS PAGE'));
    const ruleItem = selection.items.at(-1)!;
    const bytes = Buffer.from(text);
    expect(bytes.subarray(ruleItem.spans[0]!.start, ruleItem.spans[0]!.end).toString()).toBe(`- ${dates.content}`);
  });
});

