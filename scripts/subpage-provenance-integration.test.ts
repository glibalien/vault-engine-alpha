// Composition-boundary acceptance: real Engine/Curator MCP, disposable SQLite/vault,
// and the actual OpenAI-compatible adapter backed only by a recording provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { bundleFixture } from '../packages/engine/tests/provenance/fixture.js';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type OpenAI from 'openai';
import { pageOutputFrame } from '../packages/curator/test/page-output-fixtures.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestDb } from '../packages/engine/tests/helpers/db.js';
import { createTempVault } from '../packages/engine/tests/helpers/vault.js';
import { executeMutation } from '../packages/engine/src/pipeline/execute.js';
import { WriteLockManager } from '../packages/engine/src/sync/write-lock.js';
import { registerGetNode } from '../packages/engine/src/mcp/tools/get-node.js';
import { registerProjectEvidence } from '../packages/engine/src/mcp/tools/project-evidence.js';
import { registerMemoriesTools } from '../packages/engine/src/mcp/tools/memories.js';
import { MemoryService } from '../packages/engine/src/memories/service.js';
import { registerProvenance } from '../packages/engine/src/mcp/tools/provenance.js';
import { registerWikiReconcile } from '../packages/engine/src/mcp/tools/wiki-reconcile.js';
import { registerQueryNodes } from '../packages/engine/src/mcp/tools/query-nodes.js';
import { registerUpdateNode } from '../packages/engine/src/mcp/tools/update-node.js';
import { registerDeleteNode } from '../packages/engine/src/mcp/tools/delete-node.js';
import { Engine, type WikiReconcileInput, type WikiReconcileResult } from '../packages/curator/src/engine.js';
import { curateProject } from '../packages/curator/src/curate.js';
import { curateOne, type CoreDeps } from '../packages/curator/src/core.js';
import { OpenAiCompatLlmClient } from '../packages/curator/src/llm/openai-compat.js';
import { UsageReporter } from '../packages/curator/src/usage-reporter.js';
import { runMigrations } from '../packages/curator/src/db/migrate.js';
import { registerWikiRoot } from '../packages/curator/src/db/wiki-roots.js';
import { getPageRequest } from '../packages/curator/src/db/requests.js';
import { readRequestExecution, type ActivePageRequestExecution } from '../packages/curator/src/db/request-execution.js';
import { CurationQueue } from '../packages/curator/src/queue.js';
import { curatorServerFactory } from '../packages/curator/src/server-bootstrap.js';
import type { Config } from '../packages/curator/src/config.js';
import type { TopologyPlan } from '../packages/curator/src/types.js';
import type { BundleV1, InputMetadata } from '../packages/curator/src/provenance-types.js';
import { makeClient } from '../packages/query-core/src/client.js';

const scope = (facet: string) => ({ v: 1 as const, subject: 'Project', facet });
const createPlan = (facets: string[]): TopologyPlan => ({ reviewed_page_ids: [], actions: facets.map(facet => ({
  op: 'create', plan_key: facet, title: `Project — ${facet}`, kind: 'workstream', scope: scope(facet), synthesis_brief: `Write ${facet}.`,
})) });
const envelope = (result: unknown) => {
  const text = ((result as { content: Array<{ text: string }> }).content)[0]!.text;
  try { return JSON.parse(text); } catch { throw new Error(text); }
};

