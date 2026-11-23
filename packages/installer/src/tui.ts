import { styleText } from 'node:util';

/**
 * The installer's look: the welcome screen, the step map shown at the top of every step,
 * and the colors for check marks. Pure functions over strings, so headless output and
 * tests can use them without a terminal.
 */

type Format = Parameters<typeof styleText>[0];

export interface Style {
  readonly enabled: boolean;
  paint(format: Format, text: string): string;
}

export function createStyle(enabled: boolean): Style {
  return {
    enabled,
    paint: (format, text) => (enabled ? styleText(format, text, { validateStream: false }) : text),
  };
}

/** Color when stdout is a terminal that wants it (honors NO_COLOR and FORCE_COLOR). */
export function terminalStyle(stream: NodeJS.WriteStream = process.stdout): Style {
  const env = process.env;
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0';
  const disabled = env.NO_COLOR !== undefined || env.TERM === 'dumb';
  return createStyle(forced || (!disabled && Boolean(stream.isTTY)));
}

export const PLAIN: Style = createStyle(false);

/** The width the screens are laid out for when the terminal reports none it can use. */
export const DEFAULT_COLUMNS = 80;
/** Narrower than this, a reported width is not a terminal anything can be drawn in. */
export const MIN_COLUMNS = 20;

/**
 * The terminal width to lay out for: `columns` as the terminal reports it, or 80 when it
 * reports none, 0 (a pseudo-terminal with no size set), something other than a number,
 * or fewer than 20 columns.
 */
export function usableColumns(columns: unknown): number {
  return typeof columns === 'number' && Number.isFinite(columns) && columns >= MIN_COLUMNS
    ? Math.floor(columns)
    : DEFAULT_COLUMNS;
}

/** The height the option lists are laid out for when the terminal reports none it can use. */
export const DEFAULT_ROWS = 24;
/** Shorter than this, a reported height cannot show a question, an option, and its footer. */
export const MIN_ROWS = 5;

/**
 * The terminal height to lay out for: `rows` as the terminal reports it, or 24 when it
 * reports none, 0 (a pseudo-terminal with no size set), something other than a number,
 * or fewer than 5 rows.
 */
export function usableRows(rows: unknown): number {
  return typeof rows === 'number' && Number.isFinite(rows) && rows >= MIN_ROWS
    ? Math.floor(rows)
    : DEFAULT_ROWS;
}

/**
 * Make `stream` report a usable width (`usableColumns`) from now on, through resizes too.
 * @clack/prompts reads `process.stdout.columns` itself for every box, note, spinner, and
 * prompt: at 0 its box throws `RangeError: Invalid count value`, and the others break
 * every character onto a line of its own. A stream whose width is already an accessor
 * (steadied before) is left as it is.
 */
export function steadyColumns(stream: { columns?: number }): void {
  steady(stream, 'columns', usableColumns);
}

/**
 * Make `stream` report a usable height (`usableRows`) from now on, through resizes too.
 * @clack/prompts fits its option lists (`select`, `multiselect`, `autocomplete`) into
 * `process.stdout.rows` less the prompt's own lines: at 0 that is none, so a list shows only
 * the highlighted option between `...` lines (#489). Left alone when already an accessor.
 */
export function steadyRows(stream: { rows?: number }): void {
  steady(stream, 'rows', usableRows);
}

function steady<K extends 'columns' | 'rows'>(
  stream: { [key in K]?: number },
  key: K,
  usable: (reported: unknown) => number,
): void {
  if (Object.getOwnPropertyDescriptor(stream, key)?.get) return;
  let reported: unknown = stream[key];
  Object.defineProperty(stream, key, {
    configurable: true,
    enumerable: true,
    get: () => usable(reported),
    set: (value: unknown) => {
      reported = value;
    },
  });
}

/** One stop on the step map. */
export interface Step {
  id: string;
  /** A word or two for the step map. */
  short: string;
  /** The heading shown when the step starts. */
  title: string;
  /** One or two plain sentences: what this step is for. */
  about: string;
}

/** Where a step sits in its journey, as the prompter shows it. */
export interface StepView {
  journey: string;
  steps: readonly Step[];
  index: number;
}

