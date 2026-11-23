// Real Engine and Curator MCP boundaries; disposable storage, counting synthetic provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type OpenAI from 'openai';
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
import { Engine } from '../packages/curator/src/engine.js';
import { curateProject } from '../packages/curator/src/curate.js';
import { OpenAiCompatLlmClient } from '../packages/curator/src/llm/openai-compat.js';
import { runMigrations } from '../packages/curator/src/db/migrate.js';
import { CurationQueue } from '../packages/curator/src/queue.js';
import { curatorServerFactory } from '../packages/curator/src/server-bootstrap.js';
import { ServerLifecycle } from '../packages/curator/src/server-lifecycle.js';
import type { Config } from '../packages/curator/src/config.js';
import type { CoreDeps } from '../packages/curator/src/core.js';
import type { HomeRefreshPreview, HomeRefreshRequest, HomeRefreshStatus } from '../packages/curator/src/home-refresh-types.js';
import { recoverHomeRefreshes, readHomeRefreshStatus } from '../packages/curator/src/home-refresh.js';
import { shouldSkipReconciliation } from '../packages/curator/src/write-pages.js';
import { loadWikiNodeFields } from '../packages/engine/src/wiki/write-helpers.js';
import { SettingsService } from '../packages/engine/src/settings/service.js';
import { extractManagedSection } from '../packages/engine/src/wiki/sections.js';

