import { observeEvidenceNodes } from '../../provenance/observations.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { buildProjectEvidence, parseSinceMs } from '../../wiki/evidence.js';
import { ok, fail, type Issue } from './errors.js';
import { MemoryService } from '../../memories/service.js';
import { memoriesBearingOn } from '../../memories/bearing.js';

export function registerProjectEvidence(server: McpServer, db: Database.Database): void {
  let memoryService: MemoryService | undefined;
  server.tool(
    'project-evidence',
    'Read-only typed evidence for a project, bucketed by node type for wiki synthesis: task, note and signal buckets, contacts (people ranked by direct involvement + meeting frequency, with companies; `unlinked` lists names in the people field of the project or its meetings that reach no note, excluded from evidence_hash) and meetings (recent + upcoming, with attendees and dates). Use synthesis_hints.suggested_reads as a bounded get-node reading list before calling wiki-write with managed narrative sections. Optionally pass `since` (an ISO 8601 or epoch-ms timestamp, e.g. the wiki home\'s wiki_curated_at) to also get `changed_since_curation`: project nodes modified after that time, bucketed by type. Also returns `signals_detail` (blocked/overdue risk proxies + a chronological timeline of due-dated tasks and dated meetings) and `synthesis_hints.salience` (nodes ranked by a deterministic recency/link-degree/task-urgency score). All three are additive and excluded from evidence_hash. Returns evidence_hash, a deterministic fingerprint for change detection (excludes file_mtime, the time-windowed done_recent bucket, and wiki state, and keys every note filed under the project and each listed meeting on its text hash, with links read as the words they show, so it is stable across the curator\'s own writes, no-op re-renders and links added around words already in a note while still detecting genuine edits)). evidence_components carries one fingerprint per hash input (status, tasks, notes, meetings, contacts) so callers can tell which part changed. `windows` gives the date the task buckets were cut on (today in the curator tz setting, else the Engine host\'s zone) and the stale, upcoming and recent day counts from the wiki settings. include_memories:true adds memories and memory_stats as get-node gives them for the project note (its own memories, then its memory set, preferences and corrections first, up to about 6,000 characters; excluded from evidence_hash).',
    {
      project: z.string(),
      include_provenance: z.boolean().optional(),
      include_memories: z.boolean().optional().describe('Add the memories that bear on the project, as get-node include_memories gives them'),
      provenance_node_ids: z.array(z.string().min(1)).max(512).optional()
        .describe('When include_provenance is true, return observations for these represented nodes alongside a fresh, coherent evidence snapshot. Unrepresented IDs are omitted.'),
      meeting_recent_limit: z.number().int().min(0).max(100).default(12),
      meeting_upcoming_limit: z.number().int().min(0).max(100).default(8),
      contact_limit: z.number().int().min(0).max(100).default(25),
      since: z.string().optional().describe('ISO 8601 or epoch-ms timestamp (e.g. the wiki home\'s wiki_curated_at), or the literal \'auto\' to resolve the project wiki home\'s wiki_curated_at server-side; omit to skip the changed_since_curation delta'),
    },
    async (params) => {
      try {
        const warnings: Issue[] = [];
        if (params.since !== undefined && params.since !== 'auto' && parseSinceMs(params.since) === null) {
          warnings.push({
            code: 'CHANGED_SINCE_UNPARSEABLE',
            message: `Could not parse \`since\` value "${params.since}"; expected ISO 8601 or epoch-ms. changed_since_curation omitted.`,
            severity: 'warning',
          });
        }
        if (!params.include_provenance && !params.include_memories) return ok(buildProjectEvidence(db, params), warnings);
        if (params.include_memories) memoryService ??= new MemoryService(db);
        // One read snapshot for the evidence and what comes with it.
        const data = db.transaction(() => {
          const evidence = buildProjectEvidence(db, params);
          return {
            ...evidence,
            ...(params.include_memories ? memoriesBearingOn(memoryService!, evidence.project.id) : {}),
            ...(params.include_provenance
              ? { provenance_observations: observeEvidenceNodes(db, evidence, params.provenance_node_ids) }
              : {}),
          };
        }).deferred();
        if (data.provenance_observations?.truncated) warnings.push({
          code: 'RESULT_TRUNCATED', severity: 'warning', message: 'Source observation metadata covers only a selected subset of represented nodes (maximum 512).',
        });
        return ok(data, warnings);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'Project not found') return fail('NOT_FOUND', message);
        return fail('INTERNAL_ERROR', message);
      }
    },
  );
}
