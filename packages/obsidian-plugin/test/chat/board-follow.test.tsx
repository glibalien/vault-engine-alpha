import { it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act, fireEvent } from '@testing-library/react';

vi.mock('../../src/chat/Chat.js', () => ({ Chat: () => null }));
import { ChatPane } from '../../src/chat/ChatPane.js';
import type { DocScope } from '../../src/engine/doc-scope.js';

/** A fake DocScope with a settable current node id and a manual change trigger. */
function makeDocScope(initialId: string | null): DocScope & { fire(id: string | null): void } {
  let id = initialId;
  // Multiple subscribers (board-follow + conversation-follow both subscribe), like the real
  // workspace-event DocScope — a single-cb fake would let the later subscribe clobber the earlier.
  const cbs = new Set<() => void>();
  return {
    current: vi.fn(async () => id),
    currentKey: vi.fn(() => id),
    subscribe: (fn: () => void) => { cbs.add(fn); return () => { cbs.delete(fn); }; },
    fire(next: string | null) { id = next; cbs.forEach((cb) => cb()); },
  };
}

const conv = (id: string) => ({ id, title: id, created_at: '', updated_at: '2', archived: 0 });
const convClient = () => ({
  list: vi.fn(async () => [] as ReturnType<typeof conv>[]),
  get: vi.fn(async (id: string) => ({ conversation: conv(id), messages: [], linked_docs: [], client_state: undefined })),
  save: vi.fn(async () => {}),
  setState: vi.fn(async () => true),
  linkToDoc: vi.fn(async () => true),
  unlinkFromDoc: vi.fn(async () => true),
  listForDoc: vi.fn(async () => [] as ReturnType<typeof conv>[]),
  archive: vi.fn(async () => true),
  unarchive: vi.fn(async () => true),
  remove: vi.fn(async () => true),
});

const board = (id: string, updated_at: number) => ({ id, name: id, updated_at, card_count: 0 });
/** Board client whose listForDoc returns a different board per doc node id. */
function boardClientFor(map: Record<string, ReturnType<typeof board>[]>) {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    save: vi.fn(async () => ({ id: 'b1' })),
    remove: vi.fn(async () => true),
    linkToDoc: vi.fn(async () => true),
    unlinkFromDoc: vi.fn(async () => true),
    listForDoc: vi.fn(async (nodeId: string) => map[nodeId] ?? []),
  };
}

const newBoardName = () => 'Board';
const searchNodes = async () => [];
const resolveNodes = async (ids: string[]) => ids.map((id) => ({ id, title: id, type: '' }));
// Model-picker plumbing (Task 8); these board-follow tests don't exercise the picker.
const keys = { fireworks: 'fw-key', anthropic: '' };
const settingsClient = {
  effective: vi.fn(async () => ({ settings: { defaultModel: '[[Test Model]]', maxSteps: 6 }, catalog: [] as never[] })),
  resolvedDefault: vi.fn(async () => ({ title: 'Test Model', provider: 'fireworks' as const, model: 'accounts/fireworks/models/test', enabled: true })),
};

beforeEach(() => { vi.clearAllMocks(); });

it('follow ON (default): the board tracks the active note on a doc change', async () => {
  const docScope = makeDocScope('node-a');
  const contextHolder: { activeBoardId?: string } = {};
  const boardClient = boardClientFor({ 'node-a': [board('ba', 1)], 'node-b': [board('bb', 1)] });
  render(<ChatPane client={convClient() as never} transport={{} as never} docScope={docScope} boardClient={boardClient as never} contextHolder={contextHolder as never} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={() => {}} generateTitle={async () => true} />);

  // Initial resolution → node-a's most-recent board.
  await waitFor(() => expect(contextHolder.activeBoardId).toBe('ba'));

  // Switch the active note → the board follows to node-b's board.
  await act(async () => { docScope.fire('node-b'); });
  await waitFor(() => expect(contextHolder.activeBoardId).toBe('bb'));
});

it('follow OFF: the board is frozen when the active note changes', async () => {
  const docScope = makeDocScope('node-a');
  const contextHolder: { activeBoardId?: string } = {};
  const boardClient = boardClientFor({ 'node-a': [board('ba', 1)], 'node-b': [board('bb', 1)] });
  const { getByRole } = render(<ChatPane client={convClient() as never} transport={{} as never} docScope={docScope} boardClient={boardClient as never} contextHolder={contextHolder as never} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={() => {}} generateTitle={async () => true} />);

  await waitFor(() => expect(contextHolder.activeBoardId).toBe('ba'));

  // Freeze: turn the board-follow toggle off (distinct from the conversation 'follow active note' toggle).
  fireEvent.click(getByRole('button', { name: /follow active note.s board/i }));

  await act(async () => { docScope.fire('node-b'); });
  // The note's boards reloaded, but the resolved board stays frozen on the prior selection.
  await waitFor(() => expect(boardClient.listForDoc).toHaveBeenCalledWith('node-b'));
  expect(contextHolder.activeBoardId).toBe('ba');
});
