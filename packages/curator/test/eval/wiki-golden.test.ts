import { describe, expect, it, vi } from 'vitest';
import { GOLDEN_CASES } from '../../src/eval/wiki-golden-cases.js';
import { judgeFlaggedChecks, runChecks, runGoldenCase, sectionText, totalUsage } from '../../src/eval/wiki-golden.js';
import { JUDGE_CALIBRATION } from '../../src/eval/wiki-judge-calibration.js';
import { judgeRule, parseRuleRuling, resolveJudgeModel, RULE_JUDGE_SYSTEM_PROMPT } from '../../src/eval/wiki-judge.js';
import { StructuredCallFailure } from '../../src/llm/types.js';
import type { ModelCatalogEntry } from '@vault/settings-registry';
import { PAGE_TEMPLATES } from '../../src/page-templates.js';
import type { LlmClient, StructuredCallRequest } from '../../src/llm/types.js';
import type { ResolvedWikiOutputPolicy } from '../../src/wiki-output-policy.js';

/** For every case, an answer that avoids its failure and one that reproduces it. */
const EXAMPLES: Record<string, { good: string; bad: string }> = {
  'newer-activity-not-silence': {
    good: '## Now\nAcme reached out on October 2 proposing an in-person working session; we have not replied yet.',
    bad: '## Now\nNo recent contact from Acme since the September kickoff.',
  },
  'proposed-meeting-not-confirmed': {
    good: '## Now\nAcme proposed meeting on October 23 to plan the rollout; the time is not yet confirmed.',
    bad: '## Now\nThe rollout planning meeting with Acme is booked for October 23.',
  },
  'report-date-is-not-event-date': {
    good: '## Recent\n- **September 18** — The team discussed splitting the pilot into two phases (reported September 21); the decision is open.',
    bad: '## Recent\n- On September 21 the team discussed splitting the pilot timeline.',
  },
  'done-is-not-delivered': {
    good: '## Now\nThe revised deck is finished and the task is closed; Acme has not acknowledged it yet.',
    bad: '## Now\nThe revised deck was delivered to Acme.',
  },
  'superseded-scope-is-history': {
    good: '## Current state\nThe pilot uses anonymized sandbox data only. Outlook integration was dropped on September 25.\n\n'
      + '## History\n- September 20: scope included Outlook integration.',
    bad: '## Current state\nThe pilot covers sandbox data plus Outlook integration.',
  },
  'no-restated-task-counts': {
    good: '## Focus\nThe security questionnaire is the item most likely to slip.',
    bad: '## Now\nThere are 5 open tasks, led by the security questionnaire.',
  },
  'task-field-outranks-body': {
    good: '## Now\nThe vendor contract review is blocked.',
    bad: '## Now\nThe vendor contract review is in progress with legal.',
  },
  'old-wiki-prose-is-not-evidence': {
    good: '## Current state\nThe pilot contract is not yet signed; Acme legal returned comments on September 30.',
    bad: '## Current state\nThe pilot contract was signed on August 3.',
  },
  'resolved-risk-stays-resolved': {
    good: '## Current risks\n- The training budget has not been approved.\n\n## Resolved\n- Late test-device delivery: devices arrived October 7.',
    bad: '## Current risks\n- The hardware vendor may deliver test devices late.\n- The training budget is not approved.',
  },
  'dollar-amounts-escaped': {
    good: '## Overview\nThe pilot fee is \\$45,000, with an optional \\$12,000 training add-on.',
    bad: '## Overview\nThe pilot fee is $45,000.',
  },
  'rewrite-updates-and-keeps': {
    good: '## Current risks\n\n- **Security questionnaire** — Due 2026-10-30.\n- **Training budget** — Not approved.\n\n'
      + '## Mitigations\n\n- Do not mention the Gold pricing tiers to Acme until legal approves them.\n\n'
      + '## Resolved\n\n- **Contract** — Acme signed the pilot MSA on 2026-10-15.\n- **Device delivery** — Test devices arrived on 2026-10-07.',
    // The #392 failure: the Mitigations section and its do-not-say rule dropped.
    bad: '## Current risks\n\n- **Security questionnaire** — Due 2026-10-30.\n- **Training budget** — Not approved.\n\n'
      + '## Resolved\n\n- **Contract** — Acme signed the pilot MSA on 2026-10-15.\n- **Device delivery** — Test devices arrived on 2026-10-07.',
  },
};

