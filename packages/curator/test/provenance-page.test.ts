import { expect, it, vi } from 'vitest';
import type { Engine } from '../src/engine.js';
import { immutablePreparedCapture } from '../src/llm/types.js';
import { buildOpenAiCompatParams } from '../src/llm/openai-compat.js';

it('prepares a page attempt, checkpoints dispatch/stage and shares publication sections with frozen time', async () => {
  const { PageCapture } = await import('../src/provenance-page.js');
  const { synthesisSections } = await import('../src/reconcile-write-plan.js');
  const events: string[] = [];
  const engine = {
    prepareProvenance: vi.fn(async (_request: unknown) => { events.push('prepare'); return { derivation_id: 'derivation', bundle_digest: 'digest', state: 'prepared', availability: 'retained' }; }),
    stageProvenanceResult: vi.fn(async (_request: unknown) => { events.push('stage'); return { derivation_id: 'derivation', bundle_digest: 'digest', contribution_digest: 'contribution' }; }),
    transitionProvenance: vi.fn(async (_request: unknown) => { events.push('sent'); }),
    inspectProvenance: vi.fn(async () => ({ select: 'attempt', attempt: { state: 'committed', availability: 'retained' } })),
  };
  const date = new Date('2026-09-25T23:59:59Z');
  const capture = new PageCapture(engine as unknown as Engine, { projectId: 'project', runRef: 'run', target: { plan_key: 'new' }, generatedAt: date, dryRun: false, items: [], omissions: [], timeZone: 'UTC' }, {
    attemptKey: 'fixed-attempt', beforeDispatch: async () => { events.push('checkpoint-dispatch'); }, beforeStage: async () => { events.push('checkpoint-stage'); },
  });
  date.setUTCDate(26);
  const request = { model: 'synthetic', maxTokens: 100, system: 'system', user: JSON.stringify({ action: 'create', title: 'Page', kind: 'freeform', scope: {}, synthesis_brief: 'Brief', evidence: '', sibling_scopes: [] }), toolName: 'page', toolDescription: 'Page', schema: {}, openAiResponseFormat: 'prompt-only' as const };
  await capture.onPrepared(immutablePreparedCapture('openrouter', 'synthetic', 'v1', buildOpenAiCompatParams(request)));
  const result = { target: { plan_key: 'new' }, body: 'Narrative.', log_note: '**2026-09-25** — Already formatted', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
  const binding = await capture.stage(result);
  expect(binding?.derivation_id).toBe('derivation');
  expect(events).toEqual(['prepare', 'checkpoint-dispatch', 'sent', 'checkpoint-stage', 'stage']);
  expect(engine.prepareProvenance.mock.calls[0]![0]).toMatchObject({ flow: 'project-subpage-v1', attempt_key: 'fixed-attempt', bundle: { target: { plan_key: 'new' } } });
  expect(engine.stageProvenanceResult.mock.calls[0]![0]).toMatchObject({ generated_at: '2026-09-25T23:59:59.000Z', log_stamp: '2026-09-25', contribution: synthesisSections(result), validated_sections: { body: result.body, log_note: result.log_note } });
  await capture.fail();
  expect(engine.inspectProvenance).toHaveBeenCalledWith({ select: 'attempt', attempt_key: 'fixed-attempt', flow: 'project-subpage-v1' });
  expect(events).toHaveLength(5);
});

function fixture(dryRun = false) {
  const engine = {
    prepareProvenance: vi.fn(async (req: import('../src/provenance-types.js').PrepareRequest) => req.dry_run
      ? { dry_run: true, bundle_digest: 'digest', payload_bytes: 1, reserved_bytes: 1, item_count: 0 }
      : { derivation_id: 'derivation', bundle_digest: 'digest', state: 'prepared', availability: 'retained', lease_expires_at: '2026-09-27T00:00:00Z' }),
    transitionProvenance: vi.fn(async (_req: unknown) => ({})),
    stageProvenanceResult: vi.fn(async (_req: unknown) => ({ derivation_id: 'derivation', bundle_digest: 'digest', contribution_digest: 'contribution' })),
    inspectProvenance: vi.fn(async (_req: unknown) => ({ select: 'attempt', attempt: { derivation_id: 'derivation', state: 'prepared', availability: 'retained' } })),
  };
  const context = { projectId: 'project', runRef: 'run', target: { plan_key: 'new' }, generatedAt: new Date('2026-09-25T23:59:59Z'), dryRun, items: [], omissions: [] };
  const request = { model: 'synthetic', maxTokens: 100, system: 'system', user: JSON.stringify({ action: 'create', title: 'Page', kind: 'freeform', scope: {}, synthesis_brief: 'Brief', evidence: '', sibling_scopes: [] }), toolName: 'page', toolDescription: 'Page', schema: {}, openAiResponseFormat: 'prompt-only' as const };
  const prepared = immutablePreparedCapture('openrouter', 'synthetic', 'v1', buildOpenAiCompatParams(request));
  const result = { target: { plan_key: 'new' }, body: 'Narrative.', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
  return { engine, context, request, prepared, result };
}

it('requires successful preparation and previews without staging or cleanup writes', async () => {
  const { PageCapture } = await import('../src/provenance-page.js');
  const { engine, context, prepared, result } = fixture(true);
  const capture = new PageCapture(engine as unknown as Engine, context);
  await expect(capture.stage(result)).rejects.toThrow('PROVENANCE_UNAVAILABLE');
  await capture.onPrepared(prepared);
  expect(await capture.stage(result)).toBeNull();
  await capture.fail();
  expect(engine.prepareProvenance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ dry_run: true, flow: 'project-subpage-v1' }));
  expect(engine.stageProvenanceResult).not.toHaveBeenCalled();
  expect(engine.transitionProvenance).not.toHaveBeenCalled();
  expect(engine.inspectProvenance).not.toHaveBeenCalled();
});

