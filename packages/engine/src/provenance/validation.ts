import { z } from 'zod';
import { MODEL_PROVIDERS, PROVIDERS } from '@vault/settings-registry';
import { canonicalJson, digestJson } from './canonical.js';
import { ProvenanceError, validateLimits, type ProvenanceLimits } from './limits.js';
import type { BundleV1, InputItem, Json, ProvenanceFlow } from './types.js';
import { deriveSubpageDecodedFields, reasoningBudgetSchema, validateSubpageTarget } from './subpage-validation.js';

const bounded = z.string().min(1).max(512);
const digest = z.string().regex(/^sha256:(json|text)-v1:[a-f0-9]{64}$/);
export const sourceKeySchema = z.object({
  kind: z.enum(['node', 'memory', 'curator_correction', 'generated_context', 'engine_projection']),
  namespace: bounded, native_id: bounded,
}).strict();
export const observationSchema = z.object({
  source: sourceKeySchema, authority: z.enum(['engine', 'caller']), observed_at: z.string().datetime(),
  native_version: z.number().int().nonnegative().nullable(), content_hash: z.string().max(256).nullable(),
  hash_semantics: z.enum(['engine_content_hash', 'selected_projection_v1', 'caller_content_v1']),
  observation_projection: z.enum(['node-token-v1', 'node-token-v2', 'memory-content-v1', 'caller-content-v1']),
  observation_digest: digest, label: z.string().max(4096).nullable(), path: z.string().max(4096).nullable(),
}).strict();
const spanSchema = z.object({ field: bounded, start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict();
export const itemSchema = z.object({
  key: bounded, observation: observationSchema.nullable(),
  role: z.enum(['source_material', 'generated_context', 'human_correction', 'engine_projection']),
  upstream_derivation_id: bounded.nullable(), selection: bounded, spans: z.array(spanSchema).min(1).max(512),
  original_bytes: z.number().int().nonnegative().nullable(), retained_bytes: z.number().int().nonnegative(),
  input_digest: digest, truncated: z.boolean(), origin: z.enum(['identified', 'opaque']),
}).strict();
export const bundleSchema = z.object({
  version: z.literal(1), provider: z.enum(MODEL_PROVIDERS), model: bounded,
  target: z.union([z.object({ node_id: bounded }).strict(), z.object({ plan_key: bounded }).strict()]).optional(),
  provider_payload: z.unknown(), decoded_fields: z.record(z.string(), z.string()),
  items: z.array(itemSchema).max(512),
  omissions: z.array(z.object({ code: bounded, source: sourceKeySchema.nullable() }).strict()).max(512),
  dependency_coverage: z.enum(['complete_direct', 'direct_with_opaque_components']),
  assembly_context: z.object({ evidence_hash: bounded, evaluated_at: bounded,
    query: z.object({ project: bounded, meeting_recent_limit: z.number().int().min(0).max(100),
      meeting_upcoming_limit: z.number().int().min(0).max(100), contact_limit: z.number().int().min(0).max(100),
      since: bounded.nullable() }).strict() }).strict().optional(),
  transform: z.object({ assembly: bounded, prompt: bounded, schema: bounded, adapter: bounded, output: bounded }).strict(),
}).strict();
export const prepareSchema = z.object({
  flow: z.enum(['project-home-v1', 'project-subpage-v1']).optional(),
  attempt_key: z.string().uuid(), run_ref: z.string().uuid(), project_id: bounded,
  predecessor_attempt_id: z.string().uuid().optional(), bundle: bundleSchema, dry_run: z.boolean(),
}).strict();
export const contributionSchema = z.array(z.object({
  name: bounded, mode: z.enum(['replace', 'append']), content: z.string(),
}).strict()).min(1).max(6);
export const stageSchema = z.object({
  derivation_id: z.string().uuid(), bundle_digest: digest,
  validated_sections: z.record(z.string(), z.string()), contribution: contributionSchema,
  generated_at: z.string().datetime(), log_stamp: z.string().max(128),
}).strict();

function invalid(): never { throw new ProvenanceError('PROVENANCE_LIMIT'); }
function object(v: Json | undefined): Record<string, Json> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return invalid();
  return v;
}
function string(v: Json | undefined): string { return typeof v === 'string' ? v : invalid(); }

/** Keys name decoded request strings. Evidence/page_index come from the JSON user
 * message; schema is canonicalized because the SDK sends it as an object. */
export function deriveDecodedFields(provider: BundleV1['provider'], payload: Json): Record<string, string> {
  const p = object(payload);
  const limit = PROVIDERS[provider].maxTokensField;
  const allowed = provider === 'anthropic'
    ? ['model', limit, 'system', 'tools', 'tool_choice', 'messages']
    : ['model', limit, 'messages', 'response_format', 'user', 'context_length_exceeded_behavior', 'reasoning_effort', 'reasoning'];
  if (Object.keys(p).some(k => !allowed.includes(k))) invalid();
  if (p.reasoning !== undefined && !reasoningBudgetSchema.safeParse(p.reasoning).success) invalid();
  const textMessage = z.object({ role: z.enum(['system', 'user']), content: z.string() }).strict();
  const parsed = z.array(textMessage).safeParse(p.messages);
  if (!parsed.success) return invalid();
  let system: string;
  let user: string;
  let schema: Json;
  if (provider === 'anthropic') {
    const blocks = z.array(z.object({ type: z.literal('text'), text: z.string(),
      cache_control: z.object({ type: z.literal('ephemeral') }).strict(),
    }).strict()).length(1).safeParse(p.system);
    const tool = z.array(z.object({ name: bounded, description: z.string().max(4096), input_schema: z.unknown() }).strict()).length(1).safeParse(p.tools);
    const choice = z.object({ type: z.literal('tool'), name: bounded, disable_parallel_tool_use: z.boolean().optional() }).strict().safeParse(p.tool_choice);
    if (!blocks.success || !tool.success || !choice.success || parsed.data.length !== 1 || parsed.data[0].role !== 'user') return invalid();
    system = blocks.data[0].text; user = parsed.data[0].content; schema = tool.data[0].input_schema as Json;
  } else {
    if (parsed.data.length !== 2 || parsed.data[0].role !== 'system' || parsed.data[1].role !== 'user') return invalid();
    system = parsed.data[0].content; user = parsed.data[1].content;
    const format = z.object({ type: z.literal('json_schema'), json_schema: z.object({ name: bounded, schema: z.unknown() }).strict() }).strict().safeParse(p.response_format);
    if (!format.success) return invalid();
    schema = format.data.json_schema.schema as Json;
  }
  if (typeof p.model !== 'string' || !Number.isSafeInteger(p[limit]) || (p[limit] as number) < 1) invalid();
  for (const key of ['user', 'context_length_exceeded_behavior', 'reasoning_effort']) {
    if (p[key] !== undefined && typeof p[key] !== 'string') invalid();
  }
  let content: Record<string, Json>;
  try { content = object(JSON.parse(user) as Json); } catch { return invalid(); }
  return { system, user, evidence: string(content.evidence), page_index: canonicalJson(content.accepted_page_index ?? null), schema: canonicalJson(schema) };
}

export function selectedSpan(span: InputItem['spans'][number], fields: Record<string, string>): string {
  if (!Object.hasOwn(fields, span.field)) return invalid();
  const bytes = Buffer.from(fields[span.field], 'utf8');
  if (span.start > span.end || span.end > bytes.length) return invalid();
  for (const position of [span.start, span.end]) {
    if (position < bytes.length && (bytes[position] & 0xc0) === 0x80) invalid();
  }
  return bytes.subarray(span.start, span.end).toString('utf8');
}

export function inputDigest(spans: InputItem['spans'], fields: Record<string, string>): string {
  return digestJson(spans.map(span => ({ ...span, text: selectedSpan(span, fields) })));
}

export interface ValidatedBundle {
  bundle: BundleV1;
  canonical: string;
  digest: string;
  payloadBytes: number;
  reservedBytes: number;
}

export function validateBundle(bundle: BundleV1, limits: ProvenanceLimits, flow: ProvenanceFlow = 'project-home-v1'): ValidatedBundle {
  validateLimits(limits);
  try {
    const canonical = canonicalJson(bundle as unknown as Json);
    const payloadBytes = Buffer.byteLength(canonical, 'utf8');
    if (payloadBytes > limits.totalBytes || !bundleSchema.safeParse(bundle).success) return invalid();
    if (Buffer.byteLength(canonicalJson(bundle.provider_payload)) > limits.requestBytes) invalid();
    if (object(bundle.provider_payload).model !== bundle.model) invalid();
    if (flow === 'project-subpage-v1') {
      const adapters = bundle.provider === 'anthropic' ? ['anthropic-v1']
        : ['openai-compat-v1', 'openai-compat-page-markdown-v1'];
      if (!bundle.target || bundle.transform.assembly !== 'project-subpage-evidence-v1'
        || bundle.transform.prompt !== 'project-subpage-v1' || bundle.transform.schema !== 'page-synthesis-v1'
        || bundle.transform.output !== 'managed-subpage-contribution-v1'
        || !adapters.includes(bundle.transform.adapter)) invalid();
    }
    if (flow === 'project-home-v1' && (bundle.transform.assembly === 'project-subpage-evidence-v1'
      || bundle.transform.prompt === 'project-subpage-v1' || bundle.transform.schema === 'page-synthesis-v1'
      || bundle.transform.output === 'managed-subpage-contribution-v1')) invalid();
    const decoded = flow === 'project-subpage-v1'
      ? deriveSubpageDecodedFields(bundle.provider, bundle.provider_payload)
      : deriveDecodedFields(bundle.provider, bundle.provider_payload);
    if (canonicalJson(decoded) !== canonicalJson(bundle.decoded_fields)) invalid();
    if (flow === 'project-subpage-v1') validateSubpageTarget(bundle.target, decoded);
    if (bundle.items.length > limits.itemCount || new Set(bundle.items.map(i => i.key)).size !== bundle.items.length) invalid();
    for (const item of bundle.items) {
      const retained = item.spans.reduce((n, span) => n + Buffer.byteLength(selectedSpan(span, bundle.decoded_fields)), 0);
      if (retained !== item.retained_bytes || retained > limits.componentBytes
        || item.input_digest !== inputDigest(item.spans, bundle.decoded_fields)
        || (item.original_bytes !== null && item.original_bytes < retained && !item.truncated)
        || (item.origin === 'identified' && item.observation === null)
        || (item.origin === 'opaque' && bundle.dependency_coverage === 'complete_direct')) invalid();
    }
    return { bundle, canonical, digest: digestJson(bundle as unknown as Json), payloadBytes, reservedBytes: limits.totalBytes };
  } catch (error) {
    if (error instanceof ProvenanceError) throw error;
    return invalid();
  }
}
