// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HomeRefreshError, HomeRefreshNotSentError, type HomeRefreshApi, type HomeRefreshPreview, type HomeRefreshStatus } from '@vault/query-core';
import { HomeRefresh } from '../src/HomeRefresh.js';
afterEach(cleanup);
const preview: HomeRefreshPreview = { eligible: true, reasons: [], target_kind: 'home', page_title: null, page_path: null, home_title: 'Project home', home_path: 'Home.md', project_title: 'Project',
  model: { ref: 'Model', provider: 'Provider', max_output_tokens: 4000 }, sections: ['Now', 'Focus', 'Log'],
  guard: { version: 1, vault_namespace: 'vault', home_node_id: 'home', project_id: 'project', output_revision_id: 'old', home_version: 2,
    topology_hash: 'topology', configuration_digest: 'config', corrections_digest: 'corrections' } };
const status: HomeRefreshStatus = { request_id: 'request', phase: 'committed', message: 'Home refreshed', created_at: '', updated_at: '',
  replaces_output_revision_id: 'old', usage: null, output: { output_revision_id: 'new', output_node_id: 'home' } as any };
it.each(['GUARD_CONFLICT', 'INVALID_ARGUMENT', 'REQUEST_CONFLICT'])('clears definitive %s and requires a fresh preview', async code => {
  const persisted: unknown[] = [];
  const api: HomeRefreshApi = { preview: async () => preview,
    execute: async () => { throw new HomeRefreshError(code); }, status: vi.fn() };
  render(<HomeRefresh api={api} outputRevisionId="old" expectedNamespace="vault"
    onPersist={async value => { persisted.push(value); }} onClose={() => {}} onInspect={() => {}} />);
  fireEvent.click(await screen.findByText('Rebuild page'));
  await waitFor(() => expect(persisted.at(-1)).toBeNull());
  expect(screen.getByRole('alert').textContent).toMatch(/preview again/i);
  expect(screen.queryByText('Retry same request')).toBeNull();
  expect(screen.queryByText('Rebuild page')).toBeNull();
});
it.each(['FORBIDDEN', 'READINESS_UNAVAILABLE', 'SHUTTING_DOWN'])('clears a first-attempt %s rejection and reopens with a fresh preview', async code => {
  let saved: string | null = null;
  const api: HomeRefreshApi = { preview: vi.fn(async () => preview),
    execute: vi.fn(async () => { throw new HomeRefreshError(code); }), status: vi.fn() };
  const view = render(<HomeRefresh api={api} outputRevisionId="old" expectedNamespace="vault"
    onPersist={async (value, expectedId) => {
      if (value) saved = value.request_id;
      else if (saved === expectedId) saved = null;
    }} onClose={() => {}} onInspect={() => {}} />);
  fireEvent.click(await screen.findByText('Rebuild page'));
  await screen.findByText(/This request was rejected/);
  expect(saved).toBeNull();
  expect(screen.getByRole('alert').textContent).toMatch(/preview again/i);
  expect(screen.queryByText('Retry same request')).toBeNull();
  expect(screen.queryByText('Check status now')).toBeNull();
  expect(screen.queryByText('Rebuild page')).toBeNull();
  view.unmount();
  render(<HomeRefresh api={api} outputRevisionId="old" expectedNamespace="vault"
    resume={saved ? { request_id: saved, vault_namespace: 'vault' } : undefined}
    onPersist={async () => {}} onClose={() => {}} onInspect={() => {}} />);
  await screen.findByText('Rebuild page');
  expect(api.preview).toHaveBeenCalledTimes(2);
  expect(api.status).not.toHaveBeenCalled();
  expect(api.execute).toHaveBeenCalledTimes(1);
});
it.each(['FORBIDDEN', 'READINESS_UNAVAILABLE', 'SHUTTING_DOWN'].flatMap(code => [
  { code, closed: false }, { code, closed: true },
]))('retains an earlier lost response after $code (closed=$closed)', async ({ code, closed }) => {
  let saved: string | null = null;
  let reject!: (error: Error) => void;
  const execute = vi.fn().mockRejectedValueOnce(Error('reply lost'))
    .mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const api = { preview: async () => preview, execute, status: vi.fn() };
  const view = render(<HomeRefresh api={api} outputRevisionId="old" expectedNamespace="vault"
    onPersist={async (value, expectedId) => {
      if (value) saved = value.request_id;
      else if (saved === expectedId) saved = null;
    }} onClose={() => {}} onInspect={() => {}} />);
  fireEvent.click(await screen.findByText('Rebuild page'));
  fireEvent.click(await screen.findByText('Retry same request'));
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  const submittedId = execute.mock.calls[0]![0].request_id;
  if (closed) view.unmount();
  await act(async () => reject(new HomeRefreshError(code)));
  expect(saved).toBe(submittedId);
  expect(execute.mock.calls[1]![0].request_id).toBe(submittedId);
  if (!closed) {
    expect(screen.getByText('Retry same request')).toBeTruthy();
    expect(screen.getByText('Check status now')).toBeTruthy();
    expect(screen.queryByText('Rebuild page')).toBeNull();
  }
});
it.each(['FORBIDDEN', 'READINESS_UNAVAILABLE', 'SHUTTING_DOWN'].flatMap(code => [
  { code, replaced: false }, { code, replaced: true },
]))('cleans up a late first-attempt $code without erasing a newer bookmark (replaced=$replaced)', async ({ code, replaced }) => {
  let saved: string | null = null;
  let reject!: (error: Error) => void;
  const cleared: string[] = [];
  const execute = vi.fn(() => new Promise<HomeRefreshStatus>((_, fail) => { reject = fail; }));
  const api = { preview: async () => preview, execute, status: vi.fn() };
  const view = render(<HomeRefresh api={api} outputRevisionId="old" expectedNamespace="vault"
    onPersist={async (value, expectedId) => {
      if (value) saved = value.request_id;
      else { cleared.push(expectedId!); if (saved === expectedId) saved = null; }
    }} onClose={() => {}} onInspect={() => {}} />);
  fireEvent.click(await screen.findByText('Rebuild page'));
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  const deniedId = saved;
  view.unmount();
  if (replaced) saved = 'newer-request';
  await act(async () => reject(new HomeRefreshError(code)));
  expect(cleared).toEqual([deniedId]);
  expect(saved).toBe(replaced ? 'newer-request' : null);
});
it('previews free, persists identity before one confirmation, and shows both generation links', async () => {
  const events: string[] = [];
  const api: HomeRefreshApi = { preview: vi.fn(async () => preview), execute: vi.fn(async request => { events.push('send'); return { ...status, request_id: request.request_id }; }), status: vi.fn() };
  const inspect = vi.fn();
  render(<HomeRefresh api={api} outputRevisionId="old" expectedNamespace="vault"
    onPersist={async () => { events.push('persist'); }} onClose={() => {}} onInspect={inspect} />);
  const button = await screen.findByRole('button', { name: 'Rebuild page' });
  expect(api.execute).not.toHaveBeenCalled();
  fireEvent.click(button); fireEvent.click(button);
  await screen.findByText('Home refreshed');
  expect(events).toEqual(['persist', 'send']);
  expect(api.execute).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Token usage unavailable')).toBeTruthy();
  fireEvent.click(screen.getByText('Show the previous build'));
  expect(inspect).toHaveBeenCalledWith('old', 'home');
});
it.each([Error('lost'), new HomeRefreshError('REFRESH_UNAVAILABLE')])('retries ambiguous %s with the same identity, but reopen only reads status', async error => {
  const execute = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(status);
  const api = { preview: vi.fn(async () => preview), execute, status: vi.fn(async () => status) };
  const props = { api, expectedNamespace: 'vault', onPersist: vi.fn(async () => {}), onClose: vi.fn(), onInspect: vi.fn() };
  const view = render(<HomeRefresh {...props} outputRevisionId="old" />);
  fireEvent.click(await screen.findByText('Rebuild page'));
  fireEvent.click(await screen.findByText('Retry same request'));
  await screen.findByText('Home refreshed');
  expect(execute.mock.calls[0]?.[0]).toEqual(execute.mock.calls[1]?.[0]);
  view.unmount();
  render(<HomeRefresh {...props} resume={{ request_id: 'request', vault_namespace: 'vault' }} />);
  await waitFor(() => expect(api.status).toHaveBeenCalledWith('request'));
  expect(execute).toHaveBeenCalledTimes(2);
});
it('blocks namespace mismatch and discards a late preview after unmount', async () => {
  let resolve!: (p: HomeRefreshPreview) => void;
  const api = { preview: vi.fn(() => new Promise<HomeRefreshPreview>(r => { resolve = r; })), execute: vi.fn(), status: vi.fn() };
  const v = render(<HomeRefresh api={api} outputRevisionId="old" expectedNamespace="different"
    onPersist={vi.fn()} onClose={vi.fn()} onInspect={vi.fn()} />);
  v.unmount();
  await act(async () => resolve(preview));
  expect(api.execute).not.toHaveBeenCalled();
});
it('forgets only its unsent UUID when the panel closes during layout persistence', async () => {
  let release!: () => void;
  let saved: string | null = null;
  const cleared: string[] = [];
  const api = { preview: async () => preview, execute: vi.fn(), status: vi.fn() };
  const onPersist = async (value: { request_id: string } | null, expectedId?: string) => {
    if (value) { saved = value.request_id; await new Promise<void>(resolve => { release = resolve; }); }
    else { cleared.push(expectedId!); if (saved === expectedId) saved = null; }
  };
  const view = render(<HomeRefresh api={api} outputRevisionId="old" expectedNamespace="vault"
    onPersist={onPersist} onClose={() => {}} onInspect={() => {}} />);
  fireEvent.click(await screen.findByText('Rebuild page'));
  await waitFor(() => expect(saved).not.toBeNull());
  const unsent = saved;
  view.unmount();
  await act(async () => release());
  expect(api.execute).not.toHaveBeenCalled();
  expect(cleared).toEqual([unsent]);
  expect(saved).toBeNull();
});
it('clears an identity when persistence fails before submission', async () => {
  const persist = vi.fn(async (value: unknown) => { if (value) throw Error('layout save failed'); });
  const api = { preview: async () => preview, execute: vi.fn(), status: vi.fn() };
  render(<HomeRefresh api={api} outputRevisionId="old" expectedNamespace="vault"
    onPersist={persist} onClose={() => {}} onInspect={() => {}} />);
  fireEvent.click(await screen.findByText('Rebuild page'));
  await screen.findByText(/request was not submitted/i);
  expect(api.execute).not.toHaveBeenCalled();
  expect(persist).toHaveBeenLastCalledWith(null, (persist.mock.calls[0]![0] as { request_id: string }).request_id);
});
it('retains identity when the panel closes after submission starts', async () => {
  let release!: (value: HomeRefreshStatus) => void;
  const persist = vi.fn(async () => {});
  const api = { preview: async () => preview, execute: vi.fn(() => new Promise<HomeRefreshStatus>(resolve => { release = resolve; })), status: vi.fn() };
  const view = render(<HomeRefresh api={api} outputRevisionId="old" expectedNamespace="vault"
    onPersist={persist} onClose={() => {}} onInspect={() => {}} />);
  fireEvent.click(await screen.findByText('Rebuild page'));
  await waitFor(() => expect(api.execute).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => release(status));
  expect(persist).toHaveBeenCalledTimes(1);
});
it.each(['closed', 'failed'])('retains an ambiguously submitted identity when retry persistence is %s', async mode => {
  let release!: () => void;
  let writes = 0;
  const persist = vi.fn(async (value: unknown) => {
    if (value && ++writes === 2) {
      if (mode === 'failed') throw Error('layout save failed');
      await new Promise<void>(resolve => { release = resolve; });
    }
  });
  const api = { preview: async () => preview, execute: vi.fn(async () => { throw Error('reply lost'); }), status: vi.fn() };
  const view = render(<HomeRefresh api={api} outputRevisionId="old" expectedNamespace="vault"
    onPersist={persist} onClose={() => {}} onInspect={() => {}} />);
  fireEvent.click(await screen.findByText('Rebuild page'));
  fireEvent.click(await screen.findByText('Retry same request'));
  await waitFor(() => expect(writes).toBe(2));
  if (mode === 'closed') { view.unmount(); await act(async () => release()); }
  else await screen.findByText(/Submission was not confirmed/);
  expect(api.execute).toHaveBeenCalledTimes(1);
  expect(persist).toHaveBeenCalledTimes(2);
});
it('clears a never-sent request after preflight failure and requires a new preview', async () => {
  const persist = vi.fn(async () => {});
  const api = { preview: async () => preview, execute: async () => { throw new HomeRefreshNotSentError(); }, status: vi.fn() };
  render(<HomeRefresh api={api} outputRevisionId="old" expectedNamespace="vault"
    onPersist={persist} onClose={() => {}} onInspect={() => {}} />);
  fireEvent.click(await screen.findByText('Rebuild page'));
  await screen.findByText(/request was not submitted/i);
  expect(persist).toHaveBeenLastCalledWith(null, expect.any(String));
  expect(screen.queryByText('Retry same request')).toBeNull();
  expect(screen.queryByText('Rebuild page')).toBeNull();
});
it.each([false, true])('retains an earlier ambiguous submission when retry preflight aborts (closed=%s)', async closed => {
  let reject!: (error: Error) => void;
  const persist = vi.fn(async () => {});
  const execute = vi.fn().mockRejectedValueOnce(Error('reply lost'))
    .mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const api = { preview: async () => preview, execute, status: vi.fn(async (id: string) => ({ ...status, request_id: id })) };
  const view = render(<HomeRefresh api={api} outputRevisionId="old" expectedNamespace="vault"
    onPersist={persist} onClose={() => {}} onInspect={() => {}} />);
  fireEvent.click(await screen.findByText('Rebuild page'));
  fireEvent.click(await screen.findByText('Retry same request'));
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  if (closed) view.unmount();
  await act(async () => reject(new HomeRefreshNotSentError()));
  expect(persist).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[1]![0]).toEqual(execute.mock.calls[0]![0]);
  if (!closed) {
    expect(screen.getByText('Retry same request')).toBeTruthy();
    expect(screen.queryByText('Rebuild page')).toBeNull();
  }
});

