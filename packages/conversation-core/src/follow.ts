import type { ConversationSummary } from './types.js';

/**
 * Pick which conversation to open when "following" a doc. Both surfaces use this so
 * follow behaviour is identical: the most-recently-updated ACTIVE (non-archived)
 * conversation linked to the doc, or null to signal "create a fresh one".
 * `summaries` may be in any order (callers pass doc-filtered list-conversations rows,
 * which are updated_at DESC, but we do not rely on that).
 */
export function pickFollowConversation(summaries: ConversationSummary[]): string | null {
  let best: ConversationSummary | null = null;
  for (const s of summaries) {
    if (s.archived !== 0) continue;
    if (!best || s.updated_at > best.updated_at) best = s;
  }
  return best ? best.id : null;
}
