// @vitest-environment jsdom
/**
 * The vault map's names in the views (#449): the List checkbox, the kanban's default column field,
 * the always-fetched status field, the calendar's date fallbacks and the status order. With the
 * map at its defaults (or no map: an Engine older than it) each is pinned to today's behaviour.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Client } from '@vault/query-core';
import { VizClientProvider } from '../src/viz-client-context.js';
import { VizTaskList } from '../src/VizTaskList.js';
import { VizKanban } from '../src/VizKanban.js';
import { vizQueryArgs, type VizRow, type VizSpec } from '../src/viz-spec.js';
import { resolveDateField } from '../src/calendar-grid.js';
import {
  DEFAULT_STATUS_SCALE, STATUS_ORDER, groupRows, isStatus, sortRows, statusColorVar, statusScaleFor,
} from '../src/viz-state.js';
import {
  DEFAULT_VIEW_VOCABULARY, calendarDateFields, enumValuesOf, taskCheckboxOn, viewStatusField, type ViewVocabulary,
} from '../src/view-vocabulary.js';

afterEach(() => cleanup());

/** A vault whose tasks are "todo" notes with a "state" field (todo → doing → finished). */
const OTHER: ViewVocabulary = {
  ...DEFAULT_VIEW_VOCABULARY,
  taskType: 'todo',
  taskStatusField: 'state',
  taskBacklogStatuses: ['someday'],
  taskActiveStatuses: ['todo', 'doing'],
  taskBlockedStatuses: ['waiting'],
  taskDoneStatuses: ['finished', 'shipped'],
  taskIgnoredStatuses: ['abandoned'],
  taskTickStatus: 'finished',
  taskUntickStatus: 'todo',
  projectActiveStatuses: [], projectDoneStatuses: [], projectBlockedStatuses: [],
  projectBacklogStatuses: [], projectIgnoredStatuses: [],
  dueField: 'deadline',
  dateField: null,
  scheduledField: 'planned',
};

/** No task status field, and no date fields at all. */
const NO_STATUS: ViewVocabulary = { ...OTHER, taskStatusField: null, dueField: null, dateField: null, scheduledField: null };

const client = {} as Client;
const withVocabulary = (vocabulary?: ViewVocabulary) =>
  ({ children }: { children: ReactNode }) => createElement(VizClientProvider, { client, vocabulary }, children);

const row = (id: string, fields: Record<string, unknown>): VizRow =>
  ({ id, title: `Row ${id}`, file_path: `notes/${id}.md`, types: [], fields, version: 1 });

describe('the default vocabulary', () => {
  it('is today\'s names', () => {
    expect(DEFAULT_VIEW_VOCABULARY).toEqual({
      taskType: 'task', taskStatusField: 'status',
      taskActiveStatuses: ['open', 'in-progress'], taskDoneStatuses: ['done'], taskBlockedStatuses: ['blocked'],
      taskBacklogStatuses: ['backlog'], taskIgnoredStatuses: ['dropped'],
      taskTickStatus: 'done', taskUntickStatus: 'open',
      projectActiveStatuses: ['open', 'in-progress'], projectDoneStatuses: ['done'], projectBlockedStatuses: ['blocked'],
      projectBacklogStatuses: ['backlog'], projectIgnoredStatuses: ['dropped'],
      dueField: 'due', dateField: 'date', scheduledField: 'scheduled', priorityField: 'priority',
    });
  });
});

