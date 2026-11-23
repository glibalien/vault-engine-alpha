// allow: SIZE_OK — cohesive candidate funnel and mutation-free evaluation seam; Task 9 extends its edge protocol.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import {
  conversationCaptureFingerprint,
  inspectConversation,
  type ConversationInspection,
} from '@vault/chat-core/conversation-inspection';
import { budgetRefusalDetail, isBudgetRefusal } from './budget.js';
import { vaultOf, type Config } from './config.js';
import {
  getConversationCaptureArtifact,
  getConversationCaptureLedger,
  lastConversationCaptureAt,
  listConversationCaptureArtifacts,
  listConversationCaptureLedgerByOutcome,
  setLastConversationCaptureAt,
  upsertConversationCaptureArtifact,
  upsertConversationCaptureLedger,
  type ConversationCaptureArtifactRow,
  type ConversationCaptureLedgerRow,
} from './db/conversation-capture.js';
import type { RunTrigger } from './db/runs.js';
import type { Engine } from './engine.js';
import type { ActionRecorder } from './journal/recorder.js';
import { StructuredCallFailure, type LlmClient, type StructuredCallFailureReason } from './llm/types.js';
import {
  captureBlockDate,
  captureBlockHash,
  captureCompositionHash,
  captureId,
  captureTitleCandidates,
  decodeCaptureMarkerAttribute,
  parseCaptureBlocks,
  renderCaptureBlock,
  type ParsedCaptureBlock,
} from './conversation-capture-markers.js';
import {
  adjudicateConversationCaptureArtifact,
  capturePlannerDestinationRecord,
  composeConversationCapture,
  planConversationCapture,
  type CaptureCompositionPlan,
  type CapturePlan,
  type CapturePlanReason,
  type ComposedCaptureArtifact,
  type CoverageAdjudication,
} from './conversation-capture-prompts.js';
import {
  destinationDecisionFingerprint,
  type DestinationDecisionEvidenceV1,
  type DestinationDecisionFingerprint,
  type DestinationProtectionReason,
} from './conversation-capture-destination-fingerprint.js';
import type { CurationQueue } from './queue.js';
import { localDate } from './date-line.js';
import type {
  ConversationAuthorityGuard,
  ConversationMeta,
  CreateNodePreview,
  CreateNodeResult,
  EngineNode,
} from './types.js';
import type { UsageReporter } from './usage-reporter.js';
import { RejectionBreaker } from './rejection-breaker.js';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export interface ConversationCaptureSweepDeps {
  engine: Engine;
  llm: LlmClient;
  config: Config;
  queue: CurationQueue;
  db?: Database.Database;
  usage?: UsageReporter;
  recorder?: ActionRecorder;
}

export interface ConversationCaptureProposal {
  captureId: string;
  conversationId: string;
  conversationTitle: string;
  destinationKind: 'created' | 'appended';
  destinationTitle: string;
  destinationNodeId?: string;
  /** Exact host-stamped Markdown supplied to the Engine dry-run. */
  body: string;
}

export interface ConversationCaptureSweepResult {
  ran: boolean;
  dryRun: boolean;
  detail?: string;
  scanned: number;
  settled: number;
  belowFloor: number;
  unchanged: number;
  unreliable: number;
  protectedOnly: number;
  evaluated: number;
  notValuable: number;
  fullyCovered: number;
  partiallyCovered: number;
  ungrounded: number;
  coverageCalls: number;
  uncoveredArtifacts: number;
  partiallyCoveredArtifacts: number;
  fullyCoveredArtifacts: number;
  wouldCreate: number;
  created: number;
  wouldAppend: number;
  appended: number;
  deferred: number;
  errors: number;
  proposals: ConversationCaptureProposal[];
  /** Set when the pass stopped early because one of its models kept rejecting the request (#254). */
  stopped?: string;
}

/** Mutation-free linked-node representation supplied to candidate evaluation. */
export interface ConversationCaptureLinkedNodeSnapshot {
  id: string;
  title: string;
  filePath: string;
  body: string;
  /** Required only when production preview reaches the CAS append boundary. */
  version?: number;
  fields: Record<string, unknown>;
}

/**
 * A caller must supply one outcome for every linked node. An absent/failed read
 * makes a bound candidate incomplete and therefore ineligible for planning.
 */
export type ConversationCaptureLinkedNodeRead =
  | { nodeId: string; ok: true; node: ConversationCaptureLinkedNodeSnapshot }
  | { nodeId: string; ok: false; error: string };

export interface EvaluateConversationCaptureCandidateInput {
  conversation: {
    id: string;
    title: string;
    updatedAt: string;
    linkedDocs: readonly string[];
  };
  inspection: ConversationInspection;
  inputHash: string;
  linkedNodeReads: readonly ConversationCaptureLinkedNodeRead[];
  priorCaptures: readonly { captureId: string; markdown: string }[];
  /** Host-owned evaluation-cap gate. Defaults to true. */
  allowModelCall?: boolean;
  /**
   * The date (YYYY-MM-DD) of the attribution line and the fallback note title (#496). The sweep
   * passes `captureDateFor`; defaults to the conversation's last update in `Config.curatorTz`.
   */
  capturedOn?: string;
}

export type ConversationCaptureEvaluationReason =
  | CapturePlanReason
  | 'fully-covered'
  | 'protected-only'
  | 'linked-read-failure'
  | 'unreliable-inspection'
  | 'below-floor'
  | 'evaluation-cap'
  | 'model-error'
  | 'budget';

export interface ConversationCaptureCandidateEvaluation {
  status: 'capture' | 'skip' | 'deferred';
  reasonCode: ConversationCaptureEvaluationReason;
  reason: string;
  modelEvaluated: boolean;
  partiallyCovered: boolean;
  plannedArtifactCount: number;
  coverageCalls: number;
  uncoveredArtifacts: number;
  partiallyCoveredArtifacts: number;
  fullyCoveredArtifacts: number;
  coverageAdjudications: Array<CoverageAdjudication & { artifactKey: string }>;
  plan?: CapturePlan;
  artifacts: ComposedCaptureArtifact[];
  proposals: ConversationCaptureProposal[];
}

function emptyResult(dryRun: boolean, detail?: string): ConversationCaptureSweepResult {
  return {
    ran: false,
    dryRun,
    scanned: 0,
    settled: 0,
    belowFloor: 0,
    unchanged: 0,
    unreliable: 0,
    protectedOnly: 0,
    evaluated: 0,
    notValuable: 0,
    fullyCovered: 0,
    partiallyCovered: 0,
    ungrounded: 0,
    coverageCalls: 0,
    uncoveredArtifacts: 0,
    partiallyCoveredArtifacts: 0,
    fullyCoveredArtifacts: 0,
    wouldCreate: 0,
    created: 0,
    wouldAppend: 0,
    appended: 0,
    deferred: 0,
    errors: 0,
    proposals: [],
    ...(detail === undefined ? {} : { detail }),
  };
}

function captureSummaryStats(result: ConversationCaptureSweepResult): Record<string, unknown> {
  return {
    scanned: result.scanned,
    settled: result.settled,
    belowFloor: result.belowFloor,
    unchanged: result.unchanged,
    unreliable: result.unreliable,
    protectedOnly: result.protectedOnly,
    evaluated: result.evaluated,
    notValuable: result.notValuable,
    fullyCovered: result.fullyCovered,
    partiallyCovered: result.partiallyCovered,
    ungrounded: result.ungrounded,
    coverageCalls: result.coverageCalls,
    uncoveredArtifacts: result.uncoveredArtifacts,
    partiallyCoveredArtifacts: result.partiallyCoveredArtifacts,
    fullyCoveredArtifacts: result.fullyCoveredArtifacts,
    wouldCreate: result.wouldCreate,
    created: result.created,
    wouldAppend: result.wouldAppend,
    appended: result.appended,
    deferred: result.deferred,
    errors: result.errors,
    proposals: result.proposals.length,
    ...(result.stopped === undefined ? {} : { stopped: result.stopped }),
  };
}

