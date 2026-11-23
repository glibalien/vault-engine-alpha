import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VizClientProvider } from '@vault/viz-ui';
import type { BoardClient, BoardSummary, Board, BoardCard, SaveBoardInput } from '@vault/board-core';
import type { DocScope } from '../../src/engine/doc-scope.js';
import type { BoardChoice, ChooseBoard } from '../../src/boards/board-picker-modal.js';
import { Boards, UNDO_TIMEOUT_MS } from '../../src/boards/Boards.js';
import type { VizSpec, BoardCardSpec } from '@vault/viz-ui';
import type { BoardInterpret } from '../../src/boards/BoardComposer.js';
import type { ResolvedOp } from '../../src/boards/board-ops.js';
import type { BoardLevelPlan } from '../../src/boards/board-level.js';
import { BoardSync } from '../../src/boards/board-sync.js';
import { BoardToolError } from '@vault/board-core';
import { Notice } from '../__stubs__/obsidian.js'; // the stub vitest maps 'obsidian' to, with its messages

function makeClient(overrides: Partial<BoardClient> = {}): BoardClient {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    save: vi.fn(async () => ({ id: 'b-new' })),
    remove: vi.fn(async () => true),
    linkToDoc: vi.fn(async () => true),
    unlinkFromDoc: vi.fn(async () => true),
    listForDoc: vi.fn(async () => []),
    ...overrides,
  };
}

/**
 * A fake DocScope with a settable current node id and a manual change trigger. `pathOf` maps the
 * node id to the active file's path (`currentKey()`); by default the path is the id itself.
 */
function makeDocScope(
  initialId: string | null = 'node-1',
  pathOf: (id: string) => string = (id) => id,
): DocScope & { fire(id: string | null): void } {
  let id = initialId;
  let cb: (() => void) | null = null;
  return {
    current: vi.fn(async () => id),
    currentKey: vi.fn(() => (id === null ? null : pathOf(id))),
    subscribe: vi.fn((fn: () => void) => { cb = fn; return () => { cb = null; }; }),
    fire(next: string | null) { id = next; cb?.(); },
  };
}

/** Minimal engine call stub: empty node results for query-nodes, ok for everything else. */
function makeCall() {
  const emptyNodes = (): CallToolResult => ({
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes: [], total: 0 } }) }],
  });
  const okResult = (): CallToolResult => ({
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data: {} }) }],
  });
  return vi.fn(async (req: { name: string }) => {
    if (req.name === 'query-nodes') return emptyNodes();
    return okResult();
  });
}

function renderBoards(
  client: BoardClient,
  opts: {
    onOpenPreview?: (ref: { nodeId: string } | { title: string }) => void;
    docScope?: DocScope;
    chooseBoard?: ChooseBoard;
    interpret?: BoardInterpret;
    boardSync?: BoardSync;
  } = {},
) {
  const call = makeCall();
  const result = render(
    <VizClientProvider call={call}>
      <Boards client={client} onOpenPreview={opts.onOpenPreview} docScope={opts.docScope} chooseBoard={opts.chooseBoard} interpret={opts.interpret} boardSync={opts.boardSync} />
    </VizClientProvider>,
  );
  return { ...result, call };
}

// ─── Header helpers: the board switcher and the ⋯ menu ──────────────────────

/** Open the ⋯ board-actions menu so its items render. */
function openMenu() {
  fireEvent.click(document.querySelector('.vb-menu-btn') as HTMLElement);
}

function boardBtn(): HTMLElement | null {
  return document.querySelector('.vb-board-btn');
}

/** The id of the board the switcher shows as selected ('' when none). */
function selectedBoard(): string {
  return boardBtn()?.getAttribute('data-board-id') ?? '';
}

/** The ids listed in the open switcher menu, in display order. */
function boardItems(): string[] {
  return Array.from(document.querySelectorAll('.vb-board-menu .vb-board-item')).map((b) => b.getAttribute('data-board-id') ?? '');
}

/** Open the board switcher menu (no-op when it is already open). */
async function openBoardMenu() {
  if (document.querySelector('.vb-board-menu')) return;
  await act(async () => { fireEvent.click(boardBtn() as HTMLElement); });
}

/** Pick board `id` in the switcher menu. */
async function pickBoard(id: string) {
  await openBoardMenu();
  const item = document.querySelector(`.vb-board-menu .vb-board-item[data-board-id="${id}"]`);
  if (!item) throw new Error(`no switcher entry for board ${id}; entries: ${boardItems().join(', ')}`);
  await act(async () => { fireEvent.click(item); });
}

/** Switcher menu → `selector` (e.g. "Show all boards…", "Link a board to this note…"). */
async function clickSwitcherItem(selector: string) {
  await openBoardMenu();
  await act(async () => { fireEvent.click(document.querySelector(`.vb-board-menu ${selector}`) as HTMLElement); });
}

// ─── View-tab helpers ───────────────────────────────────────────────────────

/** The board's view tabs (card ids), in display order. */
function tabIds(): string[] {
  return Array.from(document.querySelectorAll('.vb-tab')).map((t) => t.getAttribute('data-card-id') ?? '');
}

function tabLabels(): string[] {
  return Array.from(document.querySelectorAll('.vb-tab .vb-tab-label')).map((t) => t.textContent ?? '');
}

/** The open view tab's card id ('' when none). */
function openTab(): string {
  return document.querySelector('.vb-tab.is-active')?.getAttribute('data-card-id') ?? '';
}

function tabBtn(cardId: string): HTMLElement {
  const btn = document.querySelector(`.vb-tab[data-card-id="${cardId}"] .vb-tab-btn`);
  if (!btn) throw new Error(`no tab for view ${cardId}; tabs: ${tabIds().join(', ')}`);
  return btn as HTMLElement;
}

async function clickTab(cardId: string) {
  const btn = tabBtn(cardId);
  await act(async () => { fireEvent.click(btn); });
}

/** Open the tab bar's + menu. */
async function openPlus() {
  await act(async () => { fireEvent.click(document.querySelector('.vb-plus') as HTMLElement); });
}

function banner(): HTMLElement | null {
  return document.querySelector('.vb-board-undo');
}

/** The banner's message and Undo link, without its × button. */
function bannerMsg(): string | undefined {
  return banner()?.querySelector('.vb-board-undo-msg')?.textContent ?? undefined;
}

// ─── Save inspection ────────────────────────────────────────────────────────

function saves(client: BoardClient): SaveBoardInput[] {
  return vi.mocked(client.save).mock.calls.map(([arg]) => arg);
}

function lastSave(client: BoardClient): SaveBoardInput | undefined {
  return saves(client).at(-1);
}

/** The spec of `cardId` in the most recent save. */
function savedSpec(client: BoardClient, cardId = 'c1'): BoardCardSpec | undefined {
  return lastSave(client)?.cards.find((c) => c.card_id === cardId)?.spec as BoardCardSpec | undefined;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TABLE_SPEC: VizSpec = {
  kind: 'table',
  title: 'all tasks',
  query: { types: ['task'], sort_by: 'file_mtime', sort_order: 'desc' },
  display_fields: ['status', 'priority', 'due'],
};

const KANBAN_SPEC: VizSpec = {
  kind: 'kanban',
  title: 'tasks by status',
  query: { types: ['task'] },
  display_fields: ['status', 'priority', 'due'],
  group_by: 'status',
};

/** An untitled view: its tab falls back to the layout label. */
const UNTITLED_TABLE: VizSpec = { kind: 'table', title: '', query: {}, display_fields: [] };

const CREATED: VizSpec = { kind: 'kanban', title: 'open tasks', query: { types: ['task'] }, display_fields: ['status'], group_by: 'status' };

function card(card_id: string, spec: unknown, order: number): BoardCard {
  return { card_id, spec, layout: { order } };
}

function boardWith(cards: BoardCard[], id = 'b1', name = 'My Board'): Board {
  return { id, name, cards, created_at: 1, updated_at: 2, linked_docs: [] };
}

describe('Boards header — switcher and ⋯ menu', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders the empty state when there are no boards', async () => {
    const client = makeClient({ list: vi.fn(async () => []) });
    await act(async () => { renderBoards(client); });
    expect(client.list).toHaveBeenCalled();
    expect(document.querySelector('.vb-empty')).toBeTruthy();
    expect(selectedBoard()).toBe('');
    expect(boardBtn()?.classList.contains('is-empty')).toBe(true);
    expect(document.querySelector('.vb-board-name')?.textContent).toBe('No board');
    expect(document.querySelector('.vb-tabbar')).toBeNull(); // view tabs only exist for an open board
  });

  it("the switcher lists the note's boards oldest-first, checks the selected one, and offers New / Link / Show all", async () => {
    const summaries: BoardSummary[] = [
      { id: 'new', name: 'Newest', created_at: 30, updated_at: 99, card_count: 1 },
      { id: 'old', name: 'Oldest', created_at: 10, updated_at: 1, card_count: 1 },
      { id: 'mid', name: 'Middle', created_at: 20, updated_at: 5, card_count: 1 },
    ];
    const names: Record<string, string> = { new: 'Newest', old: 'Oldest', mid: 'Middle' };
    const client = makeClient({
      listForDoc: vi.fn(async () => summaries),
      get: vi.fn(async (id: string) => boardWith([card(`c-${id}`, TABLE_SPEC, 0)], id, names[id])),
    });
    const chooseBoard: ChooseBoard = vi.fn(async () => null);
    await act(async () => { renderBoards(client, { docScope: makeDocScope('node-1'), chooseBoard }); });

    // Following picks the most-recently-updated board, not the first in the list.
    await waitFor(() => expect(selectedBoard()).toBe('new'));
    await waitFor(() => expect(document.querySelector('.vb-board-name')?.textContent).toBe('Newest'));

    await openBoardMenu();
    expect(document.querySelector('.vb-board-menu .vb-menu-title')?.textContent).toBe('Boards on this note');
    expect(boardItems()).toEqual(['old', 'mid', 'new']);
    expect(Array.from(document.querySelectorAll('.vb-board-item .vb-menu-label')).map((l) => l.textContent)).toEqual(['Oldest', 'Middle', 'Newest']);
    const checked = Array.from(document.querySelectorAll('.vb-board-item[aria-checked="true"]')).map((b) => b.getAttribute('data-board-id'));
    expect(checked).toEqual(['new']);
    expect(document.querySelector('.vb-board-menu .vb-menu-new')).toBeTruthy();
    expect(document.querySelector('.vb-board-menu .vb-menu-link-existing')).toBeTruthy();
    expect(document.querySelector('.vb-board-menu .vb-menu-all')).toBeTruthy();
  });

  it('picking a board in the switcher loads it and closes the menu', async () => {
    const boards: BoardSummary[] = [
      { id: 'b1', name: 'Alpha', updated_at: 1, card_count: 0 },
      { id: 'b2', name: 'Beta', updated_at: 3, card_count: 0 },
    ];
    const client = makeClient({
      list: vi.fn(async () => boards),
      get: vi.fn(async (id: string) => boardWith([], id, id === 'b1' ? 'Alpha' : 'Beta')),
    });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(selectedBoard()).toBe('b2'));

    await pickBoard('b1');
    expect(client.get).toHaveBeenCalledWith('b1');
    expect(selectedBoard()).toBe('b1');
    expect(document.querySelector('.vb-board-menu')).toBeNull();
    await waitFor(() => expect(document.querySelector('.vb-board-name')?.textContent).toBe('Alpha'));
  });

  it('the ⋯ menu offers New / Rename / Link / Refresh / Delete — not Show all or Link existing', async () => {
    const client = makeClient({
      listForDoc: vi.fn(async () => [{ id: 'b1', name: 'Alpha', updated_at: 1, card_count: 0 }]),
      list: vi.fn(async () => []),
      get: vi.fn(async () => boardWith([], 'b1', 'Alpha')),
    });
    const chooseBoard: ChooseBoard = vi.fn(async () => null);
    await act(async () => { renderBoards(client, { docScope: makeDocScope('node-1'), chooseBoard }); });
    await waitFor(() => expect(document.querySelector('.vb-board-name')?.textContent).toBe('Alpha'));

    await act(async () => { openMenu(); });
    const items = Array.from(document.querySelectorAll('.vb-actions-menu [role="menuitem"]')).map((b) => b.className);
    expect(items).toEqual(['vb-menu-new', 'vb-menu-rename', 'vb-menu-link', 'vb-refresh', 'vb-menu-delete']);
    expect(document.querySelector('.vb-actions-menu .vb-menu-all')).toBeNull();
    expect(document.querySelector('.vb-actions-menu .vb-menu-link-existing')).toBeNull();
  });

  it('creates a new board via the ⋯ menu inline input (no window.prompt)', async () => {
    const client = makeClient({
      list: vi.fn(async () => []),
      save: vi.fn(async () => ({ id: 'b-new' })),
      get: vi.fn(async () => ({ id: 'b-new', name: 'My Board', cards: [], created_at: 1, updated_at: 1 })),
    });
    await act(async () => { renderBoards(client); });

    await act(async () => { openMenu(); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-actions-menu .vb-menu-new') as HTMLElement); });

    const input = document.querySelector('.vb-new-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => { fireEvent.change(input, { target: { value: 'My Board' } }); });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });

    expect(client.save).toHaveBeenCalledWith({ name: 'My Board', cards: [] });
    expect(client.get).toHaveBeenCalledWith('b-new');
    expect(selectedBoard()).toBe('b-new');
  });

  it('the Create button commits the typed name, the same as Enter', async () => {
    const client = makeClient({
      list: vi.fn(async () => []),
      save: vi.fn(async () => ({ id: 'b-new' })),
      get: vi.fn(async () => ({ id: 'b-new', name: 'Clicked Board', cards: [], created_at: 1, updated_at: 1 })),
    });
    await act(async () => { renderBoards(client); });
    await act(async () => { openMenu(); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-actions-menu .vb-menu-new') as HTMLElement); });

    const input = document.querySelector('.vb-new-input') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: 'Clicked Board' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });

    expect(client.save).toHaveBeenCalledWith({ name: 'Clicked Board', cards: [] });
    expect(selectedBoard()).toBe('b-new');
  });

  it('creates a new board via the switcher menu\'s "New board…"', async () => {
    const client = makeClient({
      list: vi.fn(async () => []),
      save: vi.fn(async () => ({ id: 'b-new' })),
      get: vi.fn(async () => ({ id: 'b-new', name: 'Fresh', cards: [], created_at: 1, updated_at: 1 })),
    });
    await act(async () => { renderBoards(client); });

    await clickSwitcherItem('.vb-menu-new');
    const input = document.querySelector('.vb-new-input') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: 'Fresh' } }); });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });

    expect(client.save).toHaveBeenCalledWith({ name: 'Fresh', cards: [] });
    expect(selectedBoard()).toBe('b-new');
    // A fresh board has no views yet: the pane offers the layout chooser.
    await waitFor(() => expect(screen.getByText(/has no views yet/)).toBeTruthy());
  });

  it('cancels new board creation when Escape is pressed', async () => {
    const client = makeClient({ list: vi.fn(async () => []), save: vi.fn(async () => ({ id: 'b-new' })) });
    await act(async () => { renderBoards(client); });
    await act(async () => { openMenu(); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-actions-menu .vb-menu-new') as HTMLElement); });

    const input = document.querySelector('.vb-new-input') as HTMLInputElement;
    await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }); });

    expect(document.querySelector('.vb-new-input')).toBeFalsy();
    expect(client.save).not.toHaveBeenCalled();
  });

  it('does not save a new board when name is empty or whitespace', async () => {
    const client = makeClient({ list: vi.fn(async () => []), save: vi.fn(async () => ({ id: 'b-new' })) });
    await act(async () => { renderBoards(client); });
    await act(async () => { openMenu(); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-actions-menu .vb-menu-new') as HTMLElement); });

    const input = document.querySelector('.vb-new-input') as HTMLInputElement;
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });

    expect(client.save).not.toHaveBeenCalled();
  });

  it('deletes the selected board via the ⋯ menu inline confirm (no window.confirm), naming its view count', async () => {
    const boards: BoardSummary[] = [{ id: 'b1', name: 'Alpha', updated_at: 1, card_count: 2 }];
    const board: Board = boardWith([card('c1', TABLE_SPEC, 0), card('c2', KANBAN_SPEC, 1)], 'b1', 'Alpha');
    const client = makeClient({
      list: vi.fn().mockResolvedValueOnce(boards).mockResolvedValue([]),
      get: vi.fn(async () => board),
      remove: vi.fn(async () => true),
    });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(tabIds()).toEqual(['c1', 'c2']));

    await act(async () => { openMenu(); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-menu-delete') as HTMLElement); });

    expect(document.querySelector('.vb-delete-label')?.textContent).toBe('Delete board “Alpha” and its 2 views?');
    const confirmBtn = document.querySelector('.vb-delete-confirm') as HTMLElement;
    expect(confirmBtn).toBeTruthy();
    await act(async () => { fireEvent.click(confirmBtn); });

    expect(client.remove).toHaveBeenCalledWith('b1');
    await waitFor(() => expect(selectedBoard()).toBe(''));
  });

  it('cancels delete when the cancel button is clicked', async () => {
    const boards: BoardSummary[] = [{ id: 'b1', name: 'Alpha', updated_at: 1, card_count: 0 }];
    const client = makeClient({ list: vi.fn(async () => boards), get: vi.fn(async () => boardWith([], 'b1', 'Alpha')), remove: vi.fn(async () => true) });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));
    await act(async () => { openMenu(); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-menu-delete') as HTMLElement); });

    const cancelBtn = document.querySelector('.vb-delete-cancel') as HTMLElement;
    await act(async () => { fireEvent.click(cancelBtn); });

    expect(document.querySelector('.vb-delete-confirm')).toBeFalsy();
    expect(client.remove).not.toHaveBeenCalled();
  });

  it('deleting the selected board lands on the next board', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce([{ id: 'b1', name: 'A', updated_at: 5, card_count: 0 }, { id: 'b2', name: 'B', updated_at: 1, card_count: 0 }])
      .mockResolvedValue([{ id: 'b2', name: 'B', updated_at: 1, card_count: 0 }]);
    const client = makeClient({ list, get: vi.fn(async (id: string) => boardWith([], id, id)) });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));
    await act(async () => { openMenu(); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-menu-delete') as HTMLElement); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-delete-confirm') as HTMLElement); });
    expect(client.remove).toHaveBeenCalledWith('b1');
    await waitFor(() => expect(selectedBoard()).toBe('b2'));
  });

  it('renames a board via the ⋯ menu inline input (no window.prompt)', async () => {
    const client = makeClient({
      list: vi.fn(async () => [{ id: 'b1', name: 'Alpha', updated_at: 1, card_count: 0 }]),
      get: vi.fn(async () => boardWith([], 'b1', 'Alpha')),
      save: vi.fn(async () => ({ id: 'b1' })),
    });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));
    await act(async () => { openMenu(); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-menu-rename') as HTMLElement); });

    const input = document.querySelector('.vb-rename-input') as HTMLInputElement;
    expect(input.value).toBe('Alpha');
    await act(async () => { fireEvent.change(input, { target: { value: 'Beta' } }); });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });

    expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1', name: 'Beta' }));
  });

  it('the Save button commits the typed board name, the same as Enter', async () => {
    const client = makeClient({
      list: vi.fn(async () => [{ id: 'b1', name: 'Alpha', updated_at: 1, card_count: 0 }]),
      get: vi.fn(async () => boardWith([], 'b1', 'Alpha')),
      save: vi.fn(async () => ({ id: 'b1' })),
    });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));
    await act(async () => { openMenu(); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-menu-rename') as HTMLElement); });

    const input = document.querySelector('.vb-rename-input') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: 'Gamma' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });

    expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1', name: 'Gamma' }));
    await waitFor(() => expect(document.querySelector('.vb-rename-input')).toBeFalsy());
  });

  it('refresh in the ⋯ menu reloads the board', async () => {
    const boards: BoardSummary[] = [{ id: 'b1', name: 'Alpha', updated_at: 1, card_count: 0 }];
    const get = vi.fn()
      .mockResolvedValueOnce(boardWith([], 'b1', 'Alpha'))
      .mockResolvedValueOnce(boardWith([card('c-new', TABLE_SPEC, 0)], 'b1', 'Alpha'));
    const client = makeClient({ list: vi.fn(async () => boards), get });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));

    await act(async () => { openMenu(); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-refresh') as HTMLElement); });

    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(2, 'b1');
    expect(tabIds()).toEqual(['c-new']);
    expect(screen.getByRole('toolbar', { name: 'View options' })).toBeTruthy(); // the reloaded view renders
  });

  it('refresh lands a pending view edit before reloading, so the edit is not lost', async () => {
    let server = boardWith([card('c1', TABLE_SPEC, 0), card('c2', KANBAN_SPEC, 1)], 'b1', 'Alpha');
    const client = makeClient({
      list: vi.fn(async () => [{ id: 'b1', name: 'Alpha', updated_at: 1, card_count: 2 }]),
      get: vi.fn(async () => server),
      save: vi.fn(async ({ id, name, cards }: SaveBoardInput) => { server = boardWith(cards, id ?? 'b1', name); return { id: id ?? 'b1' }; }),
    });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(tabIds()).toEqual(['c1', 'c2']));

    // Close a view, then refresh inside the 400 ms save debounce.
    await act(async () => { fireEvent.click(screen.getByLabelText('close view tasks by status')); });
    await act(async () => { openMenu(); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-refresh') as HTMLElement); });

    await waitFor(() => expect(vi.mocked(client.get).mock.calls.length).toBe(2));
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(lastSave(client)!.cards).toEqual([card('c1', TABLE_SPEC, 0)]);
    // The save landed before the reload's read, so the reload shows the edit.
    expect(vi.mocked(client.save).mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(client.get).mock.invocationCallOrder[1]!);
    expect(tabIds()).toEqual(['c1']);
  });

  it('shows error banner when client.list() rejects', async () => {
    const client = makeClient({ list: vi.fn(async () => { throw new Error('engine unavailable'); }) });
    await act(async () => { renderBoards(client); });
    const errorBanner = document.querySelector('.vb-error[role="alert"]') as HTMLElement;
    expect(errorBanner).toBeTruthy();
    expect(errorBanner.textContent).toContain('engine unavailable');
  });
});

