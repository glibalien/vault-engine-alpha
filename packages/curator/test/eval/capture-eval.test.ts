import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectConversation } from '@vault/chat-core/conversation-inspection';
import { effectiveSettings, type CuratorSettings } from '@vault/settings-registry';
import {
  CAPTURE_EVAL_REQUIRED_IDS,
  captureEvalCorpusPath,
  loadCaptureEvalCorpus,
  type CaptureEvalFixture,
} from '../../src/eval/capture-corpus.js';
import {
  computeCaptureEvalMetrics,
  evaluateCaptureEvalSafety,
  findUnsupportedCaptureUrls,
  type CaptureEvalRow,
} from '../../src/eval/capture-metrics.js';
import {
  captureEvalExitCode,
  createOfflineCaptureEvalLlm,
  evaluateCaptureEvalFixture,
  offlineCaptureEvalConfig,
  parseCaptureEvalArgs,
  resolveReadOnlyCaptureEvalConfig,
  runCaptureEval,
} from '../../src/eval-capture.js';
import { StructuredCallFailure } from '../../src/llm/types.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writeCorpus(value: unknown): string {
  const path = join(temporaryDirectory('capture-corpus-test-'), 'corpus.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('capture evaluation corpus', () => {
  it('loads every required opaque persisted-message category with exact observable labels', () => {
    const corpus = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const ids = corpus.map((fixture) => fixture.id);

    expect(ids).toHaveLength(new Set(ids).size);
    expect(ids).toEqual(expect.arrayContaining([...CAPTURE_EVAL_REQUIRED_IDS]));
    expect(ids).toHaveLength(17);

    for (const fixture of corpus) {
      expect(Array.isArray(fixture.conversation.messages)).toBe(true);
      expect(fixture).not.toHaveProperty('inspection');
      expect(fixture).not.toHaveProperty('plannerInput');

      const inspection = inspectConversation(fixture.conversation.messages);
      expect(inspection.coverageReliable).toBe(fixture.expected.coverageReliable ?? true);
      for (const expectedUrl of fixture.expected.expectedSourceUrls ?? []) {
        expect(inspection.sources.map((source) => source.url)).toContain(expectedUrl);
      }
      for (const destinationId of fixture.expected.expectedDestinationIds ?? []) {
        expect(fixture.conversation.linked_docs).toContain(destinationId);
        expect(fixture.linked_nodes.map((node) => node.id)).toContain(destinationId);
      }
      if (fixture.expected.shouldCapture) {
        expect(fixture.expected.expectedArtifactCount).toBeGreaterThan(0);
        expect(fixture.expected.expectedDestinationIds).toBeDefined();
        expect(fixture.expected.expectedSourceUrls).toBeDefined();
      }
      if (fixture.expected.coverage === 'full' || fixture.expected.coverage === 'partial') {
        expect(inspection.writeReceipts.length).toBeGreaterThan(0);
      }
    }

    expect(corpus.find((fixture) => fixture.id === 'sourced-reference')).toMatchObject({
      expected: {
        shouldCapture: true,
        expectedArtifactCount: 1,
        expectedDestinationIds: [],
        expectedSourceUrls: ['https://example.test/game/vehicles'],
        coverage: 'none',
      },
    });
    expect(corpus.find((fixture) => fixture.id === 'multi-linked-routing')).toMatchObject({
      expected: { shouldCapture: true, expectedDestinationIds: ['node-routing-a', 'node-routing-b'] },
    });
    expect(corpus.find((fixture) => fixture.id === 'unbound-multi-topic')).toMatchObject({
      expected: { shouldCapture: true, expectedArtifactCount: 2, expectedDestinationIds: [] },
    });
    const fullyCapturedAppend = corpus.find((fixture) => fixture.id === 'fully-captured-append')!;
    const appendReceipt = inspectConversation(fullyCapturedAppend.conversation.messages).writeReceipts[0]!;
    expect(appendReceipt.writtenText).toMatch(/advisory lock/i);
    expect(appendReceipt.writtenText).toMatch(/dedicated migration role/i);
    expect(inspectConversation(corpus.find((fixture) => fixture.id === 'unrelated-update')!.conversation.messages).writeReceipts).toEqual([
      expect.objectContaining({ destinationNodeId: 'shopping', writtenText: 'Purchased oats today.' }),
    ]);
    expect(corpus.find((fixture) => fixture.id === 'malformed-writer')).toMatchObject({
      expected: { shouldCapture: false, coverage: 'none', coverageReliable: false },
    });

    const partial = corpus.find((fixture) => fixture.id === 'partially-captured-answer')!;
    const partialInspection = inspectConversation(partial.conversation.messages);
    const partialAssistantText = partialInspection.turns.find((turn) => turn.role === 'assistant')?.text ?? '';
    expect(partialAssistantText).toMatch(/queue depth\/backlog.*queue age.*starvation/is);
    expect(partialAssistantText).not.toMatch(/worker concurrency/i);
    expect(partialInspection.writeReceipts).toEqual([
      expect.objectContaining({
        toolCallId: 'call-partial',
        writtenText: 'Queue depth/backlog measures accumulated queued volume.',
      }),
    ]);
    expect(partial.expected.expectedPartialMarkdownExcludes).toEqual([
      'Queue depth/backlog measures accumulated queued volume.',
    ]);
  });

  it('rejects duplicate fixture ids, invalid linked destinations, and unobserved expected URLs', () => {
    const corpus = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const valid = corpus[0]!;
    expect(() => loadCaptureEvalCorpus(writeCorpus([valid, valid]))).toThrow(/duplicate fixture id/i);

    expect(() => loadCaptureEvalCorpus(writeCorpus([...corpus, {
      ...valid,
      id: 'generic-invalid-destination',
      conversation: { ...valid.conversation, id: 'c-generic-invalid-destination' },
      expected: { ...valid.expected, expectedDestinationIds: ['not-linked'] },
    }]))).toThrow(/expected destination.*not-linked.*linked/i);

    expect(() => loadCaptureEvalCorpus(writeCorpus([...corpus, {
      ...valid,
      id: 'generic-unobserved-source',
      conversation: { ...valid.conversation, id: 'c-generic-unobserved-source' },
      expected: { ...valid.expected, expectedSourceUrls: ['https://invented.test/'] },
    }]))).toThrow(/expected source URL.*not observed/i);
  });

  it('rejects expected reliability labels that disagree with production inspection', () => {
    const corpus = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const valid = corpus[0]!;
    expect(() => loadCaptureEvalCorpus(writeCorpus([...corpus, {
      ...valid,
      id: 'generic-invalid-reliability',
      conversation: { ...valid.conversation, id: 'c-generic-invalid-reliability' },
      expected: { ...valid.expected, coverageReliable: false },
    }]))).toThrow(/coverageReliable.*inspection/i);
  });

  it('rejects duplicate conversation ids and non-RFC3339 persisted timestamps', () => {
    const corpus = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const duplicateConversation = corpus.map((fixture, index) => index === 1
      ? { ...fixture, conversation: { ...fixture.conversation, id: corpus[0]!.conversation.id } }
      : fixture);
    expect(() => loadCaptureEvalCorpus(writeCorpus(duplicateConversation))).toThrow(/duplicate conversation id/i);

    const looseTimestamp = corpus.map((fixture, index) => index === 0
      ? { ...fixture, conversation: { ...fixture.conversation, updated_at: 'August 20, 2026' } }
      : fixture);
    expect(() => loadCaptureEvalCorpus(writeCorpus(looseTimestamp))).toThrow(/RFC3339/i);
  });

  it.each([
    ['sourced-reference', { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: ['https://example.test/game/vehicles'] }],
    ['technical-explanation', { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: [] }],
    ['troubleshooting-conclusion', { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: [] }],
    ['reusable-framework', { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: [] }],
    ['routine-vault-operation', { shouldCapture: false, coverage: 'none' }],
    ['transient-answer', { shouldCapture: false, coverage: 'none' }],
    ['fully-captured-create', { shouldCapture: false, coverage: 'full', expectedCoveringToolCallIds: ['call-create'] }],
    ['fully-captured-append', { shouldCapture: false, coverage: 'full', expectedCoveringToolCallIds: ['call-append'] }],
    ['partially-captured-answer', {
      shouldCapture: true, coverage: 'partial', expectedArtifactCount: 1,
      expectedDestinationIds: ['queue-note'], expectedSourceUrls: [],
      expectedPartialMarkdownIncludes: ['queue age', 'depth', 'starvation'],
      expectedPartialMarkdownExcludes: ['Queue depth/backlog measures accumulated queued volume.'],
      expectedCoveringToolCallIds: ['call-partial'],
    }],
    ['unrelated-update', { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: [] }],
    ['sourced-factual', { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: ['https://example.test/sqlite/wal'] }],
    ['unsourced-factual', { shouldCapture: false, coverage: 'none' }],
    ['multi-linked-routing', { shouldCapture: true, coverage: 'none', expectedArtifactCount: 2, expectedDestinationIds: ['node-routing-a', 'node-routing-b'], expectedSourceUrls: [] }],
    ['protected-only', { shouldCapture: false, coverage: 'none' }],
    ['unbound-multi-topic', { shouldCapture: true, coverage: 'none', expectedArtifactCount: 2, expectedDestinationIds: [], expectedSourceUrls: [] }],
    ['contradiction-append', { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: ['retry-note'], expectedSourceUrls: [] }],
    ['malformed-writer', { shouldCapture: false, coverage: 'none', coverageReliable: false }],
  ] as const)('enforces the fixed label manifest for %s', (id, expected) => {
    const corpus = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const index = corpus.findIndex((fixture) => fixture.id === id);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(corpus[index]!.expected).toEqual(expected);

    const invalidExpected = expected.shouldCapture
      ? { ...expected, expectedArtifactCount: (expected.expectedArtifactCount ?? 0) + 1 }
      : { ...expected, coverage: expected.coverage === 'full' ? 'none' : 'full' };
    corpus[index] = { ...corpus[index]!, expected: invalidExpected } as CaptureEvalFixture;
    expect(() => loadCaptureEvalCorpus(writeCorpus(corpus))).toThrow(new RegExp(`canonical labels.*${id}`, 'i'));
  });

  it('requires proof labels for covered fixtures and content labels only for partial fixtures', () => {
    const corpus = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const partialIndex = corpus.findIndex((fixture) => fixture.id === 'partially-captured-answer');
    const partial = corpus[partialIndex]!;
    corpus.push({
      ...partial,
      id: 'generic-partial-missing-labels',
      conversation: { ...partial.conversation, id: 'c-generic-partial-missing-labels' },
      expected: { ...partial.expected, expectedPartialMarkdownIncludes: undefined },
    });
    expect(() => loadCaptureEvalCorpus(writeCorpus(corpus))).toThrow(/partial.*markdown.*includes/i);

    const fresh = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const noneIndex = fresh.findIndex((fixture) => fixture.id === 'technical-explanation');
    fresh.push({
      ...fresh[noneIndex]!,
      id: 'generic-none-with-partial-labels',
      conversation: { ...fresh[noneIndex]!.conversation, id: 'c-generic-none-with-partial-labels' },
      expected: {
        ...fresh[noneIndex]!.expected,
        expectedPartialMarkdownIncludes: ['must not be accepted'],
        expectedPartialMarkdownExcludes: [],
      },
    });
    expect(() => loadCaptureEvalCorpus(writeCorpus(fresh))).toThrow(/partial markdown.*only.*partial/i);

    const withoutProof = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const fullIndex = withoutProof.findIndex((fixture) => fixture.id === 'fully-captured-create');
    withoutProof.push({
      ...withoutProof[fullIndex]!,
      id: 'generic-full-without-proof',
      conversation: { ...withoutProof[fullIndex]!.conversation, id: 'c-generic-full-without-proof' },
      expected: { ...withoutProof[fullIndex]!.expected, expectedCoveringToolCallIds: [] },
    });
    expect(() => loadCaptureEvalCorpus(writeCorpus(withoutProof))).toThrow(/full.*covering.*id/i);
  });

  it('rejects expected proof ids that are not present in the fixture evidence', () => {
    const corpus = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const fullIndex = corpus.findIndex((fixture) => fixture.id === 'fully-captured-create');
    corpus.push({
      ...corpus[fullIndex]!,
      id: 'generic-full-invented-proof',
      conversation: { ...corpus[fullIndex]!.conversation, id: 'c-generic-full-invented-proof' },
      expected: { ...corpus[fullIndex]!.expected, expectedCoveringToolCallIds: ['invented-call'] },
    });
    expect(() => loadCaptureEvalCorpus(writeCorpus(corpus))).toThrow(/expected covering tool call.*not observed/i);
  });

  it.each([
    ['technical-explanation', { shouldCapture: false, coverage: 'none' }],
    ['routine-vault-operation', { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: [] }],
    ['fully-captured-create', { shouldCapture: true, coverage: 'partial', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: [] }],
    ['partially-captured-answer', { shouldCapture: false, coverage: 'full' }],
    ['unbound-multi-topic', { shouldCapture: true, coverage: 'none', expectedArtifactCount: 1, expectedDestinationIds: [], expectedSourceUrls: [] }],
    ['multi-linked-routing', { shouldCapture: true, coverage: 'none', expectedArtifactCount: 2, expectedDestinationIds: ['node-routing-a'], expectedSourceUrls: [] }],
    ['malformed-writer', { shouldCapture: false, coverage: 'none' }],
  ] as const)('rejects a category-changing label mutation for %s', (id, expected) => {
    const corpus = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const index = corpus.findIndex((fixture) => fixture.id === id);
    corpus[index] = { ...corpus[index]!, expected } as CaptureEvalFixture;
    expect(() => loadCaptureEvalCorpus(writeCorpus(corpus))).toThrow(new RegExp(`canonical labels.*${id}`, 'i'));
  });

  it.each([
    ['fully-captured-create', 'create', 'fully-captured-append'],
    ['fully-captured-append', 'append-body', 'fully-captured-create'],
    ['partially-captured-answer', 'append-body', 'fully-captured-create'],
  ] as const)('requires the %s terminal writer category to include a %s receipt', (id, mode, replacementId) => {
    const corpus = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const targetIndex = corpus.findIndex((fixture) => fixture.id === id);
    const replacement = corpus.find((fixture) => fixture.id === replacementId)!;
    corpus[targetIndex] = {
      ...corpus[targetIndex]!,
      conversation: { ...corpus[targetIndex]!.conversation, messages: replacement.conversation.messages },
    };
    expect(() => loadCaptureEvalCorpus(writeCorpus(corpus))).toThrow(new RegExp(`${id}.*${mode} receipt`, 'i'));
  });

  it('requires append coverage receipts to target a linked node', () => {
    const corpus = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const targetIndex = corpus.findIndex((fixture) => fixture.id === 'fully-captured-append');
    corpus[targetIndex] = {
      ...corpus[targetIndex]!,
      conversation: { ...corpus[targetIndex]!.conversation, linked_docs: ['different-note'] },
      linked_nodes: [{
        id: 'different-note', title: 'Different note', file_path: 'Notes/Different.md',
        body_excerpt: 'Unrelated existing content.', fields: {},
      }],
    };

    expect(() => loadCaptureEvalCorpus(writeCorpus(corpus))).toThrow(/fully-captured-append.*linked.*append-body receipt/i);
  });

  it('requires the representative partial receipt to contain the exact excluded covered component', () => {
    const corpus = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const targetIndex = corpus.findIndex((fixture) => fixture.id === 'partially-captured-answer');
    const target = corpus[targetIndex]!;
    const messages = structuredClone(target.conversation.messages) as Array<{
      parts?: Array<Record<string, unknown> & {
        input?: { node_id?: string; append_body?: string; dry_run?: boolean };
      }>;
    }>;
    const parts = messages[1]!.parts!;
    parts[1]!.input!.append_body = 'A different queue-health component was saved.';
    parts.push({
      type: 'dynamic-tool',
      toolName: 'update-node',
      toolCallId: 'call-other-partial',
      state: 'output-available',
      input: {
        node_id: 'queue-note',
        append_body: 'Queue depth/backlog measures accumulated queued volume.',
        dry_run: false,
      },
      output: { ok: true, data: { node_id: 'queue-note' } },
    });
    corpus[targetIndex] = {
      ...target,
      conversation: { ...target.conversation, messages },
    };

    expect(() => loadCaptureEvalCorpus(writeCorpus(corpus)))
      .toThrow(/partially-captured-answer.*call-partial.*exact.*covered component/i);
  });
});

