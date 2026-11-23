import { describe, it, expect } from 'vitest';
import { renderReportHtml, renderReportMarkdown, reportJson } from '../../src/eval/render.js';
import type { ReportInput } from '../../src/eval/render.js';
import type { RunOutput } from '../../src/eval/runner.js';
import type { EvalMetrics } from '../../src/eval/metrics.js';
import type { JudgeVerdict, Scoreboard } from '../../src/eval/judge.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRunOutput(profileId: string): RunOutput {
  return {
    profileId,
    variantId: profileId,
    model: 'claude-haiku-4-5',
    label: 'claude-haiku-4-5',
    project: 'Alpha Project',
    sections: {
      now: 'Working on tests',
      focus: 'Complete the eval harness',
      open_threads: '- thread one\n- thread two',
      log_entry: 'Did some work',
    },
    themedPages: [],
    usage: { input: 100, output: 50, cacheWrite: 0, cacheRead: 0 },
    costUsd: 0.0012,
    evidenceChars: 4000,
  };
}

function makeMetrics(totalWords: number): EvalMetrics {
  return {
    words: {
      now: Math.floor(totalWords * 0.2),
      focus: Math.floor(totalWords * 0.3),
      open_threads: Math.floor(totalWords * 0.3),
      log_entry: Math.floor(totalWords * 0.2),
      at_a_glance: 0,
      total: totalWords,
    },
    formatting: { callouts: 1, tables: 0, checkboxes: 2, mermaid: 0, bullets: 4, headings: 2 },
    wikilinks: { total: 3, resolvedInEvidence: 2, unverified: ['Unknown Link'] },
    doneLeaks: [],
  };
}

function makeVerdict(): JudgeVerdict {
  return {
    overall: 'A',
    criteria: {
      succinct: { winner: 'A', note: 'A is more succinct' },
      scannable: { winner: 'tie', note: '' },
      standup_ready: { winner: 'A', note: 'A is better' },
      grounded: { winner: 'tie', note: '' },
      not_stale: { winner: 'B', note: 'B avoids stale content' },
    },
  };
}

function makeReportInput(): ReportInput {
  return {
    byProject: [
      {
        project: 'Alpha Project',
        variants: [
          { run: makeRunOutput('baseline'), metrics: makeMetrics(142) },
          { run: makeRunOutput('concise'), metrics: makeMetrics(89) },
        ],
        judgements: [
          { aId: 'baseline', bId: 'concise', verdict: makeVerdict() },
        ],
      },
    ],
    totalCostUsd: 0.0024,
  };
}

// ---------------------------------------------------------------------------
// renderReportHtml
// ---------------------------------------------------------------------------

describe('renderReportHtml', () => {
  it('returns a string containing <html', () => {
    const html = renderReportHtml(makeReportInput());
    expect(html).toContain('<html');
  });

  it('contains a <style> block (self-contained, no external stylesheet)', () => {
    const html = renderReportHtml(makeReportInput());
    expect(html).toContain('<style');
  });

  it('contains the project title', () => {
    const html = renderReportHtml(makeReportInput());
    expect(html).toContain('Alpha Project');
  });

  it('contains both profile IDs', () => {
    const html = renderReportHtml(makeReportInput());
    expect(html).toContain('baseline');
    expect(html).toContain('concise');
  });

  it('contains the word-total numbers for each variant', () => {
    const html = renderReportHtml(makeReportInput());
    expect(html).toContain('142');
    expect(html).toContain('89');
  });

  it('does NOT contain any <script tags (self-contained)', () => {
    const html = renderReportHtml(makeReportInput());
    expect(html).not.toContain('<script');
  });

  it('does NOT contain any http:// external references', () => {
    const html = renderReportHtml(makeReportInput());
    expect(html).not.toContain('http://');
  });

  it('does NOT contain any https:// external references', () => {
    const html = renderReportHtml(makeReportInput());
    expect(html).not.toContain('https://');
  });

  it('contains the total cost when provided', () => {
    const html = renderReportHtml(makeReportInput());
    expect(html).toContain('0.00');
  });

  it('handles null totalCostUsd gracefully', () => {
    const input: ReportInput = { ...makeReportInput(), totalCostUsd: null };
    const html = renderReportHtml(input);
    expect(html).toContain('<html');
  });

  it('contains judgement winner when judgements present', () => {
    const html = renderReportHtml(makeReportInput());
    // overall winner is 'A' which maps to 'baseline'
    expect(html).toContain('baseline');
  });
});

// ---------------------------------------------------------------------------
// renderReportMarkdown
// ---------------------------------------------------------------------------

describe('renderReportMarkdown', () => {
  it('contains the project title as a heading', () => {
    const md = renderReportMarkdown(makeReportInput());
    expect(md).toContain('Alpha Project');
  });

  it('contains a markdown table row (pipe character)', () => {
    const md = renderReportMarkdown(makeReportInput());
    expect(md).toContain('|');
  });

  it('contains both profile IDs', () => {
    const md = renderReportMarkdown(makeReportInput());
    expect(md).toContain('baseline');
    expect(md).toContain('concise');
  });

  it('contains word totals', () => {
    const md = renderReportMarkdown(makeReportInput());
    expect(md).toContain('142');
    expect(md).toContain('89');
  });
});

// ---------------------------------------------------------------------------
// reportJson
// ---------------------------------------------------------------------------

describe('reportJson', () => {
  it('round-trips via JSON.parse', () => {
    const input = makeReportInput();
    const json = reportJson(input);
    const parsed = JSON.parse(json) as ReportInput;
    expect(parsed.byProject).toHaveLength(1);
    expect(parsed.byProject[0]?.project).toBe('Alpha Project');
    expect(parsed.totalCostUsd).toBeCloseTo(0.0024);
  });

  it('produces valid JSON (does not throw)', () => {
    const input = makeReportInput();
    const json = reportJson(input);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scoreboard rendering
// ---------------------------------------------------------------------------

function makeScoreboard(): Scoreboard {
  return { wins: { baseline: 2, concise: 1 }, ties: 1, pairs: 4 };
}

describe('scoreboard rendering', () => {
  it('renderReportHtml includes profile id and win count when scoreboard provided', () => {
    const input: ReportInput = { ...makeReportInput(), scoreboard: makeScoreboard() };
    const html = renderReportHtml(input);
    expect(html).toContain('baseline');
    expect(html).toContain('2'); // baseline wins
    expect(html).toContain('Corpus Scoreboard');
  });

  it('renderReportMarkdown includes profile id and win count when scoreboard provided', () => {
    const input: ReportInput = { ...makeReportInput(), scoreboard: makeScoreboard() };
    const md = renderReportMarkdown(input);
    expect(md).toContain('Corpus Scoreboard');
    expect(md).toContain('baseline');
    expect(md).toContain('2'); // baseline wins
  });

  it('renderReportHtml works without scoreboard (no crash, no scoreboard markup)', () => {
    const input = makeReportInput(); // no scoreboard field
    const html = renderReportHtml(input);
    expect(html).toContain('<html');
    expect(html).not.toContain('Corpus Scoreboard');
  });

  it('renderReportMarkdown works without scoreboard (no crash, no scoreboard markup)', () => {
    const input = makeReportInput(); // no scoreboard field
    const md = renderReportMarkdown(input);
    expect(md).toContain('Alpha Project');
    expect(md).not.toContain('Corpus Scoreboard');
  });
});