describe('vizQueryArgs', () => {
  const kanban: VizSpec = { kind: 'kanban', title: '', query: { types: ['task'] }, display_fields: ['priority'] };
  const calendar: VizSpec = { kind: 'calendar', title: '', query: {}, display_fields: [] };

  it('with the default map, or none passed, fetches what it fetched before the map', () => {
    for (const args of [vizQueryArgs(kanban), vizQueryArgs(kanban, DEFAULT_VIEW_VOCABULARY)]) {
      expect(args).toEqual({ types: ['task'], include_fields: ['priority', 'status'], limit: 50 });
    }
    for (const args of [vizQueryArgs(calendar), vizQueryArgs(calendar, DEFAULT_VIEW_VOCABULARY)]) {
      expect(args).toEqual({ include_fields: ['status', 'due', 'date', 'scheduled'], limit: 50 });
    }
  });

  it('a saved spec with explicit names keeps them, whatever the map says', () => {
    const saved: VizSpec = { kind: 'kanban', title: '', query: { types: ['task'] }, display_fields: ['status', 'priority', 'due'], group_by: 'status' };
    expect(vizQueryArgs(saved, OTHER).include_fields).toEqual(['status', 'priority', 'due']);
    expect(vizQueryArgs({ ...calendar, date_field: 'due' }, OTHER).include_fields).toEqual(['state', 'due']);
  });

  it('fetches the vault\'s own status and date fields', () => {
    expect(vizQueryArgs(kanban, OTHER).include_fields).toEqual(['priority', 'state']);
    expect(vizQueryArgs(calendar, OTHER).include_fields).toEqual(['state', 'deadline', 'planned']);
  });

  it('a list always fetches the task status field its checkbox reads, whatever its group_by', () => {
    const list: VizSpec = { kind: 'list', title: '', query: { types: ['task'] }, display_fields: ['status', 'due'] };
    // Today's List preset: unchanged.
    expect(vizQueryArgs(list).include_fields).toEqual(['status', 'due']);
    // A Kanban preset switched to List keeps group_by 'status'; the vault's checkbox field is 'state'.
    expect(vizQueryArgs({ ...list, group_by: 'status' }, OTHER).include_fields).toEqual(['status', 'due', 'state']);
    expect(vizQueryArgs({ ...list, display_fields: ['due'], group_by: 'company' }).include_fields).toEqual(['due', 'company', 'status']);
    expect(vizQueryArgs({ ...list, group_by: 'company' }, NO_STATUS).include_fields).toEqual(['status', 'due', 'company']);
  });

  it('fetches nothing extra for a status or date field the vault does not have', () => {
    expect(vizQueryArgs(kanban, NO_STATUS).include_fields).toEqual(['priority']);
    expect(vizQueryArgs(calendar, NO_STATUS).include_fields).toEqual([]);
  });
});

describe('field fallbacks', () => {
  it('group by the spec\'s field, else the task status field, else none', () => {
    expect(viewStatusField({ group_by: 'company' }, OTHER)).toBe('company');
    expect(viewStatusField({}, DEFAULT_VIEW_VOCABULARY)).toBe('status');
    expect(viewStatusField({}, OTHER)).toBe('state');
    expect(viewStatusField({}, NO_STATUS)).toBeNull();
  });

  it('the calendar tries the vault\'s date fields in order', () => {
    expect(calendarDateFields(DEFAULT_VIEW_VOCABULARY)).toEqual(['due', 'date', 'scheduled']);
    expect(resolveDateField({}, ['planned', 'deadline'], calendarDateFields(OTHER))).toBe('deadline');
    expect(resolveDateField({}, ['due'], calendarDateFields(OTHER))).toBeNull();
    expect(resolveDateField({}, ['date', 'scheduled'])).toBe('date');
  });
});

