// src/schema/render.ts
//
// Schema and global field YAML rendering to .schemas/ directory.
// One-way: DB → disk. The watcher skips .schemas/.

import { namespace } from '../rollups/definitions.js';
import { join, dirname, relative } from 'node:path';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { stringify } from 'yaml';
import type Database from 'better-sqlite3';
import { sha256 } from '../indexer/hash.js';
import { atomicWriteFile, readFileOrNull } from '../pipeline/file-writer.js';
import { safeVaultPath } from '../pipeline/safe-path.js';

const SCHEMAS_DIR = '.schemas';
const FIELDS_FILE = '_fields.yaml';

/**
 * The file of schema `schemaName`, `.schemas/<name>.yaml`, or null when the name would put
 * it anywhere else: outside `.schemas/` (a name with `..` parts), or over the field pool's
 * `_fields.yaml`. Every read, write and delete of a schema's file goes through this (#473).
 * New schemas can't get such a name (`isSchemaName`); a schema that already has one keeps
 * working in the database, and Engine writes, reads and deletes no file for it.
 */
export function schemaFilePath(vaultPath: string, schemaName: string): string | null {
  const schemasDir = join(vaultPath, SCHEMAS_DIR);
  let filePath: string;
  try {
    filePath = safeVaultPath(schemasDir, `${schemaName}.yaml`);
  } catch {
    return null;
  }
  // Any casing of the pool's name is the same file on a case-insensitive filesystem.
  if (relative(schemasDir, filePath).toLowerCase() === FIELDS_FILE) return null;
  return filePath;
}

/** The edits_log entry for a schema whose name puts its file outside `.schemas/`. */
function logOutsideSchemasDir(
  db: Database.Database,
  eventType: 'schema-file-render-blocked' | 'schema-file-delete-blocked',
  relPath: string,
): void {
  db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
    null, Date.now(), eventType,
    JSON.stringify({
      file_path: relPath,
      reason: 'outside-schemas-dir',
      resolution: 'The schema\'s name would put its file outside .schemas/ (or over _fields.yaml), so Engine '
        + 'writes, reads and deletes no file for it. The schema itself works as before in the database.',
    }),
  );
}

const YAML_OPTIONS = {
  indent: 2,
  lineWidth: 0,
  defaultKeyType: 'PLAIN' as const,
  defaultStringType: 'PLAIN' as const,
};

/**
 * Render a schema to its YAML file in .schemas/.
 * Returns true if the file was written, false if blocked by hash mismatch.
 */
