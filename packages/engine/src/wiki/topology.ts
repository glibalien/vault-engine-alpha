import { createHash } from 'node:crypto';
import type { WikiCatalogPage } from './digest.js';
import { serializeWikiScope } from './scope.js';

export function computeWikiTopologyHash(pages: readonly WikiCatalogPage[]): string {
  const canonical = JSON.stringify([...pages]
    .sort((left, right) => {
      if (left.id < right.id) return -1;
      if (left.id > right.id) return 1;
      return 0;
    })
    .map(page => {
      let scope: string | null = null;
      if (page.wiki_scope !== undefined) {
        scope = serializeWikiScope(page.wiki_scope);
      } else if (page.wiki_scope_error !== undefined) {
        scope = JSON.stringify({ invalid: page.wiki_scope_error, raw: page.wiki_scope_raw ?? '' });
      }
      return {
        id: page.id,
        title: page.title,
        version: page.version,
        content_hash: page.content_hash,
        scope,
        kind: page.wiki_kind ?? null,
        state: page.wiki_state,
        origin: page.wiki_origin,
        pinned: page.wiki_pinned,
        replaced_by_id: page.wiki_replaced_by?.id ?? null,
        replaced_by_title: page.wiki_replaced_by?.title ?? null,
      };
    }));
  return createHash('sha256').update(canonical).digest('hex');
}