async function fixture(configPatch: Record<string, unknown> = {}) {
  const db = createTestDb(), vault = createTempVault(), writeLock = new WriteLockManager();
  const curatorPath = join(vault.vaultPath, 'curator-test.db');
  let curatorDb = new Database(curatorPath); runMigrations(curatorDb);
  // Project wikis exist only when requested.
  registerWikiRoot(curatorDb, { root_title: 'Project', root_node_id: null, kind: 'project', source: 'vault', cadence: null,
    brief: null, created_at: '2026-10-25T00:00:00.000Z', created_by: 'test' });
  db.prepare("INSERT INTO schemas(name,display_name,field_claims) VALUES ('project','Project','[]'),('note','Note','[]')").run();
  const project = executeMutation(db, writeLock, vault.vaultPath, { source: 'tool', node_id: null,
    file_path: 'Project.md', title: 'Project', types: ['project'], fields: { status: 'active' }, body: 'Synthetic project.' });
  const source = executeMutation(db, writeLock, vault.vaultPath, { source: 'tool', node_id: null,
    file_path: 'Source.md', title: 'Source', types: ['note'], fields: {}, body: 'original source α' });
  db.prepare("INSERT INTO relationships(source_id,target,resolved_target_id,rel_type,context) VALUES (?,'Project',?,'project','fixture')").run(source.node_id, project.node_id);
  const config = { wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0,
    wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit',
    projectHomeProvenanceEnabled: true, model: 'synthetic', modelProviders: { synthetic: 'openrouter' },
    homeMaxTokens: 4000, meetingReads: 5, noteReads: 5, bodyCharCap: null, semanticGapFill: false,
    semanticGapFillLimit: 5, semanticGapFillBodyReads: 5, memoryWriteEnabled: false, activeStatuses: ['active'],
    ...configPatch } as unknown as Config;
  const servers: McpServer[] = [], clients: Client[] = [];
  const bundles: BundleV1[] = [], writes: WikiReconcileInput[] = [], results: WikiReconcileResult[] = [];
  let intercept: ((name: string, args: Record<string, unknown>, result: any) => void) | null = null;
  let before: ((name: string, args: Record<string, unknown>) => void) | null = null;
  let rawEngine: Client;
  const engine = new Engine(config, () => {
    const server = new McpServer({ name: 'engine-subpage-acceptance', version: '1' }); servers.push(server);
    registerGetNode(server, db); registerProjectEvidence(server, db); registerMemoriesTools(server, new MemoryService(db));
    registerProvenance(server, db); registerWikiReconcile(server, { db, writeLock, vaultPath: vault.vaultPath });
    registerQueryNodes(server, db); registerUpdateNode(server, db, writeLock, vault.vaultPath);
    registerDeleteNode(server, db, writeLock, vault.vaultPath);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'curator-engine', version: '1' }); clients.push(client); rawEngine = client;
    return { transport: ct, client: { connect: async () => { await server.connect(st); await client.connect(ct); },
      callTool: async req => {
        before?.(req.name, req.arguments);
        if (req.name === 'provenance-prepare' && req.arguments.dry_run === false) bundles.push(structuredClone(req.arguments.bundle as BundleV1));
        if (req.name === 'wiki-reconcile' && req.arguments.dry_run === false) writes.push(structuredClone(req.arguments) as WikiReconcileInput);
        const result = await client.callTool(req); const parsed = envelope(result);
        if (req.name === 'wiki-reconcile' && req.arguments.dry_run === false && parsed.ok) results.push(parsed.data);
        intercept?.(req.name, req.arguments, parsed);
        return { content: [{ type: 'text', text: JSON.stringify(parsed) }] };
      } } };
  });
  // No embedding/model service in this fixture. All selected source reads remain real MCP.
  engine.semanticRelated = async () => [];
  let plan = createPlan(['Decisions', 'Risks']);
  const sent: Array<Record<string, any>> = [];
  let duringProvider: (() => void) | null = null;
  let invalidStage: string | null = null;
  const adapter = new OpenAiCompatLlmClient({ chat: { completions: { create: async (payload: any) => {
    sent.push(structuredClone(payload)); duringProvider?.();
    const name = payload.response_format?.json_schema.name;
    const output = name === 'emit_topology_plan' ? plan
      : name === 'emit_scope_adjudication' ? { verdicts: JSON.parse(payload.messages.at(-1).content).comparisons.map((pair: any) => ({
        pair_id: pair.pair_id, candidate_plan_key: pair.candidate_plan_key, compared_to: pair.compared_to,
        relation: 'distinct', confidence: 0.95, evidence_ids: [], reason: 'Independent scopes.', narrower: 'none',
      })) } : name === 'emit_wiki_sections' ? { now: `Synthetic home summary ${sent.length}`, focus: [{ title: 'Review source' }], open_threads: [{ title: 'None' }], log_entry: `Home published ${sent.length}` }
      : { body: `## Decisions\n\nSynthetic page ${sent.length} from original source α.`, log_note: `Page published ${sent.length}` };
    return { choices: [{ message: { content: (name ? JSON.stringify : pageOutputFrame)(name === invalidStage ? {} : output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  } } } } as unknown as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
  const llm = new UsageReporter({ recordUsage: async () => {} } as unknown as Engine, { provider: 'openrouter', experiment: null, variant: null }).wrap(adapter);
  const deps: CoreDeps = { engine, llm, config, db: curatorDb, queue: new CurationQueue() };
  const curatorServer = curatorServerFactory(async () => deps, new Date())(); servers.push(curatorServer);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const send = ct.send.bind(ct);
  ct.send = message => send(message, { authInfo: { token: 'synthetic', clientId: 'fixture', scopes: ['curate:read', 'curate:trigger'] } });
  const curatorClient = new Client({ name: 'requesting-client', version: '1' }); clients.push(curatorClient);
  await curatorServer.connect(st); await curatorClient.connect(ct);
  const ref = { id: project.node_id, title: 'Project', file_path: 'Project.md', status: 'active' };
  return { db, engine, deps, config, project, source, sent, writes, results, bundles,
    full: (enabled = true) => curateProject(engine, llm, { ...config, projectHomeProvenanceEnabled: enabled }, ref, false, true),
    setPlan: (next: TopologyPlan) => { plan = next; },
    invalidateStage: (name: string) => { invalidStage = name; },
    setIntercept: (fn: typeof intercept) => { intercept = fn; }, setBefore: (fn: typeof before) => { before = fn; },
    setDuringProvider: (fn: typeof duringProvider) => { duringProvider = fn; },
    request: async (mode: 'immediate' | 'next-run' = 'immediate') => envelope(await curatorClient.callTool({ name: 'request-wiki-page', arguments: { project: 'Project', title: 'Decisions', mode } })),
    call: async (name: string, args: Record<string, unknown>) => { const data = envelope(await rawEngine.callTool({ name, arguments: args })); assert.equal(data.ok, true, JSON.stringify(data)); return data.data; },
    readClient: () => makeClient(async req => rawEngine.callTool(req) as any),
    reopen: () => { curatorDb.close(); curatorDb = new Database(curatorPath); runMigrations(curatorDb); deps.db = curatorDb; deps.queue = new CurationQueue(); },
    snapshot: () => db.prepare('SELECT id,body,version FROM nodes ORDER BY id').all(),
    close: async () => { await Promise.all(clients.map(c => c.close())); await engine.close(); await Promise.all(servers.map(s => s.close())); curatorDb.close(); db.close(); vault.cleanup(); },
  };
}

test('real MCP: full curation captures three outputs, exact SDK payloads and complete replay', async () => {
  const f = await fixture();
  try {
    const first = await f.full(); assert.equal(first.outcome, 'written', JSON.stringify(first));
    const receipts = f.results[0]!.provenance_receipts!;
    assert.equal(receipts.length, 3); assert.equal(new Set(receipts.map(r => r.derivation_id)).size, 3);
    assert.deepEqual(receipts.map(r => r.output_node_id), [f.results[0]!.home.node_id, ...f.results[0]!.created.map(p => p.node_id)]);
    assert.deepEqual(receipts.map(r => r.committed_node_version), [1, 1, 1]);
    assert.equal(new Set(receipts.map(r => r.operation_id)).size, 1);
    assert.deepEqual(f.results[0]!.provenance_receipt, receipts[0]);
    // Pages use raw Markdown framing and plan order; receipts are home-first.
    // Pair every retained request with its dispatch rather than accepting any match.
    const pageDispatches = f.sent.filter(payload => payload.response_format === undefined);
    assert.ok(f.bundles.filter(bundle => bundle.target).every(bundle => bundle.transform.adapter === 'openai-compat-page-markdown-v1'));
    const homeDispatches = f.sent.filter(payload => payload.response_format?.json_schema.name === 'emit_wiki_sections');
    assert.deepEqual(pageDispatches.map(payload => JSON.parse(payload.messages.at(-1).content).title),
      ['Project — Decisions', 'Project — Risks']);
    assert.equal(homeDispatches.length, 1);
    const capturedDispatches = [homeDispatches[0]!, ...pageDispatches];
    assert.equal(capturedDispatches.length, receipts.length);
    for (const [index, receipt] of receipts.entries()) {
      const inspected = await f.engine.inspectProvenance({ select: 'output', output_revision_id: receipt.output_revision_id, include_comparisons: true, limit: 100 });
      assert.equal(inspected.select, 'output'); if (inspected.select !== 'output') throw Error('output');
      const retained = await f.engine.inspectProvenance({ select: 'text', payload_id: inspected.payloads.find(p => p.kind === 'request')!.id, max_bytes: 65536 });
      assert.equal(retained.select, 'text'); if (retained.select !== 'text') throw Error('text');
      const decoded = JSON.parse(retained.text!);
      assert.deepEqual(decoded, capturedDispatches[index]);
      assert.equal(inspected.dependency_coverage, 'direct_with_opaque_components');
    }
    const before = f.snapshot(), calls = f.sent.length;
    const secondSubmission = (await f.engine.wikiReconcile(f.writes[0]!)).data;
    assert.deepEqual(secondSubmission.provenance_receipts, receipts); assert.equal(secondSubmission.reused, true);
    assert.deepEqual(f.snapshot(), before); assert.equal(f.sent.length, calls);
    const subpageRefreshTarget = await f.readClient().inspectProvenance({ select: 'refresh_target', output_revision_id: receipts[1]!.output_revision_id });
    assert.equal(subpageRefreshTarget.ok, true);
    if (!subpageRefreshTarget.ok || subpageRefreshTarget.data.select !== 'refresh_target') throw Error('refresh_target');
    // A captured sub-page can be rebuilt on its own (#372).
    assert.equal(subpageRefreshTarget.data.eligible, true, JSON.stringify(subpageRefreshTarget.data));
    assert.equal(subpageRefreshTarget.data.target_kind, 'page');
  } finally { await f.close(); }
});

test('real MCP: captured page and home calls carrying a reasoning budget pass Engine validation (#429)', async () => {
  const f = await fixture({ wikiPageReasoningBudget: 1000, wikiHomeReasoningBudget: 1500 });
  try {
    const first = await f.full(); assert.equal(first.outcome, 'written', JSON.stringify(first));
    const receipts = f.results[0]!.provenance_receipts!;
    assert.equal(receipts.length, 3);
    const pageDispatches = f.sent.filter(payload => payload.response_format === undefined);
    const homeDispatches = f.sent.filter(payload => payload.response_format?.json_schema.name === 'emit_wiki_sections');
    const planningDispatches = f.sent.filter(payload => payload.response_format?.json_schema.name === 'emit_topology_plan');
    assert.equal(pageDispatches.length, 2); assert.equal(homeDispatches.length, 1); assert.ok(planningDispatches.length > 0);
    for (const payload of pageDispatches) { assert.deepEqual(payload.reasoning, { max_tokens: 1000 }); assert.equal('reasoning_effort' in payload, false); }
    assert.deepEqual(homeDispatches[0]!.reasoning, { max_tokens: 1500 });
    // Planning has no budget, so its request is unchanged.
    for (const payload of planningDispatches) assert.equal('reasoning' in payload, false);
    // The Engine retained each budgeted request exactly as it was sent.
    const capturedDispatches = [homeDispatches[0]!, ...pageDispatches];
    for (const [index, receipt] of receipts.entries()) {
      const inspected = await f.engine.inspectProvenance({ select: 'output', output_revision_id: receipt.output_revision_id, include_comparisons: true, limit: 100 });
      if (inspected.select !== 'output') throw Error('output');
      const retained = await f.engine.inspectProvenance({ select: 'text', payload_id: inspected.payloads.find(p => p.kind === 'request')!.id, max_bytes: 65536 });
      if (retained.select !== 'text') throw Error('text');
      assert.deepEqual(JSON.parse(retained.text!), capturedDispatches[index]);
    }
  } finally { await f.close(); }
});

test('real MCP: old page retains original source bytes across edit, rename and deletion', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.full()).outcome, 'written');
    const receipt = f.results[0]!.provenance_receipts![1]!;
    const pages = f.results[0]!.provenance_receipts!.slice(1);
    f.setPlan({ reviewed_page_ids: pages.map(p => p.output_node_id), actions: pages.map((p, i) => ({ op: 'refresh', node_id: p.output_node_id, scope: scope(i ? 'Risks' : 'Decisions'), synthesis_brief: 'Refresh.' })) });
    assert.equal((await f.full()).outcome, 'written');
    const inspected = await f.engine.inspectProvenance({ select: 'output', output_revision_id: receipt.output_revision_id, include_comparisons: true, limit: 100 });
    if (inspected.select !== 'output') throw Error('output');
    const dependency = inspected.inputs.find(i => i.source?.native_id === f.source.node_id)!; assert.ok(dependency);
    const readOriginal = async () => {
      const text = await f.readClient().inspectProvenance({ select: 'input_text', output_revision_id: receipt.output_revision_id, input_id: dependency.id });
      assert.equal(text.ok, true); if (!text.ok || text.data.select !== 'input_text') throw Error('input_text');
      const block = text.data.segments.map(s => s.text).join('');
      assert.equal(block, `### [${f.source.node_id}] Source\ntypes: note\noriginal source α`);
      const historicalRetainedText = block.split('\n').at(-1); assert.equal(historicalRetainedText, 'original source α');
    };
    await readOriginal();
    for (const mutation of ['edit', 'rename', 'delete'] as const) {
      if (mutation === 'edit') await f.call('update-node', { node_id: f.source.node_id, set_body: 'changed source β', dry_run: false });
      if (mutation === 'rename') await f.call('update-node', { node_id: f.source.node_id, set_title: 'Renamed source' });
      if (mutation === 'delete') await f.call('delete-node', { node_id: f.source.node_id, confirm: true });
      await readOriginal();
      const affected = await f.engine.findAffectedOutputs({ sources: [dependency.source!], currentness: 'historical' });
      const page = affected.outputs.find(o => o.receipt.output_revision_id === receipt.output_revision_id)!;
      assert.ok(page); assert.equal(page.inputs[0]!.comparison, mutation === 'delete' ? 'missing' : 'changed');
    }
  } finally { await f.close(); }
});

test('real MCP: replacement and merge retain distinct histories and expected source transitions', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.full()).outcome, 'written');
    const original = f.results[0]!.provenance_receipts!;
    const target = original[1]!, source = original[2]!;
    f.setPlan({ reviewed_page_ids: [target.output_node_id, source.output_node_id], actions: [
      { op: 'refresh', node_id: target.output_node_id, scope: scope('Decisions'), synthesis_brief: 'Refresh decisions.' },
      { op: 'keep', node_id: source.output_node_id, scope: scope('Risks') },
    ] });
    assert.equal((await f.full()).outcome, 'written');
    const replacement = f.results.at(-1)!.provenance_receipts![1]!;
    assert.equal(replacement.replaces_output_revision_id, target.output_revision_id);
    f.setPlan({ reviewed_page_ids: [target.output_node_id, source.output_node_id], actions: [
      { op: 'merge', target: { node_id: target.output_node_id }, sources: [source.output_node_id], scope: scope('Decisions'), reason: 'Consolidate.', synthesis_brief: 'Merge both narratives.' },
    ] });
    const merged = await f.full(); assert.equal(merged.outcome, 'written', JSON.stringify(merged));
    const receipt = f.results.at(-1)!.provenance_receipts![1]!;
    assert.equal(receipt.replaces_output_revision_id, replacement.output_revision_id);
    const inspected = await f.engine.inspectProvenance({ select: 'output', output_revision_id: receipt.output_revision_id, include_comparisons: true, limit: 100 });
    if (inspected.select !== 'output') throw Error('output');
    for (const id of [target.output_node_id, source.output_node_id]) {
      const input: InputMetadata = inspected.inputs.find(i => i.source?.native_id === id)!;
      assert.equal(input.comparison, 'expected_self_transition');
      assert.equal((await f.engine.findAffectedOutputs({ sources: [input.source!], currentness: 'current' })).outputs.length, 0);
    }
    const oldSource = await f.engine.inspectProvenance({ select: 'node', node_id: source.output_node_id });
    if (oldSource.select !== 'node') throw Error('node');
    assert.deepEqual(oldSource.outputs.map(o => o.receipt.output_revision_id), [source.output_revision_id]);
    await f.call('update-node', { node_id: source.output_node_id, append_body: '\nExternal change.', dry_run: false });
    const sourceInput = inspected.inputs.find(i => i.source?.native_id === source.output_node_id)!;
    assert.ok((await f.engine.findAffectedOutputs({ sources: [sourceInput.source!] })).outputs.some(o => o.receipt.output_revision_id === receipt.output_revision_id && o.inputs.some(i => i.comparison === 'changed')));
  } finally { await f.close(); }
});