function row(
  expected: CaptureEvalRow['expected'],
  actual: Partial<CaptureEvalRow['actual']>,
  coverageAdjudications: CaptureEvalRow['coverageAdjudications'] = [],
): CaptureEvalRow {
  return {
    expected,
    coverageAdjudications,
    actual: {
      captured: false,
      artifactCount: 0,
      destinationIds: [],
      sourceUrls: [],
      unsupportedUrls: [],
      retainedPartialValue: false,
      ...actual,
    },
  };
}

describe('capture evaluation metrics', () => {
  it('uses the specified row/source denominators for precision, coverage, routing, and fidelity', () => {
    const rows: CaptureEvalRow[] = [
      row({ shouldCapture: true, expectedArtifactCount: 1, expectedDestinationIds: ['n1'], expectedSourceUrls: ['https://source.test/'], coverage: 'none' }, {
        captured: true, artifactCount: 1, destinationIds: ['n1'], sourceUrls: ['https://source.test/'],
      }),
      row({
        shouldCapture: true, expectedArtifactCount: 1,
        expectedDestinationIds: ['n2'], expectedSourceUrls: ['https://expected.test/'], coverage: 'partial',
        expectedPartialMarkdownIncludes: ['missing lesson'], expectedPartialMarkdownExcludes: ['prior fix'],
        expectedCoveringToolCallIds: ['call-partial'],
      }, {
        captured: true, artifactCount: 1, destinationIds: ['wrong'], sourceUrls: ['https://unsupported.test/'],
        unsupportedUrls: ['https://unsupported.test/'], retainedPartialValue: false,
      }),
      row({ shouldCapture: false, coverage: 'none' }, {
        captured: true, artifactCount: 1, sourceUrls: ['ftp://unsupported.test/file'],
        unsupportedUrls: ['ftp://unsupported.test/file'],
      }),
      row({ shouldCapture: false, coverage: 'none' }, {}),
      row({ shouldCapture: false, coverage: 'full', expectedCoveringToolCallIds: ['call-full'] }, {}, [{
        artifactKey: 'full-1', decision: 'full', coveringToolCallIds: ['call-full'],
        coveringCaptureIds: [], missingBrief: '',
      }]),
      row({ shouldCapture: false, coverage: 'full', expectedCoveringToolCallIds: ['call-full'] }, {
        captured: true, artifactCount: 1,
      }, [{
        artifactKey: 'full-1', decision: 'full', coveringToolCallIds: ['call-full'],
        coveringCaptureIds: [], missingBrief: '',
      }]),
    ];

    expect(computeCaptureEvalMetrics(rows)).toEqual({
      worthwhilePrecision: 0.5,
      falsePositiveRate: 0.5,
      fullCoverageSuppressionAccuracy: 0.5,
      partialCoverageRetentionAccuracy: 0,
      destinationRoutingAccuracy: 0.5,
      groundingSourceFidelity: 0.5,
      unsupportedUrlRate: 2 / 3,
    });
  });

  it('credits full suppression only with a sanitized full decision and exact expected proof', () => {
    const expected = {
      shouldCapture: false, coverage: 'full' as const, expectedCoveringToolCallIds: ['call-full'],
    };
    expect(computeCaptureEvalMetrics([
      row(expected, {}, [{
        artifactKey: 'full-1', decision: 'full', coveringToolCallIds: ['wrong-call'],
        coveringCaptureIds: [], missingBrief: '',
      }]),
    ]).fullCoverageSuppressionAccuracy).toBe(0);
    expect(computeCaptureEvalMetrics([
      row(expected, {}, [{
        artifactKey: 'full-1', decision: 'full', coveringToolCallIds: ['call-full'],
        coveringCaptureIds: [], missingBrief: '',
      }]),
    ]).fullCoverageSuppressionAccuracy).toBe(1);
  });

  it('requires capture emission before an expected positive earns routing or source-fidelity credit', () => {
    const rows: CaptureEvalRow[] = [
      row({
        shouldCapture: true, expectedArtifactCount: 1,
        expectedDestinationIds: [], expectedSourceUrls: [], coverage: 'none',
      }, {}),
      row({
        shouldCapture: true, expectedArtifactCount: 1,
        expectedDestinationIds: [], expectedSourceUrls: [], coverage: 'none',
      }, { captured: true, artifactCount: 1 }),
      row({
        shouldCapture: true, expectedArtifactCount: 1,
        expectedDestinationIds: ['bound-note'], expectedSourceUrls: ['https://source.test/fact'], coverage: 'none',
      }, {}),
      row({
        shouldCapture: true, expectedArtifactCount: 1,
        expectedDestinationIds: ['bound-note'], expectedSourceUrls: ['https://source.test/fact'], coverage: 'none',
      }, {
        captured: true, artifactCount: 1,
        destinationIds: ['bound-note'], sourceUrls: ['https://source.test/fact'],
      }),
    ];

    expect(computeCaptureEvalMetrics(rows)).toMatchObject({
      destinationRoutingAccuracy: 0.5,
      groundingSourceFidelity: 0.5,
    });
  });

  it('reports zero-denominator metrics as null and excludes them from the hard safety decision', () => {
    const metrics = computeCaptureEvalMetrics([]);
    expect(metrics).toEqual({
      worthwhilePrecision: null,
      falsePositiveRate: null,
      fullCoverageSuppressionAccuracy: null,
      partialCoverageRetentionAccuracy: null,
      destinationRoutingAccuracy: null,
      groundingSourceFidelity: null,
      unsupportedUrlRate: null,
    });
    expect(evaluateCaptureEvalSafety(metrics)).toEqual({
      passed: true,
      unsupportedUrlStatus: 'excluded',
    });
  });

  it('canonicalizes observed URLs and detects unobserved or unsupported emitted URLs', () => {
    expect(findUnsupportedCaptureUrls(
      ['https://EXAMPLE.test:443/a#fragment', 'https://invented.test/x', 'ftp://example.test/file'],
      ['https://example.test/a'],
    )).toEqual(['ftp://example.test/file', 'https://invented.test/x']);
  });

  it('hard-fails only unsupported URLs while leaving unapproved quality cutoffs to review', () => {
    const weakMetrics = {
      worthwhilePrecision: 0.7,
      falsePositiveRate: 0.2,
      fullCoverageSuppressionAccuracy: 0,
      partialCoverageRetentionAccuracy: 0,
      destinationRoutingAccuracy: 0.2,
      groundingSourceFidelity: 0.3,
      unsupportedUrlRate: 0,
    };
    expect(evaluateCaptureEvalSafety(weakMetrics)).toEqual({ passed: true, unsupportedUrlStatus: 'passed' });
    expect(evaluateCaptureEvalSafety({ ...weakMetrics, unsupportedUrlRate: 0.01 })).toEqual({
      passed: false, unsupportedUrlStatus: 'failed',
    });
  });
});

