import type { MarkdownPostProcessorContext } from 'obsidian';
import { noteTypes } from '../engine/type-key.js';

// Display labels for Engine's existing markers; no Engine import or stored rewrite.
const SECTION_LABELS = new Map([
  ['managed:At a glance', 'At a glance'], ['managed:Now', 'Now'],
  ['managed:Focus', 'Focus'], ['managed:Open threads', 'Open threads'],
  ['managed:Summary', 'Summary'], ['managed:Sources', 'Sources'],
  ['managed:Status', 'Status'], ['managed:Log', 'Log'],
  ['live:tasks', 'Tasks'], ['live:upcoming', 'Upcoming'], ['live:contacts', 'Contacts'],
  ['live:meetings', 'Meetings'], ['live:notes', 'Notes'], ['live:related', 'Related'],
  ['live:sub-pages', 'Sub-pages'],
]);
const RETAINED_ACTION = 'Existing wiki action (retained verbatim): ';
const MARKER = /^ {0,3}<!--\s*(\/?)ve:(managed|live):([^<>\r\n]+?)\s*-->[ \t]*$/;
const MARKER_PREFIX = /<!--\s*\/?ve:(?:managed|live):/;
const NESTED_RENDER_BOUNDARY = '.markdown-embed, .internal-embed, .markdown-embed-content, pre, code';

interface Section {
  key: string;
  opening: number;
  content: number;
  label: string;
}

/**
 * Render-only presentation for wiki previews, including Reading view and embeds. A wiki page is a
 * note of `wikiType`, the vault map's wiki kind; none means no note is presented as a wiki page.
 * `typeKey` is the frontmatter key Engine keeps a note's types in (#445).
 */
export function presentWikiReadingView(
  el: HTMLElement, ctx: MarkdownPostProcessorContext, wikiType: string | null, typeKey = 'types',
): void {
  if (el.closest('pre, code')) return;
  if (wikiType === null || !noteTypes(ctx.frontmatter?.[typeKey]).includes(wikiType)) return;
  const info = ctx.getSectionInfo(el);
  if (!info || typeof info.text !== 'string' || !Number.isInteger(info.lineStart) || !Number.isInteger(info.lineEnd)) return;
  const lines = info.text.split(/\r?\n/);
  if (info.lineStart < 0 || info.lineEnd < info.lineStart || info.lineEnd >= lines.length) return;
  const sections = readSections(lines);
  if (!sections) return;

  for (const section of sections) {
    if (section.content < info.lineStart || section.content > info.lineEnd) continue;
    if (Array.from(el.querySelectorAll('[data-ve-wiki-section]')).some(node => ownsRenderedNode(el, node) && node.getAttribute('data-ve-wiki-section') === section.key)) continue;
    // A section that already supplies its own visible heading needs no second one.
    if (lines[section.content]!.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/)?.[1] === section.label) continue;

    const comment = openingComment(el, section.key);
    // Source ranges can cover several blocks. When comments were stripped, only
    // prepend at a known first-content boundary rather than guess a DOM location.
    if (!comment && lines.slice(info.lineStart, section.content).some((line, offset) => line.trim() && info.lineStart + offset !== section.opening)) continue;
    const first = comment ? nextElement(comment) : el.firstElementChild;
    if (first?.matches('h1, h2, h3, h4, h5, h6') && first.textContent?.trim() === section.label) continue;
    const heading = el.ownerDocument.createElement('h2');
    heading.className = 've-wiki-section-heading';
    heading.setAttribute('data-ve-wiki-section', section.key);
    heading.textContent = section.label;
    if (comment) comment.parentNode?.insertBefore(heading, comment.nextSibling);
    else el.prepend(heading);
  }

  for (const paragraph of el.querySelectorAll('p')) {
    if (!ownsRenderedNode(el, paragraph) || !paragraph.textContent?.startsWith(RETAINED_ACTION)) continue;
    // Keep formatted prefixes readable, while an inline-code example stays code.
    const firstText = el.ownerDocument.createTreeWalker(paragraph, 4 /* SHOW_TEXT */).nextNode();
    if (!firstText || !ownsRenderedNode(el, firstText)) continue;
    paragraph.classList.add('ve-wiki-retained-action');
  }
}

/** Fail closed on ambiguous ownership; code examples never supply markers. */
function readSections(lines: string[]): Section[] | null {
  const sections: Section[] = [];
  const seen = new Set<string>();
  let open: { key: string; line: number } | undefined;
  let fence: string | undefined;
  let inComment = false;
  let inFrontmatter = lines[0] === '---';
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line]!;
    if (inFrontmatter) {
      if (line > 0 && text === '---') inFrontmatter = false;
      continue;
    }
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(text)) fence = undefined;
      continue;
    }
    if (inComment) {
      if (text.includes('-->')) inComment = false;
      continue;
    }
    const startFence = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (startFence) { fence = startFence[1]; continue; }
    if (/^(?: {4}|\t)/.test(text)) continue;
    const marker = MARKER.exec(text);
    if (!marker) {
      if (MARKER_PREFIX.test(text)) return null;
      if (text.includes('<!--') && !text.includes('-->')) inComment = true;
      continue;
    }
    const name = marker[3]!;
    if (!name.trim() || name !== name.trimStart()) return null;
    const key = `${marker[2]}:${name.trimEnd()}`;
    if (marker[1] === '/') {
      if (open?.key !== key) return null;
      const label = SECTION_LABELS.get(key);
      let content = open.line + 1;
      while (content < line && !lines[content]!.trim()) content++;
      if (label && content < line) sections.push({ key, label, opening: open.line, content });
      open = undefined;
    } else {
      if (open || seen.has(key)) return null;
      seen.add(key);
      open = { key, line };
    }
  }
  return open ? null : sections;
}

function openingComment(el: HTMLElement, key: string): Comment | undefined {
  const walker = el.ownerDocument.createTreeWalker(el, 128 /* SHOW_COMMENT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!ownsRenderedNode(el, node)) continue;
    if (node.nodeValue?.trim() === `ve:${key}`) return node as Comment;
  }
  return undefined;
}

/** Nested embeds have their own source context; the callback root is its owner. */
function ownsRenderedNode(el: HTMLElement, node: Node): boolean {
  let owner = node.nodeType === 1 ? node as Element : node.parentElement;
  while (owner && owner !== el) {
    if (owner.matches(NESTED_RENDER_BOUNDARY)) return false;
    owner = owner.parentElement;
  }
  return owner === el;
}

function nextElement(node: Node): Element | null {
  let next = node.nextSibling;
  while (next && next.nodeType !== 1) next = next.nextSibling;
  return next as Element | null;
}