for (const mode of ['immediate', 'next-run'] as const) test(`real MCP: ${mode} page request captures page/home pair`, async () => {
  const f = await fixture();
  try {
    f.setPlan(createPlan([])); assert.equal((await f.full()).outcome, 'written');
    f.setPlan(createPlan(['Decisions']));
    const response = await f.request(mode); assert.equal(response.ok, true, JSON.stringify(response));
    if (mode === 'next-run') {
      assert.equal(response.status, 'pending');
      await curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
    }
    const row = getPageRequest(f.deps.db!, response.request_id)!;
    assert.equal(row.status, 'fulfilled', JSON.stringify(row));
    const pair = f.results[1]!.provenance_receipts!; assert.equal(pair.length, 2);
    assert.equal(pair[1]!.output_node_id, row.page_node_id);
    const checkpoint = readRequestExecution(f.deps.db!, row.id)!;
    assert.equal(checkpoint.phase, 'committed'); assert.equal('snapshot' in checkpoint, false);
  } finally { await f.close(); }
});

for (const boundary of ['lost-commit-response', 'bookkeeping'] as const) test(`real MCP: requested ${boundary} recovery after SQLite reopen makes no provider call`, async () => {
  const f = await fixture();
  try {
    f.setPlan(createPlan([])); assert.equal((await f.full()).outcome, 'written');
    f.setPlan(createPlan(['Decisions']));
    if (boundary === 'bookkeeping') f.deps.db!.exec("CREATE TRIGGER fail_bookkeeping BEFORE UPDATE OF status ON page_requests WHEN NEW.status='fulfilled' BEGIN SELECT RAISE(ABORT,'injected'); END");
    else f.setIntercept((name, args) => { if (name === 'wiki-reconcile' && args.dry_run === false) throw Error('Lost commit response'); });
    const response = await f.request(); assert.equal(response.ok, false, JSON.stringify(response));
    const requestId = response.request_id as number;
    const receipts = f.results.at(-1)!.provenance_receipts!; assert.equal(receipts.length, 2);
    const saved = readRequestExecution(f.deps.db!, requestId) as ActivePageRequestExecution;
    assert.ok(saved.reconcile); const exact = structuredClone(saved.reconcile);
    const providerCallsBeforeRecovery = f.sent.length;
    f.setIntercept(null); f.reopen();
    if (boundary === 'bookkeeping') f.deps.db!.exec('DROP TRIGGER fail_bookkeeping');
    // Recovery is first in the queue. Stop the independent full curation after fulfillment.
    f.setBefore(name => { if (name === 'project-evidence' && getPageRequest(f.deps.db!, requestId)?.status === 'fulfilled') throw Error('End unrelated full curation'); });
    await curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
    assert.equal(getPageRequest(f.deps.db!, requestId)?.status, 'fulfilled');
    const providerCallsAfterRecovery = f.sent.length; assert.equal(providerCallsAfterRecovery, providerCallsBeforeRecovery);
    assert.deepEqual((await f.engine.wikiReconcile(exact)).data.provenance_receipts, receipts);
    assert.equal('snapshot' in readRequestExecution(f.deps.db!, requestId)!, false);
  } finally { await f.close(); }
});