describe('Boards follow / freeze', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("follow ON (default): selects the active note's most-recent board on mount", async () => {
    const docBoards: BoardSummary[] = [
      { id: 'old', name: 'Old', updated_at: 1, card_count: 0 },
      { id: 'recent', name: 'Recent', updated_at: 9, card_count: 0 },
    ];
    const client = makeClient({
      listForDoc: vi.fn(async () => docBoards),
      get: vi.fn(async (id: string) => boardWith([], id, id)),
    });
    const docScope = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope }); });

    await waitFor(() => expect(selectedBoard()).toBe('recent'));
    expect(client.get).toHaveBeenCalledWith('recent');
  });

  it('follow ON: the selection tracks the active note on a doc change', async () => {
    const map: Record<string, BoardSummary[]> = {
      'node-a': [{ id: 'ba', name: 'BA', updated_at: 1, card_count: 0 }],
      'node-b': [{ id: 'bb', name: 'BB', updated_at: 1, card_count: 0 }],
    };
    const client = makeClient({
      listForDoc: vi.fn(async (id: string) => map[id] ?? []),
      get: vi.fn(async (id: string) => boardWith([], id, id)),
    });
    const docScope = makeDocScope('node-a');
    await act(async () => { renderBoards(client, { docScope }); });
    await waitFor(() => expect(selectedBoard()).toBe('ba'));

    await act(async () => { docScope.fire('node-b'); });
    await waitFor(() => expect(selectedBoard()).toBe('bb'));
  });

  it('freeze (👁 off): the selection is frozen across a doc change, but summaries still reload', async () => {
    const map: Record<string, BoardSummary[]> = {
      'node-a': [{ id: 'ba', name: 'BA', updated_at: 1, card_count: 0 }],
      'node-b': [{ id: 'bb', name: 'BB', updated_at: 1, card_count: 0 }],
    };
    const listForDoc = vi.fn(async (id: string) => map[id] ?? []);
    const client = makeClient({ listForDoc, get: vi.fn(async (id: string) => boardWith([], id, id)) });
    const docScope = makeDocScope('node-a');
    await act(async () => { renderBoards(client, { docScope }); });
    await waitFor(() => expect(selectedBoard()).toBe('ba'));

    // Freeze.
    await act(async () => { fireEvent.click(document.querySelector('.vb-follow') as HTMLElement); });
    await act(async () => { docScope.fire('node-b'); });

    await waitFor(() => expect(listForDoc).toHaveBeenCalledWith('node-b'));
    expect(selectedBoard()).toBe('ba'); // frozen
    expect(document.querySelector('.vb-frozen-banner')).toBeTruthy();
    // The frozen board is no longer one of the active note's boards: the switcher marks it.
    await waitFor(() => expect(boardBtn()?.classList.contains('is-off-note')).toBe(true));
  });

  it("resuming follow (👁 on) snaps back to the active note's board", async () => {
    const map: Record<string, BoardSummary[]> = {
      'node-a': [{ id: 'ba', name: 'BA', updated_at: 1, card_count: 0 }],
      'node-b': [{ id: 'bb', name: 'BB', updated_at: 1, card_count: 0 }],
    };
    const client = makeClient({ listForDoc: vi.fn(async (id: string) => map[id] ?? []), get: vi.fn(async (id: string) => boardWith([], id, id)) });
    const docScope = makeDocScope('node-a');
    await act(async () => { renderBoards(client, { docScope }); });
    await waitFor(() => expect(selectedBoard()).toBe('ba'));

    await act(async () => { fireEvent.click(document.querySelector('.vb-follow') as HTMLElement); }); // freeze
    await act(async () => { docScope.fire('node-b'); });
    await waitFor(() => expect(selectedBoard()).toBe('ba'));

    await act(async () => { fireEvent.click(document.querySelector('.vb-follow') as HTMLElement); }); // resume
    await waitFor(() => expect(selectedBoard()).toBe('bb'));
    expect(document.querySelector('.vb-frozen-banner')).toBeFalsy();
  });

  it('empty state shows when the active note has no linked boards (follow ON)', async () => {
    const client = makeClient({ listForDoc: vi.fn(async () => []) });
    const docScope = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope }); });
    await waitFor(() => expect(document.querySelector('.vb-empty')).toBeTruthy());
    expect(selectedBoard()).toBe('');
    await openBoardMenu();
    expect(document.querySelector('.vb-board-menu .vb-menu-empty')?.textContent).toBe('None yet');
  });

  it('new board auto-links to the active note while following', async () => {
    const save = vi.fn(async () => ({ id: 'b-new' }));
    const linkToDoc = vi.fn(async () => true);
    const client = makeClient({
      listForDoc: vi.fn(async () => []),
      save,
      linkToDoc,
      get: vi.fn(async () => ({ id: 'b-new', name: 'NB', cards: [], created_at: 1, updated_at: 1, linked_docs: ['node-1'] })),
    });
    const docScope = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope }); });

    await act(async () => { openMenu(); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-actions-menu .vb-menu-new') as HTMLElement); });
    const input = document.querySelector('.vb-new-input') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: 'NB' } }); });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });

    expect(save).toHaveBeenCalledWith({ name: 'NB', cards: [] });
    expect(linkToDoc).toHaveBeenCalledWith('b-new', 'node-1');
  });

  it('no active note → empty message reads "No board selected" and shows "Show all boards…"', async () => {
    const client = makeClient({
      listForDoc: vi.fn(async () => []),
      list: vi.fn(async () => []),
    });
    const chooseBoard: ChooseBoard = vi.fn(async () => null);
    const docScope = makeDocScope(null); // no active note
    await act(async () => { renderBoards(client, { docScope, chooseBoard }); });
    await waitFor(() => expect(document.querySelector('.vb-empty')).toBeTruthy());

    const emptyMsg = document.querySelector('.vb-empty-msg') as HTMLElement;
    expect(emptyMsg.textContent).toBe('No board selected');
    const emptyActions = document.querySelector('.vb-empty-actions') as HTMLElement;
    const actionBtns = Array.from(emptyActions.querySelectorAll('button[type="button"]'));
    expect(actionBtns.some((b) => b.textContent === 'Show all boards…')).toBe(true);
    // No note → nothing to link to: the switcher offers no "Link a board to this note…".
    await openBoardMenu();
    expect(document.querySelector('.vb-board-menu .vb-menu-title')?.textContent).toBe('No active note');
    expect(document.querySelector('.vb-board-menu .vb-menu-link-existing')).toBeNull();
  });

  it('link/unlink menu item reflects linked_docs and calls link/unlink', async () => {
    const boards: BoardSummary[] = [{ id: 'b1', name: 'Alpha', updated_at: 1, card_count: 0 }];
    const linkToDoc = vi.fn(async () => true);
    const unlinkFromDoc = vi.fn(async () => true);
    const get = vi.fn()
      .mockResolvedValueOnce({ id: 'b1', name: 'Alpha', cards: [], created_at: 1, updated_at: 1, linked_docs: [] })
      .mockResolvedValue({ id: 'b1', name: 'Alpha', cards: [], created_at: 1, updated_at: 1, linked_docs: ['node-1'] });
    const client = makeClient({ listForDoc: vi.fn(async () => boards), get, linkToDoc, unlinkFromDoc });
    const docScope = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope }); });
    await waitFor(() => expect(document.querySelector('.vb-board-name')?.textContent).toBe('Alpha'));

    await act(async () => { openMenu(); });
    const linkItem = document.querySelector('.vb-menu-link') as HTMLElement;
    expect(linkItem.textContent).toContain('Link to this note');
    await act(async () => { fireEvent.click(linkItem); });
    expect(linkToDoc).toHaveBeenCalledWith('b1', 'node-1');

    await act(async () => { openMenu(); });
    const linkItem2 = document.querySelector('.vb-menu-link') as HTMLElement;
    expect(linkItem2.textContent).toContain('Unlink from this note');
    await act(async () => { fireEvent.click(linkItem2); });
    expect(unlinkFromDoc).toHaveBeenCalledWith('b1', 'node-1');
  });
});

