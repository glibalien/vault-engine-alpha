import { marked, type Token } from 'marked';

const MARKER = /<!--\s*\/?ve:(?:managed|live):/;

/** Extract context without teaching the model to copy Engine's control syntax or Log. */
export function pageNarrativeContext(body: string): string {
  const seen = new Set<string>();
  const context = body.replace(/<!--\s*ve:(managed|live):([^<>\r\n]+?)\s*-->([\s\S]*?)<!--\s*\/ve:(managed|live):([^<>\r\n]+?)\s*-->/g,
    (_block, kind: string, name: string, content: string, endKind: string, endName: string) => {
      const key = `${kind}:${name.trim()}`;
      if (!name.trim() || name !== name.trimStart() || endName !== endName.trimStart()
        || kind !== endKind || name.trim() !== endName.trim() || seen.has(key) || MARKER.test(content)) {
        throw new Error('Existing wiki section boundaries require repair');
      }
      seen.add(key);
      return kind === 'live' || name.trim() === 'Log' ? '\n\n' : `\n\n${content.trim()}\n\n`;
    });
  if (MARKER.test(context)) throw new Error('Existing wiki section boundaries require repair');
  return context.trim();
}

/** Evidence reaches the model JSON-encoded, so it can copy a quoted note title into a link as
 *  `[[Title \"X\"]]`. A note name never contains a backslash, so drop backslashes before a
 *  quote inside a wikilink; `\|` (an alias pipe escaped in a table cell) is left alone. */
export function unescapeWikilinkQuotes(markdown: string): string {
  return markdown.replace(/\[\[[^[\]\n]*\]\]/g, link => link.replace(/\\+"/g, '"'));
}

/** Schema validity alone cannot establish that a string is usable page Markdown. */
export function assertPageMarkdown(body: string, logNote?: string): void {
  assertMarkdown(body, true);
  if (logNote !== undefined) assertSectionMarkdown(logNote);
}

/** Check section formatting without imposing the full page's narrative requirement. */
export function assertSectionMarkdown(content: string): void {
  assertMarkdown(content, false);
}

function assertMarkdown(content: string, requireNarrative: boolean): void {
  if (MARKER.test(content)) {
    throw new Error('Generated content contains reserved wiki section markers');
  }
  const tokens = marked.lexer(content);
  if (requireNarrative && !tokens.some(hasNarrative)) {
    throw new Error('Generated page has headings but no narrative');
  }
  marked.walkTokens(tokens, token => {
    if (token.type === 'paragraph' || token.type === 'heading' || token.type === 'text') {
      const text = 'tokens' in token && token.tokens !== undefined
        ? inlineMarkdownText(token.tokens) : token.text;
      if (hasCollapsedHeading(text)) throw new Error('Generated page has collapsed Markdown headings');
      // List-item blocks are text tokens with inline children. Do not inspect
      // bare inline text again: table cells have already decoded escaped pipes.
      const blockText = token.type !== 'text' || ('tokens' in token && token.tokens !== undefined);
      // Opaque inline content still occupies a table cell. A non-pipe placeholder
      // preserves its boundaries without treating code or escapes as syntax.
      const tableText = blockText && 'tokens' in token && token.tokens !== undefined
        ? inlineMarkdownText(token.tokens, '\uFFFC') : text;
      if (blockText && hasCollapsedTableRows(tableText)) {
        throw new Error('Generated page has collapsed Markdown table rows');
      }
    }
  });
}

// Containers contribute only their contents, never bullet/quote/fence punctuation.
function hasNarrative(token: Token): boolean {
  switch (token.type) {
    case 'heading': case 'space': case 'hr': case 'def': case 'br':
      return false;
    case 'list':
      return token.items.some((item: Token) => hasNarrative(item));
    case 'table':
      return [...token.header, ...token.rows.flat()].some(cell => cell.tokens.some(hasNarrative));
    case 'code': case 'codespan':
      return token.text.trim() !== '';
    default:
      if ('tokens' in token && token.tokens !== undefined) return token.tokens.some(hasNarrative);
      if (!('text' in token) || typeof token.text !== 'string') return false;
      const text = token.text.replace(/<!--[^]*?-->/g, '').replace(/<[^>]*>/g, '').trim();
      // Marked treats a trailing bare bullet without a newline as paragraph text.
      return text !== '' && !/^(?:[-+*]|\d+[.)])(?:[ \t]+\[[ xX]\])?$/.test(text);
  }
}

// Preserve continuity across emphasis and links, but never inspect code or escaped
// delimiters as Markdown syntax. Newlines make excluded tokens detection boundaries.
function inlineMarkdownText(tokens: readonly Token[], excludedTokenText = '\n'): string {
  return tokens.map(token => {
    if (token.type === 'codespan' || token.type === 'escape' || token.type === 'image' || token.type === 'html') return excludedTokenText;
    if (token.type === 'br') return '\n';
    if ('tokens' in token && token.tokens !== undefined) return inlineMarkdownText(token.tokens, excludedTokenText);
    return token.type === 'text' ? token.text : '';
  }).join('');
}

function hasCollapsedTableRows(text: string): boolean {
  return text.split(/\r?\n/).some(line => {
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
    // Marked accepts delimiter cells with one or more hyphens.
    const delimiterCell = /^:?-+:?$/;
    for (let runStart = 0; runStart < cells.length;) {
      if (!delimiterCell.test(cells[runStart] ?? '')) { runStart++; continue; }
      let end = runStart + 1;
      while (end < cells.length && delimiterCell.test(cells[end] ?? '')) end++;
      // Header cells can themselves be delimiter-shaped, including within the
      // same run. Examine each possible boundary, then continue to later runs.
      for (let start = Math.max(2, runStart); start < end; start++) {
        const columns = end - start;
        // Single-column tables need an extra boundary cell (||); a lone pipe
        // next to dashes remains ambiguous prose. Empty headers are permitted.
        const headerColumns = start === columns + 1 && cells[start - 1] === '' ? start - 1 : start;
        // A matching header and delimiter suffice regardless of trailing data.
        if (columns === headerColumns) return true;
      }
      runStart = end;
    }
    return false;
  });
}

function hasCollapsedHeading(text: string): boolean {
  // Multi-hash joins are stronger evidence than a lone hash. For H1, require a
  // glued multi-character word or sentence boundary and a capitalized heading.
  // Keep ambiguous inline hashes (C#, F#, issue # 12, "use # for...") as prose.
  return /[^\s#][ \t]*#{2,6}[ \t]+\S/.test(text)
    || /(?:[\p{L}\p{N}]{2,}|[.!?][ \t]*)#[ \t]+\p{Lu}/u.test(text);
}
