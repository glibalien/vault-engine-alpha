import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import {
  connectEngine,
  type HttpPost,
  type HttpResponse,
} from '../../src/engine/transport.js';
import { ProvenanceView } from '../../src/provenance/provenance-view.js';

vi.mock('../../src/engine/transport.js', async (original) => ({
  ...(await original<typeof import('../../src/engine/transport.js')>()),
  connectEngine: vi.fn(),
}));
const actual = await vi.importActual<
  typeof import('../../src/engine/transport.js')
>('../../src/engine/transport.js');
const views: ProvenanceView[] = [];
afterEach(async () => {
  for (const view of views.splice(0)) await act(() => view.onClose());
  vi.resetAllMocks();
});
const envelope = (data: unknown) => ({
  content: [
    { type: 'text', text: JSON.stringify({ ok: true, data, warnings: [] }) },
  ],
});
const output = {
  receipt: {
    output_revision_id: 'out',
    output_node_id: 'home',
    committed_at: '2026-09-19T00:00:00Z',
    derivation_id: 'd',
    committed_node_version: 1,
    operation_id: 'op',
    reconcile_key: 'r',
    request_digest: 'digest',
  },
  availability: 'retained',
  currentness: 'matches',
};
async function setup() {
  let failure: 'none' | 'http' | 'network' | 'tool' | 'rpc' = 'none';
  let initializes = 0;
  let held: Promise<HttpResponse> | null = null;
  const sessions: string[] = [];
  const post: HttpPost = async (req) => {
    const response = (result: unknown, id?: number) => ({
      status: 200,
      headers: {},
      text: JSON.stringify({ jsonrpc: '2.0', id, result }),
    });
    if (req.method === 'DELETE') return response({});
    const msg = JSON.parse(req.body);
    if (msg.method === 'initialize')
      return {
        ...response({}, msg.id),
        headers: { 'mcp-session-id': `session-${++initializes}` },
      };
    if (msg.method === 'notifications/initialized') return response({});
    if (msg.method === 'tools/list')
      return response(
        {
          tools: [
            { name: 'inspect-provenance', inputSchema: { type: 'object' } },
          ],
        },
        msg.id,
      );
    sessions.push(req.headers['mcp-session-id']);
    if (held) {
      const pending = held;
      held = null;
      return pending;
    }
    if (failure === 'http')
      return {
        status: 404,
        headers: {},
        text: '{"error":"Session not found"}',
      };
    if (failure === 'network') throw Error('Connection refused');
    if (failure === 'rpc')
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: 'Tool execution failed' },
        }),
      };
    if (failure === 'tool')
      return response(
        {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: {
                  code: 'VALIDATION_FAILED',
                  message: 'Inspection unavailable',
                },
                warnings: [],
              }),
            },
          ],
        },
        msg.id,
      );
    const a = msg.params.arguments;
    let data: unknown;
    if (msg.params.name === 'get-node')
      data = { id: 'home', title: 'Home', file_path: 'Home.md' };
    else if (a.select === 'status')
      data = {
        select: 'status',
        capability_version: 1,
        vault_namespace: 'fixture',
        inspection_features: ['output_input_comparisons_v1', 'input_text_v1'],
        limits: {},
        actual_bytes: 0,
        reserved_bytes: 0,
        purge_restore_verification: 'unverified',
      };
    else if (a.select === 'node')
      data = {
        select: 'node',
        outputs: [output],
        current_provenance: 'captured',
        next_cursor: null,
      };
    else if (a.select === 'output')
      data = {
        select: 'output',
        output,
        inputs: [
          {
            id: 'input',
            source_id: 's',
            source: { kind: 'node', namespace: 'fixture', native_id: 'source' },
            role: 'source_material',
            selection: 'formatted-node-body-prefix:v1',
            origin: 'identified',
            truncated: false,
            retained_bytes: 8,
            observation_digest: 'digest',
            observed_at: null,
            label: 'Source',
            path: 'Source.md',
            comparison: 'unchanged',
          },
        ],
        compared_at: '2026-09-19T00:00:00Z',
        inputs_truncated: false,
        next_cursor: null,
        payloads: [],
        omissions: [],
        dependency_coverage: 'complete_direct',
      };
    else
      data = {
        select: 'input_text',
        output_revision_id: 'out',
        input_id: 'input',
        availability: 'retained',
        input_digest: 'digest',
        segments: [
          {
            span_index: 0,
            field: 'evidence',
            span_start: 0,
            span_end: 8,
            start: 0,
            end: 8,
            text: 'retained',
          },
        ],
        next_cursor: 'next',
      };
    return response(envelope(data), msg.id);
  };
  vi.mocked(connectEngine).mockImplementation((url, token) =>
    actual.connectEngine(url, token, post),
  );
  const plugin = { wikiCreation: () => ({}),
    settings: { engineUrl: 'http://fixture/mcp', token: 'test' },
    app: {},
    inspectCurrentNote: vi.fn(),
  };
  const view = new ProvenanceView(
    { app: plugin.app } as never,
    plugin as never,
  );
  views.push(view);
  await act(() => view.onOpen());
  await act(() => view.inspectPath('Home.md'));
  const ui = within(view.contentEl);
  await ui.findByRole('button', { name: 'Show captured text' });
  return {
    view,
    ui,
    sessions,
    count: () => initializes,
    fail: (kind: typeof failure) => {
      failure = kind;
    },
    hold: (pending: Promise<HttpResponse>) => {
      held = pending;
    },
  };
}
it.each(['http', 'network'] as const)(
  'recovers from %s failure through a new session and clears retained text',
  async (kind) => {
    const { view, ui, sessions, count, fail } = await setup();
    fireEvent.click(ui.getByRole('button', { name: 'Show captured text' }));
    await ui.findByText('retained');
    fail(kind);
    // Navigation does not itself clear retained text: disconnect handling must.
    fireEvent.click(ui.getByRole('button', { name: 'Source' }));
    const retry = await ui.findByRole('button', { name: 'Try again' });
    expect(ui.queryByText('retained')).toBeNull();
    expect(count()).toBe(1); // No automatic replay or reconnect loop.
    fail('none');
    fireEvent.click(retry);
    // Reconnected, the panel shows its note again by itself.
    await ui.findByRole('heading', { name: 'Home' });
    await act(() => view.inspectPath('Home.md'));
    await ui.findByRole('button', { name: 'Show captured text' });
    expect(count()).toBe(2);
    expect(sessions.at(-1)).toBe('session-2');
  },
);
it('can inspect again after a note lookup discovers an expired session', async () => {
  const { view, ui, count, fail } = await setup();
  fail('http');
  await act(() => view.inspectPath('Home.md'));
  await ui.findByRole('button', { name: 'Try again' });
  fail('none');
  await act(() => view.inspectPath('Home.md'));
  await ui.findByRole('button', { name: 'Show captured text' });
  expect(count()).toBe(2);
});
it('ignores a late transport failure from a replaced connection', async () => {
  const { view, ui, count, hold } = await setup();
  let reject!: (reason: Error) => void;
  hold(
    new Promise<HttpResponse>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    }),
  );
  fireEvent.click(ui.getByRole('button', { name: 'Source' }));
  act(() => view.connectionSettingsChanged());
  // Reconnected, the panel shows its note again by itself.
    await ui.findByRole('heading', { name: 'Home' });
  await act(() => view.inspectPath('Home.md'));
  await ui.findByRole('button', { name: 'Show captured text' });
  await act(async () => reject(Error('Old request failed')));
  expect(ui.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(ui.getByRole('heading', { name: 'Home' })).toBeTruthy();
  expect(count()).toBe(2);
});
it.each(['tool', 'rpc'] as const)(
  'keeps a healthy connection after a %s error',
  async (kind) => {
    const { ui, count, fail } = await setup();
    fail(kind);
    fireEvent.click(ui.getByRole('button', { name: 'Check again' }));
    await ui.findByRole('alert');
    expect(ui.queryByRole('button', { name: 'Try again' })).toBeNull();
    fail('none');
    fireEvent.click(ui.getByRole('button', { name: 'Check again' }));
    await ui.findByRole('button', { name: 'Show captured text' });
    await waitFor(() => expect(count()).toBe(1));
  },
);
