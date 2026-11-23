import type Database from 'better-sqlite3';
import { ok, type Issue } from '../mcp/tools/errors.js';
import {
  parseSummaryRequest,
  validateSummaryRequest,
} from '../summaries/input.js';
import { binaryCompare, projectLookup } from '../summaries/evaluate.js';
import {
  readIdentities,
  readSelectedFields,
} from '../summaries/read.js';
import { cyclicComponents } from './graph.js';
import {
  parseTraversalRequest,
  TraversalError,
  traversalCapacity,
  TRAVERSAL_LIMITS,
} from './input.js';
import { hasUnresolvedTraversalField, readTraversalEdges } from './read.js';
import type { TraversalData, TraversalEdge } from './types.js';
export function traverseNodes(
  db: Database.Database,
  input: unknown,
): ReturnType<typeof ok> {
  const request = parseTraversalRequest(input);
  return db
    .transaction(() => {
      const { definitions } = validateSummaryRequest(
        db,
        parseSummaryRequest({
          relations: [
            {
              as: 'traversal',
              field: request.field,
              direction: request.direction,
              lookup: { fields: request.include_fields },
            },
          ],
        }),
      );
      if (!db.prepare('SELECT 1 FROM nodes WHERE id=?').get(request.root_id))
        throw new TraversalError('NOT_FOUND', 'Traversal root not found.');
      const distances = new Map([[request.root_id, 0]]);
      let frontier = [request.root_id],
        rawCount = 0,
        unresolvedCount = 0;
      const edges = new Map<string, TraversalEdge>(),
        unresolvedSources = new Set<string>();
      for (
        let depth = 0;
        depth < request.max_depth && frontier.length;
        depth++
      ) {
        const raw = readTraversalEdges(
          db,
          frontier,
          request.field,
          request.direction,
          TRAVERSAL_LIMITS.relationships - rawCount,
        );
        rawCount += raw.length;
        const next: string[] = [];
        for (const edge of raw) {
          if (edge.target_id === null) {
            unresolvedCount++;
            unresolvedSources.add(edge.source_id);
            continue;
          }
          const id =
            request.direction === 'outgoing' ? edge.target_id : edge.source_id;
          if (!distances.has(id)) {
            if (distances.size === TRAVERSAL_LIMITS.nodes)
              traversalCapacity('nodes', distances.size + 1);
            distances.set(id, depth + 1);
            next.push(id);
          }
          const key = JSON.stringify([edge.source_id, edge.target_id]);
          if (!edges.has(key)) {
            if (edges.size === TRAVERSAL_LIMITS.edges)
              traversalCapacity('edges', edges.size + 1);
            edges.set(key, {
              source_id: edge.source_id,
              target_id: edge.target_id,
              field: request.field,
            });
          }
        }
        frontier = next.sort(binaryCompare);
      }
      const ids = [...distances.keys()],
        nodeSet = new Set(ids);
      const projections = projectLookup(
        nodeSet,
        readIdentities(db, ids),
        readSelectedFields(db, ids, request.include_fields),
        {
          fields: definitions[0].lookup!.fields,
          limit: ids.length,
        },
      );
      const nodes = projections.items
        .map((n) => ({ ...n, depth: distances.get(n.id)! }))
        .sort((a, b) => a.depth - b.depth || binaryCompare(a.id, b.id));
      const logicalEdges = [...edges.values()].sort(
        (a, b) =>
          binaryCompare(a.source_id, b.source_id) ||
          binaryCompare(a.target_id, b.target_id),
      );
      const boundary = nodes
        .filter((n) => n.depth === request.max_depth)
        .map((n) => n.id);
      const unresolved: TraversalData['unresolved'] =
        request.direction === 'outgoing'
          ? {
              scope: 'expanded_sources',
              raw_count: unresolvedCount,
              source_ids: [...unresolvedSources].sort(binaryCompare),
            }
          : {
              scope: 'vault_rel_type',
              exists: hasUnresolvedTraversalField(db, request.field),
            };
      const warnings: Issue[] = [];
      if (
        unresolved.scope === 'expanded_sources'
          ? unresolved.raw_count > 0
          : unresolved.exists
      )
        warnings.push({
          code: 'CROSS_NODE_FILTER_UNRESOLVED',
          severity: 'warning',
          message:
            'Unresolved references are excluded; the diagnostic scope is explicit.',
          details: { field: request.field, ...unresolved },
        });
      if (boundary.length)
        warnings.push({
          code: 'RESULT_TRUNCATED',
          severity: 'warning',
          message: 'Depth-boundary nodes were not expanded.',
          details: { reason: 'DEPTH_BOUNDARY', max_depth: request.max_depth },
        });
      const data: TraversalData = {
        kind: 'node_traversal',
        version: 1,
        root_id: request.root_id,
        field: request.field,
        direction: request.direction,
        max_depth: request.max_depth,
        nodes,
        edges: logicalEdges,
        cycles: {
          scope: 'returned_edges',
          components: cyclicComponents(ids, logicalEdges),
        },
        boundary: {
          depth_limited: boundary.length > 0,
          unexpanded_node_ids: boundary,
        },
        resolved_reachability_complete: boundary.length === 0,
        unresolved,
        stats: {
          returned_nodes: nodes.length,
          returned_edges: logicalEdges.length,
          raw_rows_examined: rawCount,
        },
        ...(request.include_fields.length
          ? { field_definitions: definitions[0].lookup!.fields }
          : {}),
      };
      const result = ok(data, warnings),
        bytes = Buffer.byteLength(result.content[0].text, 'utf8');
      if (bytes > TRAVERSAL_LIMITS.response_bytes)
        traversalCapacity('response_bytes', bytes);
      return result;
    })
    .deferred();
}