describe('Boards all-boards escape', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('picking an off-note board freezes follow, selects it, and lists it (marked) in the switcher', async () => {
    const noteBoards: BoardSummary[] = [{ id: 'note-board', name: 'NoteBoard', updated_at: 1, card_count: 0 }];
    const allBoards: BoardSummary[] = [
      ...noteBoards,
      { id: 'other', name: 'Q3 Roadmap', updated_at: 5, card_count: 0 },
    ];
    const client = makeClient({
      listForDoc: vi.fn(async () => noteBoards),
      list: vi.fn(async () => allBoards),
      get: vi.fn(async (id: string) => boardWith([], id, id === 'other' ? 'Q3 Roadmap' : id)),
    });
    const chooseBoard: ChooseBoard = vi.fn(async () => ({ kind: 'existing', id: 'other', name: 'Q3 Roadmap' } as BoardChoice));
    const docScope = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope, chooseBoard }); });
    await waitFor(() => expect(selectedBoard()).toBe('note-board'));

    await clickSwitcherItem('.vb-menu-all');

    await waitFor(() => expect(selectedBoard()).toBe('other'));
    expect(chooseBoard).toHaveBeenCalledWith(allBoards);
    expect(document.querySelector('.vb-frozen-banner')).toBeTruthy(); // auto-frozen
    await waitFor(() => expect(boardBtn()?.classList.contains('is-off-note')).toBe(true));

    // The frozen off-note board still appears in the switcher, after the note's own boards.
    await openBoardMenu();
    expect(boardItems()).toEqual(['note-board', 'other']);
    const offNote = document.querySelector('.vb-board-item.is-off-note') as HTMLElement;
    expect(offNote.getAttribute('data-board-id')).toBe('other');
    expect(offNote.getAttribute('aria-checked')).toBe('true');
    expect(offNote.textContent).toBe('Q3 Roadmap');
  });

  it("picking one of the note's own boards keeps follow ON", async () => {
    const noteBoards: BoardSummary[] = [
      { id: 'b1', name: 'B1', updated_at: 5, card_count: 0 },
      { id: 'b2', name: 'B2', updated_at: 1, card_count: 0 },
    ];
    const client = makeClient({
      listForDoc: vi.fn(async () => noteBoards),
      list: vi.fn(async () => noteBoards),
      get: vi.fn(async (id: string) => boardWith([], id, id)),
    });
    const chooseBoard: ChooseBoard = vi.fn(async () => ({ kind: 'existing', id: 'b2', name: 'B2' } as BoardChoice));
    const docScope = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope, chooseBoard }); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));

    await clickSwitcherItem('.vb-menu-all');

    await waitFor(() => expect(selectedBoard()).toBe('b2'));
    expect(document.querySelector('.vb-frozen-banner')).toBeFalsy(); // still following
  });

  it('picker dismissed → no selection change, no freeze', async () => {
    const noteBoards: BoardSummary[] = [{ id: 'b1', name: 'B1', updated_at: 1, card_count: 0 }];
    const client = makeClient({
      listForDoc: vi.fn(async () => noteBoards),
      list: vi.fn(async () => noteBoards),
      get: vi.fn(async (id: string) => boardWith([], id, id)),
    });
    const chooseBoard: ChooseBoard = vi.fn(async () => null);
    const docScope = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope, chooseBoard }); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));
    await waitFor(() => expect(client.get).toHaveBeenCalled());

    const getCallsBefore = vi.mocked(client.get).mock.calls.length;

    await clickSwitcherItem('.vb-menu-all');

    expect(chooseBoard).toHaveBeenCalled();
    expect(selectedBoard()).toBe('b1');
    expect(document.querySelector('.vb-frozen-banner')).toBeFalsy();
    expect(vi.mocked(client.get).mock.calls.length).toBe(getCallsBefore);
  });

  it('create-new via the all-boards picker saves + auto-links while following', async () => {
    const save = vi.fn(async () => ({ id: 'b-new' }));
    const linkToDoc = vi.fn(async () => true);
    const client = makeClient({
      listForDoc: vi.fn(async () => []),
      list: vi.fn(async () => []),
      save,
      linkToDoc,
      get: vi.fn(async () => ({ id: 'b-new', name: 'Fresh', cards: [], created_at: 1, updated_at: 1, linked_docs: ['node-1'] })),
    });
    const chooseBoard: ChooseBoard = vi.fn(async () => ({ kind: 'new', name: 'Fresh' } as BoardChoice));
    const docScope = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope, chooseBoard }); });

    await clickSwitcherItem('.vb-menu-all');

    await waitFor(() => expect(save).toHaveBeenCalledWith({ name: 'Fresh', cards: [] }));
    expect(linkToDoc).toHaveBeenCalledWith('b-new', 'node-1');
    await waitFor(() => expect(selectedBoard()).toBe('b-new'));
  });
});

describe('Boards link-a-board flow', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('switcher "Link a board to this note…" links the picked board and keeps following', async () => {
    const daily: BoardSummary = { id: 'daily', name: 'Daily Board', updated_at: 5, card_count: 0 };
    const linkToDoc = vi.fn(async () => true);
    const client = makeClient({
      listForDoc: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([daily]),
      list: vi.fn(async () => [daily]),
      linkToDoc,
      get: vi.fn(async () => ({ id: 'daily', name: 'Daily Board', cards: [], created_at: 1, updated_at: 5, linked_docs: ['node-1'] })),
    });
    const chooseBoard: ChooseBoard = vi.fn(async () => ({ kind: 'existing', id: 'daily', name: 'Daily Board' } as BoardChoice));
    const docScope = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope, chooseBoard }); });

    await clickSwitcherItem('.vb-menu-link-existing');

    expect(linkToDoc).toHaveBeenCalledWith('daily', 'node-1');
    await waitFor(() => expect(selectedBoard()).toBe('daily'));
    expect(document.querySelector('.vb-frozen-banner')).toBeFalsy(); // still following
    expect(boardBtn()?.classList.contains('is-off-note')).toBe(false); // now one of the note's boards
  });

  // The picker must see ALL boards — filtering out already-linked ones would make the modal
  // offer "Create board <name>" for an exact-name match, silently creating a duplicate board.
  // Re-linking an already-linked board is a no-op (engine INSERT OR IGNORE), so including them
  // is safe: picking one simply selects it.
  it('link-a-board picker includes already-linked boards (exact name must not offer create)', async () => {
    const b1: BoardSummary = { id: 'b1', name: 'Linked', updated_at: 1, card_count: 0 };
    const b2: BoardSummary = { id: 'b2', name: 'Unlinked', updated_at: 2, card_count: 0 };
    const client = makeClient({
      listForDoc: vi.fn(async () => [b1]),
      list: vi.fn(async () => [b1, b2]),
      get: vi.fn(async (id: string) => boardWith([], id, id)),
    });
    const chooseBoard: ChooseBoard = vi.fn(async () => null);
    const docScope = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope, chooseBoard }); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));

    await clickSwitcherItem('.vb-menu-link-existing');

    expect(chooseBoard).toHaveBeenCalledWith([b1, b2]);
    expect(client.linkToDoc).not.toHaveBeenCalled();
  });

  it('create-new via the link-a-board picker links even while frozen', async () => {
    const save = vi.fn(async () => ({ id: 'b-new' }));
    const linkToDoc = vi.fn(async () => true);
    const client = makeClient({
      listForDoc: vi.fn(async () => []),
      list: vi.fn(async () => []),
      save,
      linkToDoc,
      get: vi.fn(async () => ({ id: 'b-new', name: 'Fresh', cards: [], created_at: 1, updated_at: 1, linked_docs: ['node-1'] })),
    });
    const chooseBoard: ChooseBoard = vi.fn(async () => ({ kind: 'new', name: 'Fresh' } as BoardChoice));
    const docScope = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope, chooseBoard }); });

    await act(async () => { fireEvent.click(document.querySelector('.vb-follow') as HTMLElement); }); // freeze
    await clickSwitcherItem('.vb-menu-link-existing');

    expect(save).toHaveBeenCalledWith({ name: 'Fresh', cards: [] });
    expect(linkToDoc).toHaveBeenCalledWith('b-new', 'node-1');
  });

  it('empty state offers "Link existing board…"; dismissing the picker changes nothing', async () => {
    const client = makeClient({
      listForDoc: vi.fn(async () => []),
      list: vi.fn(async () => [{ id: 'b1', name: 'B1', updated_at: 1, card_count: 0 }]),
    });
    const chooseBoard: ChooseBoard = vi.fn(async () => null);
    const docScope = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope, chooseBoard }); });
    await waitFor(() => expect(document.querySelector('.vb-empty')).toBeTruthy());

    const linkBtn = document.querySelector('.vb-empty-link') as HTMLElement;
    expect(linkBtn).toBeTruthy();
    expect(linkBtn.textContent).toContain('Link existing board');
    await act(async () => { fireEvent.click(linkBtn); });

    expect(chooseBoard).toHaveBeenCalled();
    expect(client.linkToDoc).not.toHaveBeenCalled();
    expect(document.querySelector('.vb-empty')).toBeTruthy(); // still empty, nothing selected
  });
});

