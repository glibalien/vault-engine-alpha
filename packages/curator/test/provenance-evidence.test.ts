import { describe, expect, it, vi } from 'vitest';
import { gatherGapFillCandidates } from '../src/curate.js';
import type { Config } from '../src/config.js';
import { defaultsFor, type VaultSettings } from '@vault/settings-registry';
import { buildEvidence, homeEvidenceNodeIds } from '../src/evidence.js';
import { completeHomeEvidenceObservations } from '../src/provenance-evidence-read.js';
import { runLocalCorrections } from '../src/db/provenance.js';
import { EvidenceCollector } from '../src/provenance-evidence.js';
import type { SourceObservation } from '../src/provenance-types.js';
import type { ProjectEvidence, ProjectRef, ExistingWiki } from '../src/types.js';

const observation = (id: string): SourceObservation => ({ source: { namespace: 'vault', kind: 'node', native_id: id }, authority: 'engine',
  observed_at: '2026-09-17T00:00:00Z', native_version: 1, content_hash: 'h', hash_semantics: 'engine_content_hash',
  observation_projection: 'node-token-v1', observation_digest: 'token', label: id, path: null });
const project: ProjectRef = { id: 'p', title: 'Project', file_path: 'P.md', status: null };
const evidence: ProjectEvidence & { existing_wiki: ExistingWiki } = { project: { id: 'p', title: 'Project', status: null, file_path: 'P.md' }, tasks: { open: [{ id: 't', title: 'Task', status: null, due: null }] },
  notes: [], signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 }, meetings: { recent: [], upcoming: [] }, contacts: { people: [], companies: [] },
  existing_wiki: { home_id: 'home', home: null, topology_hash: 'topology', catalog_valid: true, subpages: [] }, synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] }, evidence_hash: 'h', generated_at: '2026-09-17T00:00:00Z' };

