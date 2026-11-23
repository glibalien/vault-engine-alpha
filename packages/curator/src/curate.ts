import { prepareHomeEvidence } from './home-evidence.js';
export { gatherGapFillCandidates, gatherHomeReads } from './home-evidence.js';
import type { CorrectionInput } from './provenance-evidence.js';
import { randomUUID } from 'node:crypto';
import type { LlmClient } from './llm/types.js';
import type { Config } from './config.js';
import { Engine } from './engine.js';
import { SPEC_A_SYSTEM_PROMPT } from './synthesize.js';
import { runReconciliationPipeline, type BuildStatusHooks } from './reconciliation-pipeline.js';
import type { PageNoteBaseline } from './page-synthesis.js';
import { persistMemories } from './persist-memories.js';
import type { CurateResult, ExistingWiki, ProjectRef } from './types.js';
import type { DeferredCreates } from './db/deferred-creates.js';
import type { StageCheckpointStore } from './stage-checkpoints.js';
import { changedEvidenceComponents, type EvidenceManifest } from './db/evidence-manifests.js';
export { curateRequestedPage } from './requested-page.js';
export type { PageRequestSpec, RequestedPageOutcome } from './requested-page.js';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function promptOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

/**
 * Curate one project into a multi-page wiki spine. Gathers typed evidence in one
 * project-evidence call, gates on the engine's evidence_hash (stored on the wiki
 * home node), then synthesizes the home overview (strong model) and a short
 * "why it matters" brief per non-empty sub-page (cheap model). Sub-pages are
 * written first so the home's live sub-page index lists them; the home is written
 * last. Curation state is stamped only when every write succeeded. Never throws —
 * every outcome is captured in the returned CurateResult.
 */
