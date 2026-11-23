// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CallFn, DossierApi, ProvenanceInputMetadata, WikiRebuildStatus } from '@vault/query-core';
import { VizClientProvider } from '../src/viz-client-context.js';
import { ProvenanceInspector, type ProvenanceInspectorProps } from '../src/ProvenanceInspector.js';
import type { DossierKind } from '../src/use-provenance-inspector.js';
import { DOSSIER_POLL_MS } from '../src/DossierSection.js';
import { defaultCall, env, inputPage } from './helpers/provenance-inspector.js';

// Dossiers in the wiki panel (#554). Fictional people and companies only (repository rule).

afterEach(cleanup);

const statusRow = (label: string) => screen.getByRole('group', { name: `${label} status` });
const findStatusRow = (label: string) => screen.findByRole('group', { name: `${label} status` });
const field = (value: string) => ({ value, type: 'text', source: 'frontmatter' });

type Node = { id: string; title: string; types: string[]; fields: Record<string, unknown>; wikiFor?: string };
const node = (id: string, title: string, over: Partial<Node> = {}): Node => ({ id, title, types: [], fields: {}, ...over });
const asGetNode = (n: Node, nodes: Node[]) => ({
  id: n.id, title: n.title, file_path: `${n.title}.md`, types: n.types, fields: n.fields, body: '', version: 1,
  relationships: {
    outgoing: n.wikiFor ? { wiki_for: [{ target_id: n.wikiFor, target_title: n.wikiFor }] } : {},
    incoming: (() => {
      const pages = nodes.filter(p => p.wikiFor === n.id);
      return pages.length ? { wiki_for: pages.map(p => ({ source_id: p.id, source_title: p.title })) } : {};
    })(),
  },
});

const PAGE = 'Jordan Ellis Dossier';
const page = (status = 'current') => node('page', PAGE, { wikiFor: 'jordan', fields: { wiki_status: field(status) } });
const jordan = (fields: Record<string, unknown> = {}) => node('jordan', 'Jordan Ellis', { types: ['person'], fields });

const input = (over: Partial<ProvenanceInputMetadata> & { id: string; selection: string }): ProvenanceInputMetadata => {
  const base = inputPage();
  if (base.select !== 'output') throw Error('Invalid fixture');
  return { ...base.inputs[0]!, comparison: 'unchanged', ...over };
};
const noteInput = (id: string, title: string, selection: string, comparison: ProvenanceInputMetadata['comparison'] = 'unchanged') =>
  input({ id: `${id}:${selection}`, source_id: id, source: { kind: 'node', namespace: 'fixture', native_id: id }, selection, label: title,
    path: `${title}.md`, comparison, role: 'source_material' });
const memoryInput = (id: number, selection: string) =>
  input({ id: `memory-${id}`, source_id: `memory-${id}`, source: { kind: 'memory', namespace: 'fixture', native_id: String(id) }, selection,
    label: null, path: null, role: 'generated_context' });
/** A dossier build's inputs, as the Curator records them (`src/dossier/evidence.ts`). */
const dossierInputs = (changed = false): ProvenanceInputMetadata[] => [
  noteInput('jordan', 'Jordan Ellis', 'dossier-subject:v1'),
  noteInput('jordan', 'Jordan Ellis', 'dossier-subject-note:v1'),
  noteInput('kickoff', '2026-09-02 Intro call', 'dossier-body:v1', changed ? 'changed' : 'unchanged'),
  noteInput('review', '2026-10-07 Quarterly review', 'dossier-meeting:v1'),
  noteInput('terms', 'Northwind contract terms', 'dossier-note-title:v1'),
  memoryInput(11, 'dossier-memory:v1'),
  memoryInput(12, 'dossier-rule:v1'),
  memoryInput(13, 'dossier-past-memory:v1'),
  input({ id: 'owner', source_id: null, source: null, selection: 'dossier-owner:v1', label: null, path: null, role: 'generated_context',
    comparison: 'comparison_unknown' }),
];
const memory = (id: number, content: string, created_at: string) => ({ id, content, category: 'fact', created_at, valid_at: created_at,
  evidence_kind: 'note', evidence_node_id: 'kickoff' });

