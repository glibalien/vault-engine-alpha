import { describe, expect, it } from 'vitest';
import { EngineError, type WikiReconcileInput, type WikiReconcileResult } from '../src/engine.js';
import { buildReconcileKey, executeReconciliation, ReconcileInvariantError, type ReconcileWriteInput } from '../src/reconcile-write.js';
import type { ExistingWiki, PageSynthesisResult, TopologyPlan, WikiCatalogPage, WikiScopeV1 } from '../src/types.js';

const curatedAt = '2026-08-14T12:00:00.000Z';
const usage = { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 };
const scope = (facet: string): WikiScopeV1 => ({ v: 1, subject: 'Demo', facet });

function page(id: string, overrides: Partial<WikiCatalogPage> = {}): WikiCatalogPage {
  return {
    id, title: `Page ${id}`, file_path: `Wikis/${id}.md`, version: 1,
    content_hash: `hash-${id}`, wiki_state: 'active', wiki_kind: 'workstream',
    wiki_origin: 'automatic', wiki_scope: scope(id), wiki_pinned: false, ...overrides,
  };
}

const catalog = [
  page('keep'),
  page('adopt', { wiki_scope: undefined }),
  page('refresh', { version: 3 }),
  page('reactivate', { version: 4, wiki_state: 'dormant' }),
  page('target', { version: 5 }),
  page('source', { version: 6 }),
  page('retire', { version: 7 }),
  page('ancestor', { version: 8, wiki_replaced_by: { id: 'source', title: 'Page source' } }),
];

const existingWiki: ExistingWiki = {
  home_id: 'home', home: { id: 'home', version: 9 }, topology_hash: 'topology-before',
  catalog_valid: true, subpages: catalog,
};

const plan: TopologyPlan = {
  reviewed_page_ids: catalog.map(item => item.id),
  actions: [
    { op: 'keep', node_id: 'keep', scope: scope('keep') },
    { op: 'keep', node_id: 'adopt', scope: scope('adopted') },
    { op: 'refresh', node_id: 'refresh', scope: scope('refresh'), synthesis_brief: 'Refresh.' },
    { op: 'reactivate', node_id: 'reactivate', scope: scope('reactivate'), synthesis_brief: 'Reactivate.' },
    { op: 'create', plan_key: 'new', title: 'New Page', kind: 'timeline', scope: scope('new'), synthesis_brief: 'Create.' },
    { op: 'merge', target: { node_id: 'target' }, sources: ['source'], scope: scope('merged'), reason: 'Overlap.', synthesis_brief: 'Merge.' },
    { op: 'retire', node_id: 'retire', scope: scope('retire'), state: 'retired', reason: 'Concluded.' },
    { op: 'keep', node_id: 'ancestor', scope: scope('merged') },
  ],
};

const synthesizedPages: readonly PageSynthesisResult[] = [
  { target: { node_id: 'refresh' }, body: 'Refresh body.', log_note: 'Refreshed.', usage },
  { target: { node_id: 'reactivate' }, body: 'Reactivate body.', usage },
  { target: { plan_key: 'new' }, body: 'New body.', usage },
  { target: { node_id: 'target' }, body: 'Merged body.', log_note: 'Merged.', usage },
];

function result(dryRun: boolean, createdId = dryRun ? 'plan:new' : 'created-new'): WikiReconcileResult {
  return {
    operation_id: dryRun ? null : 'operation-1', reconcile_key: 'ignored-by-fake', plan_digest: 'digest',
    reused: false, dry_run: dryRun,
    created: [{ node_id: createdId, title: 'New Page', file_path: 'Wikis/New Page.md', version: 1 }],
    updated: [
      { node_id: 'adopt', title: 'Page adopt', file_path: 'Wikis/adopt.md', version: 2 },
      { node_id: 'refresh', title: 'Page refresh', file_path: 'Wikis/refresh.md', version: 4 },
      { node_id: 'reactivate', title: 'Page reactivate', file_path: 'Wikis/reactivate.md', version: 5 },
      { node_id: 'target', title: 'Page target', file_path: 'Wikis/target.md', version: 6 },
      { node_id: 'source', title: 'Page source', file_path: 'Wikis/source.md', version: 7 },
      { node_id: 'retire', title: 'Page retire', file_path: 'Wikis/retire.md', version: 8 },
    ],
    mappings: [{ source_node_id: 'source', target_node_id: 'target', target_title: 'Page target' }],
    home: { node_id: 'home', title: 'Demo Wiki', file_path: 'Wikis/Demo Wiki.md', version: 10, created: false },
    topology_hash: 'topology-after', warnings: [],
    preview: { total: 6, items: [], truncated: false },
  };
}

