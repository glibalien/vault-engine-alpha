import { randomUUID } from 'node:crypto';
import { insertFieldGuessAttempts, terminalFieldGuessFields } from '../db/field-guess.js';
import { budgetRefusalDetail } from '../budget.js';
import { EngineError } from '../engine.js';
import { projectFailClosedFailure } from '../llm/types.js';
import type { StructuredCallRequest } from '../llm/types.js';
import { RejectionBreaker } from '../rejection-breaker.js';
import {
  buildFieldGuessPrompt,
  buildFieldGuessTool,
  fieldGuessEvidenceHash,
  FIELD_GUESS_PROMPT_MAX_CHARS,
  FIELD_GUESS_SYSTEM_PROMPT,
} from './prompt.js';
import { resolveFieldGuessReferences } from './references.js';
import { sanitizeFieldGuessOutput } from './sanitize.js';
import {
  FIELD_GUESS_ACTION_MAX_CHARS,
  FIELD_GUESS_CLASSIFIER_VERSION,
  FIELD_GUESS_EVIDENCE_VERSION,
  FIELD_GUESS_ERROR_MAX_CHARS,
  type FieldGuessAttemptInput,
  type FieldGuessFieldCandidate,
  type FieldGuessNodeCandidate,
  type FieldGuessNoteOutcome,
  type FieldGuessOutcome,
  type SanitizedFieldGuessDecision,
  type FieldGuessSweepDeps,
  type FieldGuessSweepOptions,
  type FieldGuessSweepResult,
  type FieldGuessSweepSkipReason,
} from './types.js';

const CANDIDATE_PAGE_LIMIT = 100;

/** A result with every count at zero. */
export function emptyFieldGuessResult(dryRun: boolean): FieldGuessSweepResult {
  return {
    ran: true,
    dryRun,
    skipReason: null,
    scannedNodes: 0,
    modelCalls: 0,
    fieldsSet: 0,
    abstentions: 0,
    ledgerSkips: 0,
    missingHashSkips: 0,
    staleNodes: 0,
    deferredNodes: 0,
    referenceErrors: 0,
    providerErrors: 0,
    mutationErrors: 0,
    errors: 0,
    warnings: [],
    actions: [],
  };
}

function truncate(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join('');
}

function inline(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function errorText(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error), FIELD_GUESS_ERROR_MAX_CHARS);
}

function warn(result: FieldGuessSweepResult, message: string): void {
  result.warnings.push(truncate(message, FIELD_GUESS_ERROR_MAX_CHARS));
}

function safeUsageContext(
  deps: FieldGuessSweepDeps,
  result: FieldGuessSweepResult,
  context: Parameters<NonNullable<FieldGuessSweepDeps['usage']>['setContext']>[0],
  label: string,
): void {
  try {
    deps.usage?.setContext(context);
  } catch {
    warn(result, `field guess usage ${label} failed`);
  }
}

function displayTitle(candidate: FieldGuessNodeCandidate, title: unknown): string {
  if (typeof title === 'string' && title.trim() !== '') return inline(title);
  if (candidate.title.trim() !== '') return inline(candidate.title);
  return inline(candidate.file_path || candidate.node_id);
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return inline(value);
  try {
    return inline(JSON.stringify(value) ?? String(value));
  } catch {
    return '[unserializable]';
  }
}

function actionLine(
  dryRun: boolean,
  field: string,
  value: unknown,
  title: string,
  reason: string,
): string {
  return truncate(
    `${dryRun ? 'would guess' : 'guessed'} ${inline(field)}=${displayValue(value)} `
      + `on "${inline(title)}" — ${inline(reason)}`,
    FIELD_GUESS_ACTION_MAX_CHARS,
  );
}

