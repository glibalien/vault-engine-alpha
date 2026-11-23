import { resolvePricing } from '@vault/pricing';
import {
  defaultsFor,
  descriptorsFor,
  effectiveSettings,
  FALLBACK_MODELS,
  modelProviderConflicts,
  resolveModelRef,
  seedFromEnv,
  SEED_MODELS,
  settingsNoteLabel,
  staleEnvVars,
  validateValue,
  vaultAliasFor,
  vaultSettingsFrom,
} from '@vault/settings-registry';
import type { CuratorSettings, ModelCatalogEntry, ModelProvider, VaultSettings } from '@vault/settings-registry';
import type { Issue } from '@vault/contract';
import type { BootstrapConfig, Config } from './config.js';
import type { SettingsDomainPayload, ModelsDomainPayload } from './engine.js';
import { Engine } from './engine.js';
import { loadBootstrapConfig } from './config.js';
import { parseCadence } from './cadence.js';
import {
  SPEC_A_SYSTEM_PROMPT, TOPIC_SYSTEM_PROMPT, TOPIC_WEB_SYSTEM_PROMPT,
  REQUESTED_PAGE_PROMPT, REQUESTED_PAGE_WEB_PROMPT,
} from './synthesize.js';
import { EXTRACT_SYSTEM_PROMPT } from './memory-sweep.js';
import { CONVERSATION_EXTRACT_SYSTEM_PROMPT } from './conversation-sweep.js';
import {
  CAPTURE_COMPOSER_SYSTEM_PROMPT,
  CAPTURE_COVERAGE_SYSTEM_PROMPT,
  CAPTURE_PLANNER_SYSTEM_PROMPT,
} from './conversation-capture-prompts.js';
import { TOPOLOGY_SYSTEM_PROMPT } from './prompts/topology.js';
import { ADJUDICATION_SYSTEM_PROMPT } from './prompts/adjudicate.js';
import { CURATOR_PAGE_SYSTEM_PROMPT } from './prompts/page.js';
import { BUILT_IN_DOSSIER_SECTIONS } from './dossier/sections.js';

export interface EngineSettingsApi {
  getSettings(domain?: string): Promise<{ settingsDir?: string; domains: Record<string, SettingsDomainPayload | ModelsDomainPayload> }>;
  updateSettings(domain: string, patch: Record<string, unknown>): Promise<{ warnings: Issue[] }>;
  registerPromptDefaults?(domain: string, defaults: Record<string, string>): Promise<{ warnings: Issue[] }>;
}

function promptOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

const CURATOR_PROMPT_DEFAULTS = {
  curatorProjectHomePrompt: SPEC_A_SYSTEM_PROMPT,
  curatorTopicPrompt: TOPIC_SYSTEM_PROMPT,
  curatorTopicWebPrompt: TOPIC_WEB_SYSTEM_PROMPT,
  curatorRequestedPagePrompt: REQUESTED_PAGE_PROMPT,
  curatorRequestedPageWebPrompt: REQUESTED_PAGE_WEB_PROMPT,
  curatorMemorySweepPrompt: EXTRACT_SYSTEM_PROMPT,
  curatorConversationSweepPrompt: CONVERSATION_EXTRACT_SYSTEM_PROMPT,
  curatorConversationCapturePlannerPrompt: CAPTURE_PLANNER_SYSTEM_PROMPT,
  curatorConversationCaptureCoveragePrompt: CAPTURE_COVERAGE_SYSTEM_PROMPT,
  curatorConversationCaptureComposerPrompt: CAPTURE_COMPOSER_SYSTEM_PROMPT,
  curatorTopologyPrompt: TOPOLOGY_SYSTEM_PROMPT,
  curatorCreateAdjudicationPrompt: ADJUDICATION_SYSTEM_PROMPT,
  curatorPagePrompt: CURATOR_PAGE_SYSTEM_PROMPT,
  dossierSections: BUILT_IN_DOSSIER_SECTIONS,
};

/**
 * Raw-id → catalog-ref seed translation (Phase 3 Task 9 controller-added
 * scope): on a fresh install whose engine models-migration one-shot already
 * fired, a custom env seed for any model-ref setting can contain a raw provider
 * id. The engine's
 * contextual resolver rejects a raw id outright (SETTINGS_MODEL_REF_UNRESOLVED)
 * since it isn't a catalog TITLE, so without this the default would silently
 * apply instead. Rewrite any model-ref key in `patch` whose raw string value
 * matches a catalog entry's `model` field into that entry's `[[Title]]` ref
 * before submitting. A value that already resolves (bracketed or bare title)
 * is left alone; an unmatched raw id is also left as-is — it will be dropped
 * server-side and reported by {@link CuratorSettingsClient.warnServerRejectedSeeds}.
 */
