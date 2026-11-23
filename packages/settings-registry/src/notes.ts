import type { SettingsDomain } from './types.js';
import { descriptorsFor } from './registry.js';

/**
 * Which note in the settings folder shows each setting (#746). Most domains have one note
 * (`Settings/Chat.md`). A domain with groups has a folder of notes instead, one per group,
 * like the tabs of a settings screen (`Settings/Curator/Models.md`). Settings are still
 * stored one blob per domain: only the notes are split.
 */
export interface SettingsNote {
  domain: SettingsDomain;
  /** The note's name inside the domain's folder, or null for the domain's single note. */
  group: string | null;
  /** One sentence on what the note holds; group notes only. */
  summary: string | null;
  /** The settings the note shows, in the order its body documents them (frontmatter keeps
   *  the renderer's own key order). */
  keys: readonly string[];
}

interface SettingsGroup {
  name: string;
  summary: string;
  keys: readonly string[];
}

const CURATOR_GROUPS: readonly SettingsGroup[] = [
  {
    name: 'General',
    summary: 'When the nightly sweep runs, how much the Curator may spend in a day, and the journal.',
    keys: ['dailyBudgetCents', 'runDailyBudgetCents', 'sweepAt', 'tz', 'journalEnabled'],
  },
  {
    name: 'Models',
    summary: 'The model each job uses, with its output-token cap and reasoning. A job left empty uses `model`.',
    keys: [
      'model', 'reasoningEffort', 'homeMaxTokens',
      'wikiPlanningModel', 'wikiPlanningMaxTokens', 'wikiPlanningReasoningEffort', 'wikiPlanningReasoningBudget',
      'wikiPageModel', 'wikiPageMaxTokens', 'wikiPageReasoningEffort', 'wikiPageReasoningBudget',
      'wikiHomeModel', 'wikiHomeMaxTokens', 'wikiHomeReasoningEffort', 'wikiHomeReasoningBudget',
      'topicEarlyRefreshAssessmentModel', 'topicEarlyRefreshAssessmentMaxTokens',
      'memorySweepModel', 'memorySweepMaxTokens',
      'conversationSweepModel', 'conversationSweepMaxTokens',
      'conversationCaptureModel', 'conversationCapturePlannerMaxTokens', 'conversationCaptureComposerMaxTokens',
      'conversationCaptureCoverageModel', 'conversationCaptureCoverageMaxTokens',
      'reconcileModel',
      'orgSweepModel', 'orgSweepMaxTokens',
      'fieldGuessModel', 'fieldGuessMaxTokens',
      'journalModel',
    ],
  },
  {
    name: 'Wikis',
    summary: 'Project wikis, topic wikis and dossiers: when they are rebuilt, what a build reads, and how many pages it may add.',
    keys: [
      'wikiReconciliationMode', 'wikiTaskOnlyRefreshDays', 'wikiFailureHoldDays', 'projectHomeProvenanceEnabled',
      'meetingReads', 'noteReads', 'bodyCharCap',
      'semanticGapFill', 'semanticGapFillLimit', 'semanticGapFillBodyReads',
      'wikiPageCreatesPerRun', 'archetypeTotalCap', 'archetypeKindCap',
      'staleProjectDays', 'staleProjectStatus', 'staleSkipStatuses',
      'topicWebCadence', 'topicEarlyRefreshEnabled', 'topicEarlyRefreshAssessmentCap',
      'webSearchResults', 'webFetchTop', 'webFetchCharCap',
      'topicRequestMaxBytes', 'topicPageRequestMaxBytes', 'topicSourceExcerptMaxBytes',
      'dossierBodyReads', 'dossierSections',
    ],
  },
  {
    name: 'Memories',
    summary: 'Collecting memories from notes and chats, checking them again, and merging duplicates.',
    keys: [
      'memoryWriteEnabled', 'memoryWriteCap',
      'memorySweepEnabled', 'memorySweepTypes', 'memorySweepPaths',
      'memorySweepCap', 'memorySweepExtractionCap', 'memorySweepNoteCap',
      'conversationSweepEnabled', 'conversationSweepSettleHours', 'conversationSweepMinUserChars',
      'conversationSweepCap', 'conversationSweepPerConversationCap',
      'reverifyEnabled', 'reconcileEnabled', 'reconcilePairCap',
    ],
  },
  {
    name: 'Conversation capture',
    summary: 'Writing notes from finished chats.',
    keys: [
      'conversationCaptureMode', 'conversationCaptureSettleHours', 'conversationCaptureInitialLookbackDays',
      'conversationCaptureMinAssistantChars', 'conversationCaptureEvaluationCap',
      'conversationCaptureArtifactCap', 'conversationCaptureWriteCap',
    ],
  },
  {
    name: 'Organization',
    summary: 'Typing and filing notes, adding links between them, and filling empty fields.',
    keys: [
      'orgSweepEnabled', 'orgTypePaths', 'orgTypeExcludePaths', 'orgTypeExclude', 'orgTypeCap',
      'orgMovePaths', 'orgMovePin', 'orgMoveCap',
      'linkSweepEnabled', 'linkSweepMode', 'linkSweepSchedule', 'linkSweepQuietMinutes',
      'linkSweepBacklog', 'linkSweepTargetTypes', 'linkSweepNoteCap',
      'fieldGuessCap',
    ],
  },
  {
    name: 'Prompts',
    summary: 'Replacements for the built-in prompts. Leave one blank to use the built-in prompt, shown folded under it.',
    keys: [
      'curatorProjectHomePrompt', 'curatorTopologyPrompt', 'curatorCreateAdjudicationPrompt', 'curatorPagePrompt',
      'curatorRequestedPagePrompt', 'curatorRequestedPageWebPrompt', 'curatorTopicPrompt', 'curatorTopicWebPrompt',
      'curatorMemorySweepPrompt', 'curatorConversationSweepPrompt',
      'curatorConversationCapturePlannerPrompt', 'curatorConversationCaptureCoveragePrompt',
      'curatorConversationCaptureComposerPrompt',
    ],
  },
];

