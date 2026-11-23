import { removeCard } from '@vault/board-core';
import type { BoardCard } from '@vault/board-core';
import { parseBoardCardSpec } from '@vault/viz-ui';
import type { BoardCardSpec, VizSpec } from '@vault/viz-ui';
import type { InverseOp } from './history.js';

/** A board-plan op after client-side expansion: every add_from_query has already
 *  fanned out into concrete `add`s; nothing here needs another engine call. */
export type ResolvedOp =
  | { op: 'add'; spec: BoardCardSpec }
  | { op: 'replace'; card_id: string; spec: VizSpec }
  | { op: 'remove'; card_id: string };

export interface AppliedOps {
  next: BoardCard[];
  inverse: InverseOp[];
  counts: { added: number; replaced: number; removed: number };
}

/**
 * One pass over the ops in plan order. Inverses are collected in REVERSE order
 * (unshift) so applyInverse's sequential walk unwinds the action LIFO. Ops whose
 * target card vanished (concurrent edit) no-op and don't count.
 */
export function applyResolvedOps(
  cards: BoardCard[],
  ops: ResolvedOp[],
  makeId: () => string,
  mergeReplace: (prior: BoardCardSpec, next: VizSpec) => BoardCardSpec,
): AppliedOps {
  let next = cards;
  const inverse: InverseOp[] = [];
  const counts = { added: 0, replaced: 0, removed: 0 };
  for (const op of ops) {
    if (op.op === 'remove') {
      const victim = next.find((c) => c.card_id === op.card_id);
      if (!victim) continue;
      inverse.unshift({ op: 'reinsert_card', card: victim });
      next = removeCard(next, op.card_id);
      counts.removed++;
    } else if (op.op === 'replace') {
      const target = next.find((c) => c.card_id === op.card_id);
      const prior = target ? parseBoardCardSpec(target.spec) : null;
      if (!target || !prior) continue;
      inverse.unshift({ op: 'restore_spec', cardId: op.card_id, spec: prior });
      const merged = mergeReplace(prior, op.spec);
      next = next.map((c) => (c.card_id === op.card_id ? { ...c, spec: merged } : c));
      counts.replaced++;
    } else {
      const id = makeId();
      inverse.unshift({ op: 'remove_card', cardId: id });
      next = [...next, { card_id: id, spec: op.spec, layout: { order: next.length } }];
      counts.added++;
    }
  }
  return { next, inverse, counts };
}
