import { pageOutputFrame } from './page-output-fixtures.js';
import { expect, it } from 'vitest';
import type OpenAI from 'openai';
import { EngineError, type Engine, type WikiReconcileInput } from '../src/engine.js';
import { runReconciliationPipeline, type HomeBudgetContext } from '../src/reconciliation-pipeline.js';
import { EvidenceCollector } from '../src/provenance-evidence.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import type { Config } from '../src/config.js';
import type { PrepareRequest, StageRequest } from '../src/provenance-types.js';
import type { ExistingWiki } from '../src/types.js';

const scope = (facet: string) => ({ v: 1 as const, subject: 'Project', facet });
const existingWiki: ExistingWiki = { home_id: null, home: null, topology_hash: 'old', catalog_valid: true, subpages: [] };
const generatedAt = new Date('2026-09-18T12:00:00Z');

async function fixture(options: { features?: string[]; failPageAt?: number; capacityAt?: number; unchanged?: boolean;
  trial?: boolean; tracked?: boolean; lostCommit?: boolean; providerUnsupported?: boolean; metadataActions?: boolean;
  /** How many times the home's capture is refused because its evidence changed mid-build. */
  homeEvidenceChanged?: number; freshReadFails?: boolean } = {}) {
  const events: string[] = [];
  const payloads: any[] = [];
  const prepares: PrepareRequest[] = [];
  const stages: StageRequest[] = [];
  const writes: WikiReconcileInput[] = [];
  let statusInspections = 0;
  let evidencePreparations = 0;
  const freshReads: boolean[] = [];
  let waits = 0;
  let homeEvidenceChanged = options.homeEvidenceChanged ?? 0;
  const attempts = new Map<string, { derivation: string; state: 'prepared' | 'result_staged' | 'committed' | 'failed' }>();
  const wiki: ExistingWiki = options.metadataActions ? { ...existingWiki, subpages: [
    { id: 'kept', title: 'Kept', file_path: 'Kept.md', version: 1, content_hash: 'kept', wiki_state: 'active',
      wiki_kind: 'workstream', wiki_origin: 'automatic', wiki_scope: scope('Kept'), wiki_pinned: false },
    { id: 'retired', title: 'Retired', file_path: 'Retired.md', version: 1, content_hash: 'retired', wiki_state: 'active',
      wiki_kind: 'workstream', wiki_origin: 'automatic', wiki_scope: scope('Retired'), wiki_pinned: false },
  ] } : existingWiki;
  const adapter = new OpenAiCompatLlmClient({ chat: { completions: { create: async (payload: any) => {
    payloads.push(payload);
    const name = payload.response_format?.json_schema.name;
    events.push(name === 'emit_topology_plan' ? 'planner' : name === 'emit_scope_adjudication' ? 'adjudicator'
      : name === 'emit_wiki_sections' ? 'home' : 'page');
    const user = JSON.parse(payload.messages.at(-1).content);
    const output = name === 'emit_scope_adjudication' ? { verdicts: user.comparisons.map((pair: any) => ({
      pair_id: pair.pair_id, candidate_plan_key: pair.candidate_plan_key, compared_to: pair.compared_to,
      relation: 'distinct', confidence: 0.95, evidence_ids: [], reason: 'Independent scopes.', narrower: 'none',
    })) } : name === 'emit_topology_plan' ? { reviewed_page_ids: options.metadataActions ? ['kept', 'retired'] : [], actions: [
      ...(options.metadataActions ? [{ op: 'keep', node_id: 'kept', scope: scope('Kept') },
        { op: 'retire', node_id: 'retired', scope: scope('Retired'), state: 'retired', reason: 'Finished.' }] : []),
      { op: 'create', plan_key: 'first', title: 'Project — First', kind: 'workstream', scope: scope('First'), synthesis_brief: 'First.' },
      { op: 'create', plan_key: 'second', title: 'Project — Second', kind: 'workstream', scope: scope('Second'), synthesis_brief: 'Second.' },
    ] } : name === 'emit_wiki_sections' ? { now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Log' }
      : { body: '## Summary\n\nPage body.' };
    return { choices: [{ message: { content: name ? JSON.stringify(output) : pageOutputFrame(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  } } } } as unknown as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
  const engine = {
    inspectProvenance: async (request: { select: string; attempt_key?: string }) => request.select === 'status'
      ? (statusInspections++, { select: 'status', capability_version: 1, capture_features: options.features ?? ['project-subpage-v1', 'multi-output-reconcile-v1'],
        vault_namespace: 'test', limits: {}, actual_bytes: 0, reserved_bytes: 0, purge_restore_verification: 'unverified' })
      : { select: 'attempt', attempt: request.attempt_key && attempts.has(request.attempt_key)
        ? { state: attempts.get(request.attempt_key)!.state, availability: 'retained' } : null },
    prepareProvenance: async (request: PrepareRequest) => {
      events.push(request.dry_run ? 'preview' : `prepare:${request.flow ?? 'home'}`);
      if (!request.dry_run && options.capacityAt === prepares.length + 1) throw new Error('PROVENANCE_CAPACITY');
      if (!request.dry_run && request.flow !== 'project-subpage-v1' && homeEvidenceChanged > 0) {
        homeEvidenceChanged -= 1;
        throw new EngineError('STALE_NODE', 'Changed', { reason: 'PROVENANCE_OBSERVATION_CHANGED' });
      }
      if (request.dry_run) return { dry_run: true, bundle_digest: 'digest', payload_bytes: 1, reserved_bytes: 2, item_count: 0 };
      prepares.push(request);
      const derivation = `derivation-${prepares.length}`;
      attempts.set(request.attempt_key, { derivation, state: 'prepared' });
      return { derivation_id: derivation, bundle_digest: 'digest', state: 'prepared', availability: 'retained', lease_expires_at: '2026-09-19T00:00:00Z' };
    },
    transitionProvenance: async (request: { derivation_id: string; action: string }) => {
      events.push(request.action);
      const attempt = [...attempts.values()].find(item => item.derivation === request.derivation_id);
      if (attempt && request.action === 'fail') attempt.state = 'failed';
      return {};
    },
    stageProvenanceResult: async (request: StageRequest) => {
      events.push('stage');
      stages.push(request);
      if (options.failPageAt === stages.length) throw new Error('PROVENANCE_CAPACITY');
      const attempt = [...attempts.values()].find(item => item.derivation === request.derivation_id);
      if (attempt) attempt.state = 'result_staged';
      return { derivation_id: request.derivation_id, bundle_digest: request.bundle_digest, contribution_digest: `contribution-${stages.length}` };
    },
    getNode: async () => { throw new Error('unexpected node read'); },
    wikiReconcile: async (request: WikiReconcileInput) => {
      writes.push(request);
      if (request.dry_run !== true && options.lostCommit) {
        for (const attempt of attempts.values()) attempt.state = 'committed';
        throw new Error('lost response after commit');
      }
      const committed = request.dry_run !== true;
      const receipts = committed ? [request.home.provenance, ...request.pages.flatMap(page => 'provenance' in page ? [page.provenance] : [])]
        .filter((binding): binding is NonNullable<typeof binding> => binding !== undefined).map((binding, index) => ({
          derivation_id: binding.derivation_id, output_revision_id: `output-${index}`, output_node_id: index === 0 ? 'home' : `page-${index}`,
          committed_node_version: 1, committed_at: generatedAt.toISOString(), operation_id: 'operation', reconcile_key: request.reconcile_key,
          request_digest: 'digest',
        })) : undefined;
      return { data: { operation_id: committed ? 'operation' : null, reconcile_key: request.reconcile_key, plan_digest: 'digest', reused: false,
        dry_run: !committed, created: request.pages.filter(page => page.op !== 'retire').map((page, index) => ({
          node_id: committed ? `page-${index + 1}` : `plan:${page.target.mode === 'new' ? page.target.plan_key : ''}`,
          title: page.target.mode === 'new' ? page.target.title : '', file_path: `Page-${index}.md`, version: 1,
        })), updated: [], mappings: [], topology_hash: 'new', warnings: [], preview: { total: 0, items: [], truncated: false },
        home: { node_id: 'home', title: 'Project Wiki', file_path: 'Home.md', version: 1, created: true },
        ...(receipts ? { provenance_receipt: receipts[0], provenance_receipts: receipts } : {}) }, warnings: [] };
    },
  } as unknown as Engine;
  const llm = {
    configurationFor: adapter.configurationFor.bind(adapter),
    withConfiguration() { return this; }, ...(options.providerUnsupported ? {} : { supportsPreparedCapture: true as const }),
    previewStructuredCall: adapter.previewStructuredCall.bind(adapter),
    structuredCall: adapter.structuredCall.bind(adapter) };
  const homeBudget: HomeBudgetContext = { generatedAt, model: 'model', system: 'sys', maxTokens: options.trial ? 16000 : 4000,
    limits: { componentBytes: 262144, itemCount: 512, requestBytes: 1048576, totalBytes: 2097152 }, omissionCounts: {} };
  const result = await runReconciliationPipeline({ engine, llm: options.trial ? adapter : llm, config: { wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0, wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit', model: 'model', homeMaxTokens: 4000, bodyCharCap: null, ...(options.trial ? { wikiPlanningMaxTokens: 24000, wikiPageMaxTokens: 32000, wikiHomeMaxTokens: 16000, wikiPlanningReasoningEffort: 'medium', wikiPageReasoningEffort: 'low', wikiHomeReasoningEffort: 'low' } : {}) } as Config,
    project: 'Project', rootTitle: 'Project', wikiRootId: 'p', evidenceHash: 'hash', existingWiki: options.unchanged
      ? { ...wiki, home: { id: 'home', version: 1, wiki_curated_at: generatedAt.toISOString(), wiki_evidence_hash: 'hash', wiki_topology_hash: 'old' } } : wiki,
    dryRun: false, force: false, ...(options.tracked === false ? {} : { provenanceRunRef: 'run' }),
    waitBeforeHomeRetry: async () => { waits += 1; },
    prepareEvidence: async (_policy, read) => { evidencePreparations += 1; freshReads.push(read?.fresh === true);
      if (read?.fresh && options.freshReadFails) throw new Error('Engine unreachable');
      return { text: 'Evidence', nodes: [],
      ...(options.tracked === false ? {} : { provenance: new EvidenceCollector({}), homeBudget }) }; } });
  return { result: result.result, payloads, events, prepares, stages, writes, attempts, statusInspections, evidencePreparations, freshReads, waits };
}

it('captures two created pages and the home before one governed publication', async () => {
  const f = await fixture();
  expect(f.result.outcome).toBe('written');
  expect(f.prepares.map(request => request.flow ?? 'project-home-v1')).toEqual(['project-subpage-v1', 'project-subpage-v1', 'project-home-v1']);
  expect(f.stages).toHaveLength(3);
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1]?.provenance_mode).toBe('project-subpage-v1');
  expect(f.writes[1]?.pages.map(page => 'provenance' in page ? page.provenance?.derivation_id : undefined)).toEqual(['derivation-1', 'derivation-2']);
  expect(f.writes[1]?.home.curated_at).toBe(generatedAt.toISOString());
  expect(f.stages.map(stage => stage.generated_at)).toEqual([generatedAt.toISOString(), generatedAt.toISOString(), generatedAt.toISOString()]);
  expect(f.result.topologyAudit?.provenanceReceipts).toHaveLength(3);
  expect(f.result.usage).toMatchObject({ input: 50, output: 10 });
});

it('rejects missing batch capability before planner dispatch', async () => {
  const f = await fixture({ features: ['project-subpage-v1'] });
  expect(f.result.outcome).toBe('error');
  expect(f.events).not.toContain('planner');
  expect(f.evidencePreparations).toBe(0);
  expect(f.prepares).toHaveLength(0);
});

it('cleans earlier safe page reservations when a later page fails', async () => {
  const f = await fixture({ failPageAt: 2 });
  expect(f.result.outcome).toBe('error');
  expect(f.writes).toHaveLength(0);
  expect([...f.attempts.values()].map(attempt => attempt.state)).toEqual(['failed', 'failed']);
});

it('skips unchanged evidence before capability, evidence preparation, or paid calls', async () => {
  const f = await fixture({ unchanged: true });
  expect(f.result.outcome).toBe('skipped');
  expect(f.statusInspections).toBe(0);
  expect(f.evidencePreparations).toBe(0);
  expect(f.events).toEqual([]);
});

it('keeps provenance disabled and topic-style pipeline paths uncaptured', async () => {
  const f = await fixture({ tracked: false });
  expect(f.result.outcome).toBe('written');
  expect(f.statusInspections).toBe(0);
  expect(f.prepares).toHaveLength(0);
  expect(f.stages).toHaveLength(0);
  expect(f.writes[1]?.provenance_mode).toBeUndefined();
});

it('rejects an unsupported provider before planner dispatch', async () => {
  const f = await fixture({ providerUnsupported: true });
  expect(f.result.outcome).toBe('error');
  expect(f.events).toEqual([]);
  expect(f.prepares).toHaveLength(0);
});

it('publishes nothing on later capacity failure and retains earlier paid usage', async () => {
  const f = await fixture({ capacityAt: 2 });
  expect(f.result.outcome).toBe('error');
  expect(f.writes).toHaveLength(0);
  expect(f.prepares).toHaveLength(1);
  expect(f.result.usage?.input).toBeGreaterThan(10);
  expect([...f.attempts.values()].map(attempt => attempt.state)).toEqual(['failed']);
});

it('reads the evidence again and retries the home once when an edit changed it mid-build', async () => {
  const f = await fixture({ homeEvidenceChanged: 1 });
  expect(f.result.outcome).toBe('written');
  expect(f.waits).toBe(1);
  expect(f.freshReads).toEqual([false, true]);
  // The refused capture was turned down before the home's call was sent: the home is paid for once.
  expect(f.events.filter(event => event === 'home')).toHaveLength(1);
  expect(f.prepares.map(request => request.flow ?? 'project-home-v1')).toEqual(['project-subpage-v1', 'project-subpage-v1', 'project-home-v1']);
  expect(f.writes[1]?.pages.map(page => 'provenance' in page ? page.provenance?.derivation_id : undefined)).toEqual(['derivation-1', 'derivation-2']);
  expect(f.writes[1]?.home.provenance?.derivation_id).toBe('derivation-3');
  expect(f.result.detail).toContain("the home's notes changed during the build; read them again and retried the home once");
  expect(f.result.topologyAudit?.warnings).toContain("the home's notes changed during the build; read them again and retried the home once");
});

it('fails the run when the home evidence changes again after the retry', async () => {
  const f = await fixture({ homeEvidenceChanged: 2 });
  expect(f.result.outcome).toBe('error');
  expect(f.result.detail).toContain('home synthesis: PROVENANCE_OBSERVATION_CHANGED');
  expect(f.result.detail).toContain('retried the home once');
  expect(f.waits).toBe(1);
  expect(f.freshReads).toEqual([false, true]);
  expect(f.events).not.toContain('home');
  expect(f.writes).toHaveLength(0);
  expect([...f.attempts.values()].map(attempt => attempt.state)).toEqual(['failed', 'failed']);
});

it('fails the run, saying so, when reading the evidence again for the retry fails', async () => {
  const f = await fixture({ homeEvidenceChanged: 1, freshReadFails: true });
  expect(f.result.outcome).toBe('error');
  expect(f.result.detail).toContain('home synthesis: Engine unreachable');
  expect(f.result.detail).toContain("reading them again for a retry failed");
  expect(f.events).not.toContain('home');
  expect(f.writes).toHaveLength(0);
});

it('does not retry the home for a capture refused for another reason', async () => {
  const f = await fixture({ capacityAt: 3 });
  expect(f.result.outcome).toBe('error');
  expect(f.result.detail).toContain('home synthesis: PROVENANCE_CAPACITY');
  expect(f.waits).toBe(0);
  expect(f.freshReads).toEqual([false]);
});

it('does not mark possibly committed captures failed after a lost commit response', async () => {
  const f = await fixture({ lostCommit: true });
  expect(f.result.outcome).toBe('error');
  expect(f.writes).toHaveLength(2);
  expect([...f.attempts.values()].map(attempt => attempt.state)).toEqual(['committed', 'committed', 'committed']);
  expect(f.events).not.toContain('fail');
});

it('keeps metadata-only keep and retire actions free of model capture', async () => {
  const f = await fixture({ metadataActions: true });
  expect(f.result.outcome).toBe('written');
  expect(f.prepares.map(request => request.flow ?? 'project-home-v1')).toEqual([
    'project-subpage-v1', 'project-subpage-v1', 'project-home-v1',
  ]);
  expect(f.writes[1]?.pages.find(page => page.op === 'retire')).toBeDefined();
  expect(f.events.filter(event => event === 'home' || event === 'page')).toHaveLength(3);
});

it('applies the planning policy to adjudication and matches trial capture payloads', async () => {
  const f = await fixture({ trial: true });
  expect(f.result.outcome).toBe('written');
  expect(f.payloads.map(p => p.max_tokens)).toEqual([24000, 24000, 32000, 32000, 16000]);
  expect(f.payloads.map(p => p.reasoning_effort)).toEqual(['medium', 'medium', 'low', 'low', 'low']);
  expect(f.prepares.map(p => p.bundle.provider_payload)).toEqual(f.payloads.slice(2));
});