async function fixture(options: { initialOptionalSections?: boolean } = {}) {
  const db = createTestDb(), vault = createTempVault(), writeLock = new WriteLockManager();
  const settings = new SettingsService(db, { settingsDir: 'Settings' });
  const dbPath = join(vault.vaultPath, 'test-curator.db');
  let curatorDb = new Database(dbPath); runMigrations(curatorDb);
  db.prepare("INSERT INTO schemas(name,display_name,field_claims) VALUES ('project','Project','[]')").run();
  const mutate = (input: Parameters<typeof executeMutation>[3]) => executeMutation(db, writeLock, vault.vaultPath, input);
  const project = mutate({ source: 'tool', node_id: null, file_path: 'Project.md', title: 'Project', types: ['project'], fields: {}, body: 'Original evidence.' });
  const other = mutate({ source: 'tool', node_id: null, file_path: 'Other.md', title: 'Other', types: ['project'], fields: {}, body: 'Other project.' });
  const config = { wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0,
    wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit',
    projectHomeProvenanceEnabled: true, model: 'synthetic', modelProviders: { synthetic: 'openrouter' },
    homeMaxTokens: 4000, meetingReads: 5, noteReads: 5, bodyCharCap: null, semanticGapFill: false, memoryWriteEnabled: false } as unknown as Config;
  const servers: McpServer[] = [];
  let intercept: ((name: string, args: Record<string, unknown>, result: unknown) => void) | null = null;
  const engine = new Engine(config, () => {
    const server = new McpServer({ name: 'engine-fixture', version: '1' }); servers.push(server);
    registerGetNode(server, db); registerProjectEvidence(server, db); registerMemoriesTools(server, new MemoryService(db));
    registerProvenance(server, db, settings); registerWikiReconcile(server, { db, vaultPath: vault.vaultPath, writeLock });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'curator-engine-fixture', version: '1' });
    return { transport: ct, client: { connect: async () => { await server.connect(st); await client.connect(ct); },
      callTool: async req => { const result = await client.callTool(req); intercept?.(req.name, req.arguments, result); return { content: result.content }; } } };
  });
  let count = 0;
  let homeOutput: Record<string, unknown> | undefined;
  let duringModel: (() => void) | null = null;
  const adapter = new OpenAiCompatLlmClient({ chat: { completions: { create: async (payload: any) => {
    count++; duringModel?.();
    const output = payload.response_format?.json_schema.name === 'emit_topology_plan' ? { reviewed_page_ids: [], actions: [] }
      : homeOutput ?? { now: `Summary ${count}`, focus: [{ title: 'Focus' }], open_threads: [{ title: 'None' }], log_entry: 'Refreshed home',
        ...(options.initialOptionalSections ? { at_a_glance: 'Old overview', sources: 'Old sources' } : {}) };
    return { choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  } } } } as unknown as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
  for (const p of [project, other]) {
    const title = p.node_id === project.node_id ? 'Project' : 'Other';
    const result = await curateProject(engine, adapter, config, { id: p.node_id, title, file_path: title + '.md', status: null }, false, true);
    assert.equal(result.outcome, 'written', JSON.stringify(result));
  }
  const home = (await engine.projectEvidence(project.node_id)).existing_wiki.home_id!;
  const homeNode = await engine.getNode(home);
  assert.ok(homeNode.file_path && homeNode.title);
  mutate({ source: 'tool', node_id: home, file_path: homeNode.file_path, title: homeNode.title, types: homeNode.types,
    fields: loadWikiNodeFields(db, home), body: 'Human introduction.\n\n' + homeNode.body });
  mutate({ source: 'tool', node_id: null, file_path: 'Wikis/Subpage.md', title: 'Subpage', types: ['wiki'],
    fields: { wiki_for: 'Project', wiki_parent: homeNode.title!, wiki_kind: 'workstream', wiki_state: 'active',
      wiki_scope: JSON.stringify({ v: 1, subject: 'Project', facet: 'Details' }) }, body: 'Subpage content stays.' });
  const old = (await engine.inspectProvenance({ select: 'node', node_id: home }));
  assert.equal(old.select, 'node'); if (old.select !== 'node') throw Error('node');
  const outputId = old.outputs[0]!.receipt.output_revision_id;
  const deps: CoreDeps = { engine, llm: adapter, config, queue: new CurationQueue(), db: curatorDb };
  const lifecycle = new ServerLifecycle();
  const curatorServer = curatorServerFactory(async () => deps, new Date(), undefined, lifecycle)(); servers.push(curatorServer);
  // Actual SDK dispatch still runs the production scope wrapper.
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const send = ct.send.bind(ct);
  let scopes = ['curate:read', 'curate:trigger'];
  ct.send = message => send(message, { authInfo: { token: 'synthetic', clientId: 'fixture', scopes } });
  const client = new Client({ name: 'plugin-fixture', version: '1' });
  await curatorServer.connect(st); await client.connect(ct);
  const rawCall = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const data = await rawCall(name, args);
    assert.equal(data.ok, true, JSON.stringify(data)); return data.data as T;
  };
  return { db, curatorDb, deps, engine, home, project, outputId, call, rawCall, settings,
    setScopes: (next: string[]) => { scopes = next; },
    stopAdmission: () => lifecycle.stop(),
    reopen: () => { curatorDb.close(); curatorDb = new Database(dbPath); runMigrations(curatorDb); deps.db = curatorDb; },
    count: () => count, setIntercept: (fn: typeof intercept) => { intercept = fn; },
    setHomeOutput: (output: Record<string, unknown>) => { homeOutput = output; },
    setDuringModel: (fn: typeof duringModel) => { duringModel = fn; },
    drain: () => deps.queue.enqueue('acceptance-drain', async () => {}),
    snapshot: () => db.prepare('SELECT id,body,version FROM nodes ORDER BY id').all() as Array<{ id: string; body: string; version: number }>,
    close: async () => { await client.close(); await engine.close(); await Promise.all(servers.map(s => s.close())); curatorDb.close(); db.close(); vault.cleanup(); },
  };
}
test('real MCP: free preview, one selected home, durable result and explicit replacement lineage', async () => {
  const f = await fixture();
  try {
    const before = f.snapshot(), count = f.count();
    const stamps = f.db.prepare("SELECT * FROM node_fields WHERE node_id=? AND field_name IN ('wiki_evidence_hash','wiki_topology_hash','wiki_curated_at') ORDER BY field_name").all(f.home);
    const preview = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: f.outputId });
    assert.equal(preview.eligible, true, JSON.stringify(preview));
    assert.equal(f.count(), count);
    const request: HomeRefreshRequest = { request_id: randomUUID(), guard: preview.guard!, confirm_paid: true };
    await f.call('refresh-wiki-page', request); await f.drain();
    const result = await f.call<HomeRefreshStatus>('wiki-refresh-status', { request_id: request.request_id });
    assert.equal(result.phase, 'committed', JSON.stringify(result));
    assert.equal(f.count(), count + 1);
    assert.equal(result.output!.replaces_output_revision_id, f.outputId);
    assert.deepEqual(f.snapshot().filter(n => n.id !== f.home), before.filter(n => n.id !== f.home));
    assert.match(f.snapshot().find(n => n.id === f.home)!.body, /Human introduction/);
    assert.deepEqual(f.db.prepare("SELECT * FROM node_fields WHERE node_id=? AND field_name IN ('wiki_evidence_hash','wiki_topology_hash','wiki_curated_at') ORDER BY field_name").all(f.home), stamps);
    assert.deepEqual(await f.call('refresh-wiki-page', request), result);
    assert.equal(f.count(), count + 1);
    const evidence = await f.engine.projectEvidence(f.project.node_id);
    assert.equal(shouldSkipReconciliation({ existingWiki: evidence.existing_wiki, evidenceHash: evidence.evidence_hash, force: false, refreshDue: false }), false);
    assert.equal((await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: f.outputId })).eligible, false);
  } finally { await f.close(); }
});
test('real MCP: read-only authorization rejects before admission and corrected scopes allow a fresh request', async () => {
  const f = await fixture();
  try {
    const count = f.count();
    f.setScopes(['curate:read']);
    const preview = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: f.outputId });
    assert.equal(preview.eligible, true);
    const rejected: HomeRefreshRequest = { request_id: randomUUID(), guard: preview.guard!, confirm_paid: true };
    const response = await f.rawCall('refresh-wiki-page', rejected);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'FORBIDDEN');
    assert.deepEqual(f.deps.db!.prepare('SELECT COUNT(*) AS count FROM home_refresh_requests').get(), { count: 0 });
    assert.equal(f.count(), count);
    f.setScopes(['curate:read', 'curate:trigger']);
    const ready = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: f.outputId });
    const fresh: HomeRefreshRequest = { request_id: randomUUID(), guard: ready.guard!, confirm_paid: true };
    await f.call('refresh-wiki-page', fresh); await f.drain();
    assert.equal((await f.call<HomeRefreshStatus>('wiki-refresh-status', { request_id: fresh.request_id })).phase, 'committed');
    assert.equal(f.count(), count + 1);
  } finally { await f.close(); }
});
for (const code of ['READINESS_UNAVAILABLE', 'SHUTTING_DOWN']) {
  test(`real MCP: ${code} is a precise rejection before admission or paid work`, async () => {
    const f = await fixture();
    try {
      const before = f.snapshot(), count = f.count();
      const preview = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: f.outputId });
      assert.equal(preview.eligible, true);
      const rejected: HomeRefreshRequest = { request_id: randomUUID(), guard: preview.guard!, confirm_paid: true };
      if (code === 'SHUTTING_DOWN') await f.stopAdmission();
      else f.deps.refreshDeps = async () => { throw Error('Settings temporarily unavailable'); };
      const response = await f.rawCall('refresh-wiki-page', rejected);
      assert.equal(response.ok, false);
      assert.equal(response.error.code, code);
      assert.deepEqual(f.deps.db!.prepare('SELECT COUNT(*) AS count FROM home_refresh_requests').get(), { count: 0 });
      assert.equal(f.count(), count);
      assert.deepEqual(f.snapshot(), before);
      if (code === 'READINESS_UNAVAILABLE') {
        f.deps.refreshDeps = undefined;
        const ready = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: f.outputId });
        assert.equal(ready.eligible, true);
        const fresh: HomeRefreshRequest = { request_id: randomUUID(), guard: ready.guard!, confirm_paid: true };
        await f.call('refresh-wiki-page', fresh); await f.drain();
        assert.equal((await f.call<HomeRefreshStatus>('wiki-refresh-status', { request_id: fresh.request_id })).phase, 'committed');
        assert.equal(f.count(), count + 1);
      }
    } finally { await f.close(); }
  });
}
test('real MCP: omitted optional sections are cleared and tracked by the new capture', async () => {
  const f = await fixture({ initialOptionalSections: true });
  try {
    const before = f.snapshot(), count = f.count();
    f.setHomeOutput({ now: 'New now', focus: [{ title: 'New focus' }], open_threads: [{ title: 'None' }], log_entry: 'Changed summary' });
    const preview = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: f.outputId });
    const request: HomeRefreshRequest = { request_id: randomUUID(), guard: preview.guard!, confirm_paid: true };
    await f.call('refresh-wiki-page', request); await f.drain();
    const result = await f.call<HomeRefreshStatus>('wiki-refresh-status', { request_id: request.request_id });
    assert.equal(result.phase, 'committed');
    const body = (await f.engine.getNode(f.home)).body!;
    assert.equal(extractManagedSection(body, 'At a glance', 1000), '');
    assert.equal(extractManagedSection(body, 'Sources', 1000), '');
    assert.equal(extractManagedSection(body, 'Now', 1000), 'New now');
    assert.match(body, /Human introduction/);
    assert.deepEqual(f.snapshot().filter(n => n.id !== f.home), before.filter(n => n.id !== f.home));
    const current = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: result.output!.output_revision_id });
    assert.equal(current.eligible, true, JSON.stringify(current));
    // An edit to an explicitly cleared section must still invalidate this output.
    f.db.prepare('UPDATE nodes SET body=? WHERE id=?').run(body.replace('<!-- ve:managed:Sources -->', '<!-- ve:managed:Sources -->\nManual edit'), f.home);
    const edited = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: result.output!.output_revision_id });
    assert.equal(edited.eligible, false);
    assert.ok(edited.reasons.some(reason => reason.code === 'MANAGED_CONTENT_CHANGED'));
    assert.equal(f.count(), count + 1);
  } finally { await f.close(); }
});
test('real MCP: identical same-time refreshes stay eligible and append one distinct log entry each', async () => {
  const f = await fixture();
  let release = () => {};
  try {
    const before = f.snapshot(), count = f.count();
    f.setHomeOutput({ now: 'Unchanged now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'None' }], log_entry: 'Same log entry' });
    let outputId = f.outputId;
    const logs: string[] = [];
    for (let i = 0; i < 2; i++) {
      const preview = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: outputId });
      assert.equal(preview.eligible, true, JSON.stringify(preview));
      const request: HomeRefreshRequest = { request_id: randomUUID(), guard: preview.guard!, confirm_paid: true };
      void f.deps.queue.enqueue('hold-clock', () => new Promise<void>(resolve => { release = resolve; }));
      await f.call('refresh-wiki-page', request);
      f.deps.db!.prepare('UPDATE home_refresh_requests SET generated_at=? WHERE request_id=?')
        .run('2026-09-21T12:00:00.000Z', request.request_id);
      release(); await f.drain();
      const result = await f.call<HomeRefreshStatus>('wiki-refresh-status', { request_id: request.request_id });
      assert.equal(result.phase, 'committed', JSON.stringify(result));
      assert.equal(result.output!.replaces_output_revision_id, outputId);
      outputId = result.output!.output_revision_id;
      const body = (await f.engine.getNode(f.home)).body!;
      const log = extractManagedSection(body, 'Log', Number.MAX_SAFE_INTEGER)!;
      assert.equal(log.split('Same log entry').length - 1, i + 1);
      logs.push(log);
      assert.deepEqual(await f.call('refresh-wiki-page', request), result);
      assert.equal((await f.engine.getNode(f.home)).body, body);
      assert.equal(f.count(), count + i + 1);
      const next = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: outputId });
      assert.equal(next.eligible, true, JSON.stringify(next));
    }
    assert.notEqual(logs[0], logs[1]);
    assert.deepEqual(f.snapshot().filter(n => n.id !== f.home), before.filter(n => n.id !== f.home));
  } finally { release(); await f.drain(); await f.close(); }
});
test('real MCP: protected evidence budget failure terminates and frees the home for a new request', async () => {
  const f = await fixture();
  try {
    const before = f.snapshot(), count = f.count();
    assert.deepEqual(f.settings.applyPatch('engine', { provenanceComponentBytes: 1 }).issues, []);
    const preview = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: f.outputId });
    assert.equal(preview.eligible, true);
    const request: HomeRefreshRequest = { request_id: randomUUID(), guard: preview.guard!, confirm_paid: true };
    await f.call('refresh-wiki-page', request); await f.drain();
    const failed = await f.call<HomeRefreshStatus>('wiki-refresh-status', { request_id: request.request_id });
    assert.equal(failed.phase, 'failed', JSON.stringify(failed));
    assert.match(failed.message, /evidence.*limit/i);
    f.reopen(); recoverHomeRefreshes(f.deps); await f.drain();
    assert.deepEqual(await f.call('refresh-wiki-page', request), failed);
    assert.equal(f.count(), count);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.settings.applyPatch('engine', { provenanceComponentBytes: 262144 }).issues, []);
    const ready = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: f.outputId });
    const replacement: HomeRefreshRequest = { ...request, request_id: randomUUID(), guard: ready.guard! };
    assert.equal((await f.call<HomeRefreshStatus>('refresh-wiki-page', replacement)).request_id, replacement.request_id);
    await f.drain();
    assert.equal((await f.call<HomeRefreshStatus>('wiki-refresh-status', { request_id: replacement.request_id })).phase, 'committed');
    assert.equal(f.count(), count + 1);
  } finally { await f.close(); }
});
test('real MCP: coalesced UUID survives a lost admission reply, terminal completion and database reopen', async () => {
  const f = await fixture();
  let release = () => {};
  try {
    const preview = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: f.outputId });
    const a: HomeRefreshRequest = { request_id: randomUUID(), guard: preview.guard!, confirm_paid: true };
    const b = { ...a, request_id: randomUUID() };
    void f.deps.queue.enqueue('hold', () => new Promise<void>(resolve => { release = resolve; }));
    const count = f.count();
    await f.call('refresh-wiki-page', a);
    // The caller loses this response, retaining only B's stable identity.
    await f.call('refresh-wiki-page', b);
    release(); await f.drain(); f.reopen();
    const status = await f.call<HomeRefreshStatus>('wiki-refresh-status', { request_id: b.request_id });
    assert.equal(status.request_id, a.request_id);
    assert.equal(status.phase, 'committed');
    assert.deepEqual(await f.call('refresh-wiki-page', b), status);
    assert.equal(f.count(), count + 1);
  } finally { release(); await f.drain(); await f.close(); }
});
for (const mode of ['queued-readiness', 'prepared-readiness', 'prepared-settings'] as const) {
  test(`real MCP: ${mode} recovers the admitted UUID after database reopen`, async () => {
    const f = await fixture();
    let release = () => {};
    try {
      const preview = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: f.outputId });
      const request: HomeRefreshRequest = { request_id: randomUUID(), guard: preview.guard!, confirm_paid: true };
      const count = f.count();
      void f.deps.queue.enqueue('hold', () => new Promise<void>(resolve => { release = resolve; }));
      await f.call('refresh-wiki-page', request);
      let prepared = false;
      f.setIntercept((name, args) => {
        if (name === 'provenance-prepare' && args.dry_run === false) prepared = true;
        if (name === 'inspect-provenance' && args.select === 'refresh_target'
          && (mode === 'queued-readiness' || mode === 'prepared-readiness' && prepared)) throw Error('Offline');
      });
      if (mode === 'prepared-settings') f.deps.refreshDeps = async () => {
        if (prepared) throw Error('Strict settings temporarily unavailable');
        return f.deps;
      };
      release(); await f.drain();
      assert.equal(readHomeRefreshStatus(f.deps, request.request_id).phase, 'awaiting_recovery');
      assert.equal(f.count(), count);
      f.setIntercept(null); f.deps.refreshDeps = undefined;
      f.reopen(); recoverHomeRefreshes(f.deps); await f.drain();
      const result = await f.call<HomeRefreshStatus>('wiki-refresh-status', { request_id: request.request_id });
      assert.equal(result.phase, 'committed', JSON.stringify(result));
      assert.equal(f.count(), count + 1);
      assert.deepEqual(await f.call('refresh-wiki-page', request), result);
      assert.equal(f.count(), count + 1);
      const attempts = f.db.prepare('SELECT state FROM provenance_derivations WHERE run_ref=? ORDER BY state')
        .all((f.deps.db!.prepare('SELECT run_ref FROM home_refresh_requests WHERE request_id=?').get(request.request_id) as { run_ref: string }).run_ref);
      assert.deepEqual(attempts, mode === 'queued-readiness' ? [{ state: 'committed' }] : [{ state: 'abandoned' }, { state: 'committed' }]);
    } finally { release(); await f.drain(); await f.close(); }
  });
}
test('real MCP: a lost mark-sent reply stays uncertain on recovery without provider dispatch', async () => {
  const f = await fixture();
  try {
    const preview = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: f.outputId });
    const request: HomeRefreshRequest = { request_id: randomUUID(), guard: preview.guard!, confirm_paid: true };
    const count = f.count();
    f.setIntercept((name, args) => {
      if (name === 'provenance-transition' && args.action === 'mark-sent') throw Error('Lost mark-sent reply');
    });
    await f.call('refresh-wiki-page', request); await f.drain();
    assert.equal(readHomeRefreshStatus(f.deps, request.request_id).phase, 'uncertain');
    f.setIntercept(null); f.reopen(); recoverHomeRefreshes(f.deps); await f.drain();
    assert.equal((await f.call<HomeRefreshStatus>('refresh-wiki-page', request)).phase, 'uncertain');
    assert.equal(f.count(), count);
  } finally { await f.close(); }
});
for (const phase of ['dispatch_intent', 'stage_pending'] as const) {
  test(`real MCP: failed ${phase} persistence respects the paid-call boundary on recovery`, async () => {
    const f = await fixture();
    try {
      const preview = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: f.outputId });
      const request: HomeRefreshRequest = { request_id: randomUUID(), guard: preview.guard!, confirm_paid: true };
      const count = f.count();
      // Fail the actual SQLite checkpoint, not a mocked orchestrator method.
      f.deps.db!.exec(`CREATE TRIGGER fail_refresh_checkpoint BEFORE UPDATE ON home_refresh_requests
        WHEN NEW.phase = '${phase}' BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END`);
      await f.call('refresh-wiki-page', request); await f.drain();
      assert.equal(readHomeRefreshStatus(f.deps, request.request_id).phase,
        phase === 'dispatch_intent' ? 'awaiting_recovery' : 'uncertain');
      assert.equal(f.count(), count + (phase === 'dispatch_intent' ? 0 : 1));
      f.deps.db!.exec('DROP TRIGGER fail_refresh_checkpoint');
      f.reopen(); recoverHomeRefreshes(f.deps); await f.drain();
      const result = await f.call<HomeRefreshStatus>('wiki-refresh-status', { request_id: request.request_id });
      assert.equal(result.phase, phase === 'dispatch_intent' ? 'committed' : 'uncertain');
      assert.equal(f.count(), count + 1);
      assert.deepEqual(await f.call('refresh-wiki-page', request), result);
      assert.equal(f.count(), count + 1);
    } finally { await f.close(); }
  });
}
for (const mode of ['preflight-offline', 'prepare-reply-lost', 'abandon-reply-lost', 'stage-reply-lost', 'commit-reply-lost', 'home-edited', 'source-changed', 'capture-purged', 'output-limit'] as const) {
  test(`real MCP: ${mode} does not dispatch a second paid call`, async () => {
    const f = await fixture();
    try {
      const preview = await f.call<HomeRefreshPreview>('preview-wiki-refresh', { output_revision_id: f.outputId });
      const request: HomeRefreshRequest = { request_id: randomUUID(), guard: preview.guard!, confirm_paid: true };
      const count = f.count();
      if (mode === 'output-limit') f.setDuringModel(() => {
        assert.deepEqual(f.settings.applyPatch('engine', { provenanceOutputBytes: 1 }).issues, []);
      });
      f.setIntercept((name, args) => {
        if (mode === 'preflight-offline' && name === 'provenance-prepare' && args.dry_run === true) throw Error('Offline');
        if ((mode === 'prepare-reply-lost' || mode === 'abandon-reply-lost') && name === 'provenance-prepare' && args.dry_run === false) throw Error('Lost prepare reply');
        if (mode === 'stage-reply-lost' && name === 'provenance-stage-result') throw Error('Lost stage reply');
        if (mode === 'commit-reply-lost' && name === 'wiki-reconcile' && args.dry_run === false) throw Error('Lost commit reply');
        if (mode === 'capture-purged' && name === 'provenance-stage-result') {
          f.db.prepare("UPDATE provenance_derivations SET availability='purged' WHERE id=?").run(args.derivation_id);
        }
      });
      if (mode === 'home-edited' || mode === 'source-changed') f.setDuringModel(() => {
        f.db.prepare('UPDATE nodes SET version=version+1 WHERE id=?').run(mode === 'home-edited' ? f.home : f.project.node_id);
      });
      await f.call('refresh-wiki-page', request); await f.drain();
      if (mode === 'home-edited' || mode === 'output-limit') {
        const attempt = f.db.prepare(`SELECT state,reserved_remaining_bytes FROM provenance_derivations
          WHERE attempt_key=(?)`).get((f.deps.db!.prepare('SELECT attempt_key FROM home_refresh_requests WHERE request_id=?')
            .get(request.request_id) as { attempt_key: string }).attempt_key);
        assert.deepEqual(attempt, { state: 'failed', reserved_remaining_bytes: 0 });
      }
      if (mode === 'abandon-reply-lost') {
        f.setIntercept((name, args) => { if (name === 'provenance-transition' && args.action === 'abandon') throw Error('Lost abandonment reply'); });
        f.reopen(); recoverHomeRefreshes(f.deps); await f.drain();
      }
      f.setIntercept(null); f.reopen(); recoverHomeRefreshes(f.deps); await f.drain();
      const result = readHomeRefreshStatus(f.deps, request.request_id);
      assert.equal(result.phase, mode === 'home-edited' ? 'conflict' : mode === 'capture-purged' || mode === 'output-limit' ? 'failed' : 'committed', JSON.stringify(result));
      assert.equal(f.count(), count + 1);
    } finally { await f.close(); }
  });
}
