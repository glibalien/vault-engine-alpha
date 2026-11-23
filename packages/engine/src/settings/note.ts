import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DOMAINS, descriptorsFor, normalizeModelRef, settingsDomainTitle, settingsNoteOfKey, settingsNotePath,
  settingsNoteTitle, settingsNotesOf, vaultAliasesOf,
} from '@vault/settings-registry';
import type { SettingsDomain, SettingIssue, ModelCatalogEntry, SettingsNote } from '@vault/settings-registry';
import { createFieldMap } from '../fields/field-map.js';
import { ContentHashMismatchError, executeMutation } from '../pipeline/execute.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import type { SyncLogger } from '../sync/sync-logger.js';
import type { SettingsService } from './service.js';
import { clearPendingSettingsNoteFields, getPendingSettingsNoteFields } from './store.js';
import { notifySettingsChange } from './hook.js';
import { sha256 } from '../indexer/hash.js';
import { typeKey } from '../parser/type-key.js';

/**
 * The pending journal fields `note` owns: its own keys, and for a domain's first note also
 * the journaled keys no note shows (a retired key a migration removes, an old vault name).
 */
export function pendingFieldsOf(db: Database.Database, note: SettingsNote): string[] {
  const first = settingsNotesOf(note.domain)[0] === note;
  return getPendingSettingsNoteFields(db, note.domain)
    .filter(field => note.keys.includes(field) || (first && settingsNoteOfKey(note.domain, field) === null));
}

/** The other notes of a domain shown in a folder, as links: `[[Settings/Curator/Models|Models]]`. */
function siblingLinks(settingsDir: string, note: SettingsNote): string {
  return settingsNotesOf(note.domain)
    .map(other => other === note
      ? `**${other.group}**`
      : `[[${settingsNotePath(settingsDir, other).replace(/\.md$/, '')}|${other.group}]]`)
    .join(' · ');
}

/** Values set at install rather than in a settings note; Settings/Vault.md lists them. */
export interface InstallFolders { settingsDir: string; attachmentDir: string | null; typeKey?: string; }

