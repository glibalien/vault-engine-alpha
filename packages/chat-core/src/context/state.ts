import type { ContextState } from './types.js';

/** Boolean chip keys (list-valued slices like `nodes` are not chips). */
export const CONTEXT_CHIP_KEYS = ['doc', 'board'] as const;
export type ContextChipKey = (typeof CONTEXT_CHIP_KEYS)[number];

/** Defaults for a conversation with no stored client_state: doc + board on, no nodes.
 *  Verbatim port of the web's coerceContext (was packages/chat/src/server/conversation-store.ts). */
export function coerceContext(raw: unknown): ContextState {
  const p = (raw ?? {}) as Partial<ContextState>;
  return {
    doc: p.doc !== false,
    board: p.board !== false,
    nodes: Array.isArray(p.nodes) ? p.nodes.filter((n): n is string => typeof n === 'string') : [],
    ...(p.activeBoardId === null || typeof p.activeBoardId === 'string' ? { activeBoardId: p.activeBoardId } : {}),
    ...(typeof p.modelRef === 'string' && p.modelRef.trim() !== '' ? { modelRef: p.modelRef } : {}),
  };
}

/** The single source of truth for resolving the effective board, used by both surfaces.
 *  docBoardIds = ids of the doc's linked boards, most-recent first. */
export function pickEffectiveBoard(state: ContextState, docBoardIds: readonly string[]): string | undefined {
  if (state.activeBoardId === null) return undefined;                              // explicit "No board"
  if (typeof state.activeBoardId === 'string') {
    return docBoardIds.includes(state.activeBoardId) ? state.activeBoardId : docBoardIds[0]; // stale id → default
  }
  if (state.board === false) return undefined;                                     // legacy off (pre-dropdown)
  return docBoardIds[0];                                                           // no choice → default
}
