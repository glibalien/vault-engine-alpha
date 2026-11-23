import { defaultsFor, descriptorsFor, validateValue, type SettingDescriptor } from '@vault/settings-registry';
import type { AnswerId } from './answers.js';
import type { Host } from './host.js';
import type { Prompter } from './prompter.js';
import { isTypeName, portableTypeKey } from './type-names.js';

export type WikiMode = 'off' | 'dry-run' | 'live';

/** Curator's choices; the plan holds null when Curator is not installed. */
export interface CuratorPlan {
  /**
   * Curator's daily model spend cap in US cents. The installer always sets one: Engine's
   * update-settings resets a null to the default cap rather than removing it.
   */
  dailyBudgetCents: number;
  sweepAt: string;
  tz: string;
  wikiMode: WikiMode;
}

const CURATOR_DEFAULTS = defaultsFor('curator');

/**
 * Curator's optional sweeps, which an install leaves off. They are set explicitly so a
 * vault Engine already manages cannot keep one running from an earlier configuration.
 */
export const OPTIONAL_SWEEPS_OFF: ReadonlyArray<{ key: string; value: boolean | string }> = [
  { key: 'memorySweepEnabled', value: false },
  { key: 'conversationSweepEnabled', value: false },
  { key: 'conversationCaptureMode', value: 'off' },
  { key: 'orgSweepEnabled', value: false },
];

function curatorDescriptor(key: string): SettingDescriptor {
  return descriptorsFor('curator').find(descriptor => descriptor.key === key) as SettingDescriptor;
}

/** Stage 4: whether Curator is installed. Without a model key it would have nothing to call. */
export async function askInstallCurator(prompter: Prompter, hasModelKey: boolean): Promise<boolean> {
  return prompter.decide<boolean>({
    id: 'curator.install',
    ask: () => prompter.confirm({
      message: hasModelKey
        ? 'Install Curator? It keeps the wikis you create up to date, and never spends more than your daily limit.'
        : 'Install Curator anyway? It needs an AI key to do anything, and you didn\'t add one.',
      initialValue: hasModelKey,
    }),
    defaultValue: () => hasModelKey,
  });
}

/** Stage 4: Curator's budget, schedule, and wiki mode. */
export async function runCuratorScheduleStage(input: { host: Host; prompter: Prompter }): Promise<CuratorPlan> {
  const { host, prompter } = input;
  const dailyBudgetCents = await askBudget(prompter);
  const sweepAt = await askSetting(prompter, 'curator.sweep_at', 'sweepAt', {
    message: 'What time should Curator do its daily update? (24-hour time, like 05:00)',
    defaultValue: CURATOR_DEFAULTS.sweepAt as string,
  });
  const tz = await askSetting(prompter, 'curator.tz', 'tz', {
    message: 'Your time zone',
    defaultValue: host.timeZone,
  });
  const wikiMode = await prompter.select<WikiMode>({
    id: 'curator.wiki_mode',
    message: 'During its daily update, what should Curator do with your wikis?',
    options: [
      { value: 'live', label: 'Keep them up to date', hint: 'recommended; stays within your daily limit' },
      { value: 'dry-run', label: 'Only preview changes', hint: 'shows what it would change, changes nothing' },
      { value: 'off', label: 'Nothing', hint: 'wikis change only when you ask' },
    ],
    initialValue: 'live',
  });
  return { dailyBudgetCents, sweepAt, tz, wikiMode };
}

/**
 * The kind of the notes Curator's journal writes: on the notes step's map interactively
 * (before Curator is chosen, so it counts only if Curator is installed), in the Curator
 * step headlessly, only when Curator is installed. It can be a type the notes have, or a
 * new name: Curator creates that type when it first writes its journal, so the install
 * creates nothing for it. `proposed` is the detected default: a type named note in any
 * case, else a new `note`.
 */
export async function chooseJournalType(prompter: Prompter, typeNames: readonly string[], proposed: string): Promise<string> {
  const other = '\u0000other';
  for (;;) {
    const answer = (await prompter.decide<string>({
      id: 'curator.journal_type',
      async ask() {
        const choice = await prompter.select<string>({
          id: 'curator.journal_type',
          message: 'If you install Curator (a later step), it keeps a journal of what it does, one note a month. Which kind of note should that be?',
          options: [
            ...(typeNames.includes(proposed) ? [] : [{ value: proposed, label: proposed, hint: 'a new kind; Curator creates it when it first writes' }]),
            ...typeNames.map(name => ({ value: name, label: name, hint: 'a kind your notes already have' })),
            { value: other, label: 'Another new kind…' },
          ],
          initialValue: proposed,
        });
        if (choice !== other) return choice;
        return prompter.text({ id: 'curator.journal_type', message: 'Name for the new kind of journal note:' });
      },
      defaultValue: () => proposed,
    })).trim();
    const clash = typeNames.find(name => name !== answer && portableTypeKey(name) === portableTypeKey(answer));
    if (!isTypeName(answer)) {
      prompter.rejectAnswer('curator.journal_type', `"${answer}" cannot be a type name.`);
    } else if (clash !== undefined) {
      prompter.rejectAnswer('curator.journal_type', `${answer} differs from your ${clash} type only by case; answer ${clash} to use it, or choose another name.`);
    } else {
      return answer;
    }
  }
}

async function askBudget(prompter: Prompter): Promise<number> {
  const descriptor = curatorDescriptor('dailyBudgetCents');
  const fallback = CURATOR_DEFAULTS.dailyBudgetCents as number;
  for (;;) {
    const cents = await prompter.decide<number>({
      id: 'curator.daily_budget_cents',
      ask: () => askBudgetInDollars(prompter, fallback),
      defaultValue: () => fallback,
    });
    const problem = validateValue(descriptor, cents);
    if (problem === null) return cents;
    prompter.rejectAnswer('curator.daily_budget_cents', `The daily cap ${problem}.`);
  }
}

async function askBudgetInDollars(prompter: Prompter, fallbackCents: number): Promise<number> {
  for (;;) {
    const answer = (await prompter.text({
      id: 'curator.daily_budget_cents',
      message: 'The most Curator may spend on AI each day, in US dollars',
      defaultValue: (fallbackCents / 100).toFixed(2),
    })).trim();
    const cents = dollarsToCents(answer);
    if (cents !== null && cents >= 1) return cents;
    prompter.rejectAnswer('curator.daily_budget_cents', 'Enter an amount such as 1 or 2.50.');
  }
}

/** `2.5` or `$2.50` -> 250; null when it is not an amount. */
export function dollarsToCents(input: string): number | null {
  const match = /^\$?(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

async function askSetting(
  prompter: Prompter,
  id: AnswerId,
  key: string,
  question: { message: string; defaultValue: string },
): Promise<string> {
  const descriptor = curatorDescriptor(key);
  for (;;) {
    const value = (await prompter.text({ id, ...question })).trim();
    const problem = validateValue(descriptor, value);
    if (problem === null) return value;
    prompter.rejectAnswer(id, `${question.message}: ${problem}.`);
  }
}
