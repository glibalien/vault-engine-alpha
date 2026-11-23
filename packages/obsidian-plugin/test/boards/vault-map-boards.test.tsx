import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VizClientProvider, DEFAULT_VIEW_VOCABULARY, _resetCachesForTest, taskCheckboxOn, type ViewVocabulary, type VizSpec } from '@vault/viz-ui';
import { kanbanPreset, KANBAN_PRESET, type Board, type BoardCard, type BoardClient } from '@vault/board-core';
import { vaultSettingsFrom } from '@vault/settings-registry';
import { Boards, listPreset } from '../../src/boards/Boards.js';
import { VaultVizProvider } from '../../src/view/vault-viz-provider.js';
import { VaultMapIndex, vaultMapFrom } from '../../src/engine/vault-map.js';

/**
 * The Boards pane reads the vault map (#449): the Kanban and List presets name the vault's task
 * kind and fields, and are not offered when the vault has none. With the map at its defaults, and
 * against an Engine older than the map, the presets are today's and a saved board loads unchanged.
 */

afterEach(() => cleanup());

/** Today's presets, as the current version writes them into a saved board. */
const TODAY_KANBAN: VizSpec = { kind: 'kanban', title: '', query: { types: ['task'] }, display_fields: ['status', 'priority', 'due'], group_by: 'status' };
const TODAY_LIST: VizSpec = { kind: 'list', title: '', query: { types: ['task'] }, display_fields: ['status', 'due'] };

/** An Engine older than the map, as the current installation has it: no vault domain, the wiki
 *  domain all defaults, the curator domain with three active project statuses. */
const OLDER_ENGINE_SETTINGS = {
  domains: {
    wiki: { effective: {
      projectType: 'project', taskType: 'task', meetingType: 'meeting', personType: 'person', companyType: 'company',
      wikiType: 'wiki', dueField: 'due', peopleField: 'people involved', companyField: 'company', wikiDir: 'Wikis',
      statusField: 'status', statusOpen: ['open', 'in-progress'], statusDone: ['done'], statusBlocked: ['blocked'],
      statusIgnored: ['dropped'], statusBacklog: ['backlog'],
    } },
    curator: { effective: { activeStatuses: ['open', 'in-progress', 'next'], topicDir: null, projectStatusField: 'status' } },
    chat: { effective: {} },
  },
};

/** A vault whose tasks are "todo" notes with a "state" field. */
const OTHER: ViewVocabulary = {
  ...DEFAULT_VIEW_VOCABULARY,
  taskType: 'todo', taskStatusField: 'state', taskDoneStatuses: ['finished'], taskTickStatus: 'finished', taskUntickStatus: 'todo',
  priorityField: null, dueField: 'deadline',
};

const nodes = (fields: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes: [{ id: 'n1', title: 'Alpha', file_path: 'Alpha.md', types: ['task'], version: 3, fields }], total: 1 } }) }],
});
const ok = (data: unknown = {}): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] });

function makeCall(fields: Record<string, unknown> = {}) {
  return vi.fn(async (req: { name: string; arguments: Record<string, unknown> }) => {
    if (req.name === 'query-nodes') return nodes(fields);
    if (req.name === 'update-node') return ok({ node: { id: 'n1', version: 4 } });
    return ok();
  });
}

function boardClient(cards: BoardCard[]): BoardClient {
  const board: Board = { id: 'b1', name: 'My Board', cards, created_at: 1, updated_at: 2, linked_docs: [] };
  return {
    list: vi.fn(async () => [{ id: 'b1', name: 'My Board', updated_at: 1, card_count: cards.length }]),
    get: vi.fn(async () => board),
    save: vi.fn(async () => ({ id: 'b1' })),
    remove: vi.fn(async () => true),
    linkToDoc: vi.fn(async () => true),
    unlinkFromDoc: vi.fn(async () => true),
    listForDoc: vi.fn(async () => []),
  };
}

async function renderWith(client: BoardClient, vocabulary?: ViewVocabulary, call = makeCall()) {
  await act(async () => {
    render(<VizClientProvider call={call} vocabulary={vocabulary}><Boards client={client} /></VizClientProvider>);
  });
  return call;
}

