/**
 * Module-singleton change hook the watcher calls into when a settings note
 * changes on disk. Same pattern as src/indexer/ignore.ts's setExcludeDirs:
 * a plain module-level variable, set once at boot (src/index.ts, Task 8) and
 * read by the watcher on every file event. Kept out of watcher.ts's own
 * dependency list so the watcher stays agnostic of the settings subsystem.
 */

import type { SettingsDomain } from '@vault/settings-registry';

export type SettingsChangeKind = 'change' | 'unlink';
export interface SettingsChangeContext {
  allowWriteBack: boolean;
  /** Optional on-disk CAS forwarded to a settings-note write-back. `null`
   * means the path must still be absent when the write lock is acquired. */
  expectedDiskContentHash?: string | null;
}

let hook: ((relPath: string, kind: SettingsChangeKind, context: SettingsChangeContext) => void) | null = null;

export function setSettingsChangeHook(
  fn: ((relPath: string, kind: SettingsChangeKind, context: SettingsChangeContext) => void) | null,
): void {
  hook = fn;
}

/** No-op if no hook is registered. Never throws — a hook failure must not break the watcher. */
export function notifySettingsChange(
  relPath: string,
  kind: SettingsChangeKind,
  context: SettingsChangeContext = { allowWriteBack: true },
): void {
  try {
    hook?.(relPath, kind, context);
  } catch (err) {
    console.error('[settings] change hook failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Tool-write counterpart of {@link setSettingsChangeHook}. The watcher path
 * notifies settings changes via `notifySettingsChange` from `processFileChange`,
 * but tool-path `executeMutation` writes never go through the watcher — so a tool
 * that writes a `Settings/Models/*.md` note (e.g. `add-model`, or a future
 * `update-node` toggling `enabled`) would leave the cached ModelCatalog stale
 * until the (later, maybe never) watcher echo arrives. `executeMutation` calls
 * `notifyToolWrite(file_path)` after every committed tool-source write, and
 * `delete-node`, `batch-mutate` and undo call it after a committed delete or
 * restore (#595: the watcher's unlink finds no node row left); the wired
 * handler (src/index.ts) routes only catalog paths — `catalog.handles(path)` —
 * to invalidate + bumpVersion + onCatalogChange, exactly the watcher path's
 * Models/ branch. Non-catalog tool writes (the overwhelming majority) are a cheap
 * no-op in the handler. Domain settings notes are deliberately NOT re-ingested
 * here — their tool writes already flow through writeSettingsNote/the service
 * (generic node-edit tools refuse them; see {@link settingsNoteDomain}), and
 * re-ingesting from a post-write hook would recurse.
 */
let toolWriteHook: ((relPath: string) => void) | null = null;

export function setToolWriteHook(fn: ((relPath: string) => void) | null): void {
  toolWriteHook = fn;
}

/** No-op if no hook is registered. Never throws — a hook failure must not break a tool write. */
export function notifyToolWrite(relPath: string): void {
  try {
    toolWriteHook?.(relPath);
  } catch (err) {
    console.error('[settings] tool-write hook failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Domain settings notes render the settings store. A generic node edit to one
 * would change the note but not the effective settings, and the next settings
 * write-back would overwrite it, so generic node-edit tools ask this first and
 * refuse. Wired at boot to `SettingsIngest.handles`; with no resolver
 * registered, nothing is a settings note.
 */
let settingsNoteResolver: ((relPath: string) => SettingsDomain | null) | null = null;

export function setSettingsNoteResolver(fn: ((relPath: string) => SettingsDomain | null) | null): void {
  settingsNoteResolver = fn;
}

/** The settings domain whose note lives at `relPath`, or null. */
export function settingsNoteDomain(relPath: string): SettingsDomain | null {
  return settingsNoteResolver?.(relPath) ?? null;
}

/**
 * The memory note is the owner's own editing surface: an edit to it is read as the
 * owner's, and a `new:` block in it becomes a memory with source `owner`. Generic
 * node-edit tools ask for its path before a signed-in chat client writes a note (#532).
 * Set at boot; with no path set, no note is the memory note.
 */
let memoryNoteRelPath: string | null = null;

export function setMemoryNotePath(relPath: string | null): void {
  memoryNoteRelPath = relPath;
}

/** The vault-relative path of the editable memory note, or null when none is set. */
export function memoryNotePathOrNull(): string | null {
  return memoryNoteRelPath;
}
