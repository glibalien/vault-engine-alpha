import { z } from 'zod';
import { PROVIDERS } from '@vault/settings-registry';
import { canonicalJson } from './canonical.js';
import { ProvenanceError } from './limits.js';
import type { BundleV1, Json } from './types.js';

function invalid(): never { throw new ProvenanceError('PROVENANCE_LIMIT'); }
/** OpenRouter's reasoning control as the Curator sends it: a token budget and nothing else (#429). */
export const reasoningBudgetSchema = z.object({
  max_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
function object(value: Json | undefined): Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : invalid();
}
function string(value: Json | undefined): string { return typeof value === 'string' ? value : invalid(); }
function canonical(value: Json | undefined): string { return canonicalJson(value === undefined ? invalid() : value); }

/** Decode only fields present in the effective page request sent by the adapter. */
export function deriveSubpageDecodedFields(provider: BundleV1['provider'], payload: Json): Record<string, string> {
  const p = object(payload);
  const limit = PROVIDERS[provider].maxTokensField;
  const allowed = provider === 'anthropic'
    ? ['model', limit, 'system', 'tools', 'tool_choice', 'messages']
    : ['model', limit, 'messages', 'user', 'context_length_exceeded_behavior', 'reasoning_effort', 'reasoning'];
  if (Object.keys(p).some(key => !allowed.includes(key))
    || (p.reasoning !== undefined && !reasoningBudgetSchema.safeParse(p.reasoning).success)
    || typeof p.model !== 'string' || !Number.isSafeInteger(p[limit]) || (p[limit] as number) < 1) invalid();
  const message = z.object({ role: z.enum(['system', 'user']), content: z.string() }).strict();
  const messages = z.array(message).safeParse(p.messages);
  if (!messages.success) invalid();
  let system: string;
  let user: string;
  if (provider === 'anthropic') {
    const blocks = z.array(z.object({ type: z.literal('text'), text: z.string(),
      cache_control: z.object({ type: z.literal('ephemeral') }).strict(),
    }).strict()).length(1).safeParse(p.system);
    const tools = z.array(z.object({ name: z.string().min(1).max(512), description: z.string().max(4096), input_schema: z.unknown() }).strict()).length(1).safeParse(p.tools);
    const choice = z.object({ type: z.literal('tool'), name: z.string().min(1).max(512), disable_parallel_tool_use: z.boolean().optional() }).strict().safeParse(p.tool_choice);
    if (!blocks.success || !tools.success || !choice.success || choice.data.name !== tools.data[0].name
      || messages.data.length !== 1 || messages.data[0].role !== 'user') invalid();
    system = blocks.data[0].text;
    user = messages.data[0].content;
  } else {
    if (messages.data.length !== 2 || messages.data[0].role !== 'system' || messages.data[1].role !== 'user') invalid();
    for (const key of ['user', 'context_length_exceeded_behavior', 'reasoning_effort']) {
      if (p[key] !== undefined && typeof p[key] !== 'string') invalid();
    }
    system = messages.data[0].content;
    user = messages.data[1].content;
  }
  let content: Record<string, Json>;
  try { content = object(JSON.parse(user) as Json); } catch { return invalid(); }
  const action = string(content.action);
  if (!['create', 'refresh', 'reactivate', 'merge'].includes(action)) invalid();
  const decoded: Record<string, string> = {
    system, user, action, title: string(content.title), kind: string(content.kind),
    scope: canonical(object(content.scope)), synthesis_brief: string(content.synthesis_brief),
    evidence: string(content.evidence), sibling_scopes: canonical(Array.isArray(content.sibling_scopes) ? content.sibling_scopes : invalid()),
  };
  if (content.current_target !== undefined) decoded.current_target = canonical(object(content.current_target));
  if (content.merge_sources !== undefined) decoded.merge_sources = canonical(Array.isArray(content.merge_sources) ? content.merge_sources : invalid());
  if (content.source_files_remain_historical !== undefined) {
    if (typeof content.source_files_remain_historical !== 'boolean') invalid();
    decoded.source_files_remain_historical = String(content.source_files_remain_historical);
  }
  return decoded;
}

/** Bind the descriptor to target identity actually present in the page prompt. */
export function validateSubpageTarget(target: BundleV1['target'], fields: Record<string, string>): void {
  if (!target) invalid();
  const hasNodeId = 'node_id' in target;
  if (fields.action === 'create' && hasNodeId) invalid();
  if ((fields.action === 'refresh' || fields.action === 'reactivate') && !hasNodeId) invalid();
  if (hasNodeId) {
    if (fields.current_target === undefined) invalid();
    let current: Record<string, Json>;
    try { current = object(JSON.parse(fields.current_target) as Json); } catch { return invalid(); }
    if (current.id !== target.node_id) invalid();
  } else if (fields.current_target !== undefined) {
    invalid();
  }
}
