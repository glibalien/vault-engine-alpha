import { resolveWikiOutputPolicy } from './wiki-output-policy.js';
import { budgetRefusalDetail, isBudgetRefusal } from './budget.js';
import { randomUUID } from 'node:crypto';
import { activeExecution, recoverRequestedPage, requestedExecutionContext, savedRequestedCalls, savedRequestedUsage, type RequestExecutionStore } from './requested-page-recovery.js';
import { liveRequestedCaptures, snapshotMemory, type ActivePageRequestExecution, type RequestedCaptureConfig } from './db/request-execution.js';
import { EvidenceCollector } from './provenance-evidence.js';
import { completeHomeEvidenceObservations } from './provenance-evidence-read.js';
import { assertProjectSubpageCapture } from './provenance-page.js';
import { readCaptureLimits } from './provenance-budget.js';
import { REQUESTED_TOPOLOGY_SYSTEM } from './requested-page-pipeline.js';
import { ADJUDICATION_SYSTEM_PROMPT } from './prompts/adjudicate.js';
import { estimateCostByModel, estimateCostUsd, ZERO_USAGE } from './pricing.js';
import type { EngineNode, Memory } from './types.js';
import { nodeStatus, vaultOf, type Config } from './config.js';
import { Engine, EngineError } from './engine.js';
import { peopleBlockContacts, peopleBlocks, requestedPageEvidence, requestedPageEvidenceNodeIds, truncate } from './evidence.js';
import type { LlmClient } from './llm/types.js';
import { RequestedPagePipelineError, runRequestedPagePipeline } from './requested-page-pipeline.js';
import { subpageTitle } from './spine.js';
import {
  REQUESTED_PAGE_PROMPT, REQUESTED_PAGE_WEB_PROMPT, SPEC_A_SYSTEM_PROMPT, TOPIC_SYSTEM_PROMPT, TOPIC_WEB_SYSTEM_PROMPT,
} from './synthesize.js';
import { buildWebEvidence } from './topic.js';
import { labelProjectMemories, projectMemories } from './home-evidence.js';
import { memoryConflicts, memoryDay, withSourceLabels, type MemoryConflict } from './wiki-memories.js';
import type { ExistingWiki, GapFillCandidate, ProjectEvidence, ProjectRef, TokenUsage } from './types.js';

const REQUEST_BODY_READS = 5;

export interface PageRequestSpec {
  id?: number;
  title: string;
  brief?: string;
}

export interface RequestedPageOutcome {
  project: string;
  requestedTitle: string;
  qualifiedTitle: string;
  outcome: 'written' | 'no-wiki' | 'unknown-project' | 'error';
  nodeId?: string;
  resolvedTo?: {
    nodeId?: string;
    title: string;
    action: 'created' | 'refreshed' | 'reactivated' | 'merged' | 'preview';
  };
  mergedSourceNodeIds?: readonly string[];
  detail?: string;
  /** The daily budget refused a call before dispatch; the request stays pending for a later run. */
  budgetRefused?: true;
  usage?: TokenUsage;
  costUsd?: number | null;
  /** Newly dispatched known usage for this invocation; excludes cached recovery results. */
  invocationUsage?: TokenUsage;
  invocationCostUsd?: number | null;
  dryRun: boolean;
}

type RequestedEvidenceInput = {
  readonly engine: Engine;
  readonly config: Config;
  readonly project: ProjectRef;
  readonly evidence: ProjectEvidence & { readonly existing_wiki: ExistingWiki };
  readonly request: PageRequestSpec;
};