export function renderSchemaFile(
  db: Database.Database,
  vaultPath: string,
  schemaName: string,
  fsRollback?: { push(undo: () => void): void },
): boolean {
  const relPath = `${SCHEMAS_DIR}/${schemaName}.yaml`;

  // Load schema from DB
  const schemaRow = db.prepare('SELECT * FROM schemas WHERE name = ?').get(schemaName) as {
    name: string; display_name: string | null; icon: string | null;
    filename_template: string | null; default_directory: string | null; metadata: string | null;
  } | undefined;
  if (!schemaRow) return false;

  const filePath = schemaFilePath(vaultPath, schemaName);
  if (filePath === null) {
    logOutsideSchemasDir(db, 'schema-file-render-blocked', relPath);
    return false;
  }

  // Load claims with inlined global field definitions
  const claims = db.prepare(`
    SELECT sfc.*, gf.field_type, gf.enum_values, gf.reference_target, gf.description as gf_description,
           gf.default_value as gf_default_value, gf.required as gf_required,
           gf.ai_guessable as gf_ai_guessable,
           gf.overrides_allowed_required, gf.overrides_allowed_default_value,
           gf.overrides_allowed_enum_values, gf.overrides_allowed_ai_guessable, gf.list_item_type, gf.enum_groups as gf_enum_groups, gf.overrides_allowed_enum_groups
    FROM schema_field_claims sfc
    JOIN global_fields gf ON gf.name = sfc.field
    WHERE sfc.schema_name = ?
    ORDER BY sfc.sort_order, sfc.field
  `).all(schemaName) as Array<{
    field: string; sort_order: number; label: string | null; description: string | null;
    required_override: number | null; default_value_override: string | null;
    default_value_overridden: number; enum_values_override: string | null;
    ai_guessable_override: number | null;
    enum_groups_override: string | null; gf_enum_groups: string | null;
    field_type: string; enum_values: string | null; enum_groups: string | null; reference_target: string | null;
    gf_description: string | null; gf_default_value: string | null; gf_required: number;
    gf_ai_guessable: number;
    overrides_allowed_required: number; overrides_allowed_default_value: number;
    overrides_allowed_enum_values: number; list_item_type: string | null;
    overrides_allowed_ai_guessable: number;
    overrides_allowed_enum_groups: number;
  }>;

  // Build YAML structure
  const data: Record<string, unknown> = { name: schemaRow.name };
  if (schemaRow.display_name) data.display_name = schemaRow.display_name;
  if (schemaRow.icon) data.icon = schemaRow.icon;
  if (schemaRow.default_directory) data.default_directory = schemaRow.default_directory;
  if (schemaRow.filename_template) data.filename_template = schemaRow.filename_template;

  const views = namespace(schemaRow.metadata ? JSON.parse(schemaRow.metadata) : null);
  if (views !== undefined) data.relationship_views = views;

  data.field_claims = claims.map(c => {
    const claim: Record<string, unknown> = { field: c.field };
    if (c.sort_order !== 1000) claim.sort_order = c.sort_order;
    if (c.required_override !== null) claim.required_override = c.required_override === 1;
    if (c.default_value_overridden === 1) {
      claim.default_value_override = c.default_value_override !== null ? JSON.parse(c.default_value_override) : null;
    }
    if (c.enum_groups_override != null) claim.enum_groups_override = JSON.parse(c.enum_groups_override);
    if (c.enum_values_override !== null) claim.enum_values_override = JSON.parse(c.enum_values_override);
    if (c.ai_guessable_override !== null) claim.ai_guessable_override = c.ai_guessable_override === 1;

    const gf: Record<string, unknown> = { field_type: c.field_type };
    if (c.enum_values) gf.enum_values = JSON.parse(c.enum_values);
    if (c.gf_enum_groups) gf.enum_groups = JSON.parse(c.gf_enum_groups);
    gf.overrides_allowed = { enum_groups: Boolean(c.overrides_allowed_enum_groups) };
    if (c.list_item_type) gf.list_item_type = c.list_item_type;
    if (c.reference_target) gf.reference_target = c.reference_target;
    if (c.gf_required) gf.required = false; // global required=false shown only when meaningful
    if (c.gf_ai_guessable) gf.ai_guessable = true;
    claim.global_field = gf;

    return claim;
  });

  const content = stringify(data, YAML_OPTIONS);
  return writeSchemaFileWithHashCheck(db, vaultPath, filePath, relPath, content, fsRollback);
}

/**
 * Render the global field pool to _fields.yaml.
 */
