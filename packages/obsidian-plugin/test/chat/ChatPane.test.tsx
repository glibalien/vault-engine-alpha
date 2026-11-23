import { it, expect, vi, beforeEach, describe } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import type { DocScope } from '../../src/engine/doc-scope.js';

// Capture the Chat props so the test can drive onSettled + assert conversationId.
let chatProps: {
  conversationId?: string;
  initialMessages?: unknown[];
  onSettled?: (m: unknown[]) => void;
  onAddNodeChip?: (c: { id: string; title: string; type?: string }) => void;
  onPinToBoard?: (spec: unknown) => void;
  modelPicker?: {
    items: Array<{ title: string; provider: string; available: boolean; unpriced?: boolean }>;
    selected: string | null;
    defaultTitle: string;
    onSelect: (title: string | null) => void;
  };
} = {};
vi.mock('../../src/chat/Chat.js', () => ({ Chat: (p: never) => { chatProps = p; return null; } }));
// Capture the switcher props so the test can flip "follow active note" etc.
let switcherProps: { followActive?: boolean; onToggleFollow?: () => void; onOpenNoteConversation?: () => void; onNew?: () => void } = {};
// Capture the context-bar props so a test can invoke onToggleDoc directly (its "doc" button only
// renders once a docPath is set, which most tests here don't exercise).
let ctxBarProps: { onToggleDoc?: () => void } = {};
vi.mock('@vault/chat-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vault/chat-ui')>();
  return {
    ...actual,
    ConversationSwitcher: (p: never) => { switcherProps = p; return null; },
    ContextChipsBar: (p: never) => { ctxBarProps = p; return null; },
  };
});
import { ChatPane } from '../../src/chat/ChatPane.js';
import { BoardSync } from '../../src/boards/board-sync.js';
import type { BoardCard } from '@vault/board-core';

function fakeClient(over: Partial<Record<string, unknown>> = {}) {
  return {
    list: vi.fn(async () => [{ id: 'c1', title: 'first', created_at: '', updated_at: '2', archived: 0 }]),
    get: vi.fn(async (id: string) => ({ conversation: { id, title: 'first', created_at: '', updated_at: '2', archived: 0 }, messages: [{ id: 'm', role: 'user', parts: [] }], linked_docs: [] })),
    save: vi.fn(async () => {}),
    setState: vi.fn(async () => true),
    linkToDoc: vi.fn(async () => true),
    unlinkFromDoc: vi.fn(async () => true),
    listForDoc: vi.fn(async () => []),
    archive: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    ...over,
  };
}

/**
 * Fake DocScope. The active doc has two independent facets: a stable host key
 * (the active file path — null only when there is no active note at all) and a
 * resolved engine node id (null when the note isn't an engine node yet). `fire`
 * simulates an active-leaf-change.
 */
function makeDocScope(initial: { key: string | null; nodeId: string | null }) {
  let state = initial;
  let cb: (() => void) | null = null;
  return {
    current: vi.fn(async () => state.nodeId),
    currentKey: vi.fn(() => state.key),
    subscribe: vi.fn((fn: () => void) => { cb = fn; return () => { cb = null; }; }),
    fire(next: { key: string | null; nodeId: string | null }) { state = next; cb?.(); },
  } as DocScope & { fire(next: { key: string | null; nodeId: string | null }): void };
}

const docScope = { current: vi.fn(async () => null), currentKey: () => null, subscribe: vi.fn(() => () => {}) };
const tx = {} as never;
// Board-context props added by the board-context-chip feature; these tests don't
// exercise the board chip, so minimal no-op fakes keep them focused on conversations.
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

// Model-picker plumbing (Task 8). Most tests below don't exercise the picker — a minimal
// one-entry catalog keeps them focused on conversation/context-bar behavior.
const keys = { fireworks: 'fw-key', anthropic: '' };
const settingsClient = {
  effective: vi.fn(async () => ({
    settings: { defaultModel: '[[Test Model]]', maxSteps: 6 },
    catalog: [{ title: 'Test Model', provider: 'fireworks' as const, model: 'accounts/fireworks/models/test', enabled: true }],
  })),
  resolvedDefault: vi.fn(async () => ({ title: 'Test Model', provider: 'fireworks' as const, model: 'accounts/fireworks/models/test', enabled: true })),
};
const onModelRefChange = vi.fn();