export async function curateRequestedPage(
  engine: Engine,
  llm: LlmClient,
  config: Config,
  project: ProjectRef,
  request: PageRequestSpec,
  dryRun: boolean,
  source: 'vault' | 'vault+web' = 'vault',
  options: { store?: RequestExecutionStore; kind?: 'project' | 'topic'; runRef?: string;
    /** Pairs of memories the reconciler kept both of, among the given ids (#631). A project's page
     *  shows them as a full build does; a durable request freezes them. */
    readConflicts?: (memoryIds: readonly number[]) => ReadonlyArray<readonly [number, number]>; } = {},
): Promise<RequestedPageOutcome> {
  const naiveTitle = request.title.startsWith(`${project.title} — `)
    ? request.title
    : subpageTitle(project.title, request.title);
  const base = { project: project.title, requestedTitle: request.title, qualifiedTitle: naiveTitle, dryRun };
  try {
    const saved = options.store?.read();
    const tracked = options.kind !== 'topic' && (config.projectHomeProvenanceEnabled || !!saved);
    if (tracked) {
      if (!dryRun && !options.store) throw new Error('REQUEST_EXECUTION_REQUIRED');
      if (options.store && saved) {
        if (dryRun) throw new Error('REQUEST_RECOVERY_DRY_RUN');
        if (project.id && saved.projectId !== project.id) throw new Error('REQUEST_PROJECT_CHANGED');
        const recovery = await recoverRequestedPage(engine, options.store);
        if (recovery === 'blocked') throw new Error('REQUEST_RECOVERY_BLOCKED');
        const state = activeExecution(options.store);
        if (recovery === 'committed') return recoveredOutcome(base, state);
        return await runFrozenRequest(engine, llm, config, base, request, options.store);
      }
      await assertProjectSubpageCapture(engine, llm);
      if (!dryRun && (!llm.configurationFor || !llm.withConfiguration)) throw new Error('REQUEST_CONFIGURATION_UNSUPPORTED');
    }
    let evidence: ProjectEvidence & { readonly existing_wiki: ExistingWiki };
    try {
      // Same meeting window as full curation, so the hash this request stamps matches the next sweep's.
      evidence = tracked ? await engine.projectEvidence(project.id ?? project.title, config.meetingReads, undefined, { includeProvenance: true })
        : await engine.projectEvidence(project.id ?? project.title, config.meetingReads);
    } catch (error) {
      if (error instanceof EngineError && /NOT_FOUND/i.test(error.code)) {
        return { ...base, outcome: 'unknown-project', detail: error.message };
      }
      throw error;
    }
    if (!evidence.existing_wiki.home_id) return { ...base, outcome: 'no-wiki', detail: 'project has no wiki yet' };
    if (tracked) {
      evidence = await completeHomeEvidenceObservations(engine, evidence, evidence.project.id, 10, undefined, requestedPageEvidenceNodeIds);
      const collector = new EvidenceCollector(evidence.provenance_observations?.nodes ?? {});
      const gathered = await gatherCapturedRequestedEvidence(engine, config, evidence, request);
      // Dated and sourced, newest first, with the pairs nothing has settled, as a full build shows them (#631).
      const memories = labelProjectMemories(await requestMemories(engine, project, evidence, gathered.related, true, collector),
        evidence, [], gathered.related, config.curatorTz);
      const conflicts = memoryConflicts(memories, options.readConflicts);
      // The project's people, with and without notes, as a full build shows them (#631); only what the blocks read.
      const contacts = peopleBlockContacts(evidence.contacts);
      const text = requestedPageEvidence(evidence, request.title, request.brief, gathered.related, config.bodyCharCap, collector,
        memories, 'project', conflicts, contacts);
      const status = await engine.inspectProvenance({ select: 'status' });
      if (status.select !== 'status') throw new Error('PROVENANCE_CAPTURE_UNSUPPORTED');
      const limits = readCaptureLimits(status.limits);
      const generatedAt = new Date();
      const frozen: RequestedCaptureConfig = {
        wikiOutputPolicy: resolveWikiOutputPolicy(config, llm),
        ...(!dryRun ? { llmConfiguration: llm.configurationFor!(config.model) } : {}),
        model: config.model, homeMaxTokens: config.homeMaxTokens, bodyCharCap: config.bodyCharCap,
        ...(config.meetingReads === undefined ? {} : { meetingReads: config.meetingReads }),
        ...(config.curatorTz ? { curatorTz: config.curatorTz } : {}),
        semanticGapFillLimit: config.semanticGapFillLimit,
        curatorRequestedPagePrompt: promptOrDefault(config.curatorRequestedPagePrompt, REQUESTED_PAGE_PROMPT),
        curatorProjectHomePrompt: promptOrDefault(config.curatorProjectHomePrompt, SPEC_A_SYSTEM_PROMPT),
        curatorTopologyPrompt: REQUESTED_TOPOLOGY_SYSTEM,
        curatorCreateAdjudicationPrompt: ADJUDICATION_SYSTEM_PROMPT,
        curatorPagePrompt: promptOrDefault(config.curatorRequestedPagePrompt, REQUESTED_PAGE_PROMPT),
        provenanceLimits: { ...limits, outputBytes: status.limits.outputBytes!, leaseMs: status.limits.leaseHours! * 3600000 },
      };
      if (dryRun) {
        const reconciled = await runRequestedPagePipeline({ engine, llm, config: { ...config, ...frozen },
          project: project.title, rootTitle: evidence.project.title, wikiRootId: evidence.project.id,
          requestId: String(request.id ?? request.title), evidenceHash: evidence.evidence_hash, evidenceText: text,
          evidenceNodes: gathered.nodes, memories, conflicts, contacts, checkRules: true, existingWiki: evidence.existing_wiki, dryRun,
          pageSystem: frozen.curatorRequestedPagePrompt, homeSystem: frozen.curatorProjectHomePrompt, provenance: collector });
        return { ...base, outcome: 'written', qualifiedTitle: reconciled.title, nodeId: reconciled.nodeId,
          resolvedTo: { nodeId: reconciled.nodeId, title: reconciled.title, action: reconciled.action },
          mergedSourceNodeIds: reconciled.sourceNodeIds, detail: reconciled.detail, usage: reconciled.usage, costUsd: reconciled.costUsd,
          invocationUsage: reconciled.invocationUsage, invocationCostUsd: reconciled.invocationCostUsd };
      }
      const state: ActivePageRequestExecution = {
        version: 1, generation: randomUUID(), projectId: evidence.project.id, runRef: options.runRef ?? randomUUID(),
        generatedAt: generatedAt.toISOString(), expiresAt: new Date(generatedAt.getTime() + frozen.provenanceLimits.leaseMs).toISOString(),
        phase: 'prepared', request: { title: request.title, ...(request.brief === undefined ? {} : { brief: request.brief }) },
        snapshot: { config: frozen, evidenceHash: evidence.evidence_hash, evidenceText: text, evidenceNodes: gathered.nodes,
          existingWiki: evidence.existing_wiki, contextNodes: {}, rootTitle: evidence.project.title,
          homeAttribution: { items: collector.items, omissions: collector.omissions },
          ...(memories.length > 0 ? { memories: memories.map(snapshotMemory) } : {}),
          // The pairs by memory id, and an empty lookup list that marks this request as one that looks
          // rules up (#631): a resumed request rebuilds the same evidence from them.
          ...(conflicts.length > 0 ? { conflicts: conflicts.map(pair => [pair.a.id, pair.b.id] as [number, number]) } : {}),
          ...(contacts && peopleBlocks(contacts).length > 0 ? { contacts } : {}),
          ruleLookups: [] }, calls: [], captures: [],
      };
      options.store!.write(null, state);
      return await runFrozenRequest(engine, llm, config, base, request, options.store!);
    }
    const related = await gatherRequestedEvidence({ engine, config, project, evidence, request });
    const memorySubject = options.kind === 'topic' ? 'topic' as const : 'project' as const;
    const selected = await requestMemories(engine, project, evidence, related, false);
    // A project's page gets what a full project build gives its pages (#631). A topic's gets only the
    // dated lines a topic build gives (#634), named by the sources found for it. A topic request is
    // never durable, so there is no checkpoint to save them in.
    const projectPage = memorySubject === 'project';
    const memories = projectPage ? labelProjectMemories(selected, evidence, [], related, config.curatorTz)
      : withSourceLabels(selected, new Map(related.map(candidate => [candidate.id, candidate.title])), memoryDay(config.curatorTz));
    const conflicts = projectPage ? memoryConflicts(memories, options.readConflicts) : [];
    const contacts = projectPage ? peopleBlockContacts(evidence.contacts) : undefined;
    let evidenceText = requestedPageEvidence(evidence, request.title, request.brief, related, config.bodyCharCap,
      undefined, memories, memorySubject, conflicts, contacts);
    let systemPrompt = promptOrDefault(config.curatorRequestedPagePrompt, REQUESTED_PAGE_PROMPT);
    if (source === 'vault+web') {
      const web = await buildWebEvidence(engine, config, request.title, request.brief);
      if (web.webText) evidenceText = `${evidenceText}\n\n${web.webText}`;
      systemPrompt = promptOrDefault(config.curatorRequestedPageWebPrompt, REQUESTED_PAGE_WEB_PROMPT);
    }
    // The home is rewritten with the prompt a full build of this wiki uses (#567).
    const homeSystem = options.kind !== 'topic'
      ? promptOrDefault(config.curatorProjectHomePrompt, SPEC_A_SYSTEM_PROMPT)
      : source === 'vault+web'
        ? promptOrDefault(config.curatorTopicWebPrompt, TOPIC_WEB_SYSTEM_PROMPT)
        : promptOrDefault(config.curatorTopicPrompt, TOPIC_SYSTEM_PROMPT);
    const reconciled = await runRequestedPagePipeline({
      engine, llm, config, project: project.title, rootTitle: evidence.project.title, wikiRootId: evidence.project.id,
      requestId: String(request.id ?? request.title), evidenceHash: evidence.evidence_hash,
      evidenceText, existingWiki: evidence.existing_wiki, dryRun, pageSystem: systemPrompt, homeSystem,
      memories, memorySubject, ...(projectPage ? { conflicts, contacts, checkRules: true } : {}),
      ...(options.kind === 'topic' ? { homeFocusTasks: false } : {}),
      evidenceNodes: related.map(candidate => ({
        id: candidate.id, title: candidate.title, types: candidate.types, fields: {}, body: candidate.body ?? '',
      })),
    });
    const resolvedTo = {
      ...(reconciled.nodeId === undefined ? {} : { nodeId: reconciled.nodeId }),
      title: reconciled.title,
      action: reconciled.action,
    };
    return {
      ...base, qualifiedTitle: reconciled.title, outcome: 'written',
      ...(reconciled.nodeId === undefined ? {} : { nodeId: reconciled.nodeId }),
      resolvedTo, mergedSourceNodeIds: reconciled.sourceNodeIds,
      detail: reconciled.detail, usage: reconciled.usage, costUsd: reconciled.costUsd,
      invocationUsage: reconciled.invocationUsage, invocationCostUsd: reconciled.invocationCostUsd,
    };
  } catch (error) {
    const refused = isBudgetRefusal(error);
    return {
      ...base, outcome: 'error', detail: refused ? budgetRefusalDetail(error) : errMessage(error),
      ...(refused ? { budgetRefused: true as const } : {}),
      ...(error instanceof RequestedPagePipelineError ? { usage: error.usage, costUsd: error.costUsd,
        invocationUsage: error.invocationUsage, invocationCostUsd: error.invocationCostUsd } : {}),
    };
  }
}