export function renderFieldsFile(db: Database.Database, vaultPath: string, fsRollback?: { push(undo: () => void): void }): boolean {
  const filePath = join(vaultPath, SCHEMAS_DIR, FIELDS_FILE);
  const relPath = `${SCHEMAS_DIR}/${FIELDS_FILE}`;

  const fields = db.prepare('SELECT * FROM global_fields ORDER BY name').all() as Array<{
    name: string; field_type: string; enum_values: string | null; enum_groups: string | null; reference_target: string | null;
    description: string | null; default_value: string | null; required: number;
    ai_guessable: number;
    overrides_allowed_required: number; overrides_allowed_default_value: number;
    overrides_allowed_enum_values: number; list_item_type: string | null;
    overrides_allowed_ai_guessable: number;
    overrides_allowed_enum_groups: number;
  }>;

  const data = {
    fields: fields.map(f => {
      const entry: Record<string, unknown> = { name: f.name, field_type: f.field_type };
      if (f.enum_values) entry.enum_values = JSON.parse(f.enum_values);
      if (f.enum_groups) entry.enum_groups = JSON.parse(f.enum_groups);
      if (f.list_item_type) entry.list_item_type = f.list_item_type;
      if (f.reference_target) entry.reference_target = f.reference_target;
      if (f.description) entry.description = f.description;
      if (f.default_value) entry.default_value = JSON.parse(f.default_value);
      if (f.required) entry.required = false;
      if (f.ai_guessable) entry.ai_guessable = true;
      if (f.overrides_allowed_required || f.overrides_allowed_default_value || f.overrides_allowed_enum_values || f.overrides_allowed_ai_guessable || f.overrides_allowed_enum_groups) {
        const oa: Record<string, boolean> = {};
        if (f.overrides_allowed_enum_groups) oa.enum_groups = true;
        if (f.overrides_allowed_required) oa.required = true;
        if (f.overrides_allowed_default_value) oa.default_value = true;
        if (f.overrides_allowed_enum_values) oa.enum_values = true;
        if (f.overrides_allowed_ai_guessable) oa.ai_guessable = true;
        entry.overrides_allowed = oa;
      }
      return entry;
    }),
  };

  const content = stringify(data, YAML_OPTIONS);
  return writeSchemaFileWithHashCheck(db, vaultPath, filePath, relPath, content, fsRollback);
}

/**
 * Write a schema file with hash-check protection.
 * Refuses to overwrite if the file was externally edited.
 */
function writeSchemaFileWithHashCheck(
  db: Database.Database,
  vaultPath: string,
  filePath: string,
  relPath: string,
  content: string,
  fsRollback?: { push(undo: () => void): void },
): boolean {
  const schemasDir = dirname(filePath);
  if (!existsSync(schemasDir)) {
    mkdirSync(schemasDir, { recursive: true });
  }

  const renderedHash = sha256(content);

  // Check stored hash
  const stored = db.prepare('SELECT content_hash FROM schema_file_hashes WHERE file_path = ?')
    .get(relPath) as { content_hash: string } | undefined;

  if (stored) {
    // Hash check: compare on-disk file hash against stored hash
    const onDisk = readFileOrNull(filePath);
    if (onDisk !== null) {
      const onDiskHash = sha256(onDisk);
      if (onDiskHash !== stored.content_hash) {
        // External edit detected — refuse to overwrite
        db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
          null, Date.now(), 'schema-file-render-blocked',
          JSON.stringify({
            file_path: relPath,
            expected_hash: stored.content_hash,
            found_hash: onDiskHash,
            resolution: 'Delete the file to let the engine re-create it, or restore it to its canonical content. The schema change has been applied to the database.',
          }),
        );
        return false;
      }
    }
  }

  // Write the file
  const tmpDir = join(vaultPath, '.vault-engine', 'tmp');
  const previous = fsRollback ? readFileOrNull(filePath) : null;
  atomicWriteFile(filePath, content, tmpDir);
  fsRollback?.push(() => {
    // Never overwrite a concurrent edit or recreate a concurrently moved file.
    if (readFileOrNull(filePath) !== content) return;
    if (previous === null) unlinkSync(filePath);
    else atomicWriteFile(filePath, previous, tmpDir);
  });

  // Store/update the hash
  db.prepare(`
    INSERT INTO schema_file_hashes (file_path, content_hash, rendered_at)
    VALUES (?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET content_hash = ?, rendered_at = ?
  `).run(relPath, renderedHash, Date.now(), renderedHash, Date.now());

  return true;
}

/**
 * Delete a schema file with hash-check protection.
 */
