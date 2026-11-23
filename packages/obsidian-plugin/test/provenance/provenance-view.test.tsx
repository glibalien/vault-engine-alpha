import { afterEach, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import type { EngineConnection } from '../../src/engine/transport.js';
import { connectEngine } from '../../src/engine/transport.js';
import { ProvenanceView } from '../../src/provenance/provenance-view.js';
vi.mock('../../src/engine/transport.js', () => ({ connectEngine: vi.fn() }));
const env = (data: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify({ ok: true, data, warnings: [] }),
    },
  ],
});
const defer = <T,>() => {
  let resolve!: (v: T) => void;
  return {
    promise: new Promise<T>((r) => (resolve = r)),
    resolve: (v: T) => resolve(v),
  };
};
const views: ProvenanceView[] = [];
/** The rebuild dialog's content: the modal the view opens for a rebuild flow (#545). */
const dialogEl = (view: ProvenanceView): HTMLElement => {
  const modal = (view as unknown as { modal: { contentEl: HTMLElement } | null }).modal;
  if (!modal) throw Error('No rebuild dialog is open');
  return modal.contentEl;
};
afterEach(async () => {
  for (const view of views.splice(0)) await act(() => view.onClose());
  vi.resetAllMocks();
});
function setup(conn: Promise<EngineConnection>) {
  vi.mocked(connectEngine).mockReturnValue(conn);
  const plugin = { wikiCreation: () => ({}),
    settings: { engineUrl: 'http://fixture/mcp', token: 'test' },
    inspectCurrentNote: vi.fn(),
    reviewCurrentNoteImpact: vi.fn(),
    app: {},
  };
  const view = new ProvenanceView(
    { app: plugin.app } as never,
    plugin as never,
  );
  views.push(view);
  return view;
}
const status = {
  select: 'status',
  capability_version: 1,
  inspection_features: ['output_input_comparisons_v1', 'input_text_v1'],
  vault_namespace: 'fixture',
  limits: {},
  actual_bytes: 0,
  reserved_bytes: 0,
  purge_restore_verification: 'unverified',
};
const tool = (name: string) => ({
  name,
  description: name,
  inputSchema: { type: 'object' as const },
});
it.each(['save', 'preflight'].flatMap(stage => ['panel', 'view', 'newer'].map(mode => ({ stage, mode }))))(
  'cleans an unsent identity after $mode closure/replacement during $stage', async ({ stage, mode }) => {
  const newer = mode === 'newer';
  const { within, fireEvent } = await import('@testing-library/react');
  const saves: Array<{ state: Record<string, unknown>; done: ReturnType<typeof defer<void>> }> = [];
  const submitted: string[] = [];
  const checking = defer<void>(), checked = defer<void>();
  let pauseNextCheck = false;
  const guard = { version: 1, vault_namespace: 'fixture', project_id: 'project', home_node_id: 'home',
    output_revision_id: 'out', home_version: 1, topology_hash: 't', configuration_digest: 'c', corrections_digest: 'c' };
  vi.mocked(connectEngine).mockImplementation(async endpoint => ({ close: async () => {},
    listTools: async () => endpoint.includes('curator')
      ? ['preview-wiki-refresh', 'refresh-wiki-page', 'wiki-refresh-status'].map(tool) : [],
    call: async request => {
      if (request.name === 'inspect-provenance') {
        if (pauseNextCheck) { pauseNextCheck = false; checking.resolve(); await checked.promise; }
        return env(status);
      }
      if (request.name === 'preview-wiki-refresh') return env({ eligible: true, reasons: [], guard,
        model: { ref: 'model', provider: 'provider', max_output_tokens: 100 }, sections: ['Now'],
        project_title: 'Project', target_kind: 'home', page_title: null, page_path: null, home_title: 'Home', home_path: 'Home.md' });
      const id = String(request.arguments?.request_id); submitted.push(id);
      return env({ request_id: id, phase: 'committed', message: 'Finished', created_at: '', updated_at: '',
        replaces_output_revision_id: 'out', output: null, usage: null });
    } }));
  let view!: ProvenanceView;
  const plugin = { wikiCreation: () => ({}), settings: { engineUrl: 'https://engine/mcp', token: 'test', curatorUrl: 'https://curator/mcp', curatorToken: 'test' },
    app: { workspace: { requestSaveLayout: () => ({ run: () => {
      const done = defer<void>(); saves.push({ state: view.getState(), done }); return done.promise;
    } }) } } };
  view = new ProvenanceView({ app: plugin.app, setViewState: async (value: { state: unknown }) => {
    await view.setState(value.state, {} as never);
  } } as never, plugin as never);
  views.push(view);
  await act(() => view.onOpen());
  const open = () => { Object.assign(view, { refreshPanel: { outputId: 'out', namespace: 'fixture' } }); (view as any).draw(); };
  act(open);
  const dialog = () => within(dialogEl(view));
  const confirm = await dialog().findByText('Rebuild page');
  pauseNextCheck = stage === 'preflight';
  fireEvent.click(confirm);
  await waitFor(() => expect(saves).toHaveLength(1));
  const unsent = (saves[0]!.state.home_refresh as { request_id: string }).request_id;
  if (stage === 'preflight') {
    await act(async () => saves[0]!.done.resolve());
    await checking.promise;
  }
  if (mode === 'view') await act(() => view.onClose());
  else fireEvent.click(dialog().getByText('Close'));
  if (newer) { act(open); fireEvent.click(await dialog().findByText('Rebuild page')); }
  await act(async () => stage === 'preflight' ? checked.resolve() : saves[0]!.done.resolve());
  await waitFor(() => expect(saves.length).toBeGreaterThanOrEqual(2));
  await act(async () => saves[1]!.done.resolve());
  for (const save of saves.slice(2)) await act(async () => save.done.resolve());
  if (newer) {
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).not.toBe(unsent);
    expect(view.getState()).toMatchObject({ home_refresh: { request_id: submitted[0] } });
  } else {
    expect(submitted).toEqual([]);
    expect(view.getState()).toEqual({});
  }
});
it('can preview on the current endpoint after dismissing an old-endpoint resume', async () => {
  const { within, fireEvent } = await import('@testing-library/react');
  const output = { receipt: { derivation_id: 'd', output_revision_id: 'out', output_node_id: 'home',
    committed_node_version: 1, committed_at: '2026-09-20T00:00:00Z', operation_id: 'op', reconcile_key: 'key', request_digest: 'digest' },
    availability: 'retained', currentness: 'matches' };
  const engine: EngineConnection = { close: async () => {}, listTools: async () => [tool('inspect-provenance')],
    call: async req => {
      if (req.name === 'get-node') return env({ id: 'home', title: 'Home', file_path: 'Home.md' });
      if (req.arguments?.select === 'status') return env({ ...status, inspection_features: [...status.inspection_features, 'selective_home_refresh_v1'] });
      if (req.arguments?.select === 'node') return env({ select: 'node', outputs: [output], current_provenance: 'captured', next_cursor: null });
      if (req.arguments?.select === 'refresh_target') return env({ select: 'refresh_target', eligible: true, reasons: [],
        vault_namespace: 'fixture', output_revision_id: 'out', latest_output_revision_id: 'out' });
      return env({ select: 'output', output, inputs: [], next_cursor: null, inputs_truncated: false, payloads: [], omissions: [], dependency_coverage: 'complete_direct' });
    } };
  const endpoints: string[] = [];
  vi.mocked(connectEngine).mockImplementation(async endpoint => {
    endpoints.push(endpoint);
    if (endpoint === 'http://fixture/mcp') return engine;
    return { close: async () => {}, listTools: async () => ['preview-wiki-refresh', 'refresh-wiki-page', 'wiki-refresh-status'].map(tool),
      call: async () => env({ eligible: false, reasons: [{ code: 'TEST', message: 'Current endpoint preview reached' }],
        model: null, guard: null, sections: [], target_kind: 'home', page_title: null, page_path: null, home_title: null, project_title: null, home_path: null }) };
  });
  const plugin = { wikiCreation: () => ({}), settings: { engineUrl: 'http://fixture/mcp', token: 'test', curatorUrl: 'https://current.example/mcp', curatorToken: 'test' },
    inspectCurrentNote: vi.fn(), app: {} };
  const view = new ProvenanceView({ app: plugin.app } as never, plugin as never); views.push(view);
  await view.setState({ home_refresh: { request_id: '12345678-1234-4234-9234-123456789abc',
    vault_namespace: 'fixture', curator_endpoint: 'https://old.example/mcp' } }, {} as never);
  await act(() => view.onOpen());
  const ui = within(view.contentEl);
  // A restored request doesn't open a dialog at startup; the panel offers its status.
  expect((view as unknown as { modal: unknown }).modal).toBeNull();
  fireEvent.click(await ui.findByRole('button', { name: 'Show status' }));
  await within(dialogEl(view)).findByText(/Cannot read refresh status/);
  // Esc or × closes it like its Close button.
  act(() => (view as unknown as { modal: { close(): void } }).modal.close());
  expect((view as unknown as { modal: unknown }).modal).toBeNull();
  await ui.findByRole('button', { name: 'Show status' });
  await act(() => view.inspectPath('Home.md'));
  fireEvent.click(await ui.findByRole('button', { name: 'Rebuild this page… (paid)' }));
  await within(dialogEl(view)).findByText('Current endpoint preview reached');
  expect(endpoints).toContain('https://current.example/mcp');
  expect(endpoints).not.toContain('https://old.example/mcp');
});
it('drops the whole-wiki rebuild panel and its client when connection settings change', async () => {
  const { within, fireEvent } = await import('@testing-library/react');
  const output = { receipt: { derivation_id: 'd', output_revision_id: 'out', output_node_id: 'home',
    committed_node_version: 1, committed_at: '2026-09-20T00:00:00Z', operation_id: 'op', reconcile_key: 'key', request_digest: 'digest' },
    availability: 'retained', currentness: 'matches' };
  const engine = (): EngineConnection => ({ close: async () => {}, listTools: async () => [tool('inspect-provenance')],
    call: async req => {
      if (req.name === 'get-node') return env({ id: 'home', title: 'Home', file_path: 'Home.md' });
      if (req.arguments?.select === 'status') return env({ ...status, inspection_features: [...status.inspection_features, 'selective_home_refresh_v1'] });
      if (req.arguments?.select === 'node') return env({ select: 'node', outputs: [output], current_provenance: 'captured', next_cursor: null });
      if (req.arguments?.select === 'refresh_target') return env({ select: 'refresh_target', eligible: false, reasons: [], project_title: 'Project',
        vault_namespace: 'fixture', output_revision_id: 'out', latest_output_revision_id: 'out' });
      return env({ select: 'output', output, inputs: [], next_cursor: null, inputs_truncated: false, payloads: [], omissions: [], dependency_coverage: 'complete_direct' });
    } });
  const curators: Array<{ endpoint: string; token: string; close: ReturnType<typeof vi.fn> }> = [];
  vi.mocked(connectEngine).mockImplementation(async (endpoint, token) => {
    if (endpoint === 'http://fixture/mcp') return engine();
    const close = vi.fn(async () => {});
    curators.push({ endpoint, token: token as string, close });
    return { close, listTools: async () => [], call: async () => ({ content: [{ type: 'text' as const, text: JSON.stringify({ project: 'Project', in_progress: null, paused: false,
      models: { planning: 'p', page: 'g', home: 'h' }, latest_run: null, last_written: null, daily_budget: { cap_usd: null, spent_usd: null, remaining_usd: null },
      results: [{ outcome: 'would_curate', detail: null }] }) }] }) };
  });
  const plugin = { wikiCreation: () => ({}), settings: { engineUrl: 'http://fixture/mcp', token: 'test', curatorUrl: 'https://old.example/mcp', curatorToken: 'old-token' },
    inspectCurrentNote: vi.fn(), app: {} };
  const view = new ProvenanceView({ app: plugin.app } as never, plugin as never); views.push(view);
  await act(() => view.onOpen());
  const ui = within(view.contentEl);
  await act(() => view.inspectPath('Home.md'));
  fireEvent.click(await ui.findByRole('button', { name: 'Rebuild the whole wiki… (paid)' }));
  await within(dialogEl(view)).findByText('Rebuild wiki');
  // The rebuild dialog's client, and the wiki lookup's (#545), both on the old endpoint.
  expect(curators.length).toBeGreaterThan(0);
  expect(curators.every(c => c.endpoint === 'https://old.example/mcp')).toBe(true);

  plugin.settings.curatorUrl = 'https://new.example/mcp';
  plugin.settings.curatorToken = 'new-token';
  act(() => view.connectionSettingsChanged());

  expect((view as unknown as { modal: unknown }).modal).toBeNull();
  await waitFor(() => expect(curators.every(c => c.close.mock.calls.length > 0)).toBe(true));
  await act(() => view.inspectPath('Home.md'));
  fireEvent.click(await ui.findByRole('button', { name: 'Rebuild the whole wiki… (paid)' }));
  await within(dialogEl(view)).findByText('Rebuild wiki');
  expect(curators.at(-1)).toMatchObject({ endpoint: 'https://new.example/mcp', token: 'new-token' });
});
it.each([
  { registered: 'root', offered: true },
  { registered: 'another-root', offered: false },
])('finds the topic wiki of a page with no build records through Curator, by its root note (#425): $registered', async ({ registered, offered }) => {
  const { within, fireEvent } = await import('@testing-library/react');
  const page = { id: 'page', title: 'Tidal Power — Risks', file_path: 'Wikis/Tidal Power — Risks.md', types: [], fields: {}, body: '', version: 1,
    relationships: { outgoing: { wiki_for: [{ target_id: 'root', target_title: 'Topics/Tidal Power.md' }] }, incoming: {} } };
  const root = { id: 'root', title: 'Tidal Power', file_path: 'Topics/Tidal Power.md', types: ['topic'], fields: {}, body: '', version: 1,
    relationships: { outgoing: {}, incoming: {} } };
  const engine = (): EngineConnection => ({ close: async () => {}, listTools: async () => [tool('inspect-provenance')],
    call: async req => {
      if (req.name === 'get-node') return env(req.arguments?.node_id === 'root' ? root : page);
      if (req.arguments?.select === 'status') return env(status);
      return env({ select: 'node', outputs: [], current_provenance: 'unknown_legacy', next_cursor: null });
    } });
  const asked: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const close = vi.fn(async () => {});
  vi.mocked(connectEngine).mockImplementation(async endpoint => {
    if (endpoint === 'http://fixture/mcp') return engine();
    return { close, listTools: async () => [], call: async (req: { name: string; arguments?: Record<string, unknown> }) => {
      asked.push({ name: req.name, arguments: req.arguments ?? {} });
      const body = req.name === 'curator-status'
        ? { project: 'Tidal Power', kind: 'topic', root_node_id: registered, source: 'vault+web', in_progress: null, paused: true,
          models: { planning: 'p', page: 'g', home: 'h' }, latest_run: null, last_written: null,
          daily_budget: { cap_usd: null, spent_usd: null, remaining_usd: null } }
        : { mode: 'project', dry_run: true, results: [{ outcome: 'would_curate', detail: null, evidence_unchanged: false }] };
      return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
    } };
  });
  const plugin = { wikiCreation: () => ({}), settings: { engineUrl: 'http://fixture/mcp', token: 'test', curatorUrl: 'https://curator/mcp', curatorToken: 'test' },
    inspectCurrentNote: vi.fn(), app: {} };
  const view = new ProvenanceView({ app: plugin.app } as never, plugin as never); views.push(view);
  await act(() => view.onOpen());
  const ui = within(view.contentEl);
  await act(() => view.inspectPath('Wikis/Tidal Power — Risks.md'));
  await waitFor(() => expect(asked).toContainEqual({ name: 'curator-status', arguments: { project: 'Tidal Power' } }));
  if (!offered) {
    await ui.findByText('No build record');
    expect(ui.queryByRole('button', { name: 'Rebuild the whole wiki… (paid)' })).toBeNull();
    return;
  }
  // The page names no parent page, so it reads as the wiki's home.
  expect((await ui.findByText(/^Home of the wiki for/)).textContent).toMatch(/^Home of the wiki for Tidal Power Topic/);
  expect(view.contentEl.textContent).toContain('Topic wikis rebuild as a whole');
  fireEvent.click(await ui.findByRole('button', { name: 'Rebuild the whole wiki… (paid)' }));
  await within(dialogEl(view)).findByText('Rebuild wiki');
  expect(dialogEl(view).textContent).toContain('only be rebuilt whole');
  expect(asked).toContainEqual({ name: 'curate-project-wiki', arguments: { project: 'Tidal Power', dry_run: true, force: true } });
  await act(() => view.onClose());
  expect(close).toHaveBeenCalled();
});
it('closes a connection that arrives after the view is closed', async () => {
  const pending = defer<EngineConnection>();
  const close = vi.fn(async () => {});
  const view = setup(pending.promise);
  await act(() => view.onOpen());
  await act(() => view.onClose());
  await act(async () =>
    pending.resolve({
      call: async () => env({}),
      listTools: async () => [],
      close,
    }),
  );
  expect(close).toHaveBeenCalledTimes(1);
  expect(view.getState()).toEqual({});
});
it('persists only resume identity and retains it while invalidating the cached Curator client', async () => {
  const view = setup(Promise.resolve({ call: async () => env({}), listTools: async () => [], close: async () => {} }));
  const saved = { request_id: '12345678-1234-4234-9234-123456789abc', vault_namespace: 'vault',
    curator_endpoint: 'https://curator.example/mcp' };
  await view.setState({ home_refresh: { ...saved, token: 'do-not-save', generated_text: 'do-not-save' }, guard: 'do-not-save' }, {} as never);
  const close = vi.fn(async () => {});
  Object.assign(view, { refreshClient: { api: {}, close }, refreshApi: {} });
  view.connectionSettingsChanged();
  expect(close).toHaveBeenCalledTimes(1);
  expect(view.getState()).toEqual({ home_refresh: saved });
  expect((view as any).refreshApi).toBeNull();
  expect((view as any).refreshClient).toBeNull();
});
it('ignores old path resolution after another note is inspected', async () => {
  const pending = defer<Awaited<ReturnType<EngineConnection['call']>>>();
  const conn = {
    close: vi.fn(async () => {}),
    listTools: async () => [],
    call: async (req: Parameters<EngineConnection['call']>[0]) =>
      req.arguments?.file_path === 'A.md'
        ? pending.promise
        : env({ id: 'B', title: 'B', file_path: 'B.md' }),
  };
  const view = setup(Promise.resolve(conn));
  await act(() => view.onOpen());
  let first!: Promise<void>;
  act(() => {
    first = view.inspectPath('A.md');
  });
  await act(() => view.inspectPath('B.md'));
  await act(async () => {
    pending.resolve(env({ id: 'A', title: 'A', file_path: 'A.md' }));
    await first;
  });
  await waitFor(() => expect(view.contentEl.textContent).toContain('B'));
  expect(view.contentEl.querySelector('h2')?.textContent).toBe('B');
  expect(view.getState()).toEqual({});
});
it('requires the impact tool in source mode without attempting an impact read', async () => {
  const calls: string[] = [];
  const conn: EngineConnection = {
    close: vi.fn(async () => {}),
    listTools: async () => [tool('inspect-provenance')],
    call: async (request) => {
      calls.push(request.name);
      if (request.name === 'get-node')
        return env({ id: 'source', title: 'Source', file_path: 'Source.md' });
      throw Error(`Unexpected tool ${request.name}`);
    },
  };
  const view = setup(Promise.resolve(conn));
  await act(() => view.onOpen());
  await act(() => view.inspectPath('Source.md', 'source-impact'));
  await waitFor(() => expect(view.contentEl.querySelector('h2')?.textContent).toBe('Source'));
  expect(calls).toContain('get-node');
  // Without find-affected-outputs the panel has no "Pages built from this note" to open.
  expect(view.contentEl.querySelector('details[aria-label="Pages built from this note"]')).toBeNull();
  expect(calls).not.toContain('find-affected-outputs');
});
it('reads the pages built from a built page only when that section is opened', async () => {
  const calls: string[] = [];
  const summary = { receipt: { derivation_id: 'd', output_revision_id: 'out', output_node_id: 'home',
    committed_node_version: 1, committed_at: '2026-09-20T00:00:00Z', operation_id: 'op', reconcile_key: 'key', request_digest: 'digest' },
    availability: 'retained', currentness: 'matches' };
  const conn: EngineConnection = {
    close: vi.fn(async () => {}),
    listTools: async () => [
      tool('inspect-provenance'),
      tool('find-affected-outputs'),
    ],
    call: async (request) => {
      calls.push(request.name);
      if (request.name === 'get-node')
        return env({ id: 'home', title: 'Home', file_path: 'Home.md' });
      if (request.name === 'find-affected-outputs')
        return env({ as_of: '2026-09-20T12:00:00Z', outputs: [], comparisons: 0,
          next_cursor: null, truncated: false, coverage: 'captured_direct_dependencies_only' });
      if (request.arguments?.select === 'status') return env(status);
      if (request.arguments?.select === 'node')
        return env({ select: 'node', outputs: [summary], current_provenance: 'captured', next_cursor: null });
      return env({ select: 'output', output: summary, inputs: [], next_cursor: null, inputs_truncated: false,
        payloads: [], omissions: [], dependency_coverage: 'complete_direct' });
    },
  };
  const view = setup(Promise.resolve(conn));
  await act(() => view.onOpen());
  await act(() => view.inspectPath('Home.md', 'output'));
  const { within } = await import('@testing-library/react');
  await within(view.contentEl).findByText('Up to date');
  const section = view.contentEl.querySelector('details[aria-label="Pages built from this note"]') as HTMLDetailsElement;
  expect(section.open).toBe(false);
  expect(calls).not.toContain('find-affected-outputs');
  // The command, or the header's button, opens it.
  await act(() => view.inspectPath('Home.md', 'source-impact'));
  await waitFor(() => expect(calls).toContain('find-affected-outputs'));
});
it('shows a note with no build record the pages built from it', async () => {
  const sources: unknown[] = [];
  const conn: EngineConnection = {
    close: vi.fn(async () => {}),
    listTools: async () => [tool('inspect-provenance'), tool('find-affected-outputs')],
    call: async (request) => {
      if (request.name === 'get-node')
        return env({ id: 'meeting', title: 'Meeting', file_path: 'Meeting.md' });
      if (request.name === 'find-affected-outputs') {
        sources.push(...(request.arguments?.sources as unknown[]));
        return env({ as_of: '2026-09-20T12:00:00Z', outputs: [], comparisons: 0,
          next_cursor: null, truncated: false, coverage: 'captured_direct_dependencies_only' });
      }
      if (request.arguments?.select === 'status') return env(status);
      if (request.arguments?.select === 'node')
        return env({ select: 'node', outputs: [], current_provenance: 'unknown_legacy', next_cursor: null });
      throw Error(`Unexpected tool ${request.name}`);
    },
  };
  const view = setup(Promise.resolve(conn));
  await act(() => view.onOpen());
  await act(() => view.inspectPath('Meeting.md', 'output'));
  // On a note that isn't part of a wiki, "Pages built from this note" is open from the start.
  await waitFor(() => expect(sources).toEqual([
    { kind: 'node', namespace: 'fixture', native_id: 'meeting' },
  ]));
  expect(view.contentEl.querySelector('h2')?.textContent).toBe('Meeting');
  expect((view.contentEl.querySelector('details[aria-label="Pages built from this note"]') as HTMLDetailsElement).open).toBe(true);
});
it('ignores a late source-impact page after switching to output mode', async () => {
  const impact = defer<Awaited<ReturnType<EngineConnection['call']>>>();
  let impactCalls = 0;
  const conn: EngineConnection = {
    close: vi.fn(async () => {}),
    listTools: async () => [
      tool('inspect-provenance'),
      tool('find-affected-outputs'),
    ],
    call: async (request) => {
      if (request.name === 'get-node') {
        const path = String(request.arguments?.file_path);
        return env({
          id: path === 'A.md' ? 'A' : 'B',
          title: path === 'A.md' ? 'A' : 'B',
          file_path: path,
        });
      }
      if (request.name === 'find-affected-outputs') {
        impactCalls++;
        return impact.promise;
      }
      if (request.arguments?.select === 'status') return env(status);
      if (request.arguments?.select === 'node')
        return env({
          select: 'node',
          outputs: [],
          current_provenance: 'captured',
          next_cursor: null,
        });
      throw Error(`Unexpected tool ${request.name}`);
    },
  };
  const view = setup(Promise.resolve(conn));
  await act(() => view.onOpen());
  await act(() => view.inspectPath('A.md', 'source-impact'));
  await waitFor(() => expect(impactCalls).toBe(1));
  await act(() => view.inspectPath('B.md', 'output'));
  await waitFor(() =>
    expect(view.contentEl.querySelector('h2')?.textContent).toBe('B'),
  );
  await act(async () =>
    impact.resolve(
      env({
        as_of: '2026-09-20T00:00:00Z',
        outputs: [],
        comparisons: 0,
        next_cursor: null,
        truncated: false,
        coverage: 'captured_direct_dependencies_only',
      }),
    ),
  );
  expect(view.contentEl.querySelector('h2')?.textContent).toBe('B');
  expect(view.contentEl.textContent).not.toContain('Current outputs to review');
});
it('does not open a source after connection settings change during its lookup', async () => {
  const source = defer<Awaited<ReturnType<EngineConnection['call']>>>();
  const openFile = vi.fn(async () => {});
  const { TFile } = await import('obsidian');
  const file = Object.assign(Object.create(TFile.prototype), {
    path: 'Source.md',
    extension: 'md',
  });
  const summary = {
    receipt: {
      derivation_id: 'd',
      output_revision_id: 'out',
      output_node_id: 'home',
      committed_node_version: 1,
      committed_at: '2026-09-19T00:00:00Z',
      operation_id: 'op',
      reconcile_key: 'r',
      request_digest: 'd',
    },
    availability: 'retained',
    currentness: 'matches',
  };
  const conn: EngineConnection = {
    close: vi.fn(async () => {}),
    listTools: async () => [
      {
        name: 'inspect-provenance',
        description: 'Inspect retained provenance',
        inputSchema: { type: 'object' },
      },
    ],
    call: async (req) => {
      const a = req.arguments!;
      if (req.name === 'get-node')
        return a.node_id
          ? source.promise
          : env({ id: 'home', title: 'Home', file_path: 'Home.md' });
      if (a.select === 'status')
        return env({
          select: 'status',
          capability_version: 1,
          inspection_features: ['output_input_comparisons_v1', 'input_text_v1'],
          vault_namespace: 'fixture',
          limits: {},
          actual_bytes: 0,
          reserved_bytes: 0,
          purge_restore_verification: 'unverified',
        });
      if (a.select === 'node')
        return env({
          select: 'node',
          outputs: [summary],
          current_provenance: 'captured',
          next_cursor: null,
        });
      return env({
        select: 'output',
        output: summary,
        inputs: [
          {
            id: 'input',
            source_id: 'source-id',
            source: { kind: 'node', namespace: 'fixture', native_id: 'source' },
            role: 'source_material',
            origin: 'identified',
            truncated: false,
            label: 'Source',
            path: 'Source.md',
            comparison: 'unchanged',
            observed_at: null,
            observation_digest: null,
            selection: null,
            retained_bytes: 1,
          },
        ],
        inputs_truncated: false,
        next_cursor: null,
        payloads: [],
        omissions: [],
        dependency_coverage: 'complete_direct',
      });
    },
  };
  vi.mocked(connectEngine).mockResolvedValue(conn);
  const plugin = { wikiCreation: () => ({}),
    settings: { engineUrl: 'http://fixture/mcp', token: 'test' },
    inspectCurrentNote: vi.fn(),
    app: {
      vault: { getAbstractFileByPath: () => file },
      workspace: { getLeaf: () => ({ openFile }) },
    },
  };
  const view = new ProvenanceView(
    { app: plugin.app } as never,
    plugin as never,
  );
  views.push(view);
  await act(() => view.onOpen());
  await act(() => view.inspectPath('Home.md'));
  const { within, fireEvent } = await import('@testing-library/react');
  const button = await within(view.contentEl).findByRole('button', {
    name: 'Source',
  });
  fireEvent.click(button);
  act(() => view.connectionSettingsChanged());
  await act(async () =>
    source.resolve(env({ id: 'source', file_path: 'Source.md' })),
  );
  expect(openFile).not.toHaveBeenCalled();
  // The panel shows its note again through the new connection, and still opens nothing.
  await waitFor(() => expect(view.contentEl.querySelector('h2')?.textContent).toBe('Home'));
  expect(openFile).not.toHaveBeenCalled();
});

