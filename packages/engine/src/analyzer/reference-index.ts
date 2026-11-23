import { basename } from 'node:path';

export interface ReferenceDocument {
  relativePath: string;
  title: string | null;
  types: string[];
}

interface IndexedReferenceDocument {
  path: string;
  types: string[];
}

type IndexedReferenceValue =
  | { status: 'unique'; document: IndexedReferenceDocument }
  | { status: 'ambiguous' };

export interface ReferenceIndex {
  exactPath: Map<string, IndexedReferenceValue>;
  exactTitle: Map<string, IndexedReferenceValue>;
  exactBasename: Map<string, IndexedReferenceValue>;
  foldedBasename: Map<string, IndexedReferenceValue>;
  nfcFoldedBasename: Map<string, IndexedReferenceValue>;
}

export type ReferenceResolution =
  | { status: 'resolved'; path: string; types: string[] }
  | { status: 'ambiguous' }
  | { status: 'unresolved' };

export function buildReferenceIndex(documents: readonly ReferenceDocument[]): ReferenceIndex {
  const index: ReferenceIndex = {
    exactPath: new Map(),
    exactTitle: new Map(),
    exactBasename: new Map(),
    foldedBasename: new Map(),
    nfcFoldedBasename: new Map(),
  };
  const sortedDocuments = documents.slice().sort((left, right) =>
    compareExact(left.relativePath, right.relativePath));
  for (const document of sortedDocuments) {
    const base = stripMarkdownSuffix(basename(document.relativePath));
    const indexed = {
      path: document.relativePath,
      types: [...new Set(document.types)].sort(compareExact),
    };
    add(index.exactPath, document.relativePath, indexed);
    if (document.title !== null) add(index.exactTitle, document.title, indexed);
    add(index.exactBasename, base, indexed);
    add(index.foldedBasename, base.toLowerCase(), indexed);
    add(index.nfcFoldedBasename, base.normalize('NFC').toLowerCase(), indexed);
  }
  return index;
}

export function resolveReference(index: ReferenceIndex, target: string): ReferenceResolution {
  const basenameTarget = stripMarkdownSuffix(target);
  const tiers = [
    index.exactPath.get(target),
    index.exactTitle.get(target),
    index.exactBasename.get(basenameTarget),
    index.foldedBasename.get(basenameTarget.toLowerCase()),
    index.nfcFoldedBasename.get(basenameTarget.normalize('NFC').toLowerCase()),
  ];
  for (const candidate of tiers) {
    if (!candidate) continue;
    if (candidate.status === 'unique') {
      return {
        status: 'resolved',
        path: candidate.document.path,
        types: candidate.document.types.slice(),
      };
    }
    return { status: 'ambiguous' };
  }
  return { status: 'unresolved' };
}

function stripMarkdownSuffix(value: string): string {
  return value.replace(/\.md$/i, '');
}

function add(
  map: Map<string, IndexedReferenceValue>,
  key: string,
  document: IndexedReferenceDocument,
): void {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { status: 'unique', document });
  } else if (existing.status === 'unique' && existing.document.path !== document.path) {
    map.set(key, { status: 'ambiguous' });
  }
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
