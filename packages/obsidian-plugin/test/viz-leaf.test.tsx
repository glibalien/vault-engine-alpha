import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VizClientProvider, VizCard } from '@vault/viz-ui';

const queryResult = (): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({
    ok: true,
    data: { nodes: [{ id: 'n1', file_path: 'Hello.md', title: 'Hello', types: ['note'], version: 1, fields: {} }], total: 1 },
  }) }],
});

const okResult = (): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data: {} }) }],
});

describe('plugin viz leaf', () => {
  it('renders rows from the injected CallFn', async () => {
    const call = vi.fn(async (req: { name: string }) => {
      if (req.name === 'query-nodes') return queryResult();
      return okResult();
    });
    render(
      <VizClientProvider call={call}>
        <VizCard spec={{ kind: 'table', title: 'Recent nodes', query: { limit: 25 }, display_fields: [] }} />
      </VizClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Hello')).toBeTruthy());
    expect(call).toHaveBeenCalled();
    const queryCall = call.mock.calls.find((c: [{ name: string }]) => c[0]?.name === 'query-nodes');
    expect(queryCall).toBeTruthy();
    expect(queryCall![0]).toMatchObject({ name: 'query-nodes' });
  });
});