function input(engine: ReconcileWriteInput['engine'], dryRun = false) {
  return {
    engine, project: 'Demo', wikiRootId: 'root-1', evidenceHash: 'evidence-1', existingWiki,
    plan, synthesizedPages, homeSections: { now: 'Now.', focus: 'Focus.', open_threads: 'Threads.', log_entry: 'Log.' },
    dryRun, curatedAt,
  };
}

describe('executeReconciliation', () => {
  it('converts every accepted action to exact versioned engine operations', async () => {
    const calls: WikiReconcileInput[] = [];
    const engine = { async wikiReconcile(value: WikiReconcileInput) { calls.push(value); return { data: result(value.dry_run === true), warnings: [] as [] }; } };

    await executeReconciliation(input(engine));

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ project: 'Demo', project_id: 'root-1' });
    expect(calls[0]?.pages).toEqual([
      { op: 'upsert', target: { mode: 'existing', node_id: 'adopt', expected_version: 1 }, scope: scope('adopted'), kind: 'workstream', origin: 'automatic', pinned: false },
      { op: 'upsert', target: { mode: 'existing', node_id: 'refresh', expected_version: 3 }, scope: scope('refresh'), kind: 'workstream', origin: 'automatic', pinned: false, sections: [{ name: 'Summary', mode: 'replace', content: 'Refresh body.' }, { name: 'Log', mode: 'append', content: 'Refreshed.' }] },
      { op: 'upsert', target: { mode: 'existing', node_id: 'reactivate', expected_version: 4 }, scope: scope('reactivate'), kind: 'workstream', origin: 'automatic', pinned: false, sections: [{ name: 'Summary', mode: 'replace', content: 'Reactivate body.' }] },
      { op: 'upsert', target: { mode: 'new', plan_key: 'new', title: 'New Page' }, scope: scope('new'), kind: 'timeline', origin: 'automatic', pinned: false, sections: [{ name: 'Summary', mode: 'replace', content: 'New body.' }] },
      { op: 'merge', target: { mode: 'existing', node_id: 'target', expected_version: 5 }, sources: [{ node_id: 'source', expected_version: 6 }], scope: scope('merged'), kind: 'workstream', origin: 'automatic', pinned: false, reason: 'Overlap.', sections: [{ name: 'Summary', mode: 'replace', content: 'Merged body.' }, { name: 'Log', mode: 'append', content: 'Merged.' }] },
      { op: 'retire', node_id: 'retire', expected_version: 7, scope: scope('retire'), state: 'retired', reason: 'Concluded.' },
    ]);
    expect(calls[0]?.home).toEqual({ expected_version: 9, sections: [
      { name: 'Now', mode: 'replace', content: 'Now.' }, { name: 'Focus', mode: 'replace', content: 'Focus.' },
      { name: 'Open threads', mode: 'replace', content: 'Threads.' }, { name: 'Log', mode: 'append', content: 'Log.' },
    ], evidence_hash: 'evidence-1', curated_at: curatedAt, refresh_live: true });
  });

  it('previews then commits the same payload and translates mappings, warnings, and outcomes', async () => {
    const calls: WikiReconcileInput[] = [];
    const warning = { code: 'STALE_ACTIVE_REPLACEMENT' as const, message: 'Stale replacement.', severity: 'warning' as const };
    const engine = { async wikiReconcile(value: WikiReconcileInput) { calls.push(value); return { data: result(value.dry_run === true), warnings: value.dry_run ? [warning] : [] }; } };

    const output = await executeReconciliation(input(engine));

    expect(calls[1]).toEqual({ ...calls[0], dry_run: false });
    expect(output.reconcileKey).toBe(calls[0]?.reconcile_key);
    expect(output.topologyHash).toBe('topology-after');
    expect(output.mappings).toEqual([{ source_node_id: 'source', target_node_id: 'target', target_title: 'Page target' }]);
    expect(output.warnings).toContainEqual(warning);
    expect(output.topology.map(item => item.action)).toEqual([
      'kept', 'adopted', 'refreshed', 'reactivated', 'created', 'merged-target', 'merged-source', 'retired', 'kept',
    ]);
  });

  it('stops after one preview for caller dry-run and suppresses commit after preview failure', async () => {
    const previewCalls: WikiReconcileInput[] = [];
    const previewEngine = { async wikiReconcile(value: WikiReconcileInput) { previewCalls.push(value); return { data: result(true), warnings: [] as [] }; } };
    const preview = await executeReconciliation(input(previewEngine, true));
    expect(previewCalls).toHaveLength(1);
    expect(preview.data.dry_run).toBe(true);

    let failedCalls = 0;
    const staleEngine = { async wikiReconcile(_value: WikiReconcileInput): Promise<{ data: WikiReconcileResult; warnings: [] }> { failedCalls += 1; throw new EngineError('STALE_NODE', 'changed'); } };
    await expect(executeReconciliation(input(staleEngine))).rejects.toMatchObject({ code: 'STALE_NODE' });
    expect(failedCalls).toBe(1);
  });

  it('rejects engine-created nodes that were not planned as new targets', async () => {
    const unexpected: WikiReconcileResult = {
      ...result(true, 'unexpected'),
      created: [{ node_id: 'unexpected', title: 'Page refresh', file_path: 'Wikis/refresh.md', version: 1 }],
    };
    const badEngine = { async wikiReconcile() { return { data: unexpected, warnings: [] as [] }; } };
    await expect(executeReconciliation(input(badEngine, true))).rejects.toBeInstanceOf(ReconcileInvariantError);
  });
});

