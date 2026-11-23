// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type {
  CallFn,
  ProvenanceInputMetadata,
  ProvenanceInspectData,
  WikiControlApi,
  WikiRebuildStatus,
} from '@vault/query-core';
import { VizClientProvider } from '../src/viz-client-context.js';
import {
  ProvenanceInspector,
  type ProvenanceInspectorProps,
} from '../src/ProvenanceInspector.js';
import {
  defaultCall,
  deferred,
  env,
  inputPage,
  output,
  status,
} from './helpers/provenance-inspector.js';
afterEach(cleanup);

/** A row of the status board: "This page", "This note" or "Wiki". */
const statusRow = (label: string) => screen.getByRole('group', { name: `${label} status` });
const findStatusRow = (label: string) => screen.findByRole('group', { name: `${label} status` });

/** Runs an action and lets every read it starts finish and render: act drains React's
 *  queued work until a macrotask passes with nothing left, with no timeout to outrun. */
async function settle(action: () => void = () => {}): Promise<void> {
  await act(async () => { action(); });
}

function renderInspector(
  call: CallFn,
  props: Partial<ProvenanceInspectorProps> = {},
) {
  return render(
    <VizClientProvider call={call}>
      <ProvenanceInspector
        target={{ nodeId: 'home', title: 'Home', path: 'Home.md' }}
        targetError={null}
        connectionKey={1}
        hasInspectionTool
        onOpenNode={async () => {}}
        {...props}
      />
    </VizClientProvider>,
  );
}

const baseInput = (): ProvenanceInputMetadata => {
  const page = inputPage();
  if (page.select !== 'output') throw Error('Invalid fixture');
  return page.inputs[0]!;
};
const note = (
  id: string,
  title: string,
  selection: string,
  comparison: ProvenanceInputMetadata['comparison'] = 'unchanged',
): ProvenanceInputMetadata => ({
  ...baseInput(),
  id: `${id}:${selection}`,
  source_id: id,
  source: { kind: 'node', namespace: 'fixture', native_id: id },
  role: selection.startsWith('formatted') ? 'source_material' : 'engine_projection',
  selection,
  label: title,
  path: `${title}.md`,
  comparison,
});
const memory = (
  id: string,
  comparison: ProvenanceInputMetadata['comparison'] = 'unchanged',
): ProvenanceInputMetadata => ({
  ...baseInput(),
  id: `memory-${id}`,
  source_id: `memory-${id}`,
  source: { kind: 'memory', namespace: 'fixture', native_id: id },
  role: 'generated_context',
  selection: 'memory:v1',
  label: null,
  path: null,
  comparison,
});
const opaque = (selection: string): ProvenanceInputMetadata => ({
  ...baseInput(),
  id: `opaque-${selection}`,
  source_id: null,
  source: null,
  role: 'generated_context',
  selection,
  origin: 'opaque',
  label: null,
  path: null,
  comparison: 'comparison_unknown',
});
const withInputs = (
  inputs: ProvenanceInputMetadata[],
  extra: { id?: string; replaces?: string; currentness?: 'matches' | 'changed'; next_cursor?: string | null } = {},
): ProvenanceInspectData => {
  const page = inputPage(extra.id ?? 'out');
  if (page.select !== 'output') throw Error('Invalid fixture');
  return {
    ...page,
    output: {
      ...page.output,
      currentness: extra.currentness ?? 'matches',
      receipt: {
        ...page.output.receipt,
        replaces_output_revision_id: extra.replaces ?? null,
      },
    },
    inputs,
    next_cursor: extra.next_cursor ?? null,
  };
};
const memoryText = (id: string) =>
  env({
    select: 'input_text',
    output_revision_id: 'out',
    input_id: `memory-${id}`,
    availability: 'retained',
    input_digest: 'digest',
    segments: [
      {
        span_index: 0,
        field: 'evidence',
        span_start: 0,
        span_end: 10,
        start: 0,
        end: 10,
        text: `- [fact] Memory number ${id} is true. (id: ${id})`,
      },
    ],
    next_cursor: null,
  });

it('groups sources by how they were used and keeps exact metadata in technical details', async () => {
  renderInspector((req) => {
    if (req.arguments.select !== 'output') return defaultCall(req);
    return Promise.resolve(
      env(
        withInputs([
          note('a', 'Meeting A', 'formatted-node-body-prefix:v1'),
          note('a', 'Meeting A', 'timeline-projection:v1'),
          note('b', 'Task B', 'task-fields:v1'),
          note('b', 'Task B', 'salience-projection:v1'),
          memory('7'),
          opaque('system:v1'),
        ]),
      ),
    );
  });
  const read = (await screen.findByText('Read')).closest('details')!;
  expect(within(read).getByRole('button', { name: 'Meeting A' })).toBeTruthy();
  expect(within(read).getByText(/read · timeline/)).toBeTruthy();
  const listed = screen.getByText('Listed').closest('details')!;
  expect(within(listed).getByRole('button', { name: 'Task B' })).toBeTruthy();
  expect(within(listed).getByText(/task list · most active/)).toBeTruthy();
  expect(screen.getByText('Memories').closest('details')).toBeTruthy();
  const internal = screen.getByText('Instructions & format').closest('details')!;
  expect(within(internal).getByText('Curator instructions')).toBeTruthy();
  // One note read, one listed and one memory: three traceable sources.
  expect(within(screen.getByRole('group', { name: 'Sources' })).getByText('3', { selector: '.vp-flair' })).toBeTruthy();
  expect(within(statusRow('This page')).getByText('Up to date')).toBeTruthy();
  const details = screen.getByText('Technical details').closest('details') as HTMLDetailsElement;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText('Technical details'));
  expect(screen.getByText('out', { selector: 'code' })).toBeTruthy();
  expect(screen.getByText(/All recorded direct sources were checked/)).toBeTruthy();
});

