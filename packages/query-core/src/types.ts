import type { ClassificationDependency, ClassificationDiscovery, EnumGroupsV1 } from './classification-types.js';
import type { RelationshipViewsDiscovery } from "./rollup-types.js";
// NOTE: Envelope/Issue are duplicated from @vault/contract ON PURPOSE, and must stay that way.
// The dependency-cruiser rule `query-core-is-shared-leaf` forbids this package from importing
// ANY other workspace package — including contract — so "reconciling" them by sharing the type
// is not available; CI would reject it. (A prior TODO here asked for exactly that.)
//
// The duplication is near-exact: `Issue` is identical, and `Envelope`'s failure `code` is widened
// to `string` here where contract closes it to its `ErrorCode` union. That widening is deliberate
// too — a leaf package cannot name the union, and query-core only ever forwards the code.
// If contract's shape changes, mirror it here by hand and keep this note honest.

/**
 * Kit types — engine envelope/schema mirrors shared by every MCP-App UI
 * surface. Surface-specific state types stay in each surface's types.ts.
 */

// Envelope (mirrors src/mcp/tools/errors.ts)
export type Envelope<T> =
  | { ok: true; data: T; warnings: Issue[] }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> }; warnings: Issue[] };

export interface Issue {
  code: string;
  message: string;
  severity: "error" | "warning";
  field?: string;
  details?: unknown;
}

// describe-schema shape
export type FieldType = "string" | "enum" | "number" | "date" | "boolean" | "reference" | "list";
export type WidgetValue = "text" | "textarea" | "enum" | "date" | "number" | "bool" | "link" | "tags";

export interface UiHints {
  widget?: WidgetValue;
  label?: string;
  help?: string;
  order?: number;
}

export interface SchemaField {
  enum_groups_override?: EnumGroupsV1 | null;
  name: string;
  type: FieldType;
  required: boolean;
  default_value: unknown;
  enum_values?: string[];
  reference_target?: string;
  list_item_type?: FieldType;
  label?: string;
  description?: string;
  ui: UiHints | null;
}

export interface Schema {
  classification?: ClassificationDiscovery;
  relationship_views?: RelationshipViewsDiscovery;
  relationship_views_hash?: string;
  name: string;
  display_name: string | null;
  fields: SchemaField[];
}

/** Synthetic field name for title cells/edits. Single source of truth —
 *  do NOT redeclare locally (was duplicated in 6 files pre-kit). */
export const TITLE_FIELD = "__title__";

// ---- update-node result shapes (verified against engine) ----
export interface CoercedValue {
  field: string;
  value: unknown;
  original?: unknown;
  source: "provided" | "defaulted" | "orphan";
  changed: boolean;
  coercion_code?: string;
}

export interface FixableEntry {
  field: string;
  suggestion: unknown;
  allowed_values?: string[];
  field_type?: string;
}

export interface UpdatePreview {
  node_id: string;
  file_path: string;
  title: string;
  types: string[];
  coerced_state: Record<string, CoercedValue>;
  fixable: FixableEntry[];
  orphan_fields: string[];
}

export interface UpdateDryRunData { dry_run: true; preview: UpdatePreview; }

export interface UpdateCommitData {
  node_id: string;
  file_path: string;
  title: string;
  types: string[];
  coerced_state: Record<string, CoercedValue>;
  orphan_fields: string[];
  version?: number;
  references_updated?: number;
}

// ---- update-node reference_edit (engine src/mcp/tools/reference-edit.ts) ----
/** Add or remove ONE member of a list-of-references field. Adding names the target
 *  node; removing by `stored_value` matches the stored text exactly and needs both
 *  `expected_version` and `expected_content_hash`. */
export interface ReferenceMemberEdit {
  field: string;
  action: "add" | "remove";
  target: { node_id: string } | { stored_value: string };
}

export interface ReferenceEditCommitData {
  node_id: string;
  file_path: string;
  title: string;
  types: string[];
  coerced_state: Record<string, CoercedValue>;
  orphan_fields: string[];
  version: number;
  content_hash: string;
  reference_edit: ReferenceMemberEdit & {
    outcome: "added" | "removed" | "already_present" | "already_absent";
    changed: boolean;
  };
}

/** A member edit's preview (`dry_run: true`): what it would do, nothing written. */
export interface ReferenceEditPreviewData {
  dry_run: true;
  reference_edit: ReferenceMemberEdit & {
    outcome: "added" | "removed" | "already_present" | "already_absent";
    would_change: boolean;
  };
}

// ---- create-node result shapes (verified against engine 2026-06-08) ----
export interface CreateWouldCreate {
  file_path: string;
  title: string;
  types: string[];
  coerced_state: Record<string, CoercedValue>;
  fixable: FixableEntry[];
  orphan_fields: string[];
  conflict?: string;
}

