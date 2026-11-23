import { describe, expect, it } from 'vitest';
import { buildCurateReport, formatFieldGuessReport, formatTopicRefreshResult } from '../src/report.js';
import type { CurateResult } from '../src/types.js';
import type { FieldGuessSweepResult } from '../src/field-guess/types.js';

const written: CurateResult = {
  project: 'Alpha', outcome: 'written', detail: 'home updated', dryRun: false,
  usage: { input: 100, output: 50, cacheWrite: 0, cacheRead: 10 }, costUsd: 0.02,
  evidenceHash: 'hash-alpha',
};
const skipped: CurateResult = {
  project: 'Beta', outcome: 'skipped', detail: 'unchanged', dryRun: false,
  evidenceHash: 'hash-beta',
};
const errored: CurateResult = {
  project: 'Gamma', outcome: 'error', detail: 'engine down', dryRun: false,
};

describe('buildCurateReport', () => {
  it('projects additive closed refresh metadata while leaving legacy views unchanged', () => {
    const refresh = {
      ...written,
      refreshTrigger: 'vault_source_changed' as const,
      changedSourceNodeIds: ['source-a'],
      webAssessment: { verdict: 'uncertain' as const, reasonCode: 'insufficient_evidence' as const, changedUrls: [] },
      refreshWarnings: ['source_read_unavailable' as const],
    };

    expect(buildCurateReport([refresh], { mode: 'project', dryRun: false }).results[0]).toMatchObject({
      refresh_trigger: 'vault_source_changed',
      changed_source_node_ids: ['source-a'],
      web_assessment: { verdict: 'uncertain', reason_code: 'insufficient_evidence', changed_urls: [] },
      refresh_warnings: ['source_read_unavailable'],
    });
    expect(buildCurateReport([written], { mode: 'project', dryRun: false }).results[0]).toEqual({
      project: 'Alpha', outcome: 'written', detail: 'home updated', evidence_hash: 'hash-alpha',
      dry_run: false, usage: written.usage, cost_usd: 0.02,
    });
  });

  it('projects a single written result and surfaces evidence_hash', () => {
    const report = buildCurateReport([written], { mode: 'project', dryRun: false });
    expect(report.mode).toBe('project');
    expect(report.dry_run).toBe(false);
    expect(report.results).toHaveLength(1);
    const v = report.results[0]!;
    expect(v).toMatchObject({
      project: 'Alpha', outcome: 'written', detail: 'home updated',
      evidence_hash: 'hash-alpha', dry_run: false, cost_usd: 0.02,
    });
    expect(v.usage).toEqual({ input: 100, output: 50, cacheWrite: 0, cacheRead: 10 });
    expect(report.summary).toEqual({
      total: 1, written: 1, skipped: 0, would_curate: 0, refreshed_live: 0, errors: 0,
      usage: { input: 100, output: 50, cacheWrite: 0, cacheRead: 10 }, cost_usd: 0.02,
    });
  });

  it('nulls missing detail/usage/cost/evidence_hash', () => {
    const report = buildCurateReport([errored], { mode: 'project', dryRun: false });
    const v = report.results[0]!;
    expect(v.evidence_hash).toBeNull();
    expect(v.usage).toBeNull();
    expect(v.cost_usd).toBeNull();
    expect(v.detail).toBe('engine down');
    expect(report.summary.errors).toBe(1);
  });

  it('tallies a mixed sweep and folds usage + cost across results', () => {
    const w2: CurateResult = {
      ...written, project: 'Delta',
      usage: { input: 4, output: 6, cacheWrite: 1, cacheRead: 2 }, costUsd: 0.03,
    };
    const report = buildCurateReport([written, skipped, errored, w2], { mode: 'sweep', dryRun: false });
    expect(report.summary).toEqual({
      total: 4, written: 2, skipped: 1, would_curate: 0, refreshed_live: 0, errors: 1,
      usage: { input: 104, output: 56, cacheWrite: 1, cacheRead: 12 }, cost_usd: 0.05,
    });
  });

  it('counts dry-run results that would curate separately from skips', () => {
    const would: CurateResult = { project: 'Echo', outcome: 'would_curate', detail: 'dry run: would curate (no wiki yet); no model calls', dryRun: true };
    const report = buildCurateReport([would, skipped], { mode: 'sweep', dryRun: true });
    expect(report.summary).toMatchObject({ total: 2, written: 0, skipped: 1, would_curate: 1, errors: 0, cost_usd: 0 });
  });

  it('includes sections only under dry_run', () => {
    const sections = { now: 'N', focus: 'F', open_threads: 'O', log_entry: 'L' };
    const dryWritten: CurateResult = { ...written, dryRun: true, sections };
    const dry = buildCurateReport([dryWritten], { mode: 'project', dryRun: true });
    expect(dry.results[0]!.sections).toEqual(sections);
    const committed = buildCurateReport([{ ...dryWritten, dryRun: false }], { mode: 'project', dryRun: false });
    expect(committed.results[0]!.sections).toBeUndefined();
  });

  it('includes themed outcomes only when present', () => {
    const themed = [{ kind: 'workstream' as const, title: 'Alpha — Auth', action: 'created' as const, state: 'active' }];
    const withThemed: CurateResult = { ...written, themed };
    const report = buildCurateReport([withThemed, skipped], { mode: 'sweep', dryRun: false });
    expect(report.results[0]!.themed).toEqual([{ kind: 'workstream', title: 'Alpha — Auth', action: 'created', state: 'active' }]);
    expect(report.results[1]!.themed).toBeUndefined();
  });

  it('includes rich topology and the themed compatibility projection', () => {
    // Given
    const result: CurateResult = {
      ...written,
      topology: [{ action: 'created', node_id: 'n1', title: 'Alpha — Auth', scope: { v: 1, subject: 'Alpha', facet: 'Auth' }, kind: 'workstream' }],
      themed: [{ kind: 'workstream', title: 'Alpha — Auth', action: 'created', state: 'active' }],
    };

    // When
    const view = buildCurateReport([result], { mode: 'project', dryRun: false }).results[0];

    // Then
    expect(view?.topology).toEqual(result.topology);
    expect(view?.themed).toEqual([{ kind: 'workstream', title: 'Alpha — Auth', action: 'created', state: 'active' }]);
  });

  it('keeps internal failed-plan diagnostics out of the public report', () => {
    const privateMarker = 'TEST_EVIDENCE_AND_PAGE_BODY_MARKER';
    const result: CurateResult = {
      ...errored,
      topologyAudit: {
        catalog: { valid: true, missing_scope_node_ids: [] },
        proposedActions: [{
          op: 'create', plan_key: 'private', title: 'Private', kind: 'workstream',
          scope: { v: 1, subject: 'Gamma', facet: 'private' }, synthesis_brief: privateMarker,
        }],
        finalActions: [], adjudicationVerdicts: [], validationIssueCodes: [], warnings: [],
        planningAttempts: [{
          phase: 'validation', attempt: 0,
          plan: { reviewed_page_ids: [], actions: [] }, issues: [],
        }],
      },
    };

    const report = buildCurateReport([result], { mode: 'project', dryRun: false });

    expect(JSON.stringify(report)).not.toContain(privateMarker);
    expect(report.results[0]).toEqual({
      project: 'Gamma', outcome: 'error', detail: 'engine down', evidence_hash: null,
      dry_run: false, usage: null, cost_usd: null,
    });
  });

  it('an empty sweep yields no results and a zero summary', () => {
    const report = buildCurateReport([], { mode: 'sweep', dryRun: false });
    expect(report.results).toEqual([]);
    expect(report.summary).toEqual({
      total: 0, written: 0, skipped: 0, would_curate: 0, refreshed_live: 0, errors: 0,
      usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, cost_usd: 0,
    });
  });
});

