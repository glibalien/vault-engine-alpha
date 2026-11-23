// allow: SIZE_OK — end-to-end preview matrix shares one deterministic fake Engine/LLM harness.
import Database from 'better-sqlite3';
import { BudgetExhaustedError } from '../src/budget.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  conversationCaptureFingerprint,
  inspectConversation,
  type ConversationInspection,
} from '@vault/chat-core/conversation-inspection';
import type { Config } from '../src/config.js';
import { MIGRATIONS, runMigrations } from '../src/db/migrate.js';
import {
  getConversationCaptureArtifact,
  getConversationCaptureLedger,
  lastConversationCaptureAt,
  setLastConversationCaptureAt,
  upsertConversationCaptureArtifact,
  upsertConversationCaptureLedger,
} from '../src/db/conversation-capture.js';
import {
  captureBlockHash,
  captureCompositionHash,
  captureId,
  renderCaptureBlock,
} from '../src/conversation-capture-markers.js';
import { destinationDecisionFingerprint } from '../src/conversation-capture-destination-fingerprint.js';
import {
  capturePlannerDestinationRecord,
  MAX_LINKED_BODY_EXCERPT_CHARS,
} from '../src/conversation-capture-prompts.js';
import { EngineError, type Engine } from '../src/engine.js';
import type { ActionRecorder } from '../src/journal/recorder.js';
import { StructuredCallFailure, type LlmClient, type StructuredCallRequest } from '../src/llm/types.js';
import { CurationQueue } from '../src/queue.js';
import type { ConversationMeta } from '../src/types.js';
import type { UsageReporter } from '../src/usage-reporter.js';
import {
  CaptureRejectionBreakers,
  evaluateConversationCaptureCandidate,
  runConversationCaptureSweep,
  type ConversationCaptureSweepResult,
  type ConversationCaptureLinkedNodeRead,
} from '../src/conversation-capture-sweep.js';
import { CAPTURE_OFF_NO_NOTE_KIND } from '../src/conversation-capture-sweep.js';
import { defaultsFor, type VaultSettings } from '@vault/settings-registry';

const DEFAULT_VAULT = defaultsFor('vault') as unknown as VaultSettings;

const NOW = new Date('2026-08-26T12:00:00.000Z');
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const SOURCE_URL = 'https://example.test/reference';
const openDbs: Database.Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function captureDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  openDbs.push(db);
  return db;
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    model: 'capture-default',
    conversationCaptureMode: 'preview',
    conversationCaptureSettleHours: 6,
    conversationCaptureInitialLookbackDays: 7,
    conversationCaptureMinAssistantChars: 500,
    conversationCaptureEvaluationCap: 10,
    conversationCaptureArtifactCap: 3,
    conversationCaptureWriteCap: 5,
    conversationCaptureModel: null,
    conversationCapturePlannerMaxTokens: 4_000,
    conversationCaptureCoverageModel: null,
    conversationCaptureCoverageMaxTokens: 2_000,
    conversationCaptureComposerMaxTokens: 6_000,
    curatorConversationCapturePlannerPrompt: 'planner prompt',
    curatorConversationCaptureCoveragePrompt: 'coverage prompt',
    curatorConversationCaptureComposerPrompt: 'composer prompt',
    // The dates these fixtures assert were written in UTC; #496 takes them in this zone.
    curatorTz: 'UTC',
    ...overrides,
  } as Config;
}

function meta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: 'conversation-1',
    title: 'Modular vehicle overview',
    created_at: '2026-08-25T00:00:00.000Z',
    updated_at: '2026-08-26T06:00:00.000Z',
    archived: 0,
    revision: 1,
    linked_docs: [],
    ...overrides,
  };
}

function messages(assistantText = `A durable assistant explanation ${'x'.repeat(560)} ${SOURCE_URL}`): unknown[] {
  return [
    { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Explain this for later reference.' }] },
    { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: assistantText }] },
  ];
}

function receiptTool(input: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'dynamic-tool', toolName: 'update-node', toolCallId: 'write-current',
    state: 'output-available', input,
    output: { ok: true, data: { node_id: input.node_id } },
  };
}