function translateRawModelIds(patch: Record<string, unknown>, catalog: ModelCatalogEntry[]): void {
  const modelRefKeys = descriptorsFor('curator').filter(d => d.type.kind === 'model-ref').map(d => d.key);
  for (const key of modelRefKeys) {
    const raw = patch[key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    if (resolveModelRef(catalog, raw)) continue; // already resolves as a ref — leave it
    const match = catalog.find(e => e.model === raw);
    if (match) patch[key] = `[[${match.title}]]`;
  }
}

const csv = (raw: string): string[] => raw.split(',').map(s => s.trim()).filter(Boolean);

/**
 * Env vars that seeded curator keys which now live in Engine's vault map (#444). They still
 * seed a never-seeded curator domain, as before: through the old key, which Engine writes to
 * the vault map.
 */
const VAULT_ENV_SEEDS: ReadonlyArray<{ var: string; key: string; parse: (raw: string) => unknown }> = [
  { var: 'CURATOR_ACTIVE_STATUSES', key: 'activeStatuses', parse: csv },
  { var: 'CURATOR_PROJECT_STATUS_FIELD', key: 'projectStatusField', parse: raw => raw },
];

/** The curator env vars that are set and seed a setting: the registry's, plus VAULT_ENV_SEEDS. */
function seededCuratorEnv(env: Record<string, string | undefined>): Array<{ var: string; key: string }> {
  return [
    ...staleEnvVars('curator', env),
    ...VAULT_ENV_SEEDS.filter(seed => (env[seed.var]?.trim() ?? '') !== '').map(seed => ({ var: seed.var, key: seed.key })),
  ];
}

/** VAULT_ENV_SEEDS values that are set and valid for their vault key, by old key. */
function vaultEnvSeeds(env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const seed of VAULT_ENV_SEEDS) {
    const raw = env[seed.var]?.trim();
    const vaultKey = vaultAliasFor('curator', seed.key)?.vaultKey;
    const descriptor = descriptorsFor('vault').find(d => d.key === vaultKey);
    if (!raw || !descriptor) continue;
    const value = seed.parse(raw);
    if (validateValue(descriptor, value) === null) out[seed.key] = value;
  }
  return out;
}
const DEFAULT_CADENCE_MS = 7 * 24 * 60 * 60 * 1000;
/** Last-resort fallback title when even the registry default ref dangles (a
 *  deleted/disabled Settings/Models note) — the same seed title `model`
 *  itself defaults to. */
const FALLBACK_TITLE = 'Claude Sonnet 4.6';

/** Single-slot dedup, repurposed from the old provider-mismatch warning: warns
 *  once per distinct dangling model-ref value. buildRuntimeConfig runs on
 *  every sweep/tool-call build, so this only suppresses a REPEAT warning for
 *  the same still-dangling value on the very next build — a different
 *  dangling value (or the same one resurfacing after another value warned in
 *  between) warns again. */
let warnedModel: string | null = null;

function normalizeVaultPathPrefix(raw: string): string | null {
  let value = raw.trim().replace(/\\/g, '/');
  if (value === '/' || value === '.' || value === './') return '.';
  value = value.replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
  return value || null;
}

function warnDangling(ref: string): void {
  if (warnedModel === ref) return;
  warnedModel = ref;
  console.warn(`[curator] model ref "${ref}" does not resolve to an enabled Settings/Models entry — falling back`);
}

/**
 * Resolve the HOME model-ref value to a raw provider id + provider, walking the
 * fallback chain: stored ref → catalog entry; dangling → the registry's `model`
 * default ref → catalog entry; still dangling → hardcoded `FALLBACK_MODELS` (the
 * user deleted/disabled every relevant Settings/Models note). Warns once per
 * distinct failing value; a value that resolves clears the warn-dedup slot so a
 * ref that dangles → gets fixed → dangles again re-warns (Fix 3b).
 */
function resolveModel(catalog: ModelCatalogEntry[], ref: string): { model: string; provider: ModelProvider } {
  const direct = resolveModelRef(catalog, ref);
  if (direct) { warnedModel = null; return { model: direct.model, provider: direct.provider }; }
  warnDangling(ref);
  const registryDefaultRef = defaultsFor('curator')['model'] as string;
  const fromDefault = resolveModelRef(catalog, registryDefaultRef);
  if (fromDefault) return { model: fromDefault.model, provider: fromDefault.provider };
  return FALLBACK_MODELS[FALLBACK_TITLE]!;
}

