import { describe, expect, it } from 'vitest';
import { enforcePageLimits, PAGE_TEMPLATES, pageKindDescriptions, pageLimitsPayload } from '../src/page-templates.js';
import type { ExistingWiki, ThemedPageKind, TopologyPlan } from '../src/types.js';

const scope = (facet: string) => ({ v: 1 as const, subject: 'P', facet });
const page = (id: string, kind: ThemedPageKind, state: 'active' | 'dormant' | 'retired' = 'active') => ({
  id, title: `P — ${id}`, file_path: `${id}.md`, version: 1, content_hash: 'h', wiki_state: state, wiki_kind: kind,
  wiki_origin: 'automatic' as const, wiki_pinned: false, wiki_scope: scope(id),
});
const wiki = (subpages: ReturnType<typeof page>[]): ExistingWiki =>
  ({ home_id: 'home', home: { id: 'home', version: 1 }, topology_hash: 't', catalog_valid: true, subpages });
const create = (key: string, kind: ThemedPageKind) =>
  ({ op: 'create' as const, plan_key: key, title: `P — ${key}`, kind, scope: scope(key), synthesis_brief: 'b' });
const limits = (maxActivePages: number, maxActivePerKind: number, maxCreatesPerRun: number) =>
  ({ maxActivePages, maxActivePerKind, maxCreatesPerRun });

describe('page templates', () => {
  it('covers every page kind', () => {
    const kinds: ThemedPageKind[] = ['workstream', 'decision-log', 'risk-register', 'timeline', 'stakeholder-map', 'spotlight', 'freeform'];
    expect(Object.keys(PAGE_TEMPLATES).sort()).toEqual([...kinds].sort());
    expect(Object.keys(pageKindDescriptions()).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) expect(PAGE_TEMPLATES[kind].guidance.length).toBeGreaterThan(0);
  });
});

