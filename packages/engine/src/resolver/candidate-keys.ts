import { basename } from 'node:path';
import { anchoredLinkName, linkAnchor } from './resolve.js';

export interface NodeLike {
  file_path: string;
  title: string | null;
}

export interface CandidateKeys {
  file_path: string;
  /** The path without `.md`, which a link can be written as (#592); null at the vault root, where it is the basename. */
  pathStem: string | null;
  title: string | null;
  basename: string;
  basenameLower: string;
  basenameNfcLower: string;
}

export function candidateKeysForNode(node: NodeLike): CandidateKeys {
  const base = basename(node.file_path, '.md');
  const stem = node.file_path.endsWith('.md') ? node.file_path.slice(0, -3) : node.file_path;
  return {
    file_path: node.file_path,
    pathStem: stem.includes('/') ? stem : null,
    title: node.title,
    basename: base,
    basenameLower: base.toLowerCase(),
    basenameNfcLower: base.normalize('NFC').toLowerCase(),
  };
}

/**
 * Whether a link written as `target` names the note with these keys at any resolver tier: its
 * path (with or without `.md`), its title, or its basename as written, case-folded or
 * NFC-normalized, a `.md` suffix dropped (as `resolveTarget` reads it).
 */
export function targetMatchesKeys(target: string, keys: CandidateKeys): boolean {
  if (target === keys.file_path || target === keys.pathStem || target === keys.title) return true;
  const bare = target.endsWith('.md') ? target.slice(0, -3) : target;
  return bare === keys.basename || bare.toLowerCase() === keys.basenameLower
    || bare.normalize('NFC').toLowerCase() === keys.basenameNfcLower;
}

/**
 * The anchor a rewrite of `target` keeps (#613): its `#…` part when it names the note with
 * these keys only through the name before its `#` (`Alpha#Intro` for Alpha), else ''. A
 * target that names the note whole (a name holding a `#`) has no anchor to keep.
 */
export function anchorNamingKeys(target: string, keys: CandidateKeys): string {
  if (targetMatchesKeys(target, keys)) return '';
  const name = anchoredLinkName(target);
  return name !== null && targetMatchesKeys(name, keys) ? linkAnchor(target) : '';
}
