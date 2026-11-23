import type Database from 'better-sqlite3';
import {
  FIELD_GUESS_ACTION_MAX_CHARS,
  FIELD_GUESS_ERROR_MAX_CHARS,
  FIELD_GUESS_REASON_MAX_CHARS,
  FIELD_GUESS_VALUE_JSON_MAX_CHARS,
  type FieldGuessAttemptInput,
  type FieldGuessOutcome,
  type FieldGuessTerminalLookup,
} from '../field-guess/types.js';

const FIELD_GUESS_OUTCOMES: ReadonlySet<FieldGuessOutcome> = new Set([
  'set',
  'abstained',
  'rejected_value',
  'rejected_reference',
  'reference_error',
  'provider_error',
  'stale_node',
  'mutation_error',
]);

type NormalizedAttempt = Omit<FieldGuessAttemptInput, 'proposed_value' | 'reason' | 'error' | 'action'> & {
  proposed_value_json: string | null;
  reason: string | null;
  error: string | null;
  action: string | null;
};

/** DDL for append-only field-guess history. Called by migration #11. */
export function createFieldGuessTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE field_guess_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_ref TEXT NOT NULL,
      call_ref TEXT NOT NULL,
      node_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      definition_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      classifier_version INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      proposed_value_json TEXT,
      reason TEXT,
      error TEXT,
      action TEXT,
      attempted_at TEXT NOT NULL
    );
    CREATE INDEX idx_field_guess_terminal_lookup ON field_guess_attempts (
      node_id, field_name, content_hash, definition_hash, model, classifier_version, outcome
    );
  `);
}

/** Inserts a whole paid-call batch atomically. Existing history is never updated. */
export function insertFieldGuessAttempts(
  db: Database.Database,
  rows: readonly FieldGuessAttemptInput[],
): void {
  const normalized = rows.map(normalizeAttempt);
  if (normalized.length === 0) return;

  const insert = db.prepare(`
    INSERT INTO field_guess_attempts (
      run_ref, call_ref, node_id, field_name, content_hash, definition_hash,
      model, classifier_version, outcome, proposed_value_json, reason, error,
      action, attempted_at, evidence_hash, evidence_version
    ) VALUES (
      @run_ref, @call_ref, @node_id, @field_name, @content_hash, @definition_hash,
      @model, @classifier_version, @outcome, @proposed_value_json, @reason, @error,
      @action, @attempted_at, @evidence_hash, @evidence_version
    )
  `);
  db.transaction((attempts: readonly NormalizedAttempt[]) => {
    for (const attempt of attempts) insert.run(attempt);
  })(normalized);
}

/**
 * Finds fields with a terminal attempt for the complete decision fingerprint.
 * Duplicate requested pairs are queried once; duplicate field names collapse in
 * the returned Set. Operational failures and successful sets remain retryable.
 */
export function terminalFieldGuessFields(
  db: Database.Database,
  input: FieldGuessTerminalLookup,
): Set<string> {
  const nodeId = requiredString(input.nodeId, 'nodeId');
  const contentHash = requiredString(input.contentHash, 'contentHash');
  const model = requiredString(input.model, 'model');
  const classifierVersion = classifierVersionValue(input.classifierVersion, 'classifierVersion');
  const evidenceHash = requiredString(input.evidenceHash, 'evidenceHash');
  const evidenceVersion = classifierVersionValue(input.evidenceVersion, 'evidenceVersion');
  if (!Array.isArray(input.fields)) throw new TypeError('fields must be an array');
  if (input.fields.length === 0) return new Set();

  const uniqueFields: Array<{ field: string; definitionHash: string }> = [];
  const definitionsByField = new Map<string, Set<string>>();
  for (const candidate of input.fields) {
    if (candidate === null || typeof candidate !== 'object') {
      throw new TypeError('fields entries must be objects');
    }
    const field = requiredString(candidate.field, 'fields[].field');
    const definitionHash = requiredString(candidate.definitionHash, 'fields[].definitionHash');
    const definitions = definitionsByField.get(field) ?? new Set<string>();
    if (definitions.has(definitionHash)) continue;
    definitions.add(definitionHash);
    definitionsByField.set(field, definitions);
    uniqueFields.push({ field, definitionHash });
  }

  const lookup = db.prepare(`
    SELECT 1 FROM field_guess_attempts
    WHERE node_id = ? AND field_name = ? AND content_hash = ? AND definition_hash = ?
      AND model = ? AND classifier_version = ? AND evidence_hash = ? AND evidence_version = ?
      AND outcome IN ('abstained', 'rejected_value', 'rejected_reference')
    LIMIT 1
  `);
  const terminal = new Set<string>();
  for (const { field, definitionHash } of uniqueFields) {
    if (lookup.get(
      nodeId,
      field,
      contentHash,
      definitionHash,
      model,
      classifierVersion,
      evidenceHash,
      evidenceVersion,
    ) !== undefined) {
      terminal.add(field);
    }
  }
  return terminal;
}

function normalizeAttempt(input: FieldGuessAttemptInput): NormalizedAttempt {
  if (input === null || typeof input !== 'object') throw new TypeError('attempt must be an object');
  const outcome = input.outcome;
  if (!FIELD_GUESS_OUTCOMES.has(outcome)) {
    throw new TypeError(`outcome must be one of ${[...FIELD_GUESS_OUTCOMES].join(', ')}`);
  }
  const evidenceHash = input.evidence_hash == null ? null : requiredString(input.evidence_hash, 'evidence_hash');
  const evidenceVersion = input.evidence_version == null ? null : classifierVersionValue(input.evidence_version, 'evidence_version');
  if ((evidenceHash === null) !== (evidenceVersion === null)) {
    throw new TypeError('evidence_hash and evidence_version must be provided together');
  }

  const serialized = input.proposed_value === null || input.proposed_value === undefined
    ? null
    : JSON.stringify(input.proposed_value) ?? null;
  return {
    run_ref: requiredString(input.run_ref, 'run_ref'),
    call_ref: requiredString(input.call_ref, 'call_ref'),
    node_id: requiredString(input.node_id, 'node_id'),
    field_name: requiredString(input.field_name, 'field_name'),
    content_hash: requiredString(input.content_hash, 'content_hash'),
    definition_hash: requiredString(input.definition_hash, 'definition_hash'),
    model: requiredString(input.model, 'model'),
    classifier_version: classifierVersionValue(input.classifier_version, 'classifier_version'),
    evidence_hash: evidenceHash,
    evidence_version: evidenceVersion,
    outcome,
    proposed_value_json: serialized === null
      ? null
      : truncateCodePoints(serialized, FIELD_GUESS_VALUE_JSON_MAX_CHARS),
    reason: boundedOptionalString(input.reason, 'reason', FIELD_GUESS_REASON_MAX_CHARS),
    error: boundedOptionalString(input.error, 'error', FIELD_GUESS_ERROR_MAX_CHARS),
    action: boundedOptionalString(input.action, 'action', FIELD_GUESS_ACTION_MAX_CHARS),
    attempted_at: canonicalIsoTimestamp(input.attempted_at, 'attempted_at'),
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function boundedOptionalString(value: unknown, name: string, maxChars: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string or null`);
  return truncateCodePoints(value, maxChars);
}

function canonicalIsoTimestamp(value: unknown, name: string): string {
  const timestamp = requiredString(value, name);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new TypeError(`${name} must exactly match Date#toISOString output`);
  }
  return timestamp;
}

function classifierVersionValue(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function truncateCodePoints(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let chars = 0;
  let end = 0;
  for (const codePoint of value) {
    if (chars === maxChars) break;
    chars += 1;
    end += codePoint.length;
  }
  return value.slice(0, end);
}
