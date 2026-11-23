import type { ProvenanceFlow } from './types.js';

export function producerForFlow(flow: ProvenanceFlow): 'curator-home-v1' | 'curator-subpage-v1' {
  return flow === 'project-home-v1' ? 'curator-home-v1' : 'curator-subpage-v1';
}
