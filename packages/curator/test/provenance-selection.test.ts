import { expect, it } from 'vitest';
import type OpenAI from 'openai';
import { buildEvidence } from '../src/evidence.js';
import { buildHomeRequest } from '../src/home-request.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { EvidenceCollector, capturedBundle, canonical, HOME_BUDGET_ASSEMBLY } from '../src/provenance-evidence.js';
import { selectHomeEvidence } from '../src/provenance-selection.js';
import type { BundleV1, Json, SourceObservation } from '../src/provenance-types.js';
import type { GapFillCandidate, ProjectEvidence, Memory } from '../src/types.js';

const observation = (id: string): SourceObservation => ({ source: { namespace: 'vault', kind: 'node', native_id: id },
  authority: 'engine', observed_at: '2026-09-18T12:00:00Z', native_version: 1, content_hash: 'hash',
  hash_semantics: 'engine_content_hash', observation_projection: 'node-token-v2',
  observation_digest: 'sha256:json-v1:' + 'a'.repeat(64), label: id, path: null });
const project = { id: 'p', title: 'Project', file_path: 'P.md', status: null };
const evidence: ProjectEvidence = { project, tasks: {}, notes: [], contacts: { people: [], companies: [] },
  meetings: { recent: [], upcoming: [] }, signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
  existing_wiki: { home_id: null, subpages: [] }, synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
  evidence_hash: 'hash', generated_at: '2026-09-18T12:00:00Z' };
const limits = { componentBytes: 262144, itemCount: 512, requestBytes: 1048576, totalBytes: 2097152 };
const candidate = (id: string, body: string): GapFillCandidate => ({ id, title: id, types: ['note'], status: null,
  body, provenance_observation: observation(id) });
