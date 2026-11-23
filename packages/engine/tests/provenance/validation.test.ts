import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/provenance/canonical.js';
import { deriveDecodedFields, validateBundle } from '../../src/provenance/validation.js';
import { DEFAULT_PROVENANCE_LIMITS } from '../../src/provenance/limits.js';
import { bundleFixture } from './fixture.js';

describe('capture bounds and attribution', () => {
  it('counts UTF-8 and preserves the whole accepted request', () => {
    const b = bundleFixture('é');
    const result = validateBundle(b, DEFAULT_PROVENANCE_LIMITS);
    expect(result.bundle).toEqual(b);
    expect(result.payloadBytes).toBe(Buffer.byteLength(result.canonical));
    expect(result.reservedBytes).toBe(2 * 1024 * 1024);
    for (const componentBytes of [2, 3]) {
      expect(() => validateBundle(b, { ...DEFAULT_PROVENANCE_LIMITS, componentBytes })).not.toThrow();
    }
    expect(() => validateBundle(b, { ...DEFAULT_PROVENANCE_LIMITS, componentBytes: 1 })).toThrow('PROVENANCE_LIMIT');
  });
  it('enforces the request-byte and 512-item boundaries exactly', () => {
    const b = bundleFixture('x'.repeat(1024));
    const requestBytes = Buffer.byteLength(canonicalJson(b.provider_payload));
    expect(() => validateBundle(b, { ...DEFAULT_PROVENANCE_LIMITS, requestBytes, componentBytes: 1024 })).not.toThrow();
    expect(() => validateBundle(b, { ...DEFAULT_PROVENANCE_LIMITS, requestBytes: requestBytes - 1, componentBytes: 1024 })).toThrow('PROVENANCE_LIMIT');
    b.items = Array.from({ length: 512 }, (_, i) => ({ ...b.items[0]!, key: String(i) }));
    expect(() => validateBundle(b, DEFAULT_PROVENANCE_LIMITS)).not.toThrow();
    b.items.push({ ...b.items[0]!, key: 'overflow' });
    expect(() => validateBundle(b, DEFAULT_PROVENANCE_LIMITS)).toThrow('PROVENANCE_LIMIT');
  });
  it('rejects forged fields, digests, duplicate keys and invalid UTF-8 spans', () => {
    const changes = [
      (b: ReturnType<typeof bundleFixture>) => { b.decoded_fields.evidence = 'unrelated'; },
      (b: ReturnType<typeof bundleFixture>) => { b.items[0]!.input_digest = 'sha256:text-v1:wrong'; },
      (b: ReturnType<typeof bundleFixture>) => { b.items.push(b.items[0]!); },
      (b: ReturnType<typeof bundleFixture>) => { b.items[0]!.spans[0]!.end = 1; },
      (b: ReturnType<typeof bundleFixture>) => { b.dependency_coverage = 'complete_direct'; },
      (b: ReturnType<typeof bundleFixture>) => { (b.provider_payload as Record<string, unknown>).api_key = 'secret'; },
    ];
    for (const change of changes) {
      const b = bundleFixture(); change(b);
      expect(() => validateBundle(b, DEFAULT_PROVENANCE_LIMITS)).toThrow();
    }
  });
  it('accepts an OpenAI home request capped with max_completion_tokens, and only that field', () => {
    const b = bundleFixture();
    const payload = b.provider_payload as Record<string, unknown>;
    payload.max_completion_tokens = payload.max_tokens;
    delete payload.max_tokens;
    b.provider = 'openai';
    b.decoded_fields = deriveDecodedFields('openai', b.provider_payload);
    expect(() => validateBundle(b, DEFAULT_PROVENANCE_LIMITS)).not.toThrow();
    const asOpenRouter = { ...structuredClone(b), provider: 'openrouter' as const };
    expect(() => validateBundle(asOpenRouter, DEFAULT_PROVENANCE_LIMITS)).toThrow('PROVENANCE_LIMIT');
  });

  it('accepts a reasoning budget only as a strict { max_tokens } object (#429)', () => {
    const b = bundleFixture();
    (b.provider_payload as Record<string, unknown>).reasoning = { max_tokens: 6000 };
    expect(() => validateBundle(b, DEFAULT_PROVENANCE_LIMITS)).not.toThrow();
    for (const reasoning of [{ max_tokens: 6000, effort: 'low' }, { effort: 'low' }, { max_tokens: 0 }, { max_tokens: 1.5 },
      { max_tokens: '6000' }, {}, 'low', null, [6000]]) {
      const bad = bundleFixture();
      (bad.provider_payload as Record<string, unknown>).reasoning = reasoning;
      expect(() => validateBundle(bad, DEFAULT_PROVENANCE_LIMITS)).toThrow('PROVENANCE_LIMIT');
    }
  });

  it('rejects unknown keys and roles without echoing request content', () => {
    const b = bundleFixture('private sentinel');
    (b.items[0] as unknown as Record<string, unknown>).role = 'verified_claim';
    expect(() => validateBundle(b, DEFAULT_PROVENANCE_LIMITS)).toThrow('PROVENANCE_LIMIT');
    try { validateBundle(b, DEFAULT_PROVENANCE_LIMITS); } catch (error) {
      expect(String(error)).not.toContain('private sentinel');
    }
    expect(() => validateBundle({ ...bundleFixture(), extra: true } as never, DEFAULT_PROVENANCE_LIMITS)).toThrow();
  });
});
