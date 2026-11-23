import { currentDateLine } from './date-line.js';
import { HOME_SECTIONS_TOOL } from './prompts/page.js';
import { SPEC_A_SYSTEM_PROMPT } from './synthesize.js';
import { WIKI_WRITING_RULES } from './prompts/writing-rules.js';
import type { StructuredCallRequest } from './llm/types.js';
import type { HomeOverviewInput } from './page-synthesis.js';

/** One request factory for sizing and dispatch, with an optional frozen date. */
export function buildHomeRequest(input: HomeOverviewInput): StructuredCallRequest {
  return {
    ...(input.onPrepared ? { onPrepared: input.onPrepared, malformedOutputPolicy: 'fail-closed-redacted' as const } : {}),
    model: input.model,
    maxTokens: input.maxTokens ?? 4_000,
    system: `${input.system ?? SPEC_A_SYSTEM_PROMPT}\n\n${WIKI_WRITING_RULES}\n\n${currentDateLine(input.generatedAt, input.timeZone)}`,
    user: JSON.stringify({ evidence: input.evidence, accepted_page_index: input.pageIndex }),
    toolName: HOME_SECTIONS_TOOL.name,
    toolDescription: HOME_SECTIONS_TOOL.description,
    schema: HOME_SECTIONS_TOOL.schema,
  };
}