it('does not let a slow output lookup override a newer open action', async () => {
  const slow = defer<Awaited<ReturnType<EngineConnection['call']>>>();
  const opened: string[] = [];
  const { TFile } = await import('obsidian');
  const files = new Map(
    ['Slow.md', 'Fast.md'].map((path) => [
      path,
      Object.assign(Object.create(TFile.prototype), {
        path,
        extension: 'md',
      }),
    ]),
  );
  const impactOutput = (revisionId: string, nodeId: string) => ({
    receipt: {
      derivation_id: `derivation-${revisionId}`,
      output_revision_id: revisionId,
      output_node_id: nodeId,
      committed_node_version: 1,
      committed_at: '2026-09-19T00:00:00Z',
      operation_id: `operation-${revisionId}`,
      reconcile_key: `reconcile-${revisionId}`,
      request_digest: `digest-${revisionId}`,
    },
    currentness: 'matches',
    inputs: [],
    inputs_truncated: false,
    dependency_coverage: 'complete_direct',
  });
  const conn: EngineConnection = {
    close: vi.fn(async () => {}),
    listTools: async () => [
      tool('inspect-provenance'),
      tool('find-affected-outputs'),
    ],
    call: async (request) => {
      if (request.name === 'get-node') {
        if (request.arguments?.node_id === 'slow-node') return slow.promise;
        if (request.arguments?.node_id === 'fast-node')
          return env({ id: 'fast-node', file_path: 'Fast.md' });
        return env({ id: 'source', title: 'Source', file_path: 'Source.md' });
      }
      if (request.name === 'find-affected-outputs')
        return env({
          as_of: '2026-09-20T00:00:00Z',
          outputs: [
            impactOutput('slow-revision', 'slow-node'),
            impactOutput('fast-revision', 'fast-node'),
          ],
          comparisons: 0,
          next_cursor: null,
          truncated: false,
          coverage: 'captured_direct_dependencies_only',
        });
      if (request.name === 'query-nodes')
        return env({
          nodes: [
            { id: 'slow-node', title: 'Slow', file_path: 'Slow.md' },
            { id: 'fast-node', title: 'Fast', file_path: 'Fast.md' },
          ],
          total: 2,
        });
      if (request.arguments?.select === 'status') return env(status);
      throw Error(`Unexpected tool ${request.name}`);
    },
  };
  vi.mocked(connectEngine).mockResolvedValue(conn);
  const plugin = { wikiCreation: () => ({}),
    settings: { engineUrl: 'http://fixture/mcp', token: 'test' },
    inspectCurrentNote: vi.fn(),
    reviewCurrentNoteImpact: vi.fn(),
    app: {
      vault: { getAbstractFileByPath: (path: string) => files.get(path) },
      workspace: {
        getLeaf: () => ({
          openFile: async (file: { path: string }) => opened.push(file.path),
        }),
      },
    },
  };
  const view = new ProvenanceView(
    { app: plugin.app } as never,
    plugin as never,
  );
  views.push(view);
  await act(() => view.onOpen());
  await act(() => view.inspectPath('Source.md', 'source-impact'));
  const { within, fireEvent } = await import('@testing-library/react');
  // Page titles are the open actions.
  fireEvent.click(await within(view.contentEl).findByRole('button', { name: 'Slow' }));
  fireEvent.click(within(view.contentEl).getByRole('button', { name: 'Fast' }));
  await waitFor(() => expect(opened).toEqual(['Fast.md']));

  await act(async () =>
    slow.resolve(env({ id: 'slow-node', file_path: 'Slow.md' })),
  );
  expect(opened).toEqual(['Fast.md']);
});
it.each([
  { registered: 'alpha', offered: true },
  { registered: 'another-project', offered: false },
])('finds the project wiki of a home not built yet through Curator, by its root note (#544): $registered', async ({ registered, offered }) => {
  const { within, fireEvent } = await import('@testing-library/react');
  const home = { id: 'home', title: 'Project Alpha Wiki', file_path: 'Wikis/Project Alpha Wiki.md', types: [], fields: {}, body: '', version: 1,
    relationships: { outgoing: { wiki_for: [{ target_id: 'alpha', target_title: 'Projects/Project Alpha.md' }] }, incoming: {} } };
  const project = { id: 'alpha', title: 'Project Alpha', file_path: 'Projects/Project Alpha.md', types: ['project'], fields: {}, body: '', version: 1,
    relationships: { outgoing: {}, incoming: {} } };
  const engine = (): EngineConnection => ({ close: async () => {}, listTools: async () => [tool('inspect-provenance')],
    call: async req => {
      if (req.name === 'get-node') return env(req.arguments?.node_id === 'alpha' ? project : home);
      if (req.arguments?.select === 'status') return env(status);
      return env({ select: 'node', outputs: [], current_provenance: 'not_recorded', next_cursor: null });
    } });
  const asked: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  vi.mocked(connectEngine).mockImplementation(async endpoint => {
    if (endpoint === 'http://fixture/mcp') return engine();
    return { close: async () => {}, listTools: async () => [], call: async (req: { name: string; arguments?: Record<string, unknown> }) => {
      asked.push({ name: req.name, arguments: req.arguments ?? {} });
      const body = req.name === 'curator-status'
        ? { project: 'Project Alpha', kind: 'project', root_node_id: registered, source: null, in_progress: null, paused: true,
          models: { planning: 'p', page: 'g', home: 'h' }, latest_run: null, last_written: null,
          daily_budget: { cap_usd: null, spent_usd: null, remaining_usd: null } }
        : { mode: 'project', dry_run: true, results: [{ outcome: 'would_curate', detail: null, evidence_unchanged: false }] };
      return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
    } };
  });
  const plugin = { wikiCreation: () => ({}), settings: { engineUrl: 'http://fixture/mcp', token: 'test', curatorUrl: 'https://curator/mcp', curatorToken: 'test' },
    inspectCurrentNote: vi.fn(), app: {} };
  const view = new ProvenanceView({ app: plugin.app } as never, plugin as never); views.push(view);
  await act(() => view.onOpen());
  const ui = within(view.contentEl);
  await act(() => view.inspectPath('Wikis/Project Alpha Wiki.md'));
  await waitFor(() => expect(asked).toContainEqual({ name: 'curator-status', arguments: { project: 'Project Alpha' } }));
  if (!offered) {
    await ui.findByText('No build record');
    expect(ui.queryByRole('button', { name: 'Rebuild the whole wiki… (paid)' })).toBeNull();
    return;
  }
  await ui.findByText('Wiki home');
  expect(view.contentEl.textContent).toContain('The wiki hasn’t been built yet');
  expect((await ui.findByRole('switch', { name: 'Scheduled builds' })).getAttribute('aria-checked')).toBe('false');
  fireEvent.click(ui.getByRole('button', { name: 'Rebuild the whole wiki… (paid)' }));
  await within(dialogEl(view)).findByText('Rebuild wiki');
  expect(dialogEl(view).textContent).toContain('This rebuild still runs, and scheduled builds stay off afterwards.');
  expect(dialogEl(view).textContent).not.toContain('only be rebuilt whole');
  expect(asked).toContainEqual({ name: 'curate-project-wiki', arguments: { project: 'Project Alpha', dry_run: true, force: true } });
  expect(asked.some(c => c.name === 'curate-project-wiki' && c.arguments.dry_run !== true)).toBe(false);
});
it('pauses the wiki from its card through Curator, and offers the create commands on a plain note (#545)', async () => {
  const { within, fireEvent } = await import('@testing-library/react');
  const node = (id: string, title: string, wikiFor?: string, fields: Record<string, unknown> = {}) => ({ id, title, file_path: `${title}.md`,
    types: [], fields, body: '', version: 1,
    relationships: { outgoing: wikiFor ? { wiki_for: [{ target_id: wikiFor, target_title: wikiFor }] } : {}, incoming: {} } });
  const nodes = [node('home', 'Project Alpha Wiki', 'alpha', { wiki_status: { value: 'current', type: 'text', source: 'frontmatter' } }),
    node('alpha', 'Project Alpha'), node('note', 'Kickoff')];
  const engine = (): EngineConnection => ({ close: async () => {}, listTools: async () => [tool('inspect-provenance')],
    call: async req => {
      if (req.name === 'get-node') {
        const found = nodes.find(n => n.id === req.arguments?.node_id || n.file_path === req.arguments?.file_path || n.title === req.arguments?.title);
        return found ? env(found) : { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: '' }, warnings: [] }) }] };
      }
      if (req.arguments?.select === 'status') return env(status);
      return env({ select: 'node', outputs: [], current_provenance: 'not_recorded', next_cursor: null });
    } });
  const asked: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let paused = false;
  vi.mocked(connectEngine).mockImplementation(async endpoint => {
    if (endpoint === 'http://fixture/mcp') return engine();
    return { close: async () => {}, listTools: async () => [], call: async (req: { name: string; arguments?: Record<string, unknown> }) => {
      asked.push({ name: req.name, arguments: req.arguments ?? {} });
      if (req.name === 'set-wiki-paused') {
        paused = req.arguments!.paused as boolean;
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, project: 'Project Alpha', paused, corrections: [] }) }] };
      }
      const registered = req.arguments?.project === 'Project Alpha';
      return { content: [{ type: 'text' as const, text: JSON.stringify({ project: req.arguments?.project, kind: registered ? 'project' : null,
        root_node_id: registered ? 'alpha' : null, source: null, in_progress: null, paused, models: { planning: 'p', page: 'g', home: 'h' },
        latest_run: null, last_written: null, daily_budget: { cap_usd: null, spent_usd: null, remaining_usd: null } }) }] };
    } };
  });
  const project = vi.fn(), topic = vi.fn();
  const plugin = { wikiCreation: vi.fn((path: string | null) => (path === 'Kickoff.md' ? { project, topic } : {})),
    settings: { engineUrl: 'http://fixture/mcp', token: 'test', curatorUrl: 'https://curator/mcp', curatorToken: 'test' },
    inspectCurrentNote: vi.fn(), reviewCurrentNoteImpact: vi.fn(), app: {} };
  const view = new ProvenanceView({ app: plugin.app } as never, plugin as never); views.push(view);
  expect(view.getDisplayText()).toBe('Wiki');
  await act(() => view.onOpen());
  const ui = within(view.contentEl);
  await act(() => view.inspectPath('Project Alpha Wiki.md'));
  await ui.findByText('Wiki home');
  const toggle = await ui.findByRole('switch', { name: 'Scheduled builds' });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  expect(asked).toContainEqual({ name: 'set-wiki-paused', arguments: { project: 'Project Alpha', paused: true } });

  await act(() => view.inspectPath('Kickoff.md'));
  await ui.findByText('Not part of a wiki');
  fireEvent.click(ui.getByRole('button', { name: 'Create project wiki…' }));
  fireEvent.click(ui.getByRole('button', { name: 'Create topic wiki…' }));
  expect(project).toHaveBeenCalledTimes(1);
  expect(topic).toHaveBeenCalledTimes(1);
});

