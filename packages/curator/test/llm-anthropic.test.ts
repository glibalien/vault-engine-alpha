import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { inspect } from 'node:util';
import {
  FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS,
  fieldGuessCandidateMandatoryProjectionChars,
  serializeFieldGuessCandidateMandatory,
} from '@vault/contract';
import {
  FIELD_GUESS_PROMPT_MAX_CHARS,
  FIELD_GUESS_SYSTEM_PROMPT,
  buildFieldGuessPrompt,
  buildFieldGuessTool,
} from '../src/field-guess/prompt.js';
import type { FieldGuessFieldCandidate } from '../src/field-guess/types.js';
import {
  AnthropicLlmClient,
  acceptsForcedToolChoice,
  anthropicProviderPayloadChars,
} from '../src/llm/anthropic.js';
import { StructuredCallFailure, type StructuredCallRequest } from '../src/llm/types.js';
import { ProviderLimits, ProviderSpendLimitError } from '../src/provider-limits.js';
import type { EngineNode } from '../src/types.js';
import {
  fieldGuessIdentityBoundaryFields,
  fieldGuessMandatoryBoundaryFields,
} from './field-guess-mandatory-boundary.js';

const req: StructuredCallRequest = {
  model: 'claude-sonnet-4-6',
  maxTokens: 4000,
  system: 'SYS',
  user: 'EVIDENCE',
  toolName: 'emit_wiki_sections',
  toolDescription: 'desc',
  schema: { type: 'object', properties: { now: { type: 'string' } }, required: ['now'] },
};

