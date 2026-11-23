import { StructuredCallFailure } from './types.js';

export function providerRequestBytes(payload: unknown): number {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error('provider request is not serializable');
  return Buffer.byteLength(serialized, 'utf8');
}

export function assertProviderRequestBytes(payload: unknown, maxBytes: number | undefined): void {
  if (maxBytes === undefined) return;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || providerRequestBytes(payload) > maxBytes) {
    throw new StructuredCallFailure('structured call failed (reason=provider_prompt_too_large)',
      undefined, 'provider_prompt_too_large');
  }
}