/**
 * Resolve a SWEEP model-ref (`memorySweepModel`/`orgSweepModel`). Unlike the home
 * model, a DANGLING sweep ref must NOT walk the home-DEFAULT chain (Fix 3): the
 * registry default `model` is `[[Claude Sonnet 4.6]]` (anthropic), so on a
 * Fireworks-only install a dangling sweep ref would provider-jump to Anthropic —
 * every nightly sweep call would then throw (no Anthropic key) or, if a key is
 * present, silently bill Claude pricing on bulk sweeps. The correct semantics:
 * `null` means "use the home model", so a dangling ref warns and falls back to
 * the ALREADY-RESOLVED home model (same id + provider) — exactly what a `null`
 * value produces at the call site. Resets the warn-dedup slot on success (Fix 3b).
 */
function resolveSweepModel(
  catalog: ModelCatalogEntry[], ref: string, home: { model: string; provider: ModelProvider },
): { model: string; provider: ModelProvider } {
  const direct = resolveModelRef(catalog, ref);
  if (direct) { warnedModel = null; return { model: direct.model, provider: direct.provider }; }
  warnDangling(ref);
  return home;
}

interface StrictModelResolution {
  model: string | null;
  provider: ModelProvider | null;
  error: string | null;
}

/** Resolve a required model-ref without any home/default/provider fallback. */
function resolveStrictModel(catalog: ModelCatalogEntry[], ref: string): StrictModelResolution {
  const resolved = resolveModelRef(catalog, ref);
  if (resolved) return { model: resolved.model, provider: resolved.provider, error: null };
  return {
    model: null,
    provider: null,
    error: 'Field guess model does not resolve to an enabled Settings/Models entry.',
  };
}

function registerModelProviderRoute(
  routes: Record<string, ModelProvider>,
  model: string,
  provider: ModelProvider,
): void {
  const existing = routes[model];
  if (existing !== undefined && existing !== provider) {
    throw new Error('Resolved model routes contain an ambiguous provider mapping.');
  }
  routes[model] = provider;
}

/**
 * Merge env-bootstrap with engine-fetched behavioral settings + model catalog
 * into the runtime Config shape the whole curation core consumes unchanged.
 * Every model-ref key (`model`, strict `fieldGuessModel`, and nullable sweep
 * overrides when not null) is resolved to a raw provider id here;
 * `modelProviders` collects resolved-id → provider for every entry that
 * resolved, so composition roots can route the dispatching LLM client and
 * usage reporter per call.
 */