test('real MCP: partial purge invalidates the complete replay without resurrecting any output', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.full()).outcome, 'written');
    const receipts = f.results[0]!.provenance_receipts!, purged = receipts[1]!;
    const scope = { derivation_ids: [purged.derivation_id] };
    const preview = await f.engine.purgeProvenance({ scope });
    assert.ok('scope_token' in preview);
    await f.engine.purgeProvenance({ scope, scope_token: preview.scope_token, dry_run: false, confirm: true });
    const before = f.snapshot(), count = f.sent.length;
    await assert.rejects(f.engine.wikiReconcile(f.writes[0]!), /PROVENANCE_UNAVAILABLE|PROVENANCE_REVOKED/);
    assert.deepEqual(f.snapshot(), before); assert.equal(f.sent.length, count);
    const inspected = await f.engine.inspectProvenance({ select: 'output', output_revision_id: purged.output_revision_id });
    assert.equal(inspected.select, 'output'); if (inspected.select !== 'output') throw Error('output');
    assert.equal(inspected.output.availability, 'purged');
    for (const payload of inspected.payloads) {
      const text = await f.engine.inspectProvenance({ select: 'text', payload_id: payload.id });
      assert.equal(text.select, 'text'); if (text.select !== 'text') throw Error('text');
      assert.equal(text.text, null);
    }
    assert.equal((await f.engine.inspectProvenance({ select: 'output', output_revision_id: receipts[0]!.output_revision_id })).select, 'output');
  } finally { await f.close(); }
});

