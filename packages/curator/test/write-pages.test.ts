import { describe, expect, it } from 'vitest';
import { shouldSkipReconciliation, topologyToThemed } from '../src/write-pages.js';
import type { ExistingWiki, TopologyResult } from '../src/types.js';

const scope = { v: 1 as const, subject: 'Demo', facet: 'architecture' };

function catalog(over: Partial<ExistingWiki> = {}): ExistingWiki {
  return {
    home_id: 'home',
    home: {
      id: 'home',
      version: 3,
      wiki_evidence_hash: 'evidence',
      wiki_topology_hash: 'topology',
      wiki_curated_at: '2026-08-14T00:00:00.000Z',
    },
    topology_hash: 'topology',
    catalog_valid: true,
    subpages: [{
      id: 'page', title: 'Demo — Architecture', file_path: 'Wikis/Demo/Architecture.md',
      version: 2, content_hash: 'body', wiki_state: 'active', wiki_origin: 'automatic',
      wiki_scope: scope, wiki_pinned: false,
    }],
    ...over,
  };
}

describe('shouldSkipReconciliation', () => {
  it('skips only when evidence, topology, catalog health, refresh state, and force all permit it', () => {
    expect(shouldSkipReconciliation({
      existingWiki: catalog(), evidenceHash: 'evidence', force: false, refreshDue: false,
    })).toBe(true);
  });

  it('runs when external topology changed although evidence is unchanged', () => {
    expect(shouldSkipReconciliation({
      existingWiki: catalog({ topology_hash: 'externally-edited' }),
      evidenceHash: 'evidence', force: false, refreshDue: false,
    })).toBe(false);
  });

  it('runs for first homes, missing scopes, broken replacements, refreshes, and force', () => {
    const page = catalog().subpages[0];
    if (page === undefined) throw new TypeError('fixture page missing');
    expect(shouldSkipReconciliation({
      existingWiki: catalog({ home_id: null, home: null }), evidenceHash: 'evidence', force: false, refreshDue: false,
    })).toBe(false);
    expect(shouldSkipReconciliation({
      existingWiki: catalog({ subpages: [{ ...page, wiki_scope: undefined }] }), evidenceHash: 'evidence', force: false, refreshDue: false,
    })).toBe(false);
    expect(shouldSkipReconciliation({
      existingWiki: catalog({ subpages: [{ ...page, wiki_replaced_by: { title: 'Missing' } }] }), evidenceHash: 'evidence', force: false, refreshDue: false,
    })).toBe(false);
    const cyclePeer = { ...page, id: 'peer', title: 'Demo — Peer', wiki_replaced_by: { id: 'page', title: page.title } };
    expect(shouldSkipReconciliation({
      existingWiki: catalog({ subpages: [{ ...page, wiki_replaced_by: { id: 'peer', title: cyclePeer.title } }, cyclePeer] }),
      evidenceHash: 'evidence', force: false, refreshDue: false,
    })).toBe(false);
    expect(shouldSkipReconciliation({
      existingWiki: catalog(), evidenceHash: 'evidence', force: false, refreshDue: true,
    })).toBe(false);
    expect(shouldSkipReconciliation({
      existingWiki: catalog(), evidenceHash: 'evidence', force: true, refreshDue: false,
    })).toBe(false);
  });
});

describe('topologyToThemed', () => {
  it('keeps the legacy themed projection derived from topology', () => {
    const topology: readonly TopologyResult[] = [
      { action: 'created', node_id: 'new', title: 'Demo — New', scope, kind: 'workstream' },
      { action: 'refreshed', node_id: 'page', title: 'Demo — Architecture', scope, kind: 'freeform' },
      { action: 'retired', node_id: 'old', title: 'Demo — Old', scope, kind: 'freeform' },
      { action: 'ambiguous-create-skipped', plan_key: 'maybe', title: 'Demo — Maybe', scope, reason: 'ambiguous' },
    ];

    expect(topologyToThemed(topology)).toEqual([
      { kind: 'workstream', title: 'Demo — New', action: 'created', state: 'active' },
      { kind: 'freeform', title: 'Demo — Architecture', action: 'updated', state: 'active' },
      { kind: 'freeform', title: 'Demo — Old', action: 'retired', state: 'retired' },
      { kind: 'freeform', title: 'Demo — Maybe', action: 'skipped', detail: 'ambiguous' },
    ]);
  });
});
