import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectConversation } from '@vault/chat-core/conversation-inspection';
import type { CaptureEvalExpected } from './capture-metrics.js';

export const CAPTURE_EVAL_REQUIRED_IDS = [
  'sourced-reference',
  'technical-explanation',
  'troubleshooting-conclusion',
  'reusable-framework',
  'routine-vault-operation',
  'transient-answer',
  'fully-captured-create',
  'fully-captured-append',
  'partially-captured-answer',
  'unrelated-update',
  'sourced-factual',
  'unsourced-factual',
  'multi-linked-routing',
  'protected-only',
  'unbound-multi-topic',
  'contradiction-append',
  'malformed-writer',
] as const;

type RequiredCaptureEvalId = (typeof CAPTURE_EVAL_REQUIRED_IDS)[number];

interface CaptureEvalCategoryManifest {
  expected: CaptureEvalExpected;
  receipt?: {
    mode: 'create' | 'append-body';
    requiresLinkedDestination: boolean;
    toolCallId?: string;
    destinationNodeId?: string;
    exactCoveredText?: string;
  };
}

const CAPTURE_EVAL_CATEGORY_MANIFEST: Record<RequiredCaptureEvalId, CaptureEvalCategoryManifest> = {
  'sourced-reference': {
    expected: { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: ['https://example.test/game/vehicles'] },
  },
  'technical-explanation': {
    expected: { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: [] },
  },
  'troubleshooting-conclusion': {
    expected: { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: [] },
  },
  'reusable-framework': {
    expected: { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: [] },
  },
  'routine-vault-operation': { expected: { shouldCapture: false, coverage: 'none' } },
  'transient-answer': { expected: { shouldCapture: false, coverage: 'none' } },
  'fully-captured-create': {
    expected: {
      shouldCapture: false, coverage: 'full', expectedCoveringToolCallIds: ['call-create'],
    },
    receipt: { mode: 'create', requiresLinkedDestination: false },
  },
  'fully-captured-append': {
    expected: {
      shouldCapture: false, coverage: 'full', expectedCoveringToolCallIds: ['call-append'],
    },
    receipt: { mode: 'append-body', requiresLinkedDestination: true },
  },
  'partially-captured-answer': {
    expected: {
      shouldCapture: true, coverage: 'partial', expectedArtifactCount: 1,
      expectedDestinationIds: ['queue-note'], expectedSourceUrls: [],
      expectedPartialMarkdownIncludes: ['queue age', 'depth', 'starvation'],
      expectedPartialMarkdownExcludes: ['Queue depth/backlog measures accumulated queued volume.'],
      expectedCoveringToolCallIds: ['call-partial'],
    },
    receipt: {
      mode: 'append-body',
      requiresLinkedDestination: true,
      toolCallId: 'call-partial',
      destinationNodeId: 'queue-note',
      exactCoveredText: 'Queue depth/backlog measures accumulated queued volume.',
    },
  },
  'unrelated-update': {
    expected: { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: [] },
  },
  'sourced-factual': {
    expected: { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: ['https://example.test/sqlite/wal'] },
  },
  'unsourced-factual': { expected: { shouldCapture: false, coverage: 'none' } },
  'multi-linked-routing': {
    expected: { shouldCapture: true, coverage: 'none', expectedArtifactCount: 2, expectedDestinationIds: ['node-routing-a', 'node-routing-b'], expectedSourceUrls: [] },
  },
  'protected-only': { expected: { shouldCapture: false, coverage: 'none' } },
  'unbound-multi-topic': {
    expected: { shouldCapture: true, coverage: 'none', expectedArtifactCount: 2, expectedDestinationIds: [], expectedSourceUrls: [] },
  },
  'contradiction-append': {
    expected: { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: ['retry-note'], expectedSourceUrls: [] },
  },
  'malformed-writer': {
    expected: { shouldCapture: false, coverage: 'none', coverageReliable: false },
  },
};

export interface CaptureEvalConversation {
  id: string;
  title: string;
  updated_at: string;
  messages: unknown[];
  linked_docs: string[];
}

export interface CaptureEvalLinkedNode {
  id: string;
  title: string;
  file_path: string;
  body_excerpt: string;
  fields: Record<string, unknown>;
}

export interface CaptureEvalFixture {
  id: string;
  conversation: CaptureEvalConversation;
  linked_nodes: CaptureEvalLinkedNode[];
  prior_captures: Array<{ capture_id: string; markdown: string }>;
  expected: CaptureEvalExpected;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const values = value.map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
  return values;
}

function exactNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function sameOptionalStringList(actual: string[] | undefined, expected: string[] | undefined): boolean {
  if (actual === undefined || expected === undefined) return actual === expected;
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sameExpectedLabels(actual: CaptureEvalExpected, expected: CaptureEvalExpected): boolean {
  return Object.keys(actual).length === Object.keys(expected).length
    && actual.shouldCapture === expected.shouldCapture
    && actual.coverage === expected.coverage
    && actual.coverageReliable === expected.coverageReliable
    && actual.expectedArtifactCount === expected.expectedArtifactCount
    && sameOptionalStringList(actual.expectedDestinationIds, expected.expectedDestinationIds)
    && sameOptionalStringList(actual.expectedSourceUrls, expected.expectedSourceUrls)
    && sameOptionalStringList(actual.expectedPartialMarkdownIncludes, expected.expectedPartialMarkdownIncludes)
    && sameOptionalStringList(actual.expectedPartialMarkdownExcludes, expected.expectedPartialMarkdownExcludes)
    && sameOptionalStringList(actual.expectedCoveringToolCallIds, expected.expectedCoveringToolCallIds)
    && sameOptionalStringList(actual.expectedCoveringCaptureIds, expected.expectedCoveringCaptureIds);
}

const RFC3339_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function strictRfc3339(value: string): boolean {
  const match = RFC3339_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    offsetSign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return false;
  if (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return false;
  if (offsetSign !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function parseExpected(value: unknown, label: string): CaptureEvalExpected {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const allowedKeys = new Set([
    'shouldCapture', 'expectedArtifactCount', 'expectedDestinationIds', 'expectedSourceUrls',
    'expectedPartialMarkdownIncludes', 'expectedPartialMarkdownExcludes',
    'expectedCoveringToolCallIds', 'expectedCoveringCaptureIds', 'coverage', 'coverageReliable',
  ]);
  const unexpectedKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpectedKey !== undefined) throw new Error(`${label}.${unexpectedKey} is not supported`);
  if (typeof value.shouldCapture !== 'boolean') throw new Error(`${label}.shouldCapture must be boolean`);
  if (value.coverage !== 'none' && value.coverage !== 'full' && value.coverage !== 'partial') {
    throw new Error(`${label}.coverage must be none, full, or partial`);
  }
  if (value.coverageReliable !== undefined && typeof value.coverageReliable !== 'boolean') {
    throw new Error(`${label}.coverageReliable must be boolean when present`);
  }
  const expected: CaptureEvalExpected = {
    shouldCapture: value.shouldCapture,
    coverage: value.coverage,
    ...(value.expectedArtifactCount === undefined ? {} : {
      expectedArtifactCount: exactNonNegativeInteger(value.expectedArtifactCount, `${label}.expectedArtifactCount`),
    }),
    ...(value.expectedDestinationIds === undefined ? {} : {
      expectedDestinationIds: stringList(value.expectedDestinationIds, `${label}.expectedDestinationIds`),
    }),
    ...(value.expectedSourceUrls === undefined ? {} : {
      expectedSourceUrls: stringList(value.expectedSourceUrls, `${label}.expectedSourceUrls`),
    }),
    ...(value.expectedPartialMarkdownIncludes === undefined ? {} : {
      expectedPartialMarkdownIncludes: stringList(
        value.expectedPartialMarkdownIncludes,
        `${label}.expectedPartialMarkdownIncludes`,
      ),
    }),
    ...(value.expectedPartialMarkdownExcludes === undefined ? {} : {
      expectedPartialMarkdownExcludes: stringList(
        value.expectedPartialMarkdownExcludes,
        `${label}.expectedPartialMarkdownExcludes`,
      ),
    }),
    ...(value.expectedCoveringToolCallIds === undefined ? {} : {
      expectedCoveringToolCallIds: stringList(
        value.expectedCoveringToolCallIds,
        `${label}.expectedCoveringToolCallIds`,
      ),
    }),
    ...(value.expectedCoveringCaptureIds === undefined ? {} : {
      expectedCoveringCaptureIds: stringList(
        value.expectedCoveringCaptureIds,
        `${label}.expectedCoveringCaptureIds`,
      ),
    }),
    ...(value.coverageReliable === undefined ? {} : { coverageReliable: value.coverageReliable }),
  };
  return expected;
}

function validateExpected(expected: CaptureEvalExpected, label: string): void {
  if (expected.shouldCapture) {
    if ((expected.expectedArtifactCount ?? 0) < 1) throw new Error(`${label} positive fixture needs expectedArtifactCount`);
    if (expected.expectedDestinationIds === undefined) throw new Error(`${label} positive fixture needs expectedDestinationIds`);
    if (expected.expectedSourceUrls === undefined) throw new Error(`${label} positive fixture needs expectedSourceUrls`);
  }
  if (expected.coverage === 'full' && expected.shouldCapture) throw new Error(`${label} full coverage must suppress capture`);
  if (expected.coverage === 'partial' && !expected.shouldCapture) throw new Error(`${label} partial coverage must retain capture value`);
  if (expected.coverage === 'partial') {
    if (expected.expectedPartialMarkdownIncludes === undefined) {
      throw new Error(`${label} partial coverage requires expectedPartialMarkdownIncludes`);
    }
    if (expected.expectedPartialMarkdownExcludes === undefined) {
      throw new Error(`${label} partial coverage requires expectedPartialMarkdownExcludes`);
    }
  } else if (expected.expectedPartialMarkdownIncludes !== undefined
    || expected.expectedPartialMarkdownExcludes !== undefined) {
    throw new Error(`${label} partial Markdown labels are allowed only for partial coverage`);
  }
  const expectedProofCount = (expected.expectedCoveringToolCallIds?.length ?? 0)
    + (expected.expectedCoveringCaptureIds?.length ?? 0);
  if ((expected.coverage === 'full' || expected.coverage === 'partial') && expectedProofCount === 0) {
    throw new Error(`${label} ${expected.coverage} coverage requires at least one expected covering id`);
  }
  if (expected.coverage === 'none' && expectedProofCount > 0) {
    throw new Error(`${label} none coverage cannot require covering ids`);
  }
}

function parseConversation(value: unknown, label: string): CaptureEvalConversation {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const updatedAt = text(value.updated_at, `${label}.updated_at`);
  if (!strictRfc3339(updatedAt)) throw new Error(`${label}.updated_at must be an RFC3339 timestamp`);
  if (!Array.isArray(value.messages)) throw new Error(`${label}.messages must be an opaque persisted-message array`);
  return {
    id: text(value.id, `${label}.id`),
    title: text(value.title, `${label}.title`, true),
    updated_at: updatedAt,
    messages: value.messages,
    linked_docs: stringList(value.linked_docs, `${label}.linked_docs`),
  };
}

function parseLinkedNodes(value: unknown, label: string): CaptureEvalLinkedNode[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const nodes = value.map((candidate, index): CaptureEvalLinkedNode => {
    const itemLabel = `${label}[${index}]`;
    if (!isRecord(candidate)) throw new Error(`${itemLabel} must be an object`);
    if (candidate.fields !== undefined && !isRecord(candidate.fields)) throw new Error(`${itemLabel}.fields must be an object`);
    return {
      id: text(candidate.id, `${itemLabel}.id`),
      title: text(candidate.title, `${itemLabel}.title`, true),
      file_path: text(candidate.file_path, `${itemLabel}.file_path`),
      body_excerpt: text(candidate.body_excerpt, `${itemLabel}.body_excerpt`, true),
      fields: candidate.fields ?? {},
    };
  });
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error(`${label} contains duplicate node ids`);
  return nodes;
}

function parsePriorCaptures(value: unknown, label: string): Array<{ capture_id: string; markdown: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const captures = value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`${label}[${index}] must be an object`);
    return {
      capture_id: text(candidate.capture_id, `${label}[${index}].capture_id`),
      markdown: text(candidate.markdown, `${label}[${index}].markdown`),
    };
  });
  if (new Set(captures.map((capture) => capture.capture_id)).size !== captures.length) {
    throw new Error(`${label} contains duplicate capture ids`);
  }
  return captures;
}