const tabIds = () => Array.from(document.querySelectorAll('.vb-tab')).map((t) => t.getAttribute('data-card-id') ?? '');
const menuItems = () => screen.getAllByRole('menuitem').map((m) => (m.textContent ?? '').trim());
const chooserItems = () => Array.from(document.querySelectorAll('.vb-chooser-btn')).map((b) => (b.textContent ?? '').trim());
async function openPlus() {
  await act(async () => { fireEvent.click(document.querySelector('.vb-plus') as HTMLElement); });
}
/** Add a view from the + menu and return the spec the board saves for it. */
async function addFromPlus(client: BoardClient, label: string): Promise<VizSpec> {
  const before = vi.mocked(client.save).mock.calls.length;
  await openPlus();
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: label })); });
  await waitFor(() => expect(vi.mocked(client.save).mock.calls.length).toBeGreaterThan(before), { timeout: 2000 });
  const saved = vi.mocked(client.save).mock.calls.at(-1)![0];
  return saved.cards.at(-1)!.spec as VizSpec;
}

const tableCard: BoardCard = { card_id: 'c0', spec: { kind: 'table', title: 'all', query: {}, display_fields: [] }, layout: { order: 0 } };

describe('the presets with the vault map at its defaults', () => {
  it('are today\'s presets', () => {
    expect(kanbanPreset(DEFAULT_VIEW_VOCABULARY)).toEqual(TODAY_KANBAN);
    expect(KANBAN_PRESET).toEqual(TODAY_KANBAN);
    expect(listPreset(DEFAULT_VIEW_VOCABULARY)).toEqual(TODAY_LIST);
    // The registry's defaults and an older Engine's settings name the same things.
    for (const vault of [vaultSettingsFrom(undefined), vaultMapFrom(OLDER_ENGINE_SETTINGS).vault]) {
      expect(kanbanPreset(vault)).toEqual(TODAY_KANBAN);
      expect(listPreset(vault)).toEqual(TODAY_LIST);
    }
  });

  it('the viz-ui defaults are the registry\'s defaults', () => {
    const registry = vaultSettingsFrom(undefined);
    const picked = Object.fromEntries(Object.keys(DEFAULT_VIEW_VOCABULARY).map((k) => [k, registry[k as keyof typeof registry]]));
    expect(picked).toEqual(DEFAULT_VIEW_VOCABULARY);
  });

  it.each([
    ['no vocabulary', undefined],
    ['the default map', DEFAULT_VIEW_VOCABULARY],
    ['an older Engine\'s settings', vaultMapFrom(OLDER_ENGINE_SETTINGS).vault],
  ])('the + menu offers and writes today\'s views with %s', async (_label, vocabulary) => {
    const client = boardClient([tableCard]);
    await renderWith(client, vocabulary);
    await waitFor(() => expect(tabIds()).toEqual(['c0']));
    await openPlus();
    expect(menuItems()).toEqual(['Table', 'Kanban', 'List', 'Calendar', 'Vault overview', 'Usage and cost']);
    await act(async () => { fireEvent.click(document.querySelector('.vb-plus') as HTMLElement); });
    expect(await addFromPlus(client, 'Kanban')).toEqual(TODAY_KANBAN);
    expect(await addFromPlus(client, 'List')).toEqual(TODAY_LIST);
  });
});

describe('a board saved by the current version', () => {
  const saved: BoardCard[] = [
    { card_id: 'k', spec: { ...TODAY_KANBAN, title: 'Tasks board', column_widths: { kanban: { open: 240 } } }, layout: { order: 0 } },
    { card_id: 'l', spec: { ...TODAY_LIST, title: 'Task list' }, layout: { order: 1 } },
  ];

  it('loads unchanged with the map at its defaults: same queries, same columns, same checkbox writes, nothing rewritten', async () => {
    const client = boardClient(saved);
    const call = await renderWith(client, vaultMapFrom(OLDER_ENGINE_SETTINGS).vault, makeCall({ status: 'open', priority: 'high', due: '2026-12-01' }));
    await waitFor(() => expect(tabIds()).toEqual(['k', 'l']));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ name: 'query-nodes', arguments: { types: ['task'], include_fields: ['status', 'priority', 'due'], limit: 50 } }));
    await waitFor(() => expect(document.querySelector('.kcol .kt')?.textContent).toBe('open'));

    await act(async () => { fireEvent.click(document.querySelector('.vb-tab[data-card-id="l"] .vb-tab-btn') as HTMLElement); });
    await waitFor(() => expect(call).toHaveBeenCalledWith({ name: 'query-nodes', arguments: { types: ['task'], include_fields: ['status', 'due'], limit: 50 } }));
    const box = await screen.findByRole('button', { name: 'toggle Alpha' });
    await act(async () => { fireEvent.click(box); });
    await waitFor(() => expect(call).toHaveBeenCalledWith({ name: 'update-node', arguments: { node_id: 'n1', set_fields: { status: 'done' }, expected_version: 3 } }));

    await act(async () => { await new Promise((r) => setTimeout(r, 1200)); });
    expect(client.save).not.toHaveBeenCalled();
  });

  it('keeps the names it stored in a vault whose map names others', async () => {
    const client = boardClient(saved);
    const call = await renderWith(client, OTHER);
    await waitFor(() => expect(tabIds()).toEqual(['k', 'l']));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ name: 'query-nodes', arguments: { types: ['task'], include_fields: ['status', 'priority', 'due'], limit: 50 } }));
    await act(async () => { await new Promise((r) => setTimeout(r, 1200)); });
    expect(client.save).not.toHaveBeenCalled();
  });
});

