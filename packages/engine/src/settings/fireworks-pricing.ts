import { pricingForExact } from '@vault/pricing';
import type { ModelEntryPricing } from '@vault/settings-registry';

const MODEL_ID = /^accounts\/fireworks\/models\/([a-z0-9][a-z0-9_-]*)$/;
const MAX_BODY_BYTES = 1_048_576;
const MAX_CONCURRENT = 4;
const MAX_PENDING = 200;
const MAX_CACHE_ENTRIES = 256;
const TIMEOUT_MS = 5_000; // Includes time waiting for a network slot and reading the body.
const CACHE_TTL_MS = 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 1000;

/** Strict adapter for the public rendered model card, verified 2026-09-13.
 * A changed shape, unit, ordering, or identity must fail closed. No aliases,
 * parameter-count estimates, script execution, or rates from other page sections.
 */
export function parseFireworksPricing(html: string, model: string): ModelEntryPricing | null {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const identities = [...text.matchAll(/model path:\s*(\S+)/g)];
  if (identities.length !== 1 || identities[0]![1] !== model) return null;
  if (text.split('Available Serverless').length !== 2) return null;
  const card = text.match(/Available Serverless Run queries immediately, pay only for usage (.*?) Per 1M Tokens \((input\/cached input\/output|input\/output)\)/);
  if (!card) return null;
  const rates = card[1]!.split(/\s*\/\s*/);
  if (rates.length !== (card[2] === 'input/output' ? 2 : 3)) return null;
  if (!rates.every(rate => /^\$\s*\d+(?:\.\d+)?$/.test(rate))) return null;
  const values = rates.map(rate => Number(rate.replace(/^\$\s*/, '')));
  if (!values.every(value => Number.isFinite(value) && value >= 0)) return null;
  return {
    input: values[0]!, output: values.at(-1)!,
    ...(values.length === 3 ? { cacheRead: values[1]! } : {}),
  };
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new Error('Pricing page unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error('Pricing page too large');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

type Pricing = ModelEntryPricing | null;
type Job = () => void;

/** Shared per fetch implementation (normally the process fetch), across MCP sessions.
 * Only completed values occupy the bounded cache. Outstanding jobs have a deadline
 * and a separate cap; a hung source can never make pricing a tool failure.
 */
export class FireworksPricingResolver {
  private readonly cache = new Map<string, { value: Pricing; expires: number }>();
  private readonly inFlight = new Map<string, Promise<Pricing>>();
  private readonly queue: Job[] = [];
  private active = 0;

  constructor(private readonly fetchImpl: typeof fetch) {}

  async resolve(model: string, fresh = false): Promise<Pricing> {
    const match = MODEL_ID.exec(model);
    if (!match) return null;
    // An add that overlaps discovery must start its own fetch AFTER that discovery,
    // rather than persisting a response from a request that preceded the add.
    if (fresh) await this.inFlight.get(model);
    const pending = this.inFlight.get(model);
    if (pending) return this.copy(await pending);
    const cached = this.cache.get(model);
    if (!fresh && cached && cached.expires > Date.now()) return this.copy(cached.value);
    if (this.inFlight.size >= MAX_PENDING) return this.cacheResult(model, null);

    let complete!: (value: Pricing) => void;
    const promise = new Promise<Pricing>(resolve => { complete = resolve; });
    this.inFlight.set(model, promise);
    const controller = new AbortController();
    let finished = false;
    const finish = (live: Pricing): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const value = this.cacheResult(model, live);
      this.inFlight.delete(model);
      complete(value);
    };
    const job = (): void => {
      this.active++;
      void (async () => {
        try {
          // Public website only; never send the Models API bearer token or follow
          // redirects to another identity/source (including renamed model pages).
          const response = await this.fetchImpl(`https://fireworks.ai/models/fireworks/${match[1]}`, {
            redirect: 'error', signal: controller.signal,
          });
          finish(parseFireworksPricing(await readBoundedBody(response), model));
        } catch {
          finish(null);
        } finally {
          // Even non-2xx responses can have a streaming body. Close it before
          // releasing the network slot, including paths that never read it.
          controller.abort();
          this.active--;
          this.drain();
        }
      })();
    };
    const timer = setTimeout(() => {
      const queued = this.queue.indexOf(job);
      if (queued !== -1) this.queue.splice(queued, 1);
      controller.abort();
      finish(null);
    }, TIMEOUT_MS);
    this.queue.push(job);
    this.drain();
    return this.copy(await promise);
  }

  // Every failed refresh, including admission failure, supersedes stale live rates.
  private cacheResult(model: string, live: Pricing): Pricing {
    const value = live ?? pricingForExact(model);
    this.cache.delete(model);
    this.cache.set(model, { value, expires: Date.now() + (live ? CACHE_TTL_MS : MISS_TTL_MS) });
    if (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    return this.copy(value);
  }

  private copy(value: Pricing): Pricing { return value ? { ...value } : null; }

  private drain(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length) this.queue.shift()!();
  }
}

const resolvers = new WeakMap<typeof fetch, FireworksPricingResolver>();
export function fireworksPricingResolver(fetchImpl: typeof fetch): FireworksPricingResolver {
  let resolver = resolvers.get(fetchImpl);
  if (!resolver) {
    resolver = new FireworksPricingResolver(fetchImpl);
    resolvers.set(fetchImpl, resolver);
  }
  return resolver;
}
