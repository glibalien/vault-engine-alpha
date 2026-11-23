// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiCreateApi, WikiCreateCheck, WikiCreateStart, WikiRebuildApi, WikiRebuildRun, WikiRebuildStatus } from '@vault/query-core';
import { WikiCreate } from '../src/WikiCreate.js';

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const run = (id: number, over: Partial<WikiRebuildRun> = {}): WikiRebuildRun => ({ id, ts: '2026-11-09T10:00:00.000Z', outcome: 'written',
  error: null, cost_usd: 0.25, input_tokens: 10, output_tokens: 5, duration_ms: 1000, ...over });
const status = (over: Partial<WikiRebuildStatus> = {}): WikiRebuildStatus => ({ project: 'Project', in_progress: null, paused: false,
  models: { planning: 'plan-model', page: 'page-model', home: 'home-model' }, latest_run: null, last_written: null,
  daily_budget: { cap_usd: 3, spent_usd: 1, remaining_usd: 2 }, queue: { running: false, depth: 0 }, ...over });
const ready: WikiCreateCheck = { status: 'ready', home_missing: true };
const building = (current = 'Project') => status({ in_progress: { since: 'now' }, queue: { running: true, depth: 1, current } });
const CREATE = 'Create project wiki (paid)';

function api(over: Partial<WikiCreateApi> = {}) {
  return { status: vi.fn(async () => status()), check: vi.fn(async (): Promise<WikiCreateCheck> => ready),
    start: vi.fn(async (): Promise<WikiCreateStart> => ({ status: 'queued' })), ...over };
}
function show(a: WikiCreateApi, extra: { onRegistered?: () => void; onOpenWiki?: () => void; onClose?: () => void; projectRef?: string;
  rebuild?: WikiRebuildApi } = {}) {
  return render(<WikiCreate api={a} project="Project" onClose={() => {}} {...extra} />);
}
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(3000); });

it('checks for free and starts nothing until confirmed, saying what it costs and uses', async () => {
  const a = api();
  show(a);
  await screen.findByRole('button', { name: CREATE });
  expect(a.start).not.toHaveBeenCalled();
  const text = document.body.textContent ?? '';
  for (const part of ['This check was free', 'writes an empty home page', 'plan-model', 'page-model', 'home-model',
    'counts against today\'s Curator budget', '$2.00 left of $3.00'])
    expect(text).toContain(part);
  expect(text).not.toContain('budget is spent');
});

it('warns before confirming when today\'s budget is spent or the wiki is paused', async () => {
  show(api({ status: vi.fn(async () => status({ paused: true, daily_budget: { cap_usd: 3, spent_usd: 3, remaining_usd: 0 } })),
    check: vi.fn(async (): Promise<WikiCreateCheck> => ({ status: 'ready', home_missing: false })) }));
  await screen.findByRole('button', { name: CREATE });
  const text = document.body.textContent ?? '';
  expect(text).toContain('budget is spent, so the first build wouldn\'t run now');
  expect(text).toContain('A pause set on this wiki earlier still holds, so creating it won\'t run its first build');
  expect(text).not.toContain('writes an empty home page');
  expect(text).not.toMatch(/sweep|until it is resumed/);
});

it('creates once on confirm, follows queued then building, and shows the cost', async () => {
  const onRegistered = vi.fn(), onOpenWiki = vi.fn();
  const a = api();
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValueOnce(building('Another project'));
  a.status.mockResolvedValueOnce(building());
  a.status.mockResolvedValue(status({ latest_run: run(1, { cost_usd: 0.5 }), last_written: run(1) }));
  show(a, { onRegistered, onOpenWiki });
  fireEvent.click(await screen.findByRole('button', { name: CREATE }));
  await screen.findByText(/^Queued\. The first build/);
  expect(onRegistered).toHaveBeenCalled();
  await tick();
  await screen.findByText(/ahead of it finishes/);
  await tick();
  await screen.findByText(/Building the wiki/);
  await tick();
  await screen.findByText('The wiki was built, for an estimated $0.500.');
  expect(a.start).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Open the wiki' }));
  expect(onOpenWiki).toHaveBeenCalled();
  await tick();
  expect(a.status).toHaveBeenCalledTimes(4);
});

it('creates by the note\'s ref and follows the build by its title', async () => {
  const a = api();
  show(a, { projectRef: 'Clients/Project.md' });
  fireEvent.click(await screen.findByRole('button', { name: CREATE }));
  await screen.findByText(/^Queued/);
  expect(a.check).toHaveBeenCalledWith('Clients/Project.md');
  expect(a.start).toHaveBeenCalledWith('Clients/Project.md');
  expect(a.status).toHaveBeenCalledWith('Project');
});

