import { createCallDiagnostics, validTokenCount, type CallDiagnosticsCollector } from './diagnostics.js';
import { countSdkAttempts, type SdkAttemptTally } from './sdk-attempts.js';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropicUsage } from '@vault/llm';
import { assertProviderRequestBytes } from './request-budget.js';
import type { TokenUsage } from '../types.js';
import {
  capturePreparedRequest,
  immutablePreparedCapture,
  StructuredCallFailure,
  projectFailClosedFailure,
  type LlmClient,
  type LlmConfiguration,
  type StructuredCallRequest,
  type StructuredCallResult,
} from './types.js';

/**
 * Whether the model accepts a forced `tool_choice` (`tool`). Claude Opus 5.5, Claude Sonnet 5.5
 * and Claude Fable and Mythos 5.1 and later answer one with a 400 (#371), and later models are
 * assumed to as well; the Claude 3 and 4 models, the 5 generation and Claude Haiku 5.5 accept it.
 */
export function acceptsForcedToolChoice(model: string): boolean {
  const id = model.trim().toLowerCase();
  return /^claude-(\d|instant)/.test(id)
    || /^claude-[a-z]+-4(?:\b|[-.])/.test(id)
    || /^claude-(opus|sonnet|fable|mythos)-5$/.test(id)
    || /^claude-haiku-5-5$/.test(id);
}

export function buildAnthropicParams(req: StructuredCallRequest): Anthropic.MessageCreateParamsNonStreaming {
  const forced = acceptsForcedToolChoice(req.model);
  const oneCall = req.malformedOutputPolicy === 'fail-closed-redacted' ? { disable_parallel_tool_use: true } : {};
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
  // A model that refuses a forced tool call is told to make it; the reply is checked for it
  // either way (missing_tool_use). The cached system prompt stays as it is.
  if (!forced) system.push({ type: 'text', text: `Answer only by calling the ${req.toolName} tool, once.` });
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system,
    tools: [{
      name: req.toolName,
      description: req.toolDescription,
      input_schema: req.schema as Anthropic.Tool['input_schema'],
    }],
    tool_choice: forced ? { type: 'tool', name: req.toolName, ...oneCall } : { type: 'auto', ...oneCall },
    messages: [{ role: 'user', content: req.user }],
  };
}

export function anthropicProviderPayloadChars(req: StructuredCallRequest): number {
  return JSON.stringify(buildAnthropicParams(req)).length;
}

/** Forced named tool_choice (or, where the model refuses one, an instructed `auto`) with a
 *  cacheable system prompt. Legacy callers retain SDK retry/error behavior; fail-closed callers
 *  get one closed attempt. */
export class AnthropicLlmClient implements LlmClient {
  readonly supportsPreparedCapture = true as const;
  constructor(private readonly client: Anthropic) {}

  configurationFor(_model: string): LlmConfiguration {
    return { provider: 'anthropic', reasoningEffort: null };
  }

  withConfiguration(configuration: LlmConfiguration): LlmClient {
    if (configuration.provider !== 'anthropic') throw new Error('REQUEST_PROVIDER_MISMATCH');
    // A forced tool call can't run with extended thinking, so a budget would be dropped.
    if (configuration.reasoningBudget !== undefined) throw new Error('REASONING_BUDGET_UNSUPPORTED: anthropic requests can\'t carry a reasoning budget');
    return this;
  }

  async previewStructuredCall(req: StructuredCallRequest) {
    return immutablePreparedCapture('anthropic', req.model, 'anthropic-v1', buildAnthropicParams(req));
  }

  async structuredCall(req: StructuredCallRequest): Promise<StructuredCallResult> {
    const sdkTally: SdkAttemptTally = { count: 0 };
    const diagnostics = createCallDiagnostics(true,
      req.onPrepared !== undefined || req.malformedOutputPolicy === 'fail-closed-redacted', sdkTally);
    try {
      const result = await countSdkAttempts(sdkTally, () => this.executeCall(req, diagnostics));
      const snapshot = diagnostics.snapshot();
      return snapshot ? { ...result, diagnostics: snapshot } : result;
    } catch (error) {
      try { if (error instanceof StructuredCallFailure) error.diagnostics = diagnostics.snapshot(); } catch { /* observer only */ }
      throw error;
    }
  }

