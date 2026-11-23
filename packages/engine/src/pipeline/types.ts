// src/pipeline/types.ts
//
// Types for the write pipeline (Section 5 of Phase 3 spec).

import type { ValidationResult, ValidationIssue } from '../validation/types.js';
import type { ConversationAuthorityGuard } from '../conversations/authority.js';
import type { ReferenceDiagnostic } from './diagnostics.js';
import type { ReferenceCatalog, ReferenceRequest, Resolution } from '../resolver/relationship-policy.js';
import type { LinkCanonicalizer } from '../resolver/file-link.js';
import type { ResolutionLookup } from '../resolver/resolve.js';
import type { FileField } from './kept-file-fields.js';

export type { FileContext } from '../validation/resolve-default.js';

export interface ProposedMutation {
  source: 'tool' | 'watcher' | 'normalizer' | 'propagation' | 'undo';
  node_id: string | null;           // null for create-node
  file_path: string;                 // vault-relative path
  title: string;
  types: string[];
  fields: Record<string, unknown>;   // proposed field values
  /** Existing-node fields explicitly changed by this request. Untouched
   * explicit-null markers overlay `fields` before validation. */
  touchedFields?: readonly string[];
  explicitNullFields?: readonly string[];    // watcher path: keys explicitly present with YAML null
  /** Keys this write states as an explicit YAML null (a bare `key:`), so the null is
   * rendered and marked rather than dropped. Settings notes use it, on the tool path and
   * when regenerating a deleted note, for a setting whose value is null while its default
   * is not, so the file keeps that value. */
  authoredNullFields?: readonly string[];
  body: string;
  raw_field_texts?: Record<string, string>;  // watcher path: pre-stripped text for wiki-link fields
  source_content_hash?: string;              // watcher path: SHA256 of file at parse time — stored as DB content_hash when file write is skipped
  db_only?: boolean;                         // when true, skip file write (watcher path)
  /** Internal composed-preview state: disk hash produced by an earlier simulated
   * write to this node. Used only for DB-only no-op comparison; ignored live. */
  previewDiskContentHash?: string;
  /** Internal composed-preview state: frontmatter key order of that earlier
   * simulated write, which a DB-only render keeps in place of the file's (a
   * preview rename does not move the file). An undo that moves a note back
   * passes the order of the note's file at the path it moves it from (#509).
   * Ignored by writes that are not DB-only. */
  previewKeyOrder?: readonly string[];
  /** Internal composed-preview state: the content of that earlier simulated write, which a
   * DB-only render reads the fields it keeps as typed from (#501) in place of the file's.
   * An undo that moves a note back passes the note's file at the path it moves it from
   * (#509). Ignored by writes that are not DB-only. */
  previewContent?: string;
  expectedVersion?: number;                  // optional optimistic concurrency check for tool callers
  expectedContentHash?: string;              // optional content-hash CAS: write only if nodes.content_hash still equals this
  /** Optional on-disk CAS. `null` means the file must still be absent. Checked
   * under the write lock immediately before an ordinary file write. */
  expectedDiskContentHash?: string | null;
  /** Optional capture authority CAS, checked inside the node-write transaction. */
  conversationAuthority?: ConversationAuthorityGuard;
  /** Field-guess-only preconditions. Revalidated inside the mutation
   * transaction so schema and reference races fail stale before any write. */
  fieldGuessGuard?: FieldGuessMutationGuard;
  /** Rewrite links only the engine can resolve so they name the file
   * (pipeline/canonical-links.ts). Defaults to on for source 'tool' only;
   * a surgical tool write that must not touch other values passes false. */
  canonicalizeLinks?: boolean;
  /** Internal: the catalog to canonicalize against, shared across a sweep so
   * titles reset by earlier re-saves still identify their notes. */
  linkCanonicalizer?: LinkCanonicalizer;
  /** Internal: the v2 catalog this write resolves its references against, in
   * place of one built from every node for this write alone. Called after the
   * node's own row is written. A caller passes one only for a run of writes
   * that leave every note's path, title and types as they are (a rename's
   * reference rewrites, #575; an undo's restores, #589), so the catalog stays
   * current across the run (pipeline/shared-catalogs.ts). */
  referenceCatalog?: () => ReferenceCatalog;
  /** Internal: the same for v1, a lookup that answers as `resolveTarget` does,
   * in place of its queries, which read every node for a target that names no
   * path or title (#589). */
  targetLookup?: () => ResolutionLookup;
  /** The caller runs `repairInboundLinks` itself once its outer transaction
   * has committed, instead of the pipeline repairing inline after a create or
   * rename (whose writes the caller's rollback could not undo correctly). */
  deferLinkRepair?: boolean;
  /** Internal: keep the stored title instead of the filename's. A link-repair
   * re-save must not reset a drifted title other links may still need. */
  keepStoredTitle?: boolean;
  /** Internal, undo only: the fields whose lines only the note's file held before the
   * operation, from its snapshot (#656). Each is written back as typed where the restored
   * state does not hold it, as a kept field is (#501). */
  restoredFileFields?: readonly FileField[];
}

export interface FieldGuessReferenceGuard {
  node_id: string;
  title: string;
  required_type: string | null;
}

export interface FieldGuessFieldGuard {
  field: string;
  definition_hash: string;
  reference_targets?: readonly FieldGuessReferenceGuard[];
}

export interface FieldGuessMutationGuard {
  offered_fields: readonly FieldGuessFieldGuard[];
  /** The fields were named by an on-demand run (#644): rechecked by the requested rule, not the nightly one. */
  requested?: boolean;
  /** With `requested`: the run asked to replace values that fail validation. Without it, such a field is refused. */
  replace_invalid?: boolean;
}

/**
 * Caller-generated context signalling undo-snapshot capture.
 * Absent undoContext on an executeMutation/executeDeletion call
 * means no snapshot is written. Re-used across every pipeline call
 * a single user-intent tool issues.
 */
export interface UndoContext {
  operation_id: string;
}

/** A composing transaction owns publication after its outer commit. */
export interface MutationEffects {
  afterCommit: { push(effect: () => void): void };
  /** Transaction-local v1 projection resolver. V2 uses the current typed catalog. */
  resolveReference?: (request: ReferenceRequest) => Resolution;
}

export interface PipelineResult {
  node_id: string;
  file_path: string;
  validation: ValidationResult;
  rendered_hash: string;
  /** Frontmatter key order of the render, on DB-only tool writes only, for a
   * composed preview to pass on as the next simulated write's `previewKeyOrder`. */
  rendered_key_order?: string[];
  /** The render itself, on DB-only tool writes only, for a composed preview to pass on as
   * the next simulated write's `previewContent`. */
  rendered_content?: string;
  edits_logged: number;               // count of edits log entries created
  file_written: boolean;              // false if hash matched (no-op)
  referenceDiagnostics: readonly ReferenceDiagnostic[];
  /** Other nodes re-saved because they linked to this one by a name its
   * filename cannot reproduce (create/rename with canonicalization only).
   * Embedding refresh targets, like this node itself. */
  links_repaired?: string[];
}

export class PipelineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly validation?: ValidationResult,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}
