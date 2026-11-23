// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DossierApi, DossierCheck, DossierPreview, DossierStart, WikiRebuildRun, WikiRebuildStatus } from '@vault/query-core';
import { DossierBuild } from '../src/DossierBuild.js';

// Fictional people only (repository rule).

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const run = (id: number, over: Partial<WikiRebuildRun> = {}): WikiRebuildRun => ({ id, ts: '2026-11-21T10:00:00.000Z', outcome: 'written',
  error: null, cost_usd: 0.006, input_tokens: 10, output_tokens: 5, duration_ms: 1000, ...over });
const status = (over: Partial<WikiRebuildStatus> = {}): WikiRebuildStatus => ({ project: 'Dana Whitfield Dossier', in_progress: null, paused: false,
  models: { planning: 'plan-model', page: 'page-model', home: 'home-model' }, latest_run: null, last_written: null,
  daily_budget: { cap_usd: 3, spent_usd: 1, remaining_usd: 2 }, queue: { running: false, depth: 0 }, ...over });
const preview = (over: Partial<DossierPreview> = {}): DossierPreview => ({ status: 'ready', page_title: 'Dana Whitfield Dossier', action: 'create',
  subject_kind: 'person', reads: { memories: 74, memories_shown: 60, past: 2, rules: 3, notes: 4, meetings: 3, read_in_full: 5 },
  sections: ['Who', 'Relationships', 'Preferences', 'History', 'Open items'], model: 'home-model', calls: 2,
  estimated_usd: 0.006, worst_case_usd: 0.05, fits: true, refusal: null, remaining_usd: 2, cap_usd: 3, rebuild: 'manual', ...over });
const BUILD = 'Build dossier';

function api(over: Partial<DossierApi> = {}) {
  return { status: vi.fn(async () => status()), check: vi.fn(async (): Promise<DossierCheck> => preview()),
    start: vi.fn(async (): Promise<DossierStart> => ({ status: 'queued', page_title: 'Dana Whitfield Dossier' })), ...over };
}
const note = vi.fn(async () => ({ id: 'dana', title: 'Dana Whitfield' }));
function show(a: DossierApi, extra: { onOpenPage?: (title: string) => void } = {}) {
  return render(<DossierBuild api={a} note={note} noteTitle="Dana Whitfield" noteRef="People/Dana Whitfield.md" onClose={() => {}} {...extra} />);
}
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(3000); });

it('previews for free what it reads and costs, and builds nothing until confirmed', async () => {
  const a = api();
  show(a);
  await screen.findByRole('button', { name: BUILD });
  expect(note).toHaveBeenCalledWith('People/Dana Whitfield.md');
  expect(a.check).toHaveBeenCalledWith('dana');
  expect(a.start).not.toHaveBeenCalled();
  expect(screen.getByRole('heading', { name: 'Build a dossier for Dana Whitfield?' })).toBeTruthy();
  const text = document.body.textContent ?? '';
  for (const part of ['A new page, “Dana Whitfield Dossier”', 'Who, Relationships, Preferences, History and Open items', 'Rules on what to say',
    '60 of the 74 memories about it', '2 past facts', 'the 4 notes and 3 meetings that link to it, the newest 5 in full',
    'This check was free', '2 paid model calls', 'Dana Whitfield’s 3 rules on what may be said', 'home-model',
    'about $0.006, at most $0.050', '$2.00 of $3.00 left', 'rebuilt only when you ask', 'Dana Whitfield and your other notes'])
    expect(text).toContain(part);
  // A first build leaves no text of the user's on a page that doesn't exist yet.
  expect(text).not.toContain('Your own text on this page');
  expect((screen.getByRole('checkbox', { name: 'Rebuild it nightly when it falls behind' }) as HTMLInputElement).checked).toBe(false);
});

