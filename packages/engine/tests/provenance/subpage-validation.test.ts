import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/provenance/canonical.js';
import { DEFAULT_PROVENANCE_LIMITS } from '../../src/provenance/limits.js';
import { normalizeContribution } from '../../src/provenance/output-binding.js';
import type { BundleV1, Json } from '../../src/provenance/types.js';
import { inputDigest, validateBundle } from '../../src/provenance/validation.js';
import { deriveSubpageDecodedFields } from '../../src/provenance/subpage-validation.js';
import { bundleFixture } from './fixture.js';

const sentUser = '{"action":"refresh","title":"Decisions","kind":"decision-log","scope":{"summary":"α"},"synthesis_brief":"Write Decision α","evidence":"path: C:\\\\vault\\nDecision α","sibling_scopes":[],"current_target":{"id":"page-1","title":"Decisions","body":"Prior \\u03b1"}}';
const sentSystem = 'Page system\n\n# Output\nReturn body and log.\nRespond with a single JSON object matching this JSON Schema:\n{"type":"object","properties":{"body":{"type":"string"}}}';
const pageSchema = { type: 'object', properties: { body: { type: 'string' } } };
const decoded = {
  system: sentSystem, user: sentUser, evidence: 'path: C:\\vault\nDecision α',
  action: 'refresh', title: 'Decisions', kind: 'decision-log', scope: '{"summary":"α"}',
  synthesis_brief: 'Write Decision α', sibling_scopes: '[]',
  current_target: '{"body":"Prior α","id":"page-1","title":"Decisions"}',
};

function payload(provider: BundleV1['provider']): Json {
  if (provider === 'anthropic') return {
    model: 'test', max_tokens: 4000,
    system: [{ type: 'text', text: sentSystem, cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'emit_scoped_page', description: 'Return body and log.', input_schema: pageSchema }],
    tool_choice: { type: 'tool', name: 'emit_scoped_page' },
    messages: [{ role: 'user', content: sentUser }],
  };
  return { model: 'test', ...(provider === 'openai' ? { max_completion_tokens: 4000 } : { max_tokens: 4000 }),
    messages: [{ role: 'system', content: sentSystem }, { role: 'user', content: sentUser }],
    ...(provider === 'fireworks' ? { user: 'vault-curator', context_length_exceeded_behavior: 'error' } : {}),
  };
}
function pageBundle(provider: BundleV1['provider'], target: BundleV1['target'] = { node_id: 'page-1' }): BundleV1 {
  const spans = [{ field: 'evidence', start: 0, end: Buffer.byteLength(decoded.evidence) }];
  const briefSpans = [{ field: 'synthesis_brief', start: 0, end: Buffer.byteLength(decoded.synthesis_brief) }];
  return { version: 1, provider, model: 'test', target, provider_payload: payload(provider), decoded_fields: { ...decoded },
    items: [{ key: 'evidence', observation: null, role: 'generated_context', upstream_derivation_id: null,
      selection: 'page-evidence:v1', spans, original_bytes: null, retained_bytes: Buffer.byteLength(decoded.evidence),
      input_digest: inputDigest(spans, decoded), truncated: false, origin: 'opaque' },
    { key: 'brief', observation: null, role: 'generated_context', upstream_derivation_id: null,
      selection: 'accepted-brief:v1', spans: briefSpans, original_bytes: null,
      retained_bytes: Buffer.byteLength(decoded.synthesis_brief), input_digest: inputDigest(briefSpans, decoded),
      truncated: false, origin: 'opaque' }],
    omissions: [], dependency_coverage: 'direct_with_opaque_components',
    transform: { assembly: 'project-subpage-evidence-v1', prompt: 'project-subpage-v1', schema: 'page-synthesis-v1',
      adapter: provider === 'anthropic' ? 'anthropic-v1' : 'openai-compat-v1', output: 'managed-subpage-contribution-v1' } };
}

function pageBundleForAction(action: 'create' | 'refresh' | 'reactivate' | 'merge', target: BundleV1['target'],
  forceCurrentTarget = false): BundleV1 {
  const bundle = pageBundle('openrouter', target);
  const source = JSON.parse(sentUser) as Record<string, Json>;
  const { current_target: currentTarget, ...base } = source;
  const withCurrentTarget = action === 'refresh' || action === 'reactivate' || (action === 'merge' && ('node_id' in (target ?? {}) || forceCurrentTarget));
  const content = { ...base, action,
    ...(withCurrentTarget ? { current_target: currentTarget } : {}),
    ...(action === 'merge' ? { merge_sources: [], source_files_remain_historical: true } : {}) };
  const request = bundle.provider_payload as { messages: Array<{ role: string; content: string }> };
  request.messages[1]!.content = JSON.stringify(content);
  bundle.decoded_fields = deriveSubpageDecodedFields(bundle.provider, bundle.provider_payload);
  return bundle;
}

