import { readProvenanceLimits } from './provenance/limits.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { openDatabase } from './db/connection.js';
import { createSchema } from './db/schema.js';
import { initializeReferencePolicyVersion, preflightReferencePolicyVersion } from './db/reference-policy-version.js';
import { checkTypeKey } from './db/type-key.js';
import { DEFAULT_TYPE_KEY, resolveTypeKey, setTypeKey } from './parser/type-key.js';
import {
  upgradeToPhase2, upgradeToPhase3, upgradeToPhase4, upgradeToPhase6, upgradeToVersionStamps,
  addCreatedAt, upgradeForContentChangedAt, upgradeForOverrides, upgradeForAiGuessableFields, upgradeToEnumGroups, ensureMetaTable, upgradeForResolvedTargetId,
  addUndoTables, addNodeTypesSortOrder, addSchemaUndoSnapshots, addGlobalFieldUndoSnapshots, addUndoLinkBindings, addUndoMemorySubjects,
  addUiHints, upgradeForAttachmentTranscripts, upgradeForMaterializedTranscripts,
  upgradeForArchiveLog, upgradeForExtractionCacheLastUsed, upgradeBoardsStore,
  upgradeBoardLinksStore, resetBoardsAfterSingleViewSplit, upgradeConversationsStore, upgradeConversationLinks, addUsageEvents,
  upgradeToMemories, upgradeToMemoriesV2, upgradeToMemoriesV3, upgradeToRicherFts,
  upgradeToMemoryNoteReceipts,
  upgradeToMemoryHistory,
  upgradeToMemoryConsolidationPending, upgradeToMemoryChangedBy, upgradeToMemorySubjects, upgradeToOAuthReuseTimes,
  dropRetiredNodeFacts,
  upgradeToProvenance,
  upgradeToWikiStatusVersions,
} from './db/migrate.js';
import { createServer } from './mcp/server.js';
import type { ToolSurface } from './mcp/tool-surface.js';
import { parseArgs } from './transport/args.js';
import { sendConsoleToStderr } from './transport/stdio-logs.js';
import { startHttpTransport } from './transport/http.js';
import { createAuthSchema } from './auth/schema.js';
import { ownerPasswordWarning, validateAuthEnv } from './auth/env.js';
import { fullIndex, indexProgressLog } from './indexer/indexer.js';
import { rereadTypeKeyValues, typesRereadLog } from './indexer/types-reread.js';
import { setExcludeDirs } from './indexer/ignore.js';
import { processFileChange, startWatcher } from './sync/watcher.js';
import { backfillExplicitNullFields } from './sync/explicit-null-backfill.js';
import { startReconciler } from './sync/reconciler.js';
import { startNormalizer, runNormalizerSweep } from './sync/normalizer.js';
import { startUndoCleanup } from './undo/cleanup.js';
import { editSessions } from './undo/edit-session.js';
import { startMaintenance } from './db/maintenance.js';
import { startDeepgramConfirmations } from './usage/deepgram-confirm.js';
import { startOpenRouterReconciliation } from './usage/openrouter-reconcile.js';
import { IndexMutex } from './sync/mutex.js';
import { WriteLockManager } from './sync/write-lock.js';
import { SyncLogger } from './sync/sync-logger.js';
import { startupSchemaRender } from './schema/render.js';
import { createProviderClients, providerKeyRef, providerKeysFromEnv } from '@vault/llm';
import { MODEL_PROVIDERS, PROVIDERS } from '@vault/settings-registry';
import { buildExtractors } from './extraction/setup.js';
import { buildWebSearch } from './web/setup.js';
import { KnownWebAddresses } from './web/known-addresses.js';
import { ExtractionCache } from './extraction/cache.js';
import { TranscriptStore } from './extraction/transcript-store.js';
import { createSubprocessEmbedder, resolveModelsDir, type Embedder } from './search/embedder.js';
import { createEmbeddingIndexer, type EmbeddingIndexer } from './search/indexer.js';
import { CURRENT_SEARCH_VERSION, getSearchVersion, setSearchVersion, planSearchUpgrade } from './db/search-version.js';
import { backfillResolvedTargets } from './resolver/refresh.js';
import { runStartupLinkRepair } from './pipeline/link-repair.js';
import { upgradeWikiSchemaOnBoot } from './wiki/bootstrap.js';
import { startWikiStatusChecks } from './wiki/status.js';
import { resolveAttachmentDir } from './pipeline/attachment-dir.js';
import { UsageRecorder } from './usage/recorder.js';
import { backfillProviderPricedEstimates } from './usage/provider-priced-estimate.js';
import { startUsageCsvReports } from './usage/csv-reports.js';
import { createConsolidator } from './mcp/tools/memory-consolidation.js';
import { wikiTimeZone } from './wiki/today.js';
import { MemoryService } from './memories/service.js';
import { MemoryNoteReceipts } from './memories/note-receipts.js';
import { MemoryNoteIngest } from './memories/note-ingest.js';
import { MemoryNoteProjection } from './memories/note-projection.js';
import { memoryNotePath } from './memories/note-format.js';
import { SettingsService } from './settings/service.js';
import {
  ModelCatalog, resolveEngineModelEntry as resolveEntryFromCatalog,
} from './settings/models.js';
import { SettingsIngest } from './settings/ingest.js';
import { seedSettingsOnBoot, seedModelsOnBoot, migrateVisionSettingsOnBoot, warnStaleEnv } from './settings/seed.js';
import { setMemoryNotePath, setSettingsChangeHook, setSettingsNoteResolver, setToolWriteHook } from './settings/hook.js';
import { safeVaultPath } from './pipeline/safe-path.js';
import { sha256 } from './indexer/hash.js';

