import 'dotenv/config';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  FIELD_GUESS_PROMPT_MAX_CHARS,
  FIELD_GUESS_SYSTEM_PROMPT,
  buildFieldGuessPrompt,
  buildFieldGuessTool,
} from '../src/field-guess/prompt.js';
import { resolveFieldGuessReferences, type FieldGuessReferenceEngine } from '../src/field-guess/references.js';
import { sanitizeFieldGuessOutput } from '../src/field-guess/sanitize.js';
import type { SanitizedFieldGuessDecision } from '../src/field-guess/types.js';
import { createDispatchingLlmClient } from '../src/llm/index.js';
import { providerForModel } from '../src/llm/provider-for-model.js';
import { projectFailClosedFailure } from '../src/llm/types.js';
import type { LlmClient, StructuredCallRequest } from '../src/llm/types.js';
import type { EngineNode, EngineNodeSummary } from '../src/types.js';
import {
  FIELD_GUESS_LIVE_FIXTURES,
  type FieldGuessLiveFixture,
} from '../test/field-guess-live-fixtures.js';

export const FIELD_GUESS_LIVE_MODEL = 'accounts/fireworks/models/gpt-oss-120b';
export const FIELD_GUESS_LIVE_MAX_TOKENS = 2_000;
export const FIELD_GUESS_LIVE_FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';

const FIELD_GUESS_LIVE_DIAGNOSTIC_MAX_CHARS = 2_000;
const FIELD_GUESS_LIVE_DIAGNOSTIC_MAX_FIELDS = 6;
const FIELD_GUESS_LIVE_DIAGNOSTIC_FIELD_MAX_CHARS = 40;
const FIELD_GUESS_LIVE_DIAGNOSTIC_FIXTURE_MAX_CHARS = 80;
const OMITTED_FIELD_REASON = 'Model omitted this offered field.';

const MUTATION_METHODS = [
  'updateNodeFieldsCas',
  'appendNodeBody',
  'createNode',
  'ensureTopicSchema',
  'wikiWrite',
  'wikiReconcile',
  'wikiWriteThemed',
  'retireThemedPage',
  'refreshHome',
  'createMemory',
  'expireMemory',
  'addTypeToNode',
  'moveNode',
  'recordUsage',
  'updateSettings',
  'registerPromptDefaults',
  'updateNodeFields',
  'refreshMemoryNote',
] as const;

type MutationMethod = (name: typeof MUTATION_METHODS[number]) => (...args: unknown[]) => Promise<never>;

export interface FixtureReferenceEngine extends FieldGuessReferenceEngine {
  updateNodeFieldsCas(...args: unknown[]): Promise<never>;
  appendNodeBody(...args: unknown[]): Promise<never>;
  createNode(...args: unknown[]): Promise<never>;
  ensureTopicSchema(...args: unknown[]): Promise<never>;
  wikiWrite(...args: unknown[]): Promise<never>;
  wikiReconcile(...args: unknown[]): Promise<never>;
  wikiWriteThemed(...args: unknown[]): Promise<never>;
  retireThemedPage(...args: unknown[]): Promise<never>;
  refreshHome(...args: unknown[]): Promise<never>;
  createMemory(...args: unknown[]): Promise<never>;
  expireMemory(...args: unknown[]): Promise<never>;
  addTypeToNode(...args: unknown[]): Promise<never>;
  moveNode(...args: unknown[]): Promise<never>;
  recordUsage(...args: unknown[]): Promise<never>;
  updateSettings(...args: unknown[]): Promise<never>;
  registerPromptDefaults(...args: unknown[]): Promise<never>;
  updateNodeFields(...args: unknown[]): Promise<never>;
  refreshMemoryNote(...args: unknown[]): Promise<never>;
}

export interface FieldGuessLiveEvaluation {
  decisions: Map<string, SanitizedFieldGuessDecision>;
  patch: Record<string, unknown>;
}

function mutationForbidden(method: string): Promise<never> {
  return Promise.reject(new Error(`Fixture Engine mutation forbidden: ${method}`));
}

