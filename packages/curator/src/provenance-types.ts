// Wire-only domain contract; mirrored across Engine and Curator.
import type { ModelProvider } from '@vault/settings-registry';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SourceKey = {
  kind: 'node' | 'memory' | 'curator_correction' | 'generated_context' | 'engine_projection';
  namespace: string; // Engine vault ID, Curator installation ID, or attempt namespace
  native_id: string;
};
export type ProvenanceFlow = 'project-home-v1' | 'project-subpage-v1';
export type CaptureTarget = { node_id: string } | { plan_key: string };
export type InputRole = 'source_material' | 'generated_context' | 'human_correction' | 'engine_projection';
export type SourceObservation = {
  source: SourceKey;
  authority: 'engine' | 'caller';
  observed_at: string;
  native_version: number | null;
  content_hash: string | null;
  hash_semantics: 'engine_content_hash' | 'selected_projection_v1' | 'caller_content_v1';
  observation_projection: 'node-token-v1' | 'node-token-v2' | 'memory-content-v1' | 'caller-content-v1';
  observation_digest: string;
  label: string | null;
  path: string | null;
};
export type InputItem = {
  key: string; // unique within the request; stable across its retries
  observation: SourceObservation | null;
  role: InputRole;
  upstream_derivation_id: string | null;
  selection: string; // e.g. body.trim.prefix:v1, task-fields:v1, page-index:v1
  spans: Array<{ field: string; start: number; end: number }>; // UTF-8, decoded string
  original_bytes: number | null;
  retained_bytes: number;
  input_digest: string; // hash of ordered field/span coordinates plus selected bytes
  truncated: boolean;
  origin: 'identified' | 'opaque';
};
export type BundleV1 = {
  version: 1;
  provider: ModelProvider;
  model: string;
  target?: CaptureTarget;
  provider_payload: Json; // allowlisted SDK request params; no headers/credentials
  decoded_fields: Record<string, string>; // exact derived message fields, not extra inputs
  items: InputItem[];
  omissions: Array<{ code: string; source: SourceKey | null }>;
  dependency_coverage: 'complete_direct' | 'direct_with_opaque_components';
  assembly_context?: { evidence_hash: string; evaluated_at: string;
    query: { project: string; meeting_recent_limit: number; meeting_upcoming_limit: number; contact_limit: number; since: string | null } };
  transform: { assembly: string; prompt: string; schema: string; adapter: string; output: string };
};
export type PrepareRequest = {
  flow?: ProvenanceFlow;
  attempt_key: string;
  run_ref: string;
  project_id: string;
  predecessor_attempt_id?: string;
  bundle: BundleV1;
  dry_run: boolean;
};
export type PreparedReceipt = {
  derivation_id: string;
  bundle_digest: string | null;
  state: 'prepared' | 'result_staged' | 'committed' | 'failed' | 'abandoned';
  availability: 'retained' | 'expired' | 'purged';
  lease_expires_at: string;
};
export type Contribution = Array<{ name: string; mode: 'replace' | 'append'; content: string }>;
export type StageRequest = {
  derivation_id: string;
  bundle_digest: string;
  validated_sections: Record<string, string>;
  contribution: Contribution;
  generated_at: string;
  log_stamp: string;
};
export type ProvenanceBinding = { derivation_id: string; bundle_digest: string; contribution_digest: string };
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

export type PreparePreview = { dry_run: true; bundle_digest: string; payload_bytes: number; reserved_bytes: number; item_count: number };
export type AttemptSummary = PreparedReceipt & { output: OutputReceipt | null };
export type TransitionRequest = { derivation_id: string; action: 'mark-sent' | 'fail' | 'abandon' | 'renew'; expected_state: 'prepared' | 'result_staged' | 'failed' | 'abandoned' };

