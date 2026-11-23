import { z } from 'zod';
import { currentDateLine } from '../date-line.js';
import type { JsonSchema, StructuredCallRequest } from '../llm/types.js';
import { builtInDossierSections, type DossierSectionSpec } from '../dossier/sections.js';

/**
 * The dossier prompt (#554): one page about one person or company, written as cited lines. The
 * model writes only the facts and what each rests on; code adds each line's date, its source link
 * and its memory marker, drops a line that cites nothing the build knows, writes "Last contact"
 * from the meetings and lists the rules under their fixed heading (`src/dossier/page.ts`).
 */

/** What code decides by: "Last contact" (who attended) and who is at the subject. Any kind that isn't
 *  the vault's person kind is read as a company there. */
export type DossierKind = 'person' | 'company';

/** The sections the model fills, in page order, and what the prompt calls the subject (#716: from the
 *  `dossierSections` setting, `src/dossier/sections.ts`). "Last contact" and the rules are code's. */
export interface DossierShape {
  readonly noun: string;
  readonly sections: readonly DossierSectionSpec[];
}

/** The built-in shape of a person's or a company's dossier. */
export function builtInDossierShape(kind: DossierKind): DossierShape {
  return { noun: kind, sections: builtInDossierSections(kind) };
}

/** One line as the model returns it, before code checks its citations. */
export interface DossierLineOutput {
  readonly section: string;
  readonly text: string;
  readonly memory_ids: readonly number[];
  readonly note_ids: readonly string[];
  /** The day a cited note gives for the fact (YYYY-MM-DD). Code keeps it only when that note holds it. */
  readonly day?: string;
}

/** The schema the model is shown. Kept compact: it runs on the wiki home model. */
export function dossierSchema(sections: readonly DossierSectionSpec[]): JsonSchema {
  const names = sections.map(section => section.name);
  if (names.length === 0) throw new Error('A dossier needs at least one section.');
  return z.toJSONSchema(z.strictObject({
    lines: z.array(z.strictObject({
      section: z.enum(names as [string, ...string[]]),
      text: z.string().describe('One fact, one sentence, on one line: no list marker, no date, no source.'),
      memory_ids: z.array(z.number().int()).optional().describe('The memories the line rests on: the number after "m".'),
      note_ids: z.array(z.string()).optional().describe('The notes the line rests on: their "n" refs, such as "n3".'),
      day: z.string().optional().describe('The day of this fact as a note you cite writes it out in full, YYYY-MM-DD. Leave it out when no cited note does.'),
    })),
  })) satisfies JsonSchema;
}

export function dossierSystemPrompt(shape: DossierShape, owner: string | null): string {
  const subject = shape.noun;
  const guide = shape.sections.map(section => `- ${section.name}: ${section.guide}`).join('\n');
  const openItems = shape.sections.find(section => section.name.toLowerCase() === 'open items')?.name;
  const history = shape.sections.find(section => section.name.toLowerCase() === 'history')?.name;
  // Past facts (#717) are History only; a list without History leaves them out.
  const pastRule = history
    ? `13. Each PAST FACT was contradicted by the newer memory shown under it. Write one only in ${history}, as what used to be ("Worked at Northwind as an account lead"), and only when that newer memory says the fact changed: a new role, employer, owner, plan or status. Leave it out when the newer memory says the older one was wrong (a corrected name, relation, number or detail): it was never true. Never write a past fact in another section; cite it, and code adds its days.`
    : '13. Leave out the PAST FACTS: they are no longer true, and this page has no section for what used to be.';
  const ownerRule = owner
    ? `The vault owner, ${owner}, reads this page and is never its subject. Call them "you", never by name or in the third person.`
    : 'The vault owner reads this page and is never its subject.';
  return `You write a dossier: one page in the user's Markdown vault (Obsidian) about one ${subject}, built from what the vault knows about them.

The input is a JSON object whose evidence holds the material: the ${subject}'s own note, the memories about them (each "[m<number>]", with the day it became true and where it came from), the meetings, notes and tasks that link to them (each "[n<number>]"; the newest meetings and notes also with their text), and the people and companies connected to them.

Return lines, each one fact in one of these sections:
${guide}

Rules:
1. Every line cites what it rests on, in memory_ids and note_ids. A line that cites nothing is dropped.
2. The memories are live facts. Where two disagree, state the newer one; keep the older only as a History line when it is an event.
3. One fact per line, one sentence, on one line. Don't add a list marker, a date or a source to the text: code adds where the fact came from, and the day it became true from the memories you cite.
4. A line that rests on notes and no memory: when a note you cite writes out the day of the fact as YYYY-MM-DD (for example a dated entry in the subject's own note), put that day in day. Never guess or work one out; a day the cited notes don't hold is dropped.
5. ${ownerRule}
6. Follow every rule on what may or may not be said, everywhere. Code lists the rules on the page; don't write them as lines.
7. The page's task list is added by the vault. Mention a task${openItems ? ` in ${openItems}` : ''} only to say why it matters.
8. Code adds when you last met them. Don't write a line about the last meeting for that.
9. Never invent specifics (names, dates, amounts, documents) that no memory or note states.
10. Link only people, companies and notes named in the evidence, by their exact titles, as [[Title]].
11. Escape literal dollar signs as \\$ so amounts are not rendered as math.
12. Leave a section with nothing to say empty. Never write placeholder text.
${pastRule}`;
}

