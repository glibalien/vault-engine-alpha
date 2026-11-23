import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { AnthropicLlmClient } from '../src/llm/anthropic.js';
import type { PreparedCapture, StructuredCallRequest } from '../src/llm/types.js';

const request: StructuredCallRequest = { model: 'synthetic', maxTokens: 100, system: 'System\nCurrent date: 2026-09-17',
  user: JSON.stringify({ evidence: 'évidence', page_index: [] }), toolName: 'home', toolDescription: 'Generate home',
  schema: { type: 'object' }, malformedOutputPolicy: 'fail-closed-redacted' };

describe('provider-bound capture', () => {
  it.each(['anthropic', 'fireworks', 'openrouter'] as const)('captures the exact frozen %s request before a single SDK dispatch', async provider => {
    let captured: PreparedCapture | undefined;
    const create = vi.fn(async (payload: unknown, _options?: unknown) => {
      expect(captured).toBeDefined();
      expect(payload).toBe(captured?.payload);
      return provider === 'anthropic'
        ? { content: [{ type: 'tool_use', name: 'home', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } }
        : { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    });
    const llm = provider === 'anthropic' ? new AnthropicLlmClient({ messages: { create } } as unknown as Anthropic)
      : new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI, { provider, fireworksExtensions: provider === 'fireworks' });
    expect(llm.supportsPreparedCapture).toBe(true);
    await llm.structuredCall({ ...request, onPrepared: async value => {
      captured = value;
      expect(Object.isFrozen(value.payload)).toBe(true);
      expect(() => { (value.payload as Record<string, unknown>).model = 'changed'; }).toThrow();
    } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
    expect(captured?.provider).toBe(provider);
    expect(JSON.stringify(captured)).not.toContain('apiKey');
    if (provider !== 'anthropic') expect(JSON.stringify(captured?.payload)).toContain('json_schema');
  });
  it('blocks dispatch and redacts a failed capture callback', async () => {
    const create = vi.fn();
    const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI);
    await expect(llm.structuredCall({ ...request, onPrepared: async () => { throw new Error('PRIVATE SOURCE'); } })).rejects.toThrow('provenance_capture_failed');
    expect(create).not.toHaveBeenCalled();
  });
});

it('preserves prepared preview, hooks and single-call usage through requested-page accounting', async () => {
  const { runRequestedPagePipeline } = await import('../src/requested-page-pipeline.js');
  const planning = await import('../src/reconciliation-planning.js');
  const { UsageReporter } = await import('../src/usage-reporter.js');
  let captured: PreparedCapture | undefined;
  const create = vi.fn(async (payload: unknown) => {
    expect(payload).toBe(captured?.payload);
    return { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 13, completion_tokens: 2 } };
  });
  const recordUsage = vi.fn(async () => {});
  const reporter = new UsageReporter({ recordUsage } as unknown as import('../src/engine.js').Engine, { provider: 'openrouter', experiment: null, variant: null });
  const wrapped = reporter.wrap(new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI));
  const spy = vi.spyOn(planning, 'planReconciliation').mockImplementation(async input => {
    expect(input.llm.supportsPreparedCapture).toBe(true);
    const req = { ...request, openAiResponseFormat: 'prompt-only' as const, onPrepared: async (value: PreparedCapture) => { captured = value; } };
    const preview = await input.llm.previewStructuredCall!(req);
    expect(create).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    await input.llm.structuredCall(req);
    expect(captured).toEqual(preview);
    throw new Error('stop after accounting boundary');
  });
  try {
    await expect(runRequestedPagePipeline({ llm: wrapped, config: { wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0, wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit', model: 'synthetic', homeMaxTokens: 4000 } } as import('../src/requested-page-pipeline.js').RequestedPipelineInput))
      .rejects.toMatchObject({ usage: { input: 13, output: 2, cacheWrite: 0, cacheRead: 0 } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});
