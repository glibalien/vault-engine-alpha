import type { ThemedPageKind } from '../types.js';

/**
 * Golden wiki cases: synthetic evidence reproducing failures seen in real wikis
 * (plan appendix B, docs/superpowers/plans/2026-10-25-curator-reset.md). Each case
 * runs one real page or home synthesis and checks the output with deterministic
 * patterns; a judge rules on what a "must not say" pattern with a `judge` rule flags
 * (#604). Informational: run with `npm run eval:wiki` before changing prompts or
 * models. All names are fictional.
 */

/** A pattern the output must (`includes`) or must not (`excludes`) match,
 *  optionally only within one `##` section. */
export interface GoldenCheck {
  readonly kind: 'includes' | 'excludes';
  readonly pattern: RegExp;
  readonly why: string;
  readonly section?: string;
  /** For an `excludes` check: the rule in full, for the judge that rules on an answer the pattern
   *  flags (#604). A pattern sees words; the judge decides whether the page says the thing. */
  readonly judge?: string;
}

export interface GoldenSource {
  readonly title: string;
  readonly types: readonly string[];
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly body: string;
  /** In a `rewrite` case: changed since the page was last built (#352). */
  readonly new?: true;
}

interface CaseBase {
  readonly id: string;
  /** The observed failure this case guards against. */
  readonly failure: string;
  readonly checks: readonly GoldenCheck[];
}

/** Home narrative written from rendered project evidence. */
export interface HomeCase extends CaseBase {
  readonly stage: 'home';
  readonly evidence: string;
}

/** One sub-page written from source notes; with `currentBody`, a refresh of an existing page, and
 *  with `rewrite` as well, a bounded rewrite from only the sources marked `new` (#352). */
export interface PageCase extends CaseBase {
  readonly stage: 'page';
  readonly page: { readonly title: string; readonly kind: ThemedPageKind; readonly brief: string; readonly currentBody?: string };
  readonly rewrite?: { readonly builtAt: string };
  readonly sources: readonly GoldenSource[];
}

export type GoldenCase = HomeCase | PageCase;

/** Every case is written as of this date. */
export const GOLDEN_NOW = new Date('2026-10-20T12:00:00.000Z');

const home = (sections: string): string => `# Project: Northwind Pilot\nStatus: in-progress\n\n${sections}`;

/** Not followed, in the same sentence, by Acme's outreach ending the silence: "…, but emailed on
 *  October 2", "… until Acme emailed", "… until October 2". Only Acme's affirmative outreach right
 *  after the "but", "then" or "until" counts, never ours or a negated one ("but we have not replied"). */
