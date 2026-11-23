// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WikiRebuildApi, WikiRebuildRun, WikiRebuildStatus } from '@vault/query-core';
import { WikiRebuild } from '../src/WikiRebuild.js';

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const run = (id: number, over: Partial<WikiRebuildRun> = {}): WikiRebuildRun => ({ id, ts: '2026-11-07T10:00:00.000Z', outcome: 'written',
  error: null, cost_usd: 0.25, input_tokens: 10, output_tokens: 5, duration_ms: 1000, ...over });
const status = (over: Partial<WikiRebuildStatus> = {}): WikiRebuildStatus => ({ project: 'Project', in_progress: null, paused: false,
  models: { planning: 'plan-model', page: 'page-model', home: 'home-model' }, latest_run: run(1), last_written: run(1),
  daily_budget: { cap_usd: 3, spent_usd: 1, remaining_usd: 2 }, ...over });
const ready = { in_progress: false as const, outcome: 'would_curate', detail: null, evidence_unchanged: false };

function api(over: Partial<WikiRebuildApi> = {}) {
  return { status: vi.fn(async () => status()), check: vi.fn(async () => ready),
    start: vi.fn(async () => ({ status: 'queued' as const })), ...over };
}
function show(a: WikiRebuildApi, extra: { onShowLatest?: () => void } = {}) {
  return render(<WikiRebuild api={a} project="Project" onClose={() => {}} onShowLatest={extra.onShowLatest ?? (() => {})} />);
}
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(3000); });

it('checks for free and starts nothing until confirmed, saying what it costs and uses', async () => {
  const a = api({ status: vi.fn(async () => status({ paused: true })), check: vi.fn(async () => ({ ...ready, evidence_unchanged: true })) });
  show(a);
  await screen.findByRole('button', { name: 'Rebuild wiki' });
  expect(a.start).not.toHaveBeenCalled();
  const text = document.body.textContent ?? '';
  for (const part of ['plan-model', 'page-model', 'home-model', '$0.250', '$2.00 of $3.00 left', 'Nothing has changed', 'Scheduled builds are off for this wiki'])
    expect(text).toContain(part);
});

it('starts once on confirm, follows the build and shows its result', async () => {
  const onShowLatest = vi.fn();
  const a = api();
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValueOnce(status({ in_progress: { since: 'now' } }));
  a.status.mockResolvedValue(status({ latest_run: run(2, { cost_usd: 0.5 }), last_written: run(2) }));
  show(a, { onShowLatest });
  fireEvent.click(await screen.findByRole('button', { name: 'Rebuild wiki' }));
  await screen.findByText(/Rebuilding/);
  await tick();
  await screen.findByText(/Rebuilding/);
  await tick();
  await screen.findByText(/rebuilt, for an estimated \$0.500/);
  expect(a.start).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Show the new build' }));
  expect(onShowLatest).toHaveBeenCalled();
  await tick();
  expect(a.status).toHaveBeenCalledTimes(3);
});

it('finds a build already running when reopened, without checking or starting', async () => {
  const a = api();
  a.status.mockResolvedValueOnce(status({ in_progress: { since: 'now' } }));
  a.status.mockResolvedValue(status({ latest_run: run(2) }));
  show(a);
  await screen.findByText(/Rebuilding/);
  await tick();
  await screen.findByText(/rebuilt/);
  expect(a.check).not.toHaveBeenCalled();
  expect(a.start).not.toHaveBeenCalled();
});

it('offers nothing to confirm when the check says it cannot run', async () => {
  show(api({ check: vi.fn(async () => ({ in_progress: false as const, outcome: 'error', detail: 'catalog: invalid', evidence_unchanged: false })) }));
  expect((await screen.findByRole('alert')).textContent).toBe('catalog: invalid');
  expect(screen.queryByRole('button', { name: 'Rebuild wiki' })).toBeNull();
});

it('puts a NO_WIKI refusal in plain words, pointing at Create project wiki', async () => {
  show(api({ check: vi.fn(async () => ({ in_progress: false as const, outcome: 'error',
    detail: 'NO_WIKI: "Project" has no project wiki; ask the curator to create one (create-project-wiki)', evidence_unchanged: false })) }));
  expect((await screen.findByRole('alert')).textContent)
    .toBe('"Project" has no project wiki yet. Run Create project wiki on its project note to start one.');
});