describe('formatTopicRefreshResult', () => {
  it.each([
    ['cadence not due', { ...skipped, outcome: 'skipped_cadence_not_due', detail: 'cadence not due', refreshTrigger: 'not_due' }, 'cadence not due'],
    ['early refresh disabled', { ...skipped, outcome: 'skipped_cadence_not_due', detail: 'early refresh disabled', refreshTrigger: 'not_due' }, 'early refresh disabled'],
    ['baseline retry pending', { ...written, refreshTrigger: 'baseline_retry' }, 'baseline commit retry pending'],
    ['source baseline not ready', { ...skipped, refreshTrigger: 'not_due', refreshWarnings: ['source_baseline_not_ready'] }, 'source baseline not ready'],
    ['source change detected', { ...written, refreshTrigger: 'vault_source_changed', changedSourceNodeIds: ['a', 'b'] }, 'source change detected (2 sources)'],
    ['unchanged web probe', { ...skipped, detail: 'web probe unchanged', refreshTrigger: 'not_due', changedSourceNodeIds: [], refreshWarnings: [] }, 'web probe unchanged'],
    ['immaterial web assessment', { ...skipped, refreshTrigger: 'not_due', webAssessment: { verdict: 'immaterial', reasonCode: 'restatement', changedUrls: [] } }, 'web change assessed immaterial (restatement)'],
    ['uncertain web assessment', { ...skipped, refreshTrigger: 'not_due', webAssessment: { verdict: 'uncertain', reasonCode: 'insufficient_evidence', changedUrls: [] } }, 'web change assessed uncertain (insufficient evidence)'],
    ['material web assessment', { ...written, refreshTrigger: 'web_material_change', webAssessment: { verdict: 'material', reasonCode: 'new_development', changedUrls: ['https://example.com'] } }, 'web change assessed material (new development)'],
    ['cap exhausted', { ...skipped, refreshTrigger: 'not_due', refreshWarnings: ['assessment_cap_exhausted'] }, 'web assessment cap exhausted'],
    ['probe unavailable', { ...skipped, refreshTrigger: 'not_due', refreshWarnings: ['web_probe_unavailable'] }, 'web probe unavailable'],
  ] as const)('%s is concise and distinct', (_name, result, expected) => {
    expect(formatTopicRefreshResult(result as CurateResult)).toBe(expected);
  });

  it('returns null for a legacy result with no refresh fields', () => {
    expect(formatTopicRefreshResult(written)).toBeNull();
  });
});

