import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeRename } from '../../src/mcp/tools/rename-node.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { inspectProvenance } from '../../src/provenance/inspect.js';
import { observeNode } from '../../src/provenance/observations.js';
import { ProvenanceService } from '../../src/provenance/service.js';
import { deriveSubpageDecodedFields } from '../../src/provenance/subpage-validation.js';
import type { CaptureTarget, Contribution, PreparedReceipt } from '../../src/provenance/types.js';
import { registerWikiReconcile, wikiReconcileInputShape } from '../../src/mcp/tools/wiki-reconcile.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { DEFAULT_WIKI_CONFIG, getWikiConfig } from '../../src/wiki/config.js';
import { fetchExistingWiki } from '../../src/wiki/digest.js';
import type { WikiReconcileInput } from '../../src/wiki/reconcile-types.js';
import { ensureWikiSchema } from '../../src/wiki/bootstrap.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { bundleFixture } from './fixture.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));

const SCOPE = { v: 1 as const, subject: 'Project', facet: 'decisions' };

/** A wiki with a captured home and two captured pages, built by a real captured reconcile. */
async function setup() {
  const db = createTestDb(); const vault = createTempVault(); const writeLock = new WriteLockManager();
  cleanups.push(() => { db.close(); vault.cleanup(); });
  db.prepare("INSERT INTO schemas(name,display_name,field_claims) VALUES ('project','Project','[]')").run();
  const project = executeMutation(db, writeLock, vault.vaultPath, { source: 'tool', node_id: null,
    file_path: 'Project.md', title: 'Project', types: ['project'], fields: {}, body: 'Original evidence.' });
  ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
  const home = executeMutation(db, writeLock, vault.vaultPath, { source: 'tool', node_id: null,
    file_path: 'Wikis/Project Wiki.md', title: 'Project Wiki', types: ['wiki'], fields: { wiki_for: 'Project' }, body: 'Human introduction.' });
  const service = new ProvenanceService(db);
  function stage(target?: CaptureTarget, text = 'Generated summary.') {
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
    const note = `2026-11-07 — ${text}`;
    const sections: Contribution = [{ name: target ? 'Summary' : 'Now', mode: 'replace', content: text },
      { name: 'Log', mode: 'append', content: note }];
    const binding = service.stage({ derivation_id: prepared.derivation_id, bundle_digest: prepared.bundle_digest!,
      validated_sections: target ? { body: text, log_note: note } : { now: text, log_entry: text },
      contribution: sections, generated_at: '2026-11-07T00:00:00Z', log_stamp: '2026-11-07' });
    return { sections, binding };
  }
  let handle: (params: any) => Promise<any>;
  registerWikiReconcile({ tool: (_n: string, _d: string, _s: unknown, fn: typeof handle) => { handle = fn; } } as unknown as McpServer,
    { db, writeLock, vaultPath: vault.vaultPath });
  const call = async (params: unknown) => JSON.parse((await handle(params)).content[0].text);

  const capturedHome = stage();
  const pages = ['decisions', 'risks'].map(facet => {
    const captured = stage({ plan_key: facet });
    return { op: 'upsert' as const, target: { mode: 'new' as const, plan_key: facet, title: `Project ${facet}` },
      scope: { ...SCOPE, facet }, kind: 'freeform' as const, origin: 'automatic' as const,
      pinned: facet === 'risks', sections: captured.sections, provenance: captured.binding };
  });
  const built = await call({ project: 'Project', project_id: project.node_id, pages, provenance_mode: 'project-subpage-v1',
    reconcile_key: `wiki-reconcile:provenance-v1:${capturedHome.binding.derivation_id}`,
    home: { expected_version: 1, sections: capturedHome.sections, provenance: capturedHome.binding,
      evidence_hash: 'evidence', curated_at: '2026-11-07T00:00:00Z', refresh_live: true }, dry_run: false });
  if (!built.ok) throw new Error(JSON.stringify(built));
  const [homeReceipt, pageReceipt, pinnedReceipt] = built.data.provenance_receipts;
  const target = (id: string): any => inspectProvenance(db, { select: 'refresh_target', output_revision_id: id } as never);
  const pageId: string = pageReceipt.output_node_id;

  /** The request the Curator will send for this page. */
  function request(over: Record<string, unknown> = {}, text = 'Rebuilt summary.', receipt = pageReceipt, facet = 'decisions', pinned = false): WikiReconcileInput {
    const facts = target(receipt.output_revision_id);
    const captured = stage({ node_id: receipt.output_node_id }, text);
    return { project: 'Project', project_id: project.node_id, provenance_mode: 'project-subpage-v1',
      page_refresh: { page_node_id: receipt.output_node_id, expected_output_revision_id: receipt.output_revision_id, expected_topology_hash: facts.topology_hash },
      reconcile_key: `wiki-reconcile:provenance-v1:${captured.binding.derivation_id}`,
      pages: [{ op: 'upsert', target: { mode: 'existing', node_id: receipt.output_node_id, expected_version: facts.page_version },
        scope: { ...SCOPE, facet }, kind: 'freeform', origin: 'automatic', pinned, sections: captured.sections, provenance: captured.binding }],
      home: { sections: [], evidence_hash: 'evidence', curated_at: '2026-11-07T01:00:00Z', refresh_live: true }, dry_run: false, ...over } as WikiReconcileInput;
  }
  /** A home refresh, which the Curator sends when the output is the home. */
  function homeRequest(over: Record<string, unknown>): WikiReconcileInput {
    const captured = stage(undefined, 'Rebuilt home.');
    return { project: 'Project', project_id: project.node_id, pages: [],
      reconcile_key: `wiki-reconcile:provenance-v1:${captured.binding.derivation_id}`,
      home: { expected_version: row(home.node_id).version, sections: captured.sections, provenance: captured.binding,
        evidence_hash: 'evidence', curated_at: '2026-11-07T01:00:00Z', refresh_live: true }, dry_run: false, ...over } as WikiReconcileInput;
  }
  const row = (id: string) => db.prepare('SELECT * FROM nodes WHERE id=?').get(id) as { version: number; body: string };
  const fields = (id: string) => db.prepare('SELECT * FROM node_fields WHERE node_id=? ORDER BY field_name').all(id);
  const counts = () => db.prepare('SELECT COUNT(*) n FROM provenance_outputs').get();
  return { db, vault, writeLock, call, target, request, homeRequest, row, fields, counts, home, project, pageId, homeReceipt, pageReceipt, pinnedReceipt, service, mutate: (input: Parameters<typeof executeMutation>[3]) => executeMutation(db, writeLock, vault.vaultPath, input) };
}

