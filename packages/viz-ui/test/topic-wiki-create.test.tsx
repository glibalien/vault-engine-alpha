// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  TopicProposal, TopicProposalCheck, TopicWikiApi, TopicWikiStart, WikiCreateRefusal, WikiRebuildRun, WikiRebuildStatus,
} from '@vault/query-core';
import { TopicWikiCreate } from '../src/TopicWikiCreate.js';

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const run = (id: number, over: Partial<WikiRebuildRun> = {}): WikiRebuildRun => ({ id, ts: '2026-11-09T10:00:00.000Z', outcome: 'written',
  error: null, cost_usd: 0.4, input_tokens: 10, output_tokens: 5, duration_ms: 1000, ...over });
const status = (over: Partial<WikiRebuildStatus> = {}): WikiRebuildStatus => ({ project: 'X', in_progress: null, paused: true,
  models: { planning: 'plan-model', page: 'page-model', home: 'home-model' }, latest_run: null, last_written: null,
  daily_budget: { cap_usd: 3, spent_usd: 1, remaining_usd: 2 }, queue: { running: false, depth: 0 }, ...over });
const building = (current: string) => status({ in_progress: { since: 'now' }, queue: { running: true, depth: 1, current } });
const proposal = (over: Partial<TopicProposal> = {}): TopicProposal => ({
  status: 'proposed', topic: 'The 2026 Metro Owls', brief: 'The Owls\' 2026 season.', confidence: 'high',
  alternatives: [{ topic: 'Metro Owls coaching', brief: 'Who coaches the Owls.' }], existing_wiki: null,
  next: { create: { topic: 'The 2026 Metro Owls', brief: 'The Owls\' 2026 season.', source: 'vault+web', source_node_ids: ['n1'], paused: true } },
  ...over,
});
const refused = (code: string, message = 'A message for AI callers.'): WikiCreateRefusal => ({ status: 'refused', code, message });

function api(over: Partial<TopicWikiApi> = {}) {
  return {
    status: vi.fn(async () => status()),
    note: vi.fn(async () => ({ id: 'n1', title: 'Why the Owls fired their coach' })),
    check: vi.fn(async (): Promise<TopicProposalCheck> => ({ status: 'ready', model: 'plan-model' })),
    propose: vi.fn(async (): Promise<TopicProposal | WikiCreateRefusal> => proposal()),
    start: vi.fn(async (): Promise<TopicWikiStart> => ({ status: 'queued', created: true })),
    ...over,
  };
}
function show(a: TopicWikiApi, onOpenWiki?: (title: string) => void) {
  return render(<TopicWikiCreate api={a} noteTitle="Why the Owls fired their coach" noteRef="Clips/Why the Owls fired their coach.md"
    onClose={() => {}} {...(onOpenWiki ? { onOpenWiki } : {})} />);
}
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(3000); });
const SUGGEST = 'Suggest a topic (paid)';
const CREATE = 'Create topic wiki (paid)';
async function suggested(a: TopicWikiApi) {
  show(a);
  fireEvent.click(await screen.findByRole('button', { name: SUGGEST }));
  await screen.findByLabelText('Topic');
}

it('checks for free, then offers the one paid suggestion, saying the model and budget', async () => {
  const a = api();
  show(a);
  await screen.findByRole('button', { name: SUGGEST });
  expect(a.note).toHaveBeenCalledWith('Clips/Why the Owls fired their coach.md');
  expect(a.check).toHaveBeenCalledWith('n1');
  expect(a.propose).not.toHaveBeenCalled();
  expect(a.start).not.toHaveBeenCalled();
  const text = document.body.textContent ?? '';
  for (const part of ['This check was free', 'one small paid call (plan-model)', 'creates nothing', '$2.00 left of $3.00'])
    expect(text).toContain(part);
});