export async function curateProject(
  engine: Engine,
  llm: LlmClient,
  config: Config,
  project: ProjectRef,
  dryRun: boolean,
  force = false,
  pinnedNodeIds: ReadonlySet<string> = new Set(),
  corrections: readonly string[] = [],
  runRef: string = randomUUID(),
  trackedCorrections?: readonly CorrectionInput[],
  options: {
    readonly preview?: boolean;
    readonly failureHoldHash?: string | null;
    /** Evidence the current narrative was written from; enables task-only live refreshes. */
    readonly priorManifest?: EvidenceManifest | null;
    /** The daily budget is spent: only the no-model skip and live-refresh paths may run. */
    readonly budgetSpent?: string;
    /** Creates the last written run deferred under the per-run cap. */
    readonly deferred?: DeferredCreates | null;
    /** Paid stage results a failed run left for the same inputs. */
    readonly checkpoints?: StageCheckpointStore;
    /** What each sub-page was last built from (#352); absent without a Curator DB, and then every
     *  page is synthesized in full. */
    readonly readPageNoteStates?: (pageIds: readonly string[]) => ReadonlyMap<string, PageNoteBaseline>;
    /** Pairs of the build's memories the reconciler kept both of (#474 idea 4); absent without a Curator DB. */
    readonly readMemoryConflicts?: (memoryIds: readonly number[]) => ReadonlyArray<readonly [number, number]>;
    /** The home's status around a written build (#547). */
    readonly buildStatus?: BuildStatusHooks;
  } = {},
): Promise<CurateResult> {
  try {
    const tracked = config.projectHomeProvenanceEnabled === true;
    const readEvidence = (ref: string) => tracked
      ? engine.projectEvidence(ref, config.meetingReads, undefined, { includeProvenance: true })
      : engine.projectEvidence(ref, config.meetingReads);
    const evidence = await readEvidence(project.id ?? project.title);
    const wikiRootId = evidence.project.id;
    const existingWiki = withRequestedPins(evidence.existing_wiki, pinnedNodeIds);
    const pinnedTitles = new Set(existingWiki.subpages.filter(page => pinnedNodeIds.has(page.id)).map(page => page.title));
    const currentHash = evidence.evidence_hash;
    const homeId = evidence.existing_wiki.home_id;
    const components = evidence.evidence_components;
    const manifest = options.priorManifest ?? null;
    // A manifest only describes the narrative when it matches the hash stamped on the home.
    const changed = components && manifest && manifest.evidenceHash === existingWiki.home?.wiki_evidence_hash
      ? changedEvidenceComponents(manifest.components, components) : undefined;
    const taskOnlyDays = config.wikiTaskOnlyRefreshDays ?? 7;
    const narrativeAgeMs = manifest ? Date.now() - Date.parse(manifest.curatedAt) : Number.POSITIVE_INFINITY;
    const taskOnlyChange = changed !== undefined && changed.length > 0 && changed.every(component => component === 'tasks')
      && narrativeAgeMs < taskOnlyDays * 86_400_000;
    const pipeline = await runReconciliationPipeline({
      engine,
      llm,
      config,
      project: project.title,
      rootTitle: evidence.project.title,
      wikiRootId,
      evidenceHash: currentHash,
      existingWiki,
      dryRun,
      preview: options.preview ?? false,
      failureHoldHash: options.failureHoldHash ?? null,
      ...(options.budgetSpent === undefined ? {} : { budgetSpent: options.budgetSpent }),
      taskOnlyChange,
      deferred: options.deferred ?? null,
      ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}),
      ...(options.readPageNoteStates ? { pageNoteStates: options.readPageNoteStates(existingWiki.subpages.map(page => page.id)) } : {}),
      ...(changed === undefined ? {} : { changedComponents: changed }),
      refreshLive: dry => engine.wikiRefreshLive(wikiRootId, dry),
      ...(options.buildStatus ? { buildStatus: options.buildStatus } : {}),
      force,
      topologySystem: config.curatorTopologyPrompt,
      adjudicationSystem: config.curatorCreateAdjudicationPrompt,
      pageSystem: config.curatorPagePrompt,
      homeSystem: promptOrDefault(config.curatorProjectHomePrompt, SPEC_A_SYSTEM_PROMPT),
      ...(tracked ? { provenanceRunRef: runRef } : {}),
      // `fresh`: the home's retry after an edit changed its evidence mid-build reads the project again.
      prepareEvidence: async (policy, read) => prepareHomeEvidence({ homePolicy: policy.home, engine, llm, config, project,
        evidence: read?.fresh ? await readEvidence(wikiRootId) : evidence, pinnedTitles, corrections, runRef, trackedCorrections,
        ...(options.readMemoryConflicts ? { readConflicts: options.readMemoryConflicts } : {}) }),
    });
    if (pipeline.result.outcome !== 'written') {
      return changed === undefined ? pipeline.result : { ...pipeline.result, changedComponents: changed };
    }

    const memoryResults = await persistMemories(engine, homeId, pipeline.memories, {
      enabled: config.memoryWriteEnabled, cap: config.memoryWriteCap, dryRun,
      evidence: { runRef, hash: currentHash }, sourceRef: project.title,
    });
    return {
      ...pipeline.result,
      ...(changed?.length ? { detail: `${pipeline.result.detail ?? 'wiki reconciled'}; changed: ${changed.join(', ')}`, changedComponents: changed } : {}),
      ...(components ? { evidenceComponents: components } : {}),
      memories: memoryResults.length > 0 ? memoryResults : undefined,
    };
  } catch (err) {
    return { project: project.title, outcome: 'error', detail: `catalog: ${errMessage(err)}`, dryRun };
  }
}

function withRequestedPins(
  existingWiki: ExistingWiki,
  pinnedNodeIds: ReadonlySet<string>,
): ExistingWiki {
  if (pinnedNodeIds.size === 0) return existingWiki;
  return {
    ...existingWiki,
    subpages: existingWiki.subpages.map(page => pinnedNodeIds.has(page.id)
      ? { ...page, wiki_pinned: true, wiki_origin: 'requested' }
      : page),
  };
}
