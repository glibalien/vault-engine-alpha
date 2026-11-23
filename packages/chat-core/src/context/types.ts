import type { EngineCall } from '../tools.js';

/** Per-conversation chip state, stored opaquely in the engine `client_state`
 *  column. SHARED across surfaces — web + plugin MUST agree on this shape, or a
 *  surface clobbers the other's settings when it writes client_state. */
export interface ContextState {
  doc: boolean;
  board: boolean;
  nodes: string[];
  /** Persisted board-context choice: undefined = none yet (default), null = explicit off, string = that board. */
  activeBoardId?: string | null;
  /** Per-conversation model choice: a Settings/Models catalog note title.
   *  undefined = use the surface default (Settings/Chat.md → defaultModel). */
  modelRef?: string;
}

/** Live, per-turn context the host supplies ("what's open right now"). Extend
 *  as new providers arrive (e.g. add an openNote field for the open-note provider). */
export interface ContextManifest {
  docPath?: string;
  /** Engine node id of the active doc (reference-mode surfaces; see docRefProvider). */
  docId?: string;
  activeBoardId?: string;
}

export interface ContextProviderInput {
  call: EngineCall;
  manifest: ContextManifest;
  state: ContextState;
  estimateTokens: (text: string) => number;
}

/** A built context block + its token estimate. */
export interface ContextSection { label: string; text: string; tokens: number }

/** A context contributor. Self-gates from `input.state` / `input.manifest`;
 *  returns null when it has nothing to add. `key` doubles as the chip key. */
export interface ContextProvider {
  key: string;
  build(input: ContextProviderInput): Promise<ContextSection | null>;
}

export interface ContextSectionMeta { label: string; tokens: number }
export interface AssembledContext { text: string; sections: ContextSectionMeta[] }