export function buildRuntimeConfig(
  bootstrap: BootstrapConfig,
  s: CuratorSettings,
  catalog: ModelCatalogEntry[],
  options: { settingsDir?: string; vault?: VaultSettings } = {},
): Config {
  const vault = options.vault ?? (defaultsFor('vault') as unknown as VaultSettings);
  const topicLimits = [s.topicRequestMaxBytes, s.topicPageRequestMaxBytes, s.topicSourceExcerptMaxBytes];
  if (topicLimits.some(n => !Number.isSafeInteger(n) || n < 1)
    || s.topicSourceExcerptMaxBytes > Math.min(s.topicRequestMaxBytes, s.topicPageRequestMaxBytes)) {
    throw new Error('Invalid topic evidence request limits.');
  }
  if (modelProviderConflicts(catalog).length > 0) {
    throw new Error('Enabled model catalog contains an ambiguous provider mapping.');
  }
  const modelProviders: Record<string, ModelProvider> = {};

  const home = resolveModel(catalog, s.model);
  registerModelProviderRoute(modelProviders, home.model, home.provider);

  const fieldGuess = resolveStrictModel(catalog, s.fieldGuessModel);
  if (fieldGuess.model !== null && fieldGuess.provider !== null) {
    registerModelProviderRoute(modelProviders, fieldGuess.model, fieldGuess.provider);
  }

  const wikiStageModel = (ref: string | null): string | null => {
    if (ref === null) return null;
    const resolved = resolveSweepModel(catalog, ref, home);
    registerModelProviderRoute(modelProviders, resolved.model, resolved.provider);
    return resolved.model;
  };
  const wikiPlanningModel = wikiStageModel(s.wikiPlanningModel);
  const wikiPageModel = wikiStageModel(s.wikiPageModel);
  const wikiHomeModel = wikiStageModel(s.wikiHomeModel);

  let memorySweepModel: string | null = null;
  if (s.memorySweepModel !== null) {
    const resolved = resolveSweepModel(catalog, s.memorySweepModel, home);
    memorySweepModel = resolved.model;
    registerModelProviderRoute(modelProviders, resolved.model, resolved.provider);
  }

  let conversationSweepModel: string | null = null;
  if (s.conversationSweepModel !== null) {
    const resolved = resolveSweepModel(catalog, s.conversationSweepModel, home);
    conversationSweepModel = resolved.model;
    registerModelProviderRoute(modelProviders, resolved.model, resolved.provider);
  }

  let conversationCaptureModel: string | null = null;
  if (s.conversationCaptureModel !== null) {
    const resolved = resolveSweepModel(catalog, s.conversationCaptureModel, home);
    conversationCaptureModel = resolved.model;
    registerModelProviderRoute(modelProviders, resolved.model, resolved.provider);
  }

  let conversationCaptureCoverageModel: string | null = null;
  if (s.conversationCaptureCoverageModel !== null) {
    const resolved = resolveSweepModel(catalog, s.conversationCaptureCoverageModel, home);
    conversationCaptureCoverageModel = resolved.model;
    registerModelProviderRoute(modelProviders, resolved.model, resolved.provider);
  }

  let orgSweepModel: string | null = null;
  if (s.orgSweepModel !== null) {
    const resolved = resolveSweepModel(catalog, s.orgSweepModel, home);
    orgSweepModel = resolved.model;
    registerModelProviderRoute(modelProviders, resolved.model, resolved.provider);
  }

  let journalModel: string | null = null;
  if (s.journalModel !== null) {
    const resolved = resolveSweepModel(catalog, s.journalModel, home);
    journalModel = resolved.model;
    registerModelProviderRoute(modelProviders, resolved.model, resolved.provider);
  }

  let reconcileModel: string | null = null;
  if (s.reconcileModel !== null) {
    const resolved = resolveSweepModel(catalog, s.reconcileModel, home);
    reconcileModel = resolved.model;
    registerModelProviderRoute(modelProviders, resolved.model, resolved.provider);
  }

  let topicEarlyRefreshAssessmentModel: string | null = null;
  if (s.topicEarlyRefreshAssessmentModel !== null) {
    const resolved = resolveSweepModel(
      catalog,
      s.topicEarlyRefreshAssessmentModel,
      home,
    );
    topicEarlyRefreshAssessmentModel = resolved.model;
    registerModelProviderRoute(
      modelProviders,
      resolved.model,
      resolved.provider,
    );
  }

  const entryPricing = new Map(catalog.filter(entry => entry.enabled).map(entry => [entry.model, entry.pricing]));
  const modelPricing = Object.fromEntries(Object.keys(modelProviders)
    .map(model => [model, resolvePricing(model, entryPricing.get(model))]));

  return {
    ...bootstrap,
    model: home.model,
    fieldGuessModel: fieldGuess.model,
    fieldGuessModelError: fieldGuess.error,
    fieldGuessCap: s.fieldGuessCap,
    fieldGuessMaxTokens: s.fieldGuessMaxTokens,
    modelProviders,
    reasoningEffort: s.reasoningEffort.trim() || undefined,
    homeMaxTokens: s.homeMaxTokens,
    wikiPlanningMaxTokens: s.wikiPlanningMaxTokens,
    wikiPageMaxTokens: s.wikiPageMaxTokens,
    wikiHomeMaxTokens: s.wikiHomeMaxTokens,
    wikiPlanningReasoningEffort: s.wikiPlanningReasoningEffort,
    wikiPageReasoningEffort: s.wikiPageReasoningEffort,
    wikiHomeReasoningEffort: s.wikiHomeReasoningEffort,
    wikiPlanningReasoningBudget: s.wikiPlanningReasoningBudget,
    wikiPageReasoningBudget: s.wikiPageReasoningBudget,
    wikiHomeReasoningBudget: s.wikiHomeReasoningBudget,
    wikiPlanningModel,
    wikiPageModel,
    wikiHomeModel,
    wikiFailureHoldDays: s.wikiFailureHoldDays,
    wikiTaskOnlyRefreshDays: s.wikiTaskOnlyRefreshDays,
    settingsDir: options.settingsDir?.trim() || 'Settings',
    vault,
    projectType: vault.projectType,
    wikiDir: vault.wikiDir,
    topicDir: vault.topicDir,
    archetypeTotalCap: s.archetypeTotalCap,
    archetypeKindCap: s.archetypeKindCap,
    wikiPageCreatesPerRun: s.wikiPageCreatesPerRun,
    dailyBudgetCents: s.dailyBudgetCents,
    runDailyBudgetCents: s.runDailyBudgetCents,
    modelPricing,

    projectHomeProvenanceEnabled: s.projectHomeProvenanceEnabled,
    activeStatuses: vault.projectActiveStatuses,
    meetingReads: s.meetingReads,
    noteReads: s.noteReads,
    bodyCharCap: s.bodyCharCap,
    topicRequestMaxBytes: s.topicRequestMaxBytes,
    topicPageRequestMaxBytes: s.topicPageRequestMaxBytes,
    topicSourceExcerptMaxBytes: s.topicSourceExcerptMaxBytes,
    webSearchResults: s.webSearchResults,
    webFetchTop: s.webFetchTop,
    webFetchCharCap: s.webFetchCharCap,
    topicWebCadenceMs: parseCadence(s.topicWebCadence, DEFAULT_CADENCE_MS),
    topicEarlyRefreshEnabled: s.topicEarlyRefreshEnabled,
    topicEarlyRefreshAssessmentModel,
    topicEarlyRefreshAssessmentMaxTokens: s.topicEarlyRefreshAssessmentMaxTokens,
    topicEarlyRefreshAssessmentCap: s.topicEarlyRefreshAssessmentCap,
    semanticGapFill: s.semanticGapFill,
    semanticGapFillLimit: s.semanticGapFillLimit,
    semanticGapFillBodyReads: s.semanticGapFillBodyReads,
    staleProjectDays: s.staleProjectDays,
    staleProjectStatus: s.staleProjectStatus,
    staleSkipStatuses: s.staleSkipStatuses,
    projectStatusField: vault.projectStatusField,
    curatorTz: s.tz.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
    curatorSweepAt: s.sweepAt,
    wikiReconciliationMode: s.wikiReconciliationMode,
    memoryWriteEnabled: s.memoryWriteEnabled,
    memoryWriteCap: s.memoryWriteCap,
    memorySweepEnabled: s.memorySweepEnabled,
    memorySweepTypes: s.memorySweepTypes,
    memorySweepPaths: s.memorySweepPaths,
    memorySweepCap: s.memorySweepCap,
    memorySweepExtractionCap: s.memorySweepExtractionCap,
    memorySweepNoteCap: s.memorySweepNoteCap,
    memorySweepMaxTokens: s.memorySweepMaxTokens,
    memorySweepModel,
    conversationSweepEnabled: s.conversationSweepEnabled,
    conversationSweepSettleHours: s.conversationSweepSettleHours,
    conversationSweepMinUserChars: s.conversationSweepMinUserChars,
    conversationSweepCap: s.conversationSweepCap,
    conversationSweepPerConversationCap: s.conversationSweepPerConversationCap,
    conversationSweepMaxTokens: s.conversationSweepMaxTokens,
    conversationSweepModel,
    conversationCaptureMode: s.conversationCaptureMode,
    conversationCaptureSettleHours: s.conversationCaptureSettleHours,
    conversationCaptureInitialLookbackDays: s.conversationCaptureInitialLookbackDays,
    conversationCaptureMinAssistantChars: s.conversationCaptureMinAssistantChars,
    conversationCaptureEvaluationCap: s.conversationCaptureEvaluationCap,
    conversationCaptureArtifactCap: s.conversationCaptureArtifactCap,
    conversationCaptureWriteCap: s.conversationCaptureWriteCap,
    conversationCaptureModel,
    conversationCapturePlannerMaxTokens: s.conversationCapturePlannerMaxTokens,
    conversationCaptureCoverageModel,
    conversationCaptureCoverageMaxTokens: s.conversationCaptureCoverageMaxTokens,
    conversationCaptureComposerMaxTokens: s.conversationCaptureComposerMaxTokens,
    reverifyEnabled: s.reverifyEnabled,
    reconcileEnabled: s.reconcileEnabled,
    reconcilePairCap: s.reconcilePairCap,
    reconcileModel,
    orgSweepEnabled: s.orgSweepEnabled,
    orgTypePaths: s.orgTypePaths,
    orgTypeExcludePaths: [...new Set(
      [options.settingsDir?.trim() || 'Settings', ...(s.orgTypeExcludePaths ?? [])]
        .map(normalizeVaultPathPrefix)
        .filter((prefix): prefix is string => prefix !== null),
    )],
    orgMovePaths: s.orgMovePaths,
    orgMovePin: s.orgMovePin,
    orgTypeExclude: s.orgTypeExclude,
    orgTypeCap: s.orgTypeCap,
    orgMoveCap: s.orgMoveCap,
    orgSweepMaxTokens: s.orgSweepMaxTokens,
    orgSweepModel,
    linkSweepEnabled: s.linkSweepEnabled,
    linkSweepMode: s.linkSweepMode,
    linkSweepBacklog: s.linkSweepBacklog,
    linkSweepSchedule: s.linkSweepSchedule,
    linkSweepQuietMinutes: s.linkSweepQuietMinutes,
    linkSweepTargetTypes: s.linkSweepTargetTypes,
    linkSweepNoteCap: s.linkSweepNoteCap,
    journalEnabled: s.journalEnabled,
    journalModel,
    curatorProjectHomePrompt: promptOrDefault(s.curatorProjectHomePrompt, SPEC_A_SYSTEM_PROMPT),
    curatorTopicPrompt: promptOrDefault(s.curatorTopicPrompt, TOPIC_SYSTEM_PROMPT),
    curatorTopicWebPrompt: promptOrDefault(s.curatorTopicWebPrompt, TOPIC_WEB_SYSTEM_PROMPT),
    curatorRequestedPagePrompt: promptOrDefault(s.curatorRequestedPagePrompt, REQUESTED_PAGE_PROMPT),
    curatorRequestedPageWebPrompt: promptOrDefault(s.curatorRequestedPageWebPrompt, REQUESTED_PAGE_WEB_PROMPT),
    curatorMemorySweepPrompt: promptOrDefault(s.curatorMemorySweepPrompt, EXTRACT_SYSTEM_PROMPT),
    curatorConversationSweepPrompt: promptOrDefault(s.curatorConversationSweepPrompt, CONVERSATION_EXTRACT_SYSTEM_PROMPT),
    curatorConversationCapturePlannerPrompt: promptOrDefault(s.curatorConversationCapturePlannerPrompt, CAPTURE_PLANNER_SYSTEM_PROMPT),
    curatorConversationCaptureCoveragePrompt: promptOrDefault(s.curatorConversationCaptureCoveragePrompt, CAPTURE_COVERAGE_SYSTEM_PROMPT),
    curatorConversationCaptureComposerPrompt: promptOrDefault(s.curatorConversationCaptureComposerPrompt, CAPTURE_COMPOSER_SYSTEM_PROMPT),
    curatorTopologyPrompt: promptOrDefault(s.curatorTopologyPrompt, TOPOLOGY_SYSTEM_PROMPT),
    curatorCreateAdjudicationPrompt: promptOrDefault(s.curatorCreateAdjudicationPrompt, ADJUDICATION_SYSTEM_PROMPT),
    curatorPagePrompt: promptOrDefault(s.curatorPagePrompt, CURATOR_PAGE_SYSTEM_PROMPT),
    // As written, blank for the built-in lists: the dossier says which list it took (#716).
    dossierSections: typeof s.dossierSections === 'string' ? s.dossierSections : '',
    dossierBodyReads: s.dossierBodyReads,
  };
}

