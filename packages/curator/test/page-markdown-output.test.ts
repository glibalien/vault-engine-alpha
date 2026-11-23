import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicLlmClient } from '../src/llm/anthropic.js';
import { UsageReporter } from '../src/usage-reporter.js';
import type { Engine } from '../src/engine.js';
import { OpenAiCompatLlmClient, openAiCompatProviderPayloadChars } from '../src/llm/openai-compat.js';
import type { StructuredCallRequest } from '../src/llm/types.js';
import { PAGE_SYNTHESIS_SCHEMA, PAGE_SYNTHESIS_TOOL } from '../src/prompts/page.js';
import { assertPageMarkdown } from '../src/page-markdown.js';

const body = '# Current state\n\nShe said "ready"; C:\\notes and literal \\n stay intact. Café 📚.\n\n'
  + '> [!note]\n> A supported observation.\n\n| Item | State |\n| --- | --- |\n| One | Open |\n\n'
  + '```json\n{"quoted":"value"}\n```\n\n' + 'Grounded long-form narrative. '.repeat(1000);
const frame = (text = body, note = 'Updated "current state".') =>
  `<<<VAULT_PAGE_V1>>>\nlog_note: ${note}\n<<<VAULT_BODY>>>\n${text}\n<<<END_VAULT_PAGE>>>`;
const req: StructuredCallRequest = {
  model: 'test', maxTokens: 32000, system: 'Write a grounded page.', user: 'Evidence',
  toolName: PAGE_SYNTHESIS_TOOL.name, toolDescription: PAGE_SYNTHESIS_TOOL.description, schema: PAGE_SYNTHESIS_TOOL.schema,
  openAiResponseFormat: 'page-markdown', malformedOutputPolicy: 'fail-closed-redacted',
  wikiContext: { stage: 'page', attempt: 0, policyVersion: 1, maxTokens: 32000,
    configuration: { provider: 'openrouter', reasoningEffort: 'medium' } },
};
function fixture(content: unknown, finish = 'stop', usage: unknown = { prompt_tokens: 100, completion_tokens: 50 }, refusal: string | null = null) {
  const create = vi.fn().mockResolvedValue({ id: 'generation', model: 'resolved',
    choices: [{ message: { content, refusal }, finish_reason: finish }], usage });
  const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI,
    { provider: 'openrouter', fireworksExtensions: false });
  return { llm, create };
}

