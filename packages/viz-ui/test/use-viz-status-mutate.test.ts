// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { VizClientProvider } from '../src/viz-client-context.js';
import { useVizStatusMutate } from '../src/use-viz-status-mutate.js';
import type { VizRow } from '../src/viz-spec.js';

const rows: VizRow[] = [{ id: 'n1', title: 'Task 1', file_path: 'notes/task-1.md', types: [], fields: { status: 'open' }, version: 3 }];
const wrap = (call: any) => ({ children }: { children: React.ReactNode }) =>
  createElement(VizClientProvider, { call }, children);

describe('useVizStatusMutate', () => {
  it('optimistically sets status and commits update-node with expected_version', async () => {
    // CallFn signature: (toolCall: { name, arguments }) => Promise<CallToolResult>
    const call = vi.fn(async (toolCall: { name: string; arguments: Record<string, unknown> }) =>
      toolCall.name === 'update-node'
        ? { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { node_id: 'n1', version: 4 } }) }] }
        : { content: [{ type: 'text', text: '{"ok":true,"data":{}}' }] });
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useVizStatusMutate(rows, onRefresh), { wrapper: wrap(call) });
    act(() => result.current.setStatus('n1', 'status', 'done'));
    expect(result.current.rows[0].fields.status).toBe('done'); // optimistic, synchronous
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({
      name: 'update-node',
      arguments: expect.objectContaining({ node_id: 'n1', set_fields: { status: 'done' }, expected_version: 3 }),
    })));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('reverts + sets error when the commit fails', async () => {
    const call = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'STALE_NODE', message: 'stale' } }) }] }));
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useVizStatusMutate(rows, onRefresh), { wrapper: wrap(call) });
    act(() => result.current.setStatus('n1', 'status', 'done'));
    await waitFor(() => expect(result.current.rows[0].fields.status).toBe('open')); // reverted
    expect(result.current.error).toBeTruthy();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('no-ops when rendered without a client provider', () => {
    const { result } = renderHook(() => useVizStatusMutate(rows)); // no wrapper
    act(() => result.current.setStatus('n1', 'status', 'done'));
    expect(result.current.rows[0].fields.status).toBe('open'); // unchanged, no throw
  });
});
