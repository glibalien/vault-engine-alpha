import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { synthesizeAcceptedPages, type AcceptedPagesSynthesisInput } from '../src/page-synthesis.js';
import type { BundleV1 } from '../src/provenance-types.js';
import { observedNode, scope, wiki } from './provenance-page-fixtures.js';

const pageFrame = (body: string, note = '') => `<<<VAULT_PAGE_V1>>>\nlog_note: ${note}\n<<<VAULT_BODY>>>\n${body}\n<<<END_VAULT_PAGE>>>`;

describe('page request evidence assembly', () => {
  it('attributes only selected coherent node bytes, with UTF-8 offsets independent of escaping and repeated text', async () => {
    const { capturedPageBundle } = await import('../src/provenance-page-evidence.js');
    let bundle: BundleV1 | undefined;
    const selected = observedNode('selected');
    const excluded = observedNode('excluded');
    const create = vi.fn(async (_payload: unknown) => ({ choices: [{ message: { content: pageFrame('Grounded narrative.') }, finish_reason: 'stop' }] }));
    const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI);
    const input: AcceptedPagesSynthesisInput = { model: 'synthetic', existingWiki: wiki, evidenceNodes: [selected, excluded],
      bodyCharCap: 16, evidenceIdsByTarget: { 'plan:new': ['selected'] }, plan: { reviewed_page_ids: [], actions: [
        { op: 'create', plan_key: 'new', title: 'Title', kind: 'freeform', scope, synthesis_brief: 'A generated correction-influenced brief.' },
      ] }, captureFactory: (target, _request, selection) => ({
        onPrepared: async capture => { bundle = capturedPageBundle(capture, { projectId: 'project', runRef: 'run', target,
          generatedAt: selection.generatedAt, dryRun: true, items: selection.items, omissions: selection.omissions }); },
        stage: async () => null, fail: async () => {},
      }) };
    await synthesizeAcceptedPages(llm, { getNode: async () => { throw new Error('unexpected reread'); } }, input);
    expect(bundle).toBeDefined();
    expect(bundle!.provider_payload).toBe(create.mock.calls[0]![0]);
    expect(bundle!.decoded_fields).not.toHaveProperty('schema');
    const identified = bundle!.items.filter(item => item.origin === 'identified');
    expect(identified.map(item => item.observation!.source.native_id)).toEqual(['selected']);
    expect(identified[0]!.truncated).toBe(true);
    const span = identified[0]!.spans[0]!;
    expect(Buffer.from(bundle!.decoded_fields[span.field]!).subarray(span.start, span.end).toString('utf8')).toBe(bundle!.decoded_fields.evidence);
    expect(identified[0]!.original_bytes).toBeGreaterThan(identified[0]!.retained_bytes);
    expect(bundle!.items.find(item => item.key === 'synthesis_brief')).toMatchObject({ origin: 'opaque', observation: null, upstream_derivation_id: null });
    expect(bundle!.items.find(item => item.key === 'sibling_scopes')).toMatchObject({ origin: 'opaque', observation: null });
    expect(bundle!.items.some(item => item.observation?.source.kind === 'curator_correction')).toBe(false);
  });

  it('calls the capture factory before the provider and honors preparation failure', async () => {
    const create = vi.fn(async (_payload: unknown) => ({ choices: [{ message: { content: pageFrame('Narrative.') }, finish_reason: 'stop' }] }));
    const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI);
    const captureFactory = vi.fn(() => ({ onPrepared: async () => { throw new Error('PRIVATE CAPTURE'); }, stage: async () => null, fail: async () => {} }));
    await expect(synthesizeAcceptedPages(llm, { getNode: async () => observedNode('target') }, {
      model: 'synthetic', existingWiki: wiki, evidenceNodes: [], captureFactory,
      plan: { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'new', title: 'Page', kind: 'freeform', scope, synthesis_brief: 'Brief' }] },
    })).rejects.toThrow('provenance_capture_failed');
    expect(create).not.toHaveBeenCalled();
  });
});