it('offers to move a renamed project\'s wiki to its new title, for free', async () => {
  const onRegistered = vi.fn();
  const a = api({ check: vi.fn(async (): Promise<WikiCreateCheck> => ({ status: 'renamed', from: 'Old Name' })),
    start: vi.fn(async (): Promise<WikiCreateStart> => ({ status: 'exists' })) });
  show(a, { onRegistered });
  const move = await screen.findByRole('button', { name: 'Move the wiki to this name' });
  expect(document.body.textContent).toContain('still registered under its old name, "Old Name"');
  expect(screen.queryByRole('button', { name: CREATE })).toBeNull();
  expect(onRegistered).not.toHaveBeenCalled();
  fireEvent.click(move);
  await screen.findByText('The wiki now goes by "Project" instead of "Old Name".');
  expect(a.start).toHaveBeenCalledTimes(1);
  expect(onRegistered).toHaveBeenCalled();
});

it('says the project already has a wiki, offering nothing to create', async () => {
  const onRegistered = vi.fn();
  show(api({ check: vi.fn(async (): Promise<WikiCreateCheck> => ({ status: 'exists' })) }), { onRegistered, onOpenWiki: () => {} });
  await screen.findByText(/already has a wiki/);
  expect(screen.queryByRole('button', { name: CREATE })).toBeNull();
  expect(screen.getByRole('button', { name: 'Open the wiki' })).toBeTruthy();
  expect(onRegistered).toHaveBeenCalled();
});

it('finds a build already running, without checking or starting', async () => {
  const a = api();
  a.status.mockResolvedValueOnce(building());
  a.status.mockResolvedValue(status({ latest_run: run(1) }));
  show(a);
  await screen.findByText(/Building the wiki/);
  await tick();
  await screen.findByText(/The wiki was built/);
  expect(a.check).not.toHaveBeenCalled();
  expect(a.start).not.toHaveBeenCalled();
});

