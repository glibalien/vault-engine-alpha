import { describe, expect, it } from 'vitest';
import { validateDomainPatch, defaultsFor, descriptorsFor, effectiveSettings, seedFromEnv, DOMAINS } from '../src/index.js';

it('defaults wiki output caps to the measured stage profile without environment seeds', () => {
  const caps: Record<string, number> = { Planning: 24000, Page: 32000, Home: 16000 };
  for (const stage of ['Planning', 'Page', 'Home']) {
    const cap = `wiki${stage}MaxTokens`, effort = `wiki${stage}ReasoningEffort`, budget = `wiki${stage}ReasoningBudget`;
    expect(defaultsFor('curator')[cap]).toBe(caps[stage]);
    expect(defaultsFor('curator')[effort]).toBe('inherit');
    expect(defaultsFor('curator')[budget]).toBe(0);
    expect(validateDomainPatch('curator', { [cap]: 0, [effort]: 'provider-default' }).issues).toEqual([]);
    for (const value of [-1, 1.5, NaN, Infinity, null]) {
      expect(validateDomainPatch('curator', { [cap]: value }).issues.length).toBeGreaterThan(0);
      expect(validateDomainPatch('curator', { [budget]: value }).issues.length).toBeGreaterThan(0);
    }
    // none is the one level Qwen 3.7 Plus honors (#355); a budget is a token count.
    expect(validateDomainPatch('curator', { [effort]: 'none', [budget]: 6000 }).issues).toEqual([]);
    expect(validateDomainPatch('curator', { [effort]: 'minimal' }).issues.length).toBeGreaterThan(0);
    expect(descriptorsFor('curator').find(d => d.key === cap)?.envSeed).toBeUndefined();
    const budgetDescriptor = descriptorsFor('curator').find(d => d.key === budget);
    expect(budgetDescriptor?.reload).toBe('next-use');
    expect(budgetDescriptor?.envSeed).toBeUndefined();
  }
});

it('exposes next-use topic byte limits', () => {
  expect(defaultsFor('curator')).toMatchObject({
    topicRequestMaxBytes: 204800, topicPageRequestMaxBytes: 98304, topicSourceExcerptMaxBytes: 24576 });
  for (const key of ['topicRequestMaxBytes', 'topicPageRequestMaxBytes', 'topicSourceExcerptMaxBytes']) {
    expect(descriptorsFor('curator').find(d => d.key === key)?.reload).toBe('next-use');
    expect(validateDomainPatch('curator', { [key]: 0 }).issues.length).toBeGreaterThan(0);
  }
});

const CAPTURE_KEYS = [
  'conversationCaptureMode',
  'conversationCaptureSettleHours',
  'conversationCaptureInitialLookbackDays',
  'conversationCaptureMinAssistantChars',
  'conversationCaptureEvaluationCap',
  'conversationCaptureArtifactCap',
  'conversationCaptureWriteCap',
  'conversationCaptureModel',
  'conversationCapturePlannerMaxTokens',
  'conversationCaptureCoverageModel',
  'conversationCaptureCoverageMaxTokens',
  'conversationCaptureComposerMaxTokens',
  'curatorConversationCapturePlannerPrompt',
  'curatorConversationCaptureCoveragePrompt',
  'curatorConversationCaptureComposerPrompt',
] as const;

const TOPIC_EARLY_REFRESH_KEYS = [
  'topicEarlyRefreshEnabled',
  'topicEarlyRefreshAssessmentModel',
  'topicEarlyRefreshAssessmentMaxTokens',
  'topicEarlyRefreshAssessmentCap',
] as const;

