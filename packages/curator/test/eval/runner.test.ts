import { describe, it, expect } from 'vitest';
import { runVariant, runMatrix } from '../../src/eval/runner.js';
import type { EvalModel } from '../../src/eval/runner.js';
import type { EvalFixture } from '../../src/eval/corpus.js';
import type { SynthesisProfile } from '../../src/eval/profile.js';
import type { LlmClient, StructuredCallRequest } from '../../src/llm/types.js';
import type { ProjectEvidence } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function stubLlm(output: unknown): LlmClient {
  return {
    configurationFor: () => ({ provider: 'anthropic', reasoningEffort: null }),
    withConfiguration() { return this; },
    structuredCall: async () => ({
      output,
      usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 },
    }),
  };
}

function makeEvidence(): ProjectEvidence {
  return {
    project: { id: 'proj-1', title: 'Vault Curator', file_path: 'Vault Curator.md', status: 'active' },
    tasks: {
      overdue: [],
      blocked: [],
      open: [{ id: 't1', title: 'Write tests', status: 'open', due: null }],
      upcoming: [],
      backlog: [],
      done_recent: [],
    },
    notes: [{ id: 'n1', title: 'Architecture Overview', file_mtime: null }],
    signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
    existing_wiki: { home_id: null, subpages: [] },
    synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
    meetings: { recent: [], upcoming: [] },
    contacts: { people: [], companies: [] },
    evidence_hash: 'ev-hash-1',
    generated_at: '2026-06-17T00:00:00Z',
  };
}

function makeFixture(): EvalFixture {
  return {
    project: { id: 'proj-1', title: 'Vault Curator', file_path: 'Vault Curator.md', status: 'active' },
    evidence: makeEvidence(),
    readNodes: [],
    candidates: [],
  };
}

function makeProfile(id: string): SynthesisProfile {
  return {
    id,
    systemPrompt: 'SYS',
    maxTokens: 100, homeReasoningEffort: 'inherit', homeReasoningBudget: 0,
    bodyCharCap: null,
    gapFill: false,
  };
}

const HAIKU: EvalModel = { model: 'claude-haiku-4-5', label: 'claude-haiku-4-5' };