test('real MCP: missing batch capability rejects captured work before any provider call', async () => {
  const f = await fixture();
  try {
    f.setIntercept((name, args, result) => { if (name === 'inspect-provenance' && args.select === 'status') delete result.data.capture_features; });
    const result = await f.full(); assert.equal(result.outcome, 'error'); assert.match(result.detail ?? '', /PROVENANCE_CAPTURE_UNSUPPORTED/);
    assert.equal(f.sent.length, 0); assert.equal(f.results.length, 0);
  } finally { await f.close(); }
});

test('real MCP: legacy no-flow home client retains singular receipt, source drift and replay semantics', async () => {
  const f = await fixture();
  try {
    f.setPlan(createPlan([])); assert.equal((await f.full(false)).outcome, 'written');
    const evidence = await f.engine.projectEvidence(f.project.node_id);
    const source = await f.engine.getNode(f.source.node_id, { includeProvenance: true });
    const bundle = bundleFixture('original source α');
    bundle.items[0]!.observation = source.provenance_observation!; bundle.items[0]!.origin = 'identified';
    const attemptKey = randomUUID();
    const prepared = await f.engine.prepareProvenance({ attempt_key: attemptKey, run_ref: randomUUID(), project_id: f.project.node_id, bundle, dry_run: false });
    if ('dry_run' in prepared) throw Error('prepare');
    const legacyAttempt = await f.engine.inspectProvenance({ select: 'attempt', attempt_key: attemptKey });
    if (legacyAttempt.select !== 'attempt') throw Error('attempt');
    assert.equal(legacyAttempt.attempt?.derivation_id, prepared.derivation_id);
    const contribution = [{ name: 'Now', mode: 'replace' as const, content: 'Legacy home summary' }];
    const binding = await f.engine.stageProvenanceResult({ derivation_id: prepared.derivation_id, bundle_digest: prepared.bundle_digest!,
      validated_sections: { now: 'Legacy home summary' }, contribution, generated_at: new Date().toISOString(), log_stamp: new Date().toISOString().slice(0, 10) });
    await f.call('update-node', { node_id: f.source.node_id, set_body: 'Legacy source drift', dry_run: false });
    const request: WikiReconcileInput = { project: 'Project', project_id: f.project.node_id, pages: [],
      reconcile_key: `wiki-reconcile:provenance-v1:${prepared.derivation_id}`, home: { expected_version: evidence.existing_wiki.home!.version,
        sections: contribution, provenance: binding, evidence_hash: evidence.evidence_hash, curated_at: new Date().toISOString(), refresh_live: true }, dry_run: false };
    const result = (await f.engine.wikiReconcile(request)).data;
    assert.equal(result.provenance_receipt?.derivation_id, prepared.derivation_id);
    assert.equal(result.provenance_receipts, undefined);
    assert.deepEqual((await f.engine.wikiReconcile(request)).data.provenance_receipt, result.provenance_receipt);
    const read = await f.readClient().inspectProvenance({ select: 'output', output_revision_id: result.provenance_receipt!.output_revision_id });
    assert.equal(read.ok, true); if (!read.ok || read.data.select !== 'output') throw Error('output');
    assert.ok(read.data.inputs.every(i => i.comparison === undefined));
  } finally { await f.close(); }
});

