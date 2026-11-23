import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { RunTrigger } from '../db/runs.js';
import type { Engine } from '../engine.js';
import type { ActionRecorder } from '../journal/recorder.js';
import type { LlmClient } from '../llm/types.js';
import type { CurationQueue } from '../queue.js';
import type { UsagePurpose } from '@vault/contract';
import type { UsageReporter } from '../usage-reporter.js';

export const FIELD_GUESS_REASON_MAX_CHARS = 500;
export const FIELD_GUESS_ERROR_MAX_CHARS = 1_000;
export const FIELD_GUESS_VALUE_JSON_MAX_CHARS = 10_000;
export const FIELD_GUESS_ACTION_MAX_CHARS = 500;
export const FIELD_GUESS_CLASSIFIER_VERSION = 1;
export const FIELD_GUESS_EVIDENCE_VERSION = 1;

export type FieldGuessFieldType =
  | 'string'
  | 'number'
  | 'date'
  | 'boolean'
  | 'reference'
  | 'enum'
  | 'list';

export type FieldGuessEligibility = 'absent' | 'required_empty' | 'invalid';

export interface FieldGuessValidationIssue {
  field: string;
  severity: 'error';
  code: string;
  message: string;
  details?: unknown;
}

export interface FieldGuessFieldCandidate {
  field: string;
  description: string | null;
  field_type: FieldGuessFieldType;
  list_item_type: FieldGuessFieldType | null;
  required: boolean;
  enum_values: string[] | null;
  per_type_enum_values?: Array<{ type: string; values: string[] | null }>;
  reference_target: string | null;
  claiming_types: string[];
  eligibility: FieldGuessEligibility;
  validation_issue?: FieldGuessValidationIssue;
  definition_hash: string;
  /** On an on-demand run's listing, for a field offered as `invalid`: the value now there, as short text. */
  held_text?: string;
}

export interface FieldGuessNodeCandidate {
  node_id: string;
  title: string;
  file_path: string;
  types: string[];
  version: number;
  content_hash: string | null;
  file_mtime: number | null;
  fields: FieldGuessFieldCandidate[];
}

export interface FieldGuessCandidatePage {
  /** The Engine's mark on an on-demand run's listing (#644); absent on the nightly one. */
  mode?: 'requested';
  candidates: FieldGuessNodeCandidate[];
  next_cursor: string | null;
}

export interface FieldGuessDecision {
  field: string;
  action: 'set' | 'abstain';
  value?: string;
  reason: string;
}

export type SanitizedFieldGuessKind =
  | 'accepted'
  | 'abstained'
  | 'rejected_value'
  | 'rejected_reference'
  | 'reference_error';

export interface SanitizedFieldGuessDecision {
  field: string;
  kind: SanitizedFieldGuessKind;
  reason: string;
  value?: unknown;
  error?: string;
  /** Canonical identities rechecked atomically by Engine for accepted refs. */
  reference_targets?: FieldGuessReferenceGuard[];
}

export interface FieldGuessReferenceGuard {
  node_id: string;
  title: string;
  required_type: string | null;
}

export interface FieldGuessFieldGuard {
  field: string;
  definition_hash: string;
  reference_targets?: FieldGuessReferenceGuard[];
}

export interface FieldGuessMutationGuard {
  offered_fields: FieldGuessFieldGuard[];
  /** The fields were named by an on-demand run (#644): Engine rechecks them by the requested rule. */
  requested?: boolean;
  /** With `requested`: the run asked to replace values that fail their field's type. */
  replace_invalid?: boolean;
}

/** What one model call decided for one note, for a caller that reports per note (#644). */
export interface FieldGuessNoteOutcome {
  node_id: string;
  title: string;
  file_path: string;
  /** Fields given a value: written, or in a dry run checked by Engine and not written. */
  set: Record<string, unknown>;
  /** Of those, the ones that held a value failing the field's type, with the value they held. */
  replaced: Record<string, unknown>;
  /** Offered fields left as they were, each with why. */
  left: Array<{ field: string; kind: Exclude<SanitizedFieldGuessKind, 'accepted'>; reason: string }>;
  /** The write's undo operation. Null in a dry run, and when nothing was written. */
  operation_id: string | null;
}

export interface SanitizedFieldGuessOutput {
  byField: Map<string, SanitizedFieldGuessDecision>;
  patch: Record<string, unknown>;
}

export type FieldGuessOutcome =
  | 'set'
  | 'abstained'
  | 'rejected_value'
  | 'rejected_reference'
  | 'reference_error'
  | 'provider_error'
  | 'stale_node'
  | 'mutation_error';

export interface FieldGuessAttemptInput {
  run_ref: string;
  call_ref: string;
  node_id: string;
  field_name: string;
  content_hash: string;
  definition_hash: string;
  /** Resolved raw provider model ID, not the model-ref display name. */
  model: string;
  classifier_version: number;
  /** Null/absent only for legacy history without a known prompt projection. */
  evidence_hash?: string | null;
  evidence_version?: number | null;
  outcome: FieldGuessOutcome;
  proposed_value?: unknown;
  reason?: string | null;
  error?: string | null;
  /** Bounded forensic action line; it is not part of terminal identity. */
  action?: string | null;
  attempted_at: string;
}

export interface FieldGuessTerminalLookup {
  nodeId: string;
  contentHash: string;
  /** Resolved raw provider model ID, not the model-ref display name. */
  model: string;
  classifierVersion: number;
  evidenceHash: string;
  evidenceVersion: number;
  fields: ReadonlyArray<{
    field: string;
    definitionHash: string;
  }>;
}

export interface FieldGuessSweepDeps {
  engine: Engine;
  llm: LlmClient;
  config: Config;
  queue: CurationQueue;
  db?: Database.Database;
  usage?: UsageReporter;
  recorder?: ActionRecorder;
}

export interface FieldGuessSweepOptions {
  dryRun: boolean;
  runRef: string;
  trigger: RunTrigger;
  /** An on-demand run's candidates (#644): the write guard is marked requested to match their listing. */
  requested?: boolean;
  /** With `requested`: the run replaces values that fail their field's type, as its listing offered them. */
  replaceInvalid?: boolean;
  /** Spend-ledger purpose of the model calls; the nightly sweep's `field-guess` by default. */
  purpose?: UsagePurpose;
  /** False leaves out the journal line per field set: a run of thousands of notes writes one summary. */
  journalActions?: boolean;
  /** Called after each model call that returned decisions, written or not. */
  onNote?: (outcome: FieldGuessNoteOutcome) => void;
}

export type FieldGuessSweepSkipReason =
  | 'disabled'
  | 'model_unresolved'
  | 'database_unavailable'
  | 'presence_backfill_pending';

export interface FieldGuessSweepResult {
  ran: boolean;
  dryRun: boolean;
  skipReason: FieldGuessSweepSkipReason | null;
  scannedNodes: number;
  modelCalls: number;
  fieldsSet: number;
  abstentions: number;
  ledgerSkips: number;
  missingHashSkips: number;
  staleNodes: number;
  deferredNodes: number;
  /** Retryable exact-title/canonical-reference operational failures. */
  referenceErrors: number;
  providerErrors: number;
  mutationErrors: number;
  errors: number;
  /** Why the sweep stopped early: the daily budget or a provider key's limit refused a call. */
  stopped?: string;
  /** The refusal itself, without the sweep's own wording around it. */
  stoppedDetail?: string;
  warnings: string[];
  actions: string[];
}