// Fake title flow (Task 8): mirrors chat-core's runTitleFlow contract without a real LLM
// call — mechanical-fallback-only, deterministic. A null fallbackTitle (shouldn't occur in
// these fixtures, which always carry a non-empty first user message) reports failure.
const generateTitle = vi.fn(async (opts: { fallbackTitle: string | null; saveTitle: (title: string) => Promise<void> }) => {
  if (opts.fallbackTitle === null) return false;
  await opts.saveTitle(opts.fallbackTitle);
  return true;
});

// Richer catalog for the dedicated picker tests below: an anthropic entry (unavailable — no
// local key), a disabled entry (must be excluded), an entry @vault/pricing has no rate row
// for (unpriced), and an OpenRouter entry the static table can't know but whose Settings/Models
// note carries price frontmatter (priced via the frontmatter-first chain).
const pickerCatalog = [
  { title: 'Qwen 3.7 Plus', provider: 'fireworks' as const, model: 'accounts/fireworks/models/qwen3p7-plus', enabled: true },
  { title: 'Claude Sonnet 4.6', provider: 'anthropic' as const, model: 'claude-sonnet-4-6', enabled: true },
  { title: 'Disabled Model', provider: 'fireworks' as const, model: 'accounts/fireworks/models/disabled', enabled: false },
  { title: 'Mystery Model', provider: 'fireworks' as const, model: 'accounts/fireworks/models/mystery-9000', enabled: true },
  { title: 'GLM 5.2', provider: 'openrouter' as const, model: 'z-ai/glm-5.2', enabled: true, pricing: { input: 0.7672, output: 2.4112, cacheRead: 0.14248 } },
];
const pickerKeys = { fireworks: 'fw-key', anthropic: '', openrouter: 'or-key' }; // anthropic NOT configured on this surface
function makePickerSettingsClient() {
  return {
    effective: vi.fn(async () => ({ settings: { defaultModel: '[[Qwen 3.7 Plus]]', maxSteps: 6 }, catalog: pickerCatalog })),
    resolvedDefault: vi.fn(async () => pickerCatalog[0]!),
  };
}

beforeEach(() => { chatProps = {}; switcherProps = {}; ctxBarProps = {}; onModelRefChange.mockClear(); generateTitle.mockClear(); });

it('conversation follow defaults ON (parity with vault-chat web)', async () => {
  const client = fakeClient();
  render(<ChatPane client={client as never} transport={tx} docScope={docScope as never} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);
  await waitFor(() => expect(switcherProps.followActive).toBe(true));
});

it('with no active note, on mount loads the most-recent conversation + its messages', async () => {
  // docScope has no active note (currentKey null), so follow can't anchor → open the most-recent.
  const client = fakeClient();
  render(<ChatPane client={client as never} transport={tx} docScope={docScope as never} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);
  await waitFor(() => expect(chatProps.conversationId).toBe('c1'));
  await waitFor(() => expect(chatProps.initialMessages).toHaveLength(1));
  expect(client.get).toHaveBeenCalledWith('c1');
});

it('a placeholder-titled conversation still gets its derived title on the next settle', async () => {
  // c1 carries the engine default placeholder ('New chat') — opening it must leave the title
  // guard off so the first real turn kicks off the (here, fallback-only) titling flow, which
  // lands via its own async saveTitle call — a SEPARATE client.save from the message save.
  const client = fakeClient({
    get: vi.fn(async (id: string) => ({ conversation: { id, title: 'New chat', created_at: '', updated_at: '2', archived: 0 }, messages: [], linked_docs: [] })),
  });
  render(<ChatPane client={client as never} transport={tx} docScope={docScope as never} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);
  // Wait for the conversation to RESOLVE, not merely for onSettled to exist: settling
  // before mount picks up c1 saves against the wrong id and the assertions below miss.
  await waitFor(() => expect(chatProps.conversationId).toBe('c1'));
  await waitFor(() => expect(chatProps.onSettled).toBeTypeOf('function'));
  await act(async () => { chatProps.onSettled!([{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'Plan my week please' }] }]); });
  // Message save first, title-only save once the (async) titling flow resolves.
  expect(client.save).toHaveBeenCalledWith({ id: 'c1', messages: expect.any(Array) });
  await waitFor(() => expect(client.save).toHaveBeenCalledWith({ id: 'c1', title: expect.stringContaining('Plan my week') }));
  expect(generateTitle).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c1', fallbackTitle: expect.stringContaining('Plan my week') }));
});