it.each([
  ['NOT_A_PROJECT', '"Project" is not a project note', /isn't a project note/],
  ['UNKNOWN_PROJECT', 'No project note matches "Project": not found', /can't find a project note called "Project"/],
  ['TITLE_IN_USE', '"Project" is already a topic wiki', /A topic wiki already uses the name "Project"/],
  ['TITLE_IN_USE', '"Project" is still registered to a renamed project; call create-project-wiki for that project under its new title first',
    /belongs to the wiki of a project note that was renamed/],
  ['FORBIDDEN', 'missing required scope: curate:trigger', /needs the curate:read and curate:trigger scopes/],
])('puts the check\'s %s refusal in plain words', async (code, message, expected) => {
  show(api({ check: vi.fn(async (): Promise<WikiCreateCheck> => ({ status: 'refused', code, message })) }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toMatch(expected);
  expect(alert.textContent).not.toContain(code);
  expect(screen.queryByRole('button', { name: CREATE })).toBeNull();
});

it('shows a refusal from the start, and counts a wiki whose home failed as registered', async () => {
  const onRegistered = vi.fn();
  show(api({ start: vi.fn(async (): Promise<WikiCreateStart> => ({ status: 'refused', code: 'HOME_CREATE_FAILED',
    message: '"Project" is registered, but its empty home could not be written (calling create-project-wiki again writes it): conflict' })) }), { onRegistered });
  fireEvent.click(await screen.findByRole('button', { name: CREATE }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/is registered, but its empty home could not be written/);
  expect(onRegistered).toHaveBeenCalled();
});

it.each([
  [{ status: 'not_started', outcome: 'skipped', detail: 'paused' } as WikiCreateStart,
    /a pause set on it earlier still holds, so its first build didn't run\. To build it, open its home page and, in the wiki panel, choose Rebuild… on the Wiki row; the wiki stays paused\.$/],
  [{ status: 'registered' } as WikiCreateStart, /registered again/],
  [{ status: 'exists' } as WikiCreateStart, /already has a wiki/],
  [{ status: 'not_started', outcome: 'error', detail: 'NO_WIKI: "Project" has no project wiki; ask the curator to create one (create-project-wiki)' } as WikiCreateStart,
    /first build didn't run: "Project" has no project wiki yet\. Run Create project wiki on its project note to start one\.$/],
])('answers a start the Curator settled at once (%o)', async (started, expected) => {
  const a = api({ start: vi.fn(async () => started) });
  show(a);
  fireEvent.click(await screen.findByRole('button', { name: CREATE }));
  await screen.findByText(expected);
  await tick();
  expect(a.status).toHaveBeenCalledTimes(1);
});

it.each([
  [run(1, { outcome: 'skipped_budget', cost_usd: null }),
    /budget is spent, so the first build didn't run\. The wiki is registered with an empty home\. To build it once there's budget, open its home page/],
  [run(1, { outcome: 'error', error: 'NO_WIKI: "Project" has no project wiki; ask the curator to create one (create-project-wiki)', cost_usd: 0.1 }),
    /failed: "Project" has no project wiki yet\. .* It spent an estimated \$0\.100 first\./],
])('says why a first build didn\'t write the wiki (%#)', async (finished, expected) => {
  const a = api();
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValue(status({ latest_run: finished }));
  show(a);
  fireEvent.click(await screen.findByRole('button', { name: CREATE }));
  await screen.findByText(/^Queued/);
  await tick();
  const message = await screen.findByText(expected);
  expect(message.textContent).not.toMatch(/NO_WIKI|skipped_budget/);
  expect(screen.queryByRole('button', { name: 'Open the wiki' })).toBeNull();
});

it('never repeats a start with no clear reply, and finds it running from status', async () => {
  const a = api({ start: vi.fn(async () => { throw new Error('lost'); }) });
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValue(building());
  show(a);
  fireEvent.click(await screen.findByRole('button', { name: CREATE }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't confirm it started/);
  fireEvent.click(screen.getByRole('button', { name: 'Check status now' }));
  await screen.findByText(/No sign of it yet/);
  expect(screen.queryByRole('button', { name: CREATE })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check status now' }));
  await screen.findByText(/Building the wiki/);
  expect(a.start).toHaveBeenCalledTimes(1);
});

it('says so when the check cannot reach Curator', async () => {
  show(api({ status: vi.fn(async () => { throw new Error('down'); }) }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Cannot check this project/);
});

describe('a first build stopped by a pause from before the create (#544)', () => {
  const ready = { in_progress: false as const, outcome: 'would_curate', detail: null, evidence_unchanged: false };
  const rebuildApi = () => ({ status: vi.fn(async () => status({ paused: true })), check: vi.fn(async () => ready),
    start: vi.fn(async () => ({ status: 'queued' as const })) });
  const pausedStart = () => api({ status: vi.fn(async () => status({ paused: true })),
    start: vi.fn(async (): Promise<WikiCreateStart> => ({ status: 'not_started', outcome: 'skipped', detail: 'paused' })) });

  it('says the pause predates the create and offers Build it now: the forced whole-wiki build, which leaves it paused', async () => {
    const onOpenWiki = vi.fn();
    const rebuild = rebuildApi();
    rebuild.status.mockResolvedValueOnce(status({ paused: true }));
    rebuild.status.mockResolvedValueOnce(status({ paused: true, in_progress: { since: 'now' } }));
    rebuild.status.mockResolvedValue(status({ paused: true, latest_run: run(1, { cost_usd: 0.5 }), last_written: run(1) }));
    show(pausedStart(), { rebuild, onOpenWiki });
    fireEvent.click(await screen.findByRole('button', { name: CREATE }));
    await screen.findByText(/^The wiki is registered, but a pause set on it earlier still holds, so its first build didn't run\. Building it now runs that build and leaves the wiki paused\.$/);
    expect(document.body.textContent).not.toMatch(/sweep|until it is resumed/);
    expect(rebuild.status).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Build it now…' }));
    // The rebuild panel: its free check first, and nothing paid until confirmed.
    const confirm = await screen.findByRole('button', { name: 'Rebuild wiki' });
    expect(rebuild.check).toHaveBeenCalledWith('Project');
    expect(rebuild.start).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('This rebuild still runs, and scheduled builds stay off afterwards.');
    fireEvent.click(confirm);
    await screen.findByText(/Rebuilding/);
    expect(rebuild.start).toHaveBeenCalledTimes(1);
    expect(rebuild.start).toHaveBeenCalledWith('Project');
    await tick();
    await screen.findByText(/Rebuilding/);
    await tick();
    await screen.findByText(/rebuilt, for an estimated \$0\.500/);
    fireEvent.click(screen.getByRole('button', { name: 'Show the new build' }));
    expect(onOpenWiki).toHaveBeenCalled();
  });

  it('closes from the build panel as from the create panel', async () => {
    const onClose = vi.fn();
    show(pausedStart(), { rebuild: rebuildApi(), onClose });
    fireEvent.click(await screen.findByRole('button', { name: CREATE }));
    fireEvent.click(await screen.findByRole('button', { name: 'Build it now…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('offers no Build it now for other outcomes', async () => {
    show(api({ start: vi.fn(async (): Promise<WikiCreateStart> => ({ status: 'registered' })) }), { rebuild: rebuildApi() });
    fireEvent.click(await screen.findByRole('button', { name: CREATE }));
    await screen.findByText(/registered again/);
    expect(screen.queryByRole('button', { name: 'Build it now…' })).toBeNull();
  });
});
