import { describe, expect, it } from 'vitest';
import type { WikiCatalogHome, WikiCatalogPage } from '../../src/wiki/digest.js';
import { computeWikiTopologyHash } from '../../src/wiki/topology.js';

function page(overrides: Partial<WikiCatalogPage> = {}): WikiCatalogPage {
  return {
    id: 'page-1',
    title: 'Project — Alpha',
    file_path: 'Wikis/Project — Alpha.md',
    version: 2,
    content_hash: 'content-1',
    wiki_state: 'active',
    wiki_kind: 'workstream',
    wiki_origin: 'automatic',
    wiki_scope: { v: 1, subject: 'Project', facet: 'Alpha' },
    wiki_replaced_by: { id: 'page-2', title: 'Project — Beta' },
    wiki_pinned: false,
    summary: 'Compact prose excluded from topology.',
    ...overrides,
  };
}

const INCLUDED_MUTATIONS: ReadonlyArray<readonly [string, (value: WikiCatalogPage) => WikiCatalogPage]> = [
  ['id', value => ({ ...value, id: 'page-changed' })],
  ['title', value => ({ ...value, title: 'Changed title' })],
  ['version', value => ({ ...value, version: 3 })],
  ['content hash', value => ({ ...value, content_hash: 'content-changed' })],
  ['scope', value => ({ ...value, wiki_scope: { v: 1, subject: 'Project', facet: 'Changed' } })],
  ['kind', value => ({ ...value, wiki_kind: 'timeline' })],
  ['state', value => ({ ...value, wiki_state: 'dormant' })],
  ['origin', value => ({ ...value, wiki_origin: 'requested' })],
  ['pin', value => ({ ...value, wiki_pinned: true })],
  ['replacement id', value => ({ ...value, wiki_replaced_by: { id: 'page-3', title: 'Project — Beta' } })],
  ['replacement title', value => ({ ...value, wiki_replaced_by: { id: 'page-2', title: 'Changed replacement' } })],
];

describe('computeWikiTopologyHash', () => {
  it('is stable under input row order', () => {
    const alpha = page();
    const beta = page({ id: 'page-2', title: 'Project — Beta', wiki_replaced_by: undefined });

    expect(computeWikiTopologyHash([alpha, beta])).toBe(computeWikiTopologyHash([beta, alpha]));
  });

  it.each(INCLUDED_MUTATIONS)('changes when included %s changes', (_name, mutate) => {
    const baseline = page();

    expect(computeWikiTopologyHash([mutate(baseline)])).not.toBe(computeWikiTopologyHash([baseline]));
  });

  it('changes for invalid-scope raw bytes and bounded error code without throwing', () => {
    const invalid = page({
      wiki_scope: undefined,
      wiki_scope_raw: '{"v":2}',
      wiki_scope_error: 'UNSUPPORTED_VERSION',
    });
    const changedRaw = { ...invalid, wiki_scope_raw: '{"v":3}' };
    const changedCode = { ...invalid, wiki_scope_error: 'MALFORMED_JSON' } satisfies WikiCatalogPage;

    expect(() => computeWikiTopologyHash([invalid])).not.toThrow();
    expect(computeWikiTopologyHash([changedRaw])).not.toBe(computeWikiTopologyHash([invalid]));
    expect(computeWikiTopologyHash([changedCode])).not.toBe(computeWikiTopologyHash([invalid]));
  });

  it('excludes file path, Summary prose, and every home stamp', () => {
    const baseline = page();
    const proseOnly = page({ file_path: 'Moved.md', summary: 'Rewritten summary.' });
    const firstHome: WikiCatalogHome = { id: 'home', version: 1, wiki_evidence_hash: 'e1' };
    const secondHome: WikiCatalogHome = {
      id: 'home',
      version: 99,
      wiki_evidence_hash: 'e2',
      wiki_topology_hash: 'self-reference',
      wiki_curated_at: '2026-08-13T00:00:00.000Z',
      wiki_reconcile_key: 'run-2',
    };

    expect(firstHome).not.toEqual(secondHome);
    expect(computeWikiTopologyHash([proseOnly])).toBe(computeWikiTopologyHash([baseline]));
  });
});