function fixtureById(id: string): CaptureEvalFixture {
  const fixture = loadCaptureEvalCorpus(captureEvalCorpusPath()).find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new Error(`missing test fixture ${id}`);
  return fixture;
}

describe('production capture evaluation seam', () => {
  it('evaluates raw persisted messages and exact linked snapshots through production routing', async () => {
    const fixture = fixtureById('multi-linked-routing');
    const result = await evaluateCaptureEvalFixture(fixture, {
      config: offlineCaptureEvalConfig(),
      llm: createOfflineCaptureEvalLlm(fixture),
    });
    expect(result.actual).toEqual({
      captured: true,
      artifactCount: 2,
      destinationIds: ['node-routing-a', 'node-routing-b'],
      sourceUrls: [],
      unsupportedUrls: [],
      retainedPartialValue: false,
    });
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        artifactKey: 'multi-linked-routing-1',
        title: 'API and worker decisions 1',
        markdown: 'Standalone durable synthesis for multi-linked-routing.',
        sourceUrls: [],
      }),
      expect.objectContaining({
        artifactKey: 'multi-linked-routing-2',
        title: 'API and worker decisions 2',
        markdown: 'Standalone durable synthesis for multi-linked-routing.',
        sourceUrls: [],
      }),
    ]);
    expect(result.reasonCode).toBe('capture');
  });

  it.each([
    ['technical-explanation', ['plan_conversation_capture', 'compose_conversation_capture']],
    ['partially-captured-answer', [
      'plan_conversation_capture',
      'adjudicate_conversation_capture_coverage',
      'compose_conversation_capture',
    ]],
    ['fully-captured-create', [
      'plan_conversation_capture',
      'adjudicate_conversation_capture_coverage',
    ]],
  ] as const)('scripts the production three-stage order for %s', async (id, expectedTools) => {
    const fixture = fixtureById(id);
    const delegate = createOfflineCaptureEvalLlm(fixture);
    const tools: string[] = [];
    await evaluateCaptureEvalFixture(fixture, {
      config: offlineCaptureEvalConfig(),
      llm: {
        structuredCall: async (request) => {
          tools.push(request.toolName);
          return delegate.structuredCall(request);
        },
      },
    });
    expect(tools).toEqual(expectedTools);
  });

  it('retains partial value while protected and malformed candidates fail closed before a model call', async () => {
    const partial = fixtureById('partially-captured-answer');
    const partialResult = await evaluateCaptureEvalFixture(partial, {
      config: offlineCaptureEvalConfig(), llm: createOfflineCaptureEvalLlm(partial),
    });
    expect(partialResult.actual.retainedPartialValue).toBe(true);
    expect(partialResult.coverageAdjudications).toEqual([{
      artifactKey: 'queue-age-starvation',
      decision: 'uncovered',
      coveringToolCallIds: [],
      coveringCaptureIds: [],
      missingBrief: '',
    }]);
    expect(partialResult.coverageAdjudications[0]).not.toHaveProperty('reason');
    expect(partialResult.artifacts[0]?.markdown).toMatch(/queue age/i);
    expect(partialResult.artifacts[0]?.markdown).toMatch(/queue depth/i);
    expect(partialResult.artifacts[0]?.markdown).not.toContain('Queue depth/backlog measures accumulated queued volume.');
    expect(partialResult.artifacts[0]?.markdown).toBe(
      'Queue age reveals starvation duration that queue depth alone can hide; track age alongside depth.',
    );

    for (const id of ['protected-only', 'malformed-writer']) {
      let modelCalls = 0;
      const result = await evaluateCaptureEvalFixture(fixtureById(id), {
        config: offlineCaptureEvalConfig(),
        llm: { structuredCall: async () => { modelCalls += 1; throw new Error('must not call model'); } },
      });
      expect(result.actual.captured).toBe(false);
      expect(modelCalls).toBe(0);
    }
  });

  it('keeps the representative missing-only uncovered artifact coherent through production-visible requests', async () => {
    const partial = fixtureById('partially-captured-answer');
    const delegate = createOfflineCaptureEvalLlm(partial);
    const requests: Array<Parameters<typeof delegate.structuredCall>[0]> = [];
    const result = await evaluateCaptureEvalFixture(partial, {
      config: offlineCaptureEvalConfig(),
      llm: {
        structuredCall: async (request) => {
          requests.push(request);
          return delegate.structuredCall(request);
        },
      },
    });

    const planner = requests.find((request) => request.toolName === 'plan_conversation_capture')!;
    const coverage = requests.find((request) => request.toolName === 'adjudicate_conversation_capture_coverage')!;
    const composer = requests.find((request) => request.toolName === 'compose_conversation_capture')!;
    const plannerRecords = planner.user.split('\n').slice(1)
      .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
    const coverageRecords = coverage.user.split('\n').slice(1)
      .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
    const composerRecords = composer.user.split('\n').slice(1)
      .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });

    expect(planner.system).toContain('its brief lists every lasting point in it');
    expect(planner.system).toContain('The cited messages support the note; they add nothing the brief leaves out');
    expect(plannerRecords.find((record) => record.kind === 'visible_turn' && record.data.role === 'assistant')?.data.text)
      .toMatch(/queue depth\/backlog.*queue age.*starvation/is);
    expect(plannerRecords.find((record) => record.kind === 'eligible_linked_node')?.data.bodyExcerpt)
      .toBe('Queue depth/backlog measures accumulated queued volume.');

    expect(coverage.system).toContain('The note\'s title and brief are everything it would contain');
    expect(coverage.system).toContain('Its cited messages support it but add nothing to it');
    expect(coverageRecords.find((record) => record.kind === 'proposed_artifact')?.data).toEqual({
      artifactKey: 'queue-age-starvation',
      title: 'Queue age starvation signal',
      brief: 'Explain how queue age reveals starvation duration even when depth alone looks acceptable.',
    });
    expect(coverageRecords.filter((record) => record.kind === 'successful_write_receipt').map((record) => record.data)).toEqual([
      expect.objectContaining({
        toolCallId: 'call-partial',
        writtenText: 'Queue depth/backlog measures accumulated queued volume.',
      }),
    ]);

    const accepted = composerRecords.find((record) => record.kind === 'accepted_artifact')?.data;
    expect(composer.system).toContain('Each note says what its brief says and nothing more');
    expect(composer.system).toContain('never bring in a claim from them that the brief leaves out');
    expect(composer.system).toContain('never repeat or reword it in any note');
    expect(composerRecords.filter((record) => record.kind === 'exclusion_evidence')).toEqual([{
      kind: 'exclusion_evidence',
      data: {
        successfulWriteReceiptTexts: ['Queue depth/backlog measures accumulated queued volume.'],
        priorCaptureMarkdown: [],
      },
    }]);
    expect(accepted).toMatchObject({
      artifactKey: 'queue-age-starvation',
      brief: 'Explain how queue age reveals starvation duration even when depth alone looks acceptable.',
      coverage: {
        state: 'uncovered',
        coveringToolCallIds: [],
        coveringCaptureIds: [],
        citedWriteReceipts: [],
        citedPriorCaptures: [],
      },
    });
    expect(accepted?.destination).not.toHaveProperty('bodyExcerpt');
    expect(JSON.stringify((accepted?.citedAssistantTurns as unknown[]) ?? []))
      .toContain('Queue depth/backlog measures accumulated queued volume.');
    expect(result.artifacts[0]?.markdown).toMatch(/queue age.*queue depth/i);
    expect(result.artifacts[0]?.markdown).not.toContain('Queue depth/backlog measures accumulated queued volume.');
  });

  it('does not credit an uncovered partition when composed Markdown repeats saved content', async () => {
    const partial = fixtureById('partially-captured-answer');
    const delegate = createOfflineCaptureEvalLlm(partial);
    const result = await evaluateCaptureEvalFixture(partial, {
      config: offlineCaptureEvalConfig(),
      llm: {
        structuredCall: async (request) => request.toolName === 'compose_conversation_capture'
          ? {
              output: { artifacts: [{
                artifact_key: 'queue-age-starvation',
                title: 'Queue age starvation signal',
                markdown: 'Queue age reveals starvation beyond depth. Queue depth/backlog measures accumulated queued volume.',
              }] },
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }
          : delegate.structuredCall(request),
      },
    });
    expect(result.status).toBe('capture');
    expect(result.coverageAdjudications).toEqual([
      expect.objectContaining({ decision: 'uncovered', coveringToolCallIds: [], missingBrief: '' }),
    ]);
    expect(result.actual.retainedPartialValue).toBe(false);
  });

  it('credits a narrow uncovered partition with useful missing-only wording', async () => {
    const partial = fixtureById('partially-captured-answer');
    const delegate = createOfflineCaptureEvalLlm(partial);
    const result = await evaluateCaptureEvalFixture(partial, {
      config: offlineCaptureEvalConfig(),
      llm: {
        structuredCall: async (request) => request.toolName === 'compose_conversation_capture'
          ? {
              output: { artifacts: [{
                artifact_key: 'queue-age-starvation',
                title: 'Queue age starvation signal',
                markdown: 'Queue age reveals starvation duration even when depth alone appears acceptable, making it a necessary complementary metric to evaluate alongside depth.',
              }] },
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }
          : delegate.structuredCall(request),
      },
    });

    expect(result.coverageAdjudications).toEqual([
      expect.objectContaining({ decision: 'uncovered', coveringToolCallIds: [], missingBrief: '' }),
    ]);
    expect(result.actual.retainedPartialValue).toBe(true);
  });

  it('credits a wide partial partition with exact proof and useful missing-only wording', async () => {
    const partial = fixtureById('partially-captured-answer');
    const delegate = createOfflineCaptureEvalLlm(partial);
    const result = await evaluateCaptureEvalFixture(partial, {
      config: offlineCaptureEvalConfig(),
      llm: {
        structuredCall: async (request) => {
          const scripted = await delegate.structuredCall(request);
          if (request.toolName === 'plan_conversation_capture') {
            return {
              ...scripted,
              output: {
                outcome: 'capture', reason_code: 'capture', reason: 'The complete framework is durable.',
                artifacts: [{
                  artifact_key: 'queue-health-framework',
                  title: 'Queue depth and age health framework',
                  brief: 'Capture the coherent two-part queue-health framework: queue depth/backlog measures accumulated queued volume, while queue age reveals starvation duration even when depth alone looks acceptable.',
                  assistant_message_ids: ['a1'],
                  source_urls: [],
                  destination_node_id: 'queue-note',
                }],
              },
            };
          }
          if (request.toolName === 'adjudicate_conversation_capture_coverage') {
            return {
              ...scripted,
              output: {
                decision: 'partial', reason: 'The depth component is saved.',
                coveringToolCallIds: ['call-partial'], coveringCaptureIds: [],
                missingBrief: 'Explain only how queue age reveals starvation duration when depth alone looks acceptable.',
              },
            };
          }
          if (request.toolName === 'compose_conversation_capture') {
            return {
              ...scripted,
              output: { artifacts: [{
                artifact_key: 'queue-health-framework',
                title: 'Queue depth and age health framework',
                markdown: 'Queue age reveals starvation duration even when depth alone appears acceptable.',
              }] },
            };
          }
          return scripted;
        },
      },
    });

    expect(result.coverageAdjudications).toEqual([
      expect.objectContaining({
        decision: 'partial', coveringToolCallIds: ['call-partial'],
        coveringCaptureIds: [], missingBrief: expect.stringMatching(/queue age.*starvation/i),
      }),
    ]);
    expect(result.actual.retainedPartialValue).toBe(true);
  });

  it.each([
    ['depth', 'Queue age reveals starvation duration even when throughput appears acceptable.'],
    ['starvation', 'Queue age complements depth by showing how long the oldest queued item has waited.'],
  ])('does not credit partial retention when natural wording omits %s', async (_label, markdown) => {
    const partial = fixtureById('partially-captured-answer');
    const delegate = createOfflineCaptureEvalLlm(partial);
    const result = await evaluateCaptureEvalFixture(partial, {
      config: offlineCaptureEvalConfig(),
      llm: {
        structuredCall: async (request) => request.toolName === 'compose_conversation_capture'
          ? {
              output: { artifacts: [{
                artifact_key: 'queue-age-starvation',
                title: 'Queue age starvation signal',
                markdown,
              }] },
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }
          : delegate.structuredCall(request),
      },
    });

    expect(result.coverageAdjudications).toEqual([
      expect.objectContaining({ decision: 'uncovered', coveringToolCallIds: [], missingBrief: '' }),
    ]);
    expect(result.actual.retainedPartialValue).toBe(false);
  });

  it.each([
    ['planner', 'plan_conversation_capture', 'RAW-PLANNER-ROW-MARKER'],
    ['coverage', 'adjudicate_conversation_capture_coverage', 'RAW-COVERAGE-ROW-MARKER'],
    ['composer', 'compose_conversation_capture', 'RAW-COMPOSER-ROW-MARKER'],
  ] as const)('keeps raw %s failures out of saved evaluation rows', async (_stage, failingTool, marker) => {
    const fixture = fixtureById('partially-captured-answer');
    const delegate = createOfflineCaptureEvalLlm(fixture);
    const result = await evaluateCaptureEvalFixture(fixture, {
      config: offlineCaptureEvalConfig(),
      llm: {
        structuredCall: async (request) => {
          if (request.toolName === failingTool) {
            throw new StructuredCallFailure(marker, undefined, 'malformed_json');
          }
          return delegate.structuredCall(request);
        },
      },
    });

    expect(result).toMatchObject({ status: 'deferred', reasonCode: 'model-error', artifacts: [] });
    expect(result.reason).toContain('reason=malformed_json');
    expect(result.reason).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('uses production destination grouping while retaining semantic artifact count', async () => {
    const base = fixtureById('unbound-multi-topic');
    const grouped: CaptureEvalFixture = {
      ...base,
      id: 'grouped-test',
      conversation: { ...base.conversation, linked_docs: ['node-grouped'] },
      linked_nodes: [{
        id: 'node-grouped', title: 'Grouped', file_path: 'Notes/Grouped.md',
        body_excerpt: 'Existing context.', fields: {},
      }],
      expected: { ...base.expected, expectedDestinationIds: ['node-grouped'] },
    };
    const result = await evaluateCaptureEvalFixture(grouped, {
      config: offlineCaptureEvalConfig(), llm: createOfflineCaptureEvalLlm(grouped),
    });
    expect(result.actual).toMatchObject({
      captured: true, artifactCount: 2, destinationIds: ['node-grouped'],
    });
    expect(result.proposalCount).toBe(1);
  });
});