it('leads with changed sources and loads changed memory text without a click', async () => {
  renderInspector((req) => {
    if (req.arguments.select === 'input_text' && req.arguments.input_id === 'memory-9')
      return Promise.resolve(memoryText('9'));
    if (req.arguments.select !== 'output') return defaultCall(req);
    return Promise.resolve(
      env(
        withInputs([
          note('a', 'Meeting A', 'formatted-node-body-prefix:v1', 'changed'),
          note('b', 'Task B', 'task-fields:v1', 'missing'),
          memory('9', 'changed'),
          memory('8'),
        ]),
      ),
    );
  });
  expect(await screen.findByText('3 sources changed')).toBeTruthy();
  expect(within(statusRow('This page')).getByText(/This page doesn't reflect them yet\./)).toBeTruthy();
  const changed = screen.getByRole('group', { name: 'Changed since this build' });
  expect(within(changed).getByRole('button', { name: 'Meeting A' })).toBeTruthy();
  expect(within(changed).getByText('Task B')).toBeTruthy();
  expect(within(changed).getByText('deleted since')).toBeTruthy();
  expect(await within(changed).findByText('Memory number 9 is true.')).toBeTruthy();
  expect(within(changed).queryByRole('button', { name: 'Show captured text' })).toBeNull();
});

it('loads memory text when the memories group is opened', async () => {
  const reads: unknown[] = [];
  renderInspector((req) => {
    if (req.arguments.select === 'input_text') {
      reads.push(req.arguments.input_id);
      return Promise.resolve(memoryText(String(req.arguments.input_id).slice('memory-'.length)));
    }
    if (req.arguments.select !== 'output') return defaultCall(req);
    return Promise.resolve(env(withInputs([memory('1'), memory('2')])));
  });
  const group = (await screen.findByText('Memories')).closest('details')!;
  expect(within(group).getByText('Memory #2')).toBeTruthy();
  expect(reads).toEqual([]);
  group.open = true;
  fireEvent(group, new Event('toggle'));
  expect(await within(group).findByText('Memory number 2 is true.')).toBeTruthy();
  expect(within(group).getByText('Memory number 1 is true.')).toBeTruthy();
  expect([...reads].sort()).toEqual(['memory-1', 'memory-2']);
});

it('reads every input page before claiming the page is up to date', async () => {
  const cursors: unknown[] = [];
  renderInspector((req) => {
    if (req.arguments.select !== 'output') return defaultCall(req);
    cursors.push(req.arguments.cursor);
    return Promise.resolve(
      env(
        req.arguments.cursor
          ? withInputs([note('b', 'Second', 'formatted-node-body-prefix:v1', 'changed')])
          : withInputs([note('a', 'First', 'formatted-node-body-prefix:v1')], { next_cursor: 'page-two' }),
      ),
    );
  });
  expect(await screen.findByText('1 source changed')).toBeTruthy();
  expect(cursors).toEqual([undefined, 'page-two']);
  expect(screen.queryByText(/Up to date/)).toBeNull();
  expect(within(screen.getByText('Read').closest('details')!).getByText('2', { selector: '.vp-count' })).toBeTruthy();
});

it('says what changed since the build this one replaced', async () => {
  renderInspector((req) => {
    if (req.arguments.select === 'node')
      return Promise.resolve(
        env({
          select: 'node',
          outputs: [
            { ...output('out'), receipt: { ...output('out').receipt, replaces_output_revision_id: 'before' } },
            output('before'),
          ],
          current_provenance: 'captured',
          next_cursor: null,
        }),
      );
    if (req.arguments.select !== 'output') return defaultCall(req);
    if (req.arguments.output_revision_id === 'before')
      return Promise.resolve(
        env(withInputs([note('a', 'Kept', 'formatted-node-body-prefix:v1'), note('gone', 'Dropped note', 'task-fields:v1'), memory('1')], { id: 'before' })),
      );
    return Promise.resolve(
      env(
        withInputs(
          [note('a', 'Kept', 'formatted-node-body-prefix:v1'), note('n', 'Fresh meeting', 'timeline-projection:v1'), memory('2'), memory('3')],
          { replaces: 'before' },
        ),
      ),
    );
  });
  const changes = await screen.findByRole('region', { name: 'Changes from the previous build' });
  expect(within(changes).getByText(/^Newly used: Fresh meeting/)).toBeTruthy();
  expect(within(changes).getByText(/^No longer used: Dropped note/)).toBeTruthy();
  expect(within(changes).getByText('+2 memories')).toBeTruthy();
  expect(within(changes).getByText('−1 memory')).toBeTruthy();
  const listed = screen.getByText('Listed').closest('details')!;
  expect(within(listed).getByText('New')).toBeTruthy();
  const read = screen.getByText('Read').closest('details')!;
  expect(within(read).queryByText('New')).toBeNull();
});

it('marks an older build and offers the latest instead of judging it stale', async () => {
  renderInspector((req) => {
    if (req.arguments.select === 'node')
      return Promise.resolve(
        env({
          select: 'node',
          outputs: [
            { ...output('newest'), receipt: { ...output('newest').receipt, replaces_output_revision_id: 'older' } },
            output('older'),
          ],
          current_provenance: 'captured',
          next_cursor: null,
        }),
      );
    return defaultCall(req);
  }, { preferredOutputId: 'older' });
  expect(await screen.findByText('Viewing an older build')).toBeTruthy();
  expect(within(statusRow('This page')).getByText(/ Replaced /)).toBeTruthy();
  expect(screen.queryByText(/Up to date/)).toBeNull();
  expect(screen.queryByRole('group', { name: 'Changed since this build' })).toBeNull();
  // The history is open on an older build, with it selected.
  expect((screen.getByRole('group', { name: 'History' }) as HTMLDetailsElement).open).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Show the latest build' }));
  expect(await screen.findByText(/^\d+ sources? changed$/)).toBeTruthy();
});

it('reports a hand edit to the curator-written section', async () => {
  renderInspector((req) =>
    req.arguments.select === 'output'
      ? Promise.resolve(env(withInputs([note('a', 'A', 'formatted-node-body-prefix:v1')], { currentness: 'changed' })))
      : defaultCall(req),
  );
  expect(await screen.findByText('Edited after this build')).toBeTruthy();
  expect(within(statusRow('This page')).getByText(/^Curator's sections were changed by you or another tool\./)).toBeTruthy();
});

it('opens "Pages built from this note" for a note with no build record', async () => {
  renderInspector((req) =>
    req.arguments.select === 'node'
      ? Promise.resolve(env({ select: 'node', outputs: [], current_provenance: 'unknown_legacy', next_cursor: null }))
      : defaultCall(req),
  { hasImpactTool: true });
  expect(within(await findStatusRow('This note')).getByText('No build record')).toBeTruthy();
  const impact = screen.getByRole('group', { name: 'Pages built from this note' }) as HTMLDetailsElement;
  expect(impact.open).toBe(true);
});

it('reads nothing for "Pages built from this note" until it is opened, and opens it on request', async () => {
  const calls: string[] = [];
  const call: CallFn = (req) => { calls.push(req.name); return defaultCall(req); };
  const target = { nodeId: 'home', title: 'Home', path: 'Home.md' };
  const view = renderInspector(call, { hasImpactTool: true, target });
  await screen.findByText(/^\d+ sources? changed$/);
  const impact = screen.getByRole('group', { name: 'Pages built from this note' }) as HTMLDetailsElement;
  expect(impact.open).toBe(false);
  expect(impact.querySelector('.vp-section-body')).toBeNull();
  expect(calls).not.toContain('find-affected-outputs');
  view.rerender(
    <VizClientProvider call={call}>
      <ProvenanceInspector target={target} targetError={null}
        connectionKey={1} hasInspectionTool hasImpactTool focusImpact={1} onOpenNode={async () => {}} />
    </VizClientProvider>,
  );
  await waitFor(() => expect(impact.open).toBe(true));
  expect(impact.querySelector('.vp-section-body')).toBeTruthy();
});

it('offers an on-demand rebuild only when Engine says the build is eligible', async () => {
  let eligible = false;
  const refresh = vi.fn();
  renderInspector((req) => {
    if (req.arguments.select === 'refresh_target')
      return defaultCall(req).then((response) => {
        const data = JSON.parse((response.content[0] as { text: string }).text).data;
        return env({ ...data, eligible });
      });
    return defaultCall(req);
  }, { onRefreshHome: refresh });
  await screen.findByText(/^\d+ sources? changed$/);
  expect(screen.queryByRole('button', { name: 'Rebuild this page… (paid)' })).toBeNull();
  eligible = true;
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  const rebuild = await screen.findByRole('button', { name: 'Rebuild this page… (paid)' });
  // A page with changed sources needs you: its rebuild is the accent button.
  expect(rebuild.className).toContain('mod-cta');
  fireEvent.click(rebuild);
  expect(refresh).toHaveBeenCalledWith('out', 'fixture');
});

it('offers to rebuild the whole wiki from the latest build, whether or not the page itself is eligible (#372)', async () => {
  const rebuild = vi.fn();
  renderInspector((req) => {
    if (req.arguments.select === 'refresh_target')
      return defaultCall(req).then((response) => {
        const data = JSON.parse((response.content[0] as { text: string }).text).data;
        return env({ ...data, eligible: false, reasons: ['HOME_OWNERSHIP_CHANGED'], project_title: 'Project' });
      });
    return defaultCall(req);
  }, { onRebuildWiki: rebuild });
  fireEvent.click(await screen.findByRole('button', { name: 'Rebuild the whole wiki… (paid)' }));
  expect(rebuild).toHaveBeenCalledWith('Project');
  expect(screen.queryByRole('button', { name: 'Rebuild this page… (paid)' })).toBeNull();
});

/** A get-node reply: `wiki_for` names the wiki's root, `wiki_parent` a sub-page's parent page. */
const wikiNode = (id: string, title: string, rel: { wikiFor?: string; parent?: string; status?: string } = {}) => ({
  id, title, file_path: `${title}.md`, types: [], body: '', version: 1,
  fields: {
    ...(rel.status ? { wiki_status: { value: rel.status, type: 'text', source: 'frontmatter' } } : {}),
    ...(rel.parent ? { wiki_parent: { value: rel.parent, type: 'text', source: 'frontmatter' } } : {}),
  },
  relationships: {
    outgoing: {
      ...(rel.wikiFor ? { wiki_for: [{ target_id: rel.wikiFor, target_title: rel.wikiFor }] } : {}),
      ...(rel.parent ? { wiki_parent: [{ target_id: 'parent', target_title: rel.parent }] } : {}),
    },
    incoming: {},
  },
});
const noBuildRecords = (current_provenance = 'unknown_legacy') =>
  Promise.resolve(env({ select: 'node', outputs: [], current_provenance, next_cursor: null }));
/** Engine with these nodes by id, each with the pages naming it in `wiki_for` as incoming links; inspection as
 *  `defaultCall`, with no builds unless `builds`. */
const wikiEngine = (nodes: ReturnType<typeof wikiNode>[], builds = false): CallFn => (req) => {
  if (req.name === 'get-node') {
    const node = nodes.find((n) => n.id === req.arguments.node_id);
    if (!node) return Promise.resolve({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'none' }, warnings: [] }) }] });
    const pages = nodes.filter((n) => (n.relationships.outgoing as { wiki_for?: Array<{ target_id: string }> }).wiki_for?.some((w) => w.target_id === node.id));
    const incoming = pages.length ? { wiki_for: pages.map((p) => ({ source_id: p.id, source_title: p.title })) } : {};
    return Promise.resolve(env({ ...node, relationships: { ...node.relationships, incoming } }));
  }
  if (req.arguments.select === 'node' && !builds) return noBuildRecords();
  return defaultCall(req);
};
const curatorStatus = (project: string, over: Partial<WikiRebuildStatus> = {}): WikiRebuildStatus => ({
  project, kind: 'project', root_node_id: 'alpha', source: null, in_progress: null, paused: false,
  models: { planning: 'Planner', page: 'Writer', home: 'Writer' },
  latest_run: { id: 7, ts: '2026-11-10T03:00:00Z', outcome: 'written', error: null, cost_usd: 0.42, input_tokens: 1, output_tokens: 1, duration_ms: 1 },
  last_written: { id: 7, ts: '2026-11-10T03:00:00Z', outcome: 'written', error: null, cost_usd: 0.42, input_tokens: 1, output_tokens: 1, duration_ms: 1 },
  daily_budget: { cap_usd: 1, spent_usd: 0.25, remaining_usd: 0.75 },
  ...over,
});
const controlApi = (status: WikiRebuildStatus) => {
  let paused = status.paused;
  return {
    status: vi.fn(async () => ({ ...status, paused })),
    setPaused: vi.fn(async (_project: string, next: boolean) => { paused = next; return { paused }; }),
  } satisfies WikiControlApi;
};
const card = () => screen.findByRole('group', { name: 'Wiki' });
const scheduled = (region: ReturnType<typeof within>) => region.findByRole('switch', { name: 'Scheduled builds' });

