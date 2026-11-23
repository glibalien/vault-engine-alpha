import { z } from 'zod';
import { executeReferenceEdit, type ReferenceEditContext, type ReferenceEditRequest, type ReferenceEditState } from '../../reference-edits/execute.js';
import { REFERENCE_EDIT_LIMITS, ReferenceEditError } from '../../reference-edits/types.js';
import { ContentHashMismatchError, StaleNodeError } from '../../pipeline/execute.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import { buildFixable } from '../../validation/fixable.js';
import { adaptIssue, describePipelineError, fail, ok } from './errors.js';
import { buildContentHashMismatchEnvelope } from './content-hash-helpers.js';
import { buildStaleNodeEnvelope } from './stale-helpers.js';

const byteString = (max: number) => z.string().refine(s => Buffer.byteLength(s, 'utf8') <= max, 'UTF-8 byte limit exceeded');
const selector = byteString(REFERENCE_EDIT_LIMITS.selectorBytes);
export const referenceEditSchema = z.object({
  field: byteString(REFERENCE_EDIT_LIMITS.fieldBytes).refine(s => s.length > 0, 'Field is required'),
  action: z.enum(['add', 'remove']),
  target: z.union([z.object({ node_id: selector.min(1) }).strict(), z.object({ stored_value: selector }).strict()]),
}).strict();

const requestSchema = z.object({
  node_id: selector.min(1), reference_edit: referenceEditSchema, dry_run: z.boolean().default(true),
  expected_version: z.number().int().min(1).optional(),
  expected_content_hash: selector.optional(),
}).strict().superRefine((request, ctx) => {
  if ('stored_value' in request.reference_edit.target && (request.reference_edit.action !== 'remove' || request.expected_version === undefined || request.expected_content_hash === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Stored-value removal requires both source guards' });
  }
});

export function parseReferenceEditRequest(params: unknown): ReferenceEditRequest {
  const parsed = requestSchema.safeParse(params);
  if (!parsed.success) throw new ReferenceEditError('INVALID_PARAMS', 'Invalid reference edit request', { reason: 'request_shape', issue: parsed.error.issues[0]?.message });
  return parsed.data;
}

function bounded(result: ReturnType<typeof ok>): ReturnType<typeof ok> {
  // Measure the actual, pretty-serialized envelope, including warnings and all fields.
  if (Buffer.byteLength(result.content[0].text, 'utf8') > REFERENCE_EDIT_LIMITS.resultBytes) {
    throw new ReferenceEditError('NOT_ELIGIBLE', 'Reference edit result exceeds the envelope limit', { reason: 'result_limit' });
  }
  return result;
}

export function referenceEditResult(state: ReferenceEditState): ReturnType<typeof ok> {
  const { request, plan, pipeline } = state;
  const reference_edit = {
    ...request.reference_edit, observed_target_id: state.observed_target_id,
    outcome: plan.outcome, changed: !request.dry_run && plan.changed, would_change: plan.changed,
    added_count: plan.added_count, removed_count: plan.removed_count, before: plan.before, after: plan.after,
    observed_version: state.observed_version, observed_content_hash: state.observed_content_hash,
    version: state.result_version, content_hash: state.result_content_hash, operation_id: state.operation_id,
  };
  const fields = { ...state.node, coerced_state: pipeline.validation.coerced_state, orphan_fields: pipeline.validation.orphan_fields };
  const warnings = pipeline.validation.issues.map(adaptIssue);
  return bounded(request.dry_run
    ? ok({ dry_run: true, preview: { ...fields, fixable: buildFixable(pipeline.validation.issues, pipeline.validation.effective_fields) }, reference_edit }, warnings)
    : ok({ ...fields, version: state.result_version, content_hash: state.result_content_hash, reference_edit }, warnings));
}

export function handleReferenceEdit(context: ReferenceEditContext, params: unknown, embeddingIndexer?: EmbeddingIndexer): ReturnType<typeof ok> {
  try {
    const request = parseReferenceEditRequest(params);
    let changed = false;
    const response = executeReferenceEdit(context, request, state => {
      changed = !state.request.dry_run && state.plan.changed;
      return referenceEditResult(state);
    });
    if (changed && embeddingIndexer) {
      try { embeddingIndexer.enqueue({ node_id: request.node_id, source_type: 'node' }); }
      catch (error) { console.error('[reference-edit] embedding enqueue failed after commit', error); }
    }
    return response;
  } catch (error) {
    let response: ReturnType<typeof ok>;
    if (error instanceof ReferenceEditError) response = fail(error.code, error.message, { details: error.details });
    else if (error instanceof ContentHashMismatchError) response = buildContentHashMismatchEnvelope(context.db, error);
    else if (error instanceof StaleNodeError) response = buildStaleNodeEnvelope(context.db, error);
    else {
      const pipeline = describePipelineError(error);
      response = pipeline ? fail(pipeline.code, pipeline.message, { details: pipeline.details })
        : fail('INTERNAL_ERROR', error instanceof Error ? error.message : 'Reference edit failed');
    }
    try { return bounded(response); }
    catch { return fail('NOT_ELIGIBLE', 'Reference edit diagnostic exceeds the envelope limit', { details: { reason: 'result_limit' } }); }
  }
}
