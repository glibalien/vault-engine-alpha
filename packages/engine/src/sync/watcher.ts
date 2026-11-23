import { logReferenceDiagnostics } from '../resolver/diagnostics.js';
import { createFieldMap } from '../fields/field-map.js';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { watch, type FSWatcher } from 'chokidar';
import { sha256 } from '../indexer/hash.js';
import { shouldIgnore } from '../indexer/ignore.js';
import { indexFile } from '../indexer/indexer.js';
import { executeDeletion } from '../pipeline/delete.js';
import { parseMarkdown } from '../parser/parse.js';
import { extractRawFieldTexts } from '../parser/raw-field-texts.js';
import { executeMutation } from '../pipeline/execute.js';
import { refreshOnCreate } from '../resolver/refresh.js';
import { notifySettingsChange } from '../settings/hook.js';
import type { IndexMutex, PendingEvent } from './mutex.js';
import type { WriteLockManager } from './write-lock.js';
import type { SyncLogger } from './sync-logger.js';
import type { EmbeddingIndexer } from '../search/indexer.js';
import type { TranscriptStore } from '../extraction/transcript-store.js';
import { explicitNullKeys } from '../fields/explicit-null.js';
import { typeKey } from '../parser/type-key.js';


export interface WatcherOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  /**
   * How long a node survives in the DB after its file's unlink event, waiting
   * for an add at another path with identical content to reclaim it as a
   * rename. Must comfortably exceed debounceMs + maxWaitMs + parse retries so
   * the add side of a rename always fires while the unlink is still pending.
   */
  renameGraceMs?: number;
}

export interface VaultWatcher extends FSWatcher {
  suspendDelivery(): void;
  waitUntilReady(): Promise<void>;
  enqueueScanDetectedUnlink(relPath: string): void;
  completeSuspendedHandoff(markComplete: () => void): Promise<void>;
  abortSuspendedDelivery(): Promise<void>;
}

interface PendingTimer {
  debounce: ReturnType<typeof setTimeout>;
  maxWait: ReturnType<typeof setTimeout>;
}

interface PendingUnlink {
  nodeId: string;
  contentHash: string;
  timer: ReturnType<typeof setTimeout>;
  blocksSuspendedHandoff: boolean;
}

export interface RenameMatch {
  node_id: string;
  from_path: string;
}

