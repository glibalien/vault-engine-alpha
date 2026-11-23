import { describe, it, expect } from 'vitest';
import { judgePair, aggregateVerdicts, normalizedWinner } from '../../src/eval/judge.js';
import type { JudgeVerdict } from '../../src/eval/judge.js';
import type { LlmClient, StructuredCallRequest } from '../../src/llm/types.js';
import type { RunOutput } from '../../src/eval/runner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function stubLlm(output: unknown): LlmClient {
  return {
    structuredCall: async () => ({
      output,
      usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 },
    }),
  };
}

function captureLlm(output: unknown): { llm: LlmClient; reqs: StructuredCallRequest[] } {
  const reqs: StructuredCallRequest[] = [];
  return {
    reqs,
    llm: {
      structuredCall: async (req) => {
        reqs.push(req);
        return { output, usage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 } };
      },
    },
  };
}

function makeRunOutput(profileId: string): RunOutput {
  return {
    profileId,
    variantId: profileId,
    model: 'claude-haiku-4-5',
    label: 'claude-haiku-4-5',
    project: 'Vault Curator',
    sections: {
      now: 'Working on the eval harness',
      focus: 'TDD + judge implementation',
      open_threads: 'None blocked',
      log_entry: 'Started C4 today',
    },
    themedPages: [],
    usage: { input: 100, output: 50, cacheWrite: 0, cacheRead: 0 },
    costUsd: 0.01,
    evidenceChars: 1000,
  };
}

const FULL_VERDICT_OUTPUT = {
  overall: 'A',
  criteria: {
    succinct: { winner: 'A', note: 'tighter' },
    scannable: { winner: 'tie', note: '' },
    standup_ready: { winner: 'A', note: '' },
    grounded: { winner: 'B', note: '' },
    not_stale: { winner: 'A', note: '' },
  },
};

// ---------------------------------------------------------------------------
// judgePair: happy-path parsing
// ---------------------------------------------------------------------------
describe('judgePair', () => {
  it('returns overall winner A when stub returns overall:A', async () => {
    const llm = stubLlm(FULL_VERDICT_OUTPUT);
    const a = makeRunOutput('baseline');
    const b = makeRunOutput('specA');

    const verdict = await judgePair(llm, 'claude-haiku-4-5', 'Vault Curator', a, b);

    expect(verdict.overall).toBe('A');
  });

  it('parses all 5 criteria from the stub output', async () => {
    const llm = stubLlm(FULL_VERDICT_OUTPUT);
    const a = makeRunOutput('baseline');
    const b = makeRunOutput('specA');

    const verdict = await judgePair(llm, 'claude-haiku-4-5', 'Vault Curator', a, b);

    expect(verdict.criteria.succinct.winner).toBe('A');
    expect(verdict.criteria.succinct.note).toBe('tighter');
    expect(verdict.criteria.scannable.winner).toBe('tie');
    expect(verdict.criteria.standup_ready.winner).toBe('A');
    expect(verdict.criteria.grounded.winner).toBe('B');
    expect(verdict.criteria.not_stale.winner).toBe('A');
  });

  it('sends toolName emit_verdict to the LLM', async () => {
    const { llm, reqs } = captureLlm(FULL_VERDICT_OUTPUT);
    const a = makeRunOutput('baseline');
    const b = makeRunOutput('specA');

    await judgePair(llm, 'claude-haiku-4-5', 'Vault Curator', a, b);

    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.toolName).toBe('emit_verdict');
  });

  it('uses the provided judgeModel', async () => {
    const { llm, reqs } = captureLlm(FULL_VERDICT_OUTPUT);
    const a = makeRunOutput('baseline');
    const b = makeRunOutput('specA');

    await judgePair(llm, 'claude-sonnet-4-6', 'Vault Curator', a, b);

    expect(reqs[0]?.model).toBe('claude-sonnet-4-6');
  });

  it('includes both A and B sections in the user prompt', async () => {
    const { llm, reqs } = captureLlm(FULL_VERDICT_OUTPUT);
    const a = makeRunOutput('baseline');
    const b = makeRunOutput('specA');
    a.sections.now = 'Unique content for A';
    b.sections.now = 'Unique content for B';

    await judgePair(llm, 'claude-haiku-4-5', 'Vault Curator', a, b);

    const userText = reqs[0]?.user ?? '';
    expect(userText).toContain('Unique content for A');
    expect(userText).toContain('Unique content for B');
  });
});

