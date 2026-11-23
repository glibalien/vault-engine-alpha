import { resolvedWikiOutputPolicySchema, type ResolvedWikiOutputPolicy } from '../wiki-output-policy.js';
import { diagnosticsSchema } from '../llm/diagnostics.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { MODEL_PROVIDERS } from '@vault/settings-registry';
import type { WikiReconcileInput, WikiReconcileMapping, WikiReconcileResult } from '../engine.js';
import type { LlmConfiguration, StructuredCallResult } from '../llm/types.js';
import type { BundleV1, CaptureTarget, InputItem, OutputReceipt, PreparedReceipt, ProvenanceFlow, StageRequest } from '../provenance-types.js';
import type { EngineNode, ExistingWiki, Memory } from '../types.js';
import type { PeopleBlockContacts } from '../evidence.js';

/** Only non-secret settings that can alter a resumed project's effective calls. */
export interface RequestedCaptureConfig {
  wikiOutputPolicy?: ResolvedWikiOutputPolicy;
  model: string;
  /** Absent only on legacy checkpoints created before provider freezing. */
  llmConfiguration?: LlmConfiguration;
  homeMaxTokens: number;
  bodyCharCap: number | null;
  /** Recent-meeting window behind the snapshot's evidence hash; absent on older checkpoints (Engine default). */
  meetingReads?: number;
  /** The zone of the request's date line and Log stamp (#459); absent on older checkpoints (the live `tz`). */
  curatorTz?: string;
  semanticGapFillLimit: number;
  curatorRequestedPagePrompt: string;
  curatorProjectHomePrompt: string;
  curatorTopologyPrompt: string;
  curatorCreateAdjudicationPrompt: string;
  curatorPagePrompt: string;
  provenanceLimits: {
    requestBytes: number;
    componentBytes: number;
    outputBytes: number;
    totalBytes: number;
    itemCount: number;
    leaseMs: number;
  };
}

export interface RequestedCallRecord {
  key: string;
  requestDigest: string;
  state: 'ready' | 'sent' | 'result';
  result?: StructuredCallResult;
}

export interface RequestedCaptureRecord {
  flow: ProvenanceFlow;
  target?: CaptureTarget;
  attemptKey: string;
  receipt?: PreparedReceipt;
  stageRequest?: StageRequest;
  /** The page's second draft, written after the rule check sent the first back (#631). Its first
   *  draft's record stays, superseded: that draft is never staged, and its attempt is failed. */
  draft?: 2;
}

interface RequestIdentity {
  version: 1;
  generation: string;
  projectId: string;
  runRef: string;
  generatedAt: string;
}

/** The fields of a memory that its rendered line, order and attribution read; nothing else is frozen.
 *  `valid_at` and `source_label` order and date a project's memory lines (#631); older checkpoints have neither. */
export type SnapshotMemory = Pick<Memory, 'id' | 'source' | 'scope' | 'node_id' | 'content' | 'category'
  | 'created_at' | 'updated_at' | 'provenance_observation' | 'valid_at' | 'source_label'>;

export function snapshotMemory(memory: Memory): SnapshotMemory {
  const { id, source, scope, node_id, content, category, created_at, updated_at, provenance_observation, valid_at, source_label } = memory;
  return { id, source, scope, node_id, content, category, created_at, updated_at,
    ...(provenance_observation === undefined ? {} : { provenance_observation }),
    ...(valid_at === undefined ? {} : { valid_at }), ...(source_label === undefined ? {} : { source_label }) };
}

/** A rule lookup by memory id (#631): the live memories it found, or null when it failed. */
export interface SnapshotRuleLookup { ids: number[]; memories: SnapshotMemory[] | null }

