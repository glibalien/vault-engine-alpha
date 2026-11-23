// The replay runner: one recorded turn × one candidate model, assembled
// EXACTLY as the production surface assembles it, run against the sandboxed
// engine through the write-intercepting executor, and scored.
//
// Fidelity is the whole point of this module. Every prompt/tool decision
// below is delegated to @vault/chat-core (the same code VEfO runs) rather
// than reconstructed here: composeSystem, wrapEngineTools + mergeToolSets in
// the production merge order, createToolTiering, assembleContext, and
// runChatStream. If the bench showed a model a different prompt or a
// different tool surface than production does, the rankings it produces
// would be fiction.

import {
  SYSTEM_PROMPT,
  TIERING_SYSTEM_NOTE,
  CORE_TOOL_NAMES,
  assembleContext,
  boardProvider,
  composeSystem,
  createPresentVizTool,
  createToolTiering,
  docRefProvider,
  memoriesProvider,
  mergeToolSets,
  nodesProvider,
  resolveModel,
  runChatStream,
  wrapEngineTools,
  type ContextProvider,
  type EngineCall,
  type EngineToolInfo,
  type ProviderKeys,
} from '@vault/chat-core';
import { wrapLanguageModel, type LanguageModel, type LanguageModelUsage, type ToolSet } from 'ai';
import { estimateCostUsdWith, resolvePricing, type TokenUsage } from '@vault/pricing';
import { CHAT_DESCRIPTORS, type ModelCatalogEntry } from '@vault/settings-registry';
import type { TurnClass } from './classify.js';
import type { CorpusTurn } from './corpus.js';
import type { BenchEngineClient } from './engine-client.js';
import { makeBenchExecutor, type CallOutcome } from './execute.js';
import { assertContained, type SandboxPaths } from './sandbox.js';

/**
 * The chat domain's own `maxSteps` default, read from the settings registry
 * rather than copied — a benchmark that hands models a bigger step budget than
 * the surface they are being ranked for produces fiction (a model needing 15
 * steps would PASS here and fail in production). Used only when the sandbox's
 * chat settings don't supply one.
 */
const REGISTRY_MAX_STEPS = ((): number => {
  const value = CHAT_DESCRIPTORS.find((d) => d.key === 'maxSteps')?.default;
  if (typeof value !== 'number') {
    throw new Error('bench: settings-registry chat domain has no numeric maxSteps default');
  }
  return value;
})();

/** Two retries, then ERROR. Injectable `sleep` keeps tests from waiting 10s. */
const RETRY_BACKOFF_MS: readonly number[] = [2000, 8000];

/** Wall-clock cap on one replay attempt. A hung provider must not stall a sweep. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Production's provider list and order (packages/obsidian-plugin/src/chat/build-context.ts). */
const CONTEXT_PROVIDERS: ContextProvider[] = [docRefProvider, boardProvider, nodesProvider, memoriesProvider];

/** Production's token estimator (same file). */
const estimateTokens = (text: string): number => Math.ceil(text.length / 3.7);

export type TurnOutcome = 'PASS' | 'WEAK' | 'FAIL' | 'ERROR';

export interface TurnResult {
  conversationId: string;
  seq: number;
  turnClass: TurnClass;
  outcome: TurnOutcome;
  calls: CallOutcome[];
  truncatedAtWrite: boolean;
  /** Count of write calls with no dry-run path — a coverage column, not a score input. */
  unvalidatable: number;
  emittedCallCount: number;
  recordedCallCount: number;
  latencyMs: number;
  /** null = the provider reported nothing. Never fabricate 0. */
  usage: TokenUsage | null;
  /** null = unknown pricing OR unmeasured usage. Never fabricate 0. */
  costUsd: number | null;
  /** Present only when outcome === 'ERROR'. */
  error?: string;
}

export interface RunReplayTurnInput {
  turn: CorpusTurn;
  modelEntry: ModelCatalogEntry;
  keys: ProviderKeys;
  client: BenchEngineClient;
  /** From client.listTools() via toEngineToolInfos — mapped once per run. */
  toolInfos: EngineToolInfo[];
  /**
   * From the sandbox's get-settings chat domain. Each null falls back to the
   * value production would use: chat-core's built-in prompts, and the settings
   * registry's own `maxSteps` default.
   */
  chatSettings: { systemPrompt: string | null; tieringNote: string | null; maxSteps: number | null };
  /**
   * The sandbox this run's engine is bound to. Required (not in the brief's
   * sketched signature) because assembly rule 7 — re-assert containment before
   * the first tool execution — is impossible without it. Verified before ANY
   * engine traffic, including host-side context assembly.
   */
  paths: SandboxPaths;
  /**
   * Model factory seam, mirroring chat-core's own `makeTurnResolver` /
   * `runTitleFlow` convention. Defaults to production's `resolveModel`; tests
   * inject MockLanguageModelV4 through it.
   */
  makeModel?: (entry: ModelCatalogEntry, keys: ProviderKeys) => LanguageModel;
  /** Retry backoff, injectable so tests don't sleep 10 real seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Wall-clock cap on one replay attempt. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * BenchEngineClient.listTools() → chat-core's EngineToolInfo[], the same
 * mapping the production adapter performs (packages/obsidian-plugin/src/
 * engine/transport.ts `listTools`). Mapped once per run, then reused for
 * every turn × model.
 */
export function toEngineToolInfos(
  tools: { name: string; description: string; inputSchema: unknown }[],
): EngineToolInfo[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));
}