function node(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Node ${id}`,
    file_path: `Notes/${id}.md`,
    types: ['note'],
    version: 4,
    fields: {},
    body: `Existing body for ${id}.`,
    metadata: { content_hash: `hash-${id}` },
    ...overrides,
  };
}

function linkedEngineNode(args: {
  id?: string;
  title?: string;
  filePath?: string;
  body?: string;
  version?: number;
  fields?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const id = args.id ?? 'linked-1';
  return node(id, {
    title: args.title ?? `Node ${id}`,
    file_path: args.filePath ?? `Notes/${id}.md`,
    body: args.body ?? `Existing body for ${id}.`,
    version: args.version ?? 4,
    fields: args.fields ?? {},
  });
}

function noFittingDestinationFingerprint(nodes: readonly Record<string, unknown>[]) {
  return destinationDecisionFingerprint(nodes.map((node) => {
    const id = String(node.id);
    return {
      nodeId: id,
      state: 'eligible' as const,
      plannerRecord: capturePlannerDestinationRecord({
        id,
        title: String(node.title),
        filePath: String(node.file_path),
        bodyExcerpt: String(node.body),
      }),
    };
  }));
}

function protectedDestinationFingerprint(
  node: Record<string, unknown>,
  reason: 'settings-path' | 'schema-path' | 'projection-field',
) {
  return destinationDecisionFingerprint([{
    nodeId: String(node.id),
    state: 'protected',
    reason,
  }]);
}

function seedNoFittingLedger(args: {
  db: Database.Database;
  conversationId: string;
  inputHash: string;
  nodes: readonly Record<string, unknown>[];
  decision?: ReturnType<typeof destinationDecisionFingerprint>;
}): void {
  const decision = args.decision ?? noFittingDestinationFingerprint(args.nodes);
  upsertConversationCaptureLedger(args.db, {
    conversation_id: args.conversationId,
    input_hash: args.inputHash,
    processed_at: NOW.toISOString(),
    outcome: 'no-fitting-destination',
    artifact_count: 0,
    destination_count: 0,
    decision_evidence_hash: decision.hash,
    decision_evidence_version: decision.version,
  });
}

function rawArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const artifactKey = typeof overrides.artifact_key === 'string' ? overrides.artifact_key : 'vehicle-overview';
  return {
    artifact_key: artifactKey,
    title: 'Modular vehicle overview',
    brief: artifactKey === 'vehicle-overview'
      ? 'A reusable overview of the modular vehicle choices.'
      : `A distinct reusable capture brief for ${artifactKey}.`,
    assistant_message_ids: ['assistant-1'],
    source_urls: [SOURCE_URL],
    destination_node_id: 'unbound',
    ...overrides,
  };
}

function planCapture(artifacts: Record<string, unknown>[]): Record<string, unknown> {
  return { outcome: 'capture', reason_code: 'capture', reason: 'Durable assistant value.', artifacts };
}

function planSkip(
  reasonCode: 'not-valuable' | 'ungrounded-factual' | 'no-fitting-destination' = 'not-valuable',
): Record<string, unknown> {
  return {
    outcome: 'skip', reason_code: reasonCode, reason: 'No capture proposed.', artifacts: [],
  };
}

function coverage(
  decision: 'uncovered' | 'partial' | 'full',
  proof: { toolCallIds?: string[]; captureIds?: string[]; missingBrief?: string } = {},
): Record<string, unknown> {
  return {
    decision,
    reason: `Coverage decision: ${decision}.`,
    coveringToolCallIds: proof.toolCallIds ?? [],
    coveringCaptureIds: proof.captureIds ?? [],
    missingBrief: proof.missingBrief ?? (decision === 'partial' ? 'Retain only the missing durable value.' : ''),
  };
}

function fullyCoveredSequence(
  proof: { toolCallIds?: string[]; captureIds?: string[] },
  artifactOverrides: Record<string, unknown> = {},
): unknown[] {
  return [
    planCapture([rawArtifact(artifactOverrides)]),
    coverage('full', proof),
  ];
}

function composed(artifacts: Array<{ key?: string; title?: string; markdown?: string }> = [{}]): Record<string, unknown> {
  return {
    artifacts: artifacts.map((artifact, index) => ({
      artifact_key: artifact.key ?? (index === 0 ? 'vehicle-overview' : `artifact-${index + 1}`),
      title: artifact.title ?? (index === 0 ? 'Modular vehicle overview' : `Artifact ${index + 1}`),
      markdown: artifact.markdown ?? (index === 0 ? 'A concise modular vehicle overview.' : `Body ${index + 1}.`),
    })),
  };
}

function scriptedLlm(outputs: unknown[]): { llm: LlmClient; calls: StructuredCallRequest[] } {
  const calls: StructuredCallRequest[] = [];
  const remaining = [...outputs];
  return {
    calls,
    llm: {
      async structuredCall(request) {
        calls.push(request);
        const output = remaining.shift();
        if (output === undefined) throw new Error(`unexpected ${request.toolName} call`);
        if (output instanceof Error) throw output;
        return { output, usage: ZERO_USAGE };
      },
    },
  };
}

interface FakeEngineHarness {
  engine: Engine;
  listCalls: Array<Record<string, unknown>>;
  conversationReads: string[];
  nodeReads: string[];
  createCalls: Array<Record<string, unknown>>;
  appendCalls: Array<Record<string, unknown>>;
  liveMutations: Array<Record<string, unknown>>;
  schemaEnsures: string[];
  nodeMap: Record<string, Record<string, unknown> | Error>;
}

interface FakeEngineBehavior {
  ensureNoteSchema?: () => Promise<void>;
  createPreview?: (args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  createLive?: (args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  append?: (args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  conversationCaptureCandidates?: (conversationId: string) => Promise<Record<string, unknown>[]> | Record<string, unknown>[];
  captureIdCandidates?: (captureId: string) => Promise<Record<string, unknown>[]> | Record<string, unknown>[];
  conversationDetail?: (id: string, readIndex: number) => Promise<unknown> | unknown;
}

function fakeEngine(
  conversations: ConversationMeta[],
  messageMap: Record<string, unknown[]>,
  nodeMap: Record<string, Record<string, unknown> | Error> = {},
  detailMap: Record<string, unknown> = {},
  listResponse: unknown = conversations,
  behavior: FakeEngineBehavior = {},
): FakeEngineHarness {
  const listCalls: Array<Record<string, unknown>> = [];
  const conversationReads: string[] = [];
  const nodeReads: string[] = [];
  const createCalls: Array<Record<string, unknown>> = [];
  const appendCalls: Array<Record<string, unknown>> = [];
  const liveMutations: Array<Record<string, unknown>> = [];
  const schemaEnsures: string[] = [];
  const engine = {
    async ensureNoteSchema(type: string) {
      schemaEnsures.push(type);
      await behavior.ensureNoteSchema?.();
    },
    async listConversations(args: Record<string, unknown>) {
      listCalls.push(args);
      return listResponse;
    },
    async getConversation(id: string) {
      conversationReads.push(id);
      if (behavior.conversationDetail !== undefined) {
        return behavior.conversationDetail(id, conversationReads.filter((value) => value === id).length);
      }
      if (Object.prototype.hasOwnProperty.call(detailMap, id)) return detailMap[id];
      const conversation = conversations.find((candidate) => candidate.id === id);
      if (!conversation) throw new Error(`missing conversation ${id}`);
      // Engine's get-conversation returns linked_docs beside the row, never inside it.
      const { linked_docs: linkedDocs, ...row } = conversation;
      return { conversation: row, messages: messageMap[id] ?? [], linked_docs: linkedDocs ?? [] };
    },
    async getNode(id: string) {
      nodeReads.push(id);
      const value = nodeMap[id];
      if (value instanceof Error) throw value;
      if (!value) throw new Error(`missing node ${id}`);
      return value;
    },
    async createNode(args: Record<string, unknown>) {
      createCalls.push(args);
      if (args.dryRun === true) {
        if (behavior.createPreview !== undefined) return behavior.createPreview(args);
        return { dry_run: true, would_create: { file_path: `Notes/${String(args.title)}.md` }, warnings: [] };
      }
      liveMutations.push(args);
      if (behavior.createLive !== undefined) return behavior.createLive(args);
      const nodeId = `created-${createCalls.filter((call) => call.dryRun !== true).length}`;
      nodeMap[nodeId] = node(nodeId, {
        title: String(args.title), file_path: `Notes/${String(args.title)}.md`, body: String(args.body), version: 1,
      });
      return { node_id: nodeId, file_path: `Notes/${String(args.title)}.md`, warnings: [] };
    },
    async appendCapturedContent(args: Record<string, unknown>) {
      appendCalls.push(args);
      const existing = nodeMap[String(args.nodeId)];
      if (existing instanceof Error || existing === undefined) throw new Error(`missing node ${String(args.nodeId)}`);
      if (Number(args.expectedVersion) !== Number(existing.version)) {
        throw new EngineError('STALE_NODE', 'version changed');
      }
      if (args.dryRun !== true) {
        liveMutations.push(args);
        const response = behavior.append === undefined ? { warnings: [] } : await behavior.append(args);
        const currentBody = String(existing.body);
        existing.body = currentBody ? `${currentBody}\n\n${String(args.text)}` : String(args.text);
        existing.version = Number(existing.version) + 1;
        return response;
      }
      return { warnings: [] };
    },
    async findNodesContainingConversationCapture(conversationId: string) {
      if (behavior.conversationCaptureCandidates !== undefined) {
        return behavior.conversationCaptureCandidates(conversationId);
      }
      return Object.values(nodeMap).filter((candidate): candidate is Record<string, unknown> =>
        !(candidate instanceof Error)
          && String(candidate.body).includes(`conversation="${conversationId}"`));
    },
    async findNodesContainingCaptureId(captureId: string) {
      if (behavior.captureIdCandidates !== undefined) return behavior.captureIdCandidates(captureId);
      return Object.values(nodeMap).filter((candidate): candidate is Record<string, unknown> =>
        !(candidate instanceof Error)
          && String(candidate.body).includes(`ve:chat-curation:start id="${captureId}"`));
    },
  } as unknown as Engine;
  return { engine, listCalls, conversationReads, nodeReads, createCalls, appendCalls, liveMutations, schemaEnsures, nodeMap };
}

function expectCompletePreviewResult(result: ConversationCaptureSweepResult): void {
  expect(result.ran).toBe(true);
  expect(result.dryRun).toBe(true);
  for (const key of [
    'scanned', 'settled', 'belowFloor', 'unchanged', 'unreliable', 'protectedOnly',
    'evaluated', 'notValuable', 'fullyCovered', 'partiallyCovered', 'ungrounded',
    'coverageCalls', 'uncoveredArtifacts', 'partiallyCoveredArtifacts', 'fullyCoveredArtifacts',
    'wouldCreate', 'created', 'wouldAppend', 'appended', 'deferred', 'errors',
  ] as const) {
    expect(typeof result[key], key).toBe('number');
  }
  expect(Array.isArray(result.proposals)).toBe(true);
}

function deps(
  harness: FakeEngineHarness,
  llm: LlmClient,
  overrides: { config?: Partial<Config>; db?: Database.Database } = {},
) {
  return {
    engine: harness.engine,
    llm,
    config: config(overrides.config),
    queue: new CurationQueue(),
    ...(overrides.db ? { db: overrides.db } : {}),
  };
}

function liveDeps(
  harness: FakeEngineHarness,
  llm: LlmClient,
  db: Database.Database,
  overrides: { config?: Partial<Config>; recorder?: ActionRecorder } = {},
) {
  return {
    ...deps(harness, llm, {
      db,
      config: { conversationCaptureMode: 'live', ...overrides.config },
    }),
    ...(overrides.recorder === undefined ? {} : { recorder: overrides.recorder }),
  };
}

function captureIdFromBlock(block: string): string {
  const match = /ve:chat-curation:start id="([^"]+)"/.exec(block);
  if (match?.[1] === undefined) throw new Error('capture block has no start id');
  return match[1];
}

function linkedRead(id: string, overrides: Record<string, unknown> = {}): ConversationCaptureLinkedNodeRead {
  const value = node(id, overrides);
  return {
    nodeId: id,
    ok: true,
    node: {
      id,
      title: String(value.title),
      filePath: String(value.file_path),
      body: String(value.body),
      version: Number(value.version),
      fields: value.fields as Record<string, unknown>,
    },
  };
}

describe('runConversationCaptureSweep candidate funnel', () => {
  it('serializes capture and records separately attributed planner and composer observability', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1'),
    });
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]), composed(),
    ]);
    const queue = new CurationQueue();
    const enqueue = vi.spyOn(queue, 'enqueue');
    const usageSetContext = vi.fn();
    const usage = { setContext: usageSetContext } as unknown as UsageReporter;
    const recorder = {
      setContext: vi.fn(), summary: vi.fn(), record: vi.fn(),
    } as unknown as ActionRecorder;
    const captureDeps = {
      ...liveDeps(engine, llm.llm, db, { recorder }),
      queue,
      usage,
    };

    const result = await runConversationCaptureSweep(captureDeps, {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ appended: 1, errors: 0 });
    expect(enqueue).toHaveBeenCalledWith('conversation-capture', expect.any(Function));
    expect(usage.setContext).toHaveBeenNthCalledWith(1, expect.objectContaining({
      project: 'conversation-capture', purpose: 'conversation-capture-planner',
    }));
    expect(usage.setContext).toHaveBeenNthCalledWith(2, null);
    expect(usage.setContext).toHaveBeenNthCalledWith(3, expect.objectContaining({
      project: 'conversation-capture', purpose: 'conversation-capture-composer',
    }));
    expect(usage.setContext).toHaveBeenNthCalledWith(4, null);
    expect(recorder.setContext).toHaveBeenNthCalledWith(1, expect.objectContaining({
      fn: 'conversation-capture', trigger: 'scheduled', project: 'conversation-capture',
    }));
    expect(recorder.setContext).toHaveBeenLastCalledWith(null);
    expect(recorder.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'conversation-capture-appended', nodeId: 'linked-1',
      detail: expect.stringMatching(/capture .*conversation-1.*linked-1/),
    }));
    expect(recorder.summary).toHaveBeenCalledWith(
      'conversation-capture', expect.any(String), expect.objectContaining({
        scanned: 1,
        appended: 1,
        coverageCalls: 0,
        uncoveredArtifacts: 1,
        partiallyCoveredArtifacts: 0,
        fullyCoveredArtifacts: 0,
        errors: 0,
      }), false,
    );
  });

  it('captures a linked conversation whose Engine detail carries linked_docs beside the row', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const { linked_docs: _linkedDocs, ...row } = conversation;
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1'),
    }, {}, [conversation], {
      conversationDetail: () => ({ conversation: row, messages: messages(), linked_docs: ['linked-1'] }),
    });
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]), composed(),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ appended: 1, deferred: 0, errors: 0 });
    expect(result.detail ?? '').not.toContain('conversation changed');
  });

  it('defers atomically when a later artifact coverage call fails', async () => {
    const db = captureDb();
    const conversationMessages = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Keep both durable lessons.' }] },
      {
        id: 'assistant-1', role: 'assistant', parts: [
          { type: 'text', text: `First durable lesson. ${'a'.repeat(300)} ${SOURCE_URL}` },
          receiptTool({ node_id: 'written-node', append_body: 'Eligible coverage evidence.', dry_run: false }),
        ],
      },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second durable lesson. ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages }, {
      'linked-1': node('linked-1'),
    });
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({ artifact_key: 'first', title: 'First', assistant_message_ids: ['assistant-1'], destination_node_id: 'linked-1' }),
        rawArtifact({ artifact_key: 'second', title: 'Second', assistant_message_ids: ['assistant-2'], destination_node_id: 'linked-1' }),
      ]),
      coverage('uncovered'),
      new StructuredCallFailure('RAW-LATER-COVERAGE-MARKER', undefined, 'malformed_json'),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(llm.calls.map((call) => call.toolName)).toEqual([
      'plan_conversation_capture',
      'adjudicate_conversation_capture_coverage',
      'adjudicate_conversation_capture_coverage',
    ]);
    expect(result).toMatchObject({
      deferred: 1,
      errors: 1,
      coverageCalls: 2,
      uncoveredArtifacts: 0,
      partiallyCoveredArtifacts: 0,
      fullyCoveredArtifacts: 0,
      created: 0,
      appended: 0,
      wouldCreate: 0,
      wouldAppend: 0,
      proposals: [],
    });
    expect(result.detail).toContain('reason=malformed_json');
    expect(result.detail).not.toContain('RAW-LATER-COVERAGE-MARKER');
    expect(engine.createCalls).toEqual([]);
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_ledger').get()).toEqual({ n: 0 });
  });

  it('does nothing while off and runs preview without a curator DB', async () => {
    const conversation = meta({ archived: 1 });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() });
    const offLlm = scriptedLlm([]);
    const off = await runConversationCaptureSweep(deps(engine, offLlm.llm, {
      config: { conversationCaptureMode: 'off' },
    }), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(off).toMatchObject({ ran: false, dryRun: false, scanned: 0 });
    expect(engine.listCalls).toEqual([]);

    const previewLlm = scriptedLlm([planSkip()]);
    const preview = await runConversationCaptureSweep(deps(engine, previewLlm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    expect(preview).toMatchObject({ ran: true, dryRun: true, scanned: 1, settled: 1, evaluated: 1, notValuable: 1 });
    expect(engine.listCalls).toEqual([{ includeArchived: true, includeLinkedDocs: true }]);
  });

  it('is off when the journal kind is none: no reads, no model calls, no writes', async () => {
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: messages() });
    const llm = scriptedLlm([]);
    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, captureDb(), {
      config: { vault: { ...DEFAULT_VAULT, journalType: null } },
    }), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ ran: false, scanned: 0, created: 0, appended: 0, detail: CAPTURE_OFF_NO_NOTE_KIND });
    expect(engine.listCalls).toEqual([]);
    expect(engine.createCalls).toEqual([]);
    expect(llm.calls).toEqual([]);
  });

  it('creates notes of the vault map\'s journal kind and recognizes them on the next pass', async () => {
    const db = captureDb();
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: messages() });
    const vault = { ...DEFAULT_VAULT, journalType: 'log' };
    const first = await runConversationCaptureSweep(liveDeps(
      engine, scriptedLlm([planCapture([rawArtifact()]), composed()]).llm, db, { config: { vault } },
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(first).toMatchObject({ created: 1, deferred: 0, errors: 0 });
    expect(engine.schemaEnsures).toEqual(['log']);
    expect(engine.createCalls.map((call) => call.types)).toEqual([['log'], ['log']]);
    const created = engine.nodeMap['created-1'];
    if (created === undefined || created instanceof Error) throw new Error('created capture node is unavailable');
    created.types = ['log'];

    const second = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm([]).llm, db, { config: { vault } }), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    expect(second).toMatchObject({ unchanged: 1, created: 0, deferred: 0, errors: 0 });
  });

  it('uses configurable seven-day and quiet-period gates with inclusive boundaries', async () => {
    const rows = [
      meta({ id: 'too-old', updated_at: '2026-08-19T11:59:59.999Z' }),
      meta({ id: 'at-lookback', updated_at: '2026-08-19T12:00:00.000Z' }),
      meta({ id: 'at-cutoff', updated_at: '2026-08-26T06:00:00.000Z' }),
      meta({ id: 'unsettled', updated_at: '2026-08-26T06:00:00.001Z' }),
    ];
    const engine = fakeEngine(rows, Object.fromEntries(rows.map((row) => [row.id, messages()])));
    const llm = scriptedLlm([planSkip(), planSkip()]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ scanned: 4, settled: 2, evaluated: 2 });
    expect(engine.conversationReads).toEqual(['at-lookback', 'at-lookback', 'at-cutoff', 'at-cutoff']);
  });

  it('honors zero and custom settle hours from config rather than hard-coding six hours', async () => {
    const current = meta({ updated_at: NOW.toISOString() });
    const zeroEngine = fakeEngine([current], { [current.id]: messages() });
    const zeroLlm = scriptedLlm([planSkip()]);
    const zero = await runConversationCaptureSweep(deps(zeroEngine, zeroLlm.llm, {
      config: { conversationCaptureSettleHours: 0 },
    }), { dryRun: false, trigger: 'cli', now: NOW });
    expect(zero).toMatchObject({ settled: 1, evaluated: 1 });

    const recent = meta({ updated_at: '2026-08-26T11:30:00.000Z' });
    const customEngine = fakeEngine([recent], { [recent.id]: messages() });
    const custom = await runConversationCaptureSweep(deps(customEngine, scriptedLlm([]).llm, {
      config: { conversationCaptureSettleHours: 1 },
    }), { dryRun: false, trigger: 'cli', now: NOW });
    expect(custom).toMatchObject({ settled: 0, evaluated: 0 });
  });

  it('applies assistant floor and unreliable-writer gates before any model call', async () => {
    const short = meta({ id: 'short' });
    const unreliable = meta({ id: 'unreliable', updated_at: '2026-08-26T05:00:00.000Z' });
    const unreliableMessages = messages();
    (unreliableMessages[1] as { parts: unknown[] }).parts.push({
      type: 'dynamic-tool', toolName: 'wiki-write', toolCallId: 'unknown-writer',
      state: 'output-available', input: { body: 'possible write' }, output: { ok: true, data: {} },
    });
    const engine = fakeEngine([short, unreliable], {
      short: messages('tiny'), unreliable: unreliableMessages,
    });
    const llm = scriptedLlm([]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ belowFloor: 1, unreliable: 1, evaluated: 0, deferred: 1 });
    expect(llm.calls).toEqual([]);
  });

  it('spends the evaluation cap oldest-first and defers later model-ready candidates', async () => {
    const rows = [
      meta({ id: 'newest', title: 'Newest', updated_at: '2026-08-26T05:00:00.000Z' }),
      meta({ id: 'oldest', title: 'Oldest', updated_at: '2026-08-25T05:00:00.000Z' }),
      meta({ id: 'middle', title: 'Middle', updated_at: '2026-08-26T04:00:00.000Z' }),
    ];
    const engine = fakeEngine(rows, Object.fromEntries(rows.map((row) => [row.id, messages()])));
    const llm = scriptedLlm([planSkip(), planSkip()]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm, {
      config: { conversationCaptureEvaluationCap: 2 },
    }), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ evaluated: 2, deferred: 1 });
    expect(engine.conversationReads).toEqual(['oldest', 'oldest', 'middle', 'middle', 'newest', 'newest']);
    expect(llm.calls.filter((call) => call.toolName === 'plan_conversation_capture').map((call) => call.user))
      .toEqual([expect.stringContaining('"id":"oldest"'), expect.stringContaining('"id":"middle"')]);
  });

  it('skips an unchanged fingerprint but reopens evaluation after a link-only change', async () => {
    const db = captureDb();
    const body = messages();
    const inspection = inspectConversation(body);
    const originalHash = conversationCaptureFingerprint(inspection, ['linked-1']);
    upsertConversationCaptureLedger(db, {
      conversation_id: 'conversation-1', input_hash: originalHash,
      processed_at: '2026-08-26T07:00:00.000Z', outcome: 'captured',
      artifact_count: 1, destination_count: 1,
    });
    const original = meta({ linked_docs: ['linked-1'] });
    const unchangedEngine = fakeEngine([original], { [original.id]: body }, { 'linked-1': node('linked-1') });
    const unchanged = await runConversationCaptureSweep(deps(unchangedEngine, scriptedLlm([]).llm, { db }), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    expect(unchanged).toMatchObject({ unchanged: 1, evaluated: 0 });

    const relinked = meta({ linked_docs: ['linked-2'] });
    const relinkedEngine = fakeEngine([relinked], { [relinked.id]: body }, { 'linked-2': node('linked-2') });
    const relinkedLlm = scriptedLlm([planSkip()]);
    const changed = await runConversationCaptureSweep(deps(relinkedEngine, relinkedLlm.llm, { db }), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    expect(changed).toMatchObject({ unchanged: 0, evaluated: 1 });
  });

  it.each([
    {
      name: 'authoritative update timestamp',
      detail: (listed: ConversationMeta) => ({
        conversation: { ...listed, updated_at: '2026-08-26T11:59:00.000Z' },
        messages: messages(`Changed transcript ${'y'.repeat(560)} ${SOURCE_URL}`),
        linked_docs: listed.linked_docs,
      }),
      expectedReason: 'updated_at',
    },
    {
      name: 'link-only projection',
      detail: (listed: ConversationMeta) => ({
        conversation: listed,
        messages: messages(),
        linked_docs: ['linked-2'],
      }),
      expectedReason: 'linked_docs',
    },
  ])('defers a candidate changed after listing via $name before planning', async ({ detail, expectedReason }) => {
    const listed = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine(
      [listed],
      { [listed.id]: messages() },
      { 'linked-1': node('linked-1'), 'linked-2': node('linked-2') },
      { [listed.id]: detail(listed) },
    );
    const llm = scriptedLlm([planSkip()]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({
      ran: true, dryRun: true, scanned: 1, settled: 1,
      evaluated: 0, deferred: 1, errors: 0, proposals: [],
    });
    expect(result.detail).toContain(`conversation-1: conversation changed after metadata scan (${expectedReason})`);
    expect(llm.calls).toEqual([]);
    expect(engine.nodeReads).toEqual([]);
    expect(engine.createCalls).toEqual([]);
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });

  it.each([
    {
      name: 'locale-formatted created_at',
      field: 'created_at',
      timestamp: 'August 25, 2026 12:00:00 GMT',
    },
    {
      name: 'timezone-less created_at',
      field: 'created_at',
      timestamp: '2026-08-25T00:00:00',
    },
    {
      name: 'calendar-invalid updated_at',
      field: 'updated_at',
      timestamp: '2026-02-30T06:00:00.000Z',
    },
  ] as const)('rejects a list row with $name before any candidate activity', async ({ field, timestamp }) => {
    const listed = meta({ [field]: timestamp });
    const engine = fakeEngine([listed], { [listed.id]: messages() });
    const llm = scriptedLlm([planSkip()]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expectCompletePreviewResult(result);
    expect(result).toMatchObject({ scanned: 1, settled: 0, evaluated: 0, deferred: 0, errors: 1, proposals: [] });
    expect(result.detail).toContain(`conversation metadata row 0 is invalid: ${field} must be an ISO timestamp`);
    expect(llm.calls).toEqual([]);
    expect(engine.conversationReads).toEqual([]);
    expect(engine.nodeReads).toEqual([]);
    expect(engine.createCalls).toEqual([]);
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });

  it.each([
    {
      name: 'locale-formatted created_at',
      field: 'created_at',
      timestamp: 'August 25, 2026 12:00:00 GMT',
    },
    {
      name: 'timezone-less created_at',
      field: 'created_at',
      timestamp: '2026-08-25T00:00:00',
    },
    {
      name: 'calendar-invalid updated_at',
      field: 'updated_at',
      timestamp: '2026-02-30T06:00:00.000Z',
    },
  ] as const)('rejects detail with $name before model or node activity', async ({ field, timestamp }) => {
    const listed = meta();
    const engine = fakeEngine(
      [listed],
      { [listed.id]: messages() },
      {},
      {
        [listed.id]: {
          conversation: { ...listed, [field]: timestamp },
          messages: messages(),
          linked_docs: listed.linked_docs,
        },
      },
    );
    const llm = scriptedLlm([planSkip()]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expectCompletePreviewResult(result);
    expect(result).toMatchObject({ scanned: 1, settled: 1, evaluated: 0, deferred: 1, errors: 1, proposals: [] });
    expect(result.detail).toContain(`conversation-1: malformed conversation detail: conversation ${field} must be an ISO timestamp`);
    expect(llm.calls).toEqual([]);
    expect(engine.nodeReads).toEqual([]);
    expect(engine.createCalls).toEqual([]);
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });

  it('accepts persisted RFC3339 timestamps without milliseconds and with an explicit offset', async () => {
    const listed = meta({
      created_at: '2026-08-25T00:00:00Z',
      updated_at: '2026-08-26T01:00:00-05:00',
    });
    const engine = fakeEngine([listed], { [listed.id]: messages() });
    const llm = scriptedLlm([planSkip()]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ scanned: 1, settled: 1, evaluated: 1, errors: 0, proposals: [] });
    expect(llm.calls).toHaveLength(1);
  });

  it('does not reject when list-conversations resolves a top-level null response', async () => {
    const engine = fakeEngine([], {}, {}, {}, null);
    const llm = scriptedLlm([planSkip()]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expectCompletePreviewResult(result);
    expect(result).toMatchObject({ scanned: 0, settled: 0, evaluated: 0, deferred: 0, errors: 1, proposals: [] });
    expect(result.detail).toContain('list-conversations result must be an array');
    expect(llm.calls).toEqual([]);
    expect(engine.conversationReads).toEqual([]);
    expect(engine.nodeReads).toEqual([]);
    expect(engine.createCalls).toEqual([]);
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });

  it('does not reject when list-conversations contains malformed rows', async () => {
    const engine = fakeEngine([], {}, {}, {}, [null, { id: 42 }]);
    const llm = scriptedLlm([planSkip()]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expectCompletePreviewResult(result);
    expect(result).toMatchObject({ scanned: 2, settled: 0, evaluated: 0, deferred: 0, errors: 2, proposals: [] });
    expect(result.detail).toContain('conversation metadata row 0 is invalid');
    expect(result.detail).toContain('conversation metadata row 1 is invalid');
    expect(llm.calls).toEqual([]);
    expect(engine.conversationReads).toEqual([]);
    expect(engine.nodeReads).toEqual([]);
    expect(engine.createCalls).toEqual([]);
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });

  it.each([
    { name: 'null detail', detail: null, expectedReason: 'detail must be an object' },
    {
      name: 'non-array messages',
      detail: (listed: ConversationMeta) => ({ conversation: listed, messages: null, linked_docs: listed.linked_docs }),
      expectedReason: 'messages must be an array',
    },
    {
      name: 'malformed linked projection',
      detail: (listed: ConversationMeta) => ({ conversation: listed, messages: messages(), linked_docs: [null] }),
      expectedReason: 'linked_docs must be an array of strings',
    },
  ])('does not reject or mutate for $name', async ({ detail, expectedReason }) => {
    const listed = meta();
    const resolvedDetail = typeof detail === 'function' ? detail(listed) : detail;
    const engine = fakeEngine([listed], { [listed.id]: messages() }, {}, { [listed.id]: resolvedDetail });

    const result = await runConversationCaptureSweep(deps(engine, scriptedLlm([]).llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expectCompletePreviewResult(result);
    expect(result).toMatchObject({ scanned: 1, settled: 1, evaluated: 0, deferred: 1, errors: 1, proposals: [] });
    expect(result.detail).toContain(`conversation-1: malformed conversation detail: ${expectedReason}`);
    expect(engine.nodeReads).toEqual([]);
    expect(engine.createCalls).toEqual([]);
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });

  it('returns a complete error result when an unexpected internal failure escapes normal guards', async () => {
    const engine = fakeEngine([], {});
    const throwingConfig = config();
    Object.defineProperty(throwingConfig, 'conversationCaptureSettleHours', {
      get() { throw new Error('unexpected config getter'); },
    });

    const result = await runConversationCaptureSweep({
      engine: engine.engine,
      llm: scriptedLlm([]).llm,
      config: throwingConfig,
      queue: new CurationQueue(),
    }, { dryRun: false, trigger: 'scheduled', now: NOW });

    expectCompletePreviewResult(result);
    expect(result).toMatchObject({ scanned: 0, settled: 0, evaluated: 0, deferred: 0, errors: 1, proposals: [] });
    expect(result.detail).toContain('unexpected conversation capture failure: unexpected config getter');
    expect(engine.listCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });
});

/** A capture call's provider rejection as the fail-closed adapters throw it (#254): no provider
 *  text, only the diagnostics' scalar status and upstream name. */
function failClosedRejection(status: number): StructuredCallFailure {
  const failure = new StructuredCallFailure('structured call failed (reason=provider_transport_failed)',
    undefined, 'provider_transport_failed');
  failure.diagnostics = { version: 1, adapterAttempts: 1, sdkAttempts: 1, responses: [],
    failure: { attempt: 0, kind: 'http', status, errorType: 'BadRequestError', upstream: 'Upstream' } };
  return failure;
}

describe('conversation capture rejection breaker (#254)', () => {
  it('stops the pass after three identical planner rejections and leaves the rest unledgered', async () => {
    const db = captureDb();
    const conversations = [1, 2, 3, 4, 5].map(index => meta({
      id: `conversation-${index}`, updated_at: `2026-08-26T0${index}:00:00.000Z`,
    }));
    const engine = fakeEngine(conversations,
      Object.fromEntries(conversations.map(conversation => [conversation.id, messages()])));
    const llm = scriptedLlm(conversations.map(() => failClosedRejection(400)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(llm.calls).toHaveLength(3);
    expect(result).toMatchObject({ evaluated: 3, errors: 3, deferred: 5 });
    expect(result.stopped).toBe('conversation capture (planner) stopped after 3 identical rejections from model '
      + 'capture-default (HTTP 400 from Upstream); the rest is retried next run');
    expect([...new Set(engine.conversationReads)]).toEqual(['conversation-1', 'conversation-2', 'conversation-3']);
    for (const conversation of conversations) expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
    expect(lastConversationCaptureAt(db)).toBeNull();
    expect(warn).toHaveBeenCalledWith(`[curator] ${result.stopped}`);
    warn.mockRestore();
  });

  it('keeps going through rate limits and failures that are not rejections', async () => {
    const conversations = [1, 2, 3, 4].map(index => meta({
      id: `conversation-${index}`, updated_at: `2026-08-26T0${index}:00:00.000Z`,
    }));
    const engine = fakeEngine(conversations,
      Object.fromEntries(conversations.map(conversation => [conversation.id, messages()])));
    const llm = scriptedLlm([failClosedRejection(429), failClosedRejection(429),
      new StructuredCallFailure('structured call failed (reason=provider_transport_failed)', undefined, 'provider_transport_failed'),
      failClosedRejection(429)]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm), {
      dryRun: true, trigger: 'scheduled', now: NOW,
    });

    expect(llm.calls).toHaveLength(4);
    expect(result.stopped).toBeUndefined();
    expect(result).toMatchObject({ evaluated: 4, errors: 4, deferred: 4 });
  });

  it('stops the pass on a budget refusal at once (#342)', async () => {
    const breakers = new CaptureRejectionBreakers(config());
    const refused = breakers.observe({ structuredCall: async () => {
      throw new StructuredCallFailure('structured call failed', undefined, 'provider_transport_failed', undefined,
        { cause: new BudgetExhaustedError('daily budget: $3.0000 spent of $3.00') });
    } }, 'planner');
    await expect(refused.structuredCall({} as StructuredCallRequest)).rejects.toBeInstanceOf(StructuredCallFailure);
    expect(breakers.stopped).toBe('conversation capture (planner) stopped: daily budget: $3.0000 spent of $3.00; the rest is retried next run');
  });

  it('gives each capture model call its own streak', async () => {
    const breakers = new CaptureRejectionBreakers(config({ conversationCaptureCoverageModel: 'coverage-model' }));
    const planner = breakers.observe({ structuredCall: async () => ({ output: {}, usage: ZERO_USAGE }) }, 'planner');
    const coverage = breakers.observe({ structuredCall: async () => { throw failClosedRejection(400); } }, 'coverage');
    const request = {} as StructuredCallRequest;
    for (let index = 0; index < 3; index += 1) {
      await planner.structuredCall(request);
      await expect(coverage.structuredCall(request)).rejects.toBeInstanceOf(StructuredCallFailure);
    }
    expect(breakers.stopped).toBe('conversation capture (coverage) stopped after 3 identical rejections from model '
      + 'coverage-model (HTTP 400 from Upstream); the rest is retried next run');
  });
});

describe('evaluateConversationCaptureCandidate routing and grouping seam', () => {
  const evaluationInput = (overrides: Record<string, unknown> = {}) => ({
    conversation: {
      id: 'conversation-1', title: 'Modular vehicle overview',
      updatedAt: '2026-08-26T06:00:00.000Z', linkedDocs: ['linked-1'],
    },
    inspection: inspectConversation(messages()),
    inputHash: 'input-hash-1',
    linkedNodeReads: [linkedRead('linked-1')],
    priorCaptures: [],
    ...overrides,
  });

  it('skips protected-only and defers linked-read-failure inputs without invoking the model', async () => {
    const llm = scriptedLlm([]);
    const protectedResult = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config() },
      evaluationInput({
        linkedNodeReads: [linkedRead('linked-1', { file_path: './Settings/Curator.md' })],
      }),
    );
    expect(protectedResult).toMatchObject({ status: 'skip', reasonCode: 'protected-only', modelEvaluated: false });

    const failedRead: ConversationCaptureLinkedNodeRead = {
      nodeId: 'linked-1', ok: false, error: 'read denied',
    };
    const failedResult = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config() },
      evaluationInput({ linkedNodeReads: [failedRead] }),
    );
    expect(failedResult).toMatchObject({ status: 'deferred', reasonCode: 'linked-read-failure', modelEvaluated: false });
    expect(llm.calls).toEqual([]);
  });

  it('protects the settings folder Engine reports, not a literal Settings/', async () => {
    const llm = scriptedLlm([]);
    const custom = config({ settingsDir: 'System/Config/' });
    const inside = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: custom },
      evaluationInput({ linkedNodeReads: [linkedRead('linked-1', { file_path: 'System/Config/Curator.md' })] }),
    );
    expect(inside).toMatchObject({ status: 'skip', reasonCode: 'protected-only', modelEvaluated: false });
    const outside = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: custom },
      evaluationInput({ linkedNodeReads: [linkedRead('linked-1', { file_path: 'Settings/Curator.md' })], allowModelCall: false }),
    );
    expect(outside).toMatchObject({ status: 'deferred', reasonCode: 'evaluation-cap' });
    expect(llm.calls).toEqual([]);
  });

  it('applies unreliable-inspection and assistant-floor gates for offline callers', async () => {
    const llm = scriptedLlm([]);
    const unreliable = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config() },
      evaluationInput({
        inspection: { ...inspectConversation(messages()), coverageReliable: false },
      }),
    );
    expect(unreliable).toMatchObject({ status: 'deferred', reasonCode: 'unreliable-inspection', modelEvaluated: false });

    const belowFloor = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config() },
      evaluationInput({ inspection: inspectConversation(messages('tiny')) }),
    );
    expect(belowFloor).toMatchObject({ status: 'skip', reasonCode: 'below-floor', modelEvaluated: false });
    expect(llm.calls).toEqual([]);
  });

  it('evaluates supplied linked snapshots without requiring a mutation version', async () => {
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      composed(),
    ]);
    const readWithoutVersion = {
      nodeId: 'linked-1', ok: true as const,
      node: {
        id: 'linked-1', title: 'Linked note', filePath: 'Notes/Linked.md',
        body: 'Routing context.', fields: {},
      },
    } satisfies ConversationCaptureLinkedNodeRead;
    const result = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config() },
      evaluationInput({ linkedNodeReads: [readWithoutVersion] }),
    );
    expect(result).toMatchObject({ status: 'capture', modelEvaluated: true });
  });

  it('omits protected links and accepts routes only to the remaining eligible linked nodes', async () => {
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      composed(),
    ]);
    const result = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config() },
      evaluationInput({
        conversation: {
          id: 'conversation-1', title: 'Modular vehicle overview',
          updatedAt: '2026-08-26T06:00:00.000Z', linkedDocs: ['linked-1', 'protected'],
        },
        linkedNodeReads: [
          linkedRead('protected', { file_path: '.schemas/note.md' }),
          linkedRead('linked-1'),
        ],
      }),
    );
    expect(result).toMatchObject({ status: 'capture', modelEvaluated: true });
    expect(result.proposals).toEqual([expect.objectContaining({ destinationNodeId: 'linked-1' })]);
    expect(llm.calls[0]?.user).toContain('"id":"linked-1"');
    expect(llm.calls[0]?.user).not.toContain('protected');

    const hostile = scriptedLlm([planCapture([rawArtifact({ destination_node_id: 'protected' })])]);
    const rejected = await evaluateConversationCaptureCandidate(
      { llm: hostile.llm, config: config() },
      evaluationInput({
        conversation: {
          id: 'conversation-1', title: 'Modular vehicle overview',
          updatedAt: '2026-08-26T06:00:00.000Z', linkedDocs: ['linked-1', 'protected'],
        },
        linkedNodeReads: [linkedRead('linked-1'), linkedRead('protected', { fields: { vault_engine_projection: true } })],
      }),
    );
    expect(rejected).toMatchObject({ status: 'deferred', reasonCode: 'model-error', modelEvaluated: true });
  });

  it('defers a conversation whose planner call was refused for budget, as budget rather than a model error (#342)', async () => {
    const llm = { structuredCall: async () => { throw new BudgetExhaustedError('daily budget: $3.0000 spent of $3.00'); } };
    const result = await evaluateConversationCaptureCandidate({ llm, config: config() }, evaluationInput());
    expect(result).toMatchObject({ status: 'deferred', reasonCode: 'budget', modelEvaluated: false,
      reason: 'planner: daily budget: $3.0000 spent of $3.00' });
  });

  it('groups same-destination artifacts in planner order with a host-owned wrapper', async () => {
    const conversationMessages = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Keep both insights.' }] },
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First durable insight. ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second durable insight. ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({ artifact_key: 'first', title: 'First insight', assistant_message_ids: ['assistant-1'], destination_node_id: 'linked-1' }),
        rawArtifact({ artifact_key: 'second', title: 'Second insight', assistant_message_ids: ['assistant-2'], destination_node_id: 'linked-1' }),
      ]),
      composed([
        { key: 'first', title: 'First insight', markdown: 'First body.' },
        { key: 'second', title: 'Second insight', markdown: 'Second body.' },
      ]),
    ]);

    const result = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config() },
      evaluationInput({ inspection: inspectConversation(conversationMessages), inputHash: 'grouped-hash' }),
    );

    expect(result).toMatchObject({ status: 'capture', plannedArtifactCount: 2, partiallyCovered: false });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      conversationId: 'conversation-1', destinationKind: 'appended',
      destinationTitle: 'Node linked-1', destinationNodeId: 'linked-1',
    });
    expect(result.proposals[0]?.body).toContain('## From chat — Modular vehicle overview');
    expect(result.proposals[0]?.body).toContain('### First insight\n\nFirst body.\n\n### Second insight\n\nSecond body.');
  });

  it('uses the no-evidence fast path without coverage calls and retains planner briefs', async () => {
    const conversationMessages = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Keep both durable lessons.' }] },
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First durable lesson. ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second durable lesson. ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({ artifact_key: 'first', title: 'First', brief: 'FIRST-PLANNER-BRIEF', assistant_message_ids: ['assistant-1'], destination_node_id: 'linked-1' }),
        rawArtifact({ artifact_key: 'second', title: 'Second', brief: 'SECOND-PLANNER-BRIEF', assistant_message_ids: ['assistant-2'], destination_node_id: 'linked-1' }),
      ]),
      composed([
        { key: 'first', title: 'First', markdown: 'First body.' },
        { key: 'second', title: 'Second', markdown: 'Second body.' },
      ]),
    ]);
    const usage = { setContext: vi.fn() } as unknown as UsageReporter;

    const result = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config(), usage, runRef: 'run-fast-path' },
      evaluationInput({ inspection: inspectConversation(conversationMessages) }),
    );

    expect(llm.calls.map((call) => call.toolName)).toEqual([
      'plan_conversation_capture', 'compose_conversation_capture',
    ]);
    expect(result.coverageAdjudications).toEqual([
      expect.objectContaining({ artifactKey: 'first', decision: 'uncovered' }),
      expect.objectContaining({ artifactKey: 'second', decision: 'uncovered' }),
    ]);
    expect(result).toMatchObject({
      coverageCalls: 0,
      uncoveredArtifacts: 2,
      partiallyCoveredArtifacts: 0,
      fullyCoveredArtifacts: 0,
    });
    expect(llm.calls[1]?.user).toContain('FIRST-PLANNER-BRIEF');
    expect(llm.calls[1]?.user).toContain('SECOND-PLANNER-BRIEF');
    expect(usage.setContext).not.toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'conversation-capture-coverage',
    }));
  });

  it('adjudicates in planner order and composes only mixed partial and uncovered artifacts', async () => {
    const conversationMessages = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Keep the durable lessons.' }] },
      {
        id: 'assistant-1', role: 'assistant', parts: [
          { type: 'text', text: `Fully covered lesson. ${'a'.repeat(300)} ${SOURCE_URL}` },
          receiptTool({ node_id: 'written-node', append_body: 'COVERED-RECEIPT-TEXT', dry_run: false }),
        ],
      },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Partial durable lesson. ${'b'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-3', role: 'assistant', parts: [{ type: 'text', text: `Uncovered durable lesson. ${'c'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({ artifact_key: 'full', title: 'Full', brief: 'FULL-BRIEF', assistant_message_ids: ['assistant-1'], destination_node_id: 'linked-1' }),
        rawArtifact({ artifact_key: 'partial', title: 'Partial', brief: 'PARTIAL-ORIGINAL-BRIEF', assistant_message_ids: ['assistant-2'], destination_node_id: 'linked-1' }),
        rawArtifact({ artifact_key: 'uncovered', title: 'Uncovered', brief: 'UNCOVERED-ORIGINAL-BRIEF', assistant_message_ids: ['assistant-3'], destination_node_id: 'linked-1' }),
      ]),
      coverage('full', { toolCallIds: ['write-current'] }),
      coverage('partial', { captureIds: ['capture-current'], missingBrief: 'PARTIAL-MISSING-BRIEF' }),
      coverage('uncovered'),
      composed([
        { key: 'partial', title: 'Partial', markdown: 'Partial missing body.' },
        { key: 'uncovered', title: 'Uncovered', markdown: 'Uncovered body.' },
      ]),
    ]);
    const usageSetContext = vi.fn();
    const usage = { setContext: usageSetContext } as unknown as UsageReporter;

    const result = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config(), usage, runRef: 'run-mixed' },
      evaluationInput({
        inspection: inspectConversation(conversationMessages),
        priorCaptures: [
          { captureId: 'capture-current', markdown: 'COVERED-CAPTURE-TEXT' },
          { captureId: 'capture-unrelated', markdown: 'UNRELATED-CAPTURE-TEXT' },
        ],
      }),
    );

    expect(llm.calls.map((call) => call.toolName)).toEqual([
      'plan_conversation_capture',
      'adjudicate_conversation_capture_coverage',
      'adjudicate_conversation_capture_coverage',
      'adjudicate_conversation_capture_coverage',
      'compose_conversation_capture',
    ]);
    expect(result).toMatchObject({
      status: 'capture', plannedArtifactCount: 3, partiallyCovered: true,
      coverageCalls: 3,
      uncoveredArtifacts: 1,
      partiallyCoveredArtifacts: 1,
      fullyCoveredArtifacts: 1,
      coverageAdjudications: [
        { artifactKey: 'full', decision: 'full' },
        { artifactKey: 'partial', decision: 'partial' },
        { artifactKey: 'uncovered', decision: 'uncovered' },
      ],
    });
    const composerUser = llm.calls.at(-1)?.user ?? '';
    expect(composerUser).not.toContain('FULL-BRIEF');
    expect(composerUser).toContain('PARTIAL-MISSING-BRIEF');
    expect(composerUser).not.toContain('PARTIAL-ORIGINAL-BRIEF');
    expect(composerUser).toContain('UNCOVERED-ORIGINAL-BRIEF');
    expect(composerUser).toContain('COVERED-CAPTURE-TEXT');
    expect(composerUser).toContain('UNRELATED-CAPTURE-TEXT');
    const composerRecords = composerUser.split('\n').slice(1)
      .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
    expect(composerRecords.filter((record) => record.kind === 'exclusion_evidence')).toEqual([{
      kind: 'exclusion_evidence',
      data: expect.objectContaining({
        priorCaptureMarkdown: ['COVERED-CAPTURE-TEXT', 'UNRELATED-CAPTURE-TEXT'],
      }),
    }]);
    const partialComposerArtifact = composerRecords
      .find((record) => record.kind === 'accepted_artifact' && record.data.artifactKey === 'partial')?.data;
    expect(partialComposerArtifact).toMatchObject({
      coverage: {
        state: 'partial', coveringCaptureIds: ['capture-current'],
        citedPriorCaptures: [{ captureId: 'capture-current', markdown: 'COVERED-CAPTURE-TEXT' }],
      },
    });
    expect(JSON.stringify(partialComposerArtifact)).not.toContain('UNRELATED-CAPTURE-TEXT');
    expect(result.artifacts.map((artifact) => artifact.artifactKey)).toEqual(['partial', 'uncovered']);
    expect(usage.setContext).toHaveBeenCalledWith(expect.objectContaining({
      project: 'conversation-capture', runRef: 'run-mixed', purpose: 'conversation-capture-coverage',
    }));
    expect(usageSetContext.mock.calls.filter(([context]) => (
      context?.purpose === 'conversation-capture-coverage'
    ))).toEqual([
      [{ project: 'conversation-capture', runRef: 'run-mixed', purpose: 'conversation-capture-coverage' }],
      [{ project: 'conversation-capture', runRef: 'run-mixed', purpose: 'conversation-capture-coverage' }],
      [{ project: 'conversation-capture', runRef: 'run-mixed', purpose: 'conversation-capture-coverage' }],
    ]);
  });

  it('counts no coverage call when mandatory evidence fails before structuredCall', async () => {
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
    ]);

    const result = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config() },
      evaluationInput({
        priorCaptures: [{ captureId: 'capture-oversized', markdown: 'x'.repeat(60_000) }],
      }),
    );

    expect(llm.calls.map((call) => call.toolName)).toEqual(['plan_conversation_capture']);
    expect(result).toMatchObject({
      status: 'deferred',
      reasonCode: 'model-error',
      coverageCalls: 0,
      uncoveredArtifacts: 0,
      partiallyCoveredArtifacts: 0,
      fullyCoveredArtifacts: 0,
      coverageAdjudications: [],
    });
  });

  it('retains committed decision counts when composition fails after coverage succeeds', async () => {
    const withReceipt = messages();
    (withReceipt[1] as { parts: unknown[] }).parts.push(receiptTool({
      node_id: 'written-node', append_body: 'Coverage evidence.', dry_run: false,
    }));
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      coverage('uncovered'),
      new StructuredCallFailure('RAW-COMPOSER-MARKER', undefined, 'malformed_json'),
    ]);

    const result = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config() },
      evaluationInput({ inspection: inspectConversation(withReceipt) }),
    );

    expect(result).toMatchObject({
      status: 'deferred',
      reasonCode: 'model-error',
      coverageCalls: 1,
      uncoveredArtifacts: 1,
      partiallyCoveredArtifacts: 0,
      fullyCoveredArtifacts: 0,
      coverageAdjudications: [],
    });
  });

  it('defers before the composer call when complete conversation exclusions cannot fit', async () => {
    const exclusionText = 'e'.repeat(51_500);
    const conversationMessages = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Capture both durable conclusions.' }] },
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First durable conclusion ${'a'.repeat(600)}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [
        { type: 'text', text: `Second durable conclusion ${'b'.repeat(600)}` },
        receiptTool({ node_id: 'linked-1', append_body: exclusionText, dry_run: false }),
      ] },
    ];
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({
          artifact_key: 'first', title: 'First durable conclusion', brief: 'a'.repeat(4_000),
          assistant_message_ids: ['assistant-1'], source_urls: [], destination_node_id: 'linked-1',
        }),
        rawArtifact({
          artifact_key: 'second', title: 'Second durable conclusion', brief: 'b'.repeat(4_000),
          assistant_message_ids: ['assistant-2'], source_urls: [], destination_node_id: 'linked-1',
        }),
      ]),
      coverage('uncovered'),
      coverage('uncovered'),
    ]);

    const result = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config() },
      evaluationInput({ inspection: inspectConversation(conversationMessages) }),
    );

    expect(llm.calls.map((call) => call.toolName)).toEqual([
      'plan_conversation_capture',
      'adjudicate_conversation_capture_coverage',
      'adjudicate_conversation_capture_coverage',
    ]);
    expect(result).toMatchObject({
      status: 'deferred', reasonCode: 'model-error', coverageCalls: 2,
      uncoveredArtifacts: 2, partiallyCoveredArtifacts: 0, fullyCoveredArtifacts: 0,
      coverageAdjudications: [],
    });
    expect(result.reason).toBe('conversation capture composer failed');
  });

  it.each([
    ['coverage-model', { conversationCaptureCoverageModel: 'coverage-model', conversationCaptureModel: 'capture-model', model: 'home-model' }],
    ['capture-model', { conversationCaptureCoverageModel: null, conversationCaptureModel: 'capture-model', model: 'home-model' }],
    ['home-model', { conversationCaptureCoverageModel: null, conversationCaptureModel: null, model: 'home-model' }],
  ] as const)('attributes an initiated coverage call to %s with the exact run context', async (expectedModel, modelConfig) => {
    const withReceipt = messages();
    (withReceipt[1] as { parts: unknown[] }).parts.push(receiptTool({
      node_id: 'written-node', append_body: 'Coverage evidence.', dry_run: false,
    }));
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      coverage('uncovered'),
      composed(),
    ]);
    const usage = { setContext: vi.fn() } as unknown as UsageReporter;

    const result = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config(modelConfig), usage, runRef: 'coverage-run-ref' },
      evaluationInput({ inspection: inspectConversation(withReceipt) }),
    );

    expect(llm.calls.find((call) => call.toolName === 'adjudicate_conversation_capture_coverage')?.model)
      .toBe(expectedModel);
    expect(usage.setContext).toHaveBeenCalledWith({
      project: 'conversation-capture',
      runRef: 'coverage-run-ref',
      purpose: 'conversation-capture-coverage',
    });
    expect(result.coverageCalls).toBe(1);
  });

  it('returns an all-full deterministic skip without composing', async () => {
    const withReceipt = messages();
    (withReceipt[1] as { parts: unknown[] }).parts.push(receiptTool({
      node_id: 'written-node', append_body: 'Already captured.', dry_run: false,
    }));
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      coverage('full', { toolCallIds: ['write-current'] }),
    ]);

    const result = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config() },
      evaluationInput({ inspection: inspectConversation(withReceipt) }),
    );

    expect(result).toMatchObject({
      status: 'skip', reasonCode: 'fully-covered', plannedArtifactCount: 1,
      artifacts: [], proposals: [],
      coverageAdjudications: [{ artifactKey: 'vehicle-overview', decision: 'full' }],
    });
    expect(llm.calls.map((call) => call.toolName)).toEqual([
      'plan_conversation_capture', 'adjudicate_conversation_capture_coverage',
    ]);
  });

  it.each([
    ['planner', [new StructuredCallFailure('RAW-PLANNER-MARKER', undefined, 'malformed_json')]],
    ['coverage', [planCapture([rawArtifact({ destination_node_id: 'linked-1' })]), new Error('RAW-COVERAGE-MARKER')]],
    ['composer', [planCapture([rawArtifact({ destination_node_id: 'linked-1' })]), coverage('uncovered'), new Error('RAW-COMPOSER-MARKER')]],
  ] as const)('projects %s failures to static metadata and publishes no partial semantics', async (_stage, outputs) => {
    const withReceipt = messages();
    (withReceipt[1] as { parts: unknown[] }).parts.push(receiptTool({
      node_id: 'written-node', append_body: 'Coverage evidence.', dry_run: false,
    }));
    const llm = scriptedLlm([...outputs]);

    const result = await evaluateConversationCaptureCandidate(
      { llm: llm.llm, config: config() },
      evaluationInput({ inspection: inspectConversation(withReceipt) }),
    );

    expect(result).toMatchObject({
      status: 'deferred', reasonCode: 'model-error', artifacts: [], proposals: [], coverageAdjudications: [],
    });
    expect(result.reason).toMatch(/conversation capture (planner|coverage|composer) failed/i);
    expect(result.reason).not.toMatch(/RAW-PLANNER-MARKER|RAW-COVERAGE-MARKER|RAW-COMPOSER-MARKER/);
  });
});