describe('Boards view tabs', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  /** One board ('b1') whose get() returns `cards`; saves are recorded but not reflected. */
  function oneBoard(cards: BoardCard[], overrides: Partial<BoardClient> = {}): BoardClient {
    return makeClient({
      list: vi.fn(async () => [{ id: 'b1', name: 'My Board', updated_at: 1, card_count: cards.length }]),
      get: vi.fn(async () => boardWith(cards)),
      save: vi.fn(async () => ({ id: 'b1' })),
      ...overrides,
    });
  }

  it("renders the board's views as tabs in layout order and only the open view", async () => {
    const client = oneBoard([
      card('c2', { ...KANBAN_SPEC, title: '' }, 1),
      card('c1', TABLE_SPEC, 0),
      card('c3', { kind: 'stats', title: '' }, 2),
    ]);
    await act(async () => { renderBoards(client); });

    await waitFor(() => expect(tabIds()).toEqual(['c1', 'c2', 'c3']));
    // A view's tab shows its title, else its layout's label.
    expect(tabLabels()).toEqual(['all tasks', 'Kanban', 'Vault overview']);
    expect(openTab()).toBe('c1'); // nothing remembered → the first view
    expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1);
    expect(screen.getByLabelText('close view Kanban')).toBeTruthy();
    // The open view fills the pane: a Bases-style toolbar, no card title row, no card chrome.
    await waitFor(() => expect(document.querySelector('.viz--pane')).toBeTruthy());
    expect(screen.getByRole('toolbar', { name: 'View options' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Layout: Table' })).toBeTruthy();
    expect(document.querySelector('.viz-head')).toBeNull();
    expect(document.querySelectorAll('.viz')).toHaveLength(1);
  });

  it('clicking a tab opens that view — and only that view renders', async () => {
    const client = oneBoard([card('c1', TABLE_SPEC, 0), card('c2', KANBAN_SPEC, 1), card('c3', { kind: 'stats', title: 'Overview' }, 2)]);
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(openTab()).toBe('c1'));

    await clickTab('c2');
    expect(openTab()).toBe('c2');
    expect(screen.getByRole('button', { name: 'Layout: Kanban' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Layout: Table' })).toBeNull();
    expect(document.querySelectorAll('.viz')).toHaveLength(1);

    await clickTab('c3');
    expect(openTab()).toBe('c3');
    await waitFor(() => expect(document.querySelector('.vz-statscard')).toBeTruthy());
    expect(document.querySelectorAll('.viz')).toHaveLength(0);
    expect(client.save).not.toHaveBeenCalled(); // switching views is not an edit
  });

  it('+ → Table appends a view to this board, opens it, and saves the board (debounced)', async () => {
    const c1 = card('c1', TABLE_SPEC, 0);
    const client = oneBoard([c1]);
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(tabIds()).toEqual(['c1']));

    await openPlus();
    expect(document.querySelector('.vb-plus-menu')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Table' })); });

    expect(document.querySelector('.vb-plus-menu')).toBeNull();
    expect(tabIds()).toHaveLength(2);
    const added = tabIds()[1]!;
    expect(openTab()).toBe(added);
    expect(tabLabels()).toEqual(['all tasks', 'Table']);
    expect(client.save).not.toHaveBeenCalled(); // debounced

    await waitFor(() => expect(client.save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(client.save).toHaveBeenCalledWith({
      id: 'b1',
      name: 'My Board',
      cards: [c1, { card_id: added, spec: expect.objectContaining({ kind: 'table', title: '' }), layout: { order: 1 } }],
    });
  });

  it('the + menu offers the query and other presets; composer-backed entries need interpret', async () => {
    const client = oneBoard([card('c1', TABLE_SPEC, 0)]);
    const { unmount } = await act(async () => renderBoards(client, { interpret: vi.fn() }));
    await waitFor(() => expect(tabIds()).toEqual(['c1']));
    await openPlus();
    const items = (): string[] => screen.getAllByRole('menuitem').map((m) => (m.textContent ?? '').trim());
    expect(items()).toEqual([
      'Table', 'Kanban', 'List', 'Calendar', 'Vault overview', 'Usage and cost',
      'One note…', 'Describe a view…',
    ]);
    unmount();

    await act(async () => { renderBoards(oneBoard([card('c1', TABLE_SPEC, 0)])); });
    await waitFor(() => expect(tabIds()).toEqual(['c1']));
    await openPlus();
    expect(items()).toEqual(['Table', 'Kanban', 'List', 'Calendar', 'Vault overview', 'Usage and cost']);
  });

  it('a board with no views says so, and its chooser appends the first view', async () => {
    const client = oneBoard([], { get: vi.fn(async () => boardWith([], 'b1', 'Empty')) });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(screen.getByText(/“Empty” has no views yet/)).toBeTruthy());
    expect(tabIds()).toEqual([]);
    expect(document.querySelector('.vb-tabbar')).toBeTruthy(); // the + is still there

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Kanban' })); });
    expect(tabIds()).toHaveLength(1);
    expect(openTab()).toBe(tabIds()[0]);
    expect(screen.queryByText(/has no views yet/)).toBeNull();

    await waitFor(() => expect(client.save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(client.save).toHaveBeenCalledWith({
      id: 'b1',
      name: 'Empty',
      cards: [{ card_id: tabIds()[0], spec: expect.objectContaining({ kind: 'kanban' }), layout: { order: 0 } }],
    });
  });

  it('no board for the note → the chooser creates a board named after the note, linked, holding that view, and opens it', async () => {
    let stored: BoardCard[] = [];
    const save = vi.fn(async (input: SaveBoardInput) => { stored = input.cards; return { id: 'b-new' }; });
    const linkToDoc = vi.fn(async () => true);
    const listForDoc = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 'b-new', name: 'Alpha Launch', created_at: 1, updated_at: 1, card_count: 1 }]);
    const client = makeClient({
      listForDoc,
      save,
      linkToDoc,
      get: vi.fn(async (id: string) => ({ ...boardWith(stored, id, 'Alpha Launch'), linked_docs: ['node-1'] })),
    });
    const docScope = makeDocScope('node-1', () => 'Projects/Alpha Launch.md');
    await act(async () => { renderBoards(client, { docScope }); });
    await waitFor(() => expect(screen.getByText(/No board linked to this note yet/)).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Vault overview' })); });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      name: 'Alpha Launch',
      cards: [{ card_id: expect.any(String), spec: { kind: 'stats', title: 'Vault overview' }, layout: { order: 0 } }],
    });
    expect(linkToDoc).toHaveBeenCalledWith('b-new', 'node-1');
    await waitFor(() => expect(selectedBoard()).toBe('b-new'));
    await waitFor(() => expect(tabIds()).toEqual([stored[0]!.card_id]));
    expect(openTab()).toBe(stored[0]!.card_id);
    expect(boardBtn()?.classList.contains('is-off-note')).toBe(false); // it is the note's board now
    expect(banner()).toBeNull(); // a hand-picked layout needs no undo banner
  });

  it('no active note → the chooser\'s board is called "New board" and is not linked', async () => {
    const save = vi.fn(async () => ({ id: 'b-new' }));
    const client = makeClient({ listForDoc: vi.fn(async () => []), save, get: vi.fn(async () => boardWith([], 'b-new', 'New board')) });
    await act(async () => { renderBoards(client, { docScope: makeDocScope(null) }); });
    await waitFor(() => expect(screen.getByText('No board selected')).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Table' })); });

    expect(save).toHaveBeenCalledWith({ name: 'New board', cards: [expect.objectContaining({ spec: expect.objectContaining({ kind: 'table' }) })] });
    expect(client.linkToDoc).not.toHaveBeenCalled();
    await waitFor(() => expect(selectedBoard()).toBe('b-new'));
  });

  it('closing the open tab opens its right-hand neighbour; Undo puts the view back where it was and opens it', async () => {
    const c1 = card('c1', TABLE_SPEC, 0);
    const c2 = card('c2', KANBAN_SPEC, 1);
    const c3 = card('c3', { kind: 'stats', title: '' }, 2);
    const client = oneBoard([c1, c2, c3]);
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(tabIds()).toEqual(['c1', 'c2', 'c3']));
    await clickTab('c2');

    await act(async () => { fireEvent.click(screen.getByLabelText('close view tasks by status')); });

    expect(tabIds()).toEqual(['c1', 'c3']);
    expect(openTab()).toBe('c3'); // the right-hand neighbour
    expect(bannerMsg()).toBe('Closed "tasks by status" · ↩ Undo');
    await waitFor(() => expect(client.save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(lastSave(client)).toEqual({ id: 'b1', name: 'My Board', cards: [c1, { ...c3, layout: { order: 1 } }] });

    await act(async () => { fireEvent.click(screen.getByText('↩ Undo')); });

    expect(tabIds()).toEqual(['c1', 'c2', 'c3']);
    expect(openTab()).toBe('c2');
    expect(banner()).toBeNull();
    await waitFor(() => expect(client.save).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(lastSave(client)!.cards).toEqual([c1, c2, c3]);
  });

  it('closing the open LAST tab opens its left-hand neighbour; closing a tab that is not open keeps the open one', async () => {
    const client = oneBoard([card('c1', TABLE_SPEC, 0), card('c2', KANBAN_SPEC, 1), card('c3', UNTITLED_TABLE, 2)]);
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(tabIds()).toEqual(['c1', 'c2', 'c3']));
    await clickTab('c3');

    await act(async () => { fireEvent.click(screen.getByLabelText('close view Table')); });
    expect(tabIds()).toEqual(['c1', 'c2']);
    expect(openTab()).toBe('c2'); // the left-hand neighbour

    await act(async () => { fireEvent.click(screen.getByLabelText('close view all tasks')); });
    expect(tabIds()).toEqual(['c2']);
    expect(openTab()).toBe('c2'); // unchanged
    expect(banner()?.textContent).toContain('Closed "all tasks"'); // the banner tracks the latest close

    // Closing the last view leaves the board empty, with its chooser.
    await act(async () => { fireEvent.click(screen.getByLabelText('close view tasks by status')); });
    expect(tabIds()).toEqual([]);
    expect(screen.getByText(/has no views yet/)).toBeTruthy();
    await waitFor(() => expect(lastSave(client)?.cards).toEqual([]), { timeout: 2000 });
  });

  it('a closed-view Undo is cleared by a board switch', async () => {
    const client = makeClient({
      list: vi.fn(async () => [
        { id: 'b1', name: 'A', updated_at: 5, card_count: 2 },
        { id: 'b2', name: 'B', updated_at: 1, card_count: 1 },
      ]),
      get: vi.fn(async (id: string) => (id === 'b1'
        ? boardWith([card('c1', TABLE_SPEC, 0), card('c2', KANBAN_SPEC, 1)], 'b1', 'A')
        : boardWith([card('d1', TABLE_SPEC, 0)], 'b2', 'B'))),
    });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(tabIds()).toEqual(['c1', 'c2']));

    await act(async () => { fireEvent.click(screen.getByLabelText('close view tasks by status')); });
    expect(banner()).toBeTruthy();

    await pickBoard('b2');
    await waitFor(() => expect(tabIds()).toEqual(['d1']));
    expect(banner()).toBeNull();

    await pickBoard('b1');
    await waitFor(() => expect(selectedBoard()).toBe('b1'));
    expect(banner()).toBeNull(); // not resurrected on the way back
  });

  it('double-clicking the open tab renames the view: Enter sets its title, an empty name falls back to the layout label', async () => {
    const c2 = card('c2', KANBAN_SPEC, 1);
    const client = oneBoard([card('c1', TABLE_SPEC, 0), c2]);
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(openTab()).toBe('c1'));

    // Only the open tab renames.
    await act(async () => { fireEvent.doubleClick(tabBtn('c2')); });
    expect(screen.queryByLabelText('view name')).toBeNull();

    await act(async () => { fireEvent.doubleClick(tabBtn('c1')); });
    const input = screen.getByLabelText('view name') as HTMLInputElement;
    expect(input.value).toBe('all tasks');
    await act(async () => { fireEvent.change(input, { target: { value: '  Open work ' } }); });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });

    expect(screen.queryByLabelText('view name')).toBeNull();
    expect(tabLabels()).toEqual(['Open work', 'tasks by status']);
    await waitFor(() => expect((savedSpec(client, 'c1') as VizSpec | undefined)?.title).toBe('Open work'), { timeout: 2000 });
    expect(savedSpec(client, 'c2')).toEqual(KANBAN_SPEC);

    await act(async () => { fireEvent.doubleClick(tabBtn('c1')); });
    const again = screen.getByLabelText('view name') as HTMLInputElement;
    expect(again.value).toBe('Open work');
    await act(async () => { fireEvent.change(again, { target: { value: '' } }); });
    await act(async () => { fireEvent.keyDown(again, { key: 'Enter' }); });

    expect(tabLabels()).toEqual(['Table', 'tasks by status']);
    await waitFor(() => expect((savedSpec(client, 'c1') as VizSpec | undefined)?.title).toBe(''), { timeout: 2000 });
  });

  it('Escape cancels a view rename; leaving the input commits it', async () => {
    const client = oneBoard([card('c1', TABLE_SPEC, 0)]);
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(openTab()).toBe('c1'));

    await act(async () => { fireEvent.doubleClick(tabBtn('c1')); });
    const input = screen.getByLabelText('view name') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: 'Nope' } }); });
    await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }); });
    expect(screen.queryByLabelText('view name')).toBeNull();
    expect(tabLabels()).toEqual(['all tasks']);

    await act(async () => { fireEvent.doubleClick(tabBtn('c1')); });
    const again = screen.getByLabelText('view name') as HTMLInputElement;
    await act(async () => { fireEvent.change(again, { target: { value: 'Blurred' } }); });
    await act(async () => { fireEvent.blur(again); });
    expect(tabLabels()).toEqual(['Blurred']);

    await waitFor(() => expect(client.save).toHaveBeenCalled(), { timeout: 2000 });
    const titles = saves(client).map((s) => (s.cards[0]!.spec as VizSpec).title);
    expect(titles).not.toContain('Nope');
    expect(titles.at(-1)).toBe('Blurred');
  });

  it('the last open tab is remembered per board across a board switch', async () => {
    const client = makeClient({
      list: vi.fn(async () => [
        { id: 'b1', name: 'A', updated_at: 5, card_count: 2 },
        { id: 'b2', name: 'B', updated_at: 1, card_count: 2 },
      ]),
      get: vi.fn(async (id: string) => (id === 'b1'
        ? boardWith([card('c1', TABLE_SPEC, 0), card('c2', KANBAN_SPEC, 1)], 'b1', 'A')
        : boardWith([card('d1', TABLE_SPEC, 0), card('d2', KANBAN_SPEC, 1)], 'b2', 'B'))),
    });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(openTab()).toBe('c1'));
    await clickTab('c2');

    await pickBoard('b2');
    await waitFor(() => expect(tabIds()).toEqual(['d1', 'd2']));
    expect(openTab()).toBe('d1'); // never visited → its first view

    await pickBoard('b1');
    await waitFor(() => expect(tabIds()).toEqual(['c1', 'c2']));
    expect(openTab()).toBe('c2');
  });

  it('switching the layout in the toolbar persists the view kind and relabels an untitled tab', async () => {
    const client = oneBoard([card('c1', UNTITLED_TABLE, 0)]);
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(tabLabels()).toEqual(['Table']));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Layout: Table' })); });
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: 'Kanban' })); });

    expect(tabLabels()).toEqual(['Kanban']);
    expect(screen.getByRole('button', { name: 'Layout: Kanban' })).toBeTruthy();
    await waitFor(() => expect(client.save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(lastSave(client)!.id).toBe('b1');
    expect((savedSpec(client) as VizSpec).kind).toBe('kanban');
  });

  it('renders node and stats views through their own components', async () => {
    const cases: Array<[BoardCardSpec, string]> = [
      [{ kind: 'node', title: 'Charter', node_id: 'n1' }, '.vz-nodecard'],
      [{ kind: 'stats', title: 'Vault overview' }, '.vz-statscard'],
    ];
    for (const [spec, selector] of cases) {
      const client = oneBoard([card('c1', spec, 0)]);
      const { unmount } = await act(async () => renderBoards(client, { interpret: vi.fn() }));
      await waitFor(() => expect(document.querySelector(selector)).toBeTruthy());
      // The composer's sparkles sits in the view's own head, next to refresh.
      expect(document.querySelector(`${selector} .vz-card-head .vb-sparkles`)).toBeTruthy();
      unmount();
    }
  });

  it('an unrecognized kind renders the visible fallback, keeps a tab, and offers no sparkles', async () => {
    const client = oneBoard([card('future', { kind: 'future', version: 9 }, 0)]);
    await act(async () => { renderBoards(client, { interpret: vi.fn() }); });
    await waitFor(() => expect(document.querySelector('.vb-view .vb-card-unrecognized')?.textContent).toBe('unrecognized view'));
    expect(tabLabels()).toEqual(['Unrecognized view']);
    expect(screen.queryByLabelText('describe a change to this view')).toBeNull();
  });

  it('saved Project health and Project evidence views show as unrecognized after their retirement (#281)', async () => {
    const client = oneBoard([
      card('h', { kind: 'project-health', version: 1, title: 'Health', project_scope: 'active', sort: 'title' }, 0),
      card('e', { kind: 'evidence', title: 'Alpha', project: 'Alpha', project_node_id: 'p1' }, 1),
    ]);
    await act(async () => { renderBoards(client, { interpret: vi.fn() }); });
    await waitFor(() => expect(document.querySelector('.vb-view .vb-card-unrecognized')?.textContent).toBe('unrecognized view'));
    expect(tabLabels()).toEqual(['Unrecognized view', 'Unrecognized view']);
    expect(client.save).not.toHaveBeenCalled(); // shown, never dropped or rewritten
  });

  it('a board saved out of order shows its views in layout order, and close + Undo keep that order', async () => {
    const client = oneBoard([card('c2', KANBAN_SPEC, 1), card('c1', TABLE_SPEC, 0), card('c3', UNTITLED_TABLE, 2)]);
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(tabIds()).toEqual(['c1', 'c2', 'c3']));

    await act(async () => { fireEvent.click(screen.getByLabelText('close view Table')); });
    expect(tabIds()).toEqual(['c1', 'c2']);
    await act(async () => { fireEvent.click(screen.getByText('↩ Undo')); });
    expect(tabIds()).toEqual(['c1', 'c2', 'c3']);

    await waitFor(() => expect(client.save).toHaveBeenCalled(), { timeout: 2000 });
    expect(lastSave(client)!.cards).toEqual([card('c1', TABLE_SPEC, 0), card('c2', KANBAN_SPEC, 1), card('c3', UNTITLED_TABLE, 2)]);
  });
});

describe('Boards auto-refresh on active-document change (F1)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const summary: BoardSummary = { id: 'b1', name: 'Alpha', card_count: 0, updated_at: 2 };

  it('re-reads the selected board when the active document changes, even if the selection does not', async () => {
    // The ↻ button existed because of exactly this hole: switching notes reloaded
    // the note's board LIST, but the selected board's own views were only re-read
    // when selectedId changed. Land on a doc whose follow-pick is the same board
    // (or stay frozen) and the views silently went stale.
    const client = makeClient({
      list: vi.fn(async () => [summary]),
      listForDoc: vi.fn(async () => [summary]),
      get: vi.fn(async () => boardWith([])),
    });
    const ds = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope: ds }); });
    await waitFor(() => expect(client.get).toHaveBeenCalled());

    vi.mocked(client.get).mockClear();
    await act(async () => { ds.fire('node-2'); });

    await waitFor(() => expect(client.get).toHaveBeenCalledWith('b1'));
  });

  it('ignores a doc-scope event that reports the same document', async () => {
    // active-leaf-change also fires when focus moves onto the board leaf itself,
    // which reports the same active file. Refetching there would spam the engine
    // and risk clobbering an in-progress view edit.
    const client = makeClient({
      list: vi.fn(async () => [summary]),
      listForDoc: vi.fn(async () => [summary]),
      get: vi.fn(async () => boardWith([])),
    });
    const ds = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope: ds }); });
    await waitFor(() => expect(client.get).toHaveBeenCalled());

    vi.mocked(client.get).mockClear();
    vi.mocked(client.listForDoc).mockClear();
    await act(async () => { ds.fire('node-1'); }); // same doc

    expect(client.get).not.toHaveBeenCalled();
    expect(client.listForDoc).not.toHaveBeenCalled();
  });

  it('a pending debounced save flushes before a same-board reload — the reload does not race the flush', async () => {
    // A doc change whose follow-pick is the SAME board (so selectedId doesn't change but
    // refreshNonce still bumps) — with an unflushed edit in flight when the bump lands. If the
    // flush isn't awaited before the reload's client.get(), the read can interleave ahead of the
    // write and the reload can revert the just-flushed edit.
    const boardA: Board = { id: 'b1', name: 'Board A', cards: [card('a1', TABLE_SPEC, 0)], created_at: 0, updated_at: 0 };
    const summaryA: BoardSummary = { id: 'b1', name: 'Board A', card_count: 1, updated_at: 0 };

    let resolveSave!: (v: { id: string }) => void;
    const save = vi.fn(() => new Promise<{ id: string }>((res) => { resolveSave = res; }));
    const client = makeClient({
      list: vi.fn(async () => [summaryA]),
      listForDoc: vi.fn(async () => [summaryA]),
      get: vi.fn(async () => boardA),
      save,
    });
    const ds = makeDocScope('node-1');
    await act(async () => { renderBoards(client, { docScope: ds }); });
    await waitFor(() => expect(client.get).toHaveBeenCalledWith('b1'));

    vi.mocked(client.get).mockClear();

    // Switch the view's layout — schedules a debounced save that has not fired yet.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Layout: Table' })); });
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: 'Kanban' })); });
    expect(save).not.toHaveBeenCalled();

    // Active-document change whose follow-pick is the SAME board (b1) — bumps refreshNonce
    // without changing selectedId, exactly the ↻/F1 re-read path exercised above.
    await act(async () => { ds.fire('node-2'); });

    // The flush must have been issued synchronously as part of that effect...
    expect(save).toHaveBeenCalledTimes(1);
    // ...and the reload's read must wait on it, not race ahead of it.
    expect(client.get).not.toHaveBeenCalled();

    await act(async () => { resolveSave({ id: 'b1' }); });

    await waitFor(() => expect(client.get).toHaveBeenCalledWith('b1'));
  });
});