it('follows the active note unless pinned, and catches up when unpinned (#545)', async () => {
  const { within, fireEvent } = await import('@testing-library/react');
  let active: string | null = 'A.md';
  const conn: EngineConnection = {
    close: vi.fn(async () => {}),
    listTools: async () => [],
    call: async (req) => {
      const path = String(req.arguments?.file_path);
      return env({ id: path, title: path.replace('.md', ''), file_path: path });
    },
  };
  vi.mocked(connectEngine).mockResolvedValue(conn);
  const plugin = { wikiCreation: () => ({}), settings: { engineUrl: 'http://fixture/mcp', token: 'test' },
    activeNotePath: () => active, app: {} };
  const view = new ProvenanceView({ app: plugin.app } as never, plugin as never); views.push(view);
  // Opening the panel shows the note being edited.
  await act(() => view.onOpen());
  await waitFor(() => expect(view.contentEl.querySelector('h2')?.textContent).toBe('A'));
  active = 'B.md';
  await act(async () => view.follow('B.md'));
  await waitFor(() => expect(view.contentEl.querySelector('h2')?.textContent).toBe('B'));
  const ui = within(view.contentEl);
  fireEvent.click(ui.getByRole('button', { name: 'Pin to this note' }));
  expect(ui.getByRole('button', { name: 'Pinned to this note' }).getAttribute('aria-pressed')).toBe('true');
  active = 'C.md';
  await act(async () => view.follow('C.md'));
  expect(view.contentEl.querySelector('h2')?.textContent).toBe('B');
  // Unpinning moves it to the note that is active now.
  fireEvent.click(ui.getByRole('button', { name: 'Pinned to this note' }));
  await waitFor(() => expect(view.contentEl.querySelector('h2')?.textContent).toBe('C'));
});

