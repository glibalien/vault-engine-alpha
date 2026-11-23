// @vault/contract — the shared MCP response-envelope WIRE shape.
// Loose by design: `Issue.code` is a plain string so clients treat codes as
// opaque (new engine IssueCode literals are additive, never breaking). The
// engine keeps a stricter internal `IssueCode` union and proves it stays
// assignable to these types via a conformance test (see engine
// contract-conformance.test-d.ts).

export interface Issue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  field?: string;
  details?: unknown;
}

/** Closed set of top-level tool failure codes the engine emits. */
export type ErrorCode =
  | 'CLASSIFICATION_INVALID_CONFIG'
  | 'CLASSIFICATION_STALE_DEFINITION'
  | 'CLASSIFICATION_LIMIT_EXCEEDED'
  | 'CLASSIFICATION_IN_USE'
  | 'NOT_FOUND'
  | 'ALREADY_MATERIALIZED'
  | 'INVALID_PARAMS'
  | 'AMBIGUOUS_MATCH'
  | 'INTERNAL_ERROR'
  | 'VALIDATION_FAILED'
  | 'UNKNOWN_TYPE'
  | 'EXTRACTOR_UNAVAILABLE'
  | 'AMBIGUOUS_FILENAME'
  | 'CONFLICT'
  | 'BATCH_FAILED'
  | 'OPERATION_NOT_FOUND'
  | 'CONFIRMATION_REQUIRED'
  | 'STALE_NODE'
  | 'CONTENT_HASH_MISMATCH'
  | 'NOT_ELIGIBLE'
  | 'UPSTREAM_ERROR'
  | 'DUPLICATE_MEMORY';

export type Envelope<T> =
  | { ok: true; data: T; warnings: Issue[] }
  | { ok: false; error: { code: ErrorCode; message: string; details?: Record<string, unknown> }; warnings: Issue[] };

export { verdict, dryRunVerdict, EMPTY_COLLECTION_KEYS, type Verdict, type DryRunVerdict } from './verdict.js';
export { USAGE_PURPOSES, type UsagePurpose } from './usage.js';
export {
  FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS,
  FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS,
  fieldGuessCandidateIdentityProjectionChars,
  fieldGuessCandidateMandatoryProjectionChars,
  serializeFieldGuessCandidateIdentity,
  serializeFieldGuessCandidateMandatory,
  type FieldGuessCandidateIdentity,
  type FieldGuessCandidateMandatory,
} from './field-guess.js';
export { isValidWikiPageTitle, WIKI_TITLE_FORBIDDEN_CHARACTERS, wikiPageTitlePrefix, wikiTitleKey } from './wiki-title.js';
export { withoutWikiLinks } from './wiki-links.js';
