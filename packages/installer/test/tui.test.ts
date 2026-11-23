import { describe, expect, it } from 'vitest';
import { checkTally, colorMarks, createStyle, INSTALL_STEPS, PLAIN, plainStepLine, progressBar, renderStepMap, renderWelcome, SETUP_STEPS, steadyColumns, steadyRows, usableColumns, usableRows, wrap } from '../src/tui.js';

describe('tui', () => {
  it('draws the step map with finished, current, and later steps', () => {
    const lines = renderStepMap({ journey: 'Setup', steps: SETUP_STEPS, index: 2 }, PLAIN, 80);
    expect(lines[0]).toBe(`●━━━━━━━━●━━━━━━━━◉${'────────○'.repeat(SETUP_STEPS.length - 3)}`);
    expect(lines[1]).toMatch(/^Computer Folder {3}Notes {4}AI keys/);
    expect(lines).toContain('Setup · Step 3 of 8');
    expect(lines).toContain('Sort your notes into kinds');
  });

  it('drops the step names on a narrow terminal', () => {
    const lines = renderStepMap({ journey: 'Install', steps: INSTALL_STEPS, index: 0 }, PLAIN, 40);
    expect(lines[0]).toBe(`◉${'───○'.repeat(INSTALL_STEPS.length - 1)}`);
    expect(lines[1]).toBe('');
  });

  it('prints one plain line per step for headless runs', () => {
    expect(plainStepLine({ journey: 'Install', steps: INSTALL_STEPS, index: 6 })).toBe('[Install 7/8] Check everything works');
  });

  it('lists every setup step on the welcome screen and says nothing changes in a practice run', () => {
    const text = renderWelcome('plan', PLAIN);
    for (const step of SETUP_STEPS) expect(text).toContain(step.title);
    expect(text).toContain('Two ways through them\n  Quick setup asks for your notes folder and one AI key.');
    expect(text).toContain('Choose everything asks each question in turn');
    expect(text).toContain('nothing on this computer changes');
    expect(text).toContain('quit at any time; nothing is changed');
  });

  it('promises an unchanged computer on Ctrl+C only before an install is approved', () => {
    const text = renderWelcome('install', PLAIN);
    expect(text).not.toContain('quit at any time; nothing is changed');
    expect(text).toContain('Before you approve the plan, nothing is changed;\n  after that, run install again to pick up where it stopped');
  });

  it('colors status marks only when color is on', () => {
    const text = '✓ Node.js: 24\n! Memory: low\nplain line';
    expect(colorMarks(text, PLAIN)).toBe(text);
    const colored = colorMarks(text, createStyle(true));
    expect(colored).toContain('\u001b[');
    expect(colored).toContain('▲');
    expect(colored.split('\n')[2]).toBe('plain line');
  });

  it('tallies checks and draws a progress bar', () => {
    expect(checkTally(['pass', 'pass', 'warn'])).toBe('2 passed · 1 to note · no problems');
    expect(checkTally(['pass', 'fail'])).toBe('1 passed · 1 problem');
    expect(progressBar(2, 8, PLAIN, 8)).toBe('██░░░░░░ 2/8');
  });

  it('never draws a progress bar longer or shorter than its width', () => {
    expect(progressBar(9, 8, PLAIN, 8)).toBe('████████ 9/8');
    expect(progressBar(-1, 8, PLAIN, 8)).toBe('░░░░░░░░ -1/8');
    expect(progressBar(0, 0, PLAIN, 8)).toBe('████████ 0/0');
  });

  it.each([
    [0, 80],
    [undefined, 80],
    [Number.NaN, 80],
    [Number.POSITIVE_INFINITY, 80],
    [1, 80],
    [19, 80],
    [20, 20],
    [80, 80],
    [120.5, 120],
    [200, 200],
  ])('lays out a terminal that reports %s columns at %i (#469)', (reported, expected) => {
    expect(usableColumns(reported)).toBe(expected);
  });

  it('makes a stream report a usable width, and follows a resize', () => {
    const stream: { columns?: number } = { columns: 0 };
    steadyColumns(stream);
    expect(stream.columns).toBe(80);
    stream.columns = 132;
    expect(stream.columns).toBe(132);
    stream.columns = 0;
    expect(stream.columns).toBe(80);
    steadyColumns(stream);
    stream.columns = 40;
    expect(stream.columns).toBe(40);

    const piped: { columns?: number } = {};
    steadyColumns(piped);
    expect(piped.columns).toBe(80);
  });

  it.each([
    [0, 24],
    [undefined, 24],
    [Number.NaN, 24],
    [Number.POSITIVE_INFINITY, 24],
    [1, 24],
    [4, 24],
    [5, 5],
    [12, 12],
    [24, 24],
    [30.7, 30],
    [60, 60],
  ])('lays out a terminal that reports %s rows at %i (#489)', (reported, expected) => {
    expect(usableRows(reported)).toBe(expected);
  });

  it('makes a stream report a usable height, and follows a resize', () => {
    const stream: { rows?: number; columns?: number } = { rows: 0, columns: 0 };
    steadyRows(stream);
    expect(stream.rows).toBe(24);
    expect(stream.columns).toBe(0);
    stream.rows = 50;
    expect(stream.rows).toBe(50);
    stream.rows = 0;
    expect(stream.rows).toBe(24);
    steadyRows(stream);
    stream.rows = 12;
    expect(stream.rows).toBe(12);

    const piped: { rows?: number } = {};
    steadyRows(piped);
    expect(piped.rows).toBe(24);
  });

  it('wraps on spaces', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });
});
