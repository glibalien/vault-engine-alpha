import type { TopicEvidenceDiagnostics } from './topic-evidence-diagnostics.js';
import type { TopicEvidenceSource } from './topic-evidence-selection.js';
import type { SourceObservation, OutputReceipt, ProvenanceBinding } from './provenance-types.js';
// Shared shapes for the curator. Engine payloads are typed loosely (only the
// fields we actually read) since the engine owns the full schema.
// allow: SIZE_OK — central pure declaration table with no runtime logic.
import type { Issue } from '@vault/contract';
import type { CanonicalWebProbe } from './topic-refresh-evidence.js';
import type { TopicRefreshAdmissionWarning, TopicRefreshTrigger } from './topic-refresh-admission.js';
import type { TopicWebMaterialityAssessment } from './topic-refresh-assessment.js';

/** What the caller/sweep asks curateTopic to build. */
export interface TopicSpec {
  brief?: string;
  source: 'vault' | 'vault+web';
  cadence?: string | null;
}

/** One web-search result (mirrors the engine's WebSearchResult wire shape). */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
}

/** A cited external source on a vault+web topic wiki. */
export interface WebSource { title: string; url: string }
/** Rendered web evidence for a vault+web topic refresh. */
export interface WebEvidence {
  evidenceSources?: readonly TopicEvidenceSource[];
  webText: string;
  sources: WebSource[];
  resultCount: number;
  /** Present only when web-search completed and produced a canonical baseline. */
  probe?: CanonicalWebProbe;
}

// A durable memory row (engine `memories` table, source='curator' rows are ours).
// Defined locally — the curator can't import types from the engine package.
// NOTE: list-memories returns a PARSED `metadata` field (see `toMemory` in
// packages/engine/src/mcp/tools/memories.ts), not the raw `metadata_json`
// column — match the actual wire shape here.
export interface Memory {
  readonly provenance_observation?: SourceObservation;
  id: number;
  source: string;
  scope: 'vault' | 'node';
  node_id: string | null;
  content: string;
  category: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  /** ISO timestamp the fact became true (engine `valid_at`); absent on older payloads. */
  valid_at?: string | null;
  /** Set on a memory another replaced (#717): when it stopped being true, when it was expired, and why. */
  invalid_at?: string | null;
  expired_at?: string | null;
  expire_reason?: string | null;
  /** The memory that replaced it, when one did. */
  superseded_by?: number | null;
  /** Provenance kind — 'note' | 'curation-run' on the engine side (Memories v3 §3); absent on older payloads. */
  evidence_kind?: string;
  /** The note it was drawn from, when the Engine gives it. */
  evidence_node_id?: string | null;
  /** Set by a project wiki build, not the Engine (#474 idea 4): the day the memory became true and
   *  where it came from, as its line in a wiki prompt shows them. */
  source_label?: string;
}

export interface ProjectRef {
  /** Stable Engine node ID when known; null for title-only callers before evidence resolution. */
  id: string | null;
  title: string;
  file_path: string;
  status: string | null;
}

/** Conversation metadata as returned by the engine's list-conversations /
 *  get-conversation tools. `archived` is 0|1 (SQLite integer boolean). */
export interface ConversationMeta {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived: number;
  /** Monotonic Engine authority revision returned by get-conversation and linked list reads. */
  revision?: number;
  linked_docs?: string[];
}

/** Exact conversation state which Engine must verify in the mutation transaction. */
export interface ConversationAuthorityGuard {
  conversationId: string;
  expectedRevision: number;
  expectedLinkMode: 'bound' | 'unbound';
  expectedLinkedDocs: string[];
}

/** Typed create-node input shared by live creation and dry-run previews. */
export interface CreateNodeArgs {
  title: string;
  types: string[];
  fields?: Record<string, unknown>;
  body?: string;
  directory?: string;
  conversationAuthority?: ConversationAuthorityGuard;
}

/** Engine dry-run create-node result: no node exists yet. */
export interface CreateNodePreview {
  dry_run: true;
  would_create: { file_path: string; conflict?: string };
  warnings: Issue[];
}