describe('evidence attribution at formatting time', () => {
  it('preserves legacy formatting and records selected source versus generated-context bytes', () => {
    const nodes = [{ id: 'n', title: 'Note', body: 'évidence ' + 'x'.repeat(100), fields: {}, types: ['note'], provenance_observation: observation('n') },
      { id: 'home', title: 'Prior home', body: 'Generated earlier', fields: {}, types: ['wiki'], provenance_observation: observation('home') }];
    const collector = new EvidenceCollector({ p: observation('p'), t: observation('t') });
    const old = buildEvidence(project, evidence, nodes, 20);
    const text = buildEvidence(project, evidence, nodes, 20, [], new Set(), [], [], collector);
    expect(text).toBe(old);
    expect(collector.items.find(i => i.observation?.source.native_id === 'home')?.role).toBe('generated_context');
    const note = collector.items.find(i => i.observation?.source.native_id === 'n');
    expect(note?.truncated).toBe(true);
    expect(note?.role).toBe('source_material');
    expect(collector.items.some(i => i.observation?.source.native_id === 't')).toBe(true);
    for (const item of collector.items) {
      expect(item.spans.every(span => span.start >= 0 && span.end <= Buffer.byteLength(text))).toBe(true);
    }
  });
  it('keeps a wiki body\'s narrative but drops its Log and live sections, recording the omission', () => {
    const homeBody = ['Intro before markers.',
      '<!-- ve:managed:Now -->', 'Current narrative.', '<!-- /ve:managed:Now -->',
      '<!-- ve:live:tasks -->', '**Open (1)**', '- [[Task]] — open', '<!-- /ve:live:tasks -->',
      '<!-- ve:managed:Log -->', '**2026-10-01** — first curation', '<!-- /ve:managed:Log -->'].join('\n');
    const nodes = [{ id: 'home', title: 'Project Wiki', body: homeBody, fields: {}, types: ['wiki'], provenance_observation: observation('home') }];
    const collector = new EvidenceCollector({ p: observation('p'), t: observation('t') });
    const text = buildEvidence(project, evidence, nodes, null, [], new Set(), [], [], collector);
    expect(text).toContain('Intro before markers.');
    expect(text).toContain('Current narrative.');
    expect(text).not.toContain('first curation');
    expect(text).not.toContain('<!-- ve:');
    const home = collector.items.find(i => i.observation?.source.native_id === 'home');
    expect(home).toMatchObject({ role: 'generated_context', selection: 'wiki-narrative-context:v1', truncated: true });
    expect(home?.original_bytes).toBeGreaterThan(Buffer.byteLength(text.slice(text.indexOf('### Project Wiki'))));
    const broken = [{ ...nodes[0]!, body: '<!-- ve:managed:Now -->unterminated' }];
    expect(buildEvidence(project, evidence, broken, null)).toContain('unterminated');
  });

  it('treats reads and candidates of the vault map\'s wiki kind as generated context; none treats none so', () => {
    const body = ['Narrative.', '<!-- ve:managed:Log -->', '**2026-10-01** — first curation', '<!-- /ve:managed:Log -->'].join('\n');
    const nodes = [{ id: 'page', title: 'A page', body, fields: {}, types: ['page'], provenance_observation: observation('page') },
      { id: 'old', title: 'An old wiki', body: 'Old text', fields: {}, types: ['wiki'], provenance_observation: observation('old') }];
    const candidates = [{ id: 'cand', title: 'Cand', types: ['page'], status: null, provenance_observation: observation('cand') }];
    const roles = (wikiType: string | null) => {
      const collector = new EvidenceCollector({ p: observation('p'), t: observation('t') });
      const text = buildEvidence(project, { ...evidence, existing_wiki: { ...evidence.existing_wiki, home_id: null } }, nodes, null,
        candidates, new Set(), [], [], collector, wikiType);
      const role = (id: string) => collector.items.find(i => i.observation?.source.native_id === id)?.role;
      return { page: role('page'), old: role('old'), cand: role('cand'), keptLog: text.includes('first curation') };
    };
    expect(roles('page')).toEqual({ page: 'generated_context', old: 'source_material', cand: 'generated_context', keptLog: false });
    expect(roles('wiki')).toEqual({ page: 'source_material', old: 'generated_context', cand: 'source_material', keptLog: true });
    expect(roles(null)).toEqual({ page: 'source_material', old: 'source_material', cand: 'source_material', keptLog: true });
  });

  it('keeps owner correction, generated memory and repeated candidate appearances distinct', () => {
    const corrections = runLocalCorrections(['Use “é”\nKeep the correction.'], 'run');
    const memories = ['owner', 'curator'].map((source, index) => ({ id: index + 1, source, scope: 'vault' as const,
      node_id: null, content: 'Repeated text 😀', category: null, created_at: '2026-09-17', updated_at: '2026-09-17',
      provenance_observation: { ...observation(String(index + 1)), source: { namespace: 'vault', kind: 'memory' as const, native_id: String(index + 1) } } }));
    const candidates = [{ id: 'candidate', title: 'Task', types: ['wiki'], status: null,
      body: 'Repeated text 😀', provenance_observation: observation('candidate') }];
    const collector = new EvidenceCollector({ p: observation('p'), t: observation('t') }, corrections);
    const notes = corrections.map(c => c.note);
    const text = buildEvidence(project, evidence, [], null, candidates, new Set(), notes, memories, collector);
    expect(text).toBe(buildEvidence(project, evidence, [], null, candidates, new Set(), notes, memories));
    expect(collector.items.filter(i => i.role === 'human_correction')).toHaveLength(2);
    expect(collector.items.find(i => i.observation?.source.native_id === 'candidate')?.role).toBe('generated_context');
    const memoryItems = collector.items.filter(i => i.observation?.source.kind === 'memory');
    expect(memoryItems.map(i => i.role)).toEqual(['human_correction', 'generated_context']);
    expect(new Set(memoryItems.map(i => i.spans[0]!.start)).size).toBe(2);
    for (const item of memoryItems) {
      const span = item.spans[0]!;
      expect(Buffer.from(text).subarray(span.start, span.end).toString()).toBe('- Repeated text 😀');
    }
  });
  it('fails a named direct dependency with a missing observation rather than labelling it opaque', () => {
    expect(() => buildEvidence(project, evidence, [], null, [], new Set(), [], [], new EvidenceCollector({ p: observation('p') }))).toThrow('PROVENANCE_OBSERVATION_MISSING');
  });
});

