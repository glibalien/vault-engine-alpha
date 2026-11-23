import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  descriptorsFor,
  effectiveSettings,
  isModelProvider,
  SEED_MODELS,
  validateValue,
  type CuratorSettings,
  type ModelCatalogEntry,
} from '@vault/settings-registry';
import {
  conversationCaptureFingerprint,
  inspectConversation,
} from '@vault/chat-core/conversation-inspection';
import { loadBootstrapConfig, type BootstrapConfig, type Config } from './config.js';
import {
  evaluateConversationCaptureCandidate,
  type ConversationCaptureEvaluationReason,
} from './conversation-capture-sweep.js';
import {
  captureEvalCorpusPath,
  loadCaptureEvalCorpus,
  type CaptureEvalFixture,
} from './eval/capture-corpus.js';
import {
  computeCaptureEvalMetrics,
  evaluateCaptureEvalSafety,
  findUnsupportedCaptureUrls,
  type CaptureEvalCoverageAdjudication,
  type CaptureEvalMetrics,
  type CaptureEvalRow,
  type CaptureEvalSafetyResult,
} from './eval/capture-metrics.js';
import {
  CAPTURE_STANDALONE_JUDGE_FAILURE_REASON,
  deterministicCaptureStandaloneUsefulness,
  judgeCaptureStandaloneUsefulness,
  unavailableCaptureStandaloneUsefulness,
  type CaptureEvalExactArtifact,
  type CaptureStandaloneUsefulness,
} from './eval/capture-standalone-judge.js';
import { Engine, type ModelsDomainPayload, type SettingsDomainPayload } from './engine.js';
import { createDispatchingLlmClient } from './llm/index.js';
import { providerForModel } from './llm/provider-for-model.js';
import type { LlmClient, StructuredCallResult } from './llm/types.js';
import { buildRuntimeConfig, vaultFromPayload } from './settings.js';

const ZERO_USAGE = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } as const;

export type CaptureEvalMode = 'offline' | 'live';

export interface CaptureEvalEvaluatedRow extends CaptureEvalRow {
  id: string;
  status: 'capture' | 'skip' | 'deferred';
  reasonCode: ConversationCaptureEvaluationReason;
  reason: string;
  proposalCount: number;
  /** Exact composer outputs, retained verbatim for qualitative review. */
  artifacts: CaptureEvalExactArtifact[];
}

export interface CaptureEvalReportRow extends CaptureEvalEvaluatedRow {
  standaloneUsefulness: CaptureStandaloneUsefulness;
}

export interface CaptureEvalReport {
  version: 1;
  mode: CaptureEvalMode;
  /** Backward-compatible alias for plannerComposerModel. */
  model: string;
  plannerComposerModel: string;
  coverageModel: string;
  fixtureCount: number;
  metrics: CaptureEvalMetrics;
  safetyResult: CaptureEvalSafetyResult;
  schemaFailures: string[];
  expectationFailures: string[];
  /** Missing, thrown, or schema-invalid required judge results are runner failures. */
  standaloneJudgeFailures: string[];
  passed: boolean;
  rows: CaptureEvalReportRow[];
}

export interface CaptureEvalRunResult {
  outputDirectory: string;
  report: CaptureEvalReport;
}

export interface CaptureEvalArgs {
  mode: CaptureEvalMode;
  fixtureId?: string;
}

export function parseCaptureEvalArgs(argv: readonly string[]): CaptureEvalArgs {
  let offline = false;
  let live = false;
  let fixtureId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--offline') offline = true;
    else if (arg === '--live') live = true;
    else if (arg === '--fixture') {
      if (fixtureId !== undefined) throw new Error('--fixture may be specified only once');
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--fixture requires a value in the form --fixture <exact-id>');
      }
      fixtureId = value;
      index += 1;
    } else if (arg.startsWith('--fixture=')) {
      throw new Error('use --fixture <exact-id>; --fixture=id is not accepted');
    } else if (arg === '--help' || arg === '-h') continue;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (offline && live) throw new Error('--offline and --live are mutually exclusive');
  return {
    mode: offline ? 'offline' : 'live',
    ...(fixtureId === undefined ? {} : { fixtureId }),
  };
}

