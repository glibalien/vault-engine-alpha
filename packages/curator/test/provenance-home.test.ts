import { describe, expect, it, vi } from 'vitest';
import { HomeCapture } from '../src/provenance-home.js';
import { EvidenceCollector } from '../src/provenance-evidence.js';
import { buildOpenAiCompatParams } from '../src/llm/openai-compat.js';
import { HOME_BUDGET_ASSEMBLY } from '../src/provenance-evidence.js';
import type { Json } from '../src/provenance-types.js';
import type { Engine } from '../src/engine.js';

function fixture(dryRun: boolean, budgeted = false, timeZone = 'UTC') {
  const engine = {
    prepareProvenance: vi.fn(async (input: { dry_run: boolean }) => input.dry_run ? { dry_run: true, bundle_digest: 'digest', payload_bytes: 1, reserved_bytes: 2, item_count: 3 }
      : { derivation_id: 'derivation', bundle_digest: 'digest', state: 'prepared', availability: 'retained', lease_expires_at: '2026-09-18T00:00:00Z' }),
    stageProvenanceResult: vi.fn(async (_input: unknown) => ({ derivation_id: 'derivation', bundle_digest: 'digest', contribution_digest: 'contribution' })),
    transitionProvenance: vi.fn(async (_input: unknown) => ({})),
    inspectProvenance: vi.fn(async (_input: unknown) => ({ select: 'attempt', attempt: { state: 'committed' } })),
  };
  const capture = new HomeCapture(engine as unknown as Engine, 'project', 'run', dryRun, new EvidenceCollector({}), new Date('2026-09-17T00:00:00Z'), budgeted ? HOME_BUDGET_ASSEMBLY : undefined, undefined, timeZone);
  const payload = buildOpenAiCompatParams({ model: 'model', maxTokens: 100, system: 'sys',
    user: JSON.stringify({ evidence: '', accepted_page_index: [] }), toolName: 'home', toolDescription: 'home', schema: { type: 'object' } });
  return { engine, capture, prepared: { provider: 'openrouter' as const, model: 'model', adapter_version: 'v1', payload: payload as unknown as Json } };
}
describe('one home capture', () => {
  it('requires prepare before stage and carries the binding into publication', async () => {
    const { capture, engine, prepared } = fixture(false);
    await capture.onPrepared(prepared);
    const binding = await capture.stage({ now: 'Now', focus: 'Focus', open_threads: 'Open', log_entry: 'Dated log' }, { now: 'Now', focus: 'Focus', open_threads: 'Open', log_entry: 'Raw log' });
    expect(binding?.derivation_id).toBe('derivation');
    expect(engine.prepareProvenance).toHaveBeenCalledTimes(1);
    expect(engine.transitionProvenance).toHaveBeenCalledWith({ derivation_id: 'derivation', action: 'mark-sent', expected_state: 'prepared' });
    expect(engine.stageProvenanceResult.mock.calls[0]?.[0]).toMatchObject({ generated_at: '2026-09-17T00:00:00.000Z', log_stamp: '2026-09-17', validated_sections: { log_entry: 'Raw log' }, contribution: expect.arrayContaining([{ name: 'Log', mode: 'append', content: 'Dated log' }]) });
    await capture.fail();
    expect(engine.transitionProvenance).toHaveBeenCalledTimes(1); // already committed: never mark failed
  });
  it('records the log stamp as the date in the configured zone, like the Log entry (#459)', async () => {
    // Midnight UTC on 17 September is still the evening of the 16th in New York.
    const { capture, engine, prepared } = fixture(false, false, 'America/New_York');
    await capture.onPrepared(prepared);
    await capture.stage({ now: 'Now', focus: 'Focus', open_threads: 'Open', log_entry: 'Dated log' });
    expect(engine.stageProvenanceResult.mock.calls[0]?.[0]).toMatchObject({ generated_at: '2026-09-17T00:00:00.000Z', log_stamp: '2026-09-16' });
  });
  it('previews exact capture but never stages or records a dry-run attempt', async () => {
    const { capture, engine, prepared } = fixture(true);
    await capture.onPrepared(prepared);
    expect(await capture.stage({ now: 'Now', focus: 'Focus', open_threads: 'Open', log_entry: 'Log' })).toBeNull();
    expect(engine.prepareProvenance.mock.calls[0]?.[0]).toMatchObject({ dry_run: true });
    expect(engine.stageProvenanceResult).not.toHaveBeenCalled();
    expect(engine.transitionProvenance).not.toHaveBeenCalled();
  });
});


it('preflights without a reservation and then captures the same request', async () => {
  const { capture, engine, prepared } = fixture(false, true);
  await capture.preflight(prepared);
  expect(engine.transitionProvenance).not.toHaveBeenCalled();
  expect(engine.stageProvenanceResult).not.toHaveBeenCalled();
  await capture.onPrepared(prepared);
  expect(engine.prepareProvenance.mock.calls.map(([req]) => req.dry_run)).toEqual([true, false]);
});

it.each(['provider', 'model', 'adapter_version', 'payload'] as const)('rejects changed %s before reservation', async key => {
  const { capture, engine, prepared } = fixture(false, true);
  await capture.preflight(prepared);
  await expect(capture.onPrepared({ ...prepared, [key]: key === 'payload' ? { changed: true } : 'changed' }))
    .rejects.toThrow('PROVENANCE_PREVIEW_MISMATCH');
  expect(engine.prepareProvenance).toHaveBeenCalledTimes(1);
  expect(engine.transitionProvenance).not.toHaveBeenCalled();
});

it('requires preflight for a budgeted capture and does not hide unsupported state', async () => {
  const { capture, engine, prepared } = fixture(false, true);
  await expect(capture.onPrepared(prepared)).rejects.toThrow('PROVENANCE_PREVIEW_REQUIRED');
  expect(engine.prepareProvenance).not.toHaveBeenCalled();
});

it('does not authorize capture after an invalid preview receipt', async () => {
  const { capture, engine, prepared } = fixture(false, true);
  engine.prepareProvenance.mockResolvedValueOnce({ dry_run: true, bundle_digest: '', payload_bytes: 1, reserved_bytes: 2, item_count: 3 });
  await expect(capture.preflight(prepared)).rejects.toThrow('PROVENANCE_PREVIEW_INVALID');
  await expect(capture.onPrepared(prepared)).rejects.toThrow('PROVENANCE_PREVIEW_REQUIRED');
  expect(engine.prepareProvenance).toHaveBeenCalledTimes(1);
  expect(engine.transitionProvenance).not.toHaveBeenCalled();
});
