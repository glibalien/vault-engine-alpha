import { createEvidenceDiagnostics } from './topic-evidence-diagnostics.js';
import { webSourceId, type TopicEvidenceSource } from './topic-evidence-selection.js';
import { createTopicSelectionRecorder } from './topic-selection-state.js';
import type { TopicRequestBudgetContext } from './topic-request-budget.js';
import { createHash } from 'node:crypto';
import { withoutWikiLinks } from '@vault/contract';
import { isCuratorJournalTitle } from './topic-source-policy.js';
import { EngineError, type Engine } from './engine.js';
import type { Config } from './config.js';
import { collectEvidenceIds, truncate } from './evidence.js';
import { memoryDay, renderWikiMemories, selectWikiMemories, withSourceLabels } from './wiki-memories.js';
import type {
  CurateResult,
  EngineNode,
  ExistingWiki,
  GapFillCandidate,
  Memory,
  MemoryWriteResult,
  ProjectRef,
  TopicSpec,
  WebEvidence,
  WebSearchResult,
  WebSource,
} from './types.js';
import type { LlmClient } from './llm/types.js';
import type { DeferredCreates } from './db/deferred-creates.js';
import { TOPIC_SYSTEM_PROMPT, TOPIC_WEB_SYSTEM_PROMPT } from './synthesize.js';
import { runReconciliationPipeline, type BuildStatusHooks } from './reconciliation-pipeline.js';
import { persistMemories } from './persist-memories.js';
import { parseCadence, isCadenceDue } from './cadence.js';
import type { TopicCommittedSourceProjection } from './db/topic-refresh.js';
import type {
  TopicRefreshAdmission,
  TopicRefreshAdmissionWarning,
  TopicRefreshTrigger,
} from './topic-refresh-admission.js';
import {
  buildCanonicalWebProbe,
  comparableTopicBody,
  topicVaultSourceFingerprint,
  type CanonicalWebProbe,
  type CanonicalWebProbeResult,
} from './topic-refresh-evidence.js';

// How many top semantic hits get their bodies read into topic evidence.
const TOPIC_BODY_READS = 6;
const TOPIC_OBSERVED_SOURCE_CAP = 50;
const REFRESH_DUE_TRIGGERS: ReadonlySet<TopicRefreshTrigger> = new Set([
  'cadence_due',
  'baseline_retry',
  'vault_source_changed',
  'web_material_change',
]);

function promptOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

export interface TopicEvidence {
  mandatoryEvidence: string;
  sources: readonly TopicEvidenceSource[];
  evidenceText: string;
  topicHash: string;
  /** `topicHash` as builds stamped it before links were read as their words (#332). */
  topicHashWithLinks: string;
  candidateCount: number;
  evidenceNodes: EngineNode[];
  sourceProjections: TopicCommittedSourceProjection[];
  observedSourceNodeIds: string[];
  warnings: TopicRefreshAdmissionWarning[];
  stableSourceReadUnavailable: boolean;
}

export interface TopicEvidenceSourceOptions {
  explicitSourceNodeIds: readonly string[];
  prioritySourceNodeIds: readonly string[];
}

export interface CurateTopicOptions {
  dryRun: boolean;
  /** With dryRun, run the paid stages and preview without writing. */
  preview?: boolean;
  /** Evidence hash of a recent paid failure; unforced runs on the same evidence are held. */
  failureHoldHash?: string | null;
  /** Creates the last written run deferred under the per-run cap. */
  deferred?: DeferredCreates | null;
  force: boolean;
  pinnedNodeIds: ReadonlySet<string>;
  corrections: readonly string[];
  runRef: string;
  scheduled: boolean;
  admission: TopicRefreshAdmission;
  explicitSourceNodeIds: readonly string[];
  prioritySourceNodeIds: readonly string[];
  /** The home's status around a written build (#547). */
  buildStatus?: BuildStatusHooks;
}

