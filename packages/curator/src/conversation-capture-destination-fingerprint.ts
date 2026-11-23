import { createHash } from 'node:crypto';
import type { CapturePlannerDestinationRecord } from './conversation-capture-prompts.js';

export type { CapturePlannerDestinationRecord } from './conversation-capture-prompts.js';

export type DestinationProtectionReason =
  | 'settings-path'
  | 'schema-path'
  | 'projection-field';

export type DestinationDecisionEvidenceV1 =
  | {
      nodeId: string;
      state: 'eligible';
      plannerRecord: CapturePlannerDestinationRecord;
    }
  | {
      nodeId: string;
      state: 'protected';
      reason: DestinationProtectionReason;
    };

export interface DestinationDecisionFingerprint {
  version: 1;
  hash: string;
}

export const DESTINATION_DECISION_EVIDENCE_VERSION = 1 as const;

function validateUniqueDestinations(destinations: readonly DestinationDecisionEvidenceV1[]): void {
  const seen = new Set<string>();
  for (const destination of destinations) {
    if (seen.has(destination.nodeId)) throw new Error(`duplicate destination node ID: ${destination.nodeId}`);
    seen.add(destination.nodeId);
    if (destination.state === 'eligible' && destination.plannerRecord.id !== destination.nodeId) {
      throw new Error('eligible planner record ID must match destination node ID');
    }
  }
}

function canonicalDestination(destination: DestinationDecisionEvidenceV1): DestinationDecisionEvidenceV1 {
  if (destination.state === 'eligible') {
    return {
      nodeId: destination.nodeId,
      state: 'eligible',
      plannerRecord: {
        id: destination.plannerRecord.id,
        title: destination.plannerRecord.title,
        filePath: destination.plannerRecord.filePath,
        bodyExcerpt: destination.plannerRecord.bodyExcerpt,
      },
    };
  }
  return {
    nodeId: destination.nodeId,
    state: 'protected',
    reason: destination.reason,
  };
}

export function destinationDecisionFingerprint(
  evidence: readonly DestinationDecisionEvidenceV1[],
): DestinationDecisionFingerprint {
  const destinations = [...evidence].sort((left, right) => (
    left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0
  ));
  validateUniqueDestinations(destinations);
  const payload = {
    version: DESTINATION_DECISION_EVIDENCE_VERSION,
    destinations: destinations.map(canonicalDestination),
  };
  return {
    version: DESTINATION_DECISION_EVIDENCE_VERSION,
    hash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}
