import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { connectSandboxEngine, parseEngineToolResult } from './engine-client.js';

// Unit tests here must not spawn a real engine (that's Task 10's e2e job).
// This one regression test is the exception that proves the rule: it proves
// connectSandboxEngine refuses BEFORE attempting to spawn when the engine
// hasn't been built, by pointing at a path that provably doesn't exist and
// asserting on the fast, synchronous-ish rejection — not by spawning
// anything. This is the exact gap the Task 6 review flagged: nothing in the
// type system forces `assertEngineDistBuilt` to be called, so a regression
// here would otherwise surface only as an opaque spawn failure.
describe('connectSandboxEngine', () => {
  it('calls assertEngineDistBuilt before spawning — refuses with a clear error when the engine dist is missing', async () => {
    const missingDistPath = join('/nonexistent-vault-bench-dist-check', 'index.js');
    expect(existsSync(missingDistPath)).toBe(false);

    await expect(
      connectSandboxEngine(
        { command: process.execPath, args: [missingDistPath], env: {} },
        1000,
      ),
    ).rejects.toThrow('engine dist missing — run: npm run build -w vault-engine');
  });
});

// `parseEngineToolResult` is the most safety-sensitive parsing path in the
// module (it's what decides whether a raw MCP result reads as a real
// envelope) — it deliberately never trusts transport-level status, only
// parses the first text content item. These edge cases previously had zero
// coverage: execute.test.ts drives makeBenchExecutor against a stub
// BenchEngineClient that bypasses this parsing entirely.
describe('parseEngineToolResult', () => {
  it('parses a well-formed envelope from the first text content item', () => {
    const result = { content: [{ type: 'text', text: '{"ok":true,"data":{"id":"1"},"warnings":[]}' }] };
    expect(parseEngineToolResult('get-node', result)).toEqual({ ok: true, data: { id: '1' }, warnings: [] });
  });

  it('synthesizes an ok:false INTERNAL_ERROR envelope, never throws, on an empty content array', () => {
    expect(() => parseEngineToolResult('get-node', { content: [] })).not.toThrow();
    const envelope = parseEngineToolResult('get-node', { content: [] });
    expect(envelope).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'tool get-node returned no text content' },
      warnings: [],
    });
  });

  it('synthesizes an ok:false INTERNAL_ERROR envelope, never throws, when content is entirely non-text (e.g. an image item)', () => {
    const result = { content: [{ type: 'image', text: undefined }] };
    expect(() => parseEngineToolResult('embed-attachment', result)).not.toThrow();
    const envelope = parseEngineToolResult('embed-attachment', result);
    expect(envelope).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'tool embed-attachment returned no text content' },
      warnings: [],
    });
  });

  it('finds the first TEXT item even when it is not the first content item overall', () => {
    const result = { content: [{ type: 'image', text: undefined }, { type: 'text', text: '{"ok":true,"data":{},"warnings":[]}' }] };
    expect(parseEngineToolResult('get-node', result)).toEqual({ ok: true, data: {}, warnings: [] });
  });

  it('synthesizes an ok:false INTERNAL_ERROR envelope, never throws, on malformed JSON text', () => {
    const result = { content: [{ type: 'text', text: 'not json at all' }] };
    expect(() => parseEngineToolResult('query-nodes', result)).not.toThrow();
    const envelope = parseEngineToolResult('query-nodes', result) as { ok: false; error: { code: string; message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INTERNAL_ERROR');
    expect(envelope.error.message).toMatch(/^tool query-nodes returned non-JSON text: not json at all/);
  });

  it('every synthesized failure is ok:false and never resembles a success envelope', () => {
    const cases: Array<{ content?: Array<{ type: string; text?: string }> }> = [
      { content: [] },
      { content: undefined },
      { content: [{ type: 'text', text: '{broken' }] },
    ];
    for (const result of cases) {
      const envelope = parseEngineToolResult('some-tool', result);
      expect(envelope.ok).toBe(false);
    }
  });
});
