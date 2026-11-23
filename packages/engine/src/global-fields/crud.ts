// src/global-fields/crud.ts

import { parseEnumGroups } from '../classification/definitions.js';
import { resolveEnumGroups } from '../classification/resolver.js';
import { ClassificationError, type EnumGroupsV1 } from '../classification/types.js';
import type Database from 'better-sqlite3';
import { readReferencePolicyVersion } from '../db/reference-policy-version.js';
import { refreshTypedReferences } from '../resolver/typed-refresh.js';
import type { GlobalFieldDefinition, FieldType } from '../validation/types.js';
import { coerceValue } from '../validation/coerce.js';
import { validateUiHints, normalizeUiHints, type UiHints } from './ui-hints.js';
import { renameExplicitNullField } from '../fields/explicit-null.js';
import { supportsAiGuessing } from '../field-guess/field-name.js';
import { assertFieldGuessCandidateIdentityBudget } from '../field-guess/candidate-contract.js';
import { typeKey } from '../parser/type-key.js';

// ── Shared types ─────────────────────────────────────────────────────

export interface CreateGlobalFieldInput {
  name: string;
  field_type: FieldType;
  enum_values?: string[];
  enum_groups?: EnumGroupsV1 | null;
  reference_target?: string;
  description?: string;
  default_value?: unknown;
  required?: boolean;
  ai_guessable?: boolean;
  list_item_type?: FieldType;
  overrides_allowed?: { required?: boolean; default_value?: boolean; enum_values?: boolean; enum_groups?: boolean; ai_guessable?: boolean };
  ui?: UiHints | null;
}

export interface UpdateGlobalFieldInput {
  field_type?: FieldType;
  enum_values?: string[];
  enum_groups?: EnumGroupsV1 | null;
  reference_target?: string;
  description?: string;
  default_value?: unknown;
  required?: boolean;
  ai_guessable?: boolean;
  list_item_type?: FieldType;
  overrides_allowed?: { required?: boolean; default_value?: boolean; enum_values?: boolean; enum_groups?: boolean; ai_guessable?: boolean };
  ui?: UiHints | null;
  confirm?: boolean;
  discard_uncoercible?: boolean;
}

export interface TypeChangeResult {
  preview: boolean;
  applied?: boolean;
  field?: GlobalFieldDefinition;
  affected_nodes?: number;
  coercible?: Array<{ node_id: string; old_value: unknown; new_value: unknown }>;
  uncoercible?: Array<{ node_id: string; value: unknown; reason: string }>;
  would_orphan?: number;
}

export class TypeChangeRequiresDiscardError extends Error {
  readonly details: {
    affected_nodes: number;
    coercible_count: number;
    uncoercible: Array<{ node_id: string; value: unknown; reason: string }>;
  };

  constructor(details: TypeChangeRequiresDiscardError['details']) {
    super(
      `Type change would discard ${details.uncoercible.length} uncoercible value(s); ` +
        `set discard_uncoercible: true to proceed`,
    );
    this.name = 'TypeChangeRequiresDiscardError';
    this.details = details;
  }
}

const VALID_FIELD_TYPES: Set<string> = new Set([
  'string', 'number', 'date', 'boolean', 'reference', 'enum', 'list',
]);

// ── Value helpers ────────────────────────────────────────────────────

function extractValue(row: {
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
}): unknown {
  if (row.value_json !== null) return JSON.parse(row.value_json);
  if (row.value_number !== null) return row.value_number;
  if (row.value_date !== null) return row.value_date;
  return row.value_text;
}

function classifyCoercedValue(value: unknown): {
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
} {
  if (value === null || value === undefined) {
    return { value_text: null, value_number: null, value_date: null, value_json: JSON.stringify(null) };
  }
  if (typeof value === 'string') {
    return { value_text: value, value_number: null, value_date: null, value_json: null };
  }
  if (typeof value === 'number') {
    return { value_text: null, value_number: value, value_date: null, value_json: null };
  }
  return { value_text: null, value_number: null, value_date: null, value_json: JSON.stringify(value) };
}

// ── Row → GlobalFieldDefinition ──────────────────────────────────────

