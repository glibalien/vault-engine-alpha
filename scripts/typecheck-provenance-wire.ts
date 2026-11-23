// Type-only conformance. No deployable surface imports another.
import type * as Engine from "../packages/engine/src/provenance/types.js";
import type * as Curator from "../packages/curator/src/provenance-types.js";
type Assert<T extends true> = T;
type Match<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SourceKeyMatch = Assert<Match<Engine.SourceKey, Curator.SourceKey>>;
type SourceObservationMatch = Assert<Match<Engine.SourceObservation, Curator.SourceObservation>>;
type BundleV1Match = Assert<Match<Engine.BundleV1, Curator.BundleV1>>;
type PrepareRequestMatch = Assert<Match<Engine.PrepareRequest, Curator.PrepareRequest>>;
type PreparedReceiptMatch = Assert<Match<Engine.PreparedReceipt, Curator.PreparedReceipt>>;
type StageRequestMatch = Assert<Match<Engine.StageRequest, Curator.StageRequest>>;
type ProvenanceBindingMatch = Assert<Match<Engine.ProvenanceBinding, Curator.ProvenanceBinding>>;
type OutputReceiptMatch = Assert<Match<Engine.OutputReceipt, Curator.OutputReceipt>>;
type PreparePreviewMatch = Assert<Match<Engine.PreparePreview, Curator.PreparePreview>>;
type AttemptSummaryMatch = Assert<Match<Engine.AttemptSummary, Curator.AttemptSummary>>;
type TransitionRequestMatch = Assert<Match<Engine.TransitionRequest, Curator.TransitionRequest>>;
type InspectRequestMatch = Assert<Match<Engine.InspectRequest, Curator.InspectRequest>>;
type InspectDataMatch = Assert<Match<Engine.InspectData, Curator.InspectData>>;
type ImpactRequestMatch = Assert<Match<Engine.ImpactRequest, Curator.ImpactRequest>>;
type ImpactDataMatch = Assert<Match<Engine.ImpactData, Curator.ImpactData>>;
type PurgeRequestMatch = Assert<Match<Engine.PurgeRequest, Curator.PurgeRequest>>;
type PurgePreviewMatch = Assert<Match<Engine.PurgePreview, Curator.PurgePreview>>;
type PurgeReceiptMatch = Assert<Match<Engine.PurgeReceipt, Curator.PurgeReceipt>>;

import type * as Query from '../packages/query-core/src/provenance-types.js';
type ReadSelectors = 'status' | 'node' | 'output' | 'input_text' | 'refresh_target';
type InspectorRequestsMatch = Assert<Match<Extract<Engine.InspectRequest, {select:ReadSelectors}>, Query.ProvenanceInspectRequest>>;
type InspectorDataMatch = Assert<Match<Extract<Engine.InspectData, {select:ReadSelectors}>, Query.ProvenanceInspectData>>;
type QueryImpactRequestMatch = Assert<Match<Engine.ImpactRequest, Query.ProvenanceImpactRequest>>;
type QueryImpactDataMatch = Assert<Match<Engine.ImpactData, Query.ProvenanceImpactData>>;
import type * as RefreshCurator from '../packages/curator/src/home-refresh-types.js';
import type * as RefreshQuery from '../packages/query-core/src/home-refresh-types.js';
type RefreshApiMatch = Assert<Match<RefreshCurator.HomeRefreshApi, RefreshQuery.HomeRefreshApi>>;

import type * as EngineWiki from '../packages/engine/src/wiki/reconcile.js';
import type * as EngineWikiInput from '../packages/engine/src/wiki/reconcile-types.js';
import type * as CuratorWiki from '../packages/curator/src/engine.js';
type ProvenanceFlowMatch = Assert<Match<Engine.ProvenanceFlow, Curator.ProvenanceFlow>>;
type CaptureTargetMatch = Assert<Match<Engine.CaptureTarget, Curator.CaptureTarget>>;
type OutputCurrentnessMatch = Assert<Match<Engine.OutputCurrentness, Curator.OutputCurrentness>>;
type ReconcileInputMatch = Assert<Match<EngineWikiInput.WikiReconcileInput, CuratorWiki.WikiReconcileInput>>;
type ReconcileResultMatch = Assert<Match<EngineWiki.WikiReconcileResult, CuratorWiki.WikiReconcileResult>>;

declare const legacyPrepare: Engine.PrepareRequest;
declare const legacyReconcile: EngineWikiInput.WikiReconcileInput;
declare const legacyResult: EngineWiki.WikiReconcileResult;
const curatorLegacyPrepare: Curator.PrepareRequest = legacyPrepare;
const curatorLegacyReconcile: CuratorWiki.WikiReconcileInput = legacyReconcile;
const curatorLegacyResult: CuratorWiki.WikiReconcileResult = legacyResult;
const subpagePrepare: Engine.PrepareRequest = {
  ...legacyPrepare, flow: 'project-subpage-v1',
  bundle: { ...legacyPrepare.bundle, target: { plan_key: 'page-1' } },
};
const curatorSubpagePrepare: Curator.PrepareRequest = subpagePrepare;
const subpageReconcile: EngineWikiInput.WikiReconcileInput = {
  ...legacyReconcile, provenance_mode: 'project-subpage-v1',
};
const curatorSubpageReconcile: CuratorWiki.WikiReconcileInput = subpageReconcile;
const subpageResult: EngineWiki.WikiReconcileResult = {
  ...legacyResult, provenance_receipts: [], current_outputs: {},
};
const curatorSubpageResult: CuratorWiki.WikiReconcileResult = subpageResult;
void [curatorLegacyPrepare, curatorLegacyReconcile, curatorLegacyResult,
  curatorSubpagePrepare, curatorSubpageReconcile, curatorSubpageResult];

// The legacy selector omits comparisons; publication transitions use the same
// wire enum for old home outputs and newly captured merge-source inputs.
type ComparisonMatch = Assert<Match<Engine.Comparison, Query.Comparison>>;
type InputMetadataMatch = Assert<Match<Engine.InputMetadata, Query.InputMetadata>>;
const legacyOutputRead: Query.ProvenanceInspectRequest = { select: 'output', output_revision_id: 'legacy-home' };
const subpageOutputRead: Curator.InspectRequest = { ...legacyOutputRead, include_comparisons: true };
const publicationTransition: Query.Comparison = 'expected_self_transition';
void [subpageOutputRead, publicationTransition];
