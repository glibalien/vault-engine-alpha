import type { ClassifyNodesInput, ClassifyNodesResult, ClassificationDiscovery } from './classification-types.js';
import type { PrepareRequest, PreparedReceipt, PreparePreview, StageRequest, ProvenanceBinding, TransitionRequest, InspectRequest, InspectData, ImpactRequest, ImpactData, PurgeRequest, PurgePreview, PurgeReceipt, OutputReceipt, OutputCurrentness } from './provenance-types.js';
import type { ReadRollupsRequest, ReadRollupsData, RelationshipViewsDiscovery } from './rollup-types.js';
import type { TraversalRequest, TraversalData } from './traversal-types.js';
import type { SummaryRequest, SummaryData } from './summary-types.js';
// allow: SIZE_OK — one typed MCP facade centralizes transport, retry, and mutation journaling.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { nodeStatus, statusFields, vaultOf, type BootstrapConfig, type Config } from './config.js';
import type { ProjectRef, ProjectEvidence, EngineNode, EngineNodeSummary, WikiSections, GapFillCandidate, WebSearchResult, Memory, ChangedNodeRef, SchemaRef, OrgNodeRef, HashedNodeRef, ConversationMeta, CreateNodeArgs, CreateNodePreview, CreateNodeResult, ThemedPageKind, WikiScopeV1, ExistingWiki } from './types.js';
import type { Envelope, Issue } from '@vault/contract';
import type { ActionRecorder } from './journal/recorder.js';
import {
  captureIdMarkerQuery,
  conversationCaptureMarkerQuery,
} from './conversation-capture-markers.js';
import type { ConversationAuthorityGuard } from './types.js';
import type { FieldGuessCandidatePage, FieldGuessMutationGuard } from './field-guess/types.js';

/** A schema display name for a kind: its name with the first letter capitalized ('note' → 'Note'). */
function kindDisplayName(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** Machinery lifecycle stamps — a fields patch touching ONLY these is wiki
 *  bookkeeping (curation-state/themed-state stamping), not a narratable action. */
export const WIKI_STAMP_FIELDS = new Set([
  'wiki_state', 'wiki_kind', 'wiki_origin', 'wiki_scope', 'wiki_replaced_by', 'wiki_pinned',
  'wiki_evidence_hash', 'wiki_curated_at', 'wiki_topology_hash', 'wiki_reconcile_key', 'wiki_status',
]);

/** A wiki home page's `wiki_status` (#547), as the Engine's `wiki-status` tool reads and writes it. */
export type WikiStatus = 'current' | 'behind' | 'paused' | 'paused-behind' | 'building' | 'failed';

/** What `wiki-status` answers: the wiki's home (null when it has none yet) and its status. */
export interface WikiStatusResult {
  readonly root_id: string;
  readonly home_node_id: string | null;
  readonly previous_status?: WikiStatus | null;
  readonly status: WikiStatus | null;
  readonly version: number | null;
  /** Whether a build has stamped the home (it carries an evidence hash). */
  readonly built?: boolean;
  readonly written: boolean;
}

function conversationAuthorityWire(
  authority: ConversationAuthorityGuard,
): Record<string, unknown> {
  return {
    conversation_id: authority.conversationId,
    expected_revision: authority.expectedRevision,
    expected_link_mode: authority.expectedLinkMode,
    expected_linked_docs: authority.expectedLinkedDocs,
  };
}

/** A note the link sweep may read: identity and last-change time (#332). */
export interface LinkSweepNoteRef {
  id: string;
  title: string | null;
  file_path: string;
  file_mtime?: number | null;
  /** When the Engine first indexed the note (ms); the listing's order. */
  created_at?: number | null;
}

/** A note the link sweep may read from the backlog (#697), with how many notes link to it and it links to. */
export interface LinkSweepBacklogRef extends LinkSweepNoteRef {
  inlink_count: number;
  outlink_count: number;
}

export class EngineError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(`engine ${code}: ${message}`);
    this.name = 'EngineError';
  }
}

/** One settings domain's engine-side payload (get-settings/update-settings wire shape). */
export interface SettingsDomainPayload {
  effective: Record<string, unknown>;
  stored: Record<string, unknown>;
  version: number;
  seeded: boolean;
  issues: unknown[];
}

/** The read-only "models" pseudo-domain payload (Settings/Models/ catalog; get-settings only). */
export interface ModelsDomainPayload {
  catalog: Array<{ title: string; provider: string; model: string; enabled: boolean }>;
  providers: Record<string, boolean>;
  version: number;
  issues: unknown[];
}

/** One cross-source/scope memory pair in the dedup gray band (list-memory-near-pairs wire shape). */
/** `note_date` is when the member's source note was written, by the Engine's rule; null or absent without a dated note.
 *  `note_title` and `note_projects` name that note and the projects it is filed under (#352). */
export type NearPairMember = Memory & { note_date?: string | null; note_title?: string | null; note_projects?: string[] };
/** `subjects_apart`: the Engine's subject rule keeps the two apart (#718); absent from an older Engine. */
export interface NearPair { a: NearPairMember; b: NearPairMember; distance: number; subjects_apart?: boolean }

/** What create-memory did: `add` wrote a new memory, `update`/`contradict` wrote one that
 *  replaces an existing memory, `noop` wrote nothing (already known). */
export type MemoryCreateOperation = 'add' | 'update' | 'contradict' | 'noop';

/** What get-memory says about whether a memory is live and what replaced it. */
export interface MemoryState {
  id: number;
  content: string;
  expired_at: string | null;
  expire_reason: string | null;
  superseded_by: number | null;
  /** Moves with every change to the memory, in place or not (#554's subjects included). */
  updated_at?: string;
  evidence_node_id?: string | null;
  evidence_hash?: string | null;
}

export interface FieldGuessCandidateListInput {
  limit?: number;
  cursor?: string;
  /** An on-demand run (#644): these fields, on the notes the query selects (query-nodes filters). */
  requested?: { fields: readonly string[]; query?: Record<string, unknown>; replace_invalid?: boolean };
}

/**
 * An on-demand run asked for its own listing; make sure that is what came back. An Engine from
 * before #644 drops the `requested` argument and answers with the nightly listing: other fields,
 * on notes outside the run's scope. Filling those would write what nobody asked for, so a page
 * without the Engine's mark, or offering a field the run did not name, is refused.
 */
function assertRequestedPage(page: FieldGuessCandidatePage, fields: readonly string[], warnings: readonly Issue[]): void {
  // Before its presence backfill completes the Engine answers every listing with an empty page and a warning.
  if (warnings.some(issue => issue.code === 'FIELD_PRESENCE_BACKFILL_PENDING')) return;
  const named = new Set(fields);
  const stray = page.candidates.some(candidate => candidate.fields.some(field => !named.has(field.field)));
  // (A field offered as `invalid` to a run that did not ask to replace is refused by the Engine's
  // write guard, which holds the rule; this check is about whose listing came back.)
  if (page.mode !== 'requested' || stray) {
    throw new EngineError('ENGINE_TOO_OLD', 'This Engine does not list notes for an on-demand field-filling run. '
      + 'Update the Engine to the Curator\'s version, then try again.');
  }
}

/** undo-operations over a run's stored operations: ids no longer active are reported, not fatal. */
/** A memory the subject model pass asks about (Engine `memory-subject-pass` list, #554). */
export interface SubjectPassMemory {
  id: number;
  content: string;
  category: string | null;
  source_title: string | null;
  source_names: string[];
  /** The subjects it has: only the free match's can be there. Absent from an Engine before that. */
  subjects?: string[];
}

export interface SubjectPassPage { memories: SubjectPassMemory[]; total: number; next_after_id: number | null }

/** What became of one memory's names (Engine `memory-subject-pass` write). */
export interface SubjectPassResult {
  memory_id: number;
  outcome: 'written' | 'none' | 'has_subjects' | 'not_live' | 'not_found';
  subjects: Array<{ name: string; status: 'linked' | 'unresolved' | 'ambiguous'; title: string | null; held?: true }>;
  /** For `written`: when, which with the memory id names the write for `clearModelSubjects`. */
  written_at?: string;
}

export interface SubjectPassWrite { results: SubjectPassResult[]; memories: number; subjects: number }

export interface UndoOperationsResult {
  dry_run: boolean;
  total_undone: number;
  total_conflicts: number;
  total_skipped: number;
  conflicts: Array<{ node_id: string; reason: string; file_path?: string; title?: string }>;
  not_found: string[];
}

export interface UpdateNodeFieldsCasInput {
  nodeId: string;
  setFields: Record<string, unknown>;
  expectedVersion: number;
  expectedContentHash: string;
  guard: FieldGuessMutationGuard;
  dryRun: boolean;
}

export type WikiReconcileSection = {
  readonly name: string;
  readonly mode: 'replace' | 'append';
  readonly content: string;
};

export type WikiReconcileTarget =
  | { readonly mode: 'existing'; readonly node_id: string; readonly expected_version: number }
  | { readonly mode: 'new'; readonly plan_key: string; readonly title: string };

export type WikiReconcilePageOperation =
  | {
      readonly op: 'upsert';
      readonly target: WikiReconcileTarget;
      readonly scope: WikiScopeV1;
      readonly kind: ThemedPageKind;
      readonly origin: 'automatic' | 'requested';
      readonly pinned: boolean;
      readonly sections?: readonly WikiReconcileSection[];
      readonly provenance?: ProvenanceBinding;
    }
  | {
      readonly op: 'merge';
      readonly target: WikiReconcileTarget;
      readonly sources: readonly { readonly node_id: string; readonly expected_version: number }[];
      readonly scope: WikiScopeV1;
      readonly kind: ThemedPageKind;
      readonly origin: 'automatic' | 'requested';
      readonly pinned: boolean;
      readonly reason: string;
      readonly sections: readonly WikiReconcileSection[];
      readonly provenance?: ProvenanceBinding;
    }
  | {
      readonly op: 'retire';
      readonly node_id: string;
      readonly expected_version: number;
      readonly scope: WikiScopeV1;
      readonly state: 'dormant' | 'retired';
      readonly reason: string;
    };