function recordAction(
  deps: FieldGuessSweepDeps,
  opts: FieldGuessSweepOptions,
  result: FieldGuessSweepResult,
  candidate: FieldGuessNodeCandidate,
  title: string,
  line: string,
): void {
  if (deps.recorder === undefined) return;
  try {
    deps.recorder.setContext({
      runRef: opts.runRef,
      trigger: opts.trigger,
      fn: 'field-guess-sweep',
      project: title,
    });
  } catch {
    warn(result, 'field guess journal context setup failed');
  }
  try {
    deps.recorder.record({
      action: 'field-guessed',
      nodeId: candidate.node_id,
      target: truncate(title, FIELD_GUESS_ACTION_MAX_CHARS),
      detail: line,
    });
  } catch {
    warn(result, 'field guess journal action failed');
  } finally {
    try {
      deps.recorder.setContext(null);
    } catch {
      warn(result, 'field guess journal context cleanup failed');
    }
  }
}

function recordSweepSummary(
  deps: FieldGuessSweepDeps,
  opts: FieldGuessSweepOptions,
  result: FieldGuessSweepResult,
): void {
  if (deps.recorder === undefined) return;
  try {
    deps.recorder.setContext({
      runRef: opts.runRef,
      trigger: opts.trigger,
      fn: 'field-guess-sweep',
    });
  } catch {
    warn(result, 'field guess journal summary context setup failed');
  }
  try {
    const line = result.ran
      ? `field guessing: ${result.modelCalls} model calls, ${result.fieldsSet} fields set, ${result.errors} errors`
        + (result.stopped === undefined ? '' : `; ${result.stopped}`)
      : `field guessing: skipped (${result.skipReason ?? 'unknown'})`;
    deps.recorder.summary('field-guess-sweep', line, {
      ran: result.ran,
      skipReason: result.skipReason,
      scannedNodes: result.scannedNodes,
      modelCalls: result.modelCalls,
      fieldsSet: result.fieldsSet,
      abstentions: result.abstentions,
      ledgerSkips: result.ledgerSkips,
      missingHashSkips: result.missingHashSkips,
      staleNodes: result.staleNodes,
      deferredNodes: result.deferredNodes,
      providerErrors: result.providerErrors,
      referenceErrors: result.referenceErrors,
      mutationErrors: result.mutationErrors,
      errors: result.errors,
      ...(result.stopped === undefined ? {} : { stopped: result.stopped }),
    }, opts.dryRun);
  } catch {
    warn(result, 'field guess journal summary failed');
  } finally {
    try {
      deps.recorder.setContext(null);
    } catch {
      warn(result, 'field guess journal summary context cleanup failed');
    }
  }
}

function skip(
  result: FieldGuessSweepResult,
  reason: FieldGuessSweepSkipReason,
  warning?: string,
): FieldGuessSweepResult {
  result.ran = false;
  result.skipReason = reason;
  if (warning !== undefined) warn(result, warning);
  return result;
}

function terminalOfferedFields(
  deps: FieldGuessSweepDeps,
  candidate: FieldGuessNodeCandidate,
  model: string,
  evidenceHash: string,
): FieldGuessFieldCandidate[] {
  if (candidate.content_hash === null) return candidate.fields;
  const terminal = terminalFieldGuessFields(deps.db!, {
    nodeId: candidate.node_id,
    contentHash: candidate.content_hash,
    model,
    classifierVersion: FIELD_GUESS_CLASSIFIER_VERSION,
    evidenceHash,
    evidenceVersion: FIELD_GUESS_EVIDENCE_VERSION,
    fields: candidate.fields.map(field => ({
      field: field.field,
      definitionHash: field.definition_hash,
    })),
  });
  return candidate.fields.filter(field => !terminal.has(field.field));
}

function outcomeForDecision(decision: SanitizedFieldGuessDecision): FieldGuessOutcome {
  if (decision.kind === 'accepted') {
    throw new Error(`Accepted decision ${decision.field} requires a mutation outcome.`);
  }
  return decision.kind;
}

