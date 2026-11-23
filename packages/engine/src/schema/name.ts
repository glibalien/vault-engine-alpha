// src/schema/name.ts
//
// What a new schema may be called. A schema's name is also its file name in .schemas/
// (`<name>.yaml`, see render.ts), so a name that is a path, or one of Engine's own files
// there, is refused when a schema is created. Schemas that already exist keep their names;
// render.ts keeps their files inside .schemas/ whatever the name.

/** The rule in words, for refusals. */
export const SCHEMA_NAME_RULE = 'a schema\'s name is also its file name in .schemas/, so it can\'t contain "/" or "\\", '
  + 'can\'t be "." or "..", and can\'t start with "_" (reserved for Engine\'s own files there, such as _fields.yaml)';

/**
 * Whether `name` can name a new schema: no slash or backslash, not "." or "..", and no
 * leading "_". Everything else is allowed (spaces, unicode, dots inside the name). This is
 * the rule the vault map's kinds already follow (materialize-transcript, Curator).
 */
export function isSchemaName(name: string): boolean {
  return !/[\\/]/.test(name) && name !== '.' && name !== '..' && !name.startsWith('_');
}

/** The refusal for a name that can't name a new schema, or null when it can. */
export function schemaNameProblem(name: string): string | null {
  return isSchemaName(name) ? null : `Schema name ${JSON.stringify(name)} can't be used: ${SCHEMA_NAME_RULE}.`;
}
