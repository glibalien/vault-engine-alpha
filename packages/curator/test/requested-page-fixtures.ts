import { randomUUID } from 'node:crypto';
import type { ActivePageRequestExecution } from '../src/db/request-execution.js';
const now = () => Date.now();
export function active(over: Partial<ActivePageRequestExecution> = {}): ActivePageRequestExecution {
  const started = now();
  const generatedAt = new Date(started).toISOString();
  return {
    version: 1, generation: randomUUID(), projectId: 'project-1', runRef: randomUUID(), generatedAt,
    expiresAt: new Date(started + 60_000).toISOString(), phase: 'prepared',
    request: { title: 'Decisions', brief: 'Record decisions.' },
    snapshot: {
      config: {
        model: 'test-model', homeMaxTokens: 1000, bodyCharCap: 1000,
        semanticGapFillLimit: 2, curatorRequestedPagePrompt: 'Requested prompt',
        curatorProjectHomePrompt: 'Home prompt', curatorTopologyPrompt: 'Topology prompt',
        curatorCreateAdjudicationPrompt: 'Adjudication prompt', curatorPagePrompt: 'Page prompt',
        provenanceLimits: { requestBytes: 1_048_576, componentBytes: 262_144,
          outputBytes: 262_144, totalBytes: 2_097_152, itemCount: 512, leaseMs: 60_000 },
      },
      evidenceHash: 'hash-1', evidenceText: 'Evidence text', evidenceNodes: [],
      existingWiki: { home_id: null, home: null, topology_hash: 'topology', catalog_valid: true, subpages: [] },
      contextNodes: {},
    },
    calls: [], captures: [], ...over,
  };
}