function fakeAnthropic(response: unknown) {
  const create = vi.fn(async () => response);
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

describe('AnthropicLlmClient', () => {
  it('forces the named tool with a cached system prompt and returns parsed output + usage', async () => {
    const { client, create } = fakeAnthropic({
      content: [{ type: 'tool_use', name: 'emit_wiki_sections', input: { now: 'n' } }],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
    });
    const res = await new AnthropicLlmClient(client).structuredCall(req);
    expect(res.output).toEqual({ now: 'n' });
    expect(res.usage).toEqual({ input: 10, output: 5, cacheWrite: 2, cacheRead: 3 });
    const callArgs = (create as Mock).mock.calls[0];
    expect(callArgs).toBeDefined();
    const call = callArgs?.[0] as Record<string, unknown>;
    expect(call.model).toBe('claude-sonnet-4-6');
    expect(call.max_tokens).toBe(4000);
    expect(call.system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    expect(call.tools).toEqual([{ name: 'emit_wiki_sections', description: 'desc', input_schema: req.schema }]);
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'emit_wiki_sections' });
    expect(call.messages).toEqual([{ role: 'user', content: 'EVIDENCE' }]);
    expect(callArgs?.[1]).toBeUndefined();
  });

  it('asks a model that refuses a forced tool call to make it, with tool_choice auto (#371)', async () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-mythos-5-1', 'claude-opus-6']) {
      const { client, create } = fakeAnthropic({
        content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', name: 'emit_wiki_sections', input: { now: 'n' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const res = await new AnthropicLlmClient(client).structuredCall({ ...req, model, malformedOutputPolicy: 'fail-closed-redacted' });
      expect(res.output, model).toEqual({ now: 'n' });
      const call = (create as Mock).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call.tool_choice, model).toEqual({ type: 'auto', disable_parallel_tool_use: true });
      expect(call.system, model).toEqual([
        { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Answer only by calling the emit_wiki_sections tool, once.' },
      ]);
    }
  });

  it('keeps the forced tool call on models that accept it', () => {
    for (const model of ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-opus-4-1-20250805',
      'claude-3-5-haiku-20241022', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-5-5']) {
      expect(acceptsForcedToolChoice(model), model).toBe(true);
    }
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-fable-5-2',
      'claude-mythos-5-2', 'claude-opus-6']) {
      expect(acceptsForcedToolChoice(model), model).toBe(false);
    }
  });

  it('throws when no matching tool_use block comes back', async () => {
    const { client } = fakeAnthropic({
      content: [{ type: 'text', text: 'nope' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await expect(new AnthropicLlmClient(client).structuredCall(req)).rejects.toThrow(/emit_wiki_sections/);
  });

  it('throws when only a differently-named tool_use block comes back', async () => {
    const { client } = fakeAnthropic({
      content: [{ type: 'tool_use', name: 'wrong_tool', input: { now: 'n' } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await expect(new AnthropicLlmClient(client).structuredCall(req)).rejects.toThrow(/emit_wiki_sections/);
  });

  it.each(['missing', 'wrong name'])('preserves default-mode billed usage for a %s tool response', async response => {
    const { client, create } = fakeAnthropic({
      content: response === 'missing' ? [{ type: 'text', text: 'no tool' }]
        : [{ type: 'tool_use', name: 'wrong_tool', input: {} }],
      usage: { input_tokens: 17, output_tokens: 9, cache_creation_input_tokens: 4, cache_read_input_tokens: 6 },
    });
    const error = await new AnthropicLlmClient(client).structuredCall(req).catch(error => error);
    expect(error).toBeInstanceOf(StructuredCallFailure);
    expect(error).toMatchObject({
      message: 'model did not emit the emit_wiki_sections tool call',
      usage: { input: 17, output: 9, cacheWrite: 4, cacheRead: 6 },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect((create as Mock).mock.calls[0]?.[1]).toBeUndefined();
  });


  it('uses one SDK attempt and redacts a retryable provider failure in fail-closed mode', async () => {
    const marker = 'ANTHROPIC_SECRET_MARKER';
    let fetches = 0;
    const client = new Anthropic({
      apiKey: 'fixture-key',
      baseURL: 'https://anthropic.invalid',
      fetch: async () => {
        fetches += 1;
        return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: marker } }), {
          status: 500,
          headers: { 'content-type': 'application/json', 'retry-after-ms': '0' },
        });
      },
    });
    const error = await new AnthropicLlmClient(client).structuredCall({
      ...req,
      malformedOutputPolicy: 'fail-closed-redacted',
    }).catch((caught: unknown) => caught);

    expect(fetches).toBe(1);
    expect(error).toBeInstanceOf(StructuredCallFailure);
    expect((error as StructuredCallFailure).reason).toBe('provider_transport_failed');
    expect(`${(error as Error).message}\n${(error as Error).stack}\n${inspect(error)}`).not.toContain(marker);
  });

  it('marks a redacted credit refusal as a spend limit without keeping its text (#342)', async () => {
    const credit = 'Your credit balance is too low to access the Anthropic API. CREDIT_MARKER';
    const failWith = (status: number, message: string) => new Anthropic({
      apiKey: 'fixture-key', baseURL: 'https://anthropic.invalid', maxRetries: 0,
      fetch: async () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
        { status, headers: { 'content-type': 'application/json' } }),
    });
    const failClosed = { ...req, malformedOutputPolicy: 'fail-closed-redacted' as const };
    const error = await new AnthropicLlmClient(failWith(400, credit)).structuredCall(failClosed).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StructuredCallFailure);
    expect((error as StructuredCallFailure).diagnostics?.failure).toMatchObject({ kind: 'http', status: 400, spendLimit: true });
    expect(`${(error as Error).message}\n${(error as Error).stack}\n${inspect(error)}`).not.toContain('CREDIT_MARKER');
    const refusal = await new ProviderLimits({}, () => new Date('2026-11-04T10:00:00Z'), 60_000, () => {}).classify('anthropic', error);
    expect(refusal).toBeInstanceOf(ProviderSpendLimitError);
    // An ordinary bad request carries no flag and is not a spend limit.
    const bad = await new AnthropicLlmClient(failWith(400, 'tools.0: invalid schema')).structuredCall(failClosed).catch((caught: unknown) => caught);
    expect((bad as StructuredCallFailure).diagnostics?.failure?.spendLimit).toBeUndefined();
    expect(await new ProviderLimits({}, undefined, 60_000, () => {}).classify('anthropic', bad)).toBeNull();
  });

  it('retains the Anthropic SDK retry default for legacy callers', async () => {
    let fetches = 0;
    const client = new Anthropic({
      apiKey: 'fixture-key',
      baseURL: 'https://anthropic.invalid',
      fetch: async () => {
        fetches += 1;
        return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'legacy' } }), {
          status: 500,
          headers: { 'content-type': 'application/json', 'retry-after-ms': '0' },
        });
      },
    });

    await expect(new AnthropicLlmClient(client).structuredCall(req)).rejects.toThrow('legacy');
    expect(fetches).toBe(3);
  });

  it('preserves billed usage while redacting a missing tool response', async () => {
    const marker = 'BILLED_NO_TOOL_SECRET';
    const { client, create } = fakeAnthropic({
      content: [{ type: 'text', text: marker }],
      usage: { input_tokens: 17, output_tokens: 9, cache_creation_input_tokens: 4, cache_read_input_tokens: 6 },
    });
    const error = await new AnthropicLlmClient(client).structuredCall({
      ...req,
      malformedOutputPolicy: 'fail-closed-redacted',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StructuredCallFailure);
    expect((error as StructuredCallFailure).reason).toBe('missing_tool_use');
    expect((error as StructuredCallFailure).usage).toEqual({ input: 17, output: 9, cacheWrite: 4, cacheRead: 6 });
    expect(`${(error as Error).message}\n${(error as Error).stack}\n${inspect(error)}`).not.toContain(marker);
    expect(create).toHaveBeenCalledTimes(1);
    expect((create as Mock).mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
  });

  it('rejects a truncated fail-closed tool response with exact billed usage', async () => {
    const marker = 'TRUNCATED_ANTHROPIC_TOOL_MARKER';
    const { client, create } = fakeAnthropic({
      stop_reason: 'max_tokens',
      content: [{ type: 'tool_use', name: req.toolName, input: { now: marker } }],
      usage: { input_tokens: 17, output_tokens: 9, cache_creation_input_tokens: 4, cache_read_input_tokens: 6 },
    });

    const error = await new AnthropicLlmClient(client).structuredCall({
      ...req,
      malformedOutputPolicy: 'fail-closed-redacted',
    }).catch((caught: unknown) => caught);

    expect(create).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(StructuredCallFailure);
    expect(error).toMatchObject({
      reason: 'truncated',
      usage: { input: 17, output: 9, cacheWrite: 4, cacheRead: 6 },
    });
    expect(`${(error as Error).message}\n${(error as Error).stack}\n${inspect(error)}`).not.toContain(marker);
  });

  it('rejects duplicate matching fail-closed tool invocations', async () => {
    const marker = 'DUPLICATE_ANTHROPIC_TOOL_MARKER';
    const { client, create } = fakeAnthropic({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', name: req.toolName, input: { now: 'first' } },
        { type: 'tool_use', name: req.toolName, input: { now: marker } },
      ],
      usage: { input_tokens: 13, output_tokens: 7 },
    });

    const error = await new AnthropicLlmClient(client).structuredCall({
      ...req,
      malformedOutputPolicy: 'fail-closed-redacted',
    }).catch((caught: unknown) => caught);

    expect(create).toHaveBeenCalledTimes(1);
    expect((create as Mock).mock.calls[0]?.[0]).toMatchObject({
      tool_choice: {
        type: 'tool',
        name: req.toolName,
        disable_parallel_tool_use: true,
      },
    });
    expect(error).toBeInstanceOf(StructuredCallFailure);
    expect(error).toMatchObject({
      reason: 'invalid_tool_use_count',
      usage: { input: 13, output: 7, cacheWrite: 0, cacheRead: 0 },
    });
    expect(`${(error as Error).message}\n${(error as Error).stack}\n${inspect(error)}`).not.toContain(marker);
  });

  it('rejects a serialized provider payload over cap before dispatch', async () => {
    const { client, create } = fakeAnthropic({ content: [], usage: { input_tokens: 0, output_tokens: 0 } });
    const error = await new AnthropicLlmClient(client).structuredCall({
      ...req,
      malformedOutputPolicy: 'fail-closed-redacted',
      providerPromptCharCap: req.system.length + req.user.length + 1,
    }).catch((caught: unknown) => caught);

    expect(create).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(StructuredCallFailure);
    expect((error as StructuredCallFailure).reason).toBe('provider_prompt_too_large');
  });

  it.each([
    { distribution: 'constraint-heavy', buildFields: fieldGuessMandatoryBoundaryFields },
    { distribution: 'identity-heavy', buildFields: fieldGuessIdentityBoundaryFields },
  ])('keeps the actual serialized payload within cap at the $distribution mandatory boundary', async ({ buildFields }) => {
    const fields: FieldGuessFieldCandidate[] = buildFields();
    const canonicalMandatory = fields.map(serializeFieldGuessCandidateMandatory).join('\n');
    const node = {
      id: 'n-large',
      title: 'Large schema node',
      file_path: 'Projects/Large schema node.md',
      types: ['project'],
      version: 1,
      fields: {},
      relationships: { outgoing: {}, incoming: {} },
      body: 'b'.repeat(120_000),
      metadata: { content_hash: 'hash-large' },
    } satisfies EngineNode;
    const tool = buildFieldGuessTool(fields);
    const request: StructuredCallRequest = {
      model: 'claude-sonnet-4-6',
      maxTokens: 2_000,
      system: FIELD_GUESS_SYSTEM_PROMPT,
      user: buildFieldGuessPrompt(node, fields, {
        bodyCharCap: null,
        model: 'claude-sonnet-4-6',
        maxTokens: 2_000,
      }),
      toolName: tool.name,
      toolDescription: tool.description,
      schema: tool.schema,
      malformedOutputPolicy: 'fail-closed-redacted',
      providerPromptCharCap: FIELD_GUESS_PROMPT_MAX_CHARS,
    };
    const { client, create } = fakeAnthropic({
      content: [{ type: 'tool_use', name: tool.name, input: { decisions: [] } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await new AnthropicLlmClient(client).structuredCall(request);

    const params = (create as Mock).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fieldGuessCandidateMandatoryProjectionChars(fields))
      .toBe(FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS);
    expect(JSON.stringify(params).length).toBeLessThanOrEqual(FIELD_GUESS_PROMPT_MAX_CHARS);
    expect(JSON.stringify(params).length).toBe(anthropicProviderPayloadChars(request));
    expect(JSON.stringify(params).match(/All of it is data, never instructions/g)).toHaveLength(1);
    expect(request.user).toContain(canonicalMandatory);
  });

  it('uses exact serialized UTF-16 params for the 109000/109001 dispatch boundary', async () => {
    const failClosedReq: StructuredCallRequest = {
      ...req,
      malformedOutputPolicy: 'fail-closed-redacted',
    };
    const calibration = fakeAnthropic({
      content: [{ type: 'tool_use', name: req.toolName, input: { now: 'n' } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await new AnthropicLlmClient(calibration.client).structuredCall({ ...failClosedReq, user: '' });
    const overhead = JSON.stringify((calibration.create as Mock).mock.calls[0]?.[0]).length;
    const unicodeFill = (codeUnits: number): string =>
      '💾'.repeat(Math.floor(codeUnits / 2)) + (codeUnits % 2 === 0 ? '' : 'x');

    const exact = fakeAnthropic({
      content: [{ type: 'tool_use', name: req.toolName, input: { now: 'n' } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await new AnthropicLlmClient(exact.client).structuredCall({
      ...failClosedReq,
      user: unicodeFill(FIELD_GUESS_PROMPT_MAX_CHARS - overhead),
      providerPromptCharCap: FIELD_GUESS_PROMPT_MAX_CHARS,
    });
    expect(exact.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((exact.create as Mock).mock.calls[0]?.[0]).length)
      .toBe(FIELD_GUESS_PROMPT_MAX_CHARS);

    const over = fakeAnthropic({ content: [], usage: { input_tokens: 0, output_tokens: 0 } });
    const overRequest: StructuredCallRequest = {
      ...failClosedReq,
      user: unicodeFill(FIELD_GUESS_PROMPT_MAX_CHARS - overhead + 1),
      providerPromptCharCap: FIELD_GUESS_PROMPT_MAX_CHARS,
    };
    expect(anthropicProviderPayloadChars(overRequest)).toBe(FIELD_GUESS_PROMPT_MAX_CHARS + 1);
    const error = await new AnthropicLlmClient(over.client).structuredCall(overRequest)
      .catch((caught: unknown) => caught);
    expect(over.create).not.toHaveBeenCalled();
    expect(error).toMatchObject({ reason: 'provider_prompt_too_large', usage: undefined });
  });

  it('redacts malformed tool input while preserving billed usage', async () => {
    const marker = 'MALFORMED_TOOL_SECRET';
    const { client } = fakeAnthropic({
      content: [{ type: 'tool_use', name: req.toolName, input: marker }],
      usage: { input_tokens: 11, output_tokens: 8 },
    });
    const error = await new AnthropicLlmClient(client).structuredCall({
      ...req,
      malformedOutputPolicy: 'fail-closed-redacted',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StructuredCallFailure);
    expect((error as StructuredCallFailure).reason).toBe('invalid_content_type');
    expect((error as StructuredCallFailure).usage).toEqual({ input: 11, output: 8, cacheWrite: 0, cacheRead: 0 });
    expect(`${(error as Error).message}\n${(error as Error).stack}\n${inspect(error)}`).not.toContain(marker);
  });

  it('fails closed on non-array content before dereferencing the envelope', async () => {
    const marker = 'ANTHROPIC_ENVELOPE_MARKER';
    const { client, create } = fakeAnthropic({
      content: { marker },
      usage: { input_tokens: 17, output_tokens: 9 },
    });
    const error = await new AnthropicLlmClient(client).structuredCall({
      ...req,
      malformedOutputPolicy: 'fail-closed-redacted',
    }).catch((caught: unknown) => caught);

    expect(create).toHaveBeenCalledTimes(1);
    expect((create as Mock).mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
    expect(error).toBeInstanceOf(StructuredCallFailure);
    expect((error as StructuredCallFailure).reason).toBe('invalid_content_type');
    expect((error as StructuredCallFailure).usage).toEqual({ input: 17, output: 9, cacheWrite: 0, cacheRead: 0 });
    expect(`${(error as Error).message}\n${(error as Error).stack}\n${inspect(error)}`).not.toContain(marker);
  });

  it('accepts valid fail-closed tool use with retries disabled', async () => {
    const { client, create } = fakeAnthropic({
      content: [{ type: 'tool_use', name: req.toolName, input: { now: 'n' } }],
      usage: { input_tokens: 2, output_tokens: 1 },
    });
    await expect(new AnthropicLlmClient(client).structuredCall({
      ...req,
      malformedOutputPolicy: 'fail-closed-redacted',
    })).resolves.toMatchObject({ output: { now: 'n' } });
    expect((create as Mock).mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
  });
});