/**
 * Deterministic, ORDER-INDEPENDENT aggregate over a turn's call outcomes.
 *
 * Task 7's `outcomes()` returns entries in EMISSION order, which under
 * concurrent tool dispatch is not invocation order — so nothing here may read
 * `calls` positionally ("the first call decides" would be a real bug). Every
 * rule below quantifies over the whole array.
 *
 * `write-unvalidatable` and `suppressed` are coverage columns: a turn is not
 * penalised for the harness having refused (or truncated) its own calls.
 */
export function scoreCalls(calls: CallOutcome[]): 'PASS' | 'WEAK' | 'FAIL' {
  const failed = calls.some(
    (c) =>
      (c.kind === 'read' && c.verdict === 'FAIL') || (c.kind === 'write-validated' && c.verdict === 'INVALID'),
  );
  if (failed) return 'FAIL';
  return calls.some((c) => c.kind === 'read' && c.verdict === 'WEAK') ? 'WEAK' : 'PASS';
}

/**
 * ai@7 usage → @vault/pricing TokenUsage.
 *
 * There is NO flat `cachedInputTokens` in ai@7: cache accounting lives under
 * `inputTokenDetails`. Every nested read is `?.`-guarded because a mocked or
 * hand-built usage value omits the detail objects even though the type marks
 * them required — the same trap chat-core's interpret-core.ts:32-38 and
 * usage.ts document.
 *
 * Absent stays absent: when the provider reported nothing at all this returns
 * null so the caller records "not measured", never a fabricated 0. The
 * input fallback (flat inputTokens minus cache reads) mirrors usage.ts's
 * ledger mapping so bench cost and recorded spend agree.
 */
export function tokenUsageFrom(total: LanguageModelUsage | null | undefined): TokenUsage | null {
  if (!total) return null;
  const details = total.inputTokenDetails;
  const noCache = details?.noCacheTokens;
  const cacheRead = details?.cacheReadTokens;
  const cacheWrite = details?.cacheWriteTokens;
  const output = total.outputTokens;
  if (
    noCache === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    output === undefined &&
    total.inputTokens === undefined
  ) {
    return null;
  }
  return {
    input: noCache ?? Math.max(0, (total.inputTokens ?? 0) - (cacheRead ?? 0)),
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
  };
}

/** Blank/whitespace settings values fall back to the default, as production's `promptOrDefault` does. */
function promptOrDefault(value: string | null, fallback: string): string {
  return value !== null && value.trim() !== '' ? value : fallback;
}

/**
 * Raw engine call for HOST-side work (context assembly), bypassing the
 * write-intercepting executor on purpose: context providers are the host's
 * own reads, not the model's tool calls, and scoring them would pollute
 * every turn's call list with list-memories. This mirrors production, where
 * buildContext uses `engineCallFor(conn)` directly rather than the model's
 * wrapped tool set.
 */
function hostEngineCall(client: BenchEngineClient): EngineCall {
  return async (name, args) => ({
    content: [{ type: 'text', text: JSON.stringify(await client.callToolEnvelope(name, args)) }],
  });
}

/**
 * The AI SDK masks every stream error to the literal string "An error
 * occurred." before it reaches any seam RunChatInput exposes, so the only
 * place the real provider message survives is at the model boundary. This
 * middleware taps it there (and mid-stream error parts on the way through)
 * purely so TurnResult.error is diagnosable — "An error occurred." would make
 * every ERROR row in the report indistinguishable.
 */
function captureModelErrors(model: LanguageModel, sink: (err: unknown) => void): LanguageModel {
  if (typeof model === 'string') return model;
  return wrapLanguageModel({
    model,
    middleware: {
      wrapStream: async ({ doStream }) => {
        let result;
        try {
          result = await doStream();
        } catch (err) {
          sink(err);
          throw err;
        }
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if ((part as { type?: string }).type === 'error') sink((part as { error?: unknown }).error);
                controller.enqueue(part);
              },
            }),
          ),
        };
      },
    },
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface AttemptOutcome {
  calls: CallOutcome[];
  emittedCallCount: number;
  latencyMs: number;
  totalUsage: LanguageModelUsage | null;
  /** null when the attempt completed; a message when the model/transport failed. */
  failure: string | null;
  /** A timeout is terminal — the caller must not retry it. */
  timedOut: boolean;
}