it.each(['anthropic', 'fireworks', 'openrouter'] as const)('captures all accepted page actions with the real %s adapter', async provider => {
  const { AnthropicLlmClient } = await import('../src/llm/anthropic.js');
  const { PageCapture } = await import('../src/provenance-page.js');
  const { currentDateLine } = await import('../src/date-line.js');
  const date = new Date('2026-09-25T23:59:59Z');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(date);
  const bundles: BundleV1[] = [];
  const stages: import('../src/provenance-types.js').StageRequest[] = [];
  const previews: import('../src/llm/types.js').PreparedCapture[] = [];
  const events: string[] = [];
  const output = { body: '# Decisions\n\nA grounded é 😀 narrative.', log_note: '**2026-09-25** — Existing formatting.' };
  const create = vi.fn(async (payload: unknown) => {
    expect(events.at(-1)).toBe('sent');
    expect(payload).toBe(bundles.at(-1)!.provider_payload);
    expect(payload).toEqual(previews.at(-1)!.payload);
    events.push('provider');
    vi.setSystemTime(new Date('2026-09-26T05:00:00Z'));
    return provider === 'anthropic'
      ? { content: [{ type: 'tool_use', name: 'emit_scoped_page', input: output }], usage: { input_tokens: 3, output_tokens: 2 } }
      : { choices: [{ message: { content: pageFrame(output.body, output.log_note) }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
  });
  const llm = provider === 'anthropic'
    ? new AnthropicLlmClient({ messages: { create } } as unknown as import('@anthropic-ai/sdk').default)
    : new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI, { provider, fireworksExtensions: provider === 'fireworks' });
  const nodes = new Map(['target', 'source'].map(id => [id, observedNode(id, 'Owner é "same"\n<!-- ve:managed:Summary -->\nRepeated 😀 "quote" \\ path\n<!-- /ve:managed:Summary -->\n<!-- ve:managed:Log -->OLD LOG<!-- /ve:managed:Log -->', 9)]));
  const getNode = vi.fn(async (id: string, options?: { includeProvenance?: boolean }) => {
    expect(options).toEqual({ includeProvenance: true });
    return nodes.get(id)!;
  });
  const engine = {
    prepareProvenance: vi.fn(async (req: import('../src/provenance-types.js').PrepareRequest) => {
      bundles.push(req.bundle); events.push('prepare');
      return { derivation_id: 'd-' + bundles.length, bundle_digest: 'digest', state: 'prepared', availability: 'retained', lease_expires_at: '2026-09-27T00:00:00Z' };
    }),
    transitionProvenance: vi.fn(async () => { events.push('sent'); }),
    stageProvenanceResult: vi.fn(async (req: import('../src/provenance-types.js').StageRequest) => {
      stages.push(req); return { derivation_id: req.derivation_id, bundle_digest: 'digest', contribution_digest: 'contribution' };
    }), inspectProvenance: vi.fn(),
  };
  const createAction = { op: 'create' as const, plan_key: 'new', title: 'Page', kind: 'freeform' as const, scope, synthesis_brief: 'Generated brief.' };
  const plan: import('../src/types.js').TopologyPlan = { reviewed_page_ids: [], actions: [
    createAction, { op: 'refresh', node_id: 'target', scope, synthesis_brief: 'Refresh' },
    { op: 'reactivate', node_id: 'target', scope, synthesis_brief: 'Reactivate' },
    { op: 'merge', target: { node_id: 'target' }, sources: ['source'], scope, synthesis_brief: 'Merge', reason: 'Same scope' },
    { ...createAction, plan_key: 'merged-new' },
    { op: 'merge', target: { plan_key: 'merged-new' }, sources: ['source', 'target'], scope, synthesis_brief: 'Merge into new', reason: 'Same scope' },
    { op: 'keep', node_id: 'source', scope },
    { op: 'retire', node_id: 'source', scope, state: 'retired', reason: 'Historical' },
  ] };
  try {
    const result = await synthesizeAcceptedPages(llm, { getNode }, { model: 'synthetic', existingWiki: wiki,
      plan, evidenceNodes: [observedNode('evidence-a'), observedNode('evidence-b')], generatedAt: date,
      captureFactory: async (target, request, selection) => {
        previews.push(await llm.previewStructuredCall!(request));
        return new PageCapture(engine as unknown as import('../src/engine.js').Engine, {
          projectId: 'project', runRef: 'run', target, generatedAt: selection.generatedAt, dryRun: false,
          items: selection.items, omissions: selection.omissions, timeZone: 'UTC',
        });
      },
    });
    expect(create).toHaveBeenCalledTimes(5);
    expect(result.pages.map(page => page.provenance?.derivation_id)).toEqual(['d-1', 'd-2', 'd-3', 'd-4', 'd-5']);
    expect(result.usage).toEqual({ input: 15, output: 10, cacheWrite: 0, cacheRead: 0 });
    expect(bundles.map(bundle => bundle.decoded_fields.action)).toEqual(['create', 'refresh', 'reactivate', 'merge', 'merge']);
    for (const bundle of bundles) {
      expect(bundle.transform.adapter).toBe(provider === 'anthropic' ? 'anthropic-v1' : 'openai-compat-page-markdown-v1');
      expect(bundle.decoded_fields.system).toContain(currentDateLine(date));
      expect(bundle.provider_payload).not.toHaveProperty('response_format');
      expect(bundle.decoded_fields).not.toHaveProperty('schema');
      for (const item of bundle.items.filter(item => item.origin === 'identified')) {
        const span = item.spans[0]!;
        const bytes = Buffer.from(bundle.decoded_fields[span.field]!).subarray(span.start, span.end).toString('utf8');
        if (span.field !== 'evidence') {
          const node = JSON.parse(bytes) as { id: string; title: string; body: string };
          expect(node.id).toBe(item.observation!.source.native_id);
          expect(node.title).toBe('Repeated é 😀 "quote"');
          expect(node.body).toContain('Repeated 😀 "quote" \\ path');
          expect(node.body).not.toContain('OLD LOG');
          expect(node.body).not.toContain('ve:managed');
          expect(item.observation!.native_version).toBe(9);
        } else {
          expect(bytes).toContain(`[${item.observation!.source.native_id}]`);
        }
      }
    }
    const merge = bundles[3]!;
    expect(merge.items.filter(item => ['current_target', 'merge_sources'].includes(item.spans[0]!.field)).map(item => item.observation!.source.native_id)).toEqual(['target', 'source']);
    expect(bundles[4]!.decoded_fields).not.toHaveProperty('current_target');
    expect(bundles[4]!.target).toEqual({ plan_key: 'merged-new' });
    expect(stages).toHaveLength(5);
    for (const stage of stages) expect(stage).toMatchObject({ generated_at: '2026-09-25T23:59:59.000Z', log_stamp: '2026-09-25',
      validated_sections: output, contribution: [{ name: 'Summary', mode: 'replace', content: output.body }, { name: 'Log', mode: 'append', content: output.log_note }] });
  } finally { vi.useRealTimers(); }
});

it('replaces a missing observation and its old body together; stops after three unsuccessful rereads', async () => {
  const old = { ...observedNode('selected', 'OLD BODY'), provenance_observation: undefined };
  const create = vi.fn(async (_payload: unknown) => ({ choices: [{ message: { content: pageFrame('Narrative.') }, finish_reason: 'stop' }] }));
  const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI);
  const snapshots: BundleV1[] = [];
  const input: AcceptedPagesSynthesisInput = { model: 'synthetic', existingWiki: wiki, evidenceNodes: [old],
    plan: { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'new', title: 'Page', kind: 'freeform', scope, synthesis_brief: 'Brief' }] },
    captureFactory: (target, _request, selection) => ({ onPrepared: async capture => {
      const { capturedPageBundle } = await import('../src/provenance-page-evidence.js');
      snapshots.push(capturedPageBundle(capture, { projectId: 'project', runRef: 'run', target, ...selection, dryRun: true }));
    }, stage: async () => null, fail: async () => {} }),
  };
  const getNode = vi.fn(async (_id: string, _options?: unknown) => observedNode('selected', 'NEW BODY', 10));
  await synthesizeAcceptedPages(llm, { getNode }, input);
  expect(getNode).toHaveBeenCalledExactlyOnceWith('selected', { includeProvenance: true });
  expect(snapshots[0]!.decoded_fields.evidence).toContain('NEW BODY');
  expect(snapshots[0]!.decoded_fields.evidence).not.toContain('OLD BODY');
  expect(snapshots[0]!.items[0]!.observation!.native_version).toBe(10);
  getNode.mockReset().mockResolvedValue(old);
  create.mockClear();
  await expect(synthesizeAcceptedPages(llm, { getNode }, input)).rejects.toThrow('PROVENANCE_PAGE_FAILED');
  expect(getNode).toHaveBeenCalledTimes(3);
  expect(create).not.toHaveBeenCalled();
});

