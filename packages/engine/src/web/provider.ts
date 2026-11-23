// packages/engine/src/web/provider.ts
import { WebError } from './errors.js';
import type { UsageRecorder } from '../usage/recorder.js';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
}

export interface WebSearchProvider {
  readonly name: string;
  search(query: string, opts: { numResults: number; signal?: AbortSignal }): Promise<WebSearchResult[]>;
}

const EXA_ENDPOINT = 'https://api.exa.ai/search';
const SEARCH_TIMEOUT_MS = 15_000;
const SNIPPET_MAX_CHARS = 1500;

export class ExaSearchProvider implements WebSearchProvider {
  readonly name = 'exa';

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly recorder?: UsageRecorder,
  ) {}

  async search(query: string, opts: { numResults: number; signal?: AbortSignal }): Promise<WebSearchResult[]> {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(EXA_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
        body: JSON.stringify({
          query,
          numResults: opts.numResults,
          contents: { text: { maxCharacters: SNIPPET_MAX_CHARS } },
        }),
        signal: opts.signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new WebError('UPSTREAM_ERROR', `Exa search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new WebError('UPSTREAM_ERROR', `Exa search failed: HTTP ${res.status}`);
    const body = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string }>;
      costDollars?: { total?: number };
      requestId?: string;
    };
    this.recorder?.record({
      provider: 'exa',
      service: 'engine',
      purpose: 'web-search',
      // Omit rather than default to 0: a missing cost is unknown, not free.
      // Passing 0 records cost_basis 'provider-reported', i.e. the ledger
      // asserting Exa told us the call was free. Omitting it prices as
      // 'unpriced', which is what we actually know.
      ...(typeof body.costDollars?.total === 'number' ? { providerCostUsd: body.costDollars.total } : {}),
      sourceRef: query,
      latencyMs: Date.now() - t0,
      ...(body.requestId !== undefined ? { requestId: body.requestId } : {}),
    });
    return (body.results ?? []).map((r) => {
      const result: WebSearchResult = {
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: (r.text ?? '').slice(0, SNIPPET_MAX_CHARS),
      };
      if (r.publishedDate) result.published = r.publishedDate;
      return result;
    });
  }
}
