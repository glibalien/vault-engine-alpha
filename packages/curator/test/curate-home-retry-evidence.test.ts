import { expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import type { LlmClient } from '../src/llm/types.js';
import type { ReconciliationPipelineInput } from '../src/reconciliation-pipeline.js';
import type { ExistingWiki, ProjectEvidence, ProjectRef } from '../src/types.js';

// The home's retry after an edit changed its evidence mid-build asks for `fresh` evidence. On a
// first build the home reads the gate's own read, so a retry that reused it would be refused again.
const seen = vi.hoisted(() => ({ pipeline: [] as ReconciliationPipelineInput[], homeEvidence: [] as Array<{ evidence: ProjectEvidence }> }));

vi.mock('../src/reconciliation-pipeline.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/reconciliation-pipeline.js')>(),
  runReconciliationPipeline: vi.fn(async (input: ReconciliationPipelineInput) => {
    seen.pipeline.push(input);
    return { result: { project: input.project, outcome: 'error', detail: 'stopped by the test', dryRun: false }, memories: [] };
  }),
}));

vi.mock('../src/home-evidence.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/home-evidence.js')>(),
  prepareHomeEvidence: vi.fn(async (input: { evidence: ProjectEvidence }) => {
    seen.homeEvidence.push(input);
    return { text: 'Evidence', nodes: [] };
  }),
}));

const { curateProject } = await import('../src/curate.js');

const project: ProjectRef = { id: 'p1', title: 'Project Alpha', file_path: 'Projects/Project Alpha.md', status: 'in-progress' };
const existingWiki: ExistingWiki = { home_id: 'home', home: { id: 'home', version: 1, wiki_evidence_hash: 'old', wiki_topology_hash: 'stored' },
  topology_hash: 'current', catalog_valid: true, subpages: [] };

function evidence(hash: string): ProjectEvidence {
  return {
    project: { id: 'p1', title: 'Project Alpha', file_path: 'Projects/Project Alpha.md', status: 'in-progress' },
    tasks: { open: [], overdue: [], blocked: [], upcoming: [], backlog: [], done_recent: [] },
    notes: [], signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
    meetings: { recent: [], upcoming: [] }, contacts: { people: [], companies: [] },
    existing_wiki: existingWiki,
    synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
    evidence_hash: hash, generated_at: '2026-11-18T05:28:00.000Z',
  };
}

it('reads the project again when the home retry asks for fresh evidence', async () => {
  const reads = ['gate', 'fresh'];
  const engine = { projectEvidence: vi.fn(async () => evidence(reads.shift() ?? 'unexpected')) };
  const config = { projectHomeProvenanceEnabled: true, meetingReads: 10 } as Config;

  await curateProject(engine as never, {} as LlmClient, config, { ...project, id: null } as unknown as ProjectRef, false, true);

  const input = seen.pipeline[0]!;
  const policy = { home: undefined } as never;
  await input.prepareEvidence(policy);
  expect(engine.projectEvidence).toHaveBeenCalledTimes(1);
  expect(seen.homeEvidence[0]?.evidence.evidence_hash).toBe('gate');

  await input.prepareEvidence(policy, { fresh: true });
  expect(engine.projectEvidence).toHaveBeenCalledTimes(2);
  // By the root's id, which the gate's read resolved from the title.
  expect(engine.projectEvidence).toHaveBeenLastCalledWith('p1', 10, undefined, { includeProvenance: true });
  expect(seen.homeEvidence[1]?.evidence.evidence_hash).toBe('fresh');
});
