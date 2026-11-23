// Characters that break Obsidian wiki-link *syntax* (distinct from filenames).
// `|` is the alias delimiter: a title-derived ref `[[A | B]]` parses as target
// `A` + alias `B`, so the ref no longer resolves to the renamed/materialized
// node. Filename sanitization can't save it — the rewrite (rewriteBodyWikiLinks)
// emits the raw title, and near-miss recovery (normalizeRefKey) never sees the
// `B` half because the parser already consumed the pipe as a delimiter. So `|`
// must stay in BOTH this set and FILENAME_UNSAFE.
const WIKILINK_UNSAFE = ['(', ')', '[', ']', '|', '#', '^'];

export type ToolIssueCode =
  | 'TITLE_WIKILINK_UNSAFE'
  | 'FRONTMATTER_IN_BODY'
  | 'TYPE_OP_CONFLICT'
  | 'LAST_TYPE_REMOVAL'
  | 'TITLE_FILENAME_SANITIZED'
  | 'UNPRICED_MODELS';

export interface ToolIssue {
  code: ToolIssueCode;
  message: string;
  characters?: string[];
}

export function checkTitleSafety(title: string): ToolIssue[] {
  const found = WIKILINK_UNSAFE.filter(ch => title.includes(ch));
  if (found.length === 0) return [];
  return [{
    code: 'TITLE_WIKILINK_UNSAFE',
    message: `Title contains characters that may break Obsidian wiki-links: ${found.join(' ')}`,
    characters: found,
  }];
}

// Characters that are illegal or reserved in cross-platform filenames:
// `/` `\` POSIX/Windows path separators; `:` Windows reserved + classic Mac
// path separator (still rejected by Finder); `*` `?` `"` `<` `>` Windows
// reserved; `|` Windows reserved AND Obsidian wiki-link alias separator.
// Mirrors the set canonicalized by `normalizeRefKey` in resolver/near-miss.ts.
const FILENAME_UNSAFE = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

export interface SanitizeResult {
  filename: string;
  sanitized: boolean;
  characters: string[];
}

export function sanitizeFilename(name: string): SanitizeResult {
  const found = FILENAME_UNSAFE.filter(ch => name.includes(ch));
  if (found.length === 0) {
    return { filename: name, sanitized: false, characters: [] };
  }
  let out = name;
  for (const ch of FILENAME_UNSAFE) {
    out = out.split(ch).join('-');
  }
  return { filename: out, sanitized: true, characters: found };
}

export function checkBodyFrontmatter(body: string): ToolIssue[] {
  if (body.startsWith('---\n') || body.startsWith('---\r\n')) {
    return [{
      code: 'FRONTMATTER_IN_BODY',
      message: 'Body appears to start with a YAML frontmatter block. Structured fields should be passed via the fields parameter, not embedded in body.',
    }];
  }
  return [];
}
