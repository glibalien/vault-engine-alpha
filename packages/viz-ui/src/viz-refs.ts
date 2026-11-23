export interface SchemaFieldLike { name: string; reference_target?: string | null }

/** Field names that are references (carry a non-empty reference_target in describe-schema output). */
export function referenceFieldNames(fields: SchemaFieldLike[] | undefined): string[] {
  if (!fields) return [];
  return fields
    .filter((f) => typeof f.reference_target === 'string' && f.reference_target.length > 0)
    .map((f) => f.name);
}
