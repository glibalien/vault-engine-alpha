/**
 * Evidence rules every wiki page and home writer follows, distilled from failures
 * observed in real wikis (see the golden cases in src/eval/wiki-golden-cases.ts).
 * Appended in code, so prompt overrides in settings still get them.
 */
export const WIKI_WRITING_RULES = `Evidence rules:
1. State current facts from the newest dated evidence. When sources conflict, give the newer dated statement and keep the older one only as dated history.
2. A report's date is when it was written, not when its events happened; use the event dates the source gives.
3. Keep proposed, agreed and completed apart: a proposed or requested meeting is not booked or confirmed unless a source says so.
4. A task marked done means the task was closed; do not claim delivery, receipt or acceptance unless a source says so.
5. The live task sections already list tasks, counts and statuses; do not restate them. Mention a task only to explain why it matters.
6. A task's status field outranks older wording in its body.
7. Existing wiki text, page scopes and memories are context, not evidence; keep a claim from them only when a supplied source supports it.
8. Never call a subject quiet or without recent activity when any source reports newer activity.
9. Superseded plans, scopes, risks and timelines are history; never present them as current.
10. Never invent specifics (names, dates, amounts, documents or tools) that no source states.
11. Link only to notes named in the evidence, using their exact titles.
12. Escape literal dollar signs as \\$ so amounts are not rendered as math.`;

/**
 * The rules for a bounded rewrite (#352): an existing page updated from its current text plus
 * only the notes that changed since it was last built. Rule 7 changes because the current page
 * is the evidence for what it already says: under the base rule, a rewrite dropped whole
 * sections, a do-not-say rule among them, that the new evidence didn't mention (#392). Rule 11
 * lets the page keep its own links.
 */
export const WIKI_REWRITE_RULES = WIKI_WRITING_RULES
  .replace(
    '7. Existing wiki text, page scopes and memories are context, not evidence; keep a claim from them only when a supplied source supports it.',
    '7. This is an update of the current page (current_target), written from earlier sources. The current page is the evidence for what it already says: keep each of its sections and entries that no changed note changes, even when no changed note mentions it, and never drop a section because the CHANGED NOTES say nothing about it. The CHANGED NOTES are the sources for every change. Page scopes and memories are context, not evidence; keep a claim from them only when a note supports it.',
  )
  .replace(
    '11. Link only to notes named in the evidence, using their exact titles.',
    '11. Link only to notes named in the evidence, this wiki\'s pages, and notes the current page already links, using their exact titles.',
  )
  .replace(
    '12. Escape literal dollar signs',
    '12. Rewrite the current page as a whole, keeping its headings and about its length. Where a changed note changes a claim (a newer status, a resolved risk, a new date or owner), state the new position: the newest source wins. Move what is now resolved or superseded to the page\'s history or resolved part. Add what the changed notes raise within the page\'s scope, merging into existing entries rather than adding near-duplicates. Keep every rule on what not to say, share or claim. If no changed note concerns the page, return it unchanged.\n'
      + '13. Escape literal dollar signs',
  );