test('real MCP: purged staged requested capture blocks restart and erases cached sections', async () => {
  const f = await fixture();
  try {
    f.setPlan(createPlan([])); assert.equal((await f.full()).outcome, 'written');
    const before = f.snapshot();
    f.setPlan(createPlan(['Decisions']));
    f.setBefore((name, args) => { if (name === 'wiki-reconcile' && args.dry_run === false) throw Error('Offline before commit'); });
    const response = await f.request(); assert.equal(response.ok, false, JSON.stringify(response));
    const saved = readRequestExecution(f.deps.db!, response.request_id) as ActivePageRequestExecution;
    assert.ok(saved.reconcile); assert.equal(saved.captures.length, 2);
    const scope = { derivation_ids: [saved.captures[0]!.receipt!.derivation_id] };
    const preview = await f.engine.purgeProvenance({ scope });
    assert.ok('scope_token' in preview);
    await f.engine.purgeProvenance({ scope, scope_token: preview.scope_token, dry_run: false, confirm: true });
    const calls = f.sent.length; f.reopen();
    f.setBefore(name => { if (name === 'project-evidence' && getPageRequest(f.deps.db!, response.request_id)?.status === 'failed') throw Error('End unrelated full curation'); });
    await curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
    assert.equal(getPageRequest(f.deps.db!, response.request_id)?.status, 'failed');
    const terminal = readRequestExecution(f.deps.db!, response.request_id)!;
    assert.equal(terminal.phase, 'failed'); assert.equal('snapshot' in terminal, false);
    assert.equal(f.sent.length, calls); assert.deepEqual(f.snapshot(), before); assert.equal(f.results.length, 1);
  } finally { await f.close(); }
});