export function noteBodyFor(
  note: SettingsNote, issues: SettingIssue[], effective: Record<string, unknown>,
  promptDefaults: Record<string, string> = {}, stalePrompts: Set<string> = new Set(),
  folders?: InstallFolders,
): string {
  const { domain } = note;
  const lines: string[] = [];
  if (note.group !== null) {
    if (note.summary) lines.push(note.summary, '');
    if (folders) lines.push(`${settingsDomainTitle(domain)} settings: ${siblingLinks(folders.settingsDir, note)}`, '');
  }
  if (domain === 'vault') {
    lines.push('The names the suite expects in your notes: kinds of notes (types), fields, what each status value means, and folders.');
    lines.push('Leave a kind or field empty (none) to turn off what depends on it.', '');
    if (folders) {
      lines.push('Set at install, not here:');
      lines.push(`- Settings: \`${folders.settingsDir}\` (VAULT_SETTINGS_DIR)`);
      if (folders.attachmentDir !== null) lines.push(`- Attachments: \`${folders.attachmentDir}\` (VAULT_ATTACHMENT_DIR)`);
      if (folders.typeKey !== undefined) lines.push(`- Type key: \`${folders.typeKey}\`, the frontmatter key that holds a note's types (VAULT_TYPE_KEY)`);
      lines.push('');
    }
  }
  if (issues.length > 0) {
    lines.push('> [!warning] Settings issues');
    for (const i of issues) {
      // An unresolved model ref (like an invalid value) is rejected at write time,
      // so the last-good effective value is what's actually running — show it too.
      const effectiveNote = i.code === 'SETTINGS_INVALID_VALUE' || i.code === 'SETTINGS_MODEL_REF_UNRESOLVED'
        ? ` (value in effect: \`${JSON.stringify(effective[i.key])}\`)` : '';
      lines.push(`> - **${i.key}** — ${i.message}${effectiveNote}`);
    }
    lines.push('');
  }
  lines.push('## Keys', '');
  const shown = new Set(note.keys);
  for (const d of descriptorsFor(domain).filter(d => shown.has(d.key))
    .sort((a, b) => note.keys.indexOf(a.key) - note.keys.indexOf(b.key))) {
    lines.push(`### ${d.key}`, '');
    lines.push(d.description, '');
    const typeLabel = d.type.kind === 'enum' ? `enum: ${d.type.values.join(' | ')}` : d.type.kind;
    lines.push(`- Type: ${typeLabel}`);
    lines.push(`- Default: \`${JSON.stringify(d.default)}\`${d.type.kind === 'text' ? ' (blank = built-in)' : ''}`);
    lines.push(`- Applies: ${d.reload === 'restart' ? 'after engine restart' : d.reload === 're-arm' ? 'live (subsystem re-arms)' : 'live (next use)'}`);
    if (d.envSeed) lines.push(`- Seeded from env: \`${d.envSeed.var}\` (env is ignored after first seeding)`);
    if (d.type.kind === 'text') {
      lines.push('');
      const builtIn = promptDefaults[d.key];
      if (builtIn === undefined) {
        lines.push(`> [!note] Built-in default will appear here once the ${domain} client connects.`);
      } else {
        lines.push(`> [!note]- Built-in default (${builtIn.length} chars)`);
        for (const line of builtIn.split('\n')) lines.push(`> ${line}`);
      }
      if (stalePrompts.has(d.key)) {
        lines.push('', '> [!warning] Built-in default has changed');
        lines.push(`> The built-in prompt was updated since this override was set.`);
        lines.push(`> Clear \`${d.key}\` in frontmatter to adopt the new default.`);
      }
    }
    lines.push('');
  }
  const moved = settingsNotesOf(domain)[0] === note ? vaultAliasesOf(domain) : [];
  if (moved.length > 0) {
    lines.push('## Set in Vault.md', '');
    lines.push('These settings moved to Vault.md, the vault map, under new names. Set them there; a line for one here is not read.', '');
    for (const alias of moved) lines.push(`- ${alias.key}: Vault.md ${alias.vaultKey}`);
    lines.push('');
  }
  lines.push('*This body is engine-owned documentation — edits here are overwritten. Edit settings in the frontmatter (Obsidian: Properties panel).*');
  return lines.join('\n') + '\n';
}

export interface NoteWriterDeps {
  db: Database.Database;
  writeLock: WriteLockManager;
  vaultPath: string;
  syncLogger?: SyncLogger;
  service: SettingsService;
}

/**
 * Presentation-only re-wrap: `model-ref`-kind descriptor values that are
 * non-null strings render as `[[${normalizeModelRef(value)}]]` in frontmatter,
 * so Obsidian's Properties panel turns them into live wikilinks — real graph
 * edges to the referenced Settings/Models/ catalog note — regardless of
 * whether the stored/effective value happened to be bare or bracketed. The
 * STORED value is never touched here; `normalizeModelRef` already treats
 * bracketed and bare forms as equal everywhere else (validation, deviations
 * filtering, ingest — see @vault/settings-registry), so this is a no-op on
 * what's persisted. A nullable model-ref key at `null` is left alone (not a
 * string, so it's skipped here and stays omitted from frontmatter, same as
 * every other null-valued settings key).
 */
function withModelRefsWrapped(
  domain: SettingsDomain, values: Record<string, unknown>,
): Record<string, unknown> {
  const modelRefKeys = descriptorsFor(domain).filter(d => d.type.kind === 'model-ref').map(d => d.key);
  if (modelRefKeys.length === 0) return values;
  const rendered = { ...values };
  for (const key of modelRefKeys) {
    const value = rendered[key];
    if (typeof value !== 'string') continue;
    rendered[key] = `[[${normalizeModelRef(value)}]]`;
  }
  return rendered;
}

