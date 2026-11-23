import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createFieldMap } from '../fields/field-map.js';
import { join } from 'node:path';
import {
  DOMAINS, SETTINGS_GROUPS, descriptorsFor, settingsDomainTitle, settingsNotePath, settingsNotesOf,
  vaultAliasFor, vaultAliasValues,
} from '@vault/settings-registry';
import type { SettingsDomain, SettingsNote } from '@vault/settings-registry';
import { parseFrontmatter } from '../parser/frontmatter.js';
import { sha256 } from '../indexer/hash.js';
import { ContentHashMismatchError } from '../pipeline/execute.js';
import { executeDeletion } from '../pipeline/delete.js';
import { readFileIfExists } from '../pipeline/file-writer.js';
import { safeVaultPath } from '../pipeline/safe-path.js';
import type { SettingsChangeContext, SettingsChangeKind } from './hook.js';
import { pendingFieldsOf, projectPendingSettingsNotes, writeSettingsNote } from './note.js';
import type { NoteWriterDeps } from './note.js';
import type { ModelCatalog } from './models.js';
import { getPendingSettingsNoteFields, readJson, writeJson } from './store.js';

/** Set once the domains shown in a folder had their single notes retired (#746). */
const FLAT_NOTES_RETIRED_META_KEY = 'settings.flat_notes_retired';

export interface SettingsReconcileOptions {
  /** Route a disk snapshot not yet represented by the node index through the
   * normal watcher ingest before settings projection. */
  ingestChangedFile?: (relPath: string) => void;
}

export class SettingsIngest {
  private readonly deps: NoteWriterDeps;
  private readonly catalog?: ModelCatalog;
  /** Fired after a Models/ note event invalidates + bumps the catalog, so the
   *  engine can re-arm catalog-dependent subsystems (e.g. the vision extractor
   *  set, whose `visionModel` resolves THROUGH the catalog). Not fired on
   *  domain-note events — those flow through the settings onChange listeners. */
  private readonly onCatalogChange?: () => void;
  private readonly pathToNote = new Map<string, SettingsNote>();

  constructor(deps: NoteWriterDeps, catalog?: ModelCatalog, onCatalogChange?: () => void) {
    this.deps = deps;
    this.catalog = catalog;
    this.onCatalogChange = onCatalogChange;
    for (const domain of DOMAINS) {
      for (const note of settingsNotesOf(domain)) {
        this.pathToNote.set(settingsNotePath(deps.service.settingsDir, note), note);
      }
    }
  }

  /** The domain whose settings note lives at `relPath`, or null. */
  handles(relPath: string): SettingsDomain | null {
    return this.pathToNote.get(relPath)?.domain ?? null;
  }

  /** The settings note at `relPath`, or null. */
  noteAt(relPath: string): SettingsNote | null {
    return this.pathToNote.get(relPath) ?? null;
  }

  /** Read every note of `domain` through {@link onFileEvent}. */
  ingestDomain(domain: SettingsDomain, context: SettingsChangeContext = { allowWriteBack: true }): void {
    for (const note of settingsNotesOf(domain)) {
      this.onFileEvent(settingsNotePath(this.deps.service.settingsDir, note), 'change', context);
    }
  }