describe('enforcePageLimits', () => {
  it('counts active pages only and keeps creates in plan order while they fit', () => {
    const existing = wiki([page('a', 'workstream'), page('b', 'timeline'), page('old', 'workstream', 'retired')]);
    const plan: TopologyPlan = { reviewed_page_ids: ['a', 'b', 'old'], actions: [
      { op: 'keep', node_id: 'a', scope: scope('a') },
      create('w2', 'workstream'), create('w3', 'workstream'), create('t2', 'timeline'), create('s1', 'spotlight'),
    ] };
    const { plan: limited, dropped } = enforcePageLimits(plan, existing, limits(4, 2, 5));
    expect(limited.actions.map(action => action.op === 'create' ? action.plan_key : action.op)).toEqual(['keep', 'w2', 't2']);
    expect(dropped).toEqual([
      { title: 'P — w3', kind: 'workstream', reason: 'active-per-kind' },
      { title: 'P — s1', kind: 'spotlight', reason: 'active-pages' },
    ]);
    expect(limited.reviewed_page_ids).toEqual(plan.reviewed_page_ids);
  });

  it('caps creates per run and never drops a merge target', () => {
    const plan: TopologyPlan = { reviewed_page_ids: ['a'], actions: [
      create('x', 'workstream'), create('target', 'freeform'),
      { op: 'merge', target: { plan_key: 'target' }, sources: ['a'], scope: scope('target'), reason: 'r', synthesis_brief: 'b' },
      create('y', 'timeline'),
    ] };
    const { plan: limited, dropped } = enforcePageLimits(plan, wiki([page('a', 'freeform')]), limits(10, 10, 1));
    expect(limited.actions.map(action => action.op === 'create' ? action.plan_key : action.op)).toEqual(['x', 'target', 'merge']);
    expect(dropped).toEqual([{ title: 'P — y', kind: 'timeline', reason: 'creates-per-run' }]);
  });

  it('keeps creates matching an existing page\'s scope without counting them', () => {
    const existing = wiki([page('a', 'workstream'), page('old', 'timeline', 'retired')]);
    const plan: TopologyPlan = { reviewed_page_ids: ['a', 'old'], actions: [
      create('a', 'workstream'), create('old', 'timeline'), create('fresh', 'spotlight'),
    ] };
    const { plan: limited, dropped } = enforcePageLimits(plan, existing, limits(1, 1, 1));
    expect(limited.actions.map(action => action.op === 'create' ? action.plan_key : action.op)).toEqual(['a', 'old']);
    expect(dropped).toEqual([{ title: 'P — fresh', kind: 'spotlight', reason: 'active-pages' }]);
  });

  it('frees the capacity of pages the same plan retires or merges away', () => {
    const existing = wiki([page('a', 'workstream'), page('b', 'workstream'), page('c', 'timeline')]);
    const plan: TopologyPlan = { reviewed_page_ids: ['a', 'b', 'c'], actions: [
      { op: 'retire', node_id: 'a', scope: scope('a'), state: 'retired', reason: 'done' },
      { op: 'merge', target: { node_id: 'c' }, sources: ['b'], scope: scope('c'), reason: 'overlap', synthesis_brief: 'b' },
      create('w', 'workstream'), create('w2', 'workstream'), create('s', 'spotlight'),
    ] };
    const { plan: limited, dropped } = enforcePageLimits(plan, existing, limits(3, 1, 5));
    expect(limited.actions.filter(action => action.op === 'create').map(action => action.plan_key)).toEqual(['w', 's']);
    expect(dropped).toEqual([{ title: 'P — w2', kind: 'workstream', reason: 'active-per-kind' }]);
  });

  it('charges pages the plan brings back before admitting new ones', () => {
    const existing = wiki([page('a', 'workstream'), page('b', 'workstream', 'dormant'), page('c', 'timeline', 'retired')]);
    const reactivating: TopologyPlan = { reviewed_page_ids: ['a', 'b', 'c'], actions: [
      { op: 'reactivate', node_id: 'b', scope: scope('b'), synthesis_brief: 'b' }, create('w', 'workstream'),
    ] };
    expect(enforcePageLimits(reactivating, existing, limits(2, 2, 5)).dropped)
      .toEqual([{ title: 'P — w', kind: 'workstream', reason: 'active-pages' }]);
    const viaCreate: TopologyPlan = { reviewed_page_ids: ['a', 'b', 'c'], actions: [create('c', 'timeline'), create('w', 'workstream')] };
    const { plan: limited, dropped } = enforcePageLimits(viaCreate, existing, limits(2, 2, 5));
    expect(limited.actions.map(action => action.op === 'create' ? action.plan_key : action.op)).toEqual(['c']);
    expect(dropped).toEqual([{ title: 'P — w', kind: 'workstream', reason: 'active-pages' }]);
  });

  it('charges repeated creates of one scope once', () => {
    const twice = { ...create('a2', 'workstream'), scope: scope('a') };
    const plan: TopologyPlan = { reviewed_page_ids: [], actions: [create('a', 'workstream'), twice, create('b', 'workstream')] };
    const { plan: limited, dropped } = enforcePageLimits(plan, wiki([]), limits(6, 2, 3));
    expect(limited.actions.map(action => action.op === 'create' ? action.plan_key : action.op)).toEqual(['a', 'a2', 'b']);
    expect(dropped).toEqual([]);
  });

  it('does not free a retiring page that an exact-match create keeps', () => {
    const existing = wiki([page('a', 'workstream'), page('b', 'workstream')]);
    const plan: TopologyPlan = { reviewed_page_ids: ['a', 'b'], actions: [
      { op: 'retire', node_id: 'a', scope: scope('a'), state: 'retired', reason: 'stale' },
      { op: 'keep', node_id: 'b', scope: scope('b') },
      { ...create('again', 'workstream'), scope: scope('a') }, create('c', 'workstream'),
    ] };
    expect(enforcePageLimits(plan, existing, limits(2, 2, 5)).dropped)
      .toEqual([{ title: 'P — c', kind: 'workstream', reason: 'active-pages' }]);
  });

  it('drops every create of a scope together, so folding cannot revive a dropped page', () => {
    const twice = { ...create('n2', 'workstream'), scope: scope('n') };
    const plan: TopologyPlan = { reviewed_page_ids: ['a'], actions: [create('n', 'workstream'), twice] };
    const { plan: limited, dropped } = enforcePageLimits(plan, wiki([page('a', 'workstream')]), limits(1, 1, 3));
    expect(limited.actions).toEqual([]);
    expect(dropped).toEqual([{ title: 'P — n', kind: 'workstream', reason: 'active-pages' }]);
  });

  it('describes limits and current active pages for the planner', () => {
    const existing = wiki([page('a', 'workstream'), page('b', 'workstream'), page('c', 'risk-register', 'dormant')]);
    expect(pageLimitsPayload(limits(6, 2, 3), existing)).toEqual({ max_active_pages: 6, max_active_per_kind: 2,
      max_creates_this_run: 3, active_pages_by_kind: { workstream: 2 } });
  });
});
