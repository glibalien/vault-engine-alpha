import type { EngineSettings } from '@vault/settings-registry';

export interface ProvenanceLimits {
  requestBytes: number;
  componentBytes: number;
  itemCount: number;
  outputBytes: number;
  totalBytes: number;
  capacityBytes: number;
  leaseHours: number;
  failedRetentionDays: number;
}

export const DEFAULT_PROVENANCE_LIMITS: Readonly<ProvenanceLimits> = Object.freeze({
  requestBytes: 1024 * 1024,
  componentBytes: 256 * 1024,
  itemCount: 512,
  outputBytes: 256 * 1024,
  totalBytes: 2 * 1024 * 1024,
  capacityBytes: 1024 * 1024 * 1024,
  leaseHours: 24,
  failedRetentionDays: 7,
});

export type ProvenanceReason = 'PROVENANCE_LIMIT' | 'PROVENANCE_CAPACITY'
  | 'PROVENANCE_OBSERVATION_CHANGED' | 'PROVENANCE_KEY_CONFLICT' | 'PROVENANCE_UNAVAILABLE'
  | 'PROVENANCE_REVOKED' | 'PROVENANCE_LEASE_EXPIRED' | 'PROVENANCE_CAPTURE_UNSUPPORTED'
  | 'PURGE_SCOPE_CHANGED';

/** Deliberately contains no input, source label, SDK error or provider response. */
export class ProvenanceError extends Error {
  constructor(readonly reason: ProvenanceReason) { super(reason); }
}

export function validateLimits(limits: ProvenanceLimits): void {
  for (const key of Object.keys(DEFAULT_PROVENANCE_LIMITS) as (keyof ProvenanceLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new ProvenanceError('PROVENANCE_LIMIT');
    if (key !== 'capacityBytes' && key !== 'leaseHours' && key !== 'failedRetentionDays'
      && limits[key] > DEFAULT_PROVENANCE_LIMITS[key]) throw new ProvenanceError('PROVENANCE_LIMIT');
  }
  if (limits.componentBytes > limits.requestBytes || limits.requestBytes > limits.totalBytes
    || limits.outputBytes > limits.totalBytes || limits.capacityBytes < limits.totalBytes
    || limits.leaseHours > 168 || limits.failedRetentionDays > 365) {
    throw new ProvenanceError('PROVENANCE_LIMIT');
  }
}

export function readProvenanceLimits(settings: EngineSettings): ProvenanceLimits {
  const limits = {
    requestBytes: settings.provenanceRequestBytes,
    componentBytes: settings.provenanceComponentBytes,
    itemCount: settings.provenanceItemCount,
    outputBytes: settings.provenanceOutputBytes,
    totalBytes: settings.provenanceTotalBytes,
    capacityBytes: settings.provenanceCapacityBytes,
    leaseHours: settings.provenanceLeaseHours,
    failedRetentionDays: settings.provenanceFailedRetentionDays,
  };
  validateLimits(limits);
  return limits;
}
