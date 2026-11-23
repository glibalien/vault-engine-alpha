import { recordBatchTransitions } from '../../src/provenance/batch-binding.js';
import { inspectProvenance } from '../../src/provenance/inspect.js';
import { findAffectedOutputs } from '../../src/provenance/impact.js';
import { clearDerivation, commitProvenancePurge, previewProvenancePurge } from '../../src/provenance/purge.js';
import { ProvenanceStore } from '../../src/provenance/store.js';
import { runProvenanceRetention } from '../../src/provenance/retention.js';
import { DEFAULT_PROVENANCE_LIMITS } from '../../src/provenance/limits.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { ensureWikiSchema } from '../../src/wiki/bootstrap.js';
import { DEFAULT_WIKI_CONFIG } from '../../src/wiki/config.js';
import { registerWikiReconcile } from '../../src/mcp/tools/wiki-reconcile.js';
import { ProvenanceService } from '../../src/provenance/service.js';
import { observeNode } from '../../src/provenance/observations.js';
import { deriveSubpageDecodedFields } from '../../src/provenance/subpage-validation.js';
import type { CaptureTarget, Contribution, PreparedReceipt } from '../../src/provenance/types.js';
import type { WikiReconcileInput } from '../../src/wiki/reconcile-types.js';
import { bundleFixture } from './fixture.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
function fixture() {
  const db = createTestDb(); const vault = createTempVault(); const writeLock = new WriteLockManager();
  cleanups.push(() => { db.close(); vault.cleanup(); });
  db.prepare("INSERT INTO schemas(name,display_name,field_claims) VALUES ('project','Project','[]')").run();
  const project = executeMutation(db, writeLock, vault.vaultPath, { source: 'tool', node_id: null,
    file_path: 'Project.md', title: 'Project', types: ['project'], fields: {}, body: 'Original evidence.' });
  ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
  const home = executeMutation(db, writeLock, vault.vaultPath, { source: 'tool', node_id: null,
    file_path: 'Wikis/Project Wiki.md', title: 'Project Wiki', types: ['wiki'], fields: { wiki_for: 'Project' }, body: 'Human introduction.' });
  const service = new ProvenanceService(db);
  function stage(target?: CaptureTarget, log = '2026-09-25 — Generated.', inputs = [project.node_id]) {
    let bundle = bundleFixture();
    if (target) {
      const provider_payload = { model: 'test', max_tokens: 100, messages: [
        { role: 'system', content: 'Synthetic page system' },
        { role: 'user', content: JSON.stringify({ action: 'node_id' in target ? 'refresh' : 'create',
          title: 'Page', kind: 'freeform', scope: {}, synthesis_brief: 'Summarize.', evidence: 'évidence', sibling_scopes: [],
          ...('node_id' in target ? { current_target: { id: target.node_id } } : {}) }) },
      ] };
      bundle = { ...bundle, target, provider_payload, decoded_fields: deriveSubpageDecodedFields('openrouter', provider_payload),
        transform: { assembly: 'project-subpage-evidence-v1', prompt: 'project-subpage-v1', schema: 'page-synthesis-v1',
          adapter: 'openai-compat-v1', output: 'managed-subpage-contribution-v1' } };
    }
    bundle.items = inputs.map((id, index) => ({ ...bundle.items[0]!, key: `input-${index}`, observation: observeNode(db, id), origin: 'identified' as const }));
    const prepared = service.prepare({ attempt_key: randomUUID(), run_ref: randomUUID(), project_id: project.node_id,
      ...(target ? { flow: 'project-subpage-v1' as const } : {}), bundle, dry_run: false }) as PreparedReceipt;
    const sections: Contribution = [{ name: target ? 'Summary' : 'Now', mode: 'replace', content: 'Generated summary.' },
      { name: 'Log', mode: 'append', content: log }];
    const binding = service.stage({ derivation_id: prepared.derivation_id, bundle_digest: prepared.bundle_digest!,
      validated_sections: target ? { body: 'Generated summary.', log_note: log } : { now: 'Generated summary.', log_entry: 'Generated.' },
      contribution: sections, generated_at: '2026-09-25T00:00:00Z', log_stamp: '2026-09-25' });
    return { sections, binding };
  }
  const capturedHome = stage();
  const pages = ['decisions', 'risks'].map(key => {
    const captured = stage({ plan_key: key });
    return { op: 'upsert' as const, target: { mode: 'new' as const, plan_key: key, title: `Project ${key}` },
      scope: { v: 1 as const, subject: 'Project', facet: key }, kind: 'freeform' as const, origin: 'automatic' as const,
      pinned: false, sections: captured.sections, provenance: captured.binding };
  });
  const input: WikiReconcileInput = { project: 'Project', project_id: project.node_id, pages,
    provenance_mode: 'project-subpage-v1', reconcile_key: `wiki-reconcile:provenance-v1:${capturedHome.binding.derivation_id}`,
    home: { expected_version: 1, sections: capturedHome.sections, provenance: capturedHome.binding,
      evidence_hash: 'evidence', curated_at: '2026-09-25T00:00:00Z', refresh_live: true }, dry_run: false };
  let handle: (params: any) => Promise<any>;
  registerWikiReconcile({ tool: (_n: string, _d: string, _s: unknown, fn: typeof handle) => { handle = fn; } } as unknown as McpServer,
    { db, writeLock, vaultPath: vault.vaultPath });
  const call = async (params = input) => JSON.parse((await handle(params)).content[0].text);
  const snapshot = () => ({ nodes: db.prepare('SELECT * FROM nodes ORDER BY id').all(),
    fields: db.prepare('SELECT * FROM node_fields ORDER BY node_id,field_name').all(),
    files: readdirSync(join(vault.vaultPath, 'Wikis')).map(name => [name, readFileSync(join(vault.vaultPath, 'Wikis', name), 'utf8')]),
    outputs: db.prepare('SELECT * FROM provenance_outputs').all(),
    derivations: db.prepare('SELECT * FROM provenance_derivations ORDER BY id').all() });
  return { db, input, call, snapshot, home, project, stage, pages, deps: { db, writeLock, vaultPath: vault.vaultPath, config: DEFAULT_WIKI_CONFIG } };
}


