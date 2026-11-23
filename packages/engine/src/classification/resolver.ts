import { classificationHash, globalClassificationHash, parseEnumGroups } from './definitions.js';
import { ClassificationError, type ClassificationContext, type EffectiveEnumGroups, type EnumGroupsV1, type StoredEnumValue, type ValueClassification } from './types.js';
export interface ResolveEnumGroupsInput {
  context: ClassificationContext; fieldType: string; globalValues: string[] | null; typeValues: string[] | null;
  globalGroups: EnumGroupsV1 | null; override: EnumGroupsV1 | null; overrideAllowed: boolean;
}
export function resolveEnumGroups(input: ResolveEnumGroupsInput): EffectiveEnumGroups {
  const { context, fieldType, globalValues, typeValues, globalGroups, override, overrideAllowed } = input;
  const fail = (message: string): never => { throw new ClassificationError('CLASSIFICATION_INVALID_CONFIG', message, context); };
  if (fieldType !== 'enum' || globalValues === null) return fail('Classification requires a scalar enum with a vocabulary.');
  if (override !== null && !overrideAllowed) return fail('Enum group overrides are disabled.');
  const global = globalGroups === null ? null : parseEnumGroups(globalGroups, globalValues);
  const vocabulary = [...new Set(typeValues ?? globalValues)].sort();
  const selected = override !== null ? parseEnumGroups(override, vocabulary) : global;
  if (selected === null) return fail('No enum group definition is configured.');
  const allowed = new Set(vocabulary);
  const excluded_values = selected.groups.map(g => ({ group: g.name, values: g.values.filter(v => !allowed.has(v)) })).filter(g => g.values.length > 0);
  const effective: EnumGroupsV1 = { version: 1, groups: selected.groups.map(g => ({ ...g, values: g.values.filter(v => allowed.has(v)) })) };
  const assigned = new Set(effective.groups.flatMap(g => g.values));
  const global_definition_hash = globalClassificationHash({ field_type: fieldType, enum_values: globalValues, enum_groups: global, overrides_allowed: { enum_groups: overrideAllowed } });
  return { ...context, origin: override !== null ? 'override' : 'global', enum_values: vocabulary, enum_groups: effective, excluded_values,
    unassigned_values: vocabulary.filter(v => !assigned.has(v)), global_definition_hash,
    definition_hash: classificationHash({ ...context, global_definition_hash, type_values: typeValues === null ? null : vocabulary, override: override === null ? null : selected }),
    execution_hash: classificationHash({ ...context, enum_values: vocabulary, groups: effective.groups.map(g => ({ name: g.name, values: g.values })) }),
  };
}
export function classifyEnumValue(definition: EffectiveEnumGroups, original: StoredEnumValue): ValueClassification {
  if (original.kind !== 'value') return { state: 'unclassified', reason: original.kind, original };
  if (typeof original.value !== 'string' || !definition.enum_values.includes(original.value)) return { state: 'unclassified', reason: 'invalid', original };
  const value = original.value;
  const groups = definition.enum_groups.groups.filter(g => g.values.includes(value)).map(g => g.name);
  return groups.length ? { state: 'classified', value, groups } : { state: 'unclassified', reason: 'unmapped', original };
}