describe('preview proposals and state isolation', () => {
  it('previews one exact append to the eligible linked node without mutating state', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1', { title: 'Vehicle notes' }),
    });
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      composed(),
    ]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm, { db }), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ ran: true, dryRun: true, wouldAppend: 1, appended: 0, errors: 0 });
    expect(result.proposals).toEqual([expect.objectContaining({
      destinationKind: 'appended', destinationNodeId: 'linked-1', destinationTitle: 'Vehicle notes',
      body: expect.stringContaining('## From chat — Modular vehicle overview'),
    })]);
    expect(engine.appendCalls).toEqual([expect.objectContaining({
      nodeId: 'linked-1', text: result.proposals[0]?.body, expectedVersion: 4, dryRun: true,
    })]);
    expect(engine.createCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_ledger').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_state').get()).toEqual({ n: 0 });
  });

  it('previews one standalone note per unbound artifact and stamps exact final Markdown', async () => {
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: messages() });
    const llm = scriptedLlm([
      planCapture([rawArtifact()]),
      composed(),
    ]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ wouldCreate: 1, wouldAppend: 0, created: 0 });
    expect(engine.schemaEnsures).toEqual([]); // previews write nothing, including schemas
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0]!;
    expect(proposal).toMatchObject({
      captureId: 'cap-a1e57d88068713a8e66c53221cdf11c334c5497d0c0788db4dbf2559a6e5dc99',
      destinationKind: 'created', destinationTitle: 'Modular vehicle overview',
    });
    expect(proposal).not.toHaveProperty('destinationNodeId');
    expect(proposal.body).toBe([
      '<!-- ve:chat-curation:start id="cap-a1e57d88068713a8e66c53221cdf11c334c5497d0c0788db4dbf2559a6e5dc99" conversation="conversation-1" transcript-hash="566d76160aeefdb194322a1df9734a5c43c95b462f383963addf638da73f5cfd" -->',
      'A concise modular vehicle overview.',
      '',
      `**Sources:** <${SOURCE_URL}>`,
      '',
      '_Curated from “Modular vehicle overview” on 2026-08-26._',
      '<!-- ve:chat-curation:end id="cap-a1e57d88068713a8e66c53221cdf11c334c5497d0c0788db4dbf2559a6e5dc99" -->',
    ].join('\n'));
    expect(engine.createCalls).toEqual([expect.objectContaining({
      title: 'Modular vehicle overview', types: ['note'], body: proposal.body, dryRun: true,
    })]);
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });

  it('routes different artifacts to different linked nodes and previews each destination once', async () => {
    const conversationMessages = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Keep both.' }] },
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First. ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second. ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const conversation = meta({ linked_docs: ['linked-1', 'linked-2'] });
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages }, {
      'linked-1': node('linked-1'), 'linked-2': node('linked-2', { version: 8 }),
    });
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({ artifact_key: 'first', title: 'First insight', assistant_message_ids: ['assistant-1'], destination_node_id: 'linked-1' }),
        rawArtifact({ artifact_key: 'second', title: 'Second insight', assistant_message_ids: ['assistant-2'], destination_node_id: 'linked-2' }),
      ]),
      composed([
        { key: 'first', title: 'First insight', markdown: 'First body.' },
        { key: 'second', title: 'Second insight', markdown: 'Second body.' },
      ]),
    ]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ wouldAppend: 2, evaluated: 1 });
    expect(result.proposals.map((proposal) => proposal.destinationNodeId)).toEqual(['linked-1', 'linked-2']);
    expect(engine.appendCalls.map((call) => ({ nodeId: call.nodeId, expectedVersion: call.expectedVersion, dryRun: call.dryRun }))).toEqual([
      { nodeId: 'linked-1', expectedVersion: 4, dryRun: true },
      { nodeId: 'linked-2', expectedVersion: 8, dryRun: true },
    ]);
  });

  it('isolates the planner and passes only current-conversation coverage evidence to the adjudicator', async () => {
    const db = captureDb();
    const conversationMessages = messages();
    (conversationMessages[1] as { parts: unknown[] }).parts.push(receiptTool({ node_id: 'written-node', append_body: 'Already saved paragraph.', dry_run: false }));
    const priorMarkdown = 'Same conversation prior Markdown.';
    const priorInputHash = 'b'.repeat(64);
    const priorCaptureId = captureId({
      conversationId: 'conversation-1', inputHash: priorInputHash,
      destinationIdentity: 'Same Node', compositionHash: captureCompositionHash(priorMarkdown),
    });
    const priorBlock = renderCaptureBlock({
      captureId: priorCaptureId,
      conversationId: 'conversation-1',
      transcriptHash: priorInputHash,
      conversationTitle: 'Earlier conversation title',
      capturedOn: '2026-08-25',
      title: 'Same Node',
      markdown: priorMarkdown,
      sourceUrls: [],
      includeHeading: false,
    });
    upsertConversationCaptureArtifact(db, {
      capture_id: priorCaptureId, conversation_id: 'conversation-1', input_hash: priorInputHash,
      destination_kind: 'created', destination_node_id: 'same-node', content_hash: captureBlockHash(priorBlock),
      content_markdown: priorBlock, committed_at: '2026-08-25T00:00:00.000Z',
    });
    upsertConversationCaptureArtifact(db, {
      capture_id: 'other-capture', conversation_id: 'unrelated-conversation', input_hash: 'other-input',
      destination_kind: 'created', destination_node_id: 'other-node', content_hash: 'other-hash',
      content_markdown: 'Unrelated global duplicate text.', committed_at: '2026-08-25T00:00:00.000Z',
    });
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages }, {
      'same-node': node('same-node', { title: 'Same Node', body: priorBlock }),
    });
    const llm = scriptedLlm(fullyCoveredSequence({ toolCallIds: ['write-current'] }));

    const result = await runConversationCaptureSweep(deps(engine, llm.llm, { db }), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({
      fullyCovered: 1,
      coverageCalls: 1,
      uncoveredArtifacts: 0,
      partiallyCoveredArtifacts: 0,
      fullyCoveredArtifacts: 1,
    });
    const plannerUser = llm.calls[0]?.user ?? '';
    const coverageUser = llm.calls[1]?.user ?? '';
    expect(plannerUser).not.toContain('Already saved paragraph.');
    expect(plannerUser).not.toContain('Same conversation prior Markdown.');
    expect(coverageUser).toContain('Already saved paragraph.');
    expect(coverageUser).toContain('Same conversation prior Markdown.');
    expect(coverageUser).not.toContain('Unrelated global duplicate text.');
  });

  it('counts partial coverage while retaining the missing artifact', async () => {
    const conversation = meta();
    const conversationMessages = messages();
    (conversationMessages[1] as { parts: unknown[] }).parts.push(receiptTool({ node_id: 'written-node', append_body: 'Already saved portion.', dry_run: false }));
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages });
    const llm = scriptedLlm([
      planCapture([rawArtifact()]),
      coverage('partial', { toolCallIds: ['write-current'] }),
      composed(),
    ]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    expect(result).toMatchObject({
      partiallyCovered: 1,
      coverageCalls: 1,
      uncoveredArtifacts: 0,
      partiallyCoveredArtifacts: 1,
      fullyCoveredArtifacts: 0,
      wouldCreate: 1,
    });
  });

  it('defers over-cap and invalid-route model output without any Engine preview call', async () => {
    const overCapConversation = meta();
    const overCapEngine = fakeEngine([overCapConversation], { [overCapConversation.id]: messages() });
    const overCapLlm = scriptedLlm([planCapture([
      rawArtifact(), rawArtifact({ artifact_key: 'second', title: 'Second', assistant_message_ids: ['assistant-2'] }),
    ])]);
    const overCap = await runConversationCaptureSweep(deps(overCapEngine, overCapLlm.llm, {
      config: { conversationCaptureArtifactCap: 1 },
    }), { dryRun: false, trigger: 'scheduled', now: NOW });
    expect(overCap).toMatchObject({ evaluated: 1, deferred: 1, errors: 1, proposals: [] });
    expect(overCapEngine.createCalls).toEqual([]);

    const bound = meta({ linked_docs: ['linked-1'] });
    const invalidEngine = fakeEngine([bound], { [bound.id]: messages() }, { 'linked-1': node('linked-1') });
    const invalidLlm = scriptedLlm([planCapture([rawArtifact({ destination_node_id: 'unlinked' })])]);
    const invalid = await runConversationCaptureSweep(deps(invalidEngine, invalidLlm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    expect(invalid).toMatchObject({ evaluated: 1, deferred: 1, errors: 1, proposals: [] });
    expect(invalidEngine.appendCalls).toEqual([]);
  });

  it('defers a whole conversation when its grouped destination set exceeds the remaining write cap', async () => {
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages });
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({ artifact_key: 'first', title: 'First', assistant_message_ids: ['assistant-1'] }),
        rawArtifact({ artifact_key: 'second', title: 'Second', assistant_message_ids: ['assistant-2'] }),
      ]),
      composed([
        { key: 'first', title: 'First', markdown: 'First body.' },
        { key: 'second', title: 'Second', markdown: 'Second body.' },
      ]),
    ]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm, {
      config: { conversationCaptureWriteCap: 1 },
    }), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ evaluated: 1, deferred: 1, wouldCreate: 0, proposals: [] });
    expect(engine.createCalls).toHaveLength(2);
    expect(engine.createCalls.every((call) => call.dryRun === true)).toBe(true);
    expect(engine.appendCalls).toEqual([]);
  });
});

