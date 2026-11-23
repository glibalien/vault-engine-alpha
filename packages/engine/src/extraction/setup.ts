import { createProviderClients, providerKeysFromEnv, type ProviderClients } from '@vault/llm';
import { isModelProvider, PROVIDERS } from '@vault/settings-registry';
import type { Extractor } from './types.js';
import type { UsageRecorder } from '../usage/recorder.js';
import { ExtractorRegistry } from './registry.js';
import { MarkdownExtractor } from './extractors/markdown.js';
import { OfficeExtractor } from './extractors/office.js';
import { UnpdfExtractor } from './extractors/unpdf.js';
import { SvgTextExtractor } from './extractors/svg-text.js';
import { DeepgramExtractor, DEEPGRAM_EXTENSIONS } from './extractors/deepgram.js';
import {
  GeminiVisionImageExtractor,
  GeminiVisionPdfExtractor,
  GEMINI_IMAGE_EXTENSIONS,
} from './extractors/gemini-vision.js';
import {
  CLAUDE_VISION_MODEL,
  ModelVisionImageExtractor,
  ModelVisionPdfExtractor,
  visionExtractorId,
  visionImageExtensions,
  type VisionTarget,
} from './extractors/model-vision.js';

export interface BuiltExtractors {
  registry: ExtractorRegistry;
  pdfFallback: Extractor | null;
}

type VisionProvider = 'gemini' | 'claude' | 'model';

function resolveVisionProvider(raw: string | undefined): VisionProvider {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed === '' || trimmed === 'gemini') return 'gemini';
  if (trimmed === 'claude') return 'claude';
  // 'qwen' is the legacy name for the generalized 'model' arm — accept it for
  // env back-compat (mirrors the registry envSeed.parse mapping).
  if (trimmed === 'model' || trimmed === 'qwen') return 'model';
  throw new Error(
    `Invalid VISION_PROVIDER=${JSON.stringify(raw)}; expected 'gemini', 'claude', or 'model'`,
  );
}

const DEFAULT_VISION_MODEL = 'accounts/fireworks/models/qwen3p7-plus';

/** The catalog model behind the `claude` and `model` arms: `claude` pins Claude
 *  Sonnet 4.6; `model` is whatever `visionModel` resolved to, on any provider. */
function catalogVisionTarget(provider: VisionProvider, env: Record<string, string | undefined>): VisionTarget | null {
  if (provider === 'claude') return { provider: 'anthropic', model: CLAUDE_VISION_MODEL };
  if (provider !== 'model') return null;
  const modelProvider = env.VISION_MODEL_PROVIDER?.trim().toLowerCase();
  return {
    provider: isModelProvider(modelProvider) ? modelProvider : 'fireworks',
    model: env.VISION_MODEL?.trim() || DEFAULT_VISION_MODEL,
  };
}

export function buildExtractors(
  env: Record<string, string | undefined>,
  usageRecorder?: UsageRecorder,
  existingRegistry?: ExtractorRegistry,
  extractionEnabled = true,
  clients: ProviderClients = createProviderClients(providerKeysFromEnv(env)),
): BuiltExtractors {
  // Re-arm path: rebuild INTO the same instance so every holder of the
  // reference (ExtractionCache, per-session server contexts, vault-stats)
  // observes the fresh extractor set without needing to be handed a new object.
  const registry = existingRegistry ?? new ExtractorRegistry();
  if (existingRegistry) registry.clear();

  // Always-on local extractors
  registry.register(new MarkdownExtractor());
  registry.register(new OfficeExtractor());
  registry.register(new UnpdfExtractor());
  registry.register(new SvgTextExtractor());

  // Paid extraction off by setting: the provider's extractors are listed as
  // disabled whatever keys are present, so no attachment reaches a paid API.
  if (!extractionEnabled) {
    const provider = resolveVisionProvider(env.VISION_PROVIDER);
    const target = catalogVisionTarget(provider, env);
    registry.registerDisabled('deepgram-nova-3', 'audio', DEEPGRAM_EXTENSIONS);
    if (target === null) {
      registry.registerDisabled('gemini-vision-image', 'image', GEMINI_IMAGE_EXTENSIONS);
    } else {
      registry.registerDisabled(visionExtractorId(target.provider, 'image'), 'image', visionImageExtensions(target.provider));
    }
    if (target !== null && PROVIDERS[target.provider].pdfInput) {
      registry.registerDisabled(visionExtractorId(target.provider, 'pdf'), 'pdf', ['.pdf']);
    } else {
      registry.registerDisabled('gemini-vision-pdf', 'pdf', ['.pdf']);
    }
    console.log('[extraction] extractionEnabled is off; audio and vision extraction disabled');
    return { registry, pdfFallback: null };
  }

  // Deepgram audio
  const deepgramKey = env.DEEPGRAM_API_KEY;
  if (deepgramKey) {
    registry.register(new DeepgramExtractor(deepgramKey, usageRecorder));
  } else {
    registry.registerUnavailable(
      'deepgram-nova-3',
      'audio',
      DEEPGRAM_EXTENSIONS,
      'DEEPGRAM_API_KEY',
    );
  }

  // Vision provider — selected by VISION_PROVIDER, defaulting to gemini
  const provider = resolveVisionProvider(env.VISION_PROVIDER);
  const target = catalogVisionTarget(provider, env);
  let pdfFallback: Extractor | null = null;

  if (target === null) {
    const key = env.GEMINI_API_KEY;
    if (key) {
      registry.register(new GeminiVisionImageExtractor(key, usageRecorder));
      pdfFallback = new GeminiVisionPdfExtractor(key, usageRecorder);
    } else {
      console.warn(
        '[extraction] VISION_PROVIDER=gemini but GEMINI_API_KEY is unset; vision extraction disabled',
      );
      registry.registerUnavailable('gemini-vision-image', 'image', GEMINI_IMAGE_EXTENSIONS, 'GEMINI_API_KEY');
      registry.registerUnavailable('gemini-vision-pdf', 'pdf', ['.pdf'], 'GEMINI_API_KEY');
    }
  } else {
    // claude and model: a catalog model on any provider, called through the
    // shared provider clients. Scanned PDFs go to the same model when its
    // provider takes PDF input (Anthropic, OpenAI); otherwise they ride on
    // Gemini, degradable independently of the image path.
    const keyName = PROVIDERS[target.provider].apiKeyEnv;
    const hasKey = clients.has(target.provider);
    const imageId = visionExtractorId(target.provider, 'image');
    if (hasKey) {
      registry.register(new ModelVisionImageExtractor(clients, target, usageRecorder));
    } else {
      console.warn(`[extraction] VISION_PROVIDER=${provider} but ${keyName} is unset; image vision extraction disabled`);
      registry.registerUnavailable(imageId, 'image', visionImageExtensions(target.provider), keyName);
    }

    if (PROVIDERS[target.provider].pdfInput) {
      if (hasKey) pdfFallback = new ModelVisionPdfExtractor(clients, target, usageRecorder);
      else registry.registerUnavailable(visionExtractorId(target.provider, 'pdf'), 'pdf', ['.pdf'], keyName);
    } else {
      const geminiKey = env.GEMINI_API_KEY;
      if (geminiKey) {
        pdfFallback = new GeminiVisionPdfExtractor(geminiKey, usageRecorder);
      } else {
        console.warn(`[extraction] VISION_PROVIDER=${provider} but GEMINI_API_KEY is unset; scanned-PDF fallback disabled`);
        registry.registerUnavailable('gemini-vision-pdf', 'pdf', ['.pdf'], 'GEMINI_API_KEY');
      }
    }
  }

  return { registry, pdfFallback };
}
