import type { Engine } from './engine.js';
import { homeEvidenceNodeIds } from './evidence.js';

type ObservedEvidence = Awaited<ReturnType<Engine['projectEvidence']>>;

/** Re-read selected observations and evidence together; never attach new tokens
 * to an old snapshot. Bounded retries tolerate a changing rendered source set. */
export async function completeHomeEvidenceObservations(
  engine: Pick<Engine, 'projectEvidence'>,
  evidence: ObservedEvidence,
  project: string,
  meetingReads: number,
  since?: string,
  selectNodeIds: (evidence: ObservedEvidence) => string[] = homeEvidenceNodeIds,
): Promise<ObservedEvidence> {
  let current = evidence;
  for (let attempt = 0; attempt <= 3; attempt++) {
    const selected = selectNodeIds(current);
    if (selected.length > 512) throw new Error('PROVENANCE_LIMIT');
    if (selected.every(id => current.provenance_observations?.nodes[id])) return current;
    if (attempt === 3) break;
    current = await engine.projectEvidence(project, meetingReads, since, {
      includeProvenance: true, provenanceNodeIds: selected,
    });
  }
  throw new Error('PROVENANCE_OBSERVATION_MISSING');
}
