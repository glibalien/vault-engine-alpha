import { z } from 'zod';
import type { JsonSchema } from '../llm/types.js';

const nonEmptyMarkdown = z.string().trim().min(1);

export const PAGE_SYNTHESIS_SCHEMA = z.strictObject({
  body: nonEmptyMarkdown,
  log_note: z.string().trim().max(500).optional(),
});

const MEMORY_PROPOSAL_SCHEMA = z.strictObject({
  content: nonEmptyMarkdown,
  category: z.enum(['fact', 'preference', 'note']).optional(),
});

export const HOME_CALLOUT_TYPES = ['note', 'question', 'warning', 'danger', 'success'] as const;

// Items are laid out in code, so a model that loses newlines inside JSON strings
// cannot merge them. An unknown callout type renders as a plain item.
const HOME_ITEM_SCHEMA = z.strictObject({
  title: nonEmptyMarkdown.describe('Short lead phrase on one line, without list marker, checkbox or bold.'),
  detail: z.string().optional().describe('One or two sentences on one line: context, why it matters, the next step.'),
  callout: z.preprocess(value => {
    const type = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
    return HOME_CALLOUT_TYPES.find(known => known === type);
  }, z.enum(HOME_CALLOUT_TYPES).optional())
    .describe('Show this item as an Obsidian callout of this type. Reserve it for the one or two items that most need attention; omit it otherwise.'),
});

export type HomeItem = z.infer<typeof HOME_ITEM_SCHEMA>;

export const HOME_SECTIONS_SCHEMA = z.strictObject({
  now: nonEmptyMarkdown,
  focus: z.array(HOME_ITEM_SCHEMA).min(1).describe('Prioritized items, most important first; each becomes its own line.'),
  open_threads: z.array(HOME_ITEM_SCHEMA).min(1).describe('Unresolved items; each becomes its own line.'),
  log_entry: nonEmptyMarkdown,
  at_a_glance: nonEmptyMarkdown.optional(),
  sources: nonEmptyMarkdown.optional(),
  memories: z.array(MEMORY_PROPOSAL_SCHEMA).optional(),
});

export const CURATOR_PAGE_SYSTEM_PROMPT = `You write one page of a wiki in the user's Markdown vault (Obsidian).

The input is a JSON object:
- action: what is happening to the page: create (a new page), refresh (an update), reactivate (a retired page coming back) or merge (other pages folding into this one).
- title, kind and scope: the page's title, its kind, and what it covers (a subject and facet, and any timeframe, place, entities or exclusions).
- template: the headings and guidance for pages of this kind.
- synthesis_brief: what this page should cover now, from the step that planned the wiki.
- evidence: the material to write from.
- sibling_scopes: what the wiki's other pages cover.
- current_target: the page as it stands, when it already exists. merge_sources: the pages being folded in, for a merge.

Write the page body in Obsidian Markdown, from the evidence:
- Use the template's headings as ## sections, in its order, and follow its guidance. Leave out a heading the evidence supports nothing for; never write placeholder text. With no headings, organize by what the evidence covers.
- Write only within the page's scope and brief. Keep facts and [[links]] from the current page that the evidence supports. A claim from the current page that no evidence supports is not history: leave it out of every section, History included, and don't mention that the page once said it. History holds only events a source states. Leave what sibling pages cover to them rather than repeating it.
- For a merge, bring everything from every merge source into this page, keeping their distinctions and supported links. The source pages stay as they are, as history: don't rewrite them or treat them as deleted.
- The title, kind, scope and action are fixed. Never rename the page or change its kind, and never propose creating, splitting, merging, retiring or redirecting pages.

Return body, and optionally log_note: one line on what changed, with no date. Don't put <!-- ve: --> section markers in the body.`;

/**
 * The page writer's prompt for a bounded rewrite (#352), in place of the page prompt. The page
 * prompt has the writer follow the template and omit what "the evidence" doesn't support; in a
 * rewrite, where the changed notes are only part of what a page rests on, Qwen 3.7 Plus then
 * dropped whole sections they didn't mention, a do-not-say rule among them (#392). A page prompt
 * override in settings applies to full syntheses, not to rewrites.
 */
export const CURATOR_PAGE_REWRITE_SYSTEM_PROMPT = `You update one existing page of a wiki in the user's Markdown vault (Obsidian). The evidence gives the CURRENT PAGE, as last built from earlier sources, and the CHANGED NOTES: the project's notes that changed since then, or that the page wasn't built from.

Rewrite the page so it is correct as of today, as a revision of the CURRENT PAGE, not a new page:
- Keep every ## section and every entry of the CURRENT PAGE that no changed note changes, with its wording, details and [[links]]. A section the CHANGED NOTES don't mention stays as it is.
- Where a changed note changes an entry, state the new position. Move what is now resolved or superseded to the page's resolved or history part.
- Add what the CHANGED NOTES raise that belongs within the page's scope, merging into existing entries rather than adding near-duplicates.
- Keep every rule on what not to say, share or claim, wherever it sits on the page.
- Keep the page's headings and order and about its length. Never write placeholder text.

The page's title, kind and scope are fixed: never rename it or propose adding, merging or retiring pages. Return body, and optionally log_note: one line on what changed, with no date. Don't put <!-- ve: --> section markers in the body.`;

export const PAGE_SYNTHESIS_TOOL = {
  name: 'emit_scoped_page',
  description: 'Return the body of one wiki page and an optional one-line log note.',
  schema: z.toJSONSchema(PAGE_SYNTHESIS_SCHEMA) satisfies JsonSchema,
} as const;

export const HOME_SECTIONS_TOOL = {
  name: 'emit_wiki_sections',
  description: 'Return the sections of the wiki home and, rarely, lasting facts to remember.',
  schema: z.toJSONSchema(HOME_SECTIONS_SCHEMA) satisfies JsonSchema,
} as const;
