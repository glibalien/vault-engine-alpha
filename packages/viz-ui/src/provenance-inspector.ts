import type {
  ProvenanceComparison,
  ProvenanceInspectData,
  Issue,
} from '@vault/query-core';
export type InspectorTarget = {
  nodeId: string;
  title: string | null;
  path: string | null;
};
export type InspectionPage<S extends ProvenanceInspectData['select']> = Extract<
  ProvenanceInspectData,
  { select: S }
>;
export type ReadState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  readAt: string | null;
  warnings: Issue[];
};
export const emptyRead = <T>(): ReadState<T> => ({
  data: null,
  loading: false,
  error: null,
  stale: false,
  readAt: null,
  warnings: [],
});
export const comparisonLabels: Record<ProvenanceComparison, string> = {
  unchanged: 'Source unchanged since capture',
  changed: 'Source changed since capture',
  missing: 'Source no longer exists',
  unavailable: 'Source check unavailable',
  comparison_unknown: 'Source cannot be compared',
  expected_self_transition: 'Expected change during publication',
};
export const currentProvenanceLabels = {
  captured: 'Vault Engine has a saved record of how this note was created.',
  unknown_legacy: 'This note predates creation tracking, so its full history may not be available.',
  not_recorded: 'No creation record is available for this note.',
  unavailable: 'Creation history is temporarily unavailable.',
  unknown: 'Vault Engine cannot determine whether creation history is available.',
} as const;
export const dependencyCoverageLabels = {
  complete_direct: 'All recorded direct sources were checked.',
  direct_with_opaque_components: 'Some recorded inputs cannot be checked individually.',
  unknown: 'Vault Engine cannot tell how complete this source check is.',
} as const;
export const inputRoleLabels = {
  source_material: 'Source material',
  generated_context: 'Generated context',
  human_correction: 'Human correction',
  engine_projection: 'Vault data',
} as const;