it('rejects attribution built for different request bytes before prepare', async () => {
  const { capturedPageBundle, pageEvidence } = await import('../src/provenance-page-evidence.js');
  const { immutablePreparedCapture } = await import('../src/llm/types.js');
  const { buildOpenAiCompatParams } = await import('../src/llm/openai-compat.js');
  const context = { projectId: 'project', runRef: 'run', target: { plan_key: 'new' }, generatedAt: new Date(), dryRun: true, items: [] as import('../src/provenance-types.js').InputItem[], omissions: [] };
  pageEvidence([observedNode('source')], [], null, new Set(), context);
  const payload = buildOpenAiCompatParams({ model: 'synthetic', maxTokens: 100, system: 'system', user: JSON.stringify({ action: 'create', title: 'Page', kind: 'freeform', scope, synthesis_brief: 'Brief', evidence: 'UNRELATED'.repeat(20), sibling_scopes: [] }), toolName: 'page', toolDescription: 'Page', schema: {}, openAiResponseFormat: 'prompt-only' });
  expect(() => capturedPageBundle(immutablePreparedCapture('openrouter', 'synthetic', 'v1', payload), context)).toThrow('PROVENANCE_UNAVAILABLE');
});

it('rejects a UTF-8 span ending inside a four-byte character, even when replacement text has the same byte length', async () => {
  const { capturedPageBundle } = await import('../src/provenance-page-evidence.js');
  const { spanDigest } = await import('../src/provenance-evidence.js');
  const { immutablePreparedCapture } = await import('../src/llm/types.js');
  const { buildOpenAiCompatParams } = await import('../src/llm/openai-compat.js');
  const fields = { evidence: '😀' };
  const spans = [{ field: 'evidence', start: 0, end: 3 }];
  const item: import('../src/provenance-types.js').InputItem = { key: 'bad', observation: observedNode('source').provenance_observation!, role: 'source_material', origin: 'identified', upstream_derivation_id: null, selection: 'test', spans, original_bytes: 4, retained_bytes: 3, input_digest: spanDigest(spans, fields), truncated: true };
  const payload = buildOpenAiCompatParams({ model: 'synthetic', maxTokens: 100, system: 'system', user: JSON.stringify({ action: 'create', title: 'Page', kind: 'freeform', scope, synthesis_brief: 'Brief', ...fields, sibling_scopes: [] }), toolName: 'page', toolDescription: 'Page', schema: {}, openAiResponseFormat: 'prompt-only' });
  expect(() => capturedPageBundle(immutablePreparedCapture('openrouter', 'synthetic', 'v1', payload), { projectId: 'project', runRef: 'run', target: { plan_key: 'new' }, generatedAt: new Date(), dryRun: true, items: [item], omissions: [] })).toThrow('PROVENANCE_UNAVAILABLE');
});