it('reopening a conversation that already has a real title does NOT re-send a title on settle', async () => {
  // c1 carries a real, non-placeholder title ('first'). Continuing it (even from another surface
  // that re-derives a different/shorter title) must not clobber the stored title: the titling
  // flow is never even invoked, and the message save carries no title.
  const client = fakeClient();
  render(<ChatPane client={client as never} transport={tx} docScope={docScope as never} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);
  await waitFor(() => expect(chatProps.conversationId).toBe('c1'));
  await waitFor(() => expect(chatProps.onSettled).toBeTypeOf('function'));
  await act(async () => { chatProps.onSettled!([{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'Plan my week please' }] }]); });
  // Saved once, with NO title key at all, so the engine upsert leaves the stored title intact.
  expect(client.save).toHaveBeenCalledWith({ id: 'c1', messages: expect.any(Array) });
  expect(client.save).not.toHaveBeenCalledWith(expect.objectContaining({ title: expect.any(String) }));
  expect(generateTitle).not.toHaveBeenCalled();
});

it('deriveTitle caps the title at 80 chars (byte-identical to vault-chat web)', async () => {
  // Placeholder-titled so the title derives; a >80-char first message must be truncated to 80,
  // matching web's history.ts deriveTitle so a shared conversation never re-titles on reopen.
  const client = fakeClient({
    get: vi.fn(async (id: string) => ({ conversation: { id, title: 'New conversation', created_at: '', updated_at: '2', archived: 0 }, messages: [], linked_docs: [] })),
  });
  render(<ChatPane client={client as never} transport={tx} docScope={docScope as never} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);
  // Same readiness precondition as above — without it this test was flaky under load.
  await waitFor(() => expect(chatProps.conversationId).toBe('c1'));
  await waitFor(() => expect(chatProps.onSettled).toBeTypeOf('function'));
  const longText = 'x'.repeat(120);
  await act(async () => { chatProps.onSettled!([{ id: 'm', role: 'user', parts: [{ type: 'text', text: longText }] }]); });
  await waitFor(() => expect(client.save).toHaveBeenCalledWith({ id: 'c1', title: 'x'.repeat(80) }));
});

it('follow (default on) → navigating to a note with no node id yields a blank conversation', async () => {
  const client = fakeClient({ listForDoc: vi.fn(async () => []) });
  const scope = makeDocScope({ key: 'a.md', nodeId: 'node-a' });
  render(<ChatPane client={client as never} transport={tx} docScope={scope} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);

  // Mount anchors to node-a; it has no linked conversation → a fresh blank (not the most-recent c1).
  await waitFor(() => expect(chatProps.conversationId).toBeTruthy());
  const mountId = chatProps.conversationId;
  expect(chatProps.initialMessages).toHaveLength(0);

  // Navigate to a brand-new / unindexed note: an active file (key) but no engine node id → no convo.
  await act(async () => { scope.fire({ key: 'b.md', nodeId: null }); });

  await waitFor(() => expect(chatProps.conversationId).not.toBe(mountId));
  expect(chatProps.initialMessages).toHaveLength(0);
});

it('follow (default on) → focus leaving the editor (no active note) keeps the current conversation', async () => {
  const client = fakeClient({ listForDoc: vi.fn(async () => []) });
  const scope = makeDocScope({ key: 'a.md', nodeId: 'node-a' });
  render(<ChatPane client={client as never} transport={tx} docScope={scope} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);
  await waitFor(() => expect(chatProps.conversationId).toBeTruthy());
  const mountId = chatProps.conversationId;

  // No active file (focus moved to the chat pane / a board) — must NOT blank or switch.
  await act(async () => { scope.fire({ key: null, nodeId: null }); });

  expect(chatProps.conversationId).toBe(mountId);
});