function fixture(body = 'PROTECTED SOURCE', baseOmissions: BundleV1['omissions'] = [], correction = '', ownerMemory = '') {
  const adapter = new OpenAiCompatLlmClient({} as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
  return {
    limits,
    render(candidates: readonly GapFillCandidate[], omissions: BundleV1['omissions']) {
      const corrections = correction ? [{ note: correction, observation: { ...observation('correction'), authority: 'caller' as const, source: { kind: 'curator_correction' as const, namespace: 'run', native_id: 'correction' } } }] : [];
      const collector = new EvidenceCollector({ p: observation('p') }, corrections);
      const memories: Memory[] = ownerMemory ? [{ id: 1, content: ownerMemory, source: 'owner', scope: 'vault', node_id: null, category: null, created_at: '', updated_at: '', provenance_observation: { ...observation('1'), source: { kind: 'memory', namespace: 'vault', native_id: '1' } } }] : [];
      collector.omissions.push(...baseOmissions, ...omissions);
      const text = buildEvidence(project, evidence, [{ id: 'p', title: 'Project', types: ['project'], fields: {}, body,
        provenance_observation: observation('p') }], null, [...candidates], new Set(), corrections.map(c => c.note), memories, collector);
      return { text, collector };
    },
    preview: (text: string) => adapter.previewStructuredCall({ ...buildHomeRequest({ model: 'model', system: 'sys', evidence: text,
      pageIndex: [], generatedAt: new Date('2026-09-18T12:00:00Z') }), malformedOutputPolicy: 'fail-closed-redacted' }),
  };
}

it('omits oversized optional input and admits a later small candidate without truncating required evidence', async () => {
  const f = fixture();
  const large = candidate('large', 'OVERSIZE ' + 'x'.repeat(523679));
  const small = candidate('small', 'SMALL OPTIONAL');
  const selected = await selectHomeEvidence({ ...f, candidates: [large, small] });
  expect(selected.selectedCandidates.map(c => c.id)).toEqual(['small']);
  expect(selected.text).toContain('PROTECTED SOURCE');
  expect(selected.text).toContain('SMALL OPTIONAL');
  expect(selected.text).not.toContain('OVERSIZE');
  expect(selected.collector.omissions).toEqual([{ code: 'gap_fill_component_budget', source: large.provenance_observation!.source }]);
  expect(selected.collector.items.filter(i => i.selection === 'gap-fill-candidate:v1')).toHaveLength(1);
  expect(Object.isFrozen(selected.collector.items)).toBe(true);
});

it('fails before selection when protected evidence is oversized', async () => {
  await expect(selectHomeEvidence({ ...fixture('x'.repeat(262145)), candidates: [candidate('small', 'text')] }))
    .rejects.toThrow('stage=selection dimension=component');
});

it.each([undefined, { ...observation('bad'), observation_digest: 'invalid' }])('does not size-drop candidates with invalid provenance', async obs => {
  await expect(selectHomeEvidence({ ...fixture(), candidates: [{ ...candidate('bad', 'x'.repeat(300000)), provenance_observation: obs }] }))
    .rejects.toThrow(obs ? 'PROVENANCE_ATTRIBUTION_INVALID' : 'PROVENANCE_OBSERVATION_MISSING');
});

it('uses effective item limits and preserves rank without duplicates across trials', async () => {
  const f = fixture();
  const base = f.render([], []);
  const itemCount = capturedBundle(await f.preview(base.text), base.collector, HOME_BUDGET_ASSEMBLY).items.length + 1;
  const selected = await selectHomeEvidence({ ...f, limits: { ...limits, itemCount }, candidates: [candidate('first', 'one'), candidate('second', 'two')] });
  expect(selected.selectedCandidates.map(c => c.id)).toEqual(['first']);
  expect(selected.budgetOmissions).toEqual([{ code: 'gap_fill_item_budget', source: observation('second').source }]);
  expect(new Set(selected.collector.items.map(i => i.key)).size).toBe(selected.collector.items.length);
});

it('fails when recording a truthful omission exceeds the manifest bound', async () => {
  await expect(selectHomeEvidence({ ...fixture('required', Array.from({ length: 512 }, () => ({ code: 'unavailable', source: null }))),
    candidates: [candidate('large', 'x'.repeat(300000))] })).rejects.toThrow('dimension=omissions');
});

it('propagates preview failures without omitting inputs', async () => {
  await expect(selectHomeEvidence({ ...fixture(), preview: async () => { throw new Error('PROVENANCE_UNAVAILABLE'); }, candidates: [] }))
    .rejects.toThrow('PROVENANCE_UNAVAILABLE');
});


it.each(['correction', 'owner memory'])('preserves an oversized %s by failing rather than dropping it', async kind => {
  const text = 'x'.repeat(300000);
  await expect(selectHomeEvidence({ ...fixture('source', [], kind === 'correction' ? text : '', kind === 'owner memory' ? text : ''),
    candidates: [candidate('optional', 'text')] })).rejects.toThrow('stage=selection dimension=component');
});

it.each(['request', 'bundle'] as const)('omits optional candidates that cumulatively exceed %s bytes', async kind => {
  const f = fixture();
  const first = candidate('first', 'A'.repeat(10000));
  const second = candidate('second', 'B'.repeat(10000));
  const one = f.render([first], []);
  const bundle = capturedBundle(await f.preview(one.text), one.collector, HOME_BUDGET_ASSEMBLY);
  const cap = Buffer.byteLength(canonical(kind === 'request' ? bundle.provider_payload : bundle as unknown as Json)) + 2000;
  const selected = await selectHomeEvidence({ ...f, limits: { ...limits, [kind === 'request' ? 'requestBytes' : 'totalBytes']: cap },
    candidates: [first, second] });
  expect(selected.selectedCandidates.map(c => c.id)).toEqual(['first']);
  expect(selected.budgetOmissions[0]?.code).toBe(kind === 'request' ? 'gap_fill_request_budget' : 'gap_fill_bundle_budget');
});

it('projects unknown preview errors without exposing source contents', async () => {
  await expect(selectHomeEvidence({ ...fixture(), candidates: [], preview: async () => { throw new Error('PRIVATE CONTENT'); } }))
    .rejects.toThrow(/^PROVENANCE_UNAVAILABLE$/);
});
