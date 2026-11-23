import { getWikiConfig } from '../wiki/config.js';
import { readInputText } from './input-text.js';
import { readHomeRefreshTarget } from './home-refresh.js';
import { compareInput, type ComparisonCandidate } from './compare.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { digestJson } from './canonical.js';
import { DEFAULT_PROVENANCE_LIMITS, ProvenanceError, type ProvenanceLimits } from './limits.js';
import { outputCurrentness, outputReceipt } from './output-binding.js';
import { ProvenanceService } from './service.js';
import { ProvenanceStore } from './store.js';
import type { Contribution, InputMetadata, InspectData, InspectRequest, Json, OutputSummary, PurgeReceipt } from './types.js';

const page = { limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(4096).optional() };
export const inspectSchema = z.discriminatedUnion('select', [
  z.object({ select: z.literal('refresh_target'), output_revision_id: z.string().min(1).max(512) }).strict(),
  z.object({ select: z.literal('input_text'), output_revision_id: z.string().max(512), input_id: z.string().max(512), cursor: page.cursor, max_bytes: z.number().int().min(4).max(65536).optional() }).strict(),
  z.object({ select: z.literal('status') }).strict(),
  z.object({ select: z.literal('attempt'), attempt_key: z.string().uuid(), flow: z.enum(['project-home-v1', 'project-subpage-v1']).optional() }).strict(),
  z.object({ select: z.literal('output'), output_revision_id: z.string().max(512), include_comparisons: z.boolean().optional(), ...page }).strict(),
  z.object({ select: z.literal('node'), node_id: z.string().max(512), ...page }).strict(),
  z.object({ select: z.literal('text'), payload_id: z.string().max(512), cursor: page.cursor, max_bytes: z.number().int().min(4).max(65536).optional() }).strict(),
  z.object({ select: z.literal('purge_receipts'), ...page }).strict(),
]);

export function encodeCursor(scope: string, position: string[]): string {
  return Buffer.from(JSON.stringify({ scope, position }), 'utf8').toString('base64url');
}
export function decodeCursor(cursor: string | undefined, scope: string, length: number): string[] | null {
  if (!cursor) return null;
  try {
    const value = z.object({ scope: z.literal(scope), position: z.array(z.string().max(512)).length(length) }).strict().parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return value.position;
  } catch { throw new ProvenanceError('PROVENANCE_LIMIT'); }
}

function decodeNodeCursor(nodeId: string, cursor: string | undefined): [number, string, string] | null {
  // Timestamp/ID cursors cannot continue safely under revision-first ordering.
  // Reject them through the normal invalid-cursor path; callers must restart.
  const position = decodeCursor(cursor, `node:${nodeId}`, 3);
  if (!position) return null;
  const version = Number(position[0]);
  if (!Number.isSafeInteger(version) || version < 0) throw new ProvenanceError('PROVENANCE_LIMIT');
  return [version, position[1]!, position[2]!];
}

export interface InspectionOutputRow {
  id: string; derivation_id: string; node_id: string; node_version: number; committed_at: string;
  operation_id: string; reconcile_key: string; request_digest: string | null; replay_result: string | null;
  omissions_json: string | null; post_commit_observation: string | null;
  availability: OutputSummary['availability']; dependency_coverage: 'complete_direct' | 'direct_with_opaque_components' | null;
}
export const OUTPUT_SELECT = `SELECT o.*,d.availability,d.dependency_coverage,d.omissions_json FROM provenance_outputs o
  JOIN provenance_derivations d ON d.id=o.derivation_id`;
export function outputSummary(db: Database.Database, row: InspectionOutputRow): OutputSummary {
  const retained = new ProvenanceStore(db).payload(row.derivation_id, 'contribution');
  return { receipt: outputReceipt(row), availability: row.availability,
    currentness: outputCurrentness(db, row.node_id, retained ? JSON.parse(retained) as Contribution : null) };
}

/**
 * Where an input begins in the request the model was sent: its first span's field and the
 * smallest start offset in that field. Inputs are stored under random ids, so this is how a
 * reader lists them in the order the model read them (#551). Null once spans are purged.
 */
export function inputPosition(spans: string | null): { field: string; start: number } | null {
  if (!spans) return null;
  try {
    const parsed = z.array(z.object({ field: z.string(), start: z.number().int().min(0) }).passthrough()).min(1).parse(JSON.parse(spans));
    const field = parsed[0]!.field;
    return { field, start: Math.min(...parsed.filter(span => span.field === field).map(span => span.start)) };
  } catch { return null; }
}

