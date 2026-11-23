import type { Issue } from '../mcp/tools/errors.js';
import { PROPOSED_REFERENCE_NODE_ID, type ReferenceDiagnostic } from '../pipeline/diagnostics.js';

const MAX_ISSUES = 50;
const MAX_DETAILS_BYTES = 32 * 1024;
// Iteration stops at the excerpt boundary, including for very large Unicode input.
function excerpt(value: string, limit = 512): string {
  let result = ''; let count = 0;
  for (const char of value) { if (count++ === limit) break; result += char; }
  return result;
}
const bytes = (issue: Issue) => Buffer.byteLength(JSON.stringify(issue.details));

/** One invocation per response (including all batch operations). Missing stays silent. */
export function buildReferenceWarnings(
  diagnostics: Iterable<ReferenceDiagnostic>, options: { opIndex?: number } = {},
): Issue[] {
  const warnings: Issue[] = [];
  let observed = 0;
  let size = 0;
  for (const diagnostic of diagnostics) {
    const { request, resolution } = diagnostic;
    const currentId = resolution.status === 'resolved' ? resolution.targetId : null;
    const stale = diagnostic.storedTargetId !== undefined && diagnostic.storedTargetId !== currentId;
    const reason = resolution.status === 'unresolved' ? resolution.reason : 'resolved';
    const codes: Issue['code'][] = [];
    if (reason === 'ambiguous') codes.push('REFERENCE_AMBIGUOUS');
    if (reason === 'type_mismatch') codes.push('REFERENCE_TARGET_TYPE_MISMATCH');
    if (stale) codes.push('REFERENCE_RESOLUTION_STALE');
    for (const code of codes) {
      observed++;
      if (warnings.length >= MAX_ISSUES) continue;
      const raw = excerpt(request.rawTarget);
      let detailTruncated = false;
      const bounded = (text: string | null): string | null => {
        if (text === null) return null;
        const result = excerpt(text); detailTruncated ||= result !== text; return result;
      };
      const candidates = resolution.candidates.slice(0, 10).map(candidate => ({
        id: candidate.id === PROPOSED_REFERENCE_NODE_ID ? null : bounded(candidate.id), file_path: bounded(candidate.file_path),
        ...(candidate.id === PROPOSED_REFERENCE_NODE_ID ? { proposed: true } : {}),
      }));
      const details = {
        reason, required_type: bounded(request.context.requiredType), source_id: bounded(diagnostic.sourceId),
        field: bounded(request.context.field), raw_target: raw, raw_target_truncated: raw !== request.rawTarget,
        candidate_count: resolution.candidateCount, candidates,
        candidates_truncated: resolution.candidatesTruncated || resolution.candidateCount > candidates.length,
        tier: resolution.tier,
        ...(stale ? { stored_target_id: bounded(diagnostic.storedTargetId!), current_target_id: bounded(currentId) } : {}),
        details_truncated: detailTruncated,
      };
      const issue: Issue = { code, severity: 'warning',
        message: code === 'REFERENCE_RESOLUTION_STALE' ? 'Stored reference resolution differs from the current policy.'
          : code === 'REFERENCE_AMBIGUOUS' ? 'Reference matches multiple eligible targets.' : 'Reference target does not have the required type.',
        ...(request.context.field === null ? {} : { field: excerpt(request.context.field) }), details,
        ...((diagnostic.opIndex ?? options.opIndex) === undefined ? {} : { op_index: diagnostic.opIndex ?? options.opIndex }),
      };
      // Reserve space for a response-level truncation notice before accepting details.
      if (size + bytes(issue) > MAX_DETAILS_BYTES - 256) continue;
      warnings.push(issue); size += bytes(issue);
    }
  }
  if (observed > warnings.length) {
    if (warnings.length === MAX_ISSUES) warnings.pop();
    warnings.push({ code: 'RESULT_TRUNCATED', severity: 'warning', message: 'Reference diagnostics were truncated.',
      details: { diagnostic_kind: 'reference', observed_count: observed, reported_count: warnings.length,
        truncated: true, max_issues: MAX_ISSUES, max_details_bytes: MAX_DETAILS_BYTES } });
  }
  return warnings;
}

/** Post-ingestion observer only; diagnostics must never fail the committed mutation. */
export function logReferenceDiagnostics(diagnostics: Iterable<ReferenceDiagnostic>, source: 'watcher' | 'indexer'): void {
  try {
    const warnings = buildReferenceWarnings(diagnostics);
    if (warnings.length > 0) console.warn(`[${source}] Reference diagnostics:`, JSON.stringify(warnings));
  } catch {
    // Console sinks and diagnostic inspection are best-effort observers.
  }
}