describe('refresh_target for a sub-page', () => {
  it('reports the page, with the home fields still describing the wiki\'s home', async () => {
    const f = await setup();
    expect(f.target(f.pageReceipt.output_revision_id)).toMatchObject({ eligible: true, reasons: [], target_kind: 'page',
      page_node_id: f.pageId, page_title: 'Project decisions', page_version: expect.any(Number),
      home_node_id: f.home.node_id, home_title: 'Project Wiki', project_id: f.project.node_id, project_title: 'Project' });
  });

  it('still reports a home as a home', async () => {
    const f = await setup();
    expect(f.target(f.homeReceipt.output_revision_id)).toMatchObject({ eligible: true, target_kind: 'home', page_node_id: null, home_node_id: f.home.node_id });
  });

  it('blocks a page that is no longer active', async () => {
    const f = await setup();
    f.db.prepare("UPDATE node_fields SET value_text='dormant' WHERE node_id=? AND field_name='wiki_state'").run(f.pageId);
    const facts = f.target(f.pageReceipt.output_revision_id);
    expect(facts.eligible).toBe(false);
    expect(facts.reasons).toContain('PAGE_NOT_ACTIVE');
  });

  it('blocks a page whose generated text was edited', async () => {
    const f = await setup();
    f.db.prepare("UPDATE nodes SET body=REPLACE(body,'Generated summary.','Owner edit') WHERE id=?").run(f.pageId);
    const facts = f.target(f.pageReceipt.output_revision_id);
    expect(facts.eligible).toBe(false);
    expect(facts.reasons).toContain('MANAGED_CONTENT_CHANGED');
  });
});

