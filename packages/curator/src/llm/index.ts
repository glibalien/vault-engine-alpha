import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createProviderClients, type OpenAiCompatProvider, type ProviderClients } from '@vault/llm';
import type { ModelProvider } from '@vault/settings-registry';
import type { LlmKeys } from '../config.js';
import { AnthropicLlmClient } from './anthropic.js';
import { OpenAiCompatLlmClient } from './openai-compat.js';
import { countingFetch } from './sdk-attempts.js';
import { projectFailClosedFailure, supportsReasoningBudget } from './types.js';
import type { LlmClient, StructuredCallRequest, StructuredCallResult } from './types.js';

/** Resolves a per-call model id to the provider that serves it (catalog-backed
 *  via `Config.modelProviders` — see settings.ts's buildRuntimeConfig). */
export type ProviderFor = (model: string) => ModelProvider;

/**
 * Build a single LlmClient that routes each `structuredCall` to whichever
 * provider `providerFor(req.model)` names. SDK clients and keys come from the
 * shared `@vault/llm` provider clients, built lazily on first use; this
 * constructs at most one adapter per provider. The one LlmClient factory every
 * composition root (server.ts/run.ts/eval*.ts) uses.
 */
export function createDispatchingLlmClient(
  keys: LlmKeys,
  providerFor: ProviderFor,
  opts: { reasoningEffort?: string } = {},
): LlmClient {
  // Counted fetches let each call's diagnostics see the SDKs' own retries (#321).
  const fetch = countingFetch();
  return dispatchingClient(createProviderClients(keys.keys, {
    baseURLs: keys.baseURLs,
    createOpenAi: options => new OpenAI({ ...options, fetch }),
    createAnthropic: options => new Anthropic({ ...options, fetch }),
  }), providerFor, { ...opts });
}

function dispatchingClient(
  clients: ProviderClients,
  providerFor: ProviderFor,
  opts: { reasoningEffort?: string; reasoningBudget?: number },
): LlmClient {
  let anthropicClient: AnthropicLlmClient | undefined;
  const openAiCompatClients = new Map<OpenAiCompatProvider, OpenAiCompatLlmClient>();

  function getAnthropic(model: string): AnthropicLlmClient {
    anthropicClient ??= new AnthropicLlmClient(clients.anthropic(model));
    return anthropicClient;
  }

  function getOpenAiCompat(provider: OpenAiCompatProvider, model: string): OpenAiCompatLlmClient {
    let client = openAiCompatClients.get(provider);
    if (!client) {
      client = new OpenAiCompatLlmClient(clients.openAiCompat(provider, model), {
        reasoningEffort: opts.reasoningEffort,
        ...(opts.reasoningBudget !== undefined ? { reasoningBudget: opts.reasoningBudget } : {}),
        // Fireworks-only request extensions (replica affinity, loud context overflow).
        fireworksExtensions: provider === 'fireworks',
        provider,
      });
      openAiCompatClients.set(provider, client);
    }
    return client;
  }

  function resolve(req: StructuredCallRequest) {
    let client: AnthropicLlmClient | OpenAiCompatLlmClient;
    try {
      const provider = providerFor(req.model);
      client = provider === 'anthropic' ? getAnthropic(req.model) : getOpenAiCompat(provider, req.model);
    } catch (error) {
      throw req.malformedOutputPolicy === 'fail-closed-redacted'
        ? projectFailClosedFailure(error, 'provider_dispatch_failed')
        : error;
    }
    return client;
  }

  return {
    configurationFor: model => {
      const provider = providerFor(model);
      // A bound budget must survive configurationFor -> withConfiguration round trips, as
      // topic request budgeting makes (fitTopicRequest); only withConfiguration sets one.
      return { provider, reasoningEffort: provider === 'anthropic' ? null : opts.reasoningEffort ?? null,
        ...(opts.reasoningBudget !== undefined && supportsReasoningBudget(provider) ? { reasoningBudget: opts.reasoningBudget } : {}) };
    },
    withConfiguration: configuration => {
      const { provider, reasoningEffort, reasoningBudget } = configuration;
      // Refused here, before any call: the Anthropic adapter would otherwise ignore it.
      if (reasoningBudget !== undefined && !supportsReasoningBudget(provider)) {
        throw new Error(`REASONING_BUDGET_UNSUPPORTED: ${provider} requests can't carry a reasoning budget`);
      }
      return dispatchingClient(clients, () => provider, { reasoningEffort: reasoningEffort ?? undefined,
        ...(reasoningBudget !== undefined ? { reasoningBudget } : {}) });
    },
    supportsPreparedCapture: true,
    async previewStructuredCall(req: StructuredCallRequest) {
      try { return await resolve(req).previewStructuredCall(req); }
      catch (error) {
        throw req.malformedOutputPolicy === 'fail-closed-redacted'
          ? projectFailClosedFailure(error, 'provider_dispatch_failed') : error;
      }
    },
    // async: a missing-key throw must surface as a rejected promise, not a
    // synchronous exception — callers (curateProject) only capture the former.
    async structuredCall(req: StructuredCallRequest): Promise<StructuredCallResult> {
      const client = resolve(req);
      try {
        return await client.structuredCall(req);
      } catch (error) {
        throw req.malformedOutputPolicy === 'fail-closed-redacted'
          ? projectFailClosedFailure(error, 'provider_call_failed')
          : error;
      }
    },
  };
}