/** Outputs from real eval runs (#386), reworded with the fixtures' names, and near misses. A correct
 *  answer that reports the old state as history must pass; a miss must still fail, on the named checks. */
const RUN_OUTPUTS: ReadonlyArray<{ id: string; label: string; output: string; fails: readonly string[] }> = [
  { id: 'proposed-meeting-not-confirmed', label: 'correct, says "no confirmed time"', fails: [],
    output: '## Now\nAcme suggested October 23 for a rollout planning meeting. It is proposed, not booked: there is still no confirmed time.\n\n'
      + '## Open threads\n- **October 23 meeting** — waiting on Acme\'s calendar; an unconfirmed date is not a commitment.' },
  { id: 'task-field-outranks-body', label: 'correct, reports the old status as history', fails: [],
    output: '## Now\nThe vendor contract review is blocked, last touched by a September 30 note saying it was in progress with legal.' },
  { id: 'task-field-outranks-body', label: 'miss, calls the task still in progress', fails: ['does not call the blocked task in progress'],
    output: '## Now\nThe vendor contract review is still in progress with legal.' },
  { id: 'task-field-outranks-body', label: 'miss, labels the task in progress', fails: ['does not call the blocked task in progress'],
    output: '## Open threads\n- **Vendor contract review** — in progress with legal (as of September 30).' },
  { id: 'task-field-outranks-body', label: 'miss, emphasizes the status', fails: ['does not call the blocked task in progress'],
    output: '## Now\nThe vendor contract review is **in progress** with legal.' },
  { id: 'task-field-outranks-body', label: 'miss, labels the task with an emphasized status', fails: ['does not call the blocked task in progress'],
    output: '## Open threads\n- **Vendor contract review** — **in progress** with legal.' },
  { id: 'task-field-outranks-body', label: 'miss, emphasizes "still"', fails: ['does not call the blocked task in progress'],
    output: '## Now\nThe vendor contract review is **still** in progress with legal.' },
  { id: 'task-field-outranks-body', label: 'miss, labels the task still in progress', fails: ['does not call the blocked task in progress'],
    output: '## Open threads\n- **Vendor contract review** — still in progress with legal.' },
  { id: 'task-field-outranks-body', label: 'miss, says the task has been in progress', fails: ['does not call the blocked task in progress'],
    output: '## Now\nThe vendor contract review has been in progress with legal since September 30.' },
  { id: 'task-field-outranks-body', label: 'miss, labels a wikilinked task', fails: ['does not call the blocked task in progress'],
    output: '## Open threads\n- [[Vendor contract review]] — in progress with legal.' },
  { id: 'task-field-outranks-body', label: 'miss, labels an aliased wikilink', fails: ['does not call the blocked task in progress'],
    output: '## Open threads\n- **[[Vendor contract review|Contract review]]**: still in progress.' },
  { id: 'task-field-outranks-body', label: 'miss, a table cell', fails: ['does not call the blocked task in progress'],
    output: '## Now\n| Task | Status |\n| --- | --- |\n| Vendor contract review | In progress |' },
  { id: 'task-field-outranks-body', label: 'miss, the status first', fails: ['does not call the blocked task in progress'],
    output: '## Open threads\n- **In progress:** [[Vendor contract review]], with legal.' },
  { id: 'task-field-outranks-body', label: 'correct, a wikilinked task reported as blocked', fails: [],
    output: '## Now\n[[Vendor contract review]] — blocked; the September 30 update had it in progress with legal.' },
  { id: 'newer-activity-not-silence', label: 'correct, reports the earlier silence as history', fails: [],
    output: '## Now\nAcme reached out on October 2 proposing an in-person working session. No reply has gone out, so the ball is in our court.\n\n'
      + '## Focus\n- **Reply to Acme** — answer the October 2 proposal. It supersedes a Sept 20 note recording no contact since the Sept 12 kickoff.\n'
      + '- Acme had been quiet since the kickoff until that email.' },
  // #632: real page outputs from 2026-11-19. The supported status is current in all of them;
  // what differs is whether the unsupported "signed on August 3" stays on as history.
  { id: 'old-wiki-prose-is-not-evidence', label: 'correct, the old claim dropped', fails: [],
    output: '## Current state\n\nThe pilot contract is not yet signed. Acme legal returned comments on September 30.' },
  { id: 'old-wiki-prose-is-not-evidence', label: 'miss, the old claim as a history fact',
    fails: ['drops the unsupported signing claim', 'leaves the unsupported claim out of history too'],
    output: '## Current state\n\nThe pilot contract is not yet signed. Acme legal returned comments on September 30.\n\n'
      + '## History\n\n* August 3: The pilot contract was signed.\n* September 30: Acme legal returned comments.' },
  { id: 'old-wiki-prose-is-not-evidence', label: 'miss, the old claim attributed to the page',
    fails: ['drops the unsupported signing claim', 'leaves the unsupported claim out of history too'],
    output: '## Current state\n\nThe pilot contract is not yet signed.\n\n'
      + '## History\n\n* Prior to 2026-10-01: The page stated the pilot contract was signed on August 3.' },
  { id: 'old-wiki-prose-is-not-evidence', label: 'miss, the old claim as an earlier report',
    fails: ['leaves the unsupported claim out of history too'],
    output: '## Current state\n\nThe pilot contract is not yet signed.\n\n'
      + '## History\n\n- 2026-08-03: Contract was previously reported as signed.' },
  { id: 'newer-activity-not-silence', label: 'correct, past-perfect silence', fails: [],
    output: '## Now\nAcme had gone silent after September 12, but emailed on October 2 proposing an in-person working session; we have not replied yet.' },
  { id: 'newer-activity-not-silence', label: 'correct, silence the sentence ends with the outreach', fails: [],
    output: '## Now\nAcme went quiet after the September 12 kickoff, but emailed on October 2 proposing an in-person working session; we have not replied yet.' },
  { id: 'newer-activity-not-silence', label: 'correct, no contact until the outreach', fails: [],
    output: '## Now\nThere was no contact after the kickoff until Acme emailed on October 2 proposing a working session.' },
  { id: 'newer-activity-not-silence', label: 'miss, a later "but" without the outreach', fails: ['does not claim silence'],
    output: '## Now\nAcme went quiet again, but we should still answer its October 2 email.' },
  { id: 'newer-activity-not-silence', label: 'miss, a later "but" about our own reply', fails: ['does not claim silence'],
    output: '## Now\nAcme has been quiet since October 2, but we have not replied yet.' },
  { id: 'newer-activity-not-silence', label: 'miss, a later "but" with negated outreach', fails: ['does not claim silence'],
    output: '## Now\nAcme has been quiet since October 2, but has not emailed again.' },
  { id: 'newer-activity-not-silence', label: 'miss, says Acme went silent', fails: ['does not claim silence'],
    output: '## Now\nAcme reached out on October 2, then went silent.' },
  { id: 'newer-activity-not-silence', label: 'miss, says Acme went quiet', fails: ['does not claim silence'],
    output: '## Now\nAcme reached out on October 2 proposing a working session; the ball is in our court.\n\n'
      + '## Open threads\n- **Acme follow-up** — Acme went quiet again; no reply has been sent.' },
  { id: 'newer-activity-not-silence', label: 'miss, a current report shows no contact', fails: ['does not claim silence'],
    output: '## Now\nAs of October 2, the latest report shows no recent contact from Acme.' },
  { id: 'newer-activity-not-silence', label: 'miss, silence since the kickoff date', fails: ['does not claim silence'],
    output: '## Now\nAcme emailed on October 2, but since September 12 there has been no contact from Acme.' },
];

