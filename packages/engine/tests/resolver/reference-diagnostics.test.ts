import { describe, it, expect } from 'vitest';
import { buildReferenceWarnings } from '../../src/resolver/diagnostics.js';
import type { ReferenceDiagnostic } from '../../src/pipeline/diagnostics.js';
const diagnostic = (count = 2, rawTarget = 'Example'): ReferenceDiagnostic => ({
  sourceId: 'S', request: { rawTarget, context: { origin: 'field', field: 'project', requiredType: 'Project' } },
  resolution: { status: 'unresolved', reason: 'ambiguous', tier: 2, candidateCount: count, candidatesTruncated: false,
    candidates: Array.from({ length: count }, (_, i) => ({ id: String(i), file_path: `${i}.md`, title: 'Example', types: ['Project'] })) },
});
describe('bounded reference warnings', () => {
  it('allows 50 and reserves truncation slot for 51 issues', () => {
    expect(buildReferenceWarnings(Array.from({length:50}, () => diagnostic()))).toHaveLength(50);
    const warnings = buildReferenceWarnings(Array.from({length:51}, () => diagnostic()));
    expect(warnings).toHaveLength(50);
    expect(warnings.at(-1)).toMatchObject({ code: 'RESULT_TRUNCATED', details: { observed_count: 51, reported_count: 49 } });
  });
  it('caps candidates at 10 with explicit original count', () => {
    expect(buildReferenceWarnings([diagnostic(10)])[0].details).toMatchObject({ candidate_count: 10, candidates_truncated: false });
    const details = buildReferenceWarnings([diagnostic(11)])[0].details as any;
    expect(details.candidates).toHaveLength(10);
    expect(details).toMatchObject({ candidate_count: 11, candidates_truncated: true });
  });
  it('bounds combined encoded details including truncation and excerpts Unicode without mutating input', () => {
    const raw = '🌟'.repeat(50000);
    const input = Array.from({length:50}, () => diagnostic(10,raw));
    const warnings = buildReferenceWarnings(input, { opIndex: 4 });
    expect(warnings.reduce((sum,w) => sum + Buffer.byteLength(JSON.stringify(w.details)),0)).toBeLessThanOrEqual(32768);
    expect(warnings.at(-1)?.code).toBe('RESULT_TRUNCATED');
    expect(warnings[0]).toMatchObject({ op_index:4, details: { raw_target_truncated: true } });
    expect((warnings[0].details as any).raw_target).not.toContain('�');
    expect(input[0].request.rawTarget).toBe(raw);
  });
  it('keeps missing references compatible', () => {
    const value = diagnostic(); value.resolution = { ...value.resolution, status:'unresolved', reason:'missing' };
    expect(buildReferenceWarnings([value])).toEqual([]);
  });
});