it('does not follow a note the panel opens itself (#545)', async () => {
  const { within, fireEvent } = await import('@testing-library/react');
  const { TFile } = await import('obsidian');
  const summary = { receipt: { derivation_id: 'd', output_revision_id: 'out', output_node_id: 'home',
    committed_node_version: 1, committed_at: '2026-09-19T00:00:00Z', operation_id: 'op', reconcile_key: 'r', request_digest: 'd' },
    availability: 'retained', currentness: 'matches' };
  const input = { id: 'input', source_id: 'source-id', source: { kind: 'node', namespace: 'fixture', native_id: 'source' },
    role: 'source_material', origin: 'identified', truncated: false, label: 'Source', path: 'Source.md', comparison: 'unchanged',
    observed_at: null, observation_digest: null, selection: null, retained_bytes: 1 };
  const conn: EngineConnection = {
    close: vi.fn(async () => {}),
    listTools: async () => [tool('inspect-provenance')],
    call: async (req) => {
      const a = req.arguments!;
      if (req.name === 'get-node')
        return a.node_id ? env({ id: 'source', file_path: 'Source.md' }) : env({ id: 'home', title: 'Home', file_path: 'Home.md' });
      if (a.select === 'status') return env(status);
      if (a.select === 'node') return env({ select: 'node', outputs: [summary], current_provenance: 'captured', next_cursor: null });
      return env({ select: 'output', output: summary, inputs: [input], inputs_truncated: false, next_cursor: null,
        payloads: [], omissions: [], dependency_coverage: 'complete_direct' });
    },
  };
  vi.mocked(connectEngine).mockResolvedValue(conn);
  let view!: ProvenanceView;
  let active = 'Home.md';
  const file = Object.assign(Object.create(TFile.prototype), { path: 'Source.md', extension: 'md' });
  const plugin = { wikiCreation: () => ({}), settings: { engineUrl: 'http://fixture/mcp', token: 'test' },
    activeNotePath: () => active,
    app: { vault: { getAbstractFileByPath: () => file },
      // Opening a file fires the workspace's file-open, which the plugin passes on as follow().
      workspace: { getLeaf: () => ({ openFile: async (f: { path: string }) => { active = f.path; view.follow(f.path); } }) } } };
  view = new ProvenanceView({ app: plugin.app } as never, plugin as never); views.push(view);
  await act(() => view.onOpen());
  const ui = within(view.contentEl);
  fireEvent.click(await ui.findByRole('button', { name: 'Source' }));
  await waitFor(() => expect(active).toBe('Source.md'));
  await act(async () => view.follow('Source.md'));
  expect(view.contentEl.querySelector('h2')?.textContent).toBe('Home');
});

