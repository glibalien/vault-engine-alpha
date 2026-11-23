import { act, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { EngineConnection } from '../../src/engine/transport.js';
import { DossierModal } from '../../src/wiki/dossier-modal.js';

// Fictional people only (repository rule).

const reply = (body: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(body) }] });
const status = { project: 'Dana Whitfield Dossier', in_progress: null, paused: false, queue: { running: false, depth: 0 },
  models: { planning: 'p', page: 'g', home: 'h' }, latest_run: null, last_written: null,
  daily_budget: { cap_usd: 3, spent_usd: 1, remaining_usd: 2 } };
const preview = {
  ok: true, dry_run: true, subject: { node_id: 'dana', title: 'Dana Whitfield', kind: 'person' },
  page: { title: 'Dana Whitfield Dossier', path: 'Wikis/Dana Whitfield Dossier.md', node_id: null, action: 'create' },
  reads: { memories: { about: 12, shown: 12, left_out: 0 }, notes: 2, meetings: 1, read_in_full: 3 },
  rebuild: { current: 'manual', note: '' }, model: { ref: 'home-model' },
  cost: { priced: true, estimated_usd: 0.006, worst_case_usd: 0.05, calls: 1 },
  daily_budget: { cap_usd: 3, remaining_usd: 2, fits: true, refusal: null },
};
const connection = (call: (req: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>) =>
  ({ listTools: vi.fn(async () => []), close: vi.fn(async () => {}), call: vi.fn(call) });

it('previews the dossier for free over the Curator, and closes its connection when closed (#715)', async () => {
  const conn = connection(async req => reply(req.name === 'curator-status' ? status : preview));
  const note = vi.fn(async () => ({ id: 'dana', title: 'Dana Whitfield' }));
  const onClosed = vi.fn();
  const modal = new DossierModal({} as never, { noteTitle: 'Dana Whitfield', notePath: 'People/Dana Whitfield.md',
    endpoint: 'https://curator/mcp', token: 'token', note, onOpenPage: vi.fn(), onClosed,
    connect: vi.fn(async () => conn as unknown as EngineConnection) });
  document.body.append(modal.contentEl);
  await act(async () => { modal.open(); });
  await screen.findByRole('button', { name: 'Build dossier' });
  expect(note).toHaveBeenCalledWith('People/Dana Whitfield.md');
  expect(conn.call.mock.calls.map(([req]) => req)).toEqual([
    { name: 'build-dossier', arguments: { node_id: 'dana', dry_run: true } },
    { name: 'curator-status', arguments: { project: 'Dana Whitfield Dossier' } },
  ]);
  expect(modal.contentEl.textContent).toContain('1 paid model call');
  expect(modal.contentEl.textContent).toContain('home-model');
  await act(async () => { screen.getByRole('button', { name: 'Cancel' }).click(); });
  expect(conn.close).toHaveBeenCalled();
  // A build may be running now: the host reads the wiki panel's status again.
  expect(onClosed).toHaveBeenCalledTimes(1);
  expect(modal.contentEl.textContent).toBe('');
  modal.contentEl.remove();
});
