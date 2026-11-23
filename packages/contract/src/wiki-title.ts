/**
 * The rule for a new wiki page's title, shared by the Engine, which enforces it when a wiki is
 * reconciled, and the Curator, which checks a planned title before it pays for any page (#557).
 */

/** The characters a new wiki page title can't contain, as a planner prompt can list them. */
export const WIKI_TITLE_FORBIDDEN_CHARACTERS = '( ) [ ] | # ^ / \\ : * ? " < >';

// The listed characters, plus control characters.
const FORBIDDEN = /[\u0000-\u001f()[\]|#^/\\:*?"<>]/u;
const FORBIDDEN_ALL = /[\u0000-\u001f()[\]|#^/\\:*?"<>]/gu;

/**
 * Whether `title` can name a new wiki page: trimmed, not empty, not `.` or `..`, and free of
 * WIKI_TITLE_FORBIDDEN_CHARACTERS and control characters.
 */
export function isValidWikiPageTitle(title: string): boolean {
  return title === title.trim() && title !== '' && title !== '.' && title !== '..' && !FORBIDDEN.test(title);
}

/** The key two wiki page titles collide on: Unicode NFC, then lower case. */
export function wikiTitleKey(title: string): string {
  return title.normalize('NFC').toLowerCase();
}

/**
 * The prefix a wiki's page titles start with, "<root> — ", built from the root's title with each
 * forbidden character turned into a space and the spaces collapsed, so a root such as
 * "Acme (Pilot)" still gives its pages valid titles ("Acme Pilot — Risks"). Empty when nothing of
 * the root title is left.
 */
export function wikiPageTitlePrefix(rootTitle: string): string {
  const safe = rootTitle.replace(FORBIDDEN_ALL, ' ').replace(/\s+/gu, ' ').trim();
  return safe === '' || safe === '.' || safe === '..' ? '' : `${safe} — `;
}
