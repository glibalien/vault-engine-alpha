import { act, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { EngineConnection } from '../../src/engine/transport.js';
import { CreateTopicWikiModal, engineNoteByPath } from '../../src/wiki/create-topic-wiki-modal.js';

const reply = (body: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(body) }] });
const status = { project: 'Note', in_progress: null, paused: false, queue: { running: false, depth: 0 },
  models: { planning: 'p', page: 'g', home: 'h' }, latest_run: null, last_written: null,
  daily_budget: { cap_usd: 3, spent_usd: 1, remaining_usd: 2 } };
const connection = (call: (req: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>) =>
  ({ listTools: vi.fn(async () => []), close: vi.fn(async () => {}), call: vi.fn(call) });

it('finds the note\'s Engine node by its path with get-node, and closes that connection', async () => {
  const conn = connection(async () => reply({ ok: true, data: { id: 'n1', title: 'Field notes', file_path: 'Clips/Field notes.md' } }));
  const connect = vi.fn(async () => conn as unknown as EngineConnection);
  expect(await engineNoteByPath('https://engine/mcp', 'engine-token', connect)('Clips/Field notes.md')).toEqual({ id: 'n1', title: 'Field notes' });
  expect(connect).toHaveBeenCalledWith('https://engine/mcp', 'engine-token');
  expect(conn.call).toHaveBeenCalledWith({ name: 'get-node', arguments: { file_path: 'Clips/Field notes.md', include_embeds: false } });
  expect(conn.close).toHaveBeenCalled();
  const missing = connection(async () => reply({ ok: false, error: { code: 'NOT_FOUND', message: 'no node' } }));
  await expect(engineNoteByPath('u', 't', vi.fn(async () => missing as unknown as EngineConnection))('Gone.md')).rejects.toThrow(/no node/);
  expect(missing.close).toHaveBeenCalled();
});

it('runs the free check over the Curator, and closes its connection when closed', async () => {
  const conn = connection(async req => reply(req.name === 'curator-status' ? status
    : { ok: true, dry_run: true, node: { id: 'n1', title: 'Field notes' }, model: 'plan-model', detail: 'Would make one call' }));
  const note = vi.fn(async () => ({ id: 'n1', title: 'Field notes' }));
  const modal = new CreateTopicWikiModal({} as never, { noteTitle: 'Field notes', notePath: 'Clips/Field notes.md',
    endpoint: 'https://curator/mcp', token: 'token', note, onOpenWiki: vi.fn(),
    connect: vi.fn(async () => conn as unknown as EngineConnection) });
  document.body.append(modal.contentEl);
  await act(async () => { modal.open(); });
  await screen.findByRole('button', { name: 'Suggest a topic (paid)' });
  expect(note).toHaveBeenCalledWith('Clips/Field notes.md');
  expect(conn.call.mock.calls.map(([req]) => req)).toEqual(expect.arrayContaining([
    { name: 'propose-topic-wiki', arguments: { node_id: 'n1', dry_run: true } },
    { name: 'curator-status', arguments: { project: 'Field notes' } },
  ]));
  expect(conn.call).toHaveBeenCalledTimes(2);
  await act(async () => { screen.getByRole('button', { name: 'Close' }).click(); });
  expect(conn.close).toHaveBeenCalled();
  expect(modal.contentEl.textContent).toBe('');
  modal.contentEl.remove();
});
