import { audioPricingFor, pricingForExact } from '@vault/pricing';
import { isModelProvider, PROVIDERS } from '@vault/settings-registry';
import { engineEnvPath } from './configure.js';
import { EngineToolError, type EngineCall } from './engine-client.js';
import { waitUntilAnswering, type EngineStageDeps } from './engine-stage.js';
import type { Host } from './host.js';
import type { Prompter } from './prompter.js';
import type { PlanReport } from './report.js';
import { dollars } from './review.js';
import type { ServiceBackend } from './services.js';
import { saveState, StateError, type InstallState } from './state.js';
import { count } from './text.js';
import { ENGINE_UNIT } from './units.js';

/** Engine applies each domain's patch on its own; this order keeps model references last. */
const DOMAIN_ORDER = ['engine', 'vault', 'wiki', 'chat', 'curator'];

/** Engine's image extractors, by vision provider (`packages/engine/src/extraction/extractors`). */
const IMAGE_EXTENSIONS: Record<'gemini' | 'claude' | 'model', readonly string[]> = {
  gemini: ['.png', '.jpg', '.jpeg', '.webp'],
  claude: ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
  model: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tiff', '.bmp'],
};
/** Engine's image types for a catalog vision model: Fireworks and OpenRouter also take tiff and bmp. */
function catalogImageExtensions(provider: string): readonly string[] {
  return provider === 'fireworks' || provider === 'openrouter' ? IMAGE_EXTENSIONS.model : IMAGE_EXTENSIONS.claude;
}
const AUDIO_EXTENSIONS: readonly string[] = ['.m4a', '.mp3', '.wav', '.webm', '.ogg', '.mp4'];
/** The models Engine's own extractors call. */
const VISION_MODELS = { gemini: 'gemini-2.5-flash', claude: 'claude-sonnet-4-6' } as const;
const AUDIO_MODEL = 'nova-3';
/** Rough tokens per image and minutes per audio file, for a cost range rather than a quote. */
const IMAGE_TOKENS = { input: [300, 2000], output: [200, 1000] } as const;
const AUDIO_MINUTES = [1, 30] as const;

export class SettingsError extends Error {
  override readonly name = 'SettingsError';
}

export interface SettingsStageDeps extends Pick<EngineStageDeps, 'readyTimeoutMs' | 'pollMs'> {
  host: Host;
  prompter: Prompter;
  backend: ServiceBackend;
  /** Engine calls with the installer token. */
  engine: () => Promise<EngineCall>;
  now: () => Date;
}

/**
 * Stage 10. Add the planned models Engine's catalog lacks, apply every approved setting
 * through Engine (the curator domain too, so Curator's first start already has them),
 * then ask before turning on paid attachment extraction. Applying settings again changes
 * nothing, so a rerun repeats the calls safely.
 */
export async function runSettingsStage(deps: SettingsStageDeps, state: InstallState, path: string): Promise<void> {
  if (state.stages.settings?.completed_at) return;
  const { prompter } = deps;
  const plan = state.plan;
  state.stages.settings ??= { started_at: deps.now().toISOString(), completed_at: null, extraction: null, engine_restarted: false };
  await saveState(path, state);

  const call = await deps.engine();
  const added = await addModels(call, plan.models.models.filter(model => model.add_to_catalog));
  // A setting with a condition (`when`) waits for it: the vision provider for consent.
  const applied = await applySettings(call, plan.review.settings.filter(setting => setting.when === undefined));
  prompter.info(`Applied ${count(applied, 'setting')} through Engine${added > 0 ? `, after adding ${count(added, 'model')} to its catalog` : ''}.`);

  await consentToExtraction(deps, state, path, call);
  state.stages.settings.completed_at = deps.now().toISOString();
  await saveState(path, state);
}

interface CatalogEntry {
  title: string;
  provider: string;
  model: string;
  enabled: boolean;
}

