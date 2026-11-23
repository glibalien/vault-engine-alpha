import type { ConsolidationInput, ConsolidationOp, ConsolidationVerdict, MemoryCandidate, MemoryNoteContext } from '../mcp/tools/memory-consolidation.js';

/** One memory-merge decision with the answer a good consolidator gives (#605): the operation and,
 *  for noop / update / contradict, which candidate it targets. Names are made up; the shapes come
 *  from real bugs (#349, #352). Used by `npm run eval:consolidation`. */
export interface ConsolidationEvalCase {
  id: string;
  /** What the case guards against. */
  why: string;
  input: ConsolidationInput;
  expected: { operation: ConsolidationOp; targetId?: number };
}

let nextId = 500;
function candidate(content: string, note: MemoryNoteContext | null = null, extra: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return { id: nextId++, content, category: 'fact', valid_at: null, distance: 0.1, note, ...extra };
}
const note = (title: string, date: string | null, projects: string[] = []): MemoryNoteContext => ({ title, date, projects });

const contractor = candidate('The garage renovation contractor is Hillside Builds.', note('Kickoff — garage renovation', '2026-07-01'));
const richScope = candidate('Northwind\'s pilot uses anonymized sandbox data only; Outlook integration is out of scope.',
  note('Scope decision — 2026-09-25', '2026-09-25', ['Northwind Pilot']));
const payments = candidate('Priya Raman leads the payments team.', note('Org chart — 2026-03-04', '2026-03-04'));
const emailPref = candidate('Avery prefers email over Slack for work requests.', note('Working notes — 2026-06-02', '2026-06-02'), { category: 'preference' });
const northwindDue = candidate('The security questionnaire is due on October 30.', note('Northwind pilot status — 2026-10-15', '2026-10-15', ['Northwind Pilot']));
const atlasLaunch = candidate('The Atlas launch moved to Q1 2027.', note('Atlas planning — 2026-10-20', '2026-10-20', ['Atlas']));
const rowan = candidate('Rowan leads the data platform group from September 2026.', note('2026-07-03', '2026-07-03'));
const desk = candidate('The home office uses a standing desk from Fully.', note('Office setup', '2025-11-03'));

export const CONSOLIDATION_EVAL_CASES: ConsolidationEvalCase[] = [
  {
    id: 'noop-reworded-duplicate',
    why: 'The same fact, reworded, adds nothing.',
    input: { content: 'Hillside Builds is the contractor for the garage renovation.', category: 'fact',
      note: note('Garage renovation — invoice', '2026-08-12'), candidates: [contractor] },
    expected: { operation: 'noop', targetId: contractor.id },
  },
  {
    id: 'update-superset',
    why: 'A new memory that says everything the old one does and more replaces it without loss.',
    input: { content: 'The garage renovation contractor is Hillside Builds; the project lead there is Dana Okafor.', category: 'fact',
      note: note('Garage renovation — site visit', '2026-07-15'), candidates: [contractor] },
    expected: { operation: 'update', targetId: contractor.id },
  },
  {
    id: 'noop-narrower-than-candidate',
    why: 'A narrower new memory is already covered: noop, and never an update that replaces the richer one (#349: update replaced richer memories with narrower ones).',
    input: { content: 'Northwind\'s pilot uses sandbox data.', category: 'fact',
      note: note('Pilot prep — 2026-10-01', '2026-10-01', ['Northwind Pilot']), candidates: [richScope] },
    expected: { operation: 'noop', targetId: richScope.id },
  },
  {
    id: 'contradict-changed-role',
    why: 'A newer note that changes a fact supersedes the old memory.',
    input: { content: 'Priya Raman leads the data platform team; she moved from payments in October 2026.', category: 'fact',
      note: note('Team update — 2026-10-12', '2026-10-12'), candidates: [payments] },
    expected: { operation: 'contradict', targetId: payments.id },
  },
  {
    id: 'add-general-and-specific',
    why: 'A specific preference beside a general one: both are true.',
    input: { content: 'Avery wants contract questions sent by email to the legal inbox.', category: 'preference',
      note: note('Contract process — 2026-08-19', '2026-08-19'), candidates: [emailPref] },
    expected: { operation: 'add' },
  },
  {
    id: 'add-same-wording-other-project',
    why: 'The same sentence from another project\'s note is a different fact (#352).',
    input: { content: 'The security questionnaire is due on November 14.', category: 'fact',
      note: note('Contoso renewal sync — 2026-10-16', '2026-10-16', ['Contoso Renewal']), candidates: [northwindDue] },
    expected: { operation: 'add' },
  },
  {
    id: 'add-another-aspect',
    why: 'Another aspect of the same subject, not a change: both stay.',
    input: { content: 'The Atlas beta still ships in December 2026.', category: 'fact',
      note: note('Atlas standup — 2026-10-20', '2026-10-20', ['Atlas']), candidates: [atlasLaunch] },
    expected: { operation: 'add' },
  },
  {
    id: 'noop-picks-the-matching-candidate',
    why: 'Among several candidates, a duplicate targets the one it repeats.',
    input: { content: 'From September 2026 Rowan leads the data platform group.', category: 'fact',
      note: note('2026-07-05', '2026-07-05'), candidates: [desk, rowan] },
    expected: { operation: 'noop', targetId: rowan.id },
  },
];

/** Exact scoring: the operation must match, and so must the target where one is expected.
 *  `null` is a call that failed or answered nothing usable. */
export function scoreConsolidation(
  cases: readonly ConsolidationEvalCase[],
  verdicts: ReadonlyArray<Pick<ConsolidationVerdict, 'operation' | 'target_id'> | null>,
): { correct: number; total: number; mismatches: string[] } {
  const mismatches: string[] = [];
  let correct = 0;
  cases.forEach((c, i) => {
    const got = verdicts[i] ?? null;
    const ok = got !== null && got.operation === c.expected.operation
      && (c.expected.targetId === undefined || got.target_id === c.expected.targetId);
    if (ok) { correct += 1; return; }
    const want = `${c.expected.operation}${c.expected.targetId === undefined ? '' : ` ${c.expected.targetId}`}`;
    const have = got === null ? 'no usable answer' : `${got.operation}${got.target_id === undefined ? '' : ` ${got.target_id}`}`;
    mismatches.push(`${c.id}: expected ${want}, got ${have} — ${c.why}`);
  });
  return { correct, total: cases.length, mismatches };
}
