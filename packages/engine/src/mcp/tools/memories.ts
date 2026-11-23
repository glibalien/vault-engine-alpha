import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail, type Issue } from './errors.js';
import { evidenceSchema, type MemoryEvidence } from './memory-evidence.js';
import { MemoryService, MEMORY_NEAR_DUP, MEMORY_UNRELATED, MEMORY_SEARCH_MAX_DISTANCE } from '../../memories/service.js';
import { CONSOLIDATION_PURPOSES, type CreateMemoryArgs, type MemoryWarning } from '../../memories/types.js';
import { MAX_SUBJECTS } from '../../memories/subjects.js';
import { backfillMemorySubjects, clearMatchedSubjects } from '../../memories/subject-backfill.js';
import { backfillMemoryDates, undoMemoryDates } from '../../memories/date-backfill.js';
import { SUBJECT_PASS_LIMITS, clearModelSubjects, listSubjectPassMemories, writeModelSubjects } from '../../memories/subject-pass.js';
import { ConsolidationReplay, ConsolidationReplayRefusal, REPLAY_MAX_LIMIT } from '../../memories/consolidation-replay.js';
import { USAGE_SERVICES } from '../../usage/recorder.js';
import { chatClientEditor, toolCaller, type ToolCaller } from '../../auth/client-label.js';

// Re-export the canonical constants + tiering for backwards-compat with
// existing test imports (`decideTier`, `MEMORY_NEAR_DUP`, … from this module).
export {
  MEMORY_NEAR_DUP,
  MEMORY_UNRELATED,
  MEMORY_RECONCILE_REPORT_FAR,
  MEMORY_DEDUP_K,
  decideTier,
  type TierDecision,
} from '../../memories/service.js';

/**
 * Sources the suite's own writers own (#300): `curator` (the Curator service) and `owner`
 * (Settings/Memories.md, ingested in-process). Dedup and consolidation compare only within
 * one source, and wiki prompts give owner memories their own uncut section, so an
 * OAuth-flow client (claude.ai, Claude Code) may not claim them. Service-token and
 * unauthenticated local callers are trusted, the same split as the tool surface
 * (`toolSurfaceFor` in src/transport/http.ts).
 */
export const RESERVED_MEMORY_SOURCES: readonly string[] = ['curator', 'owner'];

export function reservedSourceRefusal(source: string, caller: ToolCaller | string | undefined): string | null {
  if (!RESERVED_MEMORY_SOURCES.includes(source)) return null;
  // A chat client: one that signed in, or a host's chat model (see chatClientEditor).
  if (chatClientEditor(caller) === undefined) return null;
  return `source "${source}" is reserved for the suite's own services — use your client's name (for example "claude" or "chat") as the source`;
}

function semanticUnavailable(why: string): Issue {
  return {
    code: 'SEMANTIC_SEARCH_UNAVAILABLE',
    severity: 'warning',
    message: `search_mode "semantic" fell back to full-text search: ${why}. Full text needs the memory's own words.`,
  };
}

/** A memory's subjects as a caller gives them (#554). */
const subjectsSchema = z.array(z.string().min(1).max(500)).max(MAX_SUBJECTS);

function toIssues(warnings: MemoryWarning[]): Issue[] {
  return warnings as Issue[];
}

function envelope<T>(result: { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }, warnings: MemoryWarning[]) {
  if (result.ok) return ok(result.data, toIssues(warnings));
  return fail(result.error.code as Parameters<typeof fail>[0], result.error.message, result.error.details ? { details: result.error.details } : undefined);
}

