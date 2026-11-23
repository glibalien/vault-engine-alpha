import type { VizSpec, BoardCardSpec, ViewVocabulary } from '@vault/viz-ui';
import type { BoardCard } from './types.js';

/** Append a new card to the end of the cards array. Pure — does not mutate.
 *  `spec` accepts the full `BoardCardSpec` union (not just the four viz kinds) since the board
 *  composer can create node/stats/spend/evidence cards too; `BoardCard.spec` is `unknown` at
 *  rest regardless. */
export function addCard(cards: BoardCard[], spec: BoardCardSpec, makeId: () => string): BoardCard[] {
  return [...cards, { card_id: makeId(), spec, layout: { order: cards.length } }];
}

/** Cards sorted by `layout.order` and renumbered 0..n-1, other layout keys kept. Every other
 *  mutator here assumes that canonical form (array position = order); a board saved by another
 *  client may arrive out of order or with gaps. Pure; unchanged cards keep their identity. */
export function normalizeOrder(cards: BoardCard[]): BoardCard[] {
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.layout?.order ?? a.i) - (b.c.layout?.order ?? b.i) || a.i - b.i)
    .map(({ c }, i) => (c.layout?.order === i ? c : { ...c, layout: { ...c.layout, order: i } }));
}

/** Remove the card with card_id and renumber order. Pure. */
export function removeCard(cards: BoardCard[], card_id: string): BoardCard[] {
  return cards.filter((c) => c.card_id !== card_id).map((c, i) => ({ ...c, layout: { ...c.layout, order: i } }));
}

/** Move card_id to toIndex (0-based) and renumber order. Pure. */
export function reorderCard(cards: BoardCard[], card_id: string, toIndex: number): BoardCard[] {
  const from = cards.findIndex((c) => c.card_id === card_id);
  if (from === -1) return cards;
  const clamped = Math.max(0, Math.min(toIndex, cards.length - 1));
  const copy = [...cards];
  const [moved] = copy.splice(from, 1);
  copy.splice(clamped, 0, moved);
  return copy.map((c, i) => ({ ...c, layout: { ...c.layout, order: i } }));
}

/** Update width/height of card_id. Pure. */
export function resizeCard(cards: BoardCard[], card_id: string, size: { width?: number; height?: number }): BoardCard[] {
  return cards.map((c) => (c.card_id === card_id ? { ...c, layout: { ...c.layout, ...size } } : c));
}

/** The Kanban preset with the vault map at its defaults. */
export const KANBAN_PRESET: VizSpec = {
  kind: 'kanban', title: '', query: { types: ['task'] }, display_fields: ['status', 'priority', 'due'], group_by: 'status',
};

/**
 * The Kanban preset for a vault: its tasks in columns by their status field, showing status,
 * priority and due. The names are written into the spec, so a saved board keeps them. Null when the
 * vault map has no task kind or no task status field: then the preset is not offered.
 */
export function kanbanPreset(v: Pick<ViewVocabulary, 'taskType' | 'taskStatusField' | 'priorityField' | 'dueField'>): VizSpec | null {
  if (v.taskType === null || v.taskStatusField === null) return null;
  const display_fields = [v.taskStatusField, v.priorityField, v.dueField].filter((f): f is string => f !== null);
  return { kind: 'kanban', title: '', query: { types: [v.taskType] }, display_fields, group_by: v.taskStatusField };
}

export const TABLE_PRESET: VizSpec = {
  kind: 'table', title: '', query: { sort_by: 'file_mtime', sort_order: 'desc' }, display_fields: [],
};
