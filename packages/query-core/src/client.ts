import type { ClassifyNodesInput, ClassifyNodesResult } from './classification-types.js';
import type {
  ProvenanceImpactData,
  ProvenanceImpactRequest,
  ProvenanceInspectRequest,
  ProvenanceInspectData,
} from "./provenance-types.js";
import type { ReadRollupsRequest, ReadRollupsData } from "./rollup-types.js";
import type { TraversalRequest, TraversalData } from './traversal-types.js';
import type { SummaryRequest, SummaryData } from "./summary-types.js";
/**
 * Typed wrappers around app.callServerTool with envelope unwrap.
 * Single chokepoint for tool calls — render/flows never call the SDK directly.
 *
 * M1: queryNodes / describeSchema / describeGlobalField / listFieldValues.
 * M3: updateNode / renameNode / getNode are now wired.
 */
import { makeCall, type CallFn } from "./call.js";
import type {
  Envelope, QueryArgs, QueryNodesData, Schema,
  UpdateDryRunData, UpdateCommitData, RenameData, CurrentNode,
  CreateDryRunData, CreateCommitData,
  BatchOp, BatchDryRunData, BatchCommitData,
  ReferenceMemberEdit, ReferenceEditCommitData, ReferenceEditPreviewData,
  MemoryList,
} from "./types.js";

export interface Client {
  classifyNodes(args: ClassifyNodesInput): Promise<Envelope<ClassifyNodesResult>>;
  findAffectedOutputs(args: ProvenanceImpactRequest): Promise<Envelope<ProvenanceImpactData>>;
  inspectProvenance(args: ProvenanceInspectRequest): Promise<Envelope<ProvenanceInspectData>>;
  readRollups(args: ReadRollupsRequest): Promise<Envelope<ReadRollupsData>>;
  traverseNodes(args: TraversalRequest): Promise<Envelope<TraversalData>>;
  summarizeNodes(args: SummaryRequest): Promise<Envelope<SummaryData>>;
  queryNodes(args: QueryArgs): Promise<Envelope<QueryNodesData>>;
  describeSchema(name: string, include?: Array<"coverage" | "orphans" | "overrides" | "relationship_views" | "classification">): Promise<Envelope<Schema>>;
  describeGlobalField(name: string): Promise<Envelope<Record<string, unknown>>>;
  listFieldValues(field: string): Promise<Envelope<{ values: string[] }>>;
  updateNode(args: {
    node_id: string;
    set_fields?: Record<string, unknown>;
    expected_version?: number;
    dry_run?: boolean;
  }): Promise<Envelope<UpdateDryRunData | UpdateCommitData>>;
  renameNode(args: {
    node_id: string;
    new_title: string;
    expected_version?: number;
  }): Promise<Envelope<RenameData>>;
  /** Commit one add or remove on a list-of-references field (update-node
   *  `reference_edit`). The other members are left exactly as stored. */
  editReferenceMember(args: {
    node_id: string;
    reference_edit: ReferenceMemberEdit;
    expected_version: number;
    expected_content_hash?: string;
  }): Promise<Envelope<ReferenceEditCommitData>>;
  /** The same edit as a preview: what it would change, nothing written. */
  previewReferenceMember(args: {
    node_id: string;
    reference_edit: ReferenceMemberEdit;
    expected_version: number;
  }): Promise<Envelope<ReferenceEditPreviewData>>;
  getNode(args: ({ node_id: string; file_path?: never } | { file_path: string; node_id?: never }) & { include_embeds?: boolean }): Promise<Envelope<CurrentNode>>;
  /** list-memories, newest first by when each became true. `subject_of` is a note's id: the memories about it. */
  listMemories(args: { subject_of?: string; limit?: number; offset?: number }): Promise<Envelope<MemoryList>>;
  createNode(args: {
    title: string;
    types: string[];
    fields?: Record<string, unknown>;
    body?: string;
    directory?: string;
    dry_run?: boolean;
  }): Promise<Envelope<CreateDryRunData | CreateCommitData>>;
  deleteNode(args: {
    node_id: string;
    confirm?: boolean;
    dry_run?: boolean;
    expected_version?: number;
  }): Promise<Envelope<unknown>>;
  /** All node types (data is a flat array of {type,count,has_schema,...}). */
  listTypes(): Promise<Envelope<TypeSummary[]>>;
  batchMutate(args: {
    operations: BatchOp[];
    dry_run?: boolean;
  }): Promise<Envelope<BatchDryRunData | BatchCommitData>>;
}

