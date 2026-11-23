import type { NearPair, NearPairMember } from '../engine.js';

/** One near pair with the verdict a good reconciler returns (#605). `survivor` names the memory that
 *  must stay for a duplicate or contradiction. Names are made up; the shapes come from real bugs. */
export interface ReconcileFixture {
  id: string;
  /** What the case guards against. */
  why: string;
  pair: NearPair;
  expected: { verdict: 'duplicate' | 'contradiction' | 'distinct'; survivor?: 'a' | 'b' };
}

let nextId = 1000;
function memory(content: string, extra: Partial<NearPairMember> = {}): NearPairMember {
  const id = nextId++;
  return {
    id, source: 'curator', scope: 'vault', node_id: null, content, category: 'fact',
    created_at: '2026-10-01T09:00:00.000Z', updated_at: '2026-10-01T09:00:00.000Z',
    valid_at: null, evidence_kind: 'note', note_date: null, note_title: null, note_projects: [],
    ...extra,
  };
}

function pair(a: NearPairMember, b: NearPairMember, distance = 0.12): NearPair {
  return { a, b, distance };
}

export const RECONCILE_FIXTURES: ReconcileFixture[] = [
  {
    id: 'duplicate-richer-survives',
    why: 'Of two statements of one fact, the fuller one stays (#349: a narrower memory replaced a richer one).',
    pair: pair(
      memory('Northwind\'s pilot uses anonymized sandbox data.', { note_date: '2026-09-25', note_title: 'Scope decision — 2026-09-25', note_projects: ['Northwind Pilot'] }),
      memory('Northwind\'s pilot uses anonymized sandbox data only; Outlook integration is out of scope.', { note_date: '2026-09-25', note_title: 'Scope decision — 2026-09-25', note_projects: ['Northwind Pilot'] }),
      0.08,
    ),
    expected: { verdict: 'duplicate', survivor: 'b' },
  },
  {
    id: 'changed-fact-newer-note-survives',
    why: 'A real change: the memory from the newer note stays, though it was saved first (#349: older notes replaced newer ones).',
    pair: pair(
      memory('Priya Raman leads the data platform team.', { note_date: '2026-10-12', note_title: 'Team update — 2026-10-12', created_at: '2026-10-02T09:00:00.000Z', updated_at: '2026-10-02T09:00:00.000Z' }),
      memory('Priya Raman leads the payments team.', { note_date: '2026-03-04', note_title: 'Org chart — 2026-03-04', created_at: '2026-10-14T09:00:00.000Z', updated_at: '2026-10-14T09:00:00.000Z' }),
    ),
    expected: { verdict: 'contradiction', survivor: 'a' },
  },
  {
    id: 'same-wording-different-projects',
    why: 'The same sentence about two projects is two facts (#352).',
    pair: pair(
      memory('The security questionnaire is due on October 30.', { note_date: '2026-10-15', note_title: 'Northwind pilot status — 2026-10-15', note_projects: ['Northwind Pilot'] }),
      memory('The security questionnaire is due on November 14.', { note_date: '2026-10-16', note_title: 'Contoso renewal sync — 2026-10-16', note_projects: ['Contoso Renewal'] }),
      0.06,
    ),
    expected: { verdict: 'distinct' },
  },
  {
    id: 'different-accounts-same-role',
    why: 'Two accounts with the same kind of contact are not one fact (#352).',
    pair: pair(
      memory('Dana Ruiz is the procurement contact at Acme.', { note_date: '2026-09-12', note_title: 'Acme kickoff — 2026-09-12', note_projects: ['Northwind Pilot'] }),
      memory('Marco Bellini is the procurement contact at Fabrikam.', { note_date: '2026-09-30', note_title: 'Fabrikam intro — 2026-09-30', note_projects: ['Fabrikam Expansion'] }),
    ),
    expected: { verdict: 'distinct' },
  },
  {
    id: 'general-and-specific',
    why: 'A general statement and a specific one can both be true.',
    pair: pair(
      memory('Avery prefers email over Slack for work requests.', { category: 'preference', note_date: '2026-06-02', note_title: 'Working notes — 2026-06-02' }),
      memory('Avery wants contract questions sent by email to the legal inbox.', { category: 'preference', note_date: '2026-08-19', note_title: 'Contract process — 2026-08-19' }),
    ),
    expected: { verdict: 'distinct' },
  },
  {
    id: 'same-day-not-a-contradiction',
    why: 'Two same-day notes that only look opposed are both true: a plan and its first step (#351).',
    pair: pair(
      memory('The Atlas launch moved to Q1 2027.', { note_date: '2026-10-20', note_title: 'Atlas planning — 2026-10-20' }),
      memory('The Atlas beta still ships in December 2026.', { note_date: '2026-10-20', note_title: 'Atlas standup — 2026-10-20' }),
    ),
    expected: { verdict: 'distinct' },
  },
  {
    id: 'topical-neighbours',
    why: 'Near in meaning, but independently useful facts.',
    pair: pair(
      memory('The home office uses a standing desk from Fully.', { note_date: '2025-11-03', note_title: 'Office setup' }),
      memory('The home office monitor is a 27-inch Dell.', { note_date: '2025-11-03', note_title: 'Office setup' }),
      0.18,
    ),
    expected: { verdict: 'distinct' },
  },
  {
    id: 'correction-in-conversation',
    why: 'A later correction from the owner replaces the earlier fact.',
    pair: pair(
      memory('Avery\'s dentist is Dr. Reyes at Lakeview Dental.', { note_date: '2024-05-10', note_title: 'Health contacts' }),
      memory('Avery switched dentists to Dr. Okafor at Riverside Dental in 2026.', { evidence_kind: 'conversation', source: 'chat', valid_at: '2026-09-01T00:00:00.000Z', note_date: null }),
    ),
    expected: { verdict: 'contradiction', survivor: 'b' },
  },
  {
    id: 'plain-duplicate',
    why: 'The same fact twice, worded alike.',
    pair: pair(
      memory('Rowan leads the data platform group from September 2026.', { note_date: '2026-07-03', note_title: '2026-07-03' }),
      memory('From September 2026 Rowan leads the data platform group.', { note_date: '2026-07-03', note_title: '2026-07-03' }),
      0.04,
    ),
    // Equally good wording: either may stay.
    expected: { verdict: 'duplicate' },
  },
];

/** Exact scoring: the verdict must match, and for a duplicate or contradiction so must the survivor.
 *  A duplicate's survivor is scored only where the fixture says which one must stay. */
export function scoreReconcile(
  fixtures: readonly ReconcileFixture[],
  verdicts: ReadonlyArray<{ verdict: string; survivorId?: number } | null>,
): { correct: number; total: number; mismatches: string[] } {
  const mismatches: string[] = [];
  let correct = 0;
  fixtures.forEach((f, i) => {
    const got = verdicts[i] ?? null;
    const survivor = f.expected.survivor === undefined ? undefined : f.pair[f.expected.survivor].id;
    const ok = got !== null && got.verdict === f.expected.verdict
      && (survivor === undefined || got.survivorId === survivor);
    if (ok) { correct += 1; return; }
    const want = `${f.expected.verdict}${survivor === undefined ? '' : ` (keep ${survivor})`}`;
    const have = got === null ? 'unparseable' : `${got.verdict}${got.survivorId === undefined ? '' : ` (keep ${got.survivorId})`}`;
    mismatches.push(`${f.id}: expected ${want}, got ${have} — ${f.why}`);
  });
  return { correct, total: fixtures.length, mismatches };
}