/**
 * Vault kinds and fields set to none. Vault.md must show them as a bare `key:`: a key
 * missing from the file reads back as a reset to its default. A key whose default is null
 * needs no line, and the other domains' keys render as before.
 */
function authoredNulls(
  domain: SettingsDomain, effective: Record<string, unknown>, preserveRaw: Record<string, unknown> | undefined,
): string[] {
  if (domain !== 'vault') return [];
  const keys = descriptorsFor('vault').filter(d => d.default !== null).map(d => d.key);
  return keys.filter(key => effective[key] === null && !(preserveRaw && Object.hasOwn(preserveRaw, key)));
}

/** The rendered wikilink text of each model-ref key, supplied as the field's raw text.
 *  Keys pinned by `preserveRaw` keep the pipeline's stored as-supplied text instead. */
function modelRefRawTexts(
  domain: SettingsDomain, wrapped: Record<string, unknown>, preserveRaw: Record<string, unknown> | undefined,
): Record<string, string> {
  const raw = createFieldMap<string>();
  for (const d of descriptorsFor(domain)) {
    if (d.type.kind !== 'model-ref' || (preserveRaw && Object.hasOwn(preserveRaw, d.key))) continue;
    const value = Object.hasOwn(wrapped, d.key) ? wrapped[d.key] : undefined;
    if (typeof value === 'string') raw[d.key] = value;
  }
  return raw;
}

/**
 * Render and write one settings note through the single mutation pipeline: a domain's
 * note, or one group note of a domain shown in a folder (#746), with that note's keys only.
 * Idempotent: calling this twice in a row with no
 * intervening settings change produces identical file bytes and does not
 * bump `nodes.version` — `executeMutation`'s Stage-6 no-op rule (rendered
 * hash matches both the on-disk file and the stored `content_hash`, and
 * identity plus explicit-null marker state are unchanged) already provides
 * this, so no pre-write probe is needed here.
 *
 * `preserveRaw` (optional): frontmatter values to keep verbatim, spread
 * AFTER the effective map so callers (e.g. the Task 6 ingest path) can
 * pin specific keys to their as-supplied raw value rather than the
 * registry-computed effective one.
 *
 * `touchedFields` is caller-owned mutation intent, not a property of the
 * canonical projection. Effective values for untouched keys are still passed
 * through the pipeline, but their persisted explicit-null markers overlay
 * those values. Body-only projections therefore pass no touched fields, while
 * a settings patch or migration names only the keys it actually changed or
 * reset. Watcher-source missing-note/unlink projections keep their existing
 * snapshot semantics; the watcher path replaces marker state independently of
 * this tool-path list.
 *
 * Durable ownership is registered at the programmatic settings commit seam,
 * not here. This writer consumes the pending programmatic fields this note owns
 * ({@link pendingFieldsOf}) and combines them with the current caller's transient
 * ownership. In particular, a failed file-snapshot compare-and-swap must not journal
 * the stale snapshot fields and later overlay them onto a newer human edit.
 */