export function createFixtureReferenceEngine(
  targets: readonly EngineNode[],
): FixtureReferenceEngine {
  const byId = new Map(targets.map(target => [target.id, target]));
  const mutation: MutationMethod = name => (..._args: unknown[]) => mutationForbidden(name);
  const engine: Record<string, unknown> = {
    async findNodesByExactTitle(title: string, limit: number): Promise<EngineNodeSummary[]> {
      if (limit !== 2) throw new Error(`Fixture exact-title lookup requires limit 2, received ${limit}`);
      return targets
        .filter(target => target.title === title)
        .slice(0, limit)
        .map(target => ({
          id: target.id,
          title: target.title,
          file_path: target.file_path ?? '',
          types: [...target.types],
          version: target.version ?? 0,
          field_count: Object.keys(target.fields).length,
        }));
    },
    async getNode(nodeId: string, options: { includeEmbeds: false }): Promise<EngineNode> {
      if (options.includeEmbeds !== false) throw new Error('Fixture canonical refetch forbids embeds');
      const target = byId.get(nodeId);
      if (target === undefined) throw new Error(`Fixture reference target not found: ${nodeId}`);
      return target;
    },
  };
  for (const method of MUTATION_METHODS) engine[method] = mutation(method);
  return engine as unknown as FixtureReferenceEngine;
}

export function buildFieldGuessLiveRequest(
  fixture: FieldGuessLiveFixture,
): StructuredCallRequest {
  const tool = buildFieldGuessTool(fixture.fields);
  return {
    model: FIELD_GUESS_LIVE_MODEL,
    maxTokens: FIELD_GUESS_LIVE_MAX_TOKENS,
    system: FIELD_GUESS_SYSTEM_PROMPT,
    user: buildFieldGuessPrompt(fixture.node, fixture.fields, {
      bodyCharCap: null,
      model: FIELD_GUESS_LIVE_MODEL,
      maxTokens: FIELD_GUESS_LIVE_MAX_TOKENS,
    }),
    toolName: tool.name,
    toolDescription: tool.description,
    schema: tool.schema,
    malformedOutputPolicy: 'fail-closed-redacted',
    providerPromptCharCap: FIELD_GUESS_PROMPT_MAX_CHARS,
  };
}

export async function evaluateFieldGuessLiveOutput(
  fixture: FieldGuessLiveFixture,
  output: unknown,
): Promise<FieldGuessLiveEvaluation> {
  const sanitized = sanitizeFieldGuessOutput(output, fixture.fields);
  const engine = createFixtureReferenceEngine(fixture.referenceTargets);
  const decisions = new Map<string, SanitizedFieldGuessDecision>();
  const patch: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fixture.fields) {
    const decision = sanitized.byField.get(field.field) ?? {
      field: field.field,
      kind: 'abstained' as const,
      reason: 'Model omitted this offered field.',
    };
    const resolvedDecision = await resolveFieldGuessReferences(decision, field, engine);
    decisions.set(field.field, resolvedDecision);
    if (resolvedDecision.kind === 'accepted') patch[field.field] = resolvedDecision.value;
  }
  return { decisions, patch };
}

function boundedDiagnosticIdentifier(value: string, maxChars: number): string {
  const safe = Array.from(value, character => /[A-Za-z0-9_.: -]/u.test(character) ? character : '?');
  if (safe.length <= maxChars) return safe.join('');
  return `${safe.slice(0, maxChars - 3).join('')}...`;
}

function boundedDiagnosticFields(fields: readonly string[]): string {
  const visible = fields.slice(0, FIELD_GUESS_LIVE_DIAGNOSTIC_MAX_FIELDS)
    .map(field => boundedDiagnosticIdentifier(field, FIELD_GUESS_LIVE_DIAGNOSTIC_FIELD_MAX_CHARS));
  const omitted = fields.length - visible.length;
  if (omitted > 0) visible.push(`...(+${omitted} fields omitted)`);
  return `[${visible.join(',')}]`;
}