export interface CreateDryRunData { dry_run: true; would_create: CreateWouldCreate; }

export interface CreateCommitData {
  node_id: string;
  file_path: string;
  title: string;
  types: string[];
  coerced_state: Record<string, CoercedValue>;
  orphan_fields: string[];
}

export interface CurrentNode {
  id: string;
  file_path: string;
  title: string | null;
  types: string[];
  fields: Record<string, unknown>;
  body: string | null;
  version: number;
  /** get-node's metadata. A removal by stored value sends `content_hash` back as a guard. */
  metadata?: { content_hash: string | null; file_mtime?: number | null; indexed_at?: number | null };
}

/** One memory, as list-memories returns it: the fields the clients read. */
export interface MemoryRow {
  id: number;
  content: string;
  category: string | null;
  created_at: string;
  valid_at: string | null;
  evidence_kind: string;
  evidence_node_id: string | null;
}

/** list-memories' data: the page of memories and how many match in all. */
export interface MemoryList {
  memories: MemoryRow[];
  total: number;
}

export interface StaleNodeDetails {
  current_version: number;
  expected_version: number;
  current_node?: CurrentNode;
}

/** A title edit's result: the update-node set_title commit fields the UI reads. */
export interface RenameData {
  node_id: string;
  file_path: string;
  title: string;
  references_updated?: number;
  version?: number;
}

// ---- filter chips (state model consumed by _kit/filters.ts + chips.ts) ----
export interface FilterChip { field: string; state: Record<string, unknown>; }

// ---- a field-scoped inline error (deciders return it; drafts/cells render it)
export interface DraftError { field: string; code: string; message: string; }

// ---- the slice of a pending edit the preview pill needs ----
export interface PillPending { value: unknown; warnings: Issue[]; reasons: string[]; }

// ---- a reference-picker suggestion (query-nodes row slice) ----
export interface RefCandidate { id: string; title: string; types: string[]; }

// ---- a link chip's picked identity target ----
export interface LinkTarget { id: string; title: string | null; }

/**
 * Surface types for the query-nodes table UI. Generic engine mirrors
 * (Envelope/Issue/Schema/tool result shapes/FilterChip/TITLE_FIELD) are
 * defined above; additional declarations for the query-nodes surface follow.
 */

// query-nodes shape we care about
export type QueryArgs = Record<string, unknown>;
import type { LinkCountRules, ServerSortBy } from "./link-counts.js";

// ---- caller-filter visibility (owned-args) ----
/** The five filter-strip-owned keys, always materialized (engine defaults), plus the link-count
 *  rules the Filter menu edits (absent when none is set). */
export interface StripState {
  title_contains: string;
  query: string;
  sort_by: ServerSortBy;
  sort_order: "asc" | "desc";
  limit: number;
  link_counts?: LinkCountRules;
}

/** An incoming query-nodes arg fragment the UI carries VERBATIM: visible as a
 *  dashed caller chip, removable, never interpreted. scope drives the
 *  type-switch rule: "schema" fragments drop on a switch to a different type
 *  (their field/rel_type names belong to the old type's schema), "global"
 *  ones survive. */
export interface CallerFragment {
  id: number;            // stable per-state id (removal-safe; assigned at parse)
  key: string;           // arg key it composes back into
  fieldName?: string;    // for `fields` operator remainders
  payload: unknown;      // carried verbatim — never interpreted
  scope: "schema" | "global";
}

export interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
  types: string[];
  version: number;
  field_count: number;
  fields?: Record<string, unknown>;
  score?: number;
  match_sources?: string[];
  snippet?: string;
}

export interface QueryNodesData {
  classification_dependencies?: ClassificationDependency[];
  nodes: NodeRow[];
  total: number;
}

// ---- settings (density popover) ----
export interface UiSettings {
  density: "compact" | "cozy" | "comfy";
  showRowNumbers: boolean;
  showVersion: boolean;
}

// ---- batch-mutate mirrors (update ops only — bulk edit never creates/deletes/renames) ----
export interface BatchOp {
  op: "update";
  params: {
    node_id: string;
    set_fields?: Record<string, unknown>;
    add_types?: string[];
    remove_types?: string[];
    expected_version?: number;
  };
}
export interface BatchWouldApply {
  op: string;
  node_id?: string;
  file_path?: string;
  fields_changed?: string[];
  types_after?: string[];
  body_changed?: boolean;
  title_changed?: boolean;
}
export interface BatchDryRunData {
  dry_run: true;
  op_count?: number;
  would_apply: BatchWouldApply[];
  // present when the dry run hit a failure mid-batch (still ok:true):
  failed_at?: number;
  op?: string;
  message?: string;
}
export interface BatchResult {
  op: string;
  op_index: number;
  status: "applied" | "stale";
  node_id?: string;
  file_path?: string;
  new_version?: number;
  details?: StaleNodeDetails;
}
export interface BatchCommitData { applied: true; results: BatchResult[]; }

