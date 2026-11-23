import * as clack from '@clack/prompts';
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AnswersError, answerFor, type AnswerId, type Answers } from './answers.js';
import { resolveUserPath } from './layout.js';
import { colorMarks, plainStepLine, renderStepMap, renderWelcome, steadyColumns, steadyRows, terminalStyle, usableColumns, type Step, type StepView, type WelcomeMode } from './tui.js';

export interface TextQuestion {
  id: AnswerId;
  message: string;
  placeholder?: string;
  /** Used when an interactive user accepts the suggestion, or a headless run omits the answer. */
  defaultValue?: string;
  /** Accept an empty answer (interactive only). */
  allowEmpty?: boolean;
  /** A folder on this computer: the interactive prompt suggests folders as you type. */
  folder?: boolean;
  /** A folder question's starting text, which the user edits (interactive only). */
  initialInput?: string;
  /**
   * The folder a relative answer to a folder question is read from, so the suggestions
   * list what the answer will name. Defaults to this process's working folder.
   */
  relativeTo?: string;
  /**
   * The default is only a fallback for a choice the user should make (the usual folder
   * already exists), so a run that takes defaults (`createDefaultsPrompter`) still asks it.
   */
  mustAsk?: boolean;
}

export interface SelectQuestion<T extends string> {
  id: AnswerId;
  message: string;
  options: Array<{ value: T; label: string; hint?: string }>;
  /** Highlighted interactively; the headless default when the answer is omitted. */
  initialValue: T;
  /**
   * No default can stand in for the answer (two kind names that differ only by case), so a
   * run that takes every default (`createDefaultsPrompter`) still asks it.
   */
  mustAsk?: boolean;
}

/** A yes/no question; `active` and `inactive` name the two answers (default Yes and No). */
export interface ConfirmQuestion {
  message: string;
  initialValue: boolean;
  active?: string;
  inactive?: string;
}

export interface SecretQuestion {
  id: AnswerId;
  /** What the key is, for example `Anthropic API key`. */
  message: string;
  /** The environment variable an interactive user can take the key from. */
  envVar: string;
  envPresent: boolean;
}

/** Where a key comes from; null skips it. An entered key is never echoed. */
export type SecretAnswer = { source: 'env'; name: string } | { source: 'entered'; value: string } | null;

/**
 * A decision the TUI reaches through several prompts but an answers file states at once
 * (for example, folder rules). Headless runs use the answer, or `defaultValue()`.
 */
export interface DecisionQuestion<T> {
  id: AnswerId;
  ask(): Promise<T>;
  defaultValue(): T;
}

export interface MultiselectQuestion {
  id: AnswerId;
  message: string;
  options: Array<{ value: string; label: string; hint?: string }>;
  /** Preselected interactively; the headless default when the answer is omitted. */
  initialValues: string[];
}

/**
 * The only way stages talk to the user. The interactive implementation uses
 * @clack/prompts; the scripted one answers from an answers file, so both modes run
 * the same stage code.
 */
