import { registerClassifyNodes } from './classify-nodes.js';
import { registerProvenance } from './provenance.js';
import { registerReadRollups } from './read-rollups.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { registerVaultStats } from './vault-stats.js';
import { registerListSchemas } from './list-schemas.js';
import { registerDescribeSchema } from './describe-schema.js';
import { registerListGlobalFields } from './list-global-fields.js';
import { registerDescribeGlobalField } from './describe-global-field.js';
import { registerQueryNodes } from './query-nodes.js';
import { registerSummarizeNodes } from './summarize-nodes.js';
import { registerTraverseNodes } from './traverse-nodes.js';
import { registerGetNode } from './get-node.js';
import { registerCreateGlobalField } from './create-global-field.js';
import { registerUpdateGlobalField } from './update-global-field.js';
import { registerRenameGlobalField } from './rename-global-field.js';
import { registerDeleteGlobalField } from './delete-global-field.js';
import { registerCreateSchema } from './create-schema.js';
import { registerUpdateSchema } from './update-schema.js';
import { registerDeleteSchema } from './delete-schema.js';
import { registerValidateNode } from './validate-node.js';
import { registerInferFieldType } from './infer-field-type.js';
import { registerListFieldValues } from './list-field-values.js';
import { registerCreateNode } from './create-node.js';
import { registerUpdateNode } from './update-node.js';
import { registerDeleteNode } from './delete-node.js';
import { registerBatchMutate } from './batch-mutate.js';
import { registerReadEmbedded } from './read-embedded.js';
import { registerListTranscripts } from './list-transcripts.js';
import { registerQuerySyncLog } from './query-sync-log.js';
import { registerQueryEditsLog } from './query-edits-log.js';
import { registerListUndoHistory } from './list-undo-history.js';
import { registerUndoOperations } from './undo-operations.js';
import { registerMaterializeTranscript } from './materialize-transcript.js';
import { registerArchiveSource } from './archive-source.js';
import { registerProjectEvidence } from './project-evidence.js';
import { registerVaultDoctor } from './vault-doctor.js';
import { registerWikiWrite } from './wiki-write.js';
import { registerWikiReconcile } from './wiki-reconcile.js';
import { registerWikiStatus } from './wiki-status.js';
import { registerEmbedAttachment } from './embed-attachment.js';
import { registerBoardTools } from './boards.js';
import { registerConversationTools } from './conversations.js';
import { registerMemoriesTools } from './memories.js';
import { oauthClientLabel } from '../../auth/client-label.js';
import { registerRefreshMemoryNote } from './refresh-memory-note.js';
import { MemoryService } from '../../memories/service.js';
import { registerWebSearch } from './web-search.js';
import { registerFetchUrl } from './fetch-url.js';
import { registerRecordUsage } from './record-usage.js';
import { registerUsageReport } from './usage-report.js';
import { registerGetSettings, registerUpdateSettings } from './settings.js';
import { registerPromptDefaults } from './prompt-defaults.js';
import { registerDiscoverModels } from './discover-models.js';
import { registerAddModel } from './add-model.js';
import { registerListFieldGuessCandidates } from './list-field-guess-candidates.js';
import { registerSurveyNodes } from './survey-nodes.js';
import { registerCleanupReport } from './cleanup-report.js';
import { registerFindDuplicateNodes } from './find-duplicate-nodes.js';
import { registerFindMissingNodes } from './find-missing-nodes.js';
import { registerListInlineTags } from './list-inline-tags.js';
import { registerMergeNodes } from './merge-nodes.js';
import { registerRecoverDates } from './recover-dates.js';
import type { WebSearchProvider } from '../../web/provider.js';
import { KnownWebAddresses } from '../../web/known-addresses.js';
import { resolveAttachmentDir } from '../../pipeline/attachment-dir.js';