export function startWatcher(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock: WriteLockManager,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
  transcriptStore?: TranscriptStore,
  options?: WatcherOptions,
): VaultWatcher {
  const debounceMs = options?.debounceMs ?? 2500;
  const maxWaitMs = options?.maxWaitMs ?? 5000;
  const renameGraceMs = options?.renameGraceMs ?? 15_000;
  const pendingTimers = new Map<string, PendingTimer>();
  const retryCount = new Map<string, number>();
  const suspendedEvents = new Map<string, PendingEvent>();
  const suppressedUnlinkWriteBacks = new Set<string>();
  let deliverySuspended = false;
  const handoffUnlinks = new Set<string>();
  let handoffUnlinkError: unknown;
  let handoffProgressResolvers: Array<() => void> = [];
  // Nodes whose file just unlinked, kept alive for renameGraceMs so an add at
  // another path with identical content can reclaim them as a rename.
  const pendingUnlinks = new Map<string, PendingUnlink>();

  function notifyHandoffProgress(): void {
    const resolvers = handoffProgressResolvers;
    handoffProgressResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  function settleHandoffUnlink(relPath: string, error?: unknown): void {
    if (!handoffUnlinks.delete(relPath)) return;
    handoffUnlinkError ??= error;
    notifyHandoffProgress();
  }

  function replaySuppressedUnlinkWriteBacks(): void {
    const relPaths = [...suppressedUnlinkWriteBacks];
    suppressedUnlinkWriteBacks.clear();
    for (const relPath of relPaths) {
      // A file recreated at the handoff boundary owns its new contents. Its
      // live add/change event will ingest normally; a stale unlink must not
      // overwrite it with the prior settings projection.
      if (existsSync(join(vaultPath, relPath))) continue;
      notifySettingsChange(relPath, 'unlink', {
        allowWriteBack: true,
        expectedDiskContentHash: null,
      });
    }
  }

  function cancelPendingUnlink(
    relPath: string,
    options?: { retainSuppressedWriteBack?: boolean },
  ): void {
    const pending = pendingUnlinks.get(relPath);
    if (pending) {
      clearTimeout(pending.timer);
      pendingUnlinks.delete(relPath);
      // During startup handoff, a matching add at another path is a rename:
      // it consumes the deferred deletion to preserve node identity, but the
      // old canonical settings path still needs its suppressed unlink
      // projection after delivery becomes live. Same-path recreation cancels
      // the unlink entirely and ordinary live renames do not enter this path.
      if (options?.retainSuppressedWriteBack && pending.blocksSuspendedHandoff) {
        suppressedUnlinkWriteBacks.add(relPath);
      }
      if (pending.blocksSuspendedHandoff) settleHandoffUnlink(relPath);
    }
  }

  function matchRename(contentHash: string, content: string, relPath: string): RenameMatch | null {
    // Blank notes (e.g. Obsidian's freshly created empty files) all share one
    // hash — never transfer identity between them.
    if (content.trim() === '') return null;
    const candidates: string[] = [];
    for (const [fromPath, pending] of pendingUnlinks) {
      if (pending.contentHash === contentHash) candidates.push(fromPath);
    }
    let fromPath = candidates.length === 1 ? candidates[0] : undefined;
    if (fromPath === undefined && candidates.length > 1) {
      // Ambiguous (duplicate-content notes, e.g. unedited templates): only a
      // unique basename match may pair — which covers folder moves. Otherwise
      // refuse; delete + create is safer than guessing identity.
      const byBase = candidates.filter(p => basename(p) === basename(relPath));
      if (byBase.length === 1) fromPath = byBase[0];
    }
    if (fromPath === undefined) return null;
    const pending = pendingUnlinks.get(fromPath)!;
    cancelPendingUnlink(fromPath, { retainSuppressedWriteBack: fromPath !== relPath });
    return { node_id: pending.nodeId, from_path: fromPath };
  }

  function deleteByPath(relPath: string, rethrow = false): void {
    try {
      // Stale-event guard: if the file exists again (re-created, or an add for
      // this path is still queued), this is not a deletion.
      if (existsSync(join(vaultPath, relPath))) return;
      const row = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string } | undefined;
      if (row) {
        executeDeletion(db, writeLock, vaultPath, {
          source: 'watcher',
          node_id: row.id,
          file_path: relPath,
          unlink_file: false,
        });
        embeddingIndexer?.removeNode(row.id);
      } else {
        transcriptStore?.markDeleted(relPath);
      }
    } catch (err) {
      // The grace timer can outlive the session (DB closed at shutdown) — log,
      // never crash; the reconciler sweep re-detects genuine deletions.
      console.error(
        `[watcher] deferred deletion failed for ${relPath}:`,
        err instanceof Error ? err.message : err,
      );
      if (rethrow) throw err;
    }
  }

  function stashUnlink(relPath: string, blocksSuspendedHandoff = false): void {
    const row = db.prepare('SELECT id, content_hash FROM nodes WHERE file_path = ?').get(relPath) as
      | { id: string; content_hash: string }
      | undefined;
    if (!row) {
      transcriptStore?.markDeleted(relPath);
      return;
    }
    cancelPendingUnlink(relPath);
    const timer = setTimeout(() => {
      if (mutex.isRunning()) {
        mutex.enqueue({ type: 'unlink-expired', path: relPath });
      } else {
        void mutex.run(async () => {
          await processEvent({ type: 'unlink-expired', path: relPath });
        }).catch(() => {
          // Handoff failures are retained in handoffUnlinkError and observed by
          // completeSuspendedHandoff. Ordinary timer failures were logged by
          // deleteByPath and remain recoverable by the reconciler.
        });
      }
    }, renameGraceMs);
    // Never keep the process alive for a pending deletion — if we exit first,
    // the next startup's fullIndex pairing/deletion recovers it correctly.
    timer.unref();
    pendingUnlinks.set(relPath, {
      nodeId: row.id,
      contentHash: row.content_hash,
      timer,
      blocksSuspendedHandoff,
    });
    if (blocksSuspendedHandoff) handoffUnlinks.add(relPath);
  }

  async function processEvent(
    event: PendingEvent,
    options?: { allowSettingsWriteBack?: boolean },
  ): Promise<void> {
    const absPath = join(vaultPath, event.path);
    const relPath = relative(vaultPath, absPath);
    if (event.type === 'unlink') {
      stashUnlink(relPath, deliverySuspended);
    } else if (event.type === 'unlink-expired') {
      const pending = pendingUnlinks.get(relPath);
      if (!pending) return;
      try {
        deleteByPath(relPath, pending.blocksSuspendedHandoff);
        const allowSettingsWriteBack = options?.allowSettingsWriteBack ?? !deliverySuspended;
        notifySettingsChange(relPath, 'unlink', {
          allowWriteBack: allowSettingsWriteBack,
        });
        if (!allowSettingsWriteBack) suppressedUnlinkWriteBacks.add(relPath);
        pendingUnlinks.delete(relPath);
        if (pending.blocksSuspendedHandoff) settleHandoffUnlink(relPath);
      } catch (error) {
        pendingUnlinks.delete(relPath);
        if (pending.blocksSuspendedHandoff) settleHandoffUnlink(relPath, error);
        throw error;
      }
    } else {
      if (existsSync(absPath)) cancelPendingUnlink(relPath);
      processFileChange(absPath, relPath, db, writeLock, vaultPath, syncLogger, embeddingIndexer, {
        matchRename,
        allowSettingsWriteBack: options?.allowSettingsWriteBack,
      });
    }
  }

  // Wire mutex.processEvent to handle queued events during indexing.
  mutex.processEvent = processEvent;

  function enqueueSuspended(event: PendingEvent): void {
    suspendedEvents.set(event.path, event);
    notifyHandoffProgress();
  }

  function nextSuspendedEvent(): [string, PendingEvent] | undefined {
    let first: [string, PendingEvent] | undefined;
    for (const entry of suspendedEvents) {
      first ??= entry;
      // Live delivery's debounce lets unlink identity get stashed before the
      // add side is indexed. Suspended delivery has no debounce, so impose the
      // same ordering explicitly even when chokidar reports add first.
      if (entry[1].type === 'unlink') return entry;
    }
    return first;
  }

  function assertSuspendedEventReconciled(event: PendingEvent): void {
    if (event.type !== 'add' && event.type !== 'change') return;
    const absPath = join(vaultPath, event.path);
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      throw new Error(`Suspended watcher event did not reconcile ${event.path}: file is unavailable`);
    }
    const indexed = db.prepare('SELECT content_hash FROM nodes WHERE file_path = ?').get(event.path) as
      | { content_hash: string }
      | undefined;
    if (indexed?.content_hash !== sha256(content)) {
      throw new Error(`Suspended watcher event did not reconcile ${event.path}`);
    }
  }

  async function drainSuspendedEvents(options?: { continueOnError?: boolean }): Promise<void> {
    let firstError: unknown;
    while (suspendedEvents.size > 0) {
      const next = nextSuspendedEvent();
      if (!next) break;
      const [path, event] = next;
      // Abort owns an event as soon as it attempts it, allowing failure to
      // advance to later accepted paths. Completion keeps ownership queued
      // until success, so an early failure leaves the entire tail for abort.
      if (options?.continueOnError) suspendedEvents.delete(path);
      try {
        await processEvent(event, { allowSettingsWriteBack: false });
        assertSuspendedEventReconciled(event);
      } catch (err) {
        if (!options?.continueOnError) throw err;
        firstError ??= err;
        continue;
      }
      // Do not delete a newer event for the same path that arrived while the
      // prior event was being processed.
      if (suspendedEvents.get(path) === event) suspendedEvents.delete(path);
    }
    if (firstError !== undefined) throw firstError;
  }

  function scheduleIndex(absPath: string): void {
    const relPath = relative(vaultPath, absPath);

    // Clear existing debounce timer if any
    const existing = pendingTimers.get(absPath);
    if (existing) {
      clearTimeout(existing.debounce);
    }

    const fire = () => {
      const timers = pendingTimers.get(absPath);
      if (timers) {
        clearTimeout(timers.debounce);
        clearTimeout(timers.maxWait);
        pendingTimers.delete(absPath);
      }

      if (deliverySuspended) {
        enqueueSuspended({ type: 'change', path: relPath });
        return;
      }

      // Check write lock
      if (writeLock.isLocked(absPath)) return;

      // Hash check: skip if content unchanged
      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        // File may have been deleted between event and fire
        return;
      }
      // The file exists at this path — a deferred deletion for it (delete then
      // re-create) must be cancelled even if the hash-skip below returns early.
      cancelPendingUnlink(relPath);
      const hash = sha256(content);
      syncLogger?.watcherEvent(relPath, hash, content.length);
      const row = db.prepare('SELECT content_hash FROM nodes WHERE file_path = ?').get(relPath) as
        | { content_hash: string }
        | undefined;
      if (row && row.content_hash === hash) return;

      // Parse check: if YAML is broken, this may be Obsidian's truncation
      // window (documented bug where growing files are temporarily truncated
      // on disk for 1-2s). Re-enqueue with a retry delay instead of
      // processing garbage.
      const parseCheck = parseMarkdown(content, relPath);
      if (parseCheck.parseError !== null) {
        const retryKey = absPath;
        const retries = (retryCount.get(retryKey) ?? 0) + 1;
        if (retries <= 3) {
          retryCount.set(retryKey, retries);
          syncLogger?.parseRetry(relPath, retries, parseCheck.parseError ?? 'unknown');
          const retryTimer = setTimeout(fire, 2000);
          pendingTimers.set(absPath, { debounce: retryTimer, maxWait: retryTimer });
          return;
        }
        // Max retries exceeded — fall through to processFileChange
        // which will log the parse error and preserve DB state
        retryCount.delete(retryKey);
      } else {
        retryCount.delete(absPath);
      }

      // Process through mutex via write pipeline
      if (mutex.isRunning()) {
        mutex.enqueue({ type: 'change', path: relPath });
      } else {
        void mutex.run(async () => {
          processFileChange(absPath, relPath, db, writeLock, vaultPath, syncLogger, embeddingIndexer, { matchRename });
        });
      }
    };

    const debounceTimer = setTimeout(fire, debounceMs);

    if (existing) {
      // Keep existing maxWait timer, just reset debounce
      pendingTimers.set(absPath, { debounce: debounceTimer, maxWait: existing.maxWait });
    } else {
      // First event for this path: set up max-wait timer too
      const maxWaitTimer = setTimeout(fire, maxWaitMs);
      pendingTimers.set(absPath, { debounce: debounceTimer, maxWait: maxWaitTimer });
    }
  }

  function handleUnlink(absPath: string): void {
    const relPath = relative(vaultPath, absPath);

    // Clear any pending timers for this file
    const timers = pendingTimers.get(absPath);
    if (timers) {
      clearTimeout(timers.debounce);
      clearTimeout(timers.maxWait);
      pendingTimers.delete(absPath);
    }

    if (writeLock.isLocked(absPath)) return;

    if (deliverySuspended) {
      enqueueSuspended({ type: 'unlink', path: relPath });
      return;
    }

    if (mutex.isRunning()) {
      mutex.enqueue({ type: 'unlink', path: relPath });
    } else {
      // Deletion is deferred by renameGraceMs (see stashUnlink) so a matching
      // add at another path can reclaim the node as a rename instead of the
      // delete + re-create that would destroy its id — and with it everything
      // keyed on node id (board links, card-spec filters, incoming edges).
      stashUnlink(relPath);
    }
  }

  const watcher = watch(vaultPath, {
    ignoreInitial: true,
    ignored: [/(^|[/\\])\./, '**/node_modules/**'],
  });
  const ready = new Promise<void>((resolveReady) => {
    watcher.once('ready', () => resolveReady());
  });

  watcher.on('add', (filePath: string) => {
    const relPath = relative(vaultPath, filePath);
    if (shouldIgnore(relPath)) return;
    if (deliverySuspended) {
      enqueueSuspended({ type: 'add', path: relPath });
      return;
    }
    scheduleIndex(filePath);
  });

  watcher.on('change', (filePath: string) => {
    const relPath = relative(vaultPath, filePath);
    if (shouldIgnore(relPath)) return;
    if (deliverySuspended) {
      enqueueSuspended({ type: 'change', path: relPath });
      return;
    }
    scheduleIndex(filePath);
  });

  watcher.on('unlink', (filePath: string) => {
    const relPath = relative(vaultPath, filePath);
    if (shouldIgnore(relPath, { allowNonMarkdown: true })) return;
    handleUnlink(filePath);
  });

  const vaultWatcher = watcher as VaultWatcher;
  vaultWatcher.suspendDelivery = () => {
    deliverySuspended = true;
  };
  vaultWatcher.waitUntilReady = () => ready;
  vaultWatcher.enqueueScanDetectedUnlink = (relPath) => {
    if (!deliverySuspended) {
      throw new Error('Watcher delivery is not suspended');
    }
    enqueueSuspended({ type: 'unlink', path: relPath });
  };
  vaultWatcher.completeSuspendedHandoff = async (markComplete) => {
    if (!deliverySuspended) {
      throw new Error('Watcher delivery is not suspended');
    }
    let complete = false;
    while (!complete) {
      // At startup no reconciler is armed yet, but waiting here also makes the
      // lifecycle safe if suspension is reused while an index pass is ending.
      await mutex.onIdle();
      await mutex.run(async () => {
        // Events accepted while this awaits remain in suspendedEvents. Unlinks
        // are drained first so adds can reclaim identity through matchRename.
        await drainSuspendedEvents();
        if (handoffUnlinkError !== undefined) throw handoffUnlinkError;
        if (handoffUnlinks.size > 0) return;

        // No await from the stable state through publication: the marker and
        // live-delivery flip are one atomic handoff boundary.
        markComplete();
        deliverySuspended = false;
        complete = true;
      });

      if (!complete) {
        // Grace expiry must be able to acquire IndexMutex, and an add/change
        // arriving during the wait must wake us early to preserve rename
        // identity. Never await either condition while mutex.run is active.
        if (suspendedEvents.size === 0 && handoffUnlinks.size > 0) {
          await new Promise<void>(resolve => handoffProgressResolvers.push(resolve));
        }
      }
    }
    // Projection writes are intentionally suppressed while delivery is
    // suspended. Replay missing unlink projections only after the marker/live
    // boundary and after IndexMutex has been released.
    replaySuppressedUnlinkWriteBacks();
  };
  vaultWatcher.abortSuspendedDelivery = async () => {
    if (!deliverySuspended) return;
    let aborted = false;
    try {
      while (!aborted) {
        await mutex.onIdle();
        await mutex.run(async () => {
          if (!deliverySuspended) {
            aborted = true;
            return;
          }
          try {
            await drainSuspendedEvents({ continueOnError: true });
          } finally {
            // Failure leaves the durable completion marker to the caller, but the
            // watcher must not remain paused or strand events in memory.
            deliverySuspended = false;
            handoffUnlinks.clear();
            handoffUnlinkError = undefined;
            for (const pending of pendingUnlinks.values()) {
              pending.blocksSuspendedHandoff = false;
            }
            notifyHandoffProgress();
            aborted = true;
          }
        });
      }
    } finally {
      // mutex.run releases its ownership before this outer finally executes.
      if (aborted && !deliverySuspended) replaySuppressedUnlinkWriteBacks();
    }
  };

  return vaultWatcher;
}

