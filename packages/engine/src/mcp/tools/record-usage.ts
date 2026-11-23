import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isProviderPricedModel } from '@vault/pricing';
import { ok, type Issue } from './errors.js';
import { USAGE_PROVIDERS, USAGE_SERVICES, USAGE_PURPOSES, type UsageRecorder } from '../../usage/recorder.js';

export const recordUsageParamsShape = {
  provider: z.enum(USAGE_PROVIDERS)
    .describe('Third-party provider that was paid'),
  service: z.enum(USAGE_SERVICES)
    .describe('Which surface spent the money'),
  purpose: z.enum(USAGE_PURPOSES)
    .describe('What the call was for'),
  model: z.string().optional().describe('Provider model id, e.g. accounts/fireworks/models/qwen3p7-plus'),
  reported_model: z.string().min(1).optional()
    .describe("Model the provider's response says served the call (its `model` field), e.g. where openrouter/auto routed it. Reported only; it never changes the price"),
  provider_cost_usd: z.number().finite().nonnegative().optional()
    .describe('Actual account charge returned by the provider; omit for estimates or unavailable billing'),
  input_tokens: z.number().int().min(0).optional().describe('Prompt tokens EXCLUDING cached tokens'),
  output_tokens: z.number().int().min(0).optional(),
  cache_read_tokens: z.number().int().min(0).optional(),
  cache_write_tokens: z.number().int().min(0).optional(),
  audio_seconds: z.number().min(0).optional().describe('Transcribed audio duration (Deepgram billing unit)'),
  ts: z.string().datetime().optional().describe('ISO 8601 UTC time of the API call; defaults to now'),
  conversation_id: z.string().optional().describe('Engine conversations.id when the call belongs to a chat turn'),
  run_ref: z.string().optional().describe('Curator run reference'),
  source_ref: z.string().optional().describe('File path (extraction), query (web-search), or project (curator)'),
  experiment: z.string().optional().describe('Benchmark experiment label'),
  variant: z.string().optional().describe('Benchmark arm label'),
  latency_ms: z.number().int().min(0).optional(),
  request_id: z.string().optional().describe('Provider request id when exposed'),
  key_ref: z.string().regex(/^[0-9a-f]{16}$/).optional().describe('Fingerprint of the API key that paid (16 hex characters, never the key). Lets reconciliation compare a key only with its own rows.'),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

export function registerRecordUsage(server: McpServer, recorder: UsageRecorder): void {
  server.tool(
    'record-usage',
    'Record one paid third-party API call into the spend ledger. Send raw token/audio units and, when available, provider_cost_usd from the actual provider response (never an estimate). Actual charges take precedence; otherwise Engine estimates from its rate table. Unavailable pricing is marked unpriced, not free. INTERNAL WRITE PATH for the suite\'s own services: do NOT call this to log tool calls or model turns you observe — the engine and its clients record their own spend automatically; calling it yourself would double-count.',
    recordUsageParamsShape,
    async (params) => {
      const recorded = recorder.recordOrThrow({
        provider: params.provider,
        service: params.service,
        purpose: params.purpose,
        model: params.model,
        providerCostUsd: params.provider_cost_usd,
        ts: params.ts,
        inputTokens: params.input_tokens,
        outputTokens: params.output_tokens,
        cacheReadTokens: params.cache_read_tokens,
        cacheWriteTokens: params.cache_write_tokens,
        audioSeconds: params.audio_seconds,
        conversationId: params.conversation_id,
        runRef: params.run_ref,
        sourceRef: params.source_ref,
        experiment: params.experiment,
        variant: params.variant,
        latencyMs: params.latency_ms,
        requestId: params.request_id,
        keyRef: params.key_ref,
        reportedModel: params.reported_model,
        metadata: params.metadata,
      });
      const warnings: Issue[] = [];
      if (recorded.costBasis === 'unpriced') {
        const providerPriced = params.model !== undefined && isProviderPricedModel(params.model);
        warnings.push({
          code: 'UNPRICED_MODELS',
          severity: 'warning',
          message: providerPriced
            ? `${params.model} has no rate of its own, the call carried no provider charge, and the ledger has too few charged calls to it to estimate from — recorded with cost 0. Send provider_cost_usd from the response; a pricing row can't fix it.`
            : `No pricing row for model ${params.model ?? '(none)'} — recorded with cost 0. Add a row to @vault/pricing.`,
          details: { model: params.model ?? null, ...(providerPriced ? { provider_priced: true } : {}) },
        });
      }
      return ok({ id: recorded.id, cost_usd: recorded.costUsd, cost_basis: recorded.costBasis }, warnings);
    },
  );
}