/** Engine live create-node result, including non-fatal validation warnings. */
export interface CreateNodeResult {
  node_id: string;
  file_path: string;
  warnings: Issue[];
}

/** A cheap candidate row from the sweep's changed-node query (no body — fetch via getNode). */
export interface ChangedNodeRef {
  id: string;
  title: string;
  file_path: string;
  /** Epoch ms, as query-nodes reports it; absent when the engine omits it. */
  file_mtime?: number;
}

/** One row of the engine's schema catalog (org-sweep routing table). */
export interface SchemaRef {
  name: string;
  display_name: string | null;
  default_directory: string | null;
}

/** A cheap org-sweep candidate row (typing + move passes). */
export interface OrgNodeRef {
  id: string;
  title: string;
  file_path: string;
  types: string[];
  version: number;
}

/** A note as a memory extraction run lists it (#659): undefined `content_hash` means an Engine too old to say. */
export interface HashedNodeRef extends OrgNodeRef {
  content_hash?: string | null;
}

// A wiki sub-page as surfaced by project-evidence. file_path +
// wiki_state shipped with the engine's Track 3 step 1; older payloads omit them.
export interface WikiSubpageRef {
  id: string;
  title: string;
  file_path?: string;
  wiki_state?: string;
  wiki_kind?: string;
}

// Curator-local mirrors of the engine wiki catalog wire contract. The curator
// remains an independent MCP client and must not import engine source types.
export interface WikiScopeV1 {
  v: 1;
  subject: string;
  facet: string;
  timeframe?: string;
  geography?: string;
  entities?: string[];
  exclusions?: string[];
}

export type WikiScopeErrorCode =
  | 'MALFORMED_JSON'
  | 'INVALID_SCOPE'
  | 'UNSUPPORTED_VERSION'
  | 'MISSING_SUBJECT'
  | 'MISSING_FACET'
  | 'INVALID_SCALAR'
  | 'INVALID_ARRAY';

export interface WikiCatalogPage {
  id: string;
  title: string;
  file_path: string;
  version: number;
  content_hash: string;
  wiki_state: 'active' | 'dormant' | 'retired';
  wiki_kind?: ThemedPageKind;
  wiki_origin: 'automatic' | 'requested';
  wiki_scope?: WikiScopeV1;
  wiki_scope_raw?: string;
  wiki_scope_error?: WikiScopeErrorCode;
  wiki_replaced_by?: { id?: string; title: string };
  wiki_pinned: boolean;
  summary?: string;
}

export interface WikiCatalogHome {
  id: string;
  version: number;
  wiki_evidence_hash?: string;
  wiki_topology_hash?: string;
  wiki_curated_at?: string;
  wiki_reconcile_key?: string;
}

export interface ExistingWiki {
  home_id: string | null;
  home: WikiCatalogHome | null;
  topology_hash: string;
  catalog_valid: boolean;
  subpages: WikiCatalogPage[];
}

export interface SuggestedRead {
  id: string;
  title: string;
  reason: string;
}

/** The day and day-count windows Engine cut the task buckets with (#448). */
export interface DigestWindows {
  today: string;
  time_zone: string;
  stale_days: number;
  upcoming_days: number;
  recent_days: number;
}

export interface ProjectDigest {
  project: { id: string; title: string; file_path: string };
  /** Absent on Engines that predate configurable windows (#448). */
  windows?: DigestWindows;
  tasks: Record<string, Array<{ id: string; title: string; status: string | null; due: string | null; file_mtime?: number | null }>>;
  /** `project_count`: how many projects the note is filed under (#474); absent on older Engines. */
  notes: Array<{ id: string; title: string; file_mtime?: number | null; project_count?: number }>;
  signals: { overdue_count: number; blocked_count: number; churn_rate: number };
  existing_wiki: { home_id: string | null; subpages: WikiSubpageRef[] };
  synthesis_hints: {
    suggested_reads: SuggestedRead[];
    overdue_task_ids: string[];
    recently_done_ids: string[];
    // Deterministic importance ranking — project-evidence only; a bare digest omits it.
    salience?: SalienceEntry[];
  };
}

// --- Engine project-evidence projections (vault-engine main 2026-06-15). All
// optional on the curator side: older engine payloads omit them. ---

