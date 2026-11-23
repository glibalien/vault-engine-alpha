import type { UsagePurpose } from '@vault/contract';
import type { ModelProvider } from '@vault/settings-registry';
import { AsyncLocalStorage } from 'node:async_hooks';
import { providerKeyRef } from '@vault/llm';
import type { LlmKeys } from './config.js';
import type { Engine } from './engine.js';
import { StructuredCallFailure } from './llm/types.js';
import { buildWikiCallMetadata, safeDiagnostics } from './llm/diagnostics.js';
import type { LlmClient, LlmConfiguration, StructuredCallRequest, StructuredCallResult } from './llm/types.js';

/** The fingerprint to report with OpenRouter calls, when this process has that key. */
export function openRouterKeyRef(llmKeys: LlmKeys): string | undefined {
  return llmKeys.keys.openrouter ? providerKeyRef(llmKeys.keys.openrouter) : undefined;
}

export interface UsageRunContext {
  project: string;
  runRef: string;
  /** Spend-ledger purpose for calls under this context; default 'wiki-synthesis'. Typed from the
   *  Engine's list, because record-usage rejects any other value and the spend is then lost. */
  purpose?: UsagePurpose;
}

type UsageProvider = ModelProvider | ((model: string) => ModelProvider);

/** How long `flush()` waits for pending ledger writes by default. */
export const USAGE_FLUSH_TIMEOUT_MS = 5_000;

/**
 * Wraps the LlmClient at the composition root and reports every structuredCall
 * to the engine's spend ledger (record-usage), best-effort. curateProject stays
 * pure of observability — per-run attribution is threaded via setContext from
 * the timed wrappers in core.ts (safe: the CurationQueue serializes runs).
 * Writes are not awaited by the call they report; a CLI awaits `flush()` before
 * closing the Engine so the last call's row isn't lost (#386).
 */
export class UsageReporter {
  private ctx: UsageRunContext | null = null;
  private readonly sweep = new AsyncLocalStorage<{ ref: string; trigger: string }>();
  private readonly scoped = new AsyncLocalStorage<UsageRunContext>();
  private readonly pending = new Set<Promise<void>>();

  /** Async scope survives the queue without leaking into concurrent on-demand jobs. */
  withSweep<T>(context: { ref: string; trigger: string }, work: () => Promise<T>): Promise<T> {
    return this.sweep.run(context, work);
  }

  /** Attributes the calls made inside `work` to `context` without touching the shared
   *  `setContext` slot, so a paid call made outside the queue can't relabel a running curation's calls. */
  withContext<T>(context: UsageRunContext, work: () => Promise<T>): Promise<T> {
    return this.scoped.run(context, work);
  }

  constructor(
    private readonly engine: Pick<Engine, 'recordUsage'>,
    private readonly opts: {
      /** Fixed label (single-provider processes) or a per-call resolver keyed
       *  off the routed model (dispatching client, Task 6+). */
      provider: UsageProvider;
      experiment: string | null;
      variant: string | null;
      /** Fingerprint of the OpenRouter key this process calls with, so reconciliation can tell it
       *  from the Engine's when they differ (#345). */
      openRouterKeyRef?: string | undefined;
    },
  ) {}

  setContext(ctx: UsageRunContext | null): void {
    this.ctx = ctx;
  }

