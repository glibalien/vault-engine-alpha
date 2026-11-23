import type { ExtractionFixture } from './extraction.js';

/** Four planted-fact fixtures: a meeting note, a daily note, a clipping
 *  where the correct extraction is NOTHING (tests the emit-nothing discipline),
 *  and an account sync holding rules on what may be said (#626).
 *  Bodies deliberately mix durable facts with ephemera. */
export const EXTRACTION_FIXTURES: ExtractionFixture[] = [
  {
    title: 'Kickoff — garage renovation',
    file_path: 'Meetings/Kickoff — garage renovation.md',
    body: [
      'Met with the contractor at 9:30 (he was 10 minutes late, traffic on I-90).',
      'Contractor is Hillside Builds; our project lead there is Dana Okafor.',
      'Agreed budget ceiling is $42k, firm — Dana said change orders above that need written sign-off.',
      'Coffee was terrible. Next check-in scheduled for Thursday.',
      'Avery prefers all invoices sent to the shared household email, not his work address.',
    ].join('\n'),
    expected: [
      'The garage renovation contractor is Hillside Builds; the project lead is Dana Okafor',
      'The garage renovation budget ceiling is $42k; change orders above it need written sign-off',
      'Avery prefers invoices sent to the shared household email, not his work address',
    ],
    subjects: ['Hillside Builds', 'Dana Okafor'],
  },
  {
    title: '2026-07-03',
    file_path: 'Journal/2026-07-03.md',
    body: [
      'Slow morning, skipped the run — knee still sore.',
      'Lunch with Rowan. She mentioned she is switching teams in September to lead the data platform group.',
      'Groceries after work. Rain most of the evening.',
    ].join('\n'),
    expected: [
      'Rowan is switching teams in September to lead the data platform group',
    ],
    subjects: ['Rowan'],
  },
  {
    title: 'How SQLite WAL mode works',
    file_path: 'Clippings/How SQLite WAL mode works.md',
    body: [
      'Clipped from a blog post: WAL mode appends changes to a write-ahead log instead of',
      'overwriting pages in place. Readers see a consistent snapshot; a checkpoint folds the',
      'log back into the main database file. Long-running readers can delay checkpoints.',
    ].join('\n'),
    expected: [], // reference material about the world, not durable personal/project facts
  },
  {
    title: 'Northwind pilot — messaging sync',
    file_path: 'Meetings/Northwind pilot — messaging sync.md',
    body: [
      'Quick sync with Priya before Thursday\'s Northwind pilot review. Room was freezing again.',
      'Northwind\'s brand team asked that we always write "Northwind Cloud Ledger" in full, never "NCL" or "the Ledger".',
      'Do not give Northwind a launch date for the mobile app; if they ask, say "later this year".',
      'Northwind\'s procurement contact is Tomas Reyes.',
      'Ordered sandwiches for the team; Priya will book the room for next week.',
    ].join('\n'),
    // Three, the production per-note cap.
    expected: [
      'Northwind Cloud Ledger is always written in full for Northwind, never "NCL" or "the Ledger"',
      'Northwind is not to be given a launch date for the mobile app; say "later this year"',
      'Northwind\'s procurement contact is Tomas Reyes',
    ],
    rules: 2,
    subjects: ['Northwind', 'Tomas Reyes'],
  },
];
