import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/**
 * Finding plain-text mentions of existing notes in a note's body (#332). Pure: no Engine, no
 * model. The rules keep false links out rather than catch every mention:
 *
 * - A name is a target note's title or one of its aliases, at least `MIN_NAME_CHARS` long and
 *   holding a letter. A name more than one note answers to is ambiguous and never matched.
 * - A person matches only by a name of two or more words: a first name alone ("Sam") named the
 *   wrong person as often as the right one, since another Sam is usually the one meant.
 * - A one-word name must match its own capitalization ("Acme", never "acme"); a longer name
 *   matches in any case. A match is a whole word or words, with any whitespace between words.
 * - A mention followed by another capitalized word is part of a longer name ("Acme Cloud",
 *   "Sam Rivera Jones"), a product or another company, and is left alone.
 * - Only prose counts: text that is code, a link or its label, an embed, a URL, a comment, a tag,
 *   a heading, a table or HTML is left alone, so a proposed link never lands where it would change
 *   how the note renders or what it links. Markdown is read with a parser; Obsidian's own syntax
 *   with patterns.
 * - Only the first mention of each target counts, never the note's own name, and never a target
 *   the note already links to.
 */

export interface LinkTarget {
  id: string;
  title: string;
  aliases: readonly string[];
  /** A person: only a name of two or more words matches. */
  person?: boolean;
}

export interface Mention {
  targetId: string;
  /** The target's title, the name a link would point at. */
  title: string;
  /** The text as written in the note. */
  text: string;
  start: number;
  end: number;
  /** A short excerpt around the mention, for the journal. */
  context: string;
}

export const MIN_NAME_CHARS = 3;

interface NameEntry {
  targetIds: Set<string>;
  /** Every spelling given for this name, for one-word names that must match their case. */
  spellings: Set<string>;
  oneWord: boolean;
  /** A person's one-word name (a first name): never matched (see the rules above). */
  personFirstName: boolean;
}

export interface NameIndex {
  /** Lowercased, whitespace-folded name → entry. */
  names: Map<string, NameEntry>;
  /** Target id → title. */
  titles: Map<string, string>;
  /** One pattern over every name, ambiguous ones included, longest first; null when there is none. */
  pattern: RegExp | null;
  /** Names left out because more than one note answers to them. */
  ambiguous: string[];
}

const keyOf = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
const DATE_LIKE = /^\d{4}-\d{2}(-\d{2})?$/;

function usable(name: string): boolean {
  const n = name.trim();
  return n.length >= MIN_NAME_CHARS && /\p{L}/u.test(n) && !DATE_LIKE.test(n);
}

export function buildNameIndex(targets: readonly LinkTarget[]): NameIndex {
  const names = new Map<string, NameEntry>();
  const titles = new Map<string, string>();
  for (const target of targets) {
    titles.set(target.id, target.title);
    for (const raw of [target.title, ...target.aliases]) {
      if (typeof raw !== 'string' || !usable(raw)) continue;
      const spelling = raw.trim().replace(/\s+/g, ' ');
      const key = keyOf(spelling);
      const entry = names.get(key) ?? { targetIds: new Set<string>(), spellings: new Set<string>(), oneWord: !spelling.includes(' '), personFirstName: false };
      entry.targetIds.add(target.id);
      // Kept in the index so the name stays ambiguous when another note shares it; never matched.
      if (target.person && entry.oneWord) entry.personFirstName = true;
      entry.spellings.add(spelling);
      names.set(key, entry);
    }
  }
  const ambiguous: string[] = [];
  for (const entry of names.values()) if (entry.targetIds.size > 1) ambiguous.push([...entry.spellings][0]!);
  // Ambiguous names stay in the pattern, so they take their whole span and a shorter name inside
  // one ("Acme" in an ambiguous "Acme Corp") can't match there; findMentions then skips them.
  const keys = [...names.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const alternatives = keys.map((key) => key.split(' ').map(escapeRegExp).join('\\s+'));
  const pattern = alternatives.length === 0
    ? null
    : new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  return { names, titles, pattern, ambiguous: ambiguous.sort() };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const markdown = unified().use(remarkParse).use(remarkGfm);

/** Markdown nodes whose text is never prose a link can go in: a link's label, a heading (a link
 *  changes its anchor), a table (a link's `|` splits the cell), a reference definition. Code,
 *  inline code, HTML and images are leaves with no text nodes, so they are left out anyway. */
const NOT_PROSE = new Set(['link', 'linkReference', 'heading', 'table', 'definition']);

/**
 * The prose of `body`, as [start, end) ranges: the text nodes of its Markdown (CommonMark plus
 * GitHub tables, autolinks and the rest), outside links, headings, tables and definitions. A
 * parser rather than patterns, so fenced, indented and inline code, tables with or without a
 * leading pipe, setext headings and HTML are what Markdown says they are (Codex on #624).
 */
export function proseRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const visit = (node: MdNode, blocked: boolean): void => {
    const inside = blocked || NOT_PROSE.has(node.type);
    if (node.type === 'text' && !inside) {
      const from = node.position?.start.offset;
      const to = node.position?.end.offset;
      if (typeof from === 'number' && typeof to === 'number') ranges.push([from, to]);
    }
    for (const child of node.children ?? []) visit(child, inside);
  };
  visit(markdown.parse(body) as MdNode, false);
  return ranges;
}

interface MdNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
}