/** The questions both `plan` and `install` ask, in order. */
export const SETUP_STEPS: readonly Step[] = [
  {
    id: 'computer',
    short: 'Computer',
    title: 'Check this computer',
    about: 'A quick look to make sure this machine can run Vault. Nothing is changed.',
  },
  {
    id: 'folder',
    short: 'Folder',
    title: 'Choose your notes folder',
    about: 'Pick the folder of Markdown notes you want Vault to work with.',
  },
  {
    id: 'notes',
    short: 'Notes',
    title: 'Sort your notes into kinds',
    about: 'Vault learns which kinds of notes you keep (meetings, people, projects…) so it can organize them. The suggestions come from your own notes.',
  },
  {
    id: 'keys',
    short: 'AI keys',
    title: 'Connect AI services',
    about: 'Add an API key for each AI service you use. Every key is optional and stays on this computer.',
  },
  {
    id: 'curator',
    short: 'Curator',
    title: 'Set up Curator',
    about: 'Curator is an optional helper that keeps your wikis up to date. It never spends more than a daily limit you set.',
  },
  {
    id: 'models',
    short: 'Models',
    title: 'Choose AI models',
    about: 'Choose which AI models do the work. A preset is the easy choice, and you can change models later.',
  },
  {
    id: 'backup',
    short: 'Backup',
    title: 'Back up your notes',
    about: 'Make a safety copy of your notes before anything in them changes.',
  },
  {
    id: 'review',
    short: 'Review',
    title: 'Review the plan',
    about: 'Here is the plan in short, with every file and command on request. Nothing has changed yet.',
  },
];

/** What `install` does once the plan is approved, in order. */
export const INSTALL_STEPS: readonly Step[] = [
  { id: 'configure', short: 'Config', title: 'Save the configuration', about: 'Writes the settings files the services read. Keys go only into private files that only you can read.' },
  { id: 'backup', short: 'Backup', title: 'Back up your notes', about: 'Copies your notes to a safe place before anything in them changes.' },
  { id: 'engine', short: 'Engine', title: 'Start Vault Engine', about: 'Starts Engine as a background service that restarts on its own.' },
  { id: 'adopt', short: 'Organize', title: 'Organize your notes', about: 'Gives each note its kind, as planned. Every change can be undone for 24 hours.' },
  { id: 'settings', short: 'Settings', title: 'Apply your settings', about: 'Saves your model choices and other settings in Engine.' },
  { id: 'curator', short: 'Curator', title: 'Start Curator', about: 'Starts Curator, the helper that keeps your wikis current.' },
  { id: 'verify', short: 'Check', title: 'Check everything works', about: 'Free, read-only checks that everything is running as planned.' },
  { id: 'handoff', short: 'Finish', title: 'Finish up', about: 'Writes a guide for connecting your apps and removes the installer\'s temporary access.' },
];

const DOT_DONE = '●';
const DOT_NOW = '◉';
const DOT_TODO = '○';
const COLUMN = 9;

/**
 * The step map: a row of dots joined by a line, with the step names under them when the
 * terminal is wide enough, then the heading and what the step is for.
 *
 *   ●━━━━━━━━━●━━━━━━━━━◉─────────○
 *   Computer  Folder    Notes     AI keys
 */
export function renderStepMap(view: StepView, style: Style, width = 80): string[] {
  const { steps, index } = view;
  const wide = steps.length * COLUMN <= width - 4;
  const column = wide ? COLUMN : 4;
  let dots = '';
  let labels = '';
  steps.forEach((step, position) => {
    const dot = position < index ? DOT_DONE : position === index ? DOT_NOW : DOT_TODO;
    const color: Format = position < index ? 'green' : position === index ? ['cyan', 'bold'] : 'gray';
    dots += style.paint(color, dot);
    if (position < steps.length - 1) {
      const line = (position < index ? '━' : '─').repeat(column - 1);
      dots += style.paint(position < index ? 'green' : 'gray', line);
    }
    if (wide) {
      const label = step.short.slice(0, column - 1).padEnd(position < steps.length - 1 ? column : 0);
      labels += style.paint(position === index ? ['cyan', 'bold'] : position < index ? 'green' : 'gray', label);
    }
  });
  const current = steps[index] as Step;
  return [
    dots,
    ...(wide ? [labels] : []),
    '',
    `${style.paint(['bold', 'cyan'], `${view.journey} · Step ${index + 1} of ${steps.length}`)}`,
    style.paint('bold', current.title),
    ...wrap(current.about, Math.min(width - 6, 72)).map(line => style.paint('dim', line)),
  ];
}

/** The plain one-line version, for logs and answers-file runs. */
export function plainStepLine(view: StepView): string {
  const step = view.steps[view.index] as Step;
  return `[${view.journey} ${view.index + 1}/${view.steps.length}] ${step.title}`;
}