/** The captures a commit must cover: all but a first draft its rule retry superseded (#631). */
export function liveRequestedCaptures(state: Pick<ActivePageRequestExecution, 'captures'>): RequestedCaptureRecord[] {
  const target = (capture: RequestedCaptureRecord) => `${capture.flow}:${JSON.stringify(capture.target ?? null)}`;
  const retried = new Set(state.captures.filter(capture => capture.draft === 2).map(target));
  return state.captures.filter(capture => capture.draft === 2 || !retried.has(target(capture)));
}

export interface ActivePageRequestExecution extends RequestIdentity {
  expiresAt: string;
  phase: 'prepared' | 'sent' | 'staged' | 'uncertain';
  request: { title: string; brief?: string };
  snapshot: {
    config: RequestedCaptureConfig;
    evidenceHash: string;
    evidenceText: string;
    evidenceNodes: EngineNode[];
    existingWiki: ExistingWiki;
    contextNodes: Record<string, EngineNode>;
    homeAttribution?: { items: InputItem[]; omissions: BundleV1['omissions']; assemblyContext?: BundleV1['assembly_context'] };
    rootTitle?: string;
    /** The memories the page's own evidence appends (#313); absent on older checkpoints, which had none. */
    memories?: SnapshotMemory[];
    /** Pairs of those memories, by id, that the reconciler kept both of (#631); absent when none,
     *  and on older checkpoints. */
    conflicts?: Array<[number, number]>;
    /** The rule memories looked up by id after planning, so a resumed request writes the same rules
     *  (#631). Present (empty until a lookup) on checkpoints that look rules up; absent on older ones. */
    ruleLookups?: SnapshotRuleLookup[];
    /** What the page's people blocks show (`peopleBlockContacts`, #631); absent when they show
     *  nobody, and on older checkpoints, whose page had no people blocks. */
    contacts?: PeopleBlockContacts;
  };
  calls: RequestedCallRecord[];
  captures: RequestedCaptureRecord[];
  reconcile?: WikiReconcileInput;
  result?: WikiReconcileResult;
  errorCode?: string;
}

/** Completion/abandonment retains references, never recoverable request text. */
export interface TerminalPageRequestExecution extends RequestIdentity {
  phase: 'committed' | 'failed';
  receipts?: OutputReceipt[];
  mappings?: WikiReconcileMapping[];
  reconcileKey?: string;
  errorCode?: string;
}

export type PageRequestExecution = ActivePageRequestExecution | TerminalPageRequestExecution;

function isTerminal(execution: PageRequestExecution): execution is TerminalPageRequestExecution {
  return execution.phase === 'committed' || execution.phase === 'failed';
}

/** Closed recovery signal: only the CAS identity is exposed, never recovery material. */
export class RequestExecutionExpiredError extends Error {
  override get name(): string { return 'RequestExecutionExpiredError'; }

  constructor(readonly generation: string) {
    super('REQUEST_EXECUTION_EXPIRED');
  }
}

