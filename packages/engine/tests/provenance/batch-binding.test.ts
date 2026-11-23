import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { ensureWikiSchema } from '../../src/wiki/bootstrap.js';
import { DEFAULT_WIKI_CONFIG } from '../../src/wiki/config.js';
import { registerWikiReconcile, wikiReconcileInputShape } from '../../src/mcp/tools/wiki-reconcile.js';
import { ProvenanceService } from '../../src/provenance/service.js';
import { observeNode } from '../../src/provenance/observations.js';
import { deriveSubpageDecodedFields } from '../../src/provenance/subpage-validation.js';
import type { CaptureTarget, Contribution, PreparedReceipt } from '../../src/provenance/types.js';
import type { WikiReconcileInput } from '../../src/wiki/reconcile-types.js';
import { executeWikiReconcile } from '../../src/wiki/reconcile.js';
import { validateWikiReconcilePlan } from '../../src/wiki/reconcile-plan.js';
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
  function stage(target?: CaptureTarget, log = '2026-09-25 — Generated.') {
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
    bundle.items[0]!.observation = observeNode(db, project.node_id);
    bundle.items[0]!.origin = 'identified';
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

describe('atomic captured reconciliation batches', () => {
  it('publishes three distinct receipts home-first and replays the complete batch without writing', async () => {
    const f = fixture();
    const committed = await f.call();
    expect(committed.ok, JSON.stringify(committed)).toBe(true);
    expect(committed.data.provenance_receipts).toHaveLength(3);
    const receipts = committed.data.provenance_receipts;
    expect(new Set(receipts.map((r: any) => r.output_revision_id)).size).toBe(3);
    expect(new Set(receipts.map((r: any) => r.derivation_id)).size).toBe(3);
    expect(receipts.map((r: any) => r.output_node_id)).toEqual([f.home.node_id, ...committed.data.created.map((r: any) => r.node_id)]);
    expect(receipts.map((r: any) => r.committed_node_version)).toEqual([2, 1, 1]);
    expect(receipts.every((r: any) => r.operation_id === committed.data.operation_id && r.reconcile_key === f.input.reconcile_key)).toBe(true);
    expect(committed.data.provenance_receipt).toEqual(receipts[0]);
    expect(f.db.prepare('SELECT COUNT(*) n FROM provenance_outputs WHERE replay_result IS NOT NULL').get()).toEqual({ n: 1 });
    const accounting = f.db.prepare(`SELECT d.payload_bytes,d.reserved_remaining_bytes,
      (SELECT SUM(bytes) FROM provenance_payloads p WHERE p.derivation_id=d.id) AS payloads,
      COALESCE(length(CAST(o.replay_result AS BLOB)),0) AS replay
      FROM provenance_derivations d JOIN provenance_outputs o ON o.derivation_id=d.id`).all() as
      Array<{ payload_bytes: number; reserved_remaining_bytes: number; payloads: number; replay: number }>;
    for (const row of accounting) {
      expect(row.payload_bytes).toBe(row.payloads + row.replay);
      expect(row.reserved_remaining_bytes).toBe(0);
    }
    const before = f.snapshot(); const replay = await f.call();
    expect(replay.data.provenance_receipts).toEqual(receipts);
    expect(replay.data.reused).toBe(true);
    expect(Object.values(replay.data.current_outputs)).toEqual(['matches', 'matches', 'matches']);
    expect(f.snapshot()).toEqual(before);
  });
  it('accepts the complete captured request at the MCP schema boundary', () => {
    expect(z.object(wikiReconcileInputShape).safeParse(fixture().input).success).toBe(true);
  });
  it.each(['home', 'page', 'target', 'derivation', 'project', 'observation', 'producer'] as const)('rejects invalid %s binding before any write', async kind => {
    const f = fixture(); const request = structuredClone(f.input) as any;
    if (kind === 'home') delete request.home.provenance;
    if (kind === 'page') delete request.pages[1].provenance;
    if (kind === 'target') request.pages[0].target.plan_key = 'other';
    if (kind === 'derivation') request.pages[1].provenance = request.pages[0].provenance;
    if (kind === 'project') f.db.prepare("UPDATE provenance_derivations SET project_id='other' WHERE id=?").run(request.pages[0].provenance.derivation_id);
    if (kind === 'producer') f.db.prepare("UPDATE provenance_derivations SET producer='curator-home-v1' WHERE id=?").run(request.pages[0].provenance.derivation_id);
    if (kind === 'observation') f.db.prepare('UPDATE nodes SET version=version+1 WHERE id=?').run(f.project.node_id);
    const before = f.snapshot();
    expect((await f.call(request)).ok).toBe(false);
    expect(f.snapshot()).toEqual(before);
  });
  it.each(['legacy-home', 'new-home', 'mixed-pages'] as const)(
    'preserves observation-check compatibility for %s', async mode => {
      const f = fixture();
      const { provenance_mode, ...legacy } = structuredClone(f.input);
      const request: WikiReconcileInput = { ...legacy, pages: mode === 'mixed-pages' ? legacy.pages : [],
        ...(mode === 'new-home' ? { provenance_mode } : {}) };
      f.db.prepare('UPDATE nodes SET version=version+1 WHERE id=?').run(f.project.node_id);
      const before = f.snapshot();
      const result = await f.call(request);
      expect(result.ok, JSON.stringify(result)).toBe(mode === 'legacy-home');
      if (mode === 'legacy-home') {
        expect(result.data.provenance_receipt.output_node_id).toBe(f.home.node_id);
        expect((await f.call(request)).data.provenance_receipt).toEqual(result.data.provenance_receipt);
      } else {
        expect(result.error.details.reason).toBe('PROVENANCE_OBSERVATION_CHANGED');
        expect(f.snapshot()).toEqual(before);
      }
    });
  it.each([1, 2, 3])('compensates files and DB after receipt insertion %i fails', async position => {
    const f = fixture(); const before = f.snapshot();
    f.db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON provenance_outputs WHEN (SELECT COUNT(*) FROM provenance_outputs)=${position - 1} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    expect((await f.call()).ok).toBe(false);
    expect(f.snapshot()).toEqual(before);
  });

  it.each([1, 2, 3])('compensates after governed write %i fails', async position => {
    const f = fixture(); const before = f.snapshot();
    const validated = validateWikiReconcilePlan(f.db, DEFAULT_WIKI_CONFIG, f.input);
    if (!validated.ok) throw new Error('Fixture invalid');
    let writes = 0;
    await expect(executeWikiReconcile({ ...f.deps, mutate: (...args) => {
      const result = executeMutation(...args);
      if (++writes === position) throw new Error('injected after write');
      return result;
    } }, validated, { dryRun: false })).rejects.toThrow('injected after write');
    expect(f.snapshot()).toEqual(before);
  });
  it('checks input observations again inside the transaction before the first publication write', async () => {
    const f = fixture(); const before = f.snapshot();
    f.db.exec(`CREATE TRIGGER move_input AFTER INSERT ON undo_operations BEGIN UPDATE nodes SET version=version+1 WHERE id='${f.project.node_id}'; END`);
    const response = await f.call();
    expect(response.ok).toBe(false);
    expect(response.error.details.reason).toBe('PROVENANCE_OBSERVATION_CHANGED');
    // The trigger edits only the input before the publication transaction starts.
    expect(f.db.prepare('SELECT version FROM nodes WHERE id=?').get(f.home.node_id)).toEqual({ version: 1 });
    expect(f.snapshot().files).toEqual(before.files);
    expect(f.snapshot().outputs).toEqual([]);
  });
  it.each(['purged', 'expired', 'missing-output', 'missing-payload'] as const)('refuses batch replay with a %s sibling', async state => {
    const f = fixture(); expect((await f.call()).ok).toBe(true);
    const id = f.pages[1]!.provenance.derivation_id;
    if (state === 'missing-output') f.db.prepare('DELETE FROM provenance_outputs WHERE derivation_id=?').run(id);
    else if (state === 'missing-payload') f.db.prepare("DELETE FROM provenance_payloads WHERE derivation_id=? AND kind='contribution'").run(id);
    else f.db.prepare('UPDATE provenance_derivations SET availability=? WHERE id=?').run(state, id);
    const before = f.snapshot();
    expect((await f.call()).ok).toBe(false);
    expect(f.snapshot()).toEqual(before);
  });
  it('rejects oversized complete replay payloads without publishing a subset', async () => {
    const f = fixture(); const before = f.snapshot();
    const pages = Array.from({ length: 120 }, (_, index) => {
      const key = `page-${index}`;
      const captured = f.stage({ plan_key: key });
      return { ...f.pages[0]!, target: { mode: 'new' as const, plan_key: key, title: `Project page ${index}` },
        provenance: captured.binding };
    });
    const request = { ...f.input, pages };
    const staged = f.snapshot();
    const response = await f.call(request);
    expect(response.ok).toBe(false);
    expect(response.error.details.reason).toBe('PROVENANCE_LIMIT');
    expect(f.snapshot()).toEqual(staged);
    expect(f.snapshot().files).toEqual(before.files);
  });
  it('replaces only the same stable node and preserves merge-source output history', async () => {
    const f = fixture(); const first = await f.call(); expect(first.ok).toBe(true);
    const [home, target, source] = first.data.provenance_receipts;
    const homeCapture = f.stage(undefined, 'Second home log.');
    const pageCapture = f.stage({ node_id: target.output_node_id });
    const request: WikiReconcileInput = { ...f.input, reconcile_key: `wiki-reconcile:provenance-v1:${homeCapture.binding.derivation_id}`,
      home: { ...f.input.home, expected_version: 2, sections: homeCapture.sections, provenance: homeCapture.binding },
      pages: [{ ...f.pages[0]!, op: 'merge', target: { mode: 'existing', node_id: target.output_node_id, expected_version: 1 },
        sources: [{ node_id: source.output_node_id, expected_version: 1 }], reason: 'Consolidate',
        sections: pageCapture.sections, provenance: pageCapture.binding }] };
    const merged = await f.call(request); expect(merged.ok, JSON.stringify(merged)).toBe(true);
    expect(merged.data.provenance_receipts.map((receipt: any) => receipt.replaces_output_revision_id))
      .toEqual([home.output_revision_id, target.output_revision_id]);
    expect(merged.data.provenance_receipts.map((receipt: any) => receipt.committed_node_version)).toEqual([3, 2]);
    expect(f.db.prepare('SELECT replaces_output_revision_id FROM provenance_outputs WHERE id=?').get(source.output_revision_id))
      .toEqual({ replaces_output_revision_id: null });
    expect((await f.call(request)).data.provenance_receipts).toEqual(merged.data.provenance_receipts);
  });
  it('rejects a capture moved to another existing node despite identical generated text', async () => {
    const f = fixture(); const first = await f.call(); expect(first.ok).toBe(true);
    const target = first.data.created[0]; const other = first.data.created[1];
    const home = f.stage(undefined, 'Next home.'); const page = f.stage({ node_id: target.node_id }, 'Next page.');
    const request: WikiReconcileInput = { ...f.input, reconcile_key: `wiki-reconcile:provenance-v1:${home.binding.derivation_id}`,
      home: { ...f.input.home, expected_version: 2, sections: home.sections, provenance: home.binding },
      pages: [{ ...f.pages[0]!, target: { mode: 'existing', node_id: other.node_id, expected_version: 1 }, sections: page.sections, provenance: page.binding }] };
    const before = f.snapshot(); expect((await f.call(request)).ok).toBe(false); expect(f.snapshot()).toEqual(before);
  });
  it('preserves bounded target presentation on replay', async () => {
    const f = fixture();
    const request = { ...f.input, pages: [{ ...f.pages[0]!, target: { ...f.pages[0]!.target, title: 'Page ' + 'x'.repeat(210) } }] };
    const first = await f.call(request); expect(first.ok, JSON.stringify(first)).toBe(true);
    const replay = await f.call(request);
    expect(replay.data.created).toEqual(first.data.created);
    expect(replay.data.preview).toEqual(first.data.preview);
  });
  it.each(['duplicate-target', 'sections', 'digest', 'lease', 'mode'] as const)('rejects %s without partial publication', async kind => {
    const f = fixture(); const request = structuredClone(f.input) as any;
    if (kind === 'duplicate-target') request.pages[1].target = request.pages[0].target;
    if (kind === 'sections') request.pages[0].sections[0].content = 'Uncaptured change';
    if (kind === 'digest') request.pages[0].provenance.contribution_digest = 'wrong';
    if (kind === 'lease') f.db.prepare("UPDATE provenance_derivations SET lease_expires_at='2020-01-01T00:00:00Z' WHERE id=?").run(request.pages[0].provenance.derivation_id);
    if (kind === 'mode') { expect((await f.call()).ok).toBe(true); delete request.provenance_mode; }
    const before = f.snapshot(); expect((await f.call(request)).ok).toBe(false); expect(f.snapshot()).toEqual(before);
  });
  it.each(['payload', 'state', 'activation'] as const)('compensates when final %s binding fails', async point => {
    const f = fixture(); const before = f.snapshot();
    const trigger = point === 'payload'
      ? "BEFORE INSERT ON provenance_payloads WHEN NEW.kind='contribution'"
      : point === 'state' ? "BEFORE UPDATE ON provenance_derivations WHEN NEW.state='committed'"
        : "BEFORE INSERT ON provenance_flow_activations WHEN NEW.flow='project-subpage-v1'";
    f.db.exec(`CREATE TRIGGER reject_binding ${trigger} BEGIN SELECT RAISE(ABORT, 'injected binding'); END`);
    expect((await f.call()).ok).toBe(false); expect(f.snapshot()).toEqual(before);
  });
  it.each(['keep', 'retire'] as const)('does not require a manufactured capture for metadata-only %s', async operation => {
    const f = fixture(); const first = await f.call(); expect(first.ok).toBe(true);
    const page = first.data.created[0]; const home = f.stage(undefined, 'Metadata update.');
    const target = { mode: 'existing' as const, node_id: page.node_id, expected_version: 1 };
    const metadata = operation === 'keep'
      ? { op: 'upsert' as const, target, scope: f.pages[0]!.scope, kind: 'freeform' as const, origin: 'automatic' as const, pinned: true }
      : { op: 'retire' as const, node_id: page.node_id, expected_version: 1, scope: f.pages[0]!.scope, state: 'dormant' as const, reason: 'Paused' };
    const request: WikiReconcileInput = { ...f.input, reconcile_key: `wiki-reconcile:provenance-v1:${home.binding.derivation_id}`,
      home: { ...f.input.home, expected_version: 2, sections: home.sections, provenance: home.binding }, pages: [metadata] };
    const response = await f.call(request); expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response.data.provenance_receipts).toHaveLength(1);
    expect(response.data.provenance_receipt.output_node_id).toBe(f.home.node_id);
    expect((await f.call(request)).data.provenance_receipts).toEqual(response.data.provenance_receipts);
  });
  it('previews without publishing and rejects changed frozen retries', async () => {
    const f = fixture(); const before = f.snapshot();
    expect((await f.call({ ...f.input, dry_run: true })).ok).toBe(true);
    expect(f.snapshot()).toEqual(before);
    expect((await f.call()).ok).toBe(true);
    const committed = f.snapshot();
    expect((await f.call({ ...f.input, home: { ...f.input.home, evidence_hash: 'different' } })).ok).toBe(false);
    expect(f.snapshot()).toEqual(committed);
  });
});