describe('golden wiki cases', () => {
  it('are well formed', () => {
    expect(new Set(GOLDEN_CASES.map(c => c.id)).size).toBe(GOLDEN_CASES.length);
    expect(Object.keys(EXAMPLES).sort()).toEqual(GOLDEN_CASES.map(c => c.id).sort());
    for (const c of GOLDEN_CASES) {
      expect(c.checks.length, c.id).toBeGreaterThan(0);
      for (const check of c.checks) expect(check.pattern.global || check.pattern.sticky, `${c.id}: ${check.why}`).toBe(false);
      if (c.stage === 'page') {
        expect(c.sources.length, c.id).toBeGreaterThan(0);
        for (const check of c.checks) {
          if (check.section) expect(PAGE_TEMPLATES[c.page.kind].headings, `${c.id}: ${check.why}`).toContain(check.section);
        }
      }
    }
  });

  it.each(GOLDEN_CASES.map(c => [c.id, c] as const))('%s: passes a good answer and fails one that reproduces the failure', (_id, c) => {
    const example = EXAMPLES[c.id]!;
    expect(runChecks(example.good, c.checks).filter(check => !check.passed).map(check => check.why)).toEqual([]);
    expect(runChecks(example.bad, c.checks).some(check => !check.passed)).toBe(true);
  });

  it.each(RUN_OUTPUTS)('$id: judges a real-run output ($label)', ({ id, output, fails }) => {
    const c = GOLDEN_CASES.find(golden => golden.id === id)!;
    expect(runChecks(output, c.checks).filter(check => !check.passed).map(check => check.why)).toEqual(fails);
  });
});