describe('the List checkbox on the current installation (#488)', () => {
  /** The current Engine: the vault domain at its defaults, beside the old keys it mirrors. */
  const CURRENT_ENGINE_SETTINGS = {
    domains: { ...OLDER_ENGINE_SETTINGS.domains, vault: { effective: { ...vaultSettingsFrom(undefined) } } },
  };
  /** The task type's status field as the current installation has it: an enum holding done and open. */
  const TASK_SCHEMA = {
    name: 'task', display_name: 'Task', fields: [
      { name: 'status', type: 'enum', required: true, default_value: 'open', ui: null,
        enum_values: ['open', 'in-progress', 'pending', 'done', 'dropped', 'backlog', 'next'] },
      { name: 'due', type: 'date', required: false, default_value: null, ui: null },
    ],
  };
  function callWithSchema(status: string) {
    return vi.fn(async (req: { name: string; arguments: Record<string, unknown> }) => {
      if (req.name === 'query-nodes') return nodes({ status, due: '2026-12-01' });
      if (req.name === 'describe-schema') return ok(TASK_SCHEMA);
      if (req.name === 'list-schemas') return ok([{ name: 'task', node_count: 1, has_schema: true }]);
      if (req.name === 'update-node') return ok({ node: { id: 'n1', version: 4 } });
      return ok();
    });
  }
  const savedList: BoardCard[] = [{ card_id: 'l', spec: { ...TODAY_LIST, title: 'Task list' }, layout: { order: 0 } }];

  beforeEach(() => _resetCachesForTest());
  afterEach(() => _resetCachesForTest());

  it.each([
    ['an Engine older than the map', OLDER_ENGINE_SETTINGS],
    ['an Engine with the map at its defaults', CURRENT_ENGINE_SETTINGS],
  ])('with %s, a saved List shows today\'s checkbox, ticks done and unticks open', async (_label, settings) => {
    const vault = vaultMapFrom(settings).vault;
    expect(taskCheckboxOn(vault)).toBe(true);
    expect(taskCheckboxOn(vault, TASK_SCHEMA.fields[0]!.enum_values)).toBe(true);

    for (const [status, writes] of [['open', 'done'], ['done', 'open']] as const) {
      const index = new VaultMapIndex(async () => vaultMapFrom(settings));
      await index.load();
      const call = callWithSchema(status);
      const client = boardClient(savedList);
      await act(async () => {
        render(<VaultVizProvider call={call} vaultMap={index}><Boards client={client} /></VaultVizProvider>);
      });
      await waitFor(() => expect(call).toHaveBeenCalledWith({ name: 'query-nodes', arguments: { types: ['task'], include_fields: ['status', 'due'], limit: 50 } }));
      await waitFor(() => expect(call).toHaveBeenCalledWith({ name: 'describe-schema', arguments: { name: 'task' } }));
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      const box = await screen.findByRole('button', { name: 'toggle Alpha' });
      expect(box.classList.contains('done')).toBe(status === 'done');
      expect(document.querySelector('.vtask .spill')).toBeNull();
      await act(async () => { fireEvent.click(box); });
      await waitFor(() => expect(call).toHaveBeenCalledWith({ name: 'update-node', arguments: { node_id: 'n1', set_fields: { status: writes }, expected_version: 3 } }));
      expect(document.querySelector('.viz-stale')).toBeNull();
      expect(client.save).not.toHaveBeenCalled();
      cleanup();
      _resetCachesForTest();
    }
  });

  it('a vault whose task status field has no done value shows each task\'s status instead', async () => {
    // A designated `state` enum with only todo and waiting: the tick values stay Engine's defaults.
    const vault = vaultMapFrom({ domains: { vault: { effective: {
      taskStatusField: 'state', taskActiveStatuses: ['todo'], taskBlockedStatuses: ['waiting'], taskDoneStatuses: [],
    } } } }).vault;
    expect([vault.taskTickStatus, vault.taskUntickStatus]).toEqual(['done', 'open']);
    const call = vi.fn(async (req: { name: string; arguments: Record<string, unknown> }) => {
      if (req.name === 'query-nodes') return nodes({ state: 'todo' });
      return ok();
    });
    await renderWith(boardClient([{ card_id: 'l', spec: { kind: 'list', title: 'Tasks', query: { types: ['task'] }, display_fields: ['state'] }, layout: { order: 0 } }]), vault, call);
    await waitFor(() => expect(document.querySelector('.vtask .spill')?.textContent).toBe('todo'));
    expect(document.querySelector('.cbox')).toBeNull();
    expect(document.querySelector('.viz-stale')).toBeNull();
  });
});

