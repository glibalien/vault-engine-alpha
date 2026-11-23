import { compareInput } from './compare.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { sourceKeySchema } from './validation.js';
import { ProvenanceError } from './limits.js';
import { decodeCursor, encodeCursor, OUTPUT_SELECT, outputSummary, requestScope, type InspectionOutputRow } from './inspect.js';
import type { ImpactData, ImpactRequest, InputRole } from './types.js';

export const impactSchema = z.object({ sources: z.array(sourceKeySchema).min(1).max(50),
  currentness: z.enum(['all', 'current', 'historical']).optional(),
  limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(4096).optional(),
}).strict();
type Candidate = { input_id: string; output_id: string; committed_at: string; derivation_id: string;
  role: InputRole | null; kind: string; namespace: string; native_id: string; observation_digest: string | null;
  expected_post_commit_observation: string | null; projection: string | null; authority: string | null; post_commit_observation: string | null; output_node_id: string;
  text_hash: string | null; label: string | null; path: string | null };

/** Direct recorded dependencies only. No new-source discovery, recursion or truth judgement. */
export function findAffectedOutputs(db: Database.Database, request: ImpactRequest): ImpactData {
  if (!impactSchema.safeParse(request).success) throw new ProvenanceError('PROVENANCE_LIMIT');
  return db.transaction(() => {
    const scope = requestScope({ sources: request.sources, currentness: request.currentness ?? 'all' });
    const cursor = decodeCursor(request.cursor, scope, 3);
    const sourceIds = request.sources.flatMap(source => {
      const row = db.prepare('SELECT id FROM provenance_sources WHERE namespace=? AND kind=? AND native_id=?').get(source.namespace, source.kind, source.native_id) as { id: string } | undefined;
      return row ? [row.id] : [];
    });
    const result: ImpactData = { as_of: new Date().toISOString(), outputs: [], comparisons: 0, next_cursor: null, truncated: false, coverage: 'captured_direct_dependencies_only' };
    if (sourceIds.length === 0) return result;
    const rows = db.prepare(`SELECT i.id AS input_id,out.id AS output_id,out.committed_at,out.derivation_id,i.role,
      s.kind,s.namespace,s.native_id,obs.expected_post_commit_observation,obs.observation_digest,obs.projection,obs.authority,obs.text_hash,obs.label,obs.path,out.post_commit_observation,out.node_id AS output_node_id
      FROM provenance_sources s JOIN provenance_observations obs ON obs.source_id=s.id
      JOIN provenance_inputs i ON i.observation_id=obs.id JOIN provenance_outputs out ON out.derivation_id=i.derivation_id
      JOIN provenance_derivations d ON d.id=out.derivation_id
      WHERE s.id IN (${sourceIds.map(() => '?').join(',')}) AND d.state='committed'
      ${cursor ? 'AND (out.committed_at,out.id,i.id)>(?,?,?)' : ''}
      ORDER BY out.committed_at,out.id,i.id LIMIT 1001`).all(...sourceIds, ...(cursor ?? [])) as Candidate[];
    const summaries = new Map<string, { row: InspectionOutputRow; summary: ReturnType<typeof outputSummary> }>();
    let last: Candidate | undefined;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (result.comparisons === 1000 || (result.outputs.length === (request.limit ?? 20) && result.outputs[result.outputs.length - 1].receipt.output_revision_id !== row.output_id)) break;
      result.comparisons++; last = row;
      const comparison = compareInput(db, row);
      if (comparison === 'unchanged' || comparison === 'expected_self_transition') continue;
      let metadata = summaries.get(row.output_id);
      if (!metadata) {
        const output = db.prepare(OUTPUT_SELECT + ' WHERE o.id=?').get(row.output_id) as InspectionOutputRow;
        metadata = { row: output, summary: outputSummary(db, output) }; summaries.set(row.output_id, metadata);
      }
      if ((request.currentness === 'current' && metadata.summary.currentness !== 'matches')
        || (request.currentness === 'historical' && metadata.summary.currentness === 'matches')) continue;
      let output = result.outputs.find(item => item.receipt.output_revision_id === row.output_id);
      if (!output) {
        output = { receipt: metadata.summary.receipt, currentness: metadata.summary.currentness, inputs: [], inputs_truncated: false, dependency_coverage: metadata.row.dependency_coverage ?? 'unknown' };
        result.outputs.push(output);
      }
      output.inputs.push({ input_id: row.input_id, role: row.role, comparison, reason: comparison });
    }
    if (last && result.comparisons < rows.length) {
      result.truncated = true;
      result.next_cursor = encodeCursor(scope, [last.committed_at, last.output_id, last.input_id]);
      const final = result.outputs[result.outputs.length - 1];
      if (final && rows[result.comparisons].output_id === final.receipt.output_revision_id) final.inputs_truncated = true;
    }
    return result;
  }).deferred();
}