describe('board composer — tweak the open view', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function sprint(cards: BoardCard[], overrides: Partial<BoardClient> = {}): BoardClient {
    return makeClient({
      list: vi.fn(async () => [{ id: 'b1', name: 'Sprint', updated_at: 0, card_count: cards.length }]),
      get: vi.fn(async () => boardWith(cards, 'b1', 'Sprint')),
      ...overrides,
    });
  }

  async function submitTweak(text: string) {
    const input = screen.getByPlaceholderText('describe a view…');
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter' });
  }

  it('sparkles scopes the composer to the open view; submit tweaks it; revert restores it; the scope stays', async () => {
    const prior: VizSpec = { kind: 'table', title: 'By status', query: { types: ['task'] }, display_fields: [] };
    const client = sprint([card('c1', prior, 0)]);
    const interpret = vi.fn(async () => ({ ok: true as const, spec: CREATED }));
    renderBoards(client, { interpret });
    expect(screen.queryByLabelText('composer tool')).toBeNull(); // closed until asked for
    fireEvent.click(await screen.findByLabelText('describe a change to this view'));
    expect(screen.getByTitle('tweaking “By status”')).toBeTruthy();
    await submitTweak('make it kanban');
    await waitFor(() => expect(interpret).toHaveBeenCalledWith('query-nodes', 'make it kanban', prior, expect.any(Array)));
    await waitFor(() => expect((savedSpec(client) as VizSpec).kind).toBe('kanban'), { timeout: 2000 });
    expect(screen.getByLabelText('clear tweak target')).toBeTruthy(); // still tweaking this view
    fireEvent.click(await screen.findByText('↩ tweak'));
    await waitFor(() => expect(savedSpec(client)).toEqual(prior), { timeout: 2000 });
  });

  it("tweak preserves presentation keys (density, show_row_numbers, column_widths) the interpreter's schema can't express", async () => {
    const prior: VizSpec = {
      kind: 'table', title: 'By status', query: { types: ['task'] }, display_fields: ['status'],
      density: 'compact', show_row_numbers: true, show_link_counts: false, column_widths: { status: 120 },
    };
    const client = sprint([card('c1', prior, 0)]);
    renderBoards(client, { interpret: vi.fn(async () => ({ ok: true as const, spec: CREATED })) });
    fireEvent.click(await screen.findByLabelText('describe a change to this view'));
    await submitTweak('make it kanban');
    await waitFor(() => {
      const spec = savedSpec(client) as VizSpec;
      expect(spec.kind).toBe('kanban');
      expect(spec.density).toBe('compact');
      expect(spec.show_row_numbers).toBe(true);
      expect(spec.show_link_counts).toBe(false);
      expect(spec.column_widths).toEqual({ status: 120 });
    }, { timeout: 2000 });
  });

  it('tweak keeps folded sections (#573) while the group field stays, and the interpreter never sees them', async () => {
    const prior: VizSpec = {
      kind: 'table', title: 'By status', query: { types: ['task'] }, display_fields: ['status'],
      group_by: 'status', collapsed_groups: ['done', ''],
    };
    const shown: VizSpec = { kind: 'table', title: 'By status', query: { types: ['task'] }, display_fields: ['status'], group_by: 'status' };
    const next: VizSpec = { ...shown, query: { types: ['task'], fields: { status: { ne: 'dropped' } } } };
    const client = sprint([card('c1', prior, 0)]);
    const interpret = vi.fn(async () => ({ ok: true as const, spec: next }));
    renderBoards(client, { interpret });
    fireEvent.click(await screen.findByLabelText('describe a change to this view'));
    await submitTweak('hide dropped ones');
    await waitFor(() => expect(interpret).toHaveBeenCalledWith('query-nodes', 'hide dropped ones', shown, expect.any(Array)));
    await waitFor(() => {
      const spec = savedSpec(client) as VizSpec;
      expect(spec.query).toEqual(next.query);
      expect(spec.group_by).toBe('status');
      expect(spec.collapsed_groups).toEqual(['done', '']);
    }, { timeout: 2000 });
  });

  it('tweak drops folded sections when the answer groups by another field', async () => {
    const prior: VizSpec = {
      kind: 'table', title: 'By status', query: { types: ['task'] }, display_fields: ['status'],
      group_by: 'status', collapsed_groups: ['done'],
    };
    const next: VizSpec = { kind: 'table', title: 'By project', query: { types: ['task'] }, display_fields: ['status'], group_by: 'project' };
    const client = sprint([card('c1', prior, 0)]);
    renderBoards(client, { interpret: vi.fn(async () => ({ ok: true as const, spec: next })) });
    fireEvent.click(await screen.findByLabelText('describe a change to this view'));
    await submitTweak('group by project instead');
    await waitFor(() => {
      const spec = savedSpec(client) as VizSpec;
      expect(spec.group_by).toBe('project');
      expect(spec.collapsed_groups).toBeUndefined();
    }, { timeout: 2000 });
  });

  it('tweak keeps a table column sort (#393) when the answer sets no query sort', async () => {
    const prior: VizSpec = {
      kind: 'table', title: 'By status', query: { types: ['task'], sort_by: 'file_mtime', sort_order: 'desc' },
      display_fields: ['status'], column_sort: { field: 'status', order: 'desc' },
    };
    // The interpreter sees the view without the column sort or the query sort it replaces…
    const shown: VizSpec = { kind: 'table', title: 'By status', query: { types: ['task'] }, display_fields: ['status'] };
    // …and answers without a sort when none was asked for.
    const next: VizSpec = { ...shown, query: { types: ['task'], fields: { status: { eq: 'open' } } } };
    const client = sprint([card('c1', prior, 0)]);
    const interpret = vi.fn(async () => ({ ok: true as const, spec: next }));
    renderBoards(client, { interpret });
    fireEvent.click(await screen.findByLabelText('describe a change to this view'));
    await submitTweak('only open ones');
    await waitFor(() => expect(interpret).toHaveBeenCalledWith('query-nodes', 'only open ones', shown, expect.any(Array)));
    await waitFor(() => {
      const spec = savedSpec(client) as VizSpec;
      expect(spec.query).toEqual({ types: ['task'], fields: { status: { eq: 'open' } }, sort_by: 'file_mtime', sort_order: 'desc' });
      expect(spec.column_sort).toEqual({ field: 'status', order: 'desc' });
    }, { timeout: 2000 });
  });

  it('tweak asking for a sort replaces the column sort, even one matching the query sort under it', async () => {
    // Default query order (title ascending) under a status column sort; the person asks for A–Z.
    const prior: VizSpec = {
      kind: 'table', title: 'By status', query: { types: ['task'] },
      display_fields: ['status'], column_sort: { field: 'status', order: 'asc' },
    };
    const next: VizSpec = { kind: 'table', title: 'By status', query: { types: ['task'], sort_by: 'title', sort_order: 'asc' }, display_fields: ['status'] };
    const client = sprint([card('c1', prior, 0)]);
    renderBoards(client, { interpret: vi.fn(async () => ({ ok: true as const, spec: next })) });
    fireEvent.click(await screen.findByLabelText('describe a change to this view'));
    await submitTweak('sort alphabetically by name');
    await waitFor(() => {
      const spec = savedSpec(client) as VizSpec;
      expect(spec.query).toEqual({ types: ['task'], sort_by: 'title', sort_order: 'asc' });
      expect(spec.column_sort).toBeUndefined();
    }, { timeout: 2000 });
  });

  it('tweak preserves presentation keys for a legacy `tasklist`-kind prior (guard reads the PARSED prior)', async () => {
    const prior = { kind: 'tasklist', title: 'Todo', query: { types: ['task'] }, display_fields: [], column_widths: { status: 100 } } as unknown as VizSpec;
    const client = sprint([card('c1', prior, 0)]);
    renderBoards(client, { interpret: vi.fn(async () => ({ ok: true as const, spec: CREATED })) });
    fireEvent.click(await screen.findByLabelText('describe a change to this view'));
    await submitTweak('make it kanban');
    await waitFor(() => {
      const spec = savedSpec(client) as VizSpec;
      expect(spec.kind).toBe('kanban');
      expect(spec.column_widths).toEqual({ status: 100 });
    }, { timeout: 2000 });
  });

  it('✨ on a node view scopes with the node tool', async () => {
    const client = sprint([card('c1', { kind: 'node', title: 'Charter', node_id: 'n1' }, 0)]);
    const interpret = vi.fn(async () => ({ ok: true as const, spec: { kind: 'node' as const, title: 'Other', node_id: 'n2' } }));
    renderBoards(client, { interpret });
    fireEvent.click(await screen.findByLabelText('describe a change to this view'));
    fireEvent.change(screen.getByPlaceholderText('which note?…'), { target: { value: 'other note' } });
    fireEvent.keyDown(screen.getByPlaceholderText('which note?…'), { key: 'Enter' });
    await waitFor(() => expect(interpret).toHaveBeenCalledWith('get-node', 'other note', { kind: 'node', title: 'Charter', node_id: 'n1' }, expect.any(Array)));
  });

  it('no interpret prop → no sparkles, no composer, no composer entries in +', async () => {
    const client = sprint([card('c1', TABLE_SPEC, 0)]);
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(document.querySelector('.viz--pane')).toBeTruthy());
    expect(screen.queryByLabelText('describe a change to this view')).toBeNull();
    await openPlus();
    expect(screen.queryByRole('menuitem', { name: 'Describe a view…' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'One note…' })).toBeNull();
    expect(screen.queryByLabelText('composer tool')).toBeNull();
  });

  it('the tweak scope follows the open tab', async () => {
    const byStatus: VizSpec = { kind: 'table', title: 'By status', query: { types: ['task'] }, display_fields: [] };
    const byOwner: VizSpec = { kind: 'table', title: 'By owner', query: { types: ['task'] }, display_fields: ['owner'] };
    const client = sprint([card('c1', byStatus, 0), card('c2', byOwner, 1)]);
    const interpret = vi.fn(async () => ({ ok: true as const, spec: CREATED }));
    await act(async () => { renderBoards(client, { interpret }); });
    fireEvent.click(await screen.findByLabelText('describe a change to this view'));
    expect(screen.getByTitle('tweaking “By status”')).toBeTruthy();

    await clickTab('c2');
    expect(screen.getByTitle('tweaking “By owner”')).toBeTruthy();
    expect(screen.queryByTitle('tweaking “By status”')).toBeNull();

    await submitTweak('make it kanban');
    await waitFor(() => expect(interpret).toHaveBeenCalledWith('query-nodes', 'make it kanban', byOwner, expect.any(Array)));
    await waitFor(() => expect((savedSpec(client, 'c2') as VizSpec | undefined)?.kind).toBe('kanban'), { timeout: 2000 });
    expect(savedSpec(client, 'c1')).toEqual(byStatus);
  });

  it('a tweak composer closes when the open tab switches to a view it cannot tweak', async () => {
    const client = sprint([card('c1', TABLE_SPEC, 0), card('c2', { kind: 'future', version: 9 }, 1)]);
    await act(async () => { renderBoards(client, { interpret: vi.fn() }); });
    fireEvent.click(await screen.findByLabelText('describe a change to this view'));
    expect(screen.getByLabelText('composer tool')).toBeTruthy();

    await clickTab('c2');
    await waitFor(() => expect(screen.queryByLabelText('composer tool')).toBeNull());
  });

  it('a tweak resolving after a tab switch within the board still applies — to the view it was submitted for', async () => {
    const byStatus: VizSpec = { kind: 'table', title: 'By status', query: { types: ['task'] }, display_fields: [] };
    const client = sprint([card('c1', byStatus, 0), card('c2', KANBAN_SPEC, 1)]);
    let resolveInterpret!: (r: Awaited<ReturnType<BoardInterpret>>) => void;
    const interpret: BoardInterpret = () => new Promise((res) => { resolveInterpret = res; });
    await act(async () => { renderBoards(client, { interpret }); });
    fireEvent.click(await screen.findByLabelText('describe a change to this view'));
    await submitTweak('make it kanban');

    await clickTab('c2');
    await act(async () => { resolveInterpret({ ok: true, spec: CREATED }); });

    await waitFor(() => expect(savedSpec(client, 'c1')).toEqual(CREATED), { timeout: 2000 });
    expect(savedSpec(client, 'c2')).toEqual(KANBAN_SPEC);
    expect(openTab()).toBe('c2'); // the tweak does not yank the user back
    expect(screen.getByText('↩ tweak').getAttribute('title')).toBe('By status');
  });

  it('switching boards closes a tweak composer and clears revert state', async () => {
    const client = makeClient({
      list: vi.fn(async () => [
        { id: 'b1', name: 'Sprint', updated_at: 5, card_count: 1 },
        { id: 'b2', name: 'Other', updated_at: 0, card_count: 1 },
      ]),
      get: vi.fn(async (id: string) => (id === 'b1'
        ? boardWith([card('c1', TABLE_SPEC, 0)], 'b1', 'Sprint')
        : boardWith([card('d1', TABLE_SPEC, 0)], 'b2', 'Other'))),
    });
    await act(async () => { renderBoards(client, { interpret: vi.fn(async () => ({ ok: true as const, spec: CREATED })) }); });
    fireEvent.click(await screen.findByLabelText('describe a change to this view'));
    await submitTweak('make it kanban');
    await screen.findByText('↩ tweak');

    await pickBoard('b2');
    await waitFor(() => expect(screen.queryByLabelText('composer tool')).toBeNull());
    expect(screen.queryByText(/↩/)).toBeNull();
  });

  it('a tweak resolving after a board switch is dropped — not applied to either board', async () => {
    const save = vi.fn(async () => ({ id: 'ok' }));
    const client = makeClient({
      list: vi.fn(async () => [
        { id: 'board-a', name: 'A', updated_at: 5, card_count: 1 },
        { id: 'board-b', name: 'B', updated_at: 0, card_count: 1 },
      ]),
      get: vi.fn(async (id: string) => boardWith([card(`card-${id}`, TABLE_SPEC, 0)], id, id)),
      save,
    });
    let resolveInterpret!: (r: Awaited<ReturnType<BoardInterpret>>) => void;
    const interpret: BoardInterpret = () => new Promise((res) => { resolveInterpret = res; });
    await act(async () => { renderBoards(client, { interpret }); });
    fireEvent.click(await screen.findByLabelText('describe a change to this view'));
    await submitTweak('make it kanban');

    await pickBoard('board-b');
    await act(async () => { resolveInterpret({ ok: true, spec: CREATED }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    expect(save).not.toHaveBeenCalled();
  });

  it('a pending debounced save flushes on board switch — the old board keeps its last edit', async () => {
    const save = vi.fn(async () => ({ id: 'ok' }));
    const client = makeClient({
      list: vi.fn(async () => [
        { id: 'b1', name: 'A', updated_at: 5, card_count: 1 },
        { id: 'b2', name: 'B', updated_at: 0, card_count: 0 },
      ]),
      get: vi.fn(async (id: string) => (id === 'b1' ? boardWith([card('a1', TABLE_SPEC, 0)], 'b1', 'A') : boardWith([], 'b2', 'B'))),
      save,
    });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));
    // Switch the layout — schedules a debounced save that has not fired yet.
    const layoutBtn = await screen.findByRole('button', { name: 'Layout: Table' });
    await act(async () => { fireEvent.click(layoutBtn); });
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: 'List' })); });
    expect(save).not.toHaveBeenCalled();

    await pickBoard('b2');
    expect(save).toHaveBeenCalledTimes(1);
    const flushed = lastSave(client)!;
    expect(flushed.id).toBe('b1');
    expect((flushed.cards[0]!.spec as VizSpec).kind).toBe('list');
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("boardContext carries every view on the board, in tab order, minus presentation keys", async () => {
    const viz: VizSpec = {
      kind: 'table', title: 'All tasks', query: { types: ['task'], sort_by: 'file_mtime', sort_order: 'desc' }, display_fields: ['status'],
      density: 'compact', show_row_numbers: true, show_version: true, show_link_counts: true, column_widths: { status: 90 },
      // A column sort (#393) is left out, with the query sort it replaces.
      column_sort: { field: 'status', order: 'asc' },
    };
    const client = sprint([
      card('c3', { kind: 'node', title: 'Charter', node_id: 'n1' }, 2),
      card('c1', viz, 0),
      card('c2', { kind: 'stats', title: '' }, 1),
    ]);
    const interpret = vi.fn(async (..._args: Parameters<BoardInterpret>) => ({ ok: true as const, spec: CREATED }));
    renderBoards(client, { interpret });
    fireEvent.click(await screen.findByLabelText('describe a change to this view'));
    await submitTweak('x');
    await waitFor(() => expect(interpret).toHaveBeenCalled());

    const ctx = interpret.mock.calls[0]![3]!;
    expect(ctx.map((c) => c.card_id)).toEqual(['c1', 'c2', 'c3']);
    expect(ctx[0]!.spec).toEqual({ kind: 'table', title: 'All tasks', query: { types: ['task'] }, display_fields: ['status'] });
    expect(ctx[1]).toEqual({ card_id: 'c2', kind: 'stats', title: 'stats' }); // untitled → its kind; non-viz views carry no spec
    expect(ctx[2]).toEqual({ card_id: 'c3', kind: 'node', title: 'Charter' });
  });
});