export type InputTextRequest = { select: 'input_text'; output_revision_id: string; input_id: string; cursor?: string; max_bytes?: number };
export type InputTextSegment = { span_index: number; field: string; span_start: number; span_end: number; start: number; end: number; text: string };
export type InputTextData = { select: 'input_text'; output_revision_id: string; input_id: string; availability: 'retained' | 'expired' | 'purged'; input_digest: string | null; segments: InputTextSegment[]; next_cursor: string | null };
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
export type InspectRequest =
  | { select: 'refresh_target'; output_revision_id: string }
  | InputTextRequest
  | { select: 'status' }
  | { select: 'attempt'; attempt_key: string; flow?: ProvenanceFlow }
  | { select: 'output'; output_revision_id: string; include_comparisons?: boolean; limit?: number; cursor?: string }
  | { select: 'node'; node_id: string; limit?: number; cursor?: string }
  | { select: 'text'; payload_id: string; cursor?: string; max_bytes?: number }
  | { select: 'purge_receipts'; limit?: number; cursor?: string };
export type Comparison = 'unchanged' | 'changed' | 'missing' | 'unavailable' | 'comparison_unknown' | 'expected_self_transition';
export type Currentness = 'matches' | 'changed' | 'missing' | 'unknown';
export type OutputCurrentness = Currentness;
export type ImpactRequest = { sources: SourceKey[]; currentness?: 'all' | 'current' | 'historical'; limit?: number; cursor?: string };
export type ImpactData = {
  as_of: string;
  outputs: Array<{ receipt: OutputReceipt; currentness: Currentness;
    inputs: Array<{ input_id: string; role: InputRole | null; comparison: Comparison; reason: string }>;
    inputs_truncated: boolean; dependency_coverage: BundleV1['dependency_coverage'] | 'unknown' }>;
  comparisons: number; next_cursor: string | null; truncated: boolean;
  coverage: 'captured_direct_dependencies_only';
};
export type PayloadReference = { id: string; kind: string; bytes: number; digest: string | null; availability: PreparedReceipt['availability'] };
export type InputMetadata = { comparison?: Comparison; id: string; source_id: string | null; source: SourceKey | null;
  role: InputRole | null; selection: string | null; origin: 'identified' | 'opaque' | null;
  truncated: boolean | null; retained_bytes: number | null; observation_digest: string | null;
  observed_at: string | null; label: string | null; path: string | null;
  /** Where the input begins in the request; absent from Engines before #551. */
  position?: { field: string; start: number } | null };
export type OutputSummary = { receipt: OutputReceipt; availability: PreparedReceipt['availability']; currentness: Currentness };
export type PurgeScope = { source_ids: string[] } | { derivation_ids: string[] };
export type PurgePreview = { dry_run: true; scope_token: string; derivation_ids: string[]; source_ids: string[];
  payload_bytes: number; truncated: boolean; composite_loss: true };
export type PurgeReceipt = { id: string; scope_token: string; committed_at: string; source_ids: string[]; derivation_ids: string[] };
export type PurgeRequest = { scope: PurgeScope; dry_run?: boolean; scope_token?: string; confirm?: boolean };
export type InspectData =
  | RefreshTargetData
  | InputTextData
  | { select: 'status'; capability_version: 1; inspection_features?: string[]; capture_features?: string[]; vault_namespace: string; limits: Record<string, number>;
      actual_bytes: number; reserved_bytes: number; purge_restore_verification: 'unverified' }
  | { select: 'attempt'; attempt: AttemptSummary | null }
  | { select: 'output'; compared_at?: string; output: OutputSummary; inputs: InputMetadata[]; inputs_truncated: boolean;
      next_cursor: string | null; payloads: PayloadReference[]; omissions: BundleV1['omissions']; dependency_coverage: BundleV1['dependency_coverage'] | 'unknown' }
  | { select: 'node'; outputs: OutputSummary[]; current_provenance: 'captured' | 'unknown_legacy' | 'not_recorded' | 'unavailable' | 'unknown'; next_cursor: string | null }
  | { select: 'text'; payload_id: string; availability: PreparedReceipt['availability']; text: string | null;
      digest: string | null; start: number; end: number; next_cursor: string | null }
  | { select: 'purge_receipts'; receipts: PurgeReceipt[]; next_cursor: string | null };
