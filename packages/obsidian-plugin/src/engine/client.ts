import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CallFn, Envelope, QueryArgs, QueryNodesData, VaultStats } from './types.js';

/** Parse the {ok,data,warnings} envelope out of a tool result's first text block. */
export function unwrapEnvelope<T>(result: CallToolResult): Envelope<T> {
  const first = result.content?.[0] as { type: string; text?: string } | undefined;
  if (typeof first?.text !== 'string') throw new Error('Tool result missing text content');
  return JSON.parse(first.text) as Envelope<T>;
}

export interface EngineClient {
  vaultStats(): Promise<Envelope<VaultStats>>;
  queryNodes(args: QueryArgs): Promise<Envelope<QueryNodesData>>;
}

/** Typed read-only wrappers over a CallFn. No mutation tools in the skeleton. */
export function makeEngineClient(call: CallFn): EngineClient {
  return {
    vaultStats: async () => unwrapEnvelope<VaultStats>(await call({ name: 'vault-stats', arguments: {} })),
    queryNodes: async (args) => unwrapEnvelope<QueryNodesData>(await call({ name: 'query-nodes', arguments: args })),
  };
}