/**
 * Drain the UI-message stream, never rejecting. Draining is mandatory:
 * onStreamFinish (our usage/step source) fires only once the stream is fully
 * consumed, so an undrained stream hangs the run. It is also the only error
 * channel — the AI SDK does not reject on model failure, it emits an `error`
 * chunk. Rejections are returned rather than thrown so the timeout race below
 * can never lose an error to an unhandled rejection after it has moved on.
 */
async function drainStream(
  stream: ReadableStream<{ type: string; errorText?: string }>,
): Promise<{ errorText: string | null; thrown: unknown | null }> {
  try {
    const reader = stream.getReader();
    let errorText: string | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === 'error' && errorText === null) errorText = value.errorText ?? 'unknown stream error';
    }
    return { errorText, thrown: null };
  } catch (err) {
    return { errorText: null, thrown: err };
  }
}

/**
 * One replay attempt, wall-clock capped. Never throws for model/transport
 * trouble — it reports `failure` so the caller can decide whether to retry.
 *
 * The timeout is enforced by racing the drain, not by the abort signal alone:
 * a provider that never settles its `doStream` promise never observes the
 * signal, which is exactly the hang this guards against. The signal is still
 * passed (and aborted on timeout) so a well-behaved provider tears its request
 * down. An abandoned drain that resolves later is harmless — Task 7's executor
 * bumps its epoch on `reset()` and discards outcomes from a superseded turn.
 */
