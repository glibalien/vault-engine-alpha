import { it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act, fireEvent } from '@testing-library/react';

vi.mock('../../src/chat/Chat.js', () => ({ Chat: () => null }));
import { ChatPane } from '../../src/chat/ChatPane.js';
import type { ChatContextHolder } from '../../src/chat/context-state.js';
import type { DocScope } from '../../src/engine/doc-scope.js';

/** Fake DocScope with separate path (currentKey) and node id (current), like the real one. */
export function makeDocScope(initial: { path: string; id: string | null } | null): DocScope & { fire(next: { path: string; id: string | null } | null): void } {
  let cur = initial;
  const cbs = new Set<() => void>();
  return {
    current: vi.fn(async () => cur?.id ?? null),
    currentKey: vi.fn(() => cur?.path ?? null),
    subscribe: (fn: () => void) => { cbs.add(fn); return () => { cbs.delete(fn); }; },
    fire(next) { cur = next; cbs.forEach((cb) => cb()); },
  };
}

const conv = (id: string) => ({ id, title: id, created_at: '', updated_at: '2', archived: 0 });
export function convClient(clientState?: unknown) {
  return {
    list: vi.fn(async () => [conv('c1')]),
    get: vi.fn(async (id: string) => ({ conversation: conv(id), messages: [], linked_docs: [], client_state: clientState })),
    save: vi.fn(async () => {}),
    setState: vi.fn(async () => true),
    linkToDoc: vi.fn(async () => true),
    unlinkFromDoc: vi.fn(async () => true),
    listForDoc: vi.fn(async () => [] as ReturnType<typeof conv>[]),
    archive: vi.fn(async () => true),
    unarchive: vi.fn(async () => true),
    remove: vi.fn(async () => true),
  };
}
const boardClient = () => ({
  list: vi.fn(async () => []), get: vi.fn(async () => null), save: vi.fn(async () => ({ id: 'b1' })),
  remove: vi.fn(async () => true), linkToDoc: vi.fn(async () => true), unlinkFromDoc: vi.fn(async () => true),
  listForDoc: vi.fn(async () => []),
});

const searchNodes = async () => [];
const resolveNodes = async (ids: string[]) => ids.map((id) => ({ id, title: id, type: '' }));
// Model-picker plumbing (Task 8); these doc-context tests don't exercise the picker.
const keys = { fireworks: 'fw-key', anthropic: '' };
const settingsClient = {
  effective: vi.fn(async () => ({ settings: { defaultModel: '[[Test Model]]', maxSteps: 6 }, catalog: [] as never[] })),
  resolvedDefault: vi.fn(async () => ({ title: 'Test Model', provider: 'fireworks' as const, model: 'accounts/fireworks/models/test', enabled: true })),
};

export function renderPane(opts: { docScope: DocScope; client?: ReturnType<typeof convClient> }) {
  const contextHolder: ChatContextHolder = { docEnabled: true };
  const client = opts.client ?? convClient();
  const utils = render(<ChatPane client={client as never} transport={{} as never} docScope={opts.docScope} boardClient={boardClient() as never} contextHolder={contextHolder} newBoardName={() => 'Board'} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={() => {}} generateTitle={async () => true} />);
  return { ...utils, contextHolder, client };
}

beforeEach(() => { vi.clearAllMocks(); });

it('tracks the active doc into the holder (path + node id) and follows changes', async () => {
  const docScope = makeDocScope({ path: 'Notes/A.md', id: 'na' });
  const { contextHolder } = renderPane({ docScope });
  await waitFor(() => expect(contextHolder.docPath).toBe('Notes/A.md'));
  await waitFor(() => expect(contextHolder.docId).toBe('na'));
  await act(async () => { docScope.fire({ path: 'Notes/B.md', id: 'nb' }); });
  await waitFor(() => expect(contextHolder.docPath).toBe('Notes/B.md'));
  await waitFor(() => expect(contextHolder.docId).toBe('nb'));
});

it('keeps the last known doc on a null active-file event (chat pane focus)', async () => {
  const docScope = makeDocScope({ path: 'Notes/A.md', id: 'na' });
  const { contextHolder } = renderPane({ docScope });
  await waitFor(() => expect(contextHolder.docPath).toBe('Notes/A.md'));
  await act(async () => { docScope.fire(null); });
  expect(contextHolder.docPath).toBe('Notes/A.md');
  expect(contextHolder.docId).toBe('na');
});

it('does not let a slow stale-doc lookup overwrite a newer path/id pairing (race guard)', async () => {
  // Note A is a cache MISS: current() hangs until resolveA() below. Note B is a cache HIT:
  // current() resolves instantly. Gate ALL current() calls made while note A is active on a
  // shared pending list, since other effects (loadDocBoards, follow) also call current().
  let cur: { path: string; id: string | null } | null = { path: 'Notes/A.md', id: null };
  const cbs = new Set<() => void>();
  const pendingA: Array<(id: string | null) => void> = [];
  const docScope: DocScope & { fire(next: { path: string; id: string | null } | null): void } = {
    current: vi.fn(async () => {
      if (cur?.path === 'Notes/A.md') return new Promise<string | null>((res) => { pendingA.push(res); });
      return cur?.id ?? null;
    }),
    currentKey: vi.fn(() => cur?.path ?? null),
    subscribe: (fn: () => void) => { cbs.add(fn); return () => { cbs.delete(fn); }; },
    fire(next) { cur = next; cbs.forEach((cb) => cb()); },
  };
  const { contextHolder } = renderPane({ docScope });
  await waitFor(() => expect(contextHolder.docPath).toBe('Notes/A.md'));
  expect(contextHolder.docId).toBeUndefined(); // A's lookup is still in flight
  // Switch to B — cache hit, instant.
  await act(async () => { docScope.fire({ path: 'Notes/B.md', id: 'nb' }); });
  await waitFor(() => expect(contextHolder.docPath).toBe('Notes/B.md'));
  await waitFor(() => expect(contextHolder.docId).toBe('nb'));
  // Now A's slow lookup resolves LAST — it must not overwrite B's pairing.
  await act(async () => { pendingA.forEach((res) => res('na')); });
  expect(contextHolder.docId).toBe('nb');
  expect(contextHolder.docPath).toBe('Notes/B.md');
});