describe('capture evaluation CLI runner', () => {
  const readOnlyBootstrap = {
    engineUrl: 'http://engine.test', engineToken: 'token', experiment: null, variant: null,
    llmKeys: { keys: { fireworks: 'key' }, baseURLs: { fireworks: 'https://provider.test' } },
    oauthOwnerPassword: undefined, oauthIssuerUrl: undefined, curatorPort: 3335,
    curatorDbPath: ':memory:', memorySweepSince: null, conversationSweepSince: null,
  };

  function validReadOnlyDomains(): Record<string, unknown> {
    return {
      curator: {
        effective: effectiveSettings<CuratorSettings>('curator', {}),
        stored: {}, version: 4, seeded: true, issues: [],
      },
      models: {
        catalog: [
          { title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true },
        ],
        providers: {}, version: 2, issues: [],
      },
    };
  }

  function liveEvalWithJudgeResult(judgeResult: unknown | Error) {
    const corpus = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const byConversation = new Map(corpus.map((fixture) => [fixture.conversation.id, fixture]));
    let delegate: ReturnType<typeof createOfflineCaptureEvalLlm> | undefined;
    const config = {
      ...offlineCaptureEvalConfig(),
      conversationCaptureModel: 'accounts/fireworks/models/capture-eval-judge-failure-test',
    };
    const judgeRequests: Array<Parameters<ReturnType<typeof createOfflineCaptureEvalLlm>['structuredCall']>[0]> = [];
    const llm = {
      structuredCall: async (request: Parameters<ReturnType<typeof createOfflineCaptureEvalLlm>['structuredCall']>[0]) => {
        if (request.toolName === 'judge_capture_standalone_usefulness') {
          judgeRequests.push(request);
          if (judgeResult instanceof Error) throw judgeResult;
          return { output: judgeResult, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
        }
        if (request.toolName === 'plan_conversation_capture') {
          const conversationLine = request.user.split('\n').find((line) => line.includes('"kind":"conversation"'));
          const parsed = conversationLine === undefined
            ? undefined
            : JSON.parse(conversationLine) as { data?: { id?: string } };
          const fixture = parsed?.data?.id === undefined ? undefined : byConversation.get(parsed.data.id);
          if (fixture === undefined) throw new Error('judge failure test could not resolve fixture from production prompt');
          delegate = createOfflineCaptureEvalLlm(fixture);
        }
        if (delegate === undefined) throw new Error('composer called without its production planner call');
        return delegate.structuredCall(request);
      },
    };
    return { config, llm, judgeRequests };
  }

  it('defaults to live mode and exposes an explicit deterministic offline mode', () => {
    expect(parseCaptureEvalArgs([])).toEqual({ mode: 'live' });
    expect(parseCaptureEvalArgs(['--offline'])).toEqual({ mode: 'offline' });
    expect(parseCaptureEvalArgs(['--live'])).toEqual({ mode: 'live' });
    expect(parseCaptureEvalArgs(['--live', '--fixture', 'partially-captured-answer'])).toEqual({
      mode: 'live', fixtureId: 'partially-captured-answer',
    });
    expect(() => parseCaptureEvalArgs(['--offline', '--live'])).toThrow(/mutually exclusive/i);
    expect(() => parseCaptureEvalArgs(['--fixture'])).toThrow(/fixture.*value/i);
    expect(() => parseCaptureEvalArgs(['--fixture', 'a', '--fixture', 'b'])).toThrow(/fixture.*once/i);
    expect(() => parseCaptureEvalArgs(['--fixture=partially-captured-answer'])).toThrow(/--fixture <exact-id>/i);
  });

  it('selects exactly one fixture and rejects non-exact ids before any model call', async () => {
    const selected = await runCaptureEval({
      mode: 'offline', fixtureId: 'partially-captured-answer',
      outputParent: temporaryDirectory('capture-eval-selected-parent-'),
    });
    expect(selected.report.fixtureCount).toBe(1);
    expect(selected.report.rows.map((candidate) => candidate.id)).toEqual(['partially-captured-answer']);
    const json = JSON.parse(readFileSync(join(selected.outputDirectory, 'capture-eval.json'), 'utf8')) as {
      rows: unknown[];
    };
    expect(json.rows).toHaveLength(1);
    const markdown = readFileSync(join(selected.outputDirectory, 'capture-eval.md'), 'utf8');
    expect(markdown).toContain('partially-captured-answer');
    expect(markdown).toContain('- Decision: uncovered');
    expect(markdown).toContain('- Covering tool-call IDs: (none)');
    expect(markdown).toMatch(/queue age.*queue depth/is);
    expect(markdown).not.toContain('technical-explanation');

    for (const fixtureId of ['partially-captured', 'PARTIALLY-CAPTURED-ANSWER']) {
      let modelCalls = 0;
      await expect(runCaptureEval({
        mode: 'live', fixtureId, config: offlineCaptureEvalConfig(),
        llm: {
          structuredCall: async () => {
            modelCalls += 1;
            throw new Error('model must not be called');
          },
        },
        outputParent: temporaryDirectory('capture-eval-unknown-parent-'),
      })).rejects.toThrow(/unknown capture eval fixture/i);
      expect(modelCalls).toBe(0);
    }
  });

  it('refuses a live run without an explicitly resolved runtime config and LLM', async () => {
    await expect(runCaptureEval({
      mode: 'live', llm: createOfflineCaptureEvalLlm(fixtureById('sourced-reference')),
    })).rejects.toThrow(/configured runtime config/i);
    await expect(runCaptureEval({
      mode: 'live', config: offlineCaptureEvalConfig(),
    })).rejects.toThrow(/configured LLM client/i);
  });

  it('runs offline without runtime credentials and emits deterministic JSON and Markdown reports', async () => {
    const first = await runCaptureEval({ mode: 'offline', outputParent: temporaryDirectory('capture-eval-parent-') });
    const second = await runCaptureEval({ mode: 'offline', outputParent: temporaryDirectory('capture-eval-parent-') });

    expect(first.report).toEqual(second.report);
    expect(first.report).toMatchObject({
      mode: 'offline',
      model: 'offline-deterministic',
      plannerComposerModel: 'offline-deterministic',
      coverageModel: 'offline-deterministic',
      fixtureCount: 17,
      safetyResult: { passed: true, unsupportedUrlStatus: 'passed' },
      metrics: { unsupportedUrlRate: 0 },
    });
    const positive = first.report.rows.find((row) => row.id === 'technical-explanation')!;
    expect(positive.artifacts).toEqual([expect.objectContaining({
      artifactKey: 'technical-explanation-1',
      markdown: 'Standalone durable synthesis for technical-explanation.',
    })]);
    expect(positive.standaloneUsefulness).toMatchObject({
      source: 'offline-deterministic', assessment: 'standalone-useful',
      artifactJudgments: [expect.objectContaining({
        artifactKey: 'technical-explanation-1', assessment: 'standalone-useful',
      })],
    });
    expect(first.report.rows.find((row) => row.id === 'transient-answer')?.standaloneUsefulness)
      .toMatchObject({ source: 'offline-deterministic', assessment: 'not-applicable', artifactJudgments: [] });
    expect(first.report.standaloneJudgeFailures).toEqual([]);
    expect(first.outputDirectory).not.toBe(second.outputDirectory);
    const json = JSON.parse(readFileSync(join(first.outputDirectory, 'capture-eval.json'), 'utf8')) as unknown;
    expect(json).toEqual(first.report);
    const markdown = readFileSync(join(first.outputDirectory, 'capture-eval.md'), 'utf8');
    for (const name of Object.keys(first.report.metrics)) expect(markdown).toContain(name);
    expect(markdown).toContain('Planner/composer model: offline-deterministic');
    expect(markdown).toContain('Coverage model: offline-deterministic');
    expect(markdown).toContain('Standalone usefulness');
    expect(markdown).toContain('Standalone durable synthesis for technical-explanation.');
  });

  it('fails the release result and CLI exit when valid output misses a fixture expectation', async () => {
    const fixture = fixtureById('technical-explanation');
    const forcedMismatch: CaptureEvalFixture = {
      ...fixture,
      expected: { ...fixture.expected, shouldCapture: false },
    };
    const delegate = createOfflineCaptureEvalLlm(fixture);
    const result = await runCaptureEval({
      mode: 'live',
      fixtures: [forcedMismatch],
      config: offlineCaptureEvalConfig(),
      llm: {
        structuredCall: async (request) => {
          if (request.toolName !== 'judge_capture_standalone_usefulness') {
            return delegate.structuredCall(request);
          }
          const input = JSON.parse(request.user) as { artifacts: Array<{ artifactKey: string }> };
          return {
            output: {
              artifact_judgments: input.artifacts.map((artifact) => ({
                artifact_key: artifact.artifactKey,
                assessment: 'standalone-useful',
                rationale: 'The exact artifact is self-contained.',
              })),
            },
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
        },
      },
      outputParent: temporaryDirectory('capture-eval-expectation-mismatch-parent-'),
    });
    const markdown = readFileSync(join(result.outputDirectory, 'capture-eval.md'), 'utf8');

    expect(result.report.safetyResult.passed).toBe(true);
    expect(result.report.schemaFailures).toEqual([]);
    expect(result.report.standaloneJudgeFailures).toEqual([]);
    expect(result.report.expectationFailures).toEqual(['technical-explanation: capture decision']);
    expect.soft(result.report.passed).toBe(false);
    expect.soft(captureEvalExitCode(result.report)).toBe(1);
    expect.soft(markdown).toContain('- Overall release result: FAIL');
    expect.soft(markdown).toContain('- Unsupported-URL safety result: PASS');
    expect.soft(markdown).toContain('- Schema/model execution result: PASS');
    expect.soft(markdown).toContain('- Standalone-judge execution result: PASS');
    expect.soft(markdown).toContain('- Fixture expectation result: FAIL');
    expect.soft(markdown).not.toContain('Hard safety/schema result');
  });

  it('fails a full-coverage fixture when the planner skips without an exact proven adjudication', async () => {
    const fixture = fixtureById('fully-captured-create');
    const result = await runCaptureEval({
      mode: 'live',
      fixtures: [fixture],
      config: offlineCaptureEvalConfig(),
      llm: {
        structuredCall: async (request) => {
          if (request.toolName !== 'plan_conversation_capture') {
            throw new Error(`unexpected model call ${request.toolName}`);
          }
          return {
            output: {
              outcome: 'skip', reason_code: 'not-valuable',
              reason: 'The planner skipped before coverage.', artifacts: [],
            },
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
        },
      },
      outputParent: temporaryDirectory('capture-eval-full-planner-skip-parent-'),
    });

    expect(result.report.safetyResult.passed).toBe(true);
    expect(result.report.schemaFailures).toEqual([]);
    expect(result.report.rows[0]).toMatchObject({
      status: 'skip', reasonCode: 'not-valuable', coverageAdjudications: [],
    });
    expect(result.report.expectationFailures).toEqual([
      'fully-captured-create: full coverage suppression with exact proof',
    ]);
    expect(result.report.passed).toBe(false);
    expect(captureEvalExitCode(result.report)).toBe(1);
  });

  it('fails a positive uncovered fixture when an unrelated receipt produces partial coverage', async () => {
    const fixture = fixtureById('unrelated-update');
    const receiptId = inspectConversation(fixture.conversation.messages).writeReceipts[0]!.toolCallId;
    const delegate = createOfflineCaptureEvalLlm(fixture);
    const result = await runCaptureEval({
      mode: 'live',
      fixtures: [fixture],
      config: offlineCaptureEvalConfig(),
      llm: {
        structuredCall: async (request) => {
          if (request.toolName === 'judge_capture_standalone_usefulness') {
            const input = JSON.parse(request.user) as { artifacts: Array<{ artifactKey: string }> };
            return {
              output: {
                artifact_judgments: input.artifacts.map((artifact) => ({
                  artifact_key: artifact.artifactKey,
                  assessment: 'standalone-useful',
                  rationale: 'The exact artifact is self-contained.',
                })),
              },
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            };
          }
          const scripted = await delegate.structuredCall(request);
          if (request.toolName !== 'adjudicate_conversation_capture_coverage') return scripted;
          return {
            output: {
              decision: 'partial',
              reason: 'The unrelated receipt was incorrectly treated as partial coverage.',
              coveringToolCallIds: [receiptId],
              coveringCaptureIds: [],
              missingBrief: 'Retain the proposed artifact.',
            },
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
        },
      },
      outputParent: temporaryDirectory('capture-eval-none-partial-parent-'),
    });

    expect(result.report.safetyResult.passed).toBe(true);
    expect(result.report.schemaFailures).toEqual([]);
    expect(result.report.rows[0]?.coverageAdjudications).toEqual([
      expect.objectContaining({
        decision: 'partial', coveringToolCallIds: [receiptId], missingBrief: 'Retain the proposed artifact.',
      }),
    ]);
    expect(result.report.expectationFailures).toEqual([
      'unrelated-update: uncovered adjudications with empty proof',
    ]);
    expect(result.report.passed).toBe(false);
    expect(captureEvalExitCode(result.report)).toBe(1);
  });

  it('runs live fixtures through the same seam with configured model, prompts, and token budgets', async () => {
    const corpus = loadCaptureEvalCorpus(captureEvalCorpusPath());
    const byConversation = new Map(corpus.map((fixture) => [fixture.conversation.id, fixture]));
    const calls: Array<{
      model: string;
      maxTokens: number;
      system: string;
      toolName: string;
      user: string;
      malformedOutputPolicy: string | undefined;
      providerPromptCharCap: number | undefined;
    }> = [];
    let delegate: ReturnType<typeof createOfflineCaptureEvalLlm> | undefined;
    const config = {
      ...offlineCaptureEvalConfig(),
      conversationCaptureModel: 'accounts/fireworks/models/capture-eval-test',
      conversationCaptureCoverageModel: 'accounts/fireworks/models/capture-coverage-eval-test',
      conversationCapturePlannerMaxTokens: 777,
      conversationCaptureCoverageMaxTokens: 666,
      conversationCaptureComposerMaxTokens: 888,
      curatorConversationCapturePlannerPrompt: 'configured planner prompt',
      curatorConversationCaptureComposerPrompt: 'configured composer prompt',
      modelProviders: {
        'accounts/fireworks/models/capture-eval-test': 'fireworks' as const,
        'accounts/fireworks/models/capture-coverage-eval-test': 'fireworks' as const,
      },
    };
    const llm = {
      structuredCall: async (request: Parameters<ReturnType<typeof createOfflineCaptureEvalLlm>['structuredCall']>[0]) => {
        calls.push({
          model: request.model,
          maxTokens: request.maxTokens,
          system: request.system,
          toolName: request.toolName,
          user: request.user,
          malformedOutputPolicy: request.malformedOutputPolicy,
          providerPromptCharCap: request.providerPromptCharCap,
        });
        if (request.toolName === 'judge_capture_standalone_usefulness') {
          const exactArtifacts = JSON.parse(request.user) as { artifacts: Array<{ artifactKey: string; markdown: string }> };
          return {
            output: {
              artifact_judgments: exactArtifacts.artifacts.map((artifact) => ({
                artifact_key: artifact.artifactKey,
                assessment: 'not-useful',
                rationale: `Qualitative test judgment for exact body: ${artifact.markdown}`,
              })),
            },
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
        }
        if (request.toolName === 'plan_conversation_capture') {
          const conversationLine = request.user.split('\n').find((line) => line.includes('"kind":"conversation"'));
          const parsed = conversationLine === undefined ? undefined : JSON.parse(conversationLine) as { data?: { id?: string } };
          const fixture = parsed?.data?.id === undefined ? undefined : byConversation.get(parsed.data.id);
          if (fixture === undefined) throw new Error('live test could not resolve fixture from production prompt');
          delegate = createOfflineCaptureEvalLlm(fixture);
        }
        if (delegate === undefined) throw new Error('composer called without its production planner call');
        return delegate.structuredCall(request);
      },
    };

    const result = await runCaptureEval({
      mode: 'live', config, llm, outputParent: temporaryDirectory('capture-eval-live-parent-'),
    });
    expect(result.report).toMatchObject({
      mode: 'live',
      model: 'accounts/fireworks/models/capture-eval-test',
      plannerComposerModel: 'accounts/fireworks/models/capture-eval-test',
      coverageModel: 'accounts/fireworks/models/capture-coverage-eval-test',
      passed: true,
    });
    expect(result.report.standaloneJudgeFailures).toEqual([]);
    expect(result.report.rows.filter((row) => row.actual.captured).every((row) => (
      row.standaloneUsefulness.assessment === 'not-useful'
      && row.standaloneUsefulness.source === 'live-model'
    ))).toBe(true);
    expect(calls.filter((call) => call.toolName === 'plan_conversation_capture')).not.toHaveLength(0);
    expect(calls.filter((call) => call.toolName === 'plan_conversation_capture').every((call) => (
      call.model === config.conversationCaptureModel
      && call.maxTokens === 777
      && call.system.includes('configured planner prompt')
    ))).toBe(true);
    expect(calls.filter((call) => call.toolName === 'compose_conversation_capture').every((call) => (
      call.model === config.conversationCaptureModel
      && call.maxTokens === 888
      && call.system.includes('configured composer prompt')
    ))).toBe(true);
    expect(calls.filter((call) => call.toolName === 'adjudicate_conversation_capture_coverage').every((call) => (
      call.model === config.conversationCaptureCoverageModel
      && call.maxTokens === 666
    ))).toBe(true);
    const judgeCalls = calls.filter((call) => call.toolName === 'judge_capture_standalone_usefulness');
    expect(judgeCalls).toHaveLength(result.report.rows.filter((row) => row.actual.captured).length);
    expect(judgeCalls.every((call) => (
      call.model === config.conversationCaptureModel
      && call.system.includes('standalone')
      && (call.user.includes('Standalone durable synthesis') || call.user.includes('Queue age'))
      && call.malformedOutputPolicy === 'fail-closed-redacted'
      && call.providerPromptCharCap === 80_000
    ))).toBe(true);
    const markdown = readFileSync(join(result.outputDirectory, 'capture-eval.md'), 'utf8');
    expect(markdown).toContain('Planner/composer model: accounts/fireworks/models/capture-eval-test');
    expect(markdown).toContain('Coverage model: accounts/fireworks/models/capture-coverage-eval-test');
    const offline = await runCaptureEval({
      mode: 'offline', fixtureId: 'sourced-reference',
      outputParent: temporaryDirectory('capture-eval-schema-parent-'),
    });
    expect(Object.keys(result.report).sort()).toEqual(Object.keys(offline.report).sort());
    expect(Object.keys(result.report.rows[0]!).sort()).toEqual(Object.keys(offline.report.rows[0]!).sort());
    // Qualitative judgments are review evidence, never a numeric or pass/fail release gate.
    expect(result.report.passed).toBe(true);
    expect(captureEvalExitCode(result.report)).toBe(0);
  });

  it.each([
    ['throws', new Error('standalone judge transport failed')],
    ['returns schema-invalid output', { artifact_judgments: 'not-an-array' }],
  ])('fails the live runner when the required standalone judge %s', async (_label, judgeResult) => {
    const { config, llm } = liveEvalWithJudgeResult(judgeResult);
    const result = await runCaptureEval({
      mode: 'live', config, llm,
      outputParent: temporaryDirectory('capture-eval-judge-failure-parent-'),
    });
    const capturedRows = result.report.rows.filter((row) => row.actual.captured);

    expect(capturedRows.length).toBeGreaterThan(0);
    expect(result.report.schemaFailures).toEqual([]);
    expect(result.report.standaloneJudgeFailures).toHaveLength(capturedRows.length);
    expect(capturedRows.every((row) => row.standaloneUsefulness.assessment === 'unavailable')).toBe(true);
    expect(result.report.passed).toBe(false);
    expect(captureEvalExitCode(result.report)).toBe(1);
    const markdown = readFileSync(join(result.outputDirectory, 'capture-eval.md'), 'utf8');
    expect(markdown).toContain('- Overall release result: FAIL');
    expect(markdown).toContain('- Unsupported-URL safety result: PASS');
    expect(markdown).toContain('- Schema/model execution result: PASS');
    expect(markdown).toContain('- Standalone-judge execution result: FAIL');
    expect(markdown).toContain('- Fixture expectation result: PASS');
  });

  it('projects standalone judge failures to static metadata without persisting provider content', async () => {
    const marker = 'RAW-STANDALONE-JUDGE-PROVIDER-MARKER';
    const { config, llm, judgeRequests } = liveEvalWithJudgeResult(
      new StructuredCallFailure(marker, undefined, 'malformed_json'),
    );
    const result = await runCaptureEval({
      mode: 'live', config, llm, fixtureId: 'technical-explanation',
      outputParent: temporaryDirectory('capture-eval-judge-redaction-parent-'),
    });

    expect(judgeRequests).toEqual([
      expect.objectContaining({
        malformedOutputPolicy: 'fail-closed-redacted',
        providerPromptCharCap: 80_000,
      }),
    ]);
    expect(result.report.standaloneJudgeFailures).toEqual([
      'technical-explanation: standalone_judge_failed',
    ]);
    expect(result.report.rows[0]?.standaloneUsefulness).toMatchObject({
      assessment: 'unavailable',
      rationale: 'standalone_judge_failed',
    });

    const json = readFileSync(join(result.outputDirectory, 'capture-eval.json'), 'utf8');
    const markdown = readFileSync(join(result.outputDirectory, 'capture-eval.md'), 'utf8');
    expect(JSON.stringify(result.report.rows)).not.toContain(marker);
    expect(JSON.stringify(result.report.standaloneJudgeFailures)).not.toContain(marker);
    expect(json).not.toContain(marker);
    expect(markdown).not.toContain(marker);
  });

  it('resolves live settings with one read-only getSettings snapshot', async () => {
    const settings = {
      ...effectiveSettings<CuratorSettings>('curator', {}),
      conversationCaptureModel: '[[Capture Eval Model]]',
      conversationCapturePlannerMaxTokens: 1234,
      conversationCaptureComposerMaxTokens: 2345,
      curatorConversationCapturePlannerPrompt: 'snapshot planner',
      curatorConversationCaptureComposerPrompt: 'snapshot composer',
    };
    const calls: Array<string | undefined> = [];
    const config = await resolveReadOnlyCaptureEvalConfig({
      engineUrl: 'http://engine.test', engineToken: 'token', experiment: null, variant: null,
      llmKeys: { keys: { fireworks: 'key' }, baseURLs: { fireworks: 'https://provider.test' } },
      oauthOwnerPassword: undefined, oauthIssuerUrl: undefined, curatorPort: 3335,
      curatorDbPath: ':memory:', memorySweepSince: null, conversationSweepSince: null,
    }, {
      getSettings: async (domain?: string) => {
        calls.push(domain);
        return { domains: {
          curator: { effective: settings as unknown as Record<string, unknown>, stored: {}, version: 4, seeded: true, issues: [] },
          models: { catalog: [
            { title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true },
            { title: 'Capture Eval Model', provider: 'fireworks', model: 'accounts/fireworks/models/capture-eval', enabled: true },
          ], providers: {}, version: 2, issues: [] },
        } };
      },
    });

    expect(calls).toEqual([undefined]);
    expect(config).toMatchObject({
      conversationCaptureModel: 'accounts/fireworks/models/capture-eval',
      conversationCapturePlannerMaxTokens: 1234,
      conversationCaptureComposerMaxTokens: 2345,
      curatorConversationCapturePlannerPrompt: 'snapshot planner',
      curatorConversationCaptureComposerPrompt: 'snapshot composer',
    });
  });

  it('accepts every catalog provider in the models snapshot and rejects unknown ones', async () => {
    const withCatalog = (catalog: unknown[]) => ({
      ...validReadOnlyDomains(),
      models: { catalog, providers: {}, version: 2, issues: [] },
    });
    const claude = { title: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true };
    await expect(resolveReadOnlyCaptureEvalConfig(readOnlyBootstrap, {
      getSettings: async () => ({ domains: withCatalog([claude, { title: 'GPT Test', provider: 'openai', model: 'gpt-test', enabled: true }]) as never }),
    })).resolves.toBeDefined();
    await expect(resolveReadOnlyCaptureEvalConfig(readOnlyBootstrap, {
      getSettings: async () => ({ domains: withCatalog([claude, { title: 'Other', provider: 'mistral', model: 'm', enabled: true }]) as never }),
    })).rejects.toThrow('catalog[1].provider is unsupported');
  });

  it.each([
    ['curator', { models: validReadOnlyDomains().models }],
    ['models', { curator: validReadOnlyDomains().curator }],
  ] as const)('fails closed when the read-only snapshot is missing the %s domain', async (domain, domains) => {
    await expect(resolveReadOnlyCaptureEvalConfig(readOnlyBootstrap, {
      getSettings: async () => ({ domains: domains as never }),
    })).rejects.toThrow(new RegExp(`missing required.*${domain}.*domain`, 'i'));
  });

  it.each([
    ['curator effective settings are not an object', {
      ...validReadOnlyDomains(),
      curator: { effective: null, stored: {}, version: 4, seeded: true, issues: [] },
    }, /invalid.*curator.*effective.*object/i],
    ['a required effective setting has the wrong type', {
      ...validReadOnlyDomains(),
      curator: {
        effective: {
          ...effectiveSettings<CuratorSettings>('curator', {}),
          conversationCapturePlannerMaxTokens: 'many',
        },
        stored: {}, version: 4, seeded: true, issues: [],
      },
    }, /invalid.*curator.*conversationCapturePlannerMaxTokens.*integer/i],
    ['models catalog is not an array', {
      ...validReadOnlyDomains(),
      models: { catalog: {}, providers: {}, version: 2, issues: [] },
    }, /invalid.*models.*catalog.*array/i],
    ['a model catalog entry has an unsupported provider', {
      ...validReadOnlyDomains(),
      models: {
        catalog: [{ title: 'Broken', provider: 'unknown', model: 'broken-model', enabled: true }],
        providers: {}, version: 2, issues: [],
      },
    }, /invalid.*models.*catalog\[0\].*provider/i],
  ] as const)('fails closed when %s', async (_description, domains, expectedError) => {
    await expect(resolveReadOnlyCaptureEvalConfig(readOnlyBootstrap, {
      getSettings: async () => ({ domains: domains as never }),
    })).rejects.toThrow(expectedError);
  });
});
