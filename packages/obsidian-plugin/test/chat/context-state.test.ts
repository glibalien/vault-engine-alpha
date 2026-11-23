import { describe, expect, it } from 'vitest';
import { hydrateBoardChoice, hydrateDocChip, hydrateModelRef, hydrateNodeChips, patchActiveBoard, patchDocChip, patchModelRef, patchNodeChips } from '../../src/chat/context-state.js';

describe('patchActiveBoard', () => {
  it('sets ONLY activeBoardId, preserving doc/board/nodes from the other surface', () => {
    expect(patchActiveBoard({ doc: false, board: true, nodes: ['x'] }, null))
      .toEqual({ doc: false, board: true, nodes: ['x'], activeBoardId: null });
  });
  it('applies defaults when no prior state and records the chosen board', () => {
    expect(patchActiveBoard(undefined, 'b1').activeBoardId).toBe('b1');
  });
});

describe('hydrateBoardChoice', () => {
  it('maps legacy "board off" (board:false, no explicit choice) to explicit off (null)', () => {
    // The plugin resolves with a hardcoded board:true, so the resolver's legacy-off branch is
    // unreachable from a raw board flag; translate it to an explicit "No board" choice here.
    expect(hydrateBoardChoice({ board: false })).toBeNull();
  });
  it('defaults (undefined) when board is on and there is no explicit choice', () => {
    expect(hydrateBoardChoice({ board: true })).toBeUndefined();
    expect(hydrateBoardChoice(undefined)).toBeUndefined();
    expect(hydrateBoardChoice({})).toBeUndefined();
  });
  it('passes an explicit choice through, even over a legacy board flag', () => {
    expect(hydrateBoardChoice({ activeBoardId: 'b1' })).toBe('b1');
    expect(hydrateBoardChoice({ activeBoardId: null })).toBeNull();
    expect(hydrateBoardChoice({ board: false, activeBoardId: 'b2' })).toBe('b2');
  });
});

describe('patchDocChip', () => {
  it('sets ONLY doc, preserving board/nodes/activeBoardId from the other surface', () => {
    expect(patchDocChip({ doc: true, board: false, nodes: ['x'], activeBoardId: 'b1' }, false))
      .toEqual({ doc: false, board: false, nodes: ['x'], activeBoardId: 'b1' });
  });
  it('applies defaults when no prior state', () => {
    expect(patchDocChip(undefined, false)).toEqual({ doc: false, board: true, nodes: [] });
  });
});

describe('hydrateDocChip', () => {
  it('defaults ON for absent/empty/garbage state', () => {
    expect(hydrateDocChip(undefined)).toBe(true);
    expect(hydrateDocChip({})).toBe(true);
    expect(hydrateDocChip('garbage')).toBe(true);
  });
  it('honors an explicit false from either surface', () => {
    expect(hydrateDocChip({ doc: false })).toBe(false);
  });
});

describe('patchNodeChips', () => {
  it('sets only nodes, preserving other slices', () => {
    const prior = { doc: false, board: true, nodes: ['a'], activeBoardId: 'b1' };
    expect(patchNodeChips(prior, ['a', 'b'])).toEqual({ doc: false, board: true, nodes: ['a', 'b'], activeBoardId: 'b1' });
  });
});

describe('hydrateNodeChips', () => {
  it('reads persisted ids and defaults to []', () => {
    expect(hydrateNodeChips({ nodes: ['x'] })).toEqual(['x']);
    expect(hydrateNodeChips(undefined)).toEqual([]);
  });
});

describe('patchModelRef', () => {
  it('sets ONLY modelRef, preserving doc/board/nodes/activeBoardId from the other surface', () => {
    expect(patchModelRef({ doc: false, board: true, nodes: ['x'], activeBoardId: 'b1' }, 'Claude Sonnet 4.6'))
      .toEqual({ doc: false, board: true, nodes: ['x'], activeBoardId: 'b1', modelRef: 'Claude Sonnet 4.6' });
  });
  it('null deletes the key (back to the surface default), preserving other slices', () => {
    expect(patchModelRef({ doc: false, board: true, nodes: ['x'], modelRef: 'Old Model' }, null))
      .toEqual({ doc: false, board: true, nodes: ['x'] });
  });
  it('applies defaults when no prior state', () => {
    expect(patchModelRef(undefined, 'Qwen 3.7 Plus')).toEqual({ doc: true, board: true, nodes: [], modelRef: 'Qwen 3.7 Plus' });
  });
});

describe('hydrateModelRef', () => {
  it('reads the persisted per-conversation override', () => {
    expect(hydrateModelRef({ modelRef: 'Claude Sonnet 4.6' })).toBe('Claude Sonnet 4.6');
  });
  it('defaults to undefined (surface default applies) for absent/empty/garbage state', () => {
    expect(hydrateModelRef(undefined)).toBeUndefined();
    expect(hydrateModelRef({})).toBeUndefined();
    expect(hydrateModelRef('garbage')).toBeUndefined();
  });
  it('round-trips through patchModelRef: set then null-clear', () => {
    const set = patchModelRef(undefined, 'Claude Sonnet 4.6');
    expect(hydrateModelRef(set)).toBe('Claude Sonnet 4.6');
    const cleared = patchModelRef(set, null);
    expect(hydrateModelRef(cleared)).toBeUndefined();
  });
});
