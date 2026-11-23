import { expect, it, vi } from 'vitest';
import { EngineTransportError, type EngineConnection } from '../../src/engine/transport.js';
import { makeWikiRebuildClient } from '../../src/provenance/wiki-rebuild-client.js';

const reply = (body: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(body) }], ...(isError ? { isError: true } : {}) });
const validStatus = { project: 'Project', in_progress: null, paused: true, queue: { running: false, depth: 0 },
  models: { planning: 'p', page: 'g', home: 'h' }, latest_run: null, last_written: null,
  daily_budget: { cap_usd: 3, spent_usd: 1, remaining_usd: 2 } };

function client(call: (req: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>, token = 'token') {
  const conn = { call: vi.fn(call), close: vi.fn(async () => {}), listTools: vi.fn(async () => []) };
  const connect = vi.fn(async () => conn as unknown as EngineConnection);
  return { conn, connect, ...makeWikiRebuildClient({ endpoint: 'https://curator', token, connect: connect as never }) };
}

it('uses only the tools an AI caller has, with the arguments it would pass', async () => {
  const { conn, api } = client(async req => {
    if (req.name === 'curator-status') return reply(validStatus);
    return reply(req.arguments.dry_run ? { results: [{ outcome: 'would_curate', detail: null, evidence_unchanged: true }] } : { status: 'queued' });
  });
  expect(await api.status('Project')).toMatchObject({ project: 'Project', paused: true });
  expect(await api.check('Project')).toEqual({ in_progress: false, outcome: 'would_curate', detail: null, evidence_unchanged: true });
  expect(await api.start('Project')).toEqual({ status: 'queued' });
  expect(conn.call.mock.calls.map(([req]) => req)).toEqual([
    { name: 'curator-status', arguments: { project: 'Project' } },
    { name: 'curate-project-wiki', arguments: { project: 'Project', dry_run: true, force: true } },
    { name: 'curate-project-wiki', arguments: { project: 'Project', force: true } },
  ]);
});

it('reports an older Curator that ignores the project filter', async () => {
  const { api } = client(async () => reply({ recent_runs: [], projects: [] }));
  await expect(api.status('Project')).rejects.toThrow(/Update Curator/);
});

it('reads a build already running, and a refusal, from either call', async () => {
  const { api } = client(async req => reply(req.arguments.dry_run ? { status: 'in_progress' } : { results: [{ outcome: 'error', detail: 'no wiki' }] }));
  expect(await api.check('Project')).toEqual({ in_progress: true });
  expect(await api.start('Project')).toEqual({ status: 'refused', detail: 'no wiki' });
});

it('counts a repeat start while one runs as started, so it never reads as a failure', async () => {
  const { api } = client(async () => reply({ status: 'in_progress' }));
  expect(await api.start('Project')).toEqual({ status: 'in_progress' });
});

it('fails on an error result or an unreadable reply', async () => {
  const refused = client(async () => reply({ ok: false, error: { code: 'FORBIDDEN' } }, true));
  await expect(refused.api.start('Project')).rejects.toThrow(/refused/);
  const garbled = client(async () => ({ content: [{ type: 'text', text: 'not json' }] }));
  await expect(garbled.api.start('Project')).rejects.toThrow(/Invalid/);
});

it('needs a token, and reconnects after a transport failure', async () => {
  const none = client(async () => reply(validStatus), ' ');
  await expect(none.api.status('Project')).rejects.toThrow(/Curator token/);
  expect(none.connect).not.toHaveBeenCalled();

  let failed = false;
  const flaky = client(async () => {
    if (!failed) { failed = true; throw new EngineTransportError('gone'); }
    return reply(validStatus);
  });
  await expect(flaky.api.status('Project')).rejects.toThrow('gone');
  await expect(flaky.api.status('Project')).resolves.toMatchObject({ project: 'Project' });
  expect(flaky.connect).toHaveBeenCalledTimes(2);
  expect(flaky.conn.close).toHaveBeenCalled();
});

it('closes its connection and refuses further calls', async () => {
  const { api, close, conn } = client(async () => reply(validStatus));
  await api.status('Project');
  await close();
  expect(conn.close).toHaveBeenCalled();
  await expect(api.status('Project')).rejects.toThrow(/closed/);
});

const created = (over: Record<string, unknown> = {}) => ({ ok: true, project: 'Project', project_id: 'n1', dry_run: false, created: true,
  home_created: true, first_build: 'queued', detail: 'wiki registered', ...over });

it('creates on the tool an AI caller has, checking with a dry run first', async () => {
  const { conn, create } = client(async req => reply(req.arguments.dry_run ? created({ dry_run: true, first_build: null }) : created()));
  expect(await create.check('Project')).toEqual({ status: 'ready', home_missing: true });
  expect(await create.start('Project')).toEqual({ status: 'queued' });
  expect(conn.call.mock.calls.map(([req]) => req)).toEqual([
    { name: 'create-project-wiki', arguments: { project: 'Project', dry_run: true } },
    { name: 'create-project-wiki', arguments: { project: 'Project' } },
  ]);
});

it('reads an existing wiki, a build in flight, and a build the Curator answered at once', async () => {
  const replies: unknown[] = [
    created({ dry_run: true, created: false, home_created: false, first_build: null }),
    created({ dry_run: true, created: false, first_build: 'in_progress' }),
    created({ created: false, home_created: false, first_build: null }),
    created({ created: true, home_created: false, first_build: null }),
    created({ first_build: 'in_progress' }),
    created({ first_build: { project: 'Project', outcome: 'skipped', detail: 'paused', dryRun: false } }),
  ];
  const { create } = client(async req => reply(req.name === 'curator-status'
    ? { project_wikis: [{ project: 'Project', root_node_id: 'n1' }] } : replies.shift()));
  expect(await create.check('Project')).toEqual({ status: 'exists' });
  expect(await create.check('Project')).toEqual({ status: 'in_progress' });
  expect(await create.start('Project')).toEqual({ status: 'exists' });
  expect(await create.start('Project')).toEqual({ status: 'registered' });
  expect(await create.start('Project')).toEqual({ status: 'in_progress' });
  expect(await create.start('Project')).toEqual({ status: 'not_started', outcome: 'skipped', detail: 'paused' });
});

it('passes the note\'s path, so a namesake in another folder is never taken for it', async () => {
  const { conn, create } = client(async () => reply(created({ dry_run: true, first_build: null })));
  await create.check('Clients/Project.md');
  expect(conn.call).toHaveBeenCalledWith({ name: 'create-project-wiki', arguments: { project: 'Clients/Project.md', dry_run: true } });
});

it('tells a renamed project\'s wiki, still under its old title, from one already current', async () => {
  let wikis: unknown[] = [{ project: 'Old Name', root_node_id: 'n1' }, { project: 'Other', root_node_id: 'n2' }];
  const { create } = client(async req => reply(req.name === 'curator-status' ? { project_wikis: wikis }
    : created({ dry_run: true, created: false, home_created: false, first_build: null })));
  expect(await create.check('Project.md')).toEqual({ status: 'renamed', from: 'Old Name' });
  wikis = [{ project: 'Project', root_node_id: 'n1' }];
  expect(await create.check('Project.md')).toEqual({ status: 'exists' });
  wikis = [{ project: 'Project', root_node_id: null }];
  expect(await create.check('Project.md')).toEqual({ status: 'exists' });
});

it('returns the Curator\'s refusals with their codes, from the check and the start', async () => {
  const { create } = client(async req => reply({ ok: false, error: req.arguments.dry_run
    ? { code: 'TITLE_IN_USE', message: '"Project" is already a topic wiki' }
    : { code: 'FORBIDDEN', message: 'missing required scope: curate:trigger' } }, true));
  expect(await create.check('Project')).toEqual({ status: 'refused', code: 'TITLE_IN_USE', message: '"Project" is already a topic wiki' });
  expect(await create.start('Project')).toEqual({ status: 'refused', code: 'FORBIDDEN', message: 'missing required scope: curate:trigger' });
});

it('fails on a create reply it cannot read', async () => {
  const garbled = client(async () => reply({ ok: true, created: 'yes' }));
  await expect(garbled.create.start('Project')).rejects.toThrow(/Invalid create response/);
  const bare = client(async () => reply({ nope: true }, true));
  await expect(bare.create.start('Project')).rejects.toThrow(/refused/);
});

it('lists the project wikis from the full status, and needs a Curator that reports them', async () => {
  const { conn, projectWikis } = client(async () => reply({ project_wikis: [{ project: 'Alpha', root_node_id: 'a' }, { project: 'Beta', root_node_id: null }] }));
  expect(await projectWikis()).toEqual(['Alpha', 'Beta']);
  expect(conn.call).toHaveBeenCalledWith({ name: 'curator-status', arguments: { limit: 1, window_hours: 1 } });
  const old = client(async () => reply({ recent_runs: [] }));
  await expect(old.projectWikis()).rejects.toThrow(/Update Curator/);
});

it('reads the curation lane from status when present, and rejects a malformed one', async () => {
  const lane = client(async () => reply({ ...validStatus, queue: { running: true, depth: 2, current: 'Project' } }));
  expect((await lane.api.status('Project')).queue).toEqual({ running: true, depth: 2, current: 'Project' });
  const bad = client(async () => reply({ ...validStatus, queue: { running: 'yes' } }));
  await expect(bad.create.status('Project')).rejects.toThrow(/Update Curator/);
});

// Topic wikis from a note (#387): propose-topic-wiki, create-or-update-wiki and curator-status.
const proposed = (over: Record<string, unknown> = {}) => ({ ok: true, dry_run: false, node: { id: 'n1', title: 'Note' },
  topic: 'The 2026 Metro Owls', brief: 'The season.', confidence: 'medium',
  alternatives: [{ topic: 'Metro Owls', brief: 'The club.' }, { topic: '' }, 'junk'],
  existing_wiki: { title: 'Metro Owls', kind: 'topic', matched_by: 'model', paused: true, source: 'vault+web', source_node_ids: ['x'], note_is_source: false },
  next: { create: { topic: 'The 2026 Metro Owls', brief: 'The season.', source: 'vault+web', source_node_ids: ['n1'], paused: true },
    add_source: { topic: 'Metro Owls', add_source_node_ids: ['n1'] } },
  model: 'plan-model', detail: 'Show the topic and brief…', ...over });

it('proposes and creates a topic wiki on the tools an AI caller has, with the arguments it would pass', async () => {
  const { conn, topic } = client(async req => reply(req.name === 'create-or-update-wiki'
    ? { ok: true, topic: 'The 2026 Metro Owls', root_node_id: 't1', outcome: 'queued', created: true, paused: true, detail: 'queued' }
    : req.arguments.dry_run ? { ok: true, dry_run: true, node: { id: 'n1', title: 'Note' }, model: 'plan-model', detail: 'Would make one call' }
      : proposed()));
  expect(await topic.check('n1')).toEqual({ status: 'ready', model: 'plan-model' });
  expect(await topic.propose('n1')).toEqual({ status: 'proposed', topic: 'The 2026 Metro Owls', brief: 'The season.', confidence: 'medium',
    alternatives: [{ topic: 'Metro Owls', brief: 'The club.' }],
    existing_wiki: { title: 'Metro Owls', kind: 'topic', matched_by: 'model', paused: true, note_is_source: false },
    next: proposed().next });
  const args = { topic: 'Owls', source: 'vault+web' as const, source_node_ids: ['n1'], paused: true as const };
  expect(await topic.start(args)).toEqual({ status: 'queued', created: true });
  expect(conn.call.mock.calls.map(([req]) => req)).toEqual([
    { name: 'propose-topic-wiki', arguments: { node_id: 'n1', dry_run: true } },
    { name: 'propose-topic-wiki', arguments: { node_id: 'n1' } },
    { name: 'create-or-update-wiki', arguments: args },
  ]);
});

it('reads a proposal with no match and no ready arguments, a build already queued, and a reply answered at once', async () => {
  const replies: unknown[] = [
    proposed({ existing_wiki: null, next: {}, alternatives: [] }),
    { ok: true, topic: 'T', root_node_id: 't1', outcome: 'in_progress', created: false, paused: true, detail: 'already queued' },
    { ok: true, topic: 'T', root_node_id: 't1', outcome: 'skipped', created: false, paused: true, detail: 'no changes' },
    { ok: true, topic: 'T', root_node_id: 't1', outcome: 'written', created: true },
  ];
  const { topic } = client(async () => reply(replies.shift()));
  expect(await topic.propose('n1')).toMatchObject({ existing_wiki: null, next: {}, alternatives: [] });
  expect(await topic.start({ topic: 'T', add_source_node_ids: ['n1'] })).toEqual({ status: 'in_progress', created: false });
  expect(await topic.start({ topic: 'T', add_source_node_ids: ['n1'] })).toEqual({ status: 'answered', created: false, outcome: 'skipped', detail: 'no changes' });
  expect(await topic.start({ topic: 'T' })).toEqual({ status: 'answered', created: true, outcome: 'written', detail: null });
});

it('returns the Curator\'s refusals from the check, the proposal and the create', async () => {
  const { topic } = client(async req => reply({ ok: false, error: req.name === 'create-or-update-wiki'
    ? { code: 'WIKI_EXISTS', message: 'already has a wiki' }
    : req.arguments.dry_run ? { code: 'TOO_LITTLE_TEXT', message: 'too little' } : { code: 'DAILY_BUDGET_EXHAUSTED', message: 'spent' } }, true));
  expect(await topic.check('n1')).toEqual({ status: 'refused', code: 'TOO_LITTLE_TEXT', message: 'too little' });
  expect(await topic.propose('n1')).toEqual({ status: 'refused', code: 'DAILY_BUDGET_EXHAUSTED', message: 'spent' });
  expect(await topic.start({ topic: 'T', paused: true })).toEqual({ status: 'refused', code: 'WIKI_EXISTS', message: 'already has a wiki' });
});

it('fails on a proposal or create reply it cannot read, as from a Curator without the tools', async () => {
  for (const bad of [proposed({ topic: '' }), proposed({ confidence: 'sure' }), proposed({ existing_wiki: { title: 'X' } }),
    proposed({ next: { create: { brief: 'no topic' } } }), { ok: true, dry_run: true }])
    await expect(client(async () => reply(bad)).topic.propose('n1')).rejects.toThrow(/Update Curator/);
  await expect(client(async () => reply({ ok: true, dry_run: true, model: '' })).topic.check('n1')).rejects.toThrow(/Update Curator/);
  await expect(client(async () => reply({ ok: true, created: true })).topic.start({ topic: 'T' })).rejects.toThrow(/Invalid create response/);
  await expect(client(async () => ({ content: [{ type: 'text', text: 'Tool propose-topic-wiki not found' }], isError: true })).topic.check('n1'))
    .rejects.toThrow();
});

it('pauses and resumes a wiki with set-wiki-paused, the tool an AI caller has (#545)', async () => {
  const { conn, control } = client(async req => req.name === 'curator-status'
    ? reply(validStatus)
    : reply({ ok: true, project: 'Project', paused: req.arguments.paused, corrections: [], wiki_status: null }));
  expect(await control.status('Project')).toMatchObject({ project: 'Project', paused: true });
  expect(await control.setPaused('Project', false)).toEqual({ paused: false });
  expect(await control.setPaused('Project', true)).toEqual({ paused: true });
  expect(conn.call.mock.calls.map(([req]) => req)).toEqual([
    { name: 'curator-status', arguments: { project: 'Project' } },
    { name: 'set-wiki-paused', arguments: { project: 'Project', paused: false } },
    { name: 'set-wiki-paused', arguments: { project: 'Project', paused: true } },
  ]);
});

it('fails a pause the Curator refuses or answers in an unknown shape', async () => {
  const refused = client(async () => reply({ ok: false, error: { code: 'FORBIDDEN', message: 'needs curate:trigger' } }, true));
  await expect(refused.control.setPaused('Project', true)).rejects.toThrow(/refused/);
  const older = client(async () => reply({ ok: true }));
  await expect(older.control.setPaused('Project', true)).rejects.toThrow(/Update Curator/);
});

// Fictional people only (repository rule).
const dossierPreview = {
  ok: true, dry_run: true, subject: { node_id: 'dana', title: 'Dana Whitfield', kind: 'person' },
  page: { title: 'Dana Whitfield Dossier', path: 'Wikis/Dana Whitfield Dossier.md', node_id: null, action: 'create' },
  reads: { memories: { about: 74, shown: 60, past: 2, left_out: 14, rules: 1, preferences: 2, owner: 3 }, notes: 4, meetings: 3, read_in_full: 5,
    tasks: 0, people: 2, companies: 1, last_contact: null },
  sections: { list: 'person', from: 'built-in', names: ['Who', 'Relationships', 'History'], note: 'The built-in "person" list.' },
  rebuild: { current: 'on-change', note: 'The nightly sweep rebuilds this dossier when it is behind.' },
  model: { ref: 'Home Model', provider: 'openrouter', max_output_tokens: 32000 },
  request_bytes: 1000, capture: {},
  cost: { priced: true, estimated_usd: 0.006, worst_case_usd: 0.05, calls: 2, note: 'From recent builds.' },
  daily_budget: { cap_usd: 3, remaining_usd: 2, fits: true, refusal: null },
  next: { tool: 'build-dossier', arguments: { node_id: 'dana', dry_run: false } },
};

it('previews and builds a dossier with build-dossier, the tool an AI caller has, and follows it by its page (#715)', async () => {
  const { conn, dossier } = client(async req => {
    if (req.name === 'curator-status') return reply({ ...validStatus, project: 'Dana Whitfield Dossier' });
    return reply(req.arguments.dry_run ? dossierPreview
      : { ok: true, dry_run: false, status: 'queued', subject: dossierPreview.subject, page: { title: 'Dana Whitfield Dossier' },
        queued_at: 'now', detail: 'Queued.', follow: { tool: 'curator-status', arguments: { project: 'Dana Whitfield Dossier' } } });
  });
  expect(await dossier.check('dana')).toEqual({ status: 'ready', page_title: 'Dana Whitfield Dossier', action: 'create', subject_kind: 'person',
    reads: { memories: 74, memories_shown: 60, past: 2, rules: 1, notes: 4, meetings: 3, read_in_full: 5 },
    sections: ['Who', 'Relationships', 'History'], model: 'Home Model', calls: 2,
    estimated_usd: 0.006, worst_case_usd: 0.05, fits: true, refusal: null, remaining_usd: 2, cap_usd: 3, rebuild: 'on-change' });
  expect(await dossier.start('dana')).toEqual({ status: 'queued', page_title: 'Dana Whitfield Dossier' });
  // Nightly rebuilds set with the build, which writes the note's field before it reads the note (#714).
  expect(await dossier.start('dana', 'manual')).toEqual({ status: 'queued', page_title: 'Dana Whitfield Dossier' });
  expect(await dossier.status('Dana Whitfield Dossier')).toMatchObject({ project: 'Dana Whitfield Dossier' });
  expect(conn.call.mock.calls.map(([req]) => req)).toEqual([
    { name: 'build-dossier', arguments: { node_id: 'dana', dry_run: true } },
    { name: 'build-dossier', arguments: { node_id: 'dana', dry_run: false } },
    { name: 'build-dossier', arguments: { node_id: 'dana', dry_run: false, rebuild: 'manual' } },
    { name: 'curator-status', arguments: { project: 'Dana Whitfield Dossier' } },
  ]);
});

it('reads a dossier rebuild that does not fit the cap, an answer given at once, and a refusal (#715)', async () => {
  const { dossier } = client(async req => reply(req.arguments.dry_run
    ? { ...dossierPreview, page: { ...dossierPreview.page, action: 'rebuild' }, rebuild: { current: 'manual', note: '' },
      daily_budget: { cap_usd: 3, remaining_usd: 0, fits: false, refusal: 'daily budget: spent' } }
    : { ok: true, dry_run: false, status: 'skipped_budget', subject: dossierPreview.subject, page_title: 'Dana Whitfield Dossier',
      detail: 'Today\'s budget is spent.' }));
  expect(await dossier.check('dana')).toMatchObject({ action: 'rebuild', rebuild: 'manual', fits: false, refusal: 'daily budget: spent' });
  // A Curator from before #716 names no sections, and one from before #717 counts no past facts.
  const before = client(async () => reply({ ...dossierPreview, sections: undefined, reads: { ...dossierPreview.reads,
    memories: { about: 74, shown: 60, left_out: 14 } } }));
  expect(await before.dossier.check('dana')).toMatchObject({ sections: [], reads: { past: 0, rules: 0 } });
  expect(await dossier.start('dana')).toEqual({ status: 'answered', page_title: 'Dana Whitfield Dossier', outcome: 'skipped_budget',
    detail: 'Today\'s budget is spent.' });
  const refusing = client(async () => reply({ ok: false, error: { code: 'PROJECT_NOTE', message: '"Pilot" is a project.' } }, true));
  expect(await refusing.dossier.check('pilot')).toEqual({ status: 'refused', code: 'PROJECT_NOTE', message: '"Pilot" is a project.' });
  const old = client(async () => reply({ ok: true, results: [] }));
  await expect(old.dossier.check('dana')).rejects.toThrow(/Update Curator/);
});
