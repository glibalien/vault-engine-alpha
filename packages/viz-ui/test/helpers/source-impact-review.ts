import type {
  ProvenanceImpactData,
  ProvenanceImpactOutput,
} from '@vault/query-core';
import { output } from './provenance-inspector.js';

export const impactOutput = (
  revision = 'impact-output',
  node = 'generated-home',
  comparison: ProvenanceImpactOutput['inputs'][number]['comparison'] =
    'changed',
): ProvenanceImpactOutput => ({
  receipt: output(revision, node).receipt,
  currentness: 'matches',
  inputs: [
    {
      input_id: 'source-input',
      role: 'source_material',
      comparison,
      reason: comparison,
    },
  ],
  inputs_truncated: false,
  dependency_coverage: 'complete_direct',
});

export const impactPage = (
  outputs: ProvenanceImpactOutput[],
  next_cursor: string | null = null,
): ProvenanceImpactData => ({
  as_of: '2026-09-20T12:00:00Z',
  outputs,
  comparisons: next_cursor ? 1000 : outputs.length,
  next_cursor,
  truncated: next_cursor !== null,
  coverage: 'captured_direct_dependencies_only',
});