it('shows a page\'s build from "Pages built from this note", then goes back (#545)', async () => {
  const { within, fireEvent } = await import('@testing-library/react');
  const impact = { receipt: { derivation_id: 'd', output_revision_id: 'page-revision', output_node_id: 'page',
    committed_node_version: 1, committed_at: '2026-09-19T00:00:00Z', operation_id: 'op', reconcile_key: 'r', request_digest: 'd' },
    currentness: 'matches', inputs: [{ input_id: 'in-1', comparison: 'changed', role: 'source_material', reason: 'digest differs' }],
    inputs_truncated: false, dependency_coverage: 'complete_direct' };
  const seen: Array<Record<string, unknown>> = [];
  const conn: EngineConnection = {
    close: vi.fn(async () => {}),
    listTools: async () => [tool('inspect-provenance'), tool('find-affected-outputs')],
    call: async (req) => {
      seen.push({ name: req.name, ...req.arguments });
      if (req.name === 'get-node') return env({ id: 'note', title: 'Kickoff', file_path: 'Kickoff.md' });
      if (req.name === 'find-affected-outputs')
        return env({ as_of: '2026-09-20T00:00:00Z', outputs: [impact], comparisons: 1, next_cursor: null, truncated: false,
          coverage: 'captured_direct_dependencies_only' });
      if (req.name === 'query-nodes') return env({ nodes: [{ id: 'page', title: 'Decisions', file_path: 'Decisions.md' }], total: 1 });
      if (req.arguments?.select === 'status') return env(status);
      return env({ select: 'node', outputs: [], current_provenance: 'unknown_legacy', next_cursor: null });
    },
  };
  const view = setup(Promise.resolve(conn));
  await act(() => view.onOpen());
  await act(() => view.inspectPath('Kickoff.md'));
  const ui = within(view.contentEl);
  expect(await ui.findByText('1 wiki page is behind on this note')).toBeTruthy();
  fireEvent.click(ui.getByRole('button', { name: 'See what it was built from' }));
  await waitFor(() => expect(view.contentEl.querySelector('h2')?.textContent).toBe('Decisions'));
  // It reads that page's build, in the vault the list came from.
  await waitFor(() => expect(seen).toContainEqual(expect.objectContaining({ name: 'inspect-provenance', select: 'node', node_id: 'page' })));
  fireEvent.click(ui.getByRole('button', { name: 'Back to Kickoff' }));
  await waitFor(() => expect(view.contentEl.querySelector('h2')?.textContent).toBe('Kickoff'));
  expect(ui.queryByRole('button', { name: /^Back to/ })).toBeNull();
  expect((view.contentEl.querySelector('details[aria-label="Pages built from this note"]') as HTMLDetailsElement).open).toBe(true);
});

