import { expect, it } from 'vitest';
import { makeClient } from '../src/client.js';
it('preserves revoked-read reasons for clearing inspector text', async () => {
  const response = {
    ok: false,
    error: {
      code: 'VALIDATION_FAILED',
      message: 'PROVENANCE_REVOKED',
      details: { reason: 'PROVENANCE_REVOKED' },
    },
    warnings: [],
  };
  const request = {
    select: 'input_text' as const,
    output_revision_id: 'output',
    input_id: 'input',
    cursor: 'cursor',
    max_bytes: 16384,
  };
  const client = makeClient(async (call) => {
    expect(call).toEqual({ name: 'inspect-provenance', arguments: request });
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  });
  expect(await client.inspectProvenance(request)).toEqual(response);
});

it('forwards a bounded direct-impact read without changing its envelope', async () => {
  const response = {
    ok: true as const,
    data: {
      as_of: '2026-09-20T00:00:00Z',
      outputs: [],
      comparisons: 1000,
      next_cursor: 'continue',
      truncated: true,
      coverage: 'captured_direct_dependencies_only' as const,
    },
    warnings: [],
  };
  const request = {
    sources: [
      { kind: 'node' as const, namespace: 'vault', native_id: 'source' },
    ],
    currentness: 'current' as const,
    limit: 20,
    cursor: 'page-one',
  };
  const client = makeClient(async (call) => {
    expect(call).toEqual({ name: 'find-affected-outputs', arguments: request });
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  });
  expect(await client.findAffectedOutputs(request)).toEqual(response);
});
