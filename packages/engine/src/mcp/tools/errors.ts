import type { ValidationIssue, ValidationIssueCode } from '../../validation/types.js';
import type { ToolIssue, ToolIssueCode } from './title-warnings.js';
import { PipelineError } from '../../pipeline/types.js';
import { buildFixable } from '../../validation/fixable.js';

export type ErrorCode =
  | 'CLASSIFICATION_INVALID_CONFIG'
  | 'CLASSIFICATION_STALE_DEFINITION'
  | 'CLASSIFICATION_LIMIT_EXCEEDED'
  | 'CLASSIFICATION_IN_USE'
  | 'NOT_FOUND'
  | 'ALREADY_MATERIALIZED'
  | 'INVALID_PARAMS'
  | 'AMBIGUOUS_MATCH'
  | 'INTERNAL_ERROR'
  | 'VALIDATION_FAILED'
  | 'UNKNOWN_TYPE'
  | 'EXTRACTOR_UNAVAILABLE'
  | 'AMBIGUOUS_FILENAME'
  | 'CONFLICT'
  | 'DUPLICATE_MEMORY'
  | 'BATCH_FAILED'
  | 'OPERATION_NOT_FOUND'
  | 'CONFIRMATION_REQUIRED'
  | 'STALE_NODE'
  | 'CONTENT_HASH_MISMATCH'
  | 'NOT_ELIGIBLE'
  | 'UPSTREAM_ERROR';

export type IssueCode =
  | ValidationIssueCode
  | ToolIssueCode
  | 'CHANGED_SINCE_UNPARSEABLE'
  | 'CROSS_NODE_FILTER_UNRESOLVED'
  | 'DEPRECATED_PARAM'
  | 'EMBEDDINGS_UNVERIFIED'
  | 'FIELD_OPERATOR_MISMATCH'
  | 'FIELD_PRESENCE_BACKFILL_PENDING'
  | 'FTS_QUERY_INVALID'
  | 'LAST_TYPE_REMOVAL'
  | 'MEMORY_CONSOLIDATION_FAILED'
  | 'MEMORY_DEDUP_DEGRADED'
  | 'MEMORY_SUBJECT_UNRESOLVED'
  | 'PENDING_REFERENCES'
  | 'SCHEMA_FILE_RENDER_BLOCKED'
  | 'SEMANTIC_SEARCH_UNAVAILABLE'
  | 'REFERENCE_AMBIGUOUS'
  | 'REFERENCE_TARGET_TYPE_MISMATCH'
  | 'REFERENCE_RESOLUTION_STALE'
  | 'RESULT_TRUNCATED'
  | 'TEXT_BUDGET_EXCEEDED'
  | 'UNDO_FILE_KEPT'
  | 'SETTINGS_INVALID_VALUE'
  | 'SETTINGS_MODEL_REF_UNRESOLVED'
  | 'SETTINGS_NOTE_WRITE_FAILED'
  | 'SETTINGS_NOT_IN_VAULT'
  | 'SETTINGS_UNKNOWN_KEY'
  | 'WIKI_NARRATIVE_EMPTY'
  | 'WIKI_SCHEMA_BOOTSTRAP_REQUIRED'
  | 'STALE_ACTIVE_REPLACEMENT'
  | 'STALE_NODE'
  | 'WIKI_SUBPAGE_CAP'
  | 'WIKI_SUBPAGE_REUSED';

export interface Issue {
  code: IssueCode;
  message: string;
  severity: 'error' | 'warning';
  field?: string;
  details?: unknown;
  /**
   * Index of the originating operation within a multi-op tool call (e.g.
   * batch-mutate's `operations` array). Lets callers attribute a warning to a
   * specific op when the warnings array is flat. Optional and additive — single-op
   * tools never set it.
   */
  op_index?: number;
}

export type Envelope<T> =
  | { ok: true; data: T; warnings: Issue[] }
  | { ok: false; error: { code: ErrorCode; message: string; details?: Record<string, unknown> }; warnings: Issue[] };

type ToolCallResult = { content: Array<{ type: 'text'; text: string }> };

function wrap(body: unknown): ToolCallResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
}

export function ok<T>(data: T, warnings: Issue[] = []): ToolCallResult {
  const env: Envelope<T> = { ok: true, data, warnings };
  return wrap(env);
}

export function fail(
  code: ErrorCode,
  message: string,
  options?: { details?: Record<string, unknown>; warnings?: Issue[] },
): ToolCallResult {
  const error = options?.details !== undefined
    ? { code, message, details: options.details }
    : { code, message };
  const env: Envelope<never> = { ok: false, error, warnings: options?.warnings ?? [] };
  return wrap(env);
}

export function adaptIssue(v: ValidationIssue | ToolIssue): Issue {
  // Discriminator: ValidationIssue has severity: 'error' (required); ToolIssue has no severity.
  // If ToolIssue ever gains a severity field, update this discriminator to use a more explicit check.
  if ('severity' in v) {
    const issue: Issue = {
      code: v.code,
      message: v.message,
      severity: v.severity,
    };
    if (v.field !== undefined) issue.field = v.field;
    if (v.details !== undefined) issue.details = v.details;
    return issue;
  }
  const issue: Issue = { code: v.code, message: v.message, severity: 'warning' };
  if (v.characters !== undefined) issue.details = { characters: v.characters };
  return issue;
}

/**
 * A write refused for setting a field named like the type key (#480): VALIDATION_FAILED
 * with the refusal as its message, so a caller reads what to use without opening details.
 */
export function failTypeKeyField(issue: ValidationIssue): ToolCallResult {
  return fail('VALIDATION_FAILED', issue.message, { details: { field: issue.field, issues: [adaptIssue(issue)] } });
}

/** A PipelineError optionally annotated with the file_path of the node that failed. */
export type PipelineErrorWithNode = PipelineError & { node_file_path?: string };

export interface DescribedPipelineError {
  code: 'VALIDATION_FAILED';
  message: string;
  details: {
    issues: Issue[];
    fixable?: ReturnType<typeof buildFixable>;
    node_file_path?: string;
  };
}

/**
 * Map a thrown error to a structured VALIDATION_FAILED descriptor when it is a
 * PipelineError (the tool-path validation failure executeMutation throws),
 * reusing adaptIssue + buildFixable like create-node does. Returns null for any
 * other error so callers fall back to INTERNAL_ERROR. If the error was annotated
 * with `node_file_path` (the referencing note a ref-rewrite failed on), the
 * message names it and it is surfaced in details.
 */
export function describePipelineError(err: unknown): DescribedPipelineError | null {
  if (!(err instanceof PipelineError)) return null;
  const nodePath = (err as PipelineErrorWithNode).node_file_path;
  const prefix = nodePath ? `Re-rendering referencing note "${nodePath}" failed: ` : '';

  if (err.validation) {
    const errorCount = err.validation.issues.filter(i => i.severity === 'error').length;
    const details: DescribedPipelineError['details'] = {
      issues: err.validation.issues.map(adaptIssue),
      fixable: buildFixable(err.validation.issues, err.validation.effective_fields),
    };
    if (nodePath) details.node_file_path = nodePath;
    return { code: 'VALIDATION_FAILED', message: `${prefix}Validation failed with ${errorCount} error(s)`, details };
  }

  const details: DescribedPipelineError['details'] = { issues: [] };
  if (nodePath) details.node_file_path = nodePath;
  return { code: 'VALIDATION_FAILED', message: `${prefix}${err.message}`, details };
}