/** Add each model the plan uses that Engine does not seed; one already there is kept. */
async function addModels(call: EngineCall, models: PlanReport['models']['models']): Promise<number> {
  if (models.length === 0) return 0;
  const { domains } = await call<{ domains: { models: { catalog: CatalogEntry[] } } }>('get-settings', { domain: 'models' });
  let added = 0;
  for (const model of models) {
    const existing = domains.models.catalog.find(entry => entry.provider === model.provider && entry.model === model.model);
    if (existing) {
      if (existing.title !== model.title || !existing.enabled) {
        throw new SettingsError(`Engine's model catalog already has ${model.model} as "${existing.title}"${existing.enabled ? '' : ' (disabled)'}, but the plan uses "${model.title}". Rename or enable its note in Settings/Models/ and run the install again.`);
      }
      continue;
    }
    try {
      await call('add-model', { provider: model.provider, model: model.model, title: model.title });
    } catch (error) {
      if (!(error instanceof EngineToolError)) throw error;
      throw new SettingsError(`Engine could not add ${model.title} (${model.model}) to its catalog: ${error.message}`);
    }
    added++;
  }
  return added;
}

/**
 * One `update-settings` per domain; returns how many settings Engine took. A key counts
 * only when Engine applied it and its effective value is the planned one: `null` resets a
 * key to its default rather than storing null.
 */
async function applySettings(call: EngineCall, settings: PlanReport['review']['settings']): Promise<number> {
  const patches = new Map<string, Record<string, unknown>>();
  for (const { setting, value } of settings) {
    const [domain, key] = splitSetting(setting);
    patches.set(domain, { ...patches.get(domain), [key]: value });
  }
  const domains = [...patches.keys()].sort((left, right) => rank(left) - rank(right));
  const problems: string[] = [];
  for (const domain of domains) {
    const patch = patches.get(domain) as Record<string, unknown>;
    problems.push(...await updateSettings(call, domain, patch));
  }
  if (problems.length > 0) {
    throw new SettingsError(`Engine did not take ${problems.join('; ')}. The others were applied. Engine's get-settings shows each domain's issues; fix the cause and run the install again.`);
  }
  return settings.length;
}

/** Apply one domain's patch; returns each key Engine did not take as planned. */
async function updateSettings(call: EngineCall, domain: string, patch: Record<string, unknown>): Promise<string[]> {
  const result = await call<{ applied: string[]; effective: Record<string, unknown> }>('update-settings', { domain, patch });
  return Object.entries(patch).flatMap(([key, value]) => {
    if (!result.applied.includes(key)) return [`${domain}.${key} (rejected)`];
    const effective = result.effective[key] ?? null;
    return JSON.stringify(effective) === JSON.stringify(value)
      ? []
      : [`${domain}.${key} (it is ${JSON.stringify(effective)}, not ${JSON.stringify(value)})`];
  });
}

function splitSetting(setting: string): [string, string] {
  const dot = setting.indexOf('.');
  if (dot <= 0) throw new StateError(`the saved plan has a setting without a domain: ${setting}`);
  return [setting.slice(0, dot), setting.slice(dot + 1)];
}

function rank(domain: string): number {
  const index = DOMAIN_ORDER.indexOf(domain);
  return index === -1 ? DOMAIN_ORDER.length : index;
}

/**
 * Engine's first start seeded extractionEnabled off, so its extraction keys make no paid
 * calls. Show what extraction would read and roughly what it costs, and only on approval
 * turn extractionEnabled on and restart Engine, which reads the setting when it starts.
 * The answer is saved first, so a rerun finishes what it started without asking again.
 */
