/**
 * Field names are data, including __proto__ and Object.prototype member names.
 * Use a dictionary without inherited properties whenever accumulating or patching
 * field values. Copies retain only the source's own enumerable properties.
 */
export function createFieldMap<T>(source?: Readonly<Record<string, T>>): Record<string, T> {
  const fields: Record<string, T> = {};
  Object.setPrototypeOf(fields, null);
  if (source !== undefined) Object.assign(fields, source);
  return fields;
}
