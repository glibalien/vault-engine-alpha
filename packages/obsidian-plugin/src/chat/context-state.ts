import { coerceContext, type ContextState } from '@vault/chat-core';

/** Mutable bridge between ChatPane (React) and the transport's buildContext closure. */
export interface ChatContextHolder {
  activeBoardId?: string;
  /** Last known active doc — survives null active-file events (chat pane focus). */
  docPath?: string;
  docId?: string;
  /** Hydrated ContextState.doc chip for the current conversation (default ON). */
  docEnabled: boolean;
  /** '@'/'+ add' node-chip ids for the current conversation (ContextState.nodes). */
  nodes?: string[];
}

/** Read-modify-write: set ONLY activeBoardId, preserving doc/board/nodes set by other
 *  surfaces (client_state is shared — never blind-overwrite). */
export function patchActiveBoard(raw: unknown, activeBoardId: string | null): ContextState {
  return { ...coerceContext(raw), activeBoardId };
}

/** Hydrate the persisted board choice from shared client_state for the dropdown.
 *  undefined = no choice yet (default to the doc's most-recent board), null = explicit off,
 *  string = that board. The plugin resolves with a hardcoded board:true, so the resolver's
 *  legacy-off branch (board === false) is unreachable here; translate a legacy "board off"
 *  conversation (board:false with no explicit choice — set on either surface pre-dropdown)
 *  into the explicit "No board" choice (null) so it stays off. An explicit choice always wins. */
export function hydrateBoardChoice(raw: unknown): string | null | undefined {
  const st = coerceContext(raw);
  if (st.activeBoardId !== undefined) return st.activeBoardId; // explicit null or a board id
  return st.board === false ? null : undefined;                // legacy off → explicit off; else default
}

/** Read-modify-write: set ONLY doc, preserving board/nodes/activeBoardId set by other
 *  surfaces (client_state is shared — never blind-overwrite). */
export function patchDocChip(raw: unknown, doc: boolean): ContextState {
  return { ...coerceContext(raw), doc };
}

/** Hydrate the persisted doc chip from shared client_state (default ON — parity with
 *  web's coerceContext: absent means true). */
export function hydrateDocChip(raw: unknown): boolean {
  return coerceContext(raw).doc;
}

/** Read-modify-write: set ONLY nodes, preserving doc/board/activeBoardId set by other
 *  surfaces (client_state is shared — never blind-overwrite). */
export function patchNodeChips(raw: unknown, nodes: string[]): ContextState {
  return { ...coerceContext(raw), nodes };
}

/** Hydrate the persisted node-chip ids from shared client_state. */
export function hydrateNodeChips(raw: unknown): string[] {
  return coerceContext(raw).nodes;
}

/** Read-modify-write: set ONLY modelRef, preserving doc/board/nodes/activeBoardId set by
 *  other surfaces (client_state is shared — never blind-overwrite). `null` deletes the key,
 *  clearing the override back to the surface default (Settings/Chat.md → defaultModel). */
export function patchModelRef(raw: unknown, modelRef: string | null): ContextState {
  const next: ContextState = { ...coerceContext(raw) };
  if (modelRef === null) delete next.modelRef;
  else next.modelRef = modelRef;
  return next;
}

/** Hydrate the persisted per-conversation model override from shared client_state.
 *  undefined = no override — the surface resolves its own default. */
export function hydrateModelRef(raw: unknown): string | undefined {
  return coerceContext(raw).modelRef;
}
