import { descriptorsFor, validateValue } from '@vault/settings-registry';
import { afterEach, describe, expect, it } from 'vitest';
import { createAnalyzerRunner } from '../src/analyzer.js';
import type { CuratorPlan } from '../src/curator-plan.js';
import type { StructurePlan } from '../src/structure.js';
import {
  buildVaultMap,
  detectActiveStatuses,
  detectDailyNoteType,
  detectMapField,
  detectMapFields,
  detectStatusGroups,
  fieldNamesOf,
  mapFieldCandidates,
  NO_STATUS,
  proposeVaultMap,
  renderVaultMap,
  statusFieldCandidates,
  taskCheckboxOff,
  taskTickValues,
  vaultMapSettings,
} from '../src/vault-map.js';
import type { VaultPlan } from '../src/vault.js';
import { fm, makeTree, removeTrees, SOURCE_ANALYZER } from './helpers.js';

afterEach(removeTrees);

const analyzer = createAnalyzerRunner(SOURCE_ANALYZER);
const CURATOR: CuratorPlan = { dailyBudgetCents: 100, sweepAt: '05:00', tz: 'UTC', wikiMode: 'live' };
const VAULT = { wikiDir: 'Wikis', topicDir: 'Topics' } as VaultPlan;

async function analysisOf(files: Record<string, string>) {
  const root = await makeTree(files);
  return analyzer.analyze(root, { type_field: 'type', folder_rules: [], type_renames: {}, exclude: [] });
}

describe('proposeVaultMap', () => {
  it('detects each designation from the notes alone, leaving the rest none', async () => {
    const analysis = await analysisOf({
      'Initiatives/Alpha.md': fm({ type: 'initiative', stage: 'active' }),
      'Initiatives/Beta.md': fm({ type: 'initiative', stage: 'complete' }),
      'Todos/One.md': fm({ type: 'todo', state: 'open', owner: 'Avery' }),
      'Todos/Two.md': fm({ type: 'todo', state: 'done', owner: 'Blake' }),
      'Notes/Idea.md': fm({ type: 'Note' }),
    });

    const map = proposeVaultMap({ analysis, renames: { project: 'initiative' } });

    // A kind follows a rename of its type; otherwise its type's name.
    expect(map.kinds).toEqual({ project: 'initiative', task: 'todo', meeting: null, person: null, company: null });
    expect(map.status.project).toEqual({
      field: 'stage', starter: false, active: ['active'], groups: { done: ['complete'], blocked: [], backlog: [], ignored: [] },
    });
    expect(map.status.task).toEqual({
      field: 'state', starter: false, active: ['open'], groups: { done: ['done'], blocked: [], backlog: [], ignored: [] },
    });
    expect(map.journalType).toBe('Note');
    // The kind's own status-like field first, then its other text fields.
    expect(statusFieldCandidates(analysis, 'todo')).toEqual(['state', 'stage', 'owner']);
  });

  it('reads a value still to do as open for tasks and as backlog for projects', () => {
    const values = ['todo', 'doing', 'done'];

    expect(detectActiveStatuses(values, 'task')).toEqual(['todo', 'doing']);
    expect(detectActiveStatuses(values, 'project')).toEqual(['doing']);
    expect(detectStatusGroups(values, ['doing'])).toMatchObject({ backlog: ['todo'], done: ['done'] });
  });

  it('proposes nothing new for a vault with no types', () => {
    expect(proposeVaultMap({ analysis: null, renames: {} })).toEqual({
      kinds: { project: null, task: null, meeting: null, person: null, company: null },
      status: { project: NO_STATUS, task: NO_STATUS },
      fields: { due: null, date: null, people: null, company: null, priority: null, scheduled: null },
      journalType: 'note',
    });
  });

  it('designates each other field from a line the notes have, by name, else none', async () => {
    const analysis = await analysisOf({
      'Tasks/One.md': fm({ type: 'task', Deadline: '2026-01-01', attendees: '"[[Avery]]"', prio: 'high' }),
      'Tasks/Two.md': fm({ type: 'task', Deadline: '2026-02-01', attendees: '"[[Blake]]"', prio: 'low' }),
      'People/Avery.md': fm({ type: 'person' }),
    });

    // Matched ignoring case; a line no name matches is none, not Engine's default name.
    expect(proposeVaultMap({ analysis, renames: {} }).fields).toEqual({
      due: 'Deadline', date: null, people: 'attendees', company: null, priority: 'prio', scheduled: null,
    });
  });
});

