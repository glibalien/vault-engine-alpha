import { describe, expect, it } from 'vitest';
import { measureBundle, readCaptureLimits } from '../src/provenance-budget.js';
import { EvidenceCollector, capturedBundle, canonical, spanDigest } from '../src/provenance-evidence.js';
import { buildHomeRequest } from '../src/home-request.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import type OpenAI from 'openai';
import type { Json } from '../src/provenance-types.js';

const limits = { componentBytes: 262144, itemCount: 512, requestBytes: 1048576, totalBytes: 2097152 };
async function fixture(text = 'é😀\n"quoted"') {
  const collector = new EvidenceCollector({});
  collector.record([text], 0, null, 'generated_context', 'test');
  collector.finish([text], text);
  const adapter = new OpenAiCompatLlmClient({} as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
  const capture = await adapter.previewStructuredCall(buildHomeRequest({ model: 'model', system: 'sys', evidence: text,
    pageIndex: [], generatedAt: new Date('2026-09-18T12:00:00Z'), maxTokens: 50 }));
  return capturedBundle(capture, collector);
}

describe('canonical capture sizing', () => {
  it('allows exact request and bundle boundaries and rejects one byte below', async () => {
    const bundle = await fixture();
    const requestBytes = Buffer.byteLength(canonical(bundle.provider_payload));
    const totalBytes = Buffer.byteLength(canonical(bundle as unknown as Json));
    expect(measureBundle(bundle, { ...limits, requestBytes, totalBytes })).toBeNull();
    expect(measureBundle(bundle, { ...limits, requestBytes: requestBytes - 1 }))
      .toEqual({ dimension: 'request', measured: requestBytes, allowed: requestBytes - 1 });
    expect(measureBundle(bundle, { ...limits, totalBytes: totalBytes - 1 }))
      .toEqual({ dimension: 'bundle', measured: totalBytes, allowed: totalBytes - 1 });
  });
  it('measures UTF-8 component bytes independently of character count', async () => {
    const bundle = await fixture('😀'.repeat(65537));
    expect(measureBundle(bundle, limits)).toEqual({ dimension: 'component', measured: 262148, allowed: 262144 });
  });
  it('counts each item and the complete omission manifest', async () => {
    const bundle = await fixture();
    const count = bundle.items.length;
    expect(measureBundle(bundle, { ...limits, itemCount: count })).toBeNull();
    expect(measureBundle(bundle, { ...limits, itemCount: count - 1 }))
      .toEqual({ dimension: 'items', measured: count, allowed: count - 1 });
    bundle.omissions = Array.from({ length: 513 }, () => ({ code: 'unavailable', source: null }));
    expect(measureBundle(bundle, limits)).toEqual({ dimension: 'omissions', measured: 513, allowed: 512 });
  });
  it('does not turn corrupt span attribution into a size omission', async () => {
    const bundle = await fixture('é');
    bundle.items[0]!.spans[0]!.start = 1;
    expect(() => measureBundle(bundle, limits)).toThrow('PROVENANCE_ATTRIBUTION_INVALID');
  });
  it('rejects digest mismatches before size-based omission', async () => {
    const bundle = await fixture();
    bundle.items[0]!.input_digest = 'bad';
    expect(() => measureBundle(bundle, limits)).toThrow('PROVENANCE_ATTRIBUTION_INVALID');
  });
  it('measures overlapping spans separately for each attributed component', async () => {
    const bundle = await fixture('abc');
    const item = bundle.items[0]!;
    item.spans.push({ ...item.spans[0]! }); item.retained_bytes = 6;
    item.input_digest = spanDigest(item.spans, bundle.decoded_fields);
    // Remove generated items so the deliberate six-byte component controls this boundary.
    bundle.items = [item];
    expect(measureBundle(bundle, { ...limits, componentBytes: 5 }))
      .toEqual({ dimension: 'component', measured: 6, allowed: 5 });
  });
  it.each([{}, { ...limits, totalBytes: NaN }, { ...limits, itemCount: 0 },
    { ...limits, requestBytes: 1 }, { ...limits, componentBytes: 262145 }])('fails closed on unusable effective limits %j', raw => {
    expect(() => readCaptureLimits(raw)).toThrow('PROVENANCE_LIMITS_INVALID');
  });
});
