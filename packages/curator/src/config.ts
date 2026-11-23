import type { ModelPricing } from '@vault/pricing';
import type { CuratorSettings, VaultSettings } from '@vault/settings-registry';
import 'dotenv/config';
import { resolve } from 'node:path';
import { defaultsFor, MODEL_PROVIDERS, PROVIDERS, type ModelProvider } from '@vault/settings-registry';
import { providerKeysFromEnv, type ProviderKeys } from '@vault/llm';

export type WikiReconciliationMode = 'off' | 'dry-run' | 'live';

/**
 * Per-call provider credentials (Phase 3 dispatching seam). Every key is
 * optional — a run only needs the key for whichever provider(s) the catalog
 * actually routes calls to; `createDispatchingLlmClient` throws loudly, per
 * call, if a routed provider's key is missing.
 */
export interface LlmKeys {
  /** API key per catalog provider, read from the provider table's env vars. */
  keys: ProviderKeys;
  /** Base URL overrides. Fireworks honours `OPENAI_COMPAT_BASE_URL`. */
  baseURLs: Partial<Record<ModelProvider, string>>;
}

/** Every key optional; warns (never throws) when NONE is set — the process may
 *  still be useful (e.g. typechecking, dry runs that never reach the LLM seam),
 *  but no LLM call will succeed until at least one is configured.
 *
 *  Curator's original Fireworks variables, `OPENAI_COMPAT_API_KEY` and
 *  `OPENAI_COMPAT_BASE_URL`, still work; when set, the key wins over
 *  `FIREWORKS_API_KEY` so existing deployments keep the key they use. */
/** The vault map a config carries, or the registry defaults when it carries none (tests). */
export function vaultOf(config: Pick<Config, 'vault'>): VaultSettings {
  return config.vault ?? (defaultsFor('vault') as unknown as VaultSettings);
}

/** The project kind: null when the vault map sets it to none; 'project' when the config predates the map. */
export function projectTypeOf(config: Pick<Config, 'projectType'>): string | null {
  return config.projectType === undefined ? 'project' : config.projectType;
}

/** The field a node's status is read from: the project status field for a note of the project
 *  kind, else the task status field. Null when that field is none. */
export function statusFieldFor(types: readonly string[], vault: VaultSettings): string | null {
  return vault.projectType !== null && types.includes(vault.projectType) ? vault.projectStatusField : vault.taskStatusField;
}

/** Every status field the vault map names, for reads that don't know the node's kind yet. */
export function statusFields(vault: VaultSettings): string[] {
  return [...new Set([vault.taskStatusField, vault.projectStatusField])].filter((name): name is string => name !== null);
}

/** A node's status as text (its `statusFieldFor` field; a `{ value }` envelope is unwrapped), or null. */
export function nodeStatus(fields: Record<string, unknown> | undefined, types: readonly string[], vault: VaultSettings): string | null {
  const name = statusFieldFor(types, vault);
  const raw = name === null ? undefined : fields?.[name];
  const value = raw !== null && typeof raw === 'object' && 'value' in raw ? (raw as { value: unknown }).value : raw;
  return typeof value === 'string' ? value : null;
}

export function loadLlmKeys(env: NodeJS.ProcessEnv = process.env): LlmKeys {
  const keys = providerKeysFromEnv(env);
  const legacyFireworksKey = env.OPENAI_COMPAT_API_KEY?.trim();
  if (legacyFireworksKey) keys.fireworks = legacyFireworksKey;
  const baseURLs: LlmKeys['baseURLs'] = {};
  const fireworksBaseUrl = env.OPENAI_COMPAT_BASE_URL?.trim().replace(/\/+$/, '');
  if (fireworksBaseUrl) baseURLs.fireworks = fireworksBaseUrl;
  if (Object.keys(keys).length === 0) {
    const names = MODEL_PROVIDERS.map(p => PROVIDERS[p].apiKeyEnv).join(', ');
    console.warn(`[curator] none of ${names} (or OPENAI_COMPAT_API_KEY) is set — every LLM call will fail until at least one provider key is configured`);
  }
  return { keys, baseURLs };
}

