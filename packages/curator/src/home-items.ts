import { marked } from 'marked';
import type { z } from 'zod';
import type { HOME_SECTIONS_SCHEMA, HomeItem } from './prompts/page.js';
import type { WikiSections } from './types.js';

type HomeSectionsOutput = Omit<z.infer<typeof HOME_SECTIONS_SCHEMA>, 'memories'>;

/** Lay out the itemized home sections as Markdown. Focus items are next actions
 *  (checkboxes) on a project home; a topic home has no tasks. */
export function renderHomeSections(output: HomeSectionsOutput, focusTasks = true): WikiSections {
  return {
    ...output,
    now: moveCalloutTextToBody(output.now),
    log_entry: moveCalloutTextToBody(output.log_entry),
    ...(output.at_a_glance === undefined ? {} : { at_a_glance: moveCalloutTextToBody(output.at_a_glance) }),
    ...(output.sources === undefined ? {} : { sources: moveCalloutTextToBody(output.sources) }),
    focus: renderHomeItems(output.focus, focusTasks),
    open_threads: renderHomeItems(output.open_threads, false),
  };
}

// At most three spaces around each `>`: more would make the rest a code block.
const CALLOUT_WITH_TEXT = /^((?: {0,3}> ?)+ {0,3})(\[![^\]\s]+\][+-]?)[ \t]+(\S.*)$/;

/** Obsidian treats text on a callout's first line as its title. Some models put the whole
 *  callout there (#357), which shows a long title with no body, so text with nothing under
 *  it moves to the body. A title with a body below it is what was meant and stays. The
 *  Markdown lexer finds the quotes, so anything inside a code block is never touched. */
export function moveCalloutTextToBody(markdown: string): string {
  const tokens = marked.lexer(markdown);
  // Every token keeps its source text, so this only fails on input the lexer normalized.
  if (tokens.map(token => token.raw).join('') !== markdown) return markdown;
  return tokens.map(token => (token.type === 'blockquote' ? calloutWithBody(token.raw) : token.raw)).join('');
}

function calloutWithBody(quote: string): string {
  const [first = '', ...rest] = quote.split('\n');
  const callout = CALLOUT_WITH_TEXT.exec(first);
  if (!callout || rest.some(line => /[^\s>]/.test(line))) return quote;
  return [`${callout[1]}${callout[2]}`, `${callout[1]}${callout[3]}`, ...rest].join('\n');
}

/** One line per plain item, grouped into a list; each callout is its own block. */
export function renderHomeItems(items: readonly HomeItem[], tasks: boolean): string {
  const blocks: string[] = [];
  let list: string[] = [];
  for (const item of items) {
    // Bold, list markers and checkboxes are layout, which belongs to the renderer.
    const title = oneLine(item.title).replace(/^(?:[-*+]\s+)?(?:\[[ xX]\](?:\s+|$))?/, '').replaceAll('**', '').trim();
    if (!title) throw new Error('home item has an empty title');
    const detail = oneLine(item.detail ?? '').replace(/^[—–-]\s+/, '');
    if (item.callout) {
      if (list.length > 0) blocks.push(list.join('\n'));
      list = [];
      blocks.push(`> [!${item.callout}] ${title}${detail ? `\n> ${detail}` : ''}`);
    } else {
      list.push(`${tasks ? '- [ ] ' : '- '}**${title}**${detail ? ` — ${detail}` : ''}`);
    }
  }
  if (list.length > 0) blocks.push(list.join('\n'));
  return blocks.join('\n\n');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
