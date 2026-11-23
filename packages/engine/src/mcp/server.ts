import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { WriteLockManager } from '../sync/write-lock.js';
import type { SyncLogger } from '../sync/sync-logger.js';
import type { ExtractorRegistry } from '../extraction/registry.js';
import type { ExtractionCache } from '../extraction/cache.js';
import type { EmbeddingIndexer } from '../search/indexer.js';
import type { Embedder } from '../search/embedder.js';
import type { TranscriptStore } from '../extraction/transcript-store.js';
import type { WebSearchProvider } from '../web/provider.js';
import type { KnownWebAddresses } from '../web/known-addresses.js';
import type { UsageRecorder } from '../usage/recorder.js';
import type { MemoryConsolidator } from './tools/memory-consolidation.js';
import type { MemoryService } from '../memories/service.js';
import type { MemoryNoteIngest } from '../memories/note-ingest.js';
import type { MemoryNoteReceipts } from '../memories/note-receipts.js';
import type { MemoryNoteProjection } from '../memories/note-projection.js';
import type { SettingsService } from '../settings/service.js';
import type { NoteWriterDeps } from '../settings/note.js';
import type { ModelCatalog } from '../settings/models.js';
import { registerAllTools } from './tools/index.js';
import { registerQueryNodesUi } from './ui/query-nodes/register.js';
import { registerToolsForSurface, type ToolSurface } from './tool-surface.js';
import { registerPrompts } from './prompts.js';
import { treatBlankOptionalParamsAsAbsent } from './blank-params.js';

export interface ServerContext {
  db: Database.Database;
  writeLock?: WriteLockManager;
  syncLogger?: SyncLogger;
  vaultPath?: string;
  attachmentDir?: string;
  extractorRegistry?: ExtractorRegistry;
  extractionCache?: ExtractionCache;
  embeddingIndexer?: EmbeddingIndexer;
  embedder?: Embedder;
  memoryConsolidator?: MemoryConsolidator;
  memoryService?: MemoryService;
  memoryNoteIngest?: MemoryNoteIngest;
  memoryNoteReceipts?: MemoryNoteReceipts;
  memoryNoteProjection?: MemoryNoteProjection;
  webSearchProvider?: WebSearchProvider;
  /** Addresses web-search returned to each signed-in client; shared by every session. */
  knownWebAddresses?: KnownWebAddresses;
  usageRecorder?: UsageRecorder;
  settingsService?: SettingsService;
  settingsNoteDeps?: NoteWriterDeps;
  modelCatalog?: ModelCatalog;
  /** Fired after add-model refreshes the catalog, so catalog-dependent subsystems
   *  (e.g. the vision extractor set) can re-arm — same callback the Models/ ingest uses. */
  onCatalogChange?: () => void;
}

export function createServer(db: Database.Database, ctx?: {
  writeLock?: WriteLockManager;
  syncLogger?: SyncLogger;
  vaultPath?: string;
  attachmentDir?: string;
  extractorRegistry?: ExtractorRegistry;
  extractionCache?: ExtractionCache;
  embeddingIndexer?: EmbeddingIndexer;
  embedder?: Embedder;
  memoryConsolidator?: MemoryConsolidator;
  memoryService?: MemoryService;
  memoryNoteIngest?: MemoryNoteIngest;
  memoryNoteReceipts?: MemoryNoteReceipts;
  memoryNoteProjection?: MemoryNoteProjection;
  transcriptStore?: TranscriptStore;
  webSearchProvider?: WebSearchProvider;
  /** Addresses web-search returned to each signed-in client; shared by every session. */
  knownWebAddresses?: KnownWebAddresses;
  usageRecorder?: UsageRecorder;
  settingsService?: SettingsService;
  settingsNoteDeps?: NoteWriterDeps;
  modelCatalog?: ModelCatalog;
  onCatalogChange?: () => void;
  /** Tools this session sees; defaults to `full`. See src/mcp/tool-surface.ts. */
  surface?: ToolSurface;
}): McpServer {
  const server = new McpServer({ name: 'vault-engine', version: '0.1.0' });
  treatBlankOptionalParamsAsAbsent(server);
  registerToolsForSurface(server, ctx?.surface ?? 'full', () => registerAllTools(server, db, ctx));
  registerPrompts(server);
  registerQueryNodesUi(server);
  return server;
}