describe('status order', () => {
  /** Every status word today's views know, mixed case, plus values they don't. */
  const VALUES = [...STATUS_ORDER, 'Done', 'In-Progress', 'archived', 'zebra', ''];

  it('with the default map, today\'s status words keep their order and colours', () => {
    const scale = statusScaleFor(DEFAULT_VIEW_VOCABULARY);
    expect(scale.order.filter((v) => STATUS_ORDER.includes(v))).toEqual(STATUS_ORDER);
    for (const v of VALUES) {
      expect(statusColorVar(v, scale)).toBe(statusColorVar(v, DEFAULT_STATUS_SCALE));
      expect(isStatus(v, scale)).toBe(isStatus(v, DEFAULT_STATUS_SCALE));
    }
    const rows = VALUES.map((v, i) => row(String(i), { status: v }));
    const today = groupRows(rows, 'status').map((g) => g.value);
    expect(groupRows(rows, 'status', scale).map((g) => g.value)).toEqual(today);
    const known = rows.slice(0, STATUS_ORDER.length + 2);
    for (const dir of [1, -1] as const) {
      expect(sortRows(known, { key: 'status', dir }, scale).map((r) => r.id)).toEqual(sortRows(known, { key: 'status', dir }).map((r) => r.id));
    }
  });

  it('with the default map, its one status no view knew today, blocked, goes with the blocked statuses', () => {
    const scale = statusScaleFor(DEFAULT_VIEW_VOCABULARY);
    expect(scale.order).toEqual(['backlog', 'open', 'next', 'in-progress', 'pending', 'blocked', 'done', 'dropped']);
    expect(statusColorVar('blocked', scale)).toBe('--st-blocked');
  });

  it('a vault\'s own status words order by meaning, before values in no list', () => {
    const scale = statusScaleFor(OTHER);
    const rows = ['shipped', 'zebra', 'doing', 'abandoned', 'someday', 'waiting', 'todo', 'finished', 'archived']
      .map((v) => row(v, { state: v }));
    expect(groupRows(rows, 'state', scale).map((g) => g.value))
      .toEqual(['someday', 'todo', 'doing', 'waiting', 'finished', 'shipped', 'abandoned', 'archived', 'zebra']);
    expect(statusColorVar('Doing', scale)).toBe('--st-progress');
    expect(statusColorVar('finished', scale)).toBe('--st-done');
    expect(statusColorVar('waiting', scale)).toBe('--st-blocked');
    expect(isStatus('someday', scale)).toBe(true);
    expect(isStatus('zebra', scale)).toBe(false);
    const statusy = ['finished', 'todo', 'doing'].map((v) => row(v, { state: v }));
    expect(sortRows(statusy, { key: 'state', dir: 1 }, scale).map((r) => r.id)).toEqual(['todo', 'doing', 'finished']);
  });
});

describe('the List checkbox', () => {
  const click = (rows: VizRow[], vocabulary?: ViewVocabulary) => {
    const onToggle = vi.fn();
    const { getByRole } = render(<VizTaskList rows={rows} displayFields={[]} onToggle={onToggle} />, { wrapper: withVocabulary(vocabulary) });
    fireEvent.click(getByRole('button', { name: /toggle/i }));
    return onToggle;
  };

  it('with the default map, ticks status done and unticks it open, as today', () => {
    for (const vocabulary of [undefined, DEFAULT_VIEW_VOCABULARY]) {
      expect(click([row('a', { status: 'open' })], vocabulary)).toHaveBeenCalledWith('a', 'status', 'done');
      cleanup();
      expect(click([row('b', { status: 'done' })], vocabulary)).toHaveBeenCalledWith('b', 'status', 'open');
      cleanup();
    }
  });

  it('is ticked for any of the vault\'s done statuses, and writes its tick and untick values', () => {
    expect(click([row('a', { state: 'doing' })], OTHER)).toHaveBeenCalledWith('a', 'state', 'finished');
    cleanup();
    expect(click([row('b', { state: 'shipped' })], OTHER)).toHaveBeenCalledWith('b', 'state', 'todo');
    cleanup();
    const { container } = render(<VizTaskList rows={[row('c', { state: 'finished' }), row('d', { status: 'done' })]} />, { wrapper: withVocabulary(OTHER) });
    expect([...container.querySelectorAll('.vtask')].map((el) => el.classList.contains('done'))).toEqual([true, false]);
  });

  it('is not shown when the vault has no task status field', () => {
    const { container } = render(<VizTaskList rows={[row('a', { status: 'done' })]} onToggle={vi.fn()} />, { wrapper: withVocabulary(NO_STATUS) });
    expect(container.querySelector('.cbox')).toBeNull();
    expect(container.querySelector('.vtask.done')).toBeNull();
    expect(container.textContent).toContain('Row a');
  });

  it('shows the vault\'s due field as meta when the spec names none', () => {
    const { container } = render(<VizTaskList rows={[row('a', { state: 'todo', deadline: '2026-12-01' })]} />, { wrapper: withVocabulary(OTHER) });
    expect(container.querySelector('.tmeta')?.textContent).toBe('2026-12-01');
  });
});

