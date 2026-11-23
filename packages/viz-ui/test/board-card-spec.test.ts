import { describe, expect, it } from 'vitest';
import { parseBoardCardSpec } from '../src/board-card-spec.js';

const VIZ = { kind: 'table', title: 't', query: {}, display_fields: [] };

// Matches TABLE_PRESET's literal shape (packages/board-core/src/board-cards.ts) — viz-ui must
// NOT import board-core (board-core depends on viz-ui), so this is an inline fixture rather
// than the real preset import.
const TABLE_PRESET_SHAPED = { kind: 'table', title: '', query: { sort_by: 'file_mtime', sort_order: 'desc' }, display_fields: [] };

describe('parseBoardCardSpec', () => {
  it('accepts all four viz kinds via isVizSpec, normalizing legacy names', () => {
    expect(parseBoardCardSpec(VIZ)?.kind).toBe('table');
    expect(parseBoardCardSpec({ ...VIZ, kind: 'tasklist' })?.kind).toBe('list'); // legacy normalization preserved
  });
  it('accepts a viz-kind card with an empty title (board presets + persisted phase-1 cards)', () => {
    expect(parseBoardCardSpec(TABLE_PRESET_SHAPED)).toEqual(TABLE_PRESET_SHAPED);
  });
  it('accepts the non-query kinds with their required fields', () => {
    expect(parseBoardCardSpec({ kind: 'node', title: 'Charter', node_id: 'n1' })).toEqual({ kind: 'node', title: 'Charter', node_id: 'n1' });
    expect(parseBoardCardSpec({ kind: 'node', title: 'Charter', node_id: 'n1', expanded: true })?.kind).toBe('node');
    expect(parseBoardCardSpec({ kind: 'stats', title: '' })?.kind).toBe('stats'); // stats title may be empty-string
    expect(parseBoardCardSpec({ kind: 'spend', title: 'Usage and cost', range: '30d' })).toEqual({ kind: 'spend', title: 'Usage and cost', range: '30d' });
    // A card from the old free-text composer opens as this month's view (#281).
    expect(parseBoardCardSpec({ kind: 'spend', title: 'this month', args: { group_by: ['model'], since: '2026-07-01' } }))
      .toEqual({ kind: 'spend', title: 'this month', range: 'month' });
  });
  it('the retired Project health and Project evidence views parse as unknown kinds (#281)', () => {
    expect(parseBoardCardSpec({ kind: 'evidence', title: 'VE', project: 'Vault Engine', project_node_id: 'p1' })).toBeNull();
    expect(parseBoardCardSpec({ kind: 'project-health', version: 1, title: 'Health', project_scope: 'active', sort: 'title' })).toBeNull();
  });
  it('rejects junk: unknown kind, missing required fields, wrong shapes', () => {
    expect(parseBoardCardSpec(null)).toBeNull();
    expect(parseBoardCardSpec({ kind: 'pie', title: 'x' })).toBeNull();
    expect(parseBoardCardSpec({ kind: 'node', title: 'x' })).toBeNull();           // no node_id
    expect(parseBoardCardSpec({ kind: 'spend' })).toBeNull();                       // no title
  });
});
