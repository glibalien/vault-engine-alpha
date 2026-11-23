import { PROVIDERS, type ModelProvider } from '@vault/settings-registry';
import type { LlmKeys } from './config.js';
import { SPEND_LIMIT_TEXT, safeDiagnostics } from './llm/diagnostics.js';
import { providerRejectionSummary } from './llm/openai-compat.js';
import { StructuredCallFailure } from './llm/types.js';

/**
 * A provider refused, or would refuse, a call because its key's spend limit or the account's
 * credit has run out (#342). It is a budget refusal like the Curator's own daily cap: a wiki
 * run it stops is skipped for budget rather than failed (so no failure hold), and a per-item
 * sweep stage stops on it and leaves the rest for a later run.
 */
export class ProviderSpendLimitError extends Error {
  override readonly name = 'ProviderSpendLimitError';
  readonly code = 'PROVIDER_SPEND_LIMIT';
  constructor(message: string, readonly provider: ModelProvider, readonly resetsAt: string | null, options?: ErrorOptions) {
    super(message, options);
  }
}

export type LimitReset = 'daily' | 'weekly' | 'monthly';

/** A key's spend limit as its provider reports it. */
export interface ProviderKeyStatus {
  /** The limit for the period in USD; null when the key has none. */
  readonly limitUsd: number | null;
  /** What is left of it in USD; null when the key has no limit or the provider didn't say. */
  readonly remainingUsd: number | null;
  readonly reset: LimitReset | null;
}

export type ProviderKeyReader = () => Promise<ProviderKeyStatus>;

const READ_TIMEOUT_MS = 10_000;

function usdOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** OpenRouter's `GET /key` for the calling key: its limit, what remains and its reset period.
 *  The inference key may read its own status; no management key is needed. */
