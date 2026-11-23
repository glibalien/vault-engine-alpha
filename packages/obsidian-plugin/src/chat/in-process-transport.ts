import { runChatStream, chatErrorText, composeSystem, emitVizParts, emitSynthesizedVizParts, stampMemoryEvidence, guardWebFetch, createFetchAllowance, callBilling, combineBilling, type CallBilling, type FetchAllowance, type ToolTiering, type VizDataPart } from '@vault/chat-core';
import type { ChatTransport, LanguageModel, LanguageModelUsage, UIMessage, UIMessageChunk } from 'ai';
import type { ModelCatalogEntry } from '@vault/settings-registry';

export interface TransportDeps {
  system: string;
  prompts?: () => Promise<{ system: string; tieringNote: string }>;
  tiering: ToolTiering;
  /** Resolved fresh at each send: current picker selection (or default), live maxSteps. */
  turn: () => Promise<{ model: LanguageModel; maxSteps: number; entry: ModelCatalogEntry }>;
  /** Per-turn context block, composed into the system prompt. Errors are swallowed. */
  buildContext?: () => Promise<string>;
  /** Fires once per finished turn with the provider-reported usage — the
   *  spend-ledger hook. Errors in the callback are the callback's problem;
   *  keep it fire-and-forget. */
  onUsage?: (info: { totalUsage: LanguageModelUsage; latencyMs: number; conversationId?: string | undefined; entry: ModelCatalogEntry; billing: CallBilling }) => void;
}

/** How many conversations' fetch allowances one transport keeps. */
const MAX_FETCH_ALLOWANCES = 50;

/** Drives @vault/chat-core's runChatStream in-process so useChat needs no HTTP endpoint. */
export class InProcessChatTransport implements ChatTransport<UIMessage> {
  /**
   * Which addresses each conversation's model may fetch (#548), by chat id. Filled only
   * from what this transport witnessed: text the user submitted through it, and searches
   * run through it. Kept in memory, so stored history, which the model can write, never
   * fills it.
   */
  private readonly fetchAllowances = new Map<string, FetchAllowance>();

  constructor(private readonly deps: TransportDeps) {}

  private fetchAllowanceFor(chatId: string): FetchAllowance {
    let allowance = this.fetchAllowances.get(chatId);
    // Re-insert so the map's order is least recently used first.
    if (allowance) this.fetchAllowances.delete(chatId);
    else allowance = createFetchAllowance();
    this.fetchAllowances.set(chatId, allowance);
    while (this.fetchAllowances.size > MAX_FETCH_ALLOWANCES) {
      this.fetchAllowances.delete(this.fetchAllowances.keys().next().value as string);
    }
    return allowance;
  }

  async sendMessages(
    options: Parameters<ChatTransport<UIMessage>['sendMessages']>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const t0 = Date.now();
    const { model, maxSteps, entry } = await this.deps.turn();
    const contextBlock = this.deps.buildContext ? await this.deps.buildContext().catch(() => '') : '';
    const prompts = this.deps.prompts ? await this.deps.prompts() : { system: this.deps.system, tieringNote: '' };
    const system = composeSystem(prompts.system + prompts.tieringNote, contextBlock, undefined);
    const { tools, prepareStep } = this.deps.tiering.forRequest(options.messages);
    // Memories v3 (§3): stamp conversation provenance host-side and OVERWRITE
    // anything the model supplied — same seam and same wrapper as web chat.ts.
    const stamped = stampMemoryEvidence(tools, {
      conversationId: options.chatId ?? 'unknown',
      messageIndex: Math.max(0, options.messages.length - 1),
      service: 'chat-plugin',
    });
    // The model fetches only an address the user typed or a search returned (#548). The
    // Engine cannot apply this to the plugin's service token: it never sees the user's messages.
    const allowance = this.fetchAllowanceFor(options.chatId ?? 'unknown');
    if (options.trigger === 'submit-message') {
      // The message being submitted is the one thing here the user certainly wrote. Earlier
      // messages may have been loaded from storage, so they are not read.
      const submitted = options.messages[options.messages.length - 1];
      if (submitted?.role === 'user') {
        for (const part of submitted.parts) if (part.type === 'text') allowance.noteUserText(part.text);
      }
    }
    const guarded = guardWebFetch(stamped, allowance);
    return runChatStream({
      model,
      system,
      messages: options.messages,
      tools: guarded,
      prepareStep,
      maxSteps,
      abortSignal: options.abortSignal,
      onStepFinish: (step, writer) => {
        const w = writer as unknown as { write(p: VizDataPart): void };
        emitVizParts(w, step.toolResults, () => {}); // agent auto-pin no-ops (parity with web chat.ts); manual pin → current board is in ChatPane.handlePin
        emitSynthesizedVizParts(w, step.toolResults);
      },
      onStreamFinish: ({ steps, totalUsage }) => {
        // Each step is its own provider call: its charge and id ride on the step.
        const billing = combineBilling(steps.map(callBilling));
        this.deps.onUsage?.({ totalUsage, latencyMs: Date.now() - t0, conversationId: options.chatId, entry, billing });
      },
      onError: chatErrorText,
    });
  }

  async reconnectToStream(
    _options: Parameters<ChatTransport<UIMessage>['reconnectToStream']>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }
}