it('builds on confirm, follows it by the page\'s status, and offers the page once written', async () => {
  const a = api();
  const statuses = [status({ latest_run: run(4) }), status({ in_progress: { since: 'now' }, queue: { running: true, depth: 1, current: 'Dana Whitfield Dossier' } }),
    status({ latest_run: run(5) })];
  a.status.mockImplementation(async () => statuses.shift() ?? status({ latest_run: run(5) }));
  const onOpenPage = vi.fn();
  show(a, { onOpenPage });
  fireEvent.click(await screen.findByRole('button', { name: BUILD }));
  await screen.findByText(/^Sent to Curator\. This usually takes/);
  expect(a.start).toHaveBeenCalledWith('dana');
  expect(screen.queryByRole('button', { name: BUILD })).toBeNull();
  // Once sent, the heading says what is happening, not the question that was answered (#715).
  expect(screen.getByRole('heading', { name: 'Building “Dana Whitfield Dossier”' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Build a dossier for Dana Whitfield?' })).toBeNull();
  expect(document.body.textContent).toContain('The wiki panel shows how it stands.');
  await tick();
  await screen.findByText(/^Curator is writing it now\./);
  await tick();
  await screen.findByText('"Dana Whitfield Dossier" was written, for an estimated $0.006.');
  expect(screen.getByRole('heading', { name: '“Dana Whitfield Dossier” is ready' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open the dossier' }));
  expect(onOpenPage).toHaveBeenCalledWith('Dana Whitfield Dossier');
});

it('names the build it waits behind in the Curator\'s lane', async () => {
  const a = api();
  const statuses = [status(), status({ in_progress: { since: 'now' }, queue: { running: true, depth: 2, current: 'Avery Stone Dossier' } }),
    status({ in_progress: { since: 'now' }, queue: { running: true, depth: 1, current: 'Dana Whitfield Dossier' } })];
  a.status.mockImplementation(async () => statuses.shift() ?? status({ latest_run: run(5) }));
  show(a);
  fireEvent.click(await screen.findByRole('button', { name: BUILD }));
  await screen.findByText(/^Sent to Curator/);
  await tick();
  await screen.findByText('Curator is finishing “Avery Stone Dossier” first. This build starts after it.');
  expect(screen.getByRole('heading', { name: '“Dana Whitfield Dossier” is queued' })).toBeTruthy();
  await tick();
  await screen.findByText(/^Curator is writing it now\./);
  expect(screen.getByRole('heading', { name: 'Building “Dana Whitfield Dossier”' })).toBeTruthy();
});

it('says a rebuild, the nightly mode, and a build that does not fit today\'s cap, which it does not offer', async () => {
  const a = api({ check: vi.fn(async (): Promise<DossierCheck> => preview({ action: 'rebuild', rebuild: 'on-change', fits: false,
    refusal: 'daily budget: $3.0000 spent or in flight of $3.00; this build could cost up to $0.0500' })) });
  show(a);
  const button = await screen.findByRole('button', { name: 'Rebuild dossier' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('heading', { name: 'Rebuild “Dana Whitfield Dossier”?' })).toBeTruthy();
  const text = document.body.textContent ?? '';
  expect(text).toContain('Your own text on this page');
  expect(text).toContain('The nightly sweep rebuilds it when it falls behind');
  expect((screen.getByRole('checkbox', { name: 'Rebuild it nightly when it falls behind' }) as HTMLInputElement).checked).toBe(true);
  expect(text).toContain('daily budget: $3.0000 spent');
});

it('shows a refusal in the Curator\'s words, and a failed build\'s reason', async () => {
  const refused = api({ check: vi.fn(async (): Promise<DossierCheck> => ({ status: 'refused', code: 'PROJECT_NOTE',
    message: '"Pilot" is a project. A project\'s dossier is its project wiki.' })) });
  show(refused);
  await screen.findByText('"Pilot" is a project. A project\'s dossier is its project wiki.');
  expect(screen.getByRole('heading', { name: 'Can’t build a dossier for Dana Whitfield' })).toBeTruthy();
  cleanup();
  const failed = api({ status: vi.fn().mockResolvedValueOnce(status()).mockResolvedValue(status({ latest_run: run(1, { outcome: 'error',
    error: 'The model call failed (provider_error); nothing was written.' }) })) });
  show(failed);
  fireEvent.click(await screen.findByRole('button', { name: BUILD }));
  await screen.findByText(/^Sent to Curator\. This usually takes/);
  await tick();
  await screen.findByText('The build failed: The model call failed (provider_error); nothing was written.');
  expect(screen.getByRole('heading', { name: '“Dana Whitfield Dossier” wasn’t written' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open the dossier' })).toBeNull();
});

it('settles a build request with no clear reply by reading status, never starting it again', async () => {
  const a = api({ start: vi.fn(async () => { throw new Error('lost'); }) });
  show(a);
  fireEvent.click(await screen.findByRole('button', { name: BUILD }));
  await screen.findByText(/Couldn't confirm it started/);
  expect(screen.getByRole('heading', { name: 'Did the build start?' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Check status now' }));
  await screen.findByText(/No sign of it yet/);
  expect(a.start).toHaveBeenCalledTimes(1);
});

it('sets nightly rebuilds as part of the build, only when the choice differs from the note\'s', async () => {
  const a = api();
  show(a);
  const box = await screen.findByRole('checkbox', { name: 'Rebuild it nightly when it falls behind' });
  fireEvent.click(box);
  expect(document.body.textContent).toContain('Saved on Dana Whitfield as dossier: on-change when the build starts');
  fireEvent.click(screen.getByRole('button', { name: BUILD }));
  await screen.findByText(/^Sent to Curator\. This usually takes/);
  expect(a.start).toHaveBeenCalledWith('dana', 'on-change');
  cleanup();
  const kept = api({ check: vi.fn(async (): Promise<DossierCheck> => preview({ action: 'rebuild', rebuild: 'on-change' })) });
  show(kept);
  fireEvent.click(await screen.findByRole('button', { name: 'Rebuild dossier' }));
  await screen.findByText(/^Sent to Curator\. This usually takes/);
  expect(kept.start).toHaveBeenCalledWith('dana');
});

it('turns nightly rebuilds off with the build when the box is cleared', async () => {
  const a = api({ check: vi.fn(async (): Promise<DossierCheck> => preview({ action: 'rebuild', rebuild: 'on-change' })) });
  show(a);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Rebuild it nightly when it falls behind' }));
  expect(document.body.textContent).toContain('Taken off Dana Whitfield when the build starts');
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild dossier' }));
  await screen.findByText(/^Sent to Curator\. This usually takes/);
  expect(a.start).toHaveBeenCalledWith('dana', 'manual');
});