// ---------------------------------------------------------------------------
// judgePair: defensive parsing (malformed output)
// ---------------------------------------------------------------------------
describe('judgePair — defensive parsing', () => {
  it('defaults overall to tie on empty output {}', async () => {
    const llm = stubLlm({});
    const a = makeRunOutput('baseline');
    const b = makeRunOutput('specA');

    const verdict = await judgePair(llm, 'claude-haiku-4-5', 'Vault Curator', a, b);

    expect(verdict.overall).toBe('tie');
  });

  it('defaults all 5 criteria to tie on empty output {}', async () => {
    const llm = stubLlm({});
    const a = makeRunOutput('baseline');
    const b = makeRunOutput('specA');

    const verdict = await judgePair(llm, 'claude-haiku-4-5', 'Vault Curator', a, b);

    for (const key of ['succinct', 'scannable', 'standup_ready', 'grounded', 'not_stale'] as const) {
      expect(verdict.criteria[key].winner).toBe('tie');
      expect(verdict.criteria[key].note).toBe('');
    }
  });

  it('defaults unknown overall winner to tie', async () => {
    const llm = stubLlm({ overall: 'X', criteria: {} });
    const a = makeRunOutput('baseline');
    const b = makeRunOutput('specA');

    const verdict = await judgePair(llm, 'claude-haiku-4-5', 'Vault Curator', a, b);

    expect(verdict.overall).toBe('tie');
  });

  it('defaults individual criteria to tie when missing from output', async () => {
    const llm = stubLlm({
      overall: 'A',
      criteria: {
        succinct: { winner: 'A', note: 'ok' },
        // scannable, standup_ready, grounded, not_stale all missing
      },
    });
    const a = makeRunOutput('baseline');
    const b = makeRunOutput('specA');

    const verdict = await judgePair(llm, 'claude-haiku-4-5', 'Vault Curator', a, b);

    expect(verdict.criteria.scannable.winner).toBe('tie');
    expect(verdict.criteria.standup_ready.winner).toBe('tie');
  });

  it('defaults criteria with invalid winner to tie', async () => {
    const llm = stubLlm({
      overall: 'A',
      criteria: {
        succinct: { winner: 'invalid', note: 'bad' },
        scannable: { winner: 'tie', note: '' },
        standup_ready: { winner: 'A', note: '' },
        grounded: { winner: 'B', note: '' },
        not_stale: { winner: 'A', note: '' },
      },
    });
    const a = makeRunOutput('baseline');
    const b = makeRunOutput('specA');

    const verdict = await judgePair(llm, 'claude-haiku-4-5', 'Vault Curator', a, b);

    expect(verdict.criteria.succinct.winner).toBe('tie');
  });
});