  onFileEvent(
    relPath: string,
    kind: SettingsChangeKind,
    context: SettingsChangeContext = { allowWriteBack: true },
  ): void {
    // Models/ notes are user-owned data, not settings notes: any event (change
    // OR unlink) just invalidates the catalog cache and bumps its version so
    // the next read reassembles from the DB — the engine NEVER writes the file
    // back. Unlinking a model note must not regenerate it (unlike the domain
    // notes below, which DO regenerate on unlink).
    if (this.handleCatalogChange(relPath)) return;
    const note = this.noteAt(relPath);
    if (!note) return;
    const { domain } = note;
    if (kind === 'unlink') {
      // Deleting or renaming a settings note is not a reset. Only regenerate
      // while its canonical path is still absent under the pipeline write lock;
      // a same-path recreation belongs to the user, even for a stale unlink.
      if (context.allowWriteBack) {
        writeSettingsNote(this.deps, note, undefined, {
          source: 'watcher',
          expectedDiskContentHash: null,
        });
      }
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(join(this.deps.vaultPath, relPath), 'utf8');
    } catch {
      return; // deleted between event and read; the unlink event will follow
    }
    // Unless the watcher supplied a stricter expectation, bind canonical
    // write-back to the exact bytes parsed above. An external editor can write
    // between this read and executeMutation's write lock; the CAS must reject
    // that stale projection rather than overwrite the newer save.
    const writeBackDiskExpectation = {
      expectedDiskContentHash: context.expectedDiskContentHash !== undefined
        ? context.expectedDiskContentHash
        : sha256(raw),
    };
    const rawTextFields = new Set(descriptorsFor(domain).filter(d => d.type.kind === 'text').map(d => d.key));
    const parsed = parseFrontmatter(raw, rawTextFields);
    if (parsed.parseError !== null) {
      // Unparseable: keep all last-good values, never rewrite mid-edit frontmatter
      // (the sanctioned no-touch — writing a callout into broken YAML would bypass
      // the mutation pipeline). Record the parse error so get-settings surfaces it
      // on the next read; a later successful parse clears it via replaceFromFile.
      console.warn(`[settings] ${relPath}: frontmatter parse error, keeping last-good values (${parsed.parseError})`);
      this.deps.service.noteParseError(note, `frontmatter parse error: ${parsed.parseError}`);
      return;
    }
    const fileValues: Record<string, unknown> = Object.fromEntries(parsed.fields);
    // Upgrade translation (Fix 1): a pre-Phase-3 domain note materializes its
    // model-ref keys as RAW provider ids. The contextual resolver rejects a raw
    // id (SETTINGS_MODEL_REF_UNRESOLVED), preserveRaw would then pin it and a
    // warning callout would render on every reconcile — a stable state that
    // reads as a permanently failed migration. Rewrite any raw id that matches a
    // catalog entry's `model` field into that entry's ref BEFORE replaceFromFile,
    // mirroring the clients' translateRawModelIds. No-op without a catalog.
    this.translateRawModelIds(domain, fileValues);
    // A programmatic patch is committed to SQLite before its Markdown
    // projection. If that projection failed, its durable field ownership wins
    // exactly once over the stale values still present in this file. Every
    // unrelated file key keeps ordinary snapshot authority and is ingested
    // below, including invalid/unknown raw values. After the merged projection
    // succeeds the journal clears, so later human edits to these same keys once
    // again follow the normal file-ingest path.
    const pendingFields = pendingFieldsOf(this.deps.db, note);
    if (pendingFields.length > 0) {
      const effective = this.deps.service.effective(domain);
      for (const key of pendingFields) {
        if (note.keys.includes(key)) {
          fileValues[key] = effective[key];
        } else if (domain === 'engine' && key === 'qwenVisionModel') {
          // The vision rename migration journals deletion of its retired key.
          delete fileValues[key];
        } else if (vaultAliasFor(domain, key) && Object.hasOwn(fileValues, key)) {
          // An old name of a vault key, journaled when the notes still mirrored the vault
          // map: the line reads as the vault's committed value, so it is dropped as a mirror.
          fileValues[key] = vaultAliasValues(domain, this.deps.service.vault())[key];
        }
        // Any other unknown journal key has no canonical service value to
        // replay. Leave its as-authored raw file value intact.
      }
    }
    // Echo safety lives in the service, not here: the canonical write-back
    // materializes every descriptor key, but SettingsService stores
    // deviations-from-default only (default-equal values are dropped at
    // commit), so re-ingesting our own canonical output reduces back to the
    // original deviations set → no change, no version bump, no listener fire.
    const result = this.deps.service.replaceFromFile(note, fileValues);
    // Preserve the user's raw (invalid/unknown) text in the re-rendered file
    // instead of letting writeSettingsNote replace it with the last-good
    // effective value — otherwise the user's typo would vanish from the note
    // before they get a chance to fix it in place.
    const preserveRaw = createFieldMap<unknown>();
    for (const issue of result.issues) {
      if (Object.hasOwn(fileValues, issue.key)) preserveRaw[issue.key] = fileValues[issue.key];
    }
    // A settings note is a file snapshot of the keys it shows: an omitted one is an
    // explicit reset, and a supplied non-null value replaces any prior explicit-null
    // marker (including invalid/unknown raw values preserved below). A supplied
    // null is different — its marker is authored presence and must survive the
    // canonical write-back so SettingsIngest can continue to surface invalid
    // non-nullable nulls instead of materializing a last-good/default value.
    // A line the note no longer shows and that is not kept as written (an old vault name
    // mirroring the vault map) is owned too, so the write-back drops it, null or not.
    const touchedFields = [
      ...note.keys.filter(key => !(key in fileValues)),
      ...Object.entries(fileValues)
        .filter(([key, value]) => (value !== null && value !== undefined)
          || (!note.keys.includes(key) && !Object.hasOwn(preserveRaw, key)))
        .map(([key]) => key),
    ];
    // Canonical write-back (materialize keys, refresh body/issues). writeSettingsNote is
    // idempotent, so a file already in canonical form produces no write and no version bump.
    if (context.allowWriteBack) {
      writeSettingsNote(this.deps, note, preserveRaw, { ...writeBackDiskExpectation, touchedFields });
    }
    // A vault key written through update-settings by an old name journals Vault.md; other
    // notes holding journaled fields are projected here. Without write-back the journal
    // waits for their next ingest.
    if (context.allowWriteBack) projectPendingSettingsNotes(this.deps, [note]);
  }