export function registerAllTools(server: McpServer, db: Database.Database, ctx?: { writeLock?: import('../../sync/write-lock.js').WriteLockManager; syncLogger?: import('../../sync/sync-logger.js').SyncLogger; vaultPath?: string; attachmentDir?: string; extractionCache?: import('../../extraction/cache.js').ExtractionCache; extractorRegistry?: import('../../extraction/registry.js').ExtractorRegistry; embeddingIndexer?: import('../../search/indexer.js').EmbeddingIndexer; embedder?: import('../../search/embedder.js').Embedder; memoryConsolidator?: import('./memory-consolidation.js').MemoryConsolidator; memoryService?: MemoryService; memoryNoteProjection?: import('../../memories/note-projection.js').MemoryNoteProjection; transcriptStore?: import('../../extraction/transcript-store.js').TranscriptStore; webSearchProvider?: WebSearchProvider; knownWebAddresses?: KnownWebAddresses; usageRecorder?: import('../../usage/recorder.js').UsageRecorder; settingsService?: import('../../settings/service.js').SettingsService; settingsNoteDeps?: import('../../settings/note.js').NoteWriterDeps; modelCatalog?: import('../../settings/models.js').ModelCatalog; onCatalogChange?: () => void }): void {
  registerVaultStats(server, db, ctx?.extractorRegistry, ctx?.embeddingIndexer);
  // One list for the whole process when the caller supplies it; a session of its own otherwise.
  const knownWebAddresses = ctx?.knownWebAddresses ?? new KnownWebAddresses();
  registerFetchUrl(server, undefined, undefined, knownWebAddresses);
  if (ctx?.webSearchProvider) {
    registerWebSearch(server, ctx.webSearchProvider, knownWebAddresses);
  }
  registerVaultDoctor(server, db);
  if (ctx?.usageRecorder) {
    registerRecordUsage(server, ctx.usageRecorder);
  }
  registerUsageReport(server, db);
  registerBoardTools(server, db);
  registerConversationTools(server, db);
  registerMemoriesTools(
    server,
    ctx?.memoryService ?? new MemoryService(db, { embedder: ctx?.embedder, consolidator: ctx?.memoryConsolidator }),
    { editorLabel: (clientId) => oauthClientLabel(db, clientId) },
  );
  if (ctx?.memoryNoteProjection) {
    registerRefreshMemoryNote(server, ctx.memoryNoteProjection);
  }
  registerListSchemas(server, db);
  registerDescribeSchema(server, db);
  registerListGlobalFields(server, db);
  registerDescribeGlobalField(server, db);
  registerQueryNodes(server, db, ctx?.embeddingIndexer, ctx?.embedder);
  registerSummarizeNodes(server, db);
  registerReadRollups(server, db);
  registerClassifyNodes(server, db);
  registerTraverseNodes(server, db);
  registerSurveyNodes(server, db, ctx?.settingsService?.settingsDir);
  registerCleanupReport(server, db, ctx?.settingsService?.settingsDir);
  registerFindDuplicateNodes(server, db, ctx?.settingsService?.settingsDir);
  registerFindMissingNodes(server, db, ctx?.settingsService?.settingsDir);
  registerListInlineTags(server, db, ctx?.settingsService?.settingsDir);
  registerProjectEvidence(server, db);
  registerProvenance(server, db, ctx?.settingsService);
  registerQuerySyncLog(server, db);
  registerQueryEditsLog(server, db);
  registerGetNode(server, db, ctx?.extractionCache, ctx?.vaultPath, ctx?.transcriptStore);
  registerCreateGlobalField(server, db, ctx);
  registerUpdateGlobalField(server, db, ctx);
  registerRenameGlobalField(server, db, ctx);
  registerDeleteGlobalField(server, db, ctx);
  registerCreateSchema(server, db, ctx);
  registerUpdateSchema(server, db, ctx);
  registerDeleteSchema(server, db, ctx);
  registerValidateNode(server, db);
  registerInferFieldType(server, db);
  registerListFieldValues(server, db);
  registerListFieldGuessCandidates(server, db, ctx?.vaultPath);
  registerListUndoHistory(server, db);

  // Phase 6 extraction tools (require extractionCache and vaultPath)
  if (ctx?.extractionCache && ctx?.vaultPath) {
    registerReadEmbedded(server, db, ctx.extractionCache, ctx.vaultPath, ctx.transcriptStore);
  }

  if (ctx?.transcriptStore) {
    registerListTranscripts(server, ctx.transcriptStore);
  }

  // Phase 3 mutation tools (require writeLock and vaultPath)
  if (ctx?.writeLock && ctx?.vaultPath) {
    registerCreateNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.syncLogger, ctx.embeddingIndexer);
    registerUpdateNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.syncLogger, ctx.embeddingIndexer);
    registerDeleteNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.syncLogger, ctx.embeddingIndexer);
    registerBatchMutate(server, db, ctx.writeLock, ctx.vaultPath, ctx.syncLogger, ctx.embeddingIndexer);
    registerMergeNodes(server, db, ctx.writeLock, ctx.vaultPath, ctx.syncLogger, ctx.embeddingIndexer, ctx.settingsService?.settingsDir);
    registerRecoverDates(server, db, ctx.writeLock, ctx.vaultPath, ctx.syncLogger, ctx.embeddingIndexer, ctx.settingsService?.settingsDir);
    registerWikiWrite(server, db, ctx.writeLock, ctx.vaultPath, ctx.syncLogger, ctx.embeddingIndexer);
    registerWikiReconcile(server, {
      db,
      writeLock: ctx.writeLock,
      vaultPath: ctx.vaultPath,
      ...(ctx.syncLogger === undefined ? {} : { syncLogger: ctx.syncLogger }),
      ...(ctx.embeddingIndexer === undefined ? {} : { embeddingIndexer: ctx.embeddingIndexer }),
    });
    registerWikiStatus(server, {
      db,
      writeLock: ctx.writeLock,
      vaultPath: ctx.vaultPath,
      ...(ctx.syncLogger === undefined ? {} : { syncLogger: ctx.syncLogger }),
      ...(ctx.embeddingIndexer === undefined ? {} : { embeddingIndexer: ctx.embeddingIndexer }),
    });
    registerUndoOperations(server, db, ctx.writeLock, ctx.vaultPath, ctx.embeddingIndexer);
    if (ctx.transcriptStore) {
      registerMaterializeTranscript(server, db, ctx.writeLock, ctx.vaultPath, ctx.transcriptStore, ctx.syncLogger, ctx.embeddingIndexer);
      registerArchiveSource(server, db, ctx.writeLock, ctx.vaultPath, ctx.transcriptStore, ctx.syncLogger, ctx.extractorRegistry, ctx.embeddingIndexer);
    }
  }

  if (ctx?.vaultPath) {
    registerEmbedAttachment(server, ctx.vaultPath, ctx.attachmentDir ?? resolveAttachmentDir(ctx.vaultPath));
  }

  if (ctx?.settingsService && ctx?.modelCatalog) {
    registerGetSettings(server, ctx.settingsService, ctx.modelCatalog);
    if (ctx.settingsNoteDeps) {
      registerUpdateSettings(server, ctx.settingsService, ctx.settingsNoteDeps);
      registerPromptDefaults(server, ctx.settingsService, ctx.settingsNoteDeps);
    }
  }

  if (ctx?.modelCatalog) {
    registerDiscoverModels(server, ctx.modelCatalog, process.env);
    if (ctx.settingsNoteDeps) {
      registerAddModel(server, {
        catalog: ctx.modelCatalog,
        noteDeps: ctx.settingsNoteDeps,
        env: process.env,
        ...(ctx.onCatalogChange ? { onCatalogChange: ctx.onCatalogChange } : {}),
      });
    }
  }
}