export function openRouterKeyReader(apiKey: string, baseURL: string, fetchFn: typeof fetch = fetch): ProviderKeyReader {
  return async () => {
    const res = await fetchFn(`${baseURL.replace(/\/+$/, '')}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = ((await res.json()) as { data?: Record<string, unknown> } | null)?.data;
    if (data === null || typeof data !== 'object') throw new Error('no data in the response');
    const limitUsd = usdOrNull(data.limit);
    const reset = data.limit_reset === 'daily' || data.limit_reset === 'weekly' || data.limit_reset === 'monthly'
      ? data.limit_reset : null;
    return { limitUsd, remainingUsd: limitUsd === null ? null : usdOrNull(data.limit_remaining), reset };
  };
}

/** Status readers for the configured providers that report a key's limit (OpenRouter today). */
export function providerKeyReaders(llmKeys: LlmKeys | undefined, fetchFn: typeof fetch = fetch): Partial<Record<ModelProvider, ProviderKeyReader>> {
  const key = llmKeys?.keys?.openrouter;
  if (!key) return {};
  return { openrouter: openRouterKeyReader(key, llmKeys?.baseURLs?.openrouter ?? PROVIDERS.openrouter.baseURL, fetchFn) };
}

/** When a period limit next resets: midnight UTC, weeks running Monday to Sunday. */
export function nextResetAt(reset: LimitReset, now: Date): Date {
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  if (reset === 'daily') return new Date(Date.UTC(y, m, d + 1));
  if (reset === 'monthly') return new Date(Date.UTC(y, m + 1, 1));
  const toMonday = (8 - now.getUTCDay()) % 7 || 7;
  return new Date(Date.UTC(y, m, d + toMonday));
}

const RESET_TEXT = /resets (?:at )?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i;
const PERIOD_TEXT = /\((daily|weekly|monthly) limit\)/i;
/** How long a stop lasts when nothing says when the limit resets. A status read showing money left
 *  clears it sooner; the bound keeps recovery from depending on the status endpoint. */
const UNKNOWN_RESET_MS = 60 * 60_000;

/** An identifier-shaped error code (e.g. OpenAI's `insufficient_quota`), or undefined. */
function codeOf(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : undefined;
}

/** The HTTP status of a failed call, the provider's text when the error kept it, and whether
 *  the adapter marked it a spend limit before redacting it. */
function failureFacts(error: unknown): { status: number | undefined; text: string | undefined; marked: boolean } {
  try {
    let current = error;
    for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth++) {
      const status = (current as { status?: unknown }).status;
      if (typeof status === 'number') {
        const message = (current as { message?: unknown }).message;
        const text = providerRejectionSummary(current) ?? (typeof message === 'string' ? message : undefined);
        const code = codeOf(current) ?? codeOf((current as { error?: unknown }).error);
        return { status, text: [text, code].filter(part => part !== undefined).join(' ') || undefined, marked: false };
      }
      if (current instanceof StructuredCallFailure) {
        // A fail-closed call keeps no provider text, only scalars: the status, any error code, and
        // the adapter's spend-limit flag.
        const failed = safeDiagnostics(current.diagnostics)?.failure;
        if (failed?.kind === 'http' && failed.status !== undefined) {
          return { status: failed.status, text: failed.code, marked: failed.spendLimit === true };
        }
      }
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // A hostile error object says nothing about a spend limit.
  }
  return { status: undefined, text: undefined, marked: false };
}

function label(provider: ModelProvider): string {
  return PROVIDERS[provider]?.label ?? provider;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

interface StatusEntry {
  status: ProviderKeyStatus | null;
  readAt: number;
  /** What settled calls cost since the read, which the read can't include yet. */
  spentSinceRead: number;
  /** Worst cases held by admitted calls that have not settled. */
  reserved: number;
  pending: Promise<ProviderKeyStatus | null> | null;
}

interface Stop {
  readonly message: string;
  readonly setAt: number;
  /** When the provider resets the limit, or a bounded retry time when nothing says. */
  readonly until: number;
}

/**
 * Process-wide view of the providers' own spend limits, beside the Curator's daily budget.
 *
 * - **Stops.** A call the provider refused for a spent key limit or empty account stops every
 *   later call to that provider before dispatch, until the limit resets (the time the provider
 *   gave, else the key's period) or a fresh status read shows money left (the owner raised it).
 * - **Remaining allowance.** Where the provider reports the key's limit, a call is admitted only
 *   if its worst case fits what remains: the last read, less what calls cost since, less the
 *   calls in flight. Reads are cached for `ttlMs`. A failed read admits calls (fail open): the
 *   provider still enforces its own limit, and a refusal sets a stop.
 */
export class ProviderLimits {
  private readonly entries = new Map<ModelProvider, StatusEntry>();
  private readonly stops = new Map<ModelProvider, Stop>();

  constructor(private readonly readers: Partial<Record<ModelProvider, ProviderKeyReader>>,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = 5 * 60_000,
    private readonly warn: (message: string) => void = message => console.warn(`[curator] ${message}`)) {}

  /** The provider's key status, from cache while fresh; null when unknown. */
  private async status(provider: ModelProvider, force = false): Promise<{ status: ProviderKeyStatus | null; readAt: number } | null> {
    const reader = this.readers[provider];
    if (!reader) return null;
    const entry = this.entries.get(provider);
    if (entry?.pending) await entry.pending;
    else if (force || !entry || this.stale(entry)) await this.read(provider, reader);
    const current = this.entries.get(provider);
    return current ? { status: current.status, readAt: current.readAt } : null;
  }

  /** A reading is stale after the cache time, or once the key's period has reset since it was taken. */
  private stale(entry: StatusEntry): boolean {
    const now = this.now().getTime();
    if (now - entry.readAt >= this.ttlMs) return true;
    const reset = entry.status?.reset;
    return reset !== null && reset !== undefined && now >= nextResetAt(reset, new Date(entry.readAt)).getTime();
  }

  private async read(provider: ModelProvider, reader: ProviderKeyReader): Promise<void> {
    const before = this.entries.get(provider);
    const entry: StatusEntry = before ?? { status: null, readAt: 0, spentSinceRead: 0, reserved: 0, pending: null };
    this.entries.set(provider, entry);
    const pending = reader().then(status => status, (error: unknown) => {
      this.warn(`${label(provider)} key status unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    entry.pending = pending;
    try {
      const status = await pending;
      entry.status = status;
      entry.readAt = this.now().getTime();
      entry.spentSinceRead = 0;
    } finally {
      entry.pending = null;
    }
  }

  /** The active stop's message, after expiring it or clearing it on a fresh read that shows money left. */
  private async activeStop(provider: ModelProvider): Promise<Stop | null> {
    const stop = this.stops.get(provider);
    if (!stop) return null;
    if (this.now().getTime() >= stop.until) {
      this.stops.delete(provider);
      return null;
    }
    const read = await this.status(provider);
    const remaining = read?.status?.remainingUsd;
    if (read && read.readAt > stop.setAt && read.status !== null && (remaining === null || (remaining ?? 0) > 0)) {
      this.stops.delete(provider);
      return null;
    }
    return stop;
  }

  private refusal(provider: ModelProvider, stop: Stop): ProviderSpendLimitError {
    return new ProviderSpendLimitError(stop.message, provider, new Date(stop.until).toISOString());
  }

  /** Holds the call's worst case against the key's remaining allowance; returns the amount to pass
   *  to `settle`. Throws ProviderSpendLimitError when the provider is stopped or the call won't fit. */
  async admit(provider: ModelProvider | null, worstCaseUsd: number): Promise<number> {
    if (provider === null) return 0;
    const stop = await this.activeStop(provider);
    if (stop) throw this.refusal(provider, stop);
    const read = await this.status(provider);
    const status = read?.status;
    const entry = this.entries.get(provider);
    if (!status || status.remainingUsd === null || !entry) return 0;
    const left = status.remainingUsd - entry.spentSinceRead - entry.reserved;
    if (worstCaseUsd > left || left <= 0) {
      const resets = status.reset ? `; resets ${nextResetAt(status.reset, this.now()).toISOString()}` : '';
      throw new ProviderSpendLimitError(`${label(provider)} key limit: ${usd(Math.max(left, 0))} left`
        + `${status.limitUsd !== null ? ` of ${usd(status.limitUsd)}${status.reset ? ` ${status.reset}` : ''}` : ''}; `
        + `this call could cost up to $${worstCaseUsd.toFixed(4)}${resets}`, provider,
        status.reset ? nextResetAt(status.reset, this.now()).toISOString() : null);
    }
    entry.reserved += worstCaseUsd;
    return worstCaseUsd;
  }

  /** Releases an admitted call's hold and counts what it cost; an unknown cost counts its hold. */
  settle(provider: ModelProvider | null, heldUsd: number, costUsd: number | null): void {
    if (provider === null) return;
    const entry = this.entries.get(provider);
    if (!entry) return;
    entry.reserved = Math.max(0, entry.reserved - heldUsd);
    const cost = costUsd ?? heldUsd;
    if (Number.isFinite(cost) && cost > 0) entry.spentSinceRead += cost;
  }

  /**
   * The spend-limit refusal behind a failed call, or null. The provider's wording or an HTTP 402
   * says so directly. A bare 403 (a fail-closed call keeps no text) counts only when a fresh
   * status read shows the key has nothing left, since a 403 can also mean moderation or access.
   * A recognized refusal stops the provider until the limit resets.
   */
  async classify(provider: ModelProvider | null, error: unknown): Promise<ProviderSpendLimitError | null> {
    if (provider === null) return null;
    const { status, text, marked } = failureFacts(error);
    if (status === undefined) return null;
    let keyStatus: ProviderKeyStatus | null = null;
    let confirmed = status === 402 || marked || (text !== undefined && SPEND_LIMIT_TEXT.test(text));
    if (status === 403 || confirmed) {
      try {
        keyStatus = (await this.status(provider, true))?.status ?? null;
      } catch {
        keyStatus = null;
      }
      if (!confirmed) confirmed = keyStatus?.remainingUsd !== null && keyStatus?.remainingUsd !== undefined
        && keyStatus.remainingUsd <= 0;
    }
    if (!confirmed) return null;
    const now = this.now();
    const fromText = text?.match(RESET_TEXT)?.[1];
    const period = keyStatus?.reset ?? (text?.match(PERIOD_TEXT)?.[1]?.toLowerCase() as LimitReset | undefined) ?? null;
    const parsed = fromText ? Date.parse(fromText) : Number.NaN;
    const until = Number.isFinite(parsed) && parsed > now.getTime() ? parsed
      : period ? nextResetAt(period, now).getTime() : now.getTime() + UNKNOWN_RESET_MS;
    const limit = keyStatus?.limitUsd !== null && keyStatus?.limitUsd !== undefined
      ? ` (${usd(keyStatus.limitUsd)}${period ? ` ${period}` : ''} limit)` : period ? ` (${period} limit)` : '';
    const message = `${label(provider)} refused calls: key spend limit or credit reached${limit}`
      + `; ${period || fromText ? 'resets' : 'retried after'} ${new Date(until).toISOString()}`;
    const stop: Stop = { message, setAt: now.getTime(), until };
    this.stops.set(provider, stop);
    this.warn(message);
    return new ProviderSpendLimitError(message, provider, new Date(until).toISOString(), { cause: error });
  }

  /** The first stop among `providers`, or a key with nothing left; null when all may be called. */
  async spentDetail(providers: readonly ModelProvider[]): Promise<string | null> {
    for (const provider of new Set(providers)) {
      const stop = await this.activeStop(provider);
      if (stop) return stop.message;
      const status = (await this.status(provider))?.status;
      const entry = this.entries.get(provider);
      if (status?.remainingUsd !== null && status?.remainingUsd !== undefined && entry
        && status.remainingUsd - entry.spentSinceRead - entry.reserved <= 0) {
        return `${label(provider)} key limit spent${status.reset ? `; resets ${nextResetAt(status.reset, this.now()).toISOString()}` : ''}`;
      }
    }
    return null;
  }

  /** For curator-status: each provider's known limit, what remains and any stop. */
  async report(providers: readonly ModelProvider[]): Promise<Array<Record<string, string | number | null>>> {
    const rows: Array<Record<string, string | number | null>> = [];
    for (const provider of new Set(providers)) {
      const stop = await this.activeStop(provider);
      const status = (await this.status(provider))?.status ?? null;
      if (!stop && (status === null || status.limitUsd === null)) continue;
      const entry = this.entries.get(provider);
      const remaining = status?.remainingUsd === null || status?.remainingUsd === undefined || !entry ? null
        : Math.round(Math.max(0, status.remainingUsd - entry.spentSinceRead) * 1e6) / 1e6;
      rows.push({
        provider, limit_usd: status?.limitUsd ?? null, remaining_usd: remaining, reset: status?.reset ?? null,
        resets_at: status?.reset ? nextResetAt(status.reset, this.now()).toISOString() : null,
        stopped: stop?.message ?? null,
      });
    }
    return rows;
  }
}