export function inspectProvenance(db: Database.Database, request: InspectRequest, limits: ProvenanceLimits = DEFAULT_PROVENANCE_LIMITS): InspectData {
  if (!inspectSchema.safeParse(request).success) throw new ProvenanceError('PROVENANCE_LIMIT');
  return db.transaction((): InspectData => {
    const store = new ProvenanceStore(db);
    switch (request.select) {
      case 'refresh_target': return readHomeRefreshTarget(db, request.output_revision_id);
      case 'input_text': return readInputText(db, request);
      case 'status': {
        const size = db.prepare('SELECT COALESCE(SUM(payload_bytes),0) AS actual_bytes,COALESCE(SUM(reserved_remaining_bytes),0) AS reserved_bytes FROM provenance_derivations').get() as { actual_bytes: number; reserved_bytes: number };
        return { select: 'status', capability_version: 1, capture_features: ['project-subpage-v1', 'multi-output-reconcile-v1'], inspection_features: ['output_input_comparisons_v1', 'input_text_v1', 'selective_home_refresh_v1', 'selective_page_refresh_v1'], vault_namespace: store.namespace(), limits: { ...limits }, ...size, purge_restore_verification: 'unverified' };
      }
      case 'attempt': return { select: 'attempt', attempt: new ProvenanceService(db).lookupAttempt(request.attempt_key, request.flow) };
      case 'text': {
        const row = db.prepare(`SELECT p.text,p.digest,d.availability FROM provenance_payloads p
          JOIN provenance_derivations d ON d.id=p.derivation_id WHERE p.id=?`).get(request.payload_id) as
          { text: string | null; digest: string | null; availability: OutputSummary['availability'] } | undefined;
        if (!row) throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
        if (row.availability !== 'retained' || row.text === null) {
          if (request.cursor) throw new ProvenanceError('PROVENANCE_REVOKED');
          return { select: 'text', payload_id: request.payload_id, availability: row.availability, text: null, digest: null, start: 0, end: 0, next_cursor: null };
        }
        const scope = `${request.payload_id}:${row.digest}`;
        const decoded = decodeCursor(request.cursor, scope, 1);
        const start = decoded ? Number(decoded[0]) : 0;
        const bytes = Buffer.from(row.text, 'utf8');
        if (!Number.isSafeInteger(start) || start < 0 || start > bytes.length || (start < bytes.length && (bytes[start] & 0xc0) === 0x80)) throw new ProvenanceError('PROVENANCE_LIMIT');
        let end = Math.min(bytes.length, start + (request.max_bytes ?? 65536));
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        return { select: 'text', payload_id: request.payload_id, availability: row.availability,
          text: bytes.subarray(start, end).toString('utf8'), digest: row.digest, start, end,
          next_cursor: end < bytes.length ? encodeCursor(scope, [String(end)]) : null };
      }
      case 'output': {
        const row = db.prepare(OUTPUT_SELECT + ' WHERE o.id=?').get(request.output_revision_id) as InspectionOutputRow | undefined;
        if (!row) throw new ProvenanceError('PROVENANCE_UNAVAILABLE');
        const limit = request.limit ?? 20; const scope = request.include_comparisons ? `inputs:comparisons-v1:${row.id}` : `inputs:${row.id}`;
        const last = decodeCursor(request.cursor, scope, 1)?.[0] ?? '';
        const rows = db.prepare(`SELECT i.id,o.source_id,s.kind,s.namespace,s.native_id,i.role,i.selection,i.coverage AS origin,
          i.truncated,i.retained_bytes,i.spans,o.observation_digest,o.observed_at,o.label,o.path,o.projection,o.authority,o.expected_post_commit_observation,o.text_hash FROM provenance_inputs i
          LEFT JOIN provenance_observations o ON o.id=i.observation_id LEFT JOIN provenance_sources s ON s.id=o.source_id
          WHERE i.derivation_id=? AND i.id>? ORDER BY i.id LIMIT ?`).all(row.derivation_id, last, limit + 1) as Array<Omit<InputMetadata, 'position'> & Pick<ComparisonCandidate, 'projection' | 'authority' | 'expected_post_commit_observation'> & { text_hash: string | null; kind: string | null; namespace: string; native_id: string; spans: string | null }>;
        const inputs = rows.slice(0, limit).map(({ kind, namespace, native_id, projection, authority, expected_post_commit_observation, text_hash, spans, ...item }) => ({ ...item,
          position: inputPosition(spans),
          ...(request.include_comparisons ? { comparison: compareInput(db, { kind, namespace, native_id, projection, authority, expected_post_commit_observation, observation_digest: item.observation_digest, post_commit_observation: row.post_commit_observation, output_node_id: row.node_id, text_hash, label: item.label, path: item.path }) } : {}),
          truncated: item.truncated === null ? null : Boolean(item.truncated),
          source: kind === null ? null : { kind, namespace, native_id },
        })) as InputMetadata[];
        const payloads = db.prepare('SELECT id,kind,bytes,digest,? AS availability FROM provenance_payloads WHERE derivation_id=? ORDER BY kind').all(row.availability, row.derivation_id) as Extract<InspectData, { select: 'output' }>['payloads'];
        return { select: 'output', ...(request.include_comparisons ? { compared_at: new Date().toISOString() } : {}), output: outputSummary(db, row), inputs, inputs_truncated: rows.length > limit,
          next_cursor: rows.length > limit ? encodeCursor(scope, [inputs[inputs.length - 1].id]) : null,
          payloads, omissions: row.omissions_json ? JSON.parse(row.omissions_json) : [], dependency_coverage: row.dependency_coverage ?? 'unknown' };
      }
      case 'node': {
        const limit = request.limit ?? 20; const scope = `node:${request.node_id}`;
        const cursor = decodeNodeCursor(request.node_id, request.cursor);
        const rows = db.prepare(OUTPUT_SELECT + ` WHERE o.node_id=? ${cursor ? 'AND (o.node_version,o.committed_at,o.id)<(?,?,?)' : ''}
          ORDER BY o.node_version DESC,o.committed_at DESC,o.id DESC LIMIT ?`).all(request.node_id, ...(cursor ?? []), limit + 1) as InspectionOutputRow[];
        const outputs = rows.slice(0, limit).map(row => outputSummary(db, row));
        // Classify current content independently of the requested history page.
        const latest = db.prepare(OUTPUT_SELECT + ` WHERE o.node_id=?
          ORDER BY o.node_version DESC,o.committed_at DESC,o.id DESC LIMIT 1`).get(request.node_id) as InspectionOutputRow | undefined;
        const current = latest ? outputSummary(db, latest).currentness : null;
        const last = rows[limit - 1];
        // Only a known creation after this project's first capture proves a new
        // unrecorded output. Unknown creation/history remains explicitly legacy.
        const config = getWikiConfig(db);
        const unrecorded = !latest && db.prepare(`SELECT 1 FROM nodes n
          JOIN node_types wt ON wt.node_id=n.id AND wt.schema_type=?
          JOIN relationships r ON r.source_id=n.id AND r.rel_type='wiki_for'
          JOIN node_types pt ON pt.node_id=r.resolved_target_id AND pt.schema_type=?
          JOIN provenance_flow_activations a ON a.project_id=r.resolved_target_id
            AND a.flow=CASE WHEN EXISTS (SELECT 1 FROM relationships p WHERE p.source_id=n.id AND p.rel_type='wiki_parent')
              THEN 'project-subpage-v1' ELSE 'project-home-v1' END
          WHERE n.id=? AND n.created_at IS NOT NULL AND n.created_at >
            CAST(strftime('%s',a.first_committed_at) AS INTEGER)*1000 + CAST(substr(strftime('%f',a.first_committed_at),4,3) AS INTEGER)
          LIMIT 1`).get(config.wikiType, config.projectType, request.node_id);
        return { select: 'node', outputs, current_provenance: latest && latest.availability !== 'retained' ? 'unavailable' : current === 'matches' ? 'captured'
          : current === 'changed' || current === 'missing' ? 'not_recorded' : current === 'unknown' ? 'unknown' : unrecorded ? 'not_recorded' : 'unknown_legacy',
          next_cursor: rows.length > limit ? encodeCursor(scope, [String(last.node_version), last.committed_at, last.id]) : null };
      }
      case 'purge_receipts': {
        const limit = request.limit ?? 20; const scope = 'purge_receipts'; const cursor = decodeCursor(request.cursor, scope, 2);
        const rows = db.prepare(`SELECT * FROM provenance_purge_receipts ${cursor ? 'WHERE (committed_at,id)>(?,?)' : ''} ORDER BY committed_at,id LIMIT ?`).all(...(cursor ?? []), limit + 1) as Array<Omit<PurgeReceipt, 'source_ids' | 'derivation_ids'> & { source_ids: string; derivation_ids: string }>;
        const last = rows[limit - 1];
        return { select: 'purge_receipts', receipts: rows.slice(0, limit).map(row => ({ ...row, source_ids: JSON.parse(row.source_ids), derivation_ids: JSON.parse(row.derivation_ids) })), next_cursor: rows.length > limit ? encodeCursor(scope, [last.committed_at, last.id]) : null };
      }
    }
  }).deferred();
}

export function requestScope(value: unknown): string { return digestJson(value as Json); }
