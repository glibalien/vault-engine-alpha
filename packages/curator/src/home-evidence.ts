import { bindWikiStageClient, type ResolvedWikiStagePolicy } from './wiki-output-policy.js';
import { buildHomeRequest } from './home-request.js';
import { readCaptureLimits, type CaptureLimits } from './provenance-budget.js';
import { selectHomeEvidence } from './provenance-selection.js';
import { EvidenceCollector, type CorrectionInput } from './provenance-evidence.js';
import { completeHomeEvidenceObservations } from './provenance-evidence-read.js';
import { runLocalCorrections } from './db/provenance.js';
import type { LlmClient } from './llm/types.js';
import { nodeStatus, vaultOf, type Config } from './config.js';
import { Engine } from './engine.js';
import {
  buildEvidence,
  gapFillQueryText,
  collectEvidenceIds,
  fieldValue,
  truncate,
} from './evidence.js';
import { SPEC_A_SYSTEM_PROMPT } from './synthesize.js';
import { memoryConflicts, memoryDay, selectWikiMemories, withSourceLabels } from './wiki-memories.js';
import type { ReconciliationEvidence } from './reconciliation-pipeline.js';
import type {
  EngineNode, GapFillCandidate, Memory, ProjectEvidence, ProjectRef, ExistingWiki,
} from './types.js';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function promptOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

/**
 * Gather semantically-related-but-unlinked candidate nodes to enrich the home
 * overview. Best-effort: search failure yields []; unreadable tracked candidates
 * are omitted before formatting. Runs only when enabled, dedups
 * against everything already in the structured evidence, caps at the limit, and
 * attaches bounded bodies to the top `semanticGapFillBodyReads` candidates.
 */
export async function gatherGapFillCandidates(
  engine: Engine,
  config: Config,
  project: ProjectRef,
  evidence: ProjectEvidence,
  collector?: EvidenceCollector,
): Promise<GapFillCandidate[]> {
  if (!config.semanticGapFill) return [];
  try {
    const queryText = gapFillQueryText(project, evidence);
    const raw = await engine.semanticRelated(queryText, config.semanticGapFillLimit, config);
    const seen = collectEvidenceIds(evidence, project);
    const fresh = raw.filter(n => !seen.has(n.id)).slice(0, config.semanticGapFillLimit);
    const bodyReads = Math.min(config.semanticGapFillBodyReads, fresh.length);
    const reads = config.projectHomeProvenanceEnabled ? fresh.length : bodyReads;
    const unavailable = new Set<number>();
    for (let i = 0; i < reads; i++) {
      const candidate = fresh[i];
      if (!candidate) continue;
      try {
        const node = await engine.getNode(candidate.id, config.projectHomeProvenanceEnabled ? { includeProvenance: true, includeEmbeds: false } : {});
        const body = (node.body ?? '').trim();
        if (config.projectHomeProvenanceEnabled) {
          fresh[i] = { ...candidate, title: node.title ?? candidate.title, types: node.types,
            status: nodeStatus(node.fields, node.types, vaultOf(config)),
            ...(i < bodyReads ? { body: truncate(body, config.bodyCharCap) } : {}),
            provenance_observation: node.provenance_observation,
            provenance_truncated: i < bodyReads && config.bodyCharCap !== null && body.length > config.bodyCharCap,
          };
        } else fresh[i] = { ...candidate, body: truncate(body, config.bodyCharCap) };
      } catch {
        if (config.projectHomeProvenanceEnabled) unavailable.add(i);
        collector?.omissions.push({ code: config.projectHomeProvenanceEnabled ? 'gap_fill_candidate_unavailable' : 'gap_fill_body_unavailable', source: collector.observations[candidate.id]?.source ?? null });
        // Tracked inputs need a coherent read; legacy enrichment keeps search metadata.
      }
    }
    return fresh.filter((_, index) => !unavailable.has(index));
  } catch (err) {
    // Gap-fill is enrichment, never a hard dependency — a failure must not fail curation.
    // But surface it: a silent empty result hides engine/transport problems from the operator.
    collector?.omissions.push({ code: 'gap_fill_unavailable', source: null });
    console.warn(`[curator] gap-fill skipped for ${project.title}: ${errMessage(err)}`);
    return [];
  }
}

/** A note filed under this many projects or more is a broad summary (#474). */
const BROAD_NOTE_PROJECT_COUNT = 3;
/** A broad summary within this long of a project-specific note or meeting covers a period that
 *  note already covers, so it is read only if there's room. */
const COVERED_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

function isBroad(projectCount: number | undefined): boolean {
  return (projectCount ?? 1) >= BROAD_NOTE_PROJECT_COUNT;
}