interface GlobalFieldRow {
  name: string;
  field_type: string;
  enum_values: string | null;
  enum_groups: string | null;
  overrides_allowed_enum_groups: number;
  reference_target: string | null;
  description: string | null;
  default_value: string | null;
  required: number;
  ai_guessable: number;
  overrides_allowed_required: number;
  overrides_allowed_default_value: number;
  overrides_allowed_enum_values: number;
  overrides_allowed_ai_guessable: number;
  list_item_type: string | null;
  ui_hints: string | null;
}

function rowToDefinition(row: GlobalFieldRow): GlobalFieldDefinition {
  return {
    name: row.name,
    field_type: row.field_type as FieldType,
    enum_values: row.enum_values ? JSON.parse(row.enum_values) : null,
    enum_groups: row.enum_groups ? JSON.parse(row.enum_groups) : null,
    reference_target: row.reference_target,
    description: row.description,
    default_value: row.default_value !== null ? JSON.parse(row.default_value) : null,
    required: row.required === 1,
    ai_guessable: row.ai_guessable === 1,
    overrides_allowed: {
      required: row.overrides_allowed_required === 1,
      default_value: row.overrides_allowed_default_value === 1,
      enum_values: row.overrides_allowed_enum_values === 1,
      enum_groups: row.overrides_allowed_enum_groups === 1,
      ai_guessable: row.overrides_allowed_ai_guessable === 1,
    },
    list_item_type: row.list_item_type as FieldType | null,
    ui_hints: row.ui_hints !== null ? JSON.parse(row.ui_hints) as UiHints : null,
  };
}

// ── getGlobalField ───────────────────────────────────────────────────

export function getGlobalField(
  db: Database.Database,
  name: string,
): GlobalFieldDefinition | null {
  const row = db.prepare(`SELECT * FROM global_fields WHERE name = ?`).get(name) as
    | GlobalFieldRow
    | undefined;
  return row ? rowToDefinition(row) : null;
}

export function listGlobalFields(db: Database.Database): GlobalFieldDefinition[] {
  const rows = db.prepare('SELECT * FROM global_fields ORDER BY name').all() as GlobalFieldRow[];
  return rows.map(rowToDefinition);
}

// ── createGlobalField ────────────────────────────────────────────────

/**
 * The frontmatter key that holds a note's types (`types` unless VAULT_TYPE_KEY names
 * another) is not a field: a field of that name would be written over each note's types.
 */
function assertNotTypeKey(name: string): void {
  if (name === typeKey()) {
    throw new Error(`'${name}' is the frontmatter key that holds a note's types, so it cannot be a global field`);
  }
}

