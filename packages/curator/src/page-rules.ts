import { z } from 'zod';
import type { JsonSchema, LlmClient } from './llm/types.js';
import type { Memory, TokenUsage } from './types.js';

/**
 * Rules on what a project wiki page may say (#474 idea 4). The planner marks which memories are
 * rules for each page (naming, messaging, dates not to give, material to keep internal). Code
 * writes them onto the page under a fixed heading, so a rewrite can't drop them, as rewrites did
 * in #389 and #392. A check after writing makes sure the page's own text doesn't break them.
 *
 * Each rule line ends with a hidden marker naming its memory, so the next build keeps the rule
 * while its memory is still one the build sees, even when the planner doesn't mark it again.
 */

export const RULES_HEADING = 'Rules on what to say';

const MARKER = /<!--\s*memory:(\d+)\s*-->/g;
const SECTION = new RegExp(`^## ${RULES_HEADING}[ \\t]*\\r?\\n[\\s\\S]*?(?=^#{1,2} |(?![\\s\\S]))`, 'm');

/** The page without its rules section; a writer never sees or writes it. */
export function withoutRulesSection(body: string): string {
  return body.replace(SECTION, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** The page's rules section as written, or null when it has none. */
export function rulesSectionText(body: string): string | null {
  return SECTION.exec(body)?.[0].trim() ?? null;
}

/**
 * The rules sections of several pages as one, each line once: what a build carries over when it
 * can't read its memories, for a page and the pages merged into it.
 */
export function carriedRulesSection(bodies: readonly string[]): string | null {
  const seen = new Set<string>();
  const lines = bodies.flatMap(body => (SECTION.exec(body)?.[0] ?? '').split('\n').slice(1).filter(line => line.startsWith('- ')))
    .filter(line => {
      const key = /<!--\s*memory:(\d+)\s*-->/.exec(line)?.[1] ?? line;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return lines.length > 0 ? `## ${RULES_HEADING}\n\n${lines.join('\n')}` : null;
}

/** The memory ids in the page's rules section, in order. */
export function rulesInSection(body: string): number[] {
  const section = SECTION.exec(body)?.[0] ?? '';
  return [...new Set([...section.matchAll(MARKER)].map(match => Number(match[1])))];
}

/**
 * A page's rules for this build: the ones already on it whose memories the build still sees, then
 * the ones the planner marked. A memory the build doesn't see (expired, or no longer about the
 * project) drops its rule.
 */
export function pageRules(marked: readonly number[] | undefined, currentBody: string | null | undefined,
  memories: readonly Memory[]): Memory[] {
  const byId = new Map(memories.map(memory => [memory.id, memory]));
  const ids = [...new Set([...rulesInSection(currentBody ?? ''), ...(marked ?? [])])];
  return ids.flatMap(id => byId.get(id) ?? []);
}

function ruleText(memory: Memory): string {
  // One line each; a literal dollar sign would render as math (writing rule 12).
  return memory.content.replace(/\s+/g, ' ').trim().replace(/(?<!\\)\$/g, '\\$');
}

/** The page with its rules written under the fixed heading, after everything the writer wrote. */
export function withRulesSection(body: string, rules: readonly Memory[]): string {
  const page = withoutRulesSection(body);
  if (rules.length === 0) return page;
  const lines = rules.map(rule => `- ${ruleText(rule)} <!-- memory:${rule.id} -->`);
  return `${page}\n\n## ${RULES_HEADING}\n\n${lines.join('\n')}`;
}

/** The rules block in a page writer's evidence. */
export function renderPageRules(rules: readonly Memory[]): string[] {
  if (rules.length === 0) return [];
  return [`## RULES FOR THIS PAGE (code adds them to the end of the page under "${RULES_HEADING}"; don't write that section yourself, and don't break any of them anywhere on the page)`,
    ...rules.map(rule => `- ${rule.content.replace(/\s+/g, ' ').trim()}`)];
}

export const RULE_CHECK_SYSTEM_PROMPT = `You check one wiki page against rules on what it may say. The rules come from the owner's notes: naming, messaging, dates not to give, material to keep internal, claims not to make.

A page breaks a rule when it says what the rule forbids: it uses a name or wording the rule says not to use, gives a date or detail the rule says not to give, or makes a claim the rule says not to make. Rules about what to tell clients or other outsiders are broken only by text meant for them, such as talking points, messaging or anything written to be shared; an internal record of a fact doesn't break them. A page that only states a rule, or doesn't touch it, doesn't break it.

The page's log_note, when given, is published with it and is checked the same way.

Return only the rules the page breaks, by number, each with the page's words that break it, quoted exactly. Return an empty list when it breaks none.`;

const RULE_CHECK_SCHEMA = z.object({
  broken: z.array(z.object({ rule: z.number().int(), words: z.string().optional() })),
});

const RULE_CHECK_TOOL = {
  name: 'emit_rule_check',
  description: 'Return the rules the page breaks, by number, with the words that break each.',
  schema: z.toJSONSchema(RULE_CHECK_SCHEMA) satisfies JsonSchema,
};

export type RuleBreak = { readonly rule: Memory; readonly words: string };

/**
 * One call on the page model: which of the page's rules its text breaks. Output that doesn't
 * parse counts as no ruling, so the page stands (logged); a failed call throws like a page call.
 */
export async function checkPageRules(llm: LlmClient, input: {
  readonly model: string; readonly maxTokens: number; readonly body: string; readonly rules: readonly Memory[];
  /** The page's new Log line, which is published with it. */
  readonly logNote?: string;
}): Promise<{ readonly broken: readonly RuleBreak[]; readonly usage: TokenUsage }> {
  const { output, usage } = await llm.structuredCall({
    model: input.model,
    maxTokens: input.maxTokens,
    system: RULE_CHECK_SYSTEM_PROMPT,
    user: JSON.stringify({
      rules: input.rules.map((rule, index) => `${index + 1}. ${rule.content.replace(/\s+/g, ' ').trim()}`),
      page: withoutRulesSection(input.body),
      ...(input.logNote ? { log_note: input.logNote } : {}),
    }),
    toolName: RULE_CHECK_TOOL.name,
    toolDescription: RULE_CHECK_TOOL.description,
    schema: RULE_CHECK_TOOL.schema,
  });
  const parsed = RULE_CHECK_SCHEMA.safeParse(output);
  if (!parsed.success) {
    console.warn('[curator] rule check gave no ruling; the page stands');
    return { broken: [], usage };
  }
  const broken = parsed.data.broken.flatMap(entry => {
    const rule = input.rules[entry.rule - 1];
    return rule ? [{ rule, words: entry.words?.trim() ?? '' }] : [];
  });
  return { broken: [...new Map(broken.map(entry => [entry.rule.id, entry])).values()], usage };
}

/** What a retry's writer is told about its last draft. */
export function ruleBreakFeedback(broken: readonly RuleBreak[]): string {
  const lines = broken.map(entry => `- Rule: ${entry.rule.content.replace(/\s+/g, ' ').trim()}${entry.words ? ` Your words: "${entry.words}"` : ''}`);
  return `A check found that your last draft of this page broke these rules on what to say. Write the page again so it breaks none of them.\n${lines.join('\n')}`;
}

/** Thrown when a page still breaks a rule after its one retry. */
export class PageRuleError extends Error {
  override readonly name = 'PageRuleError';
  constructor(readonly broken: readonly RuleBreak[]) {
    super(`breaks a rule on what to say: ${broken.map(entry => `memory ${entry.rule.id}${entry.words ? ` ("${entry.words.slice(0, 80)}")` : ''}`).join('; ')}`);
  }
}