async function mergeFixture() {
  const f = fixture(); const initial = await f.call(); expect(initial.ok).toBe(true);
  const [a, b] = initial.data.created;
  const home = f.stage(undefined, 'Merge home.', [b.node_id]);
  // Repeated source observations are retained separately and each costs bytes.
  const page = f.stage({ node_id: a.node_id }, 'Merge page.', [a.node_id, b.node_id, b.node_id, f.project.node_id]);
  const input: WikiReconcileInput = { ...f.input, reconcile_key: `wiki-reconcile:provenance-v1:${home.binding.derivation_id}`,
    home: { ...f.input.home, expected_version: 2, sections: home.sections, provenance: home.binding },
    pages: [{ ...f.pages[0]!, op: 'merge', target: { mode: 'existing', node_id: a.node_id, expected_version: 1 },
      sources: [{ node_id: b.node_id, expected_version: 1 }], reason: 'Consolidate', sections: page.sections, provenance: page.binding }] };
  return { ...f, input, a: a.node_id as string, b: b.node_id as string, homeCapture: home, pageCapture: page };
}
function output(f: ReturnType<typeof fixture>, id: string) {
  const result = inspectProvenance(f.db, { select: 'output', output_revision_id: id, include_comparisons: true });
  if (result.select !== 'output') throw new Error('selector');
  return result;
}
function retainedInput(f: ReturnType<typeof fixture>, id: string) {
  const input = output(f, id).inputs[0]!;
  return inspectProvenance(f.db, { select: 'input_text', output_revision_id: id, input_id: input.id });
}
function actualBytes(f: ReturnType<typeof fixture>) {
  return (f.db.prepare('SELECT SUM(payload_bytes) n FROM provenance_derivations').get() as { n: number }).n;
}