export interface SalienceEntry {
  id: string;
  title: string;
  score: number;
  components: { recency: number; degree: number; urgency: number };
}

export interface RiskProxy {
  id: string;
  title: string;
  status: string | null;
  due: string | null;
  priority: string | null;
  scheduled: string | null;
  bucket: 'overdue' | 'blocked';
  blocked: boolean;
}

export interface TimelineItem {
  id: string;
  title: string;
  date: string;
  type: 'task' | 'meeting';
}

export interface SignalsDetail {
  risk_proxies: RiskProxy[];
  timeline: TimelineItem[];
}

export interface ChangedNode {
  id: string;
  title: string;
  type: string;
  file_mtime: number;
  modified: string;
}

export interface ChangedSinceCuration {
  since: string;
  buckets: Record<string, ChangedNode[]>;
}

export interface EvidenceContact {
  id: string;
  title: string;
  companies: string[];
  direct: boolean;
  meeting_count: number;
  last_seen: number | null;
}

/** Someone the project or its meetings name in the people field who has no note (#474 idea 4). */
export interface UnlinkedContact {
  name: string;
  /** Named in the project's own people field. */
  direct: boolean;
  /** Project meetings that name them. */
  meeting_count: number;
}

export interface EvidenceMeeting {
  id: string;
  title: string;
  date: string | null;
  file_mtime: number | null;
  attendees: string[];
  /** How many projects the meeting is filed under (#474); absent on older Engines. */
  project_count?: number;
}

/** Per-component fingerprints of the Engine evidence_hash inputs. */
export interface EvidenceComponents {
  status: string;
  tasks: string;
  notes: string;
  meetings: string;
  contacts: string;
}

// project-evidence is a structural superset of the engine's project digest.
export interface ProjectEvidence extends ProjectDigest {
  readonly provenance_observations?: {
    readonly nodes: Readonly<Record<string, SourceObservation>>;
    readonly truncated: boolean;
    readonly aggregate_coverage: 'opaque';
  };
  project: ProjectDigest['project'] & { status: string | null };
  meetings: { recent: EvidenceMeeting[]; upcoming: EvidenceMeeting[] };
  /** `unlinked` is absent on Engines before #474's people block. */
  contacts: { people: EvidenceContact[]; companies: Array<{ id: string; title: string }>; unlinked?: UnlinkedContact[] };
  evidence_hash: string;
  /** Absent on Engines that predate component fingerprints. */
  evidence_components?: EvidenceComponents;
  generated_at: string;
  // Grounded projections (optional — present only on the new engine, and
  // changed_since_curation only when a `since` was passed).
  signals_detail?: SignalsDetail;
  changed_since_curation?: ChangedSinceCuration;
  closed_since?: Array<{ id: string; title: string; status: string | null; due: string | null; closed_at: number }>;
}

// The archetype palette. `workstream` is the rich persistent sub-wiki; the others
// are sharper single-purpose pages; `freeform` is the catch-all.
export type ThemedPageKind =
  | 'workstream'
  | 'decision-log' | 'risk-register' | 'timeline'
  | 'stakeholder-map' | 'spotlight' | 'freeform';

export type NodeRef = { node_id: string } | { plan_key: string };

export type TopologyAction =
  | { op: 'keep'; node_id: string; scope: WikiScopeV1 }
  | { op: 'refresh'; node_id: string; scope: WikiScopeV1; synthesis_brief: string; evidence_ids?: string[]; rule_ids?: number[] }
  | { op: 'reactivate'; node_id: string; scope: WikiScopeV1; synthesis_brief: string; evidence_ids?: string[]; rule_ids?: number[] }
  | { op: 'create'; plan_key: string; title: string; kind: ThemedPageKind; scope: WikiScopeV1; synthesis_brief: string; evidence_ids?: string[]; rule_ids?: number[] }
  | { op: 'merge'; target: NodeRef; sources: string[]; scope: WikiScopeV1; reason: string; synthesis_brief: string; evidence_ids?: string[]; rule_ids?: number[] }
  | { op: 'retire'; node_id: string; scope: WikiScopeV1; state: 'dormant' | 'retired'; reason: string };

