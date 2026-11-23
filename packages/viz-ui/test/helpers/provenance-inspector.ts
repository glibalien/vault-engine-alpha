import type {
  CallFn,
  ProvenanceInspectData,
  ProvenanceOutputSummary,
} from '@vault/query-core';
export const env = (data: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify({ ok: true, data, warnings: [] }),
    },
  ],
});
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
export const output = (id = 'out', node = 'home'): ProvenanceOutputSummary => ({
  receipt: {
    derivation_id: 'derivation',
    output_revision_id: id,
    output_node_id: node,
    committed_node_version: 1,
    committed_at: '2026-09-19T00:00:00Z',
    operation_id: 'op',
    reconcile_key: 'reconcile',
    request_digest: 'digest',
  },
  availability: 'retained',
  currentness: 'matches',
});
export const status = (features = true): ProvenanceInspectData => ({
  select: 'status',
  capability_version: 1,
  vault_namespace: 'fixture',
  inspection_features: features
    ? ['output_input_comparisons_v1', 'input_text_v1']
    : undefined,
  limits: {},
  actual_bytes: 0,
  reserved_bytes: 0,
  purge_restore_verification: 'unverified',
});
export const inputPage = (
  id = 'out',
  node = 'home',
): ProvenanceInspectData => ({
  select: 'output',
  output: output(id, node),
  compared_at: '2026-09-19T00:00:00Z',
  inputs: [
    {
      id: 'input',
      source_id: 'source-id',
      source: { kind: 'node', namespace: 'fixture', native_id: 'source' },
      role: 'source_material',
      selection: 'formatted-node-body-prefix:v1',
      origin: 'identified',
      truncated: false,
      retained_bytes: 40,
      observation_digest: 'digest',
      observed_at: '2026-09-19T00:00:00Z',
      label: 'Source',
      path: 'Source.md',
      comparison: 'changed',
    },
  ],
  inputs_truncated: false,
  next_cursor: null,
  payloads: [],
  omissions: [],
  dependency_coverage: 'complete_direct',
});
export const defaultCall: CallFn = async ({ name, arguments: a }) => {
  if (name !== 'inspect-provenance') throw Error('Unexpected tool');
  if (a.select === 'status') return env(status());
  if (a.select === 'node')
    return env({
      select: 'node',
      outputs: [output('out', a.node_id as string)],
      current_provenance: 'captured',
      next_cursor: null,
    });
  if (a.select === 'output')
    return env(inputPage(a.output_revision_id as string));
  if (a.select === 'refresh_target')
    return env({
      select: 'refresh_target',
      eligible: true,
      reasons: [],
      vault_namespace: 'fixture',
      output_revision_id: a.output_revision_id,
      latest_output_revision_id: a.output_revision_id,
      project_id: 'project',
      project_title: 'Project',
      home_node_id: 'home',
      home_title: 'Home',
      home_path: 'Home.md',
      home_version: 1,
      topology_hash: 'topology',
      currentness: 'matches',
      availability: 'retained',
    });
  if (a.select === 'input_text')
    return env({
      select: 'input_text',
      output_revision_id: a.output_revision_id,
      input_id: a.input_id,
      availability: 'retained',
      input_digest: 'digest',
      segments: [
        {
          span_index: 0,
          field: 'evidence',
          span_start: 0,
          span_end: 40,
          start: 0,
          end: 40,
          text: '<img src=x onerror=alert(1)>',
        },
      ],
      next_cursor: a.cursor ? null : 'next',
    });
  throw Error('Unexpected selector');
};
