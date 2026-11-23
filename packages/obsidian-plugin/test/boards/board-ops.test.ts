import { describe, it, expect } from 'vitest';
import type { BoardCard } from '@vault/board-core';
import type { BoardCardSpec, VizSpec } from '@vault/viz-ui';
import { applyResolvedOps, type ResolvedOp } from '../../src/boards/board-ops.js';
import { applyInverse } from '../../src/boards/history.js';

const viz = (title: string): VizSpec => ({ kind: 'table', title, query: {}, display_fields: [] });
const card = (id: string, spec: BoardCardSpec, order: number): BoardCard => ({ card_id: id, spec, layout: { order } });
const keepNext = (_prior: BoardCardSpec, next: VizSpec): BoardCardSpec => next;

describe('applyResolvedOps', () => {
  const cards = [card('a', viz('A'), 0), card('b', viz('B'), 1)];
  it('applies adds/replaces/removes in one pass with counts', () => {
    let n = 0;
    const ops: ResolvedOp[] = [
      { op: 'replace', card_id: 'a', spec: viz('A2') },
      { op: 'remove', card_id: 'b' },
      { op: 'add', spec: { kind: 'stats', title: 'S' } },
    ];
    const r = applyResolvedOps(cards, ops, () => `new-${n++}`, keepNext);
    expect(r.counts).toEqual({ added: 1, replaced: 1, removed: 1 });
    expect(r.next.map((c) => c.card_id)).toEqual(['a', 'new-0']);
    expect((r.next[0].spec as VizSpec).title).toBe('A2');
  });
  it('the inverse list round-trips: applyInverse(next, inverse) restores every touched card, with canonical orders', () => {
    let n = 0;
    const ops: ResolvedOp[] = [
      { op: 'replace', card_id: 'a', spec: viz('A2') },
      { op: 'remove', card_id: 'b' },
      { op: 'add', spec: { kind: 'stats', title: 'S' } },
    ];
    const r = applyResolvedOps(cards, ops, () => `new-${n++}`, keepNext);
    const undone = applyInverse(r.next, r.inverse);
    expect(undone.map((c) => c.card_id).sort()).toEqual(['a', 'b']);
    expect((undone.find((c) => c.card_id === 'a')!.spec as VizSpec).title).toBe('A');
    expect(undone.map((c) => ({ id: c.card_id, order: c.layout.order }))).toEqual([
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
    ]);
  });
  it('remove-then-inverse restores the original sequence and canonical orders for a middle card (A,B,C → remove B → undo)', () => {
    const three = [card('a', viz('A'), 0), card('b', viz('B'), 1), card('c', viz('C'), 2)];
    const r = applyResolvedOps(three, [{ op: 'remove', card_id: 'b' }], () => 'unused', keepNext);
    expect(r.next.map((c) => ({ id: c.card_id, order: c.layout.order }))).toEqual([
      { id: 'a', order: 0 },
      { id: 'c', order: 1 },
    ]);
    const restored = applyInverse(r.next, r.inverse);
    expect(restored.map((c) => ({ id: c.card_id, order: c.layout.order }))).toEqual([
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
      { id: 'c', order: 2 },
    ]);
  });
  it('ops on vanished cards no-op and do not count', () => {
    const r = applyResolvedOps(cards, [{ op: 'remove', card_id: 'zzz' }, { op: 'replace', card_id: 'zzz', spec: viz('x') }], () => 'id', keepNext);
    expect(r.counts).toEqual({ added: 0, replaced: 0, removed: 0 });
    expect(r.next).toEqual(cards);
  });
  it('replace routes through mergeReplace with the parsed prior', () => {
    const r = applyResolvedOps(cards, [{ op: 'replace', card_id: 'a', spec: viz('A2') }], () => 'id',
      (prior, next) => ({ ...next, title: `${(prior as VizSpec).title}+${next.title}` }));
    expect((r.next[0].spec as VizSpec).title).toBe('A+A2');
  });
});