  private async executeCall(req: StructuredCallRequest, diagnostics: CallDiagnosticsCollector): Promise<StructuredCallResult> {
    let params = buildAnthropicParams(req);
    const failClosed = req.onPrepared !== undefined || req.malformedOutputPolicy === 'fail-closed-redacted';
    if (req.providerPromptCharCap !== undefined) {
      let payloadChars: number;
      try {
        payloadChars = JSON.stringify(params).length;
      } catch (error) {
        if (failClosed) throw projectFailClosedFailure(error, 'provider_prompt_too_large');
        throw error;
      }
      if (payloadChars > req.providerPromptCharCap) {
        if (failClosed) {
          throw new StructuredCallFailure(
            'structured call failed (reason=provider_prompt_too_large)',
            undefined,
            'provider_prompt_too_large',
          );
        }
        throw new Error('provider prompt exceeds configured character cap');
      }
    }
    params = await capturePreparedRequest(params, req, 'anthropic', 'anthropic-v1');
    assertProviderRequestBytes(params, req.providerRequestMaxBytes);
    let message: Anthropic.Message;
    try {
      diagnostics.start();
      message = await this.client.messages.create(params, failClosed ? { maxRetries: 0 } : undefined);
    } catch (error) {
      diagnostics.failure(error);
      if (failClosed) throw projectFailClosedFailure(error, 'provider_transport_failed');
      throw error;
    }
    let reportedUsageKnown = false;
    {
      try {
        const u = message?.usage;
        reportedUsageKnown = !!u && validTokenCount(u.input_tokens) && validTokenCount(u.output_tokens)
          && (u.cache_read_input_tokens == null || validTokenCount(u.cache_read_input_tokens))
          && (u.cache_creation_input_tokens == null || validTokenCount(u.cache_creation_input_tokens));
      } catch { reportedUsageKnown = false; }
    }
    diagnostics.response(() => ({ content: message?.content, finishReason: message?.stop_reason,
      reportedModel: message?.model, requestId: message?.id, usageKnown: reportedUsageKnown }));
    if (failClosed && (message === null || typeof message !== 'object' || Array.isArray(message))) {
      throw new StructuredCallFailure(
        'structured call failed (reason=invalid_content_type)', undefined, 'invalid_content_type',
      );
    }
    const usage = !reportedUsageKnown ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : anthropicUsage(message.usage);
    const failureUsage = !reportedUsageKnown ? undefined : usage;
    if (failClosed && message.stop_reason === 'max_tokens') {
      throw new StructuredCallFailure(
        'structured call failed (reason=truncated)', failureUsage, 'truncated',
      );
    }
    if (failClosed && (!Array.isArray(message.content) || message.content.some(block =>
      block === null || typeof block !== 'object' || Array.isArray(block)))) {
      throw new StructuredCallFailure(
        'structured call failed (reason=invalid_content_type)', failureUsage, 'invalid_content_type',
      );
    }
    const toolUses = message.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === req.toolName,
    );
    if (failClosed && toolUses.length > 1) {
      throw new StructuredCallFailure(
        'structured call failed (reason=invalid_tool_use_count)', failureUsage, 'invalid_tool_use_count',
      );
    }
    const toolUse = toolUses[0];
    if (!toolUse) {
      if (failClosed) {
        throw new StructuredCallFailure(
          'structured call failed (reason=missing_tool_use)', failureUsage, 'missing_tool_use',
        );
      }
      throw new StructuredCallFailure(`model did not emit the ${req.toolName} tool call`, failureUsage);
    }
    if (failClosed && (toolUse.input === null || typeof toolUse.input !== 'object' || Array.isArray(toolUse.input))) {
      throw new StructuredCallFailure(
        'structured call failed (reason=invalid_content_type)', failureUsage, 'invalid_content_type',
      );
    }
    return { output: toolUse.input, usage, ...(!reportedUsageKnown ? { usageKnown: false } : {}) };
  }
}