describe('the map\'s other fields', () => {
  it('prefers Engine\'s own name, then the others in order, ignoring case, spaces, _ and -', () => {
    expect(detectMapField('due', ['deadline', 'due'])).toBe('due');
    expect(detectMapField('due', ['Due_Date', 'deadline'])).toBe('Due_Date');
    expect(detectMapField('people', ['people-involved', 'attendees'])).toBe('people-involved');
    expect(detectMapField('scheduled', ['do date'])).toBe('do date');
    expect(detectMapField('company', ['client'])).toBeNull();
    // Offered best first, then the rest as they come.
    expect(mapFieldCandidates('due', ['owner', 'deadline', 'due'])).toEqual(['due', 'deadline', 'owner']);
  });

  it('counts a field the notes use in more than one way, and one a new type adds', async () => {
    const analysis = await analysisOf({
      'Projects/Alpha.md': fm({ type: 'project', date: '2026-01-01' }),
      'Projects/Beta.md': fm({ type: 'project', date: '7' }),
    });

    expect(analysis.needs_review.ambiguous_fields.map(field => field.name)).toEqual(['date']);
    expect(detectMapFields(fieldNamesOf(analysis, ['due', 'people involved']))).toEqual({
      due: 'due', date: 'date', people: 'people involved', company: null, priority: null, scheduled: null,
    });
  });
});