  /**
   * Tool-path counterpart of {@link onFileEvent} for Models/ notes ONLY.
   *
   * A tool-source `executeMutation` write to a `Settings/Models/*.md` note
   * (e.g. `add-model`, or a future `update-node` toggling `enabled`) bypasses
   * the watcher, so nothing would invalidate the cached catalog until the
   * (later, maybe never) watcher echo. The pipeline calls this via the
   * `notifyToolWrite` hook after every committed tool write; it runs the exact
   * same invalidate + bump + onCatalogChange routing as the watcher path's
   * Models/ branch. Domain settings notes are intentionally NOT handled here —
   * their tool writes already flow through writeSettingsNote/the service, and
   * re-ingesting them from a post-write hook would recurse.
   *
   * Double-firing is by design and harmless: when the watcher later observes the
   * same file it invalidates + bumps again (a second version bump is acceptable —
   * the version is only a monotonic "did the catalog change" signal).
   */
  onToolWrite(relPath: string): void {
    this.handleCatalogChange(relPath);
  }

  /**
   * Shared Models/ invalidation used by both the watcher path ({@link onFileEvent})
   * and the tool path ({@link onToolWrite}). Returns true iff `relPath` is a
   * catalog note (so onFileEvent can stop before the domain-note handling).
   */
  private handleCatalogChange(relPath: string): boolean {
    if (!this.catalog?.handles(relPath)) return false;
    this.catalog.invalidate();
    this.catalog.bumpVersion();
    for (const issue of this.catalog.issues()) {
      console.warn(`[settings] Models/ note failed validation, excluded from catalog: ${issue.path} — ${issue.message}`);
    }
    // A Models/ edit can change what a live model-ref (e.g. visionModel)
    // resolves to; notify so the engine can re-arm catalog-dependent subsystems.
    this.onCatalogChange?.();
    return true;
  }

  /**
   * In-place rewrite of raw provider-id values into catalog refs on the model-ref
   * keys of `fileValues` — the engine-side twin of chat/curator's
   * `translateRawModelIds`. For each model-ref-kind descriptor whose file value
   * is a non-empty string that does NOT resolve as a ref (`catalog.resolve(v) ===
   * null`) but whose raw string equals a catalog entry's `model` field, replace
   * it with that entry's title (bare — the frontmatter parser strips `[[...]]`
   * brackets on read-back, so a bracketed value would re-store bracket-free on the
   * next reconcile and never converge byte-identical; a bare title round-trips
   * unchanged). Requires the optional catalog; a no-op without it, so ingests
   * constructed without a catalog behave exactly as before.
   */
  private translateRawModelIds(domain: SettingsDomain, fileValues: Record<string, unknown>): void {
    if (!this.catalog) return;
    const modelRefKeys = descriptorsFor(domain).filter(d => d.type.kind === 'model-ref').map(d => d.key);
    if (modelRefKeys.length === 0) return;
    const entries = this.catalog.entries();
    for (const key of modelRefKeys) {
      const raw = fileValues[key];
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      if (this.catalog.resolve(raw) !== null) continue; // already resolves as a ref — leave it
      const match = entries.find(e => e.model === raw);
      if (match) {
        // If the stored value already names this same catalog entry, preserve
        // its representation. Startup model migration stores bracketed refs;
        // reconciling another field from an older raw-id note must not rewrite
        // that last-good value to a bare title as a side effect.
        const prior = this.deps.service.stored(domain)[key];
        const priorMatch = this.catalog.resolve(prior);
        fileValues[key] = priorMatch?.title === match.title ? prior : match.title;
      }
    }
  }