function diagnosticReason(decision: SanitizedFieldGuessDecision): string {
  if (decision.kind === 'accepted') return 'accepted_decision';
  if (decision.kind === 'abstained') {
    return decision.reason === OMITTED_FIELD_REASON ? 'omitted' : 'explicit_abstention';
  }
  return decision.kind === 'rejected_value' ? 'sanitizer_rejection' : 'reference_rejection';
}

function diagnosticError(error: string): string {
  if (error === 'reserved field name') return 'reserved_field_name';
  if (error === 'duplicate decision') return 'duplicate_decision';
  if (error === 'malformed decision') return 'malformed_decision';
  if (error === 'set decision value must be a string') return 'non_string_set_value';
  if (error === 'value does not satisfy offered field constraints') return 'value_constraint';
  if (error === 'reference title must be non-empty text') return 'invalid_reference_title';
  if (error.startsWith('exact-title lookup failed:')) return 'reference_lookup_failed';
  if (error === 'exact-title lookup returned an invalid node summary') return 'invalid_reference_summary';
  if (error.startsWith('no exact-title node matches')) return 'missing_reference';
  if (error.includes(' is ambiguous')) return 'ambiguous_reference';
  if (error === 'canonical reference title is empty or invalid') return 'invalid_reference_title';
  if (error === 'canonical reference types are invalid') return 'invalid_reference_types';
  if (error.startsWith('reference target must have type')) return 'reference_type_mismatch';
  if (error.startsWith('canonical reference fetch failed:')) return 'reference_fetch_failed';
  if (error === 'reference list must be a non-empty list') return 'invalid_reference_list';
  return 'unclassified_error';
}

function boundedDecisionDiagnostic(
  fixture: FieldGuessLiveFixture,
  evaluation: FieldGuessLiveEvaluation,
): string {
  const visibleFields = fixture.fields.slice(0, FIELD_GUESS_LIVE_DIAGNOSTIC_MAX_FIELDS);
  const decisions = visibleFields.map(field => {
    const decision = evaluation.decisions.get(field.field) ?? {
      field: field.field,
      kind: 'abstained' as const,
      reason: OMITTED_FIELD_REASON,
    };
    const error = decision.error === undefined ? '' : `,error=${diagnosticError(decision.error)}`;
    return `{field=${boundedDiagnosticIdentifier(field.field, FIELD_GUESS_LIVE_DIAGNOSTIC_FIELD_MAX_CHARS)}`
      + `,kind=${decision.kind},reason=${diagnosticReason(decision)}${error}}`;
  });
  const omitted = fixture.fields.length - visibleFields.length;
  if (omitted > 0) decisions.push(`...(+${omitted} fields omitted)`);
  return `[${decisions.join(';')}]`;
}

function expectationFailure(
  fixture: FieldGuessLiveFixture,
  evaluation: FieldGuessLiveEvaluation,
  mismatch: string,
): Error {
  const fixtureName = boundedDiagnosticIdentifier(
    fixture.name,
    FIELD_GUESS_LIVE_DIAGNOSTIC_FIXTURE_MAX_CHARS,
  );
  const message = `Fixture "${fixtureName}" ${mismatch}; decisions=`
    + boundedDecisionDiagnostic(fixture, evaluation);
  const codePoints = Array.from(message);
  if (codePoints.length <= FIELD_GUESS_LIVE_DIAGNOSTIC_MAX_CHARS) return new Error(message);
  const suffix = '...[diagnostic truncated]';
  return new Error(
    codePoints.slice(0, FIELD_GUESS_LIVE_DIAGNOSTIC_MAX_CHARS - suffix.length).join('') + suffix,
  );
}

