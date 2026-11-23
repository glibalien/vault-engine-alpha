// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VizClientProvider } from '../src/viz-client-context.js';
import { NodeCard } from '../src/NodeCard.js';
import type { NodeCardSpec } from '../src/board-card-spec.js';

afterEach(() => cleanup());

const NODE = {
  id: 'n1', title: 'Vault Engine - Charter', file_path: 'Notes/Charter.md', types: ['project', 'reference'],
  fields: {
    status: { value: 'active', type: 'text', source: 'frontmatter' },
    owner: { value: 'avery', type: 'text', source: 'frontmatter' },
    people: { value: ['Ada', 'Grace'], type: 'json', source: 'frontmatter' },
    weird: { value: { nested: true }, type: 'json', source: 'frontmatter' },
  },
  body: '# Charter\n\nThe engine is **database-authoritative**.\nLine three.\nLine four.\nLine five.\nLine six.\nLine seven — beyond the snippet.',
};
const SPEC: NodeCardSpec = { kind: 'node', title: 'Vault Engine - Charter', node_id: 'n1' };
const env = (payload: unknown, ok = true): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(ok ? { ok: true, data: payload, warnings: [] } : { ok: false, error: { code: 'NODE_NOT_FOUND', message: 'no such node' }, warnings: [] }) }],
});

function renderNode(spec: NodeCardSpec = SPEC, payload: unknown = NODE, ok = true) {
  const call = vi.fn(async () => env(payload, ok));
  const onOpenPreview = vi.fn();
  const onSpecChange = vi.fn();
  render(
    <VizClientProvider call={call}>
      <NodeCard spec={spec} onOpenPreview={onOpenPreview} onSpecChange={onSpecChange} />
    </VizClientProvider>,
  );
  return { call, onOpenPreview, onSpecChange };
}

describe('NodeCard', () => {
  it('renders header, type chips, scalar fields, and a markdown-stripped 6-line snippet', async () => {
    const { call } = renderNode();
    await waitFor(() => expect(screen.getByText('Vault Engine - Charter')).toBeTruthy());
    expect(screen.getByText('project')).toBeTruthy();
    expect(screen.getByText(/active/)).toBeTruthy();
    expect(screen.getByText(/Ada · Grace/)).toBeTruthy();          // array joined
    expect(screen.queryByText(/nested/)).toBeNull();               // object values skipped
    expect(screen.getByText(/database-authoritative/)).toBeTruthy();
    expect(screen.getByText(/database-authoritative/).textContent).not.toContain('**'); // markdown stripped
    expect(screen.queryByText(/beyond the snippet/)).toBeNull();   // line 7 not in the 6-line snippet
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ name: 'get-node', arguments: expect.objectContaining({ include_embeds: false }) }));
  });
  it('expand reveals the full body and persists via onSpecChange', async () => {
    const { onSpecChange } = renderNode();
    await waitFor(() => expect(screen.getByRole('button', { name: /expand/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /expand/ }));
    expect(screen.getByText(/beyond the snippet/)).toBeTruthy();
    expect(onSpecChange).toHaveBeenCalledWith({ ...SPEC, expanded: true });
  });
  it('starts expanded when the spec says so', async () => {
    renderNode({ ...SPEC, expanded: true });
    await waitFor(() => expect(screen.getByText(/beyond the snippet/)).toBeTruthy());
  });
  it('title click opens the note', async () => {
    const { onOpenPreview } = renderNode();
    await waitFor(() => expect(screen.getByText('Vault Engine - Charter')).toBeTruthy());
    fireEvent.click(screen.getByText('Vault Engine - Charter'));
    expect(onOpenPreview).toHaveBeenCalledWith({ nodeId: 'n1' });
  });
  it('deleted target → in-card error naming the stored title', async () => {
    renderNode(SPEC, null, false);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Vault Engine - Charter/));
  });
});