describe('buildReconcileKey', () => {
  it('is stable and changes with evidence, topology, actions, or request identity', () => {
    const base = { wikiRootId: 'root-1', evidenceHash: 'evidence-1', topologyHash: 'topology-1', plan };
    expect(buildReconcileKey(base)).toBe(buildReconcileKey(base));
    expect(new Set([
      buildReconcileKey(base), buildReconcileKey({ ...base, evidenceHash: 'evidence-2' }),
      buildReconcileKey({ ...base, topologyHash: 'topology-2' }),
      buildReconcileKey({ ...base, plan: { ...plan, actions: plan.actions.slice(1) } }),
      buildReconcileKey({ ...base, requestedPageRequestId: 'request-1' }),
    ])).toHaveLength(5);
  });
});

describe('captured project batch', () => {
  const binding = (id: string) => ({ derivation_id: id, bundle_digest: `bundle-${id}`, contribution_digest: `contribution-${id}` });
  const capturedPages = synthesizedPages.map((page, index) => ({ ...page, provenance: binding(`page-${index}`) }));
  const captured = (engine: ReconcileWriteInput['engine']): ReconcileWriteInput => ({ ...input(engine),
    provenance: binding('home'), provenanceMode: 'project-subpage-v1', synthesizedPages: capturedPages });
  const receipt = (id: string, nodeId: string, version: number, key: string) => ({
    derivation_id: id, output_revision_id: `output-${id}`, output_node_id: nodeId, committed_node_version: version,
    committed_at: curatedAt, operation_id: 'operation-1', reconcile_key: key, request_digest: 'request-digest',
  });

  it('binds each page capture and resolves the created node from its receipt', async () => {
    const calls: WikiReconcileInput[] = [];
    const engine = { async wikiReconcile(value: WikiReconcileInput) {
      calls.push(value);
      const data = { ...result(value.dry_run === true), reconcile_key: value.reconcile_key };
      if (value.dry_run) return { data, warnings: [] as [] };
      const receipts = [receipt('home', 'home', 10, value.reconcile_key), receipt('page-0', 'refresh', 4, value.reconcile_key),
        receipt('page-1', 'reactivate', 5, value.reconcile_key), receipt('page-2', 'created-new', 1, value.reconcile_key),
        receipt('page-3', 'target', 6, value.reconcile_key)];
      return { data: { ...data, provenance_receipt: receipts[0], provenance_receipts: receipts }, warnings: [] as [] };
    } };
    const translated = await executeReconciliation(captured(engine));
    expect(calls[1]?.provenance_mode).toBe('project-subpage-v1');
    expect(calls[1]?.pages.flatMap(page => 'provenance' in page && page.provenance ? [page.provenance.derivation_id] : []))
      .toEqual(['page-0', 'page-1', 'page-2', 'page-3']);
    expect(translated.data.provenance_receipts).toHaveLength(5);
    const created = translated.topology.find(item => item.action === 'created');
    expect(created && 'node_id' in created ? created.node_id : undefined).toBe('created-new');
  });

  it('rejects a commit reply mislabeled as a dry run before accepting absent receipts', async () => {
    let calls = 0;
    const engine = { async wikiReconcile(value: WikiReconcileInput) {
      calls += 1;
      return { data: { ...result(true), reconcile_key: value.reconcile_key }, warnings: [] as [] };
    } };
    await expect(executeReconciliation(captured(engine))).rejects.toBeInstanceOf(ReconcileInvariantError);
    expect(calls).toBe(2);
  });

  it('rejects mixed request digests across an otherwise complete batch', async () => {
    const engine = { async wikiReconcile(value: WikiReconcileInput) {
      const data = { ...result(value.dry_run === true), reconcile_key: value.reconcile_key };
      if (value.dry_run) return { data, warnings: [] as [] };
      const receipts = [receipt('home', 'home', 10, value.reconcile_key), receipt('page-0', 'refresh', 4, value.reconcile_key),
        { ...receipt('page-1', 'reactivate', 5, value.reconcile_key), request_digest: 'different-request' },
        receipt('page-2', 'created-new', 1, value.reconcile_key), receipt('page-3', 'target', 6, value.reconcile_key)];
      return { data: { ...data, provenance_receipt: receipts[0], provenance_receipts: receipts }, warnings: [] as [] };
    } };
    await expect(executeReconciliation(captured(engine))).rejects.toBeInstanceOf(ReconcileInvariantError);
  });

  it('rejects an incomplete receipt set after commit', async () => {
    const engine = { async wikiReconcile(value: WikiReconcileInput) {
      const data = { ...result(value.dry_run === true), reconcile_key: value.reconcile_key };
      if (value.dry_run) return { data, warnings: [] as [] };
      const home = receipt('home', 'home', 10, value.reconcile_key);
      return { data: { ...data, provenance_receipt: home, provenance_receipts: [home] }, warnings: [] as [] };
    } };
    await expect(executeReconciliation(captured(engine))).rejects.toBeInstanceOf(ReconcileInvariantError);
  });
});

describe('captured batch prepublication guard', () => {
  it('refuses a writing page without a staged capture before Engine publication', async () => {
    let calls = 0;
    const engine = { async wikiReconcile(_value: WikiReconcileInput) { calls += 1; return { data: result(false), warnings: [] as [] }; } };
    await expect(executeReconciliation({ ...input(engine), provenance: { derivation_id: 'home', bundle_digest: 'bundle', contribution_digest: 'contribution' },
      provenanceMode: 'project-subpage-v1' })).rejects.toBeInstanceOf(ReconcileInvariantError);
    expect(calls).toBe(0);
  });
});