/** Engine: these notes by id, the page's one build (when `built`), its inputs, and the memories about Jordan. */
function engine(nodes: Node[], opts: { built?: boolean; inputs?: ProvenanceInputMetadata[]; memories?: ReturnType<typeof memory>[];
  /** How many memories Engine says there are, when more than `memories` (a page past the last one comes back empty). */
  total?: number;
  update?: (args: Record<string, unknown>) => unknown } = {}): CallFn {
  return async (req) => {
    const a = req.arguments;
    if (req.name === 'get-node') {
      const n = nodes.find(x => x.id === a.node_id);
      if (!n) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'none' }, warnings: [] }) }] };
      return env(asGetNode(n, nodes));
    }
    if (req.name === 'list-memories') {
      const all = opts.memories ?? [];
      const offset = Number(a.offset ?? 0), limit = Number(a.limit ?? 50);
      const total = opts.total ?? all.length;
      // Past the listed memories, a page is filled with older ones the build read or that came before it.
      const page = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) =>
        all[offset + i] ?? memory(100_000 + offset + i, 'An older memory.', '2026-01-01T00:00:00Z'));
      return env({ memories: page, total });
    }
    if (req.name === 'update-node') {
      const result = await opts.update?.(a);
      if (result instanceof Error) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code: 'REFUSED', message: result.message }, warnings: [] }) }] };
      if (!a.dry_run) {
        // The write lands on the note, as Engine's would.
        const written = nodes.find(x => x.id === a.node_id)!;
        for (const [key, value] of Object.entries(a.set_fields as Record<string, unknown>)) {
          if (value === null) delete written.fields[key];
          else written.fields[key] = field(String(value));
        }
      }
      return env(a.dry_run ? { dry_run: true, preview: {} } : { node_id: a.node_id });
    }
    if (a.select === 'node' && (!opts.built || a.node_id !== 'page'))
      return env({ select: 'node', outputs: [], current_provenance: 'unknown_legacy', next_cursor: null });
    if (a.select === 'output') {
      const base = inputPage(a.output_revision_id as string, 'page');
      if (base.select !== 'output') throw Error('Invalid fixture');
      return env({ ...base, inputs: opts.inputs ?? dossierInputs() });
    }
    if (a.select === 'refresh_target') {
      // A dossier's build belongs to its person's note, which is no project: Engine says it can't be rebuilt as a wiki page.
      const response = await defaultCall(req);
      const data = JSON.parse((response.content[0] as { text: string }).text).data;
      return env({ ...data, eligible: false, reasons: ['HOME_OWNERSHIP_CHANGED'], project_title: 'Jordan Ellis' });
    }
    return defaultCall(req);
  };
}

const run = (id: number, over: Record<string, unknown> = {}) => ({ id, ts: '2026-11-20T21:12:00Z', outcome: 'written', error: null,
  cost_usd: 0.09, input_tokens: 1, output_tokens: 1, duration_ms: 1, ...over });
const curator = (over: Partial<WikiRebuildStatus> = {}): WikiRebuildStatus => ({
  project: PAGE, kind: null, root_node_id: null, source: null, in_progress: null, paused: false,
  models: { planning: 'Planner', page: 'Writer', home: 'Writer' }, latest_run: run(3) as WikiRebuildStatus['latest_run'],
  last_written: run(3) as WikiRebuildStatus['last_written'], daily_budget: { cap_usd: 2, spent_usd: 0.38, remaining_usd: 1.62 }, ...over,
});
const dossierApi = (status: WikiRebuildStatus = curator()) =>
  ({ status: vi.fn(async () => status), check: vi.fn(), start: vi.fn() }) as unknown as DossierApi & { status: ReturnType<typeof vi.fn> };
