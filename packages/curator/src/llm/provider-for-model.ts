import type { ModelProvider } from '@vault/settings-registry';
import type { ProviderFor } from './index.js';

/**
 * The single definition of "which provider serves this model id" — used by both
 * the dispatching LLM client (which key to send) and the usage reporter (which
 * provider to bill in the spend ledger). Those two MUST agree; when this logic
 * was inlined at eight call sites as `modelProviders[m] ?? 'fireworks'`, any
 * model absent from the catalog was attributed to Fireworks regardless of where
 * it actually ran — silently wrong in the ledger once OpenRouter went live.
 *
 * Resolution order:
 *   1. the catalog-resolved map (`buildRuntimeConfig`'s `modelProviders`)
 *   2. an unambiguous prefix in the id — this is what keeps the eval `--models`
 *      axis working, since it passes raw ids that never went through settings.
 *      `gpt-` is OpenAI's own naming; OpenRouter ids carry a vendor prefix
 *      (`openai/gpt-…`) and Fireworks ids start `accounts/fireworks/`
 *   3. throw. There is no default provider: guessing one bills the wrong
 *      account and sends the wrong API key.
 */
export function providerForModel(
  modelProviders: Record<string, ModelProvider>,
): ProviderFor {
  return (model: string): ModelProvider => {
    const mapped = modelProviders[model];
    if (mapped !== undefined) return mapped;
    if (model.startsWith('accounts/fireworks/')) return 'fireworks';
    if (model.startsWith('claude-')) return 'anthropic';
    if (model.startsWith('gpt-')) return 'openai';
    throw new Error(
      `no provider for model "${model}" — add a Settings/Models/ catalog note for it ` +
        `(or reference it from Settings/Curator/Models.md) so its provider is explicit. ` +
        `Refusing to guess: the wrong guess bills the wrong provider and sends the wrong API key.`,
    );
  };
}
