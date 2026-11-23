import { assembleContext, boardProvider, docRefProvider, memoriesProvider, nodesProvider, type EngineCall } from '@vault/chat-core';
import type { ChatContextHolder } from './context-state.js';

/** System-context assembler for the plugin chat: active-doc reference + board views +
 *  pinned nodes + durable memories (vault-scoped always, node-scoped when a doc is
 *  active). Reads the mutable holder at send time so context always reflects "now". */
export function makeBuildContext(holder: ChatContextHolder, call: EngineCall): () => Promise<string> {
  return async () => {
    const assembled = await assembleContext([docRefProvider, boardProvider, nodesProvider, memoriesProvider], {
      call,
      manifest: { docPath: holder.docPath, docId: holder.docId, activeBoardId: holder.activeBoardId },
      state: { doc: holder.docEnabled, board: true, nodes: holder.nodes ?? [] },
      estimateTokens: (t) => Math.ceil(t.length / 3.7),
    });
    return assembled.text;
  };
}