export function createGlobalField(
  db: Database.Database,
  input: CreateGlobalFieldInput,
): GlobalFieldDefinition {
  assertNotTypeKey(input.name);
  if (input.ai_guessable === true && !supportsAiGuessing(input.name)) {
    throw new Error(`Global field '${input.name}' cannot enable AI guessing because its name is reserved`);
  }

  validateClassificationState(db, input.name, { field_type: input.field_type, enum_values: input.enum_values ?? null, enum_groups: input.enum_groups ?? null, overrides_allowed: input.overrides_allowed ?? {} });

  // Validate field_type
  if (!VALID_FIELD_TYPES.has(input.field_type)) {
    throw new Error(`Invalid field_type: ${input.field_type}`);
  }

  // Validate enum requires enum_values
  if (input.field_type === 'enum') {
    if (!input.enum_values || input.enum_values.length === 0) {
      throw new Error('enum field_type requires non-empty enum_values');
    }
  }

  // Validate list requires list_item_type
  if (input.field_type === 'list') {
    if (!input.list_item_type) {
      throw new Error('list field_type requires list_item_type');
    }
    if (input.list_item_type === 'list') {
      throw new Error('Nested lists are not allowed (list_item_type cannot be list)');
    }
  }

  // Validate + normalize ui hints
  let uiHintsJson: string | null = null;
  if (input.ui !== undefined) {
    const validated = validateUiHints(input.ui);
    if (!validated.ok) {
      throw new Error(validated.reason);
    }
    const normalized = normalizeUiHints(validated.value);
    uiHintsJson = normalized !== null ? JSON.stringify(normalized) : null;
  }

  const enumValues = input.enum_values ? JSON.stringify(input.enum_values) : null;
  const defaultValue = input.default_value !== undefined && input.default_value !== null
    ? JSON.stringify(input.default_value)
    : null;

  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO global_fields (name, field_type, enum_values, reference_target, description, default_value, required, ai_guessable, overrides_allowed_required, overrides_allowed_default_value, overrides_allowed_enum_values, overrides_allowed_ai_guessable, list_item_type, ui_hints, enum_groups, overrides_allowed_enum_groups)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.name,
        input.field_type,
        enumValues,
        input.reference_target ?? null,
        input.description ?? null,
        defaultValue,
        input.required ? 1 : 0,
        input.ai_guessable ? 1 : 0,
        input.overrides_allowed?.required ? 1 : 0,
        input.overrides_allowed?.default_value ? 1 : 0,
        input.overrides_allowed?.enum_values ? 1 : 0,
        input.overrides_allowed?.ai_guessable ? 1 : 0,
        input.list_item_type ?? null,
        uiHintsJson,
        input.enum_groups == null ? null : JSON.stringify(parseEnumGroups(input.enum_groups, input.enum_values ?? [])),
        input.overrides_allowed?.enum_groups ? 1 : 0,
      );
      refreshTypedReferences(db, { kind: 'field', names: [input.name] });
    })();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE') || msg.includes('unique')) {
      throw new Error(`Global field '${input.name}' already exists`);
    }
    throw err;
  }

  return getGlobalField(db, input.name)!;
}

// ── updateGlobalField ────────────────────────────────────────────────

