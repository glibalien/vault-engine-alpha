// AI-caller parity for #372: everything the inspector's rebuild buttons do, driven over real MCP.
// The caller's Engine connection is the OAuth surface, so a service-only tool isn't there to call.
// Disposable SQLite and vault; the actual OpenAI-compatible adapter over a recording provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type OpenAI from 'openai';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pageOutputFrame } from '../packages/curator/test/page-output-fixtures.js';
import { createTestDb } from '../packages/engine/tests/helpers/db.js';
import { createTempVault } from '../packages/engine/tests/helpers/vault.js';
import { executeMutation } from '../packages/engine/src/pipeline/execute.js';
import { WriteLockManager } from '../packages/engine/src/sync/write-lock.js';
import { registerToolsForSurface, SERVICE_ONLY_TOOL_NAMES } from '../packages/engine/src/mcp/tool-surface.js';
import { registerGetNode } from '../packages/engine/src/mcp/tools/get-node.js';
import { registerProjectEvidence } from '../packages/engine/src/mcp/tools/project-evidence.js';
import { registerMemoriesTools } from '../packages/engine/src/mcp/tools/memories.js';
import { MemoryService } from '../packages/engine/src/memories/service.js';
import { registerProvenance } from '../packages/engine/src/mcp/tools/provenance.js';
import { registerWikiReconcile } from '../packages/engine/src/mcp/tools/wiki-reconcile.js';
import { registerQueryNodes } from '../packages/engine/src/mcp/tools/query-nodes.js';
import { registerUpdateNode } from '../packages/engine/src/mcp/tools/update-node.js';
import { Engine } from '../packages/curator/src/engine.js';
import { BackgroundBuilds } from '../packages/curator/src/background-builds.js';
import { curateProject } from '../packages/curator/src/curate.js';
import type { CoreDeps } from '../packages/curator/src/core.js';
import { OpenAiCompatLlmClient } from '../packages/curator/src/llm/openai-compat.js';
import { UsageReporter } from '../packages/curator/src/usage-reporter.js';
import { runMigrations } from '../packages/curator/src/db/migrate.js';
import { registerWikiRoot } from '../packages/curator/src/db/wiki-roots.js';
import { replaceExplicitTopicRefreshSources } from '../packages/curator/src/db/topic-refresh.js';
import { curateTopicTimed } from '../packages/curator/src/core.js';
import { CurationQueue } from '../packages/curator/src/queue.js';
import { curatorServerFactory } from '../packages/curator/src/server-bootstrap.js';
import { loadWikiNodeFields } from '../packages/engine/src/wiki/write-helpers.js';
import type { Config } from '../packages/curator/src/config.js';
import type { HomeRefreshPreview, HomeRefreshStatus } from '../packages/curator/src/home-refresh-types.js';
import type { TopologyPlan } from '../packages/curator/src/types.js';

const scope = (facet: string) => ({ v: 1 as const, subject: 'Project', facet });
const createPlan: TopologyPlan = { reviewed_page_ids: [], actions: ['Decisions', 'Risks'].map(facet => ({
  op: 'create', plan_key: facet, title: `Project — ${facet}`, kind: 'workstream', scope: scope(facet), synthesis_brief: `Write ${facet}.`, evidence_ids: [],
})) };
const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content)[0]!.text;

