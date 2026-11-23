import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../../src/view/App.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// A minimal CallToolResult for query-nodes with one row.
const makeQueryResult = (title: string): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({
    ok: true,
    data: { nodes: [{ id: 'n1', file_path: 'A.md', title, types: ['note'], version: 1, fields: {} }], total: 1 },
  }) }],
});

// A minimal CallToolResult for any other tool (vault-stats, list-types, describe-schema, …).
const makeOkResult = (): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data: {} }) }],
});

describe('App (VizCard leaf)', () => {
  it('renders node rows from the injected CallFn', async () => {
    const call = vi.fn(async (req: { name: string }) => {
      if (req.name === 'query-nodes') return makeQueryResult('Alpha');
      return makeOkResult();
    });
    render(<App call={call} />);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(call).toHaveBeenCalled();
  });

  it('renders a loading state before data arrives', () => {
    const call = vi.fn(() => new Promise<CallToolResult>(() => {})); // never resolves
    render(<App call={call} />);
    // VizCard shows a loading indicator while the query is in-flight
    expect(document.querySelector('.viz')).toBeTruthy();
  });
});