test('real MCP: source drift after captured page dispatch rejects the whole new-mode batch', async () => {
  const f = await fixture();
  try {
    let changed = false;
    f.setDuringProvider(() => {
      if (!changed && f.bundles.length === 3) {
        changed = true;
        f.db.prepare('UPDATE nodes SET version=version+1 WHERE id=?').run(f.source.node_id);
      }
    });
    const result = await f.full();
    assert.equal(result.outcome, 'error'); assert.match(result.detail ?? '', /PROVENANCE_OBSERVATION_CHANGED/);
    assert.ok(changed); assert.equal(f.results.length, 0);
    assert.deepEqual(f.db.prepare('SELECT COUNT(*) AS n FROM provenance_outputs').get(), { n: 0 });
    assert.deepEqual(f.db.prepare("SELECT COUNT(*) AS n FROM node_types WHERE schema_type='wiki'").get(), { n: 0 });
  } finally { await f.close(); }
});

test('real MCP: legacy subpage classification remains honest after another page activates the flow', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.full(false)).outcome, 'written');
    const pages = (await f.engine.projectEvidence(f.project.node_id)).existing_wiki.subpages;
    assert.equal(pages.length, 2);
    for (const page of pages) {
      const history = await f.readClient().inspectProvenance({ select: 'node', node_id: page.id });
      assert.equal(history.ok, true); if (!history.ok || history.data.select !== 'node') throw Error('node');
      assert.equal(history.data.current_provenance, 'unknown_legacy');
    }
    const target = pages.find(p => p.title.endsWith('Decisions'))!, other = pages.find(p => p.id !== target.id)!;
    await f.call('update-node', { node_id: target.id, set_fields: { wiki_state: 'dormant' }, dry_run: false });
    f.setPlan({ reviewed_page_ids: pages.map(p => p.id), actions: [
      { op: 'reactivate', node_id: target.id, scope: scope('Decisions'), synthesis_brief: 'Revive this page.' },
      { op: 'keep', node_id: other.id, scope: scope('Risks') },
    ] });
    const reactivated = await f.full(); assert.equal(reactivated.outcome, 'written', JSON.stringify(reactivated));
    assert.equal(f.results.at(-1)!.provenance_receipts![1]!.replaces_output_revision_id, null);
    for (const [id, expected] of [[target.id, 'captured'], [other.id, 'unknown_legacy']]) {
      const history = await f.readClient().inspectProvenance({ select: 'node', node_id: id! });
      assert.equal(history.ok, true); if (!history.ok || history.data.select !== 'node') throw Error('node');
      assert.equal(history.data.current_provenance, expected);
    }
  } finally { await f.close(); }
});