/** Every value of a status enum like today's installation's: the default map's tick values among them. */
const TODAY_STATUS_ENUM = ['open', 'in-progress', 'pending', 'done', 'dropped', 'backlog', 'next'];

describe('when the List checkbox is shown (#488)', () => {
  it('with the default map, as today: with or without the status enum the view knows', () => {
    expect(taskCheckboxOn(DEFAULT_VIEW_VOCABULARY)).toBe(true);
    expect(taskCheckboxOn(DEFAULT_VIEW_VOCABULARY, TODAY_STATUS_ENUM)).toBe(true);
    expect(taskCheckboxOn(OTHER)).toBe(true);
  });

  it('not with no task status field', () => {
    expect(taskCheckboxOn(NO_STATUS)).toBe(false);
  });

  it('not when the tick value is not a done status: a ticked row would not show ticked', () => {
    // A status field with no done value: the tick value stays Engine's default.
    expect(taskCheckboxOn({ ...OTHER, taskDoneStatuses: [], taskTickStatus: 'done' })).toBe(false);
    expect(taskCheckboxOn({ ...OTHER, taskTickStatus: 'done' })).toBe(false);
  });

  it('not when the untick value is empty or a done status: an unticked row would stay ticked', () => {
    expect(taskCheckboxOn({ ...OTHER, taskUntickStatus: ' ' })).toBe(false);
    expect(taskCheckboxOn({ ...OTHER, taskUntickStatus: 'shipped' })).toBe(false);
  });

  it('with an untick value outside the active list: unticking still writes a status that is not done', () => {
    expect(taskCheckboxOn({ ...DEFAULT_VIEW_VOCABULARY, taskActiveStatuses: ['in-progress'] })).toBe(true);
    expect(taskCheckboxOn({ ...DEFAULT_VIEW_VOCABULARY, taskActiveStatuses: [] })).toBe(true);
  });

  it('not when the field is an enum that does not take the tick or the untick value', () => {
    expect(taskCheckboxOn(DEFAULT_VIEW_VOCABULARY, ['todo', 'waiting'])).toBe(false);
    expect(taskCheckboxOn(DEFAULT_VIEW_VOCABULARY, ['open', 'finished'])).toBe(false);
    expect(taskCheckboxOn(DEFAULT_VIEW_VOCABULARY, ['done', 'todo'])).toBe(false);
    expect(taskCheckboxOn(DEFAULT_VIEW_VOCABULARY, [])).toBe(false);
  });

  it('matches enum values as Engine does: trimmed, ignoring case', () => {
    expect(taskCheckboxOn(DEFAULT_VIEW_VOCABULARY, ['Open', 'DONE'])).toBe(true);
    expect(taskCheckboxOn({ ...DEFAULT_VIEW_VOCABULARY, taskUntickStatus: ' open ' }, ['open', 'done'])).toBe(true);
  });

  it('reads the enum from the type\'s schema only when the field is an enum with values', () => {
    const schema = { fields: [
      { name: 'status', type: 'enum' as const, required: false, default_value: null, enum_values: ['open', 'done'], ui: null },
      { name: 'state', type: 'string' as const, required: false, default_value: null, ui: null },
      { name: 'stage', type: 'enum' as const, required: false, default_value: null, ui: null },
    ] };
    expect(enumValuesOf(schema, 'status')).toEqual(['open', 'done']);
    expect(enumValuesOf(schema, 'state')).toBeUndefined();
    expect(enumValuesOf(schema, 'stage')).toBeUndefined();
    expect(enumValuesOf(schema, 'phase')).toBeUndefined();
    expect(enumValuesOf(schema, null)).toBeUndefined();
    expect(enumValuesOf(null, 'status')).toBeUndefined();
  });
});