export function writeSettingsNote(
  deps: NoteWriterDeps,
  note: SettingsNote,
  preserveRaw?: Record<string, unknown>,
  options: {
    source?: 'tool' | 'watcher';
    expectedDiskContentHash?: string | null;
    touchedFields?: readonly string[];
  } = {},
): void {
  const { db, writeLock, vaultPath, syncLogger, service } = deps;
  const { domain } = note;
  const filePath = settingsNotePath(service.settingsDir, note);
  const all = service.effective(domain);
  const effective = Object.fromEntries(note.keys.filter(key => Object.hasOwn(all, key)).map(key => [key, all[key]]));
  const wrapped = withModelRefsWrapped(domain, effective);
  const fields = { ...wrapped, ...preserveRaw };
  // Supplying the current refs as raw text stops the pipeline from carrying a
  // raw ref ingested from an earlier file edit over a changed value.
  const rawFieldTexts = modelRefRawTexts(domain, wrapped, preserveRaw);
  const body = noteBodyFor(note, service.noteIssues(note), effective, service.promptDefaults(domain),
    service.stalePrompts(domain), { settingsDir: service.settingsDir, attachmentDir: service.attachmentDir, typeKey: typeKey() });
  const authoredNullFields = authoredNulls(domain, effective, preserveRaw);
  // The journal's fields no note shows go to the first note only ({@link pendingFieldsOf}),
  // but a caller's own touched fields name lines in the note being written: one that is no
  // setting of the domain (an old vault name the ingest drops, null or not) is this note's.
  const pending = pendingFieldsOf(db, note);
  const owned = (field: string): boolean => note.keys.includes(field)
    || settingsNoteOfKey(domain, field) === null;
  const touchedFields = [...new Set([
    ...pending,
    ...(options.touchedFields ?? []).filter(owned),
  ])].sort();

  const existing = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(filePath) as { id: string } | undefined;
  const result = executeMutation(db, writeLock, vaultPath, {
    source: options.source ?? 'tool',
    node_id: existing?.id ?? null,
    file_path: filePath,
    title: settingsNoteTitle(note),
    types: [],
    fields,
    ...(Object.keys(rawFieldTexts).length > 0 ? { raw_field_texts: rawFieldTexts } : {}),
    touchedFields,
    ...(authoredNullFields.length > 0 ? { authoredNullFields } : {}),
    body,
    // Engine-rendered and re-ingested: the note's bytes must be the render.
    canonicalizeLinks: false,
    ...(options.expectedDiskContentHash !== undefined
      ? { expectedDiskContentHash: options.expectedDiskContentHash }
      : {}),
  }, syncLogger);
  // A no-op is a successful projection too: desired bytes, DB fields, and
  // marker state already match, so no ownership remains to replay.
  if (pending.length > 0) clearPendingSettingsNoteFields(db, domain, pending);
  void result;
}

/**
 * Write the notes of `domain` (all of them, or `notes`) after a programmatic change: a
 * patch writes the notes that show its keys (`settingsNotesForKeys`), a migration all.
 * Each note takes the touched fields it shows.
 */
export function writeSettingsNotes(
  deps: NoteWriterDeps,
  domain: SettingsDomain,
  options: { notes?: readonly SettingsNote[]; touchedFields?: readonly string[] } = {},
): void {
  for (const note of options.notes ?? settingsNotesOf(domain)) {
    writeSettingsNote(deps, note, undefined, { touchedFields: options.touchedFields ?? [] });
  }
}

/**
 * Project every settings note (other than those in `skip`) that owns journaled fields: a
 * write elsewhere committed values it shows (a vault key written through an old name, say).
 * Each goes through {@link projectSettingsNoteUnlessUnread}. A caller skips the notes it
 * has just written: when such a write failed, its journal must wait for the note's next
 * ingest or restart, not be consumed by writing the note again from the store.
 */
export function projectPendingSettingsNotes(deps: NoteWriterDeps, skip: readonly SettingsNote[] = []): void {
  for (const domain of DOMAINS) {
    if (getPendingSettingsNoteFields(deps.db, domain).length === 0) continue;
    for (const note of settingsNotesOf(domain)) {
      if (skip.includes(note)) continue;
      if (pendingFieldsOf(deps.db, note).length > 0) projectSettingsNoteUnlessUnread(deps, note);
    }
  }
}

/**
 * Project a note for fields a write elsewhere committed with a pending journal. The note
 * is re-read through its own ingest (the settings change hook), so its journaled fields
 * take their committed values and every other line keeps what was written there, unknown
 * and invalid values included. A note holding a save the index has not read yet is left
 * alone: the journal carries the fields into that save's ingest. A missing note is created
 * only while still absent. Returns whether the note's journal was consumed.
 */
