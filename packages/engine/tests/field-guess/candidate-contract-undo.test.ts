import {
  FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS,
  serializeFieldGuessCandidateMandatory,
} from '@vault/contract';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateGlobalField, createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, patchSchemaDefinition } from '../../src/schema/crud.js';
import { readCurrentClaims } from '../../src/schema/claims.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createOperation, finalizeOperation } from '../../src/undo/operation.js';
import { restoreMany } from '../../src/undo/restore.js';
import { captureSchemaSnapshot } from '../../src/undo/schema-snapshot.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';

const MANDATORY_BUDGET_ERROR = /AI field-guess mandatory offered projection.*20,000/i;

function oversizedEnumValue(): string {
  const emptyRecordChars = serializeFieldGuessCandidateMandatory({
    field: 'status',
    field_type: 'enum',
    list_item_type: null,
    enum_values: [''],
    reference_target: null,
  }).length;
  return 'x'.repeat(
    FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS + 1 - emptyRecordChars,
  );
}

describe('field-guess mandatory projection undo invariant', () => {
  let db: Database.Database;
  let vaultPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    db = createTestDb();
    ({ vaultPath, cleanup } = createTempVault());
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it('rolls back an undo which would restore an oversized AI-guessable enum projection', () => {
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['active'],
      required: true,
      ai_guessable: false,
      overrides_allowed: { ai_guessable: true },
    });
    createSchemaDefinition(db, {
      name: 'Project',
      field_claims: [{ field: 'status', ai_guessable: true }],
    });

    const operationId = createOperation(db, {
      source_tool: 'patch-schema',
      description: 'Disable AI guessing temporarily',
    });
    captureSchemaSnapshot(db, operationId, 'Project');
    patchSchemaDefinition(db, 'Project', {
      update_field_claims: [{ field: 'status', ai_guessable: false }],
    });
    finalizeOperation(db, operationId);

    updateGlobalField(db, 'status', { enum_values: [oversizedEnumValue()] });
    expect(() => restoreMany(db, new WriteLockManager(), vaultPath, {
      operation_ids: [operationId],
      dry_run: false,
    })).toThrow(MANDATORY_BUDGET_ERROR);

    expect(readCurrentClaims(db, 'Project')).toMatchObject([{
      field: 'status',
      ai_guessable: false,
    }]);
    expect(db.prepare(
      'SELECT status FROM undo_operations WHERE operation_id = ?',
    ).get(operationId)).toEqual({ status: 'active' });
  });
});