const SILENCE_ENDED_LATER = new RegExp('(?![^.\\n]*\\b('
  + /(but|then|until) (on (oct(ober)?\.? 2|2026-10-02),? )?((acme|dana( ruiz)?|they|it|she) )?(emailed|reached out|wrote|proposed|got in touch|got back)\b/.source
  + '|' + /until ((its|the|acme['’]s) )?(oct(ober)?\.? 2\b|2026-10-02)/.source + '))').source;

/** "in progress", optionally emphasized and qualified ("**still** in progress"). */
const IN_PROGRESS = /[*_]*((still|currently|now)[*_]* [*_]*)?in progress/.source;

export const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    id: 'newer-activity-not-silence',
    failure: 'A newer report recorded outreach, but the home still said there was no recent activity.',
    stage: 'home',
    evidence: home(`## Tasks
- Follow up with Acme procurement — open

## Evidence reads
### Northwind weekly report — 2026-10-05
types: report
fields: date="2026-10-05"

On October 2, Dana Ruiz (Acme) emailed proposing an in-person working session to review pilot results. No reply has been sent yet.

### Northwind status note — 2026-09-20
types: note

No contact from Acme since the September 12 kickoff.`),
    checks: [
      { kind: 'includes', pattern: /oct(ober)?\.? 2\b|2026-10-02/i, why: 'mentions the October 2 outreach' },
      // Silence claimed now. Explicit history passes (#386): what a note dated before the October 2
      // outreach recorded ("a Sept 20 note recording no contact"), a past perfect ("had been quiet"),
      // or silence the same sentence ends with the outreach ("went quiet …, but emailed on October 2").
      { kind: 'excludes', pattern: new RegExp('(' + [
        /(?<!\b(sep(t(ember)?)?\.? \d{1,2}|2026-09-\d\d)\b[^.\n]*\b(note|report|update|summary|entry)\w*\b[^.\n]*|\bhad been )/.source
          + /\bno (recent )?(contact|activity|signal)\b/.source,
        /(?<!\bhad )\b((been|gone|going|went|remains?|stays?) quiet|(went|gone|going|fallen|fell) silent)\b/.source,
        /not heard (back )?from|no response from acme/.source,
      ].join('|') + ')' + SILENCE_ENDED_LATER, 'i'),
        why: 'does not claim silence',
        judge: 'The page must not present Acme as currently quiet, silent or out of contact. Acme emailed on October 2, after the September 20 note that recorded no contact; that note is history.' },
    ],
  },
  {
    id: 'proposed-meeting-not-confirmed',
    failure: 'A proposed meeting was reported as booked or confirmed.',
    stage: 'home',
    evidence: home(`## Evidence reads
### Email summary — 2026-10-14
types: note

Acme suggested meeting on October 23 to plan the rollout. We have not confirmed a time; the proposal is waiting on their calendar.`),
    checks: [
      { kind: 'excludes', pattern: /(?<!(\bno|not|n't|never) (yet )?(been )?)\b(booked|confirmed|locked in)\b/i, why: 'does not call the meeting booked or confirmed',
        judge: 'The page must not say the October 23 meeting is booked, confirmed or scheduled. Acme only proposed it, and no time is agreed.' },
      { kind: 'includes', pattern: /propos|suggest|tentative|pending|not (yet )?confirmed|unconfirmed/i, why: 'presents the meeting as proposed' },
    ],
  },
  {
    id: 'report-date-is-not-event-date',
    failure: 'A discussion was dated by the report that described it, not by when it happened.',
    stage: 'page',
    page: { title: 'Northwind Pilot — Timeline', kind: 'timeline', brief: 'Order the pilot\'s dated events.' },
    sources: [
      { title: 'Northwind weekly report — 2026-09-21', types: ['report'], fields: { date: '2026-09-21' },
        body: 'This week\'s report. On September 18 the team discussed splitting the pilot timeline into two phases. The decision is still open.' },
    ],
    checks: [
      { kind: 'includes', pattern: /sep(tember|t)?\.? 18|2026-09-18|09-18/i, why: 'dates the discussion September 18' },
      { kind: 'excludes', pattern: /\bon (sep(tember|t)?\.? 21|2026-09-21)[^.\n]*discuss|discuss\w*[^.\n]*\bon (sep(tember|t)?\.? 21|2026-09-21)/i,
        why: 'does not date the discussion by the report' },
    ],
  },
  {
    id: 'done-is-not-delivered',
    failure: 'A task marked done was described as delivered and accepted.',
    stage: 'home',
    evidence: home(`## Tasks
- Send revised pilot deck to Acme — done

## Evidence reads
### Pilot prep note — 2026-10-10
types: note

Revised deck finished and closed out the task. Acme has not acknowledged anything yet.`),
    checks: [
      { kind: 'excludes', pattern: /(?<!(not|n't|never) (yet )?(been )?)\b(delivered|received|accepted|acknowledged|signed off)\b/i,
        why: 'claims no delivery or acceptance',
        judge: 'The page must not say the revised deck was delivered, received, accepted or acknowledged. The task was only closed, and Acme has acknowledged nothing.' },
    ],
  },
  {
    id: 'superseded-scope-is-history',
    failure: 'A superseded scope decision stayed in the current state.',
    stage: 'page',
    page: { title: 'Northwind Pilot — Scope', kind: 'workstream', brief: 'Describe what the pilot currently covers.' },
    sources: [
      { title: 'Scope note — 2026-09-20', types: ['note'], body: 'Pilot scope: sandbox data plus Outlook integration.' },
      { title: 'Scope decision — 2026-09-25', types: ['note'], body: 'Scope change agreed on September 25: Outlook integration is out of scope for the pilot. The pilot uses anonymized sandbox data only.' },
    ],
    checks: [
      { kind: 'excludes', pattern: /\b(includes|including|plus|with|and)\s+(an?\s+|the\s+)?outlook/i, section: 'Current state',
        why: 'does not present Outlook as in scope' },
      { kind: 'excludes', pattern: /outlook[^.\n]*\b(open|pending|undecided|to be decided|under discussion)\b/i, section: 'Current state',
        why: 'does not present the settled Outlook decision as open' },
      { kind: 'includes', pattern: /anonymi[sz]ed/i, section: 'Current state', why: 'states the current sandbox scope' },
    ],
  },
  {
    id: 'no-restated-task-counts',
    failure: 'The narrative restated task counts that conflicted with the live task sections.',
    stage: 'home',
    evidence: home(`## Tasks
- Draft security questionnaire — open
- Schedule data review — open
- Confirm success metrics — open
- Prepare training plan — open
- Collect pilot feedback — open

## Evidence reads
### Pilot status — 2026-10-15
types: note

Work is on track; the security questionnaire is the item most likely to slip.`),
    checks: [
      { kind: 'excludes', pattern: /\b(\d+|one|two|three|four|five|six)\s+(open|outstanding|remaining|pending)\s+tasks?\b/i, why: 'does not restate task counts',
        judge: 'The page must not state how many tasks are open, outstanding, remaining or pending. The live task sections already show the tasks.' },
    ],
  },
  {
    id: 'task-field-outranks-body',
    failure: 'Narrative used stale task body text instead of the current status field.',
    stage: 'home',
    evidence: home(`## Tasks
- Vendor contract review — blocked

## Evidence reads
### Vendor contract review
types: task
fields: status="blocked"

Status update (September 30): in progress with legal.`),
    checks: [
      // Calling the task in progress, with or without emphasis or a wikilink, not reporting what the
      // old status update said (#386).
      { kind: 'excludes', pattern: new RegExp([
        // "The vendor contract review is (still) in progress", "has been in progress", "it's in progress"
        /vendor contract[^.\n]*(\b(is|remains|stays|has been)|['’]s( been)?) /.source + IN_PROGRESS,
        // a label: "**Vendor contract review** — in progress", "[[Vendor contract review]]: still in progress", a table cell
        /vendor contract( review)?(\|[^\]\n]*)?[*_\]]* *([—–:(|]| -) *(status:? *)?/.source + IN_PROGRESS,
        // the status first: "In progress: [[Vendor contract review]]"
        /(^|\n)[-*+ ]*[*_]*in progress[*_]* *([—–:]| -)[^.\n]*vendor contract/.source,
      ].join('|'), 'i'),
        why: 'does not call the blocked task in progress',
        judge: 'The page must not say the vendor contract review is in progress now. Its status field says blocked; the September 30 "in progress" wording is older.' },
    ],
  },
  {
    id: 'old-wiki-prose-is-not-evidence',
    failure: 'A claim from the previous wiki text survived although no source supported it.',
    stage: 'page',
    page: { title: 'Northwind Pilot — Contract', kind: 'workstream', brief: 'Describe the contract status.',
      currentBody: '## Current state\n\nThe pilot contract was signed on August 3.' },
    sources: [
      { title: 'Legal update — 2026-10-01', types: ['note'], body: 'The pilot contract is not yet signed; Acme legal returned comments on September 30.' },
    ],
    checks: [
      { kind: 'excludes', pattern: /(was|been|is) signed(?! [^.]*not)|signed on aug/i, why: 'drops the unsupported signing claim' },
      // No source names August 3: any mention of it is the old claim, as history or attributed
      // to the old page too (owner's decision, #632; 9 of 10 pages moved it to History).
      { kind: 'excludes', pattern: /\baug(?:ust|\.)? 0?3\b|-08-03\b/i, why: 'leaves the unsupported claim out of history too' },
      { kind: 'includes', pattern: /not (yet )?signed|unsigned/i, why: 'states the supported status' },
    ],
  },
  {
    id: 'resolved-risk-stays-resolved',
    failure: 'A resolved risk was presented as a current risk.',
    stage: 'page',
    page: { title: 'Northwind Pilot — Risks', kind: 'risk-register', brief: 'Track the pilot\'s risks.' },
    sources: [
      { title: 'Risk review — 2026-09-15', types: ['note'], body: 'Risk: hardware vendor may deliver test devices late, delaying onboarding.' },
      { title: 'Vendor update — 2026-10-08', types: ['note'], body: 'Test devices arrived on October 7; the delivery risk is closed. New risk: the training budget has not been approved.' },
    ],
    checks: [
      { kind: 'excludes', pattern: /device|vendor|deliver/i, section: 'Current risks', why: 'keeps the closed delivery risk out of current risks' },
      { kind: 'includes', pattern: /training budget/i, section: 'Current risks', why: 'lists the open budget risk' },
    ],
  },
  {
    id: 'dollar-amounts-escaped',
    failure: 'Unescaped dollar amounts rendered as math.',
    stage: 'page',
    page: { title: 'Northwind Pilot — Budget', kind: 'spotlight', brief: 'Summarize the pilot budget.' },
    sources: [
      { title: 'Budget note — 2026-10-12', types: ['note'], body: 'Pilot fee is $45,000; an optional training add-on costs $12,000.' },
    ],
    checks: [
      { kind: 'excludes', pattern: /(^|[^\\])\$\d/m, why: 'escapes every dollar amount' },
      { kind: 'includes', pattern: /45,000/, why: 'keeps the amount' },
    ],
  },
  {
    id: 'rewrite-updates-and-keeps',
    failure: 'Re-planned in full, one project\'s Risks page dropped constraints and kept stale statuses; a rewrite under the page prompt dropped a whole section with its do-not-say rule (#389, #392). A rewrite from the changed notes must update what changed and carry the rest forward.',
    stage: 'page',
    page: { title: 'Northwind Pilot — Risks', kind: 'risk-register', brief: 'Track the pilot\'s risks.',
      currentBody: '## Current risks\n\n- **Contract** — The pilot MSA is in Acme legal review (as of 2026-09-20).\n'
        + '- **Training budget** — The training budget for the pilot has not been approved.\n\n'
        + '## Mitigations\n\n- Do not mention the Gold pricing tiers to Acme until legal approves them.\n\n'
        + '## Resolved\n\n- **Device delivery** — Test devices arrived on 2026-10-07.' },
    rewrite: { builtAt: '2026-10-10T09:00:00.000Z' },
    sources: [
      { title: 'Risk review — 2026-09-20', types: ['meeting'], fields: { date: '2026-09-20' },
        body: 'The pilot MSA is in Acme legal review. The training budget is still waiting on approval.' },
      { title: 'Account call — 2026-10-15', types: ['meeting'], fields: { date: '2026-10-15' }, new: true,
        body: 'Acme signed the pilot MSA on 2026-10-15. Acme procurement now requires a security questionnaire, due 2026-10-30, before the pilot can expand.' },
    ],
    checks: [
      { kind: 'excludes', pattern: /legal review/i, section: 'Current risks', why: 'no longer lists the contract as in legal review' },
      { kind: 'includes', pattern: /signed/i, why: 'states the signing' },
      { kind: 'includes', pattern: /questionnaire/i, section: 'Current risks', why: 'adds the new questionnaire risk' },
      { kind: 'includes', pattern: /training budget/i, section: 'Current risks', why: 'keeps the unchanged budget risk' },
      { kind: 'includes', pattern: /Gold pricing/i, why: 'keeps the do-not-say rule' },
      { kind: 'includes', pattern: /devices? arrived|device delivery/i, section: 'Resolved', why: 'keeps the resolved item' },
    ],
  },
];