async function runAttempt(args: {
  turn: CorpusTurn;
  model: LanguageModel;
  system: string;
  tools: ToolSet;
  maxSteps: number;
  prepareStep: Parameters<typeof runChatStream>[0]['prepareStep'];
  executor: ReturnType<typeof makeBenchExecutor>;
  timeoutMs: number;
}): Promise<AttemptOutcome> {
  const { turn, system, tools, maxSteps, prepareStep, executor, timeoutMs } = args;
  executor.reset();

  let captured: unknown = null;
  const model = captureModelErrors(args.model, (err) => {
    if (captured === null) captured = err;
  });

  let totalUsage: LanguageModelUsage | null = null;
  let emittedCallCount = 0;

  const controller = new AbortController();
  const started = performance.now();
  const fail = (failure: string, timedOut: boolean): AttemptOutcome => ({
    calls: executor.outcomes(),
    emittedCallCount,
    latencyMs: performance.now() - started,
    totalUsage: null,
    failure,
    timedOut,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stream = runChatStream({
      model,
      system,
      messages: turn.history,
      tools,
      prepareStep,
      maxSteps,
      abortSignal: controller.signal,
      // No onStepFinish: viz rendering is client-side and the bench has no
      // rendering host, so viz emission is the no-op half of present-viz.
      // The tool itself still runs its real query against the sandbox.
      onStreamFinish: ({ steps, totalUsage: usage }) => {
        totalUsage = usage;
        emittedCallCount = steps.reduce((n, step) => n + step.toolCalls.length, 0);
      },
      onError: (err) => messageOf(err),
    });

    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const raced = await Promise.race([drainStream(stream), timeout]);

    if (raced === 'timeout') {
      controller.abort();
      return fail(`bench: turn timed out after ${timeoutMs}ms`, true);
    }
    if (raced.thrown !== null) return fail(messageOf(captured ?? raced.thrown), false);

    const latencyMs = performance.now() - started;
    const failure = captured !== null ? messageOf(captured) : raced.errorText;
    return {
      calls: executor.outcomes(),
      emittedCallCount,
      latencyMs,
      totalUsage: failure === null ? totalUsage : null,
      failure,
      timedOut: false,
    };
  } catch (err) {
    return fail(messageOf(captured ?? err), false);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Replay one recorded turn against one candidate model.
 *
 * Resolves with `outcome: 'ERROR'` for model/transport failures (a harness
 * statistic, never folded into FAIL). REJECTS for harness misconfiguration —
 * a sandbox containment violation or a missing provider key — because those
 * are not results to be tabulated, they are reasons to stop the run.
 */
export async function runReplayTurn(input: RunReplayTurnInput): Promise<TurnResult> {
  // Rule 7: re-assert containment before any engine traffic at all (context
  // assembly below already talks to the engine). This is the runner-side half
  // of the sandbox's hard guard — deliberately outside the retry loop and
  // outside every try/catch, so a violation aborts the run instead of
  // degrading into a scored ERROR row.
  assertContained(input.paths);

  const { turn, modelEntry, keys, client, toolInfos, chatSettings } = input;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Resolved once, outside the retry loop: resolveModel throws LOUDLY on a
  // missing provider key, and retrying a misconfiguration three times (with
  // 10s of backoff) would only bury it.
  const baseModel = (input.makeModel ?? resolveModel)(modelEntry, keys);

  const executor = makeBenchExecutor(client);

  // Rule 1: production's merge order — engine tools first (they win any name
  // collision), then present-viz. mergeToolSets is FIRST-wins, so the order
  // matters. No curator connection: Task 4 excluded turns that used curator
  // tools from the corpus.
  const toolSet = mergeToolSets(wrapEngineTools(toolInfos, executor.engineCall), {
    'present-viz': createPresentVizTool(executor.engineCall),
  });
  // Rule 3: never pre-add load-vault-tools (createToolTiering throws) and
  // never expect record-usage to be visible (it strips it).
  const tiering = createToolTiering(toolSet, { core: CORE_TOOL_NAMES });

  // Rule 2: the working-context block, built by the same providers, in the
  // same order, through the same assembleContext production uses — with the
  // conversation's OWN persisted chip state (Task 4 parses client_state through
  // chat-core's coerceContext and carries the result on the turn).
  //
  // The manifest is production's "what's open right now", which a replay has
  // nothing to fill: no open note, so docRefProvider stays silent (the corpus
  // does not record which note was active — a standing fidelity limit). The one
  // exception is the board: `activeBoardId` is a PERSISTED choice, so replaying
  // it into the manifest is the only way boardProvider can fire at all, and
  // dropping it would silently discard context those conversations really had.
  const assembled = await assembleContext(CONTEXT_PROVIDERS, {
    call: hostEngineCall(client),
    manifest: typeof turn.contextState.activeBoardId === 'string'
      ? { activeBoardId: turn.contextState.activeBoardId }
      : {},
    state: turn.contextState,
    estimateTokens,
  });

  // Rule 2: `now` is the conversation's own updated_at, not replay-day — the
  // closest available anchor for the date line. Its divergence from the
  // original turn's date is a known fidelity limit, recorded in the manifest.
  const base =
    promptOrDefault(chatSettings.systemPrompt, SYSTEM_PROMPT) +
    promptOrDefault(chatSettings.tieringNote, TIERING_SYSTEM_NOTE);
  const system = composeSystem(base, assembled.text, undefined, new Date(turn.conversationUpdatedAt));

  // The step budget the surface itself runs with — never a bench-local number.
  const maxSteps = chatSettings.maxSteps ?? REGISTRY_MAX_STEPS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let attempt: AttemptOutcome | null = null;
  for (let i = 0; i <= RETRY_BACKOFF_MS.length; i++) {
    if (i > 0) await sleep(RETRY_BACKOFF_MS[i - 1] ?? 0);
    // Fresh per-request tiering state each attempt: a partially-loaded
    // deferred set from a failed attempt must not leak into the retry.
    const request = tiering.forRequest(turn.history);
    attempt = await runAttempt({
      turn,
      model: baseModel,
      system,
      tools: request.tools,
      maxSteps,
      prepareStep: request.prepareStep,
      executor,
      timeoutMs,
    });
    // Retries exist for transient errors. A timeout is terminal: the attempt
    // already burned the full budget, so retrying it would triple the stall the
    // timeout exists to prevent.
    if (attempt.failure === null || attempt.timedOut) break;
  }

  // Unreachable: the loop always runs at least once and assigns `attempt`.
  if (attempt === null) throw new Error('bench: replay produced no attempt');

  const calls = attempt.calls;
  const usage = tokenUsageFrom(attempt.totalUsage);
  const pricing = resolvePricing(modelEntry.model, modelEntry.pricing);
  const result: TurnResult = {
    conversationId: turn.conversationId,
    seq: turn.seq,
    turnClass: turn.turnClass,
    outcome: attempt.failure === null ? scoreCalls(calls) : 'ERROR',
    calls,
    truncatedAtWrite: calls.some((c) => c.kind === 'write-validated' || c.kind === 'write-unvalidatable'),
    unvalidatable: calls.filter((c) => c.kind === 'write-unvalidatable').length,
    emittedCallCount: attempt.emittedCallCount,
    recordedCallCount: turn.recordedCalls.length,
    latencyMs: attempt.latencyMs,
    usage,
    // Unknown pricing → null, never 0: an unpriced model must not look free.
    costUsd: usage !== null && pricing !== null ? estimateCostUsdWith(pricing, usage) : null,
  };
  return attempt.failure === null ? result : { ...result, error: attempt.failure };
}