describe('subpage publication lifecycle', () => {
  it('records merge transitions for target and source while preserving original inputs and later impact', async () => {
    const f = await mergeFixture();
    const before = f.db.prepare('SELECT * FROM provenance_payloads WHERE derivation_id=? ORDER BY id').all(f.pageCapture.binding.derivation_id);
    const committed = await f.call(f.input); expect(committed.ok, JSON.stringify(committed)).toBe(true);
    const receipt = committed.data.provenance_receipts[1];
    const inspected = output(f, receipt.output_revision_id);
    const bySource = new Map(inspected.inputs.map(input => [input.source?.native_id, input.comparison]));
    expect(bySource.get(f.a)).toBe('expected_self_transition');
    expect(bySource.get(f.b)).toBe('expected_self_transition');
    expect(bySource.get(f.project.node_id)).toBe('unchanged');
    const sources = [observeNode(f.db, f.a).source, observeNode(f.db, f.b).source];
    expect(findAffectedOutputs(f.db, { sources }).outputs).toEqual([]);
    const retained = retainedInput(f, receipt.output_revision_id);
    expect(retained).toMatchObject({ segments: [{ text: 'évidence' }] });
    const observations = f.db.prepare(`SELECT s.native_id,o.expected_post_commit_observation token FROM provenance_observations o
      JOIN provenance_sources s ON s.id=o.source_id WHERE derivation_id=?`).all(receipt.derivation_id) as Array<{ native_id: string; token: string | null }>;
    expect(observations.filter(row => row.token)).toHaveLength(3);
    expect(observations.find(row => row.native_id === f.project.node_id)?.token).toBeNull();
    const stored = new ProvenanceStore(f.db).get(receipt.derivation_id)!;
    const payloads = f.db.prepare('SELECT * FROM provenance_payloads WHERE derivation_id=? ORDER BY id').all(receipt.derivation_id) as Array<{ bytes: number; kind: string }>;
    expect(payloads.filter(row => row.kind !== 'contribution')).toEqual(before);
    expect(stored.payload_bytes).toBe(payloads.reduce((sum, row) => sum + row.bytes, 0) + observations.reduce((sum, row) => sum + Buffer.byteLength(row.token ?? ''), 0));
    expect(stored.reserved_remaining_bytes).toBe(0);
    f.db.prepare('UPDATE nodes SET version=version+1 WHERE id=?').run(f.b);
    const impact = findAffectedOutputs(f.db, { sources });
    expect(impact.outputs.map(row => row.receipt.output_node_id)).toContain(f.a);
    expect(output(f, receipt.output_revision_id).inputs.filter(row => row.source?.native_id === f.b).map(row => row.comparison)).toEqual(['changed', 'changed']);
    expect(retainedInput(f, receipt.output_revision_id)).toEqual(retained);
    // A changed source is a reason to rebuild this page, and doesn't block it.
    expect(inspectProvenance(f.db, { select: 'refresh_target', output_revision_id: receipt.output_revision_id })).toMatchObject({ eligible: true, target_kind: 'page', page_node_id: f.a });
  });
  it('rejects a pre-publication source change and compensates all files and receipt state', async () => {
    const f = await mergeFixture();
    f.db.prepare('UPDATE nodes SET content_hash=? WHERE id=?').run('external edit', f.b);
    const before = f.snapshot(); const result = await f.call(f.input);
    expect(result.ok).toBe(false); expect(result.error.details.reason).toBe('PROVENANCE_OBSERVATION_CHANGED');
    expect(f.snapshot()).toEqual(before);
  });
  it('fails atomically when a page reservation covers contribution but not final observation metadata', async () => {
    const f = await mergeFixture();
    f.db.prepare('UPDATE provenance_derivations SET reserved_remaining_bytes=300 WHERE id=?').run(f.pageCapture.binding.derivation_id);
    const before = f.snapshot(); const result = await f.call(f.input);
    expect(result.ok).toBe(false); expect(result.error.details.reason).toBe('PROVENANCE_LIMIT');
    expect(f.snapshot()).toEqual(before);
    expect(f.db.prepare('SELECT COUNT(*) n FROM provenance_observations WHERE expected_post_commit_observation IS NOT NULL').get()).toEqual({ n: 0 });
  });
  it.each(['purged', 'expired'] as const)('invalidates sibling home replay on %s exactly once without erasing its input text', async availability => {
    const f = await mergeFixture(); const committed = await f.call(f.input); expect(committed.ok).toBe(true);
    const [home, page] = committed.data.provenance_receipts;
    const retained = retainedInput(f, home.output_revision_id);
    const scope = { derivation_ids: [page.derivation_id] };
    const store = new ProvenanceStore(f.db); const before = actualBytes(f);
    const replayBytes = (f.db.prepare('SELECT length(CAST(replay_result AS BLOB)) n FROM provenance_outputs WHERE id=?').get(home.output_revision_id) as { n: number }).n;
    const preview = previewProvenancePurge(f.db, scope);
    expect(preview.derivation_ids).toEqual([page.derivation_id]);
    expect(preview.payload_bytes).toBe(store.get(page.derivation_id)!.payload_bytes + replayBytes);
    if (availability === 'purged') commitProvenancePurge(f.db, { scope, scope_token: preview.scope_token, confirm: true });
    else f.db.transaction(() => clearDerivation(f.db, page.derivation_id, 'expired', new Date().toISOString()))();
    expect(f.db.prepare('SELECT replay_result FROM provenance_outputs WHERE id=?').get(home.output_revision_id)).toEqual({ replay_result: null });
    expect(f.db.prepare('SELECT expected_post_commit_observation FROM provenance_observations WHERE derivation_id=?').all(page.derivation_id))
      .toEqual(Array.from({ length: 4 }, () => ({ expected_post_commit_observation: null })));
    const after = actualBytes(f); expect(before - after).toBe(preview.payload_bytes);
    f.db.transaction(() => clearDerivation(f.db, page.derivation_id, availability, new Date().toISOString()))();
    expect(actualBytes(f)).toBe(after);
    expect(retainedInput(f, home.output_revision_id)).toEqual(retained);
    const snapshot = f.snapshot(); expect((await f.call(f.input)).ok).toBe(false); expect(f.snapshot()).toEqual(snapshot);
  });
  it('binds purge confirmation to the sibling replay bytes, including same-length changes', async () => {
    const f = fixture(); const committed = await f.call(); expect(committed.ok).toBe(true);
    const [home, page] = committed.data.provenance_receipts;
    const scope = { derivation_ids: [page.derivation_id] }; const preview = previewProvenancePurge(f.db, scope);
    f.db.prepare("UPDATE provenance_outputs SET replay_result=replace(replay_result,'Project','Changed') WHERE id=?").run(home.output_revision_id);
    expect(() => commitProvenancePurge(f.db, { scope, scope_token: preview.scope_token, confirm: true })).toThrow('PURGE_SCOPE_CHANGED');
  });
  it('counts one replay only when erasing the anchor and sibling together', async () => {
    const f = fixture(); expect((await f.call()).ok).toBe(true);
    const scope = { derivation_ids: [f.input.home.provenance!.derivation_id, f.pages[0]!.provenance.derivation_id] };
    const preview = previewProvenancePurge(f.db, scope); const before = actualBytes(f);
    commitProvenancePurge(f.db, { scope, scope_token: preview.scope_token, confirm: true });
    expect(before - actualBytes(f)).toBe(preview.payload_bytes);
  });
  it('expires abandoned captures while preserving committed histories and transition metadata', async () => {
    const f = await mergeFixture(); const committed = await f.call(f.input); expect(committed.ok).toBe(true);
    const staged = f.stage({ plan_key: 'unused' });
    const committedRows = f.db.prepare('SELECT * FROM provenance_observations WHERE expected_post_commit_observation IS NOT NULL').all();
    expect(committedRows).toHaveLength(4);
    const cleanup = runProvenanceRetention(f.db, DEFAULT_PROVENANCE_LIMITS, new Date(Date.now() + 10 * 86400000));
    expect(cleanup).toEqual({ abandoned: 1, expired: 1 });
    expect(new ProvenanceStore(f.db).get(staged.binding.derivation_id)).toMatchObject({ availability: 'expired', payload_bytes: 0 });
    expect(f.db.prepare('SELECT * FROM provenance_observations WHERE expected_post_commit_observation IS NOT NULL').all()).toEqual(committedRows);
    expect((await f.call(f.input)).data.reused).toBe(true);
  });
});

