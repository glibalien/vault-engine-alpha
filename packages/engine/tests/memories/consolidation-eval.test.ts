import { describe, expect, it } from 'vitest';
import { CONSOLIDATION_EVAL_CASES, scoreConsolidation } from '../../src/memories/consolidation-eval.js';
import { buildUserPrompt, parseConsolidationResponse } from '../../src/mcp/tools/memory-consolidation.js';

describe('memory-merge eval cases (#605)', () => {
  it('are well formed: unique ids, a target from the candidates exactly when the operation needs one', () => {
    expect(new Set(CONSOLIDATION_EVAL_CASES.map(c => c.id)).size).toBe(CONSOLIDATION_EVAL_CASES.length);
    for (const c of CONSOLIDATION_EVAL_CASES) {
      const ids = new Set(c.input.candidates.map(candidate => candidate.id));
      if (c.expected.operation === 'add') expect(c.expected.targetId, c.id).toBeUndefined();
      else expect(ids.has(c.expected.targetId!), c.id).toBe(true);
    }
  });

  it('cover every operation and the bug shapes they guard (#349, #352)', () => {
    expect([...new Set(CONSOLIDATION_EVAL_CASES.map(c => c.expected.operation))].sort()).toEqual(['add', 'contradict', 'noop', 'update']);
    const why = CONSOLIDATION_EVAL_CASES.map(c => c.why).join(' ');
    expect(why).toContain('#349');
    expect(why).toContain('#352');
  });

  it('render through the production user prompt with each note\'s title and projects', () => {
    const c = CONSOLIDATION_EVAL_CASES.find(e => e.id === 'add-same-wording-other-project')!;
    const prompt = buildUserPrompt(c.input);
    expect(prompt).toContain('filed under Contoso Renewal');
    expect(prompt).toContain('filed under Northwind Pilot');
  });

  it('expected answers parse with the production parser', () => {
    for (const c of CONSOLIDATION_EVAL_CASES) {
      const answer = JSON.stringify({ operation: c.expected.operation, target_id: c.expected.targetId ?? null, valid_at: null, reason: 'r' });
      const verdict = parseConsolidationResponse(answer, new Set(c.input.candidates.map(candidate => candidate.id)));
      expect(scoreConsolidation([c], [verdict]).correct, c.id).toBe(1);
    }
  });

  it('score the operation and target exactly', () => {
    const update = CONSOLIDATION_EVAL_CASES.find(c => c.id === 'update-superset')!;
    const narrower = CONSOLIDATION_EVAL_CASES.find(c => c.id === 'noop-narrower-than-candidate')!;
    const result = scoreConsolidation([update, narrower], [
      { operation: 'update', target_id: update.expected.targetId },
      { operation: 'update', target_id: narrower.input.candidates[0]!.id },
    ]);
    expect(result).toMatchObject({ correct: 1, total: 2 });
    expect(result.mismatches[0]).toContain(`noop-narrower-than-candidate: expected noop ${narrower.expected.targetId}, got update`);
    expect(scoreConsolidation([update], [null]).mismatches[0]).toContain('got no usable answer');
  });
});
