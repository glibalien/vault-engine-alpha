// src/schema/preview.ts
//
// SAVEPOINT-based preview of an update-schema call. Runs the real mutation
// pipeline inside a savepoint and unconditionally rolls back. Used by
// update-schema's dry_run path, by the confirm_large_change gate to compute
// orphan counts pre-commit, and as the single source of the preview response
// shape.

import { namespace, RollupError } from '../rollups/definitions.js';
import { relationshipViewsDiff } from '../rollups/mutation.js';
import { SummaryError } from '../summaries/errors.js';
import type Database from 'better-sqlite3';
import {
  getSchemaDefinition,
  patchSchemaDefinition,
  updateSchemaDefinition,
  type ClaimInput,
  type PatchSchemaInput,
  type UpdateSchemaInput,
} from './crud.js';
import { diffClaims, propagateSchemaChange } from './propagate.js';
import { readCurrentClaims } from './claims.js';
import { SchemaValidationError, type ValidationGroup } from './errors.js';
import type { WriteLockManager } from '../sync/write-lock.js';

export interface SchemaPreviewBaseFields {
  relationship_views?: ReturnType<typeof relationshipViewsDiff>;
  claims_added: string[];
  claims_removed: string[];
  claims_modified: string[];
  orphaned_field_names: Array<{ field: string; count: number }>;
  propagation: {
    nodes_affected: number;
    nodes_rerendered: number;
    defaults_populated: number;
    fields_orphaned: number;
  };
}

export type SchemaPreviewResult =
  | ({ ok: true } & SchemaPreviewBaseFields)
  | ({ ok: false; groups: ValidationGroup[] } & SchemaPreviewBaseFields);

interface PreviewMutationPlan {
  hasClaimMutation: boolean;
  proposedViews?: unknown;
  replacementClaims?: ClaimInput[];
  patch?: PatchSchemaInput;
  apply: () => void;
}

export function previewSchemaChange(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  schemaName: string,
  proposedUpdate: UpdateSchemaInput,
): SchemaPreviewResult {
  return previewSchemaMutation(db, writeLock, vaultPath, schemaName, {
    hasClaimMutation: proposedUpdate.field_claims !== undefined,
    proposedViews: proposedUpdate.relationship_views,
    replacementClaims: proposedUpdate.field_claims,
    apply: () => { updateSchemaDefinition(db, schemaName, proposedUpdate); },
  });
}

export function previewSchemaPatch(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  schemaName: string,
  patch: PatchSchemaInput,
): SchemaPreviewResult {
  const hasClaimMutation =
    patch.add_field_claims !== undefined ||
    patch.update_field_claims !== undefined ||
    patch.remove_field_claims !== undefined;
  return previewSchemaMutation(db, writeLock, vaultPath, schemaName, {
    hasClaimMutation,
    proposedViews: patch.relationship_views,
    patch,
    apply: () => { patchSchemaDefinition(db, schemaName, patch); },
  });
}

function previewSchemaMutation(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  schemaName: string,
  plan: PreviewMutationPlan,
): SchemaPreviewResult {
  const existing = getSchemaDefinition(db, schemaName);
  if (!existing) {
    throw new Error(`Schema '${schemaName}' not found`);
  }

  // Read current claims (pre-savepoint) for diff computation.
  const oldClaims = readCurrentClaims(db, schemaName);

  const base: SchemaPreviewBaseFields = {
    claims_added: [],
    claims_removed: [],
    claims_modified: [],
    orphaned_field_names: [],
    propagation: { nodes_affected: 0, nodes_rerendered: 0, defaults_populated: 0, fields_orphaned: 0 },
  };

  if (plan.proposedViews !== undefined) {
    base.relationship_views = relationshipViewsDiff(namespace(existing.metadata), plan.proposedViews);
  }

  if (plan.replacementClaims !== undefined) {
    const newClaimsShape = plan.replacementClaims.map(c => ({
      field: c.field,
      sort_order: c.sort_order,
      label: c.label,
      description: c.description,
      required: c.required ?? null,
      default_value: (c.default_value_overridden === true || c.default_value !== undefined)
        ? (c.default_value ?? null)
        : undefined,
      enum_values_override: c.enum_values_override ?? null,
      enum_groups_override: c.enum_groups_override ?? null,
      ai_guessable: c.ai_guessable ?? null,
    }));
    const diff = diffClaims(oldClaims, newClaimsShape);
    base.claims_added = diff.added;
    base.claims_removed = diff.removed;
    base.claims_modified = diff.changed;
  } else if (plan.patch) {
    base.claims_added = plan.patch.add_field_claims?.map(claim => claim.field) ?? [];
    base.claims_removed = plan.patch.remove_field_claims ?? [];
    base.claims_modified = plan.patch.update_field_claims?.map(claim => claim.field) ?? [];
  }

  // Seed the diff from caller intent so validation failures can still report
  // which claims were attempted. Successful mutations replace it with the
  // actual post-write diff before propagation and response construction.
  db.prepare('SAVEPOINT preview_schema_change').run();
  let result: SchemaPreviewResult;
  try {
    try {
      plan.apply();
    } catch (err) {
      if (err instanceof SchemaValidationError) {
        result = { ok: false, groups: err.groups, ...base };
        return result;
      }
      if (base.relationship_views && (err instanceof RollupError || err instanceof SummaryError)
        && (err.code === 'INVALID_PARAMS' || err.code === 'VALIDATION_FAILED')) {
        throw new RollupError(err.code, err.message, { ...err.details, ...base });
      }
      throw err;
    }

    if (plan.proposedViews !== undefined) base.relationship_views = relationshipViewsDiff(namespace(existing.metadata), namespace(getSchemaDefinition(db, schemaName)!.metadata));
    let propagationGroups: ValidationGroup[] = [];
    if (plan.hasClaimMutation) {
      const newClaims = readCurrentClaims(db, schemaName);
      const diff = diffClaims(oldClaims, newClaims);
      base.claims_added = diff.added;
      base.claims_removed = diff.removed;
      base.claims_modified = diff.changed;
      const prop = propagateSchemaChange(db, writeLock, vaultPath, schemaName, diff, undefined, { preview: true });
      base.propagation = {
        nodes_affected: prop.nodes_affected,
        nodes_rerendered: prop.nodes_rerendered,
        defaults_populated: prop.defaults_populated,
        fields_orphaned: prop.fields_orphaned,
      };
      base.orphaned_field_names = prop.orphaned_field_names ?? [];
      propagationGroups = prop.validation_groups ?? [];
    }

    if (propagationGroups.length > 0) {
      result = { ok: false, groups: propagationGroups, ...base };
    } else {
      result = { ok: true, ...base };
    }
    return result;
  } finally {
    db.prepare('ROLLBACK TO SAVEPOINT preview_schema_change').run();
    db.prepare('RELEASE SAVEPOINT preview_schema_change').run();
  }
}