  /**
   * Waits for the ledger writes already started, for at most `timeoutMs`. Never throws:
   * a failed write was already logged, and a write still pending at the deadline is left
   * behind with a warning, so a hung Engine can't hang the caller.
   */
  async flush(timeoutMs = USAGE_FLUSH_TIMEOUT_MS): Promise<void> {
    if (this.pending.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    try {
      while (this.pending.size > 0) {
        const settled = Promise.allSettled([...this.pending]).then(() => 'settled' as const);
        if (await Promise.race([settled, deadline]) === 'timeout') {
          console.warn(`[curator] usage flush timed out; ${this.pending.size} write(s) still pending`);
          return;
        }
      }
    } catch {
      console.warn('[curator] usage flush failed');
    } finally {
      clearTimeout(timer);
    }
  }

  wrap(llm: LlmClient, provider: UsageProvider = this.opts.provider): LlmClient {
    return {
      ...(llm.configurationFor ? { configurationFor: llm.configurationFor.bind(llm) } : {}),
      ...(llm.withConfiguration ? { withConfiguration: (configuration: LlmConfiguration) =>
        this.wrap(llm.withConfiguration!(configuration), configuration.provider) } : {}),
      supportsPreparedCapture: llm.supportsPreparedCapture,
      ...(llm.previewStructuredCall ? { previewStructuredCall: llm.previewStructuredCall.bind(llm) } : {}),
      structuredCall: async (req: StructuredCallRequest): Promise<StructuredCallResult> => {
        const t0 = Date.now();
        const context = this.scoped.getStore() ?? this.ctx;
        let res: StructuredCallResult;
        try {
          res = await llm.structuredCall(req);
        } catch (error) {
          try {
            if (error instanceof StructuredCallFailure && (error.usage !== undefined
              || safeDiagnostics(error.diagnostics)?.responses.some(r => r.providerCostUsd !== undefined))) {
              this.report(req, { output: undefined, usage: error.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                ...(error.usage === undefined ? { usageKnown: false } : {}), diagnostics: error.diagnostics }, t0, provider, context, 'failed', error.reason);
            } else if (req.wikiContext) {
              console.warn('[curator] wiki call usage unavailable', JSON.stringify(buildWikiCallMetadata(req.wikiContext,
                error instanceof StructuredCallFailure ? error.diagnostics : undefined, false, 'failed',
                error instanceof StructuredCallFailure ? error.reason : undefined)));
            }
          } catch {
            console.warn('[curator] usage attribution failed');
          }
          throw error;
        }
        try {
          this.report(req, res, t0, provider, context);
        } catch {
          console.warn('[curator] usage attribution failed');
        }
        return res;
      },
    };
  }

  private report(
    req: StructuredCallRequest,
    res: StructuredCallResult,
    startedAt: number,
    providerForCall: UsageProvider,
    context: UsageRunContext | null,
    outcome: 'returned' | 'failed' = 'returned',
    reason?: import('./llm/types.js').StructuredCallFailureReason,
  ): void {
    const model = req.model;
    const diagnostics = safeDiagnostics(res.diagnostics);
    const wikiMetadata = req.wikiContext
      ? buildWikiCallMetadata(req.wikiContext, diagnostics, res.usageKnown !== false, outcome, reason) : undefined;
    const singleResponse = diagnostics?.adapterAttempts === 1 && diagnostics.sdkAttempts === 1
      && diagnostics.responses.length === 1 ? diagnostics.responses[0] : undefined;
    const u = res.usage;
    const provider = typeof providerForCall === 'function' ? providerForCall(model) : providerForCall;
    const responses = diagnostics?.responses ?? [];
    const allResponses = responses.length > 0 && responses.length === diagnostics?.adapterAttempts;
    const costsKnown = provider === 'openrouter' && allResponses && responses.every(r => r.providerCostUsd !== undefined);
    const providerCost = costsKnown ? responses.reduce((sum, r) => sum + r.providerCostUsd!, 0) : undefined;
    if (res.usageKnown === false && providerCost === undefined) {
      console.warn('[curator] call usage unavailable');
      return;
    }
    const models = [...new Set(responses.map(r => r.reportedModel).filter(Boolean))];
    const reportedModel = allResponses && responses.every(r => r.reportedModel) && models.length === 1 ? models[0] : undefined;
    const sweep = this.sweep.getStore();
    const metadata = { ...wikiMetadata, curator_usage: {
      version: 1, ...(sweep ? { sweep_ref: sweep.ref, trigger: sweep.trigger } : {}),
      stage: req.wikiContext?.stage ?? context?.purpose ?? 'unknown', outcome,
      ...(reason ? { reason } : {}), ...(reportedModel ? { reported_model: reportedModel } : {}),
      response_count: responses.length,
      usage_complete: res.usageKnown !== false && allResponses && responses.every(r => r.usageKnown)
        && diagnostics?.sdkAttempts === diagnostics?.adapterAttempts,
      ...(allResponses && responses.every(r => r.reasoningTokens !== undefined)
        ? { reasoning_tokens: responses.reduce((sum, r) => sum + r.reasoningTokens!, 0) } : {}),
      ...(diagnostics ? { diagnostics } : {}),
    } };
    const args: Record<string, unknown> = {
      provider,
      service: 'curator',
      purpose: context?.purpose ?? 'wiki-synthesis',
      model,
      ts: new Date(startedAt).toISOString(),
      ...(providerCost !== undefined && Number.isFinite(providerCost) ? { provider_cost_usd: providerCost } : {}),
      ...(res.usageKnown === false ? {} : { input_tokens: u.input, output_tokens: u.output,
        cache_read_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite }),
      latency_ms: Date.now() - startedAt,
      ...(metadata ? { metadata } : {}),
      ...(singleResponse?.requestId ? { request_id: singleResponse.requestId } : {}),
      ...(provider === 'openrouter' && this.opts.openRouterKeyRef ? { key_ref: this.opts.openRouterKeyRef } : {}),
      ...(context !== null ? { run_ref: context.runRef, source_ref: context.project } : {}),
      ...(this.opts.experiment !== null ? { experiment: this.opts.experiment } : {}),
      ...(this.opts.variant !== null ? { variant: this.opts.variant } : {}),
    };
    const write = this.engine.recordUsage(args).catch((error: unknown) => {
      // Only the Engine's error code, so a refused row is diagnosable: an INVALID_PARAMS here meant
      // a purpose the ledger doesn't accept (#372). The message stays out, because it can carry request text.
      const code = (error as { code?: unknown } | null)?.code;
      const suffix = typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? ` (${code})` : '';
      console.warn(`[curator] usage persistence failed${suffix}`);
    });
    this.pending.add(write);
    const settle = (): void => { this.pending.delete(write); };
    void write.then(settle, settle);
  }
}
