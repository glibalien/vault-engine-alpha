import type {
  SummaryIdentity,
  SummaryScalar,
  SummaryLookupDefinition,
} from './summary-types.js';
export interface TraversalRequest {
  root_id: string;
  field: string;
  direction: 'incoming' | 'outgoing';
  max_depth?: number;
  include_fields?: string[];
}
export interface TraversalEdge {
  source_id: string;
  target_id: string;
  field: string;
}
export interface TraversalData {
  kind: 'node_traversal';
  version: 1;
  root_id: string;
  field: string;
  direction: 'incoming' | 'outgoing';
  max_depth: number;
  nodes: Array<
    SummaryIdentity & { depth: number; fields: Record<string, SummaryScalar> }
  >;
  edges: TraversalEdge[];
  cycles: { scope: 'returned_edges'; components: string[][] };
  boundary: { depth_limited: boolean; unexpanded_node_ids: string[] };
  resolved_reachability_complete: boolean;
  unresolved:
    | { scope: 'expanded_sources'; raw_count: number; source_ids: string[] }
    | { scope: 'vault_rel_type'; exists: boolean };
  stats: {
    returned_nodes: number;
    returned_edges: number;
    raw_rows_examined: number;
  };
  field_definitions?: SummaryLookupDefinition['fields'];
}
