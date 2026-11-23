import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** The single tool-call seam every surface injects (mirrors query-core's CallFn). */
export type CallFn = (tc: { name: string; arguments: Record<string, unknown> }) => Promise<CallToolResult>;

/** The engine's MCP response envelope (subset the skeleton reads). */
export interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
  warnings?: unknown[];
}

/** Subset of vault-stats data the skeleton renders. */
export interface VaultStats {
  node_count: number;
  type_counts?: Array<{ type: string; count: number }>;
  field_count?: number;
  relationship_count?: number;
  schema_count?: number;
  [k: string]: unknown;
}

/** A query-nodes result row (subset of the engine's NodeRow). */
export interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
  types: string[];
  version: number;
  field_count: number;
  fields?: Record<string, unknown>;
}

export interface QueryNodesData {
  nodes: NodeRow[];
  total: number;
}

export type QueryArgs = Record<string, unknown>;