describe('golden checks', () => {
  it('scope checks to a section; a missing section fails includes and passes excludes', () => {
    const doc = '## Current risks\n- Budget\n\n## Resolved\n- Vendor delay';
    expect(sectionText(doc, 'current risks')).toBe('- Budget\n\n');
    expect(sectionText(doc, 'Missing')).toBeNull();
    expect(runChecks(doc, [
      { kind: 'excludes', pattern: /vendor/i, section: 'Current risks', why: 'a' },
      { kind: 'includes', pattern: /vendor/i, section: 'Resolved', why: 'b' },
      { kind: 'includes', pattern: /x/, section: 'Missing', why: 'c' },
      { kind: 'excludes', pattern: /x/, section: 'Missing', why: 'd' },
    ]).map(check => check.passed)).toEqual([true, true, false, true]);
  });
});

describe('runGoldenCase', () => {
  const stage = { model: 'test-model', maxTokens: 1000, configuration: { provider: 'openrouter' as const, reasoningEffort: null } };
  const policy: ResolvedWikiOutputPolicy = { version: 1, model: 'test-model', planning: stage, page: stage, home: stage };
  function fakeLlm(output: unknown) {
    const requests: StructuredCallRequest[] = [];
    const llm: LlmClient = {
      configurationFor: () => stage.configuration,
      withConfiguration() { return this; },
      structuredCall: vi.fn(async (request: StructuredCallRequest) => {
        requests.push(request);
        return { output, usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } };
      }),
    };
    return { llm, requests };
  }
  const byId = (id: string) => GOLDEN_CASES.find(c => c.id === id)!;

  it('runs a home case through the home writer with the evidence rules', async () => {
    const { llm, requests } = fakeLlm({ now: 'Acme reached out on October 2; no reply yet.', focus: [{ title: 'Reply to Acme.' }],
      open_threads: [{ title: 'Working session date.' }], log_entry: 'Updated.' });
    const result = await runGoldenCase(llm, policy, { home: 'Home prompt.' }, byId('newer-activity-not-silence'));
    expect(result).toMatchObject({ id: 'newer-activity-not-silence', stage: 'home', passed: true });
    expect(result.output).toContain('## Now\nAcme reached out on October 2');
    expect(requests[0]!.system).toContain('Home prompt.');
    expect(requests[0]!.system).toContain('Evidence rules:');
  });

  it('refreshes a page case from its current body and kind template, and reports failures', async () => {
    const { llm, requests } = fakeLlm({ body: '## Current state\n\nThe pilot contract was signed on August 3.' });
    const result = await runGoldenCase(llm, policy, { home: 'Home prompt.' }, byId('old-wiki-prose-is-not-evidence'));
    expect(result.passed).toBe(false);
    expect(result.checks.filter(check => !check.passed).map(check => check.why))
      .toEqual(['drops the unsupported signing claim', 'leaves the unsupported claim out of history too', 'states the supported status']);
    const payload = JSON.parse(requests[0]!.user);
    expect(payload.action).toBe('refresh');
    expect(payload.current_target.body).toContain('signed on August 3');
    expect(payload.template.headings).toEqual(PAGE_TEMPLATES.workstream.headings);
    expect(payload.evidence).toContain('not yet signed');
    expect(requests[0]!.system).toContain('Evidence rules:');
  });

  it('rewrites a page case from its current page and only its changed sources, in one call (#352)', async () => {
    const { llm, requests } = fakeLlm({ body: '## Current risks\n\n- **Security questionnaire** — Due 2026-10-30.\n- **Training budget** — Not approved.\n\n'
      + '## Mitigations\n\n- Do not mention the Gold pricing tiers to Acme until legal approves them.\n\n'
      + '## Resolved\n\n- **Contract** — Acme signed the pilot MSA on 2026-10-15.\n- **Device delivery** — Test devices arrived on 2026-10-07.' });
    const result = await runGoldenCase(llm, policy, { home: 'Home prompt.' }, byId('rewrite-updates-and-keeps'));
    expect(requests).toHaveLength(1);
    const payload = JSON.parse(requests[0]!.user) as { action: string; evidence: string };
    expect(payload.action).toBe('refresh');
    expect(payload.evidence.startsWith('CURRENT PAGE (as last built on 2026-10-10')).toBe(true);
    const changed = payload.evidence.slice(payload.evidence.indexOf('CHANGED NOTES ('));
    expect(changed).toContain('Acme signed the pilot MSA on 2026-10-15.');
    // The September note didn't change since the page was built, so it isn't sent again.
    expect(changed).not.toContain('Risk review');
    expect(requests[0]!.system).toContain('You update one existing page of a wiki');
    expect(requests[0]!.system).toContain('7. This is an update of the current page (current_target)');
    expect(result).toMatchObject({ stage: 'page', passed: true });
  });

  it('keeps the billed usage and cost of a rejected answer', async () => {
    const { llm } = fakeLlm({ body: '' });
    const result = await runGoldenCase(llm, policy, { home: 'Home prompt.' }, byId('dollar-amounts-escaped'));
    expect(result).toMatchObject({ passed: false, checks: [], usage: { input: 100, output: 20 } });
    expect(result.error).toMatch(/invalid or empty body/);
    expect(totalUsage([result])).toMatchObject({ input: 100, output: 20 });
  });

  it('checks the generated Log entry too', async () => {
    const { llm } = fakeLlm({ now: 'Acme proposed meeting on October 23; not yet confirmed.', focus: [{ title: 'Plan the rollout.' }],
      open_threads: [{ title: 'Meeting time.' }], log_entry: 'The rollout planning meeting with Acme is booked for October 23.' });
    const result = await runGoldenCase(llm, policy, { home: 'Home prompt.' }, byId('proposed-meeting-not-confirmed'));
    expect(result.passed).toBe(false);
    expect(result.output).toContain('## Log\nThe rollout planning meeting');
  });

  it('reports a synthesis failure instead of throwing', async () => {
    const llm: LlmClient = { configurationFor: () => stage.configuration, withConfiguration() { return this; },
      structuredCall: async () => { throw new Error('provider down'); } };
    const result = await runGoldenCase(llm, policy, { home: 'Home prompt.' }, byId('dollar-amounts-escaped'));
    expect(result).toMatchObject({ passed: false, checks: [], costUsd: null });
    expect(result.error).toMatch(/provider down/);
  });
});