export interface Prompter {
  readonly interactive: boolean;
  intro(title: string): void;
  /** The first screen of an interactive run: what is about to happen and how to answer. */
  welcome(mode: WelcomeMode): void;
  /** A new step starts: interactive runs show the step map, headless runs one line. */
  step(view: StepView): void;
  /** A finished run's closing message, shown as a highlighted box when interactive. */
  success(message: string, title: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  info(message: string): void;
  warn(message: string): void;
  text(question: TextQuestion): Promise<string>;
  select<T extends string>(question: SelectQuestion<T>): Promise<T>;
  confirm(question: ConfirmQuestion): Promise<boolean>;
  multiselect(question: MultiselectQuestion): Promise<string[]>;
  secret(question: SecretQuestion): Promise<SecretAnswer>;
  decide<T>(question: DecisionQuestion<T>): Promise<T>;
  /** Report an invalid answer. Interactive prompts ask again; headless runs stop. */
  rejectAnswer(id: AnswerId, reason: string): void;
  /** `message` replaces the spinner's line; a headless run prints it as a new line. */
  spinner(message: string): { stop(message: string): void; message?(message: string): void };
}

/** Run `task` under a spinner that stops whether the task succeeds or fails. */
export async function withSpinner<T>(
  prompter: Pick<Prompter, 'spinner'>,
  message: string,
  task: () => Promise<T>,
  done: (result: T) => string,
): Promise<T> {
  const spinner = prompter.spinner(message);
  try {
    const result = await task();
    spinner.stop(done(result));
    return result;
  } catch (error) {
    spinner.stop('Stopped.');
    throw error;
  }
}

/** Start step `id` of a journey: `showStep(prompter, 'Setup', SETUP_STEPS, 'keys')`. */
export function showStep(prompter: Pick<Prompter, 'step'>, journey: string, steps: readonly Step[], id: string): void {
  const index = steps.findIndex(step => step.id === id);
  if (index >= 0) prompter.step({ journey, steps, index });
}

export class CancelledError extends Error {
  override readonly name = 'CancelledError';
}

/** `resumeCommand` continues an approved install, for the message shown on Ctrl+C. */
export function createClackPrompter(resumeCommand: string): Prompter {
  const style = terminalStyle();
  const unlessCancelled = <T>(value: T | symbol): T => {
    if (clack.isCancel(value)) {
      clack.cancel(`Stopped. Nothing changes before you approve a plan. If you had already approved one, run \`${resumeCommand}\` again to pick up where it stopped.`);
      throw new CancelledError('cancelled');
    }
    return value as T;
  };
  // A terminal that reports no usable width (0 in a pseudo-terminal with no size) is laid
  // out at 80 columns, by the step map here and by clack's own boxes and prompts (#469);
  // one that reports no usable height, at 24 rows, so clack's option lists page (#489).
  steadyColumns(process.stdout);
  steadyRows(process.stdout);
  const width = () => usableColumns(process.stdout.columns);
  return {
    interactive: true,
    intro: title => clack.intro(style.paint(['bgCyan', 'black', 'bold'], ` ${title} `)),
    welcome: mode => clack.box(renderWelcome(mode, style), '', {
      contentPadding: 2,
      formatBorder: border => style.paint('cyan', border),
    }),
    step: view => clack.log.message(renderStepMap(view, style, width() - 4), {
      symbol: style.paint('cyan', '◆'),
      spacing: 1,
    }),
    success: (message, title) => clack.box(message, ` ${title} `, {
      contentPadding: 2,
      formatBorder: border => style.paint('green', border),
    }),
    outro: message => clack.outro(message),
    note: (message, title) => clack.note(colorMarks(message, style), title),
    info: message => clack.log.info(message),
    warn: message => clack.log.warn(message),
    async text(question) {
      if (question.folder) {
        // clack.path, except that a typed path that is not an existing folder can be chosen
        // too, so the stage can offer to create it.
        const value = await clack.autocomplete<string>({
          message: question.message,
          initialUserInput: question.initialInput ?? question.defaultValue ?? '',
          maxItems: 5,
          completeOnTab: true,
          options() {
            return folderOptions(this.userInput, homedir(), question.relativeTo ?? process.cwd());
          },
          validate: input => (typeof input !== 'string' || !input.trim() ? 'Type or pick a folder.' : undefined),
        });
        return unlessCancelled<string>(value) ?? '';
      }
      const value = await clack.text({
        message: question.message,
        ...(question.placeholder !== undefined ? { placeholder: question.placeholder } : {}),
        ...(question.defaultValue !== undefined
          ? { defaultValue: question.defaultValue, placeholder: question.placeholder ?? question.defaultValue }
          : {}),
        validate: input => (question.defaultValue === undefined && !question.allowEmpty && !input?.trim()
          ? 'An answer is required.'
          : undefined),
      });
      return unlessCancelled<string>(value) ?? '';
    },
    async select(question) {
      const value = await clack.select({
        message: question.message,
        options: question.options as clack.Option<typeof question.initialValue>[],
        initialValue: question.initialValue,
      });
      return unlessCancelled<typeof question.initialValue>(value);
    },
    async confirm(question) {
      return unlessCancelled<boolean>(await clack.confirm(question));
    },
    async multiselect(question) {
      if (question.options.length === 0) return [];
      const value = await clack.multiselect({
        message: question.message,
        options: question.options,
        initialValues: question.initialValues,
        required: false,
      });
      return unlessCancelled<string[]>(value);
    },
    async secret(question) {
      if (question.envPresent) {
        const choice = unlessCancelled<'env' | 'enter' | 'skip'>(await clack.select({
          message: question.message,
          options: [
            { value: 'env' as const, label: 'Use the key already on this computer', hint: `from ${question.envVar}` },
            { value: 'enter' as const, label: 'Paste a different key' },
            { value: 'skip' as const, label: 'Skip', hint: 'add it later' },
          ],
          initialValue: 'env' as const,
        }));
        if (choice === 'env') return { source: 'env', name: question.envVar };
        if (choice === 'skip') return null;
      }
      const value = unlessCancelled<string | undefined>(await clack.password({
        message: `${question.message} ${style.paint('dim', '(paste it, or press Enter to skip)')}`,
      }))?.trim() ?? '';
      return value === '' ? null : { source: 'entered', value };
    },
    decide: question => question.ask(),
    rejectAnswer: (_id, reason) => clack.log.error(reason),
    spinner(message) {
      const indicator = clack.spinner();
      indicator.start(message);
      return { stop: done => indicator.stop(done), message: text => indicator.message(text) };
    },
  };
}

/**
 * Suggestions for a folder question as typed so far: the folders whose path starts with it
 * (as clack's path prompt lists them), then the typed path itself when it is not one of
 * them and is not a file, so a folder that does not exist yet can be chosen.
 */
export function folderOptions(
  input: string,
  homeDir = homedir(),
  cwd = process.cwd(),
): Array<{ value: string; label: string; hint?: string }> {
  if (input === '') return [];
  // Where typed text points, read as the answer will be: `~` is the home folder, and a
  // relative path is under `cwd`. Suggestions keep the form that was typed.
  const onDisk = (path: string): string => resolveUserPath(path, homeDir, cwd);
  const prefix = input.length > 1 && input.endsWith('/') ? input.slice(0, -1) : input;
  let folders: string[] = [];
  try {
    const listed = existsSync(onDisk(input)) && lstatSync(onDisk(input)).isDirectory() && input.endsWith('/') ? input : dirname(input);
    folders = readdirSync(onDisk(listed))
      .map(name => join(listed, name))
      .filter(path => path.startsWith(prefix) && lstatSync(onDisk(path)).isDirectory())
      .sort();
  } catch {
    // Nothing to suggest under a folder that cannot be read.
  }
  const options: Array<{ value: string; label: string; hint?: string }> = folders.map(path => ({ value: path, label: path }));
  if (folders.includes(prefix)) return options;
  const typed = onDisk(input);
  let isFile = false;
  let exists = false;
  try {
    const stats = statSync(typed);
    exists = true;
    isFile = !stats.isDirectory();
  } catch {
    // Missing: offered as a new folder.
  }
  if (isFile) return options;
  return [...options, { value: input, label: input, ...(exists ? {} : { hint: 'new folder' }) }];
}

type Output = Pick<Prompter, 'intro' | 'welcome' | 'step' | 'success' | 'outro' | 'note' | 'info' | 'warn' | 'spinner'>;

function plainOutput(write: (line: string) => void): Output {
  return {
    intro: title => write(title),
    welcome() {},
    step: view => write(plainStepLine(view)),
    success: (message, title) => write(`${title}\n${message}`),
    outro: message => write(message),
    note: (message, title) => write(title ? `${title}\n${message}` : message),
    info: message => write(message),
    warn: message => write(`Warning: ${message}`),
    spinner(message) {
      write(message);
      return { stop: done => write(done), message: write };
    },
  };
}

/**
 * Headless output for a run with nothing to ask, such as continuing a saved install.
 * A question stops it, since there is no answers file to take the answer from.
 */
export function createProgressPrompter(write: (line: string) => void): Prompter {
  const refuse = (id: AnswerId): never => {
    throw new AnswersError(`missing answer: ${id}; pass --answers <file>`);
  };
  return {
    interactive: false,
    ...plainOutput(write),
    text: async question => refuse(question.id),
    select: async question => refuse(question.id),
    async confirm(question) {
      return question.initialValue;
    },
    multiselect: async question => refuse(question.id),
    secret: async question => refuse(question.id),
    decide: async question => refuse(question.id),
    rejectAnswer(id, reason) {
      throw new AnswersError(`invalid answer ${id}: ${reason}`);
    },
  };
}

/**
 * Takes every question's default, as a headless run with no answers does, while output
 * (notes, warnings, spinners) still reaches the user through `real`. Some questions still
 * go to the user: one marked `mustAsk`; one whose default was refused (`rejectAnswer`),
 * with the questions `reask` lists for it, from then on; and every prompt inside a
 * decision that is asked. A step that opens with what it detected uses this to settle
 * everything it can without asking.
 *
 * With `only`, just the questions it names take their default; every other question, and
 * every confirmation (which has no id), goes to the user. Quick setup uses this, so a
 * question it does not know about is asked rather than answered unseen.
 */
export function createDefaultsPrompter(
  real: Prompter,
  reask: Partial<Record<AnswerId, AnswerId[]>> = {},
  only?: ReadonlySet<AnswerId>,
): Prompter {
  const refused = new Set<AnswerId>();
  let deciding = 0;
  const defaulted = (id: AnswerId) => !refused.has(id) && (only === undefined || only.has(id));
  const asks = (id: AnswerId) => deciding > 0 || !defaulted(id);
  return {
    ...real,
    text: question => (asks(question.id) || question.mustAsk ? real.text(question) : Promise.resolve(question.defaultValue ?? '')),
    select: question => (asks(question.id) || question.mustAsk ? real.select(question) : Promise.resolve(question.initialValue)),
    multiselect: question => (asks(question.id) ? real.multiselect(question) : Promise.resolve(question.initialValues)),
    secret: question => (asks(question.id) ? real.secret(question) : Promise.resolve(null)),
    // A confirmation has no id: it is asked inside a decision that is asked, and always with `only`.
    confirm: question => (deciding > 0 || only !== undefined ? real.confirm(question) : Promise.resolve(question.initialValue)),
    async decide(question) {
      if (defaulted(question.id)) return question.defaultValue();
      deciding++;
      try {
        return await real.decide(question);
      } finally {
        deciding--;
      }
    },
    rejectAnswer(id, reason) {
      real.rejectAnswer(id, reason);
      for (const again of [id, ...(reask[id] ?? [])]) refused.add(again);
    },
  };
}

/** Answers questions from a validated answers file; writes plain lines to `write`. */
export function createScriptedPrompter(answers: Answers, write: (line: string) => void): Prompter {
  return {
    interactive: false,
    ...plainOutput(write),
    async text(question) {
      const value = answerFor(answers, question.id);
      if (value === undefined) {
        if (question.defaultValue !== undefined) return question.defaultValue;
        throw new AnswersError(`missing answer: ${question.id} (${question.message})`);
      }
      if (typeof value !== 'string') throw new AnswersError(`answer ${question.id} must be a string`);
      return value;
    },
    async select(question) {
      const value = answerFor(answers, question.id);
      if (value === undefined) return question.initialValue;
      const option = question.options.find(candidate => candidate.value === value);
      if (!option) {
        throw new AnswersError(`answer ${question.id} must be one of: ${question.options.map(o => o.value).join(', ')}`);
      }
      return option.value;
    },
    async confirm(question) {
      return question.initialValue;
    },
    async multiselect(question) {
      const value = answerFor(answers, question.id);
      if (value === undefined) return question.initialValues;
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new AnswersError(`answer ${question.id} must be a list of strings`);
      }
      return value as string[];
    },
    async secret(question) {
      const value = answerFor(answers, question.id);
      if (value === undefined || value === null) return null;
      const match = typeof value === 'string' ? /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value) : null;
      if (!match) throw new AnswersError(`answer ${question.id} must be an env:NAME reference`);
      return { source: 'env', name: match[1] as string };
    },
    async decide<T>(question: DecisionQuestion<T>) {
      const value = answerFor(answers, question.id);
      return value === undefined ? question.defaultValue() : value as T;
    },
    rejectAnswer(id, reason) {
      throw new AnswersError(`invalid answer ${id}: ${reason}`);
    },
  };
}
