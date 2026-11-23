import type { LlmClient, JsonSchema } from '../llm/types.js';

/** A synthetic note with planted durable facts (expected) and planted ephemera
 *  (implicit — anything extracted that the judge doesn't match to expected and
 *  deems non-durable is a violation). */
export interface ExtractionFixture {
  title: string;
  file_path: string;
  body: string;
  /** Durable facts a good extraction should surface (semantic match, judged). */
  expected: string[];
  /** How many of `expected` are rules on what may be said, shared or claimed, which the
   *  extraction should label `rule` (#626). Absent: none, so any `rule` label is a miss. */
  rules?: number;
  /** The subjects the facts should name between them, by full name (#554): checked by name, not
   *  judged. Absent: none expected. */
  subjects?: string[];
}

/** The owner the extraction eval names to the model: the fixtures' "Avery" (never a subject). */
export const EVAL_OWNER = 'Avery';

/**
 * How the facts' subjects compare with a fixture's (#554), by name, case aside: the expected ones
 * named, the owner named (never wanted), and first names given alone where a full name was expected.
 */
export function subjectCheck(expected: readonly string[], named: readonly string[], owner: string | null): {
  found: number; expected: number; owner: number; firstNameOnly: string[];
} {
  const lower = named.map(name => name.toLowerCase());
  const found = expected.filter(name => lower.includes(name.toLowerCase())).length;
  const firstNameOnly = expected
    .filter(name => name.includes(' ') && !lower.includes(name.toLowerCase()) && lower.includes(name.split(' ')[0]!.toLowerCase()))
    .map(name => name.split(' ')[0]!);
  const ownerKey = owner?.toLowerCase();
  return { found, expected: expected.length, owner: ownerKey ? lower.filter(name => name === ownerKey || name.startsWith(`${ownerKey} `)).length : 0, firstNameOnly };
}

export interface JudgeVerdict {
  /** Expected facts the extraction covered (verbatim entries from `expected`). */
  found: string[];
  /** Extracted strings that are ephemera / summaries / not durable. */
  violations: string[];
}

export interface ExtractionScore {
  title: string;
  extracted: string[];
  verdict: JudgeVerdict;
  /** found / expected; 1 when nothing was expected. */
  coverage: number;
  /** 1 - violations/extracted; 1 when nothing was extracted. */
  precision: number;
}

export const JUDGE_SYSTEM_PROMPT = `You judge a memory-extraction run. You get a note's EXPECTED durable facts and the EXTRACTED facts an AI produced from that note.

Report:
- found: which EXPECTED entries the extraction covered (semantic match counts; return the EXPECTED entry verbatim).
- violations: which EXTRACTED entries are bad memories — ephemera (one-off logistics, past appointments, transient status), summaries/restatements of the note, or facts not standalone enough to make sense without the note.

An extracted fact that matches an expected one is never a violation. Be strict about durability: when unsure whether something will matter months from now, call it a violation.`;

export const JUDGE_TOOL: { name: string; description: string; schema: JsonSchema } = {
  name: 'judge_extraction',
  description: 'Report which expected facts were found and which extracted facts are violations.',
  schema: {
    type: 'object',
    properties: {
      found: { type: 'array', description: 'Expected entries covered by the extraction, verbatim.', items: { type: 'string' } },
      violations: { type: 'array', description: 'Extracted entries that are ephemera, summaries, or not durable.', items: { type: 'string' } },
    },
    required: ['found', 'violations'],
  },
};

export function parseJudgeVerdict(output: unknown): JudgeVerdict {
  const o = (output ?? {}) as Record<string, unknown>;
  const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return { found: strings(o.found), violations: strings(o.violations) };
}

export function computeScore(
  fixture: Pick<ExtractionFixture, 'title' | 'expected'>,
  extracted: string[],
  verdict: JudgeVerdict,
): ExtractionScore {
  const coverage = fixture.expected.length === 0 ? 1 : verdict.found.length / fixture.expected.length;
  const precision = extracted.length === 0 ? 1 : 1 - verdict.violations.length / extracted.length;
  return { title: fixture.title, extracted, verdict, coverage, precision };
}

/** One live judge call for one fixture's extraction. */
export async function judgeExtraction(
  llm: LlmClient,
  model: string,
  fixture: Pick<ExtractionFixture, 'title' | 'expected'>,
  extracted: string[],
): Promise<ExtractionScore> {
  const { output } = await llm.structuredCall({
    model,
    // Reasoning models spend thinking tokens before the tool call — 800 truncated
    // qwen-as-judge under reasoningEffort=high. The cap costs nothing unless generated.
    maxTokens: 4000,
    system: JUDGE_SYSTEM_PROMPT,
    user: `EXPECTED:\n${fixture.expected.map(e => `- ${e}`).join('\n') || '(none — a good extraction emits nothing)'}\n\nEXTRACTED:\n${extracted.map(e => `- ${e}`).join('\n') || '(nothing extracted)'}`,
    toolName: JUDGE_TOOL.name,
    toolDescription: JUDGE_TOOL.description,
    schema: JUDGE_TOOL.schema,
  });
  return computeScore(fixture, extracted, parseJudgeVerdict(output));
}

/** The conversation eval's judge (#605). A chat fixture's EXPECTED list is complete: it holds every
 *  fact the user asserted or endorsed that a sweep should keep. So every EXTRACTED entry that matches
 *  no EXPECTED entry is a violation, durable or not: a fact the assistant retrieved, reasoned or
 *  proposed must not be kept, and the judge never sees the chat to tell otherwise. */
export const CONVERSATION_JUDGE_SYSTEM_PROMPT = `You judge a memory-extraction run over a finished chat. You get the chat's EXPECTED facts, the complete list of facts worth keeping from it, and the EXTRACTED facts an AI kept.

Report:
- found: which EXPECTED entries the extraction covered (semantic match counts; return the EXPECTED entry verbatim).
- violations: every EXTRACTED entry that matches no EXPECTED entry. An extracted entry that states part of an expected entry, or the same fact in other words, matches it. Anything else is a violation, however durable or true it looks: the expected list is complete.`;

/** One live judge call for one chat fixture's kept facts, against its complete expected list. */
export async function judgeConversation(
  llm: LlmClient,
  model: string,
  fixture: Pick<ExtractionFixture, 'title' | 'expected'>,
  extracted: string[],
): Promise<ExtractionScore> {
  const { output } = await llm.structuredCall({
    model,
    maxTokens: 4000,
    system: CONVERSATION_JUDGE_SYSTEM_PROMPT,
    user: `EXPECTED (complete):\n${fixture.expected.map(e => `- ${e}`).join('\n') || '(none — nothing in this chat should be kept)'}\n\nEXTRACTED:\n${extracted.map(e => `- ${e}`).join('\n') || '(nothing extracted)'}`,
    toolName: JUDGE_TOOL.name,
    toolDescription: JUDGE_TOOL.description,
    schema: JUDGE_TOOL.schema,
  });
  return computeScore(fixture, extracted, parseJudgeVerdict(output));
}