export function updateGlobalField(
  db: Database.Database,
  name: string,
  input: UpdateGlobalFieldInput,
): TypeChangeResult {
  const current = getGlobalField(db, name);
  if (!current) {
    throw new Error(`Global field '${name}' not found`);
  }
  if (input.ai_guessable === true && !supportsAiGuessing(name)) {
    throw new Error(`Global field '${name}' cannot enable AI guessing because its name is reserved`);
  }

  validateClassificationState(db, name, { ...current, ...input, enum_values: input.enum_values ?? current.enum_values, enum_groups: input.enum_groups === undefined ? current.enum_groups ?? null : input.enum_groups, overrides_allowed: { ...current.overrides_allowed, ...input.overrides_allowed } });

  const isTypeChange = input.field_type !== undefined && input.field_type !== current.field_type;

  if (!isTypeChange) {
    // Non-type-change: validate invariants after applying updates
    const effectiveType = current.field_type;
    const effectiveEnumValues = input.enum_values !== undefined ? input.enum_values : current.enum_values;
    const effectiveListItemType = input.list_item_type !== undefined ? input.list_item_type : current.list_item_type;

    if (effectiveType === 'enum' && (!effectiveEnumValues || effectiveEnumValues.length === 0)) {
      throw new Error('enum field_type requires non-empty enum_values');
    }
    if (effectiveType === 'list' && !effectiveListItemType) {
      throw new Error('list field_type requires list_item_type');
    }
    if (effectiveListItemType === 'list') {
      throw new Error('Nested lists are not allowed (list_item_type cannot be list)');
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.enum_groups !== undefined) {
      updates.push('enum_groups = ?');
      params.push(input.enum_groups === null ? null : JSON.stringify(parseEnumGroups(input.enum_groups, input.enum_values ?? current.enum_values ?? [])));
    }
    if (input.overrides_allowed?.enum_groups !== undefined) {
      updates.push('overrides_allowed_enum_groups = ?'); params.push(input.overrides_allowed.enum_groups ? 1 : 0);
    }
    if (input.description !== undefined) {
      updates.push('description = ?');
      params.push(input.description);
    }
    if (input.enum_values !== undefined) {
      updates.push('enum_values = ?');
      params.push(JSON.stringify(input.enum_values));
    }
    if (input.reference_target !== undefined) {
      updates.push('reference_target = ?');
      params.push(input.reference_target);
    }
    if (input.default_value !== undefined) {
      updates.push('default_value = ?');
      params.push(JSON.stringify(input.default_value));
    }
    if (input.required !== undefined) {
      updates.push('required = ?');
      params.push(input.required ? 1 : 0);
    }
    if (input.ai_guessable !== undefined) {
      updates.push('ai_guessable = ?');
      params.push(input.ai_guessable ? 1 : 0);
    }
    if (input.list_item_type !== undefined) {
      updates.push('list_item_type = ?');
      params.push(input.list_item_type);
    }
    if (input.overrides_allowed !== undefined) {
      if (input.overrides_allowed.required !== undefined) {
        updates.push('overrides_allowed_required = ?');
        params.push(input.overrides_allowed.required ? 1 : 0);
      }
      if (input.overrides_allowed.default_value !== undefined) {
        updates.push('overrides_allowed_default_value = ?');
        params.push(input.overrides_allowed.default_value ? 1 : 0);
      }
      if (input.overrides_allowed.enum_values !== undefined) {
        updates.push('overrides_allowed_enum_values = ?');
        params.push(input.overrides_allowed.enum_values ? 1 : 0);
      }
      if (input.overrides_allowed.ai_guessable !== undefined) {
        updates.push('overrides_allowed_ai_guessable = ?');
        params.push(input.overrides_allowed.ai_guessable ? 1 : 0);
      }
    }
    if (input.ui !== undefined) {
      const validated = validateUiHints(input.ui);
      if (!validated.ok) {
        throw new Error(validated.reason);
      }
      const normalized = normalizeUiHints(validated.value);
      updates.push('ui_hints = ?');
      params.push(normalized !== null ? JSON.stringify(normalized) : null);
    }

    if (updates.length > 0) {
      const updateTx = db.transaction(() => {
        params.push(name);
        db.prepare(`UPDATE global_fields SET ${updates.join(', ')} WHERE name = ?`).run(...params);
        assertFieldGuessCandidateIdentityBudget(db);
        if (input.reference_target !== undefined || input.list_item_type !== undefined) {
          refreshTypedReferences(db, { kind: 'field', names: [name] });
        }
      });
      updateTx();
    }

    return { preview: false, field: getGlobalField(db, name)! };
  }

  // Type change path
  const newType = input.field_type!;

  // Gather all node_fields rows for this field
  interface NodeFieldRow {
    node_id: string;
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    value_json: string | null;
  }

  const rows = db.prepare(
    `SELECT node_id, value_text, value_number, value_date, value_json FROM node_fields WHERE field_name = ?`,
  ).all(name) as NodeFieldRow[];

  const coercible: Array<{ node_id: string; old_value: unknown; new_value: unknown }> = [];
  const uncoercible: Array<{ node_id: string; value: unknown; reason: string }> = [];

  for (const row of rows) {
    const oldValue = extractValue(row);
    const result = coerceValue(oldValue, newType, {
      enum_values: input.enum_values ?? current.enum_values ?? undefined,
      list_item_type: input.list_item_type ?? current.list_item_type ?? undefined,
    });

    if (result.ok) {
      coercible.push({ node_id: row.node_id, old_value: oldValue, new_value: result.value });
    } else {
      uncoercible.push({ node_id: row.node_id, value: oldValue, reason: result.reason });
    }
  }

  if (!input.confirm) {
    // Preview mode
    return {
      preview: true,
      affected_nodes: rows.length,
      coercible,
      uncoercible,
      would_orphan: uncoercible.length,
    };
  }

  // Gate: refuse to discard uncoercible values without explicit opt-in.
  // The operator must acknowledge data loss via discard_uncoercible: true.
  if (uncoercible.length > 0 && !input.discard_uncoercible) {
    throw new TypeChangeRequiresDiscardError({
      affected_nodes: rows.length,
      coercible_count: coercible.length,
      uncoercible,
    });
  }

  // Apply mode
  const applyTx = db.transaction(() => {
    // Update global_fields type
    const gfUpdates: string[] = ['field_type = ?'];
    const gfParams: unknown[] = [newType];

    if (input.enum_groups !== undefined) {
      gfUpdates.push('enum_groups = ?'); gfParams.push(input.enum_groups === null ? null : JSON.stringify(input.enum_groups));
    }
    if (input.overrides_allowed?.enum_groups !== undefined) {
      gfUpdates.push('overrides_allowed_enum_groups = ?'); gfParams.push(input.overrides_allowed.enum_groups ? 1 : 0);
    }
    if (input.enum_values !== undefined) {
      gfUpdates.push('enum_values = ?');
      gfParams.push(JSON.stringify(input.enum_values));
    }
    if (input.list_item_type !== undefined) {
      gfUpdates.push('list_item_type = ?');
      gfParams.push(input.list_item_type);
    }
    if (input.reference_target !== undefined) {
      gfUpdates.push('reference_target = ?');
      gfParams.push(input.reference_target);
    }
    if (input.ai_guessable !== undefined) {
      gfUpdates.push('ai_guessable = ?');
      gfParams.push(input.ai_guessable ? 1 : 0);
    }
    if (input.overrides_allowed?.ai_guessable !== undefined) {
      gfUpdates.push('overrides_allowed_ai_guessable = ?');
      gfParams.push(input.overrides_allowed.ai_guessable ? 1 : 0);
    }
    if (input.ui !== undefined) {
      const validated = validateUiHints(input.ui);
      if (!validated.ok) {
        throw new Error(validated.reason);
      }
      const normalized = normalizeUiHints(validated.value);
      gfUpdates.push('ui_hints = ?');
      gfParams.push(normalized !== null ? JSON.stringify(normalized) : null);
    }

    gfParams.push(name);
    db.prepare(`UPDATE global_fields SET ${gfUpdates.join(', ')} WHERE name = ?`).run(...gfParams);

    // Coerce node_fields
    const updateStmt = db.prepare(
      `UPDATE node_fields SET value_text = ?, value_number = ?, value_date = ?, value_json = ?
       WHERE node_id = ? AND field_name = ?`,
    );

    for (const c of coercible) {
      const cols = classifyCoercedValue(c.new_value);
      updateStmt.run(cols.value_text, cols.value_number, cols.value_date, cols.value_json, c.node_id, name);
    }

    // Remove uncoercible values — the old value can't satisfy the new type,
    // so the field becomes unfilled. The schema claim remains; the node will
    // show this field in unfilled_claims until a valid value is provided.
    if (uncoercible.length > 0) {
      const deleteStmt = db.prepare(
        `DELETE FROM node_fields WHERE node_id = ? AND field_name = ?`,
      );
      const logStmt = db.prepare(
        `INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)`,
      );
      const now = Date.now();
      for (const u of uncoercible) {
        deleteStmt.run(u.node_id, name);
        logStmt.run(u.node_id, now, 'value-removed', JSON.stringify({
          source: 'tool',
          trigger: `update-global-field type change: ${current.field_type} → ${newType}`,
          field: name,
          removed_value: u.value,
          reason: u.reason,
        }));
      }
    }

    assertFieldGuessCandidateIdentityBudget(db);
    refreshTypedReferences(db, { kind: 'field', names: [name] });
  });

  applyTx();

  return {
    preview: false,
    applied: true,
    affected_nodes: rows.length,
    coercible,
    uncoercible,
    would_orphan: uncoercible.length,
  };
}

