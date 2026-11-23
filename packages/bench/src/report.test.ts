import { describe, expect, it } from 'vitest';
import { ALL_TURN_CLASSES } from './sample.js';
import type { TurnClass } from './classify.js';
import type { CallOutcome } from './execute.js';
import type { TurnResult } from './runner.js';
import {
  aggregateByClass,
  aggregateCell,
  buildHistoryEntry,
  buildReport,
  passRate,
  type CoverageInput,
  type ModelResultsInput,
  type ReportCell,
  type ReportManifest,
} from './report.js';

// ---------------------------------------------------------------- fixtures

const READ_PASS: CallOutcome = { kind: 'read', verdict: 'PASS', envelope: { ok: true, data: {}, warnings: [] } };
const SUPPRESSED: CallOutcome = { kind: 'suppressed' };
const WRITE_UNVALIDATABLE: CallOutcome = { kind: 'write-unvalidatable' };

function turn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    conversationId: 'conv-1',
    seq: 1,
    turnClass: 'single-read',
    outcome: 'PASS',
    calls: [READ_PASS],
    truncatedAtWrite: false,
    unvalidatable: 0,
    emittedCallCount: 1,
    recordedCallCount: 1,
    latencyMs: 100,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.001,
    ...overrides,
  };
}

// -------------------------------------------------------------- aggregateCell