async function consentToExtraction(deps: SettingsStageDeps, state: InstallState, path: string, call: EngineCall): Promise<void> {
  const { prompter } = deps;
  const plan = state.plan;
  const record = state.stages.settings as NonNullable<InstallState['stages']['settings']>;
  const vision = plan.models.vision_provider;
  if (!plan.review.extraction_seeded_off) {
    record.extraction = 'not_needed';
    return;
  }
  if (record.extraction === null || record.extraction === 'not_needed') {
    prompter.note(extractionPreview(plan).join('\n'), 'Attachment extraction');
    // A headless plan recorded the answers file's choice; nobody can be asked on a
    // headless resume of an interactive plan, so extraction stays off.
    let approved = plan.extraction_approved;
    if (approved !== null) prompter.info(approved ? 'The answers file approves it.' : 'The answers file does not approve it.');
    else approved = prompter.interactive && await prompter.confirm({ message: 'Start reading your attachments now? This uses paid AI calls.', initialValue: false });
    record.extraction = approved ? 'approved' : 'declined';
    await saveState(path, state);
  }

  if (record.extraction === 'declined') {
    prompter.info([
      'Attachment extraction stays off; Engine keeps its keys for its other features.',
      'To turn it on later, set Engine\'s extractionEnabled to true with update-settings, and restart Engine.',
    ].join(' '));
    return;
  }

  const problems = await updateSettings(call, 'engine', { extractionEnabled: true });
  if (problems.length > 0) {
    throw new SettingsError(`Engine did not take ${problems.join('; ')}. Engine's get-settings shows why; fix it and run the install again.`);
  }
  if (!record.engine_restarted) await restartForExtraction(deps, state, path);
  prompter.info(`Attachment extraction is on${vision !== 'off' ? ` (vision: ${vision})` : ''}. Engine reads embedded attachments in the background, once each.`);
}

/**
 * Engine reads extractionEnabled only when it starts, and attachments it skipped are tried
 * again only after a restart, so approval always restarts it. A scanned PDF it read before
 * (from its text layer alone) is read again once the vision fallback exists. The request is
 * saved first: a restart the user ran by hand (with --no-sudo) counts once Engine runs a
 * process started after it. Either way, Engine must then report extraction on, its keys,
 * and the provider in use.
 */
async function restartForExtraction(deps: SettingsStageDeps, state: InstallState, path: string): Promise<void> {
  const plan = state.plan;
  const record = state.stages.settings as NonNullable<InstallState['stages']['settings']>;
  // The real clock, not the install's: it is compared with when Engine's process started.
  record.restart_requested_at ??= new Date().toISOString();
  await saveState(path, state);
  const started = await deps.backend.startedAt(ENGINE_UNIT);
  if (started === null || started.getTime() < Date.parse(record.restart_requested_at)) {
    await deps.backend.restart(ENGINE_UNIT);
  }
  await waitUntilAnswering(deps, plan.services.engine_port);

  const { extractors } = await (await deps.engine())<{ extractors?: ExtractorStatus }>('vault-stats');
  const keys = plan.review.env_keys.engine_first_boot;
  const vision = plan.models.vision_provider;
  const off = (extractors?.disabled ?? []).length > 0;
  const missing = [...new Set((extractors?.unavailable ?? [])
    .map(entry => entry.missingKey)
    .filter(key => keys.includes(key)))];
  // Engine names catalog vision extractors by API: claude-vision-* for Anthropic.
  const expected = vision === 'off' ? null
    : vision === 'model' && planVisionModel(plan)?.provider === 'anthropic' ? VISION_EXTRACTORS.claude
      : VISION_EXTRACTORS[vision];
  const inactive = expected !== null && !(extractors?.active ?? []).some(entry => entry.id === expected);
  if (off || missing.length > 0 || inactive) {
    const problem = off
      ? 'still has extraction off'
      : missing.length > 0 ? `does not have ${missing.join(', ')}` : `does not read images with ${vision}`;
    throw new SettingsError([
      `Engine restarted but ${problem}.`,
      `Check ${engineEnvPath(plan.data_dir)} and Engine's log (${deps.backend.logCommand(ENGINE_UNIT)}), then run the install again.`,
    ].join(' '));
  }
  record.engine_restarted = true;
  await saveState(path, state);
}

/** Engine's image extractor for each vision provider. */
const VISION_EXTRACTORS: Record<'gemini' | 'claude' | 'model', string> = {
  gemini: 'gemini-vision-image',
  claude: 'claude-vision-image',
  model: 'openai-compat-vision-image',
};

interface ExtractorStatus {
  active: Array<{ id: string }>;
  unavailable: Array<{ id: string; missingKey: string }>;
  /** Paid extractors kept off by extractionEnabled. */
  disabled?: Array<{ id: string }>;
}

/**
 * What extraction would read, by kind, with a rough cost. The counts are every such file
 * in the vault; Engine reads only those embedded in a note.
 */
