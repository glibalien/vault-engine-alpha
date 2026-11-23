import type { Issue as EnvelopeIssue } from '@vault/contract';

// Re-exported under the local name so call-sites can keep importing EnvelopeIssue.
export type { EnvelopeIssue };

/** Pull warnings out of a tool output envelope, if it looks like one. */
export function envelopeWarnings(output: unknown): EnvelopeIssue[] {
  if (typeof output !== 'object' || output === null) return [];
  const w = (output as { warnings?: unknown }).warnings;
  return Array.isArray(w) ? (w as EnvelopeIssue[]) : [];
}

export function envelopeOk(output: unknown): boolean {
  return typeof output === 'object' && output !== null && (output as { ok?: unknown }).ok === true;
}

export function envelopeMs(output: unknown): number | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const ms = (output as { _ms?: unknown })._ms;
  return typeof ms === 'number' ? ms : undefined;
}