function captureSummaryLine(result: ConversationCaptureSweepResult): string {
  return `Conversation capture — scanned ${result.scanned}, evaluated ${result.evaluated}, created ${result.created}, appended ${result.appended}, deferred ${result.deferred}, errors ${result.errors}`
    + (result.stopped === undefined ? '' : `; ${result.stopped}`);
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STRUCTURED_FAILURE_REASONS = new Set<StructuredCallFailureReason>([
  'provider_dispatch_failed',
  'provider_transport_failed',
  'provider_call_failed',
  'provider_prompt_too_large',
  'missing_tool_use',
  'invalid_tool_use_count',
  'no_choices',
  'truncated',
  'content_filtered',
  'invalid_content_type',
  'empty_content',
  'malformed_json',
]);

function captureModelFailureDiagnostic(
  stage: 'planner' | 'coverage' | 'composer',
  error: unknown,
): string {
  try {
    if (error instanceof StructuredCallFailure
      && error.reason !== undefined
      && STRUCTURED_FAILURE_REASONS.has(error.reason)) {
      return `conversation capture ${stage} failed (reason=${error.reason})`;
    }
  } catch {
    // Hostile error objects still project to static metadata below.
  }
  return `conversation capture ${stage} failed`;
}

function appendDetail(result: ConversationCaptureSweepResult, detail: string): void {
  result.detail = result.detail === undefined ? detail : `${result.detail}; ${detail}`;
}

function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type RuntimeValidation<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateLinkedDocs(value: unknown): RuntimeValidation<string[]> {
  if (!Array.isArray(value) || value.some((nodeId) => typeof nodeId !== 'string' || nodeId.trim() === '')) {
    return { ok: false, error: 'linked_docs must be an array of strings' };
  }
  return { ok: true, value: normalizedLinkedDocs(value) };
}

const RFC3339_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isStrictIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = RFC3339_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    offsetSign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth[month - 1]!) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetSign !== undefined && (offsetHour > 23 || offsetMinute > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function validateConversationMeta(
  value: unknown,
  requireLinkedDocs: boolean,
  requireRevision: boolean,
): RuntimeValidation<ConversationMeta> {
  try {
    if (!isRecord(value)) return { ok: false, error: 'conversation metadata must be an object' };
    const { id, title, created_at: createdAt, updated_at: updatedAt, archived, revision } = value;
    if (typeof id !== 'string' || id.trim() === '') return { ok: false, error: 'id must be a non-empty string' };
    if (typeof title !== 'string') return { ok: false, error: 'title must be a string' };
    if (!isStrictIsoTimestamp(createdAt)) {
      return { ok: false, error: 'created_at must be an ISO timestamp' };
    }
    if (!isStrictIsoTimestamp(updatedAt)) {
      return { ok: false, error: 'updated_at must be an ISO timestamp' };
    }
    if (archived !== 0 && archived !== 1) return { ok: false, error: 'archived must be 0 or 1' };
    if (requireRevision && (!Number.isInteger(revision) || Number(revision) < 1)) {
      return { ok: false, error: 'revision must be a positive integer' };
    }
    if (revision !== undefined && (!Number.isInteger(revision) || Number(revision) < 1)) {
      return { ok: false, error: 'revision must be a positive integer' };
    }

    let linkedDocs: string[] | undefined;
    if (value.linked_docs !== undefined || requireLinkedDocs) {
      const validated = validateLinkedDocs(value.linked_docs);
      if (!validated.ok) return validated;
      linkedDocs = validated.value;
    }
    return {
      ok: true,
      value: {
        id,
        title,
        created_at: createdAt,
        updated_at: updatedAt,
        archived,
        ...(revision === undefined ? {} : { revision: Number(revision) }),
        ...(linkedDocs === undefined ? {} : { linked_docs: linkedDocs }),
      },
    };
  } catch (error) {
    return { ok: false, error: diagnostic(error) };
  }
}

interface ValidatedConversationDetail {
  conversation: ConversationMeta;
  messages: unknown[];
  linked_docs: string[];
}

function validateConversationDetail(value: unknown): RuntimeValidation<ValidatedConversationDetail> {
  try {
    if (!isRecord(value)) return { ok: false, error: 'detail must be an object' };
    const conversation = validateConversationMeta(value.conversation, false, true);
    if (!conversation.ok) return { ok: false, error: `conversation ${conversation.error}` };
    if (!Array.isArray(value.messages)) return { ok: false, error: 'messages must be an array' };
    const linkedDocs = validateLinkedDocs(value.linked_docs);
    if (!linkedDocs.ok) return linkedDocs;
    return {
      ok: true,
      value: {
        conversation: conversation.value,
        messages: value.messages,
        linked_docs: linkedDocs.value,
      },
    };
  } catch (error) {
    return { ok: false, error: diagnostic(error) };
  }
}

function normalizedLinkedDocs(linkedDocs: readonly string[]): string[] {
  return [...new Set(linkedDocs)].sort(lexicalCompare);
}

function metadataChangeAfterRead(
  listed: ConversationMeta,
  authoritative: ConversationMeta,
  authoritativeLinkedDocs: readonly string[],
): string | null {
  const fields: Array<keyof Omit<ConversationMeta, 'linked_docs'>> = [
    'id', 'title', 'created_at', 'updated_at', 'archived', 'revision',
  ];
  for (const field of fields) {
    if (listed[field] !== authoritative[field]) return field;
  }
  const listedLinks = normalizedLinkedDocs(listed.linked_docs ?? []);
  const authoritativeLinks = normalizedLinkedDocs(authoritativeLinkedDocs);
  if (listedLinks.length !== authoritativeLinks.length
    || listedLinks.some((nodeId, index) => nodeId !== authoritativeLinks[index])) {
    return 'linked_docs';
  }
  return null;
}

type ConversationAuthorityCheck =
  | { ok: true }
  | { ok: false; error: string; countError: boolean };

function conversationAuthorityGuard(
  detail: ValidatedConversationDetail,
): RuntimeValidation<ConversationAuthorityGuard> {
  const revision = detail.conversation.revision;
  if (!Number.isInteger(revision) || Number(revision) < 1) {
    return { ok: false, error: 'conversation authority revision is missing' };
  }
  const expectedLinkedDocs = normalizedLinkedDocs(detail.linked_docs);
  return {
    ok: true,
    value: {
      conversationId: detail.conversation.id,
      expectedRevision: Number(revision),
      expectedLinkMode: expectedLinkedDocs.length === 0 ? 'unbound' : 'bound',
      expectedLinkedDocs,
    },
  };
}

async function checkConversationAuthority(args: {
  engine: Engine;
  initial: ValidatedConversationDetail;
  inputHash: string;
  boundary: string;
}): Promise<ConversationAuthorityCheck> {
  let raw: unknown;
  try {
    raw = await args.engine.getConversation(args.initial.conversation.id);
  } catch (error) {
    return {
      ok: false,
      error: `conversation reread failed ${args.boundary}: ${diagnostic(error)}`,
      countError: true,
    };
  }
  const validated = validateConversationDetail(raw);
  if (!validated.ok) {
    return {
      ok: false,
      error: `malformed conversation reread ${args.boundary}: ${validated.error}`,
      countError: true,
    };
  }
  // Engine returns linked_docs beside the conversation row, not inside it, so
  // the first read's links travel with its row for the comparison.
  const changedField = metadataChangeAfterRead(
    { ...args.initial.conversation, linked_docs: args.initial.linked_docs },
    validated.value.conversation,
    validated.value.linked_docs,
  );
  if (changedField !== null) {
    return {
      ok: false,
      error: `conversation changed ${args.boundary} (${changedField})`,
      countError: false,
    };
  }
  const freshInspection = inspectConversation(validated.value.messages);
  const freshInputHash = conversationCaptureFingerprint(
    freshInspection,
    normalizedLinkedDocs(validated.value.linked_docs),
  );
  if (freshInputHash !== args.inputHash) {
    return {
      ok: false,
      error: `conversation changed ${args.boundary} (transcript)`,
      countError: false,
    };
  }
  return { ok: true };
}

function normalizedPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * The vault names conversation capture reads: the kind of the notes it creates (the vault map's
 * `journalType`, the kind of Curator's own notes) and the settings folder it never writes in
 * (Engine's `settingsDir`). With no journal kind the sweep is off, so a pass always has one.
 */
interface CaptureVocabulary {
  readonly noteType: string;
  readonly settingsPrefix: string;
}

/** The settings folder as a path prefix (`Settings/` by default). */
function captureSettingsPrefix(config: Pick<Config, 'settingsDir'>): string {
  return `${normalizedPath(config.settingsDir?.trim() || 'Settings').replace(/\/+$/, '')}/`;
}

/** The pass's vocabulary, or null when the journal kind is none (the sweep is off). */
function captureVocabulary(config: Pick<Config, 'settingsDir' | 'vault'>): CaptureVocabulary | null {
  const noteType = vaultOf(config).journalType;
  return noteType === null ? null : { noteType, settingsPrefix: captureSettingsPrefix(config) };
}

/** What a pass reports when the journal kind is none. */
export const CAPTURE_OFF_NO_NOTE_KIND = 'conversation capture is off: journalType is none in Settings/Vault.md, so there is no kind for the notes it writes';

function linkedDestinationProtectionReason(
  node: ConversationCaptureLinkedNodeSnapshot,
  settingsPrefix: string,
): DestinationProtectionReason | null {
  const path = normalizedPath(node.filePath);
  if (path.startsWith(settingsPrefix)) return 'settings-path';
  if (path.startsWith('.schemas/')) return 'schema-path';
  if (Object.prototype.hasOwnProperty.call(node.fields, 'vault_engine_projection')) return 'projection-field';
  return null;
}

function isProtected(node: ConversationCaptureLinkedNodeSnapshot, settingsPrefix: string): boolean {
  return linkedDestinationProtectionReason(node, settingsPrefix) !== null;
}

function destinationDecisionEvidence(
  reads: readonly ConversationCaptureLinkedNodeRead[],
  settingsPrefix: string,
): DestinationDecisionEvidenceV1[] | undefined {
  const evidence: DestinationDecisionEvidenceV1[] = [];
  for (const read of reads) {
    if (!read.ok || read.node.id !== read.nodeId || read.node.filePath.trim() === '') return undefined;
    const reason = linkedDestinationProtectionReason(read.node, settingsPrefix);
    evidence.push(reason === null
      ? {
        nodeId: read.node.id,
        state: 'eligible',
        plannerRecord: capturePlannerDestinationRecord({
          id: read.node.id,
          title: read.node.title,
          filePath: read.node.filePath,
          bodyExcerpt: read.node.body,
        }),
      }
      : { nodeId: read.node.id, state: 'protected', reason });
  }
  return evidence;
}

function priorCaptureDecisionIsUnchanged(
  prior: ConversationCaptureLedgerRow | undefined,
  inputHash: string,
  destination: DestinationDecisionFingerprint | undefined,
): boolean {
  if (prior === undefined || prior.input_hash !== inputHash) return false;
  if (prior.outcome === 'protected-only') return false;
  if (prior.outcome !== 'no-fitting-destination') return true;
  return destination !== undefined
    && prior.decision_evidence_version === destination.version
    && prior.decision_evidence_hash === destination.hash;
}

function normalizedTitleIdentity(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

function escapeMarkdownHeading(title: string): string {
  return title.replace(/[&<>]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
  })[character] ?? character);
}

function deferredEvaluation(
  reasonCode: ConversationCaptureEvaluationReason,
  reason: string,
  modelEvaluated = false,
  coverage: {
    coverageCalls: number;
    uncoveredArtifacts: number;
    partiallyCoveredArtifacts: number;
    fullyCoveredArtifacts: number;
  } = {
    coverageCalls: 0,
    uncoveredArtifacts: 0,
    partiallyCoveredArtifacts: 0,
    fullyCoveredArtifacts: 0,
  },
): ConversationCaptureCandidateEvaluation {
  return {
    status: 'deferred',
    reasonCode,
    reason,
    modelEvaluated,
    partiallyCovered: false,
    plannedArtifactCount: 0,
    ...coverage,
    coverageAdjudications: [],
    artifacts: [],
    proposals: [],
  };
}

function skippedEvaluation(
  reasonCode: ConversationCaptureEvaluationReason,
  reason: string,
): ConversationCaptureCandidateEvaluation {
  return {
    status: 'skip',
    reasonCode,
    reason,
    modelEvaluated: false,
    partiallyCovered: false,
    plannedArtifactCount: 0,
    coverageCalls: 0,
    uncoveredArtifacts: 0,
    partiallyCoveredArtifacts: 0,
    fullyCoveredArtifacts: 0,
    coverageAdjudications: [],
    artifacts: [],
    proposals: [],
  };
}

function eligibleLinkedNodes(
  input: EvaluateConversationCaptureCandidateInput,
  settingsPrefix: string,
): { ok: true; nodes: ConversationCaptureLinkedNodeSnapshot[] } | { ok: false; result: ConversationCaptureCandidateEvaluation } {
  const linkedDocs = normalizedLinkedDocs(input.conversation.linkedDocs);
  if (linkedDocs.length === 0) {
    if (input.linkedNodeReads.length > 0) {
      return { ok: false, result: deferredEvaluation('linked-read-failure', 'unbound candidate supplied linked-node reads') };
    }
    return { ok: true, nodes: [] };
  }

  const byId = new Map<string, ConversationCaptureLinkedNodeRead>();
  for (const read of input.linkedNodeReads) {
    if (byId.has(read.nodeId)) {
      return { ok: false, result: deferredEvaluation('linked-read-failure', `duplicate linked-node read for ${read.nodeId}`) };
    }
    byId.set(read.nodeId, read);
  }

  const snapshots: ConversationCaptureLinkedNodeSnapshot[] = [];
  for (const nodeId of linkedDocs) {
    const read = byId.get(nodeId);
    if (read === undefined || !read.ok) {
      const reason = read === undefined ? 'missing read outcome' : read.error;
      return { ok: false, result: deferredEvaluation('linked-read-failure', `${nodeId}: ${reason}`) };
    }
    if (read.node.id !== nodeId || read.node.filePath.trim() === '') {
      return { ok: false, result: deferredEvaluation('linked-read-failure', `${nodeId}: invalid linked-node snapshot`) };
    }
    snapshots.push(read.node);
  }

  const eligible = snapshots.filter((node) => !isProtected(node, settingsPrefix));
  if (eligible.length === 0) {
    return { ok: false, result: skippedEvaluation('protected-only', 'every linked destination is protected') };
  }
  return { ok: true, nodes: eligible };
}

function proposalForDestination(args: {
  input: EvaluateConversationCaptureCandidateInput;
  destinationNode: ConversationCaptureLinkedNodeSnapshot | undefined;
  artifacts: ComposedCaptureArtifact[];
  capturedOn: string;
  destinationTitle?: string;
}): ConversationCaptureProposal {
  const appended = args.destinationNode !== undefined;
  const multiple = args.artifacts.length > 1;
  const destinationTitle = args.destinationTitle ?? (appended
    ? args.destinationNode!.title
    : args.artifacts[0]!.title);
  const blockTitle = multiple ? args.input.conversation.title : args.artifacts[0]!.title;
  const markdown = multiple
    ? args.artifacts.map((artifact) => `### ${escapeMarkdownHeading(artifact.title)}\n\n${artifact.markdown}`).join('\n\n')
    : args.artifacts[0]!.markdown;
  const sourceUrls = [...new Set(args.artifacts.flatMap((artifact) => artifact.sourceUrls))].sort(lexicalCompare);
  const id = captureId({
    conversationId: args.input.conversation.id,
    inputHash: args.input.inputHash,
    destinationIdentity: args.destinationNode?.id ?? normalizedTitleIdentity(destinationTitle),
    compositionHash: captureCompositionHash(markdown),
  });
  const body = renderCaptureBlock({
    captureId: id,
    conversationId: args.input.conversation.id,
    transcriptHash: args.input.inputHash,
    conversationTitle: args.input.conversation.title,
    capturedOn: args.capturedOn,
    title: blockTitle,
    markdown,
    sourceUrls,
    includeHeading: appended,
  });
  return {
    captureId: id,
    conversationId: args.input.conversation.id,
    conversationTitle: args.input.conversation.title,
    destinationKind: appended ? 'appended' : 'created',
    destinationTitle,
    ...(args.destinationNode === undefined ? {} : { destinationNodeId: args.destinationNode.id }),
    body,
  };
}

function groupProposals(
  input: EvaluateConversationCaptureCandidateInput,
  plan: CaptureCompositionPlan,
  artifacts: ComposedCaptureArtifact[],
  linkedNodes: readonly ConversationCaptureLinkedNodeSnapshot[],
  capturedOn: string,
): ConversationCaptureProposal[] {
  const composedByKey = new Map(artifacts.map((artifact) => [artifact.artifactKey, artifact]));
  const nodeById = new Map(linkedNodes.map((node) => [node.id, node]));
  const groups = new Map<string, { destinationNode: ConversationCaptureLinkedNodeSnapshot | undefined; artifacts: ComposedCaptureArtifact[] }>();
  for (const planned of plan.artifacts) {
    const composed = composedByKey.get(planned.artifactKey);
    if (composed === undefined) throw new Error(`missing composed artifact ${planned.artifactKey}`);
    const destinationNode = planned.destinationNodeId === null ? undefined : nodeById.get(planned.destinationNodeId);
    if (planned.destinationNodeId !== null && destinationNode === undefined) {
      throw new Error(`destination ${planned.destinationNodeId} is not eligible`);
    }
    const key = destinationNode === undefined ? `artifact:${planned.artifactKey}` : `node:${destinationNode.id}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { destinationNode, artifacts: [composed] });
    else group.artifacts.push(composed);
  }
  return [...groups.values()].map((group) => proposalForDestination({ input, capturedOn, ...group }));
}

/**
 * Pure candidate-evaluation seam for both production preview and the offline
 * evaluation corpus. It reads no Engine/DB state and performs no mutation: all
 * messages are already inspected, every linked read outcome is supplied, and
 * prior-capture coverage is explicitly scoped to this conversation.
 */
export async function evaluateConversationCaptureCandidate(
  deps: {
    llm: LlmClient;
    config: Config;
    usage?: UsageReporter;
    runRef?: string;
    /** The pass's breakers; each model call reports its outcome (#254). */
    rejections?: CaptureRejectionBreakers;
  },
  input: EvaluateConversationCaptureCandidateInput,
): Promise<ConversationCaptureCandidateEvaluation> {
  if (!input.inspection.coverageReliable) {
    return deferredEvaluation('unreliable-inspection', 'conversation inspection coverage is unreliable');
  }
  if (input.inspection.assistantChars < deps.config.conversationCaptureMinAssistantChars || input.inspection.turns.length === 0) {
    return skippedEvaluation('below-floor', 'visible assistant prose is below the configured floor');
  }
  const linked = eligibleLinkedNodes(input, captureSettingsPrefix(deps.config));
  if (!linked.ok) return linked.result;
  if (input.allowModelCall === false) {
    return deferredEvaluation('evaluation-cap', 'conversation capture evaluation cap reached');
  }

  const context = {
    conversation: {
      id: input.conversation.id,
      title: input.conversation.title,
      updatedAt: input.conversation.updatedAt,
    },
    inspection: input.inspection,
    linkedNodes: linked.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      filePath: node.filePath,
      bodyExcerpt: node.body,
    })),
    priorCaptures: input.priorCaptures.map((capture) => ({ ...capture })),
    artifactCap: deps.config.conversationCaptureArtifactCap,
  };

  let plan: CapturePlan;
  try {
    ({ plan } = await withCaptureUsageContext(
      deps,
      'conversation-capture-planner',
      () => planConversationCapture(stageLlm(deps, 'planner'), deps.config, context),
    ));
  } catch (error) {
    if (isBudgetRefusal(error)) return deferredEvaluation('budget', `planner: ${budgetRefusalDetail(error)}`);
    return deferredEvaluation('model-error', captureModelFailureDiagnostic('planner', error), true);
  }

  if (plan.outcome === 'skip') {
    return {
      status: 'skip',
      reasonCode: plan.reasonCode,
      reason: plan.reason,
      modelEvaluated: true,
      partiallyCovered: false,
      plannedArtifactCount: 0,
      coverageCalls: 0,
      uncoveredArtifacts: 0,
      partiallyCoveredArtifacts: 0,
      fullyCoveredArtifacts: 0,
      coverageAdjudications: [],
      plan,
      artifacts: [],
      proposals: [],
    };
  }

  const hasCoverageEvidence = context.inspection.writeReceipts.length > 0
    || context.priorCaptures.length > 0;
  const coverageAdjudications: Array<CoverageAdjudication & { artifactKey: string }> = [];
  let coverageCalls = 0;
  const coverageLlm = stageLlm(deps, 'coverage');
  const countedCoverageLlm: LlmClient = {
    structuredCall: (request) => {
      coverageCalls += 1;
      return coverageLlm.structuredCall(request);
    },
  };
  try {
    for (const artifact of plan.artifacts) {
      let adjudication: CoverageAdjudication;
      if (hasCoverageEvidence) {
        const citedIds = new Set(artifact.assistantMessageIds);
        const citedAssistantTurns = context.inspection.turns.flatMap((turn) => (
          turn.role === 'assistant' && citedIds.has(turn.messageId)
            ? [{ messageId: turn.messageId, role: 'assistant' as const, text: turn.text }]
            : []
        ));
        ({ adjudication } = await withCaptureUsageContext(
          deps,
          'conversation-capture-coverage',
          () => adjudicateConversationCaptureArtifact(countedCoverageLlm, deps.config, {
            artifact,
            citedAssistantTurns,
            evidence: {
              writeReceipts: context.inspection.writeReceipts.map((receipt) => ({ ...receipt })),
              priorCaptures: context.priorCaptures.map((capture) => ({ ...capture })),
            },
          }),
        ));
      } else {
        adjudication = {
          decision: 'uncovered',
          reason: 'No eligible same-conversation coverage evidence was presented.',
          coveringToolCallIds: [],
          coveringCaptureIds: [],
          missingBrief: '',
        };
      }
      coverageAdjudications.push({ artifactKey: artifact.artifactKey, ...adjudication });
    }
  } catch (error) {
    if (isBudgetRefusal(error)) {
      return deferredEvaluation('budget', `coverage: ${budgetRefusalDetail(error)}`, true, {
        coverageCalls, uncoveredArtifacts: 0, partiallyCoveredArtifacts: 0, fullyCoveredArtifacts: 0,
      });
    }
    return deferredEvaluation('model-error', captureModelFailureDiagnostic('coverage', error), true, {
      coverageCalls,
      uncoveredArtifacts: 0,
      partiallyCoveredArtifacts: 0,
      fullyCoveredArtifacts: 0,
    });
  }

  const uncoveredArtifacts = coverageAdjudications.filter((adjudication) => adjudication.decision === 'uncovered').length;
  const partiallyCoveredArtifacts = coverageAdjudications.filter((adjudication) => adjudication.decision === 'partial').length;
  const fullyCoveredArtifacts = coverageAdjudications.filter((adjudication) => adjudication.decision === 'full').length;
  const completedCoverage = {
    coverageCalls,
    uncoveredArtifacts,
    partiallyCoveredArtifacts,
    fullyCoveredArtifacts,
  };

  const compositionPlan: CaptureCompositionPlan = {
    artifacts: plan.artifacts.flatMap((artifact, index) => {
      const adjudication = coverageAdjudications[index];
      if (adjudication === undefined) throw new Error('missing successful coverage adjudication');
      if (adjudication.decision === 'full') return [];
      return [{
        ...artifact,
        brief: adjudication.decision === 'partial' ? adjudication.missingBrief : artifact.brief,
        coverage: adjudication.decision,
        coveringToolCallIds: [...adjudication.coveringToolCallIds],
        coveringCaptureIds: [...adjudication.coveringCaptureIds],
      }];
    }),
  };
  const partiallyCovered = coverageAdjudications.some((adjudication) => adjudication.decision === 'partial');
  if (compositionPlan.artifacts.length === 0) {
    return {
      status: 'skip',
      reasonCode: 'fully-covered',
      reason: 'Every planned artifact is covered by eligible same-conversation evidence.',
      modelEvaluated: true,
      partiallyCovered: false,
      plannedArtifactCount: plan.artifacts.length,
      ...completedCoverage,
      coverageAdjudications,
      plan,
      artifacts: [],
      proposals: [],
    };
  }

  let artifacts: ComposedCaptureArtifact[];
  try {
    ({ artifacts } = await withCaptureUsageContext(
      deps,
      'conversation-capture-composer',
      () => composeConversationCapture(stageLlm(deps, 'composer'), deps.config, context, compositionPlan),
    ));
    const capturedOn = input.capturedOn ?? localDate(new Date(input.conversation.updatedAt), deps.config.curatorTz);
    const proposals = groupProposals(input, compositionPlan, artifacts, linked.nodes, capturedOn);
    return {
      status: 'capture',
      reasonCode: 'capture',
      reason: plan.reason,
      modelEvaluated: true,
      partiallyCovered,
      plannedArtifactCount: plan.artifacts.length,
      ...completedCoverage,
      coverageAdjudications,
      plan,
      artifacts,
      proposals,
    };
  } catch (error) {
    if (isBudgetRefusal(error)) {
      return deferredEvaluation('budget', `composer: ${budgetRefusalDetail(error)}`, true, completedCoverage);
    }
    return deferredEvaluation(
      'model-error',
      captureModelFailureDiagnostic('composer', error),
      true,
      completedCoverage,
    );
  }
}

type CaptureModelStage = 'planner' | 'coverage' | 'composer';

function stageLlm(deps: { llm: LlmClient; rejections?: CaptureRejectionBreakers }, stage: CaptureModelStage): LlmClient {
  return deps.rejections ? deps.rejections.observe(deps.llm, stage) : deps.llm;
}

/**
 * Stops the capture pass once one of its model calls keeps being rejected (#254). Each call has
 * its own streak: the planner can succeed on every conversation while coverage, on its own model,
 * rejects every request. Conversations the pass then skips stay unledgered and are retried.
 */
export class CaptureRejectionBreakers {
  stopped: string | null = null;
  private readonly breakers: Record<CaptureModelStage, RejectionBreaker>;

  constructor(config: Pick<Config, 'model' | 'conversationCaptureModel' | 'conversationCaptureCoverageModel'>) {
    const model = config.conversationCaptureModel ?? config.model;
    this.breakers = {
      planner: new RejectionBreaker('conversation capture (planner)', model),
      coverage: new RejectionBreaker('conversation capture (coverage)', config.conversationCaptureCoverageModel ?? model),
      composer: new RejectionBreaker('conversation capture (composer)', model),
    };
  }

  /** The stage's client, reporting every call's outcome to its breaker. */
  observe(llm: LlmClient, stage: CaptureModelStage): LlmClient {
    return {
      structuredCall: async (request) => {
        try {
          const result = await llm.structuredCall(request);
          this.breakers[stage].succeeded();
          return result;
        } catch (error) {
          // A budget refusal (the daily cap or a provider key limit, #342) stops the pass at once.
          const breaker = this.breakers[stage];
          const stop = breaker.budgetStop(error) ?? breaker.failed(error);
          if (stop !== null) this.stopped ??= stop;
          throw error;
        }
      },
    };
  }
}

async function withCaptureUsageContext<T>(
  deps: { usage?: UsageReporter; runRef?: string },
  purpose: 'conversation-capture-planner' | 'conversation-capture-coverage' | 'conversation-capture-composer',
  work: () => Promise<T>,
): Promise<T> {
  try {
    if (deps.usage !== undefined && deps.runRef !== undefined) {
      deps.usage.setContext({ project: 'conversation-capture', runRef: deps.runRef, purpose });
    }
  } catch (error) {
    warnObserverFailure('conversation capture usage context setup failed', error);
  }
  try {
    return await work();
  } finally {
    try {
      deps.usage?.setContext(null);
    } catch (error) {
      warnObserverFailure('conversation capture usage context clear failed', error);
    }
  }
}

function linkedSnapshot(raw: EngineNode): ConversationCaptureLinkedNodeSnapshot | null {
  const wire = raw as EngineNode & { file_path?: unknown };
  if (
    typeof wire.file_path !== 'string'
    || typeof raw.title !== 'string'
    || typeof raw.body !== 'string'
  ) return null;
  return {
    id: raw.id,
    title: raw.title,
    filePath: wire.file_path,
    body: raw.body,
    ...(typeof raw.version === 'number' ? { version: raw.version } : {}),
    fields: raw.fields ?? {},
  };
}

async function readLinkedNodes(
  engine: Engine,
  linkedDocs: readonly string[],
): Promise<ConversationCaptureLinkedNodeRead[]> {
  const reads: ConversationCaptureLinkedNodeRead[] = [];
  for (const nodeId of normalizedLinkedDocs(linkedDocs)) {
    try {
      const snapshot = linkedSnapshot(await engine.getNode(nodeId));
      if (snapshot === null) reads.push({ nodeId, ok: false, error: 'linked-node response lacks file_path' });
      else reads.push({ nodeId, ok: true, node: snapshot });
    } catch (error) {
      reads.push({ nodeId, ok: false, error: diagnostic(error) });
    }
  }
  return reads;
}

type LinkedNodeSnapshotCheck =
  | { ok: true; value: ConversationCaptureLinkedNodeRead[] }
  | { ok: false; error: string; countError: boolean };

function linkedNodeSnapshotChange(
  expected: ConversationCaptureLinkedNodeSnapshot,
  actual: ConversationCaptureLinkedNodeSnapshot,
): string | null {
  if (actual.id !== expected.id) return 'id';
  if (actual.title !== expected.title) return 'title';
  if (actual.filePath !== expected.filePath) return 'file path';
  if (actual.body !== expected.body) return 'body';
  if (actual.version !== expected.version) return 'version';
  if (!isDeepStrictEqual(actual.fields, expected.fields)) return 'fields';
  return null;
}

async function checkLinkedNodeSnapshots(args: {
  engine: Engine;
  initial: readonly ConversationCaptureLinkedNodeRead[];
  boundary: string;
}): Promise<LinkedNodeSnapshotCheck> {
  if (args.initial.length === 0) return { ok: true, value: [] };
  const fresh = await readLinkedNodes(args.engine, args.initial.map((read) => read.nodeId));
  const freshById = new Map(fresh.map((read) => [read.nodeId, read]));
  for (const expected of args.initial) {
    if (!expected.ok) {
      return {
        ok: false,
        error: `linked destination baseline is unavailable ${args.boundary} (${expected.nodeId})`,
        countError: true,
      };
    }
    const actual = freshById.get(expected.nodeId);
    if (actual === undefined || !actual.ok) {
      return {
        ok: false,
        error: `linked destination reread failed ${args.boundary} (${expected.nodeId}): ${actual?.error ?? 'missing read outcome'}`,
        countError: true,
      };
    }
    const changedField = linkedNodeSnapshotChange(expected.node, actual.node);
    if (changedField !== null) {
      return {
        ok: false,
        error: `linked destination changed ${args.boundary} (${expected.nodeId}.${changedField})`,
        countError: false,
      };
    }
  }
  return { ok: true, value: fresh };
}

interface RecoveryNode {
  id: string;
  title: string;
  body: string;
  filePath?: string;
  types?: string[];
  fields?: Record<string, unknown>;
}

interface LocatedCapture {
  node: RecoveryNode;
  block: ParsedCaptureBlock;
  destinationKind: 'created' | 'appended';
}

interface RecoveredCaptureIdentity {
  artifact: ConversationCaptureArtifactRow;
  located: LocatedCapture;
}

type CaptureRecoveryResult =
  | { ok: true; artifacts: ConversationCaptureArtifactRow[]; identities: RecoveredCaptureIdentity[] }
  | { ok: false; error: string };

function recoveryNode(value: unknown): RecoveryNode | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id.trim() === '') return null;
  if (typeof value.title !== 'string' || typeof value.body !== 'string') return null;
  const wire = value as Record<string, unknown> & { filePath?: unknown; file_path?: unknown };
  const filePath = typeof wire.filePath === 'string'
    ? wire.filePath
    : typeof wire.file_path === 'string' ? wire.file_path : undefined;
  const types = Array.isArray(value.types) && value.types.every((type) => typeof type === 'string')
    ? value.types
    : undefined;
  const fields = isRecord(value.fields) ? value.fields : undefined;
  return {
    id: value.id,
    title: value.title,
    body: value.body,
    ...(filePath === undefined ? {} : { filePath }),
    ...(types === undefined ? {} : { types }),
    ...(fields === undefined ? {} : { fields }),
  };
}

function mergeRecoveryNode(left: RecoveryNode, right: RecoveryNode): RecoveryNode | null {
  if (left.id !== right.id || left.title !== right.title || left.body !== right.body) return null;
  if (left.filePath !== undefined && right.filePath !== undefined && left.filePath !== right.filePath) return null;
  if (left.types !== undefined && right.types !== undefined && JSON.stringify(left.types) !== JSON.stringify(right.types)) return null;
  if (left.fields !== undefined && right.fields !== undefined && JSON.stringify(left.fields) !== JSON.stringify(right.fields)) return null;
  return {
    ...left,
    ...(right.filePath === undefined ? {} : { filePath: right.filePath }),
    ...(right.types === undefined ? {} : { types: right.types }),
    ...(right.fields === undefined ? {} : { fields: right.fields }),
  };
}

interface CaptureBlockPayload {
  markdown: string;
}

function canonicalSourceUrls(line: string): string[] | null {
  if (!/^\*\*Sources:\*\* <[^<>\s]+>(?:, <[^<>\s]+>)*$/.test(line)) return null;
  const urls = line.slice('**Sources:** '.length).split(', ').map((wrapped) => wrapped.slice(1, -1));
  if (new Set(urls).size !== urls.length || [...urls].sort(lexicalCompare).some((url, index) => url !== urls[index])) {
    return null;
  }
  for (const value of urls) {
    try {
      const parsed = new URL(value);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        || parsed.hash !== ''
        || parsed.toString() !== value) return null;
    } catch {
      return null;
    }
  }
  return urls;
}

function canonicalCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Inverts the host renderer only after the actual destination context is
 * known. Optional source attribution is enumerated instead of greedily
 * stripped; capture identity plus a byte-for-byte re-render must select one
 * and only one original composition.
 */
function captureBlockPayload(args: {
  block: ParsedCaptureBlock;
  includeHeading: boolean;
  destinationIdentity: string;
}): RuntimeValidation<CaptureBlockPayload> {
  const lines = args.block.contentMarkdown.split('\n');
  if (lines.length < 4) return { ok: false, error: 'capture block lacks a unique canonical capture block interpretation' };
  const attributionIndex = lines.length - 2;
  const attribution = /^_Curated from “(.*)” on (\d{4}-\d{2}-\d{2})\._$/.exec(lines[attributionIndex] ?? '');
  if (attribution === null || !canonicalCalendarDate(attribution[2] ?? '')) {
    return { ok: false, error: 'capture block lacks a unique canonical capture block interpretation' };
  }
  const conversationTitle = decodeCaptureMarkerAttribute(attribution[1] ?? '');
  const capturedOn = attribution[2] ?? '';

  const content = lines.slice(1, attributionIndex);
  if (content.pop() !== '') {
    return { ok: false, error: 'capture block lacks a unique canonical capture block interpretation' };
  }
  let title = '';
  if (args.includeHeading) {
    const heading = content.shift();
    if (heading === undefined || !heading.startsWith('## From chat — ') || content.shift() !== '') {
      return { ok: false, error: 'capture block lacks a unique canonical capture block interpretation' };
    }
    title = decodeCaptureMarkerAttribute(heading.slice('## From chat — '.length));
  }

  const interpretations: Array<{ markdown: string; sourceUrls: string[] }> = [
    { markdown: content.join('\n'), sourceUrls: [] },
  ];
  const terminalLine = content[content.length - 1] ?? '';
  const sourceUrls = canonicalSourceUrls(terminalLine);
  const invalidTerminalSource = terminalLine.startsWith('**Sources:**') && sourceUrls === null;
  if (sourceUrls !== null && content[content.length - 2] === '') {
    interpretations.push({ markdown: content.slice(0, -2).join('\n'), sourceUrls });
  }

  const valid: CaptureBlockPayload[] = [];
  let canonicalRendererMatch = false;
  for (const interpretation of interpretations) {
    if (interpretation.markdown.length === 0 || interpretation.markdown !== interpretation.markdown.trim()) continue;
    try {
      const rendered = renderCaptureBlock({
        captureId: args.block.captureId,
        conversationId: args.block.conversationId,
        transcriptHash: args.block.transcriptHash,
        conversationTitle,
        capturedOn,
        title,
        markdown: interpretation.markdown,
        sourceUrls: interpretation.sourceUrls,
        includeHeading: args.includeHeading,
      });
      if (rendered !== args.block.contentMarkdown) continue;
      canonicalRendererMatch = true;
      const expectedCaptureId = captureId({
        conversationId: args.block.conversationId,
        inputHash: args.block.transcriptHash,
        destinationIdentity: args.destinationIdentity,
        compositionHash: captureCompositionHash(interpretation.markdown),
      });
      if (expectedCaptureId === args.block.captureId) valid.push({ markdown: interpretation.markdown });
    } catch {
      // A renderer-rejected composition cannot prove a historical host write.
    }
  }
  if (valid.length !== 1) {
    return {
      ok: false,
      error: canonicalRendererMatch && !invalidTerminalSource
        ? 'capture block destination identity mismatch'
        : 'capture block lacks a unique canonical capture block interpretation',
    };
  }
  return { ok: true, value: valid[0]! };
}

function isEligibleCreatedRecoveryNode(
  node: RecoveryNode,
  block: ParsedCaptureBlock,
  hasAuthoritativeArtifact: boolean,
  vocab: CaptureVocabulary,
): boolean {
  if (node.types?.includes(vocab.noteType) !== true || node.filePath === undefined || node.filePath.trim() === '') return false;
  const path = normalizedPath(node.filePath);
  const isProtected = path.startsWith(vocab.settingsPrefix)
    || path.startsWith('.schemas/')
    || (node.fields !== undefined && Object.prototype.hasOwnProperty.call(node.fields, 'vault_engine_projection'));
  const bodyIsExact = node.body.trim() === block.contentMarkdown;
  if (isProtected) return hasAuthoritativeArtifact && bodyIsExact;
  return hasAuthoritativeArtifact || bodyIsExact;
}

function isAuthoritativeCreatedArtifact(args: {
  artifact?: ConversationCaptureArtifactRow;
  node: RecoveryNode;
  block: ParsedCaptureBlock;
  conversationId: string;
}): boolean {
  const artifact = args.artifact;
  return artifact?.destination_kind === 'created'
    && artifact.capture_id === args.block.captureId
    && artifact.conversation_id === args.conversationId
    && artifact.input_hash === args.block.transcriptHash
    && artifact.destination_node_id === args.node.id
    && artifact.content_hash === captureBlockHash(args.block.contentMarkdown)
    && artifact.content_markdown === args.block.contentMarkdown;
}

function locateCaptureAtDestination(args: {
  node: RecoveryNode;
  block: ParsedCaptureBlock;
  conversationId: string;
  vocab: CaptureVocabulary;
  expectedDestinationKind?: 'created' | 'appended';
  historicalArtifact?: ConversationCaptureArtifactRow;
}): RuntimeValidation<LocatedCapture> {
  const hasAuthoritativeCreatedArtifact = isAuthoritativeCreatedArtifact({
    node: args.node,
    block: args.block,
    conversationId: args.conversationId,
    ...(args.historicalArtifact === undefined ? {} : { artifact: args.historicalArtifact }),
  });
  const attempt = (destinationKind: 'created' | 'appended'): RuntimeValidation<LocatedCapture> => {
    if (destinationKind === 'created' && !isEligibleCreatedRecoveryNode(
      args.node,
      args.block,
      hasAuthoritativeCreatedArtifact,
      args.vocab,
    )) {
      return { ok: false, error: `${args.block.captureId}: ineligible created-note destination` };
    }
    const payload = captureBlockPayload({
      block: args.block,
      includeHeading: destinationKind === 'appended',
      destinationIdentity: destinationKind === 'appended'
        ? args.node.id
        : normalizedTitleIdentity(args.node.title),
    });
    if (!payload.ok) return payload;
    return { ok: true, value: { node: args.node, block: args.block, destinationKind } };
  };

  if (args.expectedDestinationKind !== undefined) return attempt(args.expectedDestinationKind);
  const attempts = (['created', 'appended'] as const).map(attempt);
  const valid = attempts.filter((result): result is Extract<RuntimeValidation<LocatedCapture>, { ok: true }> => result.ok);
  if (valid.length === 1) return valid[0]!;
  if (valid.length > 1) {
    return { ok: false, error: `${args.block.captureId}: ambiguous created/appended recovery inverse` };
  }
  return {
    ok: false,
    error: attempts.map((result) => result.ok ? '' : result.error).filter(Boolean).join('; '),
  };
}

function recoveredArtifact(
  located: LocatedCapture,
  committedAt: string,
): ConversationCaptureArtifactRow {
  return {
    capture_id: located.block.captureId,
    conversation_id: located.block.conversationId,
    input_hash: located.block.transcriptHash,
    destination_kind: located.destinationKind,
    destination_node_id: located.node.id,
    content_hash: captureBlockHash(located.block.contentMarkdown),
    content_markdown: located.block.contentMarkdown,
    committed_at: committedAt,
  };
}

function sameArtifactIdentity(
  existing: ConversationCaptureArtifactRow,
  recovered: ConversationCaptureArtifactRow,
): boolean {
  return existing.capture_id === recovered.capture_id
    && existing.conversation_id === recovered.conversation_id
    && existing.input_hash === recovered.input_hash
    && existing.destination_kind === recovered.destination_kind
    && existing.destination_node_id === recovered.destination_node_id
    && existing.content_hash === recovered.content_hash
    && existing.content_markdown === recovered.content_markdown;
}

function sameLocatedCaptureIdentity(left: LocatedCapture, right: LocatedCapture): boolean {
  return left.destinationKind === right.destinationKind
    && left.block.captureId === right.block.captureId
    && left.block.conversationId === right.block.conversationId
    && left.block.transcriptHash === right.block.transcriptHash
    && left.block.contentMarkdown === right.block.contentMarkdown
    && left.node.id === right.node.id
    && left.node.title === right.node.title
    && left.node.body === right.node.body
    && left.node.filePath === right.node.filePath
    && JSON.stringify(left.node.types) === JSON.stringify(right.node.types)
    && JSON.stringify(left.node.fields) === JSON.stringify(right.node.fields);
}

function mergeRecoveredCaptureIdentities(
  target: Map<string, RecoveredCaptureIdentity>,
  incoming: readonly RecoveredCaptureIdentity[],
): RuntimeValidation<void> {
  for (const identity of incoming) {
    const captureIdentity = identity.artifact.capture_id;
    const prior = target.get(captureIdentity);
    if (prior === undefined) {
      target.set(captureIdentity, identity);
      continue;
    }
    if (!sameArtifactIdentity(prior.artifact, identity.artifact)
      || !sameLocatedCaptureIdentity(prior.located, identity.located)) {
      return { ok: false, error: `${captureIdentity}: recovered destination changed between discoveries` };
    }
  }
  return { ok: true, value: undefined };
}

function locateConversationCaptures(
  conversationId: string,
  nodes: readonly RecoveryNode[],
  existingById: ReadonlyMap<string, ConversationCaptureArtifactRow>,
  vocab: CaptureVocabulary,
): { ok: true; captures: Map<string, LocatedCapture> } | { ok: false; error: string } {
  const captures = new Map<string, LocatedCapture>();
  for (const node of nodes) {
    const parsed = parseCaptureBlocks(node.body);
    if (!parsed.ok) return { ok: false, error: `${node.id}: ${parsed.diagnostic}` };
    for (const block of parsed.blocks) {
      if (block.conversationId !== conversationId) continue;
      if (!/^cap-[a-f\d]{64}$/.test(block.captureId)) {
        return { ok: false, error: `${node.id}: mismatched recovery capture id ${block.captureId}` };
      }
      if (!/^[a-f\d]{64}$/.test(block.transcriptHash)) {
        return { ok: false, error: `${node.id}: mismatched recovery transcript hash for ${block.captureId}` };
      }
      if (captures.has(block.captureId)) {
        return { ok: false, error: `ambiguous recovery for ${block.captureId}` };
      }
      const existing = existingById.get(block.captureId);
      if (existing !== undefined && existing.destination_node_id !== node.id) {
        return { ok: false, error: `${block.captureId}: marker and artifact destination mismatch` };
      }
      const located = locateCaptureAtDestination({
        node,
        block,
        conversationId,
        vocab,
        ...(existing === undefined ? {} : { expectedDestinationKind: existing.destination_kind }),
        ...(existing === undefined ? {} : { historicalArtifact: existing }),
      });
      if (!located.ok) return { ok: false, error: `${node.id}: ${located.error}` };
      captures.set(block.captureId, located.value);
    }
  }
  return { ok: true, captures };
}

async function recoverConversationArtifacts(args: {
  engine: Engine;
  db?: Database.Database;
  vocab: CaptureVocabulary;
  conversationId: string;
  linkedReads: readonly ConversationCaptureLinkedNodeRead[];
  recoveredAt: string;
  persistRecovery: boolean;
}): Promise<CaptureRecoveryResult> {
  let existing: ConversationCaptureArtifactRow[];
  try {
    existing = args.db === undefined ? [] : listConversationCaptureArtifacts(args.db, args.conversationId);
  } catch (error) {
    return { ok: false, error: `artifact ledger read failed: ${diagnostic(error)}` };
  }

  const candidates = new Map<string, RecoveryNode>();
  const addCandidate = (value: unknown): string | null => {
    const candidate = recoveryNode(value);
    if (candidate === null) return 'recovery candidate is malformed';
    const prior = candidates.get(candidate.id);
    if (prior !== undefined) {
      const merged = mergeRecoveryNode(prior, candidate);
      if (merged === null) return `${candidate.id}: recovery candidate changed during scan`;
      candidates.set(candidate.id, merged);
    } else {
      candidates.set(candidate.id, candidate);
    }
    return null;
  };

  for (const read of args.linkedReads) {
    if (!read.ok) continue;
    const error = addCandidate({
      id: read.node.id,
      title: read.node.title,
      body: read.node.body,
      filePath: read.node.filePath,
      fields: read.node.fields,
    });
    if (error !== null) return { ok: false, error };
  }

  let ftsCandidates: EngineNode[];
  try {
    ftsCandidates = await args.engine.findNodesContainingConversationCapture(args.conversationId);
  } catch (error) {
    return { ok: false, error: `conversation marker candidate search failed: ${diagnostic(error)}` };
  }
  for (const candidate of ftsCandidates) {
    const error = addCandidate(candidate);
    if (error !== null) return { ok: false, error };
  }

  for (const artifact of existing) {
    if (candidates.has(artifact.destination_node_id)) continue;
    try {
      const error = addCandidate(await args.engine.getNode(artifact.destination_node_id));
      if (error !== null) return { ok: false, error };
    } catch (error) {
      return { ok: false, error: `${artifact.capture_id}: destination read failed: ${diagnostic(error)}` };
    }
  }

  const existingById = new Map(existing.map((artifact) => [artifact.capture_id, artifact]));
  const located = locateConversationCaptures(args.conversationId, [...candidates.values()], existingById, args.vocab);
  if (!located.ok) return located;
  const missing: ConversationCaptureArtifactRow[] = [];
  for (const [captureId, capture] of located.captures) {
    const recovered = recoveredArtifact(capture, args.recoveredAt);
    const artifact = existingById.get(captureId);
    if (artifact === undefined) missing.push(recovered);
    else if (!sameArtifactIdentity(artifact, recovered)) {
      return { ok: false, error: `${captureId}: marker and artifact ledger mismatch` };
    }
  }
  for (const artifact of existing) {
    if (!located.captures.has(artifact.capture_id)) {
      return { ok: false, error: `${artifact.capture_id}: artifact ledger has no authoritative paired marker` };
    }
  }

  if (args.persistRecovery) {
    if (args.db === undefined) return { ok: false, error: 'live capture recovery requires the Curator database' };
    try {
      for (const artifact of missing) upsertConversationCaptureArtifact(args.db, artifact);
    } catch (error) {
      return { ok: false, error: `artifact recovery persistence failed: ${diagnostic(error)}` };
    }
  }
  const artifacts = [...existing, ...missing].sort((a, b) => lexicalCompare(a.committed_at, b.committed_at)
    || lexicalCompare(a.capture_id, b.capture_id));
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.capture_id, artifact]));
  return {
    ok: true,
    artifacts,
    identities: [...located.captures.values()].map((capture) => ({
      artifact: artifactsById.get(capture.block.captureId)!,
      located: capture,
    })),
  };
}

async function revalidateRecoveredCaptureIdentities(args: {
  engine: Engine;
  vocab: CaptureVocabulary;
  conversationId: string;
  identities: readonly RecoveredCaptureIdentity[];
  expectedNodeBodies?: ReadonlyMap<string, string>;
}): Promise<RuntimeValidation<void>> {
  if (args.identities.length === 0 && (args.expectedNodeBodies?.size ?? 0) === 0) {
    return { ok: true, value: undefined };
  }
  const freshNodes = new Map<string, RecoveryNode>();
  const identityNodeIds = new Set(args.identities.map((identity) => identity.located.node.id));
  const nodeIds = new Set([
    ...identityNodeIds,
    ...(args.expectedNodeBodies?.keys() ?? []),
  ]);

  for (const nodeId of nodeIds) {
    const expected = args.identities.find((identity) => identity.located.node.id === nodeId)?.located.node;
    let raw: EngineNode;
    try {
      raw = await args.engine.getNode(nodeId);
    } catch (error) {
      return { ok: false, error: `${nodeId}: fresh recovered destination read failed: ${diagnostic(error)}` };
    }
    const fresh = recoveryNode(raw);
    if (fresh === null) return { ok: false, error: `${nodeId}: fresh recovered destination is malformed` };
    if (expected !== undefined && (fresh.title !== expected.title
      || (expected.filePath !== undefined && fresh.filePath !== expected.filePath)
      || (expected.types !== undefined && JSON.stringify(fresh.types) !== JSON.stringify(expected.types))
      || (expected.fields !== undefined && JSON.stringify(fresh.fields) !== JSON.stringify(expected.fields)))) {
      return { ok: false, error: `${nodeId}: recovered destination identity changed` };
    }
    const expectedBody = args.expectedNodeBodies?.get(nodeId) ?? expected?.body;
    if (expectedBody !== undefined && fresh.body !== expectedBody) {
      return { ok: false, error: `${nodeId}: recovered destination body changed` };
    }
    if (identityNodeIds.has(nodeId)) freshNodes.set(fresh.id, fresh);
  }

  const expectedById = new Map(args.identities.map((identity) => [
    identity.artifact.capture_id,
    identity.artifact,
  ]));
  const located = locateConversationCaptures(args.conversationId, [...freshNodes.values()], expectedById, args.vocab);
  if (!located.ok) return located;
  for (const identity of args.identities) {
    const fresh = located.captures.get(identity.artifact.capture_id);
    if (fresh === undefined) {
      return { ok: false, error: `${identity.artifact.capture_id}: recovered marker is missing` };
    }
    const refreshedArtifact = recoveredArtifact(fresh, identity.artifact.committed_at);
    if (!sameArtifactIdentity(identity.artifact, refreshedArtifact)) {
      return { ok: false, error: `${identity.artifact.capture_id}: recovered marker identity changed` };
    }
  }
  return { ok: true, value: undefined };
}

async function refreshConversationRecovery(args: {
  engine: Engine;
  db?: Database.Database;
  vocab: CaptureVocabulary;
  conversationId: string;
  linkedDocs: readonly string[];
  linkedReads?: readonly ConversationCaptureLinkedNodeRead[];
  recoveredAt: string;
  identities: Map<string, RecoveredCaptureIdentity>;
  persistRecovery: boolean;
}): Promise<RuntimeValidation<ConversationCaptureLinkedNodeRead[]>> {
  const linkedReads = args.linkedReads === undefined
    ? await readLinkedNodes(args.engine, args.linkedDocs)
    : [...args.linkedReads];
  const recovered = await recoverConversationArtifacts({
    engine: args.engine,
    db: args.db,
    vocab: args.vocab,
    conversationId: args.conversationId,
    linkedReads,
    recoveredAt: args.recoveredAt,
    persistRecovery: args.persistRecovery,
  });
  if (!recovered.ok) return recovered;
  const merged = mergeRecoveredCaptureIdentities(args.identities, recovered.identities);
  if (!merged.ok) return merged;
  const revalidated = await revalidateRecoveredCaptureIdentities({
    engine: args.engine,
    vocab: args.vocab,
    conversationId: args.conversationId,
    identities: [...args.identities.values()],
  });
  if (!revalidated.ok) return revalidated;
  return { ok: true, value: linkedReads };
}

function countSkip(result: ConversationCaptureSweepResult, reason: ConversationCaptureEvaluationReason): void {
  if (reason === 'not-valuable' || reason === 'no-fitting-destination') result.notValuable += 1;
  else if (reason === 'fully-covered') result.fullyCovered += 1;
  else if (reason === 'ungrounded-factual') result.ungrounded += 1;
}

function issueSummary(warnings: readonly unknown[]): string {
  return warnings.map((warning) => {
    if (typeof warning !== 'object' || warning === null) return String(warning);
    const record = warning as { code?: unknown; message?: unknown };
    if (typeof record.code === 'string') return record.code;
    if (typeof record.message === 'string') return record.message;
    return 'Engine warning';
  }).join(', ');
}

type ExistingProposalStatus =
  | { status: 'missing' }
  | { status: 'committed'; identity: RecoveredCaptureIdentity }
  | { status: 'error'; error: string };

function matchingProposalMarker(args: {
  vocab: CaptureVocabulary;
  proposal: ConversationCaptureProposal;
  inputHash: string;
  nodes: readonly RecoveryNode[];
  historicalArtifact?: ConversationCaptureArtifactRow;
}): { ok: true; located?: LocatedCapture } | { ok: false; error: string } {
  let located: LocatedCapture | undefined;
  for (const node of args.nodes) {
    const parsed = parseCaptureBlocks(node.body);
    if (!parsed.ok) return { ok: false, error: `${node.id}: ${parsed.diagnostic}` };
    for (const block of parsed.blocks) {
      if (block.captureId !== args.proposal.captureId) continue;
      if (located !== undefined) return { ok: false, error: `ambiguous recovery for ${block.captureId}` };
      if (block.conversationId !== args.proposal.conversationId
        || block.transcriptHash !== args.inputHash
        || block.contentMarkdown !== args.proposal.body
        || captureBlockHash(block.contentMarkdown) !== captureBlockHash(args.proposal.body)) {
        return { ok: false, error: `${block.captureId}: paired marker content mismatch` };
      }
      if (args.proposal.destinationKind === 'appended'
        && args.proposal.destinationNodeId !== node.id) {
        return { ok: false, error: `${block.captureId}: destination node mismatch` };
      }
      const validated = locateCaptureAtDestination({
        node,
        block,
        vocab: args.vocab,
        conversationId: args.proposal.conversationId,
        expectedDestinationKind: args.proposal.destinationKind,
        ...(args.historicalArtifact === undefined ? {} : { historicalArtifact: args.historicalArtifact }),
      });
      if (!validated.ok) return { ok: false, error: `${node.id}: ${validated.error}` };
      if (validated.value.destinationKind !== args.proposal.destinationKind) {
        return { ok: false, error: `${block.captureId}: destination kind mismatch` };
      }
      located = validated.value;
    }
  }
  return { ok: true, ...(located === undefined ? {} : { located }) };
}

async function existingProposalStatus(args: {
  deps: ConversationCaptureSweepDeps;
  vocab: CaptureVocabulary;
  proposal: ConversationCaptureProposal;
  inputHash: string;
  nodes?: readonly RecoveryNode[];
  persistRecovery: boolean;
  now: string;
}): Promise<ExistingProposalStatus> {
  let artifact: ConversationCaptureArtifactRow | undefined;
  if (args.deps.db !== undefined) {
    try {
      artifact = getConversationCaptureArtifact(args.deps.db, args.proposal.captureId);
    } catch (error) {
      return { status: 'error', error: `artifact ledger read failed: ${diagnostic(error)}` };
    }
  }

  const nodes = new Map<string, RecoveryNode>();
  const addNode = (value: unknown): string | null => {
    const candidate = recoveryNode(value);
    if (candidate === null) return 'capture marker candidate is malformed';
    const prior = nodes.get(candidate.id);
    if (prior !== undefined) {
      const merged = mergeRecoveryNode(prior, candidate);
      if (merged === null) return `${candidate.id}: capture marker candidate changed during check`;
      nodes.set(candidate.id, merged);
    } else {
      nodes.set(candidate.id, candidate);
    }
    return null;
  };
  for (const value of args.nodes ?? []) {
    const error = addNode(value);
    if (error !== null) return { status: 'error', error };
  }

  if (args.proposal.destinationKind === 'created') {
    let candidates: EngineNode[];
    try {
      candidates = await args.deps.engine.findNodesContainingCaptureId(args.proposal.captureId);
    } catch (error) {
      return { status: 'error', error: `capture marker candidate search failed: ${diagnostic(error)}` };
    }
    for (const candidate of candidates) {
      const error = addNode(candidate);
      if (error !== null) return { status: 'error', error };
    }
  }
  if (artifact !== undefined && !nodes.has(artifact.destination_node_id)) {
    try {
      const error = addNode(await args.deps.engine.getNode(artifact.destination_node_id));
      if (error !== null) return { status: 'error', error };
    } catch (error) {
      return { status: 'error', error: `${artifact.capture_id}: destination read failed: ${diagnostic(error)}` };
    }
  }

  const marker = matchingProposalMarker({
    vocab: args.vocab,
    proposal: args.proposal,
    inputHash: args.inputHash,
    nodes: [...nodes.values()],
    ...(artifact === undefined ? {} : { historicalArtifact: artifact }),
  });
  if (!marker.ok) return { status: 'error', error: marker.error };
  if (marker.located === undefined) {
    if (artifact !== undefined) {
      return { status: 'error', error: `${artifact.capture_id}: artifact ledger has no authoritative paired marker` };
    }
    return { status: 'missing' };
  }

  const recovered = recoveredArtifact(marker.located, args.now);
  if (artifact !== undefined && !sameArtifactIdentity(artifact, recovered)) {
    return { status: 'error', error: `${artifact.capture_id}: marker and artifact ledger mismatch` };
  }
  if (artifact === undefined && args.persistRecovery) {
    if (args.deps.db === undefined) return { status: 'error', error: 'live capture recovery requires the Curator database' };
    try {
      upsertConversationCaptureArtifact(args.deps.db, recovered);
    } catch (error) {
      return { status: 'error', error: `artifact recovery persistence failed: ${diagnostic(error)}` };
    }
  }
  return {
    status: 'committed',
    identity: {
      artifact: artifact ?? recovered,
      located: marker.located,
    },
  };
}

function warnObserverFailure(label: string, error: unknown): void {
  console.warn(`[curator] ${label}: ${diagnostic(error)}`);
}

function recordCaptureAction(
  deps: ConversationCaptureSweepDeps,
  proposal: ConversationCaptureProposal,
  nodeId: string,
): void {
  try {
    deps.recorder?.record({
      action: proposal.destinationKind === 'appended'
        ? 'conversation-capture-appended'
        : 'conversation-capture-created',
      nodeId,
      target: proposal.destinationTitle,
      detail: `capture ${proposal.captureId} from conversation "${proposal.conversationTitle}" (${proposal.conversationId}) committed to ${nodeId}`,
    });
  } catch (error) {
    warnObserverFailure('conversation capture journal write failed', error);
  }
}

function persistConfirmedArtifact(args: {
  db: Database.Database;
  proposal: ConversationCaptureProposal;
  inputHash: string;
  nodeId: string;
  committedAt: string;
}): void {
  upsertConversationCaptureArtifact(args.db, {
    capture_id: args.proposal.captureId,
    conversation_id: args.proposal.conversationId,
    input_hash: args.inputHash,
    destination_kind: args.proposal.destinationKind,
    destination_node_id: args.nodeId,
    content_hash: captureBlockHash(args.proposal.body),
    content_markdown: args.proposal.body,
    committed_at: args.committedAt,
  });
}

type ProposalExecutionResult = (
  | { complete: true }
  | { complete: false; error: string; countError: boolean }
) & {
  confirmedAppend?: { nodeId: string; expectedBodyAfter: string };
};

type StagedCaptureDestination =
  | { kind: 'committed'; proposal: ConversationCaptureProposal; nodeId: string }
  | {
    kind: 'append';
    proposal: ConversationCaptureProposal;
    nodeId: string;
    expectedVersion: number;
    expectedBodyAfter: string;
  }
  | { kind: 'create'; proposal: ConversationCaptureProposal; previewFilePath: string };

type StageCaptureDestinationsResult =
  | { ok: true; destinations: StagedCaptureDestination[] }
  | { ok: false; error: string; countError: boolean; destinationTitle: string };

function recoveredProposalStatus(args: {
  proposal: ConversationCaptureProposal;
  inputHash: string;
  identities: ReadonlyMap<string, RecoveredCaptureIdentity>;
}): ExistingProposalStatus | undefined {
  const recovered = args.identities.get(args.proposal.captureId);
  if (recovered === undefined) return undefined;
  const { artifact, located } = recovered;
  const destinationMatches = args.proposal.destinationKind === 'appended'
    ? args.proposal.destinationNodeId === located.node.id
    : normalizedTitleIdentity(args.proposal.destinationTitle) === normalizedTitleIdentity(located.node.title);
  if (artifact.conversation_id !== args.proposal.conversationId
    || artifact.input_hash !== args.inputHash
    || artifact.destination_kind !== args.proposal.destinationKind
    || artifact.destination_node_id !== located.node.id
    || artifact.content_markdown !== args.proposal.body
    || artifact.content_hash !== captureBlockHash(args.proposal.body)
    || located.block.contentMarkdown !== args.proposal.body
    || !destinationMatches) {
    return { status: 'error', error: `${args.proposal.captureId}: paired marker content mismatch` };
  }
  return { status: 'committed', identity: recovered };
}

async function stageCaptureDestinations(args: {
  deps: ConversationCaptureSweepDeps;
  vocab: CaptureVocabulary;
  destinations: readonly PreparedCaptureDestination[];
  recoveredIdentities: Map<string, RecoveredCaptureIdentity>;
  inputHash: string;
  dryRun: boolean;
  now: string;
  result: ConversationCaptureSweepResult;
  linkedNodeReads: readonly ConversationCaptureLinkedNodeRead[];
  revalidateRecovered: () => Promise<RuntimeValidation<void>>;
  conversationAuthority: ConversationAuthorityGuard;
}): Promise<StageCaptureDestinationsResult> {
  const verifiedLinkedNodes = new Map<string, ConversationCaptureLinkedNodeSnapshot>();
  for (const read of args.linkedNodeReads) {
    if (read.ok) verifiedLinkedNodes.set(read.nodeId, read.node);
  }
  const inspected: Array<{
    destination: PreparedCaptureDestination;
    committed?: { proposal: ConversationCaptureProposal; nodeId: string };
    appendLatest?: ConversationCaptureLinkedNodeSnapshot;
  }> = [];

  // Phase one is read-only: establish status for every concrete identity before
  // choosing any title or issuing any Engine dry-run/live call.
  for (const destination of args.destinations) {
    const committed: Array<{ proposal: ConversationCaptureProposal; nodeId: string }> = [];
    let appendLatest: ConversationCaptureLinkedNodeSnapshot | undefined;
    for (const proposal of destination.concreteCandidates) {
      let status = recoveredProposalStatus({ proposal, inputHash: args.inputHash, identities: args.recoveredIdentities });
      if (status === undefined) {
        const nodes: RecoveryNode[] = [];
        if (proposal.destinationKind === 'appended') {
          const nodeId = proposal.destinationNodeId;
          if (nodeId === undefined) {
            return { ok: false, error: 'append proposal lacks a destination node', countError: true, destinationTitle: proposal.destinationTitle };
          }
          appendLatest = verifiedLinkedNodes.get(nodeId);
          if (appendLatest === undefined || appendLatest.id !== nodeId || isProtected(appendLatest, args.vocab.settingsPrefix)) {
            return { ok: false, error: 'verified linked destination is unavailable, invalid, or protected', countError: true, destinationTitle: proposal.destinationTitle };
          }
          nodes.push(appendLatest);
        }
        status = await existingProposalStatus({
          vocab: args.vocab,
          deps: args.deps,
          proposal,
          inputHash: args.inputHash,
          nodes,
          persistRecovery: !args.dryRun,
          now: args.now,
        });
      }
      if (status.status === 'error') {
        return { ok: false, error: status.error, countError: true, destinationTitle: proposal.destinationTitle };
      }
      if (status.status === 'committed') {
        const merged = mergeRecoveredCaptureIdentities(args.recoveredIdentities, [status.identity]);
        if (!merged.ok) {
          return { ok: false, error: merged.error, countError: true, destinationTitle: proposal.destinationTitle };
        }
        committed.push({ proposal, nodeId: status.identity.located.node.id });
      }
    }
    if (committed.length > 1) {
      return {
        ok: false,
        error: 'more than one deterministic capture title is already committed',
        countError: true,
        destinationTitle: destination.proposal.destinationTitle,
      };
    }
    inspected.push({
      destination,
      ...(committed[0] === undefined ? {} : { committed: committed[0] }),
      ...(appendLatest === undefined ? {} : { appendLatest }),
    });
  }

  const revalidated = await args.revalidateRecovered();
  if (!revalidated.ok) {
    return {
      ok: false,
      error: `recovered capture changed before mutation: ${revalidated.error}`,
      countError: true,
      destinationTitle: 'recovered capture',
    };
  }

  // Phase two is still mutation-free: choose titles and complete every exact
  // Engine dry-run before allowing the first live mutation.
  const staged: StagedCaptureDestination[] = [];
  const reservedCreatePaths = new Set<string>();
  const reservedCreateTitles = new Set<string>();
  for (const item of inspected) {
    if (item.committed !== undefined) {
      staged.push({ kind: 'committed', ...item.committed });
      continue;
    }
    if (item.destination.proposal.destinationKind === 'appended') {
      const proposal = item.destination.proposal;
      const nodeId = proposal.destinationNodeId;
      const version = item.appendLatest?.version;
      if (nodeId === undefined || version === undefined || !Number.isInteger(version) || version < 0) {
        return { ok: false, error: 'latest linked destination lacks a valid version', countError: true, destinationTitle: proposal.destinationTitle };
      }
      let warnings: readonly unknown[];
      try {
        ({ warnings } = await args.deps.engine.appendCapturedContent({
          nodeId, text: proposal.body, expectedVersion: version, dryRun: true,
          conversationAuthority: args.conversationAuthority,
        }));
      } catch (error) {
        return { ok: false, error: `append dry-run failed: ${diagnostic(error)}`, countError: true, destinationTitle: proposal.destinationTitle };
      }
      if (warnings.length > 0) {
        appendDetail(args.result, `${proposal.conversationId}: ${proposal.destinationTitle} warnings: ${issueSummary(warnings)}`);
      }
      const currentBody = item.appendLatest?.body ?? '';
      const expectedBodyAfter = currentBody ? `${currentBody}\n\n${proposal.body}` : proposal.body;
      staged.push({ kind: 'append', proposal, nodeId, expectedVersion: version, expectedBodyAfter });
      continue;
    }

    let selected: ConversationCaptureProposal | undefined;
    let selectedFilePath: string | undefined;
    let reservationConflict = false;
    for (const proposal of item.destination.concreteCandidates) {
      let preview: CreateNodePreview;
      try {
        preview = await args.deps.engine.createNode({
          title: proposal.destinationTitle, types: [args.vocab.noteType], body: proposal.body, dryRun: true,
          conversationAuthority: args.conversationAuthority,
        });
      } catch (error) {
        return { ok: false, error: `create dry-run failed: ${diagnostic(error)}`, countError: true, destinationTitle: proposal.destinationTitle };
      }
      if (preview.would_create.conflict !== undefined) continue;
      const previewFilePath = preview.would_create.file_path;
      if (typeof previewFilePath !== 'string' || previewFilePath.trim() === '') {
        return { ok: false, error: 'create dry-run returned no file path', countError: true, destinationTitle: proposal.destinationTitle };
      }
      const pathIdentity = normalizedPath(previewFilePath).normalize('NFC');
      const titleIdentity = normalizedTitleIdentity(proposal.destinationTitle).normalize('NFC');
      if (reservedCreatePaths.has(pathIdentity) || reservedCreateTitles.has(titleIdentity)) {
        reservationConflict = true;
        continue;
      }
      if (preview.warnings.length > 0) {
        appendDetail(args.result, `${proposal.conversationId}: ${proposal.destinationTitle} warnings: ${issueSummary(preview.warnings)}`);
      }
      selected = proposal;
      selectedFilePath = pathIdentity;
      break;
    }
    if (selected === undefined || selectedFilePath === undefined) {
      return {
        ok: false,
        error: reservationConflict
          ? 'all deterministic create paths conflict with staged destinations or existing vault content'
          : 'all deterministic create titles conflict with existing vault content',
        countError: false,
        destinationTitle: item.destination.proposal.destinationTitle,
      };
    }
    reservedCreatePaths.add(selectedFilePath);
    reservedCreateTitles.add(normalizedTitleIdentity(selected.destinationTitle).normalize('NFC'));
    staged.push({ kind: 'create', proposal: selected, previewFilePath: selectedFilePath });
  }
  return { ok: true, destinations: staged };
}

function persistAfterConfirmedWrite(args: {
  deps: ConversationCaptureSweepDeps;
  proposal: ConversationCaptureProposal;
  inputHash: string;
  nodeId: string;
  now: string;
  kind: 'append' | 'create';
}): ProposalExecutionResult {
  if (args.deps.db === undefined) {
    recordCaptureAction(args.deps, args.proposal, args.nodeId);
    return { complete: false, error: `confirmed ${args.kind} could not be persisted without the Curator database`, countError: true };
  }
  let persistenceError: unknown;
  try {
    persistConfirmedArtifact({
      db: args.deps.db,
      proposal: args.proposal,
      inputHash: args.inputHash,
      nodeId: args.nodeId,
      committedAt: args.now,
    });
  } catch (error) {
    persistenceError = error;
  }
  recordCaptureAction(args.deps, args.proposal, args.nodeId);
  if (persistenceError !== undefined) {
    return { complete: false, error: `confirmed ${args.kind} artifact persistence failed: ${diagnostic(persistenceError)}`, countError: true };
  }
  return { complete: true };
}

async function executeStagedCapture(args: {
  deps: ConversationCaptureSweepDeps;
  vocab: CaptureVocabulary;
  destination: StagedCaptureDestination;
  inputHash: string;
  now: string;
  result: ConversationCaptureSweepResult;
  conversationAuthority: ConversationAuthorityGuard;
}): Promise<ProposalExecutionResult> {
  if (args.destination.kind === 'committed') return { complete: true };
  const proposal = args.destination.proposal;
  if (args.destination.kind === 'append') {
    let warnings: readonly unknown[];
    try {
      ({ warnings } = await args.deps.engine.appendCapturedContent({
        nodeId: args.destination.nodeId,
        text: proposal.body,
        expectedVersion: args.destination.expectedVersion,
        dryRun: false,
        conversationAuthority: args.conversationAuthority,
      }));
    } catch (error) {
      return { complete: false, error: `append live write failed: ${diagnostic(error)}`, countError: true };
    }
    args.result.appended += 1;
    if (warnings.length > 0) {
      appendDetail(args.result, `${proposal.conversationId}: ${proposal.destinationTitle} live warnings: ${issueSummary(warnings)}`);
    }
    const persistence = persistAfterConfirmedWrite({
      deps: args.deps, proposal, inputHash: args.inputHash,
      nodeId: args.destination.nodeId, now: args.now, kind: 'append',
    });
    return {
      ...persistence,
      confirmedAppend: {
        nodeId: args.destination.nodeId,
        expectedBodyAfter: args.destination.expectedBodyAfter,
      },
    };
  }

  let created: CreateNodeResult;
  try {
    created = await args.deps.engine.createNode({
      title: proposal.destinationTitle, types: [args.vocab.noteType], body: proposal.body, dryRun: false,
      conversationAuthority: args.conversationAuthority,
    });
  } catch (error) {
    return { complete: false, error: `create live write failed: ${diagnostic(error)}`, countError: true };
  }
  args.result.created += 1;
  if (typeof created.node_id !== 'string' || created.node_id.trim() === '') {
    return { complete: false, error: 'confirmed create returned no destination node id', countError: true };
  }
  if (created.warnings.length > 0) {
    appendDetail(args.result, `${proposal.conversationId}: ${proposal.destinationTitle} live warnings: ${issueSummary(created.warnings)}`);
  }
  const persistence = persistAfterConfirmedWrite({
    deps: args.deps, proposal, inputHash: args.inputHash,
    nodeId: created.node_id, now: args.now, kind: 'create',
  });
  const rawLiveFilePath = (created as CreateNodeResult & { file_path?: unknown }).file_path;
  const pathError = typeof rawLiveFilePath !== 'string' || rawLiveFilePath.trim() === ''
    ? 'confirmed create returned no file path'
    : normalizedPath(rawLiveFilePath).normalize('NFC') !== args.destination.previewFilePath
      ? 'confirmed create file path differs from its dry-run reservation'
      : undefined;
  if (!persistence.complete) {
    return pathError === undefined
      ? persistence
      : { complete: false, error: `${pathError}; ${persistence.error}`, countError: true };
  }
  if (pathError !== undefined) return { complete: false, error: pathError, countError: true };
  return { complete: true };
}

function persistConversationCompletion(args: {
  db: Database.Database;
  conversationId: string;
  inputHash: string;
  processedAt: string;
  outcome: string;
  artifactCount: number;
  destinationCount: number;
  destinationDecision?: DestinationDecisionFingerprint;
}): void {
  const recordsDecision = args.outcome === 'no-fitting-destination'
    && args.destinationDecision !== undefined;
  upsertConversationCaptureLedger(args.db, {
    conversation_id: args.conversationId,
    input_hash: args.inputHash,
    processed_at: args.processedAt,
    outcome: args.outcome,
    artifact_count: args.artifactCount,
    destination_count: args.destinationCount,
    decision_evidence_hash: recordsDecision ? args.destinationDecision!.hash : null,
    decision_evidence_version: recordsDecision ? args.destinationDecision!.version : null,
  });
}

function createdTitleProposals(args: {
  input: EvaluateConversationCaptureCandidateInput;
  artifact: ComposedCaptureArtifact;
  capturedOn: string;
}): ConversationCaptureProposal[] {
  return captureTitleCandidates(
    args.artifact.title,
    args.input.conversation.title,
    args.capturedOn,
  ).map((destinationTitle) => proposalForDestination({
    input: args.input,
    destinationNode: undefined,
    artifacts: [args.artifact],
    capturedOn: args.capturedOn,
    destinationTitle,
  }));
}

/**
 * The date a capture of this transcript carries in its attribution line and fallback title
 * (#496): the conversation's last update in the configured zone, unless a capture of the same
 * transcript (`inputHash`) is already in the vault. Then it is that capture's date, so a capture
 * retried for the same transcript (a write that never reached the ledger) renders byte-identical
 * to the one already written, with the same fallback title and capture id, even when that one
 * was dated in UTC before #496 or in a zone since changed.
 */
function captureDateFor(
  identities: Iterable<RecoveredCaptureIdentity>,
  inputHash: string,
  updatedAt: string,
  timeZone: string,
): string {
  const written = [...identities]
    .filter(({ located }) => located.block.transcriptHash === inputHash)
    .sort((a, b) => lexicalCompare(a.artifact.committed_at, b.artifact.committed_at)
      || lexicalCompare(a.artifact.capture_id, b.artifact.capture_id))
    .map(({ located }) => captureBlockDate(located.block.contentMarkdown))
    .find((date): date is string => date !== null);
  return written ?? localDate(new Date(updatedAt), timeZone);
}

interface PreparedCaptureDestination {
  proposal: ConversationCaptureProposal;
  concreteCandidates: ConversationCaptureProposal[];
}

type PrepareCaptureDestinationsResult =
  | { ok: true; destinations: PreparedCaptureDestination[] }
  | { ok: false; error: string };

/**
 * Materializes every deterministic capture identity before the first Engine
 * dry-run. Capture IDs intentionally do not include source attribution, so a
 * collision guard is required around the exact stamped bytes.
 */
function prepareCaptureDestinations(args: {
  input: EvaluateConversationCaptureCandidateInput;
  evaluation: ConversationCaptureCandidateEvaluation;
  capturedOn: string;
}): PrepareCaptureDestinationsResult {
  const destinations: PreparedCaptureDestination[] = [];
  let createdArtifactIndex = 0;
  for (const proposal of args.evaluation.proposals) {
    if (proposal.destinationKind === 'appended') {
      destinations.push({ proposal, concreteCandidates: [proposal] });
      continue;
    }
    const artifact = args.evaluation.artifacts[createdArtifactIndex];
    createdArtifactIndex += 1;
    if (artifact === undefined) return { ok: false, error: 'created proposal lacks its composed artifact' };
    destinations.push({
      proposal,
      concreteCandidates: createdTitleProposals({ input: args.input, artifact, capturedOn: args.capturedOn }),
    });
  }

  const identities = new Map<string, ConversationCaptureProposal>();
  for (const destination of destinations) {
    for (const candidate of destination.concreteCandidates) {
      const prior = identities.get(candidate.captureId);
      if (prior === undefined) {
        identities.set(candidate.captureId, candidate);
        continue;
      }
      const byteIdentical = prior.body === candidate.body
        && prior.destinationKind === candidate.destinationKind
        && prior.destinationNodeId === candidate.destinationNodeId
        && normalizedTitleIdentity(prior.destinationTitle) === normalizedTitleIdentity(candidate.destinationTitle);
      return {
        ok: false,
        error: byteIdentical
          ? `duplicate capture identity ${candidate.captureId}`
          : `capture identity collision ${candidate.captureId}`,
      };
    }
  }
  return { ok: true, destinations };
}

const CAPTURE_DETAIL_LOG_MAX_CHARS = 4000;

/** One capped server-log line with the run's per-conversation reasons. Nothing
 *  else surfaces `detail`: the journal summary and the CLI print counts only.
 *  Its entries are closed reason codes, ids, destination titles (a new note's
 *  comes from the composer) and Engine messages — never conversation text or
 *  composed bodies. */
function logCaptureDetail(result: ConversationCaptureSweepResult): void {
  const detail = result.detail;
  if (detail === undefined || detail === '') return;
  const capped = detail.length > CAPTURE_DETAIL_LOG_MAX_CHARS
    ? `${detail.slice(0, CAPTURE_DETAIL_LOG_MAX_CHARS)}… (${detail.length - CAPTURE_DETAIL_LOG_MAX_CHARS} more chars)`
    : detail;
  console.warn(`[curator] conversation capture (errors ${result.errors}, deferred ${result.deferred}): ${capped}`);
}

export async function runConversationCaptureSweep(
  deps: ConversationCaptureSweepDeps,
  opts: { dryRun: boolean; trigger: RunTrigger; now?: Date },
): Promise<ConversationCaptureSweepResult> {
  let result: ConversationCaptureSweepResult;
  try {
    result = await runConversationCaptureSweepSafely(deps, opts);
  } catch (error) {
    result = {
      ...emptyResult(true, `unexpected conversation capture failure: ${diagnostic(error)}`),
      ran: true,
      errors: 1,
    };
  }
  try {
    logCaptureDetail(result);
  } catch {
    // Observer only: a failed log line never changes the sweep result.
  }
  return result;
}

async function runConversationCaptureSweepSafely(
  deps: ConversationCaptureSweepDeps,
  opts: { dryRun: boolean; trigger: RunTrigger; now?: Date },
): Promise<ConversationCaptureSweepResult> {
  let mode: unknown;
  try {
    mode = deps.config.conversationCaptureMode;
  } catch (error) {
    return {
      ...emptyResult(true, `unexpected conversation capture failure: ${diagnostic(error)}`),
      ran: true,
      errors: 1,
    };
  }
  if (mode === 'off') return emptyResult(opts.dryRun);
  const vocab = captureVocabulary(deps.config);
  if (vocab === null) return emptyResult(opts.dryRun, CAPTURE_OFF_NO_NOTE_KIND);

  const effectiveDryRun = opts.dryRun || mode !== 'live';
  const result = { ...emptyResult(effectiveDryRun), ran: true };
  if (mode !== 'preview' && mode !== 'live') {
    result.errors += 1;
    result.detail = 'conversation capture mode is invalid';
    return result;
  }
  if (!effectiveDryRun && deps.db === undefined) {
    result.errors += 1;
    result.detail = 'live conversation capture requires the Curator database';
    return result;
  }

  return deps.queue.enqueue('conversation-capture', async () => {
    const runRef = randomUUID();
    let completed = result;
    try {
      try {
        deps.recorder?.setContext({
          runRef,
          trigger: opts.trigger,
          fn: 'conversation-capture',
          project: 'conversation-capture',
        });
      } catch (error) {
        warnObserverFailure('conversation capture journal context setup failed', error);
      }
      completed = await runConversationCapturePass(deps, vocab, opts, result, runRef);
      return completed;
    } catch (error) {
      completed.errors += 1;
      appendDetail(completed, `unexpected conversation capture failure: ${diagnostic(error)}`);
      return completed;
    } finally {
      try {
        deps.recorder?.summary(
          'conversation-capture',
          captureSummaryLine(completed),
          captureSummaryStats(completed),
          completed.dryRun,
        );
      } catch (error) {
        warnObserverFailure('conversation capture journal summary failed', error);
      }
      try {
        deps.recorder?.setContext(null);
      } catch (error) {
        warnObserverFailure('conversation capture journal context clear failed', error);
      }
    }
  });
}

async function runConversationCapturePass(
  deps: ConversationCaptureSweepDeps,
  vocab: CaptureVocabulary,
  opts: { dryRun: boolean; trigger: RunTrigger; now?: Date },
  result: ConversationCaptureSweepResult,
  runRef: string,
): Promise<ConversationCaptureSweepResult> {
  const now = opts.now === undefined ? new Date() : new Date(opts.now);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return { ...result, errors: 1, detail: 'invalid sweep time' };
  const nowIso = now.toISOString();
  const cutoffMs = nowMs - deps.config.conversationCaptureSettleHours * HOUR_MS;
  const settleCutoff = new Date(cutoffMs).toISOString();

  let sinceMs = nowMs - deps.config.conversationCaptureInitialLookbackDays * DAY_MS;
  if (deps.db !== undefined) {
    try {
      const watermark = lastConversationCaptureAt(deps.db);
      if (watermark !== null) {
        const parsed = Date.parse(watermark);
        if (Number.isFinite(parsed)) sinceMs = parsed;
      }
    } catch (error) {
      result.errors += 1;
      appendDetail(result, `capture watermark read failed: ${diagnostic(error)}`);
    }
  }

  let rawMetadata: unknown;
  try {
    rawMetadata = await deps.engine.listConversations({ includeArchived: true, includeLinkedDocs: true });
  } catch (error) {
    return { ...result, errors: result.errors + 1, detail: `conversation list failed: ${diagnostic(error)}` };
  }
  if (!Array.isArray(rawMetadata)) {
    result.errors += 1;
    appendDetail(result, 'list-conversations result must be an array');
    return result;
  }
  result.scanned = rawMetadata.length;
  const metadata: ConversationMeta[] = [];
  for (let index = 0; index < rawMetadata.length; index += 1) {
    const validated = validateConversationMeta(rawMetadata[index], true, true);
    if (!validated.ok) {
      result.errors += 1;
      appendDetail(result, `conversation metadata row ${index} is invalid: ${validated.error}`);
      continue;
    }
    metadata.push(validated.value);
  }
  const watermarkRevisitIds = new Set<string>();
  if (deps.db !== undefined) {
    const conversationIds = metadata.map((conversation) => conversation.id);
    try {
      for (const row of listConversationCaptureLedgerByOutcome(
        deps.db,
        'protected-only',
        100,
        conversationIds,
      )) {
        watermarkRevisitIds.add(row.conversation_id);
      }
    } catch (error) {
      result.errors += 1;
      appendDetail(result, `protected-only revisit ledger read failed: ${diagnostic(error)}`);
    }
    try {
      for (const row of listConversationCaptureLedgerByOutcome(
        deps.db,
        'no-fitting-destination',
        Math.max(1, conversationIds.length),
        conversationIds,
      )) {
        watermarkRevisitIds.add(row.conversation_id);
      }
    } catch (error) {
      result.errors += 1;
      appendDetail(result, `no-fitting-destination revisit ledger read failed: ${diagnostic(error)}`);
    }
  }
  const candidates = metadata
    .filter((conversation) => {
      const updated = Date.parse(conversation.updated_at);
      return Number.isFinite(updated)
        && updated <= cutoffMs
        && (updated >= sinceMs || watermarkRevisitIds.has(conversation.id));
    })
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || lexicalCompare(a.id, b.id));
  result.settled = candidates.length;

  let writesLeft = deps.config.conversationCaptureWriteCap;
  const rejections = new CaptureRejectionBreakers(deps.config);
  for (const meta of candidates) {
    // A model that keeps rejecting the request ends the pass; the rest is retried next run.
    if (rejections.stopped !== null) {
      result.deferred += 1;
      continue;
    }
    let rawDetail: unknown;
    try {
      rawDetail = await deps.engine.getConversation(meta.id);
    } catch (error) {
      result.deferred += 1;
      result.errors += 1;
      appendDetail(result, `${meta.id}: conversation read failed: ${diagnostic(error)}`);
      continue;
    }
    const validatedDetail = validateConversationDetail(rawDetail);
    if (!validatedDetail.ok) {
      result.deferred += 1;
      result.errors += 1;
      appendDetail(result, `${meta.id}: malformed conversation detail: ${validatedDetail.error}`);
      continue;
    }
    const detail = validatedDetail.value;

    const changedField = metadataChangeAfterRead(meta, detail.conversation, detail.linked_docs);
    if (changedField !== null) {
      result.deferred += 1;
      appendDetail(result, `${meta.id}: conversation changed after metadata scan (${changedField})`);
      continue;
    }

    const authoritativeMeta = detail.conversation;
    const linkedDocs = normalizedLinkedDocs(detail.linked_docs);
    const inspection = inspectConversation(detail.messages);
    const inputHash = conversationCaptureFingerprint(inspection, linkedDocs);
    const authority = conversationAuthorityGuard(detail);
    if (!authority.ok) {
      result.deferred += 1;
      result.errors += 1;
      appendDetail(result, `${meta.id}: ${authority.error}`);
      continue;
    }
    if (!inspection.coverageReliable) {
      result.unreliable += 1;
      result.deferred += 1;
      continue;
    }
    const belowFloor = inspection.assistantChars < deps.config.conversationCaptureMinAssistantChars
      || inspection.turns.length === 0;
    const recoveredIdentities = new Map<string, RecoveredCaptureIdentity>();
    let linkedNodeReads: ConversationCaptureLinkedNodeRead[] | undefined;
    const initialRecovery = await refreshConversationRecovery({
      engine: deps.engine,
      vocab,
      ...(deps.db === undefined ? {} : { db: deps.db }),
      conversationId: authoritativeMeta.id,
      linkedDocs,
      recoveredAt: nowIso,
      identities: recoveredIdentities,
      persistRecovery: !result.dryRun,
    });
    if (!initialRecovery.ok) {
      if (belowFloor) result.belowFloor += 1;
      result.errors += 1;
      result.deferred += 1;
      appendDetail(result, `${meta.id}: ${belowFloor ? 'recovered capture changed before below-floor ledger' : 'capture recovery failed'}: ${initialRecovery.error}`);
      continue;
    }
    linkedNodeReads = initialRecovery.value;
    let priorLedger: ConversationCaptureLedgerRow | undefined;
    if (deps.db !== undefined) {
      try {
        priorLedger = getConversationCaptureLedger(deps.db, authoritativeMeta.id);
        if (priorLedger?.input_hash === inputHash
          && priorLedger.outcome !== 'protected-only'
          && priorLedger.outcome !== 'no-fitting-destination') {
          result.unchanged += 1;
          continue;
        }
      } catch (error) {
        result.errors += 1;
        result.deferred += 1;
        appendDetail(result, `${meta.id}: capture ledger read failed: ${diagnostic(error)}`);
        continue;
      }
    }
    const comparesPriorNoFitting = priorLedger?.input_hash === inputHash
      && priorLedger.outcome === 'no-fitting-destination';
    let destinationDecision: DestinationDecisionFingerprint | undefined;
    if (!belowFloor || comparesPriorNoFitting) {
      try {
        const decisionEvidence = destinationDecisionEvidence(linkedNodeReads, vocab.settingsPrefix);
        destinationDecision = decisionEvidence === undefined
          ? undefined
          : destinationDecisionFingerprint(decisionEvidence);
      } catch {
        result.errors += 1;
        result.deferred += 1;
        appendDetail(result, `${meta.id}: destination decision projection failed`);
        continue;
      }
      if (priorCaptureDecisionIsUnchanged(priorLedger, inputHash, destinationDecision)) {
        result.unchanged += 1;
        continue;
      }
    }
    if (belowFloor) {
      result.belowFloor += 1;
      if (!result.dryRun) {
        const authorityCheck = await checkConversationAuthority({
          engine: deps.engine,
          initial: detail,
          inputHash,
          boundary: 'before below-floor ledger',
        });
        if (!authorityCheck.ok) {
          if (authorityCheck.countError) result.errors += 1;
          result.deferred += 1;
          appendDetail(result, `${meta.id}: ${authorityCheck.error}`);
          continue;
        }
        const refreshed = await refreshConversationRecovery({
          engine: deps.engine,
          vocab,
          db: deps.db!,
          conversationId: authoritativeMeta.id,
          linkedDocs,
          recoveredAt: nowIso,
          identities: recoveredIdentities,
          persistRecovery: true,
        });
        if (!refreshed.ok) {
          result.errors += 1;
          result.deferred += 1;
          appendDetail(result, `${meta.id}: recovered capture changed before below-floor ledger: ${refreshed.error}`);
          continue;
        }
        try {
          persistConversationCompletion({
            db: deps.db!,
            conversationId: authoritativeMeta.id,
            inputHash,
            processedAt: nowIso,
            outcome: 'below-floor',
            artifactCount: 0,
            destinationCount: 0,
          });
        } catch (error) {
          result.errors += 1;
          result.deferred += 1;
          appendDetail(result, `${meta.id}: below-floor ledger persistence failed: ${diagnostic(error)}`);
        }
      }
      continue;
    }

    linkedNodeReads ??= await readLinkedNodes(deps.engine, linkedDocs);
    const captures = [...recoveredIdentities.values()]
      .sort((a, b) => lexicalCompare(a.artifact.committed_at, b.artifact.committed_at)
        || lexicalCompare(a.artifact.capture_id, b.artifact.capture_id))
      .map(({ artifact }) => ({ captureId: artifact.capture_id, markdown: artifact.content_markdown }));
    const capturedOn = captureDateFor(
      recoveredIdentities.values(), inputHash, authoritativeMeta.updated_at, deps.config.curatorTz,
    );

    const evaluationInput: EvaluateConversationCaptureCandidateInput = {
      conversation: {
        id: authoritativeMeta.id,
        title: authoritativeMeta.title,
        updatedAt: authoritativeMeta.updated_at,
        linkedDocs,
      },
      inspection,
      inputHash,
      linkedNodeReads,
      priorCaptures: captures,
      allowModelCall: result.evaluated < deps.config.conversationCaptureEvaluationCap,
      capturedOn,
    };
    const evaluation = await evaluateConversationCaptureCandidate(
      { llm: deps.llm, config: deps.config, usage: deps.usage, runRef, rejections },
      evaluationInput,
    );
    if (rejections.stopped !== null && result.stopped === undefined) {
      result.stopped = rejections.stopped;
      console.warn(`[curator] ${rejections.stopped}`);
    }
    if (evaluation.modelEvaluated) result.evaluated += 1;
    result.coverageCalls += evaluation.coverageCalls;
    result.uncoveredArtifacts += evaluation.uncoveredArtifacts;
    result.partiallyCoveredArtifacts += evaluation.partiallyCoveredArtifacts;
    result.fullyCoveredArtifacts += evaluation.fullyCoveredArtifacts;

    const postModelAuthority = await checkConversationAuthority({
      engine: deps.engine,
      initial: detail,
      inputHash,
      boundary: 'after model',
    });
    if (!postModelAuthority.ok) {
      if (postModelAuthority.countError) result.errors += 1;
      result.deferred += 1;
      appendDetail(result, `${meta.id}: ${postModelAuthority.error}`);
      continue;
    }
    const linkedSnapshotCheck = await checkLinkedNodeSnapshots({
      engine: deps.engine,
      initial: linkedNodeReads,
      boundary: 'after model',
    });
    if (!linkedSnapshotCheck.ok) {
      if (linkedSnapshotCheck.countError) result.errors += 1;
      result.deferred += 1;
      appendDetail(result, `${meta.id}: ${linkedSnapshotCheck.error}`);
      continue;
    }
    const refreshed = await refreshConversationRecovery({
      engine: deps.engine,
      vocab,
      ...(deps.db === undefined ? {} : { db: deps.db }),
      conversationId: authoritativeMeta.id,
      linkedDocs,
      linkedReads: linkedSnapshotCheck.value,
      recoveredAt: nowIso,
      identities: recoveredIdentities,
      persistRecovery: !result.dryRun,
    });
    if (!refreshed.ok) {
      result.errors += 1;
      result.deferred += 1;
      const boundary = evaluation.status === 'skip'
        ? 'recovered capture changed before skip ledger'
        : evaluation.status === 'capture'
          ? 'recovered capture changed before mutation'
          : 'post-model capture recovery failed';
      appendDetail(result, `${meta.id}: ${boundary}: ${refreshed.error}`);
      continue;
    }

    if (evaluation.status === 'deferred') {
      result.deferred += 1;
      if (evaluation.reasonCode === 'protected-only') result.protectedOnly += 1;
      if (evaluation.reasonCode === 'model-error' || evaluation.reasonCode === 'linked-read-failure') result.errors += 1;
      appendDetail(result, `${meta.id}: ${evaluation.reason}`);
      continue;
    }
    if (evaluation.status === 'skip') {
      if (evaluation.reasonCode === 'protected-only') result.protectedOnly += 1;
      countSkip(result, evaluation.reasonCode);
      if (!result.dryRun) {
        try {
          persistConversationCompletion({
            db: deps.db!,
            conversationId: authoritativeMeta.id,
            inputHash,
            processedAt: nowIso,
            outcome: evaluation.reasonCode,
            artifactCount: 0,
            destinationCount: 0,
            ...(evaluation.reasonCode === 'no-fitting-destination'
              ? { destinationDecision }
              : {}),
          });
        } catch (error) {
          result.errors += 1;
          result.deferred += 1;
          appendDetail(result, `${meta.id}: skip ledger persistence failed: ${diagnostic(error)}`);
        }
      }
      continue;
    }
    if (evaluation.partiallyCovered) result.partiallyCovered += 1;
    const prepared = prepareCaptureDestinations({ input: evaluationInput, evaluation, capturedOn });
    if (!prepared.ok) {
      result.errors += 1;
      result.deferred += 1;
      appendDetail(result, `${meta.id}: ${prepared.error}`);
      continue;
    }
    // Creates are previewed as the journal kind, which Engine accepts only once that schema exists.
    // A dry run writes nothing, so on a vault without the schema its create preview fails.
    if (!result.dryRun && prepared.destinations.some((destination) => destination.proposal.destinationKind === 'created')) {
      try {
        await deps.engine.ensureNoteSchema(vocab.noteType);
      } catch (error) {
        result.errors += 1;
        result.deferred += 1;
        appendDetail(result, `${meta.id}: note schema unavailable: ${diagnostic(error)}`);
        continue;
      }
    }
    const staged = await stageCaptureDestinations({
      deps,
      vocab,
      destinations: prepared.destinations,
      recoveredIdentities,
      inputHash,
      dryRun: result.dryRun,
      now: nowIso,
      result,
      linkedNodeReads: linkedSnapshotCheck.value,
      revalidateRecovered: () => revalidateRecoveredCaptureIdentities({
        engine: deps.engine,
        vocab,
        conversationId: authoritativeMeta.id,
        identities: [...recoveredIdentities.values()],
      }),
      conversationAuthority: authority.value,
    });
    if (!staged.ok) {
      if (staged.countError) result.errors += 1;
      result.deferred += 1;
      appendDetail(result, `${meta.id}: ${staged.destinationTitle}: ${staged.error}`);
      continue;
    }
    const requiredWrites = staged.destinations.filter((destination) => destination.kind !== 'committed').length;
    if (requiredWrites > writesLeft) {
      result.deferred += 1;
      appendDetail(result, `${meta.id}: ${requiredWrites} missing destinations exceed remaining write cap ${writesLeft}`);
      continue;
    }
    writesLeft -= requiredWrites;
    if (result.dryRun) {
      for (const destination of staged.destinations) {
        if (destination.kind === 'committed') continue;
        result.proposals.push(destination.proposal);
        if (destination.kind === 'append') result.wouldAppend += 1;
        else result.wouldCreate += 1;
      }
      continue;
    }

    let incomplete = false;
    const expectedNodeBodies = new Map<string, string>();
    for (const destination of staged.destinations) {
      if (destination.kind !== 'committed') {
        const authorityCheck = await checkConversationAuthority({
          engine: deps.engine,
          initial: detail,
          inputHash,
          boundary: 'before live write',
        });
        if (!authorityCheck.ok) {
          incomplete = true;
          if (authorityCheck.countError) result.errors += 1;
          appendDetail(result, `${meta.id}: ${authorityCheck.error}`);
          break;
        }
        const revalidated = await revalidateRecoveredCaptureIdentities({
          engine: deps.engine,
          vocab,
          conversationId: authoritativeMeta.id,
          identities: [...recoveredIdentities.values()],
          expectedNodeBodies,
        });
        if (!revalidated.ok) {
          incomplete = true;
          result.errors += 1;
          appendDetail(result, `${meta.id}: recovered capture changed before live write: ${revalidated.error}`);
          break;
        }
      }
      const execution = await executeStagedCapture({
        deps, vocab, destination, inputHash, now: nowIso, result,
        conversationAuthority: authority.value,
      });
      if (execution.confirmedAppend !== undefined) {
        expectedNodeBodies.set(
          execution.confirmedAppend.nodeId,
          execution.confirmedAppend.expectedBodyAfter,
        );
      }
      if (!execution.complete) {
        incomplete = true;
        if (execution.countError) result.errors += 1;
        appendDetail(result, `${meta.id}: ${destination.proposal.destinationTitle}: ${execution.error}`);
      }
    }
    if (incomplete) {
      result.deferred += 1;
      continue;
    }
    const completionAuthority = await checkConversationAuthority({
      engine: deps.engine,
      initial: detail,
      inputHash,
      boundary: 'before completion ledger',
    });
    if (!completionAuthority.ok) {
      if (completionAuthority.countError) result.errors += 1;
      result.deferred += 1;
      appendDetail(result, `${meta.id}: ${completionAuthority.error}`);
      continue;
    }
    const completionRevalidation = await revalidateRecoveredCaptureIdentities({
      engine: deps.engine,
      vocab,
      conversationId: authoritativeMeta.id,
      identities: [...recoveredIdentities.values()],
      expectedNodeBodies,
    });
    if (!completionRevalidation.ok) {
      result.errors += 1;
      result.deferred += 1;
      appendDetail(result, `${meta.id}: recovered capture changed before completion ledger: ${completionRevalidation.error}`);
      continue;
    }
    if (!result.dryRun) {
      try {
        persistConversationCompletion({
          db: deps.db!,
          conversationId: authoritativeMeta.id,
          inputHash,
          processedAt: nowIso,
          outcome: 'captured',
          artifactCount: evaluation.plannedArtifactCount,
          destinationCount: prepared.destinations.length,
        });
      } catch (error) {
        result.errors += 1;
        result.deferred += 1;
        appendDetail(result, `${meta.id}: completion ledger persistence failed: ${diagnostic(error)}`);
      }
    }
  }

  if (!result.dryRun && result.deferred === 0 && result.errors === 0) {
    try {
      setLastConversationCaptureAt(deps.db!, settleCutoff);
    } catch (error) {
      result.errors += 1;
      appendDetail(result, `capture watermark persistence failed: ${diagnostic(error)}`);
    }
  }
  return result;
}
