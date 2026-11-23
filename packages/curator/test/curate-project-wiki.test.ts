import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { CurateResult } from '../src/types.js';

vi.mock('../src/core.js', () => ({ triggerCuration: vi.fn(), startOnDemandCuration: vi.fn() }));
import { startOnDemandCuration, triggerCuration } from '../src/core.js';
import { makeCurateProjectWikiHandler } from '../src/tools/curate-project-wiki.js';

const triggerExtra = { authInfo: { scopes: ['curate:trigger'] } };

beforeEach(() => { (triggerCuration as Mock).mockReset(); (startOnDemandCuration as Mock).mockReset(); });

describe('curate-project-wiki handler', () => {
  it('curates a single project and surfaces evidence_hash in the report', async () => {
    (triggerCuration as Mock).mockResolvedValue([{
      project: 'Demo', outcome: 'written', detail: 'home updated', dryRun: false,
      usage: { input: 1, output: 2, cacheWrite: 0, cacheRead: 0 }, costUsd: 0.01,
      evidenceHash: 'h1',
    } as CurateResult]);
    const handler = makeCurateProjectWikiHandler({} as never);
    const res = await handler({ project: 'Demo', dry_run: false, force: false }, triggerExtra);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.mode).toBe('project');
    expect(body.results[0].outcome).toBe('written');
    expect(body.results[0].evidence_hash).toBe('h1');
    expect(body.summary).toMatchObject({ total: 1, written: 1, skipped: 0, errors: 0 });
    expect(triggerCuration).toHaveBeenCalledWith(
      expect.anything(),
      { project: 'Demo', force: false, dryRun: false, preview: false, limit: null },
      'on-demand',
    );
  });

  it('sweeps when project is omitted and reports mode:sweep', async () => {
    (triggerCuration as Mock).mockResolvedValue([
      { project: 'A', outcome: 'written', dryRun: false } as CurateResult,
      { project: 'B', outcome: 'skipped', dryRun: false } as CurateResult,
    ]);
    const handler = makeCurateProjectWikiHandler({} as never);
    const res = await handler({ dry_run: false, force: false, limit: 5 }, triggerExtra);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.mode).toBe('sweep');
    expect(body.summary).toMatchObject({ total: 2, written: 1, skipped: 1, errors: 0 });
    expect(triggerCuration).toHaveBeenCalledWith(
      expect.anything(),
      { project: null, force: false, dryRun: false, preview: false, limit: 5 },
      'on-demand',
    );
  });

  it('threads dry_run/force through and previews sections under dry_run', async () => {
    const sections = { now: 'N', focus: 'F', open_threads: 'O', log_entry: 'L' };
    (triggerCuration as Mock).mockResolvedValue([{
      project: 'Demo', outcome: 'written', dryRun: true, sections,
    } as CurateResult]);
    const handler = makeCurateProjectWikiHandler({} as never);
    const res = await handler({ project: 'Demo', dry_run: true, force: true }, triggerExtra);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.dry_run).toBe(true);
    expect(body.results[0].sections).toEqual(sections);
    expect(triggerCuration).toHaveBeenCalledWith(
      expect.anything(),
      { project: 'Demo', force: true, dryRun: true, preview: false, limit: null },
      'on-demand',
    );
  });

  it('forwards paid preview only together with dry_run', async () => {
    (triggerCuration as Mock).mockResolvedValue([]);
    const handler = makeCurateProjectWikiHandler({} as never);
    await handler({ project: 'Demo', dry_run: true, preview: true, force: false }, triggerExtra);
    await handler({ project: 'Demo', dry_run: false, preview: true, force: false }, triggerExtra);
    expect((triggerCuration as Mock).mock.calls.map(([, args]) => [args.dryRun, args.preview])).toEqual([[true, true], [false, false]]);
  });

  it('on the server, replies with the queued status instead of waiting for the curation', async () => {
    const builds = {};
    (startOnDemandCuration as Mock).mockResolvedValue({ status: 'queued', project: 'Demo', queued_at: '2026-11-01T00:00:00.000Z', detail: 'Queued.' });
    const handler = makeCurateProjectWikiHandler({ builds } as never);
    const res = await handler({ project: 'Demo', dry_run: false, force: false }, triggerExtra);
    expect(JSON.parse(res.content[0]!.text)).toEqual({ mode: 'project', dry_run: false, status: 'queued', project: 'Demo',
      queued_at: '2026-11-01T00:00:00.000Z', detail: 'Queued.' });
    expect(startOnDemandCuration).toHaveBeenCalledWith({ builds }, builds,
      { project: 'Demo', force: false, dryRun: false, preview: false, limit: null }, 'on-demand');
    expect(triggerCuration).not.toHaveBeenCalled();
  });

  it('on the server, reports an answer given before queueing and runs dry runs synchronously', async () => {
    const handler = makeCurateProjectWikiHandler({ builds: {} } as never);
    (startOnDemandCuration as Mock).mockResolvedValueOnce([{ project: 'Demo', outcome: 'error', detail: 'NO_WIKI', dryRun: false } as CurateResult]);
    const refused = JSON.parse((await handler({ project: 'Demo', dry_run: false, force: false }, triggerExtra)).content[0]!.text);
    expect(refused).toMatchObject({ mode: 'project', results: [{ outcome: 'error', detail: 'NO_WIKI' }] });
    (startOnDemandCuration as Mock).mockResolvedValueOnce(null);
    (triggerCuration as Mock).mockResolvedValueOnce([{ project: 'Demo', outcome: 'would_curate', dryRun: true } as CurateResult]);
    const dry = JSON.parse((await handler({ project: 'Demo', dry_run: true, force: false }, triggerExtra)).content[0]!.text);
    expect(dry).toMatchObject({ mode: 'project', dry_run: true, results: [{ outcome: 'would_curate' }] });
    expect(triggerCuration).toHaveBeenCalledTimes(1);
  });

  it('enforces the curate:trigger scope', async () => {
    const handler = makeCurateProjectWikiHandler({} as never);
    const res = await handler({ project: 'Demo', dry_run: false, force: false }, { authInfo: { scopes: [] } });
    expect(res.isError).toBe(true);
    expect(triggerCuration).not.toHaveBeenCalled();
  });
});