/**
 * Durable Memories — the CRUD and search MCP tools over the `memories` table.
 *
 * Row serialization, versioning, dedup, embedding, and expiry live in the
 * shared {@link MemoryService} (`src/memories/service.ts`); these handlers are
 * thin envelope wrappers that preserve the public tool names, Zod schemas,
 * descriptions, envelope shapes, warnings, and error messages byte-compatible
 * with the pre-extraction behavior. The service is also the ingest path for
 * the editable `Settings/Memories.md` projection (Task 4).
 *
 * One production `MemoryService` is constructed in `src/index.ts` and shared
 * across every MCP session + the note ingest path; tests construct their own
 * per-DB instance via `makeMemoriesServer`.
 *
 * A chat client that signed in through the OAuth flow may update, retire, reactivate and
 * purge any memory, the reserved `owner` and `curator` sources included: the owner corrects
 * memories from a chat client. What it writes is marked with the client (`changed_by`), so
 * the source label does not claim the edit (#532). `editorLabel` names the client.
 */
export function registerMemoriesTools(
  server: McpServer,
  service: MemoryService,
  opts: { editorLabel?: (clientId: string) => string } = {},
): void {
  const editor = (extra: Parameters<typeof toolCaller>[0]): string | undefined =>
    chatClientEditor(toolCaller(extra), opts.editorLabel);

  // -------------------------------------------------------------------------
  // create-memory
  // -------------------------------------------------------------------------
  server.tool(
    'create-memory',
    'Create a new memory record. Auto-rejects near-duplicates using vector/FTS dedup within the same source.',
    {
      source: z.string().describe('Client source tag, e.g. "chat" or your client\'s name. "curator" and "owner" are reserved for the suite\'s own services.'),
      content: z.string().max(10000).describe('Memory content (10k char max, concise)'),
      scope: z.enum(['vault', 'node']).default('vault').describe('Scope: "vault" = global, "node" = project/topic-specific'),
      node_id: z.string().optional().describe('Required when scope="node". FK to nodes.id.'),
      category: z.string().optional().describe('Lightweight taxonomy: "preference", "rule" (a rule on what may or may not be said, shared or claimed), "action", "correction", "request", "fact", "note"'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Arbitrary JSON metadata blob'),
      dedup_threshold: z.number().min(0).max(1).optional().describe('Cosine distance threshold for dedup (0-1, default 0.06). Lower = stricter match.'),
      evidence: evidenceSchema.optional().describe('REQUIRED provenance: what this memory was created from. kind "note" needs node_id+hash; "conversation"/"curation-run" need ref. Chat/curator clients stamp this automatically — other MCP callers must supply it explicitly.'),
      subjects: subjectsSchema.optional().describe('Who or what the memory is about: the titles, aliases or [[links]] of notes of the kinds the vault map lists in entityTypes (people, companies, projects by default), or their note ids. A name no such note answers to yet is kept and matched once one does; a name several notes answer to links to none of them.'),
      usage: z.object({
        service: z.enum(USAGE_SERVICES),
        run_ref: z.string().optional(),
        source_ref: z.string().optional(),
        conversation_id: z.string().optional(),
        purpose: z.enum(CONSOLIDATION_PURPOSES).optional(),
      }).optional().describe('Spend attribution for the dedup model call, stamped by the suite\'s own services. Omit it.'),
    },
    async (params, extra) => {
      const reserved = reservedSourceRefusal(params.source, toolCaller(extra));
      if (reserved) return fail('INVALID_PARAMS', reserved);
      const { result, warnings } = await service.create(params as CreateMemoryArgs);
      return envelope(result, warnings);
    },
  );

  // -------------------------------------------------------------------------
  // update-memory
  // -------------------------------------------------------------------------
  server.tool(
    'update-memory',
    'Update a memory. Content changes mint a new versioned row and supersede the old one (lineage-preserving); category, metadata and subjects changes update in place. The memory keeps its source; a change made by a signed-in chat client is recorded on the memory as changed_by.',
    {
      id: z.number().int().positive(),
      content: z.string().max(10000).optional(),
      category: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      subjects: subjectsSchema.optional().describe('Who or what the memory is about, replacing its subjects ([] removes them all): note titles, aliases, [[links]] or note ids, as for create-memory. To pick one of several notes that answer to a name, give its title or vault path.'),
      evidence: evidenceSchema.optional().describe('Provenance for a content update — REQUIRED when content changes (attaches to the new version). Ignored when content is identical (no-op updates keep the original provenance).'),
    },
    async (params, extra) => {
      const { result, warnings } = await service.update({
        ...(params as { id: number; content?: string; category?: string; metadata?: Record<string, unknown>; evidence?: MemoryEvidence; subjects?: string[] }),
        changed_by: editor(extra),
      });
      return envelope(result, warnings);
    },
  );

  // -------------------------------------------------------------------------
  // expire-memory
  // -------------------------------------------------------------------------
  server.tool(
    'expire-memory',
    'Retire a memory without deleting it (sets expired_at; history and lineage kept); reason "deleted" is a soft delete. Optionally link the live memory that supersedes it. reactivate:true un-retires an expired memory. purge:true + confirm:true instead permanently deletes the row and its vector; that cannot be undone.',
    {
      id: z.number().int().positive(),
      reason: z.string().min(1).optional().describe('Why. Required unless purge:true. Well-known values: contradicted, evidence-changed, source-deleted, deleted, superseded-by-update; free text allowed.'),
      superseded_by: z.number().int().positive().optional().describe('Existing LIVE memory that replaces this one'),
      invalid_at: z.string().optional().describe('ISO timestamp when the fact stopped being true in the real world'),
      reactivate: z.boolean().default(false).describe('Clear expiry state instead of setting it'),
      purge: z.boolean().default(false).describe('Permanently delete the row and its vector instead of retiring it'),
      confirm: z.boolean().default(false).describe('Required alongside purge:true'),
      unless_subjects_apart: z.boolean().optional().describe('With superseded_by: refuse, changing nothing, when the two memories are about different things of one kind (different companies, say), as near-pairs\' subjects_apart says'),
    },
    async (params, extra) => {
      if (params.purge) {
        if (params.reactivate || params.superseded_by !== undefined || params.invalid_at !== undefined) {
          return fail('INVALID_PARAMS', 'purge cannot be combined with reactivate, superseded_by or invalid_at');
        }
        const { result, warnings } = await service.delete({ id: params.id, purge: true, confirm: params.confirm, changed_by: editor(extra) });
        return envelope(result, warnings);
      }
      if (params.reason === undefined) return fail('INVALID_PARAMS', 'reason is required unless purge:true');
      const { result, warnings } = await service.expire({
        id: params.id,
        reason: params.reason,
        superseded_by: params.superseded_by,
        invalid_at: params.invalid_at,
        reactivate: params.reactivate,
        unless_subjects_apart: params.unless_subjects_apart,
        changed_by: editor(extra),
      });
      return envelope(result, warnings);
    },
  );

  // -------------------------------------------------------------------------
  // backfill-memory-subjects (#554, slice 2)
  // -------------------------------------------------------------------------
  server.tool(
    'backfill-memory-subjects',
    'Give the memories that have no subjects the people, companies and projects they name, with no model: each note of an entity kind (the vault map\'s entityTypes, else its person, company and project kinds) whose title or alias appears in the memory\'s text, a one-word name only when the memory\'s source note links that note, plus the source note itself when it is such a note. A name several notes answer to is skipped, and your own note (the vault map\'s ownerNote) is never added. Memories that already have subjects are left alone. Previews by default (dry_run true): how many memories get subjects, the notes named most, and samples. What it writes is marked set_by "match"; clear: true takes all of that back out.',
    {
      dry_run: z.boolean().default(true).describe('Preview without writing (default). Pass false to write.'),
      clear: z.boolean().default(false).describe('Take out every subject the backfill wrote (set_by "match") instead of adding any.'),
      samples: z.number().int().min(0).max(50).default(10).describe('How many memories to show with their subjects.'),
    },
    async (params, extra) => {
      try {
        // A chat client's changes are marked on the memories, as the other memory tools do (#532).
        const changedBy = editor(extra);
        const data = params.clear
          ? clearMatchedSubjects(service.database, { dryRun: params.dry_run, changedBy })
          : backfillMemorySubjects(service.database, { dryRun: params.dry_run, samples: params.samples, changedBy });
        return ok(data);
      } catch (e) {
        return fail('INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // backfill-memory-dates (#706)
  // -------------------------------------------------------------------------
  server.tool(
    'backfill-memory-dates',
    'Date the memories drawn from notes by their notes, as new ones are: each live memory whose source note has a readable date (its date field, else the last date in its title) gets that day as valid_at, so a fact from an old note no longer lists as new. A date the merge check gave (one that differs from when the memory was written) is kept, unless it is later than the note\'s day. Memories from chats, and notes with no date, are left as they are. Previews by default (dry_run true): how many memories change, and samples with the old and new date. Each change is kept in the memory\'s history; undo: true puts back the old dates on the memories nothing has changed since.',
    {
      dry_run: z.boolean().default(true).describe('Preview without writing (default). Pass false to write.'),
      undo: z.boolean().default(false).describe('Put back the dates the backfill replaced instead of dating any.'),
      samples: z.number().int().min(0).max(50).default(10).describe('How many changed memories to show.'),
    },
    async (params, extra) => {
      try {
        // A chat client's changes are marked on the memories, as the other memory tools do (#532).
        const changedBy = editor(extra);
        const data = params.undo
          ? undoMemoryDates(service.database, { dryRun: params.dry_run, changedBy })
          : backfillMemoryDates(service.database, { dryRun: params.dry_run, samples: params.samples, changedBy });
        return ok(data);
      } catch (e) {
        return fail('INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // memory-subject-pass (#554, slice 2; service-only)
  // -------------------------------------------------------------------------
  server.tool(
    'memory-subject-pass',
    'For the Curator\'s model pass over memories with no subjects but the free match\'s (backfill-memory-subjects). list: those live memories, in id order after after_id, each with the subjects it has, its source note\'s title and the people, companies and projects that note is or links to. write: add the names in items to memories that still have no subjects but the free match\'s, resolved as create-memory resolves subjects and marked set_by "model"; a name the memory has already is skipped (dry_run previews how each resolves). clear: take back out the subjects of the writes named (each a memory_id and the written_at its write returned); later writes and subjects set any other way stay.',
    {
      action: z.enum(['list', 'write', 'clear']),
      after_id: z.number().int().min(0).optional().describe('list: only memories with a greater id.'),
      limit: z.number().int().min(1).max(SUBJECT_PASS_LIMITS.maxPage).optional().describe(`list: memories per page (default ${SUBJECT_PASS_LIMITS.page}).`),
      items: z.array(z.object({
        memory_id: z.number().int().positive(),
        subjects: z.array(z.string()).max(MAX_SUBJECTS),
      })).max(SUBJECT_PASS_LIMITS.maxItems).optional().describe('write: each memory and the names it is about.'),
      writes: z.array(z.object({
        memory_id: z.number().int().positive(),
        written_at: z.string().min(1),
      })).max(SUBJECT_PASS_LIMITS.maxItems).optional().describe('clear: the writes to take back, as write returned them.'),
      dry_run: z.boolean().default(false).describe('write and clear: report without writing.'),
    },
    async (params, extra) => {
      try {
        const changedBy = editor(extra);
        switch (params.action) {
          case 'list':
            return ok(listSubjectPassMemories(service.database, { afterId: params.after_id, limit: params.limit }));
          case 'write':
            if (params.items === undefined) return fail('INVALID_PARAMS', 'write takes items.');
            return ok({ dry_run: params.dry_run, ...writeModelSubjects(service.database, params.items, { dryRun: params.dry_run, changedBy }) });
          case 'clear':
            if (params.writes === undefined) return fail('INVALID_PARAMS', 'clear takes writes.');
            return ok({ dry_run: params.dry_run, ...clearModelSubjects(service.database, params.writes, { dryRun: params.dry_run, changedBy }) });
        }
      } catch (e) {
        return fail('INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // get-memory
  // -------------------------------------------------------------------------
  server.tool(
    'get-memory',
    'Get a single memory by ID, with its subjects (the notes it is about). include_lineage adds its versions (content changes); include_history adds its in-place changes (reactivations with the expiry they cleared, category, metadata and subject edits with the values they replaced).',
    {
      id: z.number().int().positive(),
      include_lineage: z.boolean().default(false),
      include_history: z.boolean().default(false),
    },
    async (params) => {
      const res = service.get(params as { id: number; include_lineage?: boolean; include_history?: boolean });
      return envelope(res, []);
    },
  );

  // -------------------------------------------------------------------------
  // list-memories
  // -------------------------------------------------------------------------
  server.tool(
    'list-memories',
    'List or search memories with optional filters. Pass query to rank FTS5 matches over content and category (use it before creating a memory to check for similar ones); omit it to list newest first, by when each became true (valid_at: for a note memory, its note\'s day). With search_mode "semantic", query is plain words and memories rank by closeness of meaning instead, so they are found without their exact wording; each carries distance (cosine, lower is closer), memories farther than max_distance are left out, so a topic with no memories returns none, and memories without an embedding are left out too. Every filter applies in each mode. get-node include_memories gives the memories that bear on a note. Useful for injecting into AI context.',
    {
      query: z.string().min(1).optional().describe('FTS5 query string; results rank by relevance. With search_mode "semantic", the words to compare memories with'),
      search_mode: z.enum(['fts', 'semantic']).default('fts').describe('"fts" (default): full-text match. "semantic": rank by meaning; needs query'),
      max_distance: z.number().min(0).max(2).optional().describe(`search_mode "semantic" only: leave out memories farther than this cosine distance (default ${MEMORY_SEARCH_MAX_DISTANCE}; a memory a question is about is usually under 0.35; 2 keeps every memory)`),
      include_provenance: z.boolean().optional(),
      source: z.string().optional(),
      scope: z.enum(['vault', 'node']).optional(),
      node_id: z.string().optional(),
      category: z.string().optional(),
      evidence_kind: z.string().optional(),
      evidence_node_id: z.string().optional(),
      evidence_node_ids: z.array(z.string()).max(200).optional().describe('Memories drawn from any of these notes'),
      ids: z.array(z.number().int().positive()).max(200).optional().describe('Only these memories, by id (live ones, unless include_superseded)'),
      project_of: z.string().optional().describe('A node id: the memories of the project(s) this node is filed under, or of the node itself when it is a project. A note is filed under every project it links to, from a field or its body, as for project wiki evidence. They are the memories drawn from the project\'s note or from notes filed under it. A node filed under no project matches nothing. Listed most specific first: memories from the project\'s own note, then from notes filed under the fewest projects, then newest.'),
      subject_of: z.string().optional().describe('A node id: the memories about that note, by a subject linked to it or a name that now resolves to it alone. Add include_superseded for their earlier versions too.'),
      evidence_ref: z.string().optional().describe('Exact evidence ref'),
      evidence_conversation: z.string().optional().describe('Memories drawn from this conversation id, in either ref format (bare id or <id>#<message>)'),
      include_superseded: z.boolean().default(false),
      expire_reasons: z.array(z.string().min(1)).min(1).max(10).optional().describe('Only memories expired for one of these reasons, none of them live: "contradicted" (a newer memory said the fact changed), "superseded-by-update" (a newer one restated it, or it was edited), "duplicate-of:<id>", "deleted". With subject_of, the earlier facts about a note.'),
      as_of: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    },
    async ({ search_mode, max_distance: maxDistance, ...params }) => {
      const warnings: Issue[] = [];
      let queryVector: Float32Array | undefined;
      if (search_mode === 'semantic') {
        if (params.query === undefined) return fail('INVALID_PARAMS', 'search_mode "semantic" needs a query: the words to compare memories with');
        // Without a working embedder the search still answers, from the full text, and says so.
        try {
          queryVector = (await service.embedSearchQuery(params.query)) ?? undefined;
          if (queryVector === undefined) warnings.push(semanticUnavailable('no embedder is available'));
        } catch (e) {
          warnings.push(semanticUnavailable(`the embedder failed: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
      const res = params.include_provenance
        ? service.listWithProvenance(params, { queryVector, maxDistance })
        : service.list(params, { queryVector, maxDistance });
      if (!res.ok) {
        return fail(res.error.code as Parameters<typeof fail>[0], res.error.message, {
          ...(res.error.details ? { details: res.error.details } : {}), warnings,
        });
      }
      return ok(res.data, warnings);
    },
  );

  // -------------------------------------------------------------------------
  // list-memory-near-pairs
  // -------------------------------------------------------------------------
  server.tool(
    'list-memory-near-pairs',
    'List pairs of LIVE memories whose embeddings fall in the dedup gray band (default cosine distance 0.06-0.35), across sources and scopes — reconciliation/audit candidates, distance ascending. Each member carries note_date: when its source note was written, or null without a dated note. subjects_apart is true when the two are about different things of the same kind (each has a linked subject of one kind, the vault owner\'s own companies left out, and they share none): such a pair is never merged.',
    {
      near: z.number().min(0).max(1).default(MEMORY_NEAR_DUP),
      far: z.number().min(0).max(1).default(MEMORY_UNRELATED),
      limit: z.number().int().min(1).max(500).default(200),
    },
    async (params) => {
      const { result, warnings } = service.nearPairs(params as { near: number; far: number; limit: number });
      return envelope(result, warnings);
    },
  );

  // -------------------------------------------------------------------------
  // replay-memory-consolidation (#346)
  // -------------------------------------------------------------------------
  server.tool(
    'replay-memory-consolidation',
    'Re-run create-memory\'s merge decision for live memories added without it — those flagged after a failed consolidation call (pending), or those created in a time window — in id order against older memories, and apply the verdicts: a repeat is expired as duplicate-of its neighbour; an update or contradiction expires the older memory, unless this memory comes from an earlier-dated note, or for a contradiction one of the same date (both stay). Runs in the background: action "start" (dry_run defaults to true and changes nothing, but its model calls are paid), "status", "stop". Resume a stopped run with after_id = its last_id.',
    {
      action: z.enum(['start', 'status', 'stop']).default('status'),
      dry_run: z.boolean().default(true).describe('start only: report verdicts without applying them'),
      pending: z.boolean().optional().describe('Select memories flagged after a failed consolidation call. Default: true unless a window is given.'),
      created_since: z.string().optional().describe('Select memories created at or after this ISO time'),
      created_until: z.string().optional().describe('Select memories created before this ISO time'),
      source: z.string().optional().describe('Only memories of this source'),
      after_id: z.number().int().min(0).optional().describe('Only memories with a higher id (resume cursor)'),
      limit: z.number().int().min(1).max(REPLAY_MAX_LIMIT).default(1000).describe('Most memories to replay'),
    },
    async (params) => {
      const replay = ConsolidationReplay.for(service);
      if (params.action === 'status') return ok(replay.status());
      if (params.action === 'stop') return ok(replay.stop());
      const window: { created_since?: string; created_until?: string } = {};
      for (const key of ['created_since', 'created_until'] as const) {
        const value = params[key];
        if (value === undefined) continue;
        const ms = Date.parse(value);
        if (!Number.isFinite(ms)) return fail('INVALID_PARAMS', `${key} is not a valid ISO time: ${value}`);
        window[key] = new Date(ms).toISOString();
      }
      if (window.created_since !== undefined && window.created_until !== undefined && window.created_since >= window.created_until) {
        return fail('INVALID_PARAMS', 'created_since must be before created_until');
      }
      const pending = params.pending ?? (window.created_since === undefined && window.created_until === undefined);
      if (!pending && window.created_since === undefined && window.created_until === undefined) {
        return fail('INVALID_PARAMS', 'select memories with pending: true or a created_since/created_until window');
      }
      try {
        return ok(replay.start({
          pending, ...window,
          ...(params.source !== undefined ? { source: params.source } : {}),
          ...(params.after_id !== undefined ? { after_id: params.after_id } : {}),
          limit: params.limit,
        }, params.dry_run));
      } catch (e) {
        if (e instanceof ConsolidationReplayRefusal) return fail(e.code, e.message);
        throw e;
      }
    },
  );
}