describe('page_refresh', () => {
  it('fits the MCP schema, and advertises the feature', async () => {
    const f = await setup();
    expect(z.object(wikiReconcileInputShape).safeParse(f.request()).success).toBe(true);
    const status = inspectProvenance(f.db, { select: 'status' } as never) as { inspection_features: string[] };
    expect(status.inspection_features).toContain('selective_page_refresh_v1');
  });

  it('rewrites only that page, with lineage to the build it replaces', async () => {
    const f = await setup();
    const homeBefore = { row: f.row(f.home.node_id), fields: f.fields(f.home.node_id) };
    const other = f.pinnedReceipt.output_node_id;
    const otherBefore = { row: f.row(other), fields: f.fields(other) };

    const result = await f.call(f.request());

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.data.provenance_receipt).toMatchObject({ output_node_id: f.pageId, replaces_output_revision_id: f.pageReceipt.output_revision_id });
    expect(result.data.provenance_receipts).toHaveLength(1);
    expect(result.data.updated.map((n: { node_id: string }) => n.node_id)).toEqual([f.pageId]);
    expect(result.data.created).toEqual([]);
    expect(f.row(f.pageId).body).toContain('Rebuilt summary.');
    expect({ row: f.row(f.home.node_id), fields: f.fields(f.home.node_id) }).toEqual(homeBefore);
    expect({ row: f.row(other), fields: f.fields(other) }).toEqual(otherBefore);

    const latest = f.target(result.data.provenance_receipt.output_revision_id);
    expect(latest).toMatchObject({ eligible: true, target_kind: 'page', latest_output_revision_id: result.data.provenance_receipt.output_revision_id });
    expect(f.target(f.pageReceipt.output_revision_id).reasons).toContain('HISTORICAL_OUTPUT');
  });

  it('leaves the home eligible for its own rebuild', async () => {
    const f = await setup();
    expect((await f.call(f.request())).ok).toBe(true);
    expect(f.target(f.homeReceipt.output_revision_id)).toMatchObject({ eligible: true, target_kind: 'home' });
  });

  it('previews without writing', async () => {
    const f = await setup();
    const before = { row: f.row(f.pageId), outputs: f.counts() };
    const result = await f.call(f.request({ dry_run: true }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.data.dry_run).toBe(true);
    expect({ row: f.row(f.pageId), outputs: f.counts() }).toEqual(before);
  });

  it('leaves the page\'s fields exactly as they were', async () => {
    const f = await setup();
    // Spelled differently from what a rebuild of the fields would write.
    f.db.prepare("UPDATE node_fields SET value_text='Project' WHERE node_id=? AND field_name='wiki_for'").run(f.pageId);
    const before = f.fields(f.pageId);
    const result = await f.call(f.request());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(f.fields(f.pageId)).toEqual(before);
  });

  it('keeps the page under a home that was renamed', async () => {
    const f = await setup();
    f.db.transaction(() => executeRename(f.db, f.writeLock, f.vault.vaultPath, { node_id: f.home.node_id, file_path: 'Wikis/Project Wiki.md', title: 'Project Wiki' }, 'Renamed Home', 'Wikis/Renamed Home.md'))();
    const fieldsBefore = f.fields(f.pageId);
    const result = await f.call(f.request());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(f.fields(f.pageId)).toEqual(fieldsBefore);
    const catalog = fetchExistingWiki(f.db, f.project.node_id, getWikiConfig(f.db));
    expect(catalog.home_id).toBe(f.home.node_id);
    expect(catalog.subpages.map(page => page.id)).toContain(f.pageId);
    expect(f.target(result.data.provenance_receipt.output_revision_id)).toMatchObject({ eligible: true, target_kind: 'page', home_title: 'Renamed Home' });
  });

  it('previews the same home as it publishes, which is the unchanged one', async () => {
    const f = await setup();
    const before = f.row(f.home.node_id).version;
    const input = f.request();
    const preview = await f.call({ ...input, dry_run: true });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    expect(preview.data.home).toMatchObject({ node_id: f.home.node_id, version: before, created: false });
    const published = await f.call(input);
    expect(published.ok, JSON.stringify(published)).toBe(true);
    expect(published.data.home).toEqual(preview.data.home);
    expect(f.row(f.home.node_id).version).toBe(before);
  });

  it('isn\'t blocked by broken section markers in the home it doesn\'t write', async () => {
    const f = await setup();
    f.db.prepare("UPDATE nodes SET body=body || char(10) || '<!-- ve:managed:Now:start -->' WHERE id=?").run(f.home.node_id);
    const homeBefore = f.row(f.home.node_id);
    const input = f.request();
    const preview = await f.call({ ...input, dry_run: true });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    const published = await f.call(input);
    expect(published.ok, JSON.stringify(published)).toBe(true);
    expect(f.row(f.home.node_id)).toEqual(homeBefore);
  });

  it('replays a committed request without writing again', async () => {
    const f = await setup();
    const input = f.request();
    const first = await f.call(input);
    const before = { row: f.row(f.pageId), outputs: f.counts() };
    const replay = await f.call(input);
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    expect(replay.data).toMatchObject({ reused: true, provenance_receipt: first.data.provenance_receipt, current_output: 'matches' });
    expect({ row: f.row(f.pageId), outputs: f.counts() }).toEqual(before);
  });

  it.each([
    ['a second page', (input: any) => { input.pages.push({ ...input.pages[0], target: { mode: 'existing', node_id: 'other', expected_version: 1 } }); }],
    ['no page', (input: any) => { input.pages = []; }],
    ['another node in the guard', (input: any) => { input.page_refresh.page_node_id = 'another'; }],
    ['home content', (input: any) => { input.home.sections = [{ name: 'Now', mode: 'replace', content: 'x' }]; }],
    ['no capture', (input: any) => { delete input.pages[0].provenance; }],
    ['the wrong mode', (input: any) => { delete input.provenance_mode; }],
  ])('refuses %s, writing nothing', async (_label, change) => {
    const f = await setup();
    const input = f.request();
    change(input);
    const before = { row: f.row(f.pageId), outputs: f.counts() };
    const result = await f.call(input);
    expect(result.ok).toBe(false);
    expect(result.error.message + JSON.stringify(result.error.details ?? {})).toMatch(/PAGE_REFRESH_INVALID|Page refresh/);
    expect({ row: f.row(f.pageId), outputs: f.counts() }).toEqual(before);
  });

  it.each([
    ['a home refresh too', (input: any) => { input.home_refresh = { home_node_id: 'h', expected_output_revision_id: 'o', expected_topology_hash: 't' }; }],
    ['a stale output', (input: any) => { input.page_refresh.expected_output_revision_id = 'absent'; }],
    ['a stale topology', (input: any) => { input.page_refresh.expected_topology_hash = 'stale'; }],
    ['a changed pin', (input: any) => { input.pages[0].pinned = true; }],
    ['a changed scope', (input: any) => { input.pages[0].scope = { ...SCOPE, facet: 'other' }; }],
    ['a changed kind', (input: any) => { input.pages[0].kind = 'timeline'; }],
    ['a changed origin', (input: any) => { input.pages[0].origin = 'requested'; }],
    ['a reconcile key from another capture', (input: any) => { input.reconcile_key = 'wiki-reconcile:provenance-v1:other'; }],
  ])('refuses %s, writing nothing', async (_label, change) => {
    const f = await setup();
    const input = f.request();
    change(input);
    const before = { row: f.row(f.pageId), outputs: f.counts() };
    const result = await f.call(input);
    expect(result.ok).toBe(false);
    expect({ row: f.row(f.pageId), outputs: f.counts() }).toEqual(before);
  });

  it('refuses when the page changed after it was read', async () => {
    const f = await setup();
    const input = f.request();
    (input.pages[0] as { target: { expected_version: number } }).target.expected_version -= 1;
    expect((await f.call(input)).ok).toBe(false);
  });

  it('rebuilds a pinned page, which stays pinned', async () => {
    const f = await setup();
    const pinned = f.pinnedReceipt.output_node_id;
    const result = await f.call(f.request({}, 'Rebuilt pinned page.', f.pinnedReceipt, 'risks', true));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(f.row(pinned).body).toContain('Rebuilt pinned page.');
    const stored = fetchExistingWiki(f.db, f.project.node_id, getWikiConfig(f.db)).subpages.find(page => page.id === pinned);
    expect(stored?.wiki_pinned).toBe(true);
  });

  it('can rebuild the same page again', async () => {
    const f = await setup();
    const first = await f.call(f.request());
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const second = await f.call(f.request({}, 'Rebuilt again.', first.data.provenance_receipt));
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(f.row(f.pageId).body).toContain('Rebuilt again.');
    expect(second.data.provenance_receipt.replaces_output_revision_id).toBe(first.data.provenance_receipt.output_revision_id);
  });

  it('refuses a page output offered as a home refresh, writing nothing', async () => {
    const f = await setup();
    const facts = f.target(f.pageReceipt.output_revision_id);
    const before = { row: f.row(f.home.node_id), outputs: f.counts() };
    const home = f.homeRequest({ home_refresh: { home_node_id: f.home.node_id, expected_output_revision_id: f.pageReceipt.output_revision_id, expected_topology_hash: facts.topology_hash } });
    const result = await f.call(home);
    expect(result.ok).toBe(false);
    expect({ row: f.row(f.home.node_id), outputs: f.counts() }).toEqual(before);
  });

  it('refuses a home output, even with a valid page in the request', async () => {
    const f = await setup();
    const input = f.request();
    (input.page_refresh as { expected_output_revision_id: string }).expected_output_revision_id = f.homeReceipt.output_revision_id;
    expect((await f.call(input)).ok).toBe(false);
  });
});
