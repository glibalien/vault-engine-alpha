import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { sha256 } from '../indexer/hash.js';

export interface MissingNode {
  id: string;
  file_path: string;
  content_hash: string;
}

/**
 * Hash the disk files that have no DB row (potential rename targets). Blank
 * files are excluded — all empty notes share one hash, so they can never pair
 * safely.
 */
export function collectNewPathHashes(
  vaultPath: string,
  diskFiles: Iterable<string>,
  dbPaths: Set<string>,
): Map<string, string[]> {
  const hashToNewPaths = new Map<string, string[]>();
  for (const relPath of diskFiles) {
    if (dbPaths.has(relPath)) continue;
    try {
      const content = readFileSync(join(vaultPath, relPath), 'utf-8');
      if (content.trim() === '') continue;
      const hash = sha256(content);
      const paths = hashToNewPaths.get(hash);
      if (paths) paths.push(relPath);
      else hashToNewPaths.set(hash, [relPath]);
    } catch {
      // Unreadable — not a rename candidate
    }
  }
  return hashToNewPaths;
}

/**
 * Pair missing nodes with new disk paths by content hash, keyed by new path.
 * Unambiguous (1:1) hashes pair directly. Within an ambiguous hash group
 * (duplicate-content notes, e.g. unedited templates) a pair is made only when
 * the basename matches uniquely on both sides — which covers folder moves.
 * Anything still ambiguous is refused: delete + create is safer than guessing
 * identity between different notes.
 */
export function pairRenames(
  missing: MissingNode[],
  hashToNewPaths: Map<string, string[]>,
): Map<string, MissingNode> {
  const missingByHash = new Map<string, MissingNode[]>();
  for (const node of missing) {
    const group = missingByHash.get(node.content_hash);
    if (group) group.push(node);
    else missingByHash.set(node.content_hash, [node]);
  }

  const paired = new Map<string, MissingNode>();
  for (const [hash, nodes] of missingByHash) {
    const paths = hashToNewPaths.get(hash) ?? [];
    if (paths.length === 0) continue;
    if (nodes.length === 1 && paths.length === 1) {
      paired.set(paths[0], nodes[0]);
      continue;
    }
    for (const node of nodes) {
      const base = basename(node.file_path);
      if (nodes.filter(n => basename(n.file_path) === base).length !== 1) continue;
      const candidates = paths.filter(p => basename(p) === base && !paired.has(p));
      if (candidates.length === 1) {
        paired.set(candidates[0], node);
      }
    }
  }
  return paired;
}