describe('curator domain', () => {
  it('is registered with 116 keys and config.ts-equivalent defaults', () => {
    expect(DOMAINS).toContain('curator');
    expect(descriptorsFor('curator')).toHaveLength(116);
    expect(defaultsFor('curator')).toEqual({
      topicRequestMaxBytes: 204800, topicPageRequestMaxBytes: 98304, topicSourceExcerptMaxBytes: 24576,
      projectHomeProvenanceEnabled: false,
      model: '[[Claude Sonnet 4.6]]',  // catalog reference; provider derives from the referenced entry
      fieldGuessModel: '[[GPT-OSS 120B]]',
      fieldGuessCap: 25,
      fieldGuessMaxTokens: 2000,
      homeMaxTokens: 4000,
      wikiPlanningMaxTokens: 24000, wikiPageMaxTokens: 32000, wikiHomeMaxTokens: 16000,
      wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit',
      wikiPlanningReasoningBudget: 0, wikiPageReasoningBudget: 0, wikiHomeReasoningBudget: 0,
      wikiPlanningModel: null, wikiPageModel: null, wikiHomeModel: null, wikiFailureHoldDays: 7, wikiTaskOnlyRefreshDays: 7, dailyBudgetCents: 100, runDailyBudgetCents: 500,
      reasoningEffort: '',             // '' = omitted from requests
      meetingReads: 10,
      noteReads: 6,
      bodyCharCap: null,               // null = unlimited
      webSearchResults: 5,
      webFetchTop: 3,
      webFetchCharCap: 4000,
      topicWebCadence: '7d',
      topicEarlyRefreshEnabled: false,
      topicEarlyRefreshAssessmentModel: null,
      topicEarlyRefreshAssessmentMaxTokens: 2000,
      topicEarlyRefreshAssessmentCap: 5,
      semanticGapFill: true,
      semanticGapFillLimit: 15,
      semanticGapFillBodyReads: 3,
      archetypeTotalCap: 6,
      archetypeKindCap: 2,
      wikiPageCreatesPerRun: 3,
      staleProjectDays: 14,
      staleProjectStatus: 'backlog',
      staleSkipStatuses: ['backlog', 'done', 'dropped'],
      sweepAt: '05:00',
      wikiReconciliationMode: 'off',
      tz: '',                          // '' = system IANA zone
      memoryWriteEnabled: true,
      memoryWriteCap: 3,
      memorySweepEnabled: false,
      memorySweepTypes: [],
      memorySweepPaths: [],
      memorySweepCap: 10,
      memorySweepExtractionCap: 50,
      memorySweepNoteCap: 3,
      memorySweepMaxTokens: 4000,
      memorySweepModel: null,          // null = use `model`
      conversationSweepEnabled: false,
      conversationSweepSettleHours: 6,
      conversationSweepMinUserChars: 300,
      conversationSweepCap: 5,
      conversationSweepPerConversationCap: 2,
      conversationSweepMaxTokens: 4000,
      conversationSweepModel: null,    // null = use `model`
      conversationCaptureMode: 'off',
      conversationCaptureSettleHours: 6,
      conversationCaptureInitialLookbackDays: 7,
      conversationCaptureMinAssistantChars: 500,
      conversationCaptureEvaluationCap: 10,
      conversationCaptureArtifactCap: 3,
      conversationCaptureWriteCap: 5,
      conversationCaptureModel: null,
      conversationCapturePlannerMaxTokens: 4000,
      conversationCaptureCoverageModel: null,
      conversationCaptureCoverageMaxTokens: 2000,
      conversationCaptureComposerMaxTokens: 6000,
      reverifyEnabled: true,           // §4a: expire unsupported facts on a changed note
      reconcileEnabled: true,          // §4c: nightly reconciliation kill switch
      reconcilePairCap: 10,
      reconcileModel: null,            // null = use `model`
      orgSweepEnabled: false,
      orgTypePaths: [],
      orgTypeExcludePaths: [],
      orgMovePaths: ['/'],
      orgMovePin: ['CLAUDE.md'],
      orgTypeExclude: [],
      orgTypeCap: 25,
      orgMoveCap: 25,
      orgSweepMaxTokens: 4000,
      orgSweepModel: null,             // null = use `model`
      linkSweepEnabled: false,         // #332: off by default
      linkSweepMode: 'report',         // #332: lists links, writes none, until set to apply
      linkSweepBacklog: 'fewest-links', // #697: older unread notes, fewest links first, after the new ones
      linkSweepSchedule: 'daily',
      linkSweepQuietMinutes: 30,
      linkSweepTargetTypes: [],        // [] = the vault map's project, person and company kinds
      linkSweepNoteCap: 50,
      journalEnabled: true,
      journalModel: null,             // null = use `model`
      curatorProjectHomePrompt: '',
      curatorTopicPrompt: '',
      curatorTopicWebPrompt: '',
      curatorRequestedPagePrompt: '',
      curatorRequestedPageWebPrompt: '',
      curatorMemorySweepPrompt: '',
      curatorConversationSweepPrompt: '',
      curatorConversationCapturePlannerPrompt: '',
      curatorConversationCaptureCoveragePrompt: '',
      curatorConversationCaptureComposerPrompt: '',
      curatorTopologyPrompt: '',
      curatorCreateAdjudicationPrompt: '',
      curatorPagePrompt: '',
      dossierSections: '',
      dossierBodyReads: 8,
    });
  });

  it('validates the specialty kinds', () => {
    expect(validateDomainPatch('curator', { sweepAt: '5:00' }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { sweepAt: '04:30' }).issues).toHaveLength(0);
    expect(defaultsFor('curator')).toMatchObject({ wikiReconciliationMode: 'off' });
    expect(validateDomainPatch('curator', { wikiReconciliationMode: 'dry-run' }).issues).toEqual([]);
    expect(validateDomainPatch('curator', { wikiReconciliationMode: 'unsafe' }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { tz: 'Mars/Olympus_Mons' }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { tz: 'Europe/Berlin' }).issues).toHaveLength(0);
    expect(validateDomainPatch('curator', { topicWebCadence: '7y' }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { topicWebCadence: '24h' }).issues).toHaveLength(0);
    expect(validateDomainPatch('curator', { topicEarlyRefreshEnabled: true }).issues).toHaveLength(0);
    expect(validateDomainPatch('curator', { topicEarlyRefreshEnabled: 'true' }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { topicEarlyRefreshAssessmentModel: null }).issues).toHaveLength(0);
    expect(validateDomainPatch('curator', { topicEarlyRefreshAssessmentModel: '' }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { topicEarlyRefreshAssessmentMaxTokens: 0 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { topicEarlyRefreshAssessmentMaxTokens: 1 }).issues).toHaveLength(0);
    expect(validateDomainPatch('curator', { topicEarlyRefreshAssessmentCap: 0 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { topicEarlyRefreshAssessmentCap: 1 }).issues).toHaveLength(0);
    expect(validateDomainPatch('curator', { bodyCharCap: null }).issues).toHaveLength(0);     // nullable
    expect(validateDomainPatch('curator', { bodyCharCap: 0 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { fieldGuessCap: 0 }).issues).toHaveLength(0);
    expect(validateDomainPatch('curator', { fieldGuessCap: -1 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { fieldGuessCap: 1.5 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { fieldGuessMaxTokens: 1 }).issues).toHaveLength(0);
    expect(validateDomainPatch('curator', { fieldGuessMaxTokens: 0 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { memorySweepModel: null }).issues).toHaveLength(0);
    expect(validateDomainPatch('curator', { memorySweepModel: '' }).issues).toHaveLength(1);  // nonEmpty when set
    expect(validateDomainPatch('curator', { orgMovePaths: [] }).issues).toHaveLength(0);      // explicit empty list is valid
    expect(validateDomainPatch('curator', { curatorTopicPrompt: 'Use [[links]] exactly.' }).issues).toHaveLength(0);
    expect(validateDomainPatch('curator', { curatorTopicPrompt: false }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { conversationCaptureMode: 'preview' }).issues).toHaveLength(0);
    expect(validateDomainPatch('curator', { conversationCaptureMode: 'unsafe' }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { conversationCaptureSettleHours: -1 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { conversationCaptureInitialLookbackDays: -1 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { conversationCaptureMinAssistantChars: -1 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { conversationCaptureEvaluationCap: 0 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { conversationCaptureArtifactCap: 0 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { conversationCaptureWriteCap: 0 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { conversationCapturePlannerMaxTokens: 255 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { conversationCaptureCoverageMaxTokens: 255 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { conversationCaptureCoverageMaxTokens: 256 }).issues).toHaveLength(0);
    expect(validateDomainPatch('curator', { conversationCaptureComposerMaxTokens: 255 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { conversationCaptureModel: null }).issues).toHaveLength(0);
    expect(validateDomainPatch('curator', { conversationCaptureCoverageModel: null }).issues).toHaveLength(0);
    expect(validateDomainPatch('curator', { curatorConversationCapturePlannerPrompt: 'Plan carefully.' }).issues).toHaveLength(0);
  });

  it('keeps conversation capture controls Markdown-only with conservative defaults', () => {
    expect(effectiveSettings('curator', {})).toMatchObject({
      conversationCaptureMode: 'off',
      conversationCaptureSettleHours: 6,
      conversationCaptureInitialLookbackDays: 7,
      conversationCaptureMinAssistantChars: 500,
      conversationCaptureEvaluationCap: 10,
      conversationCaptureArtifactCap: 3,
      conversationCaptureWriteCap: 5,
      conversationCaptureModel: null,
      conversationCapturePlannerMaxTokens: 4000,
      conversationCaptureCoverageModel: null,
      conversationCaptureCoverageMaxTokens: 2000,
      conversationCaptureComposerMaxTokens: 6000,
      curatorConversationCapturePlannerPrompt: '',
      curatorConversationCaptureCoveragePrompt: '',
      curatorConversationCaptureComposerPrompt: '',
    });
    const byKey = new Map(descriptorsFor('curator').map(descriptor => [descriptor.key, descriptor]));
    for (const key of CAPTURE_KEYS) expect(byKey.get(key)?.envSeed).toBeUndefined();
    expect(byKey.get('conversationCaptureCoverageModel')?.type).toEqual({ kind: 'model-ref', nullable: true });

    const projectedHeadings = descriptorsFor('curator').map(descriptor => `### ${descriptor.key}`).join('\n');
    expect(projectedHeadings).toContain('### conversationCaptureCoverageModel');
    expect(projectedHeadings).toContain('### conversationCaptureCoverageMaxTokens');
    expect(projectedHeadings).toContain('### curatorConversationCaptureCoveragePrompt');
  });

  it('keeps topic early refresh controls Markdown-only and validates their shapes', () => {
    const effective = effectiveSettings('curator', {});
    expect(effective).toMatchObject({
      topicEarlyRefreshEnabled: false,
      topicEarlyRefreshAssessmentModel: null,
      topicEarlyRefreshAssessmentMaxTokens: 2000,
      topicEarlyRefreshAssessmentCap: 5,
    });
    const byKey = new Map(descriptorsFor('curator').map(descriptor => [descriptor.key, descriptor]));
    for (const key of TOPIC_EARLY_REFRESH_KEYS) {
      expect(byKey.get(key)?.reload).toBe('next-use');
      expect(byKey.get(key)?.envSeed).toBeUndefined();
    }
    expect(byKey.get('topicEarlyRefreshEnabled')?.type).toEqual({ kind: 'bool' });
    expect(byKey.get('topicEarlyRefreshAssessmentModel')?.type).toEqual({ kind: 'model-ref', nullable: true });
    expect(byKey.get('topicEarlyRefreshAssessmentMaxTokens')?.type).toEqual({ kind: 'int', min: 1 });
    expect(byKey.get('topicEarlyRefreshAssessmentCap')?.type).toEqual({ kind: 'int', min: 1 });

    const projectedHeadings = descriptorsFor('curator').map(descriptor => `### ${descriptor.key}`).join('\n');
    for (const key of TOPIC_EARLY_REFRESH_KEYS) expect(projectedHeadings).toContain(`### ${key}`);
  });

  it('seeds with the config.ts boolean env semantics', () => {
    expect(seedFromEnv('curator', {
      CURATOR_SEMANTIC_GAP_FILL: 'false',       // "!== 'false'" style: only 'false' disables
      CURATOR_MEMORY_WRITE_ENABLED: 'nonsense', // → true (not 'false')
      CURATOR_MEMORY_SWEEP_ENABLED: 'true',     // "=== 'true'" style: only 'true' enables
      CURATOR_ORG_SWEEP_ENABLED: 'yes',         // → false (not 'true')
      CURATOR_MODEL: 'accounts/fireworks/models/deepseek-v4-pro',
      CURATOR_FIELD_GUESS_MODEL: 'accounts/fireworks/models/gpt-oss-120b',
      CURATOR_FIELD_GUESS_CAP: '0',
      CURATOR_FIELD_GUESS_MAX_TOKENS: '2500',
      CURATOR_SWEEP_AT: '04:30',
      CURATOR_ARCHETYPE_TOTAL_CAP: '9',
    })).toEqual({
      semanticGapFill: false,
      memoryWriteEnabled: true,
      memorySweepEnabled: true,
      orgSweepEnabled: false,
      model: 'accounts/fireworks/models/deepseek-v4-pro',
      fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
      fieldGuessCap: 0,
      fieldGuessMaxTokens: 2500,
      sweepAt: '04:30',
    });
    // NOTE: memoryWriteEnabled:true and orgSweepEnabled:false equal their defaults —
    // seedFromEnv returns them, but the SERVICE's deviations-only commit drops them.
    // The set-empty semantics of CURATOR_ORG_MOVE_PATHS / _PIN and the
    // CURATOR_THEMED_PAGE_CAP alias are handled curator-side (Task 8), not here.
  });

  it('validates the automatic page caps without env seeding', () => {
    const descriptors = new Map(descriptorsFor('curator').map(descriptor => [descriptor.key, descriptor]));
    expect(validateDomainPatch('curator', { archetypeTotalCap: 1, archetypeKindCap: 100, wikiPageCreatesPerRun: 0 }).issues).toEqual([]);
    expect(validateDomainPatch('curator', { archetypeTotalCap: 0 }).issues).toHaveLength(1);
    expect(validateDomainPatch('curator', { wikiPageCreatesPerRun: -1 }).issues).toHaveLength(1);
    for (const key of ['archetypeTotalCap', 'archetypeKindCap', 'wikiPageCreatesPerRun']) {
      expect(descriptors.get(key)?.description).not.toMatch(/no-op/i);
      expect(descriptors.get(key)?.envSeed).toBeUndefined();
    }
  });

  it('keeps backlog as the staleness status and takes an empty one to turn the nudge off (#447)', () => {
    expect(defaultsFor('curator').staleProjectStatus).toBe('backlog');
    expect(validateDomainPatch('curator', { staleProjectStatus: '' }).issues).toEqual([]);
    expect(validateDomainPatch('curator', { staleProjectStatus: 'someday' }).issues).toEqual([]);
    expect(validateDomainPatch('curator', { staleProjectStatus: null }).issues).toHaveLength(1);
    // An empty env value seeds nothing, so an install keeps backlog.
    expect(seedFromEnv('curator', { CURATOR_STALE_PROJECT_STATUS: '' })).toEqual({});
  });

  it('every descriptor has a description and its default validates', () => {
    for (const d of descriptorsFor('curator')) {
      expect(d.description.length).toBeGreaterThan(10);
      expect(validateDomainPatch('curator', { [d.key]: defaultsFor('curator')[d.key] }).issues).toEqual([]);
    }
  });
});
