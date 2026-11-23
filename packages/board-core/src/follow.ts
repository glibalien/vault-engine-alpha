import type { BoardSummary } from './types.js';

/**
 * Pick which board to "follow" for a doc: the most-recently-updated linked board,
 * or null when the doc has none. Board analog of conversation-core's
 * pickFollowConversation, so board follow-active-doc behaviour matches conversations.
 * `summaries` may be in any order (callers pass doc-filtered list-boards rows, which are
 * updated_at DESC, but we do not rely on that).
 */
export function pickFollowBoard(summaries: BoardSummary[]): string | null {
  let best: BoardSummary | null = null;
  for (const s of summaries) {
    if (!best || s.updated_at > best.updated_at) best = s;
  }
  return best ? best.id : null;
}
