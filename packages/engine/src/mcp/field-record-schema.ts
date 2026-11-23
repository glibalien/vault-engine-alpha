import { z } from 'zod';

const KEY_PREFIX = 'field:';
const recordInputSchema = z.record(z.string(), z.unknown());

/**
 * Zod records omit `__proto__`, even when it is an own JSON property. Encode
 * every key before parsing so arbitrary field names remain data, then restore
 * them with Object.fromEntries (which creates own properties without setters).
 * Prefixing every key keeps literal prefixes collision-free. Validation runs on
 * encoded keys; issues are translated back to the caller's field names. Public
 * Zod JSON-schema metadata retains the original record's advertised input shape
 * while the transform preserves keys that Zod would otherwise discard.
 * Value schemas must be synchronous, matching the tool schemas using this helper.
 */
export function fieldRecordSchema<Value extends z.ZodType>(valueSchema: Value) {
  const recordSchema = z.record(z.string(), valueSchema);
  const { $schema: _dialect, ...inputJsonSchema } = z.toJSONSchema(recordSchema, {
    io: 'input', target: 'draft-7', cycles: 'throw', reused: 'inline',
  });
  return z.unknown().transform((input, ctx): Record<string, z.output<Value>> => {
    // Check record shape without transforming values. Keep the original input:
    // the shape check's parsed data has already lost __proto__.
    const shape = recordInputSchema.safeParse(input);
    if (!shape.success) {
      for (const issue of shape.error.issues) ctx.addIssue({ ...issue });
      return z.NEVER;
    }
    // Object.entries excludes inherited properties; all encoded names begin
    // with a non-underscore prefix and can never equal __proto__.
    const encoded = Object.fromEntries(Object.entries(input as Record<string, unknown>)
      .map(([key, value]) => [`${KEY_PREFIX}${key}`, value]));
    const parsed = recordSchema.safeParse(encoded);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const [key, ...rest] = issue.path;
        ctx.addIssue({ ...issue, path: typeof key === 'string'
          ? [key.slice(KEY_PREFIX.length), ...rest]
          : issue.path });
      }
      return z.NEVER;
    }
    return Object.fromEntries(Object.entries(parsed.data)
      .map(([key, value]) => [key.slice(KEY_PREFIX.length), value]));
  }).meta(inputJsonSchema);
}