const ENGINE_GROUPS: readonly SettingsGroup[] = [
  {
    name: 'General',
    summary: 'Folders left out of the vault, the nightly normalizer, and link repair at start.',
    keys: ['excludeDirs', 'normalizeCron', 'normalizeQuiescenceMinutes', 'linkRepair'],
  },
  {
    name: 'Models',
    summary: 'Reading attachments (audio, images, scanned PDFs) and the model that merges memories.',
    keys: ['extractionEnabled', 'visionProvider', 'visionModel', 'memoryConsolidationModel'],
  },
  {
    name: 'Backups and retention',
    summary: 'Database backups, and how long logs, undo history and cached extractions are kept.',
    keys: [
      'backupsEnabled', 'backupIntervalHours', 'backupKeep',
      'editsLogRetentionDays', 'extractionCacheRetentionDays', 'syncLogRetentionHours', 'undoRetentionHours',
    ],
  },
  {
    name: 'Provenance',
    summary: 'Size limits for the record of what a wiki build read.',
    keys: [
      'provenanceRequestBytes', 'provenanceComponentBytes', 'provenanceItemCount', 'provenanceOutputBytes',
      'provenanceTotalBytes', 'provenanceCapacityBytes', 'provenanceLeaseHours', 'provenanceFailedRetentionDays',
    ],
  },
];

/** The domains whose settings are shown in a folder of notes, one per group. */
export const SETTINGS_GROUPS: Readonly<Partial<Record<SettingsDomain, readonly SettingsGroup[]>>> = {
  curator: CURATOR_GROUPS,
  engine: ENGINE_GROUPS,
};

/** `Curator` for `curator`: a domain's note, or its folder. */
export function settingsDomainTitle(domain: SettingsDomain): string {
  return domain.charAt(0).toUpperCase() + domain.slice(1);
}

const notesCache = new Map<SettingsDomain, readonly SettingsNote[]>();

/**
 * The notes that show `domain`'s settings. A known key no group lists is shown in the
 * first note, so a key added without a group still has a note (a registry test fails on
 * it all the same).
 */
export function settingsNotesOf(domain: SettingsDomain): readonly SettingsNote[] {
  const cached = notesCache.get(domain);
  if (cached) return cached;
  const known = descriptorsFor(domain).map(d => d.key);
  const groups = SETTINGS_GROUPS[domain];
  let notes: SettingsNote[];
  if (!groups) {
    notes = [{ domain, group: null, summary: null, keys: known }];
  } else {
    const knownSet = new Set(known);
    const grouped = new Set(groups.flatMap(g => g.keys));
    const loose = known.filter(key => !grouped.has(key));
    notes = groups.map((g, i) => ({
      domain,
      group: g.name,
      summary: g.summary,
      keys: [...g.keys.filter(key => knownSet.has(key)), ...(i === 0 ? loose : [])],
    }));
  }
  notesCache.set(domain, notes);
  return notes;
}

/** The note that shows `key`, or null when `key` is no setting of `domain`. */
export function settingsNoteOfKey(domain: SettingsDomain, key: string): SettingsNote | null {
  return settingsNotesOf(domain).find(note => note.keys.includes(key)) ?? null;
}

/** The note's vault path: `Settings/Chat.md`, or `Settings/Curator/Models.md` for a group. */
export function settingsNotePath(settingsDir: string, note: Pick<SettingsNote, 'domain' | 'group'>): string {
  const title = settingsDomainTitle(note.domain);
  return note.group === null ? `${settingsDir}/${title}.md` : `${settingsDir}/${title}/${note.group}.md`;
}

/** The note's file title, as the Engine writes it: `Chat`, or `Models` for a group note. */
export function settingsNoteTitle(note: Pick<SettingsNote, 'domain' | 'group'>): string {
  return note.group ?? settingsDomainTitle(note.domain);
}

/**
 * Where a setting is edited, for messages: `Settings/Curator/Models.md` for a known key,
 * else the domain's note or folder (`Settings/Curator/`). `settingsDir` defaults to the
 * install default, `Settings`.
 */
export function settingsNoteLabel(domain: SettingsDomain, key?: string, settingsDir = 'Settings'): string {
  const note = key === undefined ? null : settingsNoteOfKey(domain, key);
  if (note) return settingsNotePath(settingsDir, note);
  return SETTINGS_GROUPS[domain]
    ? `${settingsDir}/${settingsDomainTitle(domain)}/`
    : `${settingsDir}/${settingsDomainTitle(domain)}.md`;
}

/**
 * The notes a write of `keys` changes: each key's note, and the domain's first note for a
 * key that is none of its settings (an unknown key, or an old name of a vault key). With no
 * keys, every note: a write that names nothing regenerates them all.
 */
export function settingsNotesForKeys(domain: SettingsDomain, keys: Iterable<string>): SettingsNote[] {
  const notes = settingsNotesOf(domain);
  const wanted = new Set<SettingsNote>();
  let any = false;
  for (const key of keys) {
    any = true;
    wanted.add(settingsNoteOfKey(domain, key) ?? notes[0]!);
  }
  return any ? notes.filter(note => wanted.has(note)) : [...notes];
}

/** The note `key`'s issues belong to: its own note, or the domain's first note. */
export function settingsNoteForIssue(domain: SettingsDomain, key: string): SettingsNote {
  return settingsNoteOfKey(domain, key) ?? settingsNotesOf(domain)[0]!;
}