/**
 * The notes to read, newest first, except that a broad summary goes last when a project-specific
 * note or meeting is within a week of it (#474 idea 5): a claim from the project's own note
 * outranks its restatement in a note filed under eight projects, and broad summaries fill only
 * the periods no specific note covers. A note without a date counts as uncovered.
 */
export function noteReadOrder<T extends { readonly project_count?: number; readonly file_mtime?: number | null }>(
  notes: readonly T[], meetings: readonly { readonly project_count?: number; readonly file_mtime?: number | null }[] = [],
): T[] {
  const specificTimes = [...notes, ...meetings].filter(n => !isBroad(n.project_count) && typeof n.file_mtime === 'number')
    .map(n => n.file_mtime as number);
  const covered = (note: T): boolean => isBroad(note.project_count) && typeof note.file_mtime === 'number'
    && specificTimes.some(time => Math.abs(time - (note.file_mtime as number)) <= COVERED_WITHIN_MS);
  return [...notes.filter(note => !covered(note)), ...notes.filter(covered)];
}

/** Why a note was read, with how specific it is (#474). No count (an older Engine) or none: the old reason. */
function noteReadReason(projectCount: number | undefined): string {
  if (projectCount === undefined || projectCount < 1) return 'Recent associated note.';
  if (projectCount === 1) return 'Associated note, filed under 1 project.';
  if (projectCount < BROAD_NOTE_PROJECT_COUNT) return `Associated note, filed under ${projectCount} projects.`;
  return `Associated note, filed under ${projectCount} projects: a broad summary; prefer a project-specific note where both cover the same thing.`;
}

/**
 * Build the home-synthesis read set by category from the typed evidence buckets
 * (not the engine's suggested_reads ranking, which starves narrative behind tasks):
 * project root + existing wiki home (context), then the most recent meetings, then
 * the newest notes not already read, a broad summary last when a project-specific note or
 * meeting covers its week (`noteReadOrder`, #474), so summary notes filed under many
 * projects don't crowd out the project's own but still fill weeks nothing else covers.
 * Meetings are read before notes so they win dedup — the engine's `notes` bucket also
 * contains meeting nodes. Full bodies (the bodyCharCap escape hatch still applies in
 * buildEvidence). Unreadable nodes are skipped, never fatal. Task bodies are
 * intentionally not read — task state is already rendered from the task buckets.
 */
export async function gatherHomeReads(
  engine: Engine,
  evidence: ProjectEvidence,
  config: Config,
  collector?: EvidenceCollector,
): Promise<Array<EngineNode & { reason?: string }>> {
  const readNodes: Array<EngineNode & { reason?: string }> = [];
  const seen = new Set<string>();
  const read = async (id: string | null | undefined, reason: string): Promise<void> => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    try {
      readNodes.push({ ...(await engine.getNode(id, config.projectHomeProvenanceEnabled ? { includeProvenance: true, includeEmbeds: false } : {})), reason });
    } catch {
      collector?.omissions.push({ code: 'source_body_unavailable', source: collector.observations[id]?.source ?? null });
      // Skip an unreadable node rather than failing the whole project.
    }
  };

  if (evidence.meetings.recent.length > config.meetingReads) collector?.omissions.push({ code: 'meeting_read_count_cap', source: null });
  if (evidence.notes.length > config.noteReads) collector?.omissions.push({ code: 'note_read_count_cap', source: null });
  await read(evidence.project.id, 'Project root; canonical context.');
  await read(evidence.existing_wiki.home_id, 'Existing wiki home — CONTEXT ONLY; may be stale, not authoritative for task status.');
  for (const m of evidence.meetings.recent.slice(0, config.meetingReads)) {
    await read(m.id, 'Recent project meeting (summary + action items).');
  }
  const notes = noteReadOrder(evidence.notes.filter((n) => !seen.has(n.id)), evidence.meetings.recent);
  for (const n of notes.slice(0, config.noteReads)) {
    await read(n.id, noteReadReason(n.project_count));
  }
  return readNodes;
}

/** The project's names for memory selection: its title, aliases and linked companies. */
function projectNames(evidence: ProjectEvidence, root: EngineNode | undefined): string[] {
  // get-node returns each field as { value, type, source }.
  const aliases = fieldValue(root?.fields?.['aliases'] ?? root?.fields?.['alias']);
  return [evidence.project.title,
    ...(Array.isArray(aliases) ? aliases : [aliases]).filter((a): a is string => typeof a === 'string'),
    ...(evidence.contacts?.companies ?? []).map(company => company.title)];
}

/** The notes around a project whose memories are about it too (#719): its companies, then the
 *  people on its own note (the people field, `direct`; owner's choice over meeting attendees). */