const LOGO = [
  '█░█ ▄▀█ █░█ █░░ ▀█▀',
  '▀▄▀ █▀█ █▄█ █▄▄ ░█░',
];

export type WelcomeMode = 'plan' | 'install';

/** The first screen: what Vault is, what is about to happen, and how to answer. */
export function renderWelcome(mode: WelcomeMode, style: Style): string {
  const gradient: Format[] = ['cyan', 'blue'];
  const logo = LOGO.map((line, row) => style.paint([gradient[row] as 'cyan', 'bold'], line));
  const promise = mode === 'plan'
    ? 'This is a practice run. You answer the same questions, see the full plan, and nothing on this computer changes.'
    : 'You answer a few questions, see the full plan, and only then decide. Nothing changes until you say yes.';
  const lines = [
    ...logo,
    '',
    style.paint('bold', 'Welcome! Let\'s set up Vault on this computer.'),
    ...wrap('Vault turns a folder of Markdown notes into an organized, searchable knowledge base that your AI assistants can use.', 64),
    '',
    ...wrap(promise, 64),
    '',
    style.paint('bold', `${SETUP_STEPS.length} short steps`),
    ...SETUP_STEPS.map((step, position) => `  ${style.paint('cyan', `${position + 1}.`)} ${step.title}`),
    '',
    style.paint('bold', 'Two ways through them'),
    ...wrap('Quick setup asks for your notes folder and one AI key. The rest takes the usual answer, or what your notes already say, and you see all of it before you approve.', 62).map(line => `  ${line}`),
    ...wrap('Choose everything asks each question in turn (about 25).', 62).map(line => `  ${line}`),
    '',
    style.paint('bold', 'How to answer'),
    `  ${keyCap('↑ ↓', style)} move   ${keyCap('Space', style)} tick a box   ${keyCap('Enter', style)} confirm`,
    ...(mode === 'plan'
      ? [`  ${keyCap('Ctrl+C', style)} quit at any time; nothing is changed`]
      : [
        `  ${keyCap('Ctrl+C', style)} quit. Before you approve the plan, nothing is changed;`,
        '  after that, run install again to pick up where it stopped',
      ]),
    `  Unsure? The highlighted answer is a safe default.`,
  ];
  return lines.join('\n');
}

function keyCap(key: string, style: Style): string {
  return style.paint(['inverse', 'bold'], ` ${key} `);
}

const STATUS_COLORS: Record<string, Format> = {
  '✓': 'green',
  '!': 'yellow',
  '✗': 'red',
  '-': 'gray',
};

/**
 * Color the leading status mark of each line in a report (`✓`, `!`, `✗`, `-`) and turn
 * `!` into a warning sign, so the result reads at a glance.
 */
export function colorMarks(text: string, style: Style): string {
  if (!style.enabled) return text;
  return text.split('\n').map(line => {
    const match = /^(\s*)([✓!✗-]) (.*)$/.exec(line);
    if (!match) return line;
    const [, indent, mark, rest] = match as unknown as [string, string, string, string];
    const shown = mark === '!' ? '▲' : mark === '-' ? '·' : mark;
    const colon = rest.indexOf(': ');
    const body = colon > 0 ? `${style.paint('bold', rest.slice(0, colon))}${rest.slice(colon)}` : rest;
    return `${indent}${style.paint(STATUS_COLORS[mark] as Format, shown)} ${body}`;
  }).join('\n');
}

/** `9 passed · 1 to note · 0 problems`, for a list of checks. */
export function checkTally(statuses: ReadonlyArray<'pass' | 'warn' | 'fail'>): string {
  const passed = statuses.filter(status => status === 'pass').length;
  const warned = statuses.filter(status => status === 'warn').length;
  const failed = statuses.filter(status => status === 'fail').length;
  return [
    `${passed} passed`,
    ...(warned > 0 ? [`${warned} to note`] : []),
    `${failed === 0 ? 'no' : failed} problem${failed === 1 ? '' : 's'}`,
  ].join(' · ');
}

/** A bar such as `████████░░░░ 8/12`. */
export function progressBar(done: number, total: number, style: Style, width = 24): string {
  const share = total === 0 ? 1 : done / total;
  const filled = Math.min(width, Math.max(0, Math.round((Number.isFinite(share) ? share : 0) * width)));
  return `${style.paint('green', '█'.repeat(filled))}${style.paint('gray', '░'.repeat(width - filled))} ${done}/${total}`;
}

/** Break `text` into lines of at most `width` characters, on spaces. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