/**
 * Process a file change through the Phase 3 write pipeline.
 * Parses the file and calls executeMutation with source='watcher';
 * the pipeline handles default population, validation, and rendering.
 */
export function processFileChange(
  absPath: string,
  relPath: string,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
  opts?: {
    /**
     * Consulted only when no node exists at relPath: given the file's content
     * hash, return the node this file was renamed from (consuming any pending
     * deletion for it) so the mutation updates that node in place instead of
     * minting a new id.
     */
    matchRename?: (contentHash: string, content: string, relPath: string) => RenameMatch | null;
    /** Forensic attribution for rename log entries (default 'watcher'). */
    renameSource?: string;
    /** Rollout backfills ingest settings but must not canonicalize Markdown. */
    allowSettingsWriteBack?: boolean;
  },
): void {
  let content: string;
  try {
    content = readFileSync(absPath, 'utf-8');
  } catch {
    return;
  }
  const sourceContentHash = sha256(content);

  const parsed = parseMarkdown(content, relPath);

  // Handle parse errors
  if (parsed.parseError !== null) {
    const existing = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string } | undefined;
    if (existing) {
      // Existing node: preserve DB state, log parse error
      db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
        existing.id,
        Date.now(),
        'parse-error',
        JSON.stringify({
          source: 'watcher',
          file_path: relPath,
          error: parsed.parseError,
          db_state: 'preserved',
        }),
      );
    } else {
      // New file with parse error: create minimal node with body-only
      // (Phase 1 fallback behavior)
      const fallbackNodeId = indexFile(absPath, vaultPath, db);
      // indexFile bypasses executeMutation's refreshOnCreate — without this,
      // pre-existing unresolved edges pointing at the new file never resolve.
      refreshOnCreate(db, fallbackNodeId);
      // Self-draining queue (T0.3): enqueue kicks a background drain; embed
      // errors are logged inside the indexer (see indexer.ts processOne catch).
      try {
        embeddingIndexer?.enqueue({ node_id: fallbackNodeId, source_type: 'node' });
      } catch (err) {
        // The fallback node is already committed. Keep a synchronous enqueue
        // failure visible without suppressing the settings parse-error hook.
        console.error(
          `[watcher] Pipeline error processing ${relPath}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    // Fire the settings hook on the definitive parse-failure return too, so a
    // broken settings-note edit surfaces via get-settings (SettingsIngest's
    // parse-error branch records the issue). The hook filters to settings paths,
    // so non-settings files are unaffected.
    notifySettingsChange(relPath, 'change', {
      allowWriteBack: opts?.allowSettingsWriteBack ?? true,
      expectedDiskContentHash: sourceContentHash,
    });
    return;
  }

  // Convert parsed fields from Map to Record
  const parsedFields = createFieldMap<unknown>();
  for (const [key, value] of parsed.fields) {
    parsedFields[key] = value;
  }

  // Extract raw field texts for wiki-link preservation
  const rawFieldTexts = extractRawFieldTexts(content);

  // Load current DB state for diff
  const existing = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string } | undefined;
  // Unknown path: check whether this is the add half of a rename before
  // treating it as a brand-new node.
  const renamedFrom = existing ? null : (opts?.matchRename?.(sourceContentHash, content, relPath) ?? null);
  const nodeId = existing?.id ?? renamedFrom?.node_id ?? null;

  let result: ReturnType<typeof executeMutation>;
  try {
    result = executeMutation(db, writeLock, vaultPath, {
      source: 'watcher',
      node_id: nodeId,
      file_path: relPath,
      title: parsed.title,
      types: parsed.types,
      fields: parsedFields,
      explicitNullFields: explicitNullKeys(parsed.fields),
      body: parsed.body,
      raw_field_texts: rawFieldTexts,
      source_content_hash: sourceContentHash,
      db_only: true,
    });
  } catch (err) {
    // Pipeline errors on watcher path are unexpected but shouldn't crash.
    // They must still be visible (T0.1), and no settings projection may run
    // because the mutation did not commit.
    console.error(
      `[watcher] Pipeline error processing ${relPath}:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  logReferenceDiagnostics(result.referenceDiagnostics, 'watcher');

  try {
    // Log the rename only after the mutation committed — a pipeline failure
    // must not leave a rename record for a rename that never applied.
    if (renamedFrom) {
      const renameSource = opts?.renameSource ?? 'watcher';
      syncLogger?.renameDetected(renamedFrom.from_path, relPath, renamedFrom.node_id, renameSource);
      db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
        renamedFrom.node_id,
        Date.now(),
        'file-renamed',
        JSON.stringify({ from: renamedFrom.from_path, to: relPath, source: renameSource }),
      );
    }

    // Self-draining queue (T0.3): enqueue kicks a background drain that pumps
    // the whole queue (node + any extraction items), not just one item. Embed
    // errors are logged inside the indexer (processOne catch), preserving the
    // T0.1 "never swallow" guarantee — now covered by indexer.test.ts.
    embeddingIndexer?.enqueue({ node_id: result.node_id, source_type: 'node' });
  } catch (err) {
    // Post-commit observer failures remain visible but cannot roll back the
    // mutation or suppress the settings hook for the committed snapshot.
    console.error(
      `[watcher] Pipeline error processing ${relPath}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Fire the settings hook after a successful process (the parse-error branch
  // above fires its own). Two callers reach here:
  //   • the debounced fire() path, which already ran the hash-skip in
  //     scheduleIndex — so the settings note this call just wrote back won't
  //     re-trigger ingest until its content actually changes again (that
  //     asymmetry is what prevents echo loops); and
  //   • the queued mutex.processEvent path, which does NOT hash-skip. It relies
  //     on ingest being idempotent instead: re-ingesting our own canonical
  //     write-back reduces to the stored deviations set (no change, no version
  //     bump, no listener fire), so an unnecessary notify is harmless.
  if (renamedFrom && renamedFrom.from_path !== relPath) {
    // Identity has moved before the settings layer recreates a missing
    // canonical domain note. The renamed file remains untouched. Suspended
    // delivery retains its existing deferred unlink replay at handoff.
    notifySettingsChange(renamedFrom.from_path, 'unlink', {
      allowWriteBack: opts?.allowSettingsWriteBack ?? true,
      expectedDiskContentHash: null,
    });
  }
  notifySettingsChange(relPath, 'change', {
    allowWriteBack: opts?.allowSettingsWriteBack ?? true,
    expectedDiskContentHash: sourceContentHash,
  });
}

/** The raw text of each field that holds a link; it lives with the parser (#667), and is re-exported for older imports. */
export { extractRawFieldTexts };
