import { buildReferenceWarnings } from '../../resolver/diagnostics.js';
import { buildReferenceCatalog, resolveRelationship } from '../../resolver/relationship-policy.js';
import { readReferencePolicyVersion } from '../../db/reference-policy-version.js';
import { TYPED_REFERENCE_EDGE_SQL } from '../../resolver/typed-refresh.js';
import { observeNode } from '../../provenance/observations.js';
import { createFieldMap } from '../../fields/field-map.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { nodeIdentityParamsError } from './resolve-identity.js';
import { projectFieldDetails, type FieldRow } from '../../fields/project.js';
import { readLinkCounts } from '../link-counts.js';
import { resolveTarget } from '../../resolver/resolve.js';
import { getNodeConformance } from '../../validation/conformance.js';
import type { ExtractionCache } from '../../extraction/cache.js';
import type { TranscriptStore } from '../../extraction/transcript-store.js';
import { assemble } from '../../extraction/assembler.js';
import { performExpansion } from '../expand.js';
import { readExplicitNullFields } from '../../fields/explicit-null.js';
import { MemoryService } from '../../memories/service.js';
import { memoriesBearingOn } from '../../memories/bearing.js';
import { textHashOf } from '../../notes/text-hash.js';

const paramsShape = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  include_provenance: z.boolean().optional(),
  include_memories: z.boolean().optional().describe('Add the memories that bear on this node: scoped to it or drawn from it, then those naming it as a subject, then its project\'s (see the description)'),
  include_embeds: z.boolean().optional().default(true),
  max_embeds: z.number().optional().default(20),
  expand: z.object({
    types: z.array(z.string()).min(1, 'types must be non-empty'),
    direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('outgoing'),
    max_nodes: z.number().int().min(1).max(25).optional().default(10),
  }).optional(),
};

interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
  body: string | null;
  content_hash: string | null;
  file_mtime: number | null;
  indexed_at: number | null;
  version: number;
}

interface RelRow {
  id: number;
  source_id: string;
  target: string;
  rel_type: string;
  context: string | null;
  resolved_target_id: string | null;
  required_type: string | null;
}

