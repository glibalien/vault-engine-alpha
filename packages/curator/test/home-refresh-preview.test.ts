import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import type { CoreDeps } from '../src/core.js';
import { previewHomeRefresh } from '../src/home-refresh-preview.js';
import { CurationQueue } from '../src/queue.js';
import { setPaused, addCorrection } from '../src/db/control.js';

const dbs: Database.Database[] = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));
function fixture() {
  const db = new Database(':memory:'); dbs.push(db); runMigrations(db);
  const target = { select: 'refresh_target', eligible: true, reasons: [], vault_namespace: 'vault',
    output_revision_id: 'output', latest_output_revision_id: 'output', project_id: 'project',
    project_title: 'Project', home_node_id: 'home', home_title: 'Renamed home', home_path: 'Home.md',
    home_version: 2, topology_hash: 'topology', currentness: 'matches', availability: 'retained' };
  const call = vi.fn();
  const deps = { db, queue: new CurationQueue(),
    config: { projectHomeProvenanceEnabled: true, model: 'model', modelProviders: { model: 'anthropic' }, homeMaxTokens: 4000, wikiHomeMaxTokens: 0, wikiHomeReasoningEffort: 'inherit' },
    llm: { configurationFor: () => ({ provider: 'anthropic', reasoningEffort: null }), withConfiguration() { return this; }, structuredCall: call, supportsPreparedCapture: true, previewStructuredCall: vi.fn(async () => ({ provider: 'anthropic', model: 'model', adapter_version: 'v1', payload: {} })) },
    engine: { inspectProvenance: vi.fn(async (req) => req.select === 'status' ? { select: 'status', capability_version: 1, inspection_features: ['selective_home_refresh_v1'], limits: {} } : target) },
  } as unknown as CoreDeps;
  return { db, deps, target, call };
}
it('previews free, reflects the exact home and never admits or executes a job', async () => {
  const { db, deps, call } = fixture();
  const p = await previewHomeRefresh(deps, 'output');
  expect(p).toMatchObject({ eligible: true, home_title: 'Renamed home', model: { ref: 'model', provider: 'anthropic' } });
  expect(call).not.toHaveBeenCalled();
  expect(deps.queue.state.depth).toBe(0);
  expect(db.prepare('SELECT COUNT(*) n FROM home_refresh_requests').get()).toEqual({ n: 0 });
});
function pageFixture() {
  const f = fixture();
  Object.assign(f.target, { target_kind: 'page', page_node_id: 'page', page_title: 'Project — Decisions', page_path: 'Wikis/Decisions.md', page_version: 3 });
  vi.mocked(f.deps.engine.inspectProvenance).mockImplementation(async (req: any) => req.select === 'status'
    ? { select: 'status', capability_version: 1, inspection_features: ['selective_home_refresh_v1', 'selective_page_refresh_v1'], limits: {} } as any : f.target as any);
  Object.assign(f.deps.config, { wikiPageModel: 'page-model', wikiPageMaxTokens: 2000, wikiPageReasoningEffort: 'inherit', modelProviders: { model: 'anthropic', 'page-model': 'anthropic' } });
  return f;
}
it('previews a sub-page as itself, on the page stage\'s model, for free', async () => {
  const { db, deps, call } = pageFixture();
  const p = await previewHomeRefresh(deps, 'output');
  expect(p).toMatchObject({ eligible: true, reasons: [], target_kind: 'page', page_title: 'Project — Decisions', page_path: 'Wikis/Decisions.md',
    home_title: 'Renamed home', sections: ['Summary', 'Log'], model: { ref: 'page-model', provider: 'anthropic', max_output_tokens: 2000 } });
  expect(p.guard).toMatchObject({ page_node_id: 'page', page_version: 3, home_node_id: 'home', output_revision_id: 'output' });
  expect(call).not.toHaveBeenCalled();
  expect(db.prepare('SELECT COUNT(*) n FROM home_refresh_requests').get()).toEqual({ n: 0 });
});
it('a home still previews as a home, with no page fields in its guard', async () => {
  const p = await previewHomeRefresh(fixture().deps, 'output');
  expect(p).toMatchObject({ eligible: true, target_kind: 'home', page_title: null, page_path: null });
  expect(p.guard).not.toHaveProperty('page_node_id');
});
it('binds the page\'s model, prompt and version into its guard', async () => {
  const { deps, target } = pageFixture();
  const before = (await previewHomeRefresh(deps, 'output')).guard!;
  expect((await previewHomeRefresh(deps, 'output')).guard).toEqual(before);
  deps.config.curatorPagePrompt = 'Another page prompt';
  expect((await previewHomeRefresh(deps, 'output')).guard!.configuration_digest).not.toBe(before.configuration_digest);
  deps.config.curatorPagePrompt = '';
  Object.assign(target, { page_version: 4 });
  expect((await previewHomeRefresh(deps, 'output')).guard!.page_version).toBe(4);
});
it('blocks a sub-page on an Engine that can\'t publish one, on no page model and when it isn\'t active', async () => {
  const f = pageFixture();
  vi.mocked(f.deps.engine.inspectProvenance).mockImplementation(async (req: any) => req.select === 'status'
    ? { select: 'status', capability_version: 1, inspection_features: ['selective_home_refresh_v1'], limits: {} } as any : f.target as any);
  expect((await previewHomeRefresh(f.deps, 'output')).reasons.map(r => r.code)).toEqual(['UPGRADE_REQUIRED']);
  const g = pageFixture();
  g.deps.config.modelProviders = { model: 'anthropic' };
  const noModel = await previewHomeRefresh(g.deps, 'output');
  expect(noModel).toMatchObject({ eligible: false, guard: null });
  expect(noModel.reasons.map(r => r.code)).toEqual(['MODEL_UNAVAILABLE']);
  const h = pageFixture();
  Object.assign(h.target, { eligible: false, reasons: ['PAGE_NOT_ACTIVE'] });
  expect((await previewHomeRefresh(h.deps, 'output')).reasons[0]).toMatchObject({ code: 'PAGE_NOT_ACTIVE', message: expect.stringMatching(/dormant or retired/) });
});
it('lets an explicit rebuild run on a paused wiki (#372)', async () => {
  const { db, deps } = fixture();
  setPaused(db, 'Project', true, null, new Date().toISOString());
  const p = await previewHomeRefresh(deps, 'output');
  expect(p).toMatchObject({ eligible: true, reasons: [] });
  expect(p.guard).not.toBeNull();
});
it('fails closed for missing capability, missing provider and stale settings', async () => {
  const { deps } = fixture();
  deps.config.modelProviders = {};
  expect((await previewHomeRefresh(deps, 'output')).eligible).toBe(false);
  deps.config.modelProviders = { model: 'anthropic' };
  deps.refreshDeps = async () => { throw new Error('private settings failure'); };
  const p = await previewHomeRefresh(deps, 'output');
  expect(p.eligible).toBe(false);
  expect(JSON.stringify(p)).not.toContain('private');
});
it('binds correction content and configuration but not observation time', async () => {
  const { db, deps } = fixture();
  const before = await previewHomeRefresh(deps, 'output');
  expect((await previewHomeRefresh(deps, 'output')).guard).toEqual(before.guard);
  addCorrection(db, { project_title: 'Project', note: 'New guidance', created_by: null, created_at: new Date().toISOString() });
  expect((await previewHomeRefresh(deps, 'output')).guard?.corrections_digest).not.toBe(before.guard?.corrections_digest);
  deps.config.homeMaxTokens++;
  expect((await previewHomeRefresh(deps, 'output')).guard?.configuration_digest).not.toBe(before.guard?.configuration_digest);
});

it('uses the home stage cap and invalidates the preview guard when it changes', async () => {
  const { deps, call } = fixture();
  Object.assign(deps.config, { wikiHomeMaxTokens: 16000, wikiHomeReasoningEffort: 'inherit', wikiPlanningMaxTokens: -1 });
  Object.assign(deps.llm, { configurationFor: () => ({ provider: 'anthropic', reasoningEffort: null }), withConfiguration: () => deps.llm });
  const first = await previewHomeRefresh(deps, 'output');
  expect(first.eligible).toBe(true);
  expect(first.model?.max_output_tokens).toBe(16000);
  deps.config.wikiHomeMaxTokens = 12000;
  expect((await previewHomeRefresh(deps, 'output')).guard?.configuration_digest).not.toBe(first.guard?.configuration_digest);
  expect(call).not.toHaveBeenCalled();
});