// ---------------------------------------------------------------------------
// runVariant
// ---------------------------------------------------------------------------
describe('runVariant', () => {
  it('resolves inherited effort from each model on the evaluation axis', async () => {
    const bindings: unknown[] = [], calls: StructuredCallRequest[] = [];
    const llm: LlmClient = {
      configurationFor: model => model === 'native' ? { provider: 'anthropic', reasoningEffort: null }
        : { provider: 'openrouter', reasoningEffort: 'high' },
      withConfiguration(configuration) { bindings.push(configuration); return this; },
      structuredCall: async request => { calls.push(request); return { output: { now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' },
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }; },
    };
    for (const model of ['native', 'router']) await runVariant(llm, makeFixture(), { ...makeProfile('trial'), maxTokens: 16000 }, { model, label: model }, model);
    expect(bindings).toEqual([{ provider: 'anthropic', reasoningEffort: null }, { provider: 'openrouter', reasoningEffort: 'high' }]);
    expect(calls.map(c => [c.model, c.maxTokens])).toEqual([['native', 16000], ['router', 16000]]);
  });
  it('returns correct profileId and project from the fixture', async () => {
    const fixture = makeFixture();
    const profile = makeProfile('baseline');
    const llm = stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' });

    const result = await runVariant(llm, fixture, profile, HAIKU, profile.id);

    expect(result.profileId).toBe('baseline');
    expect(result.project).toBe('Vault Curator');
  });

  it('maps stub LLM output to sections.now', async () => {
    const fixture = makeFixture();
    const profile = makeProfile('baseline');
    const llm = stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' });

    const result = await runVariant(llm, fixture, profile, HAIKU, profile.id);

    expect(result.sections.now).toBe('N');
  });

  it('returns a numeric costUsd for a priced model (claude-haiku-4-5)', async () => {
    const fixture = makeFixture();
    const profile = makeProfile('baseline');
    const llm = stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' });

    const result = await runVariant(llm, fixture, profile, HAIKU, profile.id);

    expect(typeof result.costUsd).toBe('number');
    expect(result.costUsd).not.toBeNull();
  });

  it('returns evidenceChars > 0 since fixture has tasks and notes', async () => {
    const fixture = makeFixture();
    const profile = makeProfile('baseline');
    const llm = stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' });

    const result = await runVariant(llm, fixture, profile, HAIKU, profile.id);

    expect(result.evidenceChars).toBeGreaterThan(0);
  });

  it('passes the profile systemPrompt to the LLM with date line appended', async () => {
    const fixture = makeFixture();
    const profile = makeProfile('baseline');
    const capturedReqs: StructuredCallRequest[] = [];
    const llm: LlmClient = {
      configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
      withConfiguration() { return this; },
      structuredCall: async (req) => {
        capturedReqs.push(req);
        return {
          output: { now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' },
          usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 },
        };
      },
    };

    await runVariant(llm, fixture, profile, HAIKU, 'baseline');

    expect(capturedReqs).toHaveLength(1);
    expect(capturedReqs[0]?.system.startsWith('SYS')).toBe(true);
    expect(capturedReqs[0]?.system).toMatch(/\n\nToday is [A-Z][a-z]+day, \d{4}-\d{2}-\d{2} \(.+\)\.$/);
    expect(capturedReqs[0]?.model).toBe('claude-haiku-4-5');
  });

  it('excludes candidates when gapFill is false', async () => {
    const evidenceWithCandidate = makeEvidence();
    const fixture: EvalFixture = {
      ...makeFixture(),
      evidence: evidenceWithCandidate,
      candidates: [{ id: 'cand-1', title: 'Some Related Thing', types: [], status: null }],
    };
    const profile: SynthesisProfile = { ...makeProfile('no-gap'), gapFill: false };
    const capturedReqs: StructuredCallRequest[] = [];
    const llm: LlmClient = {
      configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
      withConfiguration() { return this; },
      structuredCall: async (req) => {
        capturedReqs.push(req);
        return {
          output: { now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' },
          usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 },
        };
      },
    };

    await runVariant(llm, fixture, profile, HAIKU, 'no-gap');

    const userText = capturedReqs[0]?.user ?? '';
    expect(userText).not.toContain('Some Related Thing');
  });
});

// ---------------------------------------------------------------------------
// runMatrix
// ---------------------------------------------------------------------------
describe('runMatrix', () => {
  it('returns 2 outputs for 1 fixture × 2 profiles', async () => {
    const fixture = makeFixture();
    const p1 = makeProfile('p1');
    const p2 = makeProfile('p2');
    const llm = stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' });

    const results = await runMatrix(llm, [fixture], [p1, p2], [HAIKU]);

    expect(results).toHaveLength(2);
  });

  it('produces one output per fixture×profile combination', async () => {
    const f1 = makeFixture();
    const f2: EvalFixture = { ...makeFixture(), project: { ...makeFixture().project, id: 'proj-2', title: 'Other Project' } };
    const p1 = makeProfile('p1');
    const p2 = makeProfile('p2');
    const llm = stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' });

    const results = await runMatrix(llm, [f1, f2], [p1, p2], [HAIKU]);

    expect(results).toHaveLength(4);
  });

  it('returns empty array for no fixtures', async () => {
    const p1 = makeProfile('p1');
    const llm = stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' });

    const results = await runMatrix(llm, [], [p1], [HAIKU]);

    expect(results).toHaveLength(0);
  });

  it('returns empty array for no profiles', async () => {
    const fixture = makeFixture();
    const llm = stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' });

    const results = await runMatrix(llm, [fixture], [], [HAIKU]);

    expect(results).toHaveLength(0);
  });

  it('produces one output per fixture×profile×model combination', async () => {
    const fixture = makeFixture();
    const p1 = makeProfile('p1');
    const m2: EvalModel = { model: 'accounts/fireworks/models/qwen3p7-plus', label: 'Qwen 3.7 Plus' };
    const llm = stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' });

    const results = await runMatrix(llm, [fixture], [p1], [HAIKU, m2]);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.model)).toEqual(['claude-haiku-4-5', 'accounts/fireworks/models/qwen3p7-plus']);
  });

  it('dispatches each model id to the LLM', async () => {
    const fixture = makeFixture();
    const p1 = makeProfile('p1');
    const m2: EvalModel = { model: 'model-two', label: 'Two' };
    const capturedReqs: StructuredCallRequest[] = [];
    const llm: LlmClient = {
      configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
      withConfiguration() { return this; },
      structuredCall: async (req) => {
        capturedReqs.push(req);
        return {
          output: { now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' },
          usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 },
        };
      },
    };

    await runMatrix(llm, [fixture], [p1], [HAIKU, m2]);

    expect(capturedReqs.map((r) => r.model)).toEqual(['claude-haiku-4-5', 'model-two']);
  });

  it('uses plain profileId as variantId in single-model runs', async () => {
    const fixture = makeFixture();
    const llm = stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' });

    const results = await runMatrix(llm, [fixture], [makeProfile('baseline')], [HAIKU]);

    expect(results[0]?.variantId).toBe('baseline');
  });

  it('uses composite "profile @ label" variantIds in multi-model runs', async () => {
    const fixture = makeFixture();
    const m2: EvalModel = { model: 'model-two', label: 'Two' };
    const llm = stubLlm({ now: 'N', focus: [{ title: 'F' }], open_threads: [{ title: 'O' }], log_entry: 'L' });

    const results = await runMatrix(llm, [fixture], [makeProfile('baseline')], [HAIKU, m2]);

    expect(results.map((r) => r.variantId)).toEqual(['baseline @ claude-haiku-4-5', 'baseline @ Two']);
  });
});
