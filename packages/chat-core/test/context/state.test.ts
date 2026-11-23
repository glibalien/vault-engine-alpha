import { describe, expect, it } from 'vitest';
import { coerceContext, pickEffectiveBoard } from '../../src/context/state.js';

describe('coerceContext', () => {
  it('defaults doc + board on, nodes empty', () => {
    expect(coerceContext(undefined)).toEqual({ doc: true, board: true, nodes: [] });
  });
  it('respects explicit false + filters non-string nodes', () => {
    expect(coerceContext({ doc: false, board: true, nodes: ['a', 1, 'b'] }))
      .toEqual({ doc: false, board: true, nodes: ['a', 'b'] });
  });
  it('preserves activeBoardId null + string; ignores other types', () => {
    expect(coerceContext({ activeBoardId: null }).activeBoardId).toBeNull();
    expect(coerceContext({ activeBoardId: 'b1' }).activeBoardId).toBe('b1');
    expect('activeBoardId' in coerceContext({})).toBe(false);
    expect('activeBoardId' in coerceContext({ activeBoardId: 5 as unknown as string })).toBe(false);
  });
  it('round-trips modelRef; drops empty/whitespace/non-string; absent stays absent', () => {
    expect(coerceContext({ modelRef: 'Qwen 3.7 Plus' }).modelRef).toBe('Qwen 3.7 Plus');
    expect('modelRef' in coerceContext({})).toBe(false);
    expect('modelRef' in coerceContext({ modelRef: '' })).toBe(false);
    expect('modelRef' in coerceContext({ modelRef: '   ' })).toBe(false);
    expect('modelRef' in coerceContext({ modelRef: 5 as unknown as string })).toBe(false);
  });
});

describe('pickEffectiveBoard', () => {
  const base = { doc: true, board: true, nodes: [] };
  it('defaults to the most-recent board when there is no choice', () => {
    expect(pickEffectiveBoard({ ...base }, ['b1', 'b2'])).toBe('b1');
  });
  it('returns undefined for explicit "No board" (null)', () => {
    expect(pickEffectiveBoard({ ...base, activeBoardId: null }, ['b1'])).toBeUndefined();
  });
  it('returns the chosen board when it is still one of the doc boards', () => {
    expect(pickEffectiveBoard({ ...base, activeBoardId: 'b2' }, ['b1', 'b2'])).toBe('b2');
  });
  it('falls back to the default when the chosen id is stale', () => {
    expect(pickEffectiveBoard({ ...base, activeBoardId: 'gone' }, ['b1'])).toBe('b1');
  });
  it('honors legacy board:false as off', () => {
    expect(pickEffectiveBoard({ ...base, board: false }, ['b1'])).toBeUndefined();
  });
  it('returns undefined when the doc has no boards', () => {
    expect(pickEffectiveBoard({ ...base }, [])).toBeUndefined();
  });
});