// ── renameGlobalField ────────────────────────────────────────────────

function findNodeFieldRenameCollisions(
  db: Database.Database,
  oldName: string,
  newName: string,
): string[] {
  const rows = db.prepare(`
    WITH source_nodes AS (
      SELECT node_id FROM node_fields WHERE field_name = ?
      UNION
      SELECT node_id FROM node_explicit_null_fields WHERE field_name = ?
    ), target_nodes AS (
      SELECT node_id FROM node_fields WHERE field_name = ?
      UNION
      SELECT node_id FROM node_explicit_null_fields WHERE field_name = ?
    )
    SELECT source_nodes.node_id
    FROM source_nodes
    INNER JOIN target_nodes USING (node_id)
    ORDER BY source_nodes.node_id
  `).all(oldName, oldName, newName, newName) as Array<{ node_id: string }>;
  return rows.map(row => row.node_id);
}

export function renameGlobalField(
  db: Database.Database,
  oldName: string,
  newName: string,
): { affected_nodes: number; affected_schemas: number } {
  const current = getGlobalField(db, oldName);
  if (!current) {
    throw new Error(`Global field '${oldName}' not found`);
  }
  assertNotTypeKey(newName);
  if (!supportsAiGuessing(newName)) {
    const hasTrueSchemaOverride = db.prepare(`
      SELECT 1
      FROM schema_field_claims
      WHERE field = ? AND ai_guessable_override = 1
      LIMIT 1
    `).get(oldName) !== undefined;
    if (current.ai_guessable || hasTrueSchemaOverride) {
      throw new Error(
        `Cannot rename global field '${oldName}' to reserved name '${newName}' while AI guessing is enabled globally or by a schema override`,
      );
    }
  }

  const renameTx = db.transaction(() => {
    const collidingNodeIds = findNodeFieldRenameCollisions(db, oldName, newName);
    if (collidingNodeIds.length > 0) {
      throw new Error(
        `Cannot rename global field '${oldName}' to '${newName}': ` +
        `field '${newName}' already exists on node(s): ${collidingNodeIds.join(', ')}`,
      );
    }
    const affectedNodes = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT node_id FROM node_fields WHERE field_name = ?
        UNION
        SELECT node_id FROM node_explicit_null_fields WHERE field_name = ?
      )
    `).get(oldName, oldName) as { count: number }).count;

    // 1. Insert new global_fields row first (so FK references can point to it)
    db.prepare(`
      INSERT INTO global_fields (name, field_type, enum_values, reference_target, description, default_value, required, ai_guessable, overrides_allowed_required, overrides_allowed_default_value, overrides_allowed_enum_values, overrides_allowed_ai_guessable, list_item_type, ui_hints, enum_groups, overrides_allowed_enum_groups)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newName,
      current.field_type,
      current.enum_values ? JSON.stringify(current.enum_values) : null,
      current.reference_target,
      current.description,
      current.default_value !== null ? JSON.stringify(current.default_value) : null,
      current.required ? 1 : 0,
      current.ai_guessable ? 1 : 0,
      current.overrides_allowed.required ? 1 : 0,
      current.overrides_allowed.default_value ? 1 : 0,
      current.overrides_allowed.enum_values ? 1 : 0,
      current.overrides_allowed.ai_guessable ? 1 : 0,
      current.list_item_type,
      current.ui_hints !== null ? JSON.stringify(current.ui_hints) : null,
      current.enum_groups == null ? null : JSON.stringify(current.enum_groups),
      current.overrides_allowed.enum_groups ? 1 : 0,
    );

    // 2. Update schema_field_claims to point to new name
    const sfcResult = db.prepare(
      `UPDATE schema_field_claims SET field = ? WHERE field = ?`,
    ).run(newName, oldName);

    // 3. Update node_fields
    db.prepare(
      `UPDATE node_fields SET field_name = ? WHERE field_name = ?`,
    ).run(newName, oldName);
    renameExplicitNullField(db, oldName, newName);

    // 4. Delete old global_fields row (no more FK references to it)
    db.prepare(`DELETE FROM global_fields WHERE name = ?`).run(oldName);

    assertFieldGuessCandidateIdentityBudget(db);
    refreshTypedReferences(db, { kind: 'field', names: [oldName, newName] });

    return {
      affected_nodes: affectedNodes,
      affected_schemas: sfcResult.changes,
    };
  });

  return renameTx();
}