it('hydrates the doc chip from client_state on open (doc:false → disabled)', async () => {
  // No active note → the mount effect opens list[0] (c1) via openConversation.
  const docScope = makeDocScope(null);
  const { contextHolder, queryByRole } = renderPane({ docScope, client: convClient({ doc: false }) });
  await waitFor(() => expect(contextHolder.docEnabled).toBe(false));
  // No doc known → no doc chip rendered (ContextChipsBar gates the whole chip row on docPath).
  expect(queryByRole('button', { name: 'A' })).toBeNull();
});

it('resets the chip ON for a fresh conversation (follow to an unlinked note)', async () => {
  const docScope = makeDocScope(null);
  const client = convClient({ doc: false });
  const { contextHolder } = renderPane({ docScope, client });
  await waitFor(() => expect(contextHolder.docEnabled).toBe(false));
  // Follow to a note with no linked conversations → newConversation → default ON.
  await act(async () => { docScope.fire({ path: 'Notes/New.md', id: 'nn' }); });
  await waitFor(() => expect(contextHolder.docEnabled).toBe(true));
});

it('renders the doc chip and persists a toggle read-modify-write', async () => {
  const docScope = makeDocScope({ path: 'Notes/Quarterly Planning.md', id: 'nq' });
  const client = convClient({ board: false, activeBoardId: 'b9' });
  const { contextHolder, getByRole } = renderPane({ docScope, client });
  // The chip itself carries the doc's name (basename, no .md) — it must be obvious what joins the context.
  const chip = await waitFor(() => getByRole('button', { name: 'Quarterly Planning' }));
  expect(chip.classList.contains('ctx-chip-doc')).toBe(true);
  expect(chip.classList.contains('on')).toBe(true);
  fireEvent.click(chip);
  // RMW: doc flips, web-managed board/activeBoardId/nodes preserved verbatim.
  await waitFor(() => expect(client.setState).toHaveBeenCalledWith(expect.any(String), { doc: false, board: false, nodes: [], activeBoardId: 'b9' }));
  expect(contextHolder.docEnabled).toBe(false);
  await waitFor(() => expect(chip.classList.contains('on')).toBe(false));
});

it('reverts the chip when persistence fails', async () => {
  const docScope = makeDocScope({ path: 'Notes/A.md', id: 'na' });
  const client = convClient();
  client.setState = vi.fn(async () => { throw new Error('boom'); });
  const { contextHolder, getByRole } = renderPane({ docScope, client });
  const chip = await waitFor(() => getByRole('button', { name: 'A' }));
  fireEvent.click(chip);
  await waitFor(() => expect(client.setState).toHaveBeenCalled());
  await waitFor(() => expect(contextHolder.docEnabled).toBe(true)); // reverted
  await waitFor(() => expect(chip.classList.contains('on')).toBe(true));
});

it('reverts the chip when the engine reports ok:false (setState resolves false, not throws)', async () => {
  const docScope = makeDocScope({ path: 'Notes/A.md', id: 'na' });
  const client = convClient();
  client.setState = vi.fn(async () => false);
  const { contextHolder, getByRole } = renderPane({ docScope, client });
  const chip = await waitFor(() => getByRole('button', { name: 'A' }));
  fireEvent.click(chip);
  await waitFor(() => expect(client.setState).toHaveBeenCalled());
  await waitFor(() => expect(contextHolder.docEnabled).toBe(true)); // reverted
  await waitFor(() => expect(chip.classList.contains('on')).toBe(true));
});

it('a failed persist does not clobber another conversation opened mid-flight', async () => {
  const docScope = makeDocScope({ path: 'Notes/A.md', id: 'na' });
  const client = convClient();
  // Note B's conversation (c2) hydrates to doc:false — DIFFERENT from the stale toggle's
  // revert value (true), so a misdirected revert is detectable as a flip back to true.
  client.get = vi.fn(async (id: string) => ({ conversation: conv(id), messages: [], linked_docs: [], client_state: id === 'c2' ? { doc: false } : undefined }));
  let rejectSetState!: (err: unknown) => void;
  client.setState = vi.fn(() => new Promise<boolean>((_, rej) => { rejectSetState = rej; }));
  const { contextHolder, getByRole } = renderPane({ docScope, client });
  const chip = await waitFor(() => getByRole('button', { name: 'A' }));
  fireEvent.click(chip); // optimistic flip to false; the persist hangs
  await waitFor(() => expect(client.setState).toHaveBeenCalled());
  // Switch notes mid-flight: follow opens B's linked conversation c2 (hydrates doc:false).
  client.listForDoc = vi.fn(async () => [conv('c2')]);
  await act(async () => { docScope.fire({ path: 'Notes/B.md', id: 'nb' }); });
  await waitFor(() => expect(client.get).toHaveBeenCalledWith('c2'));
  await waitFor(() => expect(contextHolder.docEnabled).toBe(false));
  // The stale toggle's persist now fails — its revert must NOT touch c2's chip.
  await act(async () => { rejectSetState(new Error('boom')); });
  expect(contextHolder.docEnabled).toBe(false);
  expect(chip.classList.contains('on')).toBe(false);
});
