import type { BoardCard } from '@vault/board-core';

/** A change to a board's card list. */
export type CardsChange = (cards: BoardCard[]) => BoardCard[];

/** A Boards pane, as changes from elsewhere in the plugin see it. */
export interface BoardPaneSync {
  /** The board the pane shows, if any. */
  shownBoardId(): string | null;
  /** Make `change` to `boardId` as an edit of this pane and save it, once any load of that
   *  board has landed. Resolves true once the save has landed, or false when the pane no
   *  longer shows `boardId`. */
  applyChange(boardId: string, change: CardsChange): Promise<boolean>;
}

/**
 * Routes a change to a board's cards from outside the Boards pane (chat's Pin) through the
 * Boards pane showing that board, when there is one (#287). Both save the whole card list,
 * so two writers would drop each other's changes: a pane edit waiting for its debounced
 * save, a pin read before that save, or a pane that never re-read the board after a pin.
 * With the pane making the pin as one of its own edits, its card list is the only one
 * saved while it is open, and it shows the pinned view at once.
 *
 * With no pane showing the board, the caller writes it directly, reading the board inside
 * the queue. Changes to one board run one at a time, so two quick pins can't read the
 * same list. One instance per plugin,
 * shared by every chat and Boards pane. Edits from another device are still
 * last-writer-wins.
 */
export class BoardSync {
  private readonly panes = new Set<BoardPaneSync>();
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Register a pane; returns its unregister function. */
  register(pane: BoardPaneSync): () => void {
    this.panes.add(pane);
    return () => { this.panes.delete(pane); };
  }

  /** Apply `change` to the board through the pane showing it, or with `direct` when no
   *  pane does. Returns which one made the change. */
  change(boardId: string, change: CardsChange, direct: (change: CardsChange) => Promise<void>): Promise<'pane' | 'direct'> {
    const run = (this.tails.get(boardId) ?? Promise.resolve()).then(async () => {
      const pane = [...this.panes].find((p) => p.shownBoardId() === boardId);
      if (pane && await pane.applyChange(boardId, change)) return 'pane' as const;
      await direct(change);
      return 'direct' as const;
    });
    const tail = run.catch(() => {});
    this.tails.set(boardId, tail);
    void tail.then(() => { if (this.tails.get(boardId) === tail) this.tails.delete(boardId); });
    return run;
  }
}
