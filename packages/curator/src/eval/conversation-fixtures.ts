import type { TranscriptTurn } from '@vault/chat-core/transcript';

/** A made-up finished chat with the facts a good conversation sweep keeps (#605): often none. The
 *  sweep keeps only what the user asserted or endorsed, never instructions, retrieved vault content
 *  or the assistant's own reasoning. Scored by `judgeConversation`: each expected list is complete. */
export interface ConversationFixture {
  title: string;
  turns: TranscriptTurn[];
  /** Every lasting fact about the user a good sweep keeps (semantic match, judged); complete, so any
   *  other kept fact is a violation. */
  expected: string[];
  /** How many of `expected` are rules on what may be said, shared or claimed, which the sweep
   *  should label `rule` (#626). Absent: none. */
  rules?: number;
  /** The subjects the facts should name between them, by full name (#554): checked by name, not
   *  judged. Absent: none expected. */
  subjects?: string[];
}

const user = (text: string): TranscriptTurn => ({ role: 'user', text });
const assistant = (text: string): TranscriptTurn => ({ role: 'assistant', text });

export const CONVERSATION_FIXTURES: ConversationFixture[] = [
  {
    title: 'Status report format',
    turns: [
      user('Can you draft this week\'s status report for the Atlas project? And going forward, I always want status reports as one bullet list, never tables. Tables are unreadable on my phone.'),
      assistant('Here is the draft as a single bullet list:\n- Beta build passed QA\n- Pricing page copy is with legal\n- Launch checklist is 80% done'),
    ],
    expected: ['The user wants status reports as a single bullet list, never tables, because tables are hard to read on a phone'],
  },
  {
    title: 'Staging hosting decision',
    turns: [
      user('We need to cut the Atlas staging bill. What are the options?'),
      assistant('You could downsize the current instances, move staging to a cheaper provider such as Hetzner, or shut staging down outside working hours.'),
      user('Let\'s move staging to Hetzner. The managed instances cost three times as much and we never use the extra features.'),
    ],
    expected: ['The user decided to move the Atlas staging environment to Hetzner because the managed instances cost three times as much'],
    subjects: ['Atlas'],
  },
  {
    title: 'Who leads payments',
    turns: [
      user('Draft an intro email to whoever leads payments now.'),
      assistant('Here is a draft to Priya Raman, who leads the payments team.'),
      user('No, Priya moved to the data platform team last month. Payments is led by Tomas Lind now.'),
      assistant('Thanks, here is the draft addressed to Tomas Lind.'),
    ],
    subjects: ['Priya Raman', 'Tomas Lind'],
    expected: [
      'Priya Raman moved to the data platform team and no longer leads payments',
      'Tomas Lind leads the payments team',
    ],
  },
  {
    title: 'Attach meeting summary',
    turns: [
      user('Attach the meeting summary to the Northwind node and set its status to done.'),
      assistant('Done: the summary is attached to Northwind Pilot and the status is now done.'),
      user('Also move the old kickoff note into the archive folder.'),
      assistant('Moved "Kickoff — 2026-09-12" to Archive/.'),
    ],
    expected: [],
  },
  {
    title: 'Contract renewal lookup',
    turns: [
      user('When does the Contoso contract renew?'),
      assistant('Your note "Contoso contract" says it renews on March 1, 2027, with a 60-day notice period.'),
      user('ok thanks'),
    ],
    expected: [],
  },
  {
    title: 'Vector database market',
    turns: [
      user('What do you think happens to the vector database market next year?'),
      assistant('I expect consolidation: general-purpose databases are adding vector search, so several standalone vendors will likely be acquired or narrow their focus.'),
      user('Interesting.'),
    ],
    expected: [],
  },
  {
    title: 'Meeting-free Fridays',
    turns: [
      user('Find a slot next week for the Atlas design review.'),
      assistant('Thursday 2pm or Friday 10am are free. Should I also keep Fridays free of meetings in general when I suggest slots?'),
      user('Yes, do that. Fridays are for deep work, always.'),
      assistant('Booked Thursday at 2pm, and I\'ll keep Fridays clear from now on.'),
    ],
    expected: ['The user keeps Fridays free of meetings for deep work'],
  },
  {
    title: 'Atlas launch email',
    turns: [
      user('Draft the Atlas launch email to Contoso.'),
      assistant('Here is a draft. It says AS ships on March 3.'),
      user('Take the date out: with Contoso we never give a ship date. And it\'s "Atlas Sync" in full, never "AS".'),
      assistant('Done: no date, and "Atlas Sync" in full throughout.'),
    ],
    // Two, the production per-conversation cap.
    expected: [
      'Contoso is never given a ship date',
      'Atlas Sync is always written in full, never "AS"',
    ],
    rules: 2,
    subjects: ['Contoso'],
  },
  {
    title: 'Delayed flight',
    turns: [
      user('My flight is delayed two hours, I\'m stuck at the airport. Can you summarize the Atlas launch checklist so I can read it here?'),
      assistant('Sure. The checklist has 12 items; 9 are done. Open: final pricing sign-off, support macros, and the status page.'),
    ],
    expected: [],
  },
];