const pagePreview: HomeRefreshPreview = { ...preview, target_kind: 'page', page_title: 'Project — Decisions', page_path: 'Wikis/Decisions.md',
  sections: ['Summary', 'Log'], guard: { ...preview.guard!, page_node_id: 'page', page_version: 3 } };
const showPreview = (value: HomeRefreshPreview) => render(<HomeRefresh api={{ preview: async () => value, execute: vi.fn(), status: vi.fn() }}
  outputRevisionId="old" expectedNamespace="vault" onPersist={async () => {}} onClose={() => {}} onInspect={() => {}} />);
it('names the sub-page it would rewrite, and says the home may lag', async () => {
  showPreview(pagePreview);
  await screen.findByRole('heading', { name: 'Rebuild “Project — Decisions”?' });
  const text = document.body.textContent ?? '';
  expect(text).toContain('Wikis/Decisions.md');
  expect(screen.getByRole('heading', { name: 'Rewrites' }).parentElement?.textContent).toBe('RewritesSummaryLogMaybe one new Log entry');
  expect(text).toContain('the notes its last build read');
  expect(text).toContain('may lag until the home is next rebuilt');
  expect(text).not.toContain('Home.md');
});
it('still names the home for a home, without the note about lagging', async () => {
  showPreview(preview);
  await screen.findByRole('heading', { name: 'Rebuild “Project home”?' });
  const text = document.body.textContent ?? '';
  expect(text).toContain('One new Log entry');
  expect(text).not.toContain('may lag');
});
it('sends a sub-page\'s guard as previewed', async () => {
  const execute = vi.fn(async () => ({ ...status, phase: 'queued' as const, output: null }));
  render(<HomeRefresh api={{ preview: async () => pagePreview, execute, status: vi.fn(async () => status) }}
    outputRevisionId="old" expectedNamespace="vault" onPersist={async () => {}} onClose={() => {}} onInspect={() => {}} />);
  fireEvent.click(await screen.findByText('Rebuild page'));
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(execute.mock.calls[0]![0 as never]).toMatchObject({ confirm_paid: true, guard: { page_node_id: 'page', page_version: 3 } });
});