export interface BootstrapConfig {
  engineUrl: string;
  engineToken: string;
  /** Benchmark labels stamped onto every usage event this process reports. */
  experiment: string | null;
  variant: string | null;
  /** Per-call provider credentials — the dispatching LLM client picks the
   *  right one per routed model (see buildRuntimeConfig's modelProviders). */
  llmKeys: LlmKeys;
  // --- curator MCP server (step 2 foundation; required only on the server path) ---
  oauthOwnerPassword: string | undefined;
  oauthIssuerUrl: string | undefined;
  curatorPort: number;
  curatorDbPath: string;
  /** One-shot watermark override (ISO) for deliberate backfill; null = stored watermark. STAYS env. */
  memorySweepSince: string | null;
  /** One-shot watermark override (ISO) for a deliberate conversation backfill or
   *  post-flattener-fix re-sweep; null = stored watermark. STAYS env. */
  conversationSweepSince: string | null;
}

export interface Config extends BootstrapConfig {
  wikiPlanningMaxTokens: CuratorSettings['wikiPlanningMaxTokens'];
  wikiPageMaxTokens: CuratorSettings['wikiPageMaxTokens'];
  wikiHomeMaxTokens: CuratorSettings['wikiHomeMaxTokens'];
  wikiPlanningReasoningEffort: CuratorSettings['wikiPlanningReasoningEffort'];
  wikiPageReasoningEffort: CuratorSettings['wikiPageReasoningEffort'];
  wikiHomeReasoningEffort: CuratorSettings['wikiHomeReasoningEffort'];
  wikiPlanningReasoningBudget: CuratorSettings['wikiPlanningReasoningBudget'];
  wikiPageReasoningBudget: CuratorSettings['wikiPageReasoningBudget'];
  wikiHomeReasoningBudget: CuratorSettings['wikiHomeReasoningBudget'];
  /** Resolved per-stage wiki model ids; absent/null = use `model`. Each may route to a different provider. */
  wikiPlanningModel?: string | null;
  wikiPageModel?: string | null;
  wikiHomeModel?: string | null;
  /** Days a paid scheduled failure holds an unchanged wiki; absent = 7, 0 disables. */
  wikiFailureHoldDays?: number;
  /** Automatic sub-page caps; absent = uncapped. Requested pages are exempt. */
  archetypeTotalCap?: number;
  archetypeKindCap?: number;
  wikiPageCreatesPerRun?: number;
  /** Vault-relative settings folder (Engine-reported); excluded from semantic evidence. */
  settingsDir?: string;
  /**
   * The vault map (Engine's `vault` settings domain, Settings/Vault.md): the kinds, fields,
   * status values and folders Curator reads in notes. A kind or field that is null is none:
   * skip what depends on it. Absent (tests) = the registry defaults; read it with `vaultOf`.
   * The fields below that name vault keys are copied from it by buildRuntimeConfig.
   */
  vault?: VaultSettings;
  /** vault.projectType: the project kind; null = none (no project wikis); absent = 'project'. Read with `projectTypeOf`. */
  projectType?: string | null;
  /** vault.wikiDir: the wiki folder, where the journal note goes too; absent = 'Wikis'. */
  wikiDir?: string;
  /** vault.topicDir: folder for new topic notes; absent or null = the `topic` type's own folder (Topics/ when Curator creates it). */
  topicDir?: string | null;
  /** Days a project narrative may lag task-only evidence changes; absent = 7, 0 disables. */
  wikiTaskOnlyRefreshDays?: number;
  /** Hard daily spend cap in cents; absent/null = no cap. Applied at composition roots. */
  dailyBudgetCents?: number | null;
  /** The day's ceiling, in cents, for all on-demand runs together; absent/null = none, 0 = runs are off. */
  runDailyBudgetCents?: number | null;
  /** Pricing per resolved model id (catalog entry first, then the static table); null = unknown. */
  modelPricing?: Record<string, ModelPricing | null>;