export function assertFieldGuessLiveExpectation(
  fixture: FieldGuessLiveFixture,
  evaluation: FieldGuessLiveEvaluation,
): void {
  const offered = new Set(fixture.fields.map(field => field.field));
  const unknownPatchKeys = Object.keys(evaluation.patch).filter(field => !offered.has(field));
  if (unknownPatchKeys.length > 0) {
    throw expectationFailure(
      fixture,
      evaluation,
      `unknown patch fields: count=${unknownPatchKeys.length}`,
    );
  }
  if (!isDeepStrictEqual({ ...evaluation.patch }, fixture.expectedPatch)) {
    const expectedFields = Object.keys(fixture.expectedPatch).filter(field => offered.has(field)).sort();
    const receivedFields = Object.keys(evaluation.patch).filter(field => offered.has(field)).sort();
    throw expectationFailure(
      fixture,
      evaluation,
      'patch mismatch: expected_fields='
        + `${boundedDiagnosticFields(expectedFields)}; received_fields=`
        + boundedDiagnosticFields(receivedFields),
    );
  }
  const abstentions = [...evaluation.decisions.values()]
    .filter(decision => decision.kind === 'abstained')
    .map(decision => decision.field)
    .sort();
  const expectedAbstentions = [...fixture.expectedAbstentions].sort();
  if (!isDeepStrictEqual(abstentions, expectedAbstentions)) {
    const expectedFields = expectedAbstentions.filter(field => offered.has(field));
    throw expectationFailure(
      fixture,
      evaluation,
      'abstention mismatch: expected_fields='
        + `${boundedDiagnosticFields(expectedFields)}; received_fields=`
        + boundedDiagnosticFields(abstentions),
    );
  }
}

export async function runFieldGuessLiveHarness(
  llm: LlmClient,
  fixtures: readonly FieldGuessLiveFixture[] = FIELD_GUESS_LIVE_FIXTURES,
): Promise<FieldGuessLiveEvaluation[]> {
  const evaluations: FieldGuessLiveEvaluation[] = [];
  for (const fixture of fixtures) {
    let response: Awaited<ReturnType<LlmClient['structuredCall']>>;
    try {
      response = await llm.structuredCall(buildFieldGuessLiveRequest(fixture));
    } catch (error) {
      throw projectFailClosedFailure(error, 'provider_call_failed');
    }
    const evaluation = await evaluateFieldGuessLiveOutput(fixture, response.output);
    assertFieldGuessLiveExpectation(fixture, evaluation);
    evaluations.push(evaluation);
    const outcomes = [...evaluation.decisions.values()]
      .map(decision => `${decision.field}:${decision.kind}`)
      .join(', ');
    console.log(`[field-guess-live] PASS ${fixture.name} (${outcomes})`);
  }
  return evaluations;
}

export function requireFireworksCredential(env: NodeJS.ProcessEnv = process.env): string {
  const credential = env.OPENAI_COMPAT_API_KEY?.trim();
  if (!credential) {
    throw new Error('OPENAI_COMPAT_API_KEY is not set; the live Fireworks gate was not run');
  }
  return credential;
}

export function createFieldGuessLiveLlm(
  credential: string,
  factory: typeof createDispatchingLlmClient = createDispatchingLlmClient,
): LlmClient {
  return factory({ keys: { fireworks: credential }, baseURLs: { fireworks: FIELD_GUESS_LIVE_FIREWORKS_BASE_URL } }, providerForModel({ [FIELD_GUESS_LIVE_MODEL]: 'fireworks' }));
}

function secretFreeError(error: unknown, secrets: readonly string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret !== '') message = message.split(secret).join('[redacted]');
  }
  return Array.from(message).slice(0, FIELD_GUESS_LIVE_DIAGNOSTIC_MAX_CHARS).join('');
}

export function fieldGuessLiveFailureDiagnostic(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return secretFreeError(error, [env.OPENAI_COMPAT_API_KEY?.trim() ?? '']);
}

async function main(): Promise<void> {
  const credential = requireFireworksCredential();
  const llm = createFieldGuessLiveLlm(credential);
  const evaluations = await runFieldGuessLiveHarness(llm);
  console.log(
    `[field-guess-live] PASS ${evaluations.length}/${FIELD_GUESS_LIVE_FIXTURES.length} fixtures `
      + `(model ${FIELD_GUESS_LIVE_MODEL})`,
  );
}

const entryPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[field-guess-live] failed: ${fieldGuessLiveFailureDiagnostic(error)}`);
    process.exitCode = 1;
  });
}
