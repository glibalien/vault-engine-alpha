import type { ProposedField } from './analyzer.js';

/** Kinds Engine's project tooling and Curator look for, each designated in Settings/Vault.md. */
export const ROLES = ['project', 'task', 'meeting', 'person', 'company'] as const;
export type Role = typeof ROLES[number];

export type FieldDefinition = Pick<ProposedField, 'name' | 'field_type' | 'list_item_type' | 'enum_values' | 'reference_target'>;

/** A starter status field's values: Engine's default wiki buckets (open, done, blocked, backlog, dropped). */
export const STARTER_STATUS_VALUES = ['open', 'in-progress', 'blocked', 'backlog', 'done', 'dropped'];

/**
 * The fields a starter type comes with, for a kind the user asked for a new type for. Field
 * names follow Engine's defaults (`peopleField` is `people involved`, `companyField` is
 * `company`). Every field is optional and has no default. A status field is not among
 * them: it is designated per kind, and a new one is added only when chosen.
 */
export const STARTER_TYPE_FIELDS: Record<Role, string[]> = {
  project: ['due', 'people involved', 'company'],
  task: ['due', 'project'],
  meeting: ['project', 'people involved', 'date'],
  person: ['company'],
  company: [],
};

/** Every field name a starter type can add; a new status field cannot take one. */
export const STARTER_FIELD_NAMES: ReadonlySet<string> = new Set(Object.values(STARTER_TYPE_FIELDS).flat());

/** Definitions for starter fields; reference targets follow the designated kinds. */
export function starterFieldDefinition(name: string, roles: Record<Role, string | null>): FieldDefinition | null {
  switch (name) {
    case 'due':
    case 'date':
      return { name, field_type: 'date' };
    case 'project':
      return withTarget({ name, field_type: 'list', list_item_type: 'reference' }, roles.project);
    case 'people involved':
      return withTarget({ name, field_type: 'list', list_item_type: 'reference' }, roles.person);
    case 'company':
      return withTarget({ name, field_type: 'reference' }, roles.company);
    default:
      return null;
  }
}

/** A new status field, added only when the user chooses one: an enum of the starter values. */
export function starterStatusDefinition(name: string): FieldDefinition {
  return { name, field_type: 'enum', enum_values: STARTER_STATUS_VALUES };
}

function withTarget(definition: FieldDefinition, target: string | null): FieldDefinition {
  return target === null ? definition : { ...definition, reference_target: target };
}
