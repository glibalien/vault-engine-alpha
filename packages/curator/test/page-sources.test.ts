import { describe, expect, it } from 'vitest';
import { pageEvidenceIds, pageRuleIds, plannerSources, withHeldPages, writtenPageReads } from '../src/page-sources.js';
import type { EngineNode, ExistingWiki, TopologyPlan } from '../src/types.js';

const scope = (facet: string) => ({ v: 1 as const, subject: 'Atlas', facet });
const node = (id: string, mtime?: number): EngineNode => ({ id, title: id.toUpperCase(), types: ['note'], fields: {}, body: '',
  metadata: mtime === undefined ? null : { file_mtime: mtime } });

describe('page sources (#474 idea 3)', () => {
  it('offers the planner every read but the project note and the wiki\'s own pages', () => {
    const wiki: ExistingWiki = { home_id: 'home', home: null, topology_hash: 'th', catalog_valid: true, subpages: [
      { id: 'sub', title: 'Sub', file_path: 'Sub.md', version: 1, content_hash: 'x', wiki_state: 'active', wiki_kind: 'freeform',
        wiki_origin: 'automatic', wiki_scope: scope('Sub'), wiki_pinned: false }] };
    expect(plannerSources([node('root'), node('home'), node('sub'), node('n1', Date.UTC(2026, 10, 3, 12)), node('n2')], 'root', wiki, 'UTC'))
      .toEqual([{ id: 'n1', title: 'N1', types: ['note'], modified: '2026-11-03' }, { id: 'n2', title: 'N2', types: ['note'] }]);
  });

  it('keys each page\'s reads by its target, project note first, and joins a merge into a planned create', () => {
    const plan: TopologyPlan = { reviewed_page_ids: ['a', 'b'], actions: [
      { op: 'refresh', node_id: 'a', scope: scope('A'), synthesis_brief: 'A', evidence_ids: ['n1', 'n1'] },
      { op: 'refresh', node_id: 'b', scope: scope('B'), synthesis_brief: 'B', evidence_ids: [] },
      { op: 'create', plan_key: 'new', title: 'Atlas — New', kind: 'workstream', scope: scope('New'), synthesis_brief: 'N', evidence_ids: ['n2'] },
      { op: 'merge', target: { plan_key: 'new' }, sources: ['c'], scope: scope('New'), reason: 'r', synthesis_brief: 'N', evidence_ids: ['n3'] },
      { op: 'keep', node_id: 'd', scope: scope('D') },
    ] };
    const ids = pageEvidenceIds(plan, 'root');
    expect({ ...ids }).toEqual({ 'node:a': ['root', 'n1'], 'plan:new': ['root', 'n2', 'n3'] });
    expect(writtenPageReads({ node_id: 'a', title: 'A' }, plan, ids)).toEqual(['root', 'n1']);
    expect(writtenPageReads({ node_id: 'created-1', title: 'Atlas — New' }, plan, ids)).toEqual(['root', 'n2', 'n3']);
    expect(writtenPageReads({ node_id: 'b', title: 'B' }, plan, ids)).toBeUndefined();
  });

  it('takes any plan key the plan validator accepts, "constructor" and "__proto__" included', () => {
    const plan: TopologyPlan = { reviewed_page_ids: [], actions: ['constructor', '__proto__'].map(key =>
      ({ op: 'create' as const, plan_key: key, title: `Atlas — ${key}`, kind: 'workstream' as const, scope: scope(key), synthesis_brief: 'B', evidence_ids: ['n1'] })) };
    const ids = pageEvidenceIds(plan, 'root');
    expect(ids['plan:constructor']).toEqual(['root', 'n1']);
    expect(ids['plan:__proto__']).toEqual(['root', 'n1']);
    const rules = pageRuleIds({ reviewed_page_ids: [], actions: plan.actions.map(action => ({ ...action, rule_ids: [7] })) });
    expect(rules['plan:constructor']).toEqual([7]);
    expect(rules['plan:__proto__']).toEqual([7]);
    expect(writtenPageReads({ node_id: 'created', title: 'Atlas — constructor' }, plan, ids)).toEqual(['root', 'n1']);
    expect(writtenPageReads({ node_id: 'toString', title: 'Unplanned' }, plan, pageEvidenceIds({ reviewed_page_ids: [], actions: [] }, 'root'))).toBeUndefined();
  });

  it('keeps a planned page apart from an existing page whose id matches its plan key', () => {
    const plan: TopologyPlan = { reviewed_page_ids: ['a'], actions: [
      { op: 'refresh', node_id: 'a', scope: scope('A'), synthesis_brief: 'A', evidence_ids: ['n1'] },
      { op: 'create', plan_key: 'a', title: 'Atlas — New', kind: 'workstream', scope: scope('New'), synthesis_brief: 'N', evidence_ids: ['n2'] },
    ] };
    const ids = pageEvidenceIds(plan, 'root');
    expect(writtenPageReads({ node_id: 'a', title: 'A' }, plan, ids)).toEqual(['root', 'n1']);
    expect(writtenPageReads({ node_id: 'created', title: 'Atlas — New' }, plan, ids)).toEqual(['root', 'n2']);
  });

  it('keeps each held page as it was and writes the rest (#474 idea 4)', () => {
    const wiki: ExistingWiki = { home_id: 'home', home: null, topology_hash: 't', catalog_valid: true, subpages: ['a', 'b', 'c', 'd'].map(id =>
      ({ id, title: id, file_path: `${id}.md`, version: 1, content_hash: 'h', wiki_state: 'active' as const, wiki_kind: 'freeform' as const,
        wiki_origin: 'automatic' as const, wiki_scope: scope(`own ${id}`), wiki_pinned: false })) };
    const plan: TopologyPlan = { reviewed_page_ids: ['a', 'b', 'c', 'd'], actions: [
      { op: 'refresh', node_id: 'a', scope: scope('new a'), synthesis_brief: 'A' },
      { op: 'refresh', node_id: 'b', scope: scope('new b'), synthesis_brief: 'B' },
      { op: 'create', plan_key: 'fresh', title: 'Atlas — Fresh', kind: 'workstream', scope: scope('fresh'), synthesis_brief: 'F' },
      { op: 'create', plan_key: 'joined', title: 'Atlas — Joined', kind: 'workstream', scope: scope('joined'), synthesis_brief: 'J' },
      { op: 'merge', target: { plan_key: 'joined' }, sources: ['c', 'd'], scope: scope('joined'), reason: 'r', synthesis_brief: 'J' },
    ] };
    const out = withHeldPages(plan, [{ target: { node_id: 'a' } }, { target: { plan_key: 'fresh' } }, { target: { plan_key: 'joined' } }], wiki);
    expect(out.reviewed_page_ids).toEqual(plan.reviewed_page_ids);
    expect(out.actions).toEqual([
      { op: 'keep', node_id: 'a', scope: scope('own a') },
      plan.actions[1],
      { op: 'keep', node_id: 'c', scope: scope('own c') },
      { op: 'keep', node_id: 'd', scope: scope('own d') },
    ]);
    expect(withHeldPages(plan, [], wiki)).toBe(plan);
  });

  it('gives a retired page that led into a held merge its own scope back, so it isn\'t reactivated', () => {
    const page = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, file_path: `${id}.md`, version: 1, content_hash: 'h',
      wiki_state: 'active' as const, wiki_kind: 'freeform' as const, wiki_origin: 'automatic' as const, wiki_scope: scope(`own ${id}`), wiki_pinned: false, ...extra });
    const wiki: ExistingWiki = { home_id: 'home', home: null, topology_hash: 't', catalog_valid: true, subpages: [
      page('old', { wiki_state: 'retired', wiki_replaced_by: { id: 'c', title: 'c' } }), page('c'), page('d'), page('other', { wiki_state: 'retired' })] };
    const plan: TopologyPlan = { reviewed_page_ids: ['old', 'c', 'd', 'other'], actions: [
      { op: 'keep', node_id: 'old', scope: scope('joined') },
      { op: 'keep', node_id: 'other', scope: scope('own other') },
      { op: 'create', plan_key: 'joined', title: 'Atlas — Joined', kind: 'workstream', scope: scope('joined'), synthesis_brief: 'J' },
      { op: 'merge', target: { plan_key: 'joined' }, sources: ['c', 'd'], scope: scope('joined'), reason: 'r', synthesis_brief: 'J' },
    ] };
    expect(withHeldPages(plan, [{ target: { plan_key: 'joined' } }], wiki).actions).toEqual([
      { op: 'keep', node_id: 'old', scope: scope('own old') },
      { op: 'keep', node_id: 'other', scope: scope('own other') },
      { op: 'keep', node_id: 'c', scope: scope('own c') },
      { op: 'keep', node_id: 'd', scope: scope('own d') },
    ]);
  });
});