it('shows the suggestion to edit: topic, brief, confidence and alternatives, and picking one fills it in', async () => {
  const a = api();
  await suggested(a);
  expect(a.propose).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText('Topic') as HTMLInputElement).value).toBe('The 2026 Metro Owls');
  expect((screen.getByLabelText('Brief') as HTMLTextAreaElement).value).toBe('The Owls\' 2026 season.');
  expect(document.body.textContent).toContain('fairly sure');
  fireEvent.click(screen.getByRole('button', { name: 'Metro Owls coaching' }));
  expect((screen.getByLabelText('Topic') as HTMLInputElement).value).toBe('Metro Owls coaching');
  expect((screen.getByLabelText('Brief') as HTMLTextAreaElement).value).toBe('Who coaches the Owls.');
  expect(a.start).not.toHaveBeenCalled();
});

it('creates with the edited topic and brief, follows the build by its title, and shows the cost', async () => {
  const onOpenWiki = vi.fn();
  const a = api();
  a.status.mockResolvedValueOnce(status()); // budget, at the check
  a.status.mockResolvedValueOnce(status()); // the new wiki's runs before it starts
  a.status.mockResolvedValueOnce(building('Another wiki'));
  a.status.mockResolvedValueOnce(building('Owls 2026'));
  a.status.mockResolvedValue(status({ latest_run: run(1, { cost_usd: 0.5 }) }));
  show(a, onOpenWiki);
  fireEvent.click(await screen.findByRole('button', { name: SUGGEST }));
  fireEvent.change(await screen.findByLabelText('Topic'), { target: { value: '  Owls 2026 ' } });
  fireEvent.change(screen.getByLabelText('Brief'), { target: { value: 'The season, edited.' } });
  fireEvent.click(screen.getByRole('button', { name: CREATE }));
  await screen.findByText(/^Queued\. The build/);
  expect(a.start).toHaveBeenCalledWith({ topic: 'Owls 2026', brief: 'The season, edited.', source: 'vault+web', source_node_ids: ['n1'], paused: true });
  await tick();
  await screen.findByText(/ahead of it finishes/);
  await tick();
  await screen.findByText(/^Building "Owls 2026"/);
  await tick();
  await screen.findByText('The wiki "Owls 2026" was built, for an estimated $0.500. It\'s paused now, so it changes only when you add a note to it '
    + 'or rebuild it on request. Resumed, the nightly sweep also refreshes it, but only while scheduled wiki sweeps are on '
    + '(Curator status shows wiki_reconciliation_mode).');
  expect(a.status.mock.calls.slice(1).every(([title]) => title === 'Owls 2026')).toBe(true);
  expect(a.start).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Open the wiki' }));
  expect(onOpenWiki).toHaveBeenCalledWith('Owls 2026');
});

