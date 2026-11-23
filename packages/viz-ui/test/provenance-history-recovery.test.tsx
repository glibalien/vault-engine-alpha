// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { CallFn } from '@vault/query-core';
import { VizClientProvider } from '../src/viz-client-context.js';
import { useProvenanceInspector } from '../src/use-provenance-inspector.js';
import { defaultCall, deferred, env, inputPage, output } from './helpers/provenance-inspector.js';

afterEach(cleanup);
const target = { nodeId: 'home', title: 'Home', path: 'Home.md' };
const legacyCursor = btoa(JSON.stringify({
  scope: 'node:home', position: ['2026-09-19T00:00:00Z', 'out'],
}));
const page = (id: string, cursor: string | null) => env({
  select: 'node', outputs: [output(id)], current_provenance: 'captured', next_cursor: cursor,
});
const rejection = (code = 'INVALID_PARAMS', reason = 'PROVENANCE_LIMIT') => ({
  content: [{ type: 'text' as const, text: JSON.stringify({
    ok: false, error: { code, message: 'PROVENANCE_LIMIT', details: { reason } }, warnings: [],
  }) }],
});
function inspect(call: CallFn) {
  return renderHook(() => useProvenanceInspector({ target, connectionKey: 1, hasInspectionTool: true }), {
    wrapper: ({ children }) => <VizClientProvider call={call}>{children}</VizClientProvider>,
  });
}

it('discards rejected legacy history, clears retained reads, and continues with the fresh cursor', async () => {
  const restarted = deferred<Awaited<ReturnType<CallFn>>>();
  const cursors: unknown[] = [];
  const outputReads: unknown[] = [];
  const { result } = inspect(async (req) => {
    if (req.arguments.select === 'output') outputReads.push(req.arguments.output_revision_id);
    if (req.arguments.select !== 'node') return defaultCall(req);
    const cursor = req.arguments.cursor;
    cursors.push(cursor);
    if (cursor === legacyCursor) return rejection();
    if (cursor === 'current-cursor') return page('older', null);
    return cursors.length === 1 ? page('out', legacyCursor) : restarted.promise;
  });
  await waitFor(() => expect(result.current.outputPages[0]?.data).toBeTruthy());
  act(() => result.current.selectInput('input'));
  await waitFor(() => expect(result.current.text.data).toBeTruthy());
  act(() => result.current.loadOlder());
  await waitFor(() => expect(cursors).toEqual([undefined, legacyCursor, undefined]));
  expect(result.current.history).toHaveLength(1);
  expect(result.current.history[0]?.data).toBeNull();
  expect(result.current.text.data).toBeNull();
  expect(result.current.outputPages).toEqual([]);
  await act(async () => restarted.resolve(page('newest', 'current-cursor')));
  await waitFor(() => expect(result.current.outputPages[0]?.data).toBeTruthy());
  expect(result.current.selectedOutputId).toBe('out');
  expect(outputReads).toEqual(['out', 'out']);
  expect(result.current.history[0]?.error).toBeNull();
  act(() => result.current.loadOlder());
  await waitFor(() => expect(result.current.history[1]?.data?.outputs[0]?.receipt.output_revision_id).toBe('older'));
  expect(cursors).toEqual([undefined, legacyCursor, undefined, 'current-cursor']);
  expect(result.current.history[0]?.data?.outputs[0]?.receipt.output_revision_id).toBe('newest');
});

it('stops after a failed cursorless restart without restoring or retrying the rejected cursor', async () => {
  const cursors: unknown[] = [];
  const { result } = inspect(async (req) => {
    if (req.arguments.select !== 'node') return defaultCall(req);
    cursors.push(req.arguments.cursor);
    return cursors.length === 1 ? page('out', legacyCursor) : rejection();
  });
  await waitFor(() => expect(result.current.history[0]?.data).toBeTruthy());
  act(() => result.current.loadOlder());
  await waitFor(() => {
    expect(cursors).toEqual([undefined, legacyCursor, undefined]);
    expect(result.current.history[0]?.error).toBe('PROVENANCE_LIMIT');
  });
  expect(result.current.history[0]?.data).toBeNull();
  act(() => result.current.loadOlder());
  expect(cursors).toHaveLength(3);
});

it.each([
  ['wrong code', () => rejection('INTERNAL_ERROR')],
  ['wrong reason', () => rejection('INVALID_PARAMS', 'OTHER_REASON')],
  ['message alone', () => { throw Error('PROVENANCE_LIMIT'); }],
])('keeps the original retry cursor for unrelated failures: %s', async (_name, failure) => {
  const cursors: unknown[] = [];
  const { result } = inspect(async (req) => {
    if (req.arguments.select !== 'node') return defaultCall(req);
    cursors.push(req.arguments.cursor);
    return req.arguments.cursor ? failure() : page('out', legacyCursor);
  });
  await waitFor(() => expect(result.current.history[0]?.data).toBeTruthy());
  act(() => result.current.loadOlder());
  await waitFor(() => expect(result.current.history[0]?.error).toBe('PROVENANCE_LIMIT'));
  act(() => result.current.loadOlder());
  await waitFor(() => expect(result.current.history[0]?.error).toBe('PROVENANCE_LIMIT'));
  expect(cursors).toEqual([undefined, legacyCursor, legacyCursor]);
  expect(result.current.history[0]?.data?.next_cursor).toBe(legacyCursor);
});

it('does not restart a rejected first history page', async () => {
  let historyReads = 0;
  const { result } = inspect(async (req) => {
    if (req.arguments.select !== 'node') return defaultCall(req);
    historyReads++;
    return rejection();
  });
  await waitFor(() => expect(result.current.history[0]?.error).toBe('PROVENANCE_LIMIT'));
  expect(historyReads).toBe(1);
  expect(result.current.history[0]?.data).toBeNull();
});

it('does not restart node history for an output-input pagination rejection', async () => {
  let historyReads = 0;
  const cursors: unknown[] = [];
  const { result } = inspect(async (req) => {
    if (req.arguments.select === 'node') historyReads++;
    if (req.arguments.select !== 'output') return defaultCall(req);
    cursors.push(req.arguments.cursor);
    return req.arguments.cursor ? rejection() : env({ ...inputPage(), next_cursor: 'input-cursor' });
  });
  await waitFor(() => expect(result.current.outputPages[0]?.data).toBeTruthy());
  // The second input page loads without a click; its rejection keeps the cursor for a retry.
  await waitFor(() => expect(result.current.outputPages[0]?.error).toBe('PROVENANCE_LIMIT'));
  act(() => result.current.loadMoreInputs());
  await waitFor(() => expect(result.current.outputPages[0]?.error).toBe('PROVENANCE_LIMIT'));
  expect(cursors).toEqual([undefined, 'input-cursor', 'input-cursor']);
  expect(historyReads).toBe(1);
});
