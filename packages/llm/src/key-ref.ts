import { createHash } from 'node:crypto';

/** A short one-way fingerprint of an API key, for telling keys apart in the spend ledger
 *  without storing them. Engine and Curator must compute it the same way. */
export function providerKeyRef(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}
