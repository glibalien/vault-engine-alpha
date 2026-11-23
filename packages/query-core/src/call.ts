/**
 * Bridge-free call helper — the tool-name-agnostic typed call core every
 * surface's Client wraps. No postMessage/bridge/iframe bootstrap here.
 *
 * Extracted from packages/engine/src/mcp/ui/_kit/host.ts (makeCall +
 * unwrapEnvelope only). connectHost / createHostApp are iframe-only and
 * are deliberately omitted. CallFn is deliberately re-typed structurally
 * rather than aliased to App["callServerTool"] to keep this module free
 * of @modelcontextprotocol/ext-apps dependency.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Envelope } from "./types.js";

export type CallFn = (toolCall: {
  name: string;
  arguments: Record<string, unknown>;
}) => Promise<CallToolResult>;

export function unwrapEnvelope<T = unknown>(result: CallToolResult): Envelope<T> {
  const text = (result.content?.[0] as { type: string; text?: string } | undefined)?.text;
  if (typeof text !== "string") {
    throw new Error("Tool result missing text content");
  }
  return JSON.parse(text) as Envelope<T>;
}

/** Tool-name-agnostic typed call core. Surfaces wrap this with their typed
 *  tool list (see query-nodes/client.ts makeClient). */
export function makeCall(callServerTool: CallFn) {
  return async <T>(name: string, args: Record<string, unknown>): Promise<Envelope<T>> => {
    const result = await callServerTool({ name, arguments: args });
    return unwrapEnvelope<T>(result);
  };
}