export function deleteSchemaFile(
  db: Database.Database,
  vaultPath: string,
  schemaName: string,
): boolean {
  const relPath = `${SCHEMAS_DIR}/${schemaName}.yaml`;
  const filePath = schemaFilePath(vaultPath, schemaName);
  if (filePath === null) {
    // Whatever such a name wrote before is left where it is. Its hash row goes with the
    // schema, unless it is the field pool's own.
    if (relPath !== `${SCHEMAS_DIR}/${FIELDS_FILE}`) {
      db.prepare('DELETE FROM schema_file_hashes WHERE file_path = ?').run(relPath);
    }
    logOutsideSchemasDir(db, 'schema-file-delete-blocked', relPath);
    return false;
  }

  if (!existsSync(filePath)) {
    db.prepare('DELETE FROM schema_file_hashes WHERE file_path = ?').run(relPath);
    return true;
  }

  const stored = db.prepare('SELECT content_hash FROM schema_file_hashes WHERE file_path = ?')
    .get(relPath) as { content_hash: string } | undefined;

  if (stored) {
    const onDisk = readFileOrNull(filePath);
    if (onDisk !== null && sha256(onDisk) !== stored.content_hash) {
      // External edit — refuse to delete
      db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
        null, Date.now(), 'schema-file-delete-blocked',
        JSON.stringify({
          file_path: relPath,
          expected_hash: stored.content_hash,
          found_hash: sha256(onDisk),
          resolution: 'The schema was deleted from the database but the file was externally edited and was not deleted. Delete it manually if no longer needed.',
        }),
      );
      return false;
    }
  }

  try {
    unlinkSync(filePath);
  } catch {
    // File may have been deleted already
  }
  db.prepare('DELETE FROM schema_file_hashes WHERE file_path = ?').run(relPath);
  return true;
}

/**
 * Startup: check all schema file hashes and re-render as needed.
 */
export function startupSchemaRender(db: Database.Database, vaultPath: string): void {
  // Check existing hash entries
  const entries = db.prepare('SELECT file_path, content_hash FROM schema_file_hashes').all() as Array<{
    file_path: string; content_hash: string;
  }>;

  const prefix = `${SCHEMAS_DIR}/`;
  for (const entry of entries) {
    if (!entry.file_path.startsWith(prefix) || !entry.file_path.endsWith('.yaml')) continue;
    const name = entry.file_path.slice(prefix.length, -'.yaml'.length);
    const isFieldsFile = entry.file_path === `${prefix}${FIELDS_FILE}`;
    const filePath = isFieldsFile ? join(vaultPath, entry.file_path) : schemaFilePath(vaultPath, name);
    // A name outside .schemas/ (recorded before #473): nothing there is read or re-rendered.
    if (filePath === null) continue;
    const onDisk = readFileOrNull(filePath);

    if (onDisk === null) {
      // File missing: re-render
      if (isFieldsFile) {
        renderFieldsFile(db, vaultPath);
      } else {
        renderSchemaFile(db, vaultPath, name);
      }
    } else {
      const onDiskHash = sha256(onDisk);
      if (onDiskHash !== entry.content_hash) {
        // External edit: log and skip
        db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
          null, Date.now(), 'schema-file-render-blocked',
          JSON.stringify({
            file_path: entry.file_path,
            expected_hash: entry.content_hash,
            found_hash: onDiskHash,
            resolution: 'Delete the file to let the engine re-create it, or restore it to its canonical content.',
          }),
        );
      }
    }
  }

  // Render any schemas without hash entries
  const schemas = db.prepare('SELECT name FROM schemas').all() as Array<{ name: string }>;
  for (const { name } of schemas) {
    const relPath = `${SCHEMAS_DIR}/${name}.yaml`;
    const hasEntry = db.prepare('SELECT 1 FROM schema_file_hashes WHERE file_path = ?').get(relPath);
    if (!hasEntry) {
      renderSchemaFile(db, vaultPath, name);
    }
  }

  // Always re-render _fields.yaml
  renderFieldsFile(db, vaultPath);
}
