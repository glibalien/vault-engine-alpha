import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PreviewRef } from './preview-ref.js';
import { wikilinksToMarkdownLinks, parseVaultHref } from './chat-wikilinks.js';

/** Preserve the internal vault:// scheme (parsed into a preview button below);
 *  sanitize every other URL via react-markdown's default (strips javascript:/data:/etc.). */
function safeUrlTransform(url: string): string {
  return url.startsWith('vault://') ? url : defaultUrlTransform(url);
}

/** A message's Markdown: GFM, safe links, and [[wikilinks]] as preview buttons. */
export function MessageMarkdown({ text, onOpenPreview }: {
  text: string;
  onOpenPreview?: (ref: PreviewRef) => void;
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      urlTransform={safeUrlTransform}
      components={{
        a: ({ href, children }) => {
          const title = parseVaultHref(href ?? '');
          if (title && onOpenPreview) {
            return <button className="wl-ref" onClick={() => onOpenPreview({ title })}>{children}</button>;
          }
          return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
      }}
    >
      {wikilinksToMarkdownLinks(text)}
    </Markdown>
  );
}