describe('page Markdown output transport', () => {
  it.each(['\n', '\r\n'])('preserves long raw Markdown through capture, dispatch and page validation (%j)', async newline => {
    const content = frame().replaceAll('\n', newline);
    const expectedBody = body.replaceAll('\n', newline);
    const { llm, create } = fixture(content);
    const preview = await llm.previewStructuredCall(req);
    let captured: unknown;
    const result = await llm.structuredCall({ ...req, onPrepared: async capture => { captured = capture; } });
    expect(result.output).toEqual({ body: expectedBody, log_note: 'Updated "current state".' });
    const page = PAGE_SYNTHESIS_SCHEMA.parse(result.output);
    expect(() => assertPageMarkdown(page.body, page.log_note)).not.toThrow();
    expect(captured).toEqual(preview);
    expect(preview.adapter_version).toBe('openai-compat-page-markdown-v1');
    expect(create.mock.calls[0]?.[0]).toEqual(preview.payload);
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('response_format');
    expect(JSON.stringify(preview.payload).length).toBe(openAiCompatProviderPayloadChars(req, { provider: 'openrouter', fireworksExtensions: false }));
    expect(create.mock.calls[0]?.[0].messages[0].content).toContain('<<<VAULT_PAGE_V1>>>');
    expect(create.mock.calls[0]?.[0].messages[0].content).not.toContain('Respond with a single JSON object');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
    expect(result.usage).toEqual({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0 });
    expect(result.diagnostics?.responses[0]?.responseTextBytes).toBe(Buffer.byteLength(content));
  });

  it('omits an empty optional log note', async () => {
    const { llm } = fixture(frame('A supported observation.', ''));
    expect((await llm.structuredCall(req)).output).toEqual({ body: 'A supported observation.' });
  });

  it.each([
    ['JSON instead', '{"body":"A page."}'],
    ['missing end', frame('A page.').replace('\n<<<END_VAULT_PAGE>>>', '')],
    ['extra prose', 'Here is your page.\n' + frame('A page.')],
    ['trailing prose', frame('A page.') + '\nAnd more.'],
    ['missing header', frame('A page.').replace('log_note: Updated "current state".\n', '')],
    ['extra header', frame('A page.').replace('<<<VAULT_BODY>>>', 'other: value\n<<<VAULT_BODY>>>')],
    ['empty body', frame('   ')],
    ['oversized log', frame('A page.', 'x'.repeat(501))],
    ['nested frame', frame(frame('A page.'))],
    ['reserved line in body', frame('A page.\n  <<<VAULT_BODY>>>\nAnother page.')],
    ['multiple frames', frame('A page.') + '\n' + frame('Another page.')],
  ])('rejects %s once without exposing content', async (_label, content) => {
    const { llm, create } = fixture(content);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const error = await llm.structuredCall(req).catch(error => error);
      expect(error).toMatchObject({ reason: 'invalid_page_envelope', usage: { input: 100, output: 50 } });
      expect(String(error)).not.toContain(content);
      expect(JSON.stringify(error)).not.toContain('Updated "current state"');
      expect(warning).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
    } finally { warning.mockRestore(); }
  });

  it.each([
    ['length', 'truncated'], ['content_filter', 'content_filtered'], ['tool_calls', 'invalid_page_envelope'],
  ])('rejects %s even with a complete envelope', async (finish, reason) => {
    const { llm, create } = fixture(frame(), finish);
    await expect(llm.structuredCall(req)).rejects.toMatchObject({ reason });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rejects explicit provider refusal even with a complete envelope', async () => {
    const { llm } = fixture(frame(), 'stop', undefined, 'PRIVATE_REFUSAL');
    await expect(llm.structuredCall(req)).rejects.toMatchObject({ reason: 'refused' });
  });

  it('keeps missing usage unknown on rejection', async () => {
    const { llm } = fixture('PRIVATE_BAD_CONTENT', 'stop', null);
    await expect(llm.structuredCall(req)).rejects.toMatchObject({ reason: 'invalid_page_envelope', usage: undefined });
  });

  it('keeps missing usage unknown on success', async () => {
    const { llm } = fixture(frame(), 'stop', null);
    expect(await llm.structuredCall(req)).toMatchObject({ usageKnown: false });
  });

  it('does not invent known zero usage when page diagnostics are absent', async () => {
    const { llm } = fixture('PRIVATE_BAD_CONTENT', 'stop', null);
    await expect(llm.structuredCall({ ...req, wikiContext: undefined }))
      .rejects.toMatchObject({ reason: 'invalid_page_envelope', usage: undefined });
  });

  it('forces one redacted attempt even without an explicit policy', async () => {
    const { llm, create } = fixture('PRIVATE OUTPUT');
    await expect(llm.structuredCall({ ...req, malformedOutputPolicy: undefined, onPrepared: undefined }))
      .rejects.toMatchObject({ reason: 'invalid_page_envelope' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
  });

  it('redacts transport failures and blocks dispatch when capture fails', async () => {
    const { llm, create } = fixture(frame());
    await expect(llm.structuredCall({ ...req, onPrepared: async () => { throw new Error('PRIVATE CAPTURE'); } }))
      .rejects.toMatchObject({ reason: 'provenance_capture_failed', usage: undefined });
    expect(create).not.toHaveBeenCalled();
    create.mockRejectedValue(new Error('PRIVATE TRANSPORT'));
    const error = await llm.structuredCall(req).catch(error => error);
    expect(error).toMatchObject({ reason: 'provider_transport_failed', usage: undefined });
    expect(String(error)).not.toContain('PRIVATE');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('records known usage once through the existing reporter (valid: %s)', async valid => {
    const { llm } = fixture(valid ? frame() : 'PRIVATE OUTPUT');
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const reporter = new UsageReporter({ recordUsage } as unknown as Engine,
      { provider: 'openrouter', experiment: null, variant: null });
    await reporter.wrap(llm).structuredCall(req).catch(() => {});
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
    expect(recordUsage.mock.calls[0]?.[0]).toMatchObject({ input_tokens: 100, output_tokens: 50 });
    expect(JSON.stringify(recordUsage.mock.calls)).not.toContain('PRIVATE OUTPUT');
  });

  it('retains native Anthropic tool output and its prepared capture', async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: 'tool_use', name: req.toolName, input: { body } }],
      usage: { input_tokens: 100, output_tokens: 50 } });
    const llm = new AnthropicLlmClient({ messages: { create } } as unknown as Anthropic);
    const preview = await llm.previewStructuredCall(req);
    expect(preview.adapter_version).toBe('anthropic-v1');
    const result = await llm.structuredCall(req);
    expect(result.output).toEqual({ body });
    const params = create.mock.calls[0]?.[0];
    expect(params).toEqual(preview.payload);
    expect(params.tools[0].input_schema).toEqual(req.schema);
    expect(params.system).not.toContain('<<<VAULT_PAGE_V1>>>');
    expect(create.mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
  });

  it('enforces the exact provider request byte limit before dispatch', async () => {
    const { llm, create } = fixture(frame());
    const prepared = await llm.previewStructuredCall(req);
    const bytes = Buffer.byteLength(JSON.stringify(prepared.payload));
    await expect(llm.structuredCall({ ...req, providerRequestMaxBytes: bytes - 1 })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    await llm.structuredCall({ ...req, providerRequestMaxBytes: bytes });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
