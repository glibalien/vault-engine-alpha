/** Reserved control syntax, including in code examples: escape it when quoting it. */
export const WIKI_SECTION_PREFIX = /<!--\s*\/?ve:(?:managed|live):/;

export class WikiSectionError extends Error {
  override readonly name = 'WikiSectionError';

  constructor(detail: string) {
    super(`Invalid wiki section: ${detail}. Repair the page before refreshing it.`);
  }
}

export function assertWikiSectionContent(name: string, content: string): void {
  if (!name.trim() || name !== name.trim() || /[<>\r\n]/.test(name)) throw new WikiSectionError('invalid section name');
  if (WIKI_SECTION_PREFIX.test(content)) throw new WikiSectionError('content contains reserved section markers');
}

/** Reject ambiguous ownership before any replacement, including duplicate pairs. */
export function assertWikiSectionStructure(body: string): void {
  const seen = new Set<string>();
  let open: string | undefined;
  let cursor = 0;
  for (const match of body.matchAll(/<!--\s*(\/?)ve:(managed|live):([^<>\r\n]+?)\s*-->/g)) {
    if (WIKI_SECTION_PREFIX.test(body.slice(cursor, match.index))) throw new WikiSectionError('malformed marker');
    const key = `${match[2]}:${match[3]!.trim()}`;
    if (!match[3]!.trim()) throw new WikiSectionError('empty marker name');
    if (match[3] !== match[3]!.trimStart()) throw new WikiSectionError('padded marker name');
    if (match[1] === '/') {
      if (open !== key) throw new WikiSectionError('unmatched closing marker');
      open = undefined;
    } else {
      if (open !== undefined) throw new WikiSectionError('nested markers');
      if (seen.has(key)) throw new WikiSectionError('duplicate section');
      seen.add(key);
      open = key;
    }
    cursor = match.index + match[0].length;
  }
  if (open !== undefined || WIKI_SECTION_PREFIX.test(body.slice(cursor))) throw new WikiSectionError('unclosed marker');
}