export interface TopologyPlan {
  reviewed_page_ids: string[];
  actions: TopologyAction[];
}

export type ScopeRelation = 'same-scope' | 'substantial-overlap' | 'containment' | 'distinct';

export interface AdjudicationVerdict {
  candidate_plan_key: string;
  compared_to: NodeRef;
  relation: ScopeRelation;
  confidence: number;
  evidence_ids: string[];
  reason: string;
}

export interface PageSynthesisRequest {
  target: NodeRef;
  title: string;
  kind: ThemedPageKind;
  scope: WikiScopeV1;
  synthesis_brief: string;
  evidence_ids: string[];
}

export interface PageSynthesisResult {
  provenance?: ProvenanceBinding;
  target: NodeRef;
  /** Written as a bounded rewrite: current text plus only the notes changed since (#352). */
  rewrite?: true;
  body: string;
  log_note?: string;
  usage: TokenUsage;
}

type StableTopologyResult = {
  node_id: string;
  title: string;
  scope: WikiScopeV1;
  kind?: ThemedPageKind;
  detail?: string;
};

export type TopologyResult =
  | (StableTopologyResult & {
      action: 'kept' | 'adopted' | 'created' | 'refreshed' | 'reactivated' | 'dormant' | 'retired';
    })
  | (StableTopologyResult & {
      action: 'merged-source';
      target_node_id: string;
      target_title: string;
    })
  | (StableTopologyResult & {
      action: 'merged-target';
      source_node_ids: string[];
    })
  | {
      action: 'ambiguous-create-skipped';
      plan_key: string;
      title: string;
      scope: WikiScopeV1;
      reason: string;
      verdict?: AdjudicationVerdict;
    }
  | {
      action: 'preview';
      target: NodeRef;
      title: string;
      scope: WikiScopeV1;
      detail?: string;
    }
  | {
      action: 'error';
      title?: string;
      node_id?: string;
      detail: string;
    };

export interface EngineNode {
  readonly provenance_observation?: SourceObservation;
  id: string;
  title: string | null;
  file_path?: string;
  types: string[];
  /** Node version for optimistic-concurrency expected_version guards. */
  version?: number;
  fields: Record<string, { value: unknown } | unknown>;
  relationships?: {
    outgoing: Record<string, Array<{
      target_id: string | null;
      target_title: string;
      context?: string;
    }>>;
    incoming: Record<string, Array<{
      source_id: string;
      source_title: string | null;
      context?: string;
    }>>;
  };
  body: string | null;
  /** get-node wire metadata; content_hash drives the sweep's idempotency ledger. */
  metadata?: {
    content_hash?: string | null;
    /** The note's text with each link read as the words it shows (#332): what wikis compare. Absent from an older Engine. */
    text_hash?: string | null;
    file_mtime?: number | null;
    indexed_at?: number | null;
  } | null;
}

/** Default query-nodes projection: identity metadata only, never node body/fields. */
export interface EngineNodeSummary {
  id: string;
  title: string | null;
  file_path: string;
  types: string[];
  version: number;
  field_count: number;
}

// A semantically-related-but-unlinked node surfaced by gap-fill. `body` is
// attached only for the top few candidates (semanticGapFillBodyReads).
export interface GapFillCandidate {
  readonly provenance_observation?: SourceObservation;
  readonly provenance_truncated?: boolean;
  readonly provenance_original_bytes?: number;

  id: string;
  title: string;
  types: string[];
  status: string | null;
  match_sources?: string[];
  body?: string;
}

// The four narrative sections the curator synthesizes. Mirrors wiki-write's
// managed sections (Now/Focus/Open threads replace; Log appends).
// at_a_glance is OPTIONAL — prepended as the top managed section when present.
export interface WikiSections {
  now: string;
  focus: string;
  open_threads: string;
  log_entry: string;
  at_a_glance?: string;
  /** OPTIONAL managed "Sources" section (vault+web topic wikis only). Markdown list of cited external sources. */
  sources?: string;
}

