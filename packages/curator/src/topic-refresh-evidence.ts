import { createHash } from 'node:crypto';
import { withoutWikiLinks } from '@vault/contract';
import { truncate } from './evidence.js';

export const TOPIC_VAULT_SOURCE_EVIDENCE_VERSION = 1;
export const TOPIC_VAULT_SOURCE_TITLE_CHAR_CAP = 2_000;
export const CANONICAL_WEB_PROBE_VERSION = 1;
export const CANONICAL_WEB_PROBE_RESULT_CAP = 20;
export const CANONICAL_WEB_PROBE_URL_CHAR_CAP = 2_048;
export const CANONICAL_WEB_PROBE_TITLE_CHAR_CAP = 2_000;
export const CANONICAL_WEB_PROBE_SNIPPET_CHAR_CAP = 2_000;
export const CANONICAL_WEB_PROBE_PUBLISHED_CHAR_CAP = 128;
export const CANONICAL_WEB_PROBE_SNAPSHOT_CHAR_CAP = 64_000;

export type TopicVaultSourceEvidenceV1 =
  | {
      version: 1;
      nodeId: string;
      state: 'present';
      title: string;
      types: string[];
      bodyIncluded: boolean;
      body?: string;
    }
  | {
      version: 1;
      nodeId: string;
      state: 'missing';
    };

export interface TopicVaultSourceFingerprint {
  version: 1;
  hash: string;
  projection: TopicVaultSourceEvidenceV1;
}

export interface CanonicalWebProbeResult {
  url: string;
  title: string;
  snippet: string;
  published: string | null;
}

export interface CanonicalWebProbe {
  version: 1;
  hash: string;
  snapshotJson: string;
  results: CanonicalWebProbeResult[];
}

export type CanonicalWebProbeBuildResult =
  | { ok: true; probe: CanonicalWebProbe }
  | { ok: false; reason: 'web_probe_overflow' };

export type TopicVaultSourceFingerprintInput =
  | {
      nodeId: string;
      state: 'missing';
    }
  | {
      nodeId: string;
      state?: undefined;
      title: string;
      types: string[];
      bodyIncluded: boolean;
      renderedBody: string;
      /**
       * The body as wikis compare it (`comparableTopicBody`): links read as their words, then cut
       * at the cap. Read from `renderedBody` when absent, which is the same while no cap cuts it.
       */
      comparableBody?: string;
      /** Hash the body as written, links and all: how fingerprints were recorded before #332. */
      keepLinks?: boolean;
    };

/**
 * A topic source's body as wikis compare it (#332): trimmed, each link read as the words it shows,
 * then cut at `cap` like the rendered body. Reading links before the cut keeps a link from moving
 * the cut or the count of characters cut.
 */
export function comparableTopicBody(rawBody: string | null | undefined, cap: number | null): string {
  const trimmed = rawBody?.trim() ?? '';
  return trimmed === '' ? '' : truncate(withoutWikiLinks(trimmed), cap);
}

export interface CanonicalWebProbeInput {
  url: string;
  title: string;
  snippet: string;
  published: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedText(value: string, cap: number): string {
  return value.trim().slice(0, cap);
}

function normalizeType(value: string): string {
  return value.trim();
}

function validateNodeId(nodeId: string): void {
  if (!nodeId.trim()) throw new TypeError('nodeId must be non-empty');
}

export function topicVaultSourceFingerprint(
  input: TopicVaultSourceFingerprintInput,
): TopicVaultSourceFingerprint {
  validateNodeId(input.nodeId);

  const projection: TopicVaultSourceEvidenceV1 = input.state === 'missing'
    ? {
        version: TOPIC_VAULT_SOURCE_EVIDENCE_VERSION,
        nodeId: input.nodeId,
        state: 'missing',
      }
    : {
        version: TOPIC_VAULT_SOURCE_EVIDENCE_VERSION,
        nodeId: input.nodeId,
        state: 'present',
        title: boundedText(input.title, TOPIC_VAULT_SOURCE_TITLE_CHAR_CAP),
        types: [...new Set(input.types.map(normalizeType))]
          .filter((type): type is string => Boolean(type))
          .sort(),
        bodyIncluded: input.bodyIncluded,
        // Links read as the words they show (#332), so the link sweep linking a name is no change.
        ...(input.bodyIncluded ? { body: input.keepLinks ? input.renderedBody
          : input.comparableBody ?? withoutWikiLinks(input.renderedBody) } : {}),
      };
  const snapshotJson = JSON.stringify(projection);

  return {
    version: TOPIC_VAULT_SOURCE_EVIDENCE_VERSION,
    hash: sha256(snapshotJson),
    projection,
  };
}

function canonicalUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    const result = parsed.toString();
    return result.length <= CANONICAL_WEB_PROBE_URL_CHAR_CAP ? result : null;
  } catch {
    return null;
  }
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRecords(left: CanonicalWebProbeResult, right: CanonicalWebProbeResult): number {
  return compareText(JSON.stringify([left.title, left.snippet, left.published]), JSON.stringify([
    right.title,
    right.snippet,
    right.published,
  ]));
}

function serialize(results: CanonicalWebProbeResult[]): string {
  return JSON.stringify({ version: CANONICAL_WEB_PROBE_VERSION, results });
}

export function buildCanonicalWebProbe(
  input: readonly CanonicalWebProbeInput[],
): CanonicalWebProbeBuildResult {
  const byUrl = new Map<string, CanonicalWebProbeResult>();

  for (const item of input) {
    const url = canonicalUrl(item.url);
    if (url === null) return { ok: false, reason: 'web_probe_overflow' };
    const candidate: CanonicalWebProbeResult = {
      url,
      title: boundedText(item.title, CANONICAL_WEB_PROBE_TITLE_CHAR_CAP),
      snippet: boundedText(item.snippet, CANONICAL_WEB_PROBE_SNIPPET_CHAR_CAP),
      published: item.published === null
        ? null
        : boundedText(item.published, CANONICAL_WEB_PROBE_PUBLISHED_CHAR_CAP),
    };
    const existing = byUrl.get(url);
    if (existing === undefined || compareRecords(candidate, existing) < 0) byUrl.set(url, candidate);
  }

  const results = [...byUrl.values()]
    .sort((left, right) => compareText(left.url, right.url))
    .slice(0, CANONICAL_WEB_PROBE_RESULT_CAP);
  let snapshotJson = serialize(results);

  while (snapshotJson.length > CANONICAL_WEB_PROBE_SNAPSHOT_CHAR_CAP) {
    let reduced = false;
    for (const result of results) {
      if (result.snippet.length === 0) continue;
      result.snippet = result.snippet.slice(0, Math.floor(result.snippet.length / 2));
      reduced = true;
    }
    if (!reduced) return { ok: false, reason: 'web_probe_overflow' };
    snapshotJson = serialize(results);
  }

  return {
    ok: true,
    probe: {
      version: CANONICAL_WEB_PROBE_VERSION,
      hash: sha256(snapshotJson),
      snapshotJson,
      results,
    },
  };
}
