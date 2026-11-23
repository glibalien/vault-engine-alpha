import { describe, it, expect } from 'vitest';
import { describePipelineError } from '../../src/mcp/tools/errors.js';
import { PipelineError } from '../../src/pipeline/types.js';
import type { ValidationResult } from '../../src/validation/types.js';

function validation(issues: ValidationResult['issues']): ValidationResult {
  return {
    issues,
    coerced_state: {},
    effective_fields: new Map(),
    orphan_fields: [],
  } as unknown as ValidationResult;
}

describe('describePipelineError', () => {
  it('returns null for a non-PipelineError', () => {
    expect(describePipelineError(new Error('boom'))).toBeNull();
    expect(describePipelineError('nope')).toBeNull();
    expect(describePipelineError(undefined)).toBeNull();
  });

  it('maps a PipelineError with validation to VALIDATION_FAILED + issues', () => {
    const v = validation([{ code: 'REQUIRED_MISSING', message: 'x is required', severity: 'error', field: 'x' }]);
    const d = describePipelineError(new PipelineError('VALIDATION_FAILED', 'Validation failed', v));
    expect(d?.code).toBe('VALIDATION_FAILED');
    expect(d?.details.issues).toHaveLength(1);
    expect(d?.details.issues[0].code).toBe('REQUIRED_MISSING');
    expect(d?.details.node_file_path).toBeUndefined();
  });

  it('includes node_file_path when the error is annotated', () => {
    const v = validation([{ code: 'REQUIRED_MISSING', message: 'x', severity: 'error', field: 'x' }]);
    const err = new PipelineError('VALIDATION_FAILED', 'Validation failed', v) as PipelineError & { node_file_path?: string };
    err.node_file_path = 'Broken.md';
    const d = describePipelineError(err);
    expect(d?.details.node_file_path).toBe('Broken.md');
    expect(d?.message).toContain('Broken.md');
  });

  it('maps a PipelineError without validation to VALIDATION_FAILED + empty issues', () => {
    const d = describePipelineError(new PipelineError('VALIDATION_FAILED', 'bad thing'));
    expect(d?.code).toBe('VALIDATION_FAILED');
    expect(d?.details.issues).toEqual([]);
    expect(d?.message).toBe('bad thing');
  });
});
