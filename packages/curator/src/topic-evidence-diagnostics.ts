import { z } from 'zod';
import type { TopicEvidenceSelection } from './topic-evidence-selection.js';
const count = z.number().int().nonnegative();
const summarySchema = z.strictObject({
  stage: z.enum(['planner', 'adjudicator', 'page', 'home']), target: z.string().max(200).optional(),
  attempt: count, maxBytes: count, requestBytes: count, selectedCount: count, excerptedCount: count, omittedCount: count,
  omissionCounts: z.record(z.enum(['unavailable', 'not_selected', 'per_source_limit', 'request_limit']), count),
  affectedSourceIds: z.array(z.string().max(200)).max(20), affectedSourceIdsTruncated: z.boolean(), selectionFallback: z.boolean(),
});
const diagnosticsSchema = z.strictObject({ version: z.literal(1), calls: z.array(summarySchema).max(64), omittedCallCount: count });
export type TopicEvidenceCallSummary = z.infer<typeof summarySchema>;
export type TopicEvidenceDiagnostics = z.infer<typeof diagnosticsSchema>;

export function createEvidenceDiagnostics() {
  const calls: TopicEvidenceCallSummary[] = [];
  const attempts = new Map<string, number>();
  let omittedCallCount = 0;
  return {
    record(stage: TopicEvidenceCallSummary['stage'], target: string | undefined, selection: TopicEvidenceSelection,
      requestBytes: number, maxBytes: number, selectionFallback: boolean): void {
      const key = stage + ':' + (target ?? '');
      const attempt = attempts.get(key) ?? 0; attempts.set(key, attempt + 1);
      const counts = { unavailable: 0, not_selected: 0, per_source_limit: 0, request_limit: 0 };
      for (const o of selection.omissions) counts[o.reason]++;
      const affected = [...new Set(selection.omissions.map(o => o.sourceId))];
      const summary: TopicEvidenceCallSummary = { stage, ...(target ? { target: target.slice(0, 200) } : {}),
        attempt, requestBytes, maxBytes, selectedCount: selection.excerpts.length,
        excerptedCount: selection.excerpts.filter(e => e.retainedBytes < e.originalBytes).length,
        omittedCount: selection.omissions.length, omissionCounts: counts,
        affectedSourceIds: affected.slice(0, 20).map(id => id.slice(0, 200)),
        affectedSourceIdsTruncated: affected.length > 20 || affected.some(id => id.length > 200), selectionFallback };
      if (calls.length >= 64 || Buffer.byteLength(JSON.stringify({ version: 1, calls: [...calls, summary], omittedCallCount })) > 32000) {
        omittedCallCount++; return;
      }
      calls.push(summary);
    },
    snapshot(): TopicEvidenceDiagnostics { return { version: 1, calls: [...calls], omittedCallCount }; },
  };
}
export function topicCoverageNote(selection: TopicEvidenceSelection): string | null {
  const partial = selection.excerpts.some(e => e.retainedBytes < e.originalBytes);
  if (!partial && selection.omissions.length === 0) return null;
  const unavailable = selection.omissions.some(o => o.reason === 'unavailable');
  return 'Source coverage: This page uses selected excerpts or a subset of available sources; omitted material was not reviewed in full.'
    + (unavailable ? ' Some sources were unavailable.' : '');
}
/** Start a standalone paragraph before any model-controlled Markdown construct. */
export function withTopicCoverage(body: string, coverage: string | null): string {
  if (!coverage || body.startsWith(coverage + '\n\n')) return body;
  return coverage + '\n\n' + body;
}
export function readEvidenceDiagnostics(raw: string | null): TopicEvidenceDiagnostics | undefined {
  if (!raw || Buffer.byteLength(raw) > 128000) return undefined;
  try {
    const parsed = diagnosticsSchema.safeParse(JSON.parse(raw).evidence_selection);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}