function attemptRows(
  opts: FieldGuessSweepOptions,
  candidate: FieldGuessNodeCandidate,
  offered: readonly FieldGuessFieldCandidate[],
  model: string,
  evidenceHash: string,
  callRef: string,
  attemptedAt: string,
  decisions: ReadonlyMap<string, SanitizedFieldGuessDecision> | null,
  acceptedOutcome: FieldGuessOutcome | null,
  operationError: string | null,
  actions: ReadonlyMap<string, string> = new Map(),
): FieldGuessAttemptInput[] {
  const rows: FieldGuessAttemptInput[] = [];
  for (const field of offered) {
    const decision = decisions?.get(field.field);
    const outcome = decision === undefined
      ? 'provider_error'
      : decision.kind === 'accepted'
        ? (acceptedOutcome ?? 'provider_error')
        : outcomeForDecision(decision);
    rows.push({
      run_ref: opts.runRef,
      call_ref: callRef,
      node_id: candidate.node_id,
      field_name: field.field,
      content_hash: candidate.content_hash!,
      definition_hash: field.definition_hash,
      model,
      classifier_version: FIELD_GUESS_CLASSIFIER_VERSION,
      evidence_hash: evidenceHash,
      evidence_version: FIELD_GUESS_EVIDENCE_VERSION,
      outcome,
      ...(decision?.kind === 'accepted' ? { proposed_value: decision.value } : {}),
      reason: decision?.reason ?? null,
      error: decision === undefined
        ? operationError
        : decision.kind === 'accepted'
          ? operationError
          : decision.error ?? null,
      action: actions.get(field.field) ?? null,
      attempted_at: attemptedAt,
    });
  }
  return rows;
}

function insertAttemptsSafe(
  deps: FieldGuessSweepDeps,
  opts: FieldGuessSweepOptions,
  result: FieldGuessSweepResult,
  rows: readonly FieldGuessAttemptInput[],
): void {
  if (opts.dryRun || rows.length === 0) return;
  try {
    insertFieldGuessAttempts(deps.db!, rows);
  } catch {
    result.errors += 1;
    warn(result, 'field guess attempts were not recorded');
  }
}

function malformedCallResult(response: unknown): boolean {
  return response === null
    || typeof response !== 'object'
    || !Object.hasOwn(response, 'output');
}

async function resolveDecisions(
  deps: FieldGuessSweepDeps,
  fields: readonly FieldGuessFieldCandidate[],
  output: unknown,
): Promise<Map<string, SanitizedFieldGuessDecision>> {
  const sanitized = sanitizeFieldGuessOutput(output, fields);
  const resolved = new Map<string, SanitizedFieldGuessDecision>();
  for (const field of fields) {
    const decision = sanitized.byField.get(field.field);
    if (decision === undefined) {
      resolved.set(field.field, {
        field: field.field,
        kind: 'abstained',
        reason: 'Model omitted this offered field.',
      });
      continue;
    }
    resolved.set(
      field.field,
      await resolveFieldGuessReferences(decision, field, deps.engine),
    );
  }
  return resolved;
}

/** What a note's decisions amount to, for `opts.onNote`. */
/** A stored field value as the note holds it: Engine wraps some in `{ value }`. */
function storedValue(entry: unknown): unknown {
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) && 'value' in entry
    ? (entry as { value: unknown }).value
    : entry;
}

function noteOutcome(
  candidate: FieldGuessNodeCandidate,
  title: string,
  fields: readonly FieldGuessFieldCandidate[],
  decisions: ReadonlyMap<string, SanitizedFieldGuessDecision>,
  operationId: string | null,
  current: Readonly<Record<string, unknown>>,
): FieldGuessNoteOutcome {
  const set: Record<string, unknown> = {};
  const replaced: Record<string, unknown> = {};
  const left: FieldGuessNoteOutcome['left'] = [];
  for (const field of fields) {
    const decision = decisions.get(field.field);
    if (decision === undefined) continue;
    if (decision.kind === 'accepted') {
      set[field.field] = decision.value;
      // An invalid value is the one kind of offered field that already holds something. The
      // Engine says what: it may be text in the note's file that the database never took.
      if (field.eligibility === 'invalid') replaced[field.field] = field.held_text ?? storedValue(current[field.field]);
    } else {
      left.push({ field: field.field, kind: decision.kind, reason: truncate(inline(decision.reason), FIELD_GUESS_ACTION_MAX_CHARS) });
    }
  }
  return { node_id: candidate.node_id, title, file_path: candidate.file_path, set, replaced, left, operation_id: operationId };
}

