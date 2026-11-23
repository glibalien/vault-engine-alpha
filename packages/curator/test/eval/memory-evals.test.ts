import { describe, expect, it } from 'vitest';
import { RECONCILE_FIXTURES, scoreReconcile } from '../../src/eval/reconcile-fixtures.js';
import { CONVERSATION_FIXTURES } from '../../src/eval/conversation-fixtures.js';
import { buildReconcileUser } from '../../src/reconcile.js';
import { buildConversationUser } from '../../src/conversation-sweep.js';
import { CONVERSATION_JUDGE_SYSTEM_PROMPT, judgeConversation } from '../../src/eval/extraction.js';
import type { LlmClient, StructuredCallRequest } from '../../src/llm/types.js';

describe('reconcile eval fixtures (#605)', () => {
  it('are well formed: unique ids and pair ids, a survivor only where one must stay', () => {
    expect(new Set(RECONCILE_FIXTURES.map(f => f.id)).size).toBe(RECONCILE_FIXTURES.length);
    const memoryIds = RECONCILE_FIXTURES.flatMap(f => [f.pair.a.id, f.pair.b.id]);
    expect(new Set(memoryIds).size).toBe(memoryIds.length);
    for (const f of RECONCILE_FIXTURES) {
      if (f.expected.verdict === 'contradiction') expect(f.expected.survivor, f.id).toBeDefined();
      if (f.expected.verdict === 'distinct') expect(f.expected.survivor, f.id).toBeUndefined();
    }
  });

  it('cover every verdict and the bug shapes they guard (#349, #351, #352)', () => {
    const verdicts = new Set(RECONCILE_FIXTURES.map(f => f.expected.verdict));
    expect([...verdicts].sort()).toEqual(['contradiction', 'distinct', 'duplicate']);
    const why = RECONCILE_FIXTURES.map(f => f.why).join(' ');
    for (const issue of ['#349', '#351', '#352']) expect(why).toContain(issue);
  });

  it('render through the production user builder with each note\'s title and projects', () => {
    const f = RECONCILE_FIXTURES.find(fixture => fixture.id === 'same-wording-different-projects')!;
    const user = buildReconcileUser(f.pair);
    expect(user).toContain('MEMORY A');
    expect(user).toContain('filed under Northwind Pilot');
    expect(user).toContain('filed under Contoso Renewal');
  });

  it('score the verdict exactly, and the survivor where the fixture names one', () => {
    const [dup, change, distinct] = ['duplicate-richer-survives', 'changed-fact-newer-note-survives', 'same-wording-different-projects']
      .map(id => RECONCILE_FIXTURES.find(f => f.id === id)!);
    const fixtures = [dup!, change!, distinct!];
    const result = scoreReconcile(fixtures, [
      { verdict: 'duplicate', survivorId: dup!.pair.a.id },
      { verdict: 'contradiction', survivorId: change!.pair.a.id },
      null,
    ]);
    expect(result).toMatchObject({ correct: 1, total: 3 });
    expect(result.mismatches[0]).toContain(`duplicate-richer-survives: expected duplicate (keep ${dup!.pair.b.id}), got duplicate (keep ${dup!.pair.a.id})`);
    expect(result.mismatches[1]).toContain('same-wording-different-projects: expected distinct, got unparseable');
  });

  it('accept either survivor for an equally worded duplicate', () => {
    const f = RECONCILE_FIXTURES.find(fixture => fixture.id === 'plain-duplicate')!;
    expect(scoreReconcile([f], [{ verdict: 'duplicate', survivorId: f.pair.b.id }]).correct).toBe(1);
    expect(scoreReconcile([f], [{ verdict: 'distinct' }]).correct).toBe(0);
  });
});

describe('conversation eval fixtures (#605)', () => {
  it('each starts with the user and covers chats that should keep nothing', () => {
    expect(new Set(CONVERSATION_FIXTURES.map(f => f.title)).size).toBe(CONVERSATION_FIXTURES.length);
    for (const f of CONVERSATION_FIXTURES) expect(f.turns[0]?.role, f.title).toBe('user');
    expect(CONVERSATION_FIXTURES.filter(f => f.expected.length === 0).length).toBeGreaterThanOrEqual(3);
    expect(CONVERSATION_FIXTURES.filter(f => f.expected.length > 0).length).toBeGreaterThanOrEqual(3);
  });

  it('render through the production user builder', () => {
    const f = CONVERSATION_FIXTURES.find(fixture => fixture.title === 'Meeting-free Fridays')!;
    const user = buildConversationUser({ title: f.title }, f.turns, [], 2);
    expect(user).toContain('CONVERSATION: Meeting-free Fridays');
    expect(user).toContain('USER: Yes, do that.');
    expect(user).toContain('PER-CONVERSATION CAP: at most 2 facts.');
  });
});

describe('conversation judge (#605)', () => {
  function judgeLlm(output: unknown): { llm: LlmClient; reqs: StructuredCallRequest[] } {
    const reqs: StructuredCallRequest[] = [];
    return { reqs, llm: { structuredCall: async (req) => { reqs.push(req); return { output, usage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 } }; } } };
  }

  it('tells the judge the expected list is complete, and says so when it is empty', async () => {
    const { llm, reqs } = judgeLlm({ found: [], violations: [] });
    await judgeConversation(llm, 'm', { title: 'Contract renewal lookup', expected: [] }, []);
    expect(reqs[0]!.system).toBe(CONVERSATION_JUDGE_SYSTEM_PROMPT);
    expect(reqs[0]!.system).toContain('the expected list is complete');
    expect(reqs[0]!.user).toContain('nothing in this chat should be kept');
  });

  it('a lasting fact the user never stated costs precision', async () => {
    const kept = ['The Contoso contract renews on March 1, 2027.'];
    const { llm } = judgeLlm({ found: [], violations: kept });
    const score = await judgeConversation(llm, 'm', { title: 'Contract renewal lookup', expected: [] }, kept);
    expect(score.precision).toBe(0);
    expect(score.coverage).toBe(1);
  });
});