describe('conversation authority and preview recovery protocol', () => {
  it('passes one exact unbound authority snapshot to preview create dry-runs', async () => {
    const conversation = meta({ revision: 7 });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() });
    const result = await runConversationCaptureSweep(deps(
      engine,
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ wouldCreate: 1, deferred: 0, errors: 0 });
    expect(engine.conversationReads).toHaveLength(2);
    expect(engine.createCalls[0]).toMatchObject({
      dryRun: true,
      conversationAuthority: {
        conversationId: conversation.id,
        expectedRevision: 7,
        expectedLinkMode: 'unbound',
        expectedLinkedDocs: [],
      },
    });
  });

  it.each([
    ['transcript mutation', (conversation: ConversationMeta) => ({
      conversation: { ...conversation, revision: 2 },
      messages: messages(`Changed after planning ${'z'.repeat(560)} ${SOURCE_URL}`),
      linked_docs: [],
    })],
    ['new link on an unbound conversation', (conversation: ConversationMeta) => ({
      conversation: { ...conversation, revision: 2, linked_docs: ['new-link'] },
      messages: messages(), linked_docs: ['new-link'],
    })],
  ] as const)('defers after planning on a $name before any Engine dry-run', async (_label, changedDetail) => {
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'new-link': node('new-link'),
    }, {}, [conversation], {
      conversationDetail: (_id, readIndex) => readIndex === 1
        ? { conversation, messages: messages(), linked_docs: [] }
        : changedDetail(conversation),
    });
    const result = await runConversationCaptureSweep(deps(
      engine,
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ wouldCreate: 0, deferred: 1, errors: 0 });
    expect(result.detail).toContain('conversation changed after model');
    expect(engine.createCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });

  it('keeps the post-model authority boundary after planner, coverage, and composer finish', async () => {
    const conversationMessages = messages();
    (conversationMessages[1] as { parts: unknown[] }).parts.push(receiptTool({
      node_id: 'written-node', append_body: 'Eligible coverage evidence.', dry_run: false,
    }));
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages }, {
      'linked-1': node('linked-1'),
    }, {}, [conversation], {
      conversationDetail: (_id, readIndex) => ({
        conversation: readIndex === 1 ? conversation : { ...conversation, revision: 2 },
        messages: conversationMessages,
        linked_docs: ['linked-1'],
      }),
    });
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      coverage('uncovered'),
      composed(),
    ]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(llm.calls.map((call) => call.toolName)).toEqual([
      'plan_conversation_capture',
      'adjudicate_conversation_capture_coverage',
      'compose_conversation_capture',
    ]);
    expect(result).toMatchObject({ wouldAppend: 0, deferred: 1, errors: 0 });
    expect(result.detail).toContain('conversation changed after model');
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });

  it.each([
    ['title', { title: 'Repurposed destination' }],
    ['file path', { file_path: 'Archive/Repurposed.md' }],
    ['body', { body: 'Rewritten while capture composition was running.' }],
    ['version', { version: 5 }],
    ['fields', { fields: { project_status: 'repurposed' } }],
  ] as const)('defers when a linked destination %s changes during model evaluation', async (_name, changedNode) => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1'),
    });
    const scripted = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      composed(),
    ]);
    const llm: LlmClient = {
      async structuredCall(request) {
        const response = await scripted.llm.structuredCall(request);
        if (request.toolName === 'compose_conversation_capture') {
          engine.nodeMap['linked-1'] = node('linked-1', changedNode);
        }
        return response;
      },
    };

    const result = await runConversationCaptureSweep(deps(engine, llm, { db }), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(scripted.calls.map((call) => call.toolName)).toEqual([
      'plan_conversation_capture',
      'compose_conversation_capture',
    ]);
    expect(result).toMatchObject({ wouldAppend: 0, appended: 0, deferred: 1, errors: 0 });
    expect(result.detail).toContain('linked destination changed after model');
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
  });

  it('defers with an error when a linked destination cannot be reread after model evaluation', async () => {
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1'),
    });
    const scripted = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      composed(),
    ]);
    const llm: LlmClient = {
      async structuredCall(request) {
        const response = await scripted.llm.structuredCall(request);
        if (request.toolName === 'compose_conversation_capture') {
          engine.nodeMap['linked-1'] = new Error('linked node unavailable');
        }
        return response;
      },
    };

    const result = await runConversationCaptureSweep(deps(engine, llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ wouldAppend: 0, appended: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain('linked destination reread failed after model');
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });

  it('does not treat linked-node field key order as a snapshot change', async () => {
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1', { fields: { project: 'vehicle', status: 'active' } }),
    });
    const scripted = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      composed(),
    ]);
    const llm: LlmClient = {
      async structuredCall(request) {
        const response = await scripted.llm.structuredCall(request);
        if (request.toolName === 'compose_conversation_capture') {
          engine.nodeMap['linked-1'] = node('linked-1', { fields: { status: 'active', project: 'vehicle' } });
        }
        return response;
      },
    };

    const result = await runConversationCaptureSweep(deps(engine, llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ wouldAppend: 1, appended: 0, deferred: 0, errors: 0 });
    expect(engine.appendCalls).toEqual([
      expect.objectContaining({ nodeId: 'linked-1', expectedVersion: 4, dryRun: true }),
    ]);
  });

  it('carries the verified linked-node version into staging so a later race fails CAS', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    let recoverySearches = 0;
    let engine!: FakeEngineHarness;
    engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1'),
    }, {}, [conversation], {
      conversationCaptureCandidates: () => {
        recoverySearches += 1;
        if (recoverySearches === 2) {
          engine.nodeMap['linked-1'] = node('linked-1', {
            body: 'Changed after post-model verification.',
            version: 5,
          });
        }
        return [];
      },
    });
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      composed(),
    ]);

    const result = await runConversationCaptureSweep(deps(engine, llm.llm, { db }), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ wouldAppend: 0, appended: 0, deferred: 1, errors: 1 });
    expect(engine.appendCalls).toEqual([
      expect.objectContaining({ nodeId: 'linked-1', expectedVersion: 4, dryRun: true }),
    ]);
    expect(engine.liveMutations).toEqual([]);
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
  });

  it('defers when the conversation is deleted after planning', async () => {
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {}, {}, [conversation], {
      conversationDetail: (_id, readIndex) => {
        if (readIndex > 1) throw new Error('conversation deleted');
        return { conversation, messages: messages(), linked_docs: [] };
      },
    });
    const result = await runConversationCaptureSweep(deps(
      engine,
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ wouldCreate: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain('conversation reread failed after model');
    expect(engine.createCalls).toEqual([]);
  });

  it('uses the same exact bound guard for dry-run and live append', async () => {
    const db = captureDb();
    const conversation = meta({ revision: 9, linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1'),
    });
    const result = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm([
        planCapture([rawArtifact({ destination_node_id: 'linked-1' })]), composed(),
      ]).llm,
      db,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ appended: 1, deferred: 0, errors: 0 });
    const expectedAuthority = {
      conversationId: conversation.id,
      expectedRevision: 9,
      expectedLinkMode: 'bound',
      expectedLinkedDocs: ['linked-1'],
    };
    expect(engine.appendCalls).toHaveLength(2);
    expect(engine.appendCalls.map((call) => call.conversationAuthority))
      .toEqual([expectedAuthority, expectedAuthority]);
    expect(engine.conversationReads.length).toBeGreaterThanOrEqual(4);
  });

  it('stops between writes when the authoritative conversation changes', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1', 'linked-2'] });
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages }, {
      'linked-1': node('linked-1'), 'linked-2': node('linked-2'),
    }, {}, [conversation], {
      conversationDetail: (_id, readIndex) => readIndex < 4
        ? { conversation, messages: conversationMessages, linked_docs: conversation.linked_docs }
        : {
          conversation: { ...conversation, revision: 2, linked_docs: ['linked-2'] },
          messages: conversationMessages, linked_docs: ['linked-2'],
        },
    });
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({ artifact_key: 'first', title: 'First', assistant_message_ids: ['assistant-1'], destination_node_id: 'linked-1' }),
        rawArtifact({ artifact_key: 'second', title: 'Second', assistant_message_ids: ['assistant-2'], destination_node_id: 'linked-2' }),
      ]),
      composed([
        { key: 'first', title: 'First', markdown: 'First body.' },
        { key: 'second', title: 'Second', markdown: 'Second body.' },
      ]),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ appended: 1, deferred: 1, errors: 0 });
    expect(engine.appendCalls.filter((call) => call.dryRun === false).map((call) => call.nodeId))
      .toEqual(['linked-1']);
    expect(result.detail).toContain('conversation changed before live write');
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
  });

  it('validates marker proof in preview and never trusts a stale artifact row', async () => {
    const db = captureDb();
    const conversation = meta();
    upsertConversationCaptureArtifact(db, {
      capture_id: `cap-${'a'.repeat(64)}`,
      conversation_id: conversation.id,
      input_hash: 'b'.repeat(64),
      destination_kind: 'created',
      destination_node_id: 'missing-marker',
      content_hash: 'c'.repeat(64),
      content_markdown: 'stale ledger content',
      committed_at: NOW.toISOString(),
    });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'missing-marker': node('missing-marker', { body: 'Marker deleted.' }),
    });

    const result = await runConversationCaptureSweep(deps(engine, scriptedLlm([]).llm, { db }), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ evaluated: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain('artifact ledger has no authoritative paired marker');
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 1 });
  });

  it('discovers and validates prior markers in preview even without a Curator DB', async () => {
    const conversation = meta();
    const proposalPreview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: messages() }),
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const proposal = proposalPreview.proposals[0]!;
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'existing-capture': node('existing-capture', {
        title: proposal.destinationTitle, body: proposal.body,
      }),
    });

    const result = await runConversationCaptureSweep(deps(
      engine,
      scriptedLlm(fullyCoveredSequence({ captureIds: [proposal.captureId] })).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ fullyCovered: 1, deferred: 0, errors: 0, evaluated: 1 });
    expect(engine.createCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });
});

