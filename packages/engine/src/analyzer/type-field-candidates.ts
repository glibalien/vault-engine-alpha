import type { YamlValue } from '../parser/types.js';
import { tagCandidates } from './tags.js';
import { BoundedLexicographicStringSamples } from './bounded-samples.js';
import { scanRoot, type ScanSnapshot } from './scan.js';
import {
  ANALYZER_FORMAT_VERSION,
  ANALYZER_VERSION,
  invalidArguments,
  type AnalyzerResult,
  type TypeFieldCandidate,
  type TypeFieldCandidateReportV2,
} from './report.js';
import { parseExclusions } from './relative-directory.js';

const MAX_CANDIDATES = 50;
const MAX_SAMPLE_VALUES = 10;
const CONVENTIONAL_RANK = new Map([
  ['types', 0],
  ['type', 1],
  ['kind', 2],
  ['entity', 3],
]);

export function normalizeTypeValue(value: string): string | null {
  const trimmed = value.trim();
  const wholeLink = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(trimmed);
  const normalized = (wholeLink?.[1] ?? trimmed).trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeNestedWikiLinkValue(value: string): string | null {
  const normalized = normalizeTypeValue(value);
  if (normalized === null) return null;
  const aliasSeparator = normalized.indexOf('|');
  const canonical = (aliasSeparator === -1
    ? normalized
    : normalized.slice(0, aliasSeparator)).trim();
  return canonical.length > 0 ? canonical : null;
}

export function extractCandidateOccurrence(value: YamlValue): {
  accepted: string[];
  validShape: boolean;
} {
  if (typeof value === 'string') {
    const normalized = normalizeTypeValue(value);
    return { accepted: normalized ? [normalized] : [], validShape: normalized !== null };
  }
  if (
    Array.isArray(value) && value.length === 1 && Array.isArray(value[0])
    && value[0].length === 1 && typeof value[0][0] === 'string'
  ) {
    const normalized = normalizeNestedWikiLinkValue(value[0][0]);
    return { accepted: normalized ? [normalized] : [], validShape: normalized !== null };
  }
  if (!Array.isArray(value)) return { accepted: [], validShape: false };
  const accepted = value
    .filter((item): item is string => typeof item === 'string')
    .map(normalizeTypeValue)
    .filter((item): item is string => item !== null);
  return {
    accepted,
    validShape: value.length > 0
      && value.every(item => typeof item === 'string')
      && accepted.length > 0,
  };
}

interface CandidateAccumulator {
  key: string;
  eligible: boolean;
  documentsWithKey: number;
  validOccurrences: number;
  invalidOccurrences: number;
  acceptedValueOccurrences: number;
  distinctValues: Set<string>;
  samples: BoundedLexicographicStringSamples;
}

export function buildTypeFieldCandidateReport(snapshot: ScanSnapshot): TypeFieldCandidateReportV2 {
  const accumulators = new Map<string, CandidateAccumulator>();
  for (const file of snapshot.files) {
    if (file.unreadable || file.frontmatter === null || file.frontmatter.parseError !== null) continue;
    for (const [key, value] of Object.entries(file.frontmatter.data)) {
      let accumulator = accumulators.get(key);
      if (!accumulator) {
        accumulator = {
          key,
          eligible: false,
          documentsWithKey: 0,
          validOccurrences: 0,
          invalidOccurrences: 0,
          acceptedValueOccurrences: 0,
          distinctValues: new Set(),
          samples: new BoundedLexicographicStringSamples(MAX_SAMPLE_VALUES),
        };
        accumulators.set(key, accumulator);
      }
      accumulator.eligible ||= isCandidateValue(value);
      accumulator.documentsWithKey++;
      const occurrence = extractCandidateOccurrence(value);
      if (occurrence.validShape) {
        accumulator.validOccurrences++;
      } else {
        accumulator.invalidOccurrences++;
      }
      for (const accepted of occurrence.accepted) {
        accumulator.acceptedValueOccurrences++;
        accumulator.distinctValues.add(accepted);
        accumulator.samples.add(accepted);
      }
    }
  }

  const candidates = [...accumulators.values()]
    .filter(accumulator => accumulator.eligible)
    .map(accumulator => toCandidate(accumulator, snapshot.inventory.markdown_files))
    .sort(compareCandidates);

  return {
    format_version: ANALYZER_FORMAT_VERSION,
    analyzer_version: ANALYZER_VERSION,
    source: {
      canonical_root: snapshot.canonicalRoot,
      source_fingerprint: snapshot.sourceFingerprint,
      exclusions: snapshot.exclusions,
    },
    inventory: snapshot.inventory,
    folders: snapshot.folders,
    folders_truncated: snapshot.foldersTruncated,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    candidates_truncated: candidates.length > MAX_CANDIDATES,
    tags: tagCandidates(snapshot.files
      .filter(file => !file.unreadable && file.frontmatter !== null && file.frontmatter.parseError === null)
      .map(file => file.tags)),
    issues: snapshot.issues,
  };
}

export async function discoverTypeFields(
  input: { root: string; exclude?: string[] },
): Promise<AnalyzerResult<TypeFieldCandidateReportV2>> {
  if (typeof input?.root !== 'string' || input.root.trim() === '') {
    return invalidArguments('root must be a non-empty string');
  }
  const exclusions = parseExclusions(input.exclude);
  if (!exclusions.ok) return exclusions;
  // An empty folder is a valid answer to "what is here?"; Vault Installer plans it as a new vault.
  const scanned = await scanRoot(input.root, { exclude: exclusions.data, allowEmpty: true });
  if (!scanned.ok) return scanned;
  return { ok: true, data: buildTypeFieldCandidateReport(scanned.data) };
}

function isCandidateValue(value: YamlValue): boolean {
  if (typeof value === 'string') return true;
  if (!Array.isArray(value)) return false;
  return value.some(item => typeof item === 'string')
    || (value.length === 1 && Array.isArray(value[0])
      && value[0].length === 1 && typeof value[0][0] === 'string');
}

function toCandidate(
  accumulator: CandidateAccumulator,
  markdownFiles: number,
): TypeFieldCandidate {
  const allOccurrences = accumulator.validOccurrences + accumulator.invalidOccurrences;
  const repeatedValueRatio = accumulator.acceptedValueOccurrences === 0
    ? 0
    : clamp(1 - (accumulator.distinctValues.size / accumulator.acceptedValueOccurrences));
  return {
    key: accumulator.key,
    documents_with_key: accumulator.documentsWithKey,
    valid_occurrences: accumulator.validOccurrences,
    invalid_occurrences: accumulator.invalidOccurrences,
    markdown_coverage: markdownFiles === 0 ? 0 : accumulator.documentsWithKey / markdownFiles,
    valid_shape_ratio: allOccurrences === 0 ? 0 : accumulator.validOccurrences / allOccurrences,
    distinct_values: accumulator.distinctValues.size,
    repeated_value_ratio: repeatedValueRatio,
    sample_values: accumulator.samples.values(),
    conventional_name: CONVENTIONAL_RANK.has(accumulator.key),
  };
}

function compareCandidates(left: TypeFieldCandidate, right: TypeFieldCandidate): number {
  const leftRank = CONVENTIONAL_RANK.get(left.key) ?? Number.POSITIVE_INFINITY;
  const rightRank = CONVENTIONAL_RANK.get(right.key) ?? Number.POSITIVE_INFINITY;
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.valid_occurrences !== right.valid_occurrences) {
    return right.valid_occurrences - left.valid_occurrences;
  }
  if (left.valid_shape_ratio !== right.valid_shape_ratio) {
    return right.valid_shape_ratio - left.valid_shape_ratio;
  }
  if (left.repeated_value_ratio !== right.repeated_value_ratio) {
    return right.repeated_value_ratio - left.repeated_value_ratio;
  }
  return compareExact(left.key, right.key);
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
