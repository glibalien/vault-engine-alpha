// Read-only inspection wire mirror; checked by scripts/typecheck-provenance-wire.ts.
export type SourceKey = {
  kind:
    | 'node'
    | 'memory'
    | 'curator_correction'
    | 'generated_context'
    | 'engine_projection';
  namespace: string; // Engine vault ID, Curator installation ID, or attempt namespace
  native_id: string;
};
export type ProvenanceFlow = 'project-home-v1' | 'project-subpage-v1';
export type InputRole =
  | 'source_material'
  | 'generated_context'
  | 'human_correction'
  | 'engine_projection';
export type OutputReceipt = {
  replaces_output_revision_id?: string | null;
  derivation_id: string;
  output_revision_id: string;
  output_node_id: string;
  committed_node_version: number;
  committed_at: string;
  operation_id: string;
  reconcile_key: string;
  request_digest: string | null;
};

export type InputTextRequest = {
  select: 'input_text';
  output_revision_id: string;
  input_id: string;
  cursor?: string;
  max_bytes?: number;
};
export type InputTextSegment = {
  span_index: number;
  field: string;
  span_start: number;
  span_end: number;
  start: number;
  end: number;
  text: string;
};
export type InputTextData = {
  select: 'input_text';
  output_revision_id: string;
  input_id: string;
  availability: 'retained' | 'expired' | 'purged';
  input_digest: string | null;
  segments: InputTextSegment[];
  next_cursor: string | null;
};
export type Comparison =
  | 'unchanged'
  | 'changed'
  | 'missing'
  | 'unavailable'
  | 'comparison_unknown'
  | 'expected_self_transition';
export type Currentness = 'matches' | 'changed' | 'missing' | 'unknown';
export type ProvenanceImpactRequest = {
  sources: SourceKey[];
  currentness?: 'all' | 'current' | 'historical';
  limit?: number;
  cursor?: string;
};
export type ProvenanceImpactInput = {
  input_id: string;
  role: InputRole | null;
  comparison: Comparison;
  reason: string;
};
export type ProvenanceImpactOutput = {
  receipt: OutputReceipt;
  currentness: Currentness;
  inputs: ProvenanceImpactInput[];
  inputs_truncated: boolean;
  dependency_coverage:
    | 'complete_direct'
    | 'direct_with_opaque_components'
    | 'unknown';
};
export type ProvenanceImpactData = {
  as_of: string;
  outputs: ProvenanceImpactOutput[];
  comparisons: number;
  next_cursor: string | null;
  truncated: boolean;
  coverage: 'captured_direct_dependencies_only';
};
export type PayloadReference = {
  id: string;
  kind: string;
  bytes: number;
  digest: string | null;
  availability: 'retained' | 'expired' | 'purged';
};
export type InputMetadata = {
  comparison?: Comparison;
  id: string;
  source_id: string | null;
  source: SourceKey | null;
  role: InputRole | null;
  selection: string | null;
  origin: 'identified' | 'opaque' | null;
  truncated: boolean | null;
  retained_bytes: number | null;
  observation_digest: string | null;
  observed_at: string | null;
  label: string | null;
  path: string | null;
  /** Where the input begins in the request the model was sent: its first span's field and UTF-8
   *  byte offset. Null once purged; absent from Engines before #551. */
  position?: { field: string; start: number } | null;
};
export type OutputSummary = {
  receipt: OutputReceipt;
  availability: 'retained' | 'expired' | 'purged';
  currentness: Currentness;
};
export type RefreshTargetData = {
  select: 'refresh_target'; eligible: boolean; reasons: string[]; vault_namespace: string;
  output_revision_id: string; latest_output_revision_id: string | null;
  /** The home fields below always describe the wiki's home; the page fields are null for a home. */
  target_kind: 'home' | 'page';
  page_node_id: string | null; page_title: string | null; page_path: string | null; page_version: number | null;
  project_id: string | null; project_title: string | null; home_node_id: string | null;
  home_title: string | null; home_path: string | null; home_version: number | null; topology_hash: string | null;
  currentness: 'matches' | 'changed' | 'missing' | 'unknown'; availability: 'retained' | 'expired' | 'purged' | null;
};
export type ProvenanceInspectRequest =
  | { select: 'refresh_target'; output_revision_id: string }
  | InputTextRequest
  | { select: 'status' }
  | { select: 'node'; node_id: string; limit?: number; cursor?: string }
  | {
      select: 'output';
      output_revision_id: string;
      include_comparisons?: boolean;
      limit?: number;
      cursor?: string;
    };
export type ProvenanceInspectData =
  | RefreshTargetData
  | InputTextData
  | {
      select: 'status';
      capability_version: 1;
      inspection_features?: string[];
      capture_features?: string[];
      vault_namespace: string;
      limits: Record<string, number>;
      actual_bytes: number;
      reserved_bytes: number;
      purge_restore_verification: 'unverified';
    }
  | {
      select: 'output';
      compared_at?: string;
      output: OutputSummary;
      inputs: InputMetadata[];
      inputs_truncated: boolean;
      next_cursor: string | null;
      payloads: PayloadReference[];
      omissions: Array<{ code: string; source: SourceKey | null }>;
      dependency_coverage:
        'complete_direct' | 'direct_with_opaque_components' | 'unknown';
    }
  | {
      select: 'node';
      outputs: OutputSummary[];
      current_provenance:
        | 'captured'
        | 'unknown_legacy'
        | 'not_recorded'
        | 'unavailable'
        | 'unknown';
      next_cursor: string | null;
    };
export type {
  SourceKey as ProvenanceSourceKey,
  InputMetadata as ProvenanceInputMetadata,
  OutputSummary as ProvenanceOutputSummary,
  Comparison as ProvenanceComparison,
};
