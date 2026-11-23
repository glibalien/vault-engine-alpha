export const REFERENCE_EDIT_LIMITS = {
  fieldBytes: 256, selectorBytes: 4096, listEntries: 1000, listBytes: 256 * 1024,
  resultBytes: 1024 * 1024, catalogNodes: 50_000, catalogBytes: 16 * 1024 * 1024,
} as const;

export type ReferenceTarget = { node_id: string } | { stored_value: string };
export type ReferenceEdit = { field: string; action: 'add' | 'remove'; target: ReferenceTarget };
export type Presence = 'absent' | 'explicit_null' | 'list';
export type IdentityRow = { id: string; file_path: string; title: string | null };
export interface IdentityIndex {
  candidates(value: string): readonly IdentityRow[];
  additionTitle(targetId: string): string;
}
export interface MemberPlanInput {
  edit: ReferenceEdit;
  before: { presence: Presence; values: readonly string[] };
  identity: IdentityIndex;
}
export interface MemberPlan {
  outcome: 'added' | 'removed' | 'already_present' | 'already_absent';
  changed: boolean;
  before: { presence: Presence; count: number };
  after: { presence: Presence; count: number };
  values: readonly string[];
  added_count: number;
  removed_count: number;
}
export class ReferenceEditError extends Error {
  constructor(
    public readonly code: 'INVALID_PARAMS' | 'NOT_FOUND' | 'NOT_ELIGIBLE' | 'AMBIGUOUS_MATCH' | 'VALIDATION_FAILED' | 'CONFLICT' | 'INTERNAL_ERROR',
    message: string,
    public readonly details: Record<string, unknown>,
  ) { super(message); this.name = 'ReferenceEditError'; }
}

export function checkListLimit(values: readonly string[]): void {
  if (values.length > REFERENCE_EDIT_LIMITS.listEntries || Buffer.byteLength(JSON.stringify(values), 'utf8') > REFERENCE_EDIT_LIMITS.listBytes) {
    throw new ReferenceEditError('NOT_ELIGIBLE', 'Reference list exceeds the member-edit limit', { reason: 'list_limit' });
  }
}
