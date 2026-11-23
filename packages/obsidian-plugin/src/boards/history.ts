import { removeCard } from '@vault/board-core';
import type { BoardCard } from '@vault/board-core';
import type { BoardCardSpec } from '@vault/viz-ui';

/** One undo step for a single card. A history entry holds the list of inverses
 *  for everything one composer action did; applying them to the CURRENT cards
 *  (not a snapshot) means interleaved manual edits to untouched cards survive. */
export type InverseOp =
  | { op: 'remove_card'; cardId: string }
  | { op: 'restore_spec'; cardId: string; spec: BoardCardSpec }
  | { op: 'reinsert_card'; card: BoardCard };

export interface HistoryEntry { label: 'create' | 'tweak' | 'board op'; detail: string; inverse: InverseOp[] }

export const MAX_HISTORY = 10;

export function pushHistory(stack: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [...stack.slice(-(MAX_HISTORY - 1)), entry];
}

/** Inverses whose target no longer exists no-op silently — the entry is consumed either way.
 *  `layout.order` is always kept canonical (0..n-1), matching every other board-core mutator:
 *  remove_card renumbers survivors, and reinsert_card splices the stored card back in at its
 *  stored order (clamped) before renumbering, restoring its original position exactly. */
export function applyInverse(cards: BoardCard[], inverse: InverseOp[]): BoardCard[] {
  let next = cards;
  for (const inv of inverse) {
    if (inv.op === 'remove_card') {
      next = removeCard(next, inv.cardId);
    } else if (inv.op === 'restore_spec') {
      next = next.map((c) => (c.card_id === inv.cardId ? { ...c, spec: inv.spec } : c));
    } else if (next.every((c) => c.card_id !== inv.card.card_id)) {
      const idx = Math.min(inv.card.layout.order, next.length);
      const spliced = [...next.slice(0, idx), inv.card, ...next.slice(idx)];
      next = spliced.map((c, i) => ({ ...c, layout: { ...c.layout, order: i } }));
    }
  }
  return next;
}