describe('aggregateCell', () => {
  it('counts outcomes, coverage columns, and cost/latency exactly for a fixed TurnResult[]', () => {
    const results: TurnResult[] = [
      turn({ outcome: 'PASS', latencyMs: 100, costUsd: 0.001, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
      turn({ outcome: 'WEAK', latencyMs: 200, costUsd: 0.002, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
      turn({
        outcome: 'FAIL',
        latencyMs: 300,
        costUsd: 0.003,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        truncatedAtWrite: true,
        unvalidatable: 2,
        calls: [WRITE_UNVALIDATABLE, WRITE_UNVALIDATABLE, SUPPRESSED, SUPPRESSED, SUPPRESSED],
      }),
      // ERROR turn: usage/cost null despite having burned latency — never fabricate 0.
      turn({ outcome: 'ERROR', latencyMs: 400, costUsd: null, usage: null, calls: [], error: 'boom' }),
    ];

    const cell = aggregateCell(results);

    expect(cell).toEqual<ReportCell>({
      pass: 1,
      weak: 1,
      fail: 1,
      error: 1,
      truncatedAtWrite: 1,
      unvalidatable: 2,
      suppressed: 3,
      usageUnreported: 1, // the ERROR turn only
      meanLatencyMs: (100 + 200 + 300 + 400) / 4,
      totalCostUsd: 0.001 + 0.002 + 0.003, // the ERROR turn's null cost is excluded, not summed as 0
      turns: 4,
    });
  });

  it('returns totalCostUsd: null (never 0) when every turn in the cell has unknown cost', () => {
    const results: TurnResult[] = [
      turn({ costUsd: null, usage: null }),
      turn({ costUsd: null, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }), // priced usage, unpriced model
    ];
    const cell = aggregateCell(results);
    expect(cell.totalCostUsd).toBeNull();
    expect(cell.usageUnreported).toBe(1); // only the null-usage turn, not the unpriced-but-measured one
  });

  it('is all-zero / null for an empty bucket', () => {
    expect(aggregateCell([])).toEqual<ReportCell>({
      pass: 0, weak: 0, fail: 0, error: 0, truncatedAtWrite: 0, unvalidatable: 0,
      suppressed: 0, usageUnreported: 0, meanLatencyMs: 0, totalCostUsd: null, turns: 0,
    });
  });

  it('does not read calls positionally — order of calls within a turn never changes the aggregate', () => {
    const forward = turn({ calls: [WRITE_UNVALIDATABLE, SUPPRESSED], unvalidatable: 1 });
    const backward = turn({ calls: [SUPPRESSED, WRITE_UNVALIDATABLE], unvalidatable: 1 });
    expect(aggregateCell([forward])).toEqual(aggregateCell([backward]));
  });
});

describe('passRate — ambiguity ruling #4 (ERROR excluded from the denominator)', () => {
  it('excludes ERROR turns from the denominator', () => {
    // 2 PASS, 1 FAIL, 2 ERROR: rate must be 2/3, not 2/5.
    const cell = aggregateCell([
      turn({ outcome: 'PASS' }),
      turn({ outcome: 'PASS' }),
      turn({ outcome: 'FAIL' }),
      turn({ outcome: 'ERROR', usage: null, costUsd: null }),
      turn({ outcome: 'ERROR', usage: null, costUsd: null }),
    ]);
    expect(passRate(cell)).toBeCloseTo(2 / 3, 12);
  });

  it('is null when every turn errored (0/0), never a fabricated 0', () => {
    const cell = aggregateCell([turn({ outcome: 'ERROR', usage: null, costUsd: null })]);
    expect(passRate(cell)).toBeNull();
  });

  it('is null for an empty cell', () => {
    expect(passRate(aggregateCell([]))).toBeNull();
  });
});

// ------------------------------------------------------------ aggregateByClass

describe('aggregateByClass', () => {
  it('produces exactly one cell per ALL_TURN_CLASSES entry, including classes absent from the input', () => {
    const results: TurnResult[] = [turn({ turnClass: 'trivial' }), turn({ turnClass: 'complex', outcome: 'FAIL' })];
    const cells = aggregateByClass(results);

    expect(Object.keys(cells).sort()).toEqual([...ALL_TURN_CLASSES].sort());
    expect(cells.trivial.turns).toBe(1);
    expect(cells.complex.turns).toBe(1);
    expect(cells.complex.fail).toBe(1);
    // classes with no turns still get a (zero, not undefined/missing) cell
    expect(cells['single-write'].turns).toBe(0);
    expect(cells['single-write'].totalCostUsd).toBeNull();
  });
});

// ------------------------------------------------------------------ buildReport

function manifestFixture(overrides: Partial<ReportManifest> = {}): ReportManifest {
  return {
    tag: 'test-tag',
    gitSha: 'deadbeef',
    seed: 1,
    perClass: 2,
    models: ['accounts/fireworks/models/qwen3p7-plus', 'vendor/unpriced-model'],
    tz: 'America/New_York',
    dbPath: '/fixture/vault.db',
    corpusTurnCount: 42,
    engineDistMtime: '2026-08-01T00:00:00.000Z',
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T00:05:00.000Z',
    ...overrides,
  };
}

function coverageFixture(overrides: Partial<CoverageInput> = {}): CoverageInput {
  const sampledPerClass = Object.fromEntries(ALL_TURN_CLASSES.map((c) => [c, 2])) as Record<TurnClass, number>;
  return {
    totalTurns: 42,
    replayableTurns: 40,
    partialExcluded: 1,
    unknownToolExcluded: 1,
    requestedClasses: [...ALL_TURN_CLASSES],
    sampledPerClass,
    shortfalls: [{ turnClass: 'single-write', requested: 40, available: 2 }],
    externalToolTurns: 0,
    ...overrides,
  };
}

describe('buildReport', () => {
  it('aggregates each model into per-class cells and carries manifest/coverage through unchanged', () => {
    const modelA: ModelResultsInput = {
      ref: 'Qwen 3.7 Plus',
      model: 'accounts/fireworks/models/qwen3p7-plus',
      label: 'Qwen 3.7 Plus',
      results: [turn({ turnClass: 'trivial', outcome: 'PASS' }), turn({ turnClass: 'trivial', outcome: 'FAIL' })],
    };
    const modelB: ModelResultsInput = {
      ref: 'vendor/unpriced-model',
      model: 'vendor/unpriced-model',
      label: 'unpriced-model',
      results: [turn({ turnClass: 'trivial', outcome: 'PASS', costUsd: null })],
    };

    const report = buildReport({
      models: [modelA, modelB],
      manifest: manifestFixture(),
      coverage: coverageFixture(),
    });

    expect(report.json.models).toHaveLength(2);
    expect(report.json.models[0]!.cells.trivial.turns).toBe(2);
    expect(report.json.models[0]!.cells.trivial.pass).toBe(1);
    expect(report.json.models[0]!.cells.trivial.fail).toBe(1);
    // unpriced model: cost must be null, never 0 — the real-data note (3/9 catalog
    // models have no pricing entry) is exactly this case.
    expect(report.json.models[1]!.cells.trivial.totalCostUsd).toBeNull();

    expect(report.json.manifest.tag).toBe('test-tag');
    expect(report.json.manifest.notes.length).toBeGreaterThan(0);
    expect(report.json.coverage).toEqual(coverageFixture());
  });

  it('never renders a missing cost as $0.00 in the markdown — it renders "n/a"', () => {
    const modelB: ModelResultsInput = {
      ref: 'vendor/unpriced-model',
      model: 'vendor/unpriced-model',
      label: 'unpriced-model',
      results: [turn({ turnClass: 'trivial', outcome: 'PASS', costUsd: null, usage: null })],
    };
    const report = buildReport({ models: [modelB], manifest: manifestFixture(), coverage: coverageFixture() });

    expect(report.markdown).toContain('n/a');
    expect(report.markdown).not.toContain('$0.00');
  });

  it('excludes ERROR from the rendered pass rate denominator', () => {
    const model: ModelResultsInput = {
      ref: 'm',
      model: 'm',
      label: 'm',
      results: [
        turn({ turnClass: 'trivial', outcome: 'PASS' }),
        turn({ turnClass: 'trivial', outcome: 'PASS' }),
        turn({ turnClass: 'trivial', outcome: 'ERROR', usage: null, costUsd: null }),
      ],
    };
    const report = buildReport({ models: [model], manifest: manifestFixture(), coverage: coverageFixture() });
    // 2 pass / (3 turns - 1 error) = 2/2 = 100%, not 2/3 = 66.7%
    expect(report.markdown).toContain('100.0% (2/2)');
  });

  it('renders every ALL_TURN_CLASSES entry in the coverage table, even ones absent from the corpus', () => {
    const report = buildReport({
      models: [],
      manifest: manifestFixture(),
      coverage: coverageFixture({ sampledPerClass: Object.fromEntries(ALL_TURN_CLASSES.map((c) => [c, 0])) as Record<TurnClass, number> }),
    });
    for (const c of ALL_TURN_CLASSES) {
      expect(report.markdown).toContain(`| ${c} |`);
    }
  });

  it('carries the doc-context fidelity limit in the manifest notes (carry-forward #4: docPath was never persisted)', () => {
    const report = buildReport({ models: [], manifest: manifestFixture(), coverage: coverageFixture() });

    const docNote = report.json.manifest.notes.find((n) => n.includes('docPath'));
    expect(docNote).toBeDefined();
    expect(docNote).toContain('doc-context provider is silent');
    expect(docNote).toContain('13 of 722');

    // Reaches the rendered markdown too — a reader of report.md, not just report.json, must see it.
    expect(report.markdown).toContain('docPath');
    expect(report.markdown).toContain('doc-context provider is silent');
  });

  it('separates consecutive model tables with a blank line (multi-model reports)', () => {
    const modelA: ModelResultsInput = {
      ref: 'model-a',
      model: 'vendor/model-a',
      label: 'Model A',
      results: [turn({ turnClass: 'trivial' })],
    };
    const modelB: ModelResultsInput = {
      ref: 'model-b',
      model: 'vendor/model-b',
      label: 'Model B',
      results: [turn({ turnClass: 'trivial' })],
    };
    const report = buildReport({ models: [modelA, modelB], manifest: manifestFixture(), coverage: coverageFixture() });

    const lines = report.markdown.split('\n');
    const secondHeadingIdx = lines.indexOf('### Model B (`vendor/model-b`, ref `model-b`)');
    expect(secondHeadingIdx).toBeGreaterThan(0);
    // the line immediately before the second model's heading must be blank —
    // not the first model's last table row abutting it directly.
    expect(lines[secondHeadingIdx - 1]).toBe('');
    expect(lines[secondHeadingIdx - 2]).toContain('| trivial |'); // sanity: that blank really sits between the two tables
  });
});

// -------------------------------------------------------------- buildHistoryEntry

describe('buildHistoryEntry', () => {
  it('extracts the ledger line verbatim from a built report, defaulting mode to sampled', () => {
    const model: ModelResultsInput = {
      ref: 'Qwen 3.7 Plus',
      model: 'accounts/fireworks/models/qwen3p7-plus',
      label: 'Qwen 3.7 Plus',
      results: [turn({ turnClass: 'trivial' })],
    };
    const report = buildReport({ models: [model], manifest: manifestFixture(), coverage: coverageFixture() });
    const entry = buildHistoryEntry(report.json);

    expect(entry).toEqual({
      tag: 'test-tag',
      at: '2026-08-01T00:05:00.000Z',
      gitSha: 'deadbeef',
      seed: 1,
      perClass: 2,
      mode: 'sampled',
      models: [{ ref: 'Qwen 3.7 Plus', model: 'accounts/fireworks/models/qwen3p7-plus', cells: report.json.models[0]!.cells }],
      coverage: coverageFixture(),
    });
    // label is a report.json-only field — the ledger line is verbatim { ref, model, cells } per the brief
    expect(entry.models[0]).not.toHaveProperty('label');
  });

  it('honours an explicit full-sweep mode', () => {
    const report = buildReport({ models: [], manifest: manifestFixture(), coverage: coverageFixture() });
    const entry = buildHistoryEntry(report.json, { mode: 'full' });
    expect(entry.mode).toBe('full');
  });
});
