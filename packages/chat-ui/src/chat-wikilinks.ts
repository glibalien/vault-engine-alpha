const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const VAULT_PREFIX = 'vault://node/';

/** Convert [[Title]] into a markdown link with a custom vault:// scheme so react-markdown renders an <a>.
 * Code spans and fenced code blocks are left untouched — only plain-text segments are converted. */
export function wikilinksToMarkdownLinks(text: string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`]*`)/g);
  return parts
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(WIKILINK_RE, (_m, title: string) => `[${title}](${VAULT_PREFIX}${encodeURIComponent(title)})`)))
    .join('');
}

/** Decode a vault://node/<title> href back to its title, or null if it isn't one. */
export function parseVaultHref(href: string): string | null {
  if (typeof href !== 'string' || !href.startsWith(VAULT_PREFIX)) return null;
  try { return decodeURIComponent(href.slice(VAULT_PREFIX.length)); } catch { return null; }
}