const MAX_TOTAL = 2_097_152;
// Engine batch replay has its own bound, independent of model/staged output limits.
const MAX_REPLAY_RESULT_BYTES = 65_536;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
function replayResultBytes(result: WikiReconcileResult): number {
  // Engine adds currentness and flips reused after reading its bounded stored result.
  // The complete annotated response remains subject to the checkpoint total below.
  const { current_output: _currentOutput, current_outputs: _currentOutputs, ...stored } = result;
  return bytes({ ...stored, reused: false });
}
/** Reserve worst-case response space before a request can publish in Engine. */
export function assertRequestCommitCapacity(execution: ActivePageRequestExecution): void {
  // Optional observer fields may be discarded on the subsequent checkpoint write.
  const { result: _result, ...pending } = withoutCallDiagnostics(execution);
  // Replay currentness repeats IDs already present in the bounded receipt set.
  // A second replay-sized allowance plus field overhead bounds those annotations
  // without depending on Engine's ID length. No effective total limit is raised.
  const responseAllowance = 2 * MAX_REPLAY_RESULT_BYTES + 64;
  if (bytes(pending) + Buffer.byteLength(',"result":') + responseAllowance
    > execution.snapshot.config.provenanceLimits.totalBytes) budget();
}
const identity = {
  version: z.literal(1),
  generation: z.string().uuid(),
  projectId: z.string().min(1).max(512),
  runRef: z.string().min(1).max(512),
  generatedAt: z.string().datetime(),
};
const limitsSchema = z.object({
  requestBytes: z.number().int().min(1).max(1_048_576),
  componentBytes: z.number().int().min(1).max(262_144),
  outputBytes: z.number().int().min(1).max(262_144),
  totalBytes: z.number().int().min(1).max(MAX_TOTAL),
  itemCount: z.number().int().min(1).max(512),
  leaseMs: z.number().int().min(1).max(168 * 60 * 60 * 1000),
}).strict();
const configSchema = z.object({
  wikiOutputPolicy: resolvedWikiOutputPolicySchema.optional(),
  model: z.string().min(1).max(512),
  llmConfiguration: z.object({ provider: z.enum(MODEL_PROVIDERS),
    reasoningEffort: z.string().min(1).max(128).nullable(),
    // Optional: requests frozen before #429 have none.
    reasoningBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict().optional(),
  homeMaxTokens: z.number().int().positive(),
  bodyCharCap: z.number().int().nonnegative().nullable(),
  meetingReads: z.number().int().positive().optional(),
  curatorTz: z.string().min(1).max(128).optional(),
  semanticGapFillLimit: z.number().int().nonnegative(),
  curatorRequestedPagePrompt: z.string(),
  curatorProjectHomePrompt: z.string(),
  curatorTopologyPrompt: z.string(),
  curatorCreateAdjudicationPrompt: z.string(),
  curatorPagePrompt: z.string(),
  provenanceLimits: limitsSchema,
}).strict();
const nodeSchema = z.object({
  id: z.string().min(1), title: z.string().nullable(), types: z.array(z.string()),
  fields: z.record(z.string(), z.unknown()), body: z.string().nullable(),
}).passthrough();
const wikiSchema = z.object({
  home_id: z.string().nullable(), home: z.object({ id: z.string(), version: z.number().int() }).passthrough().nullable(),
  topology_hash: z.string(), catalog_valid: z.boolean(), subpages: z.array(z.object({ id: z.string() }).passthrough()),
}).passthrough();
const callSchema = z.object({
  key: z.string().min(1).max(512), requestDigest: z.string().min(1).max(512),
  state: z.enum(['ready', 'sent', 'result']),
  result: z.object({ output: z.unknown(), usage: z.object({
    input: z.number().nonnegative(), output: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(), cacheRead: z.number().nonnegative(),
  }).strict(), usageKnown: z.boolean().optional(), diagnostics: diagnosticsSchema.optional() }).strict().optional(),
}).strict();
const receiptSchema = z.object({
  derivation_id: z.string().min(1), bundle_digest: z.string().nullable(),
  state: z.enum(['prepared', 'result_staged', 'committed', 'failed', 'abandoned']),
  availability: z.enum(['retained', 'expired', 'purged']), lease_expires_at: z.string().datetime(),
}).strict();
const captureSchema = z.object({
  draft: z.literal(2).optional(),
  flow: z.enum(['project-home-v1', 'project-subpage-v1']),
  target: z.union([z.object({ node_id: z.string().min(1) }).strict(),
    z.object({ plan_key: z.string().min(1) }).strict()]).optional(),
  attemptKey: z.string().uuid(), receipt: receiptSchema.optional(),
  stageRequest: z.object({ derivation_id: z.string().min(1), bundle_digest: z.string().min(1),
    validated_sections: z.record(z.string(), z.string()), contribution: z.array(z.object({
      name: z.string(), mode: z.enum(['replace', 'append']), content: z.string(),
    }).strict()), generated_at: z.string().datetime(), log_stamp: z.string() }).strict().optional(),
}).strict();
const outputReceiptSchema = z.object({
  replaces_output_revision_id: z.string().nullable().optional(),
  derivation_id: z.string().min(1), output_revision_id: z.string().min(1),
  output_node_id: z.string().min(1), committed_node_version: z.number().int().nonnegative(),
  committed_at: z.string().datetime(), operation_id: z.string().min(1),
  reconcile_key: z.string().min(1), request_digest: z.string().nullable(),
}).strict();
const mappingSchema = z.object({ source_node_id: z.string(), target_node_id: z.string(), target_title: z.string() }).strict();
const bounded = z.string().min(1).max(512);
const digest = z.string().regex(/^sha256:(json|text)-v1:[a-f0-9]{64}$/);
const sourceKeySchema = z.object({
  kind: z.enum(['node', 'memory', 'curator_correction', 'generated_context', 'engine_projection']),
  namespace: bounded, native_id: bounded,
}).strict();
const observationSchema = z.object({
  source: sourceKeySchema, authority: z.enum(['engine', 'caller']), observed_at: z.string().datetime(),
  native_version: z.number().int().nonnegative().nullable(), content_hash: z.string().max(256).nullable(),
  hash_semantics: z.enum(['engine_content_hash', 'selected_projection_v1', 'caller_content_v1']),
  observation_projection: z.enum(['node-token-v1', 'node-token-v2', 'memory-content-v1', 'caller-content-v1']),
  observation_digest: digest, label: z.string().max(4096).nullable(), path: z.string().max(4096).nullable(),
}).strict();
const spanSchema = z.object({ field: bounded, start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict();
const itemSchema = z.object({
  key: bounded, observation: observationSchema.nullable(),
  role: z.enum(['source_material', 'generated_context', 'human_correction', 'engine_projection']),
  upstream_derivation_id: bounded.nullable(), selection: bounded, spans: z.array(spanSchema).min(1).max(512),
  original_bytes: z.number().int().nonnegative().nullable(), retained_bytes: z.number().int().nonnegative(),
  input_digest: digest, truncated: z.boolean(), origin: z.enum(['identified', 'opaque']),
}).strict();
const memorySchema = z.object({
  id: z.number().int().positive(), source: z.string().min(1).max(512), scope: z.enum(['vault', 'node']),
  node_id: z.string().nullable(), content: z.string(), category: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(), provenance_observation: observationSchema.optional(),
  valid_at: z.string().max(128).nullable().optional(), source_label: z.string().max(4096).optional(),
}).strict();
const memoryId = z.number().int().positive();
const meetingCount = z.number().int().nonnegative();
const contactsSchema = z.object({
  people: z.array(z.object({ id: bounded, title: z.string().max(4096), companies: z.array(z.string().max(4096)).max(512),
    direct: z.boolean(), meeting_count: meetingCount }).strict()).max(512),
  companies: z.array(z.object({ id: bounded, title: z.string().max(4096) }).strict()).max(512),
  unlinked: z.array(z.object({ name: z.string().max(4096), direct: z.boolean(), meeting_count: meetingCount }).strict()).max(512).optional(),
}).strict();
const attributionSchema = z.object({ items: z.array(itemSchema).max(512),
  omissions: z.array(z.object({ code: bounded, source: sourceKeySchema.nullable() }).strict()).max(512),
  assemblyContext: z.object({ evidence_hash: bounded, evaluated_at: bounded,
    query: z.object({ project: bounded, meeting_recent_limit: z.number().int().min(0).max(100),
      meeting_upcoming_limit: z.number().int().min(0).max(100), contact_limit: z.number().int().min(0).max(100),
      since: bounded.nullable() }).strict() }).strict().optional(),
}).strict();
const activeSchema = z.object({
  ...identity,
  expiresAt: z.string().datetime(), phase: z.enum(['prepared', 'sent', 'staged', 'uncertain']),
  request: z.object({ title: z.string().min(1), brief: z.string().optional() }).strict(),
  snapshot: z.object({
    config: configSchema, evidenceHash: z.string().min(1), evidenceText: z.string(),
    evidenceNodes: z.array(nodeSchema), existingWiki: wikiSchema,
    contextNodes: z.record(z.string(), nodeSchema),
    rootTitle: z.string().min(1).max(4096).optional(),
    homeAttribution: attributionSchema.optional(),
    memories: z.array(memorySchema).max(512).optional(),
    conflicts: z.array(z.tuple([memoryId, memoryId])).max(512).optional(),
    ruleLookups: z.array(z.object({ ids: z.array(memoryId).min(1).max(512),
      memories: z.array(memorySchema).max(512).nullable() }).strict()).max(512).optional(),
    contacts: contactsSchema.optional(),
    // Node facts (#383) froze the gathered facts here until they were retired (#352). A request
    // saved then still parses, so recovery can finish or clear it; the facts are ignored.
    facts: z.unknown().optional(),
  }).strict(),
  calls: z.array(callSchema), captures: z.array(captureSchema),
  reconcile: z.object({ project: z.string(), reconcile_key: z.string(), pages: z.array(z.unknown()),
    home: z.object({ sections: z.array(z.unknown()), evidence_hash: z.string(),
      curated_at: z.string(), refresh_live: z.literal(true) }).passthrough() }).passthrough().optional(),
  result: z.object({ reconcile_key: z.string(), created: z.array(z.unknown()),
    updated: z.array(z.unknown()), mappings: z.array(z.unknown()), home: z.object({}).passthrough() }).passthrough().optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional(),
}).strict();
const terminalSchema = z.object({
  ...identity,
  phase: z.enum(['committed', 'failed']), receipts: z.array(outputReceiptSchema).max(512).optional(),
  mappings: z.array(mappingSchema).max(512).optional(), reconcileKey: z.string().min(1).max(512).optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional(),
}).strict();

function invalid(): never { throw new Error('REQUEST_EXECUTION_INVALID'); }
function budget(): never { throw new Error('REQUEST_EXECUTION_BUDGET'); }
function expiry(): never { throw new Error('REQUEST_EXECUTION_EXPIRY'); }

function assertJson(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (depth > 64) invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return; }
  if (typeof value !== 'object' || seen.has(value)) invalid();
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertJson(entry, seen, depth + 1);
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) invalid();
    for (const [key, entry] of Object.entries(value)) {
      if (key === '__proto__') invalid();
      assertJson(entry, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function ensureNotExpired(execution: PageRequestExecution): void {
  if (!isTerminal(execution) && Date.parse(execution.expiresAt) <= Date.now()) {
    throw new RequestExecutionExpiredError(execution.generation);
  }
}

function parseExecution(value: unknown, checkTime: boolean): PageRequestExecution {
  assertJson(value);
  const shape = (value as { phase?: unknown }).phase;
  if (shape === 'committed' || shape === 'failed') {
    if (!terminalSchema.safeParse(value).success) invalid();
    const terminal = value as TerminalPageRequestExecution;
    if ((terminal.receipts?.length ?? 0) + (terminal.mappings?.length ?? 0) > 512
      || bytes(terminal) > MAX_TOTAL) budget();
    return terminal;
  }
  if (!activeSchema.safeParse(value).success) invalid();
  const active = value as ActivePageRequestExecution;
  const policy = active.snapshot.config.wikiOutputPolicy;
  if (policy && policy.model !== active.snapshot.config.model) invalid();
  const limits = active.snapshot.config.provenanceLimits;
  if (limits.componentBytes > limits.requestBytes || limits.requestBytes > limits.totalBytes
    || limits.outputBytes > limits.totalBytes) invalid();
  const generated = Date.parse(active.generatedAt);
  const expires = Date.parse(active.expiresAt);
  if (expires > generated + limits.leaseMs) expiry();
  for (const capture of active.captures) {
    if (capture.receipt && expires > Date.parse(capture.receipt.lease_expires_at)) expiry();
  }
  const ruleMemories = (active.snapshot.ruleLookups ?? []).flatMap(lookup => lookup.memories ?? []);
  if (active.calls.length > limits.itemCount || active.captures.length > limits.itemCount
    || active.snapshot.evidenceNodes.length > limits.itemCount
    || (active.snapshot.memories?.length ?? 0) > limits.itemCount
    || (active.snapshot.conflicts?.length ?? 0) > limits.itemCount
    || (active.snapshot.contacts ? active.snapshot.contacts.people.length + active.snapshot.contacts.companies.length
      + (active.snapshot.contacts.unlinked?.length ?? 0) : 0) > limits.itemCount
    || (active.snapshot.ruleLookups ?? []).reduce((sum, lookup) => sum + lookup.ids.length, 0) > limits.itemCount
    || ruleMemories.length > limits.itemCount
    || Object.keys(active.snapshot.contextNodes).length > limits.itemCount) budget();
  if (active.snapshot.homeAttribution && (active.snapshot.homeAttribution.items.length > limits.itemCount
    || active.snapshot.homeAttribution.omissions.length > limits.itemCount
    || active.snapshot.homeAttribution.items.some(item => bytes(item) > limits.componentBytes))) budget();
  const keys = new Set<string>();
  for (const call of active.calls) {
    if (keys.has(call.key) || (call.state === 'result') !== (call.result !== undefined)) invalid();
    keys.add(call.key);
    if (call.result && bytes(call.result) > limits.outputBytes) budget();
  }
  const attemptKeys = new Set<string>();
  const drafts = new Set<string>();
  for (const capture of active.captures) {
    if (attemptKeys.has(capture.attemptKey)) invalid();
    attemptKeys.add(capture.attemptKey);
    // One record per page draft: a second draft only for a sub-page, never twice.
    const draft = `${capture.flow}:${JSON.stringify(capture.target ?? null)}:${capture.draft ?? 1}`;
    if (drafts.has(draft) || (capture.draft === 2 && capture.flow !== 'project-subpage-v1')) invalid();
    drafts.add(draft);
    if (capture.stageRequest) {
      if (capture.receipt?.state !== 'prepared'
        || capture.stageRequest.derivation_id !== capture.receipt.derivation_id
        || capture.stageRequest.bundle_digest !== capture.receipt.bundle_digest) invalid();
    }
  }
  if (bytes(active.request) > limits.requestBytes ||
    (active.reconcile && bytes(active.reconcile) > limits.requestBytes)) budget();
  const components: unknown[] = [active.snapshot.evidenceText, active.snapshot.existingWiki,
    ...active.snapshot.evidenceNodes, ...(active.snapshot.memories ?? []), ...ruleMemories, ...Object.values(active.snapshot.contextNodes),
    ...(active.snapshot.homeAttribution?.omissions ?? []), active.snapshot.rootTitle ?? '', active.snapshot.contacts ?? {},
    ...active.captures.map(capture => capture.receipt).filter(Boolean),
    ...Object.values(active.snapshot.config).filter(value => typeof value === 'string')];
  if (components.some(component => bytes(component) > limits.componentBytes)) budget();
  if (active.captures.some(capture => capture.stageRequest && bytes(capture.stageRequest) > limits.outputBytes)
    || (active.result && replayResultBytes(active.result) > MAX_REPLAY_RESULT_BYTES)) budget();
  if (bytes(active) > limits.totalBytes) budget();
  if (checkTime) ensureNotExpired(active);
  return active;
}

function readStored(raw: string, checkTime: boolean): PageRequestExecution {
  if (Buffer.byteLength(raw, 'utf8') > MAX_TOTAL) budget();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { invalid(); }
  return parseExecution(value, checkTime);
}

type StoredRow = { execution_json: string | null; project_node_id: string | null };
function row(db: Database.Database, id: number): StoredRow | undefined {
  return db.prepare('SELECT execution_json, project_node_id FROM page_requests WHERE id=?').get(id) as StoredRow | undefined;
}

/** A missing checkpoint is null; an invalid or expired checkpoint fails closed. */
export function readRequestExecution(db: Database.Database, id: number): PageRequestExecution | null {
  const current = row(db, id);
  const raw = current?.execution_json;
  if (raw === undefined || raw === null) return null;
  const execution = readStored(raw, false);
  if (current?.project_node_id !== null && current?.project_node_id !== execution.projectId)
    throw new Error('REQUEST_EXECUTION_CONFLICT');
  ensureNotExpired(execution);
  return execution;
}

/** Immediate transaction serializes the generation check and durable replacement. */
function withoutCallDiagnostics(execution: ActivePageRequestExecution): ActivePageRequestExecution {
  return { ...execution, calls: execution.calls.map(call => {
    if (!call.result?.diagnostics) return call;
    const { diagnostics: _observer, ...result } = call.result;
    return { ...call, result };
  }) };
}

export function writeRequestExecution(
  db: Database.Database, id: number, expectedGeneration: string | null, next: PageRequestExecution,
): void {
  let validated: PageRequestExecution;
  try { validated = parseExecution(next, true); }
  catch (error) {
    // Parsing checks the strict shape first. Only capacity failure can discard
    // valid optional diagnostics; business fields still face every original cap.
    if (!(error instanceof Error) || error.message !== 'REQUEST_EXECUTION_BUDGET' || isTerminal(next)) throw error;
    validated = parseExecution(withoutCallDiagnostics(next), true);
  }
  const serialized = JSON.stringify(validated);
  db.transaction(() => {
    const current = row(db, id);
    if (!current || (current.project_node_id !== null && current.project_node_id !== validated.projectId))
      throw new Error('REQUEST_EXECUTION_CONFLICT');
    const prior = current.execution_json === null ? null : readStored(current.execution_json, false);
    if ((prior?.generation ?? null) !== expectedGeneration) throw new Error('REQUEST_EXECUTION_CONFLICT');
    // Terminal rows are immutable. A direct terminal insert has only the hard
    // 512-item/2-MiB caps; an active-to-terminal transition inherits its
    // frozen effective limits before the active snapshot is discarded.
    if (prior && isTerminal(prior)) throw new Error('REQUEST_EXECUTION_CONFLICT');
    if (prior && !isTerminal(validated)) ensureNotExpired(prior);
    if (prior && isTerminal(validated)) {
      if (validated.generation !== prior.generation || validated.projectId !== prior.projectId
        || validated.runRef !== prior.runRef || validated.generatedAt !== prior.generatedAt)
        throw new Error('REQUEST_EXECUTION_CONFLICT');
      const limits = prior.snapshot.config.provenanceLimits;
      if ((validated.receipts?.length ?? 0) + (validated.mappings?.length ?? 0) > limits.itemCount
        || Buffer.byteLength(serialized, 'utf8') > limits.totalBytes) budget();
    }
    const changed = db.prepare('UPDATE page_requests SET execution_json=? WHERE id=? AND execution_json IS ?')
      .run(serialized, id, current.execution_json).changes;
    if (changed !== 1) throw new Error('REQUEST_EXECUTION_CONFLICT');
  }).immediate();
}

export function clearRequestExecution(db: Database.Database, id: number, expectedGeneration: string): void {
  db.transaction(() => {
    const current = row(db, id);
    if (!current || current.execution_json === null) throw new Error('REQUEST_EXECUTION_CONFLICT');
    const prior = readStored(current.execution_json, false);
    if (prior.generation !== expectedGeneration) throw new Error('REQUEST_EXECUTION_CONFLICT');
    const changed = db.prepare('UPDATE page_requests SET execution_json=NULL WHERE id=? AND execution_json IS ?')
      .run(id, current.execution_json).changes;
    if (changed !== 1) throw new Error('REQUEST_EXECUTION_CONFLICT');
  }).immediate();
}