const args = parseArgs(process.argv.slice(2));

// A stdio server's stdout carries MCP messages only, from its first line to its last. A
// one-shot --normalize run serves no client and prints its result on stdout as before.
if ((args.transport === 'stdio' || args.transport === 'both') && !args.normalize) sendConsoleToStderr();

const vaultPath = process.env.VAULT_PATH;
if (!vaultPath) {
  console.error('VAULT_PATH environment variable is required');
  process.exit(1);
}

const attachmentDir = resolveAttachmentDir(vaultPath, process.env.VAULT_ATTACHMENT_DIR);

const dbPath = args.dbPath ?? process.env.DB_PATH ?? resolve(vaultPath, '.vault-engine', 'vault.db');
const databaseWasNew = !existsSync(dbPath);
if (!databaseWasNew) preflightReferencePolicyVersion(dbPath);
const db = openDatabase(dbPath);
createSchema(db);
upgradeToPhase2(db);
upgradeToPhase3(db);
upgradeToPhase4(db);
upgradeToPhase6(db);
upgradeToVersionStamps(db);
addCreatedAt(db);
upgradeForContentChangedAt(db);
upgradeForOverrides(db);
upgradeForAiGuessableFields(db);
upgradeToEnumGroups(db);
ensureMetaTable(db);
initializeReferencePolicyVersion(db, databaseWasNew);
upgradeForResolvedTargetId(db);
addUndoTables(db);
addNodeTypesSortOrder(db);
addSchemaUndoSnapshots(db);
addGlobalFieldUndoSnapshots(db);
addUndoLinkBindings(db);
addUndoMemorySubjects(db); // memory subjects a merge moved, for its undo (#554)
addUiHints(db);
upgradeForAttachmentTranscripts(db);
upgradeForMaterializedTranscripts(db);
upgradeForArchiveLog(db);
upgradeForExtractionCacheLastUsed(db);
upgradeBoardsStore(db);
upgradeBoardLinksStore(db); // FK → boards, so after boards
resetBoardsAfterSingleViewSplit(db); // drops the boards a #279 split left behind (meta-guarded, once)
upgradeConversationsStore(db);
upgradeConversationLinks(db); // FK → conversations, so after conversations
addUsageEvents(db);
upgradeToMemories(db);
upgradeToMemoriesV2(db);
upgradeToMemoriesV3(db);
upgradeToMemoryNoteReceipts(db); // durable-memory markdown projection ledger
upgradeToMemoryHistory(db); // reactivation + in-place edit history (#300)
upgradeToMemoryConsolidationPending(db); // memories added without consolidation, for replay (#346)
upgradeToMemoryChangedBy(db); // which chat client last wrote a memory (#532)
upgradeToMemorySubjects(db); // what each memory is about (#554)
upgradeToOAuthReuseTimes(db); // when a token was revoked and a code exchanged (#533)
upgradeToProvenance(db); // independent retained-input domain
upgradeToWikiStatusVersions(db); // wiki home versions only a status write produced (#547)
dropRetiredNodeFacts(db); // node facts retired 2026-11-09 (#352)
upgradeToRicherFts(db); // finding #4a - widen nodes_fts; must run after ensureMetaTable