// ── definitionToWire ─────────────────────────────────────────────────

/**
 * Convert a `GlobalFieldDefinition` to its wire shape for MCP responses,
 * renaming the internal `ui_hints` column key to the public `ui` API name.
 *
 * Read tools (`describe-global-field`, `describe-schema`) shape `ui` manually;
 * write tools that spread the definition into responses should use this helper
 * to keep the API surface coherent.
 *
 * Spec: docs/superpowers/specs/2026-05-03-mcp-app-foundations-2-3-design.md §2
 */
export function definitionToWire(def: GlobalFieldDefinition): Omit<GlobalFieldDefinition, 'ui_hints'> & { ui: UiHints | null } {
  const { ui_hints, ...rest } = def;
  return { ...rest, ui: ui_hints };
}

// ── deleteGlobalField ────────────────────────────────────────────────

export function deleteGlobalField(
  db: Database.Database,
  name: string,
): { affected_nodes: number; affected_schemas: number } {
  return db.transaction(() => {
    // Count before deleting
    const nodeCount = (db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM (
        SELECT node_id FROM node_fields WHERE field_name = ?
        UNION
        SELECT node_id FROM node_explicit_null_fields WHERE field_name = ?
      )
    `).get(name, name) as { cnt: number }).cnt;
    const schemaCount = (
      db.prepare(`SELECT COUNT(*) as cnt FROM schema_field_claims WHERE field = ?`).get(name) as { cnt: number }
    ).cnt;

    // The definition supplied wikilink brackets at render time. Preserve that
    // representation before removing it so orphan derivation and later renders
    // retain the same links. Existing raw text (including aliases) wins. This
    // stays in the deletion transaction and its existing undo snapshot.
    const definition = getGlobalField(db, name);
    if (readReferencePolicyVersion(db) === 2 && definition) {
      const updateRaw = db.prepare('UPDATE node_fields SET value_raw_text = ? WHERE node_id = ? AND field_name = ?');
      if (definition.field_type === 'reference') {
        const rows = db.prepare(`SELECT node_id, value_text FROM node_fields
          WHERE field_name = ? AND value_raw_text IS NULL AND value_text IS NOT NULL AND value_json IS NULL`)
          .all(name) as Array<{ node_id: string; value_text: string }>;
        for (const row of rows) updateRaw.run(`[[${row.value_text}]]`, row.node_id, name);
      } else if (definition.field_type === 'list' && definition.list_item_type === 'reference') {
        const rows = db.prepare(`SELECT node_id, value_json FROM node_fields
          WHERE field_name = ? AND value_raw_text IS NULL AND json_valid(value_json)
            AND json_type(value_json) = 'array'`).all(name) as Array<{ node_id: string; value_json: string }>;
        for (const row of rows) {
          const values = JSON.parse(row.value_json) as unknown[];
          const raw = JSON.stringify(values.map(value => typeof value === 'string' ? `[[${value}]]` : value));
          updateRaw.run(raw, row.node_id, name);
        }
      }
    }

    // Delete schema_field_claims first (FK has no CASCADE on field column)
    db.prepare(`DELETE FROM schema_field_claims WHERE field = ?`).run(name);
    // Then delete global_fields row
    db.prepare(`DELETE FROM global_fields WHERE name = ?`).run(name);

    refreshTypedReferences(db, { kind: 'field', names: [name] });
    return { affected_nodes: nodeCount, affected_schemas: schemaCount };
  })();
}

export function validateClassificationState(db: Database.Database, name: string, field: {field_type: string; enum_values: string[] | null; enum_groups: EnumGroupsV1 | null; overrides_allowed: {enum_groups?: boolean}}): void {
  if (field.enum_groups !== null) {
    if (field.field_type !== 'enum' || field.enum_values === null) throw new ClassificationError('CLASSIFICATION_INVALID_CONFIG', 'Groups require a scalar enum vocabulary.');
    parseEnumGroups(field.enum_groups, field.enum_values);
  }
  const claims = db.prepare('SELECT schema_name,enum_values_override,enum_groups_override FROM schema_field_claims WHERE field = ?').all(name) as {schema_name:string;enum_values_override:string|null;enum_groups_override:string|null}[];
  for (const claim of claims) {
    const override = claim.enum_groups_override ? JSON.parse(claim.enum_groups_override) as EnumGroupsV1 : null;
    if (override !== null || field.enum_groups !== null) resolveEnumGroups({context:{schema:claim.schema_name,field:name},fieldType:field.field_type,globalValues:field.enum_values,typeValues:claim.enum_values_override ? JSON.parse(claim.enum_values_override) : null,globalGroups:field.enum_groups,override,overrideAllowed:field.overrides_allowed.enum_groups === true});
  }
}
