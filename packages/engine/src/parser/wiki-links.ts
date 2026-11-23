/**
 * Body wiki-link extraction using remark AST walking.
 *
 * Walks text nodes in the parsed markdown AST, skipping code blocks
 * and YAML frontmatter nodes. Extracts [[target]] and [[target|alias]] links.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import type { Node, Parent } from 'unist';
import type { Text } from 'mdast';
import type { WikiLink } from './types.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** AST node types to skip when extracting wiki-links. */
const SKIP_TYPES = new Set(['code', 'inlineCode', 'yaml']);

interface TextNodeWithContext {
  text: string;
  paragraphText: string;
}

/**
 * Collect all text content from a parent node (for context).
 */
function collectText(node: Node): string {
  if ('value' in node && typeof (node as Text).value === 'string') {
    return (node as Text).value;
  }
  if ('children' in node) {
    return (node as Parent).children.map(collectText).join('');
  }
  return '';
}

/**
 * Walk the AST and collect text nodes with their paragraph context.
 */
function collectTextNodes(
  node: Node,
  contextNode: Node | null,
  results: TextNodeWithContext[],
): void {
  if (SKIP_TYPES.has(node.type)) return;

  if (node.type === 'text') {
    const ctx = contextNode ?? node;
    const paragraphText = collectText(ctx);
    results.push({
      text: (node as Text).value,
      paragraphText: paragraphText.slice(0, 200),
    });
    return;
  }

  if ('children' in node) {
    // Use block-level nodes as context providers
    const isBlockContext =
      node.type === 'paragraph' ||
      node.type === 'heading' ||
      node.type === 'listItem' ||
      node.type === 'tableCell';
    const nextContext = isBlockContext ? node : contextNode;

    for (const child of (node as Parent).children) {
      collectTextNodes(child, nextContext, results);
    }
  }
}

/**
 * Extract wiki-links from the body of a markdown document using remark AST.
 */
export function extractBodyWikiLinks(body: string): WikiLink[] {
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkGfm);

  const tree = processor.parse(body);
  const textNodes: TextNodeWithContext[] = [];
  collectTextNodes(tree, null, textNodes);

  const links: WikiLink[] = [];
  for (const { text, paragraphText } of textNodes) {
    WIKILINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKILINK_RE.exec(text)) !== null) {
      links.push({
        target: match[1],
        alias: match[2] ?? null,
        context: paragraphText,
      });
    }
  }

  return links;
}

export interface WikiLinkOccurrence {
  /** Decoded, exactly as extraction indexes it (relationships.target). */
  target: string;
  alias: string | null;
  /** The same halves as written in the source — what a replacement should
   * carry over. In a table cell an aliased target keeps the `\` of its
   * escaped separator. */
  written: { target: string; alias: string | null };
  /** Preceded by `!` — an embed, whose alias half is not display text. */
  embed: boolean;
  /** Inside a GFM table cell, where an alias separator must be written `\|`. */
  inTableCell: boolean;
}

type SourceRange = [start: number, end: number];

/**
 * Source ranges of a tree's nodes, including the ones remark-gfm builds
 * without a position: micromark leaves a URL or email right after `[`
 * (`[[a@b.com]]`) to a transform that splits the text node around it into
 * position-less text and link nodes. Such a run of siblings spans the source
 * between its positioned neighbours, and is placed only where its text
 * appears there verbatim, exactly once — text with an entity or escape stays
 * unplaced, so its links are left alone.
 */
function sourceRanges(tree: Node, body: string): (node: Node) => SourceRange | undefined {
  const placed = new Map<Node, SourceRange>();
  const rangeOf = (node: Node): SourceRange | undefined => node.position
    ? [node.position.start.offset!, node.position.end.offset!]
    : placed.get(node);
  const place = (parent: Node): void => {
    if (!('children' in parent)) return;
    const children = (parent as Parent).children;
    const outer = rangeOf(parent);
    for (let i = 0; i < children.length && outer; i++) {
      if (children[i].position) continue;
      let end = i;
      while (end < children.length && !children[end].position) end++;
      const run = children.slice(i, end);
      const from = i > 0 ? rangeOf(children[i - 1])![1] : outer[0];
      const span = body.slice(from, end < children.length ? rangeOf(children[end])![0] : outer[1]);
      const texts = run.map(collectText);
      const text = texts.join('');
      const at = span.indexOf(text);
      if (text !== '' && at !== -1 && at === span.lastIndexOf(text)) {
        let offset = from + at;
        run.forEach((node, k) => {
          placed.set(node, [offset, offset + texts[k].length]);
          offset += texts[k].length;
        });
      }
      i = end - 1;
    }
    for (const child of children) place(child);
  };
  place(tree);
  return rangeOf;
}

/**
 * Rewrite body wiki-links in place. `rewrite` returns the replacement for the
 * `[[...]]` part of a link (a leading `!` is kept), or null to leave it alone.
 * Same traversal as extraction: links in code and YAML are never touched.
 */
export function rewriteBodyWikiLinksWith(
  body: string,
  rewrite: (link: WikiLinkOccurrence) => string | null,
): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkGfm);

  const tree = processor.parse(body);
  const rangeOf = sourceRanges(tree, body);

  // Collect replacement ranges: [startOffset, endOffset, replacementText]
  const replacements: Array<[number, number, string]> = [];

  function walk(node: Node, inTableCell: boolean): void {
    if (SKIP_TYPES.has(node.type)) return;

    const range = node.type === 'text' ? rangeOf(node) : undefined;
    if (range) {
      // Targets come from the decoded value (what extraction indexes), splice
      // offsets from the source slice: an entity or escape (`&amp;`, `\|`)
      // shifts decoded indices off the body. The n-th link of one is the n-th
      // of the other — unless an escape makes or breaks a link, in which case
      // the counts differ and the node is left alone.
      const [nodeStart, nodeEnd] = range;
      const source = body.slice(nodeStart, nodeEnd);
      const sourceLinks = [...source.matchAll(new RegExp(WIKILINK_RE.source, 'g'))];
      const decodedLinks = [...(node as Text).value.matchAll(new RegExp(WIKILINK_RE.source, 'g'))];
      if (sourceLinks.length === decodedLinks.length) {
        sourceLinks.forEach((m, i) => {
          const decoded = decodedLinks[i];
          const rep = rewrite({
            target: decoded[1],
            alias: decoded[2] ?? null,
            written: { target: m[1], alias: m[2] ?? null },
            embed: source[m.index! - 1] === '!',
            inTableCell,
          });
          if (rep === null) return;
          const absStart = nodeStart + m.index!;
          replacements.push([absStart, absStart + m[0].length, rep]);
        });
      }
    }

    if ('children' in node) {
      for (const child of (node as Parent).children) {
        walk(child, inTableCell || node.type === 'tableCell');
      }
    }
  }

  walk(tree, false);

  if (replacements.length === 0) return body;

  // Apply in reverse order to preserve offsets
  let result = body;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const [start, end, rep] = replacements[i];
    result = result.slice(0, start) + rep + result.slice(end);
  }

  return result;
}