it('shows the note again after a connection change: the active one, or the pinned one (#545)', async () => {
  const { within, fireEvent } = await import('@testing-library/react');
  let active: string | null = 'A.md';
  const conn = (): EngineConnection => ({
    close: vi.fn(async () => {}),
    listTools: async () => [],
    call: async (req) => {
      const path = String(req.arguments?.file_path);
      return env({ id: path, title: path.replace('.md', ''), file_path: path });
    },
  });
  vi.mocked(connectEngine).mockImplementation(async () => conn());
  const plugin = { wikiCreation: () => ({}), settings: { engineUrl: 'http://fixture/mcp', token: 'test' },
    activeNotePath: () => active, app: {} };
  const view = new ProvenanceView({ app: plugin.app } as never, plugin as never); views.push(view);
  await act(() => view.onOpen());
  await waitFor(() => expect(view.contentEl.querySelector('h2')?.textContent).toBe('A'));
  act(() => view.connectionSettingsChanged());
  await waitFor(() => expect(view.contentEl.querySelector('h2')?.textContent).toBe('A'));
  // Pinned, it comes back to the pinned note, not the active one.
  fireEvent.click(within(view.contentEl).getByRole('button', { name: 'Pin to this note' }));
  active = 'B.md';
  act(() => view.connectionSettingsChanged());
  await waitFor(() => expect(view.contentEl.querySelector('h2')?.textContent).toBe('A'));
  expect(within(view.contentEl).getByRole('button', { name: 'Pinned to this note' })).toBeTruthy();
});