describe('the planned map', () => {
  const structure = {
    roles: { project: 'project', task: 'action', meeting: null, person: null, company: null },
    status: {
      project: NO_STATUS,
      task: { field: 'state', starter: true, active: ['open', 'in-progress'], groups: { done: ['done'], blocked: ['blocked'], backlog: ['backlog'], ignored: ['dropped'] } },
    },
    fields: { due: 'due', date: null, people: null, company: null, priority: null, scheduled: null },
    journalType: 'note',
    analysis: { proposal: { schemas: [{ name: 'project' }] } },
    starterTypes: [{ name: 'action', role: 'task', claims: ['state'] }],
  } as unknown as StructurePlan;

  it('states each designation, where it comes from, and what each none turns off', () => {
    const map = buildVaultMap(VAULT, structure, CURATOR);

    expect(map.kinds).toEqual({
      project: { type: 'project', from: 'vault' },
      task: { type: 'action', from: 'starter' },
      meeting: { type: null, from: null },
      person: { type: null, from: null },
      company: { type: null, from: null },
      journal: { type: 'note', from: 'curator' },
      dailyNote: { type: null, from: null },
    });
    expect(map.status.project).toEqual({ field: null, from: null, active: [], done: [], blocked: [], backlog: [], ignored: [] });
    expect(map.status.task).toMatchObject({ field: 'state', from: 'starter', active: ['open', 'in-progress'], done: ['done'] });
    expect(map.folders).toEqual({ wiki_dir: 'Wikis', topic_dir: 'Topics' });
    expect(map.off).toEqual([
      'No meeting kind: project wikis draw on no meeting notes.',
      'No person kind: project wikis list no people.',
      'No company kind: project wikis list no companies.',
      'No daily-note kind: search ranks no note as a daily note.',
      'Projects have no status field: Curator counts every project as active, and wikis show no project status.',
      'No date field: nothing reads a meeting\'s or note\'s date from a field.',
      'No people field: project wikis list no people linked from notes.',
      'No company field: project wikis list no companies linked from notes.',
      'No priority field: nothing reads a task\'s priority.',
      'No scheduled-date field: nothing reads when a task is scheduled.',
    ]);
    expect(map.fields).toEqual({ due: 'due', date: null, people: null, company: null, priority: null, scheduled: null });
    const text = renderVaultMap(map);
    expect(text).toContain('  projects: project\n    status field: none');
    expect(text).toContain('  tasks: action (a new type)\n    status field: state (a new field); active: open, in-progress; done: done;');
    expect(text).toContain('  Curator\'s journal: note (a new kind; Curator creates it when it first writes)');
    expect(text).toContain('  daily notes: none');
    expect(text).toContain('Off, because of a none:\n  No meeting kind');
    expect(text).toContain('  fields: due date: due; date: none; people: none; company: none; priority: none; scheduled date: none');
  });

  it('designates the notes\' daily-note kind, found by name (#572)', () => {
    expect(detectDailyNoteType(['project', 'Daily Notes', 'daily-note'])).toBe('daily-note');
    for (const name of ['Daily Notes', 'daily', 'Daily_Note', 'dailies', 'daily journal']) {
      expect(detectDailyNoteType(['project', name]), name).toBe(name);
    }
    for (const name of ['daily-standup', 'journal', 'note', 'meeting']) {
      expect(detectDailyNoteType([name]), name).toBeNull();
    }

    const withDaily = { ...structure, analysis: { proposal: { schemas: [{ name: 'project' }, { name: 'Daily Notes' }] } } } as unknown as StructurePlan;
    const map = buildVaultMap(VAULT, withDaily, CURATOR);
    expect(map.kinds.dailyNote).toEqual({ type: 'Daily Notes', from: 'vault' });
    expect(map.off).not.toContain('No daily-note kind: search ranks no note as a daily note.');
    expect(renderVaultMap(map)).toContain('  daily notes: Daily Notes');
    expect(vaultMapSettings(map)).toContainEqual({ setting: 'vault.dailyNoteType', value: 'Daily Notes' });
    // A starter type is never a daily-note kind, and none is written as null.
    expect(vaultMapSettings(buildVaultMap(VAULT, structure, CURATOR))).toContainEqual({ setting: 'vault.dailyNoteType', value: null });
  });

  it('designates no journal kind and sets no topic folder without Curator', () => {
    const map = buildVaultMap(VAULT, structure, null);

    expect(map.kinds.journal).toEqual({ type: null, from: null });
    expect(map.folders.topic_dir).toBeNull();
    expect(renderVaultMap(map)).toContain('Curator\'s journal: none (Curator is not installed)');
    expect(vaultMapSettings(map).find(setting => setting.setting === 'vault.journalType')).toEqual({ setting: 'vault.journalType', value: null });
    expect(vaultMapSettings(map).some(setting => setting.setting === 'vault.topicDir')).toBe(false);
  });

  it('writes only vault keys Engine accepts, none as null', () => {
    const settings = vaultMapSettings(buildVaultMap(VAULT, structure, CURATOR));
    const descriptors = new Map(descriptorsFor('vault').map(descriptor => [`vault.${descriptor.key}`, descriptor]));

    for (const { setting, value } of settings) {
      const descriptor = descriptors.get(setting);
      expect(descriptor, setting).toBeDefined();
      expect(validateValue(descriptor!, value), setting).toBeNull();
    }
    expect(settings).toContainEqual({ setting: 'vault.meetingType', value: null });
    expect(settings).toContainEqual({ setting: 'vault.projectStatusField', value: null });
    expect(settings).toContainEqual({ setting: 'vault.projectActiveStatuses', value: [] });
    expect(settings).toContainEqual({ setting: 'vault.taskTickStatus', value: 'done' });
    expect(settings).toContainEqual({ setting: 'vault.dueField', value: 'due' });
    expect(settings).toContainEqual({ setting: 'vault.peopleField', value: null });
  });
});