export type WikiReconcileInput = {
  readonly provenance_mode?: 'project-subpage-v1';
  readonly home_refresh?: { home_node_id: string; expected_output_revision_id: string; expected_topology_hash: string };
  /** Rewrite one existing page and nothing else: `pages` holds exactly that page, and `home` isn't written. */
  readonly page_refresh?: { page_node_id: string; expected_output_revision_id: string; expected_topology_hash: string };
  readonly project: string;
  readonly project_id?: string;
  readonly reconcile_key: string;
  readonly pages: readonly WikiReconcilePageOperation[];
  readonly home: {
    readonly provenance?: ProvenanceBinding;
    readonly expected_version?: number;
    readonly sections: readonly WikiReconcileSection[];
    readonly evidence_hash: string;
    readonly curated_at: string;
    readonly refresh_live: true;
    /** The home's `wiki_status` once the build is stamped (#547). */
    readonly status?: 'current' | 'paused';
    /** Name a new home "<root> Dossier" instead of "<root> Wiki" (#554); an existing home keeps its title.
     *  An Engine from before this option refuses it as an unknown key. */
    readonly title_suffix?: 'Dossier';
  };
  readonly dry_run?: boolean;
};

export type WikiReconcileNodeResult = {
  readonly node_id: string;
  readonly title: string;
  readonly file_path: string;
  readonly version: number;
};

export type WikiReconcileMapping = {
  readonly source_node_id: string;
  readonly target_node_id: string;
  readonly target_title: string;
};

export type WikiReconcileResult = {
  readonly provenance_receipt?: OutputReceipt;
  readonly provenance_receipts?: OutputReceipt[];
  readonly current_outputs?: Record<string, OutputCurrentness>;
  readonly current_output?: 'matches' | 'changed' | 'missing' | 'unknown';
  readonly operation_id: string | null;
  readonly reconcile_key: string;
  readonly plan_digest: string;
  readonly reused: boolean;
  readonly dry_run: boolean;
  readonly created: readonly WikiReconcileNodeResult[];
  readonly updated: readonly WikiReconcileNodeResult[];
  readonly mappings: readonly WikiReconcileMapping[];
  readonly home: {
    readonly node_id: string | null;
    readonly title: string;
    readonly file_path: string;
    readonly version: number | null;
    readonly created: boolean;
  };
  readonly topology_hash: string;
  readonly warnings: readonly {
    readonly code: 'STALE_ACTIVE_REPLACEMENT';
    readonly message: string;
    readonly node_id: string;
  }[];
  readonly preview: {
    readonly total: number;
    readonly items: readonly {
      readonly op: 'upsert' | 'merge' | 'retire';
      readonly target: string;
      readonly title: string;
      readonly source_count?: number;
      readonly state?: 'dormant' | 'retired';
    }[];
    readonly truncated: boolean;
  };
};

/** Loose client/transport shapes so a fake can be injected in tests. */
export interface EngineClientLike {
  connect(transport: unknown): Promise<void>;
  callTool(
    req: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number },
  ): Promise<{ content?: unknown }>;
}

/** How long create-memory may run before the client gives up. Its consolidation model call
 *  regularly takes 30–60 s and can run longer when the provider is slow, so the MCP SDK's
 *  60 s default gave up on calls the Engine then finished. */
export const CREATE_MEMORY_TIMEOUT_MS = 5 * 60_000;

/** The MCP SDK's request timeout: the Engine received the request and may still complete it. */
function isRequestTimeout(err: unknown): boolean {
  return err instanceof McpError && err.code === ErrorCode.RequestTimeout;
}

export interface EngineTransportLike { close(): Promise<void>; }
export type EngineClientFactory = () => { client: EngineClientLike; transport: EngineTransportLike };

