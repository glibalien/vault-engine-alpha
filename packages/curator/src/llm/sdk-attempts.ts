import { AsyncLocalStorage } from 'node:async_hooks';

/** HTTP requests a provider SDK sent inside one counted call, its own retries included. */
export interface SdkAttemptTally {
  count: number;
}

const current = new AsyncLocalStorage<SdkAttemptTally>();

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * A `fetch` for provider SDK clients that counts every request sent inside
 * {@link countSdkAttempts}. The OpenAI and Anthropic SDKs retry transient
 * errors on their own; counting their requests is how a call's diagnostics know
 * whether its reported usage covers every attempt (#321). Requests outside a
 * counted call pass through untouched.
 */
export function countingFetch(base?: Fetch): Fetch {
  return (input, init) => {
    const tally = current.getStore();
    if (tally !== undefined) tally.count += 1;
    return (base ?? globalThis.fetch)(input, init);
  };
}

/** Run one SDK call with its requests counted into `tally`. */
export function countSdkAttempts<T>(tally: SdkAttemptTally, run: () => Promise<T>): Promise<T> {
  return current.run(tally, run);
}