it('says so when the check cannot reach Curator', async () => {
  show(api({ status: vi.fn(async () => { throw new Error('down'); }) }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Cannot check this wiki/);
});

it('shows a refusal from the start', async () => {
  const a = api({ start: vi.fn(async () => ({ status: 'refused' as const, detail: 'no wiki yet' })) });
  show(a);
  fireEvent.click(await screen.findByRole('button', { name: 'Rebuild wiki' }));
  expect((await screen.findByRole('alert')).textContent).toBe('no wiki yet');
});

it('never repeats a start with no clear reply, and finds it running from status', async () => {
  const a = api({ start: vi.fn(async () => { throw new Error('lost'); }) });
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValue(status({ in_progress: { since: 'now' } }));
  show(a);
  fireEvent.click(await screen.findByRole('button', { name: 'Rebuild wiki' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't confirm it started/);
  await tick();
  expect(a.start).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Rebuild wiki' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check status now' }));
  await screen.findByText(/Rebuilding/);
});

it('stays unresolved when a lost start shows no sign yet, and offers it again only after reopening', async () => {
  const a = api({ start: vi.fn(async () => { throw new Error('lost'); }) });
  const first = show(a);
  fireEvent.click(await screen.findByRole('button', { name: 'Rebuild wiki' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Check status now' }));
  await screen.findByText(/No sign of it yet/);
  expect(screen.queryByRole('button', { name: 'Rebuild wiki' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check status now' }));
  await screen.findByText(/No sign of it yet/);
  first.unmount();
  show(a);
  await screen.findByRole('button', { name: 'Rebuild wiki' });
  expect(a.start).toHaveBeenCalledTimes(1);
});

it('picks up a lost start that shows up on a later check', async () => {
  const a = api({ start: vi.fn(async () => { throw new Error('lost'); }) });
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValue(status({ in_progress: { since: 'now' } }));
  show(a);
  fireEvent.click(await screen.findByRole('button', { name: 'Rebuild wiki' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Check status now' }));
  await screen.findByText(/No sign of it yet/);
  fireEvent.click(screen.getByRole('button', { name: 'Check status now' }));
  await screen.findByText(/Rebuilding/);
  expect(a.start).toHaveBeenCalledTimes(1);
});

it('keeps the result when reopened after the build recorded its run but before it finished', async () => {
  const a = api();
  const recorded = run(2, { ts: '2026-11-07T10:05:00.000Z' });
  a.status.mockResolvedValueOnce(status({ in_progress: { since: '2026-11-07T10:04:00.000Z' }, latest_run: recorded }));
  a.status.mockResolvedValue(status({ latest_run: recorded, last_written: recorded }));
  show(a);
  await screen.findByText(/Rebuilding/);
  await tick();
  await screen.findByText(/rebuilt/);
  screen.getByRole('button', { name: 'Show the new build' });
});

it('does not take an older run for the result of a build in progress', async () => {
  const a = api();
  const older = run(1, { ts: '2026-11-07T10:00:00.000Z' });
  a.status.mockResolvedValueOnce(status({ in_progress: { since: '2026-11-07T10:04:00.000Z' }, latest_run: older }));
  a.status.mockResolvedValue(status({ latest_run: older }));
  show(a);
  await screen.findByText(/Rebuilding/);
  await tick();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.queryByRole('button', { name: 'Show the new build' })).toBeNull();
  expect(screen.queryByText(/Rebuilding/)).toBeNull();
});

it('treats a new run found after a lost reply as the result', async () => {
  const a = api({ start: vi.fn(async () => { throw new Error('lost'); }) });
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValue(status({ latest_run: run(2) }));
  show(a);
  fireEvent.click(await screen.findByRole('button', { name: 'Rebuild wiki' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Check status now' }));
  await screen.findByText(/rebuilt/);
});

it.each([
  [{ outcome: 'skipped_budget' }, /spend cap was reached/],
  [{ outcome: 'error', error: 'home synthesis failed' }, /failed: home synthesis failed/],
  [{ outcome: 'skipped_mode_disabled' }, /finished without rebuilding \(skipped_mode_disabled\)/],
])('explains a finished run: %j', async (over, message) => {
  const a = api();
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValue(status({ latest_run: run(2, over) }));
  show(a);
  fireEvent.click(await screen.findByRole('button', { name: 'Rebuild wiki' }));
  await screen.findByText(/Rebuilding/);
  await tick();
  await screen.findByText(message);
  expect(screen.queryByRole('button', { name: 'Show the new build' })).toBeNull();
});

it('stops polling on a failed status read and lets you retry, without starting again', async () => {
  const a = api();
  a.status.mockResolvedValueOnce(status());
  a.status.mockRejectedValueOnce(new Error('blip'));
  a.status.mockResolvedValue(status({ latest_run: run(2) }));
  show(a);
  fireEvent.click(await screen.findByRole('button', { name: 'Rebuild wiki' }));
  await screen.findByText(/Rebuilding/);
  await tick();
  expect((await screen.findByRole('alert')).textContent).toMatch(/may still be running/);
  fireEvent.click(screen.getByRole('button', { name: 'Check status now' }));
  await screen.findByText(/rebuilt/);
  expect(a.start).toHaveBeenCalledTimes(1);
});

it('says a topic wiki can only be rebuilt whole, with its web research, and that a paused one stays paused (#425)', async () => {
  const a = api({ status: vi.fn(async () => status({ kind: 'topic', source: 'vault+web', root_node_id: 'root', paused: true })),
    check: vi.fn(async () => ({ ...ready, evidence_unchanged: true })) });
  show(a);
  await screen.findByRole('button', { name: 'Rebuild wiki' });
  const text = document.body.textContent ?? '';
  for (const part of ['only be rebuilt whole: not one page or its home on its own', 'searches the web',
    'None of its notes have changed since the last build. The web search may still turn up something new.', 'scheduled builds stay off afterwards'])
    expect(text).toContain(part);
  expect(text).not.toContain('Nothing has changed since the last build');
});

it('leaves out the web for a topic wiki built from notes only, and the topic lines for a project wiki', async () => {
  show(api({ status: vi.fn(async () => status({ kind: 'topic', source: 'vault' })), check: vi.fn(async () => ({ ...ready, evidence_unchanged: true })) }));
  await screen.findByRole('button', { name: 'Rebuild wiki' });
  expect(document.body.textContent).toContain('only be rebuilt whole');
  expect(document.body.textContent).not.toContain('searches the web');
  expect(document.body.textContent).toContain('Nothing has changed since the last build');
  cleanup();
  show(api({ status: vi.fn(async () => status({ kind: 'project' })) }));
  await screen.findByRole('button', { name: 'Rebuild wiki' });
  expect(document.body.textContent).not.toContain('topic wiki');
});