export interface TopicRefreshCommitMaterial {
  sourceProjections: TopicCommittedSourceProjection[];
  observedSourceNodeIds: string[];
  webProbe?: CanonicalWebProbe;
  persistMemories?: () => Promise<MemoryWriteResult[]>;
}

const refreshCommitMaterialByResult = new WeakMap<CurateResult, TopicRefreshCommitMaterial>();

/** Internal handoff for core baseline persistence. Material is not a CurateResult property. */
export function topicRefreshCommitMaterial(result: CurateResult): TopicRefreshCommitMaterial | undefined {
  return refreshCommitMaterialByResult.get(result);
}

/**
 * Content-stable idempotency hash for a topic wiki: sha256 over topic + brief and
 * the sorted-by-id (id, body) pairs of the gathered nodes. Order-independent;
 * changes only when the matched set or a rendered body changes. Excludes
 * corrections (steering, not vault content — adding one must not by itself force
 * a refresh). Each body is read with its links as the words they show (#332), so
 * the link sweep adding links to a source is no change; `keepLinks` gives the
 * hash as builds stamped it before that.
 */
export function topicEvidenceHash(
  topic: string, brief: string | undefined, nodes: Array<{ id: string; body?: string }>,
  options: { keepLinks?: boolean } = {},
): string {
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const h = createHash('sha256');
  h.update(`topic:${topic}\nbrief:${brief ?? ''}\n`);
  for (const n of sorted) h.update(`${n.id}\n${options.keepLinks ? n.body ?? '' : withoutWikiLinks(n.body ?? '')}\n`);
  return h.digest('hex');
}

/** Render topic evidence: topic header → caller corrections → curator memories →
 *  the read vault nodes. */
function renderTopicEvidence(
  topic: string, brief: string | undefined, corrections: readonly string[], related: GapFillCandidate[],
  memories: readonly Memory[] = [],
): string {
  const lines: string[] = [];
  lines.push(`# Topic: ${topic}`);
  if (brief) lines.push(`Brief: ${brief}`);
  lines.push('');
  if (corrections.length > 0) {
    lines.push('## CALLER CORRECTIONS (authoritative steering from the owner — apply over your own inference)');
    for (const note of corrections) lines.push(`- ${note}`);
    lines.push('');
  }
  lines.push(...renderWikiMemories(memories, 'topic').lines);
  lines.push('## VAULT MATERIAL (hybrid search on the topic)');
  if (related.length === 0) {
    lines.push('(nothing in the vault mentions this topic — say so plainly; a short honest page beats a padded one)');
  } else {
    for (const c of related) {
      lines.push(`### ${c.title}`);
      lines.push(`types: ${c.types.join(', ') || '(none)'}`);
      if (c.body) { lines.push(''); lines.push(c.body); }
      lines.push('');
    }
  }
  return lines.join('\n').trim();
}

type SuppliedTopicSource = {
  rendered: GapFillCandidate;
  /** The body as wikis compare it (#332; `comparableTopicBody`). */
  comparableBody: string;
  evidenceNode: EngineNode;
  projection: TopicCommittedSourceProjection;
};

function presentSource(
  nodeId: string,
  title: string,
  types: string[],
  rawBody: string | undefined,
  config: Config,
  capturedAt: string,
): SuppliedTopicSource {
  const trimmedBody = rawBody?.trim() ?? '';
  const bodyIncluded = trimmedBody !== '';
  const renderedBody = bodyIncluded ? truncate(trimmedBody, config.bodyCharCap) : '';
  const comparableBody = comparableTopicBody(trimmedBody, config.bodyCharCap);
  const fingerprint = topicVaultSourceFingerprint({
    nodeId,
    title,
    types,
    bodyIncluded,
    renderedBody,
    comparableBody,
  });
  if (fingerprint.projection.state !== 'present') throw new TypeError('present source projected missing');
  const projected = fingerprint.projection;
  return {
    comparableBody,
    rendered: {
      id: nodeId,
      title: projected.title,
      types: projected.types,
      status: null,
      ...(bodyIncluded ? { body: renderedBody } : {}),
    },
    // Page synthesis applies the same cap at its boundary, so retain the raw
    // body here rather than truncating the same string a second time.
    evidenceNode: {
      id: nodeId,
      title: projected.title,
      types: projected.types,
      fields: {},
      body: bodyIncluded ? trimmedBody : '',
    },
    projection: {
      nodeId,
      titleAtCommit: projected.title,
      evidenceState: 'present',
      bodyIncluded: bodyIncluded ? 1 : 0,
      fingerprintVersion: fingerprint.version,
      evidenceHash: fingerprint.hash,
      capturedAt,
    },
  };
}

