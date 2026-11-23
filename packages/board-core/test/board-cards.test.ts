import { describe, it, expect } from 'vitest';
import { addCard, removeCard, reorderCard, resizeCard, KANBAN_PRESET, kanbanPreset, TABLE_PRESET, normalizeOrder } from '../src/board-cards.js';
import type { BoardCard } from '../src/types.js';

const spec = TABLE_PRESET;
let n = 0;
const makeId = () => `id-${n++}`;

describe('board-cards', () => {
  it('addCard appends with order = prior length', () => {
    n = 0;
    const a = addCard([], spec, makeId);
    const b = addCard(a, spec, makeId);
    expect(a).toHaveLength(1);
    expect(a[0].layout.order).toBe(0);
    expect(b[1].layout.order).toBe(1);
    expect(b[1].card_id).toBe('id-1');
  });

  it('removeCard drops the card and renumbers order', () => {
    const cards: BoardCard[] = [
      { card_id: 'a', spec, layout: { order: 0 } },
      { card_id: 'b', spec, layout: { order: 1 } },
      { card_id: 'c', spec, layout: { order: 2 } },
    ];
    const out = removeCard(cards, 'b');
    expect(out.map((c) => c.card_id)).toEqual(['a', 'c']);
    expect(out.map((c) => c.layout.order)).toEqual([0, 1]);
  });

  it('reorderCard moves and renumbers', () => {
    const cards: BoardCard[] = [
      { card_id: 'a', spec, layout: { order: 0 } },
      { card_id: 'b', spec, layout: { order: 1 } },
      { card_id: 'c', spec, layout: { order: 2 } },
    ];
    const out = reorderCard(cards, 'c', 0);
    expect(out.map((c) => c.card_id)).toEqual(['c', 'a', 'b']);
    expect(out.map((c) => c.layout.order)).toEqual([0, 1, 2]);
  });

  it('resizeCard updates only the target card size', () => {
    const cards: BoardCard[] = [{ card_id: 'a', spec, layout: { order: 0 } }];
    const out = resizeCard(cards, 'a', { width: 500, height: 300 });
    expect(out[0].layout).toEqual({ order: 0, width: 500, height: 300 });
  });

  it('presets are well-formed VizSpecs', () => {
    expect(KANBAN_PRESET.kind).toBe('kanban');
    expect(KANBAN_PRESET.group_by).toBe('status');
    expect(TABLE_PRESET.kind).toBe('table');
  });
});

describe('kanbanPreset (#449)', () => {
  const DEFAULTS = { taskType: 'task', taskStatusField: 'status', priorityField: 'priority', dueField: 'due' };

  it('with the vault map at its defaults is today\'s preset', () => {
    expect(kanbanPreset(DEFAULTS)).toEqual(KANBAN_PRESET);
    expect(KANBAN_PRESET).toEqual({
      kind: 'kanban', title: '', query: { types: ['task'] }, display_fields: ['status', 'priority', 'due'], group_by: 'status',
    });
  });

  it('writes the vault\'s own names into the spec, leaving out a field that is none', () => {
    expect(kanbanPreset({ taskType: 'todo', taskStatusField: 'state', priorityField: null, dueField: 'deadline' })).toEqual({
      kind: 'kanban', title: '', query: { types: ['todo'] }, display_fields: ['state', 'deadline'], group_by: 'state',
    });
  });

  it('is not offered without a task kind or a task status field', () => {
    expect(kanbanPreset({ ...DEFAULTS, taskType: null })).toBeNull();
    expect(kanbanPreset({ ...DEFAULTS, taskStatusField: null })).toBeNull();
  });
});

describe('normalizeOrder', () => {
  const c = (id: string, order: number, extra: Record<string, unknown> = {}) => ({ card_id: id, spec: {}, layout: { order, ...extra } });
  it('sorts by layout.order and renumbers 0..n-1, keeping other layout keys', () => {
    expect(normalizeOrder([c('b', 5), c('a', 0, { width: 300 }), c('d', 9)])).toEqual([c('a', 0, { width: 300 }), c('b', 1), c('d', 2)]);
  });
  it('returns canonical cards unchanged (same objects)', () => {
    const input = [c('a', 0), c('b', 1)];
    const out = normalizeOrder(input);
    expect(out[0]).toBe(input[0]);
    expect(out[1]).toBe(input[1]);
  });
});
