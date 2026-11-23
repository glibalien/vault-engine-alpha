/**
 * Minimal identity shared by the Engine candidate wire and Curator's closed
 * decision protocol. Keep this projection host-agnostic and dependency-free.
 */
export interface FieldGuessCandidateIdentity {
  field: string;
  field_type: 'string' | 'number' | 'date' | 'boolean' | 'reference' | 'enum' | 'list';
  list_item_type: FieldGuessCandidateIdentity['field_type'] | null;
}

export const FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS = 20_000;
export const FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS =
  FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS;

/**
 * The complete legal-constraint core which must survive prompt reduction for
 * every offered field. Presentation metadata such as descriptions and
 * eligibility is intentionally outside this wire invariant.
 */
export interface FieldGuessCandidateMandatory extends FieldGuessCandidateIdentity {
  enum_values: string[] | null;
  per_type_enum_values?: Array<{ type: string; values: string[] | null }>;
  reference_target: string | null;
}

const FIELD_GUESS_ALLOWED_ACTIONS = ['set', 'abstain'] as const;

/** Serialize one mandatory identity record exactly as it crosses the model boundary. */
export function serializeFieldGuessCandidateIdentity(
  identity: FieldGuessCandidateIdentity,
): string {
  return JSON.stringify({
    field: identity.field,
    field_type: identity.field_type,
    list_item_type: identity.list_item_type,
    allowed_actions: FIELD_GUESS_ALLOWED_ACTIONS,
  });
}

/** Serialize one mandatory offered-field record without shortening constraints. */
export function serializeFieldGuessCandidateMandatory(
  candidate: FieldGuessCandidateMandatory,
): string {
  const enumCompatible = candidate.field_type === 'enum'
    || (candidate.field_type === 'list' && candidate.list_item_type === 'enum');
  const referenceCompatible = candidate.field_type === 'reference'
    || (candidate.field_type === 'list' && candidate.list_item_type === 'reference');
  return JSON.stringify({
    field: candidate.field,
    field_type: candidate.field_type,
    list_item_type: candidate.list_item_type,
    allowed_actions: FIELD_GUESS_ALLOWED_ACTIONS,
    ...(enumCompatible
      || candidate.enum_values !== null
      || candidate.per_type_enum_values !== undefined
      ? { enum_values: candidate.enum_values }
      : {}),
    ...(candidate.per_type_enum_values === undefined
      ? {}
      : { per_type_enum_values: candidate.per_type_enum_values }),
    ...(referenceCompatible || candidate.reference_target !== null
      ? { reference_target: candidate.reference_target }
      : {}),
  });
}

/** Count JavaScript UTF-16 characters, including one newline between records. */
export function fieldGuessCandidateIdentityProjectionChars(
  identities: readonly FieldGuessCandidateIdentity[],
): number {
  if (identities.length === 0) return 0;
  return identities.reduce(
    (total, identity) => total + serializeFieldGuessCandidateIdentity(identity).length,
    identities.length - 1,
  );
}

/** Count the one aggregate mandatory projection, including record newlines. */
export function fieldGuessCandidateMandatoryProjectionChars(
  candidates: readonly FieldGuessCandidateMandatory[],
): number {
  if (candidates.length === 0) return 0;
  return candidates.reduce(
    (total, candidate) => total + serializeFieldGuessCandidateMandatory(candidate).length,
    candidates.length - 1,
  );
}