export const DOSSIER_TOOL = {
  name: 'emit_dossier_lines',
  description: 'Return the dossier as cited lines, each in one section.',
} as const;

/** One request factory for sizing, the free preview and dispatch, so the three are the same bytes. */
export function buildDossierRequest(input: {
  readonly shape: DossierShape;
  readonly owner: string | null;
  readonly evidence: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly generatedAt: Date;
  readonly timeZone?: string;
}): StructuredCallRequest {
  return {
    model: input.model,
    maxTokens: input.maxTokens,
    system: `${dossierSystemPrompt(input.shape, input.owner)}\n\n${currentDateLine(input.generatedAt, input.timeZone)}`,
    // Engine's home capture decodes this message as {evidence, accepted_page_index}; a dossier has no pages.
    user: JSON.stringify({ evidence: input.evidence, accepted_page_index: [] }),
    toolName: DOSSIER_TOOL.name,
    toolDescription: DOSSIER_TOOL.description,
    schema: dossierSchema(input.shape.sections),
    malformedOutputPolicy: 'fail-closed-redacted',
  };
}

/** A real calendar day written YYYY-MM-DD ("2026-02-30" is not one). */
export function isCalendarDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * The model's lines, read leniently: on the OpenAI-compatible path the schema only advises, so a
 * line in an unknown section, with no text, or with ids of the wrong shape is kept as far as it
 * can be read and checked by code. Returns null when the output holds no lines array at all.
 */
const unbracketed = (id: string): string => id.trim().replace(/^\[\s*/, '').replace(/\s*\]$/, '').trim();

export function parseDossierLines(output: unknown): DossierLineOutput[] | null {
  if (output === null || typeof output !== 'object' || !Array.isArray((output as { lines?: unknown }).lines)) return null;
  return ((output as { lines: unknown[] }).lines).flatMap((raw): DossierLineOutput[] => {
    if (raw === null || typeof raw !== 'object') return [];
    const line = raw as Record<string, unknown>;
    const ids = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    const day = typeof line.day === 'string' ? line.day.trim() : '';
    return [{
      section: typeof line.section === 'string' ? line.section.trim() : '',
      text: typeof line.text === 'string' ? line.text : '',
      // A ref may come back as the evidence writes it, in brackets: "[m12]", "[n3]".
      memory_ids: ids(line.memory_ids).flatMap(id => {
        const n = typeof id === 'number' ? id : typeof id === 'string' ? Number(unbracketed(id).replace(/^m/i, '')) : NaN;
        return Number.isSafeInteger(n) && n > 0 ? [n] : [];
      }),
      note_ids: ids(line.note_ids).flatMap(id => typeof id === 'string' && unbracketed(id) !== '' ? [unbracketed(id).toLowerCase()] : []),
      ...(isCalendarDay(day) ? { day } : {}),
    }];
  });
}
