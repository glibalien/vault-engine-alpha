import { describe, it, expect } from 'vitest';
import type { ModelCatalogEntry } from '@vault/settings-registry';
import { makeRelayModel } from '../../src/llm/relay-model.js';

const FIREWORKS_ENTRY: ModelCatalogEntry = {
  title: 'Qwen 3.7 Plus', provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p7-plus', enabled: true,
};
const ANTHROPIC_ENTRY: ModelCatalogEntry = {
  title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true,
};

/** An empty-but-valid SSE response — doStream() only needs status 200 + a
 *  non-null body to resolve; it never drains the stream in this test. */
function emptyStreamResponse(): Response {
  const body = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const PROMPT = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];

/** `LanguageModel` (from `ai`) is `LanguageModelV2 | <known model-id string literal>` —
 *  narrow to the callable shape so `doStream` typechecks without pulling in
 *  `@ai-sdk/provider` just for this test. */
interface StreamingModel { doStream(options: unknown): Promise<unknown>; }
const streaming = (m: unknown): StreamingModel => m as StreamingModel;

describe('makeRelayModel', () => {
  it('routes a Fireworks catalog entry through the relay to api.fireworks.ai with a Bearer key', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init };
      return emptyStreamResponse();
    }) as typeof fetch;

    const model = makeRelayModel(
      FIREWORKS_ENTRY,
      { fireworks: 'FW-KEY' },
      { engineUrl: 'https://e.test/mcp', token: 'ENG-TOKEN' },
      fetchImpl,
    );
    await streaming(model).doStream({ prompt: PROMPT });

    expect(seen?.url).toBe('https://e.test/llm/stream');
    expect((seen?.init?.headers as Record<string, string>).Authorization).toBe('Bearer ENG-TOKEN');
    const envelope = JSON.parse(seen!.init!.body as string) as { url: string; headers: Record<string, string> };
    expect(envelope.url).toContain('api.fireworks.ai');
    // The provider SDK's Headers instance normalizes names to lowercase before
    // streaming-relay-fetch's toHeaderRecord captures them (unlike the outer
    // envelope's own Authorization header, which streaming-relay-fetch sets
    // explicitly as a plain object and keeps capitalized).
    expect(envelope.headers.authorization).toBe('Bearer FW-KEY');
  });

  it('routes an Anthropic catalog entry through the relay to api.anthropic.com with an x-api-key header', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init };
      return emptyStreamResponse();
    }) as typeof fetch;

    const model = makeRelayModel(
      ANTHROPIC_ENTRY,
      { anthropic: 'ANTH-KEY' },
      { engineUrl: 'https://e.test/mcp', token: 'ENG-TOKEN' },
      fetchImpl,
    );
    await streaming(model).doStream({ prompt: PROMPT });

    expect(seen?.url).toBe('https://e.test/llm/stream');
    const envelope = JSON.parse(seen!.init!.body as string) as { url: string; headers: Record<string, string> };
    expect(envelope.url).toContain('api.anthropic.com');
    expect(envelope.headers['x-api-key']).toBe('ANTH-KEY');
  });

  it('throws loudly (no silent fallback) when the entry needs a key not configured on this surface', () => {
    expect(() =>
      makeRelayModel(ANTHROPIC_ENTRY, { fireworks: 'FW-KEY' }, { engineUrl: 'https://e.test/mcp', token: 'ENG-TOKEN' }),
    ).toThrow(/anthropic/);
  });
});