function parseFixture(value: unknown, index: number): CaptureEvalFixture {
  const label = `capture corpus entry[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if ('inspection' in value || 'plannerInput' in value || 'planner_input' in value) {
    throw new Error(`${label} must contain opaque persisted messages, not pre-sanitized planner input`);
  }
  const fixture: CaptureEvalFixture = {
    id: text(value.id, `${label}.id`),
    conversation: parseConversation(value.conversation, `${label}.conversation`),
    linked_nodes: parseLinkedNodes(value.linked_nodes, `${label}.linked_nodes`),
    prior_captures: parsePriorCaptures(value.prior_captures, `${label}.prior_captures`),
    expected: parseExpected(value.expected, `${label}.expected`),
  };

  const manifest = CAPTURE_EVAL_CATEGORY_MANIFEST[fixture.id as RequiredCaptureEvalId];
  if (manifest !== undefined && !sameExpectedLabels(fixture.expected, manifest.expected)) {
    throw new Error(`${label} canonical labels for "${fixture.id}" do not match the approved manifest`);
  }
  validateExpected(fixture.expected, `${label}.expected`);

  const linkedDocs = new Set(fixture.conversation.linked_docs);
  const linkedNodes = new Set(fixture.linked_nodes.map((node) => node.id));
  for (const nodeId of linkedDocs) {
    if (!linkedNodes.has(nodeId)) throw new Error(`${label} linked doc "${nodeId}" has no linked-node snapshot`);
  }
  for (const nodeId of linkedNodes) {
    if (!linkedDocs.has(nodeId)) throw new Error(`${label} linked-node snapshot "${nodeId}" is not linked`);
  }
  for (const destinationId of fixture.expected.expectedDestinationIds ?? []) {
    if (!linkedDocs.has(destinationId) || !linkedNodes.has(destinationId)) {
      throw new Error(`${label} expected destination "${destinationId}" is not a linked snapshot`);
    }
  }

  const inspection = inspectConversation(fixture.conversation.messages);
  const expectedReliability = fixture.expected.coverageReliable ?? true;
  if (inspection.coverageReliable !== expectedReliability) {
    throw new Error(`${label} expected coverageReliable=${expectedReliability} disagrees with production inspection`);
  }
  const observedUrls = new Set(inspection.sources.map((source) => source.url));
  for (const sourceUrl of fixture.expected.expectedSourceUrls ?? []) {
    if (!observedUrls.has(sourceUrl)) throw new Error(`${label} expected source URL "${sourceUrl}" was not observed`);
  }
  if ((fixture.expected.coverage === 'full' || fixture.expected.coverage === 'partial')
    && inspection.writeReceipts.length === 0) {
    throw new Error(`${label} coverage fixture needs an actual terminal body-writer receipt`);
  }
  if (manifest?.receipt !== undefined) {
    const receiptInvariant = manifest.receipt;
    const matchingReceipt = inspection.writeReceipts.some((receipt) => (
      receipt.mode === receiptInvariant.mode
      && (receiptInvariant.toolCallId === undefined
        || receipt.toolCallId === receiptInvariant.toolCallId)
      && (receiptInvariant.destinationNodeId === undefined
        || receipt.destinationNodeId === receiptInvariant.destinationNodeId)
      && (!receiptInvariant.requiresLinkedDestination
        || (receipt.destinationNodeId !== undefined && linkedDocs.has(receipt.destinationNodeId)))
      && (receiptInvariant.exactCoveredText === undefined
        || receipt.writtenText === receiptInvariant.exactCoveredText)
    ));
    if (!matchingReceipt) {
      const linked = receiptInvariant.requiresLinkedDestination ? 'linked ' : '';
      const proof = receiptInvariant.toolCallId === undefined ? '' : ` ${receiptInvariant.toolCallId}`;
      const exact = receiptInvariant.exactCoveredText === undefined ? '' : ' with the exact covered component';
      throw new Error(`${label} "${fixture.id}" requires a ${linked}terminal${proof} ${receiptInvariant.mode} receipt${exact} for its category`);
    }
  }
  const observedToolCallIds = new Set(inspection.writeReceipts.map((receipt) => receipt.toolCallId));
  for (const toolCallId of fixture.expected.expectedCoveringToolCallIds ?? []) {
    if (!observedToolCallIds.has(toolCallId)) {
      throw new Error(`${label} expected covering tool call "${toolCallId}" was not observed`);
    }
  }
  const observedCaptureIds = new Set(fixture.prior_captures.map((capture) => capture.capture_id));
  for (const captureId of fixture.expected.expectedCoveringCaptureIds ?? []) {
    if (!observedCaptureIds.has(captureId)) {
      throw new Error(`${label} expected covering capture "${captureId}" was not observed`);
    }
  }
  return fixture;
}

export function captureEvalCorpusPath(): string {
  return fileURLToPath(new URL('../../eval/capture-corpus.json', import.meta.url));
}

/** Parse and validate opaque persisted-message capture fixtures. */
export function loadCaptureEvalCorpus(path: string | URL = captureEvalCorpusPath()): CaptureEvalFixture[] {
  const displayPath = path instanceof URL ? fileURLToPath(path) : path;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`capture corpus JSON failure at ${displayPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`capture corpus at ${displayPath} must be an array`);
  const fixtures = parsed.map(parseFixture);
  const ids = new Set<string>();
  const conversationIds = new Set<string>();
  for (const fixture of fixtures) {
    if (ids.has(fixture.id)) throw new Error(`duplicate fixture id "${fixture.id}"`);
    ids.add(fixture.id);
    if (conversationIds.has(fixture.conversation.id)) {
      throw new Error(`duplicate conversation id "${fixture.conversation.id}"`);
    }
    conversationIds.add(fixture.conversation.id);
  }
  for (const requiredId of CAPTURE_EVAL_REQUIRED_IDS) {
    if (!ids.has(requiredId)) throw new Error(`capture corpus missing required fixture "${requiredId}"`);
  }
  return fixtures;
}
