import { expect, it, vi } from 'vitest';
import type { StructuredCallRequest } from '../src/llm/types.js';
import { buildHomeRequest } from '../src/home-request.js';
import { synthesizeHomeOverview } from '../src/page-synthesis.js';

it('uses the same dated home request for preview and later synthesis', async () => {
  vi.useFakeTimers();
  try {
    const onPrepared = vi.fn();
    const input = { model: 'model', system: 'custom', evidence: 'ORIGINAL', pageIndex: [], maxTokens: 123,
      generatedAt: new Date('2026-09-18T12:00:00Z'), onPrepared };
    const preview = buildHomeRequest(input);
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
    const structuredCall = vi.fn(async (_req: StructuredCallRequest) => ({ output: { now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Log' },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }));
    await synthesizeHomeOverview({ structuredCall }, input);
    expect(structuredCall.mock.calls[0]?.[0]).toEqual(preview);
    expect(preview.system).toContain('2026-09-18');
    expect(preview.maxTokens).toBe(123);
    expect(preview.malformedOutputPolicy).toBe('fail-closed-redacted');
    expect(JSON.parse(preview.user)).toEqual({ evidence: 'ORIGINAL', accepted_page_index: [] });
    expect(onPrepared).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('keeps untracked home calls on their existing output policy', () => {
  const req = buildHomeRequest({ model: 'model', evidence: 'input', pageIndex: [] });
  expect(req.malformedOutputPolicy).toBeUndefined();
  expect(req.maxTokens).toBe(4000);
  expect(req.toolName).toBe('emit_wiki_sections');
});