it('fails closed on malformed captured model output without retrying or staging', async () => {
  const create = vi.fn(async (_payload: unknown) => ({ choices: [{ message: { content: 'PRIVATE OUTPUT invalid JSON' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
  const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI);
  const capture = { onPrepared: vi.fn(async () => {}), stage: vi.fn(async () => null), fail: vi.fn(async () => {}) };
  await expect(synthesizeAcceptedPages(llm, { getNode: async () => observedNode('target') }, {
    model: 'synthetic', existingWiki: wiki, evidenceNodes: [], captureFactory: () => capture,
    plan: { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'new', title: 'Page', kind: 'freeform', scope, synthesis_brief: 'Brief' }] },
  })).rejects.toMatchObject({ message: expect.stringContaining('reason=invalid_page_envelope'), usage: { input: 4, output: 2, cacheWrite: 0, cacheRead: 0 } });
  expect(create).toHaveBeenCalledTimes(1);
  expect(capture.stage).not.toHaveBeenCalled();
  expect(capture.fail).toHaveBeenCalledTimes(1);
});

it('rejects current-target observations from a different node version before provider dispatch', async () => {
  const create = vi.fn();
  const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI);
  const target = { ...observedNode('target'), version: 8 };
  const captureFactory = vi.fn(() => ({ onPrepared: async () => {}, stage: async () => null, fail: async () => {} }));
  await expect(synthesizeAcceptedPages(llm, { getNode: async () => target }, {
    model: 'synthetic', existingWiki: wiki, evidenceNodes: [], captureFactory,
    plan: { reviewed_page_ids: ['target'], actions: [{ op: 'refresh', node_id: 'target', scope, synthesis_brief: 'Brief' }] },
  })).rejects.toThrow('PROVENANCE_PAGE_FAILED');
  expect(captureFactory).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