export class CuratorSettingsClient {
  private lastKnown: CuratorSettings;
  private lastKnownCatalog: ModelCatalogEntry[];
  private lastKnownSettingsDir = 'Settings';
  private lastKnownVault = defaultsFor('vault') as unknown as VaultSettings;
  /** True once a seed has actually reached the engine (this client's submit, or a fetch reporting seeded:true). Gates the stale-env wording. */
  private seedConfirmed = false;
  /** Guards against two overlapping seed attempts (seedIfNeeded racing effective()'s lazy path, or two concurrent effective() calls) submitting duplicate update-settings calls. */
  private seedInFlight = false;

  constructor(
    private readonly engine: EngineSettingsApi,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly log: (msg: string) => void = (m) => console.warn(m),
  ) {
    this.lastKnown = effectiveSettings<CuratorSettings>('curator', {});
    this.lastKnownCatalog = [...SEED_MODELS];
  }

  /**
   * Builds the env-derived seed patch (env ⊕ defined-but-empty ORG_MOVE
   * overrides, minus keys already in `d.stored`) and
   * submits it via update-settings. Caller must have already established
   * `d.seeded === false`; not throw-safe on its own — callers wrap it.
   */
  private async seedFromPayload(d: SettingsDomainPayload, catalog: ModelCatalogEntry[]): Promise<void> {
    const env = this.env as Record<string, string | undefined>;
    const patch = { ...seedFromEnv('curator', env), ...vaultEnvSeeds(env) };
    // Seed-drop delta logging (client-side half): must run BEFORE the
    // already-stored deletion below, against the raw seedFromEnv output —
    // otherwise a key dropped only because a file edit already stored it
    // would be misreported as a validation failure.
    this.warnSeedDrops(patch);
    // Unset-vs-empty semantics (config.ts): DEFINED-but-empty means an explicit
    // empty list ("move pass disabled" / "no pins"); seedFromEnv skips empties.
    if (env['CURATOR_ORG_MOVE_PATHS'] !== undefined) patch['orgMovePaths'] = csv(env['CURATOR_ORG_MOVE_PATHS'] ?? '');
    if (env['CURATOR_ORG_MOVE_PIN'] !== undefined) patch['orgMovePin'] = csv(env['CURATOR_ORG_MOVE_PIN'] ?? '');
    // Stored deviations (pre-boot file edits) beat env.
    for (const k of Object.keys(d.stored)) delete patch[k];
    // Raw-id → catalog-ref translation (controller-added scope) — see translateRawModelIds.
    translateRawModelIds(patch, catalog);
    const { warnings } = await this.engine.updateSettings('curator', patch);
    this.seedConfirmed = true;
    this.log(`[settings] seeded curator domain from env (${Object.keys(patch).length} keys)`);
    this.warnServerRejectedSeeds(patch, warnings);
  }