it('selects precisely the catalog sources used by capped home formatting', () => {
  const nodes = Array.from({ length: 550 }, (_, i) => ({ id: `n${i}`, title: `Node ${i}`, status: null, due: null }));
  const large: ProjectEvidence = { ...evidence, tasks: { open: nodes },
    changed_since_curation: { since: '2026-01-01', buckets: { note: nodes.map(n => ({ ...n, type: 'note', file_mtime: 1, modified: '2026-09-17' })) } },
    signals_detail: { risk_proxies: nodes.map(n => ({ ...n, priority: null, scheduled: null, bucket: 'blocked', blocked: true })),
      timeline: nodes.map(n => ({ ...n, date: '2026-09-17', type: 'task' })) },
    synthesis_hints: { ...evidence.synthesis_hints, salience: nodes.map(n => ({ ...n, score: 1, components: { recency: 1, degree: 1, urgency: 1 } })) },
    closed_since: [{ ...nodes[50]!, closed_at: 1 }],
    existing_wiki: { home_id: 'home', subpages: [{ id: 'page', title: 'Project — Decisions' }, { id: 'retired', title: 'Project — Task Board' }] },
  };
  const ids = homeEvidenceNodeIds(large);
  const collector = new EvidenceCollector(Object.fromEntries(ids.map(id => [id, observation(id)])));
  buildEvidence(project, large, [], null, [], new Set(), [], [], collector);
  expect(new Set(collector.items.flatMap(i => i.observation ? [i.observation.source.native_id] : []))).toEqual(new Set(ids));
  expect(ids).toContain('n29'); expect(ids).not.toContain('n30'); expect(ids).toContain('n50');
  expect(ids.length).toBeLessThan(512);
});

it('replaces the entire evidence snapshot when filling selected observations', async () => {
  const fresh = { ...evidence, project: { ...evidence.project, title: 'Fresh title' }, evidence_hash: 'fresh',
    provenance_observations: { nodes: { p: observation('p'), t: observation('t') }, truncated: true, aggregate_coverage: 'opaque' as const } };
  const projectEvidence = vi.fn().mockResolvedValue(fresh);
  const result = await completeHomeEvidenceObservations({ projectEvidence }, evidence, 'p', 5, '2026-01-01');
  expect(result).toBe(fresh);
  expect(projectEvidence).toHaveBeenCalledExactlyOnceWith('p', 5, '2026-01-01', { includeProvenance: true, provenanceNodeIds: ['p', 't'] });
  projectEvidence.mockClear();
  expect(await completeHomeEvidenceObservations({ projectEvidence }, fresh, 'p', 5)).toBe(fresh);
  expect(projectEvidence).not.toHaveBeenCalled();
});

it('reselects after source-set changes and bounds retries when observations stay unavailable', async () => {
  const moved: typeof evidence = { ...evidence, tasks: { open: [{ id: 'new', title: 'New', status: null, due: null }] },
    provenance_observations: { nodes: { p: observation('p') }, truncated: true, aggregate_coverage: 'opaque' } };
  const ready: typeof evidence = { ...moved, provenance_observations: { ...moved.provenance_observations!, nodes: { p: observation('p'), new: observation('new') } } };
  const projectEvidence = vi.fn().mockResolvedValueOnce(moved).mockResolvedValueOnce(ready);
  expect(await completeHomeEvidenceObservations({ projectEvidence }, evidence, 'p', 5)).toBe(ready);
  expect(projectEvidence.mock.calls[1]![3].provenanceNodeIds).toEqual(['p', 'new']);
  projectEvidence.mockReset().mockResolvedValue(moved);
  await expect(completeHomeEvidenceObservations({ projectEvidence }, evidence, 'p', 5)).rejects.toThrow('PROVENANCE_OBSERVATION_MISSING');
  expect(projectEvidence).toHaveBeenCalledTimes(3);
});