describe('board composer — new views', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  async function openDescribe(): Promise<void> {
    await openPlus();
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Describe a view…' })); });
  }

  async function submit(tool: string, placeholder: string, text: string): Promise<void> {
    fireEvent.change(await screen.findByLabelText('composer tool'), { target: { value: tool } });
    const input = screen.getByPlaceholderText(placeholder);
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter' });
  }

  /**
   * Board 'b1' ("Sprint", one table view 'c1') is the only board in list(). get() returns what
   * was last saved under an id (so boards the composer creates load with their views), else a
   * board holding the one table view. New boards get the id `b-<name>`.
   */
  function setup(overrides: Partial<BoardClient> = {}): BoardClient {
    const stored = new Map<string, Board>();
    return makeClient({
      list: vi.fn(async () => [{ id: 'b1', name: 'Sprint', updated_at: 0, card_count: 1 }]),
      get: vi.fn(async (id: string) => stored.get(id) ?? boardWith([card('c1', TABLE_SPEC, 0)], id, id === 'b1' ? 'Sprint' : id)),
      save: vi.fn(async ({ id, name, cards }: SaveBoardInput) => {
        const bid = id ?? `b-${name}`;
        stored.set(bid, boardWith(cards, bid, name));
        return { id: bid };
      }),
      ...overrides,
    });
  }

  it('Describe a view… appends the interpreted view to this board and opens it; ↩ create removes it', async () => {
    const client = setup();
    const interpret = vi.fn(async () => ({ ok: true as const, spec: CREATED }));
    await act(async () => { renderBoards(client, { interpret }); });
    await waitFor(() => expect(tabIds()).toEqual(['c1']));
    await openDescribe();
    await submit('query-nodes', 'describe a view…', 'open tasks by status');

    expect(interpret).toHaveBeenCalledWith('query-nodes', 'open tasks by status', undefined, [expect.objectContaining({ card_id: 'c1' })]);
    await waitFor(() => expect(tabLabels()).toEqual(['all tasks', 'open tasks']));
    const added = tabIds()[1]!;
    expect(openTab()).toBe(added);
    await waitFor(() => expect(client.save).toHaveBeenCalled(), { timeout: 2000 });
    expect(lastSave(client)).toEqual({
      id: 'b1', name: 'Sprint',
      cards: [card('c1', TABLE_SPEC, 0), { card_id: added, spec: CREATED, layout: { order: 1 } }],
    });
    expect(banner()).toBeNull(); // Revert, not the banner, undoes a view added to this board
    expect(screen.getByLabelText('composer tool')).toBeTruthy(); // the composer stays open on the board

    fireEvent.click(screen.getByText('↩ create'));
    await waitFor(() => expect(tabIds()).toEqual(['c1']));
    await waitFor(() => expect(lastSave(client)!.cards).toEqual([card('c1', TABLE_SPEC, 0)]), { timeout: 2000 });
    expect(saves(client).every((s) => s.id === 'b1')).toBe(true); // no new board
    expect(client.linkToDoc).not.toHaveBeenCalled();
  });

  it('Several views with no board creates a note-named board holding the added views', async () => {
    let linked: BoardSummary[] = [];
    let stored: Board | null = null;
    const client = makeClient({
      listForDoc: vi.fn(async () => linked),
      save: vi.fn(async ({ name, cards }: SaveBoardInput) => { stored = boardWith(cards, 'b-new', name); return { id: 'b-new' }; }),
      linkToDoc: vi.fn(async (boardId: string) => {
        linked = [{ id: boardId, name: stored?.name ?? '', created_at: 1, updated_at: 1, card_count: 2 }];
        return true;
      }),
      get: vi.fn(async (id: string) => (stored?.id === id ? stored : null)),
    });
    const ops: ResolvedOp[] = [
      { op: 'add', spec: CREATED },
      { op: 'replace', card_id: 'ghost', spec: KANBAN_SPEC }, // nothing to replace without a board
      { op: 'add', spec: KANBAN_SPEC },
    ];
    const interpret = vi.fn(async () => ({ ok: true as const, ops, summary: 'two views', capped: false }));
    const docScope = makeDocScope('node-1', () => 'Projects/Alpha.md');
    await act(async () => { renderBoards(client, { interpret, docScope }); });
    await waitFor(() => expect(screen.getByText(/No board linked to this note yet/)).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Describe a view…' })); });
    await submit('board', 'describe a set of views…', 'tasks two ways');

    await waitFor(() => expect(client.save).toHaveBeenCalledWith({
      name: 'Alpha',
      cards: [
        { card_id: expect.any(String), spec: CREATED, layout: { order: 0 } },
        { card_id: expect.any(String), spec: KANBAN_SPEC, layout: { order: 1 } },
      ],
    }));
    expect(client.linkToDoc).toHaveBeenCalledWith('b-new', 'node-1');
    await waitFor(() => expect(selectedBoard()).toBe('b-new'));
    await waitFor(() => expect(tabLabels()).toEqual(['open tasks', 'tasks by status']));
    await waitFor(() => expect(banner()?.textContent).toContain('✓ Created "Alpha"'));
  });

  it('Describe a view… with no board creates a board named after the note holding the view; Undo deletes it', async () => {
    let linked: BoardSummary[] = [];
    let stored: Board | null = null;
    const client = makeClient({
      listForDoc: vi.fn(async () => linked),
      save: vi.fn(async ({ name, cards }: SaveBoardInput) => { stored = boardWith(cards, 'b-new', name); return { id: 'b-new' }; }),
      linkToDoc: vi.fn(async (boardId: string) => {
        linked = [{ id: boardId, name: stored?.name ?? '', created_at: 1, updated_at: 1, card_count: 1 }];
        return true;
      }),
      get: vi.fn(async (id: string) => (stored?.id === id ? stored : null)),
      remove: vi.fn(async () => { linked = []; stored = null; return true; }),
    });
    const interpret = vi.fn(async () => ({ ok: true as const, spec: CREATED }));
    const docScope = makeDocScope('node-1', () => 'Projects/Alpha.md');
    await act(async () => { renderBoards(client, { interpret, docScope }); });
    await waitFor(() => expect(screen.getByText(/No board linked to this note yet/)).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Describe a view…' })); });
    await submit('query-nodes', 'describe a view…', 'open tasks by status');

    expect(interpret).toHaveBeenCalledWith('query-nodes', 'open tasks by status', undefined, []);
    await waitFor(() => expect(client.save).toHaveBeenCalledWith({ name: 'Alpha', cards: [{ card_id: expect.any(String), spec: CREATED, layout: { order: 0 } }] }));
    expect(client.linkToDoc).toHaveBeenCalledWith('b-new', 'node-1');
    await waitFor(() => expect(selectedBoard()).toBe('b-new'));
    await waitFor(() => expect(tabLabels()).toEqual(['open tasks']));
    expect(banner()?.textContent).toContain('✓ Created "Alpha"');
    expect(banner()?.getAttribute('title')).toBe('open tasks');
    expect(screen.queryByLabelText('composer tool')).toBeNull(); // the composer closes on a board create

    await act(async () => { fireEvent.click(screen.getByText('↩ Undo')); });
    expect(client.remove).toHaveBeenCalledWith('b-new');
    await waitFor(() => expect(banner()).toBeNull());
    await waitFor(() => expect(selectedBoard()).toBe(''));
  });

  it('+ → One note… opens the composer on the note tool', async () => {
    const client = setup();
    await act(async () => { renderBoards(client, { interpret: vi.fn() }); });
    await waitFor(() => expect(tabIds()).toEqual(['c1']));
    await openPlus();
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'One note…' })); });
    expect((screen.getByLabelText('composer tool') as HTMLSelectElement).value).toBe('get-node');
    expect(screen.getByPlaceholderText('which note?…')).toBeTruthy();
  });

  it('a create resolving after a board switch is dropped', async () => {
    const client = setup({
      list: vi.fn(async () => [
        { id: 'board-a', name: 'A', updated_at: 5, card_count: 1 },
        { id: 'board-b', name: 'B', updated_at: 0, card_count: 1 },
      ]),
    });
    let resolveInterpret!: (r: Awaited<ReturnType<BoardInterpret>>) => void;
    const interpret: BoardInterpret = () => new Promise((res) => { resolveInterpret = res; });
    await act(async () => { renderBoards(client, { interpret }); });
    await waitFor(() => expect(selectedBoard()).toBe('board-a'));
    await openDescribe();
    await submit('vault-stats', 'view title (optional)…', 'stats');
    await pickBoard('board-b');
    await act(async () => { resolveInterpret({ ok: true, spec: { kind: 'stats', title: 'S' } }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    expect(client.save).not.toHaveBeenCalled();
    expect(tabIds()).toEqual(['c1']); // board-b gained nothing
  });

  it('several views: adds, replaces and removes all apply to this board as one Revert step', async () => {
    const c1 = card('c1', TABLE_SPEC, 0);
    const c2 = card('c2', KANBAN_SPEC, 1);
    const client = setup({ get: vi.fn(async () => boardWith([c1, c2], 'b1', 'Sprint')) });
    const ops: ResolvedOp[] = [
      { op: 'replace', card_id: 'c1', spec: CREATED },
      { op: 'remove', card_id: 'c2' },
      { op: 'add', spec: { kind: 'stats', title: 'Overview' } },
    ];
    const interpret = vi.fn(async () => ({ ok: true as const, ops, summary: 'reshape', capped: false }));
    await act(async () => { renderBoards(client, { interpret }); });
    await waitFor(() => expect(tabIds()).toEqual(['c1', 'c2']));
    await openDescribe();
    await submit('board', 'describe a set of views…', 'reshape');

    await screen.findByText('✓ Added 1 · updated 1 · removed 1');
    expect(tabLabels()).toEqual(['open tasks', 'Overview']);
    expect(tabIds()[0]).toBe('c1');
    expect(openTab()).toBe('c1'); // a view was replaced, so the open view stays put
    await waitFor(() => expect(client.save).toHaveBeenCalled(), { timeout: 2000 });
    expect(lastSave(client)).toEqual({
      id: 'b1', name: 'Sprint',
      cards: [
        { card_id: 'c1', spec: CREATED, layout: { order: 0 } },
        { card_id: tabIds()[1], spec: { kind: 'stats', title: 'Overview' }, layout: { order: 1 } },
      ],
    });
    expect(saves(client).every((s) => s.id === 'b1')).toBe(true); // no new boards
    expect(banner()).toBeNull();

    const revertBtn = screen.getByText('↩ board op');
    expect(revertBtn.getAttribute('title')).toBe('reshape');
    fireEvent.click(revertBtn);
    await waitFor(() => expect(tabIds()).toEqual(['c1', 'c2']));
    await waitFor(() => expect(lastSave(client)!.cards).toEqual([c1, c2]), { timeout: 2000 });
    expect(screen.queryByText(/↩/)).toBeNull(); // one Revert step undid the lot
  });

  it('several views: a replace keeps a column sort (#393) unless it sets a query sort', async () => {
    const sorted = (title: string): VizSpec => ({
      kind: 'table', title, query: { types: ['task'], sort_by: 'file_mtime', sort_order: 'desc' },
      display_fields: ['status'], column_sort: { field: 'status', order: 'desc' },
    });
    const client = setup({ get: vi.fn(async () => boardWith([card('c1', sorted('A'), 0), card('c2', sorted('B'), 1)], 'b1', 'Sprint')) });
    const ops: ResolvedOp[] = [
      { op: 'replace', card_id: 'c1', spec: { kind: 'table', title: 'A', query: { types: ['task'], fields: { status: { eq: 'open' } } }, display_fields: ['status'] } },
      { op: 'replace', card_id: 'c2', spec: { kind: 'table', title: 'B', query: { types: ['task'], sort_by: 'title', sort_order: 'asc' }, display_fields: ['status'] } },
    ];
    await act(async () => { renderBoards(client, { interpret: vi.fn(async () => ({ ok: true as const, ops, summary: 'tweak both', capped: false })) }); });
    await waitFor(() => expect(tabIds()).toEqual(['c1', 'c2']));
    await openDescribe();
    await submit('board', 'describe a set of views…', 'tweak both');
    await waitFor(() => {
      const [a, b] = lastSave(client)!.cards.map((c) => c.spec as VizSpec);
      expect(a!.query).toEqual({ types: ['task'], fields: { status: { eq: 'open' } }, sort_by: 'file_mtime', sort_order: 'desc' });
      expect(a!.column_sort).toEqual({ field: 'status', order: 'desc' });
      expect(b!.query).toEqual({ types: ['task'], sort_by: 'title', sort_order: 'asc' });
      expect(b!.column_sort).toBeUndefined();
    }, { timeout: 2000 });
  });

  it('several views: when nothing was replaced, the first added view opens', async () => {
    const client = setup();
    const ops: ResolvedOp[] = [
      { op: 'add', spec: { kind: 'stats', title: 'A' } },
      { op: 'add', spec: { kind: 'stats', title: 'B' } },
    ];
    await act(async () => { renderBoards(client, { interpret: vi.fn(async () => ({ ok: true as const, ops, summary: 'two', capped: false })) }); });
    await waitFor(() => expect(tabIds()).toEqual(['c1']));
    await openDescribe();
    await submit('board', 'describe a set of views…', 'two overviews');

    await screen.findByText('✓ Added 2 · updated 0 · removed 0');
    expect(tabLabels()).toEqual(['all tasks', 'A', 'B']);
    expect(openTab()).toBe(tabIds()[1]);
  });

  it('a board op whose replace target vanished reports zero updates and notes the capped result', async () => {
    const client = setup();
    const ops: ResolvedOp[] = [{ op: 'replace', card_id: 'ghost', spec: KANBAN_SPEC }];
    await act(async () => { renderBoards(client, { interpret: vi.fn(async () => ({ ok: true as const, ops, summary: 'reshape', capped: true })) }); });
    await waitFor(() => expect(tabIds()).toEqual(['c1']));
    await openDescribe();
    await submit('board', 'describe a set of views…', 'reshape it');

    await screen.findByText('✓ Added 0 · updated 0 · removed 0 · limited to the first set of changes');
    expect(screen.getByText('↩ board op').getAttribute('title')).toBe('reshape (capped)');
    expect(tabIds()).toEqual(['c1']);
  });

  it('create_board plan: one new board holds every planned view, linked and selected; Undo deletes it', async () => {
    const client = setup();
    const plan: BoardLevelPlan = {
      kind: 'create', name: 'Project Alpha HQ', linkNodeId: 'p9', summary: 'an HQ for Alpha',
      cards: [{ kind: 'stats', title: '' }, { kind: 'node', title: 'Alpha', node_id: 'p9' }],
    };
    const interpret = vi.fn(async () => ({ ok: true as const, boardPlan: plan }));
    await act(async () => { renderBoards(client, { interpret }); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));
    await openDescribe();
    await submit('board', 'describe a set of views…', 'create Project Alpha HQ');

    await waitFor(() => expect(banner()?.textContent).toContain('✓ Created "Project Alpha HQ"'));
    expect(banner()?.getAttribute('title')).toBe('an HQ for Alpha');
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(client.save).toHaveBeenCalledWith({
      name: 'Project Alpha HQ',
      cards: [
        { card_id: expect.any(String), spec: plan.cards[0], layout: { order: 0 } },
        { card_id: expect.any(String), spec: plan.cards[1], layout: { order: 1 } },
      ],
    });
    expect(client.linkToDoc).toHaveBeenCalledTimes(1);
    expect(client.linkToDoc).toHaveBeenCalledWith('b-Project Alpha HQ', 'p9');
    await waitFor(() => expect(selectedBoard()).toBe('b-Project Alpha HQ'));
    await waitFor(() => expect(tabLabels()).toEqual(['Vault overview', 'Alpha']));
    expect(screen.queryByLabelText('composer tool')).toBeNull();

    await act(async () => { fireEvent.click(screen.getByText('↩ Undo')); });
    expect(client.remove).toHaveBeenCalledTimes(1);
    expect(client.remove).toHaveBeenCalledWith('b-Project Alpha HQ');
    await waitFor(() => expect(banner()).toBeNull());
    await waitFor(() => expect(selectedBoard()).toBe('b1')); // back to a surviving board
  });

  it('a created-board Undo survives a board switch (and does not move the selection)', async () => {
    const client = setup();
    const plan: BoardLevelPlan = { kind: 'create', name: 'X', cards: [{ kind: 'stats', title: 'S' }], summary: 's' };
    await act(async () => { renderBoards(client, { interpret: vi.fn(async () => ({ ok: true as const, boardPlan: plan })) }); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));
    await openDescribe();
    await submit('board', 'describe a set of views…', 'create');
    await waitFor(() => expect(selectedBoard()).toBe('b-X'));
    expect(banner()?.textContent).toContain('✓ Created "X"');

    await pickBoard('b1');
    await waitFor(() => expect(tabIds()).toEqual(['c1']));
    expect(banner()?.textContent).toContain('✓ Created "X"');

    await act(async () => { fireEvent.click(screen.getByText('↩ Undo')); });
    expect(client.remove).toHaveBeenCalledWith('b-X');
    await waitFor(() => expect(banner()).toBeNull());
    expect(selectedBoard()).toBe('b1');
  });

  it('a single-view plan keeps the plan name; link failure appends " (link failed)"', async () => {
    const client = setup({ linkToDoc: vi.fn().mockRejectedValueOnce(new Error('link boom')) });
    const plan: BoardLevelPlan = { kind: 'create', name: 'Project Alpha HQ', cards: [{ kind: 'stats', title: 'S' }], linkNodeId: 'p9', summary: 's' };
    await act(async () => { renderBoards(client, { interpret: vi.fn(async () => ({ ok: true as const, boardPlan: plan })) }); });
    await waitFor(() => expect(tabIds()).toEqual(['c1']));
    await openDescribe();
    await submit('board', 'describe a set of views…', 'create');
    await waitFor(() => expect(banner()?.textContent).toContain('✓ Created "Project Alpha HQ" (link failed)'));
    expect(client.save).toHaveBeenCalledTimes(1); // the board is created despite the link failure
    expect(client.save).toHaveBeenCalledWith({ name: 'Project Alpha HQ', cards: [expect.objectContaining({ spec: { kind: 'stats', title: 'S' } })] });
    await waitFor(() => expect(selectedBoard()).toBe('b-Project Alpha HQ'));
  });

  it('a plan save failure surfaces as the composer error and no banner appears', async () => {
    const client = setup({ save: vi.fn(async () => { throw new Error('save boom'); }) });
    const plan: BoardLevelPlan = { kind: 'create', name: 'X', cards: [{ kind: 'stats', title: 'S' }], summary: 's' };
    await act(async () => { renderBoards(client, { interpret: vi.fn(async () => ({ ok: true as const, boardPlan: plan })) }); });
    await waitFor(() => expect(tabIds()).toEqual(['c1']));
    await openDescribe();
    await submit('board', 'describe a set of views…', 'create');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('save boom');
    expect(screen.queryByText(/✓ Created/)).toBeNull();
    expect(selectedBoard()).toBe('b1');
  });

  it('↩ Undo keeps the slot retryable after a failed delete, and ignores a double-click in flight', async () => {
    let resolveRemove!: (v: boolean) => void;
    const remove = vi.fn()
      .mockRejectedValueOnce(new Error('remove boom'))
      .mockImplementationOnce(() => new Promise<boolean>((res) => { resolveRemove = res; }));
    const client = setup({ remove });
    const plan: BoardLevelPlan = { kind: 'create', name: 'X', cards: [{ kind: 'stats', title: 'S' }], summary: 's' };
    await act(async () => { renderBoards(client, { interpret: vi.fn(async () => ({ ok: true as const, boardPlan: plan })) }); });
    await waitFor(() => expect(tabIds()).toEqual(['c1']));
    await openDescribe();
    await submit('board', 'describe a set of views…', 'create');
    await waitFor(() => expect(banner()).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByText('↩ Undo')); });
    expect((await screen.findByRole('alert')).textContent).toContain('undo incomplete — remove boom');
    expect(banner()).toBeTruthy();

    const undoBtn = screen.getByText('↩ Undo') as HTMLButtonElement;
    fireEvent.click(undoBtn);
    expect(undoBtn.disabled).toBe(true);
    fireEvent.click(undoBtn); // ignored — a delete is already in flight
    await act(async () => { resolveRemove(true); });
    expect(remove).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(banner()).toBeFalsy());
  });

  it('a boardPlan resolving after a board switch is dropped', async () => {
    const client = setup({
      list: vi.fn(async () => [
        { id: 'board-a', name: 'A', updated_at: 5, card_count: 1 },
        { id: 'board-b', name: 'B', updated_at: 0, card_count: 1 },
      ]),
    });
    let resolveInterpret!: (r: Awaited<ReturnType<BoardInterpret>>) => void;
    const interpret: BoardInterpret = () => new Promise((res) => { resolveInterpret = res; });
    await act(async () => { renderBoards(client, { interpret }); });
    await waitFor(() => expect(selectedBoard()).toBe('board-a'));
    await openDescribe();
    await submit('board', 'describe a set of views…', 'create');
    await pickBoard('board-b');
    await act(async () => { resolveInterpret({ ok: true, boardPlan: { kind: 'create', name: 'X', cards: [{ kind: 'stats', title: 'S' }], summary: 's' } }); });
    expect(client.save).not.toHaveBeenCalled();
    expect(client.linkToDoc).not.toHaveBeenCalled();
    expect(banner()).toBeFalsy();
    expect(selectedBoard()).toBe('board-b');
  });

  it('a dropped (stale) continuation leaves the created-board Undo alone; an applying one retires it', async () => {
    const client = setup();
    const plan: BoardLevelPlan = { kind: 'create', name: 'Alpha', cards: [{ kind: 'stats', title: 'S' }], summary: 's' };
    let resolvePending!: (r: Awaited<ReturnType<BoardInterpret>>) => void;
    const interpret = vi.fn<BoardInterpret>()
      .mockResolvedValueOnce({ ok: true, boardPlan: plan })
      .mockImplementationOnce(() => new Promise((res) => { resolvePending = res; }))
      .mockResolvedValueOnce({ ok: true, spec: { kind: 'stats', title: 'Applied' } });
    await act(async () => { renderBoards(client, { interpret }); });
    await waitFor(() => expect(tabIds()).toEqual(['c1']));

    // 1) The plan creates board "Alpha" and selects it; the banner offers Undo.
    await openDescribe();
    await submit('board', 'describe a set of views…', 'create Alpha');
    await waitFor(() => expect(selectedBoard()).toBe('b-Alpha'));
    const bannerText = banner()?.textContent;
    expect(bannerText).toContain('✓ Created "Alpha"');

    // 2) On Alpha, a create whose interpret stays pending — then switch boards before it resolves.
    await waitFor(() => expect(tabLabels()).toEqual(['S']));
    await openDescribe();
    await submit('query-nodes', 'describe a view…', 'add a stats view');
    await pickBoard('b1');
    await waitFor(() => expect(tabIds()).toEqual(['c1']));
    await act(async () => { resolvePending({ ok: true, spec: { kind: 'stats', title: 'Stale' } }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });

    expect(banner()?.textContent).toBe(bannerText); // the dropped continuation did not retire the slot
    expect(saves(client).some((s) => s.cards.some((c) => (c.spec as BoardCardSpec).title === 'Stale'))).toBe(false);

    // 3) A create that actually applies (on b1) does retire it.
    const input = screen.getByPlaceholderText('describe a view…');
    fireEvent.change(input, { target: { value: 'add another' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(tabLabels()).toEqual(['all tasks', 'Applied']));
    expect(banner()).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); }); // drain the debounced save
  });

  it('async continuations refresh summaries for the LIVE doc, not the submit-time one', async () => {
    let resolveSave!: (v: { id: string }) => void;
    const save = vi.fn(() => new Promise<{ id: string }>((res) => { resolveSave = res; }));
    const listForDoc = vi.fn(async (id: string) => (id === 'doc-1' ? [{ id: 'b1', name: 'Board A', updated_at: 0, card_count: 1 }] : []));
    const client = setup({ listForDoc, save });
    const plan: BoardLevelPlan = { kind: 'create', name: 'X', cards: [{ kind: 'stats', title: 'S' }], summary: 's' };
    const docScope = makeDocScope('doc-1');
    await act(async () => { renderBoards(client, { docScope, interpret: vi.fn(async () => ({ ok: true as const, boardPlan: plan })) }); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));
    await act(async () => { fireEvent.click(document.querySelector('.vb-follow') as HTMLElement); }); // freeze

    await openDescribe();
    await submit('board', 'describe a set of views…', 'create');
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    listForDoc.mockClear();
    await act(async () => { docScope.fire('doc-2'); });
    expect(listForDoc).toHaveBeenCalledWith('doc-2');
    await act(async () => { resolveSave({ id: 'b-new' }); });
    await waitFor(() => expect(listForDoc.mock.calls.at(-1)?.[0]).toBe('doc-2'));
  });

  // #396: a created-boards Undo deletes boards, so it outlasts a closed view's short timeout, but
  // it still goes away by itself. Fake timers that also follow real time, so waitFor still polls.
  describe('created-boards Undo timeout (#396)', () => {
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(() => { vi.useRealTimers(); });

    async function createViaPlan(client: BoardClient): Promise<void> {
      const plan: BoardLevelPlan = { kind: 'create', name: 'X', cards: [{ kind: 'stats', title: 'S' }], summary: 's' };
      await act(async () => { renderBoards(client, { interpret: vi.fn(async () => ({ ok: true as const, boardPlan: plan })) }); });
      await waitFor(() => expect(selectedBoard()).toBe('b1'));
      await openDescribe();
      await submit('board', 'describe a set of views…', 'create');
      await waitFor(() => expect(selectedBoard()).toBe('b-X'));
      expect(banner()?.textContent).toContain('✓ Created "X"');
    }

    it('stays up past the closed-view timeout, then goes away by itself without deleting anything', async () => {
      const client = setup();
      await createViaPlan(client);

      await act(async () => { vi.advanceTimersByTime(UNDO_TIMEOUT_MS.view + 1_000); });
      expect(banner()?.textContent).toContain('✓ Created "X"');

      await act(async () => { vi.advanceTimersByTime(UNDO_TIMEOUT_MS.boards); });
      expect(banner()).toBeNull();
      expect(client.remove).not.toHaveBeenCalled();
      expect(selectedBoard()).toBe('b-X');
    });

    it('× dismisses it at once and keeps the boards', async () => {
      const client = setup();
      await createViaPlan(client);

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); });
      expect(banner()).toBeNull();
      expect(client.remove).not.toHaveBeenCalled();
      expect(selectedBoard()).toBe('b-X');
    });

    it('does not time out while its Undo is in flight; after a failed delete it stays retryable until the time left runs out', async () => {
      let rejectRemove!: (err: Error) => void;
      const remove = vi.fn(() => new Promise<boolean>((_res, rej) => { rejectRemove = rej; }));
      const client = setup({ remove });
      await createViaPlan(client);

      await act(async () => { fireEvent.click(screen.getByText('↩ Undo')); });
      expect((screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => { vi.advanceTimersByTime(2 * UNDO_TIMEOUT_MS.boards); });
      expect(banner()).toBeTruthy(); // paused while the delete runs

      await act(async () => { rejectRemove(new Error('remove boom')); });
      expect(screen.getByRole('alert').textContent).toContain('undo incomplete — remove boom');
      expect(banner()).toBeTruthy(); // retryable
      expect((screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(false);

      await act(async () => { vi.advanceTimersByTime(UNDO_TIMEOUT_MS.boards); });
      expect(banner()).toBeNull();
    });
  });
});

