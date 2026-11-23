// Cross-surface integration lives at the repository composition boundary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
import { registerUpdateNode } from '../packages/engine/src/mcp/tools/update-node.js';
import { registerDeleteNode } from '../packages/engine/src/mcp/tools/delete-node.js';
import { previewProvenancePurge, commitProvenancePurge } from '../packages/engine/src/provenance/purge.js';
import { Engine } from '../packages/curator/src/engine.js';
import { curateProject } from '../packages/curator/src/curate.js';
import { OpenAiCompatLlmClient } from '../packages/curator/src/llm/openai-compat.js';
import { UsageReporter } from '../packages/curator/src/usage-reporter.js';
import { validateBundle } from '../packages/engine/src/provenance/validation.js';
import { DEFAULT_PROVENANCE_LIMITS } from '../packages/engine/src/provenance/limits.js';
import { measureBundle } from '../packages/curator/src/provenance-budget.js';
import { canonical } from '../packages/curator/src/provenance-evidence.js';
import type { BundleV1, Json } from '../packages/curator/src/provenance-types.js';
import type { Config } from '../packages/curator/src/config.js';

async function fixture(options: { optionalBody?: string; sourceBody?: string; gapFill?: 'mixed' | 'all-failed' | 'missing-observation' | 'oversized'; largeProject?: boolean; dryRun?: boolean; preview?: boolean; loseCommitReply?: boolean; failHome?: boolean; loseReply?: string; failCapture?: 'prepare' | 'stage'; changeBeforePrepare?: boolean; changeAfterPrepare?: boolean; purgeAfterStage?: boolean } = {}) {
  const db = createTestDb(); const vault = createTempVault(); const writeLock = new WriteLockManager();
  db.prepare("INSERT INTO schemas(name,display_name,field_claims) VALUES ('project','Project','[]'),('note','Note','[]')").run();
  const project = executeMutation(db, writeLock, vault.vaultPath, { source: 'tool', node_id: null, file_path: 'Project.md', title: 'Project', types: ['project'], fields: {}, body: 'Synthetic project context.' });
  const source = executeMutation(db, writeLock, vault.vaultPath, { source: 'tool', node_id: null, file_path: 'Source.md', title: 'Source', types: ['note'], fields: {}, body: options.sourceBody ?? 'ORIGINAL CAPTURE é😀 — the source used for generation.' });
  db.prepare("INSERT INTO relationships(source_id,target,resolved_target_id,rel_type,context) VALUES (?,'Project',?,'project','synthetic fixture')").run(source.node_id, project.node_id);
  if (options.largeProject) {
    // More represented IDs than the metadata cap, but few rendered task rows.
    db.transaction(() => {
      for (let index = 0; index < 520; index++) {
        const id = `!bulk-${String(index).padStart(4, '0')}`;
        db.prepare('INSERT INTO nodes(id,file_path,title,body,file_mtime) VALUES (?,?,?,?,?)').run(id, `${id}.md`, id, 'Synthetic task', Date.now());
        db.prepare("INSERT INTO node_types(node_id,schema_type) VALUES (?,'task')").run(id);
        db.prepare("INSERT INTO relationships(source_id,target,resolved_target_id,rel_type,context) VALUES (?,'Project',?,'project','synthetic fixture')").run(id, project.node_id);
      }
    })();
  }
  if (options.failCapture) db.exec(`CREATE TRIGGER fail_capture BEFORE INSERT ON provenance_payloads
    WHEN NEW.kind='${options.failCapture === 'prepare' ? 'request' : 'staged_result'}'
    BEGIN SELECT RAISE(ABORT,'database or disk is full'); END;`);
  const servers: McpServer[] = []; const clients: Client[] = [];
  let lost = false; let commits = 0;
  const bundles: BundleV1[] = [];
  const config = { wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0,
    wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit',
    projectHomeProvenanceEnabled: true, model: 'synthetic', homeMaxTokens: 4000, meetingReads: 5, noteReads: 5,
    bodyCharCap: null, semanticGapFill: options.gapFill !== undefined, semanticGapFillLimit: 5, semanticGapFillBodyReads: 2, memoryWriteEnabled: false, memoryWriteCap: 3 } as Config;
  const engine = new Engine(config, () => {
    const server = new McpServer({ name: 'provenance-fixture', version: '1' }); servers.push(server);
    registerGetNode(server, db); registerProjectEvidence(server, db); registerMemoriesTools(server, new MemoryService(db));
    registerProvenance(server, db); registerWikiReconcile(server, { db, writeLock, vaultPath: vault.vaultPath });
    registerUpdateNode(server, db, writeLock, vault.vaultPath); registerDeleteNode(server, db, writeLock, vault.vaultPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'curator-fixture', version: '1' }); clients.push(client);
    return { transport: clientTransport, client: {
      connect: async () => { await server.connect(serverTransport); await client.connect(clientTransport); },
      callTool: async req => {
        if (req.name === 'provenance-prepare') bundles.push(req.arguments.bundle as BundleV1);
        const realPrepare = req.name === 'provenance-prepare' && req.arguments.dry_run === false;
        if (options.changeBeforePrepare && realPrepare) db.prepare('UPDATE nodes SET version=version+1 WHERE id=?').run(source.node_id);
        const result = await client.callTool(req);
        if (options.changeAfterPrepare && realPrepare) db.prepare('UPDATE nodes SET version=version+1 WHERE id=?').run(source.node_id);
        if (options.purgeAfterStage && req.name === 'provenance-stage-result') {
          const ids = db.prepare('SELECT id FROM provenance_derivations').all() as Array<{ id: string }>;
          const scope = { derivation_ids: ids.map(row => row.id) }; const preview = previewProvenancePurge(db, scope);
          commitProvenancePurge(db, { scope, scope_token: preview.scope_token, confirm: true });
        }
        if (options.loseReply === req.name && (req.name !== 'provenance-prepare' || realPrepare) && !lost) { lost = true; throw new Error('Simulated lost transport reply'); }
        if (req.name === 'wiki-reconcile' && req.arguments.dry_run === false) {
          commits++;
          if (options.loseCommitReply && !lost) { lost = true; throw new Error('Simulated lost transport reply'); }
        }
        return { content: result.content };
      },
    } };
  });
  let optionalId: string | undefined;
  if (options.gapFill) {
    const optional = executeMutation(db, writeLock, vault.vaultPath, { source: 'tool', node_id: null,
      file_path: 'Optional.md', title: 'Optional valid candidate', types: ['note'], fields: {}, body: options.optionalBody ?? 'OPTIONAL CAPTURE CONTENT' });
    optionalId = optional.node_id;
    // Search is synthetic; candidate reads, capture and publication use real Engine MCP.
    engine.semanticRelated = async () => options.gapFill === 'missing-observation' || options.gapFill === 'oversized'
      ? [{ id: optional.node_id, title: 'Optional valid candidate', types: ['note'], status: null }]
      : [{ id: 'missing-optional-1', title: 'UNAVAILABLE CANDIDATE ONE', types: ['note'], status: null },
        options.gapFill === 'all-failed'
          ? { id: 'missing-optional-2', title: 'UNAVAILABLE CANDIDATE TWO', types: ['note'], status: null }
          : { id: optional.node_id, title: 'Optional valid candidate', types: ['note'], status: null }];
    if (options.gapFill === 'missing-observation') {
      const getNode = engine.getNode.bind(engine);
      engine.getNode = async (...args) => {
        const node = await getNode(...args);
        if (args[0] === optional.node_id) {
          const { provenance_observation, ...withoutObservation } = node;
          return withoutObservation;
        }
        return node;
      };
    }
  }
  const sent: unknown[] = [];
  const adapter = new OpenAiCompatLlmClient({ chat: { completions: { create: async (payload: any) => {
    sent.push(payload);
    const name = payload.response_format?.json_schema.name;
    if (name === 'emit_wiki_sections' && options.failHome) throw new Error('Synthetic provider failure');
    const output = name === 'emit_topology_plan' ? { reviewed_page_ids: [], actions: [] }
      : { now: 'Generated summary based on the source.', focus: [{ title: 'Review the source.' }], open_threads: [{ title: 'None.' }], log_entry: 'Generated from captured inputs.' };
    return { choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  } } } } as unknown as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
  // Production supplies a usage-wrapped client, not the bare provider adapter.
  // Keep that boundary in every capture/publication/failure scenario below.
  const reporter = new UsageReporter({ recordUsage: async () => {} } as unknown as Engine, {
    provider: 'openrouter', experiment: null, variant: null,
  });
  const llm = reporter.wrap(adapter);
  if (options.largeProject) {
    const seed = await curateProject(engine, llm, { ...config, projectHomeProvenanceEnabled: false }, { id: project.node_id, title: 'Project', file_path: 'Project.md', status: null }, false, true);
    assert.equal(seed.outcome, 'written');
    db.prepare("UPDATE node_fields SET value_text='2020-01-01T00:00:00Z',value_date='2020-01-01T00:00:00Z' WHERE field_name='wiki_curated_at'").run();
    sent.length = 0; commits = 0;
  }
  const result = await curateProject(engine, llm, config, { id: project.node_id, title: 'Project', file_path: 'Project.md', status: null }, options.dryRun ?? false, true,
    undefined, undefined, undefined, undefined, { preview: options.preview ?? false });
  return { db, engine, result, sent, commits, source, optionalId, bundles,
    client: () => clients[clients.length - 1]!,
    async close() { await engine.close(); await Promise.all(servers.map(server => server.close())); db.close(); vault.cleanup(); } };
}

test('real MCP: capture home, lose commit reply, edit/delete source, inspect retained bytes and purge', async () => {
  const f = await fixture({ loseCommitReply: true });
  try {
    assert.equal(f.result.outcome, 'written', JSON.stringify(f.result));
    assert.equal(f.sent.length, 2); // topology + one tracked home call
    assert.equal(f.commits, 2); // exact network replay, one database output
    const output = f.db.prepare('SELECT id,node_id FROM provenance_outputs').get() as { id: string; node_id: string };
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM provenance_outputs').get() as { n: number }).n, 1);
    const inspected = await f.engine.inspectProvenance({ select: 'output', output_revision_id: output.id, limit: 100 });
    assert.equal(inspected.select, 'output'); if (inspected.select !== 'output') throw new Error('wrong response');
    const reference = inspected.payloads.find(p => p.kind === 'request')!;
    const retained = await f.engine.inspectProvenance({ select: 'text', payload_id: reference.id });
    assert.equal(retained.select, 'text'); if (retained.select !== 'text') throw new Error('wrong response');
    assert.deepEqual(JSON.parse(retained.text!), f.sent[1]);
    assert.match(retained.text!, /ORIGINAL CAPTURE/);
    const dependency = inspected.inputs.find(i => i.source?.native_id === f.source.node_id)!;
    assert.ok(dependency?.source);
    const update = await f.client().callTool({ name: 'update-node', arguments: { node_id: f.source.node_id, set_body: 'Changed after generation', dry_run: false } });
    assert.equal(JSON.parse((update.content as Array<{ text: string }>)[0]!.text).ok, true);
    const changed = await f.engine.findAffectedOutputs({ sources: [dependency.source!] });
    assert.equal(changed.outputs[0]?.inputs[0]?.comparison, 'changed');
    const deletion = await f.client().callTool({ name: 'delete-node', arguments: { node_id: f.source.node_id, confirm: true } });
    assert.equal(JSON.parse((deletion.content as Array<{ text: string }>)[0]!.text).ok, true);
    assert.equal((await f.engine.findAffectedOutputs({ sources: [dependency.source!] })).outputs[0]?.inputs[0]?.comparison, 'missing');
    assert.deepEqual(await f.engine.inspectProvenance({ select: 'text', payload_id: reference.id }), retained);
    const preview = await f.engine.purgeProvenance({ scope: { source_ids: [dependency.source_id!] } });
    assert.ok('dry_run' in preview);
    await f.engine.purgeProvenance({ scope: { source_ids: [dependency.source_id!] }, dry_run: false, confirm: true, scope_token: preview.scope_token });
    const purged = await f.engine.inspectProvenance({ select: 'text', payload_id: reference.id });
    assert.equal(purged.select, 'text'); if (purged.select === 'text') assert.equal(purged.text, null);
    assert.ok((await f.engine.getNode(output.node_id)).body?.includes('Generated summary'));
  } finally { await f.close(); }
});

test('real MCP: tracked preview validates exact capture with no retained attempts or wiki writes', async () => {
  const f = await fixture({ dryRun: true, preview: true });
  try {
    assert.equal(f.result.outcome, 'written', JSON.stringify(f.result));
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM provenance_derivations').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM node_types WHERE schema_type='wiki'").get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

test('real MCP: tracked plain dry-run makes no model call, capture or wiki write', async () => {
  const f = await fixture({ dryRun: true });
  try {
    assert.equal(f.result.outcome, 'would_curate', JSON.stringify(f.result));
    assert.equal(f.result.usage, undefined);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM provenance_derivations').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM node_types WHERE schema_type='wiki'").get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

test('real MCP: failed home model leaves a failed capture and no published output', async () => {
  const f = await fixture({ failHome: true });
  try {
    assert.equal(f.result.outcome, 'error');
    assert.deepEqual(f.db.prepare('SELECT state,availability FROM provenance_derivations').all(), [{ state: 'failed', availability: 'retained' }]);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM provenance_outputs').get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

for (const tool of ['provenance-prepare', 'provenance-stage-result']) {
  test(`real MCP: lost ${tool} reply resumes the exact attempt without another model dispatch`, async () => {
    const f = await fixture({ loseReply: tool });
    try {
      assert.equal(f.result.outcome, 'written', JSON.stringify(f.result));
      assert.equal(f.sent.length, 2);
      assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM provenance_derivations').get() as { n: number }).n, 1);
    } finally { await f.close(); }
  });
}
for (const failCapture of ['prepare', 'stage'] as const) {
  test(`real MCP: ${failCapture} storage failure publishes no output`, async () => {
    const f = await fixture({ failCapture });
    try {
      assert.equal(f.result.outcome, 'error');
      assert.equal(f.sent.length, failCapture === 'prepare' ? 1 : 2);
      assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM provenance_outputs').get() as { n: number }).n, 0);
      if (failCapture === 'stage') assert.equal(f.result.usage?.input, 20);
    } finally { await f.close(); }
  });
}
for (const phase of ['before', 'after'] as const) {
  test(`real MCP: source change ${phase} prepare has explicit capture semantics`, async () => {
    const f = await fixture(phase === 'before' ? { changeBeforePrepare: true } : { changeAfterPrepare: true });
    try {
      assert.equal(f.result.outcome, 'error', JSON.stringify(f.result));
      assert.match(f.result.detail ?? '', /PROVENANCE_OBSERVATION_CHANGED/);
      assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM provenance_outputs').get() as { n: number }).n, 0);
      assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM node_types WHERE schema_type='wiki'").get() as { n: number }).n, 0);
      assert.equal((await f.engine.getNode(f.source.node_id)).body, 'ORIGINAL CAPTURE é😀 — the source used for generation.');
      assert.equal(f.sent.length, phase === 'before' ? 1 : 2);
    } finally { await f.close(); }
  });
}
test('real MCP: purge between stage and commit revokes publication', async () => {
  const f = await fixture({ purgeAfterStage: true });
  try {
    assert.equal(f.result.outcome, 'error');
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM provenance_outputs').get() as { n: number }).n, 0);
  } finally { await f.close(); }
});


test('real MCP: a large project captures only the observations needed by rendered home evidence', async () => {
  const f = await fixture({ largeProject: true });
  try {
    assert.equal(f.result.outcome, 'written', JSON.stringify(f.result));
    assert.equal(f.sent.length, 2);
    const count = f.db.prepare('SELECT COUNT(*) AS n FROM provenance_observations').get() as { n: number };
    assert.ok(count.n > 0 && count.n < 512);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM provenance_outputs').get() as { n: number }).n, 1);
  } finally { await f.close(); }
});

for (const gapFill of ['mixed', 'all-failed'] as const) {
  test(`real MCP: optional gap-fill read failures do not block tracked home publication (${gapFill})`, async () => {
    const f = await fixture({ gapFill });
    try {
      assert.equal(f.result.outcome, 'written', JSON.stringify(f.result));
      assert.equal(f.sent.length, 2);
      const outputs = f.db.prepare('SELECT id FROM provenance_outputs').all() as Array<{ id: string }>;
      assert.equal(outputs.length, 1);
      const inspected = await f.engine.inspectProvenance({ select: 'output', output_revision_id: outputs[0]!.id, limit: 100 });
      assert.equal(inspected.select, 'output'); if (inspected.select !== 'output') throw new Error('wrong response');
      assert.deepEqual(inspected.omissions, Array.from({ length: gapFill === 'mixed' ? 1 : 2 }, () => ({ code: 'gap_fill_candidate_unavailable', source: null })));
      assert.equal(inspected.inputs.some(i => i.source?.native_id === f.optionalId), gapFill === 'mixed');
      assert.equal(inspected.inputs.some(i => i.source?.native_id.startsWith('missing-optional')), false);
      const request = inspected.payloads.find(p => p.kind === 'request')!;
      const retained = await f.engine.inspectProvenance({ select: 'text', payload_id: request.id });
      assert.equal(retained.select, 'text'); if (retained.select !== 'text') throw new Error('wrong response');
      assert.deepEqual(JSON.parse(retained.text!), f.sent[1]);
      assert.doesNotMatch(retained.text!, /UNAVAILABLE CANDIDATE/);
      assert.equal(retained.text!.includes('OPTIONAL CAPTURE CONTENT'), gapFill === 'mixed');
    } finally { await f.close(); }
  });
}

for (const oversized of [false, true]) {
test(`real MCP: a gap-fill input without observations blocks publication even if oversized (${oversized})`, async () => {
  const f = await fixture({ gapFill: 'missing-observation', ...(oversized ? { optionalBody: 'x'.repeat(300000) } : {}) });
  try {
    assert.equal(f.result.outcome, 'error');
    assert.match(f.result.detail ?? '', /PROVENANCE_OBSERVATION_MISSING/);
    assert.equal(f.sent.length, 0);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM provenance_derivations').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM node_types WHERE schema_type='wiki'").get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

}

test('real MCP: oversized optional source is omitted before planning and retained capture stays accurate', async () => {
  const f = await fixture({ gapFill: 'oversized', optionalBody: 'OVERSIZED OPTIONAL ' + 'x'.repeat(523679) });
  try {
    assert.equal(f.result.outcome, 'written', JSON.stringify(f.result));
    assert.equal(f.sent.length, 2);
    assert.equal(f.commits, 1);
    assert.match(f.result.detail ?? '', /gap_fill_component_budget=1/);
    const output = f.db.prepare('SELECT id FROM provenance_outputs').get() as { id: string };
    const inspected = await f.engine.inspectProvenance({ select: 'output', output_revision_id: output.id, limit: 100 });
    assert.equal(inspected.select, 'output'); if (inspected.select !== 'output') throw new Error('wrong response');
    assert.equal(inspected.omissions[0]?.code, 'gap_fill_component_budget');
    assert.equal(inspected.omissions[0]?.source?.native_id, f.optionalId);
    assert.equal(inspected.inputs.some(i => i.source?.native_id === f.optionalId), false);
    const request = inspected.payloads.find(p => p.kind === 'request')!;
    const retained = await f.engine.inspectProvenance({ select: 'text', payload_id: request.id });
    assert.equal(retained.select, 'text'); if (retained.select !== 'text') throw new Error('wrong response');
    assert.doesNotMatch(retained.text!, /OVERSIZED OPTIONAL/);
    assert.match(retained.text!, /ORIGINAL CAPTURE/);
    assert.deepEqual(JSON.parse(retained.text!), f.sent[1]);
    const dependency = inspected.inputs.find(i => i.source?.native_id === f.source.node_id)!;
    await f.client().callTool({ name: 'update-node', arguments: { node_id: f.source.node_id, set_body: 'Changed source', dry_run: false } });
    assert.deepEqual(await f.engine.inspectProvenance({ select: 'text', payload_id: request.id }), retained);
    assert.equal((await f.engine.findAffectedOutputs({ sources: [dependency.source!] })).outputs[0]?.inputs[0]?.comparison, 'changed');
  } finally { await f.close(); }
});

test('real MCP: oversized protected source fails before paid planning or capture reservation', async () => {
  const f = await fixture({ sourceBody: 'x'.repeat(300000) });
  try {
    assert.equal(f.result.outcome, 'error');
    assert.match(f.result.detail ?? '', /stage=selection dimension=component/);
    assert.equal(f.sent.length, 0);
    assert.equal(f.commits, 0);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM provenance_derivations').get() as { n: number }).n, 0);
  } finally { await f.close(); }
});


test('real capture: Curator accounting agrees with Engine at every exact byte/item boundary', async () => {
  const f = await fixture({ sourceBody: 'é😀"\\\n'.repeat(30) });
  try {
    assert.equal(f.result.outcome, 'written', JSON.stringify(f.result));
    const bundle = f.bundles[0]!;
    const dimensions = [
      ['componentBytes', Math.max(...bundle.items.map(item => item.retained_bytes)), 'component'],
      ['itemCount', bundle.items.length, 'items'],
      ['requestBytes', Buffer.byteLength(canonical(bundle.provider_payload)), 'request'],
      ['totalBytes', Buffer.byteLength(canonical(bundle as unknown as Json)), 'bundle'],
    ] as const;
    for (const [key, boundary, dimension] of dimensions) {
      const exact = { ...DEFAULT_PROVENANCE_LIMITS, [key]: boundary };
      // Smaller measured requests/bundles also require coherent subordinate limits.
      if (key === 'requestBytes') exact.componentBytes = Math.min(exact.componentBytes, boundary - 1);
      if (key === 'totalBytes') {
        exact.requestBytes = Math.min(exact.requestBytes, boundary - 1);
        exact.componentBytes = Math.min(exact.componentBytes, exact.requestBytes);
        exact.outputBytes = Math.min(exact.outputBytes, boundary - 1);
      }
      assert.equal(measureBundle(bundle, exact), null);
      assert.doesNotThrow(() => validateBundle(bundle, exact));
      const below = { ...exact, [key]: boundary - 1 };
      assert.equal(measureBundle(bundle, below)?.dimension, dimension);
      assert.throws(() => validateBundle(bundle, below), /PROVENANCE_LIMIT/);
    }
  } finally { await f.close(); }
});