// A themed sub-page the home-synthesis pass proposes to create/update. The model
// emits a short free-form `title`; the curator project-qualifies it before writing.
export interface ThemedPageProposal {
  kind: ThemedPageKind;
  title: string;
  body: string;
  log_note: string;
  state: 'active' | 'dormant' | 'retired';
}

// An existing themed sub-page the home-synthesis pass proposes to wind down. The
// model echoes the EXACT stored (already-qualified) title shown in the evidence.
export interface RetirePageProposal {
  title: string;
  state: 'dormant' | 'retired';
  reason: string;
}

// A durable memory the home/topic synthesis pass proposes to persist (v1.5).
// The model emits `content` (+ optional category); the curator node-scopes it to
// the wiki being curated. Category is normalized to one of these values; the memory sweeps
// also use it, and only they are asked for `rule` (#626).
export interface MemoryProposal {
  content: string;
  category: 'fact' | 'preference' | 'rule' | 'note';
  /** Who or what the fact is about, by name (#554): only the memory sweeps are asked for them. */
  subjects?: string[];
}

// Outcome of one curator memory-write attempt, captured on CurateResult (v1.5).
export interface MemoryWriteResult {
  content: string;
  /** `created`: a memory was written (new, or replacing an older one). `noop`: the Engine's
   *  consolidation model judged it already known and wrote nothing. `duplicate`: the Engine's
   *  vector/text dedup rejected it before any model call. */
  action: 'created' | 'noop' | 'duplicate' | 'preview' | 'error';
  detail?: string;
  /** Set when the Engine added this memory without merging it because its consolidation call
   *  failed: the Engine's warning, with the provider's reason (#346). */
  consolidationFailure?: string;
}

// Outcome of one legacy-spine migration action (Task Board / Meetings cleanup).
export interface LegacySpineResult {
  title: string;
  action: 'retired' | 'preview' | 'error';
  detail?: string;
}

// Outcome of one themed-page write or retirement, captured on CurateResult.
export interface ThemedPageResult {
  kind: ThemedPageKind; // archetype, carried through for observability
  title: string; // project-qualified stored title
  action: 'created' | 'updated' | 'retired' | 'dormant' | 'skipped' | 'preview' | 'error';
  state?: string;
  detail?: string;
}

// Normalized token counts from one LLM call (cache-aware; uncached input
// and cache read/write are reported separately by the API and priced differently).
export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface TopologyPlanUsage {
  planner: TokenUsage;
  adjudicator: TokenUsage;
  page: TokenUsage;
  home: TokenUsage;
}

/** `synthesis_brief_chars`: the length of a writing action's brief, which is not itself kept (#633). */
export type PlanningActionAudit =
  | { readonly op: 'keep' | 'refresh' | 'reactivate' | 'retire'; readonly node_id: string; readonly scope: WikiScopeV1; readonly synthesis_brief_chars?: number }
  | { readonly op: 'create'; readonly plan_key: string; readonly title: string; readonly kind: ThemedPageKind; readonly scope: WikiScopeV1;
    readonly synthesis_brief_chars?: number }
  | { readonly op: 'merge'; readonly target: NodeRef; readonly sources: readonly string[]; readonly scope: WikiScopeV1;
    readonly synthesis_brief_chars?: number };

export type PlanningIssueAudit = {
  readonly code: string;
  readonly action_index?: number;
  readonly node_id?: string;
  readonly plan_key?: string;
};

export type PlanningAttemptTopologyAudit = {
  readonly phase: string;
  readonly attempt: number;
  readonly plan: {
    readonly reviewed_page_ids: readonly string[];
    readonly actions: readonly PlanningActionAudit[];
  };
  readonly issues: readonly PlanningIssueAudit[];
};

