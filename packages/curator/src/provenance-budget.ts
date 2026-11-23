import { z } from 'zod';
import { canonical, spanDigest } from './provenance-evidence.js';
import type { BundleV1, Json, SourceObservation } from './provenance-types.js';

export type CaptureLimits = { componentBytes: number; itemCount: number; requestBytes: number; totalBytes: number };
export type BudgetDimension = 'component' | 'items' | 'request' | 'bundle' | 'omissions';
export type BudgetIssue = { dimension: BudgetDimension; measured: number; allowed: number };
// Wire v1 hard maxima; effective limits can be lower. Engine remains authoritative.
const MAXIMA: CaptureLimits = { componentBytes: 262144, itemCount: 512, requestBytes: 1048576, totalBytes: 2097152 };
export const MAX_PROVENANCE_OMISSIONS = 512;

export function readCaptureLimits(raw: Record<string, number>): CaptureLimits {
  const limits = {} as CaptureLimits;
  for (const key of Object.keys(MAXIMA) as Array<keyof CaptureLimits>) {
    const value = raw[key];
    if (!Number.isSafeInteger(value) || value! < 1 || value! > MAXIMA[key]) throw new Error('PROVENANCE_LIMITS_INVALID');
    limits[key] = value!;
  }
  if (limits.componentBytes > limits.requestBytes || limits.requestBytes > limits.totalBytes) throw new Error('PROVENANCE_LIMITS_INVALID');
  return Object.freeze(limits);
}

const bounded = z.string().min(1).max(512);
const observationSchema = z.object({
  source: z.object({ kind: z.enum(['node', 'memory', 'curator_correction', 'generated_context', 'engine_projection']),
    namespace: bounded, native_id: bounded }).strict(),
  authority: z.enum(['engine', 'caller']), observed_at: z.string().datetime(),
  native_version: z.number().int().nonnegative().nullable(), content_hash: z.string().max(256).nullable(),
  hash_semantics: z.enum(['engine_content_hash', 'selected_projection_v1', 'caller_content_v1']),
  observation_projection: z.enum(['node-token-v1', 'node-token-v2', 'memory-content-v1', 'caller-content-v1']),
  observation_digest: z.string().regex(/^sha256:(json|text)-v1:[a-f0-9]{64}$/),
  label: z.string().max(4096).nullable(), path: z.string().max(4096).nullable(),
}).strict();

/** Size omissions must not conceal malformed or missing source attribution. */
export function assertSourceObservation(value: unknown): asserts value is SourceObservation {
  if (value == null) throw new Error('PROVENANCE_OBSERVATION_MISSING');
  if (!observationSchema.safeParse(value).success) throw new Error('PROVENANCE_ATTRIBUTION_INVALID');
}

export class EvidenceBudgetError extends Error {
  constructor(readonly stage: 'selection' | 'preflight', readonly issue: BudgetIssue) {
    super(`PROVENANCE_EVIDENCE_BUDGET stage=${stage} dimension=${issue.dimension} measured=${issue.measured} allowed=${issue.allowed}`);
    this.name = 'EvidenceBudgetError';
  }
}

function invalid(): never { throw new Error('PROVENANCE_ATTRIBUTION_INVALID'); }

/** Measures the serialized input bundle, not output reservation or model tokens. */
export function measureBundle(bundle: BundleV1, limits: CaptureLimits): BudgetIssue | null {
  let maxComponent = 0;
  for (const item of bundle.items) {
    if (item.origin === 'identified') assertSourceObservation(item.observation);
    let retained = 0;
    for (const span of item.spans) {
      const field = bundle.decoded_fields[span.field];
      if (typeof field !== 'string') invalid();
      const bytes = Buffer.from(field, 'utf8');
      if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
        || span.start < 0 || span.end < span.start || span.end > bytes.length) invalid();
      for (const position of [span.start, span.end]) {
        if (position < bytes.length && (bytes[position]! & 0xc0) === 0x80) invalid();
      }
      retained += span.end - span.start;
    }
    if (retained !== item.retained_bytes || item.input_digest !== spanDigest(item.spans, bundle.decoded_fields)) invalid();
    maxComponent = Math.max(maxComponent, retained);
  }
  const checks: Array<[BudgetDimension, number, number]> = [
    ['component', maxComponent, limits.componentBytes], ['items', bundle.items.length, limits.itemCount],
    ['request', Buffer.byteLength(canonical(bundle.provider_payload)), limits.requestBytes],
    ['bundle', Buffer.byteLength(canonical(bundle as unknown as Json)), limits.totalBytes],
    ['omissions', bundle.omissions.length, MAX_PROVENANCE_OMISSIONS],
  ];
  const issue = checks.find(([, measured, allowed]) => measured > allowed);
  return issue ? { dimension: issue[0], measured: issue[1], allowed: issue[2] } : null;
}