it('needs a name other than the note\'s title, then builds the create arguments itself', async () => {
  const a = api({ propose: vi.fn(async () => proposal({ topic: 'Why the Owls fired their coach', alternatives: [], next: {} })) });
  await suggested(a);
  const create = screen.getByRole('button', { name: CREATE }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  expect(document.body.textContent).toContain('needs a name other than this note\'s title');
  fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Metro Owls' } });
  fireEvent.change(screen.getByLabelText('Brief'), { target: { value: ' ' } });
  expect(create.disabled).toBe(false);
  fireEvent.click(create);
  await screen.findByText(/^Queued/);
  expect(a.start).toHaveBeenCalledWith({ topic: 'Metro Owls', source: 'vault+web', source_node_ids: ['n1'], paused: true });
});

it('offers adding the note to a matched topic wiki beside creating a new one anyway', async () => {
  const match = { title: 'Metro Owls', kind: 'topic' as const, matched_by: 'model' as const, paused: true, note_is_source: false };
  const a = api({ propose: vi.fn(async () => proposal({ existing_wiki: match,
    next: { ...proposal().next, add_source: { topic: 'Metro Owls', add_source_node_ids: ['n1'] } } })) });
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValueOnce(status({ latest_run: run(7) }));
  a.status.mockResolvedValue(status({ latest_run: run(8, { cost_usd: 0.2 }) }));
  await suggested(a);
  expect(document.body.textContent).toContain('looks like the subject of the topic wiki "Metro Owls" (paused)');
  expect(screen.getByRole('button', { name: 'Create a new wiki anyway (paid)' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add this note to "Metro Owls" (paid)' }));
  await screen.findByText(/^Queued/);
  expect(a.start).toHaveBeenCalledWith({ topic: 'Metro Owls', add_source_node_ids: ['n1'] });
  await tick();
  await screen.findByText('This note was added to "Metro Owls", and the wiki was rebuilt, for an estimated $0.200.');
  expect(a.status).toHaveBeenLastCalledWith('Metro Owls');
});

it('won\'t create a wiki under a matched wiki\'s name, and says when a project wiki matches', async () => {
  await suggested(api({ propose: vi.fn(async () => proposal({ topic: 'Metro Owls', next: {},
    existing_wiki: { title: 'Metro Owls', kind: 'project', matched_by: 'title', paused: false } })) }));
  expect((screen.getByRole('button', { name: CREATE }) as HTMLButtonElement).disabled).toBe(true);
  expect(document.body.textContent).toContain('"Metro Owls" is the same name as the wiki "Metro Owls"');
  expect(document.body.textContent).toContain('project wiki "Metro Owls"');
  expect(screen.queryByRole('button', { name: /Add this note/ })).toBeNull();
});

it.each([
  ['TOO_LITTLE_TEXT', 'has too little text for Curator to suggest a topic'],
  ['NODE_IS_A_WIKI_PAGE', 'is a page of a wiki, not a note to start one from'],
  ['NODE_HAS_A_WIKI', 'is the topic note of a wiki that already exists'],
  ['FORBIDDEN', 'needs the curate:read and curate:trigger scopes'],
])('says the free check\'s %s refusal in plain words, offering no paid step', async (code, words) => {
  const a = api({ check: vi.fn(async () => refused(code)) });
  show(a);
  expect((await screen.findByRole('alert')).textContent).toContain(words);
  expect(document.body.textContent).not.toContain(code);
  expect(screen.queryByRole('button', { name: SUGGEST })).toBeNull();
});

it.each([
  ['DAILY_BUDGET_EXHAUSTED', 'daily budget won\'t allow this call'],
  ['INFERENCE_FAILED', 'couldn\'t suggest a topic this time'],
  ['PROVIDER_SPEND_LIMIT', 'spend limit'],
])('says the suggestion\'s %s refusal in plain words', async (code, words) => {
  const a = api({ propose: vi.fn(async () => refused(code)) });
  show(a);
  fireEvent.click(await screen.findByRole('button', { name: SUGGEST }));
  expect((await screen.findByRole('alert')).textContent).toContain(words);
  expect(document.body.textContent).not.toContain(code);
  expect(a.propose).toHaveBeenCalledTimes(1);
});

it('goes back to the form when the name is taken, and blocks on other refusals', async () => {
  const a = api({ start: vi.fn(async (): Promise<TopicWikiStart> => refused('WIKI_EXISTS')) });
  await suggested(a);
  fireEvent.click(screen.getByRole('button', { name: CREATE }));
  expect((await screen.findByRole('alert')).textContent).toBe('A wiki called "The 2026 Metro Owls" already exists. Choose another name. Nothing was created.');
  expect((screen.getByLabelText('Topic') as HTMLInputElement).disabled).toBe(false);
  a.start.mockResolvedValueOnce(refused('TOO_MANY_SOURCE_NODES'));
  fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Owls' } });
  fireEvent.click(screen.getByRole('button', { name: CREATE }));
  expect((await screen.findByRole('alert')).textContent).toContain('already has the most sources a wiki can take');
  expect(screen.queryByLabelText('Topic')).toBeNull();
  expect(document.body.textContent).not.toMatch(/WIKI_EXISTS|TOO_MANY/);
});

it('says when the first build failed, that the wiki stays paused, and what it spent', async () => {
  const a = api();
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValue(status({ latest_run: run(1, { outcome: 'error', error: 'web research failed', cost_usd: 0.1 }) }));
  await suggested(a);
  fireEvent.click(screen.getByRole('button', { name: CREATE }));
  await screen.findByText(/^Queued/);
  await tick();
  await screen.findByText(/^The first build failed: web research failed\. It spent an estimated \$0\.100 first\. The wiki is registered and paused/);
  // A resume builds it only while scheduled wiki sweeps are on, so the rebuild on request comes first (#544).
  expect(document.body.textContent).toContain('To build it, ask Vault Chat to rebuild it; it stays paused. Resuming it lets the nightly sweep '
    + 'build it only while scheduled wiki sweeps are on (Curator status shows wiki_reconciliation_mode).');
  expect(screen.queryByRole('button', { name: 'Open the wiki' })).toBeNull();
});

it('never repeats a start whose reply was lost, and settles it by reading status', async () => {
  const a = api({ start: vi.fn(async (): Promise<TopicWikiStart> => { throw Error('HTTP 524'); }) });
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValueOnce(status());
  a.status.mockResolvedValue(building('The 2026 Metro Owls'));
  await suggested(a);
  fireEvent.click(screen.getByRole('button', { name: CREATE }));
  await screen.findByText(/Couldn't confirm it started/);
  fireEvent.click(screen.getByRole('button', { name: 'Check status now' }));
  await screen.findByText(/No sign of it yet/);
  fireEvent.click(screen.getByRole('button', { name: 'Check status now' }));
  await screen.findByText(/^Building "The 2026 Metro Owls"/);
  expect(a.start).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: CREATE })).toBeNull();
});

it('says nothing changed when the note was already a source by the time it was added', async () => {
  const a = api({
    propose: vi.fn(async () => proposal({ existing_wiki: { title: 'Metro Owls', kind: 'topic', matched_by: 'model', paused: true, note_is_source: false },
      next: { add_source: { topic: 'Metro Owls', add_source_node_ids: ['n1'] } } })),
    start: vi.fn(async (): Promise<TopicWikiStart> => ({ status: 'answered', created: false, outcome: 'skipped', detail: 'no changes' })),
  });
  await suggested(a);
  fireEvent.click(screen.getByRole('button', { name: 'Add this note to "Metro Owls" (paid)' }));
  await screen.findByText('Nothing changed: this note is already a source of "Metro Owls".');
});

it('says when Engine can\'t find the note, before any Curator call', async () => {
  const a = api({ note: vi.fn(async () => { throw Error('NOT_FOUND'); }) });
  show(a);
  expect((await screen.findByRole('alert')).textContent).toContain('Engine can\'t find this note');
  expect(a.check).not.toHaveBeenCalled();
});

it('compares a new name with the matched wiki\'s loosely, as the Curator does, so no near-duplicate is created', async () => {
  const a = api({ propose: vi.fn(async () => proposal({ topic: 'Metro Owls', alternatives: [], next: {},
    existing_wiki: { title: 'The Metro Owls', kind: 'topic', matched_by: 'title', paused: true, note_is_source: true } })) });
  await suggested(a);
  const create = screen.getByRole('button', { name: CREATE }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  expect(document.body.textContent).toContain('"Metro Owls" is the same name as the wiki "The Metro Owls"');
  for (const near of ['metro owls wiki', 'The Métro-Owls!', ' THE METRO OWLS '])  {
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: near } });
    expect(create.disabled).toBe(true);
  }
  fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Metro Owls coaching' } });
  expect(create.disabled).toBe(false);
  fireEvent.click(create);
  await screen.findByText(/^Queued/);
  expect(a.start).toHaveBeenCalledWith(expect.objectContaining({ topic: 'Metro Owls coaching' }));
});
