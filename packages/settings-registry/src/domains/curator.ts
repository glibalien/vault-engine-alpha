import type { SettingDescriptor } from '../types.js';

export interface CuratorSettings {
  wikiPlanningMaxTokens: number; wikiPageMaxTokens: number; wikiHomeMaxTokens: number;
  wikiPlanningReasoningEffort: 'inherit' | 'provider-default' | 'none' | 'low' | 'medium' | 'high';
  wikiPageReasoningEffort: CuratorSettings['wikiPlanningReasoningEffort'];
  wikiHomeReasoningEffort: CuratorSettings['wikiPlanningReasoningEffort'];
  wikiPlanningReasoningBudget: number; wikiPageReasoningBudget: number; wikiHomeReasoningBudget: number;
  wikiPlanningModel: string | null; wikiPageModel: string | null; wikiHomeModel: string | null;
  wikiFailureHoldDays: number;
  wikiTaskOnlyRefreshDays: number;
  dailyBudgetCents: number | null;
  runDailyBudgetCents: number | null;

  projectHomeProvenanceEnabled: boolean;
  model: string; homeMaxTokens: number; reasoningEffort: string;
  fieldGuessModel: string; fieldGuessCap: number; fieldGuessMaxTokens: number;
  meetingReads: number; noteReads: number;
  bodyCharCap: number | null;
  topicRequestMaxBytes: number;
  topicPageRequestMaxBytes: number;
  topicSourceExcerptMaxBytes: number;
  webSearchResults: number; webFetchTop: number; webFetchCharCap: number; topicWebCadence: string;
  topicEarlyRefreshEnabled: boolean; topicEarlyRefreshAssessmentModel: string | null;
  topicEarlyRefreshAssessmentMaxTokens: number; topicEarlyRefreshAssessmentCap: number;
  semanticGapFill: boolean; semanticGapFillLimit: number; semanticGapFillBodyReads: number;
  archetypeTotalCap: number; archetypeKindCap: number; wikiPageCreatesPerRun: number;
  staleProjectDays: number; staleProjectStatus: string; staleSkipStatuses: string[];
  sweepAt: string; wikiReconciliationMode: 'off' | 'dry-run' | 'live'; tz: string;
  memoryWriteEnabled: boolean; memoryWriteCap: number;
  memorySweepEnabled: boolean; memorySweepTypes: string[]; memorySweepPaths: string[];
  memorySweepCap: number; memorySweepExtractionCap: number; memorySweepNoteCap: number; memorySweepMaxTokens: number; memorySweepModel: string | null;
  conversationSweepEnabled: boolean; conversationSweepSettleHours: number; conversationSweepMinUserChars: number;
  conversationSweepCap: number; conversationSweepPerConversationCap: number;
  conversationSweepMaxTokens: number; conversationSweepModel: string | null;
  conversationCaptureMode: 'off' | 'preview' | 'live';
  conversationCaptureSettleHours: number; conversationCaptureInitialLookbackDays: number;
  conversationCaptureMinAssistantChars: number; conversationCaptureEvaluationCap: number;
  conversationCaptureArtifactCap: number; conversationCaptureWriteCap: number;
  conversationCaptureModel: string | null; conversationCapturePlannerMaxTokens: number;
  conversationCaptureCoverageModel: string | null; conversationCaptureCoverageMaxTokens: number;
  conversationCaptureComposerMaxTokens: number;
  reverifyEnabled: boolean; reconcileEnabled: boolean; reconcilePairCap: number; reconcileModel: string | null;
  orgSweepEnabled: boolean; orgTypePaths: string[]; orgTypeExcludePaths: string[]; orgMovePaths: string[]; orgMovePin: string[];
  orgTypeExclude: string[]; orgTypeCap: number; orgMoveCap: number; orgSweepMaxTokens: number; orgSweepModel: string | null;
  linkSweepEnabled: boolean; linkSweepMode: 'report' | 'apply'; linkSweepBacklog: 'fewest-links' | 'off'; linkSweepSchedule: 'daily' | 'timer'; linkSweepQuietMinutes: number;
  linkSweepTargetTypes: string[]; linkSweepNoteCap: number;
  journalEnabled: boolean; journalModel: string | null;
  curatorProjectHomePrompt: string; curatorTopicPrompt: string; curatorTopicWebPrompt: string;
  curatorRequestedPagePrompt: string; curatorRequestedPageWebPrompt: string; curatorMemorySweepPrompt: string;
  curatorConversationSweepPrompt: string; curatorTopologyPrompt: string;
  curatorCreateAdjudicationPrompt: string; curatorPagePrompt: string;
  curatorConversationCapturePlannerPrompt: string; curatorConversationCaptureCoveragePrompt: string;
  curatorConversationCaptureComposerPrompt: string;
  dossierSections: string;
  dossierBodyReads: number;
}