const OFFLINE_BOOTSTRAP: BootstrapConfig = {
  engineUrl: 'http://offline.invalid',
  engineToken: 'offline',
  experiment: null,
  variant: null,
  llmKeys: { keys: {}, baseURLs: { fireworks: 'https://offline.invalid' } },
  oauthOwnerPassword: undefined,
  oauthIssuerUrl: undefined,
  curatorPort: 3335,
  curatorDbPath: ':memory:',
  memorySweepSince: null,
  conversationSweepSince: null,
};

/** Deterministic credential-free config built through the production settings
 * resolver. The prose floor is disabled only for the eval corpus so its fixed
 * short reference fixture reaches the semantic planner. */
export function offlineCaptureEvalConfig(): Config {
  const settings = effectiveSettings<CuratorSettings>('curator', {});
  return {
    ...buildRuntimeConfig(OFFLINE_BOOTSTRAP, settings, [...SEED_MODELS]),
    conversationCaptureMinAssistantChars: 0,
  };
}

export interface ReadOnlyCaptureEvalSettingsReader {
  getSettings(domain?: string): Promise<{
    settingsDir?: string;
    domains: Record<string, SettingsDomainPayload | ModelsDomainPayload>;
  }>;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validateLiveCuratorDomain(value: unknown): CuratorSettings {
  const payload = recordValue(value);
  if (payload === null) throw new Error('invalid curator domain: payload must be an object');
  const effective = recordValue(payload.effective);
  if (effective === null) throw new Error('invalid curator domain: effective settings must be an object');
  if (recordValue(payload.stored) === null) throw new Error('invalid curator domain: stored settings must be an object');
  if (!Number.isInteger(payload.version) || (payload.version as number) < 0) {
    throw new Error('invalid curator domain: version must be a non-negative integer');
  }
  if (typeof payload.seeded !== 'boolean') throw new Error('invalid curator domain: seeded must be boolean');
  if (!Array.isArray(payload.issues)) throw new Error('invalid curator domain: issues must be an array');

  for (const descriptor of descriptorsFor('curator')) {
    if (!Object.prototype.hasOwnProperty.call(effective, descriptor.key)) {
      throw new Error(`invalid curator domain: effective.${descriptor.key} is required`);
    }
    const issue = validateValue(descriptor, effective[descriptor.key]);
    if (issue !== null) throw new Error(`invalid curator domain: effective.${descriptor.key} ${issue}`);
  }
  return effective as unknown as CuratorSettings;
}

function validateLiveModelsDomain(value: unknown): ModelCatalogEntry[] {
  const payload = recordValue(value);
  if (payload === null) throw new Error('invalid models domain: payload must be an object');
  if (!Array.isArray(payload.catalog)) throw new Error('invalid models domain: catalog must be an array');
  const providers = recordValue(payload.providers);
  if (providers === null || Object.values(providers).some((enabled) => typeof enabled !== 'boolean')) {
    throw new Error('invalid models domain: providers must be an object of booleans');
  }
  if (!Number.isInteger(payload.version) || (payload.version as number) < 0) {
    throw new Error('invalid models domain: version must be a non-negative integer');
  }
  if (!Array.isArray(payload.issues)) throw new Error('invalid models domain: issues must be an array');

  return payload.catalog.map((value: unknown, index: number): ModelCatalogEntry => {
    const entry = recordValue(value);
    if (entry === null) throw new Error(`invalid models domain: catalog[${index}] must be an object`);
    if (typeof entry.title !== 'string' || entry.title.trim() === '') {
      throw new Error(`invalid models domain: catalog[${index}].title must be a non-empty string`);
    }
    if (!isModelProvider(entry.provider)) {
      throw new Error(`invalid models domain: catalog[${index}].provider is unsupported`);
    }
    if (typeof entry.model !== 'string' || entry.model.trim() === '') {
      throw new Error(`invalid models domain: catalog[${index}].model must be a non-empty string`);
    }
    if (typeof entry.enabled !== 'boolean') {
      throw new Error(`invalid models domain: catalog[${index}].enabled must be boolean`);
    }
    return {
      title: entry.title,
      provider: entry.provider,
      model: entry.model,
      enabled: entry.enabled,
    };
  });
}

/** Resolve the live capture eval from one get-settings snapshot. Unlike normal
 * service boot, this path never seeds settings or registers prompt defaults. */
export async function resolveReadOnlyCaptureEvalConfig(
  bootstrap: BootstrapConfig,
  reader: ReadOnlyCaptureEvalSettingsReader,
): Promise<Config> {
  const { domains, settingsDir } = await reader.getSettings();
  const curator = domains['curator'];
  const models = domains['models'];
  if (curator === undefined) throw new Error('live capture eval settings snapshot missing required "curator" domain');
  if (models === undefined) throw new Error('live capture eval settings snapshot missing required "models" domain');
  const settings = validateLiveCuratorDomain(curator);
  const catalog = validateLiveModelsDomain(models);
  const vault = vaultFromPayload(domains);
  return buildRuntimeConfig(bootstrap, settings, catalog, { settingsDir, ...(vault ? { vault } : {}) });
}

function captureEvalConfig(config: Config): Config {
  return { ...config, conversationCaptureMinAssistantChars: 0 };
}

function plannerOutput(fixture: CaptureEvalFixture): unknown {
  const inspection = inspectConversation(fixture.conversation.messages);
  if (!fixture.expected.shouldCapture && fixture.expected.coverage !== 'full') {
    const reasonCode = fixture.id === 'unsourced-factual'
      ? 'ungrounded-factual'
      : 'not-valuable';
    return {
      outcome: 'skip', reason_code: reasonCode, reason: `offline label: ${fixture.id}`, artifacts: [],
    };
  }

  const assistantIds = inspection.turns.filter((turn) => turn.role === 'assistant').map((turn) => turn.messageId);
  const artifactCount = fixture.expected.coverage === 'full'
    ? 1
    : fixture.expected.expectedArtifactCount ?? 1;
  if (assistantIds.length < artifactCount) throw new Error(`offline fixture ${fixture.id} needs ${artifactCount} assistant evidence turns`);
  const destinations = fixture.expected.expectedDestinationIds
    ?? fixture.linked_nodes.map((node) => node.id);
  const expectedSources = fixture.expected.expectedSourceUrls ?? [];
  return {
    outcome: 'capture',
    reason_code: 'capture',
    reason: `offline label: ${fixture.id}`,
    artifacts: Array.from({ length: artifactCount }, (_, index) => {
      const representativePartial = fixture.id === 'partially-captured-answer' && index === 0;
      return {
        artifact_key: representativePartial ? 'queue-age-starvation' : `${fixture.id}-${index + 1}`,
        title: representativePartial ? 'Queue age starvation signal' : `${fixture.conversation.title} ${index + 1}`,
        brief: representativePartial
          ? 'Explain how queue age reveals starvation duration even when depth alone looks acceptable.'
          : `Retain the labelled durable value for ${fixture.id}, artifact ${index + 1}.`,
        assistant_message_ids: [assistantIds[index]],
        source_urls: index === 0 ? expectedSources : [],
        destination_node_id: destinations.length === 0
          ? 'unbound'
          : destinations[Math.min(index, destinations.length - 1)],
      };
    }),
  };
}

function coverageOutput(fixture: CaptureEvalFixture): unknown {
  const toolCallIds = fixture.expected.expectedCoveringToolCallIds ?? [];
  const captureIds = fixture.expected.expectedCoveringCaptureIds ?? [];
  if (fixture.expected.coverage === 'full') {
    return {
      decision: 'full', reason: `offline full coverage: ${fixture.id}`,
      coveringToolCallIds: toolCallIds, coveringCaptureIds: captureIds, missingBrief: '',
    };
  }
  if (fixture.expected.coverage === 'partial') {
    return {
      decision: 'uncovered', reason: `offline missing-only artifact: ${fixture.id}`,
      coveringToolCallIds: [], coveringCaptureIds: [], missingBrief: '',
    };
  }
  return {
    decision: 'uncovered', reason: `offline unrelated coverage: ${fixture.id}`,
    coveringToolCallIds: [], coveringCaptureIds: [], missingBrief: '',
  };
}

interface OfflinePlannerOutput {
  outcome: 'capture' | 'skip';
  artifacts: Array<{ artifact_key: string; title: string; source_urls: string[] }>;
}

function composerOutput(fixture: CaptureEvalFixture, plan: OfflinePlannerOutput): unknown {
  return {
    artifacts: plan.artifacts.map((artifact) => ({
      artifact_key: artifact.artifact_key,
      title: artifact.title,
      markdown: fixture.expected.coverage === 'partial'
        ? 'Queue age reveals starvation duration that queue depth alone can hide; track age alongside depth.'
        : [
            `Standalone durable synthesis for ${fixture.id}.`,
            ...artifact.source_urls.map((url) => `[Observed source](${url})`),
          ].join('\n\n'),
    })),
  };
}

interface OfflineCaptureEvalStage {
  toolName: string;
  output: unknown;
}

function offlineCaptureEvalStages(fixture: CaptureEvalFixture): OfflineCaptureEvalStage[] {
  const plan = plannerOutput(fixture) as OfflinePlannerOutput;
  const stages: OfflineCaptureEvalStage[] = [{
    toolName: 'plan_conversation_capture', output: plan,
  }];
  if (plan.outcome === 'skip') return stages;

  const inspection = inspectConversation(fixture.conversation.messages);
  const hasCoverageEvidence = inspection.writeReceipts.length > 0 || fixture.prior_captures.length > 0;
  if (hasCoverageEvidence) {
    for (const _artifact of plan.artifacts) {
      stages.push({
        toolName: 'adjudicate_conversation_capture_coverage',
        output: coverageOutput(fixture),
      });
    }
  }
  if (fixture.expected.coverage !== 'full') {
    stages.push({ toolName: 'compose_conversation_capture', output: composerOutput(fixture, plan) });
  }
  return stages;
}

/** A deterministic model double for plumbing/safety regression runs. It emits
 * raw advisory-schema objects; production sanitizers still accept or reject
 * them and production routing/grouping still creates the proposals. */
export function createOfflineCaptureEvalLlm(fixture: CaptureEvalFixture): LlmClient {
  const stages = offlineCaptureEvalStages(fixture);
  let stageIndex = 0;
  return {
    async structuredCall(request): Promise<StructuredCallResult> {
      const stage = stages[stageIndex];
      if (stage === undefined) {
        throw new Error(`offline capture eval received unexpected extra tool ${request.toolName}`);
      }
      if (stage.toolName !== request.toolName) {
        throw new Error(`offline capture eval expected ${stage.toolName}, received ${request.toolName}`);
      }
      stageIndex += 1;
      return { output: stage.output, usage: { ...ZERO_USAGE } };
    },
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function exactSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length
    && expected.every((value) => actual.includes(value));
}

function savedCoverageAdjudications(
  adjudications: ReadonlyArray<{
    artifactKey: string;
    decision: 'uncovered' | 'partial' | 'full';
    coveringToolCallIds: readonly string[];
    coveringCaptureIds: readonly string[];
    missingBrief: string;
  }>,
): CaptureEvalCoverageAdjudication[] {
  return adjudications.map((adjudication) => ({
    artifactKey: adjudication.artifactKey,
    decision: adjudication.decision,
    coveringToolCallIds: [...adjudication.coveringToolCallIds],
    coveringCaptureIds: [...adjudication.coveringCaptureIds],
    missingBrief: adjudication.missingBrief,
  }));
}

function retainedExpectedPartialValue(args: {
  expected: CaptureEvalFixture['expected'];
  status: 'capture' | 'skip' | 'deferred';
  adjudications: readonly CaptureEvalCoverageAdjudication[];
  artifacts: readonly CaptureEvalExactArtifact[];
}): boolean {
  if (args.expected.coverage !== 'partial' || args.status !== 'capture') return false;
  const adjudication = args.adjudications.find((candidate) => (
    (candidate.decision === 'partial'
      && exactSet(candidate.coveringToolCallIds, args.expected.expectedCoveringToolCallIds ?? [])
      && exactSet(candidate.coveringCaptureIds, args.expected.expectedCoveringCaptureIds ?? []))
    || (candidate.decision === 'uncovered'
      && candidate.coveringToolCallIds.length === 0
      && candidate.coveringCaptureIds.length === 0
      && candidate.missingBrief === '')
  ));
  if (adjudication === undefined) return false;
  const artifact = args.artifacts.find((candidate) => candidate.artifactKey === adjudication.artifactKey);
  if (artifact === undefined) return false;
  const markdown = artifact.markdown.toLocaleLowerCase('en-US');
  const includes = args.expected.expectedPartialMarkdownIncludes ?? [];
  const excludes = args.expected.expectedPartialMarkdownExcludes ?? [];
  return includes.every((label) => markdown.includes(label.toLocaleLowerCase('en-US')))
    && excludes.every((label) => !markdown.includes(label.toLocaleLowerCase('en-US')));
}

/** Evaluate one raw fixture through the exact mutation-free production seam.
 * No Engine object is accepted here: messages, linked reads, and prior
 * same-conversation captures are all explicit immutable inputs. */
export async function evaluateCaptureEvalFixture(
  fixture: CaptureEvalFixture,
  deps: { llm: LlmClient; config: Config },
): Promise<CaptureEvalEvaluatedRow> {
  const inspection = inspectConversation(fixture.conversation.messages);
  const linkedDocs = [...fixture.conversation.linked_docs];
  const evaluation = await evaluateConversationCaptureCandidate(
    { llm: deps.llm, config: deps.config },
    {
      conversation: {
        id: fixture.conversation.id,
        title: fixture.conversation.title,
        updatedAt: fixture.conversation.updated_at,
        linkedDocs,
      },
      inspection,
      inputHash: conversationCaptureFingerprint(inspection, linkedDocs),
      linkedNodeReads: fixture.linked_nodes.map((node) => ({
        nodeId: node.id,
        ok: true as const,
        node: {
          id: node.id,
          title: node.title,
          filePath: node.file_path,
          body: node.body_excerpt,
          fields: { ...node.fields },
        },
      })),
      priorCaptures: fixture.prior_captures.map((capture) => ({
        captureId: capture.capture_id,
        markdown: capture.markdown,
      })),
    },
  );

  const sourceUrls = sortedUnique(evaluation.artifacts.flatMap((artifact) => artifact.sourceUrls));
  const artifacts = evaluation.artifacts.map((artifact) => ({
    artifactKey: artifact.artifactKey,
    title: artifact.title,
    markdown: artifact.markdown,
    sourceUrls: [...artifact.sourceUrls],
  }));
  const coverageAdjudications = savedCoverageAdjudications(evaluation.coverageAdjudications);
  return {
    id: fixture.id,
    expected: fixture.expected,
    coverageAdjudications,
    actual: {
      captured: evaluation.status === 'capture',
      artifactCount: evaluation.plannedArtifactCount,
      destinationIds: sortedUnique(evaluation.proposals.flatMap((proposal) => (
        proposal.destinationNodeId === undefined ? [] : [proposal.destinationNodeId]
      ))),
      sourceUrls,
      unsupportedUrls: findUnsupportedCaptureUrls(sourceUrls, inspection.sources.map((source) => source.url)),
      retainedPartialValue: retainedExpectedPartialValue({
        expected: fixture.expected,
        status: evaluation.status,
        adjudications: coverageAdjudications,
        artifacts,
      }),
    },
    status: evaluation.status,
    reasonCode: evaluation.reasonCode,
    reason: evaluation.reason,
    proposalCount: evaluation.proposals.length,
    artifacts,
  };
}

function expectationFailures(rows: readonly CaptureEvalEvaluatedRow[]): string[] {
  const failures: string[] = [];
  for (const row of rows) {
    if (row.actual.captured !== row.expected.shouldCapture) failures.push(`${row.id}: capture decision`);
    if (row.expected.expectedArtifactCount !== undefined
      && row.actual.artifactCount !== row.expected.expectedArtifactCount) failures.push(`${row.id}: artifact count`);
    if (row.expected.expectedDestinationIds !== undefined
      && !exactSet(row.actual.destinationIds, row.expected.expectedDestinationIds)) failures.push(`${row.id}: destinations`);
    if (row.expected.expectedSourceUrls !== undefined
      && !exactSet(row.actual.sourceUrls, row.expected.expectedSourceUrls)) failures.push(`${row.id}: sources`);
    if (row.expected.coverage === 'full') {
      const hasExactFullProof = row.coverageAdjudications.some((adjudication) => (
        adjudication.decision === 'full'
        && exactSet(adjudication.coveringToolCallIds, row.expected.expectedCoveringToolCallIds ?? [])
        && exactSet(adjudication.coveringCaptureIds, row.expected.expectedCoveringCaptureIds ?? [])
      ));
      if (row.status !== 'skip' || row.reasonCode !== 'fully-covered' || !hasExactFullProof) {
        failures.push(`${row.id}: full coverage suppression with exact proof`);
      }
    }
    if (row.expected.shouldCapture && row.expected.coverage === 'none') {
      const allArtifactsAreUncovered = row.actual.artifactCount > 0
        && row.coverageAdjudications.length === row.actual.artifactCount
        && row.coverageAdjudications.every((adjudication) => (
          adjudication.decision === 'uncovered'
          && adjudication.coveringToolCallIds.length === 0
          && adjudication.coveringCaptureIds.length === 0
          && adjudication.missingBrief === ''
        ));
      if (!allArtifactsAreUncovered) {
        failures.push(`${row.id}: uncovered adjudications with empty proof`);
      }
    }
    if (row.expected.coverage === 'partial' && !row.actual.retainedPartialValue) failures.push(`${row.id}: partial value`);
  }
  return failures;
}

function markdownReport(report: CaptureEvalReport): string {
  const lines = [
    '# Conversation capture evaluation',
    '',
    `- Mode: ${report.mode}`,
    `- Model: ${report.model}`,
    `- Planner/composer model: ${report.plannerComposerModel}`,
    `- Coverage model: ${report.coverageModel}`,
    `- Fixtures: ${report.fixtureCount}`,
    `- Overall release result: ${report.passed ? 'PASS' : 'FAIL'}`,
    `- Unsupported-URL safety result: ${report.safetyResult.passed ? 'PASS' : 'FAIL'}`,
    `- Schema/model execution result: ${report.schemaFailures.length === 0 ? 'PASS' : 'FAIL'}`,
    `- Standalone-judge execution result: ${report.standaloneJudgeFailures.length === 0 ? 'PASS' : 'FAIL'}`,
    `- Fixture expectation result: ${report.expectationFailures.length === 0 ? 'PASS' : 'FAIL'}`,
    '- Standalone usefulness: qualitative review only (no numeric gate)',
    '',
    '## Metrics',
    '',
    '| Metric | Value | Handling |',
    '|---|---:|---|',
  ];
  for (const [metric, value] of Object.entries(report.metrics)) {
    const handling = value === null
      ? 'excluded (zero denominator)'
      : metric === 'unsupportedUrlRate'
        ? `hard safety: ${report.safetyResult.unsupportedUrlStatus}`
        : 'reported (no approved cutoff)';
    lines.push(`| ${metric} | ${value === null ? 'null' : value.toFixed(4)} | ${handling} |`);
  }
  lines.push('', '## Fixtures', '', '| ID | Expected | Actual | Artifacts | Destinations | Sources | Standalone usefulness | Reason |', '|---|---|---|---:|---|---|---|---|');
  for (const row of report.rows) {
    lines.push(`| ${row.id} | ${row.expected.shouldCapture ? 'capture' : 'skip'} | ${row.status} | ${row.actual.artifactCount} | ${row.actual.destinationIds.join(', ')} | ${row.actual.sourceUrls.join(', ')} | ${row.standaloneUsefulness.assessment} | ${row.reasonCode} |`);
  }
  if (report.schemaFailures.length > 0) lines.push('', '## Schema/model failures', '', ...report.schemaFailures.map((failure) => `- ${failure}`));
  if (report.expectationFailures.length > 0) lines.push('', '## Expectation mismatches', '', ...report.expectationFailures.map((failure) => `- ${failure}`));
  if (report.standaloneJudgeFailures.length > 0) {
    lines.push('', '## Standalone judge execution/schema failures', '', ...report.standaloneJudgeFailures.map((failure) => `- ${failure}`));
  }
  lines.push('', '## Coverage adjudications');
  for (const row of report.rows) {
    for (const adjudication of row.coverageAdjudications) {
      lines.push(
        '',
        `### ${row.id} / ${adjudication.artifactKey}`,
        '',
        `- Decision: ${adjudication.decision}`,
        `- Covering tool-call IDs: ${adjudication.coveringToolCallIds.join(', ') || '(none)'}`,
        `- Covering capture IDs: ${adjudication.coveringCaptureIds.join(', ') || '(none)'}`,
        `- Missing brief: ${JSON.stringify(adjudication.missingBrief)}`,
      );
    }
  }
  lines.push('', '## Exact generated artifacts');
  for (const row of report.rows) {
    for (const artifact of row.artifacts) {
      const judgment = row.standaloneUsefulness.artifactJudgments
        .find((candidate) => candidate.artifactKey === artifact.artifactKey);
      const longestFence = Math.max(2, ...[...artifact.markdown.matchAll(/`+/g)].map((match) => match[0].length));
      const fence = '`'.repeat(longestFence + 1);
      lines.push(
        '',
        `### ${row.id} / ${artifact.artifactKey}`,
        '',
        `- Title: ${artifact.title}`,
        `- Standalone usefulness: ${judgment?.assessment ?? row.standaloneUsefulness.assessment}`,
        `- Rationale: ${judgment?.rationale ?? row.standaloneUsefulness.rationale}`,
        '',
        fence,
        artifact.markdown,
        fence,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function selectCaptureEvalFixtures(
  fixtures: readonly CaptureEvalFixture[],
  fixtureId?: string,
): CaptureEvalFixture[] {
  if (fixtureId === undefined) return [...fixtures];
  const fixture = fixtures.find((candidate) => candidate.id === fixtureId);
  if (fixture === undefined) throw new Error(`unknown capture eval fixture "${fixtureId}"`);
  return [fixture];
}

export async function runCaptureEval(options: {
  mode: CaptureEvalMode;
  corpusPath?: string | URL;
  fixtureId?: string;
  fixtures?: readonly CaptureEvalFixture[];
  outputParent?: string;
  config?: Config;
  llm?: LlmClient;
}): Promise<CaptureEvalRunResult> {
  const corpus = options.fixtures === undefined
    ? loadCaptureEvalCorpus(options.corpusPath ?? captureEvalCorpusPath())
    : [...options.fixtures];
  const fixtures = selectCaptureEvalFixtures(corpus, options.fixtureId);
  if (options.mode === 'live' && options.config === undefined) {
    throw new Error('live capture eval requires a configured runtime config');
  }
  if (options.mode === 'live' && options.llm === undefined) {
    throw new Error('live capture eval requires a configured LLM client');
  }
  const config = captureEvalConfig(options.config ?? offlineCaptureEvalConfig());

  const rows: CaptureEvalReportRow[] = [];
  const standaloneJudgeFailures: string[] = [];
  const plannerComposerModel = options.mode === 'offline'
    ? 'offline-deterministic'
    : config.conversationCaptureModel ?? config.model;
  const coverageModel = options.mode === 'offline'
    ? 'offline-deterministic'
    : config.conversationCaptureCoverageModel
      ?? config.conversationCaptureModel
      ?? config.model;
  for (const fixture of fixtures) {
    const evaluated = await evaluateCaptureEvalFixture(fixture, {
      config,
      llm: options.mode === 'offline' ? createOfflineCaptureEvalLlm(fixture) : options.llm!,
    });
    let standaloneUsefulness: CaptureStandaloneUsefulness;
    if (options.mode === 'offline') {
      standaloneUsefulness = deterministicCaptureStandaloneUsefulness(evaluated.artifacts);
    } else {
      try {
        standaloneUsefulness = await judgeCaptureStandaloneUsefulness({
          llm: options.llm!,
          model: plannerComposerModel,
          maxTokens: config.conversationCapturePlannerMaxTokens,
          artifacts: evaluated.artifacts,
        });
      } catch {
        standaloneJudgeFailures.push(`${fixture.id}: ${CAPTURE_STANDALONE_JUDGE_FAILURE_REASON}`);
        standaloneUsefulness = unavailableCaptureStandaloneUsefulness();
      }
    }
    rows.push({ ...evaluated, standaloneUsefulness });
  }
  const metrics = computeCaptureEvalMetrics(rows);
  const safetyResult = evaluateCaptureEvalSafety(metrics);
  const schemaFailures = rows
    .filter((row) => row.reasonCode === 'model-error')
    .map((row) => `${row.id}: ${row.reason}`);
  const mismatches = expectationFailures(rows);
  const report: CaptureEvalReport = {
    version: 1,
    mode: options.mode,
    model: plannerComposerModel,
    plannerComposerModel,
    coverageModel,
    fixtureCount: fixtures.length,
    metrics,
    safetyResult,
    schemaFailures,
    expectationFailures: mismatches,
    standaloneJudgeFailures,
    // Qualitative labels are not a numeric gate; a missing/invalid required
    // judgment is still an eval runner/schema failure.
    passed: safetyResult.passed
      && schemaFailures.length === 0
      && mismatches.length === 0
      && standaloneJudgeFailures.length === 0,
    rows,
  };

  const outputDirectory = mkdtempSync(join(options.outputParent ?? tmpdir(), 'vault-capture-eval-'));
  writeFileSync(join(outputDirectory, 'capture-eval.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(outputDirectory, 'capture-eval.md'), markdownReport(report), 'utf8');
  return { outputDirectory, report };
}

function printHelp(): void {
  console.log(`Conversation capture evaluation\n\nUsage: npm run eval:capture -w vault-curator -- [--live | --offline] [--fixture <exact-id>]\n\n  --live                 Use the configured capture model, prompts, and token budgets (default)\n  --offline              Deterministic credential-free production-seam regression run\n  --fixture <exact-id>   Evaluate exactly one corpus fixture`);
}

export function captureEvalExitCode(report: Pick<CaptureEvalReport, 'passed'>): 0 | 1 {
  return report.passed ? 0 : 1;
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    printHelp();
    return;
  }
  const args = parseCaptureEvalArgs(process.argv.slice(2));
  const fixtures = selectCaptureEvalFixtures(loadCaptureEvalCorpus(captureEvalCorpusPath()), args.fixtureId);
  let result: CaptureEvalRunResult;
  if (args.mode === 'offline') {
    result = await runCaptureEval({ mode: 'offline', fixtures });
  } else {
    const bootstrap = loadBootstrapConfig();
    const engine = new Engine(bootstrap);
    try {
      const config = await resolveReadOnlyCaptureEvalConfig(bootstrap, engine);
      const llm = createDispatchingLlmClient(
        bootstrap.llmKeys,
        providerForModel(config.modelProviders),
        { reasoningEffort: config.reasoningEffort },
      );
      result = await runCaptureEval({ mode: 'live', config, llm, fixtures });
    } finally {
      await engine.close();
    }
  }

  console.log(`conversation capture eval (${result.report.mode}, model ${result.report.model})`);
  for (const [metric, value] of Object.entries(result.report.metrics)) {
    const handling = value === null
      ? 'excluded: zero denominator'
      : metric === 'unsupportedUrlRate'
        ? `hard safety ${result.report.safetyResult.unsupportedUrlStatus}`
        : 'reported: no approved cutoff';
    console.log(`${metric}: ${value === null ? 'null' : value.toFixed(4)} [${handling}]`);
  }
  console.log(`Report directory: ${result.outputDirectory}`);
  const exitCode = captureEvalExitCode(result.report);
  if (exitCode !== 0) process.exitCode = exitCode;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[eval-capture] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
