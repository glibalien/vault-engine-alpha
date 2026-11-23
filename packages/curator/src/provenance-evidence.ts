import { createHash } from 'node:crypto';
import type { BundleV1, InputItem, InputRole, Json, SourceObservation } from './provenance-types.js';
import type { PreparedCapture } from './llm/types.js';

// Same versioned wire algorithm as Engine; the integration tests validate bytes
// through Engine's validator. No production import crosses the MCP boundary.
export function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key]!)).join(',') + '}';
}
export function jsonDigest(value: Json): string {
  return 'sha256:json-v1:' + createHash('sha256').update('json-v1\0').update(canonical(value)).digest('hex');
}
export function spanDigest(spans: InputItem['spans'], fields: Record<string, string>): string {
  return jsonDigest(spans.map(span => ({ ...span, text: Buffer.from(fields[span.field] ?? '', 'utf8').subarray(span.start, span.end).toString('utf8') })));
}

export interface CorrectionInput { note: string; observation: SourceObservation }
type Pending = { start: number; end: number; observation: SourceObservation | null; role: InputRole;
  selection: string; truncated: boolean; originalBytes: number | null };

/** Records line positions while formatting, never searches rendered titles/text. */
export class EvidenceCollector {
  readonly items: InputItem[] = [];
  readonly omissions: BundleV1['omissions'] = [];
  private readonly pending: Pending[] = [];
  constructor(readonly observations: Readonly<Record<string, SourceObservation>>, readonly corrections: readonly CorrectionInput[] = [], readonly assemblyContext?: BundleV1['assembly_context']) {}

  record(lines: string[], start: number, observation: SourceObservation | undefined | null, role: InputRole, selection: string, truncated = false, originalBytes: number | null = null): void {
    if (observation === undefined) throw new Error('PROVENANCE_OBSERVATION_MISSING');
    if (start === lines.length) return;
    this.pending.push({ start, end: lines.length, observation, role, selection, truncated, originalBytes });
  }
  catalog(lines: string[], start: number, ids: readonly string[], role: InputRole, selection: string): void {
    for (const id of new Set(ids)) this.record(lines, start, this.observations[id], role, selection);
  }
  finish(lines: string[], text: string): void {
    const starts = [0];
    for (const line of lines) starts.push(starts[starts.length - 1]! + Buffer.byteLength(line, 'utf8') + 1);
    const bytes = Buffer.byteLength(text, 'utf8');
    for (const pending of this.pending) {
      const start = Math.min(starts[pending.start]!, bytes);
      const end = Math.min(starts[pending.end]! - 1, bytes);
      const spans = [{ field: 'evidence', start, end }];
      this.items.push({ key: `evidence:${this.items.length}`, observation: pending.observation, role: pending.role,
        upstream_derivation_id: null, selection: pending.selection, spans, original_bytes: pending.originalBytes,
        retained_bytes: end - start, input_digest: spanDigest(spans, { evidence: text }), truncated: pending.truncated,
        origin: pending.observation ? 'identified' : 'opaque' });
    }
  }
}

export const HOME_BUDGET_ASSEMBLY = 'project-home-evidence-budget-v1';

/** The labels a capture records for its prompt, schema and output: a project home's unless a caller
 *  that writes a home of its own shape (a dossier, #554) names its own. */
export type CaptureTransformLabels = { readonly prompt: string; readonly schema: string; readonly output: string };
const HOME_TRANSFORM: CaptureTransformLabels = { prompt: 'project-home-v1', schema: 'home-sections-v1', output: 'managed-home-contribution-v1' };

export function capturedBundle(capture: PreparedCapture, collector: EvidenceCollector, assembly = 'project-home-evidence-v1',
  labels: CaptureTransformLabels = HOME_TRANSFORM): BundleV1 {
  const p = capture.payload as Record<string, Json>;
  const messages = p.messages as Array<{ role: string; content: string }>;
  const anthropic = capture.provider === 'anthropic';
  const user = messages[anthropic ? 0 : 1]!.content;
  const input = JSON.parse(user) as { evidence: string; accepted_page_index: Json };
  const system = anthropic ? (p.system as Array<{ text: string }>)[0]!.text : messages[0]!.content;
  const schema = anthropic ? (p.tools as Array<{ input_schema: Json }>)[0]!.input_schema
    : ((p.response_format as Record<string, Json>).json_schema as Record<string, Json>).schema!;
  const decoded_fields = { system, user, evidence: input.evidence, page_index: canonical(input.accepted_page_index), schema: canonical(schema) };
  const items = [...collector.items];
  for (const field of ['system', 'page_index', 'schema'] as const) {
    const spans = [{ field, start: 0, end: Buffer.byteLength(decoded_fields[field]) }];
    items.push({ key: field, observation: null, role: 'generated_context', upstream_derivation_id: null,
      selection: `${field}:v1`, spans, original_bytes: null, retained_bytes: spans[0]!.end,
      input_digest: spanDigest(spans, decoded_fields), truncated: false, origin: 'opaque' });
  }
  return { version: 1, provider: capture.provider, model: capture.model, provider_payload: capture.payload,
    ...(collector.assemblyContext ? { assembly_context: collector.assemblyContext } : {}),
    decoded_fields, items, omissions: collector.omissions, dependency_coverage: 'direct_with_opaque_components',
    transform: { assembly, prompt: labels.prompt, schema: labels.schema, adapter: capture.adapter_version, output: labels.output } };
}