  projectHomeProvenanceEnabled: boolean;
  /** Resolved raw provider model id (never a `[[ref]]`) — the catalog lookup
   *  already happened in buildRuntimeConfig. */
  model: string;
  /** Strictly resolved field-inference model; null when its non-null settings
   *  reference is dangling, deleted, disabled, or otherwise unresolvable. */
  fieldGuessModel: string | null;
  /** Explicit strict-resolution failure; null whenever fieldGuessModel resolves. */
  fieldGuessModelError: string | null;
  /** Maximum admitted field-guess call slots per full sweep; 0 disables the phase. */
  fieldGuessCap: number;
  /** max_tokens for one field-guess model call. */
  fieldGuessMaxTokens: number;
  /** Resolved-id → provider, for every model key that resolved this build
   *  (home model + strict field-guess model + any non-null sweep overrides).
   *  Composition roots use this to route both the dispatching LLM client and
   *  the usage reporter. */
  modelProviders: Record<string, ModelProvider>;
  /** Reasoning control sent as reasoning_effort (openai-compat provider only).
   *  undefined = omitted from requests. */
  reasoningEffort: string | undefined;
  /** max_tokens for the home synthesis call. Kimi-class models routinely need
   *  more than the Claude-tuned 4000 default (sections + themed pages). */
  homeMaxTokens: number;
  /** vault.projectActiveStatuses: the project statuses the sweep curates. */
  activeStatuses: string[];
  /** How many recent meeting bodies to read into the home synthesis. */
  meetingReads: number;
  /** How many of a project's notes a project wiki build reads in full (newest first, broad summaries last when covered; #474). */
  noteReads: number;
  /** Per-note body truncation cap (chars). null = unlimited (no truncation). */
  bodyCharCap: number | null;
  topicRequestMaxBytes: number;
  topicPageRequestMaxBytes: number;
  topicSourceExcerptMaxBytes: number;
  // --- web enrichment (Phase 3b; vault+web topic wikis) ---
  webSearchResults: number;
  webFetchTop: number;
  webFetchCharCap: number;
  topicWebCadenceMs: number;
  topicEarlyRefreshEnabled: boolean;
  /** Resolved early-refresh materiality model override; null uses `model` at the call site. */
  topicEarlyRefreshAssessmentModel: string | null;
  topicEarlyRefreshAssessmentMaxTokens: number;
  topicEarlyRefreshAssessmentCap: number;
  semanticGapFill: boolean;
  semanticGapFillLimit: number;
  semanticGapFillBodyReads: number;
  staleProjectDays: number;
  staleProjectStatus: string;
  staleSkipStatuses: string[];
  /** vault.projectStatusField; null = none: every project of the kind counts as active, and no status is written. */
  projectStatusField: string | null;
  curatorTz: string;
  curatorSweepAt: string;
  wikiReconciliationMode: WikiReconciliationMode;
  // --- curator memory write path (v1.5) ---
  /** Master switch for the curator persisting durable memories during synthesis. */
  memoryWriteEnabled: boolean;
  /** Max memories the curator may persist per curation run. */
  memoryWriteCap: number;
  // --- automatic memory collection (v1.6 memory sweep) ---
  /** Master switch — OPT-IN (default false; enable after a dry-run inspection). */
  memorySweepEnabled: boolean;
  /** Allowlisted node types to sweep (CSV env). Empty + empty paths = sweep inert. */
  memorySweepTypes: string[];
  /** Allowlisted path prefixes to sweep (CSV env). */
  memorySweepPaths: string[];
  /** Per-run persisted-fact cap, enforced at note granularity. */
  memorySweepCap: number;
  /** Per-run cap on extraction calls; unset uses SWEEP_EXTRACTION_CAP. */
  memorySweepExtractionCap?: number;
  /** Max facts extracted per note. */
  memorySweepNoteCap: number;
  /** max_tokens for one extraction call. Reasoning models (deepseek-class) burn
   *  thinking tokens before the tool call — 1000 truncated 18/30 notes in the
   *  first prod dry-run; 4000 mirrors the homeMaxTokens default. */
  memorySweepMaxTokens: number;
  /** Extraction model override; null = use `model`. */
  memorySweepModel: string | null;
  // --- conversation memory sweep ---
  /** Master switch — OPT-IN (default false; enable after a dry-run inspection). */
  conversationSweepEnabled: boolean;
  /** Quiet period before a conversation is considered settled; also the watermark lag. */
  conversationSweepSettleHours: number;
  /** Prose floor on USER text; below it a conversation is ledgered and skipped. */
  conversationSweepMinUserChars: number;
  /** Per-run persisted-fact cap, enforced at conversation granularity. */
  conversationSweepCap: number;
  /** Max facts extracted per conversation. */
  conversationSweepPerConversationCap: number;
  /** max_tokens for one extraction call. */
  conversationSweepMaxTokens: number;
  /** Extraction model override; null = use `model`. */
  conversationSweepModel: string | null;
  // --- conversation capture sweep ---
  /** Conservative rollout mode; preview does not mutate vault or capture state. */
  conversationCaptureMode: 'off' | 'preview' | 'live';
  /** Quiet period before a conversation is eligible for capture. */
  conversationCaptureSettleHours: number;
  /** First-run lookback window in days. */
  conversationCaptureInitialLookbackDays: number;
  /** Visible assistant-text floor for a capture candidate. */
  conversationCaptureMinAssistantChars: number;
  /** Maximum conversations evaluated in one capture run. */
  conversationCaptureEvaluationCap: number;
  /** Maximum artifacts accepted from one conversation. */
  conversationCaptureArtifactCap: number;
  /** Maximum destinations written in one capture run. */
  conversationCaptureWriteCap: number;
  /** Capture planner/composer model override; null = use `model`. */
  conversationCaptureModel: string | null;
  conversationCapturePlannerMaxTokens: number;
  /** Coverage-model override; null = capture model, then main model. */
  conversationCaptureCoverageModel: string | null;
  conversationCaptureCoverageMaxTokens: number;
  conversationCaptureComposerMaxTokens: number;
  // --- memories v3 automation (§4a re-verify + §4c reconciliation) ---
  /** §4a: expire sweep-extracted facts the model reports unsupported on a changed note. */
  reverifyEnabled: boolean;
  /** §4c master kill switch (live-apply via Settings/Curator/Memories.md). */
  reconcileEnabled: boolean;
  /** Max near-pairs adjudicated per nightly run. */
  reconcilePairCap: number;
  /** Verdict model override; null = use `model`. */
  reconcileModel: string | null;
  // --- organization sweep (misfiled + untyped nodes) ---
  /** Master switch — OPT-IN (default false; enable after a dry-run inspection). */
  orgSweepEnabled: boolean;
  /** Path prefixes eligible for LLM typing (CSV env). Empty = the whole vault. */
  orgTypePaths: string[];
  /** Path prefixes excluded from LLM typing. Always includes the settings folder
   *  designated by the Engine; configured exclusions are additive. */
  orgTypeExcludePaths: string[];
  /** Exact directories eligible for moves (CSV env; '/' = vault root).
   *  Env unset → root only; set-to-empty → move pass disabled. */
  orgMovePaths: string[];
  /** Exact file paths never moved. Env unset → ['CLAUDE.md']; set → as listed. */
  orgMovePin: string[];
  /** Type names the classifier may never assign (CSV env) — removed from the
   *  enum and prompt entirely, so constrained decoding cannot emit them.
   *  For machinery-owned types like wiki/transcript. Move-pass routing is
   *  unaffected: excluded types still route to their schema directory. */
  orgTypeExclude: string[];
  /** Max LLM classification calls per run. */
  orgTypeCap: number;
  /** Max moves per run. */
  orgMoveCap: number;
  /** max_tokens per classification call (reasoning models burn thinking tokens). */
  orgSweepMaxTokens: number;
  /** Classification model override; null = use `model`. */
  orgSweepModel: string | null;
  // --- link sweep (#332) ---
  /** Master switch, off by default. */
  linkSweepEnabled: boolean;
  /** 'report' = proposals go to the journal only; 'apply' = links to people and companies are also written. */
  linkSweepMode: 'report' | 'apply';
  /** 'fewest-links' = once the new notes are read, older unread notes, fewest links first (#697); 'off' = new notes only. */
  linkSweepBacklog: 'fewest-links' | 'off';
  /** 'daily' = a phase of the daily sweep; 'timer' = its own check every 30 minutes. */
  linkSweepSchedule: 'daily' | 'timer';
  /** A note edited within this many minutes waits for a later run. */
  linkSweepQuietMinutes: number;
  /** Kinds whose titles and aliases are looked for; empty = the vault map's project, person and company kinds. */
  linkSweepTargetTypes: string[];
  /** Most new notes read per run. */
  linkSweepNoteCap: number;
  // --- curator journal (narrative action log) ---
  /** Master switch for writing journal entries to the vault after every run. */
  journalEnabled: boolean;
  /** Lede model override; null = use `model`. */
  journalModel: string | null;
  curatorProjectHomePrompt: string;
  curatorTopicPrompt: string;
  curatorTopicWebPrompt: string;
  curatorRequestedPagePrompt: string;
  curatorRequestedPageWebPrompt: string;
  curatorMemorySweepPrompt: string;
  curatorConversationSweepPrompt: string;
  curatorConversationCapturePlannerPrompt: string;
  curatorConversationCaptureCoveragePrompt: string;
  curatorConversationCaptureComposerPrompt: string;
  curatorTopologyPrompt: string;
  curatorCreateAdjudicationPrompt: string;
  curatorPagePrompt: string;
  /** Dossier sections per kind (#716), as written; blank uses the built-in lists. */
  dossierSections?: string;
  /** Past meetings and notes a dossier reads in full (after #720's 8 made builds fail on production). */
  dossierBodyReads?: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var ${key} (see .env.example)`);
  }
  return value.trim();
}

function intOr(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number`);
  return Math.floor(n);
}

