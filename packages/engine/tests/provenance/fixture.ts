import type { BundleV1 } from '../../src/provenance/types.js';
import { deriveDecodedFields, inputDigest } from '../../src/provenance/validation.js';

export function bundleFixture(evidence = 'évidence'): BundleV1 {
  const provider_payload = {
    model: 'test', max_tokens: 100,
    messages: [{ role: 'system', content: 'Synthetic system' },
      { role: 'user', content: JSON.stringify({ evidence, accepted_page_index: [] }) }],
    response_format: { type: 'json_schema', json_schema: { name: 'home', schema: { type: 'object' } } },
  };
  const decoded_fields = deriveDecodedFields('openrouter', provider_payload);
  const spans = [{ field: 'evidence', start: 0, end: Buffer.byteLength(evidence) }];
  return {
    version: 1, provider: 'openrouter', model: 'test', provider_payload, decoded_fields,
    items: [{ key: 'aggregate', observation: null, role: 'engine_projection',
      upstream_derivation_id: null, selection: 'aggregate:v1', spans,
      original_bytes: null, retained_bytes: Buffer.byteLength(evidence),
      input_digest: inputDigest(spans, decoded_fields), truncated: false, origin: 'opaque' }],
    omissions: [], dependency_coverage: 'direct_with_opaque_components',
    transform: { assembly: 'v1', prompt: 'v1', schema: 'v1', adapter: 'v1', output: 'v1' },
  };
}