describe('Boards closed-view Undo banner — timeout, hover pause and × (#396)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

  /** Board 'b1' with three views; closes 'tasks by status' (c2) so the banner offers its Undo. */
  async function closeOneView(): Promise<BoardClient> {
    const client = makeClient({
      list: vi.fn(async () => [{ id: 'b1', name: 'My Board', updated_at: 1, card_count: 3 }]),
      get: vi.fn(async () => boardWith([card('c1', TABLE_SPEC, 0), card('c2', KANBAN_SPEC, 1), card('c3', UNTITLED_TABLE, 2)])),
      save: vi.fn(async () => ({ id: 'b1' })),
    });
    await act(async () => { renderBoards(client); });
    expect(tabIds()).toEqual(['c1', 'c2', 'c3']);
    await act(async () => { fireEvent.click(screen.getByLabelText('close view tasks by status')); });
    expect(bannerMsg()).toBe('Closed "tasks by status" · ↩ Undo');
    return client;
  }

  it('goes away by itself after the timeout; the view stays closed', async () => {
    await closeOneView();

    await advance(UNDO_TIMEOUT_MS.view - 1);
    expect(banner()).toBeTruthy();
    await advance(1);
    expect(banner()).toBeNull();
    expect(tabIds()).toEqual(['c1', 'c3']);
  });

  it('the pointer over the banner pauses the timer; leaving resumes it with the time that was left', async () => {
    await closeOneView();

    await advance(6_000);
    fireEvent.mouseEnter(banner()!);
    await advance(10 * UNDO_TIMEOUT_MS.view);
    expect(banner()).toBeTruthy();

    fireEvent.mouseLeave(banner()!);
    await advance(UNDO_TIMEOUT_MS.view - 6_000 - 1);
    expect(banner()).toBeTruthy();
    await advance(1);
    expect(banner()).toBeNull();
  });

  it('focus inside the banner pauses the timer too', async () => {
    await closeOneView();
    const undoBtn = screen.getByText('↩ Undo');

    act(() => { undoBtn.focus(); });
    await advance(10 * UNDO_TIMEOUT_MS.view);
    expect(banner()).toBeTruthy();

    act(() => { undoBtn.blur(); });
    await advance(UNDO_TIMEOUT_MS.view);
    expect(banner()).toBeNull();
  });

  it('× dismisses it at once; the view stays closed', async () => {
    await closeOneView();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); });
    expect(banner()).toBeNull();
    expect(tabIds()).toEqual(['c1', 'c3']);
  });

  it('closing another view starts a fresh timer for the new banner', async () => {
    await closeOneView();

    await advance(8_000);
    await act(async () => { fireEvent.click(screen.getByLabelText('close view all tasks')); });
    expect(banner()?.textContent).toContain('Closed "all tasks"');

    await advance(8_000); // 16 s after the first close: the first banner's timer would have fired
    expect(banner()?.textContent).toContain('Closed "all tasks"');
    await advance(UNDO_TIMEOUT_MS.view - 8_000);
    expect(banner()).toBeNull();
  });
});

