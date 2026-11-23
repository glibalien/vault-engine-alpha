import { it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act, fireEvent } from '@testing-library/react';

let chatProps: { conversationId?: string } = {};
vi.mock('../../src/chat/Chat.js', () => ({ Chat: (p: never) => { chatProps = p; return null; } }));
import { ChatPane } from '../../src/chat/ChatPane.js';
import type { DocScope } from '../../src/engine/doc-scope.js';

/** A fake DocScope with a settable current node id and a manual change trigger. */
function makeDocScope(initialId: string | null): DocScope & { fire(id: string | null): void } {
  let id = initialId;
  let cb: (() => void) | null = null;
  return {
    current: vi.fn(async () => id),
    currentKey: vi.fn(() => id),
    subscribe: (fn: () => void) => { cb = fn; return () => { cb = null; }; },
    fire(next: string | null) { id = next; cb?.(); },
  };
}

const meta = (id: string) => ({ id, title: id, created_at: '', updated_at: '2', archived: 0 });
const baseClient = () => ({
  list: vi.fn(async () => [] as ReturnType<typeof meta>[]),
  get: vi.fn(async (id: string) => ({ conversation: meta(id), messages: [], linked_docs: [] })),
  save: vi.fn(async () => {}),
  linkToDoc: vi.fn(async () => true),
  unlinkFromDoc: vi.fn(async () => true),
  listForDoc: vi.fn(async (_nodeId: string) => [] as ReturnType<typeof meta>[]),
  archive: vi.fn(async () => true),
  remove: vi.fn(async () => true),
});

// Board-context props added by the board-context-chip feature; these doc-anchor
// tests don't exercise the board chip, so minimal no-op fakes suffice.
const boardClient = {
  list: vi.fn(async () => []),
  get: vi.fn(async () => null),
  save: vi.fn(async () => ({ id: 'b1' })),
  remove: vi.fn(async () => true),
  linkToDoc: vi.fn(async () => true),
  unlinkFromDoc: vi.fn(async () => true),
  listForDoc: vi.fn(async () => []),
} as never;
const contextHolder = { boardOn: true } as never;
const newBoardName = () => 'Board';
const searchNodes = async () => [];
const resolveNodes = async (ids: string[]) => ids.map((id) => ({ id, title: id, type: '' }));
// Model-picker plumbing (Task 8); these doc-anchor tests don't exercise the picker.
const keys = { fireworks: 'fw-key', anthropic: '' };
const settingsClient = {
  effective: vi.fn(async () => ({ settings: { defaultModel: '[[Test Model]]', maxSteps: 6 }, catalog: [] as never[] })),
  resolvedDefault: vi.fn(async () => ({ title: 'Test Model', provider: 'fireworks' as const, model: 'accounts/fireworks/models/test', enabled: true })),
};

beforeEach(() => { chatProps = {}; vi.clearAllMocks(); });

it('follow is ON by default: on mount it anchors to the active note\'s linked conversation', async () => {
  const docScope = makeDocScope('node-x');
  const client = baseClient();
  client.listForDoc.mockResolvedValue([meta('linked-x')]);
  render(<ChatPane client={client as never} transport={{} as never} docScope={docScope} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={() => {}} generateTitle={async () => true} />);
  await waitFor(() => expect(client.listForDoc).toHaveBeenCalledWith('node-x'));
  await waitFor(() => expect(chatProps.conversationId).toBe('linked-x'));
});

it('while following, a doc change opens the new note\'s linked conversation', async () => {
  const docScope = makeDocScope('node-x');
  const client = baseClient();
  client.listForDoc.mockImplementation(async (id: string) => (id === 'node-y' ? [meta('linked-y')] : [meta('linked-x')]));
  render(<ChatPane client={client as never} transport={{} as never} docScope={docScope} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={() => {}} generateTitle={async () => true} />);
  await waitFor(() => expect(chatProps.conversationId).toBe('linked-x')); // mount-anchored
  await act(async () => { docScope.fire('node-y'); });
  await waitFor(() => expect(chatProps.conversationId).toBe('linked-y'));
});

it('with follow toggled OFF, a later doc change does NOT switch conversation', async () => {
  const docScope = makeDocScope('node-x');
  const client = baseClient();
  client.listForDoc.mockImplementation(async (id: string) => (id === 'node-y' ? [meta('linked-y')] : [meta('linked-x')]));
  const { getByRole } = render(<ChatPane client={client as never} transport={{} as never} docScope={docScope} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={() => {}} generateTitle={async () => true} />);
  await waitFor(() => expect(chatProps.conversationId).toBe('linked-x')); // mount-anchored
  fireEvent.click(getByRole('button', { name: 'follow active note' })); // freeze
  client.listForDoc.mockClear();
  await act(async () => { docScope.fire('node-y'); });
  expect(client.listForDoc).not.toHaveBeenCalled();
  expect(chatProps.conversationId).toBe('linked-x');
});

it('open-this-note with no linked conversation starts a fresh one (pending link)', async () => {
  const docScope = makeDocScope('node-y');
  const client = baseClient();
  client.listForDoc.mockResolvedValue([]); // none linked yet
  const { getByRole } = render(<ChatPane client={client as never} transport={{} as never} docScope={docScope} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={() => {}} generateTitle={async () => true} />);
  await waitFor(() => expect(chatProps.conversationId).toBeTypeOf('string'));
  const before = chatProps.conversationId;
  fireEvent.click(getByRole('button', { name: /conversation actions/i })); // open ⋯ menu
  fireEvent.click(getByRole('menuitem', { name: /open this note/i }));
  await waitFor(() => expect(client.listForDoc).toHaveBeenCalledWith('node-y'));
  await waitFor(() => expect(chatProps.conversationId).not.toBe(before)); // a new conversation id
});

it('settle→link: new doc-anchored conversation calls linkToDoc once after first settle', async () => {
  const docScope = makeDocScope('node-y');
  const client = baseClient();
  client.listForDoc.mockResolvedValue([]); // no linked conversation yet
  const { getByRole } = render(<ChatPane client={client as never} transport={{} as never} docScope={docScope} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={() => {}} generateTitle={async () => true} />);
  await waitFor(() => expect(chatProps.conversationId).toBeTypeOf('string'));
  const before = chatProps.conversationId;

  // Trigger "open this note's conversation" — starts a fresh conversation with pendingDocLink set.
  fireEvent.click(getByRole('button', { name: /conversation actions/i })); // open ⋯ menu
  fireEvent.click(getByRole('menuitem', { name: /open this note/i }));
  await waitFor(() => expect(client.listForDoc).toHaveBeenCalledWith('node-y'));
  await waitFor(() => expect(chatProps.conversationId).not.toBe(before));
  const newId = chatProps.conversationId as string;

  // Drive the first settle: save persists the row, then linkToDoc should be called.
  const settled = await act(async () => {
    await (chatProps as { onSettled?: (m: unknown[]) => void }).onSettled?.([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ]);
  });
  void settled; // act returns undefined; discard

  expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ id: newId }));
  expect(client.linkToDoc).toHaveBeenCalledWith(newId, 'node-y');
  expect(client.linkToDoc).toHaveBeenCalledTimes(1);

  // Drive a second settle — pendingDocLink should be cleared, so linkToDoc is NOT called again.
  await act(async () => {
    await (chatProps as { onSettled?: (m: unknown[]) => void }).onSettled?.([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  expect(client.linkToDoc).toHaveBeenCalledTimes(1); // still exactly once
});
