import type { ProvenanceBinding } from '../provenance/types.js';
import type { ThemedPageKind, WikiOrigin, WikiState } from './digest.js';
import type { WikiScopeErrorCode, WikiScopeV1 } from './scope.js';

export type { ThemedPageKind, WikiOrigin, WikiState } from './digest.js';

export const THEMED_PAGE_KINDS = {
  workstream: 'workstream',
  'decision-log': 'decision-log',
  'risk-register': 'risk-register',
  timeline: 'timeline',
  'stakeholder-map': 'stakeholder-map',
  spotlight: 'spotlight',
  freeform: 'freeform',
} as const satisfies Readonly<Record<ThemedPageKind, ThemedPageKind>>;

export const WIKI_STATES = {
  active: 'active',
  dormant: 'dormant',
  retired: 'retired',
} as const satisfies Readonly<Record<WikiState, WikiState>>;

export const WIKI_ORIGINS = {
  automatic: 'automatic',
  requested: 'requested',
} as const satisfies Readonly<Record<WikiOrigin, WikiOrigin>>;

export type WikiReconcileSection = {
  readonly name: string;
  readonly mode: 'replace' | 'append';
  readonly content: string;
};

export type WikiReconcileExistingTarget = {
  readonly mode: 'existing';
  readonly node_id: string;
  readonly expected_version: number;
};

export type WikiReconcileNewTarget = {
  readonly mode: 'new';
  readonly plan_key: string;
  readonly title: string;
};

export type WikiReconcileTarget = WikiReconcileExistingTarget | WikiReconcileNewTarget;

export type WikiReconcileSource = {
  readonly node_id: string;
  readonly expected_version: number;
};

export type WikiReconcileUpsert = {
  readonly op: 'upsert';
  readonly target: WikiReconcileTarget;
  readonly scope: WikiScopeV1;
  readonly kind: ThemedPageKind;
  readonly origin: WikiOrigin;
  readonly pinned: boolean;
  readonly sections?: readonly WikiReconcileSection[];
  readonly provenance?: ProvenanceBinding;
};

export type WikiReconcileMerge = {
  readonly op: 'merge';
  readonly target: WikiReconcileTarget;
  readonly sources: readonly WikiReconcileSource[];
  readonly scope: WikiScopeV1;
  readonly kind: ThemedPageKind;
  readonly origin: WikiOrigin;
  readonly pinned: boolean;
  readonly reason: string;
  readonly sections: readonly WikiReconcileSection[];
  readonly provenance?: ProvenanceBinding;
};

export type WikiReconcileRetire = {
  readonly op: 'retire';
  readonly node_id: string;
  readonly expected_version: number;
  readonly scope: WikiScopeV1;
  readonly state: 'dormant' | 'retired';
  readonly reason: string;
};

export type WikiReconcilePageOperation = WikiReconcileUpsert | WikiReconcileMerge | WikiReconcileRetire;

export type WikiReconcileHomeInput = {
  readonly provenance?: ProvenanceBinding;
  readonly expected_version?: number;
  readonly sections: readonly WikiReconcileSection[];
  readonly evidence_hash: string;
  readonly curated_at: string;
  readonly refresh_live: true;
  /** The home's `wiki_status` once this build is stamped (#547): `paused` for a paused
   * wiki's build, else `current`. Absent, a paused or paused-behind home stays paused and
   * any other becomes current. The status check then moves it on if the evidence has. */
  readonly status?: 'current' | 'paused';
  /** A new home is named "<root> Dossier" instead of "<root> Wiki" (#554). An existing home
   *  keeps its title and path whatever this says. */
  readonly title_suffix?: 'Dossier';
};

export type WikiReconcileInput = {
  readonly provenance_mode?: 'project-subpage-v1';
  readonly home_refresh?: { home_node_id: string; expected_output_revision_id: string; expected_topology_hash: string };
  /** Rewrite one existing page and nothing else: `pages` holds exactly that page, and `home` isn't written. */
  readonly page_refresh?: { page_node_id: string; expected_output_revision_id: string; expected_topology_hash: string };
  readonly project: string;
  readonly project_id?: string;
  readonly reconcile_key: string;
  readonly pages: readonly WikiReconcilePageOperation[];
  readonly home: WikiReconcileHomeInput;
  readonly dry_run?: boolean;
};