it('follow (default on) → the active note\'s linked conversation opens (mount + on navigation)', async () => {
  const client = fakeClient({
    listForDoc: vi.fn(async (id: string) => (id === 'node-b'
      ? [{ id: 'c3', title: 'bconv', created_at: '', updated_at: '3', archived: 0 }]
      : [{ id: 'c2', title: 'aconv', created_at: '', updated_at: '3', archived: 0 }])),
  });
  const scope = makeDocScope({ key: 'a.md', nodeId: 'node-a' });
  render(<ChatPane client={client as never} transport={tx} docScope={scope} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);

  // Mount: node-a's linked conversation is already there (parity: right conversation on open).
  await waitFor(() => expect(chatProps.conversationId).toBe('c2'));
  expect(client.listForDoc).toHaveBeenCalledWith('node-a');

  // Navigate: follows to node-b's linked conversation.
  await act(async () => { scope.fire({ key: 'b.md', nodeId: 'node-b' }); });
  await waitFor(() => expect(chatProps.conversationId).toBe('c3'));
  expect(client.listForDoc).toHaveBeenCalledWith('node-b');
});

it('follow (default on) → a redundant leaf-change for the same note keeps the same blank conversation', async () => {
  const client = fakeClient({ listForDoc: vi.fn(async () => []) });
  const scope = makeDocScope({ key: 'a.md', nodeId: 'node-a' });
  render(<ChatPane client={client as never} transport={tx} docScope={scope} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);
  await waitFor(() => expect(chatProps.conversationId).toBeTruthy());
  const mountId = chatProps.conversationId;

  await act(async () => { scope.fire({ key: 'b.md', nodeId: null }); });
  await waitFor(() => expect(chatProps.conversationId).not.toBe(mountId));
  const blankId = chatProps.conversationId;

  // Same note fires again (e.g. focus the chat pane and click back) — keep the same fresh
  // conversation rather than minting a new one (which would wipe typing).
  await act(async () => { scope.fire({ key: 'b.md', nodeId: null }); });
  expect(chatProps.conversationId).toBe(blankId);
});

it('serializes persistNodes so two rapid node-chip adds do not lose an update to a race', async () => {
  // The mount hydration (openConversation) issues the FIRST client.get. The first add's
  // persistNodes issues the SECOND — deliberately deferred here — to prove the second add's
  // own read never starts until the first add's whole get→setState round-trip has completed.
  let resolveDeferredGet!: (v: { client_state?: unknown }) => void;
  const deferredGet = new Promise<{ client_state?: unknown }>((res) => { resolveDeferredGet = res; });
  let getCalls = 0;
  const client = fakeClient({
    get: vi.fn(async (id: string) => {
      getCalls += 1;
      if (getCalls === 2) return deferredGet;
      return { conversation: { id, title: 'first', created_at: '', updated_at: '2', archived: 0 }, messages: [], linked_docs: [] };
    }),
    setState: vi.fn(async () => true),
  });
  render(<ChatPane client={client as never} transport={tx} docScope={docScope as never} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);
  await waitFor(() => expect(chatProps.onAddNodeChip).toBeTypeOf('function'));

  // Two rapid adds, back to back — mirrors two fast picks from the add-picker.
  act(() => {
    chatProps.onAddNodeChip!({ id: 'n1', title: 'N1', type: 't' });
    chatProps.onAddNodeChip!({ id: 'n2', title: 'N2', type: 't' });
  });

  // The second add must NOT start its own read until the first add's round-trip finishes —
  // only the mount read + the first add's (deferred) read have fired so far.
  await waitFor(() => expect(client.get).toHaveBeenCalledTimes(2));
  expect(client.setState).not.toHaveBeenCalled();

  resolveDeferredGet({ client_state: undefined });

  // Both persists complete, in order: the SECOND (chronologically last) persisted write is the
  // one that must carry BOTH ids — proof the first add's later-finishing write can't clobber it.
  await waitFor(() => expect(client.setState).toHaveBeenCalledTimes(2));
  expect(client.setState).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({ nodes: ['n1'] }));
  expect(client.setState).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({ nodes: ['n1', 'n2'] }));
});