it.each(['prepare', 'checkpoint', 'mark-sent'] as const)('does not dispatch when %s fails', async failure => {
  const { PageCapture } = await import('../src/provenance-page.js');
  const { OpenAiCompatLlmClient } = await import('../src/llm/openai-compat.js');
  const { engine, context, request } = fixture();
  if (failure === 'prepare') engine.prepareProvenance.mockRejectedValueOnce(new Error('PRIVATE PREPARE DATA'));
  if (failure === 'mark-sent') engine.transitionProvenance.mockRejectedValueOnce(new Error('PRIVATE TRANSITION DATA'));
  const capture = new PageCapture(engine as unknown as Engine, context, { beforeDispatch: async () => {
    if (failure === 'checkpoint') throw new Error('PRIVATE CHECKPOINT DATA');
  } });
  const create = vi.fn();
  const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as import('openai').default);
  await expect(llm.structuredCall({ ...request, onPrepared: capture.onPrepared })).rejects.toThrow('provenance_capture_failed');
  expect(create).not.toHaveBeenCalled();
  expect(engine.stageProvenanceResult).not.toHaveBeenCalled();
});

it.each(['prepared', 'result_staged', 'committed', 'failed'] as const)('cleans only a retained uncommitted %s attempt', async state => {
  const { PageCapture } = await import('../src/provenance-page.js');
  const { engine, context, prepared } = fixture();
  const capture = new PageCapture(engine as unknown as Engine, context);
  await capture.onPrepared(prepared);
  engine.transitionProvenance.mockClear();
  engine.inspectProvenance.mockResolvedValueOnce({ select: 'attempt', attempt: { derivation_id: 'derivation', state, availability: 'retained' } });
  await capture.fail();
  if (state === 'prepared' || state === 'result_staged') expect(engine.transitionProvenance).toHaveBeenCalledExactlyOnceWith({ derivation_id: 'derivation', action: 'fail', expected_state: state });
  else expect(engine.transitionProvenance).not.toHaveBeenCalled();
});

it('does not stage if the durable result checkpoint fails', async () => {
  const { PageCapture } = await import('../src/provenance-page.js');
  const { engine, context, prepared, result } = fixture();
  const capture = new PageCapture(engine as unknown as Engine, context, { beforeStage: async () => { throw new Error('checkpoint unavailable'); } });
  await capture.onPrepared(prepared);
  await expect(capture.stage(result)).rejects.toThrow('checkpoint unavailable');
  expect(engine.stageProvenanceResult).not.toHaveBeenCalled();
});