type ResolvedWikiReconcileUpsert = Omit<WikiReconcileUpsert, 'scope'> & {
  readonly scope: string;
};

type ResolvedWikiReconcileMerge = Omit<WikiReconcileMerge, 'scope'> & {
  readonly scope: string;
};

type ResolvedWikiReconcileRetire = Omit<WikiReconcileRetire, 'scope'> & {
  readonly scope: string;
};

export type ResolvedWikiReconcilePageOperation =
  | ResolvedWikiReconcileUpsert
  | ResolvedWikiReconcileMerge
  | ResolvedWikiReconcileRetire;

export type ResolvedWikiReconcileHome = WikiReconcileHomeInput & {
  readonly node_id: string | null;
};

export type ResolvedWikiReconcilePlan = {
  readonly provenance_mode?: 'project-subpage-v1';
  readonly home_refresh?: WikiReconcileInput['home_refresh'];
  readonly page_refresh?: WikiReconcileInput['page_refresh'];
  readonly provenance_request_digest?: string;
  readonly project: {
    readonly id: string;
    readonly title: string;
    readonly file_path: string;
  };
  readonly reconcile_key: string;
  readonly plan_digest: string;
  readonly pages: readonly ResolvedWikiReconcilePageOperation[];
  readonly home: ResolvedWikiReconcileHome;
};

export type WikiReconcileIssueCode =
  | 'HOME_REFRESH_INVALID'
  | 'PAGE_REFRESH_INVALID'
  | 'AMBIGUOUS_PROJECT'
  | 'BROKEN_REPLACEMENT_CHAIN'
  | 'DUPLICATE_NODE_PARTICIPATION'
  | 'DUPLICATE_PLAN_KEY'
  | 'EMPTY_MERGE_SOURCES'
  | 'EXPECTED_VERSION_MISMATCH'
  | 'HOME_EXPECTED_VERSION_MISMATCH'
  | 'HOME_EXPECTED_VERSION_REQUIRED'
  | 'INVALID_PLAN_KEY'
  | 'INVALID_SCOPE'
  | 'INVALID_TITLE'
  | 'NODE_NOT_IN_WIKI'
  | 'PINNED_RETIRE'
  | 'PROJECT_ID_MISMATCH'
  | 'PROJECT_NOT_FOUND'
  | 'RECONCILE_KEY_COLLISION'
  | 'RECONCILE_KEY_EMPTY'
  | 'REPLACEMENT_CYCLE'
  | 'SOURCE_TARGET_CONFLICT'
  | 'STALE_REPLACEMENT'
  | 'TITLE_COLLISION'
  | 'ROOT_TITLE_COLLISION';

export type WikiReconcileValidationIssue = {
  readonly code: WikiReconcileIssueCode;
  readonly message: string;
  readonly operation_index?: number;
  readonly node_id?: string;
  readonly plan_key?: string;
  readonly title?: string;
  readonly target?: string;
  readonly expected_version?: number;
  readonly current_version?: number;
  readonly scope_error?: WikiScopeErrorCode;
};

export type WikiReconcileValidationMarker = {
  readonly code: 'REPLACEMENT_ALREADY_SATISFIED';
  readonly operation_index: number;
  readonly node_id: string;
  readonly target: string;
};

export type WikiReconcileValidationResult =
  | {
      readonly ok: true;
      readonly plan: ResolvedWikiReconcilePlan;
      readonly markers: readonly WikiReconcileValidationMarker[];
    }
  | {
      readonly ok: false;
      readonly issues: readonly WikiReconcileValidationIssue[];
      readonly markers: readonly WikiReconcileValidationMarker[];
      readonly plan_digest?: string;
    };

export type ValidationResult = WikiReconcileValidationResult;