function notify(opts: FieldGuessSweepOptions, result: FieldGuessSweepResult, outcome: FieldGuessNoteOutcome): void {
  if (opts.onNote === undefined) return;
  try {
    opts.onNote(outcome);
  } catch {
    warn(result, 'field guess note observer failed');
  }
}

/**
 * One candidate note, start to finish: read it, skip what the ledger says was already tried,
 * ask the model, check its answers, and write the accepted fields under the Engine's guard.
 * Every outcome lands in `result` and the attempt ledger; it throws only on an unexpected fault.
 * The nightly sweep and an on-demand run (#644) both call it.
 */
export async function guessFieldsForCandidate(
  deps: FieldGuessSweepDeps,
  opts: FieldGuessSweepOptions,
  candidate: FieldGuessNodeCandidate,
  result: FieldGuessSweepResult,
): Promise<void> {
  const model = deps.config.fieldGuessModel!;
  const fullNode = await deps.engine.getNode(candidate.node_id, { includeEmbeds: false });
  if (fullNode.version !== candidate.version
    || fullNode.metadata?.content_hash !== candidate.content_hash) {
    result.staleNodes += 1;
    return;
  }

  const promptOptions = {
    bodyCharCap: deps.config.bodyCharCap,
    model,
    maxTokens: deps.config.fieldGuessMaxTokens,
    reasoningEffort: deps.config.reasoningEffort,
  };
  const evidenceHash = fieldGuessEvidenceHash(fullNode, candidate.fields, promptOptions);
  let fields: FieldGuessFieldCandidate[];
  try {
    fields = terminalOfferedFields(deps, candidate, model, evidenceHash);
  } catch {
    result.errors += 1;
    warn(result, 'field guess ledger lookup failed');
    return;
  }
  result.ledgerSkips += candidate.fields.length - fields.length;
  if (fields.length === 0) return;

  const tool = buildFieldGuessTool(fields);
  const request: StructuredCallRequest = {
    model,
    maxTokens: deps.config.fieldGuessMaxTokens,
    system: FIELD_GUESS_SYSTEM_PROMPT,
    user: buildFieldGuessPrompt(fullNode, fields, promptOptions),
    toolName: tool.name,
    toolDescription: tool.description,
    schema: tool.schema,
    malformedOutputPolicy: 'fail-closed-redacted',
    providerPromptCharCap: FIELD_GUESS_PROMPT_MAX_CHARS,
  };

  // Admission is irrevocable immediately before entering provider code. Every
  // provider/result/parser exception below consumes this full-sweep call slot.
  result.modelCalls += 1;
  const callRef = randomUUID();
  const attemptedAt = new Date().toISOString();
  let response: Awaited<ReturnType<FieldGuessSweepDeps['llm']['structuredCall']>>;
  safeUsageContext(deps, result, {
    project: 'field-guess-sweep',
    runRef: opts.runRef,
    purpose: opts.purpose ?? 'field-guess',
  }, 'context setup');
  try {
    response = await deps.llm.structuredCall(request);
  } catch (error) {
    // Later calls would be refused the same way, so stop instead of counting an error per
    // note (#359). No attempt is recorded, so this note and the rest are retried next run.
    const budgetStop = new RejectionBreaker('field guess sweep', model).budgetStop(error);
    if (budgetStop !== null) {
      result.deferredNodes += 1;
      result.stopped = budgetStop;
      result.stoppedDetail = truncate(budgetRefusalDetail(error), FIELD_GUESS_ERROR_MAX_CHARS);
      warn(result, budgetStop);
      return;
    }
    const failure = projectFailClosedFailure(error, 'provider_call_failed');
    result.providerErrors += 1;
    result.errors += 1;
    warn(result, 'field guess provider call failed');
    insertAttemptsSafe(deps, opts, result, attemptRows(
      opts,
      candidate,
      fields,
      model,
      evidenceHash,
      callRef,
      attemptedAt,
      null,
      'provider_error',
      errorText(failure),
    ));
    return;
  } finally {
    safeUsageContext(deps, result, null, 'context cleanup');
  }

  let decisions: Map<string, SanitizedFieldGuessDecision>;
  try {
    if (malformedCallResult(response)) throw new Error('malformed structured call result');
    decisions = await resolveDecisions(deps, fields, response.output);
  } catch {
    result.providerErrors += 1;
    result.errors += 1;
    warn(result, 'field guess model output failed');
    insertAttemptsSafe(deps, opts, result, attemptRows(
      opts,
      candidate,
      fields,
      model,
      evidenceHash,
      callRef,
      attemptedAt,
      null,
      'provider_error',
      'Field guess model output failed.',
    ));
    return;
  }

  result.abstentions += [...decisions.values()]
    .filter(decision => decision.kind !== 'accepted').length;
  const referenceErrors = [...decisions.values()]
    .filter(decision => decision.kind === 'reference_error').length;
  result.referenceErrors += referenceErrors;
  result.errors += referenceErrors;
  const setFields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const decision = decisions.get(field.field);
    if (decision?.kind === 'accepted') setFields[field.field] = decision.value;
  }
  if (Object.keys(setFields).length === 0) {
    insertAttemptsSafe(deps, opts, result, attemptRows(
      opts,
      candidate,
      fields,
      model,
      evidenceHash,
      callRef,
      attemptedAt,
      decisions,
      null,
      null,
    ));
    notify(opts, result, noteOutcome(candidate, displayTitle(candidate, fullNode.title), fields, decisions, null, fullNode.fields));
    return;
  }

  let mutationResult: { ok: true; operationId: string | null } | { ok: false; error: unknown };
  try {
    const written = await deps.engine.updateNodeFieldsCas({
      nodeId: candidate.node_id,
      setFields,
      expectedVersion: candidate.version,
      expectedContentHash: candidate.content_hash!,
      guard: {
        offered_fields: fields.map(field => {
          const decision = decisions.get(field.field);
          return {
            field: field.field,
            definition_hash: field.definition_hash,
            ...(decision?.kind === 'accepted' && decision.reference_targets !== undefined
              ? { reference_targets: decision.reference_targets }
              : {}),
          };
        }),
        ...(opts.requested ? { requested: true, ...(opts.replaceInvalid ? { replace_invalid: true } : {}) } : {}),
      },
      dryRun: opts.dryRun,
    });
    const operationId = (written as { operation_id?: unknown } | null | undefined)?.operation_id;
    mutationResult = { ok: true, operationId: typeof operationId === 'string' && !opts.dryRun ? operationId : null };
  } catch (error) {
    mutationResult = { ok: false, error };
  }

  if (!mutationResult.ok) {
    const stale = mutationResult.error instanceof EngineError
      && (mutationResult.error.code === 'STALE_NODE' || mutationResult.error.code === 'CONTENT_HASH_MISMATCH');
    if (stale) {
      result.staleNodes += 1;
    } else {
      result.mutationErrors += 1;
      result.errors += 1;
      warn(result, 'field guess mutation failed');
    }
    insertAttemptsSafe(deps, opts, result, attemptRows(
      opts,
      candidate,
      fields,
      model,
      evidenceHash,
      callRef,
      attemptedAt,
      decisions,
      stale ? 'stale_node' : 'mutation_error',
      'Field guess mutation failed.',
    ));
    return;
  }

  const title = displayTitle(candidate, fullNode.title);
  const actions = new Map<string, string>();
  for (const field of fields) {
    const decision = decisions.get(field.field);
    if (decision?.kind !== 'accepted') continue;
    const line = actionLine(opts.dryRun, field.field, decision.value, title, decision.reason);
    actions.set(field.field, line);
    result.actions.push(line);
  }
  result.fieldsSet += actions.size;
  insertAttemptsSafe(deps, opts, result, attemptRows(
    opts,
    candidate,
    fields,
    model,
    evidenceHash,
    callRef,
    attemptedAt,
    decisions,
    'set',
    null,
    actions,
  ));
  if (!opts.dryRun && opts.journalActions !== false) {
    for (const line of actions.values()) recordAction(deps, opts, result, candidate, title, line);
  }
  notify(opts, result, noteOutcome(candidate, title, fields, decisions, mutationResult.operationId, fullNode.fields));
}

