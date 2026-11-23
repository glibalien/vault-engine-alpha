import type { BoardSummary } from './types.js';

/**
 * Display order for a note's boards (the board switcher): oldest first, so a new board appends at
 * the end and editing a board never reshuffles the list (summaries arrive most-recently-updated
 * first, which would). Boards from an engine that predates `created_at` keep their given order
 * after every dated board. Pure: returns a new array.
 */
export function orderBoards(summaries: BoardSummary[]): BoardSummary[] {
  return summaries
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ca = a.s.created_at;
      const cb = b.s.created_at;
      if (ca === undefined && cb === undefined) return a.i - b.i;
      if (ca === undefined) return 1;
      if (cb === undefined) return -1;
      return ca - cb || a.i - b.i;
    })
    .map(({ s }) => s);
}