async function gatherRequestedEvidence(input: RequestedEvidenceInput): Promise<GapFillCandidate[]> {
  const { engine, config, project, evidence, request } = input;
  const excluded = new Set<string>([evidence.project.id, evidence.existing_wiki.home_id ?? '']);
  if (project.id !== null) excluded.add(project.id);
  for (const page of evidence.existing_wiki.subpages) excluded.add(page.id);
  try {
    const query = [request.title, request.brief ?? ''].filter(Boolean).join('\n');
    const related = (await engine.semanticRelated(query, config.semanticGapFillLimit, config)).filter(candidate => !excluded.has(candidate.id));
    const reads = Math.min(REQUEST_BODY_READS, related.length);
    for (let index = 0; index < reads; index += 1) {
      const candidate = related[index];
      if (candidate === undefined) continue;
      try {
        const node = await engine.getNode(candidate.id);
        related[index] = { ...candidate, body: truncate((node.body ?? '').trim(), config.bodyCharCap) };
      } catch {
        continue;
      }
    }
    return related;
  } catch (error) {
    console.warn(`[curator] request retrieval failed for ${project.title}: ${errMessage(error)}`);
    return [];
  }
}

/** The owner's memories and the project's, chosen as a full build chooses them (#313): its node,
 *  home, evidence notes and names, with the related material's memories last. The project node is
 *  read only for its aliases. Best effort: a failed read leaves the page without memories. */