describe('the wiki card on a project wiki page (#545)', () => {
  const nodes = [
    wikiNode('home', 'Project Alpha Wiki', { wikiFor: 'alpha', status: 'behind' }),
    wikiNode('sub', 'Project Alpha Wiki - Risks', { wikiFor: 'alpha', parent: 'Project Alpha Wiki' }),
    wikiNode('alpha', 'Project Alpha'),
  ];
  const find = () => vi.fn(async () => ({ name: 'Project Alpha', kind: 'project' as const }));

  it('shows the wiki, its home status, last build and budget on a built page, with one whole-wiki rebuild', async () => {
    const rebuild = vi.fn();
    const lookup = find();
    renderInspector(wikiEngine(nodes, true), { target: { nodeId: 'home', title: 'Project Alpha Wiki', path: 'Project Alpha Wiki.md' },
      onRebuildWiki: rebuild, findWiki: lookup, wikiApi: controlApi(curatorStatus('Project Alpha')) });
    const region = within(await card());
    expect(screen.getByText('Wiki home')).toBeTruthy();
    expect(screen.getByText(/^Home of the wiki for/).textContent).toBe('Home of the wiki for Project Alpha Project ');
    const wikiRow = within(await findStatusRow('Wiki'));
    expect(await wikiRow.findByText('Behind')).toBeTruthy();
    expect(wikiRow.getByText(/^Notes have changed since its .+ build\.$/)).toBeTruthy();
    expect(region.getByText('Last full build')).toBeTruthy();
    expect(region.getByText('est. $0.420')).toBeTruthy();
    expect(region.getByText('$0.750 of $1.00 left')).toBeTruthy();
    expect(region.getByRole('meter').getAttribute('aria-valuenow')).toBe('75');
    expect(lookup).toHaveBeenCalledWith({ title: 'Project Alpha', nodeId: 'alpha' });
    // The build trace is still there, below the wiki, and the wiki rebuild is offered once.
    expect(await screen.findByRole('group', { name: 'Sources' })).toBeTruthy();
    await screen.findByText(/^\d+ sources? changed$/);
    expect(screen.getAllByRole('button', { name: 'Rebuild the whole wiki… (paid)' })).toHaveLength(1);
    expect(region.queryByRole('button', { name: 'Open wiki home' })).toBeNull();
    fireEvent.click(wikiRow.getByRole('button', { name: 'Rebuild the whole wiki… (paid)' }));
    expect(rebuild).toHaveBeenCalledWith('Project Alpha');
  });

  it('reads the home\'s status from a sub-page and opens the home', async () => {
    const opened = vi.fn(async () => {});
    renderInspector(wikiEngine(nodes, true), { target: { nodeId: 'sub', title: 'Project Alpha Wiki - Risks', path: 'x.md' },
      onRebuildWiki: vi.fn(), findWiki: find(), wikiApi: controlApi(curatorStatus('Project Alpha')), onOpenNode: opened });
    const region = within(await card());
    expect(screen.getByText('Wiki page')).toBeTruthy();
    expect(screen.getByText(/^Page in/).textContent).toBe('Page in Project Alpha wiki Project ');
    expect(await within(statusRow('Wiki')).findByText('Behind')).toBeTruthy();
    fireEvent.click(region.getByRole('button', { name: 'Open wiki home' }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith('home', expect.any(Function)));
  });

  it('pauses and resumes the wiki through the control API, then reads the home again', async () => {
    const api = controlApi(curatorStatus('Project Alpha'));
    const engine = vi.fn(wikiEngine(nodes, true));
    renderInspector(engine, { target: { nodeId: 'home', title: 'Project Alpha Wiki', path: 'Project Alpha Wiki.md' },
      onRebuildWiki: vi.fn(), findWiki: find(), wikiApi: api });
    const region = within(await card());
    const homeReads = () => engine.mock.calls.filter(([req]) => req.name === 'get-node' && req.arguments.node_id === 'home').length;
    const toggle = await scheduled(region);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    const initial = homeReads();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(api.setPaused).toHaveBeenCalledWith('Project Alpha', true);
    expect(region.getByText('Off. This wiki changes only when you rebuild it.')).toBeTruthy();
    expect(region.getByText('Scheduled builds are off.', { selector: '[role="status"]' })).toBeTruthy();
    // The home's status is read again: the Curator stamps paused on it.
    await waitFor(() => expect(homeReads()).toBe(initial + 1));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(api.setPaused).toHaveBeenLastCalledWith('Project Alpha', false);
    await waitFor(() => expect(homeReads()).toBe(initial + 2));
  });

  it('says so when a pause fails, and keeps the wiki as it was', async () => {
    const api = { ...controlApi(curatorStatus('Project Alpha')), setPaused: vi.fn(async () => { throw Error('refused'); }) };
    renderInspector(wikiEngine(nodes, true), { target: { nodeId: 'home', title: 'Project Alpha Wiki', path: 'Project Alpha Wiki.md' },
      onRebuildWiki: vi.fn(), findWiki: find(), wikiApi: api });
    const region = within(await card());
    fireEvent.click(await scheduled(region));
    expect(await region.findByText(/^Couldn't turn scheduled builds off\./)).toBeTruthy();
    expect((await scheduled(region)).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the toggle usable when Check again replaces a pause still in flight', async () => {
    const pending = deferred<{ paused: boolean }>();
    const api = { ...controlApi(curatorStatus('Project Alpha')), setPaused: vi.fn(() => pending.promise) };
    renderInspector(wikiEngine(nodes, true), { target: { nodeId: 'home', title: 'Project Alpha Wiki', path: 'Project Alpha Wiki.md' },
      onRebuildWiki: vi.fn(), findWiki: find(), wikiApi: api });
    const region = within(await card());
    fireEvent.click(await scheduled(region));
    await waitFor(async () => expect((await scheduled(region)).hasAttribute('disabled')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    const again = within(await card());
    await waitFor(async () => expect((await scheduled(again)).hasAttribute('disabled')).toBe(false));
    // The old answer, arriving late, changes nothing.
    await act(async () => pending.resolve({ paused: true }));
    expect((await scheduled(again)).getAttribute('aria-checked')).toBe('true');
    expect((await scheduled(again)).hasAttribute('disabled')).toBe(false);
  });

  it('shows a running build and a failed one from the Curator\'s status', async () => {
    renderInspector(wikiEngine(nodes, true), { target: { nodeId: 'home', title: 'Project Alpha Wiki', path: 'Project Alpha Wiki.md' },
      onRebuildWiki: vi.fn(), findWiki: find(), wikiApi: controlApi(curatorStatus('Project Alpha', {
        in_progress: { since: '2026-11-16T10:00:00Z' }, queue: { running: true, depth: 1, current: 'Project Alpha' } })) });
    await card();
    expect(await within(statusRow('Wiki')).findByText('Building now')).toBeTruthy();
    // No rebuild is offered while one runs.
    expect(screen.queryByRole('button', { name: 'Rebuild the whole wiki… (paid)' })).toBeNull();
    cleanup();
    const failed = { id: 8, ts: '2026-11-11T03:00:00Z', outcome: 'error', error: 'the home model timed out', cost_usd: null, input_tokens: 0, output_tokens: 0, duration_ms: 1 };
    renderInspector(wikiEngine(nodes, true), { target: { nodeId: 'home', title: 'Project Alpha Wiki', path: 'Project Alpha Wiki.md' },
      onRebuildWiki: vi.fn(), findWiki: find(), wikiApi: controlApi(curatorStatus('Project Alpha', { latest_run: failed })) });
    await card();
    const failedRow = within(statusRow('Wiki'));
    expect(await failedRow.findByText('Last build failed')).toBeTruthy();
    expect(failedRow.getByRole('alert').textContent).toMatch(/^.+: the home model timed out$/);
    expect(failedRow.getByRole('button', { name: 'Retry the wiki build… (paid)' })).toBeTruthy();
  });

  it('finds a renamed home by its links, from a sub-page and from the root note', async () => {
    const renamed = [
      wikiNode('sub', 'Alpha Risks', { wikiFor: 'alpha', parent: 'Alpha Overview' }),
      wikiNode('home', 'Alpha Overview', { wikiFor: 'alpha', status: 'behind' }),
      wikiNode('alpha', 'Project Alpha'),
    ];
    const opened = vi.fn(async () => {});
    for (const nodeId of ['sub', 'alpha']) {
      renderInspector(wikiEngine(renamed, nodeId === 'sub'), { target: { nodeId, title: nodeId, path: `${nodeId}.md` },
        onRebuildWiki: vi.fn(), findWiki: find(), wikiApi: controlApi(curatorStatus('Project Alpha')), onOpenNode: opened });
      const region = within(await card());
      expect(await within(statusRow('Wiki')).findByText('Behind')).toBeTruthy();
      fireEvent.click(region.getByRole('button', { name: 'Open wiki home' }));
      await waitFor(() => expect(opened).toHaveBeenLastCalledWith('home', expect.any(Function)));
      cleanup();
    }
  });

  it('shows a scheduled build from the home\'s status, which the Curator doesn\'t report as in progress', async () => {
    const building = [wikiNode('home', 'Project Alpha Wiki', { wikiFor: 'alpha', status: 'building' }), wikiNode('alpha', 'Project Alpha')];
    renderInspector(wikiEngine(building, true), { target: { nodeId: 'home', title: 'Project Alpha Wiki', path: 'Project Alpha Wiki.md' },
      onRebuildWiki: vi.fn(), findWiki: find(), wikiApi: controlApi(curatorStatus('Project Alpha')) });
    const region = within(await card());
    await waitFor(() => expect(region.queryByRole('status')).toBeNull());
    expect(within(statusRow('Wiki')).getByText('Building now')).toBeTruthy();
    expect(within(statusRow('Wiki')).getByText('A scheduled build is running.')).toBeTruthy();
  });

  it('says what to set up when no Curator is configured, and shows no card', async () => {
    renderInspector(wikiEngine(nodes, true), { target: { nodeId: 'home', title: 'Project Alpha Wiki', path: 'Project Alpha Wiki.md' },
      onRebuildWiki: vi.fn(), findWiki: vi.fn(async () => null) });
    expect(await within(await findStatusRow('Wiki')).findByText('Status unavailable')).toBeTruthy();
    expect(within(statusRow('Wiki')).getByText(/^Connect Curator in the plugin settings/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Wiki' })).toBeNull();
  });
});

describe('a project wiki\'s home before its first build, which has no build records (#544)', () => {
  const nodes = [wikiNode('home', 'Project Alpha Wiki', { wikiFor: 'alpha' }), wikiNode('alpha', 'Project Alpha')];

  it('shows the wiki card, says it has not been built yet, and offers the whole-wiki rebuild', async () => {
    const rebuild = vi.fn();
    const find = vi.fn(async () => ({ name: 'Project Alpha', kind: 'project' as const }));
    renderInspector(wikiEngine(nodes), { target: { nodeId: 'home', title: 'Project Alpha Wiki', path: 'Project Alpha Wiki.md' },
      onRebuildWiki: rebuild, findWiki: find,
      wikiApi: controlApi(curatorStatus('Project Alpha', { latest_run: null, last_written: null, paused: true })) });
    const region = within(await card());
    expect(find).toHaveBeenCalledWith({ title: 'Project Alpha', nodeId: 'alpha' });
    expect(await within(statusRow('Wiki')).findByText('Not built yet')).toBeTruthy();
    expect(region.getByText('None yet')).toBeTruthy();
    expect(within(statusRow('This page')).getByText('No build record')).toBeTruthy();
    expect(within(statusRow('This page')).getByText(/^The wiki hasn’t been built yet/)).toBeTruthy();
    // Not the topic wording, nor the plain note's: no single-page rebuild.
    expect(screen.queryByText(/topic wiki/i)).toBeNull();
    expect(screen.queryByRole('group', { name: 'This note status' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rebuild this page… (paid)' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild the whole wiki… (paid)' }));
    expect(rebuild).toHaveBeenCalledWith('Project Alpha');
    expect((await scheduled(region)).getAttribute('aria-checked')).toBe('false');
  });

  it('asks nothing and offers no rebuild in an inspector that cannot rebuild', async () => {
    const find = vi.fn(async () => ({ name: 'Project Alpha', kind: 'project' as const }));
    renderInspector(wikiEngine(nodes), { findWiki: find });
    await findStatusRow('This note');
    await settle();
    expect(find).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Rebuild the whole wiki… (paid)' })).toBeNull();
  });
});

describe('a topic wiki page, which has no build records (#425)', () => {
  const nodes = [wikiNode('home', 'Tidal Power Wiki', { wikiFor: 'root', status: 'paused' }), wikiNode('root', 'Tidal Power')];
  const status = curatorStatus('Tidal Power', { kind: 'topic', root_node_id: 'root', source: 'vault+web', paused: true });

  it('names the wiki, says only the whole wiki can be rebuilt, and offers that', async () => {
    const rebuild = vi.fn();
    const find = vi.fn(async () => ({ name: 'Tidal Power', kind: 'topic' as const }));
    renderInspector(wikiEngine(nodes), { onRebuildWiki: rebuild, findWiki: find, wikiApi: controlApi(status) });
    const region = within(await card());
    expect(screen.getByText('Wiki home')).toBeTruthy();
    expect(await region.findByText('Its source notes, plus the top web results for the topic.')).toBeTruthy();
    expect(screen.getByText(/^Home of the wiki for/).textContent).toMatch(/^Home of the wiki for Tidal Power Topic\s+Web$/);
    expect(within(statusRow('Wiki')).getByText('Paused')).toBeTruthy();
    expect(find).toHaveBeenCalledWith({ title: 'Tidal Power', nodeId: 'root' });
    expect(within(statusRow('This page')).getByText('No build of its own')).toBeTruthy();
    expect(screen.getByText(/^Topic wikis rebuild as a whole/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'This note status' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rebuild this page… (paid)' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild the whole wiki… (paid)' }));
    expect(rebuild).toHaveBeenCalledWith('Tidal Power');
  });

  it('keeps the plain message when Curator says the page is no registered wiki\'s', async () => {
    const find = vi.fn(async () => null);
    renderInspector(wikiEngine(nodes), { onRebuildWiki: vi.fn(), findWiki: find, wikiApi: controlApi(status) });
    expect(within(await findStatusRow('This note')).getByText('No build record')).toBeTruthy();
    await settle();
    expect(find).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Rebuild the whole wiki… (paid)' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Wiki' })).toBeNull();
  });
});

it('says when Curator can\'t be reached to find the wiki, and doesn\'t call the note plain (#545)', async () => {
  const find = vi.fn(async () => { throw Error('Curator down'); });
  renderInspector(wikiEngine([wikiNode('note', 'Kickoff')]), { target: { nodeId: 'note', title: 'Kickoff', path: 'Kickoff.md' },
    onRebuildWiki: vi.fn(), findWiki: find, wikiApi: controlApi(curatorStatus('x')), onCreateProjectWiki: vi.fn() });
  expect(await screen.findByText(/^Couldn’t reach Curator to find this note’s wiki\./)).toBeTruthy();
  expect(screen.queryByText('Not part of a wiki')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create project wiki…' })).toBeNull();
});

describe('a note that is no wiki page (#545)', () => {
  it('shows the wiki on its root note, with the home to open and the reverse view', async () => {
    const opened = vi.fn(async () => {});
    const find = vi.fn(async () => ({ name: 'Project Alpha', kind: 'project' as const }));
    renderInspector(wikiEngine([wikiNode('home', 'Project Alpha Wiki', { wikiFor: 'alpha', status: 'current' }), wikiNode('alpha', 'Project Alpha')]), {
      target: { nodeId: 'alpha', title: 'Project Alpha', path: 'Project Alpha.md' }, onRebuildWiki: vi.fn(), findWiki: find,
      wikiApi: controlApi(curatorStatus('Project Alpha')), onOpenNode: opened, hasImpactTool: true, onCreateProjectWiki: vi.fn() });
    const region = within(await card());
    expect(find).toHaveBeenCalledWith({ title: 'Project Alpha', nodeId: 'alpha' });
    expect(screen.getByText('Project note')).toBeTruthy();
    expect(screen.getByText(/^Has a wiki/)).toBeTruthy();
    expect(await within(statusRow('Wiki')).findByText('Up to date')).toBeTruthy();
    expect(within(statusRow('Wiki')).getByText(/^Its notes haven't changed since its .+ build\.$/)).toBeTruthy();
    // Its own page row is absent: the root note isn't a page of the wiki.
    expect(screen.queryByRole('group', { name: 'This page status' })).toBeNull();
    expect((screen.getByRole('group', { name: 'Pages built from this note' }) as HTMLDetailsElement).open).toBe(true);
    expect(screen.queryByText('Not part of a wiki')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create project wiki…' })).toBeNull();
    fireEvent.click(region.getByRole('button', { name: 'Open wiki home' }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith('home', expect.any(Function)));
  });

  it('offers to create a wiki and to find pages behind on a plain note', async () => {
    const project = vi.fn(), topic = vi.fn();
    renderInspector(wikiEngine([wikiNode('note', 'Kickoff')]), { target: { nodeId: 'note', title: 'Kickoff', path: 'Kickoff.md' },
      onRebuildWiki: vi.fn(), findWiki: vi.fn(async () => null), wikiApi: controlApi(curatorStatus('x')),
      onCreateProjectWiki: project, onCreateTopicWiki: topic, hasImpactTool: true });
    expect(await screen.findByText('Not part of a wiki')).toBeTruthy();
    expect(screen.getByText('Note')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'This note status' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Status' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create project wiki…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create topic wiki…' }));
    expect([project, topic].map((f) => f.mock.calls.length)).toEqual([1, 1]);
    expect((screen.getByRole('group', { name: 'Pages built from this note' }) as HTMLDetailsElement).open).toBe(true);
  });
});

it('hides navigation for a missing source while retaining text and restores navigation after refresh', async () => {
  let missing = true;
  renderInspector((req) => {
    if (req.arguments.select !== 'output') return defaultCall(req);
    const page = inputPage();
    if (page.select !== 'output') throw Error('Invalid fixture');
    return Promise.resolve(
      env({
        ...page,
        inputs: page.inputs.map((input) => ({
          ...input,
          comparison: missing ? 'missing' : 'unchanged',
        })),
      }),
    );
  });
  // Each step settles inside act instead of polling against findBy's 1 s timeout,
  // which a loaded full-suite run exceeded (#314). The fixture answers at once.
  await settle();
  expect(screen.getByRole('button', { name: 'Show captured text' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Source' })).toBeNull();
  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Show captured text' })));
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  missing = false;
  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Check again' })));
  expect(screen.getByRole('button', { name: 'Source' })).toBeTruthy();
});

it('removes old comparisons while refresh discovery and history are pending or fail', async () => {
  const discovery = deferred<Awaited<ReturnType<CallFn>>>();
  const history = deferred<Awaited<ReturnType<CallFn>>>();
  let refreshing = false;
  renderInspector((req) => {
    if (refreshing && req.arguments.select === 'status')
      return discovery.promise;
    if (refreshing && req.arguments.select === 'node') return history.promise;
    return defaultCall(req);
  });
  await screen.findAllByText('changed since');
  refreshing = true;
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(screen.queryByText('changed since')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Checking');
  await act(async () => discovery.resolve(env(status())));
  expect(screen.queryByText('changed since')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Loading');
  await act(async () =>
    history.resolve({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: 'History temporarily unavailable',
            },
            warnings: [],
          }),
        },
      ],
    }),
  );
  expect(screen.getByRole('alert').textContent).toContain(
    'History temporarily unavailable',
  );
  expect(screen.queryByText('changed since')).toBeNull();
  refreshing = false;
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await screen.findAllByText('changed since');
});

it('retries a failed source page using its original cursor without refreshing', async () => {
  let attempts = 0;
  const cursors: unknown[] = [];
  const next = deferred<Awaited<ReturnType<CallFn>>>();
  renderInspector(async (req) => {
    if (req.arguments.select !== 'output') return defaultCall(req);
    if (req.arguments.cursor) {
      cursors.push(req.arguments.cursor);
      if (++attempts === 1) throw Error('Temporary page failure');
      return next.promise;
    }
    const response = await defaultCall(req);
    const data = JSON.parse((response.content[0] as { text: string }).text).data;
    return env({ ...data, next_cursor: 'page-two' });
  });
  // The second page loads by itself; its failure leaves a retry, not a refresh.
  expect((await screen.findByRole('alert')).textContent).toContain('Temporary page failure');
  expect(screen.getByText('Checked 1 source so far')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading sources' }));
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () =>
    next.resolve(env(withInputs([note('second', 'Second source', 'formatted-node-body-prefix:v1', 'changed')]))),
  );
  expect(cursors).toEqual(['page-two', 'page-two']);
  expect(screen.queryByRole('button', { name: /sources$/ })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Second source' }).length).toBeGreaterThan(0);
  expect(screen.getByText('2 sources changed')).toBeTruthy();
});

it('retries a failed history page using its original cursor without refreshing', async () => {
  let attempts = 0;
  const cursors: unknown[] = [];
  const next = deferred<Awaited<ReturnType<CallFn>>>();
  renderInspector(async (req) => {
    if (req.arguments.select !== 'node') return defaultCall(req);
    if (req.arguments.cursor) {
      cursors.push(req.arguments.cursor);
      if (++attempts === 1) throw Error('Temporary page failure');
      return next.promise;
    }
    const response = await defaultCall(req);
    const data = JSON.parse((response.content[0] as { text: string }).text).data;
    return env({ ...data, next_cursor: 'page-two' });
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Show older builds' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Temporary page failure');
  fireEvent.click(screen.getByRole('button', { name: 'Retry older builds' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: 'Show older builds' })).toHaveProperty('disabled', true);
  await act(async () =>
    next.resolve(
      env({ select: 'node', outputs: [output('older')], current_provenance: 'captured', next_cursor: null }),
    ),
  );
  expect(cursors).toEqual(['page-two', 'page-two']);
  expect(screen.queryByRole('button', { name: 'Show older builds' })).toBeNull();
  expect(document.querySelectorAll('.vp-generation')).toHaveLength(2);
});

it('renders retained text literally and keeps the target pinned when opening a source', async () => {
  const open = vi.fn(async (_id: string, _isCurrent?: () => boolean) => {});
  const { container } = renderInspector(defaultCall, { onOpenNode: open });
  await settle();
  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Show captured text' })));
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  expect(container.querySelector('img')).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Source' })[0]!);
  expect(open).toHaveBeenCalledWith('source', expect.any(Function));
  expect(screen.getByRole('heading', { name: 'Home' })).toBeTruthy();
  expect(screen.getAllByText('changed since').length).toBeGreaterThan(0);
});

it('shows a listed source as the lines that mention it', async () => {
  renderInspector((req) => {
    if (req.arguments.select === 'input_text')
      return Promise.resolve(
        env({
          select: 'input_text',
          output_revision_id: 'out',
          input_id: req.arguments.input_id,
          availability: 'retained',
          input_digest: 'digest',
          segments: [
            {
              span_index: 0,
              field: 'evidence',
              span_start: 0,
              span_end: 10,
              start: 0,
              end: 10,
              text: '## TIMELINE\n  - 2026-10-20 — Other meeting (meeting)\n  - 2026-10-21 — Sync with Dan (meeting)\n',
            },
          ],
          next_cursor: null,
        }),
      );
    if (req.arguments.select !== 'output') return defaultCall(req);
    return Promise.resolve(env(withInputs([note('s', 'Sync with Dan', 'timeline-projection:v1')])));
  });
  const group = (await screen.findByText('Listed')).closest('details')!;
  fireEvent.click(within(group).getByRole('button', { name: 'Show captured text' }));
  expect(await within(group).findByText('2026-10-21 — Sync with Dan (meeting)')).toBeTruthy();
  expect(within(group).getByText(/In the timeline of dated tasks and meetings/)).toBeTruthy();
  expect(within(group).queryByText(/Other meeting/)).toBeNull();
});

it('does not let a slow source lookup override a newer open action', async () => {
  const slow = deferred<void>();
  const opened: string[] = [];
  const call: CallFn = async (request) => {
    if (request.arguments.select !== 'output') return defaultCall(request);
    return env(
      withInputs([
        note('slow-source', 'Slow source', 'formatted-node-body-prefix:v1'),
        note('fast-source', 'Fast source', 'formatted-node-body-prefix:v1'),
      ]),
    );
  };
  renderInspector(call, {
    onOpenNode: async (id, isCurrent = () => true) => {
      if (id === 'slow-source') await slow.promise;
      if (isCurrent()) opened.push(id);
    },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Slow source' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fast source' }));
  await waitFor(() => expect(opened).toEqual(['fast-source']));
  await act(async () => slow.resolve());
  expect(opened).toEqual(['fast-source']);
});

it('invalidates a pending source open when the inspector unmounts', async () => {
  const slow = deferred<void>();
  const opened: string[] = [];
  const { unmount } = renderInspector(defaultCall, {
    onOpenNode: async (id, isCurrent = () => true) => {
      await slow.promise;
      if (isCurrent()) opened.push(id);
    },
  });
  fireEvent.click((await screen.findAllByRole('button', { name: 'Source' }))[0]!);
  unmount();
  await act(async () => slow.resolve());
  expect(opened).toEqual([]);
});

it('shows a navigation failure without pretending the note opened', async () => {
  renderInspector(defaultCall, {
    onOpenNode: async () => {
      throw Error('Source not available locally');
    },
  });
  fireEvent.click((await screen.findAllByRole('button', { name: 'Source' }))[0]!);
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Source not available locally',
  );
});

it.each(['home', 'merge-source'])('labels the %s publication transition as part of this build, not a stale source', async nodeId => {
  renderInspector(req => {
    if (req.arguments.select !== 'output') return defaultCall(req);
    const page = inputPage();
    if (page.select !== 'output') throw Error('Invalid fixture');
    return Promise.resolve(env({ ...page, inputs: page.inputs.map(input => ({ ...input,
      source: { kind: 'node', namespace: 'vault', native_id: nodeId }, comparison: 'expected_self_transition',
    })) }));
  });
  expect(await screen.findByText('rewritten in this build')).toBeTruthy();
  expect(within(statusRow('This page')).getByText('Up to date')).toBeTruthy();
});