function missingSource(nodeId: string, capturedAt: string): TopicCommittedSourceProjection {
  const fingerprint = topicVaultSourceFingerprint({ nodeId, state: 'missing' });
  return {
    nodeId,
    titleAtCommit: null,
    evidenceState: 'missing',
    bodyIncluded: 0,
    fingerprintVersion: fingerprint.version,
    evidenceHash: fingerprint.hash,
    capturedAt,
  };
}

function uniqueNodeIds(values: readonly string[], excluded: ReadonlySet<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const nodeId of values) {
    if (nodeId.trim() === '' || excluded.has(nodeId) || seen.has(nodeId)) continue;
    seen.add(nodeId);
    result.push(nodeId);
  }
  return result;
}

function addWarning(
  warnings: TopicRefreshAdmissionWarning[],
  warning: TopicRefreshAdmissionWarning,
): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

/**
 * Gather stable explicit/trigger evidence before the fresh semantic
 * neighborhood. Stable IDs win deduplication, while the observed commit set is
 * derived from the final non-explicit evidence actually supplied to synthesis.
 */
export async function buildTopicEvidence(
  engine: Engine,
  config: Config,
  root: ProjectRef,
  brief: string | undefined,
  corrections: readonly string[],
  existingWiki: { home_id: string | null; subpages: Array<{ id: string }> },
  /** The memories to show, or a selector given the ids of the sources gathered here, so the
   *  topic's memories can come from its actual source notes (#297). */
  memories: readonly Memory[] | ((sourceNodeIds: readonly string[]) => Promise<readonly Memory[]>) = [],
  sourceOptions: TopicEvidenceSourceOptions = {
    explicitSourceNodeIds: [],
    prioritySourceNodeIds: [],
  },
): Promise<TopicEvidence> {
  const query = [root.title, brief ?? ''].filter(Boolean).join('\n');
  const excluded = new Set<string>(root.id === null ? [] : [root.id]);
  if (existingWiki.home_id) excluded.add(existingWiki.home_id);
  for (const s of existingWiki.subpages) excluded.add(s.id);

  const explicitIds = uniqueNodeIds(sourceOptions.explicitSourceNodeIds, excluded);
  const explicitIdSet = new Set(explicitIds);
  const priorityIds = uniqueNodeIds(sourceOptions.prioritySourceNodeIds, new Set([
    ...excluded,
    ...explicitIds,
  ]));
  const supplied: SuppliedTopicSource[] = [];
  const sourceProjections: TopicCommittedSourceProjection[] = [];
  const warnings: TopicRefreshAdmissionWarning[] = [];
  let stableSourceReadUnavailable = false;
  const capturedAt = new Date().toISOString();
  const claimedIds = new Set<string>([...excluded, ...explicitIds, ...priorityIds]);

  const readStable = async (nodeIds: readonly string[], explicit: boolean): Promise<void> => {
    for (const nodeId of nodeIds) {
      try {
        const read = await engine.getNode(nodeId);
        if (!explicit && isCuratorJournalTitle(read.title)) continue;
        const source = presentSource(
          nodeId,
          read.title ?? nodeId,
          read.types,
          read.body ?? undefined,
          config,
          capturedAt,
        );
        supplied.push(source);
        sourceProjections.push(source.projection);
      } catch (error) {
        if (error instanceof EngineError && error.code === 'NOT_FOUND') {
          if (explicit) {
            sourceProjections.push(missingSource(nodeId, capturedAt));
            console.warn(`[curator] topic missing explicit source ${nodeId} for ${root.title}`);
          }
          continue;
        }
        addWarning(warnings, 'source_read_unavailable');
        stableSourceReadUnavailable = true;
      }
    }
  };

  await readStable(explicitIds, true);
  await readStable(priorityIds, false);

  let semantic: GapFillCandidate[] = [];
  try {
    semantic = (await engine.semanticRelated(query, config.semanticGapFillLimit, config))
      .filter(candidate => !claimedIds.has(candidate.id) && !isCuratorJournalTitle(candidate.title));
  } catch (err) {
    console.warn(`[curator] topic retrieval failed for ${root.title}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const optionalReadUnavailable = new Set<string>();
  const semanticCandidates: GapFillCandidate[] = [];
  for (const candidate of semantic) {
    if (claimedIds.has(candidate.id)) continue;
    claimedIds.add(candidate.id);
    semanticCandidates.push(candidate);
  }

  for (let index = 0; index < semanticCandidates.length; index++) {
    const candidate = semanticCandidates[index];
    if (candidate === undefined) continue;
    let rawBody: string | undefined;
    let currentTitle = candidate.title;
    let currentTypes = candidate.types;
    if (index < TOPIC_BODY_READS) {
      try {
        const read = await engine.getNode(candidate.id);
        if (isCuratorJournalTitle(read.title)) continue;
        rawBody = read.body ?? undefined;
        currentTitle = read.title ?? candidate.title;
        currentTypes = read.types;
      } catch {
        optionalReadUnavailable.add(candidate.id);
        addWarning(warnings, 'source_read_unavailable');
      }
    }
    const source = presentSource(
      candidate.id,
      currentTitle,
      currentTypes,
      rawBody,
      config,
      capturedAt,
    );
    supplied.push(source);
    sourceProjections.push(source.projection);
  }

  const rendered = supplied.map(source => source.rendered);
  // Each memory line says when it became true and which source it came from, newest first, as a
  // project build's do (#474 idea 4).
  const shownMemories = withSourceLabels(
    typeof memories === 'function' ? await memories(rendered.map(source => source.id)) : memories,
    new Map(rendered.map(source => [source.id, source.title])), memoryDay(config.curatorTz));
  return {
    mandatoryEvidence: renderTopicEvidence(root.title, brief, corrections, [], shownMemories)
      .replace('(nothing in the vault mentions this topic — say so plainly; a short honest page beats a padded one)', ''),
    sources: sourceProjections.map(p => {
      const candidate = supplied.find(s => s.projection.nodeId === p.nodeId)?.rendered;
      const comparableBody = supplied.find(s => s.projection.nodeId === p.nodeId)?.comparableBody;
      return { id: p.nodeId, title: p.titleAtCommit ?? p.nodeId, body: candidate?.body ?? '',
        ...(comparableBody === undefined ? {} : { comparableBody }),
        priority: sourceOptions.prioritySourceNodeIds.includes(p.nodeId) ? 'changed' as const
          : explicitIdSet.has(p.nodeId) ? 'explicit' as const : 'semantic' as const,
        availability: p.evidenceState === 'missing' ? 'missing' as const
          : optionalReadUnavailable.has(p.nodeId) ? 'unavailable' as const : 'present' as const,
        origin: { kind: 'node' as const, nodeId: p.nodeId, types: candidate?.types ?? [] } };
    }),
    evidenceText: renderTopicEvidence(root.title, brief, corrections, rendered, shownMemories),
    topicHash: topicEvidenceHash(root.title, brief, supplied.map(source => ({
      id: source.rendered.id,
      body: source.comparableBody,
    }))),
    topicHashWithLinks: topicEvidenceHash(root.title, brief, rendered.map(candidate => ({
      id: candidate.id,
      body: candidate.body,
    })), { keepLinks: true }),
    candidateCount: supplied.length,
    evidenceNodes: supplied.map(source => source.evidenceNode),
    sourceProjections,
    observedSourceNodeIds: supplied
      .map(source => source.rendered.id)
      .filter(nodeId => !explicitIdSet.has(nodeId))
      .slice(0, TOPIC_OBSERVED_SOURCE_CAP),
    warnings,
    stableSourceReadUnavailable,
  };
}

type FullWebResult = WebSearchResult | CanonicalWebProbeResult;

/**
 * Render attributed web evidence. A material-change admission supplies its
 * exact canonical result set, avoiding a second search. Ordinary runs retain
 * the search/fetch path and also return a canonical commit probe. Search
 * failure is unavailable; an empty successful search has a valid empty probe.
 */
export async function buildWebEvidence(
  engine: Engine,
  config: Config,
  topic: string,
  brief: string | undefined,
  admittedProbe?: CanonicalWebProbe,
): Promise<WebEvidence> {
  try {
    let results: readonly FullWebResult[];
    let probe: CanonicalWebProbe | undefined;
    if (admittedProbe !== undefined) {
      results = admittedProbe.results;
      probe = admittedProbe;
    } else {
      const query = [topic, brief ?? ''].filter(Boolean).join(' ');
      results = await engine.webSearch(query, config.webSearchResults);
      const built = buildCanonicalWebProbe(results.map(result => ({
        url: result.url,
        title: result.title,
        snippet: result.snippet,
        published: result.published ?? null,
      })));
      if (built.ok) probe = built.probe;
    }

    // A malformed optional result must not discard its valid neighbors. Keep
    // probe validation above strict: partial results are not a complete baseline.
    const validResults = results.filter(result => {
      try {
        const url = new URL(result.url);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch { return false; }
    });
    if (validResults.length !== results.length) {
      console.warn(`[curator] skipped ${results.length - validResults.length} web results with invalid URLs`);
    }
    results = validResults;
    if (results.length === 0) {
      return {
        webText: '',
        sources: [],
        resultCount: 0,
        ...(probe === undefined ? {} : { probe }),
      };
    }

    const fetchTop = Math.min(config.webFetchTop, results.length);
    const texts: string[] = [];
    const evidenceSources: TopicEvidenceSource[] = [];
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result === undefined) continue;
      let body = result.snippet ?? '';
      if (index < fetchTop) {
        try {
          const page = await engine.fetchUrl(result.url);
          body = truncate((page.content ?? '').trim(), config.webFetchCharCap) || body;
        } catch {
          // Keep the admitted/search snippet.
        }
      }
      evidenceSources.push({ id: webSourceId(result.url), title: result.title, body, priority: 'web',
        availability: 'present', origin: { kind: 'web', url: result.url } });
      const head = result.published ? `### ${result.title} (${result.published})` : `### ${result.title}`;
      texts.push(`${head}\n${result.url}\n${body ? `\n${body}\n` : ''}`);
    }
    const lines = ['## WEB MATERIAL (external sources — attribute any claim drawn from here)', '', ...texts];
    return {
      webText: lines.join('\n').trim(),
      evidenceSources,
      sources: results.map(result => ({ title: result.title, url: result.url } satisfies WebSource)),
      resultCount: results.length,
      ...(probe === undefined ? {} : { probe }),
    };
  } catch (err) {
    console.warn(`[curator] web research failed for ${topic}: ${err instanceof Error ? err.message : String(err)}`);
    return { webText: '', sources: [], resultCount: 0 };
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Return the core-owned scheduled-admission skip result for a fresh vault+web
 * topic. Full curation consumes the authoritative admission that follows it.
 */
export function scheduledTopicCadenceSkip(
  root: ProjectRef,
  spec: TopicSpec,
  config: Config,
  existingWiki: ExistingWiki,
  dryRun: boolean,
  force: boolean,
  scheduledCadenceOnly: boolean,
  now: Date = new Date(),
): CurateResult | undefined {
  const priorCuratedAt = existingWiki.home?.wiki_curated_at ?? null;
  const cadenceDue = spec.source === 'vault+web'
    && isCadenceDue(priorCuratedAt, parseCadence(spec.cadence, config.topicWebCadenceMs), now);
  if (!scheduledCadenceOnly || force || spec.source !== 'vault+web' || cadenceDue) return undefined;
  return {
    project: root.title,
    outcome: 'skipped_cadence_not_due',
    detail: 'cadence not due',
    dryRun,
    wikiCuratedAt: priorCuratedAt,
  };
}

/** Curate one topic wiki from an already-authoritative admission decision. */
export async function curateTopic(
  engine: Engine,
  llm: LlmClient,
  config: Config,
  root: ProjectRef,
  spec: TopicSpec,
  opts: CurateTopicOptions,
): Promise<CurateResult> {
  try {
    const ev = await engine.projectEvidence(root.id ?? root.title);
    const wikiRootId = ev.project.id;
    const catalog: ExistingWiki = ev.existing_wiki;
    const existingWiki: ExistingWiki = opts.pinnedNodeIds.size === 0 ? catalog : {
      ...catalog,
      subpages: catalog.subpages.map(page => opts.pinnedNodeIds.has(page.id)
        ? { ...page, wiki_pinned: true, wiki_origin: 'requested' as const }
        : page),
    };
    const homeId = existingWiki.home_id;

    // The owner's memories and the topic's (#297), selected like a project's once the topic's
    // source notes are known: memories drawn from them are about the topic.
    const topicMemories = async (sourceNodeIds: readonly string[]): Promise<readonly Memory[]> => {
      try {
        const selected = await selectWikiMemories(engine, {
          rootId: wikiRootId, homeId,
          names: [ev.project.title, ...(ev.contacts?.companies ?? []).map(company => company.title)],
          // A source note that is a person or a company: memories about it are about the topic (#719).
          subjectNoteIds: [wikiRootId, ...sourceNodeIds],
          relatedSubjectIds: (ev.contacts?.companies ?? []).map(company => company.id),
          evidenceNodeIds: [...sourceNodeIds, ...collectEvidenceIds(ev, { ...root, id: wikiRootId })],
        }, { includeProvenance: false });
        return selected.memories;
      } catch (err) {
        console.warn(`[curator] memory fetch skipped for ${root.title}: ${errMessage(err)}`);
        return [];
      }
    };

    const topicEvidence = await buildTopicEvidence(
      engine,
      config,
      { ...root, id: wikiRootId },
      spec.brief,
      opts.corrections,
      existingWiki,
      topicMemories,
      {
        explicitSourceNodeIds: opts.explicitSourceNodeIds,
        prioritySourceNodeIds: opts.admission.trigger === 'vault_source_changed'
          ? opts.prioritySourceNodeIds
          : [],
      },
    );
    if (topicEvidence.stableSourceReadUnavailable) {
      return {
        project: root.title,
        outcome: 'error',
        detail: 'stable topic source unavailable; refresh state unchanged for retry',
        dryRun: opts.dryRun,
        refreshWarnings: topicEvidence.warnings,
      };
    }
    let webProbe: CanonicalWebProbe | undefined;
    const refreshDue = REFRESH_DUE_TRIGGERS.has(opts.admission.trigger);
    const diagnostics = createEvidenceDiagnostics();
    const selectionRecorder = createTopicSelectionRecorder(topicEvidence.sources, topicEvidence.sourceProjections, config.bodyCharCap);
    const topicContext: TopicRequestBudgetContext = {
      sources: topicEvidence.sources, mandatoryEvidence: topicEvidence.mandatoryEvidence,
      query: [root.title, spec.brief ?? ''].join(' '),
      topicRequestMaxBytes: config.topicRequestMaxBytes, topicPageRequestMaxBytes: config.topicPageRequestMaxBytes,
      topicSourceExcerptMaxBytes: config.topicSourceExcerptMaxBytes,
      recordSelection: (stage, target, selection, requestBytes, maxBytes, fallback) => {
        selectionRecorder.record(stage, target, selection);
        try { diagnostics.record(stage, target, selection, requestBytes, maxBytes, fallback); } catch { /* observer only */ }
      },
    };
    // A home stamped before links were read as their words (#332), whose sources are unchanged by
    // that reading, is unchanged: the gate compares that hash, so the wiki is not rebuilt for the
    // change of formula. Its next build stamps the current one.
    const stampedWithLinks = topicSynthesisHash(topicEvidence.topicHashWithLinks, config);
    const synthesisHash = !opts.force && existingWiki.home?.wiki_evidence_hash === stampedWithLinks
      ? stampedWithLinks : topicSynthesisHash(topicEvidence.topicHash, config);
    const pipeline = await runReconciliationPipeline({
      engine,
      llm,
      config,
      project: root.title,
      rootTitle: ev.project.title,
      wikiRootId,
      evidenceHash: synthesisHash,
      existingWiki,
      dryRun: opts.dryRun,
      preview: opts.preview ?? false,
      failureHoldHash: opts.failureHoldHash ?? null,
      deferred: opts.deferred ?? null,
      force: opts.force,
      refreshDue,
      topologySystem: config.curatorTopologyPrompt,
      adjudicationSystem: config.curatorCreateAdjudicationPrompt,
      pageSystem: config.curatorPagePrompt,
      homeSystem: spec.source === 'vault+web'
        ? promptOrDefault(config.curatorTopicWebPrompt, TOPIC_WEB_SYSTEM_PROMPT)
        : promptOrDefault(config.curatorTopicPrompt, TOPIC_SYSTEM_PROMPT),
      homeFocusTasks: false,
      ...(opts.buildStatus ? { buildStatus: opts.buildStatus } : {}),
      prepareEvidence: async () => {
        if (spec.source !== 'vault+web') {
          return { text: topicEvidence.mandatoryEvidence, nodes: topicEvidence.evidenceNodes, topicEvidence: topicContext };
        }
        const admittedProbe = opts.admission.trigger === 'web_material_change'
          ? opts.admission.webProbe
          : undefined;
        const web = await buildWebEvidence(engine, config, root.title, spec.brief, admittedProbe);
        webProbe = web.probe;
        return {
          text: topicEvidence.mandatoryEvidence,
          topicEvidence: { ...topicContext, sources: [...topicContext.sources, ...(web.evidenceSources ?? [])] },
          nodes: topicEvidence.evidenceNodes,
        };
      },
    });
    pipeline.result.evidenceSelection = diagnostics.snapshot();
    if (pipeline.result.outcome !== 'written') return pipeline.result;

    const result: CurateResult = { ...pipeline.result };
    let memoryPersistence: Promise<MemoryWriteResult[]> | undefined;
    refreshCommitMaterialByResult.set(result, {
      sourceProjections: selectionRecorder.committedSources(),
      observedSourceNodeIds: topicEvidence.observedSourceNodeIds,
      ...(webProbe === undefined ? {} : { webProbe }),
      persistMemories: () => {
        memoryPersistence ??= persistMemories(engine, homeId, pipeline.memories, {
          enabled: config.memoryWriteEnabled,
          cap: config.memoryWriteCap,
          dryRun: opts.dryRun,
          evidence: { runRef: opts.runRef, hash: topicEvidence.topicHash },
          sourceRef: root.title,
        });
        return memoryPersistence;
      },
    });
    return result;
  } catch (err) {
    return { project: root.title, outcome: 'error', detail: `catalog: ${errMessage(err)}`, dryRun: opts.dryRun };
  }
}

export function topicSynthesisHash(evidenceHash: string, config: Config): string {
  return createHash('sha256').update(JSON.stringify({ evidence: evidenceHash, policy: 1,
    limits: [config.topicRequestMaxBytes, config.topicPageRequestMaxBytes, config.topicSourceExcerptMaxBytes] })).digest('hex');
}