describe('Boards lifecycle — rename-safe debounced save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a rename landing while a view save is pending persists the NEW name', async () => {
    const cardA = card('c1', TABLE_SPEC, 0);
    let currentName = 'Sprint';
    const get = vi.fn(async () => ({ id: 'b1', name: currentName, cards: [cardA], created_at: 0, updated_at: 0 }));
    const save = vi.fn(async (payload: SaveBoardInput) => {
      currentName = payload.name;
      return { id: payload.id ?? 'b1' };
    });
    const client = makeClient({
      list: vi.fn(async () => [{ id: 'b1', name: 'Sprint', updated_at: 0, card_count: 1 }]),
      get,
      save,
    });
    await act(async () => { renderBoards(client); });
    save.mockClear();

    // Edit the view — schedules the debounced save; forBoard.name is pinned to 'Sprint' here.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Layout: Table' })); });
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: 'Kanban' })); });
    expect(save).not.toHaveBeenCalled();

    // Rename lands (its own immediate save + refresh) before the debounce fires.
    await act(async () => { openMenu(); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-menu-rename') as HTMLElement); });
    const input = document.querySelector('.vb-rename-input') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: 'Renamed' } }); });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1', name: 'Renamed' }));
    save.mockClear();

    // The debounced view save fires now — it must carry the LIVE name.
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].name).toBe('Renamed');
  });
});

describe('Boards and a board deleted elsewhere (#304)', () => {
  beforeEach(() => { vi.clearAllMocks(); Notice.messages.length = 0; });

  it("a save refused because the board is gone is reported, not retried, and the pane moves to the next board", async () => {
    const c1 = card('c1', TABLE_SPEC, 0);
    let boards: BoardSummary[] = [
      { id: 'b1', name: 'Gone board', updated_at: 2, card_count: 1 },
      { id: 'b2', name: 'Other', updated_at: 1, card_count: 0 },
    ];
    const save = vi.fn(async () => { throw new BoardToolError('NOT_FOUND', 'no board b1'); });
    const client = makeClient({
      list: vi.fn(async () => boards),
      get: vi.fn(async (id: string) => (id === 'b1' ? boardWith([c1], 'b1', 'Gone board') : boardWith([], 'b2', 'Other'))),
      save,
    });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));
    boards = boards.filter((b) => b.id !== 'b1'); // deleted on another device

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Layout: Table' })); });
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: 'Kanban' })); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });

    await waitFor(() => expect(selectedBoard()).toBe('b2'));
    expect(Notice.messages).toEqual(['"Gone board" was deleted elsewhere, so the last change to it wasn\'t saved.']);
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    expect(save).toHaveBeenCalledTimes(1); // never re-sent under the dead id
  });

  it('a switch to another board while the deleted board\'s save is pending keeps the new choice', async () => {
    const boards: BoardSummary[] = [
      { id: 'a', name: 'Gone', updated_at: 3, card_count: 1 },
      { id: 'b', name: 'Most recent other', updated_at: 2, card_count: 0 },
      { id: 'c', name: 'Chosen', updated_at: 1, card_count: 0 },
    ];
    const save = vi.fn(async (input: SaveBoardInput) => {
      if (input.id === 'a') throw new BoardToolError('NOT_FOUND', 'no board a');
      return { id: input.id ?? 'x' };
    });
    const client = makeClient({
      list: vi.fn(async () => boards.filter((b) => b.id !== 'a' || save.mock.calls.length === 0)),
      get: vi.fn(async (id: string) => boardWith(id === 'a' ? [card('c1', TABLE_SPEC, 0)] : [], id, boards.find((b) => b.id === id)!.name)),
      save,
    });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(selectedBoard()).toBe('a'));
    // Edit A (its save is debounced), then switch to C before it fires: the switch flushes A's save.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Layout: Table' })); });
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: 'Kanban' })); });
    await pickBoard('c');
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' })));
    await waitFor(() => expect(Notice.messages).toContain('"Gone" was deleted elsewhere, so the last change to it wasn\'t saved.'));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(selectedBoard()).toBe('c'); // not the fallback 'b'
  });

  it('Refresh during a save that fails keeps the unsaved edit instead of reloading over it', async () => {
    const c1 = card('c1', TABLE_SPEC, 0);
    const get = vi.fn(async () => boardWith([c1], 'b1', 'Mine'));
    const save = vi.fn(async () => { throw new BoardToolError('INTERNAL_ERROR', 'disk full'); });
    const client = makeClient({ list: vi.fn(async () => [{ id: 'b1', name: 'Mine', updated_at: 1, card_count: 1 }]), get, save });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Layout: Table' })); });
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: 'Kanban' })); });
    const reads = get.mock.calls.length;
    await act(async () => { openMenu(); });
    await act(async () => { fireEvent.click(document.querySelector('.vb-refresh') as HTMLElement); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(get.mock.calls.length).toBe(reads); // no reload over the edit
    expect(screen.getByRole('button', { name: 'Layout: Kanban' })).toBeTruthy();
    expect(Notice.messages).toEqual(['Couldn\'t save "Mine": disk full']);
  });

  it('another save failure is reported and the board stays open', async () => {
    const c1 = card('c1', TABLE_SPEC, 0);
    const save = vi.fn(async () => { throw new BoardToolError('INTERNAL_ERROR', 'disk full'); });
    const client = makeClient({
      list: vi.fn(async () => [{ id: 'b1', name: 'Mine', updated_at: 1, card_count: 1 }]),
      get: vi.fn(async () => boardWith([c1], 'b1', 'Mine')),
      save,
    });
    await act(async () => { renderBoards(client); });
    await waitFor(() => expect(selectedBoard()).toBe('b1'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Layout: Table' })); });
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: 'Kanban' })); });
    await waitFor(() => expect(Notice.messages).toEqual(['Couldn\'t save "Mine": disk full']), { timeout: 2000 });
    expect(selectedBoard()).toBe('b1');
  });
});

describe('Boards and a pin from chat (#287)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  /** One server-side board behind the pane's client, plus what ChatPane's pin passes to BoardSync. */
  function sharedBoard(cards: BoardCard[]) {
    let server = boardWith(cards, 'b1', 'Alpha');
    const client = makeClient({
      list: vi.fn(async () => [{ id: 'b1', name: 'Alpha', updated_at: 1, card_count: cards.length }]),
      get: vi.fn(async (id: string) => (id === 'b1' ? server : null)),
      save: vi.fn(async ({ id, name, cards: next }: SaveBoardInput) => { server = boardWith(next, id ?? 'b1', name); return { id: id ?? 'b1' }; }),
    });
    const pin = (cardId: string) => (list: BoardCard[]) => [...list, card(cardId, TABLE_SPEC, list.length)];
    const direct = vi.fn(async () => { throw new Error('a pane shows the board; chat must not write it'); });
    return { client, pin, direct, server: () => server };
  }

  it("a pin while the pane's edit waits to save keeps both, and shows at once", async () => {
    const { client, pin, direct, server } = sharedBoard([card('c1', TABLE_SPEC, 0), card('c2', KANBAN_SPEC, 1)]);
    const sync = new BoardSync();
    await act(async () => { renderBoards(client, { boardSync: sync }); });
    await waitFor(() => expect(tabIds()).toEqual(['c1', 'c2']));

    // Close a view, then pin inside the 400 ms save debounce.
    await act(async () => { fireEvent.click(screen.getByLabelText('close view tasks by status')); });
    await act(async () => { await sync.change('b1', pin('pinned'), direct); });

    expect(server().cards.map((c) => c.card_id)).toEqual(['c1', 'pinned']);
    expect(server().cards.map((c) => c.layout.order)).toEqual([0, 1]);
    expect(tabIds()).toEqual(['c1', 'pinned']);
    expect(direct).not.toHaveBeenCalled();
  });

  it('a pane edit after a pin keeps the pinned view, and two quick pins keep both', async () => {
    const { client, pin, direct, server } = sharedBoard([card('c1', TABLE_SPEC, 0), card('c2', KANBAN_SPEC, 1)]);
    const sync = new BoardSync();
    await act(async () => { renderBoards(client, { boardSync: sync }); });
    await waitFor(() => expect(tabIds()).toEqual(['c1', 'c2']));

    await act(async () => { await Promise.all([sync.change('b1', pin('p1'), direct), sync.change('b1', pin('p2'), direct)]); });
    await act(async () => { fireEvent.click(screen.getByLabelText('close view tasks by status')); });

    await waitFor(() => expect(server().cards.map((c) => c.card_id)).toEqual(['c1', 'p1', 'p2']));
    expect(tabIds()).toEqual(['c1', 'p1', 'p2']);
  });

  it('a pin while the pane\'s last save is still on its way keeps the pin: saves land in order', async () => {
    const { client, pin, direct, server } = sharedBoard([card('c1', TABLE_SPEC, 0), card('c2', KANBAN_SPEC, 1)]);
    const realSave = vi.mocked(client.save).getMockImplementation()!;
    let slowFirst = true;
    vi.mocked(client.save).mockImplementation(async (input) => {
      if (slowFirst) { slowFirst = false; await new Promise((r) => setTimeout(r, 80)); }
      return realSave(input);
    });
    const sync = new BoardSync();
    await act(async () => { renderBoards(client, { boardSync: sync }); });
    await waitFor(() => expect(tabIds()).toEqual(['c1', 'c2']));

    // Close a view and let its debounced save fire (slow), then pin while it is in flight.
    await act(async () => { fireEvent.click(screen.getByLabelText('close view tasks by status')); });
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    await act(async () => { await sync.change('b1', pin('pinned'), direct); });

    await waitFor(() => expect(server().cards.map((c) => c.card_id)).toEqual(['c1', 'pinned']));
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(server().cards.map((c) => c.card_id)).toEqual(['c1', 'pinned']);
  });

  it('a pin while the pane is still loading its board waits for the load, then applies there', async () => {
    const { client, pin, direct, server } = sharedBoard([card('c1', TABLE_SPEC, 0)]);
    const realGet = vi.mocked(client.get).getMockImplementation()!;
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((r) => { releaseLoad = r; });
    vi.mocked(client.get).mockImplementation(async (id) => { await loadGate; return realGet(id); });
    const sync = new BoardSync();
    await act(async () => { renderBoards(client, { boardSync: sync }); });

    let changed!: Promise<'pane' | 'direct'>;
    await act(async () => { changed = sync.change('b1', pin('pinned'), direct); });
    await act(async () => { releaseLoad(); });
    await act(async () => { expect(await changed).toBe('pane'); });

    expect(direct).not.toHaveBeenCalled();
    expect(server().cards.map((c) => c.card_id)).toEqual(['c1', 'pinned']);
    expect(tabIds()).toEqual(['c1', 'pinned']);
  });

  it('a pin to a board this pane does not show is written directly', async () => {
    const { client, pin } = sharedBoard([card('c1', TABLE_SPEC, 0)]);
    const sync = new BoardSync();
    await act(async () => { renderBoards(client, { boardSync: sync }); });
    await waitFor(() => expect(tabIds()).toEqual(['c1']));
    const direct = vi.fn(async () => {});

    await act(async () => { expect(await sync.change('b2', pin('pinned'), direct)).toBe('direct'); });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(tabIds()).toEqual(['c1']);
  });
});
