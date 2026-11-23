import { it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, act } from '@testing-library/react';

vi.mock('../../src/chat/Chat.js', () => ({ Chat: () => null }));
import { ChatPane } from '../../src/chat/ChatPane.js';
import type { DocScope } from '../../src/engine/doc-scope.js';

function makeDocScope(initialId: string | null): DocScope {
  return {
    current: vi.fn(async () => initialId),
    currentKey: vi.fn(() => initialId),
    subscribe: () => () => {},
  };
}

const metaA = (id: string, archived = 0) => ({ id, title: id, created_at: '', updated_at: '2', archived });
// An archived-conversation client: list yields one row, get reports it archived.
const archivedClient = () => ({
  list: vi.fn(async () => [metaA('a1', 1)]),
  get: vi.fn(async (id: string) => ({ conversation: metaA(id, 1), messages: [], linked_docs: [], client_state: undefined })),
  save: vi.fn(async () => {}),
  linkToDoc: vi.fn(async () => true),
  unlinkFromDoc: vi.fn(async () => true),
  listForDoc: vi.fn(async () => [] as ReturnType<typeof metaA>[]),
  archive: vi.fn(async () => true),
  unarchive: vi.fn(async () => true),
  remove: vi.fn(async () => true),
  setState: vi.fn(async () => true),
});

const boardClient = {
  list: vi.fn(async () => []), get: vi.fn(async () => null), save: vi.fn(async () => ({ id: 'b1' })),
  remove: vi.fn(async () => true), linkToDoc: vi.fn(async () => true), unlinkFromDoc: vi.fn(async () => true),
  listForDoc: vi.fn(async () => []),
} as never;
const contextHolder = { boardOn: true } as never;
const newBoardName = () => 'Board';
const searchNodes = async () => [];
const resolveNodes = async (ids: string[]) => ids.map((id) => ({ id, title: id, type: '' }));
// Model-picker plumbing (Task 8); these unarchive/attach tests don't exercise the picker.
const keys = { fireworks: 'fw-key', anthropic: '' };
const settingsClient = {
  effective: vi.fn(async () => ({ settings: { defaultModel: '[[Test Model]]', maxSteps: 6 }, catalog: [] as never[] })),
  resolvedDefault: vi.fn(async () => ({ title: 'Test Model', provider: 'fireworks' as const, model: 'accounts/fireworks/models/test', enabled: true })),
};

function renderPane(client: ReturnType<typeof archivedClient>, docScope: DocScope) {
  return render(<ChatPane client={client as never} transport={{} as never} docScope={docScope}
    boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName}
    searchNodes={searchNodes} resolveNodes={resolveNodes}
    settingsClient={settingsClient as never} keys={keys} onModelRefChange={() => {}} generateTitle={async () => true} />);
}

beforeEach(() => { vi.clearAllMocks(); });

/** Open the ⋯ conversation-actions menu (the action buttons live inside it now). */
function openMenu(r: ReturnType<typeof renderPane>): void {
  fireEvent.click(r.getByRole('button', { name: /conversation actions/i }));
}

it('opening an archived conversation shows unarchive + attach, not archive', async () => {
  // No active note (currentKey null) so follow can't anchor → the most-recent (archived a1) opens.
  const r = renderPane(archivedClient(), makeDocScope(null));
  openMenu(r);
  await waitFor(() => expect(r.getByRole('menuitem', { name: /unarchive/i })).toBeTruthy());
  expect(r.getByRole('menuitem', { name: /attach to this note/i })).toBeTruthy();
  expect(r.queryByRole('menuitem', { name: /archive \(start fresh\)/i })).toBeNull();
});

it('unarchive calls client.unarchive and swaps back to the archive button', async () => {
  const client = archivedClient();
  const r = renderPane(client, makeDocScope(null)); // most-recent (archived a1) opens on mount
  openMenu(r);
  await waitFor(() => expect(r.getByRole('menuitem', { name: /unarchive/i })).toBeTruthy());
  fireEvent.click(r.getByRole('menuitem', { name: /unarchive/i })); // also closes the menu
  await waitFor(() => expect(client.unarchive).toHaveBeenCalledWith('a1'));
  openMenu(r); // re-open: the menu now offers the archive action again
  await waitFor(() => expect(r.getByRole('menuitem', { name: /archive \(start fresh\)/i })).toBeTruthy());
});

it('attach links to the active note AND auto-unarchives', async () => {
  const client = archivedClient();
  // Isolate the attach path: no active *file* (currentKey null) so the most-recent archived a1 opens
  // on mount without doc-follow anchoring, while current() still resolves a node for attach to target.
  const docScope: DocScope = { current: vi.fn(async () => 'node-1'), currentKey: vi.fn(() => null), subscribe: () => () => {} };
  const r = renderPane(client, docScope);
  openMenu(r);
  await waitFor(() => expect(r.getByRole('menuitem', { name: /attach to this note/i })).toBeTruthy());
  fireEvent.click(r.getByRole('menuitem', { name: /attach to this note/i }));
  await waitFor(() => expect(client.linkToDoc).toHaveBeenCalledWith('a1', 'node-1'));
  await waitFor(() => expect(client.unarchive).toHaveBeenCalledWith('a1'));
});

it('attach with no active note is a no-op (no link, no unarchive)', async () => {
  const client = archivedClient();
  const r = renderPane(client, makeDocScope(null));
  openMenu(r);
  await waitFor(() => expect(r.getByRole('menuitem', { name: /attach to this note/i })).toBeTruthy());
  // Awaited act flushes the click handler's async chain (matches doc-anchor.test.tsx);
  // docScope.current() resolves null, so the handler returns before any engine call.
  await act(async () => { fireEvent.click(r.getByRole('menuitem', { name: /attach to this note/i })); });
  expect(client.linkToDoc).not.toHaveBeenCalled();
  expect(client.unarchive).not.toHaveBeenCalled();
});