it('records final observations only once for eligible inputs inside a publication transaction', async () => {
  const f = await mergeFixture(); const id = f.pageCapture.binding.derivation_id; const at = new Date().toISOString();
  expect(() => recordBatchTransitions(f.db, [id], [f.b], at)).toThrow('Provenance write requires a transaction');
  f.db.prepare('UPDATE nodes SET version=version+1 WHERE id=?').run(f.b);
  const before = new ProvenanceStore(f.db).get(id)!;
  f.db.transaction(() => {
    recordBatchTransitions(f.db, [id, id], [f.b, f.b], at);
    const first = new ProvenanceStore(f.db).get(id)!;
    const tokens = f.db.prepare('SELECT expected_post_commit_observation token FROM provenance_observations WHERE derivation_id=? AND expected_post_commit_observation IS NOT NULL').all(id) as Array<{ token: string }>;
    expect(tokens).toHaveLength(2);
    const bytes = tokens.reduce((sum, row) => sum + Buffer.byteLength(row.token), 0);
    expect(first.payload_bytes - before.payload_bytes).toBe(bytes);
    expect(before.reserved_remaining_bytes - first.reserved_remaining_bytes).toBe(bytes);
    recordBatchTransitions(f.db, [id], [f.b], at);
    expect(new ProvenanceStore(f.db).get(id)).toEqual(first);
  })();
});
it.each(['namespace', 'authority', 'projection'] as const)('does not record a trusted final token for an incompatible input %s', async field => {
  const f = await mergeFixture(); const id = f.pageCapture.binding.derivation_id;
  if (field === 'namespace') f.db.prepare("UPDATE provenance_sources SET namespace='other' WHERE native_id=?").run(f.b);
  if (field === 'authority') f.db.prepare("UPDATE provenance_observations SET authority='caller' WHERE derivation_id=?").run(id);
  if (field === 'projection') f.db.prepare("UPDATE provenance_observations SET projection='node-token-v1' WHERE derivation_id=?").run(id);
  f.db.prepare('UPDATE nodes SET version=version+1 WHERE id=?').run(f.b);
  const before = new ProvenanceStore(f.db).get(id);
  f.db.transaction(() => recordBatchTransitions(f.db, [id], [f.b], new Date().toISOString()))();
  expect(new ProvenanceStore(f.db).get(id)).toEqual(before);
  expect(f.db.prepare('SELECT COUNT(*) n FROM provenance_observations WHERE derivation_id=? AND expected_post_commit_observation IS NOT NULL').get(id)).toEqual({ n: 0 });
});