export function projectSettingsNoteUnlessUnread(deps: NoteWriterDeps, note: SettingsNote): boolean {
  const relPath = settingsNotePath(deps.service.settingsDir, note);
  let diskHash: string | null;
  try {
    diskHash = sha256(readFileSync(join(deps.vaultPath, relPath), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    diskHash = null;
  }
  if (diskHash === null) {
    try {
      writeSettingsNote(deps, note, undefined, { source: 'watcher', expectedDiskContentHash: null });
    } catch (err) {
      // A note created meanwhile is the user's; its ingest reads the journal.
      if (!(err instanceof ContentHashMismatchError)) throw err;
    }
  } else {
    const indexed = deps.db.prepare('SELECT content_hash FROM nodes WHERE file_path = ?')
      .get(relPath) as { content_hash: string } | undefined;
    if (indexed?.content_hash !== diskHash) return false;
    notifySettingsChange(relPath, 'change', { allowWriteBack: true, expectedDiskContentHash: diskHash });
  }
  return pendingFieldsOf(deps.db, note).length === 0;
}

/**
 * Create a model note IF ABSENT. Never overwrites — model note bodies are
 * user-owned (the whole point of Models/ is that the user can annotate a
 * model's notes/pricing/quirks in prose without the engine clobbering it on
 * the next boot or Models/ file event). Absence is checked via `nodes.file_path`
 * — a DB lookup, not an fs existence check — so a note whose file the user
 * has hand-edited (but which the indexer already knows about) is still
 * correctly treated as "present" and left alone. The create itself is
 * create-if-absent on disk, so a file the index has not seen yet is kept too.
 * Returns false when either already holds a note.
 */
export function writeModelNoteIfAbsent(deps: NoteWriterDeps, entry: ModelCatalogEntry): boolean {
  const { db, writeLock, vaultPath, syncLogger, service } = deps;
  const filePath = `${service.settingsDir}/Models/${entry.title}.md`;

  const existing = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(filePath) as { id: string } | undefined;
  if (existing) return false;

  // Frontmatter: always provider/model/enabled; capability + pricing fields only
  // when present on the entry. Absent optional fields are OMITTED entirely — a
  // null is never written (that would materialize as a bogus catalog value).
  const fields: Record<string, unknown> = { provider: entry.provider, model: entry.model, enabled: entry.enabled };
  if (entry.vision !== undefined) fields['vision'] = entry.vision;
  if (entry.tools !== undefined) fields['tools'] = entry.tools;
  if (entry.contextLength !== undefined) fields['context_length'] = entry.contextLength;
  if (entry.pricing !== undefined) {
    fields['price_input'] = entry.pricing.input;
    fields['price_output'] = entry.pricing.output;
    if (entry.pricing.cacheRead !== undefined) fields['price_cache_read'] = entry.pricing.cacheRead;
    if (entry.pricing.cacheWrite !== undefined) fields['price_cache_write'] = entry.pricing.cacheWrite;
  }

  // Body capabilities line (only the truthy/present ones): e.g.
  // "`vision` · `tools` · 1,000,000-token context."
  const caps: string[] = [];
  if (entry.vision) caps.push('`vision`');
  if (entry.tools) caps.push('`tools`');
  if (entry.contextLength !== undefined) caps.push(`${entry.contextLength.toLocaleString('en-US')}-token context`);

  const bodyLines = [`${entry.title} is a ${entry.provider} model (model id: \`${entry.model}\`).`];
  if (caps.length > 0) bodyLines.push(`${caps.join(' · ')}.`);
  bodyLines.push(
    `It is currently ${entry.enabled ? 'enabled' : 'disabled'} in the model catalog.`,
    '',
    "*This note's body is yours — the engine never rewrites it. Frontmatter (provider/model/enabled) is validated on ingest.*",
  );
  const body = bodyLines.join('\n') + '\n';

  try {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: filePath,
      title: entry.title,
      types: [],
      fields,
      body,
      // A note on disk that the index has not seen yet (saved offline, or a moment ago)
      // is the user's: create only while the path is absent, and let the watcher ingest it.
      expectedDiskContentHash: null,
    }, syncLogger);
  } catch (err) {
    if (err instanceof ContentHashMismatchError) return false;
    throw err;
  }
  return true;
}
