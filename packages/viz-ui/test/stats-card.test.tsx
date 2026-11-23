// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VizClientProvider } from '../src/viz-client-context.js';
import { StatsCard, WATCHER_STALE_MS } from '../src/StatsCard.js';

afterEach(() => {
  cleanup();
});

const PAYLOAD = {
  node_count: 4200, type_counts: [{ type: 'task', count: 900 }, { type: 'note', count: 2100 }], field_count: 61, relationship_count: 9800,
  orphan_count: 3, schema_count: 14, db_bytes: 157286400, wal_bytes: 0,
  watcher: { last_event_at: new Date().toISOString(), state: 'idle' },
  retained_transcripts: 390, orphaned_transcripts: 2, materialized_transcripts: 41,
  archived_sources: 392, archived_bytes: 0, undo: { active_operations: 0, total_snapshot_bytes: 0 },
};
const env = (payload: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: payload, warnings: [] }) }] });

function renderStats(payload: unknown = PAYLOAD) {
  const call = vi.fn(async () => env(payload));
  render(
    <VizClientProvider call={call}>
      <StatsCard spec={{ kind: 'stats', title: 'Vault' }} />
    </VizClientProvider>,
  );
  return call;
}

describe('StatsCard', () => {
  it('fetches vault-stats once on mount and renders the tile set', async () => {
    const call = renderStats();
    await waitFor(() => expect(screen.getByText('4,200')).toBeTruthy());   // nodes
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith({ name: 'vault-stats', arguments: {} });
    expect(screen.getByText('2')).toBeTruthy();       // types tile = Object.keys(type_counts).length
    expect(screen.getByText('150.0 MB')).toBeTruthy(); // db_bytes humanized
    expect(screen.getByText(/idle|active/)).toBeTruthy();
  });
  it('tints the watcher tile when the last event is older than WATCHER_STALE_MS (or null)', async () => {
    renderStats({ ...PAYLOAD, watcher: { last_event_at: new Date(Date.now() - WATCHER_STALE_MS - 1000).toISOString(), state: 'idle' } });
    await waitFor(() => expect(document.querySelector('.vz-stat-warn')).toBeTruthy());
  });
  it('renders the envelope error in-card', async () => {
    const call = vi.fn(async (): Promise<CallToolResult> => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { message: 'engine unreachable' }, warnings: [] }) }] }));
    render(<VizClientProvider call={call}><StatsCard spec={{ kind: 'stats', title: '' }} /></VizClientProvider>);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('engine unreachable'));
  });
  it('↻ refetches', async () => {
    const call = renderStats();
    await waitFor(() => expect(screen.getByText('4,200')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('refresh'));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  });
});