it('shows the active note once Engine is reachable after a failed first connection (#545)', async () => {
  const { within, fireEvent } = await import('@testing-library/react');
  let reachable = false;
  vi.mocked(connectEngine).mockImplementation(async () => {
    if (!reachable) throw Error('offline');
    return { close: vi.fn(async () => {}), listTools: async () => [],
      call: async () => env({ id: 'A', title: 'A', file_path: 'A.md' }) };
  });
  const plugin = { wikiCreation: () => ({}), settings: { engineUrl: 'http://fixture/mcp', token: 'test' },
    activeNotePath: () => 'A.md', app: {} };
  const view = new ProvenanceView({ app: plugin.app } as never, plugin as never); views.push(view);
  await act(() => view.onOpen());
  const ui = within(view.contentEl);
  const retry = await ui.findByRole('button', { name: 'Try again' });
  reachable = true;
  fireEvent.click(retry);
  await waitFor(() => expect(view.contentEl.querySelector('h2')?.textContent).toBe('A'));
  // Focusing the same note again is not needed, and doesn't inspect it twice.
  await act(async () => view.follow('A.md'));
  expect(view.contentEl.querySelector('h2')?.textContent).toBe('A');
});

it('keeps a pinned panel on its note when it opens a source, across a reconnect and until unpinned (#545)', async () => {
  const { within, fireEvent } = await import('@testing-library/react');
  const { TFile } = await import('obsidian');
  const summary = { receipt: { derivation_id: 'd', output_revision_id: 'out', output_node_id: 'home',
    committed_node_version: 1, committed_at: '2026-09-19T00:00:00Z', operation_id: 'op', reconcile_key: 'r', request_digest: 'd' },
    availability: 'retained', currentness: 'matches' };
  const input = { id: 'input', source_id: 'source-id', source: { kind: 'node', namespace: 'fixture', native_id: 'source' },
    role: 'source_material', origin: 'identified', truncated: false, label: 'Source', path: 'Source.md', comparison: 'unchanged',
    observed_at: null, observation_digest: null, selection: null, retained_bytes: 1 };
  const byPath: Record<string, { id: string; title: string; file_path: string }> = {
    'Home.md': { id: 'home', title: 'Home', file_path: 'Home.md' },
    'Source.md': { id: 'source', title: 'Source', file_path: 'Source.md' },
  };
  const conn = (): EngineConnection => ({
    close: vi.fn(async () => {}),
    listTools: async () => [tool('inspect-provenance')],
    call: async (req) => {
      const a = req.arguments!;
      if (req.name === 'get-node') return env(a.node_id === 'source' ? byPath['Source.md'] : byPath[String(a.file_path)]);
      if (a.select === 'status') return env(status);
      if (a.select === 'node') return env({ select: 'node', outputs: a.node_id === 'home' ? [summary] : [], current_provenance: 'captured', next_cursor: null });
      return env({ select: 'output', output: summary, inputs: [input], inputs_truncated: false, next_cursor: null,
        payloads: [], omissions: [], dependency_coverage: 'complete_direct' });
    },
  });
  vi.mocked(connectEngine).mockImplementation(async () => conn());
  let view!: ProvenanceView;
  let active = 'Home.md';
  const file = Object.assign(Object.create(TFile.prototype), { path: 'Source.md', extension: 'md' });
  const plugin = { wikiCreation: () => ({}), settings: { engineUrl: 'http://fixture/mcp', token: 'test' },
    activeNotePath: () => active,
    app: { vault: { getAbstractFileByPath: () => file },
      workspace: { getLeaf: () => ({ openFile: async (f: { path: string }) => { active = f.path; view.follow(f.path); } }) } } };
  view = new ProvenanceView({ app: plugin.app } as never, plugin as never); views.push(view);
  await act(() => view.onOpen());
  const ui = within(view.contentEl);
  fireEvent.click(await ui.findByRole('button', { name: 'Pin to this note' }));
  fireEvent.click(await ui.findByRole('button', { name: 'Source' }));
  await waitFor(() => expect(active).toBe('Source.md'));
  expect(view.contentEl.querySelector('h2')?.textContent).toBe('Home');
  // A reconnect brings back the pinned note, not the source the editor shows.
  act(() => view.connectionSettingsChanged());
  await waitFor(() => expect(view.contentEl.querySelector('h2')?.textContent).toBe('Home'));
  // Unpinning catches up with the editor's note.
  fireEvent.click(ui.getByRole('button', { name: 'Pinned to this note' }));
  await waitFor(() => expect(view.contentEl.querySelector('h2')?.textContent).toBe('Source'));
});
it('builds a person\'s dossier from the panel, in the rebuild dialog, and reads the note again once it closes (#554)', async () => {
  const { within, fireEvent } = await import('@testing-library/react');
  // Fictional people only (repository rule).
  const jordan = { id: 'jordan', title: 'Jordan Ellis', file_path: 'People/Jordan Ellis.md', types: ['person'], fields: {}, body: '', version: 1,
    relationships: { outgoing: {}, incoming: {} } };
  const engineCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const engine = (): EngineConnection => ({ close: async () => {}, listTools: async () => [tool('inspect-provenance')],
    call: async req => {
      engineCalls.push({ name: req.name, arguments: req.arguments ?? {} });
      if (req.name === 'get-node') return env(jordan);
      if (req.arguments?.select === 'status') return env(status);
      return env({ select: 'node', outputs: [], current_provenance: 'unknown_legacy', next_cursor: null });
    } });
  const asked: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  vi.mocked(connectEngine).mockImplementation(async endpoint => {
    if (endpoint === 'http://fixture/mcp') return engine();
    return { close: async () => {}, listTools: async () => [], call: async (req: { name: string; arguments?: Record<string, unknown> }) => {
      asked.push({ name: req.name, arguments: req.arguments ?? {} });
      const body = req.name === 'curator-status'
        ? { project: req.arguments?.project, kind: null, root_node_id: null, source: null, in_progress: null, paused: false,
          models: { planning: 'p', page: 'g', home: 'h' }, latest_run: null, last_written: null, queue: { running: false, depth: 0 },
          daily_budget: { cap_usd: 2, spent_usd: 0, remaining_usd: 2 } }
        : req.arguments?.dry_run
          ? { ok: true, dry_run: true, subject: { node_id: 'jordan', title: 'Jordan Ellis', kind: 'person' },
            page: { title: 'Jordan Ellis Dossier', path: 'Jordan Ellis Dossier.md', node_id: null, action: 'create' },
            reads: { memories: { about: 9, shown: 9, past: 0, left_out: 0, rules: 0 }, notes: 2, meetings: 1, read_in_full: 2 },
            sections: { names: ['Who', 'History'] }, rebuild: { current: 'manual' }, model: { ref: 'home-model' },
            cost: { priced: true, estimated_usd: 0.01, worst_case_usd: 0.03, calls: 1 },
            daily_budget: { cap_usd: 2, remaining_usd: 2, fits: true, refusal: null } }
          : { ok: true, dry_run: false, status: 'queued', page: { title: 'Jordan Ellis Dossier' } };
      return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
    } };
  });
  const plugin = { wikiCreation: () => ({}), settings: { engineUrl: 'http://fixture/mcp', token: 'test', curatorUrl: 'https://curator/mcp', curatorToken: 'test' },
    dossierKind: (types: readonly string[]) => types.includes('person') ? { kind: 'person', label: 'Person' } : null,
    openNoteTitled: vi.fn(), app: {} };
  const view = new ProvenanceView({ app: plugin.app } as never, plugin as never); views.push(view);
  await act(() => view.onOpen());
  const ui = within(view.contentEl);
  await act(() => view.inspectPath('People/Jordan Ellis.md'));
  expect(await ui.findByText('No dossier yet')).toBeTruthy();
  fireEvent.click(ui.getByRole('button', { name: 'Build dossier…' }));
  const dialog = within(dialogEl(view));
  await dialog.findByText('Build a dossier for Jordan Ellis?');
  // The panel names the note by its id: no second lookup by path.
  expect(asked).toContainEqual({ name: 'build-dossier', arguments: { node_id: 'jordan', dry_run: true } });
  expect(dialogEl(view).textContent).toContain('Who and History');
  const reads = engineCalls.filter(c => c.name === 'get-node').length;
  fireEvent.click(await dialog.findByRole('button', { name: 'Build dossier' }));
  await dialog.findByText(/^Queued\. It usually takes/);
  expect(asked).toContainEqual({ name: 'build-dossier', arguments: { node_id: 'jordan', dry_run: false } });
  fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
  expect((view as unknown as { modal: unknown }).modal).toBeNull();
  // The build may have written the page: the panel reads the note and its dossier again.
  await waitFor(() => expect(engineCalls.filter(c => c.name === 'get-node').length).toBeGreaterThan(reads));
});