/** A type in use on nodes, as the type pickers and counts consume it. */
export interface TypeSummary {
  type: string;
  count: number;
  has_schema: boolean;
  claim_count: number | null;
}

/** The list-schemas row fields this client reads (engine src/mcp/tools/list-schemas.ts). */
interface TypeCatalogRow {
  name: string;
  node_count: number;
  has_schema: boolean;
  claim_count: number | null;
}

/** list-schemas rows narrowed to the types in use, most-used first (the former list-types view). */
export function typesInUse(rows: readonly TypeCatalogRow[]): TypeSummary[] {
  return rows
    .filter((row) => row.node_count > 0)
    .map((row) => ({ type: row.name, count: row.node_count, has_schema: row.has_schema, claim_count: row.claim_count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

export function makeClient(callServerTool: CallFn): Client {
  const call = makeCall(callServerTool);

  return {
    findAffectedOutputs: (args) => call<ProvenanceImpactData>("find-affected-outputs", args as unknown as Record<string, unknown>),
    inspectProvenance: (args) => call<ProvenanceInspectData>("inspect-provenance", args as unknown as Record<string, unknown>),
    classifyNodes: (args) => call<ClassifyNodesResult>("classify-nodes", args as unknown as Record<string, unknown>),
    readRollups: (args) => call<ReadRollupsData>("read-rollups", args as unknown as Record<string, unknown>),
    traverseNodes: (args) => call<TraversalData>("traverse-nodes", args as unknown as Record<string, unknown>),
    summarizeNodes: (args) => call<SummaryData>("summarize-nodes", args as unknown as Record<string, unknown>),
    queryNodes: (args) => call<QueryNodesData>("query-nodes", args as Record<string, unknown>),
    describeSchema: (name, include) => call<Schema>("describe-schema", { name, ...(include ? { include } : {}) }),
    describeGlobalField: (name) => call<Record<string, unknown>>("describe-global-field", { name }),
    listFieldValues: (field) => call<{ values: string[] }>("list-field-values", { field }),
    updateNode: (args) => call<UpdateDryRunData | UpdateCommitData>("update-node", args as Record<string, unknown>),
    // A title edit is update-node set_title (the engine retired rename-node).
    renameNode: ({ new_title, ...rest }) => call<RenameData>("update-node", { ...rest, set_title: new_title }),
    // reference_edit previews by default; this call is the commit.
    editReferenceMember: (args) => call<ReferenceEditCommitData>("update-node", { ...args, dry_run: false }),
    previewReferenceMember: (args) => call<ReferenceEditPreviewData>("update-node", { ...args, dry_run: true }),
    getNode: (args) => call<CurrentNode>("get-node", args as Record<string, unknown>),
    listMemories: (args) => call<MemoryList>("list-memories", args as Record<string, unknown>),
    createNode: (args) => call<CreateDryRunData | CreateCommitData>("create-node", args as Record<string, unknown>),
    deleteNode: (args) => call<unknown>("delete-node", args as Record<string, unknown>),
    listTypes: async () => {
      const env = await call<TypeCatalogRow[]>("list-schemas", {});
      return env.ok ? { ...env, data: typesInUse(env.data) } : env;
    },
    batchMutate: (args) => call<BatchDryRunData | BatchCommitData>("batch-mutate", args as unknown as Record<string, unknown>),
  };
}
