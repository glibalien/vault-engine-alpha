import { wrapEngineTools, mergeToolSets, createPresentVizTool, CHAT_MODEL_META_KEY, type EngineCall, type ToolCallResultLike, type VizVaultNames } from '@vault/chat-core';
import type { ToolSet } from 'ai';
import type { EngineConnection } from '../engine/transport.js';

/** Adapt the Phase-1 CallFn to chat-core's EngineCall shape. For calls the plugin's own code makes. */
export function engineCallFor(conn: EngineConnection): EngineCall {
  return (name, args) => conn.call({ name, arguments: args }) as Promise<ToolCallResultLike>;
}

/** What the Engine records as the editor of a memory the chat model changes. */
export const CHAT_MODEL_NAME = 'Obsidian chat';

/**
 * The call the chat model's tools go through. It marks each call as the model's, so the
 * Engine applies its chat-client rules: the plugin's service token is trusted, and without
 * the mark the Engine could not tell the model's calls from the plugin's own.
 */
export function chatModelCallFor(conn: EngineConnection): EngineCall {
  return (name, args) =>
    conn.call({ name, arguments: args, _meta: { [CHAT_MODEL_META_KEY]: CHAT_MODEL_NAME } }) as Promise<ToolCallResultLike>;
}

/**
 * Build the AI-SDK ToolSet: the engine's full tool list (read + write), the
 * curator's tools when a curator connection is supplied, and the local
 * present-viz tool. Engine wins any name collision (mergeToolSets, first-wins). `vault` (the vault
 * map's names) shapes present-viz's examples and default grouping field; absent, today's names.
 */
export async function buildToolSet(
  engineConn: EngineConnection,
  curatorConn?: EngineConnection,
  vault?: VizVaultNames,
): Promise<ToolSet> {
  // Every tool in this set is called by the model, so every Engine call is marked as the model's.
  const engineCall = chatModelCallFor(engineConn);
  const engineTools = await engineConn.listTools();

  let curatorSet: ToolSet = {};
  if (curatorConn) {
    try {
      const curatorTools = await curatorConn.listTools();
      curatorSet = wrapEngineTools(curatorTools, engineCallFor(curatorConn));
    } catch (err) {
      // Curator reachable for the handshake but tools/list failed (e.g. missing
      // scope, or it died mid-open) — degrade to engine-only, never break chat.
      console.warn(`[vault-obsidian] curator tools unavailable, continuing engine-only: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // engine first (wins name collisions), then curator, then the local present-viz
  // tool — present-viz is intentionally lowest precedence.
  return mergeToolSets(
    wrapEngineTools(engineTools, engineCall),
    curatorSet,
    { 'present-viz': createPresentVizTool(engineCall, vault) },
  );
}
