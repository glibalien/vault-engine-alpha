import type { Text } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Node, Parent } from 'unist';

/**
 * Inline tags (#647): the `#tags` some apps mark a note with in its text. Read as Obsidian reads
 * them, so what this lists is what the user sees as tags there.
 *
 * - A tag is `#` followed by letters, digits, `_`, `-` and `/`, with at least one character
 *   that is not a digit: `#meeting`, `#project/alpha`, `#2021-plans`; not `#123`.
 * - The `#` starts a line or follows a space. So `# Heading` (a space after it), `page#section`,
 *   a link to a heading (`[[Note#Part]]`, `(#part)`) and a URL's fragment are not tags.
 * - Nothing inside code is a tag: a fenced or indented block, or `inline code`, on one line or over several.
 *   Nor is anything inside an HTML block or comment.
 * - Tags do not differ by letter case: `#Meeting` is `#meeting`.
 */

const TAG = /(?<![^\s])#([\p{L}\p{N}_/-]+)/gu;

/** What a match of TAG names: lowercased, or null for a number (`#123`) or a bare `#`. */
function tagOf(found: string): string | null {
  const tag = found.replace(/[/-]+$/, '');
  return tag === '' || !/[^\d]/u.test(tag) ? null : tag.toLowerCase();
}

/**
 * What a text needs for any of it not to be the note's own running text: a backtick, a tilde
 * fence or a line indented as code; an HTML tag or comment; a `---` block at its very start.
 * A text with none of these is all running text.
 */
const MAY_HOLD_CODE = /`|~~~|^(?: {4}|\t)|<[A-Za-z!/?]|^---/m;

/**
 * The inline tags of a note's text, lowercased, each once, in the order first written.
 *
 * A text that is all running text is matched as it stands, which is fast and exact. Any other
 * text that has a tag-shaped word is parsed as Markdown, so that what is code or HTML is decided
 * as a renderer decides it, wherever it sits: fenced or indented, inside a quote or a list,
 * within a line or over several, in a comment. A note with `#meeting` in a code example or in
 * a commented-out line is not a meeting.
 */
export function inlineTags(body: string): string[] {
  if (!body.includes('#')) return [];
  const plain = plainTags(body);
  return plain.length === 0 || !MAY_HOLD_CODE.test(body) ? plain : parsedTags(body);
}

const parser = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm);
/** Nothing in these is the note's own running text. */
const NOT_TEXT = new Set(['code', 'inlineCode', 'yaml', 'html']);

function parsedTags(body: string): string[] {
  const tags = new Set<string>();
  const walk = (node: Node): void => {
    if (NOT_TEXT.has(node.type)) return;
    if (node.type === 'text') {
      const start = node.position?.start.offset;
      for (const match of (node as Text).value.matchAll(TAG)) {
        // A text starts where other markup ends: `**bold**#tag` puts no space before the #.
        if (match.index === 0 && start !== undefined && start > 0 && !/\s/.test(body[start - 1]!)) continue;
        const tag = tagOf(match[1]!);
        if (tag !== null) tags.add(tag);
      }
      return;
    }
    for (const child of (node as Parent).children ?? []) walk(child);
  };
  walk(parser.parse(body));
  return [...tags];
}

/** Every tag-shaped word of a text that holds no code: nothing in it needs telling apart. */
function plainTags(body: string): string[] {
  const tags = new Set<string>();
  for (const match of body.matchAll(TAG)) {
    const tag = tagOf(match[1]!);
    if (tag !== null) tags.add(tag);
  }
  return [...tags];
}

/**
 * The tags a `tags` (or `tag`) frontmatter field holds, lowercased, without a leading `#`: a
 * list's items, or one text split on commas and spaces.
 */
export function fieldTags(text: string | null, json: string | null): string[] {
  let items: unknown[] = [];
  if (text !== null) {
    items = text.split(/[\s,]+/);
  } else if (json !== null) {
    try {
      const parsed: unknown = JSON.parse(json);
      items = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }
  const tags = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().replace(/^#/, '').replace(/[/-]+$/, '').toLowerCase();
    if (tag !== '' && /^[\p{L}\p{N}_/-]+$/u.test(tag) && /[^\d]/u.test(tag)) tags.add(tag);
  }
  return [...tags];
}
