import { act, fireEvent, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { EngineConnection } from '../../src/engine/transport.js';
import { CreateWikiModal } from '../../src/wiki/create-wiki-modal.js';

const reply = (body: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(body) }] });
const status = { project: 'Project', in_progress: null, paused: false, queue: { running: false, depth: 0 },
  models: { planning: 'p', page: 'g', home: 'h' }, latest_run: null, last_written: null,
  daily_budget: { cap_usd: 3, spent_usd: 1, remaining_usd: 2 } };

it('runs the free check over the Curator, and closes its connection when closed', async () => {
  const conn = { listTools: vi.fn(async () => []), close: vi.fn(async () => {}), call: vi.fn(async (req: { name: string }) =>
    reply(req.name === 'curator-status' ? status
      : { ok: true, project: 'Project', project_id: 'n1', dry_run: true, created: true, home_created: true, first_build: null, detail: 'dry run' })) };
  const modal = new CreateWikiModal({} as never, { project: 'Project', projectRef: 'Clients/Project.md', endpoint: 'https://curator/mcp', token: 'token',
    onRegistered: vi.fn(), onOpenWiki: vi.fn(), connect: vi.fn(async () => conn as unknown as EngineConnection) });
  document.body.append(modal.contentEl);
  await act(async () => { modal.open(); });
  await screen.findByRole('button', { name: 'Create project wiki (paid)' });
  expect(conn.call.mock.calls.map(([req]) => req)).toEqual([
    { name: 'curator-status', arguments: { project: 'Project' } },
    { name: 'create-project-wiki', arguments: { project: 'Clients/Project.md', dry_run: true } },
  ]);
  await act(async () => { screen.getByRole('button', { name: 'Close' }).click(); });
  expect(conn.close).toHaveBeenCalled();
  expect(modal.contentEl.textContent).toBe('');
  modal.contentEl.remove();
});

it('builds a wiki an earlier pause kept from its first build with the forced whole-wiki build, on the same connection (#544)', async () => {
  const paused = { ...status, paused: true };
  const conn = { listTools: vi.fn(async () => []), close: vi.fn(async () => {}), call: vi.fn(async (req: { name: string; arguments: Record<string, unknown> }) => {
    if (req.name === 'curator-status') return reply(paused);
    if (req.name === 'create-project-wiki') return reply(req.arguments.dry_run
      ? { ok: true, project: 'Project', project_id: 'n1', dry_run: true, created: true, home_created: true, first_build: null, detail: 'dry run' }
      : { ok: true, project: 'Project', project_id: 'n1', dry_run: false, created: true, home_created: true,
        first_build: { project: 'Project', outcome: 'skipped', detail: 'paused', dryRun: false }, detail: 'registered' });
    return reply({ mode: 'project', dry_run: true, results: [{ outcome: 'would_curate', detail: null, evidence_unchanged: false }] });
  }) };
  const connect = vi.fn(async () => conn as unknown as EngineConnection);
  const modal = new CreateWikiModal({} as never, { project: 'Project', projectRef: 'Clients/Project.md', endpoint: 'https://curator/mcp', token: 'token',
    onRegistered: vi.fn(), onOpenWiki: vi.fn(), connect });
  document.body.append(modal.contentEl);
  await act(async () => { modal.open(); });
  fireEvent.click(await screen.findByRole('button', { name: 'Create project wiki (paid)' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Build it now…' }));
  await screen.findByRole('button', { name: 'Rebuild wiki' });
  expect(conn.call.mock.calls.map(([req]) => req).filter(req => req.name === 'curate-project-wiki'))
    .toEqual([{ name: 'curate-project-wiki', arguments: { project: 'Project', dry_run: true, force: true } }]);
  expect(connect).toHaveBeenCalledTimes(1);
  await act(async () => { modal.close(); });
  expect(conn.close).toHaveBeenCalled();
  modal.contentEl.remove();
});