function defaultFactory(config: BootstrapConfig): EngineClientFactory {
  return () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${config.engineUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${config.engineToken}` } },
    });
    return { transport, client: adaptSdkClient(new Client({ name: 'vault-curator', version: '0.1.0' })) };
  };
}

/** The production client: the MCP SDK's Client behind {@link EngineClientLike}. Request
 *  options (the per-call timeout) must reach the SDK, or every call gets its 60 s default. */
export function adaptSdkClient(client: Pick<Client, 'connect' | 'callTool'>): EngineClientLike {
  return {
    connect: (t: unknown) => client.connect(t as Parameters<Client['connect']>[0]),
    callTool: (req, _resultSchema, options) =>
      client.callTool(req, undefined, options) as Promise<{ content?: unknown }>,
  };
}

/**
 * Thin typed wrapper over the vault-engine MCP tool surface. Connects to the
 * running engine's Streamable HTTP endpoint with a static bearer service token.
 * Every vault mutation goes through a tool call here — the curator never writes
 * files or opens the engine DB for writing.
 *
 * The client connects lazily on first use and reconnects once on transport errors
 * (engine restart under systemd). Tool-level ok:false failures are never retried.
 */
export class Engine {
  private client!: EngineClientLike;
  private transport!: EngineTransportLike;
  private connected = false;
  private connectingPromise: Promise<void> | null = null;
  private readonly factory: EngineClientFactory;
  private recorder: ActionRecorder | undefined;

  /** Wire the journal recorder (composition roots only; optional everywhere else). */
  setRecorder(recorder: ActionRecorder): void {
    this.recorder = recorder;
  }
  private spendObserver: ((usd: number | null) => void) | undefined;

  /** Receives the cost of Engine-side model calls made on the Curator's account (create-memory's
   *  consolidation): a dollar amount, or null when unknown. Wired to the daily budget's live tally,
   *  which otherwise reads the ledger only once a day (#298). */
  setSpendObserver(observer: (usd: number | null) => void): void {
    this.spendObserver = observer;
  }


  constructor(config: BootstrapConfig, factory?: EngineClientFactory) {
    this.factory = factory ?? defaultFactory(config);
  }

  /** Idempotent — first use builds + connects; later calls are no-ops. */
  async connect(): Promise<void> {
    await this.ensureConnected();
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.transport.close();
    this.connected = false;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (!this.connectingPromise) {
      this.connectingPromise = (async () => {
        const built = this.factory();
        this.client = built.client;
        this.transport = built.transport;
        await this.client.connect(this.transport);
        this.connected = true;
      })().finally(() => { this.connectingPromise = null; });
    }
    return this.connectingPromise;
  }

  private async invoke<T>(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ data: T; warnings: Issue[] }> {
    const result = timeoutMs === undefined
      ? await this.client.callTool({ name, arguments: args })
      : await this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.find(c => c.type === 'text')?.text;
    if (!text) throw new EngineError('NO_CONTENT', `tool ${name} returned no text content`);
    let env: Envelope<T>;
    try {
      env = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new EngineError('BAD_JSON', `tool ${name} returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!env.ok) throw new EngineError(env.error?.code ?? 'UNKNOWN', env.error?.message ?? 'tool failed', env.error?.details);
    return { data: env.data as T, warnings: env.warnings };
  }

  private async call<T>(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return (await this.callWithWarnings<T>(name, args, timeoutMs)).data;
  }

  /**
   * Like {@link call}, but also surfaces the envelope's `warnings` (soft
   * per-key rejections, e.g. `SETTINGS_MODEL_REF_UNRESOLVED`) — used by
   * `updateSettings`, whose seed-time callers need to know which submitted
   * keys the engine's contextual validation rejected (seed-drop delta
   * logging). Every other caller only needs `.data`, hence `call` staying the
   * default entry point.
   */
  private async callWithWarnings<T>(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ data: T; warnings: Issue[] }> {
    await this.ensureConnected();
    try {
      return await this.invoke<T>(name, args, timeoutMs);
    } catch (err) {
      // EngineError = a completed round-trip with a tool-level failure → never retry.
      // A timeout is not a broken connection: the Engine has the request and may still
      // finish it, so sending it again could apply a write twice → never retry.
      // Anything else = a transport/connection failure → reconnect once and retry once.
      if (err instanceof EngineError || isRequestTimeout(err)) throw err;
      this.connected = false;
      await this.ensureConnected();
      return this.invoke<T>(name, args, timeoutMs);
    }
  }

  /** Current-state summaries retain completeness warnings for the caller. */
  async classifyNodes(args: ClassifyNodesInput): Promise<{data:ClassifyNodesResult;warnings:Issue[]}> {
    return this.callWithWarnings<ClassifyNodesResult>('classify-nodes',args as unknown as Record<string,unknown>);
  }

  async describeClassification(schema: string): Promise<{data:ClassificationDiscovery | undefined;warnings:Issue[]}> {
    const result = await this.callWithWarnings<{classification?:ClassificationDiscovery}>('describe-schema',{name:schema,include:['classification']});
    return {data:result.data.classification,warnings:result.warnings};
  }

  async readRollups(args: ReadRollupsRequest): Promise<{ data: ReadRollupsData; warnings: Issue[] }> {
    return this.callWithWarnings<ReadRollupsData>('read-rollups', args as unknown as Record<string, unknown>);
  }

  async describeRelationshipViews(schema: string): Promise<{ data: RelationshipViewsDiscovery; warnings: Issue[] }> {
    const result = await this.callWithWarnings<{ relationship_views: RelationshipViewsDiscovery }>('describe-schema', { name: schema, include: ['relationship_views'] });
    return { data: result.data.relationship_views, warnings: result.warnings };
  }

  async traverseNodes(args: TraversalRequest): Promise<{ data: TraversalData; warnings: Issue[] }> {
    return this.callWithWarnings<TraversalData>('traverse-nodes', args as unknown as Record<string, unknown>);
  }

  async summarizeNodes(args: SummaryRequest): Promise<{ data: SummaryData; warnings: Issue[] }> {
    return this.callWithWarnings<SummaryData>('summarize-nodes', args as unknown as Record<string, unknown>);
  }

  /**
   * Projects whose status is one of `statuses`. A null project kind (none in the vault map)
   * means no projects; a null status field means every project of the kind, with no status.
   * With a status field, an empty list means no project is active, so it answers [] without
   * asking: Engine rejects an empty `one_of`, and the throw would stop the sweep before its
   * wiki, memory and journal phases (#454).
   */
  async listActiveProjects(
    statuses: string[], projectType: string | null = 'project', statusField: string | null = 'status', limit = 200,
  ): Promise<ProjectRef[]> {
    if (projectType === null) return [];
    if (statusField !== null && statuses.length === 0) return [];
    const data = await this.call<{ nodes: Array<{ id: string; title: string; file_path: string; fields?: Record<string, unknown> }> }>(
      'query-nodes',
      {
        types: [projectType],
        ...(statusField === null ? {} : { fields: { [statusField]: { one_of: statuses } }, include_fields: [statusField] }),
        sort_by: 'file_mtime',
        sort_order: 'desc',
        limit,
      },
    );
    return data.nodes.map(n => ({
      id: n.id,
      title: n.title,
      file_path: n.file_path,
      status: statusField === null ? null : (n.fields?.[statusField] as string | undefined) ?? null,
    }));
  }

  /** Every node of `type` that has `field`, with that field's value: one query-nodes read, paged
   *  only past its 200-node cap. The wiki-field check reads project notes' `wiki` field this way. */
  async listNodesWithField(type: string, field: string): Promise<Array<{ id: string; title: string; value: unknown }>> {
    const page = 200;
    const out: Array<{ id: string; title: string; value: unknown }> = [];
    for (let offset = 0; ; offset += page) {
      const data = await this.call<{ nodes: Array<{ id: string; title: string; fields?: Record<string, unknown> }> }>('query-nodes', {
        types: [type], fields: { [field]: { exists: true } }, include_fields: [field], select: ['id', 'title'],
        sort_by: 'title', limit: page, offset,
      });
      for (const n of data.nodes) out.push({ id: n.id, title: n.title, value: Engine.unwrapFieldValue(n.fields?.[field]) });
      if (data.nodes.length < page) return out;
    }
  }

  /** Notes of `types` with their titles and aliases, the names the link sweep looks for (#332). */
  async listLinkTargets(types: readonly string[], maxPages = 50): Promise<Array<{ id: string; title: string; aliases: string[]; type: string }>> {
    const page = 200;
    // `type`: the kind a note was listed under, the first of `types` it has.
    const out = new Map<string, { id: string; title: string; aliases: string[]; type: string }>();
    for (const type of new Set(types)) {
      for (let offset = 0, pages = 0; pages < maxPages; offset += page, pages++) {
        const data = await this.call<{ nodes: Array<{ id: string; title: string | null; fields?: Record<string, unknown> }> }>('query-nodes', {
          types: [type], include_fields: ['aliases', 'alias'], select: ['id', 'title'], sort_by: 'title', limit: page, offset,
        });
        for (const n of data.nodes) {
          if (typeof n.title !== 'string' || out.has(n.id)) continue;
          const aliases = ['aliases', 'alias'].flatMap(key => {
            const value = Engine.unwrapFieldValue(n.fields?.[key]);
            return (Array.isArray(value) ? value : [value]).filter((a): a is string => typeof a === 'string' && a.trim() !== '');
          });
          out.set(n.id, { id: n.id, title: n.title, aliases, type });
        }
        if (data.nodes.length < page) break;
      }
    }
    return [...out.values()];
  }

  /** How many notes the vault holds, or with `text`, how many hold its words as whole words in
   *  their title or body (any case; "Ark" is not counted in "market"): `query-nodes`' total with
   *  `full_text_words` (#332's common names, #687). */
  async countNotes(text?: string): Promise<number> {
    const data = await this.call<{ total?: unknown }>('query-nodes', { ...(text === undefined ? {} : { full_text_words: text }), select: ['id'], limit: 1 });
    if (typeof data.total !== 'number') throw new Error('query-nodes omitted total');
    return data.total;
  }

  /** How many notes have this title, letter case aside (`title_eq`): a link written as `[[title]]`
   *  names one note only when this is 1 (#332's apply mode). */
  async countTitled(title: string): Promise<number> {
    const data = await this.call<{ total?: unknown }>('query-nodes', { title_eq: title, select: ['id'], limit: 1 });
    if (typeof data.total !== 'number') throw new Error('query-nodes omitted total');
    return data.total;
  }

  /**
   * Replace a note's body, for the link sweep's apply mode (#332): only while the note is still
   * as read, at `expectedVersion` with `expectedContentHash` both in the database and on disk (a
   * save the Engine has not read yet refuses the write). No journal action of its own (the sweep
   * journals each note), and it returns the Engine's undo operation for this write and the note's
   * content hash after it.
   */
  async setBodyCas(input: { nodeId: string; body: string; expectedVersion: number; expectedContentHash: string }): Promise<{ operationId: string | null; contentHash: string | null }> {
    const data = await this.call<{ operation_id?: unknown; content_hash?: unknown }>('update-node', {
      node_id: input.nodeId, set_body: input.body,
      expected_version: input.expectedVersion, expected_content_hash: input.expectedContentHash, dry_run: false,
    });
    return {
      operationId: typeof data?.operation_id === 'string' ? data.operation_id : null,
      contentHash: typeof data?.content_hash === 'string' ? data.content_hash : null,
    };
  }

  /**
   * Notes the Engine first indexed at or after `createdSince`, oldest first, leaving out
   * suite notes (memories, journal), notes of `withoutTypes` and anything under `withoutPathPrefix`
   * (#332). `truncated` when more were there than `maxPages` pages hold.
   */
  async listCreatedNotes(args: {
    createdSince: string; withoutTypes: readonly string[]; withoutPathPrefix?: string; maxPages?: number;
  }): Promise<{ nodes: LinkSweepNoteRef[]; truncated: boolean }> {
    const page = 200;
    const maxPages = args.maxPages ?? 10;
    const out: LinkSweepNoteRef[] = [];
    for (let offset = 0, pages = 0; ; offset += page, pages++) {
      if (pages === maxPages) return { nodes: out, truncated: true };
      const data = await this.call<{ nodes: LinkSweepNoteRef[] }>('query-nodes', {
        created_since: args.createdSince,
        without_fields: ['vault_engine_projection'],
        ...(args.withoutTypes.length > 0 ? { without_types: [...args.withoutTypes] } : {}),
        ...(args.withoutPathPrefix ? { without_path_prefix: args.withoutPathPrefix } : {}),
        select: ['id', 'title', 'file_path', 'file_mtime', 'created_at'],
        sort_by: 'created_at', sort_order: 'asc', limit: page, offset,
      });
      out.push(...data.nodes);
      if (data.nodes.length < page) return { nodes: out, truncated: false };
    }
  }

  /**
   * Every note the link sweep may read, newest first, with its link counts (#697): the notes
   * {@link listCreatedNotes} would list, without its date bound. The counts are the Engine's (#611):
   * distinct notes, body links and reference fields together. It reads to the end, one page per
   * 200 notes: a fixed limit would hold every run to the same newest notes and never reach the
   * oldest, however few links they have (Codex, #698).
   */
  async listLinkSweepBacklog(args: {
    withoutTypes: readonly string[]; withoutPathPrefix?: string;
  }): Promise<{ nodes: LinkSweepBacklogRef[] }> {
    const page = 200;
    const out: LinkSweepBacklogRef[] = [];
    for (let offset = 0; ; offset += page) {
      const data = await this.call<{ nodes: LinkSweepBacklogRef[] }>('query-nodes', {
        without_fields: ['vault_engine_projection'],
        ...(args.withoutTypes.length > 0 ? { without_types: [...args.withoutTypes] } : {}),
        ...(args.withoutPathPrefix ? { without_path_prefix: args.withoutPathPrefix } : {}),
        select: ['id', 'title', 'file_path', 'file_mtime', 'created_at', 'inlink_count', 'outlink_count'],
        sort_by: 'created_at', sort_order: 'desc', limit: page, offset,
      });
      out.push(...data.nodes);
      if (data.nodes.length < page) return { nodes: out };
    }
  }

  /**
   * The ids of the notes holding `text` as whole words, in any letter case (`full_text_words`, the
   * search the too-common count uses, #687), leaving out what {@link listCreatedNotes} leaves out
   * (#699). Every page is read: the caller records the name as looked for, so a match left out
   * here would never be read again (Codex, #701). A name too common to link is never asked for.
   */
  async listNotesNaming(text: string, args: {
    withoutTypes: readonly string[]; withoutPathPrefix?: string;
  }): Promise<string[]> {
    const page = 200;
    const out: string[] = [];
    for (let offset = 0; ; offset += page) {
      const data = await this.call<{ nodes: Array<{ id: string }> }>('query-nodes', {
        full_text_words: text,
        without_fields: ['vault_engine_projection'],
        ...(args.withoutTypes.length > 0 ? { without_types: [...args.withoutTypes] } : {}),
        ...(args.withoutPathPrefix ? { without_path_prefix: args.withoutPathPrefix } : {}),
        select: ['id'], sort_by: 'created_at', sort_order: 'desc', limit: page, offset,
      });
      out.push(...data.nodes.map(n => n.id));
      if (data.nodes.length < page) break;
    }
    return out;
  }

  /**
   * The titles of the people at a company: notes of `personType` whose `companyField` link is
   * stored as resolved to `companyId`, the relation project-evidence reads a person's companies
   * from. Paged by title, at most `cap`. A dossier's "Last contact" reads it (Codex, #713): the
   * evidence's contact list is capped and ranked for the page, not for who works where.
   */
  async listPeopleAt(companyId: string, kinds: { personType: string; companyField: string }, cap = 5_000): Promise<{ titles: string[]; truncated: boolean }> {
    const titles: string[] = [];
    for (let offset = 0; offset < cap; offset += 200) {
      const data = await this.call<{ nodes: Array<{ id: string; title: string }> }>('query-nodes', {
        types: [kinds.personType], join_filters: [{ rel_type: kinds.companyField, target: { node_ids: [companyId] } }],
        select: ['id', 'title'], sort_by: 'title', limit: 200, offset,
      });
      titles.push(...data.nodes.map(node => node.title));
      if (data.nodes.length < 200) return { titles, truncated: false };
    }
    return { titles, truncated: true };
  }

  /** The listed notes that still exist, with the same fields as {@link listCreatedNotes}. */
  async listNotesById(ids: readonly string[]): Promise<LinkSweepNoteRef[]> {
    const out: LinkSweepNoteRef[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const data = await this.call<{ nodes: LinkSweepNoteRef[] }>('query-nodes', {
        node_ids: ids.slice(i, i + 200), select: ['id', 'title', 'file_path', 'file_mtime'], limit: 200,
      });
      out.push(...data.nodes);
    }
    return out;
  }

  async listFieldGuessCandidates(
    input: FieldGuessCandidateListInput,
  ): Promise<{ page: FieldGuessCandidatePage; warnings: Issue[] }> {
    const args: Record<string, unknown> = {};
    if (input.limit !== undefined) args.limit = input.limit;
    if (input.cursor !== undefined) args.cursor = input.cursor;
    if (input.requested !== undefined) {
      args.requested = {
        fields: [...input.requested.fields],
        ...(input.requested.query === undefined ? {} : { query: input.requested.query }),
        ...(input.requested.replace_invalid === true ? { replace_invalid: true } : {}),
      };
    }
    const { data, warnings } = await this.callWithWarnings<FieldGuessCandidatePage>(
      'list-field-guess-candidates',
      args,
    );
    if (input.requested !== undefined) assertRequestedPage(data, input.requested.fields, warnings);
    return { page: data, warnings };
  }

  async findNodesByExactTitle(title: string, _limit: number): Promise<EngineNodeSummary[]> {
    const data = await this.call<{ nodes: EngineNodeSummary[] }>('query-nodes', {
      title_eq: title,
      limit: 2,
    });
    return data.nodes;
  }

  /**
   * Hybrid (FTS + semantic) search over the vault, used by gap-fill to surface
   * related-but-unlinked nodes. The vault map's status fields come back inline
   * (a candidate's status is its kind's field, `nodeStatus`); no sort_by — hybrid
   * RRF ranking owns ordering.
   *
   * Semantic evidence candidates. Generated wiki pages (the map's `wikiType`; none
   * excludes no kind) and the settings folder are never evidence: their prose is
   * derived, and their churn would otherwise re-trigger paid refreshes.
   */
  async semanticRelated(queryText: string, limit: number, config: Pick<Config, 'settingsDir' | 'vault'>): Promise<GapFillCandidate[]> {
    const vault = vaultOf(config);
    const statusNames = statusFields(vault);
    const settingsDir = config.settingsDir?.trim();
    const data = await this.call<{ nodes: Array<{ id: string; title: string; types?: string[]; fields?: Record<string, unknown>; match_sources?: string[] }> }>(
      'query-nodes',
      { query: queryText, ...(statusNames.length > 0 ? { include_fields: statusNames } : {}),
        without_fields: ['vault_engine_projection'], ...(vault.wikiType === null ? {} : { without_types: [vault.wikiType] }),
        ...(settingsDir ? { without_path_prefix: `${settingsDir.replace(/\/+$/, '')}/` } : {}), limit },
    );
    return data.nodes.map(n => ({
      id: n.id,
      title: n.title,
      types: n.types ?? [],
      status: nodeStatus(n.fields, n.types ?? [], vault),
      match_sources: n.match_sources,
    }));
  }

  inspectProvenance(input: InspectRequest): Promise<InspectData> {
    return this.call('inspect-provenance', input);
  }

  findAffectedOutputs(input: ImpactRequest): Promise<ImpactData> {
    return this.call('find-affected-outputs', input);
  }

  purgeProvenance(input: PurgeRequest): Promise<PurgePreview | PurgeReceipt> {
    return this.call('purge-provenance', input);
  }

  prepareProvenance(input: PrepareRequest): Promise<PreparedReceipt | PreparePreview> {
    return this.call('provenance-prepare', input);
  }

  stageProvenanceResult(input: StageRequest): Promise<ProvenanceBinding> {
    return this.call('provenance-stage-result', input);
  }

  transitionProvenance(input: TransitionRequest): Promise<PreparedReceipt> {
    return this.call('provenance-transition', input);
  }

  projectEvidence(project: string, meetingRecentLimit?: number, since?: string, options: { includeProvenance?: boolean; provenanceNodeIds?: readonly string[] } = {}): Promise<ProjectEvidence & { readonly existing_wiki: ExistingWiki }> {
    const args: Record<string, unknown> = { project };
    if (meetingRecentLimit !== undefined) args.meeting_recent_limit = Math.min(meetingRecentLimit, 100);
    if (since !== undefined) args.since = since;
    if (options.includeProvenance) args.include_provenance = true;
    if (options.provenanceNodeIds) args.provenance_node_ids = options.provenanceNodeIds;
    return this.call<ProjectEvidence & { readonly existing_wiki: ExistingWiki }>('project-evidence', args);
  }

  getNode(node_id: string, options: { includeEmbeds?: boolean; includeProvenance?: boolean } = {}): Promise<EngineNode> {
    return this.call<EngineNode>('get-node', {
      node_id,
      include_embeds: options.includeEmbeds ?? false,
      ...(options.includeProvenance ? { include_provenance: true } : {}),
    });
  }

  /** Resolve a node by exact title (get-node title param). Throws EngineError
   *  when the engine reports no such node. */
  getNodeByTitle(title: string): Promise<EngineNode> {
    return this.call<EngineNode>('get-node', { title, include_embeds: false });
  }

  /** Append markdown to a node body via update-node append_body (the journal
   *  writer's entry sink). */
  /** Delete a note and its file (`delete-node`), as one undo operation, which it returns (#723). */
  async deleteNode(nodeId: string, title?: string): Promise<{ operationId: string | null }> {
    const data = await this.call<{ operation_id?: string }>('delete-node', { node_id: nodeId, confirm: true });
    this.recorder?.record({ action: 'page-deleted', nodeId, target: title ?? nodeId,
      detail: `deleted "${title ?? nodeId}"${data.operation_id ? ` (undo: ${data.operation_id})` : ''}` });
    return { operationId: data.operation_id ?? null };
  }

  async appendNodeBody(nodeId: string, text: string): Promise<void> {
    await this.call('update-node', { node_id: nodeId, append_body: text, dry_run: false });
  }

  /** Create a vault node via the engine's create-node tool. `directory` (optional)
   *  overrides the type schema's default directory. */
  async createNode(args: CreateNodeArgs & { dryRun: true }): Promise<CreateNodePreview>;
  async createNode(args: CreateNodeArgs & { dryRun?: false }): Promise<CreateNodeResult>;
  async createNode(args: CreateNodeArgs & { dryRun?: boolean }): Promise<CreateNodePreview | CreateNodeResult> {
    const req: Record<string, unknown> = {
      title: args.title, types: args.types, fields: args.fields ?? {}, body: args.body ?? '',
      dry_run: args.dryRun ?? false,
    };
    if (args.directory !== undefined) { req.directory = args.directory; req.override_default_directory = true; }
    if (args.conversationAuthority !== undefined) {
      req.conversation_authority = conversationAuthorityWire(args.conversationAuthority);
    }
    const result = await this.callWithWarnings<Omit<CreateNodePreview, 'warnings'> | Omit<CreateNodeResult, 'warnings'>>('create-node', req);
    if (args.dryRun) {
      return { ...(result.data as Omit<CreateNodePreview, 'warnings'>), warnings: result.warnings };
    }
    const data = result.data as Omit<CreateNodeResult, 'warnings'>;
    this.recorder?.record({
      action: 'node-created', nodeId: data.node_id, target: args.title,
      detail: `created node "${args.title}" (${args.types.join(', ') || 'untyped'})`,
    });
    return { ...data, warnings: result.warnings };
  }

  /** Ensure the schema of the topic kind (the vault map's `topicType`) exists (idempotent); a new
   *  one is rooted at `directory`. */
  async ensureTopicSchema(type: string, directory = 'Topics'): Promise<void> {
    await this.ensureSchema({ name: type, display_name: kindDisplayName(type), default_directory: directory });
  }

  /** Ensure the schema of the kind the journal and conversation capture write (the vault map's
   *  `journalType`) exists (idempotent). No default directory: the journal names its folder
   *  (the wiki folder). */
  async ensureNoteSchema(type: string): Promise<void> {
    await this.ensureSchema({ name: type, display_name: kindDisplayName(type) });
  }

  /**
   * describe-schema first; if it's absent (EngineError), create a minimal schema with no
   * field claims. A create that loses a race to an existing schema is swallowed. Other
   * engine errors propagate.
   */
  private async ensureSchema(schema: { name: string; display_name: string; default_directory?: string }): Promise<void> {
    // Kinds come from the vault map. Engine keeps a schema's file at .schemas/<name>.yaml, so a
    // name with a path part, or one of Engine's reserved "_" names, is refused here rather than
    // handed to create-schema (#473).
    if (/[\\/]/.test(schema.name) || schema.name === '.' || schema.name === '..' || schema.name.startsWith('_')) {
      throw new Error(`"${schema.name}" in Settings/Vault.md can't name a kind: a kind name has no slashes, isn't "." or "..", and doesn't start with "_".`);
    }
    try {
      await this.call<unknown>('describe-schema', { name: schema.name });
      return; // already exists
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
    }
    try {
      await this.call<unknown>('create-schema', { ...schema, field_claims: [] });
    } catch (err) {
      if (err instanceof EngineError && /exist/i.test(err.message)) return;
      throw err;
    }
  }

  async wikiWrite(project: string, sections: WikiSections, dryRun: boolean): Promise<{ node_id?: string; created: boolean; narrative_status?: string }> {
    const managed = [
      ...(sections.at_a_glance ? [{ name: 'At a glance', mode: 'replace' as const, content: sections.at_a_glance }] : []),
      { name: 'Now', mode: 'replace' as const, content: sections.now },
      { name: 'Focus', mode: 'replace' as const, content: sections.focus },
      { name: 'Open threads', mode: 'replace' as const, content: sections.open_threads },
      ...(sections.sources ? [{ name: 'Sources', mode: 'replace' as const, content: sections.sources }] : []),
      { name: 'Log', mode: 'append' as const, content: sections.log_entry },
    ];
    const res = await this.call<{ node_id?: string; created: boolean; narrative_status?: string }>('wiki-write', {
      project,
      refresh_live: true,
      dry_run: dryRun,
      sections: managed,
    });
    this.recorder?.record({
      action: 'wiki-written', nodeId: res.node_id, target: project,
      detail: `${res.created ? 'created' : 'updated'} wiki home for "${project}"`, dryRun,
    });
    return res;
  }

  /** Create an empty project wiki home: narrative sections awaiting the first curation plus the live
   *  task sections. No model is called. Engine leaves an existing home untouched (`created: false`). */
  async wikiCreateHome(project: string, dryRun: boolean): Promise<{ node_id?: string; created: boolean }> {
    return this.call<{ node_id?: string; created: boolean }>('wiki-write', {
      project, refresh_live: true, dry_run: dryRun, create_only: true, sections: [
        { name: 'Now', mode: 'replace', content: '_The curator is building this wiki; it fills in after the first curation run._' },
        { name: 'Focus', mode: 'replace', content: '' },
        { name: 'Open threads', mode: 'replace', content: '' },
      ],
    });
  }

  /** Re-render only the home's Engine-owned live sections; narrative stays untouched and no model is called.
   *  Engine skips the write when the rendered bytes are unchanged. */
  async wikiRefreshLive(project: string, dryRun: boolean): Promise<void> {
    await this.call<unknown>('wiki-write', { project, refresh_live: true, dry_run: dryRun });
  }

  /** Read a wiki home's status by the wiki's root (node id or title), or write `status` to it (#547).
   *  Bookkeeping, not journaled. */
  wikiStatus(root: string, status?: WikiStatus): Promise<WikiStatusResult> {
    return this.call<WikiStatusResult>('wiki-status', { root, ...(status === undefined ? {} : { status }) });
  }

  async wikiReconcile(input: WikiReconcileInput): Promise<{ data: WikiReconcileResult; warnings: Issue[] }> {
    const result = await this.callWithWarnings<WikiReconcileResult>('wiki-reconcile', { ...input });
    if (input.dry_run === true) return result;

    const retired = input.pages.filter(operation => operation.op === 'retire').length;
    this.recorder?.record({
      action: 'wiki-reconciled',
      nodeId: result.data.home.node_id ?? undefined,
      target: input.project,
      detail: `reconciled wiki "${input.project}" key=${input.reconcile_key}: ${result.data.created.length} created, ${result.data.updated.length} updated, ${result.data.mappings.length} merged, ${retired} retired`,
    });
    return result;
  }

  /**
   * Write an emergent themed sub-page: a plain wiki subpage with NO page_kind and
   * refresh_live:false (pure narrative, no engine live rail), then stamp its
   * `wiki_state` + `wiki_kind`. `qualifiedTitle` is already project-qualified by
   * the caller. The optional `logNote` (already dated) is appended to the page's
   * own Log. Pages written on a caller's request carry `wiki_origin: 'requested'`
   * (pin metadata, inspectable in the vault).
   */
  async wikiWriteThemed(
    project: string,
    qualifiedTitle: string,
    body: string,
    state: string,
    kind: string,
    logNote: string,
    dryRun: boolean,
    origin?: string,
  ): Promise<{ node_id?: string; created: boolean }> {
    const sections = [
      { name: 'Summary', mode: 'replace', content: body },
    ];
    if (logNote) sections.push({ name: 'Log', mode: 'append', content: logNote });
    const res = await this.call<{ node_id?: string; created: boolean }>('wiki-write', {
      project,
      target: 'subpage',
      subpage_title: qualifiedTitle,
      refresh_live: false,
      dry_run: dryRun,
      sections,
    });
    if (!dryRun && res.node_id) {
      const fields: Record<string, unknown> = { wiki_state: state, wiki_kind: kind };
      if (origin) fields.wiki_origin = origin;
      await this.updateNodeFields(res.node_id, fields);
    }
    this.recorder?.record({
      action: 'themed-written', nodeId: res.node_id, target: qualifiedTitle,
      detail: `${res.created ? 'created' : 'updated'} themed page "${qualifiedTitle}" (${project})`, dryRun,
    });
    return res;
  }

  /**
   * Wind down an existing themed sub-page: set a dated Status section with the
   * reason and stamp the new wiki_state. Never deletes. `storedTitle` is the exact
   * already-qualified title the model echoed from the evidence.
   */
  async retireThemedPage(
    project: string,
    storedTitle: string,
    state: string,
    reason: string,
    dryRun: boolean,
    date = new Date(),
  ): Promise<{ node_id?: string; created: boolean }> {
    const iso = date.toISOString().slice(0, 10);
    const note = `**${iso}** — Retired (${state})${reason ? `: ${reason}` : ''}`;
    const res = await this.call<{ node_id?: string; created: boolean }>('wiki-write', {
      project,
      target: 'subpage',
      subpage_title: storedTitle,
      refresh_live: false,
      dry_run: dryRun,
      sections: [{ name: 'Status', mode: 'replace', content: note }],
    });
    if (!dryRun && res.node_id) {
      await this.updateNodeFields(res.node_id, { wiki_state: state });
    }
    this.recorder?.record({
      action: 'page-retired', nodeId: res.node_id, target: storedTitle,
      detail: `retired "${storedTitle}" (${state})${reason ? `: ${reason}` : ''}`, dryRun,
    });
    return res;
  }

  /**
   * Refresh the home page's live rails (sub-page index etc.) and append a Log
   * note — used after a caller-requested sub-page write so the new page shows
   * up in the home's index immediately rather than at the next full curation.
   * Callers must ensure the project already has a wiki home — wiki-write would
   * otherwise create a near-empty one.
   */
  async refreshHome(project: string, logEntry: string, dryRun: boolean): Promise<void> {
    await this.call('wiki-write', {
      project,
      refresh_live: true,
      dry_run: dryRun,
      sections: [{ name: 'Log', mode: 'append', content: logEntry }],
    });
    this.recorder?.record({
      action: 'wiki-written', target: project,
      detail: `refreshed wiki home index for "${project}"`, dryRun,
    });
  }

  /** Public-web search via the engine's EXA-gated web-search tool. */
  async webSearch(query: string, numResults = 5): Promise<WebSearchResult[]> {
    const data = await this.call<{ results?: WebSearchResult[] }>('web-search', { query, num_results: numResults });
    return data.results ?? [];
  }

  /** List durable memories via the engine's list-memories tool (typically filtered to source:'curator'). */
  async listMemories(filters: {
    includeProvenance?: boolean;
    source?: string;
    scope?: string;
    node_id?: string;
    category?: string;
    evidence_node_id?: string;
    evidence_ref?: string;
    limit?: number;
  }): Promise<Memory[]> {
    const { includeProvenance, ...args } = filters;
    const result = await this.call<{ memories?: Memory[]; total?: number }>('list-memories', { ...args, ...(includeProvenance ? { include_provenance: true } : {}) });
    return result.memories ?? [];
  }

  /** Persist one durable memory via the engine's create-memory tool. The engine
   *  runs its own vector/FTS dedup and throws EngineError('DUPLICATE_MEMORY') on a
   *  near-duplicate — callers classify that as non-fatal. A gray-band match goes to the
   *  Engine's consolidation model, whose verdict comes back as `operation`: `noop` means
   *  the fact was already known and nothing was written, so it is not journaled (#298).
   *  `usage` puts that model call on the Curator's account, under this run. */
  async createMemory(args: {
    source: string;
    scope: 'vault' | 'node';
    node_id?: string;
    content: string;
    category?: string;
    /** Provenance blob stored as metadata_json (engine create-memory `metadata` param). */
    metadata?: Record<string, unknown>;
    /** Who or what the memory is about, by name (#554). The Engine resolves them. */
    subjects?: string[];
    /** First-class provenance (Memories v3 §3). REQUIRED by the engine once P2 enforcement flips. */
    evidence?: { kind: 'note' | 'curation-run' | 'conversation'; node_id?: string; hash?: string; ref?: string };
    /** The run (and source) the consolidation call, if any, is spent under; `purpose` names a run
     *  paid from its own limit (#659), so the daily tally leaves the call out. */
    usage?: { runRef: string; sourceRef?: string; purpose?: 'memory-consolidation-run' };
  }, opts: {
    /** Where the consolidation call's cost goes, in place of the process-wide observer (the daily cap's
     *  tally): a memory extraction run charges its own limit (#659). */
    onSpend?: (usd: number | null) => void;
    /** False: record no journal action. A run journals one summary for everything it wrote. */
    journal?: boolean;
  } = {}): Promise<{ id: number; operation: MemoryCreateOperation; consolidationFailure?: string; superseded: number[]; updatedAt?: string }> {
    const { usage, ...rest } = args;
    const { data: res, warnings } = await this.callWithWarnings<{ id: number; operation?: string; superseded?: Array<{ id: number }>; consolidation_cost_usd?: number | null; updated_at?: string }>('create-memory', {
      ...rest,
      ...(usage ? { usage: {
        service: 'curator', run_ref: usage.runRef,
        ...(usage.sourceRef !== undefined ? { source_ref: usage.sourceRef } : {}),
        ...(usage.purpose !== undefined ? { purpose: usage.purpose } : {}),
      } } : {}),
    }, CREATE_MEMORY_TIMEOUT_MS);
    // Only a call made on the Curator's account counts against its cap.
    if (usage && res.consolidation_cost_usd !== undefined) {
      const cost = res.consolidation_cost_usd;
      try { (opts.onSpend ?? this.spendObserver)?.(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null); }
      catch (error) { console.warn(`[curator] consolidation spend not counted: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const operation: MemoryCreateOperation = res.operation === 'noop' || res.operation === 'update' || res.operation === 'contradict'
      ? res.operation : 'add';
    const replaced = res.superseded?.map(m => m.id) ?? [];
    if (operation !== 'noop' && opts.journal !== false) {
      this.recorder?.record({
        action: 'memory-created', nodeId: args.node_id, target: args.category ?? args.scope,
        detail: `memory: "${args.content.length > 120 ? `${args.content.slice(0, 120)}…` : args.content}"`
          + (replaced.length > 0 ? ` (${operation === 'update' ? 'refines' : 'supersedes'} memory ${replaced.join(', ')})` : ''),
      });
    }
    // The Engine added this memory without merging it, because its consolidation call failed (#346).
    const failure = warnings?.find(w => w.code === 'MEMORY_CONSOLIDATION_FAILED');
    return {
      id: res.id, operation, superseded: operation === 'noop' ? [] : replaced,
      ...(typeof res.updated_at === 'string' ? { updatedAt: res.updated_at } : {}),
      ...(failure ? { consolidationFailure: failure.message } : {}),
    };
  }

  /** One memory's state, for undoing what a run wrote (#659); null when there is no such memory. */
  async getMemoryState(id: number): Promise<MemoryState | null> {
    try {
      return await this.call<MemoryState>('get-memory', { id });
    } catch (error) {
      if (error instanceof EngineError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  /** Retire a memory with no journal action (#659): what it reads now, its `updated_at` included. */
  async retireMemory(id: number, reason: string): Promise<MemoryState> {
    return this.call<MemoryState>('expire-memory', { id, reason });
  }

  /** Bring a retired memory back (expire-memory reactivate). A memory retired again meanwhile is a CONFLICT. */
  async reactivateMemory(id: number, reason: string): Promise<MemoryState> {
    return this.call<MemoryState>('expire-memory', { id, reason, reactivate: true });
  }

  /** Retire a memory via expire-memory (Memories v3). Every automated expiry is
   *  journaled here — the one place §4a re-verify and §4c reconciliation both
   *  route through. Never used for reactivate. */
  async expireMemory(args: { id: number; reason: string; superseded_by?: number; unless_subjects_apart?: boolean }): Promise<void> {
    await this.call('expire-memory', args);
    this.recorder?.record({
      action: 'memory-expired', target: args.reason,
      detail: `memory ${args.id} expired (${args.reason})${args.superseded_by !== undefined ? ` → superseded by ${args.superseded_by}` : ''}`,
    });
  }

  /** Conversation metadata for the conversation sweep. Archived conversations
   *  are INCLUDED by default — archived means "done with it", which is exactly
   *  the settled state the sweep wants. */
  async listConversations(args: { includeArchived?: boolean; includeLinkedDocs?: boolean } = {}): Promise<ConversationMeta[]> {
    const request: Record<string, unknown> = {
      include_archived: args.includeArchived ?? true,
    };
    if (args.includeLinkedDocs !== undefined) request.include_linked_docs = args.includeLinkedDocs;
    const data = await this.call<{ conversations?: ConversationMeta[] }>('list-conversations', request);
    return data.conversations ?? [];
  }

  /** One conversation with its ordered messages. Messages are OPAQUE AI-SDK
   *  blobs — flatten them with `@vault/chat-core/transcript`, never by reaching
   *  into the shape here. */
  async getConversation(id: string): Promise<{ conversation: ConversationMeta; messages: unknown[]; linked_docs: string[] }> {
    const data = await this.call<{ conversation: ConversationMeta; messages?: unknown[]; linked_docs?: string[] }>(
      'get-conversation', { id },
    );
    return {
      conversation: data.conversation,
      messages: data.messages ?? [],
      linked_docs: data.linked_docs ?? data.conversation.linked_docs ?? [],
    };
  }

  /** Append a capture block through the Engine's optimistic-concurrency guard.
   *  Warnings are returned for both preview and live requests. */
  async appendCapturedContent(args: {
    nodeId: string;
    text: string;
    expectedVersion: number;
    dryRun: boolean;
    conversationAuthority?: ConversationAuthorityGuard;
  }): Promise<{ warnings: Issue[] }> {
    const request: Record<string, unknown> = {
      node_id: args.nodeId,
      append_body: args.text,
      expected_version: args.expectedVersion,
      dry_run: args.dryRun,
    };
    if (args.conversationAuthority !== undefined) {
      request.conversation_authority = conversationAuthorityWire(args.conversationAuthority);
    }
    const result = await this.callWithWarnings('update-node', request);
    return { warnings: result.warnings };
  }

  /**
   * Find bounded *candidates* for a capture ID. FTS only identifies possible
   * matches; callers must validate capture-block markers with parseCaptureBlocks.
   */
  async findNodesContainingCaptureId(captureId: string): Promise<EngineNode[]> {
    return this.findCaptureCandidates(captureIdMarkerQuery(captureId), 20);
  }

  /**
   * Find bounded *candidates* scoped by an encoded conversation marker
   * attribute. FTS identifies possible matches only: Task 9 parses candidate
   * bodies with the authoritative parseCaptureBlocks helper before recovery
   * uses them.
   */
  async findNodesContainingConversationCapture(conversationId: string): Promise<EngineNode[]> {
    return this.findCaptureCandidates(conversationCaptureMarkerQuery(conversationId), 200);
  }

  private async findCaptureCandidates(fullText: string, limit: number): Promise<EngineNode[]> {
    const data = await this.call<{ nodes?: Array<{ id: string }> }>('query-nodes', {
      full_text: fullText,
      select: ['id'],
      limit,
    });
    return Promise.all((data.nodes ?? []).map(node => this.getNode(node.id)));
  }

  /** FTS5 search over memories (a list-memories query) — the conversation sweep's relevance-targeted
   *  ALREADY KNOWN block. `query` MUST be FTS5-safe; build it with `ftsQuery`
   *  in conversation-sweep.ts rather than passing raw user text. */
  async searchMemories(args: { query: string; source?: string; limit?: number }): Promise<Memory[]> {
    const data = await this.call<{ memories?: Memory[] }>('list-memories', args);
    return data.memories ?? [];
  }

  /** Live cross-source near-pairs in the dedup gray band, distance ascending —
   *  the §4c reconciliation shortlist. Ledger exclusion is CLIENT-side by design
   *  (an exclude param would grow unboundedly with the ledger). */
  async listMemoryNearPairs(args: { near?: number; far?: number; limit?: number }): Promise<{ pairs: NearPair[]; total_in_band: number }> {
    const r = await this.call<{ pairs?: NearPair[]; total_in_band?: number }>('list-memory-near-pairs', args);
    return { pairs: r.pairs ?? [], total_in_band: r.total_in_band ?? 0 };
  }

  /**
   * Every node changed since `modifiedSince` matching the memory-sweep
   * allowlist, newest first. The engine's `types` filter is an INTERSECTION
   * (node must have ALL listed types — query-builder.ts) and query-nodes takes
   * a single path_prefix, so this issues one paged query PER TYPE plus one per
   * prefix — the allowlist is a union — merged by node id. Pages run newest
   * first, so a node edited mid-scan moves to the front and pushes rows later
   * (read twice, deduplicated). A node deleted or leaving the allowlist
   * mid-scan pulls rows earlier instead, so each page re-reads the last
   * `overlap` rows of the one before and must contain its final row; when it
   * doesn't, a row may have slipped past unread. `truncated` is true then, or
   * when a sub-query still had rows after `maxPages` pages — the caller must
   * treat the scan as incomplete (do not advance the sweep watermark).
   */
  async listChangedNodes(args: {
    types: string[];
    pathPrefixes: string[];
    modifiedSince: string;
    /** At least 2, so a page can overlap the one before and still advance. */
    pageSize?: number;
    maxPages?: number;
  }): Promise<{ nodes: ChangedNodeRef[]; truncated: boolean }> {
    const pageSize = Math.max(2, args.pageSize ?? 200);
    const maxPages = args.maxPages ?? 50;
    const overlap = Math.min(20, Math.floor(pageSize / 2));
  const base = {
    modified_since: args.modifiedSince,
    select: ['id', 'file_path', 'title', 'file_mtime'],
    without_fields: ['vault_engine_projection'],
    sort_by: 'file_mtime',
    sort_order: 'desc',
    limit: pageSize,
  };
    const queries: Array<Record<string, unknown>> = [];
    for (const t of args.types) queries.push({ ...base, types: [t] });
    for (const p of args.pathPrefixes) queries.push({ ...base, path_prefix: p });
    const seen = new Map<string, ChangedNodeRef>();
    let truncated = false;
    for (const q of queries) {
      let consumed = 0;
      let lastId: string | undefined;
      for (let page = 0; ; page++) {
        if (page === maxPages) { truncated = true; break; }
        const offset = lastId === undefined ? 0 : consumed - overlap;
        const data = await this.call<{ nodes: Array<{ id: string; title: string; file_path: string; file_mtime?: unknown }> }>(
          'query-nodes', { ...q, offset });
        if (lastId !== undefined && !data.nodes.some(n => n.id === lastId)) truncated = true;
        for (const n of data.nodes) {
          if (!seen.has(n.id)) {
            seen.set(n.id, { id: n.id, title: n.title, file_path: n.file_path,
              ...(typeof n.file_mtime === 'number' ? { file_mtime: n.file_mtime } : {}) });
          }
        }
        const last = data.nodes.at(-1);
        if (data.nodes.length < pageSize || last === undefined) break;
        consumed = offset + data.nodes.length;
        lastId = last.id;
      }
    }
    return { nodes: [...seen.values()].sort((a, b) => (b.file_mtime ?? 0) - (a.file_mtime ?? 0)), truncated };
  }

  /** The schema catalog — the org sweep's type list + directory routing table. */
  async listSchemas(): Promise<SchemaRef[]> {
    const data = await this.call<Array<{ name: string; display_name?: string | null; default_directory?: string | null; has_schema?: boolean }>>('list-schemas', {});
    // list-schemas also lists types used on nodes without a schema; the catalog is schemas only.
    return data.filter(s => s.has_schema !== false).map(s => ({
      name: s.name,
      display_name: s.display_name ?? null,
      default_directory: s.default_directory ?? null,
    }));
  }

  /** Every node type currently in use (drives the untyped-node exclusion query). */
  async listTypes(): Promise<string[]> {
    const data = await this.call<Array<{ name: string; node_count: number }>>('list-schemas', {});
    return data.filter(t => t.node_count > 0).map(t => t.name);
  }

  /**
   * Every node with NO type, newest-first. `without_types` is a NOT-ANY filter,
   * so excluding every in-use type yields exactly the untyped set. Paginates each
   * scope to exhaustion BEFORE the caller mutates anything (add-type shifts
   * offsets mid-scan otherwise), deduped by id. `truncated` = a scope hit
   * maxPages — the scan is incomplete but the sweep may still proceed (unlike
   * the memory sweep there is no watermark to protect).
   */
  async listUntypedNodes(args: {
    pathPrefixes: string[]; pageLimit?: number; maxPages?: number;
    /** More query-nodes filters to narrow the set with (an on-demand typing run's scope, #644). */
    filter?: Record<string, unknown>;
    /** Notes to leave out as the listing is read. A note left out does not count toward `maxNodes`. */
    keep?: (node: OrgNodeRef) => boolean;
    /** Stop once this many notes are kept. The listing then says it is truncated: more may follow. */
    maxNodes?: number;
  }): Promise<{ nodes: OrgNodeRef[]; truncated: boolean }> {
    const allTypes = await this.listTypes();
    const pageLimit = args.pageLimit ?? 200;
    const maxPages = args.maxPages ?? 50;
    const scopes: Array<string | null> = args.pathPrefixes.length > 0 ? args.pathPrefixes : [null];
    const seen = new Map<string, OrgNodeRef>();
    let truncated = false;
    for (const prefix of scopes) {
      for (let page = 0; ; page++) {
        if (page >= maxPages) { truncated = true; break; }
      const q: Record<string, unknown> = {
        ...args.filter,
        without_types: allTypes,
        without_fields: ['vault_engine_projection'],
        select: ['id', 'file_path', 'title', 'types', 'version'],
        sort_by: 'file_mtime',
        sort_order: 'desc',
        limit: pageLimit,
        offset: page * pageLimit,
      };
        if (prefix !== null) q.path_prefix = prefix;
        const data = await this.call<{ nodes: OrgNodeRef[] }>('query-nodes', q);
        for (const n of data.nodes) {
          if (seen.has(n.id) || (args.keep !== undefined && !args.keep(n))) continue;
          seen.set(n.id, n);
          if (args.maxNodes !== undefined && seen.size >= args.maxNodes) return { nodes: [...seen.values()], truncated: true };
        }
        if (data.nodes.length < pageLimit) break;
      }
    }
    return { nodes: [...seen.values()], truncated };
  }

  /**
   * Notes a query selects, newest first, with each one's content hash: a memory extraction run's
   * scope (#659). Suite notes are left out. `keep` leaves notes out as the listing is read; a note
   * left out does not count toward `maxNodes`. An Engine from before #659 returns no content hash:
   * `content_hash` is then undefined, and the run finds a note already read when it reads it.
   */
  async listNotesWithHashes(args: {
    filter?: Record<string, unknown>; pageLimit: number; maxPages: number; maxNodes: number;
    keep?: (node: HashedNodeRef) => boolean;
  }): Promise<{ nodes: HashedNodeRef[]; truncated: boolean }> {
    const seen = new Map<string, HashedNodeRef>();
    for (let page = 0; ; page++) {
      if (page >= args.maxPages) return { nodes: [...seen.values()], truncated: true };
      const data = await this.call<{ nodes: HashedNodeRef[] }>('query-nodes', {
        ...args.filter,
        without_fields: ['vault_engine_projection'],
        select: ['id', 'file_path', 'title', 'types', 'version', 'content_hash'],
        sort_by: 'file_mtime',
        sort_order: 'desc',
        limit: args.pageLimit,
        offset: page * args.pageLimit,
      });
      for (const n of data.nodes) {
        if (seen.has(n.id) || (args.keep !== undefined && !args.keep(n))) continue;
        seen.set(n.id, n);
        if (seen.size >= args.maxNodes) return { nodes: [...seen.values()], truncated: true };
      }
      if (data.nodes.length < args.pageLimit) return { nodes: [...seen.values()], truncated: false };
    }
  }

  /** Nodes sitting directly in each directory (non-recursive; '' = vault root). */
  async listNodesInDirs(dirs: string[], limit = 200): Promise<{ nodes: OrgNodeRef[]; truncated: boolean }> {
    const seen = new Map<string, OrgNodeRef>();
    let truncated = false;
    for (const dir of dirs) {
    const data = await this.call<{ nodes: OrgNodeRef[] }>('query-nodes', {
      path_dir: dir,
      without_fields: ['vault_engine_projection'],
      select: ['id', 'file_path', 'title', 'types', 'version'],
      limit,
    });
      if (data.nodes.length >= limit) truncated = true;
      for (const n of data.nodes) if (!seen.has(n.id)) seen.set(n.id, n);
    }
    return { nodes: [...seen.values()], truncated };
  }

  /** Add a schema-backed type to a node (claimed field defaults auto-populate).
   *  `title` is a human label for the journal only. */
  async addTypeToNode(nodeId: string, type: string, expectedVersion?: number, title?: string): Promise<void> {
    const args: Record<string, unknown> = { node_id: nodeId, add_types: [type] };
    if (expectedVersion !== undefined) args.expected_version = expectedVersion;
    await this.call('update-node', args);
    this.recorder?.record({
      action: 'typed', nodeId, target: title ?? nodeId,
      detail: `typed "${title ?? nodeId}" → ${type}`,
    });
  }

  /**
   * Give an untyped note a type, for an on-demand typing run (#644): only if the note is still at
   * `expectedVersion` (it had no type then), with no journal line of its own (a run journals one
   * summary), and returning the Engine's undo operation so the run can be undone as one request.
   * A dry run checks the write and changes nothing.
   */
  async addTypeCas(input: { nodeId: string; type: string; expectedVersion: number; dryRun: boolean }): Promise<{ operationId: string | null }> {
    const data = await this.call<{ operation_id?: unknown }>('update-node', {
      node_id: input.nodeId, add_types: [input.type], expected_version: input.expectedVersion, dry_run: input.dryRun,
    });
    return { operationId: typeof data?.operation_id === 'string' ? data.operation_id : null };
  }

  /**
   * A page of the live memories with no subjects, in id order after `afterId`, each with its source
   * note's title and the entity names that note is or links to: the model pass's scope (#554).
   */
  async listSubjectPassMemories(afterId: number, limit: number): Promise<SubjectPassPage> {
    const data = await this.call<Partial<SubjectPassPage>>('memory-subject-pass', { action: 'list', after_id: afterId, limit });
    return { memories: data.memories ?? [], total: data.total ?? 0, next_after_id: data.next_after_id ?? null };
  }

  /** Give memories that still have no subjects the model's names, marked set_by "model". `dryRun` reports how they resolve. */
  async writeModelSubjects(items: ReadonlyArray<{ memory_id: number; subjects: readonly string[] }>, dryRun: boolean): Promise<SubjectPassWrite> {
    const data = await this.call<Partial<SubjectPassWrite>>('memory-subject-pass', {
      action: 'write', items: items.map(item => ({ memory_id: item.memory_id, subjects: [...item.subjects] })), dry_run: dryRun,
    });
    return { results: data.results ?? [], memories: data.memories ?? 0, subjects: data.subjects ?? 0 };
  }

  /** Take back out the subjects of these writes (memory id and `written_at`), later writes left alone: a subject run's undo. */
  async clearModelSubjects(writes: ReadonlyArray<{ memory_id: number; written_at: string }>, dryRun: boolean): Promise<{ cleared: number[]; subjects: number }> {
    const data = await this.call<{ cleared?: number[]; subjects?: number }>('memory-subject-pass', {
      action: 'clear', writes: writes.map(write => ({ memory_id: write.memory_id, written_at: write.written_at })), dry_run: dryRun,
    });
    return { cleared: data.cleared ?? [], subjects: data.subjects ?? 0 };
  }

  /** The names of the fields a type's notes have, in the type's own order. */
  async schemaFieldNames(type: string): Promise<string[]> {
    const data = await this.call<{ fields?: Array<{ name?: unknown }> }>('describe-schema', { name: type });
    return (data.fields ?? []).map(field => field.name).filter((name): name is string => typeof name === 'string');
  }

  /** Move a node to `directory` keeping its filename and identity; update-node
   *  rewrites path-qualified references. `title` labels the journal entry. */
  async moveNode(nodeId: string, title: string, directory: string, expectedVersion?: number): Promise<void> {
    const args: Record<string, unknown> = { node_id: nodeId, set_directory: directory };
    if (expectedVersion !== undefined) args.expected_version = expectedVersion;
    await this.call('update-node', args);
    this.recorder?.record({
      action: 'moved', nodeId, target: title,
      detail: `moved "${title}" → ${directory}/`,
    });
  }

  /** listMemories variant that also surfaces the engine's total row count —
   *  the sweep's live-stock observability line, and the wiki memory selection's limits. */
  /** Memories flagged after a failed merge, waiting for replay-memory-consolidation (#354). */
  async consolidationPendingTotal(): Promise<number> {
    const status = await this.call<{ pending_total?: unknown }>('replay-memory-consolidation', { action: 'status' });
    if (typeof status.pending_total !== 'number') throw new Error('replay status omitted pending_total');
    return status.pending_total;
  }

  async listMemoriesWithTotal(filters: {
    includeProvenance?: boolean;
    /** FTS5 query; results rank by relevance. */
    query?: string;
    source?: string;
    scope?: string;
    node_id?: string;
    category?: string;
    /** Memories drawn from any of these notes. */
    evidence_node_ids?: readonly string[];
    /** A node id: only memories of the project(s) it is filed under (itself, for a project), listed
     *  most specific first: the project's own note, then notes filed under the fewest projects. */
    project_of?: string;
    /** Only these memories, by id; live ones only (#474). */
    ids?: readonly number[];
    /** A node id: the memories about that note, by their subjects (#554); live ones, newest first. */
    subject_of?: string;
    /** Only memories expired for one of these reasons, none live (#717). */
    expire_reasons?: readonly string[];
    /** With `ids`: expired memories too. */
    include_superseded?: boolean;
    limit?: number;
  }): Promise<{ memories: Memory[]; total: number | null }> {
    const { includeProvenance, ...args } = filters;
    const result = await this.call<{ memories?: Memory[]; total?: number }>('list-memories', { ...args, ...(includeProvenance ? { include_provenance: true } : {}) });
    return { memories: result.memories ?? [], total: result.total ?? null };
  }

  /** Report one LLM call to the engine's spend ledger. Callers wrap best-effort. */
  async recordUsage(args: Record<string, unknown>): Promise<void> {
    // An ambiguous response may follow a committed insert. Never replay an
    // append-only accounting write through the generic reconnect/retry path.
    await this.ensureConnected();
    try { await this.invoke<unknown>('record-usage', args); }
    catch (error) { if (!(error instanceof EngineError)) this.connected = false; throw error; }
  }

  /** Read-only accounting; retain warnings about unknown pricing. */
  async usageReport(args: Record<string, unknown>): Promise<{ data: {
    groups: Array<Record<string, unknown>>; group_count?: number; totals: Record<string, unknown>;
  }; warnings: Issue[] }> {
    return this.callWithWarnings('usage-report', args);
  }

  /** Engine settings read — Phase 2 service-side consumption surface. Omit
   *  `domain` to fetch every domain plus the read-only "models" pseudo-domain
   *  (Settings/Models/ catalog) in one call. */
  async getSettings(domain?: string): Promise<{ settingsDir?: string; domains: Record<string, SettingsDomainPayload | ModelsDomainPayload> }> {
    return this.call('get-settings', domain !== undefined ? { domain } : {});
  }

  /** Engine settings write — used for one-shot service-side seeding of the curator
   *  domain. Returns the envelope's `warnings` (e.g. one `SETTINGS_MODEL_REF_UNRESOLVED`
   *  per rejected key) so callers can log which seeded keys the engine's contextual
   *  validation rejected (seed-drop delta logging). */
  async updateSettings(domain: string, patch: Record<string, unknown>): Promise<{ warnings: Issue[] }> {
    const { warnings } = await this.callWithWarnings<unknown>('update-settings', { domain, patch });
    return { warnings };
  }

  async registerPromptDefaults(domain: string, defaults: Record<string, string>): Promise<{ warnings: Issue[] }> {
    const { warnings } = await this.callWithWarnings<unknown>('register-prompt-defaults', { domain, defaults });
    return { warnings };
  }

  /** Fetch one public page's readable text via the engine's SSRF-guarded fetch-url tool. */
  fetchUrl(url: string): Promise<{ url: string; content: string }> {
    return this.call<{ url: string; content: string }>('fetch-url', { url });
  }

  private static unwrapFieldValue(raw: unknown): unknown {
    if (raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)) {
      return (raw as { value: unknown }).value;
    }
    return raw;
  }

  /** Read several fields off one node in a single get-node (tolerates {value} envelopes). */
  async readNodeFields(nodeId: string, names: string[]): Promise<Record<string, unknown>> {
    const node = await this.getNode(nodeId);
    const out: Record<string, unknown> = {};
    for (const name of names) out[name] = Engine.unwrapFieldValue(node.fields?.[name]);
    return out;
  }

  /** Read a single scalar field value off a node (tolerates the {value,...} envelope). */
  async readNodeField(nodeId: string, field: string): Promise<unknown> {
    return (await this.readNodeFields(nodeId, [field]))[field];
  }

  /** Mark a note as the suite's own (#600), e.g. `journal`: the marker keeps it out of every
   *  evidence path. Machinery bookkeeping, so not journaled. */
  async markSuiteNote(nodeId: string, kind: string): Promise<void> {
    await this.call('update-node', { node_id: nodeId, set_fields: { vault_engine_projection: kind }, dry_run: false });
  }

  /** Notes whose title contains `text`, with whether each already carries the suite marker (#600). */
  async listNotesTitled(text: string, limit = 200): Promise<Array<{ id: string; title: string; marked: boolean }>> {
    const data = await this.call<{ nodes: Array<{ id: string; title: string; fields?: Record<string, unknown> }> }>('query-nodes', {
      title_contains: text, include_fields: ['vault_engine_projection'], select: ['id', 'title'], limit,
    });
    return data.nodes.map(node => ({
      id: node.id, title: node.title,
      marked: node.fields !== undefined && Object.prototype.hasOwnProperty.call(node.fields, 'vault_engine_projection'),
    }));
  }

  /** Patch fields on a node. A patch touching ONLY wiki lifecycle stamps is
   *  machinery bookkeeping and is not journaled. `title` is a label for the
   *  journal only. */
  async updateNodeFields(nodeId: string, fields: Record<string, unknown>, title?: string): Promise<void> {
    await this.call('update-node', { node_id: nodeId, set_fields: fields, dry_run: false });
    const keys = Object.keys(fields);
    if (keys.every((k) => WIKI_STAMP_FIELDS.has(k))) return;
    this.recorder?.record({
      action: 'fields-updated', nodeId, target: title ?? nodeId,
      detail: `set ${keys.map((k) => `${k}=${String(fields[k])}`).join(', ')} on "${title ?? nodeId}"`,
    });
  }

  updateNodeFieldsCas(input: UpdateNodeFieldsCasInput): Promise<unknown> {
    return this.call('update-node', {
      node_id: input.nodeId,
      set_fields: input.setFields,
      expected_version: input.expectedVersion,
      expected_content_hash: input.expectedContentHash,
      field_guess_guard: input.guard,
      dry_run: input.dryRun,
    });
  }

  /** Undo the given operations (a run's own writes). Ids that are no longer active come back in
   *  `not_found`; notes changed since are conflicts and are left as they are. Dry run by default. */
  async undoOperations(operationIds: readonly string[], dryRun: boolean): Promise<UndoOperationsResult> {
    const data = await this.call<Partial<UndoOperationsResult>>('undo-operations', {
      operation_ids: [...operationIds], skip_missing: true, dry_run: dryRun,
    });
    return {
      dry_run: data.dry_run ?? dryRun,
      total_undone: data.total_undone ?? 0,
      total_conflicts: data.total_conflicts ?? 0,
      total_skipped: data.total_skipped ?? 0,
      conflicts: data.conflicts ?? [],
      not_found: data.not_found ?? [],
    };
  }

  /** Refresh the Settings/Memories.md projection (Task 9). Returns whether the
   *  file was written and a summary. Never invokes an LLM. */
  async refreshMemoryNote(dryRun: boolean): Promise<MemoryNoteRefreshResult> {
    return this.call<MemoryNoteRefreshResult>('refresh-memory-note', { dry_run: dryRun });
  }
}

export interface MemoryNoteRefreshResult {
  file_path: string;
  node_id: string | null;
  live_count: number;
  historical_count: number;
  total: number;
  rendered_hash: string;
  bytes: number;
  would_write: boolean;
  file_written: boolean;
  issues_rendered: number;
  snapshot_at: string;
}
