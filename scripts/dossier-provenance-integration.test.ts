// Real Engine and Curator MCP boundaries for a dossier (#554, slice 3); disposable storage and a
// synthetic provider that cites what it is shown.
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
import { registerQueryNodes } from '../packages/engine/src/mcp/tools/query-nodes.js';
import { MemoryService } from '../packages/engine/src/memories/service.js';
import { registerProvenance } from '../packages/engine/src/mcp/tools/provenance.js';
import { registerWikiReconcile } from '../packages/engine/src/mcp/tools/wiki-reconcile.js';
import { registerUpdateNode } from '../packages/engine/src/mcp/tools/update-node.js';
import { registerWikiStatus } from '../packages/engine/src/mcp/tools/wiki-status.js';
import { registerDeleteNode } from '../packages/engine/src/mcp/tools/delete-node.js';
import { registerUndoOperations } from '../packages/engine/src/mcp/tools/undo-operations.js';
import { SettingsService } from '../packages/engine/src/settings/service.js';
import { extractManagedSection } from '../packages/engine/src/wiki/sections.js';
import { Engine } from '../packages/curator/src/engine.js';
import { OpenAiCompatLlmClient } from '../packages/curator/src/llm/openai-compat.js';
import { runMigrations } from '../packages/curator/src/db/migrate.js';
import { startDossier } from '../packages/curator/src/dossier/build.js';
import { checkDossiers, runDossierRebuilds } from '../packages/curator/src/dossier/freshness.js';
import { CurationQueue } from '../packages/curator/src/queue.js';
import { curatorServerFactory } from '../packages/curator/src/server-bootstrap.js';
import { ServerLifecycle } from '../packages/curator/src/server-lifecycle.js';
import type { Config } from '../packages/curator/src/config.js';
import type { CoreDeps } from '../packages/curator/src/core.js';