export type TopologyAudit = {
  readonly provenanceReceipt?: OutputReceipt;
  readonly provenanceReceipts?: readonly OutputReceipt[];
  readonly catalog: {
    readonly valid: boolean;
    readonly missing_scope_node_ids: readonly string[];
  };
  readonly proposedReviewedPageIds?: readonly string[];
  readonly finalReviewedPageIds?: readonly string[];
  readonly proposedActions: readonly TopologyAction[];
  readonly finalActions: readonly TopologyAction[];
  readonly planningAttempts?: readonly PlanningAttemptTopologyAudit[];
  readonly adjudicationVerdicts: readonly AdjudicationVerdict[];
  readonly validationIssueCodes: readonly string[];
  readonly reconcileKey?: string;
  readonly warnings: readonly string[];
  readonly enginePreview?: {
    readonly total: number;
    readonly items: readonly {
      readonly op: 'upsert' | 'merge' | 'retire';
      readonly target: string;
      readonly title: string;
      readonly source_count?: number;
      readonly state?: 'dormant' | 'retired';
    }[];
    readonly truncated: boolean;
  };
  readonly homePreview?: { readonly title: string; readonly created: boolean };
  readonly mappings?: readonly { readonly source_node_id: string; readonly target_node_id: string; readonly target_title: string }[];
  readonly operationId?: string | null;
};

export interface CurateResult {
  evidenceSelection?: TopicEvidenceDiagnostics;
  project: string;
  /** would_curate: a dry run found work to do and stopped before any model call.
   *  skipped_failure_hold: a scheduled run skipped evidence whose last run already failed after paid calls.
   *  skipped_budget: the daily budget refused the work; any spend before the refusal is still reported.
   *  refreshed_live: only task evidence changed, so only Engine live sections were re-rendered (no model call). */
  outcome: 'written' | 'skipped' | 'skipped_cadence_not_due' | 'skipped_mode_disabled' | 'skipped_failure_hold'
    | 'skipped_budget' | 'refreshed_live' | 'would_curate' | 'error';
  /** Evidence the narrative was written from; recorded so later runs can tell which part changed. */
  evidenceComponents?: EvidenceComponents;
  /** Components that differ from the last narrative's evidence, when known. */
  changedComponents?: Array<keyof EvidenceComponents>;
  /** Page creates the per-run cap left for the next run (written runs only). */
  deferredCreates?: number;
  detail?: string;
  dryRun: boolean;
  // The synthesized sections, attached on success so --dry-run can preview them.
  sections?: WikiSections;
  // Token usage + estimated USD for the synthesis call, when one was made.
  usage?: TokenUsage;
  costUsd?: number | null;
  /** A forced dry run only: nothing has changed since the last build, so only force would run it. */
  evidenceUnchanged?: boolean;
  /** The wiki output policy this run used, so the failure hold can tell when it changed. */
  outputPolicyHash?: string;
  // Themed-page create/update/retire outcomes (step 5).
  themed?: ThemedPageResult[];
  topology?: TopologyResult[];
  topologyHash?: string;
  topologyAudit?: TopologyAudit;
  // Legacy-spine migration outcomes (one-time Task Board / Meetings cleanup).
  legacy?: LegacySpineResult[];
  // wiki_curated_at relevant at decision time: stored value when skipped, now()
  // when freshly written, null when no wiki / error. Drives backlog staleness.
  wikiCuratedAt?: string | null;
  // Evidence fingerprint at curation time (intrinsic — only curateProject knows
  // it). Surfaced so the sweep wrapper can record it on the run row.
  evidenceHash?: string;
  // Durable memories the curator persisted this run (v1.5). Omitted when none.
  memories?: MemoryWriteResult[];
  // The run-correlation UUID stamped by the timed wrappers in core.ts (shared
  // with the usage reporter and journal recorder). Absent when the run never
  // entered a timed wrapper (e.g. paused-skip).
  runRef?: string;
  /** Closed, body-free topic refresh observability. Absent for legacy/project results. */
  refreshTrigger?: TopicRefreshTrigger;
  changedSourceNodeIds?: string[];
  webAssessment?: TopicWebMaterialityAssessment;
  refreshWarnings?: TopicRefreshAdmissionWarning[];
  /** The sub-pages a written project build wrote, the ones it rewrote from changed notes, and the
   *  content hash of each note the build read: recorded so the next build rewrites each page from
   *  only what changed since (#352). */
  /** `pageNotes`: the notes a page read when its writer read only the ones the planner named
   *  (#474 idea 3); a page without an entry read them all. */
  pageNoteStates?: { written: string[]; rewritten: string[]; notes: Record<string, string>; pageNotes?: Record<string, string[]> };
}