const csv = (raw: string): string[] => raw.split(',').map(s => s.trim()).filter(Boolean);
const int = (raw: string): unknown => { const n = parseInt(raw, 10); return Number.isFinite(n) ? n : raw; };
const notFalse = (raw: string): boolean => raw !== 'false';   // config.ts "!== 'false'" opt-out style
const isTrue = (raw: string): boolean => raw === 'true';      // config.ts "=== 'true'" opt-in style

const D = 'curator' as const;
const s = (key: string, dflt: string, envVar: string, description: string, nonEmpty = false): SettingDescriptor =>
  ({ key, domain: D, type: { kind: 'string', ...(nonEmpty ? { nonEmpty: true } : {}) }, default: dflt,
     reload: 'next-use', envSeed: { var: envVar }, description });
const n = (key: string, dflt: number, envVar: string, description: string): SettingDescriptor =>
  ({ key, domain: D, type: { kind: 'int', min: 1 }, default: dflt, reload: 'next-use',
     envSeed: { var: envVar, parse: int }, description });
const list = (key: string, dflt: string[], envVar: string, description: string): SettingDescriptor =>
  ({ key, domain: D, type: { kind: 'string-list' }, default: dflt, reload: 'next-use',
     envSeed: { var: envVar, parse: csv }, description });
const modelRef = (key: string, dflt: string, envVar: string, description: string): SettingDescriptor =>
  ({ key, domain: D, type: { kind: 'model-ref' }, default: dflt,
     reload: 'next-use', envSeed: { var: envVar }, description });
const nullModel = (key: string, envVar: string, description: string): SettingDescriptor =>
  ({ key, domain: D, type: { kind: 'model-ref', nullable: true }, default: null,
     reload: 'next-use', envSeed: { var: envVar }, description });
const text = (key: string, description: string): SettingDescriptor =>
  ({ key, domain: D, type: { kind: 'text' }, default: '', reload: 'next-use', description });

const captureDescriptors: SettingDescriptor[] = [
  { key: 'conversationCaptureMode', domain: D,
    type: { kind: 'enum', values: ['off', 'preview', 'live'] }, default: 'off', reload: 'next-use',
    description: 'Conversation capture rollout mode: off, exact preview, or automatic live writes.' },
  { key: 'conversationCaptureSettleHours', domain: D, type: { kind: 'int', min: 0 },
    default: 6, reload: 'next-use', description: 'Required quiet period in hours.' },
  { key: 'conversationCaptureInitialLookbackDays', domain: D, type: { kind: 'int', min: 0 },
    default: 7, reload: 'next-use', description: 'Rolling first-run lookback in days.' },
  { key: 'conversationCaptureMinAssistantChars', domain: D, type: { kind: 'int', min: 0 },
    default: 500, reload: 'next-use', description: 'Minimum visible assistant characters.' },
  { key: 'conversationCaptureEvaluationCap', domain: D, type: { kind: 'int', min: 1 },
    default: 10, reload: 'next-use', description: 'Maximum conversations planned per run.' },
  { key: 'conversationCaptureArtifactCap', domain: D, type: { kind: 'int', min: 1 },
    default: 3, reload: 'next-use', description: 'Maximum artifacts per conversation.' },
  { key: 'conversationCaptureWriteCap', domain: D, type: { kind: 'int', min: 1 },
    default: 5, reload: 'next-use', description: 'Maximum destination writes per run.' },
  { key: 'conversationCaptureModel', domain: D, type: { kind: 'model-ref', nullable: true },
    default: null, reload: 'next-use', description: 'Capture model override; null uses the main Curator model.' },
  { key: 'conversationCapturePlannerMaxTokens', domain: D, type: { kind: 'int', min: 256 },
    default: 4000, reload: 'next-use', description: 'Planner output-token budget.' },
  { key: 'conversationCaptureCoverageModel', domain: D, type: { kind: 'model-ref', nullable: true },
    default: null, reload: 'next-use',
    description: 'Coverage adjudication model override. null uses the capture model, then the main Curator model.' },
  { key: 'conversationCaptureCoverageMaxTokens', domain: D, type: { kind: 'int', min: 256 },
    default: 2000, reload: 'next-use',
    description: 'Maximum output tokens for one artifact coverage adjudication.' },
  { key: 'conversationCaptureComposerMaxTokens', domain: D, type: { kind: 'int', min: 256 },
    default: 6000, reload: 'next-use', description: 'Composer output-token budget.' },
  { key: 'curatorConversationCapturePlannerPrompt', domain: D, type: { kind: 'text' },
    default: '', reload: 'next-use', description: 'Planner system prompt override; blank uses the built-in prompt.' },
  { key: 'curatorConversationCaptureCoveragePrompt', domain: D, type: { kind: 'text' },
    default: '', reload: 'next-use',
    description: 'Coverage-adjudicator system prompt override; blank uses the built-in prompt.' },
  { key: 'curatorConversationCaptureComposerPrompt', domain: D, type: { kind: 'text' },
    default: '', reload: 'next-use', description: 'Composer system prompt override; blank uses the built-in prompt.' },
];