async function fixture() {
  const db = createTestDb(), vault = createTempVault(), writeLock = new WriteLockManager();
  const settings = new SettingsService(db, { settingsDir: 'Settings' });
  const curatorDb = new Database(join(vault.vaultPath, 'test-curator.db')); runMigrations(curatorDb);
  for (const kind of ['person', 'company', 'meeting', 'project']) {
    db.prepare("INSERT INTO schemas(name,display_name,field_claims) VALUES (?,?,'[]')").run(kind, kind);
  }
  const mutate = (input: Parameters<typeof executeMutation>[3]) => executeMutation(db, writeLock, vault.vaultPath, input);
  const company = mutate({ source: 'tool', node_id: null, file_path: 'Companies/Northwind.md', title: 'Northwind', types: ['company'], fields: {}, body: 'A logistics firm.' });
  const dana = mutate({ source: 'tool', node_id: null, file_path: 'People/Dana Whitfield.md', title: 'Dana Whitfield', types: ['person'],
    fields: { company: '[[Northwind]]' }, body: 'Account lead at Northwind.' });
  mutate({ source: 'tool', node_id: null, file_path: 'People/Lee Okafor.md', title: 'Lee Okafor', types: ['person'], fields: {}, body: '' });
  const kickoff = mutate({ source: 'tool', node_id: null, file_path: 'Meetings/Kickoff call.md', title: 'Kickoff call', types: ['meeting'],
    fields: { date: '2026-03-04', 'people involved': ['[[Dana Whitfield]]', '[[Lee Okafor]]'] }, body: 'Dana asked for weekly updates.' });
  const project = mutate({ source: 'tool', node_id: null, file_path: 'Projects/Pilot.md', title: 'Pilot', types: ['project'], fields: {}, body: 'A project.' });
  const memoryService = new MemoryService(db);
  const hash = (id: string) => (db.prepare('SELECT content_hash FROM nodes WHERE id=?').get(id) as { content_hash: string }).content_hash;
  const remember = async (content: string, extra: Record<string, unknown>) => {
    const { result } = await memoryService.create({ source: 'curator', scope: 'vault', content, subjects: ['Dana Whitfield'],
      evidence: { kind: 'note', node_id: kickoff.node_id, hash: hash(kickoff.node_id) }, ...extra });
    assert.equal(result.ok, true, JSON.stringify(result));
    return (result as { ok: true; data: { id: number } }).data.id;
  };
  const lead = await remember('Dana Whitfield leads the Northwind account.', {});
  const prefers = await remember('Dana Whitfield prefers short agendas.', { category: 'preference', source: 'chat',
    evidence: { kind: 'conversation', ref: 'chat-1#2' } });
  const rule = await remember('Never share Northwind pricing with Dana Whitfield.', { category: 'rule' });
  const config = { wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0,
    wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit',
    projectHomeProvenanceEnabled: true, model: 'synthetic', modelProviders: { synthetic: 'openrouter' }, curatorTz: 'UTC',
    homeMaxTokens: 4000, meetingReads: 5, noteReads: 5, bodyCharCap: null, semanticGapFill: false, memoryWriteEnabled: false,
    modelPricing: { synthetic: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } } as unknown as Config;
  const servers: McpServer[] = [];
  const engine = new Engine(config, () => {
    const server = new McpServer({ name: 'engine-fixture', version: '1' }); servers.push(server);
    registerGetNode(server, db); registerProjectEvidence(server, db); registerMemoriesTools(server, memoryService);
    registerQueryNodes(server, db); registerProvenance(server, db, settings);
    registerWikiReconcile(server, { db, vaultPath: vault.vaultPath, writeLock });
    registerUpdateNode(server, db, writeLock, vault.vaultPath); registerWikiStatus(server, { db, writeLock, vaultPath: vault.vaultPath });
    registerDeleteNode(server, db, writeLock, vault.vaultPath); registerUndoOperations(server, db, writeLock, vault.vaultPath);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'curator-engine-fixture', version: '1' });
    return { transport: ct, client: { connect: async () => { await server.connect(st); await client.connect(ct); },
      callTool: async req => ({ content: (await client.callTool(req)).content }) } };
  });
  let calls = 0;
  let checks = 0;
  let lastEvidence = '';
  // Cites what it was shown: a memory line, the preference, a meeting, and one line citing nothing known.
  const adapter = new OpenAiCompatLlmClient({ chat: { completions: { create: async (payload: any) => {
    // The rule check on the subject's rule (#721): no line breaks it.
    if (JSON.stringify(payload).includes('emit_dossier_rule_check')) {
      checks++;
      return { choices: [{ message: { content: JSON.stringify({ broken: [] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
    }
    calls++;
    lastEvidence = JSON.parse(payload.messages.at(-1).content).evidence as string;
    const meetingRef = /\[(n\d+)\] [^\n]*Kickoff call/.exec(lastEvidence)?.[1];
    const output = { lines: [
      { section: 'Who', text: 'Leads the Northwind account.', memory_ids: [lead] },
      { section: 'Preferences', text: 'Prefers short agendas.', memory_ids: [prefers] },
      { section: 'History', text: 'Met [[Lee Okafor]] and you at the kickoff.', note_ids: meetingRef ? [meetingRef] : [] },
      { section: 'Who', text: 'An invented line.', memory_ids: [999_999] },
    ] };
    return { choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  } } } } as unknown as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
  const deps: CoreDeps = { engine, llm: adapter, config, queue: new CurationQueue(), db: curatorDb };
  const curatorServer = curatorServerFactory(async () => deps, new Date(), undefined, new ServerLifecycle())(); servers.push(curatorServer);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const send = ct.send.bind(ct);
  ct.send = message => send(message, { authInfo: { token: 'synthetic', clientId: 'fixture', scopes: ['curate:read', 'curate:trigger'] } });
  const client = new Client({ name: 'plugin-fixture', version: '1' });
  await curatorServer.connect(st); await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  return { db, curatorDb, engine, deps, remember, dana, company, project, kickoff, ids: { lead, prefers, rule }, call,
    calls: () => calls, checks: () => checks, evidence: () => lastEvidence,
    close: async () => { await client.close(); await engine.close(); await Promise.all(servers.map(s => s.close())); curatorDb.close(); db.close(); vault.cleanup(); } };
}

test('real MCP: a dossier for a person is a captured home whose inputs are its memories and notes', async () => {
  const f = await fixture();
  try {
    const preview = await f.call('build-dossier', { node_id: f.dana.node_id });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(f.calls(), 0);
    assert.deepEqual(preview.page, { title: 'Dana Whitfield Dossier', path: 'Wikis/Dana Whitfield Dossier.md', node_id: null, action: 'create' });
    assert.equal(preview.reads.memories.about, 3);
    assert.equal(preview.reads.memories.rules, 1);
    assert.equal(preview.reads.meetings, 1);
    assert.equal(preview.reads.read_in_full, 1); // the kickoff meeting's body (#720)
    assert.ok(preview.capture.item_count > 0);
    assert.ok(preview.cost.worst_case_usd > 0);
    assert.deepEqual(f.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE title LIKE '%Dossier'").get(), { n: 0 });

    const built = await f.call('build-dossier', { node_id: f.dana.node_id, dry_run: false });
    assert.equal(built.ok, true, JSON.stringify(built));
    assert.equal(built.status, 'written', JSON.stringify(built));
    assert.equal(built.lines, 3);
    assert.equal(built.dropped, 1);
    assert.equal(f.calls(), 1);
    assert.equal(f.checks(), 1); // the subject has a rule, so its lines were checked (#721)
    assert.equal(built.rule_dropped, 0);
    assert.match(f.evidence(), new RegExp(`\\[m${f.ids.lead}\\] 2026-03-04, from "Kickoff call"|\\[m${f.ids.lead}\\] [^\\n]*Dana Whitfield leads`));
    assert.match(f.evidence(), /### \[n\d+\] 2026-03-04 · Kickoff call\nDana asked for weekly updates\./);

    const home = await f.engine.getNode(built.node_id);
    assert.equal(home.title, 'Dana Whitfield Dossier');
    const glance = extractManagedSection(home.body!, 'At a glance', 100_000)!;
    assert.match(glance, new RegExp(`^- Leads the Northwind account\\. · since \\d{4}-\\d{2}-\\d{2} · \\[\\[Kickoff call\\]\\] <!-- memory:${f.ids.lead} -->$`, 'm'));
    assert.match(glance, new RegExp(`^- Prefers short agendas\\. · since \\d{4}-\\d{2}-\\d{2} · from a chat <!-- memory:${f.ids.prefers} -->$`, 'm'));
    assert.match(glance, /^- Met \[\[Lee Okafor\]\] and you at the kickoff\. · 2026-03-04 · \[\[Kickoff call\]\]$/m);
    assert.doesNotMatch(glance, /invented/);
    assert.match(glance, /## Last contact\n\n- \[\[Kickoff call\]\] · 2026-03-04/);
    assert.match(glance, new RegExp(`## Rules on what to say\\n\\n- Never share Northwind pricing with Dana Whitfield\\. <!-- memory:${f.ids.rule} -->`));
    assert.match(extractManagedSection(home.body!, 'Log', 100_000)!, /Dossier built from 3 memories and 1 meeting: 3 lines; 1 left out/);

    // The done-when check: the page's capture lists the memories it was built from.
    const node = await f.engine.inspectProvenance({ select: 'node', node_id: built.node_id });
    assert.equal(node.select, 'node'); if (node.select !== 'node') throw Error('node');
    assert.equal(node.outputs[0]!.receipt.output_revision_id, built.output_revision_id);
    const output = await f.engine.inspectProvenance({ select: 'output', output_revision_id: built.output_revision_id, limit: 100 });
    assert.equal(output.select, 'output'); if (output.select !== 'output') throw Error('output');
    const memoryInputs = output.inputs.filter(input => input.source?.kind === 'memory').map(input => Number(input.source!.native_id)).sort((a, b) => a - b);
    assert.deepEqual(memoryInputs, [f.ids.lead, f.ids.prefers, f.ids.rule].sort((a, b) => a - b));
    const nodeInputs = new Set(output.inputs.filter(input => input.source?.kind === 'node').map(input => input.source!.native_id));
    assert.ok(nodeInputs.has(f.dana.node_id), 'the subject note is an input');
    // The meeting's body was read in full and recorded as what it is (#720).
    assert.ok(output.inputs.some(input => input.source?.native_id === f.kickoff.node_id && input.role === 'source_material'
      && input.selection === 'dossier-body:v1'), JSON.stringify(output.inputs.map(input => [input.source?.native_id, input.role, input.selection])));

    // A page rebuild must not rewrite a dossier with the project home's prompt: the Engine's refresh
    // target needs a project root.
    const refresh = await f.call('preview-wiki-refresh', { output_revision_id: built.output_revision_id });
    assert.equal(refresh.ok, true, JSON.stringify(refresh));
    assert.equal(refresh.data.eligible, false);

    // A rebuild finds the same page and keeps its title and path.
    const again = await f.call('build-dossier', { title: 'Dana Whitfield', dry_run: false });
    assert.equal(again.status, 'written', JSON.stringify(again));
    assert.equal(again.node_id, built.node_id);
    assert.equal((await f.engine.getNode(built.node_id)).file_path, 'Wikis/Dana Whitfield Dossier.md');
    const runs = f.curatorDb.prepare("SELECT outcome FROM runs WHERE project = 'Dana Whitfield Dossier' ORDER BY id").all();
    assert.deepEqual(runs, [{ outcome: 'written' }, { outcome: 'written' }]);
  } finally { await f.close(); }
});

test('real MCP: a dossier shows behind when its subject gains a memory, and the sweep rebuilds one set to on-change (#714)', async () => {
  const f = await fixture();
  try {
    const lines: string[] = [];
    const built = await f.call('build-dossier', { node_id: f.dana.node_id, dry_run: false, rebuild: 'on-change' });
    assert.equal(built.status, 'written', JSON.stringify(built));
    // The mode is the note's own field, set through the Engine like any field.
    const note = await f.engine.getNode(f.dana.node_id);
    assert.equal(Engine.unwrapFieldValue(note.fields?.['dossier']), 'on-change');
    const status = async () => Engine.unwrapFieldValue((await f.engine.getNode(built.node_id)).fields?.['wiki_status']);
    assert.deepEqual(await checkDossiers({ engine: f.engine, db: f.curatorDb }, line => lines.push(line)), { checked: 1, behind: 0 });
    assert.equal(await status(), 'current');

    await f.remember('Dana Whitfield moved to the Rotterdam office.', {});
    assert.deepEqual(await checkDossiers({ engine: f.engine, db: f.curatorDb }, line => lines.push(line)), { checked: 1, behind: 1 });
    assert.equal(await status(), 'behind');
    assert.match(lines.join('\n'), /"Dana Whitfield Dossier" is behind: 1 memory it would show now is new to it/);

    // The nightly phase rebuilds it, through the same path as a live build, and it is current again.
    const rebuilt = await runDossierRebuilds(f.deps, { dryRun: false },
      (deps, nodeId, stillWanted) => startDossier(deps, { node_id: nodeId }, { wait: true, stillWanted }));
    assert.deepEqual(rebuilt, { considered: 1, rebuilt: 1, skipped: 0, failed: 0, leftForLater: 0, stoppedBy: null });
    assert.equal(await status(), 'current');
    assert.deepEqual(await checkDossiers({ engine: f.engine, db: f.curatorDb }, line => lines.push(line)), { checked: 1, behind: 0 });
  } finally { await f.close(); }
});

test('real MCP: remove-dossier deletes the page as one undo operation, and undo brings it back (#723)', async () => {
  const f = await fixture();
  try {
    const built = await f.call('build-dossier', { node_id: f.dana.node_id, dry_run: false });
    assert.equal(built.status, 'written', JSON.stringify(built));
    const preview = await f.call('remove-dossier', { title: 'Dana Whitfield' });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.page.node_id, built.node_id);
    assert.ok(await f.engine.getNode(built.node_id), 'a dry run deletes nothing');
    const removed = await f.call('remove-dossier', { node_id: built.node_id, dry_run: false });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE id = ?').get(built.node_id).n, 0);
    assert.equal(f.curatorDb.prepare('SELECT COUNT(*) AS n FROM dossiers').get().n, 0);
    await f.engine.undoOperations(removed.undo.arguments.operation_ids, false);
    const back = await f.engine.getNode(built.node_id);
    assert.equal(back.title, 'Dana Whitfield Dossier');
    // A project's own wiki page is no dossier.
    const page = await f.call('remove-dossier', { node_id: f.project.node_id });
    assert.equal(page.ok, false);
  } finally { await f.close(); }
});

test('real MCP: a project, a wiki page and a note of another kind are refused before any call', async () => {
  const f = await fixture();
  try {
    const project = await f.call('build-dossier', { node_id: f.project.node_id, dry_run: false });
    assert.equal(project.ok, false);
    assert.equal(project.error.code, 'PROJECT_NOTE');
    const built = await f.call('build-dossier', { node_id: f.dana.node_id, dry_run: false });
    const page = await f.call('build-dossier', { node_id: built.node_id });
    assert.equal(page.error.code, 'WIKI_PAGE');
    const company = await f.call('build-dossier', { node_id: f.company.node_id });
    assert.equal(company.ok, true, JSON.stringify(company));
    assert.equal(company.subject.kind, 'company');
    assert.equal(company.page.title, 'Northwind Dossier');
    assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});
