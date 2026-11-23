import { pricingForExact, type ModelPricing } from '@vault/pricing';
import { descriptorsFor, SEED_MODELS, type ModelProvider } from '@vault/settings-registry';
import type { CustomModelAnswer } from './answers.js';
import type { Prompter } from './prompter.js';
import { hasKey, MODEL_PROVIDERS, providerInfo, type ProviderKey } from './providers.js';
import { isTypeName, portableTypeKey } from './type-names.js';

/** The catalog providers the installer offers models for (it asks for these keys). */
export type InstallerModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface CatalogModel {
  title: string;
  provider: InstallerModelProvider;
  model: string;
  vision: boolean;
  /** Engine writes this model's catalog note on first boot; the others are added with add-model. */
  seeded: boolean;
  pricing: ModelPricing;
}

/** Engine's legacy rule: an unmarked seed note is vision-capable only if it is Qwen 3.7 Plus. */
const SEED_VISION_TITLE = 'Qwen 3.7 Plus';

/**
 * Priced models the presets use that Engine does not seed; adoption adds them with
 * add-model. Each needs an exact row in @vault/pricing, since the installer offers
 * only priced models.
 */
const ADDITIONS: ReadonlyArray<Omit<CatalogModel, 'seeded' | 'pricing'>> = [
  { title: 'DeepSeek V4 Flash', provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4-flash-0731', vision: false },
  { title: 'Minimax M3', provider: 'fireworks', model: 'accounts/fireworks/models/minimax-m3', vision: true },
  { title: 'GLM 5.2', provider: 'openrouter', model: 'z-ai/glm-5.2', vision: false },
  { title: 'MiMo-V2.5', provider: 'openrouter', model: 'xiaomi/mimo-v2.5', vision: true },
  { title: 'MiMo-V2.5-Pro', provider: 'openrouter', model: 'xiaomi/mimo-v2.5-pro', vision: false },
  { title: 'GPT-6.1 Terra', provider: 'openai', model: 'gpt-6.1-terra', vision: true },
  { title: 'GPT-6 Luna', provider: 'openai', model: 'gpt-6-luna', vision: true },
];

/**
 * The title add-model stores for a requested one (`sanitizeTitle` in Engine's add-model
 * tool), so a planned `[[title]]` reference names the note add-model creates.
 */
export function addModelTitle(title: string): string {
  return title.replace(/[\\/:#^|[\]]/g, '-').replace(/\s+/g, ' ').trim();
}

/**
 * Every model the installer can offer, before filtering by keys. Only models with an exact
 * list price are offered; a family estimate is not a price for a specific model.
 */
export function builtInModels(): CatalogModel[] {
  const offered = (provider: ModelProvider): provider is InstallerModelProvider =>
    (MODEL_PROVIDERS as readonly string[]).includes(provider);
  const seeded = SEED_MODELS.flatMap(entry => offered(entry.provider) ? [{
    title: entry.title,
    provider: entry.provider,
    model: entry.model,
    vision: entry.vision ?? entry.title === SEED_VISION_TITLE,
    seeded: true,
  }] : []);
  const added = ADDITIONS.map(entry => ({ ...entry, seeded: false }));
  return [...seeded, ...added].flatMap(entry => {
    const pricing = pricingForExact(entry.model);
    return pricing ? [{ ...entry, pricing }] : [];
  });
}

export type ModelDomain = 'engine' | 'chat' | 'curator';
const MODEL_DOMAINS: readonly ModelDomain[] = ['engine', 'chat', 'curator'];

export interface ModelRole {
  /** `domain.key`, as in the answers file. */
  id: string;
  domain: ModelDomain;
  key: string;
  label: string;
  nullable: boolean;
  /** What a preset fills it with; `inherit` leaves a nullable role on Curator's model. */
  tier: 'main' | 'light' | 'vision' | 'inherit';
  /** The custom preset asks about this role. */
  asked: boolean;
}

/** Roles the custom preset asks about, in the order it asks. */
const ASKED_ROLES: Readonly<Record<string, string>> = {
  'curator.model': 'Curator writing (project homes and pages)',
  'curator.wikiPlanningModel': 'Curator wiki planning',
  'curator.wikiHomeModel': 'Curator wiki home pages',
  'curator.wikiPageModel': 'Curator wiki sub-pages',
  'chat.defaultModel': 'Chat',
  'engine.memoryConsolidationModel': 'Engine memory consolidation',
  'engine.visionModel': 'Engine image vision',
};
export const ASKED_ROLE_ORDER: readonly string[] = Object.keys(ASKED_ROLES);
const MAIN_ROLES: ReadonlySet<string> = new Set(['curator.model', 'chat.defaultModel']);
const VISION_ROLE = 'engine.visionModel';

/** Every model setting in the registry, so new ones are covered without a list to update. */
export function modelRoles(): ModelRole[] {
  return MODEL_DOMAINS.flatMap(domain => descriptorsFor(domain).flatMap(descriptor => {
    if (descriptor.type.kind !== 'model-ref') return [];
    const id = `${domain}.${descriptor.key}`;
    const nullable = descriptor.type.nullable === true;
    const tier = id === VISION_ROLE ? 'vision' : MAIN_ROLES.has(id) ? 'main' : nullable ? 'inherit' : 'light';
    return [{ id, domain, key: descriptor.key, label: ASKED_ROLES[id] ?? id, nullable, tier, asked: id in ASKED_ROLES } satisfies ModelRole];
  }));
}

export type Preset = 'balanced' | 'low-cost' | 'custom';

/** Title preferences per preset; the first model whose provider has a key wins. */
// OpenAI comes last in each list, so it is the pick only when no other provider has a key.
const PREFERENCES: Record<Exclude<Preset, 'custom'>, { main: string[]; light: string[] }> = {
  balanced: {
    main: ['Claude Sonnet 4.6', 'GLM 5.2', 'Kimi K2.6', 'GPT-6.1 Terra'],
    light: ['GPT-OSS 120B', 'MiMo-V2.5', 'Claude Sonnet 4.6', 'GPT-6 Luna'],
  },
  'low-cost': {
    main: ['DeepSeek V4 Flash', 'MiMo-V2.5', 'Claude Sonnet 4.6', 'GPT-6 Luna'],
    light: ['GPT-OSS 120B', 'MiMo-V2.5', 'Claude Sonnet 4.6', 'GPT-6 Luna'],
  },
};
const VISION_PREFERENCE = ['Minimax M3', 'MiMo-V2.5', SEED_VISION_TITLE, 'GPT-6 Luna'];

export type VisionProvider = 'gemini' | 'claude' | 'model' | 'off';

export interface RoleAssignment {
  role: ModelRole;
  /** The model the setting points at; null leaves the setting as it is. */
  model: CatalogModel | null;
  /** Why the role does nothing on this install; null when it is in use. */
  off: string | null;
}

export interface ModelsPlan {
  preset: Preset;
  visionProvider: VisionProvider;
  /** Models the keys make usable, including any custom ones. */
  available: CatalogModel[];
  assignments: RoleAssignment[];
  /** Assigned models Engine does not seed; adoption adds them with add-model. */
  additions: CatalogModel[];
}

const INHERIT = '__inherit__';
const OTHER = '__other__';

/** Stage 4b: which model each role uses, and how images are read. */
export async function runModelsStage(input: {
  prompter: Prompter;
  keys: readonly ProviderKey[];
  curatorInstalled: boolean;
}): Promise<ModelsPlan> {
  const { prompter, keys } = input;
  const available = builtInModels().filter(model => hasKey(keys, model.provider));
  const roles = modelRoles();

  const visionProvider = await chooseVisionProvider(prompter, keys, available);
  const offReason = (role: ModelRole): string | null => roleOffReason(role, {
    curatorInstalled: input.curatorInstalled,
    visionProvider,
    keys,
  });

  const preset = available.length === 0 ? 'balanced' : await prompter.select<Preset>({
    id: 'models.preset',
    message: 'Which AI models should Vault use?',
    options: [
      { value: 'balanced', label: 'Balanced (recommended)', hint: describePreset('balanced', roles, available) },
      { value: 'low-cost', label: 'Low cost', hint: describePreset('low-cost', roles, available) },
      { value: 'custom', label: 'Let me choose', hint: 'pick a model for each job' },
    ],
    initialValue: 'balanced',
  });

  if (preset === 'custom') available.push(...await chooseCustomModels(prompter, keys, available));

  const defaults = new Map(roles.map(role => [role.id, presetChoice(role, preset === 'custom' ? 'balanced' : preset, available)]));
  const chosen = preset === 'custom'
    ? await chooseRoles(prompter, keys, roles, offReason, available, defaults)
    : new Map<string, CatalogModel | null>();

  const assignments = roles.map(role => {
    const off = offReason(role);
    if (off !== null) return { role, model: null, off };
    const model = chosen.has(role.id) ? chosen.get(role.id) ?? null : defaults.get(role.id) ?? null;
    if (model === null && role.tier !== 'inherit') {
      return { role, model: null, off: 'no usable model: needs an Anthropic, Fireworks, or OpenRouter key' };
    }
    return { role, model, off: null };
  });
  const additions = uniqueByTitle(assignments.flatMap(assignment =>
    assignment.model && !assignment.model.seeded ? [assignment.model] : []));
  return { preset, visionProvider, available, assignments, additions };
}

async function chooseVisionProvider(
  prompter: Prompter,
  keys: readonly ProviderKey[],
  available: readonly CatalogModel[],
): Promise<VisionProvider> {
  const visionModel = available.find(model => model.vision);
  const options: Array<{ value: VisionProvider; label: string; hint?: string }> = [
    ...(hasKey(keys, 'gemini') ? [{ value: 'gemini' as const, label: 'Gemini', hint: 'images and scanned PDFs' }] : []),
    ...(hasKey(keys, 'anthropic') ? [{ value: 'claude' as const, label: 'Claude', hint: 'images and scanned PDFs' }] : []),
    ...(visionModel ? [{
      value: 'model' as const,
      label: 'A catalog model',
      hint: `images, and scanned PDFs when its provider reads PDFs (Anthropic, OpenAI)${hasKey(keys, 'gemini') ? '; otherwise Gemini reads them' : '; otherwise they need a Gemini key'}`,
    }] : []),
    { value: 'off', label: 'Don\'t read them', hint: 'images and scanned PDFs are skipped' },
  ];
  if (options.length === 1 && prompter.interactive) return 'off';
  return prompter.select<VisionProvider>({
    id: 'models.vision_provider',
    message: 'Which AI should read the text in images and scanned PDFs? (You\'ll be asked again before it starts, since it costs money.)',
    options,
    initialValue: (options[0] as { value: VisionProvider }).value,
  });
}

function roleOffReason(
  role: ModelRole,
  context: { curatorInstalled: boolean; visionProvider: VisionProvider; keys: readonly ProviderKey[] },
): string | null {
  if (role.domain === 'curator' && !context.curatorInstalled) return 'Curator is not installed';
  if (role.id === VISION_ROLE && context.visionProvider !== 'model') {
    return context.visionProvider === 'off' ? 'image vision is off' : `images use ${context.visionProvider === 'gemini' ? 'Gemini' : 'Claude'}`;
  }
  if (role.domain === 'engine' && !MODEL_PROVIDERS.some(provider => hasKey(context.keys, provider))) {
    return 'needs a model provider key';
  }
  return null;
}

/** Models a role accepts: any provider's, and vision roles need vision. */
export function eligibleModels(role: ModelRole, available: readonly CatalogModel[]): CatalogModel[] {
  return available.filter(model => role.tier !== 'vision' || model.vision);
}

export function presetChoice(
  role: ModelRole,
  preset: Exclude<Preset, 'custom'>,
  available: readonly CatalogModel[],
): CatalogModel | null {
  if (role.tier === 'inherit') return null;
  const options = eligibleModels(role, available);
  const order = role.tier === 'vision' ? VISION_PREFERENCE : PREFERENCES[preset][role.tier];
  for (const title of order) {
    const model = options.find(option => option.title === title);
    if (model) return model;
  }
  return options[0] ?? null;
}

function describePreset(preset: Exclude<Preset, 'custom'>, roles: readonly ModelRole[], available: readonly CatalogModel[]): string {
  const main = roles.find(role => role.id === 'curator.model');
  const light = roles.find(role => role.tier === 'light' && role.domain !== 'engine');
  const titles = [main, light].flatMap(role => {
    const model = role ? presetChoice(role, preset, available) : null;
    return model ? [model.title] : [];
  });
  return titles.length > 0 ? [...new Set(titles)].join(' + ') : 'no model provider key';
}

async function chooseCustomModels(
  prompter: Prompter,
  keys: readonly ProviderKey[],
  available: readonly CatalogModel[],
): Promise<CatalogModel[]> {
  // Interactively, custom models are added from the role questions; headless runs list them.
  const answers = await prompter.decide<CustomModelAnswer[]>({
    id: 'models.custom_models',
    ask: async () => [],
    defaultValue: () => [],
  });
  const models: CatalogModel[] = [];
  for (const answer of answers) {
    const problem = customModelProblem(answer, keys, [...available, ...models]);
    if (problem) {
      prompter.rejectAnswer('models.custom_models', problem);
      continue;
    }
    models.push(customModel(answer));
  }
  return models;
}

/** Why a custom model cannot be offered, or null when it can. */
export function customModelProblem(
  answer: CustomModelAnswer,
  keys: readonly ProviderKey[],
  catalog: readonly CatalogModel[],
): string | null {
  const label = providerInfo(answer.provider).label;
  if (!hasKey(keys, answer.provider)) return `${answer.model} is served by ${label}, which has no key.`;
  const stored = addModelTitle(answer.title);
  if (stored !== answer.title) return `add-model would save "${answer.title}" as "${stored}"; use that title instead.`;
  if (!isTypeName(answer.title)) return `"${answer.title}" cannot be a catalog note title.`;
  // Engine writes every seed model's note on first start, whichever keys exist, and
  // add-model refuses a title or model id the catalog already has.
  const taken = [...SEED_MODELS, ...catalog];
  const sameTitle = taken.find(model => portableTypeKey(model.title) === portableTypeKey(answer.title));
  if (sameTitle) return `The catalog already has a model titled ${sameTitle.title}.`;
  const sameModel = taken.find(model => model.model === answer.model);
  if (sameModel) return `${answer.model} is already in the catalog as ${sameModel.title}.`;
  if (!pricingForExact(answer.model)) {
    return `No price is known for ${answer.model}. Curator's daily cap refuses unpriced models, so choose a listed model; after installing, add-model can add it with its provider's price.`;
  }
  return null;
}

function customModel(answer: CustomModelAnswer): CatalogModel {
  // Vision is unknown until add-model reads the provider's catalog, so it is not offered for images.
  return { ...answer, vision: false, seeded: false, pricing: pricingForExact(answer.model) as ModelPricing };
}

async function chooseRoles(
  prompter: Prompter,
  keys: readonly ProviderKey[],
  allRoles: readonly ModelRole[],
  offReason: (role: ModelRole) => string | null,
  available: CatalogModel[],
  defaults: ReadonlyMap<string, CatalogModel | null>,
): Promise<Map<string, CatalogModel | null>> {
  // Only roles in use with something to choose from are asked, Curator's writing model first.
  const roles = allRoles
    .filter(role => role.asked && offReason(role) === null && (role.nullable || eligibleModels(role, available).length > 0))
    .sort((left, right) => ASKED_ROLE_ORDER.indexOf(left.id) - ASKED_ROLE_ORDER.indexOf(right.id));
  const answer = await prompter.decide<Record<string, string | null>>({
    id: 'models.roles',
    ask: async () => {
      const picks: Record<string, string | null> = {};
      for (const role of roles) picks[role.id] = await askRole(prompter, keys, role, available, defaults.get(role.id) ?? null);
      return picks;
    },
    defaultValue: () => ({}),
  });

  const chosen = new Map<string, CatalogModel | null>();
  for (const [id, title] of Object.entries(answer)) {
    const role = roles.find(candidate => candidate.id === id);
    if (!role) {
      const known = allRoles.find(candidate => candidate.id === id && candidate.asked);
      if (known) prompter.warn(`Ignoring the model for ${id}: ${offReason(known) ?? 'nothing to choose from'}.`);
      else prompter.rejectAnswer('models.roles', `${id} is not a model role the custom preset asks about (${
        allRoles.filter(candidate => candidate.asked).map(candidate => candidate.id).join(', ')}).`);
      continue;
    }
    if (title === null) {
      if (!role.nullable) prompter.rejectAnswer('models.roles', `${id} needs a model.`);
      else chosen.set(id, null);
      continue;
    }
    const model = eligibleModels(role, available).find(candidate => candidate.title === title);
    if (!model) {
      prompter.rejectAnswer('models.roles', `${title} is not a model ${id} can use here (${
        eligibleModels(role, available).map(candidate => candidate.title).join(', ') || 'none'}).`);
      continue;
    }
    chosen.set(id, model);
  }
  return chosen;
}

async function askRole(
  prompter: Prompter,
  keys: readonly ProviderKey[],
  role: ModelRole,
  available: CatalogModel[],
  suggested: CatalogModel | null,
): Promise<string | null> {
  const canAddModel = role.tier !== 'vision' && MODEL_PROVIDERS.some(provider => hasKey(keys, provider));
  for (;;) {
    const options = [
      ...(role.nullable ? [{ value: INHERIT, label: 'Same as Curator writing' }] : []),
      ...eligibleModels(role, available).map(model => ({ value: model.title, label: model.title, hint: modelHint(model) })),
      ...(canAddModel ? [{ value: OTHER, label: 'Another model…', hint: 'a model id from a provider with a key' }] : []),
    ];
    const pick = await prompter.select<string>({
      id: 'models.roles',
      message: role.label,
      options,
      initialValue: role.nullable && role.tier === 'inherit' ? INHERIT : suggested?.title ?? (options[0] as { value: string }).value,
    });
    if (pick === INHERIT) return null;
    if (pick !== OTHER) return pick;
    const added = await askCustomModel(prompter, keys, available);
    if (added) {
      available.push(added);
      if (eligibleModels(role, [added]).length > 0) return added.title;
    }
  }
}

async function askCustomModel(
  prompter: Prompter,
  keys: readonly ProviderKey[],
  available: readonly CatalogModel[],
): Promise<CatalogModel | null> {
  const providers = MODEL_PROVIDERS.filter(provider => hasKey(keys, provider));
  const provider = await prompter.select<InstallerModelProvider>({
    id: 'models.custom_models',
    message: 'Which AI service offers this model?',
    options: providers.map(id => ({ value: id, label: providerInfo(id).label })),
    initialValue: providers[0] as InstallerModelProvider,
  });
  const model = (await prompter.text({
    id: 'models.custom_models',
    message: 'Model ID, exactly as the service lists it',
    placeholder: CUSTOM_MODEL_PLACEHOLDER[provider],
  })).trim();
  const title = (await prompter.text({
    id: 'models.custom_models',
    message: 'A short name for this model',
    defaultValue: addModelTitle(model.split('/').at(-1) ?? model),
  })).trim();
  const answer = { title, provider, model };
  const problem = customModelProblem(answer, keys, available);
  if (problem) {
    prompter.rejectAnswer('models.custom_models', problem);
    return null;
  }
  return customModel(answer);
}

const CUSTOM_MODEL_PLACEHOLDER: Record<InstallerModelProvider, string> = {
  anthropic: 'claude-…',
  fireworks: 'accounts/fireworks/models/…',
  openrouter: 'vendor/model',
  openai: 'gpt-…',
};

/** `$3.00 in / $15.00 out per million tokens`. */
export function modelHint(model: CatalogModel): string {
  const price = (usd: number) => `$${usd.toFixed(2)}`;
  return `${providerInfo(model.provider).label}, ${price(model.pricing.input)} in / ${price(model.pricing.output)} out per million tokens`;
}

function uniqueByTitle(models: CatalogModel[]): CatalogModel[] {
  return [...new Map(models.map(model => [model.title, model])).values()];
}