it('serializes onToggleDoc through the same persistQueue as persistNodes, so a node-add then doc-toggle preserve BOTH slices', async () => {
  // A real backing store (setState writes into it, get reads it back) so a stale/racy get would be
  // observable: without routing onToggleDoc through the SAME persistQueue as persistNodes, its
  // get→setState round-trip could start while the node-add's is still in flight and clobber the
  // just-added node id with a pre-add client_state.
  let stored: Record<string, unknown> | undefined;
  let resolveDeferredGet!: (v: { client_state?: unknown }) => void;
  const deferredGet = new Promise<{ client_state?: unknown }>((res) => { resolveDeferredGet = res; });
  let getCalls = 0;
  const client = fakeClient({
    get: vi.fn(async (id: string) => {
      getCalls += 1;
      // The node-add's own get (the 2nd overall, after mount's) is deferred — proves the
      // doc-toggle's get (queued behind it) cannot start, let alone read stale state, until the
      // node-add's whole round-trip (including its setState) has landed.
      if (getCalls === 2) return deferredGet;
      return { conversation: { id, title: 'first', created_at: '', updated_at: '2', archived: 0 }, messages: [], linked_docs: [], client_state: stored };
    }),
    setState: vi.fn(async (_id: string, patch: Record<string, unknown>) => { stored = { ...stored, ...patch }; return true; }),
  });
  render(<ChatPane client={client as never} transport={tx} docScope={docScope as never} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);
  await waitFor(() => expect(chatProps.onAddNodeChip).toBeTypeOf('function'));
  await waitFor(() => expect(ctxBarProps.onToggleDoc).toBeTypeOf('function'));

  // Kick off the node-add first; its persistNodes get() is the deferred one (getCalls === 2).
  act(() => { chatProps.onAddNodeChip!({ id: 'n1', title: 'N1', type: 't' }); });
  await waitFor(() => expect(client.get).toHaveBeenCalledTimes(2)); // mount + the add's (deferred)

  // Now fire the doc-toggle while the add is still in flight — it must queue BEHIND it, not
  // race a get of its own ahead of the add's still-pending write.
  act(() => { ctxBarProps.onToggleDoc!(); });
  expect(client.get).toHaveBeenCalledTimes(2); // the toggle's own get has NOT started yet
  expect(client.setState).not.toHaveBeenCalled();

  resolveDeferredGet({ client_state: undefined });

  // Both persists complete, in order: the SECOND (the doc-toggle's) write must carry BOTH the
  // node id (added first) and the doc flag it set — proof the toggle's read saw the node-add's
  // write rather than clobbering it with a stale/empty nodes list.
  await waitFor(() => expect(client.setState).toHaveBeenCalledTimes(2));
  expect(client.setState).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({ nodes: ['n1'] }));
  expect(client.setState).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({ nodes: ['n1'], doc: false }));
});