export const CURATOR_DESCRIPTORS: SettingDescriptor[] = [
  { key: 'wikiPlanningMaxTokens', domain: D, type: { kind: 'int', min: 0 }, default: 24000, reload: 'next-use', description: 'Wiki planning output cap per attempt, including reasoning; 0 inherits homeMaxTokens.' },
  { key: 'wikiPlanningReasoningEffort', domain: D, type: { kind: 'enum', values: ['inherit', 'provider-default', 'none', 'low', 'medium', 'high'] }, default: 'inherit', reload: 'next-use', description: 'Wiki planning reasoning: inherit the client setting, omit with provider-default, or request explicit effort on compatible providers (none turns thinking off). Some models ignore the level: Qwen 3.7 Plus on OpenRouter reasons the same at low and high, and honors only none.' },
  { key: 'wikiPlanningReasoningBudget', domain: D, type: { kind: 'int', min: 0 }, default: 0, reload: 'next-use', description: 'Most tokens a wiki planning call may spend reasoning, sent as reasoning.max_tokens; 0 sets no budget. OpenRouter models only, and it must be below the stage output cap so the answer has room. A budget replaces the reasoning effort, so leave wikiPlanningReasoningEffort at inherit or provider-default. Too small a budget cuts reasoning short and can hurt answers.' },
  { key: 'wikiPageMaxTokens', domain: D, type: { kind: 'int', min: 0 }, default: 32000, reload: 'next-use', description: 'Wiki page output cap per attempt, including reasoning; 0 inherits homeMaxTokens.' },
  { key: 'wikiPageReasoningEffort', domain: D, type: { kind: 'enum', values: ['inherit', 'provider-default', 'none', 'low', 'medium', 'high'] }, default: 'inherit', reload: 'next-use', description: 'Wiki page reasoning: inherit the client setting, omit with provider-default, or request explicit effort on compatible providers (none turns thinking off). Some models ignore the level: Qwen 3.7 Plus on OpenRouter reasons the same at low and high, and honors only none.' },
  { key: 'wikiPageReasoningBudget', domain: D, type: { kind: 'int', min: 0 }, default: 0, reload: 'next-use', description: 'Most tokens a wiki page call may spend reasoning, sent as reasoning.max_tokens; 0 sets no budget. OpenRouter models only, and it must be below the stage output cap so the answer has room. A budget replaces the reasoning effort, so leave wikiPageReasoningEffort at inherit or provider-default. Too small a budget cuts reasoning short and can hurt answers.' },
  { key: 'wikiHomeMaxTokens', domain: D, type: { kind: 'int', min: 0 }, default: 16000, reload: 'next-use', description: 'Wiki home output cap per attempt, including reasoning; 0 inherits homeMaxTokens.' },
  { key: 'wikiHomeReasoningEffort', domain: D, type: { kind: 'enum', values: ['inherit', 'provider-default', 'none', 'low', 'medium', 'high'] }, default: 'inherit', reload: 'next-use', description: 'Wiki home reasoning: inherit the client setting, omit with provider-default, or request explicit effort on compatible providers (none turns thinking off). Some models ignore the level: Qwen 3.7 Plus on OpenRouter reasons the same at low and high, and honors only none.' },
  { key: 'wikiHomeReasoningBudget', domain: D, type: { kind: 'int', min: 0 }, default: 0, reload: 'next-use', description: 'Most tokens a wiki home call may spend reasoning, sent as reasoning.max_tokens; 0 sets no budget. OpenRouter models only, and it must be below the stage output cap so the answer has room. A budget replaces the reasoning effort, so leave wikiHomeReasoningEffort at inherit or provider-default. Too small a budget cuts reasoning short and can hurt answers.' },
  { key: 'wikiPlanningModel', domain: D, type: { kind: 'model-ref', nullable: true }, default: null, reload: 'next-use', description: 'Wiki planning, repair and scope-adjudication model — a Settings/Models/ catalog reference on any provider. null = use model.' },
  { key: 'wikiPageModel', domain: D, type: { kind: 'model-ref', nullable: true }, default: null, reload: 'next-use', description: 'Wiki sub-page writing model — a Settings/Models/ catalog reference on any provider. null = use model.' },
  { key: 'dailyBudgetCents', domain: D, type: { kind: 'int', min: 1, nullable: true }, default: 100, reload: 'next-use', description: 'Hard daily cap on Curator model spend, in US cents, per local day (tz). A call is refused unless spend so far plus its worst case fits; models without pricing are refused while a cap is set. null removes the cap.' },
  { key: 'runDailyBudgetCents', domain: D, type: { kind: 'int', min: 0, nullable: true }, default: 500, reload: 'next-use', description: 'Most all on-demand runs together (fill-fields, type-notes) may spend in a local day (tz), in US cents. It is apart from dailyBudgetCents, which those runs do not use. A run states its own limit when it starts, and that limit must fit what is left of this ceiling that day. 0 turns on-demand runs off; null removes the ceiling.' },
  { key: 'wikiTaskOnlyRefreshDays', domain: D, type: { kind: 'int', min: 0 }, default: 7, reload: 'next-use', description: 'When only task evidence changed, re-render the project home\'s live task sections without model calls, and refresh the narrative only once it is at least this many days old. 0 refreshes the narrative on every task change.' },
  { key: 'wikiFailureHoldDays', domain: D, type: { kind: 'int', min: 0 }, default: 7, reload: 'next-use', description: 'Scheduled sweeps skip a wiki whose last run failed after paid model calls until its evidence or its wiki model, token cap, reasoning effort or reasoning budget changes, for at most this many days; manual and forced runs are not held. 0 disables.' },
  { key: 'wikiHomeModel', domain: D, type: { kind: 'model-ref', nullable: true }, default: null, reload: 'next-use', description: 'Wiki home writing model — a Settings/Models/ catalog reference on any provider. null = use model.' },

  modelRef('model', '[[Claude Sonnet 4.6]]', 'CURATOR_MODEL',
    'Home/page-creation synthesis model — a Settings/Models/ catalog reference ([[Model Note Title]]). Provider is derived from the referenced entry. Read at each run start.'),
  modelRef('fieldGuessModel', '[[GPT-OSS 120B]]', 'CURATOR_FIELD_GUESS_MODEL',
    'Model used to infer AI-guessable fields.'),
  { key: 'fieldGuessCap', domain: D, type: { kind: 'int', min: 0 }, default: 25, reload: 'next-use',
    envSeed: { var: 'CURATOR_FIELD_GUESS_CAP', parse: int },
    description: 'Maximum admitted field-guess call slots per full sweep; 0 disables the phase.' },
  n('fieldGuessMaxTokens', 2000, 'CURATOR_FIELD_GUESS_MAX_TOKENS',
    'Maximum output tokens for one field-guess model call.'),
  { key: 'projectHomeProvenanceEnabled', domain: D, type: { kind: 'bool' }, default: false, reload: 'next-use',
    description: 'Capture bounded project-home inputs before synthesis and require atomic output provenance. Enable only after Engine capability and retention review.' },
  n('homeMaxTokens', 4000, 'CURATOR_HOME_MAX_TOKENS',
    'Legacy output cap and fallback for wiki stage settings set to 0. Reasoning can consume the output allowance.'),
  s('reasoningEffort', '', 'CURATOR_REASONING_EFFORT',
    'Reasoning control sent as reasoning_effort (openai-compat provider only). Empty = omitted from requests. Not every model honors every level: Qwen 3.7 Plus on OpenRouter honors only "none" (thinking off) and reasons the same at low, medium and high. Thinking-by-default Fireworks models (Kimi-class) bill reasoning as completion tokens — set "none" for the curator\'s single-shot synthesis calls.'),
  n('meetingReads', 10, 'CURATOR_MEETING_READS',
    'How many recent meeting bodies to read into the home synthesis.'),
  n('noteReads', 6, 'CURATOR_NOTE_READS',
    'How many of a project\'s notes a project wiki build reads in full, newest first; a broad summary (filed under 3 or more projects) goes last when a project-specific note covers the same week. The planner names which of them each page reads.'),
  { key: 'topicRequestMaxBytes', domain: D, type: { kind: 'int', min: 1 }, default: 204800, reload: 'next-use',
    description: 'Complete topic planning and home request limit in UTF-8 bytes, including schema and instructions.' },
  { key: 'topicPageRequestMaxBytes', domain: D, type: { kind: 'int', min: 1 }, default: 98304, reload: 'next-use',
    description: 'Complete topic page request limit in UTF-8 bytes, including protected existing narrative.' },
  { key: 'topicSourceExcerptMaxBytes', domain: D, type: { kind: 'int', min: 1 }, default: 24576, reload: 'next-use',
    description: 'Maximum selected source text bytes per topic source per call; omitted material is disclosed.' },
  { key: 'bodyCharCap', domain: D, type: { kind: 'int', min: 1, nullable: true }, default: null, reload: 'next-use',
    envSeed: { var: 'CURATOR_BODY_CHAR_CAP', parse: int },
    description: 'Per-note body truncation cap (chars) when reading evidence. Empty/null = unlimited (no truncation).' },
  n('webSearchResults', 5, 'CURATOR_WEB_SEARCH_RESULTS',
    'Results requested from the engine\'s web-search per vault+web topic refresh.'),
  n('webFetchTop', 3, 'CURATOR_WEB_FETCH_TOP',
    'How many of those web results get fetched in full (fetch-url) for deeper text.'),
  n('webFetchCharCap', 4000, 'CURATOR_WEB_FETCH_CHAR_CAP',
    'Per-source truncation of fetched web text (chars).'),
  { key: 'topicWebCadence', domain: D, type: { kind: 'duration' }, default: '7d', reload: 'next-use',
    envSeed: { var: 'CURATOR_TOPIC_WEB_CADENCE' },
    description: 'Default refresh cadence for vault+web topic wikis, <amount><m|h|d|w> (e.g. 24h, 3d, 2w). Per-wiki overridable via create-or-update-wiki\'s cadence.' },
  {
    key: 'topicEarlyRefreshEnabled',
    domain: D,
    type: { kind: 'bool' },
    default: false,
    reload: 'next-use',
    description: 'Check committed vault and web evidence before topic cadence is due.',
  },
  {
    key: 'topicEarlyRefreshAssessmentModel',
    domain: D,
    type: { kind: 'model-ref', nullable: true },
    default: null,
    reload: 'next-use',
    description: 'Web materiality model override; null uses the main Curator model.',
  },
  {
    key: 'topicEarlyRefreshAssessmentMaxTokens',
    domain: D,
    type: { kind: 'int', min: 1 },
    default: 2000,
    reload: 'next-use',
    description: 'Maximum output tokens for one topic web materiality assessment.',
  },
  {
    key: 'topicEarlyRefreshAssessmentCap',
    domain: D,
    type: { kind: 'int', min: 1 },
    default: 5,
    reload: 'next-use',
    description: 'Maximum novel topic web assessments per scheduled sweep.',
  },
  { key: 'semanticGapFill', domain: D, type: { kind: 'bool' }, default: true, reload: 'next-use',
    envSeed: { var: 'CURATOR_SEMANTIC_GAP_FILL', parse: notFalse },
    description: 'Surface related-but-unlinked nodes as low-confidence leads in the home synthesis.' },
  n('semanticGapFillLimit', 15, 'CURATOR_SEMANTIC_GAP_FILL_LIMIT',
    'Max gap-fill candidates surfaced per project (after dedup against linked nodes).'),
  n('semanticGapFillBodyReads', 3, 'CURATOR_SEMANTIC_GAP_FILL_BODY_READS',
    'How many top gap-fill candidates get a bounded body read (the rest are title/type/status only).'),
  { key: 'archetypeTotalCap', domain: D, type: { kind: 'int', min: 1 }, default: 6, reload: 'next-use',
    description: 'Most active sub-pages a wiki may reach through automatic creation; requested pages are exempt.' },
  { key: 'archetypeKindCap', domain: D, type: { kind: 'int', min: 1 }, default: 2, reload: 'next-use',
    description: 'Most active sub-pages of one kind a wiki may reach through automatic creation; requested pages are exempt.' },
  { key: 'wikiPageCreatesPerRun', domain: D, type: { kind: 'int', min: 0 }, default: 3, reload: 'next-use',
    description: 'Most sub-pages one curation may create automatically; later runs can add more. 0 stops automatic creation.' },
  n('staleProjectDays', 14, 'CURATOR_STALE_PROJECT_DAYS',
    'Auto-set a project\'s status when its wiki is older than this many days.'),
  s('staleProjectStatus', 'backlog', 'CURATOR_STALE_PROJECT_STATUS',
    'Status value the staleness nudge sets on stale projects. Empty ("") turns the nudge off: no project status is changed.'),
  list('staleSkipStatuses', ['backlog', 'done', 'dropped'], 'CURATOR_STALE_SKIP_STATUSES',
    'Statuses that are never auto-backlogged by the staleness nudge.'),
  { key: 'sweepAt', domain: D, type: { kind: 'hhmm' }, default: '05:00', reload: 're-arm',
    envSeed: { var: 'CURATOR_SWEEP_AT' },
    description: 'Local wall-clock time of the daily sweep, HH:MM 24h (DST-correct). Takes effect after the NEXT sweep completes or on curator restart — the armed timer is not re-read between runs.' },
  { key: 'wikiReconciliationMode', domain: D,
    type: { kind: 'enum', values: ['off', 'dry-run', 'live'] },
    default: 'off', reload: 'next-use',
    description: 'Scheduled project/topic wiki reconciliation mode. off skips wiki work; dry-run plans and previews without committing; live permits scheduled wiki writes.' },
  { key: 'tz', domain: D, type: { kind: 'timezone' }, default: '', reload: 're-arm',
    envSeed: { var: 'CURATOR_TZ' },
    description: 'IANA timezone for the daily sweep. Empty = the curator host\'s system zone. Takes effect after the NEXT sweep completes or on curator restart. The zone also sets the day the daily budget counts and every date written for you or told to a model, each from its next run: in the Curator, journal headings, wiki Log stamps, evidence dates, conversation-capture dates and fallback titles, and the "Today is" line; in the Engine (empty = the Engine host\'s zone), the wiki "today" that makes a task overdue and starts the upcomingDays window, retirement dates, {date} in filename templates, and memory consolidation\'s "Today is" line.' },
  { key: 'memoryWriteEnabled', domain: D, type: { kind: 'bool' }, default: true, reload: 'next-use',
    envSeed: { var: 'CURATOR_MEMORY_WRITE_ENABLED', parse: notFalse },
    description: 'Master switch for the curator persisting durable memories it learns during synthesis (source=curator).' },
  n('memoryWriteCap', 3, 'CURATOR_MEMORY_WRITE_CAP',
    'Max memories the curator may persist per curation run.'),
  { key: 'memorySweepEnabled', domain: D, type: { kind: 'bool' }, default: false, reload: 'next-use',
    envSeed: { var: 'CURATOR_MEMORY_SWEEP_ENABLED', parse: isTrue },
    description: 'v1.6 automatic memory collection — OPT-IN master switch (enable only after inspecting a dry run).' },
  list('memorySweepTypes', [], 'CURATOR_MEMORY_SWEEP_TYPES',
    'Allowlisted node types for the memory sweep. Both this and memorySweepPaths empty = sweep inert.'),
  list('memorySweepPaths', [], 'CURATOR_MEMORY_SWEEP_PATHS',
    'Allowlisted path prefixes for the memory sweep.'),
  n('memorySweepCap', 10, 'CURATOR_MEMORY_SWEEP_CAP',
    'Per-run cap on persisted facts. Note-granular: a note that would exceed it is deferred whole to the next run.'),
  { key: 'memorySweepExtractionCap', domain: D, type: { kind: 'int', min: 1 }, default: 50, reload: 'next-use',
    description: 'Per-run cap on extraction calls, one per changed note. Notes arrive newest first, so a backlog drains over several runs; raise it to clear a backlog in one run.' },
  n('memorySweepNoteCap', 3, 'CURATOR_MEMORY_SWEEP_NOTE_CAP',
    'Max facts extracted per note.'),
  n('memorySweepMaxTokens', 4000, 'CURATOR_MEMORY_SWEEP_MAX_TOKENS',
    'max_tokens per extraction call. Reasoning models spend thinking tokens before the tool call — too low truncates extraction.'),
  nullModel('memorySweepModel', 'CURATOR_MEMORY_SWEEP_MODEL',
    'Extraction model override for the memory sweep — a Settings/Models/ catalog reference. null = use model.'),
  { key: 'conversationSweepEnabled', domain: D, type: { kind: 'bool' }, default: false, reload: 'next-use',
    envSeed: { var: 'CURATOR_CONVERSATION_SWEEP_ENABLED', parse: isTrue },
    description: 'Conversation memory sweep — OPT-IN master switch (enable only after inspecting a dry run). Extracts durable user-asserted facts from settled VEfO conversations.' },
  n('conversationSweepSettleHours', 6, 'CURATOR_CONVERSATION_SWEEP_SETTLE_HOURS',
    'A conversation is swept only once untouched this many hours. Also the watermark lag — the watermark advances to sweepStart minus this, so unsettled conversations stay in the next run\'s window.'),
  { key: 'conversationSweepMinUserChars', domain: D, type: { kind: 'int', min: 0 }, default: 300, reload: 'next-use',
    envSeed: { var: 'CURATOR_CONVERSATION_SWEEP_MIN_USER_CHARS', parse: int },
    description: 'Prose floor: conversations with less USER text than this are ledgered and skipped with no LLM call. Measured at 300 filtering ~88% of the live corpus.' },
  n('conversationSweepCap', 5, 'CURATOR_CONVERSATION_SWEEP_CAP',
    'Per-run cap on persisted facts. Conversation-granular: a conversation that would exceed it is deferred whole. Separate from memorySweepCap so a busy chat night cannot starve the note sweep.'),
  n('conversationSweepPerConversationCap', 2, 'CURATOR_CONVERSATION_SWEEP_PER_CONVERSATION_CAP',
    'Max facts extracted per conversation.'),
  n('conversationSweepMaxTokens', 4000, 'CURATOR_CONVERSATION_SWEEP_MAX_TOKENS',
    'max_tokens per extraction call. Reasoning models spend thinking tokens before the tool call — too low truncates extraction.'),
  nullModel('conversationSweepModel', 'CURATOR_CONVERSATION_SWEEP_MODEL',
    'Extraction model override for the conversation sweep — a Settings/Models/ catalog reference. null = use model.'),
  ...captureDescriptors,
  { key: 'reverifyEnabled', domain: D, type: { kind: 'bool' }, default: true, reload: 'next-use',
    description: 'Memories v3 §4a: when the memory or conversation sweep re-processes changed source content, previously extracted facts the model reports unsupported are expired (reason evidence-changed). Also implicitly gated by memorySweepEnabled and conversationSweepEnabled.' },
  { key: 'reconcileEnabled', domain: D, type: { kind: 'bool' }, default: true, reload: 'next-use',
    description: 'Memories v3 §4c: nightly cross-source memory reconciliation (duplicate/contradiction adjudication over embedding near-pairs). THE kill switch — set false to halt the reconciler without a deploy.' },
  { key: 'reconcilePairCap', domain: D, type: { kind: 'int', min: 1 }, default: 10, reload: 'next-use',
    description: 'Max near-pairs adjudicated per nightly reconciliation run (cost + blast-radius bound; the backlog drain lever).' },
  { key: 'reconcileModel', domain: D, type: { kind: 'model-ref', nullable: true }, default: null, reload: 'next-use',
    description: 'Verdict model override for reconciliation — a Settings/Models/ catalog reference. null = use model.' },
  { key: 'orgSweepEnabled', domain: D, type: { kind: 'bool' }, default: false, reload: 'next-use',
    envSeed: { var: 'CURATOR_ORG_SWEEP_ENABLED', parse: isTrue },
    description: 'Organization sweep (typing untyped nodes + re-filing misfiled ones) — OPT-IN master switch (enable only after inspecting a dry run).' },
  list('orgTypePaths', [], 'CURATOR_ORG_TYPE_PATHS',
    'Path prefixes eligible for LLM typing. Empty = the whole vault.'),
  { key: 'orgTypeExcludePaths', domain: D, type: { kind: 'string-list' }, default: [], reload: 'next-use',
    description: 'Additional path prefixes excluded from LLM typing. The Engine-designated settings folder is always added automatically.' },
  list('orgMovePaths', ['/'], 'CURATOR_ORG_MOVE_PATHS',
    'Exact directories eligible for moves ("/" = vault root, non-recursive). Empty list = move pass disabled.'),
  list('orgMovePin', ['CLAUDE.md'], 'CURATOR_ORG_MOVE_PIN',
    'Exact file paths never moved. Empty list = no pins.'),
  list('orgTypeExclude', [], 'CURATOR_ORG_TYPE_EXCLUDE',
    'Type names the classifier may never assign — removed from its enum entirely. For machinery-owned types (wiki, transcript); move-pass routing is unaffected.'),
  n('orgTypeCap', 25, 'CURATOR_ORG_TYPE_CAP',
    'Max LLM classification calls per run (cost bound for the untyped backlog drain).'),
  n('orgMoveCap', 25, 'CURATOR_ORG_MOVE_CAP',
    'Max file moves per run.'),
  n('orgSweepMaxTokens', 4000, 'CURATOR_ORG_SWEEP_MAX_TOKENS',
    'max_tokens per classification call (reasoning models need headroom).'),
  nullModel('orgSweepModel', 'CURATOR_ORG_SWEEP_MODEL',
    'Classification model override for the org sweep — a Settings/Models/ catalog reference. null = use model.'),
  { key: 'linkSweepEnabled', domain: D, type: { kind: 'bool' }, default: false, reload: 'next-use',
    description: 'Link sweep (#332): read notes created since the last run, then older notes (linkSweepBacklog), and find the plain-text mentions of people, companies and projects that could become links. linkSweepMode decides whether it only lists them in the Curator Journal or also adds some. Off by default.' },
  { key: 'linkSweepMode', domain: D, type: { kind: 'enum', values: ['report', 'apply'] }, default: 'report', reload: 'next-use',
    description: 'What the link sweep does with the links it finds. report = list them in the Curator Journal and change no note. apply = also add the links to people (by a name of two or more words) and companies (by their name or an alias, letter case as written), each listed in the journal with its undo, and go back over the notes an earlier report-only run read. Other links (projects, a company in other letter case) are still only listed.' },
  { key: 'linkSweepBacklog', domain: D, type: { kind: 'enum', values: ['fewest-links', 'off'] }, default: 'fewest-links', reload: 'next-use',
    description: 'What the link sweep reads once the new notes are read and the cap has room left (#697). fewest-links = the notes it has never read, those with the fewest links first (links in and out together, fields included, so a note no other note links to and that links to none comes first), newest first among notes with the same count. off = new notes only. A note is read once either way.' },
  { key: 'linkSweepSchedule', domain: D, type: { kind: 'enum', values: ['daily', 'timer'] }, default: 'daily', reload: 'next-use',
    description: 'When the link sweep runs: daily = in the daily sweep; timer = every 30 minutes through the day, each run that finds something writing its own short journal entry.' },
  { key: 'linkSweepQuietMinutes', domain: D, type: { kind: 'int', min: 0 }, default: 30, reload: 'next-use',
    description: 'The link sweep leaves a note edited within this many minutes for a later run, so it never reads a note you are still writing. 0 = no wait.' },
  { key: 'linkSweepTargetTypes', domain: D, type: { kind: 'string-list' }, default: [], reload: 'next-use',
    description: 'Kinds of notes whose titles and aliases the link sweep looks for. Empty = the project, person and company kinds in Settings/Vault.md.' },
  { key: 'linkSweepNoteCap', domain: D, type: { kind: 'int', min: 1 }, default: 50, reload: 'next-use',
    description: 'Most notes the link sweep reads per run, new ones first; the rest wait for the next run.' },
  { key: 'journalEnabled', domain: D, type: { kind: 'bool' }, default: true, reload: 'next-use',
    envSeed: { var: 'CURATOR_JOURNAL_ENABLED', parse: notFalse },
    description: 'Write a Curator Journal entry (Curator Journal — YYYY-MM, in the wiki folder: wikiDir in Settings/Vault.md) after every run — the narrative action log. Off = actions still land in the curator DB, but no vault note is written.' },
  nullModel('journalModel', 'CURATOR_JOURNAL_MODEL',
    'Journal lede model override — a Settings/Models/ catalog reference. null = use model.'),
  text('curatorProjectHomePrompt',
    'Override for the curator project home synthesis system prompt. Leave blank to use the built-in prompt registered by the curator.'),
  text('curatorTopicPrompt',
    'Override for the curator vault-only topic wiki synthesis system prompt. Leave blank to use the built-in prompt.'),
  text('curatorTopicWebPrompt',
    'Override for the curator vault-plus-web topic wiki synthesis system prompt. Leave blank to use the built-in prompt.'),
  text('curatorRequestedPagePrompt',
    'Override for the curator requested-page synthesis system prompt. Leave blank to use the built-in prompt.'),
  text('curatorRequestedPageWebPrompt',
    'Override for the curator requested-page vault-plus-web synthesis system prompt. Leave blank to use the built-in prompt.'),
  text('curatorMemorySweepPrompt',
    'Override for the curator memory-sweep extraction system prompt. Leave blank to use the built-in prompt.'),
  text('curatorConversationSweepPrompt',
    'System prompt override for the conversation memory sweep. Blank = the built-in default.'),
  text('curatorTopologyPrompt',
    'Override for semantic wiki topology planning. Leave blank to use the built-in prompt.'),
  text('curatorCreateAdjudicationPrompt',
    'Override for complete-catalog create adjudication. Leave blank to use the built-in prompt.'),
  text('curatorPagePrompt',
    'Override for accepted wiki page synthesis. Leave blank to use the built-in prompt.'),
  { key: 'dossierBodyReads', domain: D, type: { kind: 'int', min: 0, max: 16 }, default: 8, reload: 'next-use',
    description: 'How many of the newest past meetings and notes linking to a dossier\'s subject are read in full (each cut at 4,000 characters). 0 reads none: they are still listed by title.' },
  text('dossierSections',
    'Dossier sections per kind of note: a "kind:" line, then one "- Name: what goes in it" line per section. '
    + 'A kind with no list of its own takes the person or company list, else "other"; a list here comes before the built-in one. '
    + '"Last contact" and "Rules on what to say" are written by code. Leave blank to use the built-in lists.'),
];