export function extractionPreview(plan: PlanReport): string[] {
  const { engine_first_boot: firstBoot, engine_after_extraction_off: later } = plan.review.env_keys;
  const keys = [...firstBoot, ...later];
  const vision = plan.models.vision_provider;
  const files = Object.entries(plan.vault?.inventory.non_markdown_by_extension ?? {})
    .map(([extension, files]) => [extension.toLowerCase(), files] as const);
  const filesOf = (extensions: readonly string[]) => files
    .filter(([extension]) => extensions.includes(extension))
    .reduce((sum, [, files]) => sum + files, 0);
  const lines = ['Engine can read the text in attachments embedded in your notes, so search and Curator can use it. Each attachment is a paid call to the provider below, made in the background as Engine finds it.'];

  if (vision !== 'off') {
    const label = vision === 'gemini' ? 'Gemini' : vision === 'claude' ? 'Claude' : 'your vision model';
    const visionModel = vision === 'model' ? planVisionModel(plan) : null;
    const images = filesOf(visionModel ? catalogImageExtensions(visionModel.provider) : IMAGE_EXTENSIONS[vision]);
    const perImage = imageCost(plan, vision);
    lines.push(`Images: ${count(images, 'file')}, read by ${label}${perImage && images > 0
      ? `, about ${dollars(100 * images * perImage[0])}–${dollars(100 * images * perImage[1])} in all`
      : ''}.`);
    // Engine sends scanned PDFs to a catalog vision model whose provider takes PDF
    // input (Anthropic, OpenAI), and to Gemini otherwise.
    const pdfs = count(filesOf(['.pdf']), 'file');
    const modelReadsPdfs = visionModel !== null && isModelProvider(visionModel.provider) && PROVIDERS[visionModel.provider].pdfInput;
    if (vision === 'claude') {
      lines.push(`PDFs: ${pdfs}. Text PDFs are read free; only scanned pages go to Claude, at about its image rate per page.`);
    } else if (modelReadsPdfs) {
      lines.push(`PDFs: ${pdfs}. Text PDFs are read free; only scanned pages go to your vision model, at about its image rate per page.`);
    } else if (vision === 'gemini' || keys.includes('GEMINI_API_KEY')) {
      lines.push(`PDFs: ${pdfs}. Text PDFs are read free; only scanned pages go to Gemini, at about its image rate per page.`);
    } else {
      lines.push(`PDFs: ${pdfs}. Text PDFs are read free; scanned PDFs are not read, because that needs a Gemini key.`);
    }
  }
  if (keys.includes('DEEPGRAM_API_KEY')) {
    const audio = filesOf(AUDIO_EXTENSIONS);
    const perMinute = audioPricingFor(AUDIO_MODEL);
    lines.push(`Audio: ${count(audio, 'file')}, transcribed by Deepgram${perMinute !== null && audio > 0
      ? `, about ${dollars(100 * audio * perMinute * AUDIO_MINUTES[0])}–${dollars(100 * audio * perMinute * AUDIO_MINUTES[1])} for ${AUDIO_MINUTES[0]}–${AUDIO_MINUTES[1]} minutes each`
      : ''}.`);
  }
  lines.push('Counts are every such file in the vault; Engine reads only those embedded in a note, once each.');
  return lines;
}

/** The catalog model the plan assigns to Engine's image vision, if any. */
function planVisionModel(plan: PlanReport): PlanReport['models']['models'][number] | null {
  const title = plan.models.roles.find(role => role.setting === 'engine.visionModel')?.model;
  return plan.models.models.find(model => model.title === title) ?? null;
}

/** The cost of one image, low and high, in USD; null without a price. */
function imageCost(plan: PlanReport, vision: 'gemini' | 'claude' | 'model'): [number, number] | null {
  let price: { input: number; output: number } | null;
  if (vision === 'model') {
    price = planVisionModel(plan);
  } else {
    price = pricingForExact(VISION_MODELS[vision]);
  }
  if (!price) return null;
  const cost = (input: number, output: number) => (input * price.input + output * price.output) / 1_000_000;
  return [cost(IMAGE_TOKENS.input[0], IMAGE_TOKENS.output[0]), cost(IMAGE_TOKENS.input[1], IMAGE_TOKENS.output[1])];
}
