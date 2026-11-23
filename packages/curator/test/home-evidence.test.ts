import { expect, it } from 'vitest';
import { gatherHomeReads as original } from '../src/curate.js';
import { gatherHomeReads, prepareHomeEvidence } from '../src/home-evidence.js';

it('shares the existing evidence implementation without a second read path', () => {
  expect(gatherHomeReads).toBe(original);
  expect(prepareHomeEvidence).toBeTypeOf('function');
});

it("gives the home the owner's memories and this project's, selected by its names and notes (#297)", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const engine = {
    getNode: async (id: string) => ({ id, title: id === 'p1' ? 'Acme Opportunity' : id, types: [], body: '',
      fields: id === 'p1' ? { aliases: { value: ['ACME Corp'], type: 'json', source: 'frontmatter' } } : {} }), // get-node's shape
    searchNodes: async () => [],
    queryNodes: async () => ({ nodes: [] }),
    listMemoriesWithTotal: async (filters: Record<string, unknown>) => {
      calls.push(filters);
      if (filters.source === 'owner') return { memories: [{ id: 1, source: 'owner', scope: 'vault', node_id: null, content: 'Keep it short.', category: 'preference', created_at: '', updated_at: '' }], total: 1 };
      if (filters.query === '"Acme"') return { memories: [{ id: 2, source: 'curator', scope: 'vault', node_id: null, content: 'Acme runs its own gateway.', category: 'fact', created_at: '', updated_at: '' }], total: 1 };
      return { memories: [], total: 0 };
    },
  };
  const prepared = await prepareHomeEvidence({
    engine: engine as never, llm: {} as never,
    config: { meetingReads: 3, noteReads: 3, bodyCharCap: null, gapFillLimit: 0, projectHomeProvenanceEnabled: false } as never,
    project: { id: 'p1', title: 'Acme Opportunity', file_path: 'Acme.md', status: 'active' },
    evidence: {
      project: { id: 'p1', title: 'Acme Opportunity', file_path: 'Acme.md', status: 'active' },
      tasks: {}, notes: [{ id: 'n1', title: 'Kickoff' }], signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
      meetings: { recent: [], upcoming: [] }, contacts: { people: [], companies: [{ id: 'c1', title: 'Acme' }] },
      existing_wiki: { home_id: 'h1', subpages: [] }, synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
      evidence_hash: 'hash', generated_at: '2026-11-01T00:00:00Z',
    } as never,
    pinnedTitles: new Set(), corrections: [], runRef: 'run',
  });
  expect(calls.filter(f => f.query).map(f => f.query)).toEqual(['"Acme Opportunity"', '"ACME Corp"', '"Acme"']);
  expect(calls).toContainEqual(expect.objectContaining({ evidence_node_ids: expect.arrayContaining(['p1', 'n1', 'h1']) }));
  // The project's own memory set, most specific first, comes before the plain evidence query (#551).
  expect(calls).toContainEqual(expect.objectContaining({ project_of: 'p1', evidence_node_ids: expect.arrayContaining(['p1', 'n1', 'h1']) }));
  expect(calls).toContainEqual(expect.objectContaining({ scope: 'node', node_id: 'h1' }));
  expect(prepared.memories?.map(m => m.id)).toEqual([1, 2]);
  expect(prepared.text).toContain('## OWNER MEMORIES');
  expect(prepared.text).toContain('- [fact] Acme runs its own gateway.');
});