describe('the presets with a vault\'s own names', () => {
  it('write the vault\'s task kind and fields', async () => {
    const client = boardClient([tableCard]);
    await renderWith(client, OTHER);
    await waitFor(() => expect(tabIds()).toEqual(['c0']));
    expect(await addFromPlus(client, 'Kanban')).toEqual({ kind: 'kanban', title: '', query: { types: ['todo'] }, display_fields: ['state', 'deadline'], group_by: 'state' });
    expect(await addFromPlus(client, 'List')).toEqual({ kind: 'list', title: '', query: { types: ['todo'] }, display_fields: ['state', 'deadline'] });
  });

  it('are not offered, with no error, when the vault has no task kind', async () => {
    const client = boardClient([tableCard]);
    await renderWith(client, { ...OTHER, taskType: null });
    await waitFor(() => expect(tabIds()).toEqual(['c0']));
    await openPlus();
    expect(menuItems()).toEqual(['Table', 'Calendar', 'Vault overview', 'Usage and cost']);
    expect(document.querySelector('.vb-error')).toBeNull();
  });

  it('the empty board\'s chooser leaves them out too', async () => {
    await renderWith(boardClient([]), { ...OTHER, taskType: null });
    await waitFor(() => expect(chooserItems().length).toBeGreaterThan(0));
    expect(chooserItems()).toEqual(['Table', 'Calendar', 'Vault overview', 'Usage and cost']);
  });

  it('offer List but not Kanban when the vault has no task status field', async () => {
    const client = boardClient([tableCard]);
    await renderWith(client, { ...OTHER, taskStatusField: null });
    await waitFor(() => expect(tabIds()).toEqual(['c0']));
    await openPlus();
    expect(menuItems()).toEqual(['Table', 'List', 'Calendar', 'Vault overview', 'Usage and cost']);
    await act(async () => { fireEvent.click(document.querySelector('.vb-plus') as HTMLElement); });
    expect(await addFromPlus(client, 'List')).toEqual({ kind: 'list', title: '', query: { types: ['todo'] }, display_fields: ['deadline'] });
  });
});

describe('VaultVizProvider', () => {
  it('reads the map when it mounts and re-renders the presets when the read lands', async () => {
    let release!: () => void;
    const index = new VaultMapIndex(() => new Promise((resolve) => {
      release = () => resolve(vaultMapFrom({ domains: { vault: { effective: { taskType: null } } } }));
    }));
    const client = boardClient([tableCard]);
    await act(async () => {
      render(<VaultVizProvider call={makeCall()} vaultMap={index}><Boards client={client} /></VaultVizProvider>);
    });
    await waitFor(() => expect(tabIds()).toEqual(['c0']));
    await openPlus();
    expect(menuItems()).toContain('Kanban');
    await act(async () => { release(); await index.load(); });
    expect(menuItems()).not.toContain('Kanban');
    expect(menuItems()).not.toContain('List');
  });
});