describe('project subpage request validation', () => {
  it('requires each provider\'s own output-token field', () => {
    const openai = pageBundle('openai');
    const swapped = openai.provider_payload as Record<string, Json>;
    swapped.max_tokens = swapped.max_completion_tokens!;
    delete swapped.max_completion_tokens;
    expect(() => validateBundle(openai, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1')).toThrow('PROVENANCE_LIMIT');
    const fireworks = pageBundle('fireworks');
    const extra = fireworks.provider_payload as Record<string, Json>;
    extra.max_completion_tokens = extra.max_tokens!;
    delete extra.max_tokens;
    expect(() => validateBundle(fireworks, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1')).toThrow('PROVENANCE_LIMIT');
  });
  it('accepts a reasoning budget only as a strict { max_tokens } object (#429)', () => {
    const bundle = pageBundle('openrouter');
    (bundle.provider_payload as Record<string, Json>).reasoning = { max_tokens: 6000 };
    expect(() => validateBundle(bundle, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1')).not.toThrow();
    for (const reasoning of [{ max_tokens: 6000, effort: 'low' }, { max_tokens: 0 }, { max_tokens: -1 }, { max_tokens: '6000' },
      {}, 'low', null] as Json[]) {
      const bad = pageBundle('openrouter');
      (bad.provider_payload as Record<string, Json>).reasoning = reasoning;
      expect(() => validateBundle(bad, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1')).toThrow('PROVENANCE_LIMIT');
    }
    const anthropic = pageBundle('anthropic');
    (anthropic.provider_payload as Record<string, Json>).reasoning = { max_tokens: 6000 };
    expect(() => validateBundle(anthropic, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1')).toThrow('PROVENANCE_LIMIT');
  });
  it.each(['fireworks', 'openrouter', 'openai'] as const)('accepts the versioned %s Markdown adapter with existing subpage guards', provider => {
    const bundle = pageBundle(provider);
    bundle.transform.adapter = 'openai-compat-page-markdown-v1';
    expect(() => validateBundle(bundle, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1')).not.toThrow();
    for (const change of [
      (b: BundleV1) => { b.decoded_fields.evidence = 'forged'; },
      (b: BundleV1) => { b.target = { node_id: 'wrong' }; },
      (b: BundleV1) => { b.items[0]!.input_digest = `sha256:json-v1:${'0'.repeat(64)}`; },
      (b: BundleV1) => { (b.provider_payload as Record<string, Json>).response_format = { type: 'json_schema' }; },
    ]) {
      const changed = structuredClone(bundle); change(changed);
      expect(() => validateBundle(changed, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1')).toThrow('PROVENANCE_LIMIT');
    }
    expect(() => validateBundle(bundle, DEFAULT_PROVENANCE_LIMITS, 'project-home-v1')).toThrow('PROVENANCE_LIMIT');
  });
  it.each(['anthropic', 'fireworks', 'openrouter', 'openai'] as const)('rejects unknown or mismatched %s adapter versions', provider => {
    const bundle = pageBundle(provider);
    for (const adapter of ['unknown', 'openai-compat-page-markdown-v2',
      ...(provider === 'anthropic' ? ['openai-compat-page-markdown-v1', 'openai-compat-v1'] : ['anthropic-v1'])]) {
      bundle.transform.adapter = adapter;
      expect(() => validateBundle(bundle, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1')).toThrow('PROVENANCE_LIMIT');
    }
  });
  it.each(['anthropic', 'fireworks', 'openrouter', 'openai'] as const)('accepts literal %s page payload and Unicode spans', provider => {
    const bundle = pageBundle(provider);
    expect((bundle.provider_payload as Record<string, Json>).response_format).toBeUndefined();
    const result = validateBundle(bundle, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1');
    expect(result.bundle.decoded_fields.user).toBe(sentUser);
    expect(result.bundle.decoded_fields.evidence).toBe('path: C:\\vault\nDecision α');
    expect(result.bundle.items[1]).toMatchObject({ origin: 'opaque', role: 'generated_context', selection: 'accepted-brief:v1' });
  });
  it('requires the refresh target to match the sent current target ID', () => {
    expect(() => validateBundle(pageBundle('openrouter', { node_id: 'page-2' }), DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1'))
      .toThrow('PROVENANCE_LIMIT');
    expect(() => validateBundle(pageBundle('openrouter', { plan_key: 'create-1' }), DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1'))
      .toThrow('PROVENANCE_LIMIT');
  });
  it('accepts only a plan key for create and node IDs for refresh or reactivate', () => {
    const create = pageBundleForAction('create', { plan_key: 'create-1' });
    expect(() => validateBundle(create, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1')).not.toThrow();
    expect(() => validateBundle(pageBundleForAction('create', { node_id: 'page-1' }), DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1'))
      .toThrow('PROVENANCE_LIMIT');
    expect(() => validateBundle(pageBundleForAction('reactivate', { node_id: 'page-1' }), DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1'))
      .not.toThrow();
    expect(() => validateBundle(pageBundleForAction('reactivate', { plan_key: 'create-1' }), DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1'))
      .toThrow('PROVENANCE_LIMIT');
  });
  it('allows merges into an existing node or a new plan key with matching sent context', () => {
    const existing = pageBundleForAction('merge', { node_id: 'page-1' });
    const planned = pageBundleForAction('merge', { plan_key: 'merged-1' });
    expect(() => validateBundle(existing, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1')).not.toThrow();
    expect(() => validateBundle(planned, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1')).not.toThrow();
    expect(() => validateBundle(pageBundleForAction('merge', { node_id: 'page-2' }), DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1'))
      .toThrow('PROVENANCE_LIMIT');
    const contradictory = pageBundleForAction('merge', { plan_key: 'merged-1' }, true);
    expect(() => validateBundle(contradictory, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1'))
      .toThrow('PROVENANCE_LIMIT');
  });
  it('rejects absent, ambiguous, or empty targets', () => {
    for (const target of [undefined, { node_id: 'page-1', plan_key: 'create-1' }, { node_id: '' }]) {
      const bundle = pageBundle('openrouter'); bundle.target = target as BundleV1['target'];
      expect(() => validateBundle(bundle, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1')).toThrow('PROVENANCE_LIMIT');
    }
  });
  it.each(['api_key', 'headers', 'response_format'] as const)('rejects extra %s in prompt-only payload', key => {
    const bundle = pageBundle('fireworks');
    (bundle.provider_payload as Record<string, Json>)[key] = key === 'response_format' ? { type: 'json_schema' } : 'secret';
    expect(() => validateBundle(bundle, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1')).toThrow('PROVENANCE_LIMIT');
  });
  it('rejects forged decoded fields, spans, and mismatched flow or transform', () => {
    const changes = [
      (b: BundleV1) => { b.decoded_fields.synthesis_brief = 'fabricated'; },
      (b: BundleV1) => { b.items[0]!.spans[0]!.end = 1; },
      (b: BundleV1) => { b.transform.prompt = 'wrong'; },
    ];
    for (const change of changes) {
      const bundle = pageBundle('openrouter'); change(bundle);
      expect(() => validateBundle(bundle, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1')).toThrow('PROVENANCE_LIMIT');
    }
    expect(() => validateBundle(pageBundle('openrouter'), DEFAULT_PROVENANCE_LIMITS)).toThrow('PROVENANCE_LIMIT');
  });
  it('rejects page transform claims under omitted or explicit home flow while retaining home variants', () => {
    const pageVersions = pageBundle('openrouter').transform;
    const homeVariants = ['v1', 'project-home-evidence-v1', 'project-home-evidence-budget-v1'];
    for (const assembly of homeVariants) {
      const home = bundleFixture(); home.transform.assembly = assembly;
      expect(() => validateBundle(home, DEFAULT_PROVENANCE_LIMITS)).not.toThrow();
    }
    for (const field of ['assembly', 'prompt', 'schema', 'output'] as const) {
      const home = bundleFixture(); home.transform[field] = pageVersions[field];
      expect(() => validateBundle(home, DEFAULT_PROVENANCE_LIMITS)).toThrow('PROVENANCE_LIMIT');
      expect(() => validateBundle(home, DEFAULT_PROVENANCE_LIMITS, 'project-home-v1')).toThrow('PROVENANCE_LIMIT');
    }
  });
  it('normalizes only Summary/replace and optional Log/append', () => {
    expect(normalizeContribution([{ name: 'Summary', mode: 'replace', content: ' Decision α ' }], 'project-subpage-v1'))
      .toEqual([{ name: 'Summary', mode: 'replace', content: 'Decision α' }]);
    expect(normalizeContribution([{ name: 'Log', mode: 'append', content: ' Note ' }, { name: 'Summary', mode: 'replace', content: 'Decision α' }], 'project-subpage-v1'))
      .toEqual([{ name: 'Log', mode: 'append', content: 'Note' }, { name: 'Summary', mode: 'replace', content: 'Decision α' }]);
    for (const sections of [
      [{ name: 'Summary', mode: 'replace', content: 'A' }, { name: 'Summary', mode: 'replace', content: 'B' }],
      [{ name: 'Summary', mode: 'append', content: 'A' }],
      [{ name: 'Log', mode: 'append', content: 'A' }],
      [{ name: 'Now', mode: 'replace', content: 'A' }],
    ] as const) expect(() => normalizeContribution(sections, 'project-subpage-v1')).toThrow('PROVENANCE_LIMIT');
  });
  it('keeps distinct valid targets distinct even when payload bodies match', () => {
    const first = pageBundleForAction('create', { plan_key: 'create-1' });
    const second = pageBundleForAction('create', { plan_key: 'create-2' });
    expect(validateBundle(first, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1').digest)
      .not.toBe(validateBundle(second, DEFAULT_PROVENANCE_LIMITS, 'project-subpage-v1').digest);
    expect(canonicalJson(first.provider_payload)).toBe(canonicalJson(second.provider_payload));
  });
});
