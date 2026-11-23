import { pageOutputFrame } from './page-output-fixtures.js';
import { expect, it } from 'vitest';
import type OpenAI from 'openai';
import { EngineError, type Engine, type WikiReconcileInput } from '../src/engine.js';
import { runReconciliationPipeline, type HomeBudgetContext } from '../src/reconciliation-pipeline.js';
import { EvidenceCollector, canonical, capturedBundle, HOME_BUDGET_ASSEMBLY } from '../src/provenance-evidence.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { buildHomeRequest } from '../src/home-request.js';
import { curateResultToRunRow } from '../src/db/runs.js';
import type { Config } from '../src/config.js';
import type { PrepareRequest } from '../src/provenance-types.js';
import type { ExistingWiki } from '../src/types.js';
import { observedNode } from './provenance-page-fixtures.js';

async function fixture(options: { indexOverflow?: boolean; previewError?: Error; actualError?: Error; mutatePayload?: boolean;
  previewThrows?: boolean; failPage?: boolean } = {}) {
  const events: string[] = [];
  const scope = { v: 1 as const, subject: 'Project', facet: 'Decisions' };
  const existingWiki: ExistingWiki = { home_id: null, home: null, topology_hash: 'topology', catalog_valid: true,
    subpages: [{ id: 'page', title: 'Project — Decisions', file_path: 'Page.md', version: 1, content_hash: 'hash',
      wiki_state: 'active', wiki_kind: 'decision-log', wiki_origin: 'automatic', wiki_scope: scope, wiki_pinned: false }] };
  const adapter = new OpenAiCompatLlmClient({ chat: { completions: { create: async (payload: any) => {
    const name = payload.response_format?.json_schema.name;
    events.push(name === 'emit_topology_plan' ? 'planner' : name === 'emit_wiki_sections' ? 'home' : 'page');
    if (!name && options.failPage) throw new Error('page unavailable');
    const output = name === 'emit_topology_plan' ? { reviewed_page_ids: ['page'], actions: [
      { op: 'refresh', node_id: 'page', scope, synthesis_brief: 'Refresh decisions.' },
    ] } : name === 'emit_wiki_sections' ? { now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Log' }
      : { body: '## Decisions\n\nThe team chose this path.' };
    return { choices: [{ message: { content: name ? JSON.stringify(output) : pageOutputFrame(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  } } } } as unknown as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
  const collector = new EvidenceCollector({});
  const homeBudget: HomeBudgetContext = { generatedAt: new Date('2026-09-18T12:00:00Z'), model: 'model', system: 'sys', maxTokens: 4000,
    limits: { componentBytes: 262144, itemCount: 512, requestBytes: 1048576, totalBytes: 2097152 },
    omissionCounts: { gap_fill_component_budget: 1 } };
  if (options.indexOverflow) {
    const base = await adapter.previewStructuredCall({ ...buildHomeRequest({ ...homeBudget, evidence: 'Evidence', pageIndex: [] }),
      malformedOutputPolicy: 'fail-closed-redacted' });
    homeBudget.limits.requestBytes = Buffer.byteLength(canonical(capturedBundle(base, collector, HOME_BUDGET_ASSEMBLY).provider_payload));
  }
  let captureIndex = 0;
  const engine = {
    getNode: async () => observedNode('page', 'Existing page', 1),
    prepareProvenance: async (request: PrepareRequest) => {
      events.push(request.dry_run ? 'preview' : `prepare:${request.flow ?? 'home'}`);
      if (request.dry_run && options.previewError) throw options.previewError;
      if (!request.dry_run && !request.flow && options.actualError) throw options.actualError;
      if (request.dry_run) return { dry_run: true, bundle_digest: 'digest', payload_bytes: 1, reserved_bytes: 2, item_count: 3 };
      return { derivation_id: `derivation-${++captureIndex}`, bundle_digest: 'digest', state: 'prepared', availability: 'retained', lease_expires_at: '2026-09-19T00:00:00Z' };
    },
    transitionProvenance: async () => { events.push('mark-sent'); return {}; },
    stageProvenanceResult: async (request: { derivation_id: string }) => { events.push('stage'); return { derivation_id: request.derivation_id, bundle_digest: 'digest', contribution_digest: 'contribution' }; },
    inspectProvenance: async (request: { select: string }) => request.select === 'status'
      ? { select: 'status', capability_version: 1, capture_features: ['project-subpage-v1', 'multi-output-reconcile-v1'],
        vault_namespace: 'test', limits: {}, actual_bytes: 0, reserved_bytes: 0, purge_restore_verification: 'unverified' }
      : { select: 'attempt', attempt: null },
    wikiReconcile: async (input: WikiReconcileInput) => {
      events.push(input.dry_run ? 'wiki-preview' : 'wiki-write');
      const receipts = input.dry_run ? undefined : [input.home.provenance, ...input.pages.flatMap(page => 'provenance' in page ? [page.provenance] : [])]
        .filter((binding): binding is NonNullable<typeof binding> => binding !== undefined).map((binding, index) => ({
          derivation_id: binding.derivation_id, output_revision_id: `output-${index}`, output_node_id: index === 0 ? 'home' : 'page',
          committed_node_version: index === 0 ? 1 : 2, committed_at: '2026-09-18T12:00:00.000Z', operation_id: 'operation',
          reconcile_key: input.reconcile_key, request_digest: 'request',
        }));
      return { data: { operation_id: input.dry_run ? null : 'operation', reconcile_key: input.reconcile_key, plan_digest: 'digest', reused: false,
        dry_run: input.dry_run === true, created: [], updated: [{ node_id: 'page', title: 'Project — Decisions', file_path: 'Page.md', version: 2 }], mappings: [], topology_hash: 'new', warnings: [], preview: { total: 0, items: [], truncated: false },
        home: { node_id: 'home', title: 'Project Wiki', file_path: 'Home.md', version: 1, created: true },
        ...(receipts ? { provenance_receipt: receipts[0], provenance_receipts: receipts } : {}) }, warnings: [] };
    },
  } as unknown as Engine;
  const llm = {
    configurationFor: adapter.configurationFor.bind(adapter),
    withConfiguration() { return this; },
    supportsPreparedCapture: true as const,
    previewStructuredCall: async (req: Parameters<typeof adapter.previewStructuredCall>[0]) => {
      if (options.previewThrows) throw new Error('PRIVATE SOURCE TITLE AND BODY');
      return adapter.previewStructuredCall(req);
    },
    structuredCall: async (req: Parameters<typeof adapter.structuredCall>[0]) => adapter.structuredCall(
      options.mutatePayload && req.onPrepared && req.toolName === 'emit_wiki_sections' ? { ...req, user: req.user + ' ' } : req),
  };
  const config = { wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0, wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit', model: 'model', homeMaxTokens: 4000, bodyCharCap: null } as Config;
  const result = await runReconciliationPipeline({ engine, llm, config, project: 'Project', rootTitle: 'Project', wikiRootId: 'p',
    evidenceHash: 'evidence', existingWiki, dryRun: false, force: true, provenanceRunRef: 'run',
    prepareEvidence: async () => ({ text: 'Evidence', nodes: [], provenance: collector, homeBudget }) });
  return { events, result: result.result };
}

it('checks the real page index before page synthesis and preserves paid planning usage', async () => {
  const f = await fixture({ indexOverflow: true });
  expect(f.events).toEqual(['planner']);
  expect(f.result.detail).toContain('stage=preflight dimension=request');
  expect(f.result.usage?.input).toBe(10);
});

it('preflights before page synthesis, captures before home dispatch and stores omission counts', async () => {
  const f = await fixture();
  expect(f.result.outcome).toBe('written');
  expect(f.events).toEqual(['planner', 'preview', 'prepare:project-subpage-v1', 'mark-sent', 'page', 'stage',
    'prepare:home', 'mark-sent', 'home', 'stage', 'wiki-preview', 'wiki-write']);
  expect(f.result.detail).toContain('gap_fill_component_budget=1');
  const row = curateResultToRunRow(f.result, { ts: '2026-09-18T00:00:00Z', trigger: 'on-demand', durationMs: 1 });
  expect(row.topology_json).toContain('gap_fill_component_budget=1');
});

it.each(['PROVENANCE_CAPACITY', 'PROVENANCE_OBSERVATION_CHANGED', 'PROVENANCE_LIMIT'])('keeps %s separate from optional-size omission', async reason => {
  const f = await fixture({ previewError: new EngineError('VALIDATION_FAILED', 'PRIVATE ERROR', { reason }) });
  expect(f.events).toEqual(['planner', 'preview']);
  expect(f.result.detail).toContain(reason);
  expect(f.result.detail).not.toContain('PRIVATE');
  expect(f.result.usage?.input).toBe(10);
});

it('rejects payload drift before actual prepare or home dispatch', async () => {
  const f = await fixture({ mutatePayload: true });
  expect(f.events).toEqual(['planner', 'preview', 'prepare:project-subpage-v1', 'mark-sent', 'page', 'stage']);
  expect(f.result.detail).toContain('PROVENANCE_PREVIEW_MISMATCH');
  expect(f.result.usage?.input).toBe(20);
});

it('projects unexpected preview errors without revealing input or provider content', async () => {
  const f = await fixture({ previewThrows: true });
  expect(f.events).toEqual(['planner']);
  expect(f.result.detail).toContain('PROVENANCE_UNAVAILABLE');
  expect(f.result.detail).not.toContain('PRIVATE');
});

it('revalidates limits at actual prepare after preview and reports preceding paid work', async () => {
  const f = await fixture({ actualError: new EngineError('INVALID_PARAMS', 'PRIVATE ERROR', { reason: 'PROVENANCE_LIMIT' }) });
  expect(f.events).toEqual(['planner', 'preview', 'prepare:project-subpage-v1', 'mark-sent', 'page', 'stage', 'prepare:home']);
  expect(f.result.detail).toContain('PROVENANCE_LIMIT');
  expect(f.result.usage?.input).toBe(20);
});

it('does not reserve or stamp after a page synthesis failure following preview', async () => {
  const f = await fixture({ failPage: true });
  expect(f.result.outcome).toBe('error');
  expect(f.events).toContain('page');
  expect(f.events).not.toContain('wiki-write');
  expect(f.result.detail).toContain('gap_fill_component_budget=1');
});