/** Optional ISO timestamp env; unset → null; unparseable → throw. */
function isoOrNull(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  if (Number.isNaN(Date.parse(raw))) throw new Error(`${key} must be an ISO timestamp; got "${raw}"`);
  return raw;
}

/**
 * The bootstrap-only subset of Config: what the process needs before it can
 * reach the engine at all (connection + provider credentials + server
 * plumbing). Everything behavioral now comes from the engine's `curator`
 * settings domain via `buildRuntimeConfig` (see src/settings.ts).
 */
export function loadBootstrapConfig(env: NodeJS.ProcessEnv = process.env): BootstrapConfig {
  return {
    engineUrl: required(env, 'ENGINE_URL').replace(/\/+$/, ''),
    engineToken: required(env, 'ENGINE_TOKEN'),
    experiment: env.CURATOR_EXPERIMENT?.trim() || null,
    variant: env.CURATOR_VARIANT?.trim() || null,
    llmKeys: loadLlmKeys(env),
    oauthOwnerPassword: env.OAUTH_OWNER_PASSWORD?.trim() || undefined,
    oauthIssuerUrl: env.OAUTH_ISSUER_URL?.trim() || undefined,
    curatorPort: intOr(env, 'CURATOR_PORT', 3335),
    curatorDbPath: env.CURATOR_DB_PATH?.trim() || resolve(process.cwd(), '.state/curator.db'),
    memorySweepSince: isoOrNull(env, 'CURATOR_MEMORY_SWEEP_SINCE'),
    conversationSweepSince: isoOrNull(env, 'CURATOR_CONVERSATION_SWEEP_SINCE'),
  };
}