it('prints evidence dates in the configured zone (#459)', async () => {
  const engine = {
    getNode: async (id: string) => ({ id, title: id, types: [], body: '', fields: {} }),
    searchNodes: async () => [], queryNodes: async () => ({ nodes: [] }),
    listMemoriesWithTotal: async () => ({ memories: [], total: 0 }),
  };
  const prepared = await prepareHomeEvidence({
    engine: engine as never, llm: {} as never,
    config: { meetingReads: 3, noteReads: 3, bodyCharCap: null, gapFillLimit: 0, projectHomeProvenanceEnabled: false,
      curatorTz: 'Asia/Tokyo' } as never,
    project: { id: 'p1', title: 'Project', file_path: 'Project.md', status: 'active' },
    evidence: {
      project: { id: 'p1', title: 'Project', file_path: 'Project.md', status: 'active' },
      tasks: {}, notes: [], signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
      meetings: { recent: [], upcoming: [] }, contacts: { people: [], companies: [] },
      existing_wiki: { home_id: 'h1', subpages: [] }, synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
      // 20:30 UTC on 9 March is already 10 March in Tokyo.
      changed_since_curation: { since: '2026-03-01T00:00:00Z', buckets: {
        note: [{ id: 'n1', title: 'Kickoff', type: 'note', file_mtime: Date.parse('2026-03-09T20:30:00Z'), modified: '2026-03-09T20:30:00.000Z' }] } },
      evidence_hash: 'hash', generated_at: '2026-03-09T20:30:00Z',
    } as never,
    pinnedTitles: new Set(), corrections: [], runRef: 'run',
  });
  expect(prepared.text).toContain('  - Kickoff (modified 2026-03-10)');
});

it('dates and sources a project build\'s memories, shows its people, and its memory pairs nothing settled (#474 idea 4)', async () => {
  const memory = (id: number, content: string, extra: Record<string, unknown> = {}) => ({ id, source: 'curator', scope: 'vault', node_id: null,
    content, category: 'fact', created_at: '2026-11-02T00:00:00Z', updated_at: '', evidence_kind: 'note', ...extra });
  const engine = {
    getNode: async (id: string) => ({ id, title: id === 'n1' ? 'Kickoff' : id, types: [], body: '', fields: {} }),
    searchNodes: async () => [], queryNodes: async () => ({ nodes: [] }),
    listMemoriesWithTotal: async (filters: Record<string, unknown>) => filters.source === 'owner'
      ? { memories: [memory(1, 'Keep it short.', { source: 'owner' })], total: 1 }
      : { memories: [memory(2, 'Headcount is 40.', { evidence_node_id: 'n1', valid_at: '2026-11-03T00:00:00Z' }), memory(3, 'Headcount is 55.')], total: 2 },
  };
  const asked: number[][] = [];
  const prepared = await prepareHomeEvidence({
    engine: engine as never, llm: {} as never,
    config: { meetingReads: 3, noteReads: 3, bodyCharCap: null, gapFillLimit: 0, projectHomeProvenanceEnabled: false, curatorTz: 'UTC' } as never,
    project: { id: 'p1', title: 'Atlas', file_path: 'Atlas.md', status: 'active' },
    evidence: {
      project: { id: 'p1', title: 'Atlas', file_path: 'Atlas.md', status: 'active' },
      tasks: {}, notes: [{ id: 'n1', title: 'Kickoff' }], signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
      meetings: { recent: [], upcoming: [] },
      contacts: { people: [{ id: 'x1', title: 'Dana Okafor', companies: ['Acme'], direct: true, meeting_count: 1, last_seen: null }], companies: [] },
      existing_wiki: { home_id: 'h1', subpages: [] }, synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
      evidence_hash: 'hash', generated_at: '2026-11-04T00:00:00Z',
    } as never,
    pinnedTitles: new Set(), corrections: [], runRef: 'run',
    readConflicts: ids => { asked.push([...ids]); return [[2, 3], [3, 99]]; },
  });
  expect(asked).toEqual([[2, 3]]);
  expect(prepared.conflicts?.map(conflict => [conflict.a.id, conflict.b.id])).toEqual([[2, 3]]);
  expect(prepared.text).toContain('- [fact] 2026-11-03, from "Kickoff": Headcount is 40.');
  expect(prepared.text).toContain('- [fact] 2026-11-02, from a note: Headcount is 55.');
  expect(prepared.text).toContain('## UNSETTLED CONFLICTS');
  expect(prepared.text).toContain('- "Headcount is 40." (2026-11-03, from "Kickoff") vs "Headcount is 55." (2026-11-02, from a note)');
  expect(prepared.text).toContain('- Dana Okafor (Acme; project contact; 1 project meeting)');
});