  /**
   * Boot-time pass: existing notes go through the exact live-edit path
   * (which preserves invalid/unknown raw text via preserveRaw and leaves
   * unparseable notes completely untouched); missing notes are created.
   * No unconditional rewrite — a bare `writeSettingsNote(deps, domain)`
   * here would clobber preserved raw text and erase a malformed mid-edit
   * file at restart.
   */
  reconcile(options: SettingsReconcileOptions = {}): void {
    this.retireFlatNotes();
    for (const [relPath, note] of this.pathToNote) {
      try {
        const absPath = join(this.deps.vaultPath, relPath);
        if (existsSync(absPath)) {
          let diskHash: string;
          try {
            diskHash = sha256(readFileSync(absPath, 'utf8'));
          } catch {
            // Deleted between existence check and read. Preserve the live-event
            // contract: its unlink event owns any later regeneration.
            continue;
          }
          const indexed = this.deps.db.prepare(
            'SELECT content_hash FROM nodes WHERE file_path = ?',
          ).get(relPath) as { content_hash: string } | undefined;

          if (options.ingestChangedFile && indexed?.content_hash !== diskHash) {
            // Marker/value state is still for the indexed snapshot. Normal
            // watcher ingest updates both before its settings hook projects.
            options.ingestChangedFile(relPath);
            continue;
          }

          const stableIndexedHash = indexed?.content_hash === diskHash
            ? indexed.content_hash
            : undefined;
          this.onFileEvent(relPath, 'change', {
            allowWriteBack: true,
            ...(stableIndexedHash !== undefined
              ? { expectedDiskContentHash: stableIndexedHash }
              : {}),
          });
        } else {
          writeSettingsNote(this.deps, note, undefined, {
            source: 'watcher',
            expectedDiskContentHash: null,
          });
        }
      } catch (err) {
        if (err instanceof ContentHashMismatchError) {
          // A concurrent save won after this domain's baseline check. Leave its
          // bytes untouched; the live watcher event will ingest marker + value
          // state together. Other domains still reconcile this boot.
          console.warn(`[settings] ${relPath}: changed during reconcile; deferring write-back`);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Once per database (#746): the domains now shown in a folder of notes (Curator, Engine)
   * had a single note, `Settings/Curator.md`. At the first start with the folder, that note
   * is read as before, as a snapshot of the whole domain, so a change made in it while the
   * Engine was stopped still counts. Startup calls this before settings consumers start
   * (no file is written or removed here), and {@link reconcile} retires the notes.
   */
  importFlatNotes(): void {
    if (readJson<string | null>(this.deps.db, FLAT_NOTES_RETIRED_META_KEY, null) !== null) return;
    for (const domain of Object.keys(SETTINGS_GROUPS) as SettingsDomain[]) {
      try {
        this.importFlatNote(domain);
      } catch (err) {
        console.error(`[settings] reading the single ${domain} settings note failed:`,
          err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Retire the single notes: each is read once more (as {@link importFlatNotes} reads it),
   * and the folder's notes are written from the store by the loop after this. The old note
   * is removed when nothing in it is left out of the store: every value was taken (none
   * refused or unknown, no old vault name differing from the vault map). Otherwise it
   * stays, as an ordinary note no longer read, with a warning naming those lines; so does
   * one saved while it was being retired. Retried at the next start only if reading or
   * removing a note failed.
   */
  private retireFlatNotes(): void {
    const { db } = this.deps;
    if (readJson<string | null>(db, FLAT_NOTES_RETIRED_META_KEY, null) !== null) return;
    let done = true;
    for (const domain of Object.keys(SETTINGS_GROUPS) as SettingsDomain[]) {
      try {
        if (!this.retireFlatNote(domain)) done = false;
      } catch (err) {
        done = false;
        console.error(`[settings] retiring the single ${domain} settings note failed; the next start retries:`,
          err instanceof Error ? err.message : err);
      }
    }
    if (done) writeJson(db, FLAT_NOTES_RETIRED_META_KEY, new Date().toISOString());
  }

  /**
   * Read `domain`'s single note into the store as a whole-domain snapshot. Returns the
   * bytes read and the lines not taken, the parse error, or null when there is no note.
   */
  private importFlatNote(domain: SettingsDomain):
      { raw: string; leftOut: string[] } | { parseError: string } | null {
    const { db, vaultPath, service } = this.deps;
    const relPath = settingsNotePath(service.settingsDir, { domain, group: null });
    // The settings folder comes from the environment: never read or remove outside the vault.
    const raw = readFileIfExists(safeVaultPath(vaultPath, relPath));
    if (raw === null) return null;
    const textKeys = new Set(descriptorsFor(domain).filter(d => d.type.kind === 'text').map(d => d.key));
    const parsed = parseFrontmatter(raw, textKeys);
    if (parsed.parseError !== null) return { parseError: parsed.parseError };
    const fileValues: Record<string, unknown> = Object.fromEntries(parsed.fields);
    this.translateRawModelIds(domain, fileValues);
    // Committed values the note was never written with win over its stale lines, as at
    // any ingest; the journal stays for the folder's notes to consume.
    const effective = service.effective(domain);
    const known = new Set(descriptorsFor(domain).map(d => d.key));
    for (const key of getPendingSettingsNoteFields(db, domain)) {
      if (known.has(key)) fileValues[key] = effective[key];
      else if (domain === 'engine' && key === 'qwenVisionModel') delete fileValues[key];
      else if (vaultAliasFor(domain, key) && Object.hasOwn(fileValues, key)) {
        fileValues[key] = vaultAliasValues(domain, service.vault())[key];
      }
    }
    const whole: SettingsNote = { domain, group: null, summary: null, keys: [...known] };
    const result = service.replaceFromFile(whole, fileValues);
    service.clearNoteIssues(whole);
    return { raw, leftOut: [...new Set(result.issues.map(issue => issue.key))].sort() };
  }

  /** Returns false when the next start should try again. */
  private retireFlatNote(domain: SettingsDomain): boolean {
    const { db, writeLock, vaultPath, service } = this.deps;
    const relPath = settingsNotePath(service.settingsDir, { domain, group: null });
    const folder = `${service.settingsDir}/${settingsDomainTitle(domain)}/`;
    const kept = (why: string): boolean => {
      console.warn(`[settings] ${relPath} is no longer read: ${domain} settings are now in ${folder}. `
        + `It was left in place because ${why}. Copy what you need into the notes in ${folder}, then delete it.`);
      return true;
    };
    const imported = this.importFlatNote(domain);
    if (imported === null) return true;
    if ('parseError' in imported) return kept(`its frontmatter does not parse (${imported.parseError})`);
    if (imported.leftOut.length > 0) return kept(`these lines were not taken: ${imported.leftOut.join(', ')}`);
    // Only the bytes just read are removed. A save made since holds text that was not read;
    // the note is kept with it and is not read again, since the folder's notes are written
    // from the store right after this and would win over a later reading (Codex, #747).
    const readHash = sha256(imported.raw);
    const absPath = safeVaultPath(vaultPath, relPath);
    const unchanged = (): boolean => {
      const now = readFileIfExists(absPath);
      return now !== null && sha256(now) === readHash;
    };
    const savedMeanwhile = 'it was saved while it was being retired, and that save was not read';
    if (!unchanged()) return kept(savedMeanwhile);
    const row = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string } | undefined;
    if (row) {
      executeDeletion(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: row.id,
        file_path: relPath,
        unlink_file: false,
        reason: `${domain} settings moved to ${folder} (#746)`,
      });
    }
    // The write lock holds back Engine writers only, not Obsidian: the file is read once
    // more right before it is unlinked. A note kept here is indexed again by the watcher.
    const removed = writeLock.withLockSync(absPath, () => {
      if (!unchanged()) return false;
      unlinkSync(absPath);
      return true;
    });
    if (!removed) return kept(savedMeanwhile);
    console.log(`[settings] ${domain} settings are now in ${folder}; removed ${relPath}, which held nothing else`);
    return true;
  }
}
