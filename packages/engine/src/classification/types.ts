export interface EnumGroupsV1 {
  version: 1;
  groups: { name: string; values: string[]; label?: string; description?: string }[];
}
export interface ClassificationContext { schema: string; field: string }
export interface ClassificationDependency extends ClassificationContext { execution_hash: string }
export type StoredEnumValue = { kind: 'missing' } | { kind: 'null' } | { kind: 'value'; value: unknown };
export type ValueClassification =
  | { state: 'classified'; value: string; groups: string[] }
  | { state: 'unclassified'; reason: 'missing' | 'null' | 'invalid' | 'unmapped'; original: StoredEnumValue };
export type ClassificationOutcome = ValueClassification | { state: 'not_applicable' } | { state: 'missing_node' };
export interface EffectiveEnumGroups extends ClassificationContext {
  origin: 'global' | 'override'; enum_values: string[]; enum_groups: EnumGroupsV1;
  excluded_values: { group: string; values: string[] }[];
  unassigned_values: string[]; definition_hash: string;
  global_definition_hash: string; execution_hash: string;
}
export class ClassificationError extends Error {
  constructor(public readonly code: 'CLASSIFICATION_INVALID_CONFIG' | 'CLASSIFICATION_STALE_DEFINITION' | 'CLASSIFICATION_LIMIT_EXCEEDED' | 'CLASSIFICATION_IN_USE', message: string, public readonly details?: unknown) {
    super(message); this.name = 'ClassificationError';
  }
}