export function registerGetNode(
  server: McpServer,
  db: Database.Database,
  extractionCache?: ExtractionCache,
  vaultPath?: string,
  transcriptStore?: TranscriptStore,
): void {
  let memoryService: MemoryService | undefined;
  server.tool(
    'get-node',
    'Returns full details for a single node. Specify exactly one of: node_id, file_path, or title. Optional expand={types, direction?, max_nodes?} fetches one-hop neighbor nodes matching the given types, ranked by file_mtime DESC, capped at max_nodes (default 10, hard max 25). direction is "outgoing" (default), "incoming", or "both". When provided, the response includes expanded (map keyed by node_id with {id,title,types,fields,body}) and expand_stats ({returned,considered,truncated}). link_counts gives {incoming, outgoing, unresolved}: how many distinct notes link here, how many this node links to, and how many it links to that do not exist (the same counts query-nodes filters and sorts on). include_memories:true adds memories, the live memories that bear on this node: those scoped to it or drawn from it, then those that name it as a subject (a person\'s or a company\'s, from any note or chat), then the memory set of each project it is filed under, with preferences, corrections and rules first and newest first within each, up to about 6,000 characters (memory_stats gives {returned,considered,truncated}). Each names its source (evidence_kind, evidence_node_id or evidence_ref, created_at) and via ("node", "subject" or "project"); open the source before relying on a memory. list-memories with search_mode "semantic" finds memories by meaning.',
    paramsShape,
    async (params) => {
      const { node_id, file_path, title } = params;
      // Built on first use: a read without memories never touches the memory tables.
      memoryService ??= params.include_memories ? new MemoryService(db) : undefined;

      const identityError = nodeIdentityParamsError({ node_id, file_path, title });
      if (identityError) return fail('INVALID_PARAMS', identityError);

      // Finish the read snapshot before asynchronous attachment extraction.
      const readSnapshot = () => {
        let node: NodeRow | undefined;

        if (node_id) {
          node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node_id) as NodeRow | undefined;
        } else if (file_path) {
          node = db.prepare('SELECT * FROM nodes WHERE file_path = ?').get(file_path) as NodeRow | undefined;
        } else if (title) {
          // First try exact title match
          node = db.prepare('SELECT * FROM nodes WHERE title = ?').get(title) as NodeRow | undefined;
          if (!node) {
            // Fall back to four-tier path/basename resolution
            const resolved = resolveTarget(db, title);
            if (resolved) {
              node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(resolved.id) as NodeRow | undefined;
            }
          }
        }

        if (!node) {
          return null;
        }

        // Get types
        const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY rowid')
          .all(node.id) as Array<{ schema_type: string }>).map(t => t.schema_type);

        // Get fields
        const fieldRows = db.prepare('SELECT * FROM node_fields WHERE node_id = ?')
          .all(node.id) as FieldRow[];
        const fields = projectFieldDetails(fieldRows, readExplicitNullFields(db, node.id));

        // Get outgoing relationships
        const outgoing = db.prepare(`SELECT relationships.*, CASE WHEN ${TYPED_REFERENCE_EDGE_SQL}
          THEN (SELECT reference_target FROM global_fields WHERE name = relationships.rel_type) ELSE NULL END AS required_type
          FROM relationships WHERE source_id = ?`)
          .all(node.id) as RelRow[];

        // Get incoming relationships via resolved_target_id, populated by the
        // resolver (see src/resolver/refresh.ts). This catches links whose raw
        // target string only matches via case-insensitive / NFC-normalized
        // resolution and would otherwise be missed by literal target comparison.
        const incoming = db.prepare(
          'SELECT r.*, n.title as source_title FROM relationships r JOIN nodes n ON n.id = r.source_id WHERE r.resolved_target_id = ? AND r.source_id != ?'
        ).all(node.id, node.id) as Array<RelRow & { source_title: string | null }>;

        // Group outgoing
        const outgoingGrouped = createFieldMap<Array<{ target_id: string | null; target_title: string; context?: string }>>();
        for (const r of outgoing) {
          if (!outgoingGrouped[r.rel_type]) outgoingGrouped[r.rel_type] = [];
          const entry: { target_id: string | null; target_title: string; context?: string } = {
            target_id: r.resolved_target_id,
            target_title: r.target,
          };
          if (r.context) entry.context = r.context;
          outgoingGrouped[r.rel_type].push(entry);
        }

        // Group incoming
        const incomingGrouped = createFieldMap<Array<{ source_id: string; source_title: string | null; context?: string }>>();
        for (const r of incoming) {
          if (!incomingGrouped[r.rel_type]) incomingGrouped[r.rel_type] = [];
          const entry: { source_id: string; source_title: string | null; context?: string } = {
            source_id: r.source_id,
            source_title: r.source_title,
          };
          if (r.context) entry.context = r.context;
          incomingGrouped[r.rel_type].push(entry);
        }

        const resultObj: Record<string, unknown> = {
          id: node.id,
          file_path: node.file_path,
          title: node.title,
          version: node.version,
          types,
          fields,
          relationships: { outgoing: outgoingGrouped, incoming: incomingGrouped },
          link_counts: readLinkCounts(db, [node.id]).get(node.id) ?? { incoming: 0, outgoing: 0, unresolved: 0 },
          body: node.body,
          metadata: {
            content_hash: node.content_hash,
            text_hash: textHashOf(db, node.id),
            file_mtime: node.file_mtime,
            indexed_at: node.indexed_at,
          },
          conformance: getNodeConformance(db, node.id, types),
        };

        if (params.expand) {
          const { expanded, stats } = performExpansion(db, node.id, {
            types: params.expand.types,
            direction: params.expand.direction,
            max_nodes: params.expand.max_nodes,
          });
          resultObj.expanded = expanded;
          resultObj.expand_stats = stats;
        }

        if (params.include_provenance) resultObj.provenance_observation = observeNode(db, node.id);
        if (params.include_memories) Object.assign(resultObj, memoriesBearingOn(memoryService!, node.id));
        const catalog = outgoing.length ? buildReferenceCatalog(db) : null;
        const version = readReferencePolicyVersion(db);
        const warnings = buildReferenceWarnings(outgoing.map(row => {
          const request = { rawTarget: row.target, context: {
            origin: row.required_type !== null ? 'field' as const : 'orphan' as const,
            field: row.context === row.rel_type ? row.rel_type : null, requiredType: row.required_type,
          } };
          return { sourceId: node.id, storedTargetId: row.resolved_target_id, request,
            resolution: resolveRelationship(catalog!, request, version) };
        }));
        return { resultObj, nodeId: node.id, warnings };
      };
      const snapshot = db.transaction(readSnapshot).deferred();
      if (!snapshot) return fail('NOT_FOUND', 'Node not found');
      const { resultObj, nodeId, warnings } = snapshot;

      const includeEmbeds = params.include_embeds ?? true;
      const maxEmbeds = params.max_embeds ?? 20;

      if (includeEmbeds && extractionCache && vaultPath) {
        const assembled = await assemble(db, nodeId, extractionCache, vaultPath, {
          maxEmbeds,
        }, transcriptStore);
        resultObj.embeds = assembled.embeds;
        resultObj.embed_errors = assembled.errors;
      } else if (includeEmbeds) {
        // No cache configured — return empty embeds
        resultObj.embeds = [];
        resultObj.embed_errors = [];
      }

      return ok(resultObj, warnings);
    },
  );
}
