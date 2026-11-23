import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFixture } from '../../src/eval/corpus.js';
import { runEval } from '../../src/eval.js';
import type { EvalDeps, RunOpts } from '../../src/eval.js';
import type { EvalFixture } from '../../src/eval/corpus.js';
import type { LlmClient, StructuredCallRequest } from '../../src/llm/types.js';
import type { Config } from '../../src/config.js';
import { CAPTURE_COVERAGE_SYSTEM_PROMPT } from '../../src/conversation-capture-prompts.js';
import type { ProjectEvidence } from '../../src/types.js';
import { baselineProfile, VARIANT_FACTORIES } from '../../src/eval/profile.js';

// A prompt variant to compare against baseline, registered only for these tests.
VARIANT_FACTORIES['candidate'] = config => ({ ...baselineProfile(config), id: 'candidate', systemPrompt: 'CANDIDATE PROMPT' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubLlm(output: unknown): LlmClient {
  return {
    configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
    withConfiguration() { return this; },
    structuredCall: async () => ({
      output,
      usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 },
    }),
  };
}

/**
 * Stub that answers synthesis calls with model-tagged sections and judge calls
 * (toolName emit_verdict) via the supplied verdict function, capturing all requests.
 */
function dispatchLlm(
  verdictFor: (req: StructuredCallRequest) => unknown,
): { llm: LlmClient; reqs: StructuredCallRequest[] } {
  const reqs: StructuredCallRequest[] = [];
  return {
    reqs,
    llm: {
      configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
    withConfiguration() { return this; },
    structuredCall: async (req) => {
        reqs.push(req);
        const output =
          req.toolName === 'emit_verdict'
            ? verdictFor(req)
            : { now: `made by ${req.model}`, focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' };
        return { output, usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 } };
      },
    },
  };
}

/** Minimal Config literal — only the fields eval needs. */
function makeConfig(): Config {
  return {
    engineUrl: 'http://localhost:9999',
    engineToken: 'test-token',
    experiment: null,
    variant: null,
    llmKeys: { keys: { anthropic: 'test-key' }, baseURLs: {} },
    model: 'claude-haiku-4-5',
    fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
    fieldGuessModelError: null,
    fieldGuessCap: 25,
    fieldGuessMaxTokens: 2000,
    modelProviders: {
      'claude-haiku-4-5': 'anthropic',
      'accounts/fireworks/models/gpt-oss-120b': 'fireworks',
    },
    reasoningEffort: undefined,
  projectHomeProvenanceEnabled: false,
  wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0,
  wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit',
  wikiPlanningReasoningBudget: 0, wikiPageReasoningBudget: 0, wikiHomeReasoningBudget: 0,
    homeMaxTokens: 500,
    activeStatuses: ['open', 'in-progress'],
    meetingReads: 5,
    noteReads: 3,
    topicRequestMaxBytes: 204800, topicPageRequestMaxBytes: 98304, topicSourceExcerptMaxBytes: 24576,
    bodyCharCap: null,
    webSearchResults: 5,
    webFetchTop: 3,
    webFetchCharCap: 4000,
    topicWebCadenceMs: 7 * 24 * 3600_000,
    topicEarlyRefreshEnabled: false,
    topicEarlyRefreshAssessmentModel: null,
    topicEarlyRefreshAssessmentMaxTokens: 2000,
    topicEarlyRefreshAssessmentCap: 5,
    semanticGapFill: false,
    semanticGapFillLimit: 10,
    semanticGapFillBodyReads: 2,
    staleProjectDays: 14,
    staleProjectStatus: 'backlog',
    staleSkipStatuses: ['backlog', 'done', 'dropped'],
    projectStatusField: 'status',
    oauthOwnerPassword: undefined,
    oauthIssuerUrl: undefined,
    curatorPort: 3335,
    curatorDbPath: '/tmp/curator-test.db',
    curatorTz: 'UTC',
    curatorSweepAt: '05:00',
    wikiReconciliationMode: 'off',
    memoryWriteEnabled: true,
    memoryWriteCap: 3,
    memorySweepEnabled: false,
    memorySweepTypes: [],
    memorySweepPaths: [],
    memorySweepCap: 10,
    memorySweepNoteCap: 3,
    memorySweepMaxTokens: 4000,
    memorySweepModel: null,
    memorySweepSince: null,
    conversationSweepEnabled: false,
    conversationSweepSettleHours: 6,
    conversationSweepMinUserChars: 300,
    conversationSweepCap: 5,
    conversationSweepPerConversationCap: 2,
    conversationSweepMaxTokens: 4000,
    conversationSweepModel: null,
    conversationSweepSince: null,
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
    reverifyEnabled: true,
    reconcileEnabled: true,
    reconcilePairCap: 10,
    reconcileModel: null,
    orgSweepEnabled: false,
    orgTypePaths: [],
    orgTypeExcludePaths: ['Settings'],
    orgMovePaths: ['/'],
    orgMovePin: ['CLAUDE.md'],
    orgTypeExclude: [],
    orgTypeCap: 25,
    orgMoveCap: 25,
    orgSweepMaxTokens: 4000,
    orgSweepModel: null,
    linkSweepEnabled: false,
    linkSweepMode: 'report',
    linkSweepBacklog: 'fewest-links',
    linkSweepSchedule: 'daily',
    linkSweepQuietMinutes: 30,
    linkSweepTargetTypes: [],
    linkSweepNoteCap: 50,
    journalEnabled: true,
    journalModel: null,
    curatorProjectHomePrompt: 'HOME PROMPT',
    curatorTopicPrompt: 'TOPIC PROMPT',
    curatorTopicWebPrompt: 'TOPIC WEB PROMPT',
    curatorRequestedPagePrompt: 'REQ PAGE PROMPT',
    curatorRequestedPageWebPrompt: 'REQ PAGE WEB PROMPT',
    curatorConversationCapturePlannerPrompt: 'CAPTURE PLANNER PROMPT',
    curatorConversationCaptureCoveragePrompt: CAPTURE_COVERAGE_SYSTEM_PROMPT,
    curatorConversationCaptureComposerPrompt: 'CAPTURE COMPOSER PROMPT',
    curatorMemorySweepPrompt: 'MEMSWEEP PROMPT',
    curatorConversationSweepPrompt: 'CONVSWEEP PROMPT',
    curatorTopologyPrompt: 'TOPOLOGY PROMPT',
    curatorCreateAdjudicationPrompt: 'ADJUDICATION PROMPT',
    curatorPagePrompt: 'PAGE PROMPT',
  };
}

function makeEvidence(projectTitle: string): ProjectEvidence {
  return {
    project: {
      id: `proj-${projectTitle.toLowerCase().replace(/\s/g, '-')}`,
      title: projectTitle,
      file_path: `${projectTitle}.md`,
      status: 'open',
    },
    tasks: {
      overdue: [],
      blocked: [],
      open: [{ id: 't1', title: 'Write eval', status: 'open', due: null }],
      upcoming: [],
      backlog: [],
      done_recent: [],
    },
    notes: [],
    signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
    existing_wiki: { home_id: null, subpages: [] },
    synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
    meetings: { recent: [], upcoming: [] },
    contacts: { people: [], companies: [] },
    evidence_hash: `hash-${projectTitle}`,
    generated_at: '2026-06-17T00:00:00Z',
  };
}

function makeFixture(title: string): EvalFixture {
  const evidence = makeEvidence(title);
  return {
    project: {
      id: evidence.project.id,
      title,
      file_path: evidence.project.file_path,
      status: 'open',
    },
    evidence,
    readNodes: [],
    candidates: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runEval', () => {
  let fixturesDir: string;
  let outDir: string;

  beforeEach(() => {
    fixturesDir = mkdtempSync(join(tmpdir(), 'eval-fixtures-'));
    outDir = mkdtempSync(join(tmpdir(), 'eval-out-'));

    // Write two fixture JSON files to the temp fixtures dir
    writeFixture(fixturesDir, makeFixture('Alpha Project'));
    writeFixture(fixturesDir, makeFixture('Beta Project'));
  });

  afterEach(() => {
    rmSync(fixturesDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it('returns a reportPath that exists on disk', async () => {
    const deps: EvalDeps = {
      engine: null as never, // not needed for live:false
      llm: stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' }),
      config: makeConfig(),
    };

    const opts: RunOpts = {
      fixturesDir,
      outDir,
      profileIds: ['baseline'],
      live: false,
      judge: false,
      judgeModel: 'x',
    };

    const result = await runEval(deps, opts);

    expect(existsSync(result.reportPath)).toBe(true);
  });

  it('writes report.html, report.md, and report.json to outDir', async () => {
    const deps: EvalDeps = {
      engine: null as never,
      llm: stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' }),
      config: makeConfig(),
    };

    const opts: RunOpts = {
      fixturesDir,
      outDir,
      profileIds: ['baseline'],
      live: false,
      judge: false,
      judgeModel: 'x',
    };

    await runEval(deps, opts);

    expect(existsSync(join(outDir, 'report.html'))).toBe(true);
    expect(existsSync(join(outDir, 'report.md'))).toBe(true);
    expect(existsSync(join(outDir, 'report.json'))).toBe(true);
  });

  it('reportPath is the html file path', async () => {
    const deps: EvalDeps = {
      engine: null as never,
      llm: stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' }),
      config: makeConfig(),
    };

    const opts: RunOpts = {
      fixturesDir,
      outDir,
      profileIds: ['baseline'],
      live: false,
      judge: false,
      judgeModel: 'x',
    };

    const result = await runEval(deps, opts);

    expect(result.reportPath).toBe(join(outDir, 'report.html'));
  });

  it('returns a totalCostUsd (number or null)', async () => {
    const deps: EvalDeps = {
      engine: null as never,
      llm: stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' }),
      config: makeConfig(),
    };

    const opts: RunOpts = {
      fixturesDir,
      outDir,
      profileIds: ['baseline'],
      live: false,
      judge: false,
      judgeModel: 'x',
    };

    const result = await runEval(deps, opts);

    // totalCostUsd should be a number (haiku is priced) or null
    expect(result.totalCostUsd === null || typeof result.totalCostUsd === 'number').toBe(true);
  });

  it('processes both fixture files (two projects)', async () => {
    const deps: EvalDeps = {
      engine: null as never,
      llm: stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' }),
      config: makeConfig(),
    };

    const opts: RunOpts = {
      fixturesDir,
      outDir,
      profileIds: ['baseline'],
      live: false,
      judge: false,
      judgeModel: 'x',
    };

    await runEval(deps, opts);

    // Check that report.json contains both project names
    const reportJsonPath = join(outDir, 'report.json');
    const { readFileSync } = await import('node:fs');
    const parsed = JSON.parse(readFileSync(reportJsonPath, 'utf-8')) as {
      byProject: Array<{ project: string }>;
    };
    expect(parsed.byProject).toHaveLength(2);
    const titles = parsed.byProject.map((p) => p.project).sort();
    expect(titles).toContain('Alpha Project');
    expect(titles).toContain('Beta Project');
  });

  it('creates the outDir if it does not exist', async () => {
    const newOutDir = join(tmpdir(), `eval-out-new-${Date.now()}`);
    const deps: EvalDeps = {
      engine: null as never,
      llm: stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' }),
      config: makeConfig(),
    };

    const opts: RunOpts = {
      fixturesDir,
      outDir: newOutDir,
      profileIds: ['baseline'],
      live: false,
      judge: false,
      judgeModel: 'x',
    };

    try {
      await runEval(deps, opts);
      expect(existsSync(join(newOutDir, 'report.html'))).toBe(true);
    } finally {
      rmSync(newOutDir, { recursive: true, force: true });
    }
  });

  it('auto-includes the anchor model when opts.models lacks config.model', async () => {
    const deps: EvalDeps = {
      engine: null as never,
      llm: stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' }),
      config: makeConfig(),
    };

    const opts: RunOpts = {
      fixturesDir,
      outDir,
      profileIds: ['baseline'],
      models: [{ model: 'qwen-test-model', label: 'qwen-test' }],
      live: false,
      judge: false,
      judgeModel: 'x',
    };

    await runEval(deps, opts);

    const { readFileSync } = await import('node:fs');
    const parsed = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf-8')) as {
      byProject: Array<{ variants: Array<{ run: { variantId: string; model: string } }> }>;
    };
    const variantIds = parsed.byProject[0]?.variants.map((v) => v.run.variantId).sort();
    expect(variantIds).toEqual(['baseline @ claude-haiku-4-5', 'baseline @ qwen-test']);
  });
});

describe('runEval — double-pass judging', () => {
  let fixturesDir: string;
  let outDir: string;

  beforeEach(() => {
    fixturesDir = mkdtempSync(join(tmpdir(), 'eval-fixtures-'));
    outDir = mkdtempSync(join(tmpdir(), 'eval-out-'));
    writeFixture(fixturesDir, makeFixture('Alpha Project'));
  });

  afterEach(() => {
    rmSync(fixturesDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  function makeOpts(): RunOpts {
    return {
      fixturesDir,
      outDir,
      profileIds: ['baseline'],
      models: [{ model: 'qwen-test-model', label: 'qwen-test' }],
      live: false,
      judge: true,
      judgeModel: 'judge-model',
    };
  }

  async function readReport(): Promise<{
    byProject: Array<{
      judgements?: Array<{ aId: string; bId: string; orderSplit?: boolean; verdict: { overall: string } }>;
    }>;
    scoreboard?: { wins: Record<string, number>; ties: number; pairs: number };
  }> {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf-8'));
  }

  it('judges each candidate twice with positions swapped', async () => {
    const { llm, reqs } = dispatchLlm(() => ({ overall: 'tie', criteria: {} }));
    await runEval({ engine: null as never, llm, config: makeConfig() }, makeOpts());

    const judgeReqs = reqs.filter((r) => r.toolName === 'emit_verdict');
    expect(judgeReqs).toHaveLength(2);
    // pass 1: anchor (claude-haiku-4-5 output) in position A
    const firstA = (judgeReqs[0]?.user ?? '').split('## Output B')[0] ?? '';
    expect(firstA).toContain('made by claude-haiku-4-5');
    // pass 2: candidate in position A
    const secondA = (judgeReqs[1]?.user ?? '').split('## Output B')[0] ?? '';
    expect(secondA).toContain('made by qwen-test-model');
  });

  it('flags orderSplit when a constant positional verdict flips winners across passes', async () => {
    // overall 'A' always: pass 1 → anchor wins, pass 2 → candidate wins ⇒ split
    const { llm } = dispatchLlm(() => ({ overall: 'A', criteria: {} }));
    await runEval({ engine: null as never, llm, config: makeConfig() }, makeOpts());

    const report = await readReport();
    const judgements = report.byProject[0]?.judgements ?? [];
    expect(judgements).toHaveLength(2);
    expect(judgements[0]?.orderSplit).toBe(true);
    expect(judgements[1]?.orderSplit).toBe(true);
    // both passes count as pairs; the two wins cancel into a 1-1 scoreboard
    expect(report.scoreboard?.pairs).toBe(2);
    expect(report.scoreboard?.wins['baseline @ claude-haiku-4-5']).toBe(1);
    expect(report.scoreboard?.wins['baseline @ qwen-test']).toBe(1);
  });

  it('does not flag orderSplit when the same variant wins both passes', async () => {
    // winner = whichever position holds the candidate output, regardless of order
    const { llm } = dispatchLlm((req) => {
      const aBlock = req.user.split('## Output B')[0] ?? '';
      return { overall: aBlock.includes('made by qwen-test-model') ? 'A' : 'B', criteria: {} };
    });
    await runEval({ engine: null as never, llm, config: makeConfig() }, makeOpts());

    const report = await readReport();
    const judgements = report.byProject[0]?.judgements ?? [];
    expect(judgements).toHaveLength(2);
    expect(judgements[0]?.orderSplit).toBe(false);
    expect(judgements[1]?.orderSplit).toBe(false);
    expect(report.scoreboard?.wins['baseline @ qwen-test']).toBe(2);
    expect(report.scoreboard?.wins['baseline @ claude-haiku-4-5']).toBeUndefined();
  });

  it('judges profile variants against the anchor too (single-model, two profiles)', async () => {
    const { llm, reqs } = dispatchLlm(() => ({ overall: 'tie', criteria: {} }));
    const opts: RunOpts = {
      fixturesDir,
      outDir,
      profileIds: ['baseline', 'candidate'],
      live: false,
      judge: true,
      judgeModel: 'judge-model',
    };
    await runEval({ engine: null as never, llm, config: makeConfig() }, opts);

    // one candidate × two passes
    expect(reqs.filter((r) => r.toolName === 'emit_verdict')).toHaveLength(2);
  });

  it('emits per-variant rollups with cost ratio and judge record in report.json and report.md', async () => {
    const { llm } = dispatchLlm((req) => {
      const aBlock = req.user.split('## Output B')[0] ?? '';
      return { overall: aBlock.includes('made by qwen-test-model') ? 'A' : 'B', criteria: {} };
    });
    await runEval({ engine: null as never, llm, config: makeConfig() }, makeOpts());

    const { readFileSync } = await import('node:fs');
    const parsed = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf-8')) as {
      anchorVariantId?: string;
      rollups?: Array<{ variantId: string; runs: number; judge: { wins: number } | null; costVsAnchor: number | null }>;
    };
    expect(parsed.anchorVariantId).toBe('baseline @ claude-haiku-4-5');
    expect(parsed.rollups).toHaveLength(2);
    expect(parsed.rollups?.[0]?.variantId).toBe('baseline @ claude-haiku-4-5');
    expect(parsed.rollups?.[0]?.judge).toBeNull();
    expect(parsed.rollups?.[1]?.judge?.wins).toBe(2);

    const md = readFileSync(join(outDir, 'report.md'), 'utf-8');
    expect(md).toContain('## Variants');
    expect(md).toContain('baseline @ qwen-test');
  });

  it('warns and skips judging when no baseline anchor variant exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { llm, reqs } = dispatchLlm(() => ({ overall: 'tie', criteria: {} }));
      // candidate only: two variants (both models), neither from the baseline profile
      const opts: RunOpts = { ...makeOpts(), profileIds: ['candidate'] };
      await runEval({ engine: null as never, llm, config: makeConfig() }, opts);

      expect(reqs.filter((r) => r.toolName === 'emit_verdict')).toHaveLength(0);
      const report = await readReport();
      expect(report.byProject[0]?.judgements ?? []).toHaveLength(0);
      expect(report.scoreboard).toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain('no anchor variant');
    } finally {
      warn.mockRestore();
    }
  });
});