describe('live mutation, persistence, and recovery protocol', () => {
  it('dry-runs then live-appends the exact block with one CAS version and records completion', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1', { title: 'Vehicle notes' }),
    });
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      composed(),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ ran: true, dryRun: false, appended: 1, wouldAppend: 0, created: 0, deferred: 0, errors: 0 });
    expect(result.proposals).toEqual([]);
    const block = String(engine.appendCalls[0]?.text);
    expect(engine.appendCalls).toEqual([
      expect.objectContaining({ nodeId: 'linked-1', text: block, expectedVersion: 4, dryRun: true }),
      expect.objectContaining({ nodeId: 'linked-1', text: block, expectedVersion: 4, dryRun: false }),
    ]);
    expect(engine.appendCalls.some((call) => 'setBody' in call || 'setFields' in call || 'set_body' in call || 'set_fields' in call)).toBe(false);

    const id = captureIdFromBlock(block);
    expect(getConversationCaptureArtifact(db, id)).toMatchObject({
      capture_id: id,
      conversation_id: conversation.id,
      destination_kind: 'appended',
      destination_node_id: 'linked-1',
      content_hash: captureBlockHash(block),
      content_markdown: block,
      committed_at: NOW.toISOString(),
    });
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({
      outcome: 'captured', artifact_count: 1, destination_count: 1,
    });
    expect(lastConversationCaptureAt(db)).toBe('2026-08-26T06:00:00.000Z');
  });

  it('fails closed on a stale live append without blindly retrying', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1'),
    }, {}, [conversation], {
      append: () => { throw new EngineError('STALE_NODE', 'version changed'); },
    });
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      composed(),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ appended: 0, deferred: 1, errors: 1 });
    expect(engine.appendCalls).toHaveLength(2);
    expect(engine.appendCalls.map((call) => call.dryRun)).toEqual([true, false]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 0 });
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
    expect(lastConversationCaptureAt(db)).toBeNull();
  });

  it.each(['during', 'after'] as const)(
    'withholds completion when unrelated content is added %s a confirmed append',
    async (injectionPoint) => {
      const db = captureDb();
      const original = meta({ updated_at: '2026-08-26T05:00:00.000Z', linked_docs: ['linked-1'] });
      const originalMessages = messages();
      const priorPreview = await runConversationCaptureSweep(deps(
        fakeEngine([original], { [original.id]: originalMessages }, { 'linked-1': node('linked-1') }),
        scriptedLlm([
          planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
          composed([{ markdown: 'Original captured explanation.' }]),
        ]).llm,
      ), { dryRun: false, trigger: 'scheduled', now: NOW });
      const prior = priorPreview.proposals[0]!;
      const linked = node('linked-1', { body: `Existing linked content.\n\n${prior.body}` });
      const corrected = meta({ updated_at: '2026-08-26T06:00:00.000Z', linked_docs: ['linked-1'] });
      const correctedMessages = messages(`Corrected durable explanation ${'z'.repeat(560)} ${SOURCE_URL}`);
      const engine = fakeEngine([corrected], { [corrected.id]: correctedMessages }, {
        'linked-1': linked,
      }, {}, [corrected], {
        append: () => {
          if (injectionPoint === 'during') {
            linked.body = `${String(linked.body)}\n\nConcurrent addition during append.`;
          }
          return { warnings: [] };
        },
      });
      const recorder = {
        record: vi.fn(() => {
          if (injectionPoint === 'after') {
            linked.body = `${String(linked.body)}\n\nConcurrent addition after append.`;
          }
        }),
      } as unknown as ActionRecorder;
      const llm = scriptedLlm([
        planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
        coverage('uncovered'),
        composed([{ markdown: 'Corrected captured explanation.' }]),
      ]);

      const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db, { recorder }), {
        dryRun: false, trigger: 'scheduled', now: NOW,
      });

      expect(result).toMatchObject({ appended: 1, created: 0, deferred: 1, errors: 1 });
      expect(result.detail).toContain('recovered capture changed before completion ledger');
      expect(engine.appendCalls.map((call) => call.dryRun)).toEqual([true, false]);
      expect(getConversationCaptureLedger(db, corrected.id)).toBeUndefined();
      expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 2 });
    },
  );

  it('tries deterministic standalone titles by dry-run and creates only the first conflict-free candidate', async () => {
    const db = captureDb();
    const conversation = meta({ title: 'Launch discussion' });
    const conflictTitles = new Set([
      'Modular vehicle overview',
      'Modular vehicle overview — Launch discussion',
    ]);
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {}, {}, [conversation], {
      createPreview: (args) => ({
        dry_run: true,
        would_create: {
          file_path: `Notes/${String(args.title)}.md`,
          ...(conflictTitles.has(String(args.title)) ? { conflict: 'title already exists' } : {}),
        },
        warnings: [],
      }),
    });
    const llm = scriptedLlm([planCapture([rawArtifact()]), composed()]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ created: 1, wouldCreate: 0, deferred: 0, errors: 0 });
    expect(engine.createCalls.map((call) => ({ title: call.title, dryRun: call.dryRun }))).toEqual([
      { title: 'Modular vehicle overview', dryRun: true },
      { title: 'Modular vehicle overview — Launch discussion', dryRun: true },
      { title: 'Modular vehicle overview (from chat 2026-08-26)', dryRun: true },
      { title: 'Modular vehicle overview (from chat 2026-08-26)', dryRun: false },
    ]);
    expect(engine.createCalls[3]).toEqual({ ...engine.createCalls[2], dryRun: false });
    expect(engine.schemaEnsures).toEqual(['note']);
    expect(engine.liveMutations).toHaveLength(1);
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({ outcome: 'captured' });
  });

  it('defers a live create without any preview when the note schema cannot be ensured', async () => {
    const db = captureDb();
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {}, {}, [conversation], {
      ensureNoteSchema: async () => { throw new EngineError('INTERNAL_ERROR', 'schema store offline'); },
    });
    const llm = scriptedLlm([planCapture([rawArtifact()]), composed()]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ created: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain(`${conversation.id}: note schema unavailable: `);
    expect(engine.schemaEnsures).toEqual(['note']);
    expect(engine.createCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['different', 'Notes/unreserved-live-path.md'],
  ] as const)('persists a confirmed create but withholds completion when its live file path is %s', async (_label, livePath) => {
    const db = captureDb();
    const conversation = meta();
    let engine: FakeEngineHarness;
    engine = fakeEngine([conversation], { [conversation.id]: messages() }, {}, {}, [conversation], {
      createPreview: () => ({
        dry_run: true,
        would_create: { file_path: 'Notes/reserved-preview-path.md' },
        warnings: [],
      }),
      createLive: (args) => {
        engine.nodeMap['created-path-result'] = node('created-path-result', {
          title: String(args.title),
          file_path: livePath ?? 'Notes/reserved-preview-path.md',
          body: String(args.body),
          version: 1,
        });
        return {
          node_id: 'created-path-result',
          ...(livePath === undefined ? {} : { file_path: livePath }),
          warnings: [],
        };
      },
    });
    const llm = scriptedLlm([planCapture([rawArtifact()]), composed()]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ created: 1, appended: 0, deferred: 1, errors: 1 });
    expect(engine.createCalls).toHaveLength(2);
    expect(engine.createCalls[1]).toEqual({ ...engine.createCalls[0], dryRun: false });
    const block = String(engine.createCalls[1]?.body);
    const artifact = getConversationCaptureArtifact(db, captureIdFromBlock(block));
    expect(artifact).toMatchObject({
      destination_kind: 'created', destination_node_id: 'created-path-result', content_markdown: block,
    });
    expect((await engine.engine.findNodesContainingConversationCapture(conversation.id)).map((item) => item.id))
      .toContain('created-path-result');
    expect(result.detail).toContain(livePath === undefined
      ? 'confirmed create returned no file path'
      : 'confirmed create file path differs from its dry-run reservation');
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
  });

  it('defers an unrelated collision after all deterministic titles without a live create', async () => {
    const db = captureDb();
    const conversation = meta({ title: 'Launch discussion' });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {}, {}, [conversation], {
      createPreview: (args) => ({
        dry_run: true,
        would_create: { file_path: `Notes/${String(args.title)}.md`, conflict: 'unrelated existing note' },
        warnings: [],
      }),
    });
    const llm = scriptedLlm([planCapture([rawArtifact()]), composed()]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ created: 0, deferred: 1, errors: 0 });
    expect(engine.createCalls).toHaveLength(3);
    expect(engine.createCalls.every((call) => call.dryRun === true)).toBe(true);
    expect(engine.liveMutations).toEqual([]);
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
  });

  it.each([false, true])('recovers a created-note marker before planning (artifact row exists: %s)', async (artifactExists) => {
    const conversation = meta();
    const previewEngine = fakeEngine([conversation], { [conversation.id]: messages() });
    const previewLlm = scriptedLlm([planCapture([rawArtifact()]), composed()]);
    const preview = await runConversationCaptureSweep(deps(previewEngine, previewLlm.llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    const proposal = preview.proposals[0]!;
    const db = captureDb();
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), []);
    if (artifactExists) {
      upsertConversationCaptureArtifact(db, {
        capture_id: proposal.captureId,
        conversation_id: conversation.id,
        input_hash: inputHash,
        destination_kind: 'created',
        destination_node_id: 'created-existing',
        content_hash: captureBlockHash(proposal.body),
        content_markdown: proposal.body,
        committed_at: NOW.toISOString(),
      });
    }
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'created-existing': node('created-existing', { title: proposal.destinationTitle, body: proposal.body }),
    });
    const llm = scriptedLlm(fullyCoveredSequence({ captureIds: [proposal.captureId] }));

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ fullyCovered: 1, created: 0, appended: 0, deferred: 0, errors: 0 });
    expect(engine.createCalls).toEqual([]);
    expect(engine.appendCalls).toEqual([]);
    expect(getConversationCaptureArtifact(db, proposal.captureId)).toMatchObject({
      destination_kind: 'created', destination_node_id: 'created-existing', content_markdown: proposal.body,
    });
    expect(llm.calls[1]?.user).toContain(proposal.captureId);
    expect(llm.calls[1]?.user).toContain('A concise modular vehicle overview.');
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({ outcome: 'fully-covered' });
  });

  it.each([
    ['before', (block: string) => `User-authored introduction.\n\n${block}`],
    ['after', (block: string) => `${block}\n\nUser-authored follow-up.`],
    ['before and after', (block: string) => `User-authored introduction.\n\n${block}\n\nUser-authored follow-up.`],
  ])('keeps a ledgered created capture authoritative with user text %s the intact block', async (_label, surround) => {
    const db = captureDb();
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: messages() });
    const first = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
      db,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(first).toMatchObject({ created: 1, deferred: 0, errors: 0 });
    const created = engine.nodeMap['created-1'];
    if (created === undefined || created instanceof Error) throw new Error('created capture node is unavailable');
    const captureBlock = String(created.body);
    const userEditedBody = surround(captureBlock);
    created.body = userEditedBody;
    const liveMutationCount = engine.liveMutations.length;
    const createCallCount = engine.createCalls.length;
    const appendCallCount = engine.appendCalls.length;
    const secondLlm = scriptedLlm([]);

    const second = await runConversationCaptureSweep(liveDeps(engine, secondLlm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(second).toMatchObject({
      unchanged: 1, evaluated: 0, created: 0, appended: 0, deferred: 0, errors: 0,
    });
    expect(secondLlm.calls).toEqual([]);
    expect(engine.liveMutations).toHaveLength(liveMutationCount);
    expect(engine.createCalls).toHaveLength(createCallCount);
    expect(engine.appendCalls).toHaveLength(appendCallCount);
    expect(created.body).toBe(userEditedBody);
    expect(getConversationCaptureArtifact(db, captureIdFromBlock(captureBlock))).toMatchObject({
      destination_kind: 'created',
      destination_node_id: 'created-1',
      content_hash: captureBlockHash(captureBlock),
      content_markdown: captureBlock,
    });
  });

  it('does not infer created-note ownership from an unledgered block with surrounding user text', async () => {
    const conversation = meta();
    const preview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: messages() }),
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const proposal = preview.proposals[0]!;
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'unledgered-created': node('unledgered-created', {
        title: proposal.destinationTitle,
        body: `User-authored introduction.\n\n${proposal.body}\n\nUser-authored follow-up.`,
      }),
    });

    const result = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm([]).llm,
      captureDb(),
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ unchanged: 0, evaluated: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain('ineligible created-note destination');
    expect(engine.liveMutations).toEqual([]);
  });

  it.each([
    ['protected path', (created: Record<string, unknown>) => { created.file_path = 'Settings/Historical capture.md'; }],
    ['projection field', (created: Record<string, unknown>) => { created.fields = { vault_engine_projection: true }; }],
  ])('requires an exact whole note for the historical ledger exception on a %s', async (_label, protect) => {
    const db = captureDb();
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: messages() });
    const first = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
      db,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(first).toMatchObject({ created: 1, deferred: 0, errors: 0 });
    const created = engine.nodeMap['created-1'];
    if (created === undefined || created instanceof Error) throw new Error('created capture node is unavailable');
    created.body = `User-authored introduction.\n\n${String(created.body)}`;
    protect(created);
    const liveMutationCount = engine.liveMutations.length;

    const second = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm([]).llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(second).toMatchObject({ unchanged: 0, evaluated: 0, deferred: 1, errors: 1 });
    expect(second.detail).toContain('ineligible created-note destination');
    expect(engine.liveMutations).toHaveLength(liveMutationCount);
  });

  it('recovers an exact persisted created note after its path becomes protected', async () => {
    const conversation = meta();
    const preview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: messages() }),
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const proposal = preview.proposals[0]!;
    const db = captureDb();
    upsertConversationCaptureArtifact(db, {
      capture_id: proposal.captureId,
      conversation_id: conversation.id,
      input_hash: conversationCaptureFingerprint(inspectConversation(messages()), []),
      destination_kind: 'created',
      destination_node_id: 'created-now-protected',
      content_hash: captureBlockHash(proposal.body),
      content_markdown: proposal.body,
      committed_at: NOW.toISOString(),
    });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'created-now-protected': node('created-now-protected', {
        title: proposal.destinationTitle,
        file_path: 'Settings/Formerly eligible.md',
        body: proposal.body,
      }),
    });
    const llm = scriptedLlm(fullyCoveredSequence({ captureIds: [proposal.captureId] }));

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ fullyCovered: 1, created: 0, appended: 0, deferred: 0, errors: 0 });
    expect(engine.liveMutations).toEqual([]);
    expect(getConversationCaptureArtifact(db, proposal.captureId)).toMatchObject({
      destination_kind: 'created', destination_node_id: 'created-now-protected',
    });
  });

  it('treats FTS as candidates only and fails closed on a malformed paired marker', async () => {
    const conversation = meta();
    const malformed = node('malformed', {
      body: '<!-- ve:chat-curation:start id="cap-bad" conversation="conversation-1" transcript-hash="h" -->\nno end',
    });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      malformed,
    });

    const result = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm([]).llm, captureDb()), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ evaluated: 0, deferred: 1, errors: 1, created: 0, appended: 0 });
    expect(result.detail).toContain('capture start without end');
    expect(engine.liveMutations).toEqual([]);
  });

  it('fails closed when one capture ID appears in more than one recovery candidate', async () => {
    const conversation = meta();
    const previewEngine = fakeEngine([conversation], { [conversation.id]: messages() });
    const preview = await runConversationCaptureSweep(deps(
      previewEngine,
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const proposal = preview.proposals[0]!;
    const block = proposal.body;
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'duplicate-a': node('duplicate-a', { title: proposal.destinationTitle, body: block }),
      'duplicate-b': node('duplicate-b', { title: proposal.destinationTitle, body: block }),
    });

    const result = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm([]).llm, captureDb()), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ evaluated: 0, deferred: 1, errors: 1, created: 0, appended: 0 });
    expect(result.detail).toContain('ambiguous recovery');
    expect(engine.liveMutations).toEqual([]);
  });

  it('does not treat an FTS candidate as proof when its paired marker belongs to another conversation', async () => {
    const db = captureDb();
    const conversation = meta();
    const unrelatedBlock = renderCaptureBlock({
      captureId: `cap-${'a'.repeat(64)}`,
      conversationId: 'another-conversation',
      transcriptHash: 'b'.repeat(64),
      conversationTitle: 'Another chat',
      capturedOn: '2026-08-25',
      title: 'Unrelated',
      markdown: 'Unrelated captured content.',
      sourceUrls: [],
      includeHeading: false,
    });
    const unrelatedNode = node('fts-false-positive', { body: unrelatedBlock });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {}, {}, [conversation], {
      conversationCaptureCandidates: () => [unrelatedNode],
    });

    const result = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm([planSkip()]).llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ evaluated: 1, notValuable: 1, deferred: 0, errors: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 0 });
  });

  it.each([
    ['deletes its marker', (value: Record<string, unknown>) => { value.body = 'Marker deleted during planning.'; }],
    ['changes its title', (value: Record<string, unknown>) => { value.title = 'Changed recovered title'; }],
    ['changes its type', (value: Record<string, unknown>) => { value.types = ['project']; }],
  ])('defers before staging when a recovered created note %s during model calls', async (_label, mutateRecovered) => {
    const db = captureDb();
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `Recovered ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Missing ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const conversation = meta();
    const preview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: conversationMessages }),
      scriptedLlm([
        planCapture([rawArtifact({
          artifact_key: 'recovered', title: 'Recovered note', assistant_message_ids: ['assistant-1'],
        })]),
        composed([{ key: 'recovered', title: 'Recovered note', markdown: 'Recovered body.' }]),
      ]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const recoveredProposal = preview.proposals[0]!;
    const recoveredNode = node('recovered-node', {
      title: recoveredProposal.destinationTitle,
      body: recoveredProposal.body,
    });
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages }, {
      'recovered-node': recoveredNode,
    });
    const outputs = [
      planCapture([rawArtifact({
        artifact_key: 'missing', title: 'Missing note', assistant_message_ids: ['assistant-2'],
      })]),
      coverage('uncovered'),
      composed([{ key: 'missing', title: 'Missing note', markdown: 'Missing body.' }]),
    ];
    let call = 0;
    const llm: LlmClient = {
      async structuredCall() {
        if (call === 0) mutateRecovered(recoveredNode);
        const output = outputs[call];
        call += 1;
        if (output === undefined) throw new Error('unexpected model call');
        return { output, usage: ZERO_USAGE };
      },
    };

    const result = await runConversationCaptureSweep(liveDeps(engine, llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ created: 0, appended: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain('recovered capture changed before mutation');
    expect(engine.createCalls).toEqual([]);
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
    expect(db.prepare('SELECT capture_id FROM conversation_capture_artifacts').all()).toEqual([
      { capture_id: recoveredProposal.captureId },
    ]);
  });

  it('merges a capture that appears during model calls and revalidates its later change before live', async () => {
    const db = captureDb();
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `Concurrent ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Missing ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const conversation = meta();
    const priorPreview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: conversationMessages }),
      scriptedLlm([
        planCapture([rawArtifact({
          artifact_key: 'concurrent', title: 'Concurrent capture', assistant_message_ids: ['assistant-1'],
        })]),
        composed([{ key: 'concurrent', title: 'Concurrent capture', markdown: 'Concurrent recovered body.' }]),
      ]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const concurrentProposal = priorPreview.proposals[0]!;
    const concurrentNode = node('concurrent-recovered', {
      title: concurrentProposal.destinationTitle,
      body: concurrentProposal.body,
    });
    let changedAfterRecovery = false;
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages }, {}, {}, [conversation], {
      createPreview: (args) => {
        if (!changedAfterRecovery) {
          changedAfterRecovery = true;
          concurrentNode.body = 'Concurrent marker changed after post-model recovery.';
        }
        return { dry_run: true, would_create: { file_path: `Notes/${String(args.title)}.md` }, warnings: [] };
      },
    });
    const outputs = [
      planCapture([rawArtifact({
        artifact_key: 'missing', title: 'Missing capture', assistant_message_ids: ['assistant-2'],
      })]),
      composed([{ key: 'missing', title: 'Missing capture', markdown: 'Missing captured body.' }]),
    ];
    let call = 0;
    const llm: LlmClient = {
      async structuredCall() {
        if (call === 0) engine.nodeMap['concurrent-recovered'] = concurrentNode;
        const output = outputs[call];
        call += 1;
        if (output === undefined) throw new Error('unexpected model call');
        return { output, usage: ZERO_USAGE };
      },
    };

    const result = await runConversationCaptureSweep(liveDeps(engine, llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ created: 0, appended: 0, deferred: 1, errors: 1 });
    expect(engine.createCalls).toHaveLength(1);
    expect(engine.createCalls[0]?.dryRun).toBe(true);
    expect(engine.liveMutations).toEqual([]);
    expect(result.detail).toContain('recovered capture changed before live write');
    expect(getConversationCaptureArtifact(db, concurrentProposal.captureId)).toMatchObject({
      destination_node_id: 'concurrent-recovered', content_markdown: concurrentProposal.body,
    });
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
  });

  it('revalidates every recovered capture before a model skip can write the ledger', async () => {
    const db = captureDb();
    const conversation = meta();
    const preview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: messages() }),
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const proposal = preview.proposals[0]!;
    const recoveredNode = node('recovered-skip', { title: proposal.destinationTitle, body: proposal.body });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'recovered-skip': recoveredNode,
    });
    const llm: LlmClient = {
      async structuredCall(request) {
        if (request.toolName === 'plan_conversation_capture') {
          recoveredNode.body = 'Marker removed during skip planning.';
          return { output: planCapture([rawArtifact()]), usage: ZERO_USAGE };
        }
        if (request.toolName === 'adjudicate_conversation_capture_coverage') {
          return { output: coverage('full', { captureIds: [proposal.captureId] }), usage: ZERO_USAGE };
        }
        throw new Error(`unexpected ${request.toolName}`);
      },
    };

    const result = await runConversationCaptureSweep(liveDeps(engine, llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ fullyCovered: 0, created: 0, appended: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain('recovered capture changed before skip ledger');
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
    expect(engine.liveMutations).toEqual([]);
  });

  it('revalidates recovered captures after staged dry-runs and before the first live write', async () => {
    const db = captureDb();
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `Recovered ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Missing ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const conversation = meta();
    const preview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: conversationMessages }),
      scriptedLlm([
        planCapture([rawArtifact({ artifact_key: 'recovered', title: 'Recovered', assistant_message_ids: ['assistant-1'] })]),
        composed([{ key: 'recovered', title: 'Recovered', markdown: 'Recovered body.' }]),
      ]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const proposal = preview.proposals[0]!;
    const recoveredNode = node('recovered-before-live', { title: proposal.destinationTitle, body: proposal.body });
    let changed = false;
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages }, {
      'recovered-before-live': recoveredNode,
    }, {}, [conversation], {
      createPreview: (args) => {
        if (!changed) {
          changed = true;
          recoveredNode.body = 'Marker removed after dry-run.';
        }
        return { dry_run: true, would_create: { file_path: `Notes/${String(args.title)}.md` }, warnings: [] };
      },
    });
    const llm = scriptedLlm([
      planCapture([rawArtifact({ artifact_key: 'missing', title: 'Missing', assistant_message_ids: ['assistant-2'] })]),
      coverage('uncovered'),
      composed([{ key: 'missing', title: 'Missing', markdown: 'Missing body.' }]),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ created: 0, appended: 0, deferred: 1, errors: 1 });
    expect(engine.createCalls).toHaveLength(1);
    expect(engine.createCalls[0]?.dryRun).toBe(true);
    expect(engine.liveMutations).toEqual([]);
    expect(result.detail).toContain('recovered capture changed before live write');
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
  });

  it('revalidates recovered captures after live writes and before completion ledger persistence', async () => {
    const db = captureDb();
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `Recovered ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Missing ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const conversation = meta();
    const preview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: conversationMessages }),
      scriptedLlm([
        planCapture([rawArtifact({ artifact_key: 'recovered', title: 'Recovered', assistant_message_ids: ['assistant-1'] })]),
        composed([{ key: 'recovered', title: 'Recovered', markdown: 'Recovered body.' }]),
      ]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const proposal = preview.proposals[0]!;
    const recoveredNode = node('recovered-before-ledger', { title: proposal.destinationTitle, body: proposal.body });
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages }, {
      'recovered-before-ledger': recoveredNode,
    }, {}, [conversation], {
      createLive: (args) => {
        recoveredNode.types = ['project'];
        return { node_id: 'created-missing', file_path: `Notes/${String(args.title)}.md`, warnings: [] };
      },
    });
    const llm = scriptedLlm([
      planCapture([rawArtifact({ artifact_key: 'missing', title: 'Missing', assistant_message_ids: ['assistant-2'] })]),
      coverage('uncovered'),
      composed([{ key: 'missing', title: 'Missing', markdown: 'Missing body.' }]),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ created: 1, appended: 0, deferred: 1, errors: 1 });
    expect(engine.liveMutations).toHaveLength(1);
    expect(result.detail).toContain('recovered capture changed before completion ledger');
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 2 });
  });

  it('rejects normalized duplicate titles before reserving any create path', async () => {
    const db = captureDb();
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages });
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({ artifact_key: 'first', title: 'Shared note', assistant_message_ids: ['assistant-1'] }),
        rawArtifact({ artifact_key: 'second', title: 'Shared note', assistant_message_ids: ['assistant-2'] }),
      ]),
      composed([
        { key: 'first', title: 'Shared note', markdown: 'First distinct body.' },
        { key: 'second', title: 'Shared note', markdown: 'Second distinct body.' },
      ]),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ created: 0, appended: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain('conversation capture planner failed');
    expect(engine.createCalls).toEqual([]);
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
  });

  it('defers before live writes when distinct titles exhaust one sanitized path reservation', async () => {
    const db = captureDb();
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages }, {}, {}, [conversation], {
      createPreview: () => ({
        dry_run: true,
        would_create: { file_path: 'Notes/sanitized-collision.md' },
        warnings: [],
      }),
    });
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({ artifact_key: 'first', title: 'Slash / title', assistant_message_ids: ['assistant-1'] }),
        rawArtifact({ artifact_key: 'second', title: 'Colon : title', assistant_message_ids: ['assistant-2'] }),
      ]),
      composed([
        { key: 'first', title: 'Slash / title', markdown: 'First body.' },
        { key: 'second', title: 'Colon : title', markdown: 'Second body.' },
      ]),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ created: 0, appended: 0, deferred: 1, errors: 0 });
    expect(result.detail).toContain('all deterministic create paths conflict');
    expect(engine.createCalls.length).toBeGreaterThan(1);
    expect(engine.createCalls.every((call) => call.dryRun === true)).toBe(true);
    expect(engine.liveMutations).toEqual([]);
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 0 });
  });

  it('fails closed when a paired marker disagrees with its operational artifact identity', async () => {
    const conversation = meta();
    const previewEngine = fakeEngine([conversation], { [conversation.id]: messages() });
    const preview = await runConversationCaptureSweep(deps(
      previewEngine,
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const proposal = preview.proposals[0]!;
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), []);
    const db = captureDb();
    upsertConversationCaptureArtifact(db, {
      capture_id: proposal.captureId,
      conversation_id: conversation.id,
      input_hash: inputHash,
      destination_kind: 'created',
      destination_node_id: 'mismatched-existing',
      content_hash: 'not-the-marker-hash',
      content_markdown: proposal.body,
      committed_at: NOW.toISOString(),
    });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'mismatched-existing': node('mismatched-existing', { title: proposal.destinationTitle, body: proposal.body }),
    });

    const result = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm([]).llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ evaluated: 0, deferred: 1, errors: 1, created: 0, appended: 0 });
    expect(result.detail).toContain('marker and artifact ledger mismatch');
    expect(engine.liveMutations).toEqual([]);
  });

  it('keeps a confirmed append successful when artifact persistence fails, then recovers it without another write', async () => {
    const db = captureDb();
    db.exec(`
      CREATE TRIGGER fail_capture_artifact_insert
      BEFORE INSERT ON conversation_capture_artifacts
      BEGIN SELECT RAISE(FAIL, 'forced artifact insert failure'); END;
    `);
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1'),
    });
    const recorder = { record: vi.fn() } as unknown as ActionRecorder;
    const firstLlm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      composed(),
    ]);

    const first = await runConversationCaptureSweep(liveDeps(engine, firstLlm.llm, db, { recorder }), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(first).toMatchObject({ appended: 1, deferred: 1, errors: 1 });
    const block = String(engine.appendCalls[1]?.text);
    const id = captureIdFromBlock(block);
    expect(getConversationCaptureArtifact(db, id)).toBeUndefined();
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
    expect(recorder.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'conversation-capture-appended', nodeId: 'linked-1',
    }));

    db.exec('DROP TRIGGER fail_capture_artifact_insert');
    engine.appendCalls.splice(0);
    engine.liveMutations.splice(0);
    const retryLlm = scriptedLlm(fullyCoveredSequence({ captureIds: [id] }, { destination_node_id: 'linked-1' }));
    const retry = await runConversationCaptureSweep(liveDeps(engine, retryLlm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(retry).toMatchObject({ fullyCovered: 1, appended: 0, deferred: 0, errors: 0 });
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
    expect(getConversationCaptureArtifact(db, id)).toMatchObject({
      destination_kind: 'appended', destination_node_id: 'linked-1', content_markdown: block,
    });
    expect(retryLlm.calls[0]?.user).toContain(id);
    expect(retryLlm.calls[0]?.user).toContain('A concise modular vehicle overview.');
  });

  it.each([
    ['unchanged at its exact confirmed body', false],
    ['concurrently altered after confirmation', true],
  ])('tracks a first append with failed persistence when it is %s before the second write', async (_label, alterFirst) => {
    const db = captureDb();
    db.exec(`
      CREATE TRIGGER fail_first_destination_artifact_insert
      BEFORE INSERT ON conversation_capture_artifacts
      WHEN NEW.destination_node_id = 'linked-1'
      BEGIN SELECT RAISE(FAIL, 'forced first artifact insert failure'); END;
    `);
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const conversation = meta({ linked_docs: ['linked-1', 'linked-2'] });
    const linkedOne = node('linked-1');
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages }, {
      'linked-1': linkedOne,
      'linked-2': node('linked-2'),
    });
    const recorder = {
      record: vi.fn((event: { nodeId?: string }) => {
        if (alterFirst && event.nodeId === 'linked-1') {
          linkedOne.body = `${String(linkedOne.body)}\n\nConcurrent unrelated addition.`;
        }
      }),
    } as unknown as ActionRecorder;
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({ artifact_key: 'first', title: 'First', assistant_message_ids: ['assistant-1'], destination_node_id: 'linked-1' }),
        rawArtifact({ artifact_key: 'second', title: 'Second', assistant_message_ids: ['assistant-2'], destination_node_id: 'linked-2' }),
      ]),
      composed([
        { key: 'first', title: 'First', markdown: 'First captured body.' },
        { key: 'second', title: 'Second', markdown: 'Second captured body.' },
      ]),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db, { recorder }), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({
      appended: alterFirst ? 1 : 2,
      created: 0,
      deferred: 1,
      errors: alterFirst ? 2 : 1,
    });
    expect(engine.appendCalls.filter((call) => call.dryRun === false).map((call) => call.nodeId))
      .toEqual(alterFirst ? ['linked-1'] : ['linked-1', 'linked-2']);
    expect(db.prepare('SELECT destination_node_id FROM conversation_capture_artifacts ORDER BY destination_node_id').all())
      .toEqual(alterFirst ? [] : [{ destination_node_id: 'linked-2' }]);
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
    expect(lastConversationCaptureAt(db)).toBeNull();
    expect(result.detail).toContain('confirmed append artifact persistence failed');
    if (alterFirst) expect(result.detail).toContain('recovered destination body changed');
  });

  it('recovers an append into an empty linked note as appended and keeps a transcript correction additive', async () => {
    const db = captureDb();
    db.exec(`
      CREATE TRIGGER fail_empty_note_capture_artifact_insert
      BEFORE INSERT ON conversation_capture_artifacts
      BEGIN SELECT RAISE(FAIL, 'forced empty-note artifact insert failure'); END;
    `);
    const sharedNodes = { 'linked-1': node('linked-1', { title: 'Empty linked note', body: '' }) };
    const original = meta({ updated_at: '2026-08-26T05:00:00.000Z', linked_docs: ['linked-1'] });
    const firstEngine = fakeEngine([original], { [original.id]: messages() }, sharedNodes);

    const first = await runConversationCaptureSweep(liveDeps(firstEngine, scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      composed(),
    ]).llm, db), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(first).toMatchObject({ appended: 1, deferred: 1, errors: 1 });
    const firstBlock = String(firstEngine.appendCalls[1]?.text);
    const firstCaptureId = captureIdFromBlock(firstBlock);
    expect(getConversationCaptureArtifact(db, firstCaptureId)).toBeUndefined();

    db.exec('DROP TRIGGER fail_empty_note_capture_artifact_insert');
    const recoveryEngine = fakeEngine([original], { [original.id]: messages() }, sharedNodes);
    const recovery = await runConversationCaptureSweep(liveDeps(
      recoveryEngine,
      scriptedLlm(fullyCoveredSequence({ captureIds: [firstCaptureId] }, { destination_node_id: 'linked-1' })).llm,
      db,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(recovery).toMatchObject({ fullyCovered: 1, appended: 0, deferred: 0, errors: 0 });
    expect(recoveryEngine.appendCalls).toEqual([]);
    expect(getConversationCaptureArtifact(db, firstCaptureId)).toMatchObject({
      destination_kind: 'appended',
      destination_node_id: 'linked-1',
      content_markdown: firstBlock,
    });

    const corrected = meta({ updated_at: '2026-08-26T06:00:00.000Z', linked_docs: ['linked-1'] });
    const correctedMessages = messages(`A corrected durable explanation ${'z'.repeat(560)} ${SOURCE_URL}`);
    const correctionEngine = fakeEngine([corrected], { [corrected.id]: correctedMessages }, sharedNodes);
    const correction = await runConversationCaptureSweep(liveDeps(correctionEngine, scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      coverage('uncovered'),
      composed([{ markdown: 'A corrected modular vehicle overview.' }]),
    ]).llm, db), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(correction).toMatchObject({ appended: 1, created: 0, deferred: 0, errors: 0 });
    expect(String(sharedNodes['linked-1'].body).match(/ve:chat-curation:start/g)).toHaveLength(2);
    expect(String(sharedNodes['linked-1'].body)).toContain(firstBlock);
    expect(String(sharedNodes['linked-1'].body)).toContain('A corrected modular vehicle overview.');
    expect(db.prepare('SELECT destination_kind, destination_node_id FROM conversation_capture_artifacts ORDER BY committed_at, capture_id').all()).toEqual([
      { destination_kind: 'appended', destination_node_id: 'linked-1' },
      { destination_kind: 'appended', destination_node_id: 'linked-1' },
    ]);
  });

  it('fails closed when a linked-node capture marker is copied to the wrong linked node', async () => {
    const conversation = meta({ linked_docs: ['linked-1', 'linked-2'] });
    const previewEngine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1'),
      'linked-2': node('linked-2'),
    });
    const preview = await runConversationCaptureSweep(deps(
      previewEngine,
      scriptedLlm([
        planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
        composed(),
      ]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const copiedBlock = preview.proposals[0]!.body;
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1'),
      'linked-2': node('linked-2', { body: copiedBlock }),
    });

    const result = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm([]).llm,
      captureDb(),
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ evaluated: 0, appended: 0, created: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain('destination identity mismatch');
    expect(engine.appendCalls).toEqual([]);
    expect(engine.createCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });

  it('rejects a copied proposal marker in a created note with the wrong title', async () => {
    const conversation = meta();
    const firstPreview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: messages() }),
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const proposal = firstPreview.proposals[0]!;
    const wrongTitleNode = node('copied-created', {
      title: 'A different title',
      body: proposal.body,
    });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'copied-created': wrongTitleNode,
    });

    const result = await runConversationCaptureSweep(deps(
      engine,
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ wouldCreate: 0, wouldAppend: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain('destination identity mismatch');
    expect(engine.createCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
  });

  it('fails closed on a created-note recovery candidate with the wrong title', async () => {
    const conversation = meta();
    const preview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: messages() }),
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const proposal = preview.proposals[0]!;
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'wrong-title': node('wrong-title', { title: 'Wrong title', body: proposal.body }),
    });

    const result = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm([]).llm,
      captureDb(),
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ evaluated: 0, created: 0, appended: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain('destination identity mismatch');
    expect(engine.liveMutations).toEqual([]);
  });

  it('fails closed on a created-note recovery candidate with the wrong type', async () => {
    const conversation = meta();
    const preview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: messages() }),
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const proposal = preview.proposals[0]!;
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'wrong-type': node('wrong-type', { title: proposal.destinationTitle, types: ['project'], body: proposal.body }),
    });

    const result = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm([]).llm,
      captureDb(),
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ evaluated: 0, created: 0, appended: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain('ineligible created-note destination');
    expect(engine.liveMutations).toEqual([]);
  });

  it('rejects different stamped bodies sharing a capture ID before any Engine write call', async () => {
    const db = captureDb();
    const firstUrl = 'https://example.test/first';
    const secondUrl = 'https://example.test/second';
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First ${'a'.repeat(300)} ${firstUrl}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second ${'b'.repeat(300)} ${secondUrl}` }] },
    ];
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages });
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({ artifact_key: 'first', assistant_message_ids: ['assistant-1'], source_urls: [firstUrl] }),
        rawArtifact({ artifact_key: 'second', assistant_message_ids: ['assistant-2'], source_urls: [secondUrl] }),
      ]),
      composed([
        { key: 'first', title: 'Modular vehicle overview', markdown: 'Shared body.' },
        { key: 'second', title: 'Modular vehicle overview', markdown: 'Shared body.' },
      ]),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ created: 0, appended: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain('conversation capture planner failed');
    expect(engine.createCalls).toEqual([]);
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 0 });
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
  });

  it('rejects byte-identical duplicate destinations before mutation and does not overcount them', async () => {
    const db = captureDb();
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages });
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({ artifact_key: 'first', assistant_message_ids: ['assistant-1'] }),
        rawArtifact({ artifact_key: 'second', assistant_message_ids: ['assistant-2'] }),
      ]),
      composed([
        { key: 'first', title: 'Modular vehicle overview', markdown: 'Shared body.' },
        { key: 'second', title: 'Modular vehicle overview', markdown: 'Shared body.' },
      ]),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ created: 0, appended: 0, wouldCreate: 0, wouldAppend: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain('conversation capture planner failed');
    expect(engine.createCalls).toEqual([]);
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 0 });
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
  });

  it('binds a recovered fallback title before considering a newly free primary title', async () => {
    const db = captureDb();
    db.exec(`
      CREATE TRIGGER fail_fallback_capture_artifact_insert
      BEFORE INSERT ON conversation_capture_artifacts
      BEGIN SELECT RAISE(FAIL, 'forced fallback artifact insert failure'); END;
    `);
    const conversation = meta({ title: 'Launch discussion' });
    let primaryConflicts = true;
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {}, {}, [conversation], {
      createPreview: (args) => ({
        dry_run: true,
        would_create: {
          file_path: `Notes/${String(args.title)}.md`,
          ...(primaryConflicts && args.title === 'Modular vehicle overview'
            ? { conflict: 'primary occupied' }
            : {}),
        },
        warnings: [],
      }),
    });
    const outputs = (hasCoverageEvidence = false) => [
      planCapture([rawArtifact()]),
      ...(hasCoverageEvidence ? [coverage('uncovered')] : []),
      composed(),
    ];

    const first = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm(outputs()).llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(first).toMatchObject({ created: 1, deferred: 1, errors: 1 });
    const fallbackLive = engine.createCalls.find((call) => call.dryRun === false)!;
    expect(fallbackLive.title).toBe('Modular vehicle overview — Launch discussion');
    const fallbackCaptureId = captureIdFromBlock(String(fallbackLive.body));
    expect(getConversationCaptureArtifact(db, fallbackCaptureId)).toBeUndefined();
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();

    db.exec('DROP TRIGGER fail_fallback_capture_artifact_insert');
    primaryConflicts = false;
    engine.createCalls.splice(0);
    engine.liveMutations.splice(0);
    const retry = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm(outputs(true)).llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(retry).toMatchObject({ created: 0, appended: 0, deferred: 0, errors: 0 });
    expect(engine.createCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
    expect(getConversationCaptureArtifact(db, fallbackCaptureId)).toMatchObject({
      destination_kind: 'created',
      destination_node_id: 'created-1',
      content_markdown: fallbackLive.body,
    });
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({
      outcome: 'captured', artifact_count: 1, destination_count: 1,
    });
    expect(Object.values(engine.nodeMap).filter((value) => !(value instanceof Error))).toHaveLength(1);
  });

  it('finds a later recovered same-ID body conflict before an earlier missing destination mutates', async () => {
    const db = captureDb();
    const firstUrl = 'https://example.test/first';
    const secondUrl = 'https://example.test/second';
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First ${'a'.repeat(300)} ${firstUrl}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second ${'b'.repeat(300)} ${firstUrl} ${secondUrl}` }] },
    ];
    const conversation = meta();
    const recoveredPreview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: conversationMessages }),
      scriptedLlm([
        planCapture([rawArtifact({
          artifact_key: 'second', title: 'Second destination', assistant_message_ids: ['assistant-2'], source_urls: [firstUrl],
        })]),
        composed([{ key: 'second', title: 'Second destination', markdown: 'Stable second body.' }]),
      ]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const recoveredProposal = recoveredPreview.proposals[0]!;
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages }, {
      'recovered-second': node('recovered-second', {
        title: recoveredProposal.destinationTitle,
        body: recoveredProposal.body,
      }),
    });
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({
          artifact_key: 'first', title: 'First destination', assistant_message_ids: ['assistant-1'], source_urls: [firstUrl],
        }),
        rawArtifact({
          artifact_key: 'second', title: 'Second destination', assistant_message_ids: ['assistant-2'], source_urls: [secondUrl],
        }),
      ]),
      coverage('uncovered'),
      coverage('uncovered'),
      composed([
        { key: 'first', title: 'First destination', markdown: 'Missing first body.' },
        { key: 'second', title: 'Second destination', markdown: 'Stable second body.' },
      ]),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ created: 0, appended: 0, deferred: 1, errors: 1 });
    expect(result.detail).toContain('paired marker content mismatch');
    expect(engine.createCalls).toEqual([]);
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
    expect(db.prepare('SELECT capture_id, content_markdown FROM conversation_capture_artifacts').all()).toEqual([
      { capture_id: recoveredProposal.captureId, content_markdown: recoveredProposal.body },
    ]);
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
  });

  it('round-trips created recovery when user Markdown begins with a host-heading-shaped line', async () => {
    const conversation = meta();
    const markdown = '## From chat — User-authored section\n\nThis heading is part of the durable composition.';
    const preview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: messages() }),
      scriptedLlm([planCapture([rawArtifact()]), composed([{ markdown }])]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const proposal = preview.proposals[0]!;
    const db = captureDb();
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'created-heading': node('created-heading', { title: proposal.destinationTitle, body: proposal.body }),
    });

    const result = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm(fullyCoveredSequence({ captureIds: [proposal.captureId] })).llm,
      db,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ fullyCovered: 1, deferred: 0, errors: 0, created: 0, appended: 0 });
    expect(getConversationCaptureArtifact(db, proposal.captureId)).toMatchObject({
      destination_kind: 'created', content_markdown: proposal.body,
    });
  });

  it('round-trips created recovery when user Markdown ends in a sources-shaped line', async () => {
    const conversation = meta();
    const markdown = `Durable body.\n\n**Sources:** <${SOURCE_URL}>`;
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), []);
    const captureIdentity = captureId({
      conversationId: conversation.id,
      inputHash,
      destinationIdentity: 'Modular vehicle overview',
      compositionHash: captureCompositionHash(markdown),
    });
    const body = renderCaptureBlock({
      captureId: captureIdentity,
      conversationId: conversation.id,
      transcriptHash: inputHash,
      conversationTitle: conversation.title,
      capturedOn: '2026-08-26',
      title: 'Modular vehicle overview',
      markdown,
      sourceUrls: [],
      includeHeading: false,
    });
    expect(body.match(/\*\*Sources:\*\*/g)).toHaveLength(1);
    const db = captureDb();
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'created-sources': node('created-sources', { title: 'Modular vehicle overview', body }),
    });

    const result = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm(fullyCoveredSequence({ captureIds: [captureIdentity] })).llm,
      db,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ fullyCovered: 1, deferred: 0, errors: 0, created: 0, appended: 0 });
    expect(getConversationCaptureArtifact(db, captureIdentity)?.content_markdown).toBe(body);
  });

  it('round-trips canonical escaped heading, attribution, and source provenance for an append', async () => {
    const conversation = meta({ title: 'Research & <tradeoffs>', linked_docs: ['linked-1'] });
    const preview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: messages() }, { 'linked-1': node('linked-1') }),
      scriptedLlm([
        planCapture([rawArtifact({ title: 'R&D <guide>', destination_node_id: 'linked-1' })]),
        composed([{ title: 'R&D <guide>' }]),
      ]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const proposal = preview.proposals[0]!;
    expect(proposal.body).toContain('## From chat — R&amp;D &lt;guide&gt;');
    expect(proposal.body).toContain('_Curated from “Research &amp; &lt;tradeoffs&gt;”');
    const db = captureDb();
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1', { body: `Existing.\n\n${proposal.body}` }),
    });

    const result = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm(fullyCoveredSequence({ captureIds: [proposal.captureId] }, { destination_node_id: 'linked-1' })).llm,
      db,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ fullyCovered: 1, deferred: 0, errors: 0, created: 0, appended: 0 });
    expect(getConversationCaptureArtifact(db, proposal.captureId)).toMatchObject({
      destination_kind: 'appended', destination_node_id: 'linked-1', content_markdown: proposal.body,
    });
  });

  it.each([
    ['heading escaping', (block: string) => block.replace('R&amp;D &lt;guide&gt;', 'R&D &lt;guide&gt;')],
    ['non-HTTP source', (block: string) => block.replace('https://example.test/reference', 'ftp://example.test/reference')],
    ['uncanonical source', (block: string) => block.replace('https://example.test/reference', 'https://example.test:443/reference')],
    ['attribution escaping', (block: string) => block.replace('Research &amp; &lt;tradeoffs&gt;', 'Research & &lt;tradeoffs&gt;')],
  ])('rejects altered canonical %s provenance during recovery', async (_label, alter) => {
    const conversation = meta({ title: 'Research & <tradeoffs>', linked_docs: ['linked-1'] });
    const preview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: messages() }, { 'linked-1': node('linked-1') }),
      scriptedLlm([
        planCapture([rawArtifact({ title: 'R&D <guide>', destination_node_id: 'linked-1' })]),
        composed([{ title: 'R&D <guide>' }]),
      ]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const altered = alter(preview.proposals[0]!.body);
    const db = captureDb();
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1', { body: `Existing.\n\n${altered}` }),
    });

    const result = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm([]).llm,
      db,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ evaluated: 0, deferred: 1, errors: 1, created: 0, appended: 0 });
    expect(result.detail).toContain('canonical capture block');
    expect(engine.liveMutations).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 0 });
  });

  it('preserves the first destination across a partial failure and retries only the missing capture', async () => {
    const db = captureDb();
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const conversation = meta({ linked_docs: ['linked-1', 'linked-2'] });
    let failSecond = true;
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages }, {
      'linked-1': node('linked-1'), 'linked-2': node('linked-2'),
    }, {}, [conversation], {
      append: (args) => {
        if (args.nodeId === 'linked-2' && failSecond) {
          failSecond = false;
          throw new EngineError('WRITE_FAILED', 'second destination failed');
        }
        return { warnings: [] };
      },
    });
    const outputs = (hasCoverageEvidence = false) => [
      planCapture([
        rawArtifact({ artifact_key: 'first', title: 'First', assistant_message_ids: ['assistant-1'], destination_node_id: 'linked-1' }),
        rawArtifact({ artifact_key: 'second', title: 'Second', assistant_message_ids: ['assistant-2'], destination_node_id: 'linked-2' }),
      ]),
      ...(hasCoverageEvidence ? [coverage('uncovered'), coverage('uncovered')] : []),
      composed([
        { key: 'first', title: 'First', markdown: 'First body.' },
        { key: 'second', title: 'Second', markdown: 'Second body.' },
      ]),
    ];

    const first = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm(outputs()).llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    expect(first).toMatchObject({ appended: 1, deferred: 1, errors: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 1 });
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();

    engine.appendCalls.splice(0);
    engine.liveMutations.splice(0);
    const retry = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm(outputs(true)).llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(retry).toMatchObject({ appended: 1, deferred: 0, errors: 0 });
    expect(engine.appendCalls.map((call) => ({ nodeId: call.nodeId, dryRun: call.dryRun }))).toEqual([
      { nodeId: 'linked-2', dryRun: true },
      { nodeId: 'linked-2', dryRun: false },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 2 });
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({
      outcome: 'captured', artifact_count: 2, destination_count: 2,
    });
  });

  it('records transcript corrections as additive captures and never rewrites the linked node', async () => {
    const db = captureDb();
    const sharedNodes = { 'linked-1': node('linked-1') };
    const original = meta({ updated_at: '2026-08-26T05:00:00.000Z', linked_docs: ['linked-1'] });
    const firstEngine = fakeEngine([original], { [original.id]: messages() }, sharedNodes);
    const firstLlm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]), composed(),
    ]);
    const first = await runConversationCaptureSweep(liveDeps(firstEngine, firstLlm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    expect(first).toMatchObject({ appended: 1, errors: 0 });

    const corrected = meta({ updated_at: '2026-08-26T06:00:00.000Z', linked_docs: ['linked-1'] });
    const correctedMessages = messages(`A corrected durable explanation ${'z'.repeat(560)} ${SOURCE_URL}`);
    const secondEngine = fakeEngine([corrected], { [corrected.id]: correctedMessages }, sharedNodes);
    const secondLlm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      coverage('uncovered'),
      composed([{ markdown: 'A corrected modular vehicle overview.' }]),
    ]);
    const second = await runConversationCaptureSweep(liveDeps(secondEngine, secondLlm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(second).toMatchObject({ appended: 1, errors: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 2 });
    expect(String((sharedNodes['linked-1'] as Record<string, unknown>).body).match(/ve:chat-curation:start/g)).toHaveLength(2);
    expect(secondEngine.appendCalls.some((call) => 'set_body' in call || 'set_fields' in call)).toBe(false);
  });

  it('does not let journal failures negate a confirmed business write', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1'),
    });
    const recorder = {
      record: vi.fn(() => { throw new Error('journal unavailable'); }),
    } as unknown as ActionRecorder;
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]), composed(),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db, { recorder }), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ appended: 1, deferred: 0, errors: 0 });
    expect(recorder.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'conversation-capture-appended', nodeId: 'linked-1',
      detail: expect.stringContaining('conversation-1'),
    }));
    expect(getConversationCaptureLedger(db, conversation.id)).toBeDefined();
  });

  it('ledgers deterministic skips and advances the clean live watermark', async () => {
    const db = captureDb();
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: messages() });
    const result = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm([planSkip()]).llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ notValuable: 1, deferred: 0, errors: 0 });
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({
      outcome: 'not-valuable', artifact_count: 0, destination_count: 0,
      decision_evidence_hash: null, decision_evidence_version: null,
    });
    expect(lastConversationCaptureAt(db)).toBe('2026-08-26T06:00:00.000Z');
  });

  it('reopens a no-fitting decision when the visible linked body changes', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const original = linkedEngineNode({ body: 'Original visible destination body.' });
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']);
    seedNoFittingLedger({ db, conversationId: conversation.id, inputHash, nodes: [original] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': linkedEngineNode({ body: 'Changed visible destination body.' }),
    });
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]), composed(),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ unchanged: 0, evaluated: 1, appended: 1, deferred: 0, errors: 0 });
    expect(llm.calls).toHaveLength(2);
    expect(engine.nodeReads.length).toBeGreaterThan(1);
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({
      outcome: 'captured', decision_evidence_hash: null, decision_evidence_version: null,
    });
  });

  it('revisits a settled no-fitting decision when only its linked note changes between live runs', async () => {
    const db = captureDb();
    const conversation = meta({
      updated_at: '2026-08-26T05:00:00.000Z',
      linked_docs: ['linked-1'],
    });
    const destination = linkedEngineNode({ body: 'No fitting destination yet.' });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': destination,
    });
    const firstLlm = scriptedLlm([planSkip('no-fitting-destination')]);

    const first = await runConversationCaptureSweep(liveDeps(engine, firstLlm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    expect(first).toMatchObject({ settled: 1, evaluated: 1, notValuable: 1, deferred: 0, errors: 0 });
    expect(lastConversationCaptureAt(db)).toBe('2026-08-26T06:00:00.000Z');
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({
      outcome: 'no-fitting-destination',
      decision_evidence_version: 1,
      decision_evidence_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    destination.body = 'This linked note is now a fitting destination.';
    destination.version = 5;
    const secondLlm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]), composed(),
    ]);
    const second = await runConversationCaptureSweep(liveDeps(engine, secondLlm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(second).toMatchObject({ settled: 1, unchanged: 0, evaluated: 1, appended: 1, deferred: 0, errors: 0 });
    expect(secondLlm.calls).toHaveLength(2);
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({
      outcome: 'captured', decision_evidence_hash: null, decision_evidence_version: null,
    });
  });

  it('keeps an unchanged no-fitting decision suppressed without spending a planner call', async () => {
    const db = captureDb();
    const conversation = meta({
      updated_at: '2026-08-26T05:00:00.000Z',
      linked_docs: ['linked-1'],
    });
    const destination = linkedEngineNode({ body: 'Stable visible destination body.' });
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']);
    seedNoFittingLedger({ db, conversationId: conversation.id, inputHash, nodes: [destination] });
    setLastConversationCaptureAt(db, '2026-08-26T06:00:00.000Z');
    const prior = getConversationCaptureLedger(db, conversation.id)!;
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, { 'linked-1': destination });
    const llm = scriptedLlm([]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ unchanged: 1, evaluated: 0, deferred: 0, errors: 0 });
    expect(llm.calls).toEqual([]);
    expect(engine.nodeReads).toEqual(['linked-1']);
    expect(getConversationCaptureLedger(db, conversation.id)).toEqual(prior);
  });

  it.each([
    ['title', linkedEngineNode({ title: 'Changed visible destination title.' })],
    ['file path', linkedEngineNode({ filePath: 'Projects/Changed visible destination.md' })],
  ])('reopens a no-fitting decision when the linked %s changes', async (_field, changedDestination) => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const original = linkedEngineNode();
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']);
    seedNoFittingLedger({ db, conversationId: conversation.id, inputHash, nodes: [original] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, { 'linked-1': changedDestination });
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]), composed(),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ unchanged: 0, evaluated: 1, appended: 1, deferred: 0, errors: 0 });
    expect(llm.calls).toHaveLength(2);
    expect(engine.nodeReads.length).toBeGreaterThan(1);
  });

  it('keeps a no-fitting decision suppressed when only body text beyond the planner excerpt changes', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const visible = 'v'.repeat(MAX_LINKED_BODY_EXCERPT_CHARS);
    const original = linkedEngineNode({ body: `${visible} original hidden suffix` });
    const changed = linkedEngineNode({ body: `${visible} changed hidden suffix` });
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']);
    seedNoFittingLedger({ db, conversationId: conversation.id, inputHash, nodes: [original] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, { 'linked-1': changed });
    const llm = scriptedLlm([]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ unchanged: 1, evaluated: 0, deferred: 0, errors: 0 });
    expect(llm.calls).toEqual([]);
    expect(engine.nodeReads).toEqual(['linked-1']);
  });

  it('re-enters protected-only without a planner call when an eligible destination becomes settings-protected', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const original = linkedEngineNode();
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']);
    seedNoFittingLedger({ db, conversationId: conversation.id, inputHash, nodes: [original] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': linkedEngineNode({ filePath: 'Settings/Curator.md' }),
    });
    const llm = scriptedLlm([]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ unchanged: 0, protectedOnly: 1, evaluated: 0, deferred: 0, errors: 0 });
    expect(llm.calls).toEqual([]);
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({
      outcome: 'protected-only', decision_evidence_hash: null, decision_evidence_version: null,
    });
  });

  it('keeps a settings-path fingerprint stable when multiple protection predicates apply', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const destination = linkedEngineNode({
      filePath: 'Settings/Curator.md', fields: { vault_engine_projection: true },
    });
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']);
    seedNoFittingLedger({
      db,
      conversationId: conversation.id,
      inputHash,
      nodes: [destination],
      decision: protectedDestinationFingerprint(destination, 'settings-path'),
    });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, { 'linked-1': destination });
    const llm = scriptedLlm([]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ unchanged: 1, protectedOnly: 0, evaluated: 0, deferred: 0, errors: 0 });
    expect(llm.calls).toEqual([]);
  });

  it.each([
    ['version', linkedEngineNode({ version: 5, fields: { category: 'original' } })],
    ['unrelated field', linkedEngineNode({ fields: { category: 'changed' } })],
  ])('keeps a no-fitting decision suppressed when only the linked %s changes', async (_field, changedDestination) => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const original = linkedEngineNode({ fields: { category: 'original' } });
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']);
    seedNoFittingLedger({ db, conversationId: conversation.id, inputHash, nodes: [original] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, { 'linked-1': changedDestination });
    const llm = scriptedLlm([]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ unchanged: 1, evaluated: 0, deferred: 0, errors: 0 });
    expect(llm.calls).toEqual([]);
  });

  it('reconsiders an old migrated legacy no-fitting row once outside the watermark', async () => {
    const db = new Database(':memory:');
    openDbs.push(db);
    runMigrations(db, MIGRATIONS.filter((migration) => migration.version <= 12));
    const conversation = meta({
      updated_at: '2026-08-26T05:00:00.000Z',
      linked_docs: ['linked-1'],
    });
    const destination = linkedEngineNode();
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']);
    db.prepare(`
      INSERT INTO conversation_capture_ledger (
        conversation_id, input_hash, processed_at, outcome, artifact_count, destination_count
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(conversation.id, inputHash, '2026-08-20T12:00:00.000Z', 'no-fitting-destination', 0, 0);
    setLastConversationCaptureAt(db, '2026-08-26T06:00:00.000Z');
    runMigrations(db);
    expect(db.pragma('user_version', { simple: true })).toBe(41);
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({
      decision_evidence_hash: null, decision_evidence_version: null,
    });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, { 'linked-1': destination });
    const firstLlm = scriptedLlm([planSkip('no-fitting-destination')]);

    const first = await runConversationCaptureSweep(liveDeps(engine, firstLlm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    const persisted = getConversationCaptureLedger(db, conversation.id);
    expect(first).toMatchObject({ unchanged: 0, evaluated: 1, notValuable: 1, deferred: 0, errors: 0 });
    expect(persisted).toMatchObject({
      outcome: 'no-fitting-destination', decision_evidence_version: 1,
      decision_evidence_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const secondLlm = scriptedLlm([]);
    const second = await runConversationCaptureSweep(liveDeps(engine, secondLlm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    expect(second).toMatchObject({ unchanged: 1, evaluated: 0, deferred: 0, errors: 0 });
    expect(secondLlm.calls).toEqual([]);
  });

  it('does not let a fixed prefix of unchanged no-fitting rows starve changed revisits or bypass cap ordering', async () => {
    const db = captureDb();
    const conversations: ConversationMeta[] = [];
    const messageMap: Record<string, unknown[]> = {};
    const nodeMap: Record<string, Record<string, unknown>> = {};

    for (let index = 0; index < 100; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const conversationId = `a-unchanged-${suffix}`;
      const nodeId = `linked-unchanged-${suffix}`;
      const conversation = meta({
        id: conversationId,
        updated_at: '2026-08-24T05:00:00.000Z',
        linked_docs: [nodeId],
      });
      const destination = linkedEngineNode({ id: nodeId, body: `Stable body ${suffix}.` });
      const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), [nodeId]);
      conversations.push(conversation);
      messageMap[conversationId] = messages();
      nodeMap[nodeId] = destination;
      seedNoFittingLedger({ db, conversationId, inputHash, nodes: [destination] });
    }

    const changedRows = [
      meta({ id: 'z-older-changed', updated_at: '2026-08-25T04:00:00.000Z', linked_docs: ['linked-older'] }),
      meta({ id: 'z-newer-changed', updated_at: '2026-08-25T05:00:00.000Z', linked_docs: ['linked-newer'] }),
    ];
    for (const conversation of changedRows) {
      const nodeId = conversation.linked_docs![0]!;
      const original = linkedEngineNode({ id: nodeId, body: `Original body for ${conversation.id}.` });
      const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), [nodeId]);
      conversations.push(conversation);
      messageMap[conversation.id] = messages();
      nodeMap[nodeId] = linkedEngineNode({ id: nodeId, body: `Changed body for ${conversation.id}.` });
      seedNoFittingLedger({ db, conversationId: conversation.id, inputHash, nodes: [original] });
    }
    const deferredLedgerBefore = getConversationCaptureLedger(db, 'z-newer-changed');
    setLastConversationCaptureAt(db, '2026-08-26T06:00:00.000Z');
    const engine = fakeEngine([...conversations].reverse(), messageMap, nodeMap);
    const llm = scriptedLlm([planSkip('no-fitting-destination')]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db, {
      config: { conversationCaptureEvaluationCap: 1 },
    }), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({
      settled: 102, unchanged: 100, evaluated: 1, notValuable: 1, deferred: 1, errors: 0,
    });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.user).toContain('"id":"z-older-changed"');
    expect(getConversationCaptureLedger(db, 'z-newer-changed')).toEqual(deferredLedgerBefore);
  });

  it('leaves a legacy no-fitting row without evidence when cap deferral requires another reconsideration', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const destination = linkedEngineNode();
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']);
    upsertConversationCaptureLedger(db, {
      conversation_id: conversation.id,
      input_hash: inputHash,
      processed_at: NOW.toISOString(),
      outcome: 'no-fitting-destination',
      artifact_count: 0,
      destination_count: 0,
    });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, { 'linked-1': destination });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const llm = scriptedLlm([]);
      const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db, {
        config: { conversationCaptureEvaluationCap: 0 },
      }), { dryRun: false, trigger: 'scheduled', now: NOW });
      expect(result).toMatchObject({ unchanged: 0, evaluated: 0, deferred: 1, errors: 0 });
      expect(llm.calls).toEqual([]);
      expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({
        decision_evidence_hash: null, decision_evidence_version: null,
      });
    }
  });

  it.each(['not-valuable', 'ungrounded-factual', 'captured'] as const)(
    'keeps a %s outcome suppressed after destination-only changes',
    async (outcome) => {
      const db = captureDb();
      const conversation = meta({ linked_docs: ['linked-1'] });
      const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']);
      upsertConversationCaptureLedger(db, {
        conversation_id: conversation.id,
        input_hash: inputHash,
        processed_at: NOW.toISOString(),
        outcome,
        artifact_count: outcome === 'captured' ? 1 : 0,
        destination_count: outcome === 'captured' ? 1 : 0,
      });
      const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
        'linked-1': linkedEngineNode({ title: 'Destination changed after terminal outcome.' }),
      });
      const llm = scriptedLlm([]);

      const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
        dryRun: false, trigger: 'scheduled', now: NOW,
      });

      expect(result).toMatchObject({ unchanged: 1, evaluated: 0, deferred: 0, errors: 0 });
      expect(llm.calls).toEqual([]);
      expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({
        outcome, decision_evidence_hash: null, decision_evidence_version: null,
      });
    },
  );

  it.each(['not-valuable', 'ungrounded-factual', 'captured'] as const)(
    'keeps a %s outcome suppressed when destination projection would reject the linked ID',
    async (outcome) => {
      const db = captureDb();
      const malformedNodeId = ' malformed-linked-id ';
      const conversation = meta({ linked_docs: [malformedNodeId] });
      const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), [malformedNodeId]);
      upsertConversationCaptureLedger(db, {
        conversation_id: conversation.id,
        input_hash: inputHash,
        processed_at: NOW.toISOString(),
        outcome,
        artifact_count: outcome === 'captured' ? 1 : 0,
        destination_count: outcome === 'captured' ? 1 : 0,
      });
      const prior = getConversationCaptureLedger(db, conversation.id);
      const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
        [malformedNodeId]: linkedEngineNode({ id: malformedNodeId }),
      });
      const llm = scriptedLlm([]);

      const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
        dryRun: false, trigger: 'scheduled', now: NOW,
      });

      expect(result).toMatchObject({ unchanged: 1, evaluated: 0, deferred: 0, errors: 0 });
      expect(getConversationCaptureLedger(db, conversation.id)).toEqual(prior);
      expect(llm.calls).toEqual([]);
    },
  );

  it('computes a no-fitting decision in preview without writing its fingerprint', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, { 'linked-1': linkedEngineNode() });
    const llm = scriptedLlm([planSkip('no-fitting-destination')]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: true, trigger: 'cli', now: NOW,
    });

    expect(result).toMatchObject({ dryRun: true, evaluated: 1, notValuable: 1, deferred: 0, errors: 0 });
    expect(llm.calls).toHaveLength(1);
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
  });

  it('does not write a no-fitting fingerprint when the evaluation cap defers the candidate', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, { 'linked-1': linkedEngineNode() });
    const llm = scriptedLlm([]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db, {
      config: { conversationCaptureEvaluationCap: 0 },
    }), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ evaluated: 0, deferred: 1, errors: 0 });
    expect(llm.calls).toEqual([]);
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
  });

  it('leaves prior no-fitting evidence unchanged when a linked destination read fails', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const destination = linkedEngineNode();
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']);
    seedNoFittingLedger({ db, conversationId: conversation.id, inputHash, nodes: [destination] });
    const prior = getConversationCaptureLedger(db, conversation.id)!;
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': new Error('linked destination unavailable'),
    });

    const result = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm([]).llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ evaluated: 0, deferred: 1, errors: 1 });
    expect(getConversationCaptureLedger(db, conversation.id)).toEqual(prior);
  });

  it('leaves prior no-fitting evidence unchanged when planner evaluation fails', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const original = linkedEngineNode();
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']);
    seedNoFittingLedger({ db, conversationId: conversation.id, inputHash, nodes: [original] });
    const prior = getConversationCaptureLedger(db, conversation.id)!;
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': linkedEngineNode({ body: 'Changed visible body forces planner evaluation.' }),
    });

    const result = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm([new StructuredCallFailure('planner unavailable', undefined, 'malformed_json')]).llm,
      db,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ evaluated: 1, deferred: 1, errors: 1 });
    expect(getConversationCaptureLedger(db, conversation.id)).toEqual(prior);
  });

  it('leaves prior no-fitting evidence unchanged when authority changes after planning', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const original = linkedEngineNode();
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']);
    seedNoFittingLedger({ db, conversationId: conversation.id, inputHash, nodes: [original] });
    const prior = getConversationCaptureLedger(db, conversation.id)!;
    const changedDestination = linkedEngineNode({ body: 'Changed visible body forces planner evaluation.' });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': changedDestination,
    }, {}, [conversation], {
      conversationDetail: (_id, readIndex) => readIndex === 1
        ? { conversation, messages: messages(), linked_docs: ['linked-1'] }
        : {
          conversation: { ...conversation, revision: 2 },
          messages: messages(),
          linked_docs: ['linked-1'],
        },
    });

    const result = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm([planSkip('no-fitting-destination')]).llm,
      db,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ evaluated: 1, deferred: 1, errors: 0 });
    expect(getConversationCaptureLedger(db, conversation.id)).toEqual(prior);
  });

  it('leaves prior no-fitting evidence unchanged when ledger persistence fails', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const original = linkedEngineNode();
    const inputHash = conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']);
    seedNoFittingLedger({ db, conversationId: conversation.id, inputHash, nodes: [original] });
    const prior = getConversationCaptureLedger(db, conversation.id)!;
    db.exec(`
      CREATE TRIGGER fail_no_fitting_ledger_update
      BEFORE UPDATE ON conversation_capture_ledger
      BEGIN
        SELECT RAISE(FAIL, 'ledger unavailable');
      END;
    `);
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': linkedEngineNode({ body: 'Changed visible body forces planner evaluation.' }),
    });

    const result = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm([planSkip('no-fitting-destination')]).llm,
      db,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ evaluated: 1, deferred: 1, errors: 1 });
    expect(getConversationCaptureLedger(db, conversation.id)).toEqual(prior);
  });

  it('defers a malformed destination fingerprint candidate without blocking a valid later candidate', async () => {
    const db = captureDb();
    const malformed = meta({
      id: 'malformed-candidate',
      updated_at: '2026-08-25T05:00:00.000Z',
      linked_docs: [' malformed-linked-id '],
    });
    const valid = meta({
      id: 'valid-candidate',
      updated_at: '2026-08-26T05:00:00.000Z',
    });
    const malformedInputHash = conversationCaptureFingerprint(
      inspectConversation(messages()),
      [' malformed-linked-id '],
    );
    upsertConversationCaptureLedger(db, {
      conversation_id: malformed.id,
      input_hash: malformedInputHash,
      processed_at: NOW.toISOString(),
      outcome: 'no-fitting-destination',
      artifact_count: 0,
      destination_count: 0,
    });
    const priorMalformedLedger = getConversationCaptureLedger(db, malformed.id)!;
    const engine = fakeEngine([malformed, valid], {
      [malformed.id]: messages(),
      [valid.id]: messages(),
    }, {
      ' malformed-linked-id ': linkedEngineNode({ id: ' malformed-linked-id ' }),
    });
    const llm = scriptedLlm([planSkip()]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ settled: 2, deferred: 1, errors: 1, evaluated: 1, notValuable: 1 });
    expect(result.detail).toContain('malformed-candidate: destination decision projection failed');
    expect(getConversationCaptureLedger(db, malformed.id)).toEqual(priorMalformedLedger);
    expect(getConversationCaptureLedger(db, valid.id)).toMatchObject({
      outcome: 'not-valuable', decision_evidence_hash: null, decision_evidence_version: null,
    });
    expect(llm.calls).toHaveLength(1);
  });

  it('ledgers protected-only as a deterministic skip and revisits it outside the watermark', async () => {
    const db = captureDb();
    const conversation = meta({
      updated_at: '2026-08-26T05:00:00.000Z',
      linked_docs: ['linked-1'],
    });
    const protectedNode = node('linked-1', { file_path: 'Settings/Protected.md' });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': protectedNode,
    });

    const first = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm([]).llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    expect(first).toMatchObject({ protectedOnly: 1, deferred: 0, errors: 0, evaluated: 0 });
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({
      outcome: 'protected-only', decision_evidence_hash: null, decision_evidence_version: null,
    });
    expect(lastConversationCaptureAt(db)).toBe('2026-08-26T06:00:00.000Z');

    protectedNode.file_path = 'Notes/Now eligible.md';
    const second = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm([
        planCapture([rawArtifact({ destination_node_id: 'linked-1' })]), composed(),
      ]).llm,
      db,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(second).toMatchObject({ settled: 1, evaluated: 1, appended: 1, deferred: 0, errors: 0 });
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({
      outcome: 'captured', decision_evidence_hash: null, decision_evidence_version: null,
    });
  });

  it('does not let 100 deleted protected-only rows starve a live revisit and keeps preview read-only', async () => {
    const db = captureDb();
    const processedBase = Date.parse('2026-08-25T00:00:00.000Z');
    for (let index = 0; index < 100; index += 1) {
      upsertConversationCaptureLedger(db, {
        conversation_id: `deleted-${String(index).padStart(3, '0')}`,
        input_hash: `deleted-hash-${index}`,
        processed_at: new Date(processedBase + index * 1_000).toISOString(),
        outcome: 'protected-only', artifact_count: 0, destination_count: 0,
      });
    }
    const survivor = meta({
      id: 'survivor',
      updated_at: '2026-08-26T05:00:00.000Z',
    });
    upsertConversationCaptureLedger(db, {
      conversation_id: survivor.id,
      input_hash: 'survivor-old-hash',
      processed_at: '2026-08-25T12:00:00.000Z',
      outcome: 'protected-only', artifact_count: 0, destination_count: 0,
    });
    setLastConversationCaptureAt(db, '2026-08-26T11:00:00.000Z');
    const ledgerBefore = db.prepare(`
      SELECT conversation_id, input_hash, processed_at, outcome, artifact_count, destination_count
      FROM conversation_capture_ledger ORDER BY conversation_id
    `).all();
    const stateBefore = db.prepare('SELECT id, last_sweep_at FROM conversation_capture_state').all();
    const engine = fakeEngine([survivor], { [survivor.id]: messages() });

    const result = await runConversationCaptureSweep(deps(
      engine,
      scriptedLlm([planSkip()]).llm,
      { db },
    ), { dryRun: true, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ dryRun: true, settled: 1, evaluated: 1, notValuable: 1, deferred: 0, errors: 0 });
    expect(db.prepare(`
      SELECT conversation_id, input_hash, processed_at, outcome, artifact_count, destination_count
      FROM conversation_capture_ledger ORDER BY conversation_id
    `).all()).toEqual(ledgerBefore);
    expect(db.prepare('SELECT id, last_sweep_at FROM conversation_capture_state').all()).toEqual(stateBefore);
    expect(engine.liveMutations).toEqual([]);
  });

  it('recovers a persisted historical append after the conversation is unlinked', async () => {
    const original = meta({ linked_docs: ['linked-1'] });
    const previewEngine = fakeEngine([original], { [original.id]: messages() }, {
      'linked-1': node('linked-1'),
    });
    const preview = await runConversationCaptureSweep(deps(
      previewEngine,
      scriptedLlm([
        planCapture([rawArtifact({ destination_node_id: 'linked-1' })]), composed(),
      ]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const proposal = preview.proposals[0]!;
    const db = captureDb();
    upsertConversationCaptureArtifact(db, {
      capture_id: proposal.captureId,
      conversation_id: original.id,
      input_hash: conversationCaptureFingerprint(inspectConversation(messages()), ['linked-1']),
      destination_kind: 'appended',
      destination_node_id: 'linked-1',
      content_hash: captureBlockHash(proposal.body),
      content_markdown: proposal.body,
      committed_at: NOW.toISOString(),
    });
    const unlinked = meta({ revision: 2, linked_docs: [] });
    const engine = fakeEngine([unlinked], { [unlinked.id]: messages() }, {
      'linked-1': node('linked-1', { body: `Historical context.\n\n${proposal.body}` }),
    });
    const result = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm(fullyCoveredSequence({ captureIds: [proposal.captureId] })).llm,
      db,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ fullyCovered: 1, appended: 0, created: 0, deferred: 0, errors: 0 });
    expect(engine.appendCalls).toEqual([]);
    expect(getConversationCaptureArtifact(db, proposal.captureId)).toMatchObject({
      destination_kind: 'appended', destination_node_id: 'linked-1',
    });
  });

  it('charges the write cap only for missing executable destinations', async () => {
    const db = captureDb();
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const conversation = meta();
    const plan = planCapture([
      rawArtifact({ artifact_key: 'first', title: 'First', assistant_message_ids: ['assistant-1'] }),
      rawArtifact({ artifact_key: 'second', title: 'Second', assistant_message_ids: ['assistant-2'] }),
    ]);
    const composition = composed([
      { key: 'first', title: 'First', markdown: 'First body.' },
      { key: 'second', title: 'Second', markdown: 'Second body.' },
    ]);
    const preview = await runConversationCaptureSweep(deps(
      fakeEngine([conversation], { [conversation.id]: conversationMessages }),
      scriptedLlm([plan, composition]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const committed = preview.proposals[0]!;
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages }, {
      'already-committed': node('already-committed', {
        title: committed.destinationTitle, body: committed.body,
      }),
    });

    const result = await runConversationCaptureSweep(liveDeps(
      engine,
      scriptedLlm([plan, coverage('uncovered'), coverage('uncovered'), composition]).llm,
      db,
      { config: { conversationCaptureWriteCap: 1 } },
    ), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ created: 1, appended: 0, deferred: 0, errors: 0 });
    expect(engine.createCalls.filter((call) => call.dryRun === false)).toHaveLength(1);
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({ outcome: 'captured' });
  });

  it('classifies a previously ledgered below-floor input as unchanged on the next live pass', async () => {
    const db = captureDb();
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: messages('tiny') });

    const first = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm([]).llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    expect(first).toMatchObject({ belowFloor: 1, unchanged: 0 });

    const second = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm([]).llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });
    expect(second).toMatchObject({ belowFloor: 0, unchanged: 1, deferred: 0, errors: 0 });
  });

  it('ledgers a below-floor input without requiring destination projection', async () => {
    const db = captureDb();
    const malformedNodeId = ' malformed-linked-id ';
    const conversation = meta({ linked_docs: [malformedNodeId] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages('tiny') }, {
      [malformedNodeId]: linkedEngineNode({ id: malformedNodeId }),
    });
    const llm = scriptedLlm([]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ belowFloor: 1, unchanged: 0, deferred: 0, errors: 0 });
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({ outcome: 'below-floor' });
    expect(llm.calls).toEqual([]);
  });

  it.each([
    ['deleted', (block: string) => 'Prior capture marker deleted.'],
    ['altered', (block: string) => block.replace('_Curated from', '_Altered provenance from')],
  ])('does not ledger a below-floor input when a prior capture marker was %s', async (_label, alter) => {
    const fullConversation = meta({ updated_at: '2026-08-26T05:00:00.000Z' });
    const fullMessages = messages();
    const preview = await runConversationCaptureSweep(deps(
      fakeEngine([fullConversation], { [fullConversation.id]: fullMessages }),
      scriptedLlm([planCapture([rawArtifact()]), composed()]).llm,
    ), { dryRun: false, trigger: 'scheduled', now: NOW });
    const prior = preview.proposals[0]!;
    const db = captureDb();
    upsertConversationCaptureArtifact(db, {
      capture_id: prior.captureId,
      conversation_id: fullConversation.id,
      input_hash: conversationCaptureFingerprint(inspectConversation(fullMessages), []),
      destination_kind: 'created',
      destination_node_id: 'prior-capture',
      content_hash: captureBlockHash(prior.body),
      content_markdown: prior.body,
      committed_at: NOW.toISOString(),
    });
    const belowFloorConversation = meta({ updated_at: '2026-08-26T06:00:00.000Z' });
    const engine = fakeEngine([belowFloorConversation], { [belowFloorConversation.id]: messages('tiny') }, {
      'prior-capture': node('prior-capture', {
        title: prior.destinationTitle,
        body: alter(prior.body),
      }),
    });

    const result = await runConversationCaptureSweep(liveDeps(engine, scriptedLlm([]).llm, db), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ belowFloor: 1, deferred: 1, errors: 1 });
    expect(getConversationCaptureLedger(db, belowFloorConversation.id)).toBeUndefined();
    expect(lastConversationCaptureAt(db)).toBeNull();
  });

  it('forces effective preview for a global dry-run even when capture mode is live', async () => {
    const db = captureDb();
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {
      'linked-1': node('linked-1'),
    });
    const llm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]), composed(),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db), {
      dryRun: true, trigger: 'cli', now: NOW,
    });

    expect(result).toMatchObject({ dryRun: true, wouldAppend: 1, appended: 0 });
    expect(engine.appendCalls).toHaveLength(1);
    expect(engine.appendCalls[0]?.dryRun).toBe(true);
    expect(engine.liveMutations).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_ledger').get()).toEqual({ n: 0 });
    expect(lastConversationCaptureAt(db)).toBeNull();
  });

  it('stages a whole live conversation before deferring it over the write cap without mutation', async () => {
    const db = captureDb();
    const conversationMessages = [
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: `First ${'a'.repeat(300)} ${SOURCE_URL}` }] },
      { id: 'assistant-2', role: 'assistant', parts: [{ type: 'text', text: `Second ${'b'.repeat(300)} ${SOURCE_URL}` }] },
    ];
    const conversation = meta();
    const engine = fakeEngine([conversation], { [conversation.id]: conversationMessages });
    const llm = scriptedLlm([
      planCapture([
        rawArtifact({ artifact_key: 'first', title: 'First', assistant_message_ids: ['assistant-1'] }),
        rawArtifact({ artifact_key: 'second', title: 'Second', assistant_message_ids: ['assistant-2'] }),
      ]),
      composed([
        { key: 'first', title: 'First', markdown: 'First body.' },
        { key: 'second', title: 'Second', markdown: 'Second body.' },
      ]),
    ]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, db, {
      config: { conversationCaptureWriteCap: 1 },
    }), { dryRun: false, trigger: 'scheduled', now: NOW });

    expect(result).toMatchObject({ dryRun: false, created: 0, appended: 0, deferred: 1, errors: 0 });
    expect(engine.createCalls).toHaveLength(2);
    expect(engine.createCalls.every((call) => call.dryRun === true)).toBe(true);
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();
    expect(lastConversationCaptureAt(db)).toBeNull();
  });
});

describe('capture dates in the configured time zone (#496)', () => {
  // The installation: tz stored empty and the host in US Eastern, so Config.curatorTz is America/New_York.
  const NY = 'America/New_York';
  // 21:30 EDT on 25 August, already 26 August in UTC.
  const EVENING = '2026-08-26T01:30:00.000Z';
  /** The date every capture carried before #496. */
  const legacyDate = (iso: string): string => new Date(iso).toISOString().slice(0, 10);
  const PRIMARY_TITLES = new Set(['Modular vehicle overview', 'Modular vehicle overview — Launch discussion']);
  const occupiedPrimaryTitles = (args: Record<string, unknown>) => ({
    dry_run: true,
    would_create: {
      file_path: `Notes/${String(args.title)}.md`,
      ...(PRIMARY_TITLES.has(String(args.title)) ? { conflict: 'title already exists' } : {}),
    },
    warnings: [],
  });
  const failArtifactInsert = (db: Database.Database): void => {
    db.exec(`
      CREATE TRIGGER fail_496_capture_artifact_insert
      BEFORE INSERT ON conversation_capture_artifacts
      BEGIN SELECT RAISE(FAIL, 'forced artifact insert failure'); END;
    `);
  };
  const liveWrites = (harness: FakeEngineHarness) => harness.createCalls.filter((call) => call.dryRun === false);

  /** One live pass creating a fallback-titled note for a conversation last updated at `updatedAt`. */
  async function fallbackCapture(updatedAt: string, curatorTz: string): Promise<{ title: string; body: string }> {
    const db = captureDb();
    const conversation = meta({ title: 'Launch discussion', updated_at: updatedAt });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {}, {}, [conversation], {
      createPreview: occupiedPrimaryTitles,
    });
    const result = await runConversationCaptureSweep(
      liveDeps(engine, scriptedLlm([planCapture([rawArtifact()]), composed()]).llm, db, { config: { curatorTz } }),
      { dryRun: false, trigger: 'scheduled', now: NOW },
    );
    expect(result).toMatchObject({ created: 1, deferred: 0, errors: 0 });
    const [write] = liveWrites(engine);
    return { title: String(write!.title), body: String(write!.body) };
  }

  it('dates a new evening capture in the tz setting, its attribution line and fallback title alike', async () => {
    const { title, body } = await fallbackCapture(EVENING, NY);
    expect(title).toBe('Modular vehicle overview (from chat 2026-08-25)');
    expect(body).toContain('_Curated from “Launch discussion” on 2026-08-25._');
    expect(legacyDate(EVENING)).toBe('2026-08-26');
  });

  it('on the installation shape is byte-identical to the UTC dates outside 20:00 to midnight EDT', async () => {
    for (const updatedAt of [
      '2026-08-25T04:00:00.000Z', // 00:00 EDT
      '2026-08-25T16:00:00.000Z', // 12:00 EDT
      '2026-08-25T23:59:59.999Z', // 19:59 EDT
    ]) {
      const installed = await fallbackCapture(updatedAt, NY);
      // tz UTC renders exactly what the code before #496 wrote.
      expect(installed, updatedAt).toEqual(await fallbackCapture(updatedAt, 'UTC'));
      expect(installed.title).toBe(`Modular vehicle overview (from chat ${legacyDate(updatedAt)})`);
      expect(installed.body).toContain(` on ${legacyDate(updatedAt)}._`);
    }
    for (const [updatedAt, local] of [
      ['2026-08-26T00:00:00.000Z', '2026-08-25'], // 20:00 EDT
      ['2026-08-26T03:59:59.999Z', '2026-08-25'], // 23:59 EDT
    ] as const) {
      const installed = await fallbackCapture(updatedAt, NY);
      expect(legacyDate(updatedAt)).toBe('2026-08-26');
      expect(installed.title, updatedAt).toBe(`Modular vehicle overview (from chat ${local})`);
      expect(installed.body).toContain(` on ${local}._`);
    }
  });

  it('upgrade: recognises a fallback-titled note the old code wrote for the same transcript, without a duplicate', async () => {
    const db = captureDb();
    failArtifactInsert(db);
    const conversation = meta({ title: 'Launch discussion', updated_at: EVENING });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, {}, {}, [conversation], {
      createPreview: occupiedPrimaryTitles,
    });
    const outputs = (hasCoverageEvidence: boolean) => [
      planCapture([rawArtifact()]),
      ...(hasCoverageEvidence ? [coverage('uncovered')] : []),
      composed(),
    ];

    // Before the upgrade the capture is dated in UTC (tz UTC renders the old code's exact bytes), and
    // the pass stops after the create, before its artifact row and ledger.
    const before = await runConversationCaptureSweep(
      liveDeps(engine, scriptedLlm(outputs(false)).llm, db, { config: { curatorTz: 'UTC' } }),
      { dryRun: false, trigger: 'scheduled', now: NOW },
    );
    expect(before).toMatchObject({ created: 1, deferred: 1, errors: 1 });
    const [oldWrite] = liveWrites(engine);
    expect(oldWrite!.title).toBe(`Modular vehicle overview (from chat ${legacyDate(EVENING)})`);
    expect(String(oldWrite!.body)).toContain(`_Curated from “Launch discussion” on ${legacyDate(EVENING)}._`);
    const oldId = captureIdFromBlock(String(oldWrite!.body));
    expect(getConversationCaptureLedger(db, conversation.id)).toBeUndefined();

    // After the upgrade, on the installation: the same transcript and composition, now evening in New York.
    db.exec('DROP TRIGGER fail_496_capture_artifact_insert');
    engine.createCalls.splice(0);
    engine.liveMutations.splice(0);
    const after = await runConversationCaptureSweep(
      liveDeps(engine, scriptedLlm(outputs(true)).llm, db, { config: { curatorTz: NY } }),
      { dryRun: false, trigger: 'scheduled', now: NOW },
    );

    expect(after).toMatchObject({ created: 0, appended: 0, deferred: 0, errors: 0 });
    expect(engine.createCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
    expect(getConversationCaptureArtifact(db, oldId)).toMatchObject({
      destination_kind: 'created', destination_node_id: 'created-1', content_markdown: oldWrite!.body,
    });
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({
      outcome: 'captured', artifact_count: 1, destination_count: 1,
    });
    expect(Object.values(engine.nodeMap).filter((value) => !(value instanceof Error))).toHaveLength(1);
  });

  it('upgrade: recognises an append the old code wrote for the same transcript, without a second append', async () => {
    const db = captureDb();
    failArtifactInsert(db);
    const conversation = meta({ updated_at: EVENING, linked_docs: ['linked-1'] });
    const linked = node('linked-1');
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, { 'linked-1': linked });
    const outputs = (hasCoverageEvidence: boolean) => [
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      ...(hasCoverageEvidence ? [coverage('uncovered')] : []),
      composed(),
    ];

    const before = await runConversationCaptureSweep(
      liveDeps(engine, scriptedLlm(outputs(false)).llm, db, { config: { curatorTz: 'UTC' } }),
      { dryRun: false, trigger: 'scheduled', now: NOW },
    );
    expect(before).toMatchObject({ appended: 1, deferred: 1, errors: 1 });
    const oldBlock = String(engine.appendCalls.find((call) => call.dryRun === false)!.text);
    expect(oldBlock).toContain(` on ${legacyDate(EVENING)}._`);
    const bodyAfterOldWrite = String(linked.body);

    db.exec('DROP TRIGGER fail_496_capture_artifact_insert');
    engine.appendCalls.splice(0);
    engine.liveMutations.splice(0);
    const after = await runConversationCaptureSweep(
      liveDeps(engine, scriptedLlm(outputs(true)).llm, db, { config: { curatorTz: NY } }),
      { dryRun: false, trigger: 'scheduled', now: NOW },
    );

    expect(after).toMatchObject({ appended: 0, created: 0, deferred: 0, errors: 0 });
    expect(engine.appendCalls).toEqual([]);
    expect(engine.liveMutations).toEqual([]);
    expect(String(linked.body)).toBe(bodyAfterOldWrite);
    expect(getConversationCaptureArtifact(db, captureIdFromBlock(oldBlock))).toMatchObject({
      destination_kind: 'appended', destination_node_id: 'linked-1', content_markdown: oldBlock,
    });
    expect(getConversationCaptureLedger(db, conversation.id)).toMatchObject({ outcome: 'captured' });
  });

  it('upgrade: keeps the old capture and adds the continued conversation\'s capture in the local date', async () => {
    const db = captureDb();
    const sharedNodes = { 'linked-1': node('linked-1') };
    const original = meta({ updated_at: EVENING, linked_docs: ['linked-1'] });
    const firstEngine = fakeEngine([original], { [original.id]: messages() }, sharedNodes);
    const first = await runConversationCaptureSweep(
      liveDeps(firstEngine, scriptedLlm([
        planCapture([rawArtifact({ destination_node_id: 'linked-1' })]), composed(),
      ]).llm, db, { config: { curatorTz: 'UTC' } }),
      { dryRun: false, trigger: 'scheduled', now: NOW },
    );
    expect(first).toMatchObject({ appended: 1, deferred: 0, errors: 0 });
    const oldBlock = String(firstEngine.appendCalls.find((call) => call.dryRun === false)!.text);
    expect(oldBlock).toContain(' on 2026-08-26._');

    // The next evening the conversation continues: 21:30 EDT on 26 August, 27 August in UTC.
    const continued = meta({ updated_at: '2026-08-27T01:30:00.000Z', linked_docs: ['linked-1'] });
    const continuedMessages = messages(`A continued durable explanation ${'z'.repeat(560)} ${SOURCE_URL}`);
    const secondEngine = fakeEngine([continued], { [continued.id]: continuedMessages }, sharedNodes);
    const secondLlm = scriptedLlm([
      planCapture([rawArtifact({ destination_node_id: 'linked-1' })]),
      coverage('uncovered'),
      composed([{ markdown: 'A continued modular vehicle overview.' }]),
    ]);
    const second = await runConversationCaptureSweep(
      liveDeps(secondEngine, secondLlm.llm, db, { config: { curatorTz: NY } }),
      { dryRun: false, trigger: 'scheduled', now: new Date('2026-08-27T12:00:00.000Z') },
    );

    expect(second).toMatchObject({ appended: 1, created: 0, deferred: 0, errors: 0 });
    const newBlock = String(secondEngine.appendCalls.find((call) => call.dryRun === false)!.text);
    expect(newBlock).toContain(' on 2026-08-26._');
    expect(secondLlm.calls[0]?.user).toContain(captureIdFromBlock(oldBlock));
    const body = String(sharedNodes['linked-1'].body);
    expect(body).toContain(oldBlock);
    expect(body.endsWith(newBlock)).toBe(true);
    expect(body.match(/ve:chat-curation:start/g)).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_capture_artifacts').get()).toEqual({ n: 2 });
    expect(getConversationCaptureLedger(db, continued.id)).toMatchObject({ outcome: 'captured' });
  });
});

describe('conversation capture detail log', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the run detail as one warning with the error and deferral counts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = fakeEngine([], {}, {}, {}, [null, { id: 42 }]);

    const result = await runConversationCaptureSweep(deps(engine, scriptedLlm([]).llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toBe(`[curator] conversation capture (errors 2, deferred 0): ${result.detail}`);
    expect(result.detail).toContain('conversation metadata row 1 is invalid');
  });

  it('logs a model failure by its closed reason, without the provider failure text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const conversation = meta({ linked_docs: ['linked-1'] });
    const engine = fakeEngine([conversation], { [conversation.id]: messages() }, { 'linked-1': node('linked-1') });
    const llm = scriptedLlm([new StructuredCallFailure('RAW-PLANNER-MARKER', undefined, 'malformed_json')]);

    const result = await runConversationCaptureSweep(liveDeps(engine, llm.llm, captureDb()), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result).toMatchObject({ deferred: 1, errors: 1 });
    const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).toContain(`(errors 1, deferred 1): ${conversation.id}: conversation capture planner failed (reason=malformed_json)`);
    expect(logged).not.toContain('RAW-PLANNER-MARKER');
  });

  it('caps a long detail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = fakeEngine([], {}, {}, {}, Array.from({ length: 200 }, () => null));

    const result = await runConversationCaptureSweep(deps(engine, scriptedLlm([]).llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    const line = String(warn.mock.calls[0]![0]);
    expect(result.detail!.length).toBeGreaterThan(4000);
    expect(line).toContain(`${result.detail!.slice(0, 4000)}… (${result.detail!.length - 4000} more chars)`);
    expect(line).not.toContain(result.detail!.slice(0, 4001));
  });

  it('logs nothing when the run has no detail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runConversationCaptureSweep(deps(fakeEngine([], {}), scriptedLlm([]).llm), {
      dryRun: false, trigger: 'scheduled', now: NOW,
    });

    expect(result.detail).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
