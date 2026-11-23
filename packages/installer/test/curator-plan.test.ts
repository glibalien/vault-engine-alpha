import { describe, expect, it } from 'vitest';
import { AnswersSchema, type Answers } from '../src/answers.js';
import { askInstallCurator, chooseJournalType, dollarsToCents, runCuratorScheduleStage } from '../src/curator-plan.js';
import { createScriptedPrompter } from '../src/prompter.js';
import { fakeHost, replayPrompter } from './helpers.js';

function scripted(curator: Answers['curator']) {
  return createScriptedPrompter({ version: 1, vault: { path: '/v' }, ...(curator ? { curator } : {}) }, () => {});
}

describe('Curator choices', () => {
  it('defaults to installing Curator only when a model key exists', async () => {
    expect(await askInstallCurator(scripted(undefined), true)).toBe(true);
    expect(await askInstallCurator(scripted(undefined), false)).toBe(false);
    expect(await askInstallCurator(scripted({ install: true }), false)).toBe(true);
  });

  it('uses the registry defaults and the host time zone headlessly', async () => {
    const plan = await runCuratorScheduleStage({ host: fakeHost({ timeZone: 'Europe/London' }), prompter: scripted(undefined) });

    expect(plan).toEqual({ dailyBudgetCents: 100, sweepAt: '05:00', tz: 'Europe/London', wikiMode: 'live' });
  });

  it('takes answers', async () => {
    const plan = await runCuratorScheduleStage({
      host: fakeHost(),
      prompter: scripted({ daily_budget_cents: 250, sweep_at: '22:30', tz: 'America/New_York', wiki_mode: 'dry-run' }),
    });

    expect(plan).toEqual({ dailyBudgetCents: 250, sweepAt: '22:30', tz: 'America/New_York', wikiMode: 'dry-run' });
  });

  it.each([
    [{ sweep_at: '5am' }, /must be HH:MM/],
    [{ tz: 'Mars/Olympus_Mons' }, /must be a valid IANA timezone/],
  ])('rejects %j', async (curator, message) => {
    await expect(runCuratorScheduleStage({ host: fakeHost(), prompter: scripted(curator) })).rejects.toThrow(message);
  });

  it('accepts only a positive whole number of cents in an answers file', () => {
    const parse = (cents: unknown) => AnswersSchema.safeParse({ version: 1, vault: { path: '/v' }, curator: { daily_budget_cents: cents } }).success;

    // No cap is not offered: Engine's update-settings resets a null to the default cap.
    expect([parse(250), parse(null), parse(0), parse(1.5)]).toEqual([true, false, false, false]);
  });

  it('asks for the cap in dollars, always keeping one', async () => {
    const { prompter, rejections } = replayPrompter({ 'curator.daily_budget_cents': ['lots', 'none', '$2.50'] });

    const plan = await runCuratorScheduleStage({ host: fakeHost(), prompter });

    expect(rejections).toEqual(['Enter an amount such as 1 or 2.50.', 'Enter an amount such as 1 or 2.50.']);
    expect(plan.dailyBudgetCents).toBe(250);
  });

  it('designates the journal kind: the detected one by default, any type the notes have, or a new name', async () => {
    expect(await chooseJournalType(scripted(undefined), ['meeting'], 'note')).toBe('note');
    expect(await chooseJournalType(scripted(undefined), ['Note', 'meeting'], 'Note')).toBe('Note');
    expect(await chooseJournalType(scripted({ journal_type: 'meeting' }), ['meeting'], 'note')).toBe('meeting');
    // A new name: Curator creates the type when it first writes, so nothing is planned for it.
    expect(await chooseJournalType(scripted({ journal_type: 'curator log' }), ['meeting'], 'note')).toBe('curator log');
    await expect(chooseJournalType(scripted({ journal_type: 'MEETING' }), ['meeting'], 'note'))
      .rejects.toThrow(/curator\.journal_type: MEETING differs from your meeting type only by case/);
    await expect(chooseJournalType(scripted({ journal_type: '_log' }), ['meeting'], 'note'))
      .rejects.toThrow(/curator\.journal_type: "_log" cannot be a type name/);
  });

  it('asks interactively for another name for the journal kind', async () => {
    const { prompter, rejections } = replayPrompter({ 'curator.journal_type': ['\u0000other', 'Note', 'log'] });

    expect(await chooseJournalType(prompter, ['note'], 'note')).toBe('log');
    expect(rejections).toEqual(['Note differs from your note type only by case; answer note to use it, or choose another name.']);
  });

  it('converts dollars to cents', () => {
    expect(['1', '2.5', '$2.50', '0.07', '10.', 'x', '1.234'].map(dollarsToCents)).toEqual([100, 250, 250, 7, null, null, null]);
  });
});
