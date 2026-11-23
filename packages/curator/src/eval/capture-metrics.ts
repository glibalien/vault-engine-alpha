export interface CaptureEvalExpected {
  shouldCapture: boolean;
  expectedArtifactCount?: number;
  expectedDestinationIds?: string[];
  expectedSourceUrls?: string[];
  expectedPartialMarkdownIncludes?: string[];
  expectedPartialMarkdownExcludes?: string[];
  expectedCoveringToolCallIds?: string[];
  expectedCoveringCaptureIds?: string[];
  coverage: 'none' | 'full' | 'partial';
  coverageReliable?: boolean;
}

export interface CaptureEvalCoverageAdjudication {
  artifactKey: string;
  decision: 'uncovered' | 'partial' | 'full';
  coveringToolCallIds: string[];
  coveringCaptureIds: string[];
  missingBrief: string;
}

export interface CaptureEvalMetrics {
  worthwhilePrecision: number | null;
  falsePositiveRate: number | null;
  fullCoverageSuppressionAccuracy: number | null;
  partialCoverageRetentionAccuracy: number | null;
  destinationRoutingAccuracy: number | null;
  groundingSourceFidelity: number | null;
  unsupportedUrlRate: number | null;
}

export interface CaptureEvalRow {
  expected: CaptureEvalExpected;
  coverageAdjudications: CaptureEvalCoverageAdjudication[];
  actual: {
    captured: boolean;
    artifactCount: number;
    destinationIds: string[];
    sourceUrls: string[];
    unsupportedUrls: string[];
    retainedPartialValue: boolean;
  };
}

export interface CaptureEvalSafetyResult {
  passed: boolean;
  unsupportedUrlStatus: 'passed' | 'failed' | 'excluded';
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function exactStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (actualSet.size !== actual.length || expectedSet.size !== expected.length) return false;
  return [...expectedSet].every((value) => actualSet.has(value));
}

function hasExactCoverageDecision(
  row: CaptureEvalRow,
  decision: CaptureEvalCoverageAdjudication['decision'],
): boolean {
  const expectedToolCallIds = row.expected.expectedCoveringToolCallIds ?? [];
  const expectedCaptureIds = row.expected.expectedCoveringCaptureIds ?? [];
  return row.coverageAdjudications.some((adjudication) => (
    adjudication.decision === decision
    && exactStringSet(adjudication.coveringToolCallIds, expectedToolCallIds)
    && exactStringSet(adjudication.coveringCaptureIds, expectedCaptureIds)
  ));
}

/**
 * Compute row-level quality metrics with explicit denominators:
 * - worthwhile precision: expected positives among emitted captures;
 * - hard-negative FPR: emitted captures among reliable `coverage:none` negatives;
 * - coverage accuracies: exact behavior among full/partial rows respectively;
 * - routing/source fidelity: capture emission plus exact set agreement among
 *   expected-positive rows carrying the corresponding label; and
 * - unsupported URL rate: unsupported emitted URLs / all emitted source URLs.
 */
export function computeCaptureEvalMetrics(rows: readonly CaptureEvalRow[]): CaptureEvalMetrics {
  const emitted = rows.filter((row) => row.actual.captured);
  const hardNegatives = rows.filter((row) => (
    !row.expected.shouldCapture
    && row.expected.coverage === 'none'
    && row.expected.coverageReliable !== false
  ));
  const fullCoverage = rows.filter((row) => row.expected.coverage === 'full');
  const partialCoverage = rows.filter((row) => row.expected.coverage === 'partial');
  const routed = rows.filter((row) => row.expected.shouldCapture && row.expected.expectedDestinationIds !== undefined);
  const grounded = rows.filter((row) => row.expected.shouldCapture && row.expected.expectedSourceUrls !== undefined);
  const emittedSourceCount = rows.reduce((total, row) => total + row.actual.sourceUrls.length, 0);
  const unsupportedSourceCount = rows.reduce((total, row) => total + row.actual.unsupportedUrls.length, 0);

  return {
    worthwhilePrecision: ratio(emitted.filter((row) => row.expected.shouldCapture).length, emitted.length),
    falsePositiveRate: ratio(hardNegatives.filter((row) => row.actual.captured).length, hardNegatives.length),
    fullCoverageSuppressionAccuracy: ratio(fullCoverage.filter((row) => (
      !row.actual.captured && hasExactCoverageDecision(row, 'full')
    )).length, fullCoverage.length),
    partialCoverageRetentionAccuracy: ratio(
      partialCoverage.filter((row) => row.actual.captured && row.actual.retainedPartialValue).length,
      partialCoverage.length,
    ),
    destinationRoutingAccuracy: ratio(
      routed.filter((row) => (
        row.actual.captured
        && exactStringSet(row.actual.destinationIds, row.expected.expectedDestinationIds ?? [])
      )).length,
      routed.length,
    ),
    groundingSourceFidelity: ratio(
      grounded.filter((row) => (
        row.actual.captured
        && exactStringSet(row.actual.sourceUrls, row.expected.expectedSourceUrls ?? [])
      )).length,
      grounded.length,
    ),
    unsupportedUrlRate: ratio(unsupportedSourceCount, emittedSourceCount),
  };
}

function canonicalHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    if ((parsed.protocol === 'http:' && parsed.port === '80')
      || (parsed.protocol === 'https:' && parsed.port === '443')) parsed.port = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Detects both unsupported schemes/malformed values and HTTP(S) URLs that
 * were not observed by the production conversation inspector. */
export function findUnsupportedCaptureUrls(
  emittedUrls: readonly string[],
  observedUrls: readonly string[],
): string[] {
  const observed = new Set(observedUrls.flatMap((value) => {
    const canonical = canonicalHttpUrl(value);
    return canonical === null ? [] : [canonical];
  }));
  const unsupported = new Set<string>();
  for (const emitted of emittedUrls) {
    const canonical = canonicalHttpUrl(emitted);
    if (canonical === null || !observed.has(canonical)) unsupported.add(emitted.trim());
  }
  return [...unsupported].sort((a, b) => a.localeCompare(b));
}

/** The approved design defines no numeric quality cutoffs. Unsupported URLs
 * are the sole hard metric failure; all other values are reported for explicit
 * operator/release review. A null URL rate means no emitted-source denominator
 * existed and is reported as excluded. */
export function evaluateCaptureEvalSafety(metrics: CaptureEvalMetrics): CaptureEvalSafetyResult {
  if (metrics.unsupportedUrlRate === null) return { passed: true, unsupportedUrlStatus: 'excluded' };
  if (metrics.unsupportedUrlRate === 0) return { passed: true, unsupportedUrlStatus: 'passed' };
  return { passed: false, unsupportedUrlStatus: 'failed' };
}
