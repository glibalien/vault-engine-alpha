import type { Client, NodeRow } from '@vault/query-core';

export type SearchMode = 'hybrid' | 'fts' | 'semantic';

export const SEARCH_MODES: { value: SearchMode; label: string }[] = [
  { value: 'hybrid', label: 'Hybrid (FTS + semantic)' },
  { value: 'fts', label: 'FTS5' },
  { value: 'semantic', label: 'Semantic' },
];

export const SEARCH_RESULT_LIMIT = 100;

export interface SearchHit {
  file_path: string;
  title: string;
  type: string;
  snippet: string;
  score: number;
}

export type SearchResult =
  | { ok: true; hits: SearchHit[] }
  | { ok: false; message: string };

/** query-nodes search arguments (mirrors vault-chat's buildSearchArgs). */
export function buildSearchArgs(
  query: string,
  mode: SearchMode,
  limit: number,
): { query: string; search_mode: SearchMode; limit: number } {
  return { query, search_mode: mode, limit };
}

/** Vault-relative path → display-title fallback (basename without .md). */
function basename(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.md$/i, '');
}

/** Map an engine query-nodes row to a display hit. */
export function toSearchHit(node: NodeRow): SearchHit {
  const title = node.title && node.title.trim() ? node.title : basename(node.file_path);
  return {
    file_path: node.file_path,
    title,
    type: node.types[0] ?? 'node',
    snippet: node.snippet ?? '',
    score: node.score ?? 0,
  };
}

/** Split an engine snippet's <mark>…</mark> HTML into plain text segments so the
 *  modal can render highlights as DOM nodes (XSS-safe — never innerHTML).
 *  Unclosed/odd markup degrades to a single plain segment. */
export function parseSnippet(snippet: string): { text: string; mark: boolean }[] {
  const segments: { text: string; mark: boolean }[] = [];
  const re = /<mark>([\s\S]*?)<\/mark>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > last) segments.push({ text: snippet.slice(last, m.index), mark: false });
    segments.push({ text: m[1], mark: true });
    last = re.lastIndex;
  }
  if (last < snippet.length) segments.push({ text: snippet.slice(last), mark: false });
  return segments;
}

/** Run a search via query-nodes and map rows to hits. Pure over the client. */
export async function searchVault(
  client: Pick<Client, 'queryNodes'>,
  query: string,
  mode: SearchMode,
  limit: number,
): Promise<SearchResult> {
  const env = await client.queryNodes(buildSearchArgs(query, mode, limit));
  if (!env.ok) return { ok: false, message: env.error.message };
  return { ok: true, hits: env.data.nodes.map(toSearchHit) };
}