describe('formatFieldGuessReport', () => {
  it('renders the bounded phase result as a distinct summary with actions and warnings', () => {
    const result: FieldGuessSweepResult = {
      ran: true,
      dryRun: true,
      skipReason: null,
      scannedNodes: 3,
      modelCalls: 2,
      fieldsSet: 1,
      abstentions: 4,
      ledgerSkips: 5,
      missingHashSkips: 1,
      staleNodes: 1,
      deferredNodes: 6,
      referenceErrors: 1,
      providerErrors: 1,
      mutationErrors: 0,
      errors: 2,
      warnings: ['provider failed'],
      actions: ['would guess status=active on "Alpha"'],
    };

    expect(formatFieldGuessReport(result)).toEqual([
      'field guessing (dry-run): 3 scanned, 2 model calls, 1 field set, 4 abstentions, 5 ledger skips, 1 missing-hash skip, 1 stale, 6 deferred, 2 errors',
      'field guess action: would guess status=active on "Alpha"',
      'field guess warning: provider failed',
    ]);
  });

  it('reports an admission skip without manufacturing a project result', () => {
    const result: FieldGuessSweepResult = {
      ran: false,
      dryRun: false,
      skipReason: 'model_unresolved',
      scannedNodes: 0,
      modelCalls: 0,
      fieldsSet: 0,
      abstentions: 0,
      ledgerSkips: 0,
      missingHashSkips: 0,
      staleNodes: 0,
      deferredNodes: 0,
      referenceErrors: 0,
      providerErrors: 0,
      mutationErrors: 0,
      errors: 0,
      warnings: ['Field guess model did not resolve.'],
      actions: [],
    };

    expect(formatFieldGuessReport(result)).toEqual([
      'field guessing: skipped (model_unresolved)',
      'field guess warning: Field guess model did not resolve.',
    ]);
  });
});

describe('formatFieldGuessOperationalWarnings', () => {
  it('renders only closed count-based production warnings for each operational category', async () => {
    const { formatFieldGuessOperationalWarnings } = await import('../src/report.js');
    const result: FieldGuessSweepResult = {
      ran: true, dryRun: false, skipReason: null, scannedNodes: 4, modelCalls: 3,
      fieldsSet: 1, abstentions: 1, ledgerSkips: 0, missingHashSkips: 0,
      staleNodes: 0, deferredNodes: 0, referenceErrors: 1, providerErrors: 1,
      mutationErrors: 1, errors: 4,
      warnings: ['SECRET PROVIDER MODEL ACTION VALUE EXCEPTION'], actions: ['SECRET ACTION VALUE'],
    };

    const lines = formatFieldGuessOperationalWarnings(result);

    expect(lines).toEqual([
      'field guessing: 1 provider error',
      'field guessing: 1 reference error',
      'field guessing: 1 mutation error',
      'field guessing: 1 other operational error',
      'field guessing: 1 operational warning',
    ]);
    expect(JSON.stringify(lines)).not.toContain('SECRET');
  });

  it('keeps cap zero quiet but surfaces every other skip reason with a static line', async () => {
    const { formatFieldGuessOperationalWarnings } = await import('../src/report.js');
    const skipped = (skipReason: FieldGuessSweepResult['skipReason']): FieldGuessSweepResult => ({
      ran: false, dryRun: false, skipReason, scannedNodes: 0, modelCalls: 0,
      fieldsSet: 0, abstentions: 0, ledgerSkips: 0, missingHashSkips: 0,
      staleNodes: 0, deferredNodes: 0, referenceErrors: 0, providerErrors: 0,
      mutationErrors: 0, errors: 0, warnings: ['SECRET DYNAMIC DETAIL'], actions: [],
    });

    expect(formatFieldGuessOperationalWarnings(skipped('disabled'))).toEqual([]);
    expect([
      ...formatFieldGuessOperationalWarnings(skipped('model_unresolved')),
      ...formatFieldGuessOperationalWarnings(skipped('database_unavailable')),
      ...formatFieldGuessOperationalWarnings(skipped('presence_backfill_pending')),
    ]).toEqual([
      'field guessing: skipped because the configured model is unresolved',
      'field guessing: skipped because the Curator database is unavailable',
      'field guessing: skipped while field-presence backfill is pending',
    ]);
  });
});