  /** Env vars set but whose value failed the registry's shape validation, so
   *  `seedFromEnv` silently excluded them from `patch` before it was even built. */
  private warnSeedDrops(patch: Record<string, unknown>): void {
    const env = this.env as Record<string, string | undefined>;
    for (const s of seededCuratorEnv(env)) {
      if (!(s.key in patch)) {
        this.log(`[settings] ${s.var} is set but its value failed validation and was NOT seeded — fix it or remove it`);
      }
    }
  }

  /** Keys that passed local shape validation and were submitted, but the
   *  engine's contextual validation (e.g. an unresolvable model-ref) rejected
   *  at write time — surfaced via the update-settings envelope's warnings. */
  private warnServerRejectedSeeds(submittedPatch: Record<string, unknown>, warnings: Issue[]): void {
    const descriptors = descriptorsFor('curator');
    for (const w of warnings) {
      const key = w.field;
      if (!key || !(key in submittedPatch)) continue;
      const envVar = descriptors.find(d => d.key === key)?.envSeed?.var ?? VAULT_ENV_SEEDS.find(seed => seed.key === key)?.var;
      if (envVar) this.log(`[settings] ${envVar} is set but its value failed validation and was NOT seeded — fix it or remove it`);
    }
  }

  /** One-shot service-side seeding (spec: the engine can't see this process's env). Throw-safe. */
  async seedIfNeeded(): Promise<void> {
    try {
      // Omit-domain: also returns the "models" pseudo-domain, needed at seed
      // time for the raw-id → catalog-ref translation below.
      const { domains } = await this.engine.getSettings();
      const d = domains['curator'] as SettingsDomainPayload | undefined;
      if (!d) return;
      const m = domains['models'] as ModelsDomainPayload | undefined;
      if (m) this.lastKnownCatalog = m.catalog as unknown as ModelCatalogEntry[];
      if (d.seeded) { this.seedConfirmed = true; return; }
      if (this.seedInFlight) return;
      this.seedInFlight = true;
      try {
        await this.seedFromPayload(d, this.lastKnownCatalog);
      } finally {
        this.seedInFlight = false;
      }
    } catch (err) {
      this.log(`[settings] curator seeding skipped (engine unreachable?): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  warnStaleEnv(): void {
    const env = this.env as Record<string, string | undefined>;
    // Until a seed is confirmed to have reached the engine, these vars are still
    // the ONLY record of the operator's intended values — don't tell them to
    // delete something that was never captured (the deploy-race the boot-once
    // seedIfNeeded() can miss; effective()'s lazy path closes it later).
    const advice = this.seedConfirmed
      ? 'Remove it from curator.env.'
      : 'It will seed the Curator settings once the engine is first reachable — keep it until seeding is confirmed.';
    for (const s of seededCuratorEnv(env)) {
      this.log(`[settings] ${s.var} is set but ignored — "${s.key}" is managed in ${settingsNoteLabel('curator', s.key)}. ${advice}`);
    }
    if (env['CURATOR_THEMED_PAGE_CAP']?.trim()) {
      this.log('[settings] CURATOR_THEMED_PAGE_CAP is dead — wiki page creation is uncapped.');
    }
    if (env['CURATOR_PROVIDER']?.trim()) {
      this.log(`[settings] CURATOR_PROVIDER is dead — provider now derives from the model's Settings/Models entry.`);
    }
  }

  async registerPromptDefaults(): Promise<void> {
    if (!this.engine.registerPromptDefaults) return;
    try {
      await this.engine.registerPromptDefaults('curator', CURATOR_PROMPT_DEFAULTS);
    } catch (err) {
      this.log(`[settings] curator prompt defaults registration skipped (engine unreachable?): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Fresh effective settings + model catalog in ONE engine round-trip (the
   * omit-domain `get-settings` call returns every settings domain plus the
   * read-only "models" pseudo-domain); engine failure serves the last-known
   * snapshot of both (registry defaults + `SEED_MODELS` before first success).
   * If the fetched curator payload reports `seeded === false` (the deploy-race
   * window where seedIfNeeded() ran before the engine's HTTP listener was up),
   * lazily seeds here instead — throw-safe, so a seeding hiccup never blocks
   * serving the values just fetched — then re-fetches once so the returned
   * settings reflect the seed.
   */
  async effectiveStrict(): Promise<EffectiveSettings> {
    const { domains, settingsDir } = await this.engine.getSettings();
    const d = domains['curator'] as SettingsDomainPayload | undefined;
    const m = domains['models'] as ModelsDomainPayload | undefined;
    if (!d || !m) throw new Error('SETTINGS_UNAVAILABLE');
    const settings = d.effective as unknown as CuratorSettings;
    const catalog = m.catalog as unknown as ModelCatalogEntry[];
    if (!resolveModelRef(catalog, settings.model)) throw new Error('MODEL_UNAVAILABLE');
    return { settings, catalog, settingsDir: settingsDir ?? this.lastKnownSettingsDir,
      vault: vaultFromPayload(domains) ?? this.lastKnownVault };
  }

  async effective(): Promise<EffectiveSettings> {
    try {
      const { domains, settingsDir } = await this.engine.getSettings();
      if (settingsDir?.trim()) this.lastKnownSettingsDir = settingsDir.trim();
      this.lastKnownVault = vaultFromPayload(domains) ?? this.lastKnownVault;
      const d = domains['curator'] as SettingsDomainPayload | undefined;
      const m = domains['models'] as ModelsDomainPayload | undefined;
      if (m) this.lastKnownCatalog = m.catalog as unknown as ModelCatalogEntry[];
      if (!d) return this.lastKnownSettings();
      this.lastKnown = d.effective as unknown as CuratorSettings;
      if (d.seeded) {
        this.seedConfirmed = true;
      } else if (!this.seedInFlight) {
        this.seedInFlight = true;
        try {
          await this.seedFromPayload(d, this.lastKnownCatalog);
          const refetchedDomains = (await this.engine.getSettings()).domains;
          const refetched = refetchedDomains['curator'] as SettingsDomainPayload | undefined;
          if (refetched) this.lastKnown = refetched.effective as unknown as CuratorSettings;
          // The seed may have written vault keys through their old curator names.
          this.lastKnownVault = vaultFromPayload(refetchedDomains) ?? this.lastKnownVault;
        } catch (err) {
          this.log(`[settings] lazy curator seeding failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          this.seedInFlight = false;
        }
      }
    } catch (err) {
      this.log(`[settings] fetch failed, using last-known: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.lastKnownSettings();
  }

  private lastKnownSettings(): EffectiveSettings {
    return { settings: this.lastKnown, catalog: this.lastKnownCatalog, settingsDir: this.lastKnownSettingsDir,
      vault: this.lastKnownVault };
  }
}

/** What a run's config is built from: Curator settings, the model catalog and Engine-side context. */
export interface EffectiveSettings {
  settings: CuratorSettings;
  catalog: ModelCatalogEntry[];
  settingsDir: string;
  /** Engine's vault map (Settings/Vault.md). */
  vault: VaultSettings;
}

/**
 * The vault map from a get-settings payload, or undefined when the payload reports neither
 * the vault domain nor the wiki domain an older Engine kept the names in (keep the last known).
 */
export function vaultFromPayload(domains: Record<string, unknown>): VaultSettings | undefined {
  return domains['vault'] === undefined && domains['wiki'] === undefined ? undefined : vaultSettingsFrom(domains);
}

/** Bootstrap + fetch + merge in one call — the entry seam for run.ts and the eval CLIs.
 *  The catalog rides along so CLIs can resolve ad-hoc model refs (e.g. eval --judge-model)
 *  through the same Settings/Models notes as the configured models. */
export async function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = (m) => console.warn(m),
): Promise<{ bootstrap: BootstrapConfig; config: Config; engine: Engine; catalog: ModelCatalogEntry[] }> {
  const bootstrap = loadBootstrapConfig(env);
  const engine = new Engine(bootstrap);
  const client = new CuratorSettingsClient(engine, env, log);
  await client.seedIfNeeded();
  await client.registerPromptDefaults();
  client.warnStaleEnv();
  const { settings, catalog, settingsDir, vault } = await client.effective();
  return { bootstrap, config: buildRuntimeConfig(bootstrap, settings, catalog, { settingsDir, vault }), engine, catalog };
}