// ---------------------------------------------------------------------------
// aggregateVerdicts
// ---------------------------------------------------------------------------
describe('aggregateVerdicts', () => {
  it('counts aId win when overall is A', () => {
    const verdict: JudgeVerdict = {
      overall: 'A',
      criteria: {
        succinct: { winner: 'A', note: '' },
        scannable: { winner: 'A', note: '' },
        standup_ready: { winner: 'A', note: '' },
        grounded: { winner: 'A', note: '' },
        not_stale: { winner: 'A', note: '' },
      },
    };

    const scoreboard = aggregateVerdicts([{ aId: 'baseline', bId: 'specA', verdict }]);

    expect(scoreboard.wins['baseline']).toBe(1);
    expect(scoreboard.wins['specA']).toBeUndefined();
    expect(scoreboard.ties).toBe(0);
    expect(scoreboard.pairs).toBe(1);
  });

  it('counts bId win when overall is B', () => {
    const verdict: JudgeVerdict = {
      overall: 'B',
      criteria: {
        succinct: { winner: 'B', note: '' },
        scannable: { winner: 'B', note: '' },
        standup_ready: { winner: 'B', note: '' },
        grounded: { winner: 'B', note: '' },
        not_stale: { winner: 'B', note: '' },
      },
    };

    const scoreboard = aggregateVerdicts([{ aId: 'baseline', bId: 'specA', verdict }]);

    expect(scoreboard.wins['specA']).toBe(1);
    expect(scoreboard.wins['baseline']).toBeUndefined();
    expect(scoreboard.ties).toBe(0);
    expect(scoreboard.pairs).toBe(1);
  });

  it('counts tie when overall is tie', () => {
    const verdict: JudgeVerdict = {
      overall: 'tie',
      criteria: {
        succinct: { winner: 'tie', note: '' },
        scannable: { winner: 'tie', note: '' },
        standup_ready: { winner: 'tie', note: '' },
        grounded: { winner: 'tie', note: '' },
        not_stale: { winner: 'tie', note: '' },
      },
    };

    const scoreboard = aggregateVerdicts([{ aId: 'baseline', bId: 'specA', verdict }]);

    expect(scoreboard.ties).toBe(1);
    expect(scoreboard.pairs).toBe(1);
  });

  it('tallies wins across multiple verdicts', () => {
    const verdictA: JudgeVerdict = {
      overall: 'A',
      criteria: {
        succinct: { winner: 'A', note: '' },
        scannable: { winner: 'A', note: '' },
        standup_ready: { winner: 'A', note: '' },
        grounded: { winner: 'A', note: '' },
        not_stale: { winner: 'A', note: '' },
      },
    };
    const verdictB: JudgeVerdict = {
      overall: 'B',
      criteria: {
        succinct: { winner: 'B', note: '' },
        scannable: { winner: 'B', note: '' },
        standup_ready: { winner: 'B', note: '' },
        grounded: { winner: 'B', note: '' },
        not_stale: { winner: 'B', note: '' },
      },
    };
    const verdictTie: JudgeVerdict = {
      overall: 'tie',
      criteria: {
        succinct: { winner: 'tie', note: '' },
        scannable: { winner: 'tie', note: '' },
        standup_ready: { winner: 'tie', note: '' },
        grounded: { winner: 'tie', note: '' },
        not_stale: { winner: 'tie', note: '' },
      },
    };

    const scoreboard = aggregateVerdicts([
      { aId: 'baseline', bId: 'specA', verdict: verdictA },
      { aId: 'baseline', bId: 'specA', verdict: verdictB },
      { aId: 'baseline', bId: 'specA', verdict: verdictTie },
    ]);

    expect(scoreboard.wins['baseline']).toBe(1);
    expect(scoreboard.wins['specA']).toBe(1);
    expect(scoreboard.ties).toBe(1);
    expect(scoreboard.pairs).toBe(3);
  });

  it('returns zeros for empty verdicts array', () => {
    const scoreboard = aggregateVerdicts([]);

    expect(scoreboard.ties).toBe(0);
    expect(scoreboard.pairs).toBe(0);
    expect(Object.keys(scoreboard.wins)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// normalizedWinner
// ---------------------------------------------------------------------------
describe('normalizedWinner', () => {
  const criteria = {
    succinct: { winner: 'tie', note: '' },
    scannable: { winner: 'tie', note: '' },
    standup_ready: { winner: 'tie', note: '' },
    grounded: { winner: 'tie', note: '' },
    not_stale: { winner: 'tie', note: '' },
  } as const;

  it('maps overall A to aId', () => {
    expect(normalizedWinner('anchor', 'candidate', { overall: 'A', criteria })).toBe('anchor');
  });

  it('maps overall B to bId', () => {
    expect(normalizedWinner('anchor', 'candidate', { overall: 'B', criteria })).toBe('candidate');
  });

  it('maps overall tie to "tie"', () => {
    expect(normalizedWinner('anchor', 'candidate', { overall: 'tie', criteria })).toBe('tie');
  });
});