describe('optional gap-fill capture', () => {
  const config = { semanticGapFill: true, semanticGapFillLimit: 5, semanticGapFillBodyReads: 1,
    projectHomeProvenanceEnabled: true, bodyCharCap: null } as Config;
  const unavailable = { id: 'gone', title: 'Unavailable candidate', types: ['note'], status: null };
  const valid = { id: 'valid', title: 'Valid candidate', types: ['note'], status: null };

  it.each([false, true])('omits failed optional reads before formatting (all fail: %s)', async allFail => {
    const collector = new EvidenceCollector({ p: observation('p'), t: observation('t') });
    const getNode = vi.fn(async (id: string) => {
      if (allFail || id === 'gone') throw new Error('Node disappeared after search');
      return { ...valid, fields: {}, body: 'Optional body', provenance_observation: observation(id) };
    });
    const engine = { semanticRelated: vi.fn(async () => [unavailable, valid]), getNode };
    const candidates = await gatherGapFillCandidates(engine as never, config, project, evidence, collector);
    expect(candidates.map(c => c.id)).toEqual(allFail ? [] : ['valid']);
    const text = buildEvidence(project, evidence, [], null, candidates, new Set(), [], [], collector);
    expect(text).not.toContain('Unavailable candidate');
    expect(collector.omissions).toEqual(Array.from({ length: allFail ? 2 : 1 }, () => ({ code: 'gap_fill_candidate_unavailable', source: null })));
    expect(collector.items.filter(i => i.selection === 'gap-fill-candidate:v1').map(i => ({ id: i.observation?.source.native_id, origin: i.origin })))
      .toEqual(allFail ? [] : [{ id: 'valid', origin: 'identified' }]);
    // The failed first read must not promote the second candidate into the body budget.
    expect(text).not.toContain('Optional body');
    expect(getNode).toHaveBeenCalledWith('valid', { includeProvenance: true, includeEmbeds: false });
  });

  it('still rejects missing metadata on an included candidate', async () => {
    const collector = new EvidenceCollector({ p: observation('p'), t: observation('t') });
    const engine = { semanticRelated: async () => [valid], getNode: async () => ({ ...valid, fields: {}, body: 'Included body' }) };
    const candidates = await gatherGapFillCandidates(engine as never, config, project, evidence, collector);
    expect(candidates).toHaveLength(1);
    expect(collector.omissions).toEqual([]);
    expect(() => buildEvidence(project, evidence, [], null, candidates, new Set(), [], [], collector)).toThrow('PROVENANCE_OBSERVATION_MISSING');
  });

  it('passes the run config to the search and reads each candidate\'s status from the vault map', async () => {
    const vault = { ...(defaultsFor('vault') as unknown as VaultSettings), projectType: 'initiative',
      taskStatusField: 'state', projectStatusField: 'phase' };
    const reads: Record<string, { types: string[]; fields: Record<string, unknown> }> = {
      c1: { types: ['todo'], fields: { state: 'stuck', status: 'ignored' } },
      c2: { types: ['initiative'], fields: { phase: { value: 'live' }, state: 'ignored' } },
    };
    const semanticRelated = vi.fn(async () => Object.keys(reads).map(id => ({ id, title: id, types: [], status: null })));
    const engine = { semanticRelated, getNode: async (id: string) => ({ id, title: id, body: '', ...reads[id], provenance_observation: observation(id) }) };
    const run = { ...config, settingsDir: 'Settings', vault, semanticGapFillBodyReads: 2 } as Config;
    const candidates = await gatherGapFillCandidates(engine as never, run, project, evidence);
    expect(semanticRelated).toHaveBeenCalledWith(expect.any(String), 5, run);
    expect(candidates.map(c => [c.id, c.status])).toEqual([['c1', 'stuck'], ['c2', 'live']]);
  });

  it('keeps legacy search metadata after a failed body read when provenance is disabled', async () => {
    const getNode = vi.fn().mockRejectedValue(new Error('Unavailable'));
    const candidates = await gatherGapFillCandidates({ semanticRelated: async () => [unavailable, valid], getNode } as never,
      { ...config, projectHomeProvenanceEnabled: false }, project, evidence);
    expect(candidates).toEqual([unavailable, valid]);
    expect(getNode).toHaveBeenCalledExactlyOnceWith('gone', {});
    expect(buildEvidence(project, evidence, [], null, candidates)).toContain('Unavailable candidate');
  });
});