export function projectSubjectIds(evidence: ProjectEvidence): string[] {
  return [...(evidence.contacts?.companies ?? []).map(company => company.id),
    ...(evidence.contacts?.people ?? []).filter(person => person.direct).map(person => person.id)];
}

/** The owner's memories and this project's (#297). Best effort: a failed read leaves the build
 *  without memories and records an omission. A requested page selects the same way (#313). */
export async function projectMemories(
  engine: Engine, project: ProjectRef, evidence: ProjectEvidence, readNodes: readonly EngineNode[],
  relatedNodeIds: readonly string[], homeId: string | null, tracked: boolean, collector: EvidenceCollector | undefined,
): Promise<Memory[]> {
  try {
    const selected = await selectWikiMemories(engine, {
      rootId: evidence.project.id, homeId, projectId: evidence.project.id,
      names: projectNames(evidence, readNodes.find(node => node.id === evidence.project.id)),
      subjectNoteIds: [evidence.project.id],
      relatedSubjectIds: projectSubjectIds(evidence),
      evidenceNodeIds: [...collectEvidenceIds(evidence, { ...project, id: evidence.project.id })],
      relatedNodeIds,
    }, { includeProvenance: tracked });
    if (selected.omitted > 0) collector?.omissions.push({ code: 'memory_limit', source: null });
    return [...selected.memories];
  } catch (error) {
    collector?.omissions.push({ code: 'memory_read_unavailable', source: null });
    console.warn(`[curator] memory fetch skipped for ${project.title}: ${errMessage(error)}`);
    return [];
  }
}

export interface HomeEvidenceInput {
  homePolicy?: ResolvedWikiStagePolicy;
  engine: Engine; llm: LlmClient; config: Config; project: ProjectRef; evidence: ProjectEvidence & { readonly existing_wiki: ExistingWiki };
  pinnedTitles: ReadonlySet<string>; corrections: readonly string[]; runRef: string;
  trackedCorrections?: readonly CorrectionInput[]; generatedAt?: Date;
  /** Pairs of memories the reconciler kept both of, among the given ids (#474 idea 4). */
  readConflicts?: (memoryIds: readonly number[]) => ReadonlyArray<readonly [number, number]>;
}
export async function prepareHomeEvidence(input: HomeEvidenceInput): Promise<ReconciliationEvidence> {
  const { engine, config, project, evidence, pinnedTitles, corrections, runRef, trackedCorrections } = input;
  const llm = input.homePolicy ? bindWikiStageClient(input.llm, input.homePolicy) : input.llm;
  const tracked = config.projectHomeProvenanceEnabled === true;
  const wikiRootId = evidence.project.id;
  const homeId = evidence.existing_wiki.home_id;
  if (tracked && (!llm.supportsPreparedCapture || !llm.previewStructuredCall)) throw new Error('PROVENANCE_CAPTURE_UNSUPPORTED');
  let limits: CaptureLimits | undefined;
  if (tracked) {
    const status = await engine.inspectProvenance({ select: 'status' });
    if (status.select !== 'status' || status.capability_version !== 1) throw new Error('PROVENANCE_CAPTURE_UNSUPPORTED');
    limits = readCaptureLimits(status.limits);
  }

  let evidenceForSynthesis = evidence;
  let selectedSince: string | null = null;
  const priorCuratedAt = evidence.existing_wiki.home?.wiki_curated_at;
  if (priorCuratedAt !== undefined) {
    try {
      evidenceForSynthesis = tracked
        ? await engine.projectEvidence(wikiRootId, config.meetingReads, priorCuratedAt, { includeProvenance: true })
        : await engine.projectEvidence(wikiRootId, config.meetingReads, priorCuratedAt);
      selectedSince = priorCuratedAt;
    } catch {
      evidenceForSynthesis = evidence;
    }
  }
  if (tracked) evidenceForSynthesis = await completeHomeEvidenceObservations(
    engine, evidenceForSynthesis, wikiRootId, config.meetingReads, selectedSince ?? undefined,
  );
  const correctionMetadata = tracked ? (trackedCorrections ?? runLocalCorrections(corrections, runRef)) : [];
  const collector = tracked ? new EvidenceCollector(evidenceForSynthesis.provenance_observations?.nodes ?? {}, correctionMetadata, {
    evidence_hash: evidenceForSynthesis.evidence_hash, evaluated_at: evidenceForSynthesis.generated_at,
    query: { project: wikiRootId, meeting_recent_limit: Math.min(config.meetingReads, 100), meeting_upcoming_limit: 8, contact_limit: 25, since: selectedSince },
  }) : undefined;
  const candidates = await gatherGapFillCandidates(engine, config, project, evidenceForSynthesis, collector);
  const readNodes = await gatherHomeReads(engine, evidenceForSynthesis, config, collector);
  const curatorMemories = labelProjectMemories(await projectMemories(engine, project, evidenceForSynthesis, readNodes,
    candidates.map(candidate => candidate.id), homeId, tracked, collector), evidenceForSynthesis, readNodes, candidates, config.curatorTz);
  const conflicts = memoryConflicts(curatorMemories, input.readConflicts);
  if (collector && limits) {
    const homeContext = { generatedAt: input.generatedAt ?? new Date(), timeZone: config.curatorTz, model: input.homePolicy?.model ?? config.model, maxTokens: input.homePolicy?.maxTokens ?? config.homeMaxTokens,
      ...(input.homePolicy ? { homePolicy: input.homePolicy } : {}),
      system: promptOrDefault(config.curatorProjectHomePrompt, SPEC_A_SYSTEM_PROMPT), limits };
    const readOmissions = [...collector.omissions];
    const selected = await selectHomeEvidence({ candidates, limits,
      render: (included, omissions) => {
        const fresh = new EvidenceCollector(collector.observations, collector.corrections, collector.assemblyContext);
        fresh.omissions.push(...readOmissions, ...omissions);
        const text = buildEvidence({ ...project, title: evidenceForSynthesis.project.title, status: evidenceForSynthesis.project.status },
          evidenceForSynthesis, readNodes, config.bodyCharCap, [...included], pinnedTitles,
          correctionMetadata.map(c => c.note), curatorMemories, fresh, vaultOf(config).wikiType, config.curatorTz, conflicts);
        return { text, collector: fresh };
      },
      preview: text => llm.previewStructuredCall!({ ...buildHomeRequest({ ...homeContext, evidence: text, pageIndex: [] }),
        malformedOutputPolicy: 'fail-closed-redacted' }),
    });
    const omissionCounts: Record<string, number> = {};
    for (const omission of selected.budgetOmissions) omissionCounts[omission.code] = (omissionCounts[omission.code] ?? 0) + 1;
    return { text: selected.text, provenance: selected.collector, nodes: readNodes, memories: curatorMemories,
      contacts: evidenceForSynthesis.contacts, conflicts,
      homeBudget: Object.freeze({ ...homeContext, omissionCounts: Object.freeze(omissionCounts) }) };
  }

  return {
    text: buildEvidence(tracked ? { ...project, title: evidenceForSynthesis.project.title, status: evidenceForSynthesis.project.status } : project,
      evidenceForSynthesis, readNodes, config.bodyCharCap, candidates, pinnedTitles,
      tracked ? correctionMetadata.map(c => c.note) : corrections, curatorMemories, collector, vaultOf(config).wikiType, config.curatorTz, conflicts),
    ...(collector ? { provenance: collector } : {}),
    nodes: readNodes,
    memories: curatorMemories,
    contacts: evidenceForSynthesis.contacts,
    conflicts,
  };
}