// VAULT_TYPE_KEY is bootstrap config (#445): the frontmatter key that holds a note's types,
// chosen at install. Set before anything parses or renders a note, and refused when it is
// not the key this database was built with (an existing database without a recorded key
// was built with `types`).
try {
  const configuredTypeKey = resolveTypeKey(process.env.VAULT_TYPE_KEY);
  checkTypeKey(db, configuredTypeKey);
  setTypeKey(configuredTypeKey);
  if (configuredTypeKey !== DEFAULT_TYPE_KEY) console.log(`Note types are read from the "${configuredTypeKey}" frontmatter key`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  db.close();
  process.exit(1);
}
const usageRecorder = new UsageRecorder(db);
// Uncharged Auto Router rows get an estimate from the charged calls nearest them (#340): the
// past ones once, and any a thin ledger couldn't price yet at a later start. Best-effort, and
// server starts only: --normalize is one-shot maintenance, and its --dry-run promises no writes.
if (!args.normalize) {
  try {
    const backfilled = backfillProviderPricedEstimates(db);
    if (backfilled.rows > 0) console.log(`[usage] estimated ${backfilled.rows} uncharged Auto Router row(s) from charged calls: $${backfilled.usd.toFixed(4)}`);
  } catch (err) {
    console.warn(`[usage] Auto Router estimate backfill failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
const openRouterKey = process.env[PROVIDERS.openrouter.apiKeyEnv]?.trim();
if (openRouterKey) usageRecorder.setOwnKeyRef('openrouter', providerKeyRef(openRouterKey));

// --- Settings: construct service, seed from env (first boot), warn on stale env ---
// VAULT_SETTINGS_DIR is bootstrap config (a setting can't describe its own
// location). Trim + strip trailing slashes so "Settings/" and "Settings" resolve
// identically and can't slip past the excludeDirs guard; empty → "Settings".
const settingsDir = process.env.VAULT_SETTINGS_DIR?.trim().replace(/\/+$/, '') || 'Settings';
const settingsService = new SettingsService(db, { settingsDir, attachmentDir });
const modelCatalog = new ModelCatalog(db, { settingsDir, env: process.env as Record<string, string | undefined> });
// Late-bind frontmatter (Settings/Models/) pricing into the usage ledger's cost
// chain — resolvePricing consults this before the static @vault/pricing table.
usageRecorder.setCatalogPricing((model) => modelCatalog.entries().find((e) => e.model === model)?.pricing ?? null);
// Vision resolves to provider + model id (the extractor set needs the provider
// to pick baseURL + API key): visionModel may ride fireworks OR openrouter.
const resolveVisionEntry = () =>
  resolveEntryFromCatalog(modelCatalog, settingsService.engine().visionModel, 'visionModel', 'Qwen 3.7 Plus');
const resolveMemoryConsolidationEntry = () =>
  resolveEntryFromCatalog(
    modelCatalog,
    settingsService.engine().memoryConsolidationModel,
    'memoryConsolidationModel',
    'Qwen 3.7 Plus',
  );
// Seeding + stale-env warnings are full-server-only. One-shot modes
// (--normalize / --normalize --dry-run) exit before the server starts; seeding
// there — e.g. from a shell without the systemd EnvironmentFile — would seed the
// engine domain empty and mark it seeded, permanently skipping the real
// first-boot migration. Gate them behind !args.normalize.
if (!args.normalize) {
  seedSettingsOnBoot(db, settingsService, process.env as Record<string, string | undefined>);
  warnStaleEnv(process.env as Record<string, string | undefined>);
}

const applyExcludeDirs = (dirs = settingsService.engine().excludeDirs): void => {
  setExcludeDirs(dirs);
  if (dirs.length > 0) console.log(`Excluding directories: ${dirs.join(', ')}`);
};
const initialExcludeDirs = [...settingsService.engine().excludeDirs];
applyExcludeDirs(initialExcludeDirs);

function runOneShotNormalize(dryRun: boolean): never {
  const writeLock = new WriteLockManager();
  const syncLogger = new SyncLogger(db);
  const stats = runNormalizerSweep(vaultPath!, db, writeLock, syncLogger, { dryRun });
  db.close();
  process.exit(stats.errored > 0 ? 1 : 0);
}

// Dry-run normalize is read-only against the DB and writes no files, so we can run
// it before fullIndex / startupSchemaRender. That keeps it cheap and safe to invoke
// while the live service holds the same DB open in WAL mode.
if (args.normalize && args.dryRun) runOneShotNormalize(true);

// Construct the shared write seams before indexing, but defer SyncLogger's
// irreversible retention prune until the indexed Engine note has reconciled.
const writeLock = new WriteLockManager();
const syncLogger = new SyncLogger(
  db,
  settingsService.engine().syncLogRetentionHours,
  { deferInitialPrune: true },
);

// The initial pass uses the last-good stored exclusions. An offline Engine-note
// edit may change them; that is handled by at most one pass below after the
// indexed note has gone through SettingsIngest.
const deletedBeforeConsumerInit: string[] = [];
console.log(`Indexing vault at ${vaultPath}...`);
const indexStart = Date.now();
await fullIndex(vaultPath, db, {
  onNodeDeleted: (nodeId) => deletedBeforeConsumerInit.push(nodeId),
  onProgress: indexProgressLog(),
});
console.log(`Indexing complete in ${Date.now() - indexStart}ms`);
// Once per database (#482): notes an older Engine indexed with a narrower reading of
// `types` are read again, DB-only, before anything can save them. Unchanged files only
// (the index above read the rest); embeddings refresh with the all-nodes enqueue below.
try {
  for (const line of typesRereadLog(rereadTypeKeyValues(vaultPath, db, indexStart))) console.log(line);
} catch (err) {
  console.error('[types] reading notes\' types again failed; next start retries:', err instanceof Error ? err.message : err);
}

// Resolved-target backfill: populates resolved_target_id on any rows left NULL.
// Runs AFTER fullIndex on EVERY startup (not version-gated): files created while
// the engine was down are indexed by fullIndex, which reconciles typed v2
// edges itself. Legacy/unconstrained pending edges still need this pass to avoid
// permanent stragglers (2026-06-12 triage, Cause C). Batch implementation keeps this
// O(nodes + unresolved rows).
const backfillStats = backfillResolvedTargets(db);
if (backfillStats.updated > 0) {
  console.log(`Resolved-target backfill: ${backfillStats.updated}/${backfillStats.scanned} pending rows resolved (${backfillStats.uniqueTargets} unique targets).`);
}

// --- One-shot normalize mode (live writes; dry-run already exited above) ---
if (args.normalize) {
  startupSchemaRender(db, vaultPath);
  runOneShotNormalize(false);
}

// Startup vision resolution may have populated this cache from the previous DB
// snapshot. The index above is now authoritative for Settings/Models/*.md.
modelCatalog.invalidate();
modelCatalog.bumpVersion();

// Settings-note wiring exists before consumers, but no watcher or background
// work is active yet. Runtime catalog changes call the assigned re-arm function
// after the extractor registry is constructed below.
let rearmVisionIfChanged: () => void = () => {};
const settingsNoteDeps = { db, writeLock, vaultPath, syncLogger, service: settingsService };
const onCatalogChange = (): void => {
  try {
    rearmVisionIfChanged();
  } catch (err) {
    console.error('[settings] vision re-arm on Models/ change failed:', err instanceof Error ? err.message : err);
  }
};
const settingsIngest = new SettingsIngest(settingsNoteDeps, modelCatalog, onCatalogChange);
setSettingsNoteResolver((relPath) => settingsIngest.handles(relPath));

// Model seeds/migrations must precede strict model-ref validation. The vision
// rename records its projection ownership but does not rewrite Markdown before
// the explicit-null startup handoff below.
seedModelsOnBoot(db, settingsService, settingsNoteDeps, modelCatalog);
settingsService.setModelRefResolver((ref) => modelCatalog.resolve(ref));
migrateVisionSettingsOnBoot(db, settingsService, settingsNoteDeps, { deferProjection: true });

// Reconcile the already-indexed Engine notes through the live ingest seam,
// without canonical write-back. Malformed/invalid authored values therefore
// keep the service's last-good state and existing diagnostics. At the first
// start with the settings folders (#746) the old single notes are read first,
// so an edit made in them while the Engine was stopped reaches these consumers;
// reconcile below writes the folders and retires the old notes.
settingsIngest.importFlatNotes();
settingsIngest.ingestDomain('engine', { allowWriteBack: false });
const reconciledExcludeDirs = [...settingsService.engine().excludeDirs];
applyExcludeDirs(reconciledExcludeDirs);
syncLogger.setRetentionHours(settingsService.engine().syncLogRetentionHours);

// --- Extraction + Embedder (initialized from reconciled effective settings) ---
// extractionEnabled is restart-class: read once here, so a vision re-arm below
// never turns paid extraction back on mid-run.
const extractionEnabled = settingsService.engine().extractionEnabled;
// lastVision captures the exact reconciled provider/model triple handed to the
// live extractor registry; runtime settings/catalog edits compare against it.
const initialVisionEntry = resolveVisionEntry();
let lastVision = {
  provider: settingsService.engine().visionProvider,
  modelProvider: initialVisionEntry.provider,
  model: initialVisionEntry.model,
};
// One set of provider clients for every Engine model call (vision and memory
// consolidation), built lazily from the provider keys in the environment.
const providerClients = createProviderClients(providerKeysFromEnv(process.env));

const { registry: extractorRegistry, pdfFallback } = buildExtractors(
  {
    ...process.env,
    VISION_PROVIDER: lastVision.provider,
    VISION_MODEL_PROVIDER: lastVision.modelProvider,
    VISION_MODEL: lastVision.model,
  } as Record<string, string | undefined>,
  usageRecorder,
  undefined,
  extractionEnabled,
  providerClients,
);
const extractionCache = new ExtractionCache(db, extractorRegistry);
extractionCache.setPdfFallback(pdfFallback);
const transcriptStore = new TranscriptStore(db);

// Rebuild the vision extractor set in place if visionProvider/visionModel
// actually changed (`lastVision`, captured at the initial buildExtractors call
// above, holds the (provider, modelProvider, model) triple the live set was
// really built from). Defined here (early) so the one-shot post-migration
// catch-up below can call it synchronously; also invoked at runtime by two
// triggers: an engine-domain settings change (visionProvider/visionModel edits)
// AND a Settings/Models/ note edit (which can change what visionModel's ref
// RESOLVES to without the stored ref itself changing). Rebuilds INTO the existing
// registry (extractorRegistry is a `const` shared by ExtractionCache, every
// per-session server context, and vault-stats/archive-source) so the swap is
// visible everywhere without reassignment. memoryConsolidationModel is a
// next-use setting — provider + model are resolved fresh on every call, so it
// needs no rebuild here.
rearmVisionIfChanged = (): void => {
  const nextProvider = settingsService.engine().visionProvider;
  const nextEntry = resolveVisionEntry();
  if (
    nextProvider === lastVision.provider &&
    nextEntry.provider === lastVision.modelProvider &&
    nextEntry.model === lastVision.model
  ) return;
  const { pdfFallback: nextPdfFallback } = buildExtractors(
    {
      ...process.env,
      VISION_PROVIDER: nextProvider,
      VISION_MODEL_PROVIDER: nextEntry.provider,
      VISION_MODEL: nextEntry.model,
    } as Record<string, string | undefined>,
    usageRecorder,
    extractorRegistry,
    extractionEnabled,
    providerClients,
  );
  extractionCache.setPdfFallback(nextPdfFallback);
  lastVision = { provider: nextProvider, modelProvider: nextEntry.provider, model: nextEntry.model };
  console.log(`[settings] vision extractor set re-armed (provider=${nextProvider}, modelProvider=${nextEntry.provider})`);
};

const { provider: webSearchProvider } = buildWebSearch(process.env as Record<string, string | undefined>, usageRecorder);
if (webSearchProvider) console.log(`Web search enabled (${webSearchProvider.name})`);
// What web-search has returned to each signed-in client, kept across that client's sessions.
const knownWebAddresses = new KnownWebAddresses();

// Consolidation runs on whichever provider memoryConsolidationModel names, so it
// starts when any provider key is set; a missing key for the configured model
// fails that call, and create-memory falls back to adding.
const memoryConsolidator = MODEL_PROVIDERS.some(provider => providerClients.has(provider))
  ? createConsolidator(providerClients, resolveMemoryConsolidationEntry, usageRecorder, () => wikiTimeZone(db))
  : undefined;

// --- Phase 4: Embedding indexer (subprocess-isolated) ---
// Skipped in --normalize mode: saves ~1.5 GB ONNX arena; any fullIndex deletions leak embedding rows until the next server-mode startup cleans them up.
let embeddingIndexer: EmbeddingIndexer | undefined;
let embedderRef: (Embedder & { shutdown(): Promise<void> }) | undefined;

if (!args.normalize) {
  const modelsDir = resolveModelsDir(vaultPath, process.env.EMBEDDER_MODELS_DIR);
  console.log('Initializing embedder subprocess...');
  try {
    const embedder = createSubprocessEmbedder({ modelsDir });
    embedderRef = embedder;
    embeddingIndexer = createEmbeddingIndexer(db, embedder, {
      extractionCache,
      vaultPath,
      transcriptStore,
    });
  } catch (err) {
    console.error('Failed to initialize embedder — search disabled:', err instanceof Error ? err.message : err);
  }
}

// Preserve delete cleanup from the initial pass now that the embedding indexer
// exists, then reconcile an exclusion change with at most one additional pass.
for (const nodeId of deletedBeforeConsumerInit) embeddingIndexer?.removeNode(nodeId);
const exclusionsChanged = JSON.stringify(initialExcludeDirs) !== JSON.stringify(reconciledExcludeDirs);
if (exclusionsChanged) {
  console.log('Startup exclusions changed after Engine settings reconcile; indexing once more...');
  await fullIndex(vaultPath, db, {
    onNodeDeleted: (nodeId) => embeddingIndexer?.removeNode(nodeId),
    onProgress: indexProgressLog(),
  });
  backfillResolvedTargets(db);
}
startupSchemaRender(db, vaultPath);

// Link repair runs at startup, after indexing and before the watcher or any
// tool can write: links only the engine resolves (a title its filename cannot
// reproduce) or that miss a note by filename sanitization are rewritten to
// name the file, then drifted titles reset. Repaired notes are re-embedded by
// the all-nodes enqueue below. The restart-class `linkRepair` setting turns it
// to report only or off (#447).
try {
  runStartupLinkRepair(settingsService.engine().linkRepair, db, writeLock, vaultPath, syncLogger);
} catch (err) {
  console.error('Link repair failed:', err instanceof Error ? err.message : err);
}

// One shared durable-memory domain service: every MCP session AND the
// Settings/Memories.md note ingest path reuse one instance so prepared
// statements, dedup posture, and versioning rules are identical.
// Constructed after embedderRef + memoryConsolidator are resolved (above).
const memoryService = new MemoryService(db, {
  ...(embedderRef ? { embedder: embedderRef } : {}),
  ...(memoryConsolidator ? { consolidator: memoryConsolidator } : {}),
});
// Memory note ingest: compose the existing settings change hook so both
// SettingsIngest and MemoryNoteIngest see watcher events; each filters exact
// paths. The memory note is also an ordinary indexed node — the watcher
// mutation (db_only) commits first, THEN this hook fires to parse and ingest
// memory-domain edits. No second watcher pipeline.
const memoryNoteReceipts = new MemoryNoteReceipts(db);
const memoryNoteIngest = new MemoryNoteIngest({
  db, vaultPath, settingsDir, service: memoryService, receipts: memoryNoteReceipts,
});
// A signed-in chat client changes memories through the memory tools, not by writing this note (#532).
setMemoryNotePath(memoryNotePath(settingsDir));
const memoryNoteProjection = new MemoryNoteProjection({
  db, writeLock, vaultPath, settingsDir, service: memoryService, ingest: memoryNoteIngest,
  syncLogger, embeddingIndexer,
});

// fullIndex records an offline Memories note edit as an ordinary node but does
// not fire watcher hooks. Deliver that indexed snapshot once through the same
// receipt-backed ingest used for live edits before any memory query is exposed.
memoryNoteIngest.onFileEvent(memoryNotePath(settingsDir), 'change');
await memoryNoteIngest.drain();

// --- Embedder post-init: version check + initial enqueue + background ---
// Starts only after settings/catalog/memory startup reconciliation is complete.
if (embeddingIndexer) {
  // Detect a search pipeline version bump. v2→v3 is a ROLLING upgrade: old
  // vectors stay searchable while the versioned source hash drives each group
  // to refresh (atomically, per group) — nothing is cleared up front, and the
  // stored version only advances after the initial drain completes with zero
  // terminal failures. Pre-v2 stores are structurally incompatible and still
  // take the legacy clear-and-rebuild path.
  const storedVersion = getSearchVersion(db);
  const upgradeMode = planSearchUpgrade(storedVersion);
  if (upgradeMode === 'clear') {
    console.log(`Search index version ${storedVersion} → ${CURRENT_SEARCH_VERSION}: clearing and re-embedding...`);
    embeddingIndexer.clearAll();
    setSearchVersion(db, CURRENT_SEARCH_VERSION);
  } else if (upgradeMode === 'rolling') {
    console.log(`Search index version ${storedVersion} → ${CURRENT_SEARCH_VERSION}: rolling upgrade — existing vectors stay searchable while groups refresh...`);
  }

  if (args.reindexSearch) {
    console.log('Reindex requested — clearing search index...');
    embeddingIndexer.clearAll();
    setSearchVersion(db, CURRENT_SEARCH_VERSION);
  }

  const allNodes = db.prepare('SELECT id FROM nodes').all() as Array<{ id: string }>;
  for (const node of allNodes) {
    embeddingIndexer.enqueue({ node_id: node.id, source_type: 'node' });
  }

  const backgroundProcess = async () => {
    const summary = await embeddingIndexer!.processAll();
    if (summary.completed > 0) {
      console.log(`Embedded ${summary.completed} items (${summary.skipped} unchanged, ${summary.failed} failed)`);
    }
    // Rolling upgrade: persist the target version only once the initial drain
    // finished with zero terminal failures. Unfinished groups retry on the
    // next restart (updated groups hash-skip, so a restart is cheap).
    if (upgradeMode === 'rolling') {
      if (summary.failed === 0) {
        setSearchVersion(db, CURRENT_SEARCH_VERSION);
        console.log(`Search index rolling upgrade complete — version ${CURRENT_SEARCH_VERSION} recorded.`);
      } else {
        console.warn(`Search index rolling upgrade incomplete: ${summary.failed} terminal failure(s) — stored version left at ${storedVersion}, will resume on next start.`);
      }
    }
  };
  backgroundProcess().catch(err => console.error('Embedding error:', err instanceof Error ? err.message : err));

  // Memories created while the Engine ran without an embedder have no vector (#300).
  memoryService.backfillVectors().then((r) => {
    if (r.embedded > 0 || r.failed > 0 || r.remaining > 0) {
      console.log(`[memories] vector backfill: ${r.embedded} embedded, ${r.failed} failed, ${r.remaining} live memories still without a vector`);
    }
  }).catch(err => console.error('[memories] vector backfill error:', err instanceof Error ? err.message : err));

  console.log(`Embedder ready, ${allNodes.length} nodes queued`);
}

setSettingsChangeHook((relPath, kind, context) => {
  settingsIngest.onFileEvent(relPath, kind, context);
  memoryNoteIngest.onFileEvent(relPath, kind);
});

const mutex = new IndexMutex();
const watcher = startWatcher(vaultPath, db, mutex, writeLock, syncLogger, embeddingIndexer, transcriptStore);
const explicitNullBackfill = await backfillExplicitNullFields({
  db,
  vaultPath,
  watcher,
  ingestThroughWatcher: (filePath) => {
    const absolutePath = safeVaultPath(vaultPath, filePath);
    processFileChange(
      absolutePath,
      filePath,
      db,
      writeLock,
      vaultPath,
      syncLogger,
      embeddingIndexer,
      { allowSettingsWriteBack: false },
    );
    // processFileChange deliberately logs instead of throwing on the live
    // watcher path. Startup must fail closed if that seam did not reconcile
    // the exact bytes currently on disk, so the completion marker stays absent.
    const diskHash = sha256(readFileSync(absolutePath, 'utf-8'));
    const indexed = db.prepare('SELECT content_hash FROM nodes WHERE file_path = ?').get(filePath) as
      | { content_hash: string }
      | undefined;
    if (indexed?.content_hash !== diskHash) {
      throw new Error(`Explicit-null backfill watcher ingest did not reconcile ${filePath}`);
    }
  },
});
if (explicitNullBackfill.scanned > 0) {
  console.log(
    `Explicit-null backfill complete: ${explicitNullBackfill.scanned} scanned, ` +
    `${explicitNullBackfill.reingested} reingested, ${explicitNullBackfill.markers} markers`,
  );
}

// Canonical settings projection still waits for explicit-null presence to be
// durable. Effective Engine values were already reconciled without write-back
// before consumers were initialized above.
settingsIngest.reconcile({
  ingestChangedFile: (relPath) => {
    processFileChange(
      safeVaultPath(vaultPath, relPath),
      relPath,
      db,
      writeLock,
      vaultPath,
      syncLogger,
      embeddingIndexer,
    );
  },
});
rearmVisionIfChanged();

// Tool-path Models/ invalidation is armed only after boot seeding finishes, as
// before: seedModelsOnBoot invalidates/bump its catalog explicitly and should
// not re-arm vision once per seed note. Runtime tool writes still flow through
// the same invalidate + onCatalogChange path as watcher events.
setToolWriteHook((relPath) => settingsIngest.onToolWrite(relPath));

const reconciler = startReconciler(vaultPath, db, mutex, writeLock, syncLogger, embeddingIndexer, undefined, transcriptStore);
// Wiki home status (#547): claim the newest wiki fields on an existing wiki schema, then keep
// each project wiki's `behind` exact. Best-effort; a failure leaves wiki pages as they are.
try {
  const added = upgradeWikiSchemaOnBoot(db);
  if (added) console.log(`Wiki schema: added ${[...added.created_global_fields, ...added.added_schema_claims].join(', ')}`);
} catch (err) {
  console.error('Wiki schema upgrade failed:', err instanceof Error ? err.message : err);
}
const wikiStatusChecks = startWikiStatusChecks({ db, writeLock, vaultPath, syncLogger, embeddingIndexer });
// Re-arm-class subsystems: held in `let` so the settings onChange listener can
// stop + restart them with fresh values without a process restart.
let normalizer = startNormalizer(vaultPath, db, writeLock, syncLogger, {
  cronExpression: settingsService.engine().normalizeCron,
  quiescenceMinutes: settingsService.engine().normalizeQuiescenceMinutes,
});
let undoCleanup = startUndoCleanup(db, { retentionHours: settingsService.engine().undoRetentionHours });
const editSessionSweep = editSessions.startSweep();
let maintenance = startMaintenance(db, dbPath, {
  enabled: settingsService.engine().backupsEnabled,
  backupIntervalHours: settingsService.engine().backupIntervalHours,
  backupKeep: settingsService.engine().backupKeep,
  editsLogRetentionDays: settingsService.engine().editsLogRetentionDays,
  extractionCacheRetentionDays: settingsService.engine().extractionCacheRetentionDays,
  provenanceLimits: () => readProvenanceLimits(settingsService.engine()),
});
const usageCsvReports = startUsageCsvReports({
  db,
  recorder: usageRecorder,
  reportsDir: join(dirname(dbPath), 'reports'),
});
// Deepgram's request log confirms what each transcription was charged (#329). Runs whenever
// the key is set, extraction on or off: it reads usage and spends nothing.
const deepgramKey = process.env.DEEPGRAM_API_KEY?.trim();
const deepgramConfirmations = deepgramKey
  ? startDeepgramConfirmations(db, { apiKey: deepgramKey, onChanged: () => usageCsvReports.changed() })
  : null;
// OpenRouter's own running usage for the Engine's key, read daily and compared with the ledger
// over the same hours (#328). Reads only; spends nothing.
const openRouterReconciliation = openRouterKey
  ? startOpenRouterReconciliation(db, { apiKey: openRouterKey, onChanged: () => usageCsvReports.changed() })
  : null;

// Coarse re-arm: on any engine-domain settings change, re-apply excludeDirs,
// restart the re-arm-class subsystems with fresh values, and rebuild the vision
// extractor set if it changed.
settingsService.onChange('engine', () => {
  try {
    applyExcludeDirs();
    normalizer.stop();
    normalizer = startNormalizer(vaultPath, db, writeLock, syncLogger, {
      cronExpression: settingsService.engine().normalizeCron,
      quiescenceMinutes: settingsService.engine().normalizeQuiescenceMinutes,
    });
    undoCleanup.stop();
    undoCleanup = startUndoCleanup(db, { retentionHours: settingsService.engine().undoRetentionHours });
    // SyncLogger is a shared singleton (watcher/reconciler/normalizer/ingest
    // all hold it), so its retention window is re-armed in place, not restarted.
    syncLogger.setRetentionHours(settingsService.engine().syncLogRetentionHours);
    maintenance.stop();
    maintenance = startMaintenance(db, dbPath, {
      enabled: settingsService.engine().backupsEnabled,
      backupIntervalHours: settingsService.engine().backupIntervalHours,
      backupKeep: settingsService.engine().backupKeep,
      editsLogRetentionDays: settingsService.engine().editsLogRetentionDays,
      extractionCacheRetentionDays: settingsService.engine().extractionCacheRetentionDays,
      provenanceLimits: () => readProvenanceLimits(settingsService.engine()),
    });

    rearmVisionIfChanged();

    console.log('[settings] engine subsystems re-armed');
  } catch (err) {
    console.error('[settings] re-arm failed:', err instanceof Error ? err.message : err);
  }
});

const serverFactory = (options?: { surface?: ToolSurface }) => createServer(db, {
  ...(options?.surface ? { surface: options.surface } : {}),
  writeLock,
  syncLogger,
  vaultPath,
  attachmentDir,
  extractorRegistry,
  extractionCache,
  embeddingIndexer,
  embedder: embedderRef,
  memoryService,
  memoryNoteIngest,
  memoryNoteReceipts,
  memoryNoteProjection,
  transcriptStore,
  usageRecorder,
  settingsService,
  settingsNoteDeps,
  modelCatalog,
  onCatalogChange,
  ...(memoryConsolidator ? { memoryConsolidator } : {}),
  ...(webSearchProvider ? { webSearchProvider } : {}),
  knownWebAddresses,
});

if (args.transport === 'stdio' || args.transport === 'both') {
  const server = serverFactory();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (args.transport === 'http' || args.transport === 'both') {
  const authEnv = validateAuthEnv(process.env.OAUTH_OWNER_PASSWORD, process.env.OAUTH_ISSUER_URL);
  const weakPassword = ownerPasswordWarning(authEnv.ownerPassword);
  if (weakPassword) console.warn(`[vault-engine] ${weakPassword}`);
  createAuthSchema(db);
  await startHttpTransport(serverFactory, args.port, {
    db,
    ownerPassword: authEnv.ownerPassword,
    issuerUrl: authEnv.issuerUrl,
  }, { vaultPath, dir: attachmentDir });
}

async function shutdown(): Promise<void> {
  console.log('Shutting down...');
  reconciler.stop();
  wikiStatusChecks.stop();
  normalizer.stop();
  undoCleanup.stop();
  editSessionSweep.stop();
  maintenance.stop();
  usageCsvReports.stop();
  deepgramConfirmations?.stop();
  openRouterReconciliation?.stop();
  // Stop new file events, let in-flight index ops finish (they enqueue
  // embeddings), then drain the embedding queue while the embedder is still
  // alive — otherwise a background embed could run writeGroup against a
  // closing DB (T0.3). Only then shut the embedder down and close the DB.
  await watcher.close();
  await mutex.onIdle();
  await embeddingIndexer?.drain();
  await embedderRef?.shutdown();
  db.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
