import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { limitOptions } from '@clack/prompts';
import { createClackPrompter, folderOptions } from '../src/prompter.js';
import { SUMMARY_WIDTH } from '../src/report.js';
import { SETUP_STEPS } from '../src/tui.js';
import { makeTree, removeTrees } from './helpers.js';

afterEach(removeTrees);

describe('the interactive screens at any terminal width (#469)', () => {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const originalRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  let written: string[];

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (original) Object.defineProperty(process.stdout, 'columns', original);
    else delete (process.stdout as { columns?: number }).columns;
    // The prompter steadies the height too (#489).
    if (originalRows) Object.defineProperty(process.stdout, 'rows', originalRows);
    else delete (process.stdout as { rows?: number }).rows;
  });

  /** What was written since the last call, one entry per line, without color. */
  const take = (): string[] => {
    const lines = written.join('').split('\n').map(line => stripVTControlCharacters(line)).filter(Boolean);
    written = [];
    return lines;
  };

  it.each([
    [0, 80],
    [undefined, 80],
    [1, 80],
    [20, 20],
    [80, 80],
    [200, 200],
  ])('draws the welcome box, step map, notes, and summary box when the terminal reports %s columns', (reported, expected) => {
    // As the terminal reports it: a pseudo-terminal with no size set reports 0.
    Object.defineProperty(process.stdout, 'columns', { value: reported, writable: true, configurable: true, enumerable: true });
    const prompter = createClackPrompter('install');

    prompter.welcome('install');
    const welcome = take();
    expect(welcome[0]).toHaveLength(expected);
    expect(welcome.join('\n')).toContain('Welcome!');
    for (const line of welcome) expect(line.length).toBeLessThanOrEqual(expected);

    prompter.step({ journey: 'Setup', steps: SETUP_STEPS, index: 2 });
    const step = take().join('\n');
    expect(step).toContain('Setup · Step 3 of 8');
    // The step names fit under the dots only on a terminal wide enough for them.
    expect(step.includes('Computer')).toBe(expected >= 80);

    // The plan in short is drawn for 80 columns: a row of it fits on one line of its note.
    const row = 'x'.repeat(SUMMARY_WIDTH);
    prompter.note(row, 'The plan in short');
    const note = take();
    expect(note.some(line => line.includes(row))).toBe(expected >= 80);

    prompter.success('✓ Vault Engine is running    http://localhost:3334/mcp', 'Vault is ready');
    const success = take();
    expect(success.join(' ')).toContain(expected >= 80 ? 'Vault is ready' : 'Vault is r...');
    for (const line of success) expect(line).toHaveLength(expected);
  });
});

describe('the option lists at any terminal height (#489)', () => {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'rows');

  afterEach(() => {
    if (original) Object.defineProperty(process.stdout, 'rows', original);
    else delete (process.stdout as { rows?: number }).rows;
  });

  const options = Array.from({ length: 100 }, (_, index) => ({ value: `option-${index}`, label: `Option ${index}` }));

  it.each([
    [0, 18],
    [undefined, 18],
    [Number.NaN, 18],
    [1, 18],
    [4, 18],
    [5, 1],
    [12, 6],
    [24, 18],
    [50, 44],
  ])('pages a list when the terminal reports %s rows, showing %i options', (reported, shown) => {
    // As the terminal reports it: a pseudo-terminal with no size set reports 0.
    Object.defineProperty(process.stdout, 'rows', { value: reported, writable: true, configurable: true, enumerable: true });
    createClackPrompter('install');

    // clack's own paging, as select, multiselect, and autocomplete use it: process.stdout's
    // rows less the prompt's lines (five here), one of them a "..." for the options below.
    const lines = limitOptions({ cursor: 0, options, style: option => option.label, rowPadding: 5 })
      .map(line => stripVTControlCharacters(line));
    expect(lines.filter(line => line.startsWith('Option '))).toHaveLength(shown);
    expect(lines.at(-1)).toBe('...');
  });
});

describe('folderOptions', () => {
  it('suggests the folders that start with what is typed', async () => {
    const root = await makeTree({ 'Notes/A.md': '', 'Notebook/': '', 'Other/': '', 'Notes.md': '' });

    expect(folderOptions(join(root, 'No')).map(option => option.value))
      .toEqual([join(root, 'Notebook'), join(root, 'Notes'), join(root, 'No')]);
    expect(folderOptions(`${root}/`).map(option => option.value).slice(0, 3))
      .toEqual([join(root, 'Notebook'), join(root, 'Notes'), join(root, 'Other')]);
  });

  it('offers no extra choice for an existing folder typed in full', async () => {
    const root = await makeTree({ 'Notes/A.md': '' });

    expect(folderOptions(join(root, 'Notes'))).toEqual([{ value: join(root, 'Notes'), label: join(root, 'Notes') }]);
  });

  it('offers a typed folder that does not exist yet as a new folder', async () => {
    const root = await makeTree({});
    const typed = join(root, 'Fresh', 'Notes');

    expect(folderOptions(typed)).toEqual([{ value: typed, label: typed, hint: 'new folder' }]);
  });

  it('offers a typed path under ~ as typed, marking only a missing one as new', async () => {
    const home = await makeTree({ 'Notes/A.md': '' });

    expect(folderOptions('~/Notes', home)).toEqual([{ value: '~/Notes', label: '~/Notes' }]);
    expect(folderOptions('~/Fresh', home)).toEqual([{ value: '~/Fresh', label: '~/Fresh', hint: 'new folder' }]);
  });

  it('reads a relative path from the given folder, as the answer will be read', async () => {
    const from = await makeTree({ 'Notes/A.md': '', 'Notebook/': '', 'package.json/': '' });

    expect(folderOptions('No', '/nowhere', from).map(option => option.value)).toEqual(['Notebook', 'Notes', 'No']);
    // A file of that name in this process's folder does not hide the folder there.
    expect(folderOptions('package.json', '/nowhere', from)).toEqual([{ value: 'package.json', label: 'package.json' }]);
    expect(folderOptions('Fresh', '/nowhere', from)).toEqual([{ value: 'Fresh', label: 'Fresh', hint: 'new folder' }]);
  });

  it('suggests the folders under ~ that start with what is typed', async () => {
    const home = await makeTree({ 'Notes/A.md': '', 'Notebook/': '', 'Other/': '' });

    expect(folderOptions('~/No', home).map(option => option.value)).toEqual(['~/Notebook', '~/Notes', '~/No']);
  });

  it('never offers a file as the folder, or anything for an empty answer', async () => {
    const root = await makeTree({ 'Notes.md': '' });

    expect(folderOptions(join(root, 'Notes.md'))).toEqual([]);
    expect(folderOptions('')).toEqual([]);
  });
});