/**
 * @internal Runs the real sweep worker against a caller-owned mutable result.
 * Production callers should use runFieldGuessSweep so queue containment is retained.
 */
export async function runFieldGuessSweepWorker(
  deps: FieldGuessSweepDeps,
  opts: FieldGuessSweepOptions,
  result: FieldGuessSweepResult,
): Promise<FieldGuessSweepResult> {
  if (deps.config.fieldGuessCap === 0) return skip(result, 'disabled');
  if (deps.config.fieldGuessModel === null) {
    return skip(
      result,
      'model_unresolved',
      deps.config.fieldGuessModelError ?? 'Field guess model did not resolve.',
    );
  }
  if (deps.db === undefined) return skip(result, 'database_unavailable', 'Curator database is unavailable.');

  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const paidNodeIds = new Set<string>();
  for (;;) {
    const listed = await deps.engine.listFieldGuessCandidates({
      limit: CANDIDATE_PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const pending = listed.warnings.find(issue => issue.code === 'FIELD_PRESENCE_BACKFILL_PENDING');
    if (pending !== undefined) {
      return skip(result, 'presence_backfill_pending', 'Field presence backfill is pending.');
    }
    for (const _issue of listed.warnings) warn(result, 'Field guess candidate discovery warning.');

    for (const candidate of listed.page.candidates) {
      result.scannedNodes += 1;
      if (candidate.fields.length === 0) continue;
      if (paidNodeIds.has(candidate.node_id)) continue;

      // Cap admission still precedes body access. Exact suppression requires a
      // fresh bounded projection, so unread candidates after the cap are deferred.
      if (result.stopped !== undefined || result.modelCalls >= deps.config.fieldGuessCap) {
        result.deferredNodes += 1;
        continue;
      }
      if (candidate.content_hash === null) {
        result.missingHashSkips += 1;
        continue;
      }

      const callsBeforeNode = result.modelCalls;
      try {
        await guessFieldsForCandidate(deps, opts, candidate, result);
      } catch {
        result.errors += 1;
        warn(result, 'field guess node failed');
      } finally {
        if (result.modelCalls > callsBeforeNode) paidNodeIds.add(candidate.node_id);
      }
    }

    if (listed.page.next_cursor === null) break;
    if (seenCursors.has(listed.page.next_cursor)) {
      result.errors += 1;
      warn(result, 'Field guess candidate cursor cycle detected (repeated cursor); stopping paging.');
      break;
    }
    seenCursors.add(listed.page.next_cursor);
    cursor = listed.page.next_cursor;
  }
  return result;
}

/** Queue-serialized, non-throwing field-inference phase. */
export async function runFieldGuessSweep(
  deps: FieldGuessSweepDeps,
  opts: FieldGuessSweepOptions,
): Promise<FieldGuessSweepResult> {
  const result = emptyFieldGuessResult(opts.dryRun);
  try {
    return await deps.queue.enqueue('field-guess-sweep', async () => {
      try {
        return await runFieldGuessSweepWorker(deps, opts, result);
      } catch {
        result.errors += 1;
        warn(result, 'field guess sweep failed');
        return result;
      }
    });
  } catch {
    result.errors += 1;
    warn(result, 'field guess queue failed');
    return result;
  } finally {
    recordSweepSummary(deps, opts, result);
  }
}