/**
 * Obsidian syntax inside prose that Markdown doesn't know, as [start, end) ranges: wikilinks and
 * embeds, `%%` comments and tags. Bracket pairs that look like reference links (`[Acme][x]`,
 * `[Acme][]`) are kept out too, defined or not: a link added inside one nests brackets.
 */
export function protectedRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const add = (re: RegExp) => { for (const m of body.matchAll(re)) ranges.push([m.index, m.index + m[0].length]); };
  add(/!?\[\[[^\]\n]*\]\]/g);                         // wikilinks and embeds
  add(/!?\[[^\]\n]*\]\[[^\]\n]*\]/g);                 // reference-style brackets
  add(/%%[\s\S]*?%%/g);                               // Obsidian comments
  add(/(?<=^|\s)#[^\s#]+/gmu);                        // tags: a link inside one breaks the tag
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** Another capitalized word right after a mention, on the same line: the mention is part of a longer name. */
const NEXT_WORD_CAPITALIZED = /^[ \t]+\p{Lu}/u;

function overlaps(ranges: ReadonlyArray<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([s, e]) => start < e && end > s);
}

/** A one-line excerpt around a mention for the journal, with link syntax flattened to its text
 *  so the journal note doesn't link every note the excerpt happens to touch. */
function excerpt(body: string, start: number, end: number): string {
  let from = Math.max(0, start - 30);
  let to = Math.min(body.length, end + 30);
  // Never start or end inside a link: widen to take it whole.
  for (const m of body.matchAll(/!?\[\[[^\]\n]*\]\]/g)) {
    const linkEnd = m.index + m[0].length;
    if (m.index < from && from < linkEnd) from = m.index;
    if (m.index < to && to < linkEnd) to = linkEnd;
  }
  const text = body.slice(from, to)
    .replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, target: string, shown?: string) => shown || target)
    .replace(/\[\[|\]\]/g, '')
    .replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${text}${to < body.length ? '…' : ''}`;
}

/**
 * The first mention of each target in `body` that could become a link. `selfId` is the note's own
 * id; `linkedIds` are the targets it already links to (in its fields or body).
 */
export function findMentions(
  body: string,
  index: NameIndex,
  opts: { selfId: string; linkedIds: ReadonlySet<string> },
): Mention[] {
  if (index.pattern === null || body.length === 0) return [];
  const ranges = protectedRanges(body);
  const found = new Map<string, Mention>();
  // Match inside each prose span on its own, so markup at its edges (`_Sam Rivera_`, `**Acme**`)
  // never counts as part of a word.
  for (const [spanStart, spanEnd] of proseRanges(body)) {
    for (const m of body.slice(spanStart, spanEnd).matchAll(index.pattern)) {
      const text = m[0];
      const start = spanStart + m.index;
      const end = start + text.length;
      const entry = index.names.get(keyOf(text));
      if (!entry || entry.targetIds.size !== 1 || entry.personFirstName) continue;
      const targetId = [...entry.targetIds][0]!;
      if (targetId === opts.selfId || opts.linkedIds.has(targetId) || found.has(targetId)) continue;
      if (entry.oneWord && !entry.spellings.has(text)) continue;
      if (overlaps(ranges, start, end)) continue;
      if (NEXT_WORD_CAPITALIZED.test(body.slice(end, end + 8))) continue;
      found.set(targetId, { targetId, title: index.titles.get(targetId) ?? text, text, start, end, context: excerpt(body, start, end) });
    }
  }
  return [...found.values()].sort((a, b) => a.start - b.start);
}