describe('model picker (Task 8)', () => {
  it('picker data: enabled-only filtering, provider availability from local keys, unpriced flag, default title', async () => {
    const client = fakeClient();
    const pickerSettingsClient = makePickerSettingsClient();
    render(<ChatPane client={client as never} transport={tx} docScope={docScope as never} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={pickerSettingsClient as never} keys={pickerKeys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);

    await waitFor(() => expect(chatProps.modelPicker?.items.length).toBeGreaterThan(0));
    const items = chatProps.modelPicker!.items;

    // Disabled entry excluded entirely (matches the web endpoint's filter).
    expect(items.find((i) => i.title === 'Disabled Model')).toBeUndefined();
    expect(items).toHaveLength(4);

    // Availability reflects THIS surface's own keys (pickerKeys has no anthropic key).
    expect(items.find((i) => i.title === 'Qwen 3.7 Plus')?.available).toBe(true);
    expect(items.find((i) => i.title === 'Claude Sonnet 4.6')?.available).toBe(false);

    // @vault/pricing has no rate row for the "mystery-9000" model id.
    expect(items.find((i) => i.title === 'Mystery Model')?.unpriced).toBe(true);
    expect(items.find((i) => i.title === 'Qwen 3.7 Plus')?.unpriced).toBe(false);

    // Frontmatter-first chain: the static table has no row for an OpenRouter model id, but the
    // entry's own price frontmatter does — so it must NOT be badged unpriced.
    expect(items.find((i) => i.title === 'GLM 5.2')?.unpriced).toBe(false);

    expect(chatProps.modelPicker?.defaultTitle).toBe('Qwen 3.7 Plus');
  });

  it('hydrates the persisted model override into modelPicker.selected and re-syncs the slot', async () => {
    const pickerSettingsClient = makePickerSettingsClient();
    const client = fakeClient({
      get: vi.fn(async (id: string) => ({
        conversation: { id, title: 'first', created_at: '', updated_at: '2', archived: 0 },
        messages: [], linked_docs: [],
        client_state: { doc: true, board: true, nodes: [], modelRef: 'Claude Sonnet 4.6' },
      })),
    });
    render(<ChatPane client={client as never} transport={tx} docScope={docScope as never} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={pickerSettingsClient as never} keys={pickerKeys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);

    await waitFor(() => expect(chatProps.modelPicker?.selected).toBe('Claude Sonnet 4.6'));
    // The mutable slot (chat-view.ts's turn() reads it fresh per send) is kept in lockstep.
    await waitFor(() => expect(onModelRefChange).toHaveBeenCalledWith('Claude Sonnet 4.6'));
  });

  it('selecting a model persists via setState with the patched blob and updates the slot', async () => {
    const pickerSettingsClient = makePickerSettingsClient();
    const client = fakeClient();
    render(<ChatPane client={client as never} transport={tx} docScope={docScope as never} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={pickerSettingsClient as never} keys={pickerKeys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);

    await waitFor(() => expect(chatProps.modelPicker).toBeTruthy());
    onModelRefChange.mockClear(); // drop the mount/hydration sync call(s) — isolate the selection's own

    await act(async () => { chatProps.modelPicker!.onSelect('Claude Sonnet 4.6'); });

    await waitFor(() => expect(client.setState).toHaveBeenCalledWith('c1', expect.objectContaining({ modelRef: 'Claude Sonnet 4.6' })));
    expect(onModelRefChange).toHaveBeenCalledWith('Claude Sonnet 4.6');
  });

  it('clearing the selection (null) deletes modelRef via patchModelRef, preserving other slices', async () => {
    const pickerSettingsClient = makePickerSettingsClient();
    const client = fakeClient({
      get: vi.fn(async (id: string) => ({
        conversation: { id, title: 'first', created_at: '', updated_at: '2', archived: 0 },
        messages: [], linked_docs: [],
        client_state: { doc: true, board: true, nodes: ['n1'], modelRef: 'Claude Sonnet 4.6' },
      })),
    });
    render(<ChatPane client={client as never} transport={tx} docScope={docScope as never} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={pickerSettingsClient as never} keys={pickerKeys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);

    await waitFor(() => expect(chatProps.modelPicker?.selected).toBe('Claude Sonnet 4.6'));
    onModelRefChange.mockClear();

    await act(async () => { chatProps.modelPicker!.onSelect(null); });

    await waitFor(() => expect(client.setState).toHaveBeenCalled());
    const [, patch] = client.setState.mock.calls[client.setState.mock.calls.length - 1] as unknown as [string, Record<string, unknown>];
    expect(patch).not.toHaveProperty('modelRef');
    expect(patch['nodes']).toEqual(['n1']); // other slices preserved (RMW)
    expect(onModelRefChange).toHaveBeenCalledWith(null);
  });

  it('starting a new conversation resets the model override and re-syncs the slot to null', async () => {
    const pickerSettingsClient = makePickerSettingsClient();
    const client = fakeClient({
      get: vi.fn(async (id: string) => ({
        conversation: { id, title: 'first', created_at: '', updated_at: '2', archived: 0 },
        messages: [], linked_docs: [],
        client_state: { doc: true, board: true, nodes: [], modelRef: 'Claude Sonnet 4.6' },
      })),
    });
    render(<ChatPane client={client as never} transport={tx} docScope={docScope as never} boardClient={boardClient} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={pickerSettingsClient as never} keys={pickerKeys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />);

    await waitFor(() => expect(chatProps.modelPicker?.selected).toBe('Claude Sonnet 4.6'));
    onModelRefChange.mockClear();

    await act(async () => { switcherProps.onNew?.(); });

    await waitFor(() => expect(chatProps.modelPicker?.selected).toBeNull());
    expect(onModelRefChange).toHaveBeenCalledWith(null);
  });
});

describe('pin to board', () => {
  const spec = { kind: 'table', title: 'Open tasks', query: { types: ['task'] }, display_fields: ['status'] };
  const prior = { card_id: 'x', spec: { kind: 'kanban', title: 'By status', query: {}, display_fields: [] }, layout: { order: 0 } };

  function boardClientWith(boards: Array<{ id: string; name: string; updated_at: number; card_count: number }>) {
    return {
      list: vi.fn(async () => boards),
      get: vi.fn(async () => ({ id: 'b-existing', name: 'Existing', cards: [prior], created_at: 0, updated_at: 0 })),
      save: vi.fn(async () => ({ id: 'b-pinned' })),
      remove: vi.fn(async () => true),
      linkToDoc: vi.fn(async () => true),
      unlinkFromDoc: vi.fn(async () => true),
      listForDoc: vi.fn(async () => boards),
    };
  }
  const renderPane = (bc: ReturnType<typeof boardClientWith>) => render(
    <ChatPane client={fakeClient() as never} transport={tx} docScope={makeDocScope({ key: 'a.md', nodeId: 'node-a' }) as never} boardClient={bc as never} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />,
  );

  it("appends the view to the chat's board as a new tab", async () => {
    const bc = boardClientWith([{ id: 'b-existing', name: 'Existing', updated_at: 1, card_count: 1 }]);
    renderPane(bc);
    await waitFor(() => expect(bc.listForDoc).toHaveBeenCalled());
    await waitFor(() => expect(chatProps.onPinToBoard).toBeTypeOf('function'));

    await act(async () => { chatProps.onPinToBoard!(spec); });

    await waitFor(() => expect(bc.save).toHaveBeenCalledWith({
      id: 'b-existing', name: 'Existing',
      cards: [prior, expect.objectContaining({ spec, layout: { order: 1 } })],
    }));
    expect(bc.linkToDoc).not.toHaveBeenCalled();
  });

  it('a Boards pane showing the board makes the pin itself, so chat does not save the board (#287)', async () => {
    const bc = boardClientWith([{ id: 'b-existing', name: 'Existing', updated_at: 1, card_count: 1 }]);
    const boardSync = new BoardSync();
    let paneCards: BoardCard[] = [prior];
    const applyChange = vi.fn(async (_boardId: string, change: (cards: BoardCard[]) => BoardCard[]) => { paneCards = change(paneCards); return true; });
    boardSync.register({ shownBoardId: () => 'b-existing', applyChange });
    render(
      <ChatPane client={fakeClient() as never} transport={tx} docScope={makeDocScope({ key: 'a.md', nodeId: 'node-a' }) as never} boardClient={bc as never} boardSync={boardSync} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />,
    );
    await waitFor(() => expect(bc.listForDoc).toHaveBeenCalled());
    await waitFor(() => expect(chatProps.onPinToBoard).toBeTypeOf('function'));

    await act(async () => { chatProps.onPinToBoard!(spec); });

    await waitFor(() => expect(applyChange).toHaveBeenCalledTimes(1));
    expect(paneCards).toEqual([prior, expect.objectContaining({ spec, layout: { order: 1 } })]);
    expect(bc.save).not.toHaveBeenCalled();
  });

  it('two quick pins with no Boards pane open both land: each reads the board inside the queue', async () => {
    const bc = boardClientWith([{ id: 'b-existing', name: 'Existing', updated_at: 1, card_count: 1 }]);
    let server = { id: 'b-existing', name: 'Existing', cards: [prior] as BoardCard[], created_at: 0, updated_at: 0 };
    bc.get.mockImplementation(async () => server as never);
    bc.save.mockImplementation((async (input: { cards: BoardCard[] }) => { server = { ...server, cards: input.cards }; return { id: 'b-existing' }; }) as never);
    const boardSync = new BoardSync();
    render(
      <ChatPane client={fakeClient() as never} transport={tx} docScope={makeDocScope({ key: 'a.md', nodeId: 'node-a' }) as never} boardClient={bc as never} boardSync={boardSync} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />,
    );
    await waitFor(() => expect(bc.listForDoc).toHaveBeenCalled());
    await waitFor(() => expect(chatProps.onPinToBoard).toBeTypeOf('function'));

    await act(async () => { await Promise.all([chatProps.onPinToBoard!(spec), chatProps.onPinToBoard!({ ...spec, title: 'Second' })]); });

    await waitFor(() => expect(server.cards.map((c) => (c.spec as { title: string }).title)).toEqual(['By status', 'Open tasks', 'Second']));
  });

  it('a board deleted elsewhere gets a new board, and no pane is asked to change it', async () => {
    const bc = boardClientWith([{ id: 'b-existing', name: 'Existing', updated_at: 1, card_count: 1 }]);
    bc.get.mockResolvedValue(null as never);
    const applyChange = vi.fn(async () => true);
    const boardSync = new BoardSync();
    boardSync.register({ shownBoardId: () => 'b-existing', applyChange });
    render(
      <ChatPane client={fakeClient() as never} transport={tx} docScope={makeDocScope({ key: 'a.md', nodeId: 'node-a' }) as never} boardClient={bc as never} boardSync={boardSync} contextHolder={contextHolder} newBoardName={newBoardName} searchNodes={searchNodes} resolveNodes={resolveNodes} settingsClient={settingsClient as never} keys={keys} onModelRefChange={onModelRefChange} generateTitle={generateTitle} />,
    );
    await waitFor(() => expect(chatProps.onPinToBoard).toBeTypeOf('function'));

    await act(async () => { chatProps.onPinToBoard!(spec); });

    await waitFor(() => expect(bc.save).toHaveBeenCalledWith({ name: 'Board', cards: [expect.objectContaining({ spec })] }));
    expect(applyChange).not.toHaveBeenCalled();
  });

  it('appends after the last view even when the board was saved with gaps in its order', async () => {
    const bc = boardClientWith([{ id: 'b-existing', name: 'Existing', updated_at: 1, card_count: 2 }]);
    const late = { card_id: 'y', spec: prior.spec, layout: { order: 5 } };
    bc.get.mockResolvedValue({ id: 'b-existing', name: 'Existing', cards: [late, prior], created_at: 0, updated_at: 0 });
    renderPane(bc);
    await waitFor(() => expect(bc.listForDoc).toHaveBeenCalled());
    await waitFor(() => expect(chatProps.onPinToBoard).toBeTypeOf('function'));

    await act(async () => { chatProps.onPinToBoard!(spec); });

    await waitFor(() => expect(bc.save).toHaveBeenCalledWith({
      id: 'b-existing', name: 'Existing',
      cards: [prior, { ...late, layout: { order: 1 } }, expect.objectContaining({ spec, layout: { order: 2 } })],
    }));
  });

  it("starts a new linked board when the chat's board was deleted elsewhere, rather than recreating it", async () => {
    const bc = boardClientWith([{ id: 'b-existing', name: 'Existing', updated_at: 1, card_count: 1 }]);
    bc.get.mockResolvedValue(null as never);
    renderPane(bc);
    await waitFor(() => expect(bc.listForDoc).toHaveBeenCalled());
    await waitFor(() => expect(chatProps.onPinToBoard).toBeTypeOf('function'));

    await act(async () => { chatProps.onPinToBoard!(spec); });

    await waitFor(() => expect(bc.save).toHaveBeenCalledWith({ name: 'Board', cards: [expect.objectContaining({ spec, layout: { order: 0 } })] }));
    expect(bc.save).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'b-existing' }));
    await waitFor(() => expect(bc.linkToDoc).toHaveBeenCalledWith('b-pinned', 'node-a'));
  });

  it('creates a board linked to the active note when the chat has none', async () => {
    const bc = boardClientWith([]);
    renderPane(bc);
    await waitFor(() => expect(bc.listForDoc).toHaveBeenCalled());
    await waitFor(() => expect(chatProps.onPinToBoard).toBeTypeOf('function'));

    await act(async () => { chatProps.onPinToBoard!(spec); });

    await waitFor(() => expect(bc.save).toHaveBeenCalledWith({ name: 'Board', cards: [expect.objectContaining({ spec, layout: { order: 0 } })] }));
    await waitFor(() => expect(bc.linkToDoc).toHaveBeenCalledWith('b-pinned', 'node-a'));
  });
});