describe('the task checkbox (#488)', () => {
  const ENUM = (values: string[]) => ({ values, restricted: true, incomplete: false });
  const TEXT = (values: string[]) => ({ values, restricted: false, incomplete: false });

  it('ticks with the field\'s own done and open values, done and open first, and invents none', () => {
    expect(taskTickValues({ active: ['doing', 'open'], done: ['finished', 'done'] })).toEqual({ tick: 'done', untick: 'open' });
    expect(taskTickValues({ active: ['todo'], done: ['finished'] })).toEqual({ tick: 'finished', untick: 'todo' });
    expect(taskTickValues({ active: [], done: [] })).toEqual({ tick: undefined, untick: undefined });
  });

  it('is on when the field has a done and an open value', () => {
    expect(taskCheckboxOff({ active: ['open', 'in-progress'], done: ['done'] }, ENUM(['open', 'in-progress', 'done']))).toBeNull();
    expect(taskCheckboxOff({ active: ['todo'], done: ['finished'] }, ENUM(['todo', 'finished']))).toBeNull();
  });

  it('is off with no done value: the tick value would stay Engine\'s done', () => {
    expect(taskCheckboxOff({ active: ['todo'], done: [] }, ENUM(['todo', 'waiting']))).toBe('done');
    // Even where the field could take done: a ticked task would not show as done.
    expect(taskCheckboxOff({ active: ['todo'], done: [] }, TEXT(['todo', 'waiting']))).toBe('done');
  });

  it('is off with no open value only when the field cannot take Engine\'s open', () => {
    expect(taskCheckboxOff({ active: [], done: ['finished'] }, ENUM(['waiting', 'finished']))).toBe('open');
    expect(taskCheckboxOff({ active: [], done: [] }, ENUM(['waiting']))).toBe('done or open');
    // Plain text takes open: unticking writes it, as it did before the map.
    expect(taskCheckboxOff({ active: [], done: ['finished'] }, TEXT(['waiting', 'finished']))).toBeNull();
    // An enum value Engine matches ignoring case.
    expect(taskCheckboxOff({ active: [], done: ['Finished'] }, ENUM(['Open', 'Finished']))).toBeNull();
  });

  it('a designated status field with no done value: the review says the checkbox is off, and no tick value is written', async () => {
    const analysis = await analysisOf(Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
      `Todos/T${index}.md`, fm({ type: 'todo', state: index % 2 === 0 ? 'todo' : 'waiting' }),
    ])));
    const proposed = proposeVaultMap({ analysis, renames: {} });
    expect(proposed.status.task).toEqual({
      field: 'state', starter: false, active: ['todo'], groups: { done: [], blocked: ['waiting'], backlog: [], ignored: [] },
    });
    const structure = {
      roles: proposed.kinds,
      status: proposed.status,
      fields: proposed.fields,
      journalType: 'note',
      analysis,
      starterTypes: [],
    } as unknown as StructurePlan;

    const map = buildVaultMap(VAULT, structure, null);
    const line = 'The task status field state has no done value: a List view shows each task\'s status, with no checkbox to tick it off.';
    expect(map.off).toContain(line);
    expect(renderVaultMap(map)).toContain(`Off, because of a none:\n`);
    expect(renderVaultMap(map)).toContain(`  ${line}`);
    const settings = vaultMapSettings(map);
    expect(settings.some(setting => setting.setting === 'vault.taskTickStatus')).toBe(false);
    expect(settings).toContainEqual({ setting: 'vault.taskUntickStatus', value: 'todo' });
    expect(settings).toContainEqual({ setting: 'vault.taskDoneStatuses', value: [] });
  });

  it('a status field with done and open values: nothing about the checkbox', async () => {
    const analysis = await analysisOf(Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
      `Tasks/T${index}.md`, fm({ type: 'task', status: index % 2 === 0 ? 'open' : 'done' }),
    ])));
    const proposed = proposeVaultMap({ analysis, renames: {} });
    const structure = {
      roles: proposed.kinds, status: proposed.status, fields: proposed.fields, journalType: 'note', analysis, starterTypes: [],
    } as unknown as StructurePlan;

    const map = buildVaultMap(VAULT, structure, null);
    expect(map.off.filter(line => line.includes('checkbox'))).toEqual([]);
    expect(vaultMapSettings(map)).toEqual(expect.arrayContaining([
      { setting: 'vault.taskTickStatus', value: 'done' },
      { setting: 'vault.taskUntickStatus', value: 'open' },
    ]));
  });
});