async function fixture() {
  const db = createTestDb(), vault = createTempVault(), writeLock = new WriteLockManager();
  const curatorDb = new Database(join(vault.vaultPath, 'curator-test.db')); runMigrations(curatorDb);
  registerWikiRoot(curatorDb, { root_title: 'Project', root_node_id: null, kind: 'project', source: 'vault', cadence: null,
    brief: null, created_at: '2026-11-07T00:00:00.000Z', created_by: 'test' });
  db.prepare("INSERT INTO schemas(name,display_name,field_claims) VALUES ('project','Project','[]'),('note','Note','[]'),('topic','Topic','[]')").run();
  const mutate = (input: Parameters<typeof executeMutation>[3]) => executeMutation(db, writeLock, vault.vaultPath, input);
  const project = mutate({ source: 'tool', node_id: null, file_path: 'Project.md', title: 'Project', types: ['project'], fields: { status: 'active' }, body: 'Synthetic project.' });
  const source = mutate({ source: 'tool', node_id: null, file_path: 'Source.md', title: 'Source', types: ['note'], fields: {}, body: 'original source α' });
  db.prepare("INSERT INTO relationships(source_id,target,resolved_target_id,rel_type,context) VALUES (?,'Project',?,'project','fixture')").run(source.node_id, project.node_id);
  const config = { wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0,
    wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit',
    projectHomeProvenanceEnabled: true, model: 'synthetic', modelProviders: { synthetic: 'openrouter' },
    homeMaxTokens: 4000, meetingReads: 5, noteReads: 5, bodyCharCap: null, semanticGapFill: false,
    semanticGapFillLimit: 5, semanticGapFillBodyReads: 5, memoryWriteEnabled: false, activeStatuses: ['active'] } as unknown as Config;

  const servers: McpServer[] = [], clients: Client[] = [];
  const registerEngineTools = (server: McpServer) => {
    registerGetNode(server, db); registerProjectEvidence(server, db); registerMemoriesTools(server, new MemoryService(db));
    registerProvenance(server, db); registerWikiReconcile(server, { db, writeLock, vaultPath: vault.vaultPath });
    registerQueryNodes(server, db); registerUpdateNode(server, db, writeLock, vault.vaultPath);
  };
  // The Curator's own connection is the service surface, as in production.
  const engine = new Engine(config, () => {
    const server = new McpServer({ name: 'engine-service', version: '1' }); servers.push(server);
    registerToolsForSurface(server, 'full', () => registerEngineTools(server));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'curator-engine', version: '1' }); clients.push(client);
    return { transport: ct, client: { connect: async () => { await server.connect(st); await client.connect(ct); }, callTool: req => client.callTool(req) as never } };
  });
  // No embedding service in this fixture. Every source read stays real MCP.
  engine.semanticRelated = async () => [];

  let plan: TopologyPlan = createPlan;
  const sent: Array<Record<string, any>> = [];
  const adapter = new OpenAiCompatLlmClient({ chat: { completions: { create: async (payload: any) => {
    sent.push(structuredClone(payload));
    const name = payload.response_format?.json_schema.name;
    const output = name === 'emit_topology_plan' ? plan
      : name === 'emit_scope_adjudication' ? { verdicts: JSON.parse(payload.messages.at(-1).content).comparisons.map((pair: any) => ({
        pair_id: pair.pair_id, candidate_plan_key: pair.candidate_plan_key, compared_to: pair.compared_to,
        relation: 'distinct', confidence: 0.95, evidence_ids: [], reason: 'Independent scopes.', narrower: 'none',
      })) }
      : name === 'emit_wiki_sections' ? { now: `Home text ${sent.length}`, focus: [{ title: 'Review source' }], open_threads: [{ title: 'None' }], log_entry: `Home published ${sent.length}` }
      : { body: `## Notes\n\nPage text ${sent.length}.`, log_note: 'Rebuilt.' };
    return { choices: [{ message: { content: (name ? JSON.stringify : pageOutputFrame)(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  } } } } as unknown as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
  const llm = new UsageReporter({ recordUsage: async () => {} } as unknown as Engine, { provider: 'openrouter', experiment: null, variant: null }).wrap(adapter);

  const running: Array<Promise<unknown>> = [];
  const deps: CoreDeps = { engine, llm, config, db: curatorDb, queue: new CurationQueue(), builds: new BackgroundBuilds(work => { running.push(work); }) };
  const built = await curateProject(engine, llm, config, { id: project.node_id, title: 'Project', file_path: 'Project.md', status: 'active' }, false, true);
  assert.equal(built.outcome, 'written', JSON.stringify(built));

  // What the AI caller holds: the Engine's OAuth surface, and the Curator's server with its scopes.
  const callerServer = new McpServer({ name: 'engine-oauth-surface', version: '1' }); servers.push(callerServer);
  registerToolsForSurface(callerServer, 'external', () => registerEngineTools(callerServer));
  const [engineClientSide, engineServerSide] = InMemoryTransport.createLinkedPair();
  const callerEngine = new Client({ name: 'ai-caller', version: '1' }); clients.push(callerEngine);
  await callerServer.connect(engineServerSide); await callerEngine.connect(engineClientSide);

  const curatorServer = curatorServerFactory(async () => deps, new Date())(); servers.push(curatorServer);
  const [curatorClientSide, curatorServerSide] = InMemoryTransport.createLinkedPair();
  const send = curatorClientSide.send.bind(curatorClientSide);
  curatorClientSide.send = message => send(message, { authInfo: { token: 'synthetic', clientId: 'ai-caller', scopes: ['curate:read', 'curate:trigger'] } });
  const callerCurator = new Client({ name: 'ai-caller', version: '1' }); clients.push(callerCurator);
  await curatorServer.connect(curatorServerSide); await callerCurator.connect(curatorClientSide);

  /** The Engine envelope's data, or a failure with its message. */
  const onEngine = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const envelope = JSON.parse(text(await callerEngine.callTool({ name, arguments: args })));
    assert.equal(envelope.ok, true, `${name}: ${JSON.stringify(envelope)}`);
    return envelope.data as T;
  };
  const onCurator = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const parsed = JSON.parse(text(await callerCurator.callTool({ name, arguments: args })));
    if (parsed.ok === false) assert.fail(`${name}: ${JSON.stringify(parsed)}`);
    return (parsed.ok === true ? parsed.data : parsed) as T;
  };
  /** Polls as a caller would, since the paid work runs behind the reply. */
  const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
    for (let waited = 0; waited < 10_000; waited += 5) {
      const value = await read();
      if (done(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('timed out waiting for a rebuild');
  };
  /** The whole chain a caller needs for one page, given only its title or its node id. */
  const rebuildPage = async (ref: { title: string } | { node_id: string }) => {
    const node = await onEngine<{ id: string }>('get-node', ref);
    const history = await onEngine<{ outputs: Array<{ receipt: { output_revision_id: string } }> }>('inspect-provenance', { select: 'node', node_id: node.id });
    const outputId = history.outputs[0]!.receipt.output_revision_id;
    const preview = await onCurator<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: outputId });
    assert.equal(preview.eligible, true, JSON.stringify(preview));
    const request_id = randomUUID();
    await onCurator('refresh-wiki-page', { request_id, guard: preview.guard, confirm_paid: true });
    const status = await until(() => onCurator<HomeRefreshStatus>('wiki-refresh-status', { request_id }),
      value => ['committed', 'conflict', 'failed', 'uncertain'].includes(value.phase));
    assert.equal(status.phase, 'committed', JSON.stringify(status));
    return { node, outputId, preview, status };
  };
  const nodes = () => new Map((db.prepare('SELECT id,title,body,version FROM nodes').all() as Array<{ id: string; title: string; body: string; version: number }>).map(row => [row.title, row]));
  return { db, deps, vault, project, source, sent, onEngine, onCurator, until, rebuildPage, nodes, mutate, callerEngine, callerCurator, running,
    fields: (id: string) => loadWikiNodeFields(db, id),
    setPlan: (next: TopologyPlan) => { plan = next; },
    close: async () => { await Promise.all(running); await Promise.all(clients.map(c => c.close())); await engine.close(); await Promise.all(servers.map(s => s.close())); curatorDb.close(); db.close(); vault.cleanup(); },
  };
}

test('parity: the caller holds every tool in the chains, and none of the service-only ones', async () => {
  const f = await fixture();
  try {
    const engineTools = new Set((await f.callerEngine.listTools()).tools.map(tool => tool.name));
    const curatorTools = new Set((await f.callerCurator.listTools()).tools.map(tool => tool.name));
    for (const name of ['get-node', 'inspect-provenance', 'query-nodes']) assert.ok(engineTools.has(name), name);
    // create-project-wiki backs "Create project wiki" (#384); propose-topic-wiki and create-or-update-wiki back
    // "Create topic wiki from this note" (#387), which finds the note's id with get-node. The wiki panel's card
    // (#545) reads curator-status and the home's wiki_status with get-node, and pauses with set-wiki-paused.
    for (const name of ['preview-wiki-refresh', 'refresh-wiki-page', 'wiki-refresh-status', 'curate-project-wiki', 'curator-status', 'set-wiki-paused',
      'create-project-wiki', 'propose-topic-wiki', 'create-or-update-wiki'])
      assert.ok(curatorTools.has(name), name);
    for (const name of SERVICE_ONLY_TOOL_NAMES) assert.ok(!engineTools.has(name), name);
    for (const name of ['preview-home-refresh', 'refresh-project-home', 'home-refresh-status']) assert.ok(!curatorTools.has(name), `${name} should be gone`);
  } finally { await f.close(); }
});

test('parity: a sub-page of a paused wiki, starting from its title, changes only that page', async () => {
  const f = await fixture();
  try {
    await f.onCurator('set-wiki-paused', { project: 'Project', paused: true });
    const before = f.nodes();
    const fieldsBefore = f.fields(before.get('Project — Decisions')!.id);
    const calls = f.sent.length;

    const { node, outputId, preview, status } = await f.rebuildPage({ title: 'Project — Decisions' });

    assert.equal(preview.target_kind, 'page');
    assert.equal(preview.page_title, 'Project — Decisions');
    assert.deepEqual(preview.sections, ['Summary', 'Log']);
    assert.equal(f.sent.length, calls + 1, 'one paid call, and no planner');
    assert.equal(f.sent.at(-1)!.response_format, undefined, 'the page stage, not planning or the home');
    assert.equal(status.output!.replaces_output_revision_id, outputId);
    assert.equal(status.output!.output_node_id, node.id);

    const after = f.nodes();
    assert.match(after.get('Project — Decisions')!.body, new RegExp(`Page text ${calls + 1}\\.`));
    assert.deepEqual(f.fields(node.id), fieldsBefore, 'its scope, kind, origin and pin stay');
    for (const [title, row] of before) if (title !== 'Project — Decisions') assert.deepEqual(after.get(title), row, `${title} must not change`);

    // A caller can see the new build, and that the old one is no longer the latest.
    const history = await f.onEngine<{ outputs: Array<{ receipt: { output_revision_id: string } }> }>('inspect-provenance', { select: 'node', node_id: node.id });
    assert.equal(history.outputs[0]!.receipt.output_revision_id, status.output!.output_revision_id);
    const replaced = await f.onCurator<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: outputId });
    assert.equal(replaced.eligible, false);
    assert.ok(replaced.reasons.some(reason => reason.code === 'HISTORICAL_OUTPUT'));
  } finally { await f.close(); }
});

test('parity: a changed source reaches the rebuild, and it can be rebuilt again the same day', async () => {
  const f = await fixture();
  try {
    await f.onCurator('set-wiki-paused', { project: 'Project', paused: true });
    const id = f.nodes().get('Project — Risks')!.id;
    f.mutate({ source: 'tool', node_id: f.source.node_id, file_path: 'Source.md', title: 'Source', types: ['note'], fields: {}, body: 'edited source β' });

    await f.rebuildPage({ node_id: id });
    const evidence = JSON.parse(f.sent.at(-1)!.messages.at(-1).content).evidence as string;
    assert.match(evidence, /edited source β/);
    assert.doesNotMatch(evidence, /original source α/);

    const second = await f.rebuildPage({ node_id: id });
    assert.equal(second.preview.eligible, true);
    assert.equal(second.status.phase, 'committed');
  } finally { await f.close(); }
});

test('parity: the home of a paused wiki, after a sub-page rebuild, changes only the home', async () => {
  const f = await fixture();
  try {
    await f.onCurator('set-wiki-paused', { project: 'Project', paused: true });
    await f.rebuildPage({ title: 'Project — Decisions' });
    const before = f.nodes();
    const calls = f.sent.length;

    const { preview } = await f.rebuildPage({ title: 'Project Wiki' });

    assert.equal(preview.target_kind, 'home');
    assert.equal(f.sent.length, calls + 1);
    const after = f.nodes();
    assert.match(after.get('Project Wiki')!.body, new RegExp(`Home text ${calls + 1}`));
    for (const [title, row] of before) if (title !== 'Project Wiki') assert.deepEqual(after.get(title), row, `${title} must not change`);
  } finally { await f.close(); }
});

test('parity: the whole of a paused wiki, with unchanged evidence, and sweeps still skip it', async () => {
  const f = await fixture();
  try {
    type SweepCheck = { results: Array<{ project: string; outcome: string }> };
    const beforePause = await f.onCurator<SweepCheck>('curate-project-wiki', { dry_run: true });
    assert.ok(beforePause.results.some(result => result.project === 'Project'), JSON.stringify(beforePause));
    await f.onCurator('set-wiki-paused', { project: 'Project', paused: true });
    const nodes = f.nodes();
    const [decisions, risks] = [nodes.get('Project — Decisions')!.id, nodes.get('Project — Risks')!.id];
    f.setPlan({ reviewed_page_ids: [decisions, risks], actions: [
      { op: 'refresh', node_id: decisions, scope: scope('Decisions'), synthesis_brief: 'Refresh.' },
      { op: 'keep', node_id: risks, scope: scope('Risks') },
    ] });
    const calls = f.sent.length;

    // The free check spends nothing, and a caller starts from the project's title.
    const check = await f.onCurator<{ results: Array<{ outcome: string }> }>('curate-project-wiki', { project: 'Project', dry_run: true, force: true });
    assert.equal(check.results[0]!.outcome, 'would_curate', JSON.stringify(check));
    assert.equal(f.sent.length, calls);

    const started = await f.onCurator<{ status: string }>('curate-project-wiki', { project: 'Project', force: true });
    assert.equal(started.status, 'queued', JSON.stringify(started));
    const status = await f.until(() => f.onCurator<{ in_progress: unknown; paused: boolean; latest_run: { outcome: string } | null }>('curator-status', { project: 'Project' }),
      value => value.in_progress === null);
    assert.equal(status.latest_run?.outcome, 'written', JSON.stringify(status));
    assert.equal(status.paused, true, 'a rebuild does not resume the wiki');
    assert.ok(f.sent.length > calls);
    const after = f.nodes();
    assert.notEqual(after.get('Project Wiki')!.body, nodes.get('Project Wiki')!.body);
    assert.notEqual(after.get('Project — Decisions')!.body, nodes.get('Project — Decisions')!.body);

    // A sweep names no project, and pause still keeps it out.
    const spent = f.sent.length;
    const sweep = await f.onCurator<SweepCheck>('curate-project-wiki', { dry_run: true });
    assert.ok(!sweep.results.some(result => result.project === 'Project'), JSON.stringify(sweep));
    assert.equal(f.sent.length, spent);
  } finally { await f.close(); }
});

/** A topic wiki made the way create-or-update-wiki makes one, built once, then paused over MCP (#425). */
async function topicFixture() {
  const f = await fixture();
  Object.assign(f.deps.config, { topicRequestMaxBytes: 204800, topicPageRequestMaxBytes: 98304, topicSourceExcerptMaxBytes: 24576,
    webSearchResults: 5, webFetchTop: 1, webFetchCharCap: 4000 });
  const topic = 'Tidal Power';
  const tscope = (facet: string) => ({ v: 1 as const, subject: topic, facet });
  const root = f.mutate({ source: 'tool', node_id: null, file_path: 'Topics/Tidal Power.md', title: topic, types: ['topic'], fields: {}, body: '' });
  const note = f.mutate({ source: 'tool', node_id: null, file_path: 'Tide Note.md', title: 'Tide Note', types: ['note'], fields: {}, body: 'tidal note γ' });
  registerWikiRoot(f.deps.db!, { root_title: topic, root_node_id: root.node_id, kind: 'topic', source: 'vault+web', cadence: '7d',
    brief: 'Tidal energy.', created_at: '2026-11-07T00:00:00.000Z', created_by: 'test' });
  replaceExplicitTopicRefreshSources(f.deps.db!, topic, [note.node_id]);
  // No search provider in this fixture: the Curator's own Engine client answers web research.
  const searches: string[] = [];
  f.deps.engine.webSearch = async query => {
    searches.push(query);
    return [{ url: 'https://example.com/tides', title: 'Tide report', snippet: `web result ${searches.length}` }];
  };
  f.deps.engine.fetchUrl = async url => ({ url, content: `web page ${searches.length}` });
  f.setPlan({ reviewed_page_ids: [], actions: ['Decisions', 'Risks'].map(facet => ({
    op: 'create', plan_key: facet, title: `${topic} — ${facet}`, kind: 'workstream', scope: tscope(facet), synthesis_brief: `Write ${facet}.`, evidence_ids: [],
  })) });
  const built = await curateTopicTimed(f.deps, { id: root.node_id, title: topic, file_path: '', status: null },
    { brief: 'Tidal energy.', source: 'vault+web', cadence: '7d' }, { dryRun: false, force: true, trigger: 'on-demand' });
  assert.equal(built.outcome, 'written', JSON.stringify(built));
  await f.onCurator('set-wiki-paused', { project: topic, paused: true });
  return { ...f, topic, root, note, searches, tscope };
}

test('parity: a paused topic wiki, from a page\'s title or node id, is rebuilt whole with web research, stays paused, and sweeps skip it', async () => {
  const f = await topicFixture();
  try {
    type Rel = { relationships: { outgoing: Record<string, Array<{ target_id: string | null }>> } };
    type WikiStatus = { kind: string | null; root_node_id: string | null; source: string | null; paused: boolean;
      in_progress: unknown; latest_run: { outcome: string } | null };
    /** The chain a caller needs: the page's wiki_for names its root note, whose title names the wiki. */
    const wikiOf = async (ref: { title: string } | { node_id: string }) => {
      const page = await f.onEngine<Rel & { id: string }>('get-node', ref);
      const owners = page.relationships.outgoing.wiki_for ?? [];
      assert.equal(owners.length, 1, JSON.stringify(page.relationships));
      const root = await f.onEngine<{ id: string; title: string }>('get-node', { node_id: owners[0]!.target_id });
      // A topic wiki keeps no build records, so the page-level chain (inspect-provenance) has nothing to start from.
      const history = await f.onEngine<{ outputs: unknown[] }>('inspect-provenance', { select: 'node', node_id: page.id });
      assert.deepEqual(history.outputs, []);
      return root;
    };
    const nodes = f.nodes();
    const home = nodes.get(`${f.topic} Wiki`)!;
    for (const ref of [{ title: `${f.topic} — Decisions` }, { node_id: home.id }]) {
      const root = await wikiOf(ref);
      assert.equal(root.id, f.root.node_id);
      assert.equal(root.title, f.topic);
    }
    const status = await f.onCurator<WikiStatus>('curator-status', { project: f.topic });
    assert.equal(status.kind, 'topic');
    assert.equal(status.root_node_id, f.root.node_id);
    assert.equal(status.source, 'vault+web');
    assert.equal(status.paused, true);

    // Without force, a paused topic wiki is answered at once and nothing runs.
    const calls = f.sent.length, searched = f.searches.length;
    const refused = await f.onCurator<{ results: Array<{ outcome: string; detail: string }> }>('curate-project-wiki', { project: f.topic });
    assert.deepEqual([refused.results[0]!.outcome, refused.results[0]!.detail], ['skipped', 'paused']);
    // The free check spends nothing: no model call, no web search.
    const check = await f.onCurator<{ results: Array<{ outcome: string; evidence_unchanged?: boolean }> }>('curate-project-wiki',
      { project: f.topic, dry_run: true, force: true });
    assert.equal(check.results[0]!.outcome, 'would_curate', JSON.stringify(check));
    assert.equal(check.results[0]!.evidence_unchanged, true);
    assert.equal(f.sent.length, calls);
    assert.equal(f.searches.length, searched);

    const [decisions, risks] = [nodes.get(`${f.topic} — Decisions`)!.id, nodes.get(`${f.topic} — Risks`)!.id];
    f.setPlan({ reviewed_page_ids: [decisions, risks], actions: [
      { op: 'refresh', node_id: decisions, scope: f.tscope('Decisions'), synthesis_brief: 'Refresh.' },
      { op: 'keep', node_id: risks, scope: f.tscope('Risks') },
    ] });
    const started = await f.onCurator<{ status: string }>('curate-project-wiki', { project: f.topic, force: true });
    assert.equal(started.status, 'queued', JSON.stringify(started));
    const done = await f.until(() => f.onCurator<WikiStatus>('curator-status', { project: f.topic }), value => value.in_progress === null);
    assert.equal(done.latest_run?.outcome, 'written', JSON.stringify(done));
    assert.equal(done.paused, true, 'a rebuild does not resume the wiki');
    assert.equal(f.searches.length, searched + 1, 'the rebuild runs the topic\'s web research');
    assert.ok(f.sent.length > calls);
    const evidence = f.sent.slice(calls).map(payload => JSON.stringify(payload.messages)).join('\n');
    assert.ok(evidence.includes(`web page ${searched + 1}`), 'the new web material reaches the model');
    const after = f.nodes();
    assert.notEqual(after.get(`${f.topic} Wiki`)!.body, home.body);
    assert.notEqual(after.get(`${f.topic} — Decisions`)!.body, nodes.get(`${f.topic} — Decisions`)!.body);

    // A sweep names no wiki, and pause still keeps it out.
    const spent = f.sent.length;
    const sweep = await f.onCurator<{ results: Array<{ project: string }> }>('curate-project-wiki', { dry_run: true });
    assert.ok(!sweep.results.some(result => result.project === f.topic), JSON.stringify(sweep));
    assert.equal(f.sent.length, spent);
  } finally { await f.close(); }
});