export async function requestMemories(engine: Engine, project: ProjectRef, evidence: ProjectEvidence & { readonly existing_wiki: ExistingWiki },
  related: readonly GapFillCandidate[], tracked: boolean, collector?: EvidenceCollector): Promise<Memory[]> {
  let root: EngineNode | undefined;
  try {
    root = await engine.getNode(evidence.project.id, { includeEmbeds: false });
  } catch {
    root = undefined;
  }
  return projectMemories(engine, project, evidence, root ? [root] : [], related.map(candidate => candidate.id),
    evidence.existing_wiki.home_id, tracked, collector);
}

function promptOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runFrozenRequest(engine: Engine, llm: LlmClient, config: Config,
  base: Pick<RequestedPageOutcome, 'project' | 'requestedTitle' | 'qualifiedTitle' | 'dryRun'>,
  request: PageRequestSpec, store: RequestExecutionStore): Promise<RequestedPageOutcome> {
  const state = activeExecution(store);
  const frozenConfiguration = state.snapshot.config.llmConfiguration;
  // Old checkpoints have no trustworthy route/reasoning record. Preserve their
  // legacy recovery semantics; never backfill a guess as an original setting.
  if (frozenConfiguration) {
    if (!llm.withConfiguration) throw new Error('REQUEST_CONFIGURATION_UNSUPPORTED');
    llm = llm.withConfiguration(frozenConfiguration);
  }
  const attribution = state.snapshot.homeAttribution;
  if (!attribution || !state.snapshot.rootTitle) throw new Error('REQUEST_SNAPSHOT_INCOMPLETE');
  const collector = new EvidenceCollector({}, [], attribution.assemblyContext);
  collector.items.push(...attribution.items); collector.omissions.push(...attribution.omissions);
  const memories = (state.snapshot.memories ?? []) as Memory[];
  const result = await runRequestedPagePipeline({ engine, llm, config: { ...config, ...state.snapshot.config },
    project: state.snapshot.rootTitle, rootTitle: state.snapshot.rootTitle, wikiRootId: state.projectId,
    requestId: String(request.id ?? state.generation), evidenceHash: state.snapshot.evidenceHash,
    evidenceText: state.snapshot.evidenceText, evidenceNodes: state.snapshot.evidenceNodes, existingWiki: state.snapshot.existingWiki,
    memories, conflicts: frozenConflicts(memories, state.snapshot.conflicts ?? []),
    // An older checkpoint saved no people: its page had no people blocks, so its saved calls still match.
    ...(state.snapshot.contacts ? { contacts: state.snapshot.contacts } : {}),
    dryRun: false, pageSystem: state.snapshot.config.curatorRequestedPagePrompt, execution: requestedExecutionContext(store), provenance: collector });
  return { ...base, outcome: 'written', qualifiedTitle: result.title, nodeId: result.nodeId,
    resolvedTo: { nodeId: result.nodeId, title: result.title, action: result.action }, mergedSourceNodeIds: result.sourceNodeIds,
    detail: result.detail, usage: result.usage, costUsd: result.costUsd,
    invocationUsage: result.invocationUsage, invocationCostUsd: result.invocationCostUsd };
}
/** The frozen conflict pairs as the page shows them, from the frozen memories (#631). */
function frozenConflicts(memories: readonly Memory[], pairs: ReadonlyArray<readonly [number, number]>): MemoryConflict[] {
  const byId = new Map(memories.map(memory => [memory.id, memory]));
  return pairs.flatMap(([a, b]) => {
    const first = byId.get(a);
    const second = byId.get(b);
    return first && second ? [{ a: first, b: second }] : [];
  });
}
function recoveredOutcome(base: Pick<RequestedPageOutcome, 'project' | 'requestedTitle' | 'qualifiedTitle' | 'dryRun'>,
  state: ActivePageRequestExecution): RequestedPageOutcome {
  const result = state.result;
  const operation = state.reconcile?.pages.find(p => p.op !== 'retire' && p.sections);
  const capture = liveRequestedCaptures(state).find(c => c.flow === 'project-subpage-v1');
  const receipt = result?.provenance_receipts?.find(r => r.derivation_id === capture?.receipt?.derivation_id);
  const node = [...(result?.created ?? []), ...(result?.updated ?? [])].find(n => n.node_id === receipt?.output_node_id);
  if (!operation || operation.op === 'retire' || !node) throw new Error('REQUEST_COMMIT_MISMATCH');
  const action = operation.op === 'merge' ? 'merged' : operation.target.mode === 'new' ? 'created'
    : state.snapshot.existingWiki.subpages.find(p => p.id === node.node_id)?.wiki_state !== 'active' ? 'reactivated' : 'refreshed';
  const saved = savedRequestedCalls(state);
  return { ...base, outcome: 'written', qualifiedTitle: node.title, nodeId: node.node_id,
    resolvedTo: { nodeId: node.node_id, title: node.title, action },
    mergedSourceNodeIds: result!.mappings.filter(m => m.target_node_id === node.node_id).map(m => m.source_node_id),
    detail: 'recovered committed request', usage: savedRequestedUsage(state),
    costUsd: estimateCostByModel(saved.length > 0 ? saved : [[state.snapshot.config.model, ZERO_USAGE]]),
    invocationUsage: ZERO_USAGE, invocationCostUsd: estimateCostUsd(state.snapshot.config.model, ZERO_USAGE) };
}
export async function gatherCapturedRequestedEvidence(engine: Engine, config: Config,
  evidence: ProjectEvidence & { existing_wiki: ExistingWiki }, request: PageRequestSpec): Promise<{ related: GapFillCandidate[]; nodes: EngineNode[] }> {
  const excluded = new Set([evidence.project.id, evidence.existing_wiki.home_id, ...evidence.existing_wiki.subpages.map(p => p.id)]);
  let candidates: GapFillCandidate[];
  try { candidates = await engine.semanticRelated([request.title, request.brief ?? ''].filter(Boolean).join('\n'), config.semanticGapFillLimit, config); }
  catch { candidates = []; }
  const related: GapFillCandidate[] = [];
  const nodes: EngineNode[] = [];
  for (const candidate of candidates.filter(c => !excluded.has(c.id)).slice(0, config.semanticGapFillLimit)) {
    let node: EngineNode;
    try {
      node = await engine.getNode(candidate.id, { includeProvenance: true, includeEmbeds: false });
    } catch (error) {
      // Search hits are optional; only an authoritative missing-node result is safe to omit.
      if (error instanceof EngineError && error.code === 'NOT_FOUND') continue;
      throw error;
    }
    // Capture identities for every candidate, preserving the existing five-body selection.
    nodes.push(related.length < REQUEST_BODY_READS ? node : { ...node, body: '' });
    const body = (node.body ?? '').trim();
    related.push({ ...candidate, title: node.title ?? candidate.title, types: node.types, status: nodeStatus(node.fields, node.types, vaultOf(config)),
      ...(related.length < REQUEST_BODY_READS ? { body: truncate(body, config.bodyCharCap) } : {}),
      provenance_observation: node.provenance_observation,
      provenance_truncated: related.length < REQUEST_BODY_READS && config.bodyCharCap !== null && body.length > config.bodyCharCap });
  }
  return { related, nodes };
}