for (const phase of ['preview', 'commit'] as const) {
test(`real MCP: stale semantic source outside project hash fails requested ${phase} and erases recovery`, async () => {
  const f = await fixture();
  try {
    f.setPlan(createPlan([])); assert.equal((await f.full()).outcome, 'written');
    // Semantic retrieval can select a source absent from project-evidence membership.
    f.db.prepare('DELETE FROM relationships WHERE source_id=? AND rel_type=?').run(f.source.node_id, 'project');
    f.engine.semanticRelated = async () => [{ id: f.source.node_id, title: 'Source', types: ['note'], score: 1, status: null }];
    const initial = await f.engine.projectEvidence(f.project.node_id);
    assert.equal(initial.notes.some(node => node.id === f.source.node_id), false);
    const homeBefore = await f.engine.getNode(initial.existing_wiki.home_id!);
    f.setPlan(createPlan(['Decisions']));
    const callsBefore = f.sent.length;
    let previews = 0;
    let commits = 0;
    f.setBefore((name, args) => {
      if (name !== 'wiki-reconcile') return;
      if (args.dry_run === true) previews++;
      else commits++;
      if (args.dry_run === (phase === 'preview')) {
        // Mutate after capture, immediately before the selected real Engine boundary.
        f.db.prepare('UPDATE nodes SET version=version+1 WHERE id=?').run(f.source.node_id);
      }
    });
    const response = await f.request();
    assert.equal(response.ok, false, JSON.stringify(response));
    assert.equal(response.status, 'failed', JSON.stringify(response));
    const after = await f.engine.projectEvidence(f.project.node_id);
    assert.equal(after.evidence_hash, initial.evidence_hash);
    assert.deepEqual(after.existing_wiki, initial.existing_wiki);
    assert.deepEqual(await f.engine.getNode(initial.existing_wiki.home_id!), homeBefore);
    const terminal = readRequestExecution(f.deps.db!, response.request_id)!;
    assert.equal(terminal.phase, 'failed'); assert.equal('snapshot' in terminal, false);
    assert.equal('calls' in terminal, false); assert.equal('captures' in terminal, false);
    assert.equal(f.sent.length - callsBefore, 4); assert.equal(previews, 1);
    assert.equal(commits, phase === 'preview' ? 0 : 1);
    assert.equal(f.results.length, 1); assert.equal(f.writes.length, phase === 'preview' ? 1 : 2);
    assert.deepEqual(f.db.prepare("SELECT state,reserved_remaining_bytes FROM provenance_derivations WHERE state != 'committed'").all(),
      [{ state: 'abandoned', reserved_remaining_bytes: 0 }, { state: 'abandoned', reserved_remaining_bytes: 0 }]);
    f.setBefore((name, args) => {
      if (name === 'project-evidence') throw Error('End unrelated full curation');
      if (name === 'wiki-reconcile' && args.dry_run === true) previews++;
      if (name === 'wiki-reconcile' && args.dry_run === false) commits++;
    });
    await curateOne(f.deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
    assert.equal(getPageRequest(f.deps.db!, response.request_id)?.status, 'failed');
    assert.equal(f.sent.length - callsBefore, 4); assert.equal(f.results.length, 1); assert.equal(previews, 1);
    assert.equal(commits, phase === 'preview' ? 0 : 1);
  } finally { await f.close(); }
});
}


for (const offline of [false, true]) {
test(`real MCP: invalid home releases staged/page and prepared/home capacity (cleanup offline: ${offline})`, async () => {
  const f = await fixture();
  try {
    f.setPlan(createPlan([])); assert.equal((await f.full()).outcome, 'written');
    const before = f.snapshot();
    f.setPlan(createPlan(['Decisions']));
    f.invalidateStage('emit_wiki_sections');
    const callsBefore = f.sent.length;
    let cleanupCalls = 0;
    f.setBefore((name, args) => {
      if (name !== 'provenance-transition' || args.action !== 'abandon') return;
      cleanupCalls++;
      const row = f.db.prepare('SELECT reserved_remaining_bytes FROM provenance_derivations WHERE id=?').get(args.derivation_id) as { reserved_remaining_bytes: number };
      assert.ok(row.reserved_remaining_bytes > 0);
      if (offline) throw new Error('Engine offline during cleanup');
    });
    const response = await f.request();
    assert.equal(response.status, 'failed', JSON.stringify(response));
    const terminal = readRequestExecution(f.deps.db!, response.request_id)!;
    assert.equal(terminal.phase, 'failed'); assert.equal('snapshot' in terminal, false);
    assert.equal(f.sent.length - callsBefore, 4);
    assert.deepEqual(f.snapshot(), before);
    const attempts = f.db.prepare("SELECT state,reserved_remaining_bytes FROM provenance_derivations WHERE state != 'committed'").all() as Array<{ state: string; reserved_remaining_bytes: number }>;
    assert.equal(attempts.length, 2);
    assert.ok(cleanupCalls >= 2);
    if (offline) {
      assert.deepEqual(attempts.map(a => a.state).sort(), ['prepared', 'result_staged']);
      assert.ok(attempts.every(a => a.reserved_remaining_bytes > 0));
    } else {
      assert.ok(attempts.every(a => a.state === 'abandoned' && a.reserved_remaining_bytes === 0));
    }
  } finally { await f.close(); }
});
}