const kinds: DossierKind = (types) =>
  types.includes('person') ? { kind: 'person', label: 'Person' } : types.includes('vendor') ? { kind: 'other', label: 'Vendor' } : null;

const TARGET = { nodeId: 'page', title: PAGE, path: `${PAGE}.md` };
function show(call: CallFn, props: Partial<ProvenanceInspectorProps> = {}) {
  return render(
    <VizClientProvider call={call}>
      <ProvenanceInspector
        target={TARGET}
        targetError={null}
        connectionKey={1}
        hasInspectionTool
        onOpenNode={async () => {}}
        onRebuildWiki={vi.fn()}
        onRefreshHome={vi.fn()}
        findWiki={vi.fn(async () => null)}
        dossierKind={kinds}
        {...props}
      />
    </VizClientProvider>,
  );
}
const group = (summary: string) => screen.getByText(summary, { selector: 'summary span' }).closest('details')!;

describe('a dossier page', () => {
  it('names the dossier and its person, shows one status row, and offers its rebuild, not a wiki\'s', async () => {
    const build = vi.fn();
    const opened = vi.fn(async () => {});
    show(engine([page(), jordan()], { built: true, memories: [memory(11, 'Leads partnerships at Northwind.', '2026-09-01T00:00:00Z')] }),
      { dossierApi: dossierApi(), onBuildDossier: build, onOpenNode: opened });
    const row = within(await findStatusRow('This dossier'));
    expect(await row.findByText('Up to date')).toBeTruthy();
    await waitFor(() => expect(row.getByText(/Nothing new has been recorded about Jordan Ellis\.$/)).toBeTruthy());
    expect(screen.getByText('Dossier', { selector: '.vp-kicker' })).toBeTruthy();
    expect(screen.getByText(/^Dossier for/).textContent).toBe('Dossier for Jordan Ellis Person');
    // Not the wiki words a dossier's build used to get: its person's note is no wiki.
    expect(screen.queryByText(/Built by Curator for the/)).toBeNull();
    expect(screen.queryByRole('group', { name: 'Wiki status' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'This page status' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rebuild the whole wiki… (paid)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rebuild this page… (paid)' })).toBeNull();
    fireEvent.click(row.getByRole('button', { name: 'Rebuild this dossier… (paid)' }));
    expect(build).toHaveBeenCalledWith({ nodeId: 'jordan', title: 'Jordan Ellis' });
    const section = within(await screen.findByRole('group', { name: 'Dossier' }));
    expect(section.getByText('Off. It changes only when you rebuild it.')).toBeTruthy();
    expect(section.getByText('est. $0.090')).toBeTruthy();
    expect(section.getByText('$1.62 of $2.00 left')).toBeTruthy();
    fireEvent.click(section.getByRole('button', { name: 'Open Jordan Ellis' }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith('jordan', expect.any(Function)));
    fireEvent.click(screen.getByText(/^Dossier for/).querySelector('button')!);
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(2));
  });

  it('names what the build read: the note itself and notes in full, lists, memories, a rule and past facts', async () => {
    show(engine([page(), jordan()], { built: true }), { dossierApi: dossierApi() });
    await findStatusRow('This dossier');
    const read = within(await waitFor(() => group('Read')));
    expect(read.getByRole('button', { name: 'Jordan Ellis' }).closest('li')!.textContent).toContain('the note itself');
    expect(read.getByRole('button', { name: '2026-09-02 Intro call' }).closest('li')!.textContent).toContain('read in full');
    const listed = within(group('Listed'));
    expect(listed.getByText('2026-10-07 Quarterly review').closest('li')!.textContent).toContain('meeting list');
    expect(listed.getByText('Northwind contract terms').closest('li')!.textContent).toContain('note list');
    expect(within(group('Memories')).getByText('Memory #12').closest('li')!.textContent).toContain('rule on what to say');
    expect(within(group('Past facts')).getByText('Memory #13').closest('li')!.textContent).toContain('past fact');
    expect(within(group('Instructions & format')).getByText('Your name, as the vault’s owner')).toBeTruthy();
  });

  it('is behind on memories recorded since its build and on a changed source, and lists them', async () => {
    show(engine([page('behind'), jordan({ dossier: field('on-change') })], { built: true, inputs: dossierInputs(true), memories: [
      memory(40, 'Asked for the renewal draft by Dec 5.', '2026-11-21T10:00:00Z'),
      memory(11, 'Leads partnerships at Northwind.', '2026-11-21T10:00:00Z'),
      memory(5, 'Met at the trade fair.', '2026-01-01T00:00:00Z'),
    ] }), { dossierApi: dossierApi(), onBuildDossier: vi.fn() });
    const row = within(await findStatusRow('This dossier'));
    expect(await row.findByText('Behind')).toBeTruthy();
    await waitFor(() => expect(row.getByText(/^1 new memory about Jordan Ellis and 1 changed source since its .+ build\. Set to rebuild tonight\.$/)).toBeTruthy());
    expect(row.getByRole('button', { name: 'Rebuild this dossier… (paid)' }).className).toContain('mod-cta');
    const changed = within(await screen.findByRole('group', { name: 'Changed since this build' }));
    // Only the memory recorded after the build that it didn't read is new.
    expect(within(changed.getByRole('list', { name: 'New memories' })).getAllByRole('listitem')).toHaveLength(1);
    expect(changed.getByText('Asked for the renewal draft by Dec 5.')).toBeTruthy();
    expect(changed.getByText('2026-09-02 Intro call')).toBeTruthy();
    expect(changed.getByText(/New memories are ones recorded about Jordan Ellis since this build\./)).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Dossier' })).getByRole('switch', { name: 'Rebuild nightly when behind' })
      .getAttribute('aria-checked')).toBe('true');
  });

  it('shows a build in flight and a failed one from the Curator, keyed by the page title', async () => {
    const api = dossierApi(curator({ in_progress: { since: '2026-11-21T10:00:00Z' }, queue: { running: true, depth: 1, current: PAGE } }));
    show(engine([page(), jordan()], { built: true }), { dossierApi: api, onBuildDossier: vi.fn() });
    expect(await within(await findStatusRow('This dossier')).findByText('Building now')).toBeTruthy();
    expect(api.status).toHaveBeenCalledWith(PAGE);
    expect(screen.queryByRole('button', { name: 'Rebuild this dossier… (paid)' })).toBeNull();
    cleanup();
    show(engine([page(), jordan()], { built: true }), { onBuildDossier: vi.fn(),
      dossierApi: dossierApi(curator({ latest_run: run(4, { outcome: 'error', error: 'The model call failed.' }) as WikiRebuildStatus['latest_run'] })) });
    const failed = within(await findStatusRow('This dossier'));
    expect(await failed.findByText('Last build failed')).toBeTruthy();
    expect(failed.getByRole('alert').textContent).toMatch(/: The model call failed\. The page still shows its .+ build\.$/);
    expect(failed.getByRole('button', { name: 'Retry the dossier build… (paid)' })).toBeTruthy();
  });
});

describe('a person\'s note', () => {
  it('with a dossier: shows its state, opens it, and offers its rebuild', async () => {
    const build = vi.fn();
    const opened = vi.fn(async () => {});
    show(engine([page('behind'), jordan()]), { target: { nodeId: 'jordan', title: 'Jordan Ellis', path: 'Jordan Ellis.md' },
      dossierApi: dossierApi(), onBuildDossier: build, onOpenNode: opened, onCreateTopicWiki: vi.fn(), hasImpactTool: true });
    const row = within(await findStatusRow('Dossier'));
    expect(await row.findByText('Behind')).toBeTruthy();
    expect(row.getByText(/^Memories or notes it read have changed since its .+ build\.$/)).toBeTruthy();
    expect(screen.getByText('Person', { selector: '.vp-kicker' })).toBeTruthy();
    expect(screen.getByText(/^Has a dossier:/).textContent).toBe('Has a dossier: Jordan Ellis Dossier');
    expect(screen.queryByText('Not part of a wiki')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create topic wiki…' })).toBeNull();
    expect((screen.getByRole('group', { name: 'Pages built from this note' }) as HTMLDetailsElement).open).toBe(true);
    fireEvent.click(row.getByRole('button', { name: 'Rebuild the dossier… (paid)' }));
    expect(build).toHaveBeenCalledWith({ nodeId: 'jordan', title: 'Jordan Ellis' });
    fireEvent.click(within(screen.getByRole('group', { name: 'Dossier' })).getByRole('button', { name: 'Open dossier' }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith('page', expect.any(Function)));
  });

  it('without one: offers to build it in place of starting a wiki, under the note\'s own kind', async () => {
    const build = vi.fn();
    show(engine([node('harbor', 'Harbor Print Co.', { types: ['vendor'] })]), { target: { nodeId: 'harbor', title: 'Harbor Print Co.', path: 'x.md' },
      dossierApi: dossierApi(), onBuildDossier: build, onCreateTopicWiki: vi.fn() });
    expect(await screen.findByText('No dossier yet')).toBeTruthy();
    expect(screen.getByText('Vendor', { selector: '.vp-kicker' })).toBeTruthy();
    expect(screen.queryByText('Not part of a wiki')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create topic wiki…' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Status' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Build dossier…' }));
    expect(build).toHaveBeenCalledWith({ nodeId: 'harbor', title: 'Harbor Print Co.' });
  });

  it('without one yet: shows a first build in flight under the page title it will get, then the page it wrote (#715)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const nodes = [jordan()];
      const running = curator({ latest_run: null, last_written: null, in_progress: { since: '2026-11-22T15:30:00Z' },
        queue: { running: true, depth: 1, current: PAGE } });
      const api = dossierApi(running);
      show(engine(nodes), { target: { nodeId: 'jordan', title: 'Jordan Ellis', path: 'Jordan Ellis.md' }, dossierApi: api, onBuildDossier: vi.fn() });
      const row = within(await findStatusRow('Dossier'));
      expect(await row.findByText('Building now')).toBeTruthy();
      expect(api.status).toHaveBeenCalledWith(PAGE);
      expect(screen.getByText('No dossier yet')).toBeTruthy();
      // Not offered again while it runs.
      expect(screen.queryByRole('button', { name: 'Build dossier…' })).toBeNull();
      // The build writes the page and ends: the panel reads the note again and finds it.
      nodes.push(page());
      api.status.mockResolvedValue(curator());
      await act(async () => { await vi.advanceTimersByTimeAsync(DOSSIER_POLL_MS); });
      await waitFor(() => expect(screen.getByText(/^Has a dossier:/).textContent).toBe(`Has a dossier: ${PAGE}`));
      expect(within(statusRow('Dossier')).getByText('Up to date')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('without one yet: names the build a first build waits behind, and a first build that failed', async () => {
    const target = { nodeId: 'jordan', title: 'Jordan Ellis', path: 'Jordan Ellis.md' };
    show(engine([jordan()]), { target, onBuildDossier: vi.fn(), dossierApi: dossierApi(curator({ latest_run: null, last_written: null,
      in_progress: { since: '2026-11-22T15:31:00Z' }, queue: { running: true, depth: 2, current: 'Avery Stone Dossier' } })) });
    const queued = within(await findStatusRow('Dossier'));
    expect(await queued.findByText('Queued')).toBeTruthy();
    expect(queued.getByText('Curator is finishing “Avery Stone Dossier” first. This build starts after it.')).toBeTruthy();
    cleanup();
    const build = vi.fn();
    show(engine([jordan()]), { target, onBuildDossier: build, dossierApi: dossierApi(curator({ last_written: null,
      latest_run: run(4, { outcome: 'error', error: 'The model call failed.' }) as WikiRebuildStatus['latest_run'] })) });
    const failed = within(await findStatusRow('Dossier'));
    expect(await failed.findByText('Last build failed')).toBeTruthy();
    expect(failed.getByRole('alert').textContent).toMatch(/: The model call failed\.$/);
    expect(screen.queryByRole('button', { name: 'Build dossier…' })).toBeNull();
    fireEvent.click(failed.getByRole('button', { name: 'Retry the dossier build… (paid)' }));
    expect(build).toHaveBeenCalledWith({ nodeId: 'jordan', title: 'Jordan Ellis' });
  });

  it('keeps a registered wiki on a person\'s note a wiki', async () => {
    show(engine([node('home', 'Jordan Ellis Wiki', { wikiFor: 'jordan', fields: { wiki_status: field('current') } }), jordan()]), {
      target: { nodeId: 'jordan', title: 'Jordan Ellis', path: 'x.md' }, dossierApi: dossierApi(),
      findWiki: vi.fn(async () => ({ name: 'Jordan Ellis', kind: 'topic' as const })), onBuildDossier: vi.fn() });
    expect(await screen.findByText(/^Has a wiki/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Dossier status' })).toBeNull();
  });

  it('says what to set up when no Curator is configured', async () => {
    show(engine([page(), jordan()]), { target: { nodeId: 'jordan', title: 'Jordan Ellis', path: 'x.md' } });
    const row = within(await findStatusRow('Dossier'));
    expect(row.getByText('Status unavailable')).toBeTruthy();
    expect(row.getByText(/^Connect Curator in the plugin settings/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Dossier' })).toBeNull();
  });
});

describe('nightly rebuilds', () => {
  it('turns them on with the note\'s field through update-node, its dry run first', async () => {
    const update = vi.fn(() => null);
    show(engine([page(), jordan()], { built: true, update }), { dossierApi: dossierApi() });
    const section = within(await screen.findByRole('group', { name: 'Dossier' }));
    const toggle = section.getByRole('switch', { name: 'Rebuild nightly when behind' });
    expect(section.getByText(/^Saved on Jordan Ellis as/).textContent).toContain('dossier: on-change');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(update.mock.calls.map(([args]) => args)).toEqual([
      { node_id: 'jordan', set_fields: { dossier: 'on-change' }, dry_run: true },
      { node_id: 'jordan', set_fields: { dossier: 'on-change' }, dry_run: false },
    ]);
    expect(section.getByText(/^On\. Curator rebuilds it in the nightly sweep/)).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(update).toHaveBeenLastCalledWith({ node_id: 'jordan', set_fields: { dossier: null }, dry_run: false });
  });

  it('says so when Engine refuses, and leaves the switch as it was', async () => {
    const update = vi.fn(() => new Error('The note is read-only.'));
    show(engine([page(), jordan()], { built: true, update }), { dossierApi: dossierApi() });
    const section = within(await screen.findByRole('group', { name: 'Dossier' }));
    fireEvent.click(section.getByRole('switch', { name: 'Rebuild nightly when behind' }));
    expect(await section.findByText('Couldn’t change it: The note is read-only.')).toBeTruthy();
    expect(update).toHaveBeenCalledTimes(1);
    expect(section.getByRole('switch', { name: 'Rebuild nightly when behind' }).getAttribute('aria-checked')).toBe('false');
  });
});

it('reads the dossier again when the host says a build dialog closed', async () => {
  const call = vi.fn(engine([page(), jordan()], { built: true }));
  const api = dossierApi();
  const props = { dossierApi: api };
  const view = show(call, props);
  await within(await findStatusRow('This dossier')).findByText('Up to date');
  const histories = () => call.mock.calls.filter(([req]) => req.arguments.select === 'node').length;
  const before = histories();
  view.rerender(
    <VizClientProvider call={call}>
      <ProvenanceInspector target={TARGET} targetError={null} connectionKey={1} hasInspectionTool
        onOpenNode={async () => {}} onRebuildWiki={vi.fn()} findWiki={vi.fn(async () => null)} dossierKind={kinds} statusKey={1} {...props} />
    </VizClientProvider>,
  );
  await act(async () => {});
  await waitFor(() => expect(histories()).toBeGreaterThan(before));
});

describe('what is new since the build', () => {
  const old = (id: number) => memory(id, 'An older memory.', '2026-01-01T00:00:00Z');
  it('reads every page of the memories about the subject, since they come by the day each became true', async () => {
    // The one memory recorded since the build is from an older note, so it sorts onto the second page.
    const memories = [...Array.from({ length: 200 }, (_, i) => old(1000 + i)), memory(40, 'Moved to the Lisbon office.', '2026-11-21T10:00:00Z')];
    const call = vi.fn(engine([page(), jordan()], { built: true, memories, total: 250 }));
    show(call, { dossierApi: dossierApi() });
    const row = within(await findStatusRow('This dossier'));
    await waitFor(() => expect(row.getByText(/^1 new memory about Jordan Ellis since its .+ build\.$/)).toBeTruthy());
    expect(call.mock.calls.filter(([req]) => req.name === 'list-memories').map(([req]) => req.arguments.offset)).toEqual([0, 200]);
  });

  it('claims nothing new only when it has read them all', async () => {
    const call = vi.fn(engine([page(), jordan()], { built: true, total: 5000 }));
    show(call, { dossierApi: dossierApi() });
    const row = within(await findStatusRow('This dossier'));
    await waitFor(() => expect(call.mock.calls.filter(([req]) => req.name === 'list-memories')).toHaveLength(5));
    expect(await row.findByText('Up to date')).toBeTruthy();
    await act(async () => {});
    expect(row.queryByText(/Nothing new has been recorded/)).toBeNull();
    cleanup();
    show(engine([page(), jordan()], { built: true, total: 5000,
      memories: [memory(40, 'Moved to the Lisbon office.', '2026-11-21T10:00:00Z')] }), { dossierApi: dossierApi() });
    await waitFor(() => expect(within(statusRow('This dossier')).getByText(/^At least 1 new memory about Jordan Ellis since/)).toBeTruthy());
  });
});

describe('the nightly switch and the inspection', () => {
  it('reads the build\'s comparisons again after a write, since the note is one of its sources', async () => {
    const call = vi.fn(engine([page(), jordan()], { built: true, update: () => null }));
    show(call, { dossierApi: dossierApi() });
    const section = within(await screen.findByRole('group', { name: 'Dossier' }));
    await within(statusRow('This dossier')).findByText('Up to date');
    const outputs = () => call.mock.calls.filter(([req]) => req.arguments.select === 'output').length;
    const before = outputs();
    fireEvent.click(section.getByRole('switch', { name: 'Rebuild nightly when behind' }));
    await waitFor(() => expect(outputs()).toBeGreaterThan(before));
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Dossier' })).getByRole('switch', { name: 'Rebuild nightly when behind' })
      .hasAttribute('disabled')).toBe(false));
  });

  it('keeps the switch usable when Check again replaces a write still in flight', async () => {
    let finish!: () => void;
    const pending = new Promise<null>((resolve) => { finish = () => resolve(null); });
    show(engine([page(), jordan()], { built: true, update: () => pending }), { dossierApi: dossierApi() });
    const toggle = () => within(screen.getByRole('group', { name: 'Dossier' })).getByRole('switch', { name: 'Rebuild nightly when behind' });
    await screen.findByRole('group', { name: 'Dossier' });
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().hasAttribute('disabled')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByRole('group', { name: 'Dossier' });
    await waitFor(() => expect(toggle().hasAttribute('disabled')).toBe(false));
    // The old answer, arriving late, changes nothing.
    await act(async () => finish());
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(toggle().hasAttribute('disabled')).toBe(false);
  });
});
