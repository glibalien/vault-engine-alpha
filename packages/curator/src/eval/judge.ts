import type { LlmClient } from '../llm/types.js';
import type { JsonSchema } from '../llm/types.js';
import type { RunOutput } from './runner.js';

// ---------------------------------------------------------------------------
// Criteria + types
// ---------------------------------------------------------------------------

export const JUDGE_CRITERIA = [
  'succinct',
  'scannable',
  'standup_ready',
  'grounded',
  'not_stale',
] as const;

export type JudgeCriterion = (typeof JUDGE_CRITERIA)[number];

export interface JudgeVerdict {
  overall: 'A' | 'B' | 'tie';
  criteria: Record<JudgeCriterion, { winner: 'A' | 'B' | 'tie'; note: string }>;
}

export interface Scoreboard {
  wins: Record<string, number>;
  ties: number;
  pairs: number;
}

// ---------------------------------------------------------------------------
// Prompt + schema
// ---------------------------------------------------------------------------

export const JUDGE_SYSTEM =
  'You are an impartial evaluator comparing two AI-generated project-wiki home pages for the SAME project. ' +
  'Judge which better serves a glance-able daily standup. ' +
  'Rate each criterion A/B/tie: ' +
  'succinct (no padding/restated task lists), ' +
  'scannable (good use of callouts/tables/bullets, not a wall of text), ' +
  'standup_ready (at a glance: what changed, what\'s on deck, what\'s blocked), ' +
  'grounded (no invented certainty; claims supported), ' +
  'not_stale (does not re-raise items that are clearly resolved). ' +
  'Be impartial to length/order; do not favor A or B by position.';

const WINNER_ENUM = ['A', 'B', 'tie'];

const CRITERION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    winner: {
      type: 'string',
      enum: WINNER_ENUM,
      description: 'Which output wins this criterion, or tie.',
    },
    note: {
      type: 'string',
      description: 'Brief justification (one sentence or empty).',
    },
  },
  required: ['winner', 'note'],
};

const CRITERIA_PROPERTIES: Record<string, JsonSchema> = {};
for (const c of JUDGE_CRITERIA) {
  CRITERIA_PROPERTIES[c] = CRITERION_SCHEMA;
}

export const VERDICT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    overall: {
      type: 'string',
      enum: WINNER_ENUM,
      description: 'Overall winner across all criteria.',
    },
    criteria: {
      type: 'object',
      properties: CRITERIA_PROPERTIES,
      required: [...JUDGE_CRITERIA],
    },
  },
  required: ['overall', 'criteria'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidWinner(v: unknown): v is 'A' | 'B' | 'tie' {
  return v === 'A' || v === 'B' || v === 'tie';
}

function formatSections(output: RunOutput, label: 'A' | 'B'): string {
  const { sections } = output;
  const parts = [
    `## Output ${label}`,
    `### Now\n${sections.now}`,
    `### Focus\n${sections.focus}`,
    `### Open Threads\n${sections.open_threads}`,
  ];
  if (sections.at_a_glance) {
    parts.push(`### At a Glance\n${sections.at_a_glance}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Parse LLM output defensively
// ---------------------------------------------------------------------------

function parseVerdict(raw: unknown): JudgeVerdict {
  const defaultCriterion = (): { winner: 'A' | 'B' | 'tie'; note: string } => ({
    winner: 'tie',
    note: '',
  });

  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const overall = isValidWinner((obj as Record<string, unknown>)['overall'])
    ? ((obj as Record<string, unknown>)['overall'] as 'A' | 'B' | 'tie')
    : 'tie';

  const rawCriteria =
    (obj as Record<string, unknown>)['criteria'] !== null &&
    typeof (obj as Record<string, unknown>)['criteria'] === 'object'
      ? ((obj as Record<string, unknown>)['criteria'] as Record<string, unknown>)
      : {};

  const criteria = {} as Record<JudgeCriterion, { winner: 'A' | 'B' | 'tie'; note: string }>;

  for (const key of JUDGE_CRITERIA) {
    const raw = rawCriteria[key];
    if (raw !== null && typeof raw === 'object') {
      const entry = raw as Record<string, unknown>;
      const winner = isValidWinner(entry['winner']) ? entry['winner'] : 'tie';
      const note = typeof entry['note'] === 'string' ? entry['note'] : '';
      criteria[key] = { winner, note };
    } else {
      criteria[key] = defaultCriterion();
    }
  }

  return { overall, criteria };
}

/** Map a verdict's positional winner (A/B/tie) to the variant id that won, or 'tie'. */
export function normalizedWinner(aId: string, bId: string, verdict: JudgeVerdict): string {
  return verdict.overall === 'A' ? aId : verdict.overall === 'B' ? bId : 'tie';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function judgePair(
  llm: LlmClient,
  judgeModel: string,
  project: string,
  a: RunOutput,
  b: RunOutput,
): Promise<JudgeVerdict> {
  const user = [
    `Project: ${project}`,
    '',
    formatSections(a, 'A'),
    '',
    formatSections(b, 'B'),
    '',
    'Compare the two outputs above on each criterion and return your verdict.',
  ].join('\n');

  const { output } = await llm.structuredCall({
    model: judgeModel,
    maxTokens: 1200,
    system: JUDGE_SYSTEM,
    user,
    toolName: 'emit_verdict',
    toolDescription: 'Return the pairwise judgement.',
    schema: VERDICT_SCHEMA,
  });

  return parseVerdict(output);
}

export function aggregateVerdicts(
  verdicts: Array<{ aId: string; bId: string; verdict: JudgeVerdict }>,
): Scoreboard {
  const wins: Record<string, number> = {};
  let ties = 0;

  for (const { aId, bId, verdict } of verdicts) {
    if (verdict.overall === 'A') {
      wins[aId] = (wins[aId] ?? 0) + 1;
    } else if (verdict.overall === 'B') {
      wins[bId] = (wins[bId] ?? 0) + 1;
    } else {
      ties++;
    }
  }

  return { wins, ties, pairs: verdicts.length };
}
