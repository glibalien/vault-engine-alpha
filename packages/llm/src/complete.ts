import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { TokenUsage } from '@vault/pricing';
import { PROVIDERS, type ModelProvider } from '@vault/settings-registry';
import { isOpenAiCompatProvider, type ProviderClients } from './clients.js';
import { anthropicUsage, openAiCompatUsage, openRouterReportedCost } from './usage.js';

/** One piece of a single-turn user message. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: Buffer }
  | { type: 'pdf'; data: Buffer };

export interface CompletionRequest {
  provider: ModelProvider;
  model: string;
  system?: string;
  /** The user message: plain text, or parts in the order the model should read them. */
  content: string | ContentPart[];
  maxTokens: number;
  /** Ask for a JSON object where the provider has a JSON mode (OpenAI-compatible
   *  providers). Others rely on the prompt, so parse the text leniently. */
  json?: boolean;
}

export interface CompletionResult {
  text: string;
  usage: TokenUsage;
  /** The model stopped at `maxTokens`. */
  truncated: boolean;
  /** What the provider charged for the call, when it says so in the response (OpenRouter's
   *  `usage.cost`). Record it as the provider-reported cost; without it, price the tokens. */
  providerCostUsd?: number;
  /** The provider's id for the response, when it sent one. */
  requestId?: string;
  /** The model the response says served the call, when it names one. For OpenRouter's
   *  Auto Router (`openrouter/auto`) this is the model it routed to (#340). */
  reportedModel?: string;
}

/**
 * One single-turn, non-streaming model call on any catalog provider. For
 * bounded extraction and classification calls that want text back; Curator's
 * structured synthesis calls use their own adapters.
 */
export async function complete(clients: ProviderClients, req: CompletionRequest): Promise<CompletionResult> {
  if (isOpenAiCompatProvider(req.provider)) {
    const client = clients.openAiCompat(req.provider, req.model);
    const response = await client.chat.completions.create(buildOpenAiCompatRequest(req));
    const choice = response.choices[0];
    const providerCostUsd = req.provider === 'openrouter' ? openRouterReportedCost(response.usage) : undefined;
    return {
      text: choice?.message?.content ?? '',
      usage: openAiCompatUsage(response.usage, req.provider),
      truncated: choice?.finish_reason === 'length',
      ...(providerCostUsd !== undefined ? { providerCostUsd } : {}),
      ...requestIdOf(response.id),
      ...reportedModelOf(response.model),
    };
  }
  const client = clients.anthropic(req.model);
  const response = await client.messages.create(buildAnthropicRequest(req));
  return {
    text: response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join(''),
    usage: anthropicUsage(response.usage),
    truncated: response.stop_reason === 'max_tokens',
    ...requestIdOf(response.id),
    ...reportedModelOf(response.model),
  };
}

function requestIdOf(id: unknown): { requestId?: string } {
  return typeof id === 'string' && id !== '' ? { requestId: id } : {};
}

function reportedModelOf(model: unknown): { reportedModel?: string } {
  return typeof model === 'string' && model !== '' ? { reportedModel: model } : {};
}

export function buildOpenAiCompatRequest(req: CompletionRequest): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (req.system !== undefined) messages.push({ role: 'system', content: req.system });
  messages.push({
    role: 'user',
    content: typeof req.content === 'string' ? req.content : req.content.map(part => openAiPart(part, req.provider)),
  });
  return {
    model: req.model,
    [PROVIDERS[req.provider].maxTokensField]: req.maxTokens,
    ...(req.json ? { response_format: { type: 'json_object' as const } } : {}),
    messages,
  };
}

function openAiPart(part: ContentPart, provider: ModelProvider): OpenAI.Chat.ChatCompletionContentPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
      return { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data.toString('base64')}` } };
    case 'pdf':
      if (!PROVIDERS[provider].pdfInput) throw new Error(`PDF input is not supported on ${PROVIDERS[provider].label}`);
      return {
        type: 'file',
        file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${part.data.toString('base64')}` },
      };
  }
}

export function buildAnthropicRequest(req: CompletionRequest): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    ...(req.system !== undefined ? { system: req.system } : {}),
    messages: [{
      role: 'user',
      content: typeof req.content === 'string' ? req.content : req.content.map(anthropicPart),
    }],
  };
}

function anthropicPart(part: ContentPart): Anthropic.ContentBlockParam {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: part.mimeType as Anthropic.Base64ImageSource['media_type'], data: part.data.toString('base64') },
      };
    case 'pdf':
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: part.data.toString('base64') } };
  }
}
