// @vitest-environment jsdom
/**
 * The List view's checkbox in a whole card (#488): the card reads its type's schema (already
 * fetched for the card) and shows the checkbox only when Engine takes the tick and untick values.
 * With the default map and a status enum like today's installation's, the checkbox is today's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VizCard } from '../src/VizCard.js';
import { VizClientProvider } from '../src/viz-client-context.js';
import { _resetCachesForTest } from '../src/use-viz-schema.js';
import { DEFAULT_VIEW_VOCABULARY, type ViewVocabulary } from '../src/view-vocabulary.js';
import type { VizSpec } from '../src/viz-spec.js';

beforeEach(() => _resetCachesForTest());
afterEach(() => cleanup());

const LIST: VizSpec = { kind: 'list', title: '', query: { types: ['task'] }, display_fields: ['status', 'due'] };

const env = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data, warnings: [] }) }] });

function makeCall(statusField: { type: string; enum_values?: string[] }, status: string) {
  return vi.fn(async (req: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult> => {
    switch (req.name) {
      case 'query-nodes':
        return env({ nodes: [{ id: 'n1', title: 'Alpha', file_path: 'Alpha.md', types: ['task'], version: 3, fields: { status, due: '2026-12-01' } }], total: 1 });
      case 'describe-schema':
        if (req.arguments?.name === 'chore') return env({ name: 'chore', display_name: 'Chore', fields: [
          { name: 'status', type: 'enum', enum_values: ['open', 'done'], required: false, default_value: null, ui: null },
        ] });
        return env({ name: 'task', display_name: 'Task', fields: [
          { name: 'status', required: false, default_value: null, ui: null, ...statusField },
          { name: 'due', type: 'date', required: false, default_value: null, ui: null },
        ] });
      case 'list-schemas':
        return env([{ name: 'task', node_count: 1, has_schema: true }]);
      case 'update-node':
        return env({ node_id: 'n1', version: 4 });
      default:
        return env({});
    }
  });
}

async function renderList(call: ReturnType<typeof makeCall>, vocabulary?: ViewVocabulary) {
  await act(async () => {
    render(<VizClientProvider call={call} vocabulary={vocabulary}><VizCard spec={LIST} onSpecChange={vi.fn()} /></VizClientProvider>);
  });
  await waitFor(() => expect(document.querySelector('.vtask')).not.toBeNull());
  await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({ name: 'describe-schema', arguments: { name: 'task' } })));
  // Let the schema read land.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('the List checkbox in a card', () => {
  it('with the default map and a status enum like today\'s: the checkbox, ticking writes done', async () => {
    const call = makeCall({ type: 'enum', enum_values: ['open', 'in-progress', 'pending', 'done', 'dropped', 'backlog', 'next'] }, 'open');
    await renderList(call, DEFAULT_VIEW_VOCABULARY);
    expect(document.querySelector('.spill')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'toggle Alpha' })); });
    await waitFor(() => expect(call).toHaveBeenCalledWith({ name: 'update-node', arguments: { node_id: 'n1', set_fields: { status: 'done' }, expected_version: 3 } }));
    expect(document.querySelector('.viz-stale')).toBeNull();
  });

  it('with no vocabulary passed (an older host) and a status that is plain text: the checkbox, unticking writes open', async () => {
    const call = makeCall({ type: 'string' }, 'done');
    await renderList(call);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'toggle Alpha' })); });
    await waitFor(() => expect(call).toHaveBeenCalledWith({ name: 'update-node', arguments: { node_id: 'n1', set_fields: { status: 'open' }, expected_version: 3 } }));
  });

  it('shows the status, with no checkbox, when the field\'s enum does not take the untick value', async () => {
    const call = makeCall({ type: 'enum', enum_values: ['todo', 'done'] }, 'todo');
    await renderList(call, DEFAULT_VIEW_VOCABULARY);
    await waitFor(() => expect(document.querySelector('.cbox')).toBeNull());
    expect(document.querySelector('.vtask .spill')?.textContent).toBe('todo');
    expect(call).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'update-node' }));
    expect(document.querySelector('.viz-stale')).toBeNull();
  });

  it('applies only the current type\'s enum: unlocking the view, or locking another type, lets the checkbox back', async () => {
    const call = makeCall({ type: 'enum', enum_values: ['todo', 'done'] }, 'todo');
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<VizClientProvider call={call} vocabulary={DEFAULT_VIEW_VOCABULARY}><VizCard spec={LIST} onSpecChange={vi.fn()} /></VizClientProvider>);
    });
    await waitFor(() => expect(document.querySelector('.vtask .spill')?.textContent).toBe('todo'));
    expect(document.querySelector('.cbox')).toBeNull();

    // The type filter cleared: the task type's enum no longer applies.
    await act(async () => {
      view.rerender(<VizClientProvider call={call} vocabulary={DEFAULT_VIEW_VOCABULARY}><VizCard spec={{ ...LIST, query: {} }} onSpecChange={vi.fn()} /></VizClientProvider>);
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'toggle Alpha' })).toBeTruthy());
    expect(document.querySelector('.spill')).toBeNull();

    // Back to the task type, then another type whose enum takes both values.
    await act(async () => {
      view.rerender(<VizClientProvider call={call} vocabulary={DEFAULT_VIEW_VOCABULARY}><VizCard spec={LIST} onSpecChange={vi.fn()} /></VizClientProvider>);
    });
    await waitFor(() => expect(document.querySelector('.cbox')).toBeNull());
    await act(async () => {
      view.rerender(<VizClientProvider call={call} vocabulary={DEFAULT_VIEW_VOCABULARY}><VizCard spec={{ ...LIST, query: { types: ['chore'] } }} onSpecChange={vi.fn()} /></VizClientProvider>);
    });
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({ name: 'describe-schema', arguments: { name: 'chore' } })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'toggle Alpha' })).toBeTruthy());
  });

  it('calls the same tools a table of the same type calls: no read added for the checkbox', async () => {
    const names = (call: ReturnType<typeof makeCall>) => new Set(call.mock.calls.map(([req]) => `${req.name} ${JSON.stringify(req.arguments ?? {})}`));
    const list = makeCall({ type: 'enum', enum_values: ['todo', 'waiting'] }, 'todo');
    await renderList(list, DEFAULT_VIEW_VOCABULARY);
    cleanup();
    _resetCachesForTest();
    const table = makeCall({ type: 'enum', enum_values: ['todo', 'waiting'] }, 'todo');
    await act(async () => {
      render(<VizClientProvider call={table} vocabulary={DEFAULT_VIEW_VOCABULARY}><VizCard spec={{ ...LIST, kind: 'table' }} onSpecChange={vi.fn()} /></VizClientProvider>);
    });
    await waitFor(() => expect(table).toHaveBeenCalledWith(expect.objectContaining({ name: 'describe-schema' })));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const withoutQuery = (s: Set<string>) => new Set([...s].filter((n) => !n.startsWith('query-nodes')));
    expect(withoutQuery(names(list))).toEqual(withoutQuery(names(table)));
  });
});