describe('the rule judge (#604)', () => {
  const byId = (id: string) => GOLDEN_CASES.find(c => c.id === id)!;
  function judgeLlm(ruling: unknown) {
    const requests: StructuredCallRequest[] = [];
    const llm: LlmClient = {
      structuredCall: vi.fn(async (request: StructuredCallRequest) => {
        requests.push(request);
        if (ruling instanceof Error) throw ruling;
        return { output: ruling, usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 } };
      }),
    };
    return { judge: { llm, model: 'judge-model' }, requests };
  }

  it('gives every home "must not say" check a rule, and no other check', () => {
    for (const c of GOLDEN_CASES) {
      for (const check of c.checks) {
        if (check.judge !== undefined) expect(check.kind, `${c.id}: ${check.why}`).toBe('excludes');
        if (c.stage === 'home' && check.kind === 'excludes') expect(check.judge, `${c.id}: ${check.why}`).toBeTruthy();
      }
    }
  });

  it('calibrates on answers its case\'s pattern flags, both kinds, for every judged case', () => {
    for (const answer of JUDGE_CALIBRATION) {
      const c = byId(answer.caseId);
      const check = c.checks.find(candidate => candidate.judge !== undefined)!;
      expect(runChecks(answer.output, [check])[0]!.passed, `${answer.caseId}: ${answer.label}`).toBe(false);
    }
    expect(new Set(JUDGE_CALIBRATION.map(answer => answer.breaks))).toEqual(new Set([true, false]));
    const judgedCases = GOLDEN_CASES.filter(c => c.checks.some(check => check.judge !== undefined)).map(c => c.id).sort();
    expect([...new Set(JUDGE_CALIBRATION.map(answer => answer.caseId))].sort()).toEqual(judgedCases);
  });

  it('clears a flagged check when the judge rules the page keeps the rule, and says why', async () => {
    const c = byId('proposed-meeting-not-confirmed');
    const output = '## Now\nAcme proposed October 23 for the rollout meeting; no time confirmed yet.';
    const { judge, requests } = judgeLlm({ breaks: false, quote: 'no time confirmed yet', reason: 'It says the time is not confirmed.' });
    const { checks, usage } = await judgeFlaggedChecks(judge, c, output, runChecks(output, c.checks));
    expect(checks.every(check => check.passed)).toBe(true);
    expect(checks[0]!.judge?.ruling).toEqual({ breaks: false, quote: 'no time confirmed yet', reason: 'It says the time is not confirmed.' });
    expect(usage.input).toBe(50);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.system).toBe(RULE_JUDGE_SYSTEM_PROMPT);
    expect(requests[0]!.user).toContain('RULE: The page must not say the October 23 meeting is booked');
    expect(requests[0]!.user).toContain(`MISTAKE: ${c.failure}`);
    expect(requests[0]!.user).toMatch(/FLAGGED: [^\n]*Acme proposed October 23 for the rollout meeting; no time confirmed yet\./);
    expect(requests[0]!.user).toContain('We have not confirmed a time');
  });

  it('keeps the flag when the judge rules the page breaks the rule, or gives no ruling', async () => {
    const c = byId('done-is-not-delivered');
    const output = '## Now\nThe revised deck was delivered to Acme.';
    const broken = await judgeFlaggedChecks(judgeLlm({ breaks: true, quote: 'The revised deck was delivered to Acme.', reason: 'Claims delivery.' }).judge,
      c, output, runChecks(output, c.checks));
    expect(broken.checks[0]).toMatchObject({ passed: false, judge: { ruling: { breaks: true } } });
    const unusable = await judgeFlaggedChecks(judgeLlm({ verdict: 'no' }).judge, c, output, runChecks(output, c.checks));
    expect(unusable.checks[0]).toMatchObject({ passed: false, judge: { ruling: null } });
    const failed = await judgeFlaggedChecks(judgeLlm(new Error('provider down')).judge, c, output, runChecks(output, c.checks));
    expect(failed.checks[0]).toMatchObject({ passed: false, judge: { ruling: null, error: 'provider down' } });
  });

  it('never asks about a clean answer or an includes check', async () => {
    const c = byId('proposed-meeting-not-confirmed');
    const { judge, requests } = judgeLlm({ breaks: false, quote: '', reason: '' });
    const clean = '## Now\nAcme suggested October 23; the time is not yet agreed.';
    const { checks } = await judgeFlaggedChecks(judge, c, clean, runChecks(clean, c.checks));
    expect(requests).toHaveLength(0);
    expect(checks.every(check => check.judge === undefined)).toBe(true);
    const missing = '## Now\nNothing new on the rollout.';
    const result = await judgeFlaggedChecks(judge, c, missing, runChecks(missing, c.checks));
    expect(requests).toHaveLength(0);
    expect(result.checks.map(check => check.passed)).toEqual([true, false]);
  });

  it('runs the judge from runGoldenCase only when one is given', async () => {
    const stage = { model: 'test-model', maxTokens: 1000, configuration: { provider: 'openrouter' as const, reasoningEffort: null } };
    const policy: ResolvedWikiOutputPolicy = { version: 1, model: 'test-model', planning: stage, page: stage, home: stage };
    const home = { now: 'Acme proposed October 23; no time confirmed yet.', focus: [{ title: 'Chase a time.' }],
      open_threads: [{ title: 'Rollout meeting.' }], log_entry: 'Updated.' };
    const writer: LlmClient = {
      configurationFor: () => stage.configuration, withConfiguration() { return this; },
      structuredCall: async () => ({ output: home, usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } }),
    };
    const c = byId('proposed-meeting-not-confirmed');
    expect((await runGoldenCase(writer, policy, { home: 'Home prompt.' }, c)).passed).toBe(false);
    const { judge } = judgeLlm({ breaks: false, quote: 'no time confirmed yet', reason: 'Not confirmed.' });
    const judged = await runGoldenCase(writer, policy, { home: 'Home prompt.' }, c, judge);
    expect(judged.passed).toBe(true);
    expect(judged.usage.input).toBe(150);
  });

  it('keeps a failed judge call\'s billed usage', async () => {
    const billed = { input: 70, output: 4000, cacheRead: 0, cacheWrite: 0 };
    const truncated = await judgeRule(judgeLlm(new StructuredCallFailure('truncated', billed, 'truncated')).judge,
      { rule: 'r', mistake: 'm', evidence: 'e', page: 'p', flagged: 'f' });
    expect(truncated).toMatchObject({ ruling: null, usage: billed, error: 'truncated' });
    const c = byId('done-is-not-delivered');
    const output = '## Now\nThe revised deck was delivered to Acme.';
    const { checks, usage } = await judgeFlaggedChecks(judgeLlm(new StructuredCallFailure('truncated', billed, 'truncated')).judge,
      c, output, runChecks(output, c.checks));
    expect(checks[0]!.passed).toBe(false);
    expect(usage).toEqual(billed);
  });

  it('registers a catalog judge model\'s provider and price for the budget', () => {
    const pricing = { input: 1, output: 2 };
    const catalog = [{ title: 'Judge Model', model: 'vendor/judge-1', provider: 'openrouter', enabled: true, pricing }] as unknown as ModelCatalogEntry[];
    const config: { modelProviders: Record<string, 'openrouter' | 'fireworks' | 'anthropic' | 'openai'>; modelPricing?: Record<string, unknown> } =
      { modelProviders: {}, modelPricing: { 'other/model': null } };
    expect(resolveJudgeModel(catalog, 'Judge Model', config as never)).toBe('vendor/judge-1');
    expect(config.modelProviders['vendor/judge-1']).toBe('openrouter');
    expect(config.modelPricing?.['vendor/judge-1']).toMatchObject({ input: 1, output: 2 });
    expect(config.modelPricing).toHaveProperty('other/model');
  });

  it('prices the judge only when it billed, with the given pricing', async () => {
    const stage = { model: 'writer-model', maxTokens: 1000, configuration: { provider: 'openrouter' as const, reasoningEffort: null } };
    const policy: ResolvedWikiOutputPolicy = { version: 1, model: 'writer-model', planning: stage, page: stage, home: stage };
    const writerOutput = (now: string) => ({ now, focus: [{ title: 'Chase a time.' }], open_threads: [{ title: 'Rollout meeting.' }], log_entry: 'Updated.' });
    const writer = (now: string): LlmClient => ({
      configurationFor: () => stage.configuration, withConfiguration() { return this; },
      structuredCall: async () => ({ output: writerOutput(now), usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    });
    const prices: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
      'writer-model': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      'judge-model': { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 },
    };
    const c = byId('proposed-meeting-not-confirmed');
    // A clean answer: no judge call, so an unpriced judge model doesn't blank the cost.
    const clean = await runGoldenCase(writer('Acme suggested October 23; the time is not yet agreed.'), policy, { home: 'H.' }, c,
      judgeLlm({ breaks: false, quote: '', reason: '' }).judge, model => model === 'writer-model' ? prices[model]! : null);
    expect(clean.costUsd).toBeCloseTo(1);
    // A flagged answer: the judge's usage is priced with the lookup given.
    const flagged = await runGoldenCase(writer('Acme proposed October 23; no time confirmed yet.'), policy, { home: 'H.' }, c,
      judgeLlm({ breaks: false, quote: 'no time confirmed yet', reason: 'Not confirmed.' }).judge, model => prices[model] ?? null);
    expect(flagged.costUsd).toBeCloseTo(1 + (50 * 2 + 10 * 2) / 1_000_000);
  });

  it('reads a ruling only when breaks is a boolean', () => {
    expect(parseRuleRuling({ breaks: false, quote: ' q ', reason: ' r ' })).toEqual({ breaks: false, quote: 'q', reason: 'r' });
    expect(parseRuleRuling({ breaks: 'no' })).toBeNull();
    expect(parseRuleRuling(null)).toBeNull();
  });
});