/** A project build's memories with the day each became true and where it came from (#474 idea 4),
 *  as their lines in a wiki prompt show them. A requested page labels its memories the same way (#631). */
export function labelProjectMemories(memories: readonly Memory[], evidence: ProjectEvidence, reads: readonly EngineNode[],
  candidates: readonly GapFillCandidate[], timeZone: string | undefined): Memory[] {
  return withSourceLabels(memories, evidenceTitles(evidence, reads, candidates), memoryDay(timeZone));
}

/** Every note title the build's evidence names, by id: where a memory's source note can be named. */
function evidenceTitles(evidence: ProjectEvidence, reads: readonly EngineNode[], candidates: readonly GapFillCandidate[]): Map<string, string> {
  const titles = new Map<string, string>();
  const add = (id: string | undefined, title: string | null | undefined): void => {
    if (id && title && !titles.has(id)) titles.set(id, title);
  };
  for (const node of reads) add(node.id, node.title);
  // The project note, which a requested page doesn't read (#631).
  add(evidence.project?.id, evidence.project?.title);
  for (const note of evidence.notes ?? []) add(note.id, note.title);
  for (const meeting of [...(evidence.meetings?.recent ?? []), ...(evidence.meetings?.upcoming ?? [])]) add(meeting.id, meeting.title);
  for (const person of evidence.contacts?.people ?? []) add(person.id, person.title);
  for (const company of evidence.contacts?.companies ?? []) add(company.id, company.title);
  for (const bucket of Object.values(evidence.tasks ?? {})) for (const task of bucket ?? []) add(task.id, task.title);
  for (const candidate of candidates) add(candidate.id, candidate.title);
  return titles;
}