// ---- bulk edit UI state ----
export type BulkPlan =
  | { kind: "setField"; field: string; value: unknown }
  | { kind: "addType"; type: string }
  | { kind: "removeType"; type: string };

export interface BulkState {
  plan: BulkPlan | null;
  /** Open picker in the bar: choosing the field/type, or editing the value. */
  picking: "field" | "value" | "addType" | "removeType" | null;
  /** Dry-run passed; awaiting Confirm. */
  pending: { wouldApply: number; warnings: Issue[] } | null;
  /** Dry-run or commit failure (BATCH_FAILED / failed_at). */
  failed: { nodeId: string | null; message: string } | null;
  busy: boolean;
}

// ---- a recorded op for client-side undo ----
export type RecentOp =
  | { kind: "edit"; nodeId: string; field: string; isTitle: boolean; prev: unknown; label: string }
  | { kind: "create"; nodeId: string; label: string }
  | { kind: "bulk"; label: string; inverse: BatchOp[] };

// ---- transient selection/edit pointers ----
export interface CellRef { id: string; field: string; }
export interface PendingEdit {
  id: string;
  field: string;
  value: unknown;          // coerced value to commit
  version: number;         // expected_version captured at promote time
  preview?: UpdatePreview; // dry-run preview (field edits); absent on uncorrelated dry-run error
  prevValue?: unknown;     // the row's ORIGINAL field value at promote time (undo fallback)
  warnings: Issue[];
  reasons: string[];
}
export interface CellError { id: string; field: string; code: string; message: string; }

// ---- B4 sub-table expansion ----
export interface ExpandPair { childType: string; viaField: string; }
export interface ExpandedGroup {
  childType: string;
  viaField: string;
  rows: NodeRow[];
  total: number;
  busy: boolean;
  /** CROSS_NODE_FILTER_UNRESOLVED surfaced on the expansion query. */
  unresolvedWarning: boolean;
}

// ---- new-node draft (the "+ New <type>" inline row) ----
export interface DraftState {
  title: string;                       // collected title
  fields: Record<string, unknown>;     // collected raw field values
  editing: string | null;              // open editor cell: "__title__" | field name | null
  error: DraftError | null;            // inline create error scoped to a field
  pending: { reasons: string[] } | null; // smart-confirm promote (awaiting confirm)
  busy: boolean;
}

// UI state owned by state.ts
export interface UiState {
  initialArgs: QueryArgs;          // verbatim caller args — the Reset source
  // Owned query state (owned-args). The query is ALWAYS composed from these —
  // there is no pass-through args object anymore.
  strip: StripState;
  typeSelection: string | null;    // explicit lock (single-types arg or user pick)
  callerFragments: CallerFragment[];
  lockedType: string | null;
  schemaCache: Map<string, Schema>;
  envelope: Envelope<QueryNodesData> | null;
  visibleColumns: Set<string> | null;

  // All node types in the vault (for the type-lock swap menu). Fetched once on
  // mount via listTypes (list-schemas); empty until then or on fetch failure.
  availableTypes: string[];

  // M2 — per-locked-type filter chips
  filtersByType: Record<string, FilterChip[]>;

  // M3 — edit/selection state (live overlays keyed by node id)
  values: Record<string, Record<string, unknown>>; // id -> field overrides applied post-commit
  titles: Record<string, string>;                  // id -> title override post-rename
  versions: Record<string, number>;                // id -> current version (post-commit)
  staleSet: Set<string>;                            // ids blocked by STALE_NODE
  staleNodes: Record<string, CurrentNode>;          // captured current_node from STALE errors (for reload)
  selected: CellRef | null;
  editing: CellRef | null;
  pending: PendingEdit | null;
  cellError: CellError | null;
  flash: Set<string>;                              // `${id}:${field}` recently committed
  recentOps: RecentOp[];
  // new-node draft row (null unless the user clicked "+ New <type>")
  draft: DraftState | null;

  // B4 — open sub-table expansions, keyed by parent node id (depth 1).
  expanded: Map<string, ExpandedGroup>;

  // B5b — bulk row selection (parent table only) + bulk-bar state.
  bulkSelected: Set<string>;
  bulk: BulkState | null;

  settings: UiSettings;
  busy: boolean;
}