describe('a List whose checkbox cannot work (#488)', () => {
  /** The issue's vault: a "state" enum with only todo and waiting, so no done value; Engine's tick values stay. */
  const NO_DONE: ViewVocabulary = {
    ...OTHER, taskActiveStatuses: ['todo'], taskBlockedStatuses: ['waiting'], taskDoneStatuses: [],
    taskTickStatus: 'done', taskUntickStatus: 'open',
  };

  it('shows each row\'s status instead, with no checkbox and no error', () => {
    const onToggle = vi.fn();
    const rows = [row('a', { state: 'todo', deadline: '2026-12-01' }), row('b', { state: 'waiting' }), row('c', {})];
    const { container } = render(<VizTaskList rows={rows} displayFields={['state', 'deadline']} onToggle={onToggle} />, { wrapper: withVocabulary(NO_DONE) });
    expect(container.querySelector('.cbox')).toBeNull();
    expect(container.querySelector('button[aria-label^="toggle"]')).toBeNull();
    expect([...container.querySelectorAll('.vtask')].map((el) => el.querySelector('.spill')?.textContent ?? null)).toEqual(['todo', 'waiting', null]);
    expect(container.querySelector('.vtask .tmeta')?.textContent).toBe('todo2026-12-01');
    expect(container.textContent).toContain('Row a');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('shows the status, not the checkbox, when the field\'s enum does not take a tick value', () => {
    const { container } = render(
      <VizTaskList rows={[row('a', { status: 'todo' })]} displayFields={[]} onToggle={vi.fn()} statusEnum={['todo', 'done']} />,
      { wrapper: withVocabulary(DEFAULT_VIEW_VOCABULARY) },
    );
    expect(container.querySelector('.cbox')).toBeNull();
    expect(container.querySelector('.spill')?.textContent).toBe('todo');
  });

  it('keeps a done row struck through', () => {
    const { container } = render(<VizTaskList rows={[row('a', { status: 'done' })]} displayFields={[]} statusEnum={['done', 'todo']} />);
    expect(container.querySelector('.cbox')).toBeNull();
    expect(container.querySelector('.vtask.done .spill')?.textContent).toBe('done');
  });

  it('with the default map and a status enum like today\'s, the checkbox is as today: no status pill, done and open written', () => {
    const onToggle = vi.fn();
    const { container, getAllByRole } = render(
      <VizTaskList rows={[row('a', { status: 'next' }), row('b', { status: 'done' })]} displayFields={['status', 'due']} onToggle={onToggle} statusEnum={TODAY_STATUS_ENUM} />,
    );
    expect(container.querySelector('.spill')).toBeNull();
    const [tick, untick] = getAllByRole('button', { name: /toggle/i });
    fireEvent.click(tick!);
    fireEvent.click(untick!);
    expect(onToggle.mock.calls).toEqual([['a', 'status', 'done'], ['b', 'status', 'open']]);
  });
});

describe('the kanban', () => {
  it('colours and orders its columns by the vault\'s statuses', () => {
    const rows = [row('a', { state: 'finished' }), row('b', { state: 'todo' })];
    const { container } = render(<VizKanban rows={rows} groupBy="state" displayFields={[]} />, { wrapper: withVocabulary(OTHER) });
    expect([...container.querySelectorAll('.kt')].map((el) => el.textContent)).toEqual(['todo', 'finished']);
    const dots = [...container.querySelectorAll('.kcol-head .d')].map((el) => (el as HTMLElement).style.background);
    expect(dots).toEqual(['var(--st-progress)', 'var(--st-done)']);
  });
});
