import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  validateDomainPatch, effectiveSettings, descriptorsFor, defaultsFor, deviationsOnly, normalizeModelRef,
  vaultAliasFor, vaultAliasesOf, vaultAliasValues, settingsNotesOf, settingsNotesForKeys, settingsNoteForIssue,
  settingsNoteOfKey, settingsNotePath,
} from '@vault/settings-registry';
import type {
  SettingsDomain, SettingIssue, EngineSettings, WikiSettings, ModelCatalogEntry, VaultAlias, VaultSettings,
  SettingsNote,
} from '@vault/settings-registry';
import {
  getStoredSettings, setStoredSettings, getSettingsVersion, isDomainSeeded,
  getPromptDefaults, setPromptDefaults, getPromptDefaultHashes, setPromptDefaultHashes,
  getPromptOverrideHashes, setPromptOverrideHashes,
  addPendingSettingsNoteFields,
} from './store.js';
import { isVisionCapableEntry } from './models.js';
import { ProvenanceError, readProvenanceLimits } from '../provenance/limits.js';
import { vaultNameIssues } from './vault.js';
import { createFieldMap } from '../fields/field-map.js';

export interface ApplyResult {
  applied: string[];
  issues: SettingIssue[];
  changed: boolean;
  /** Vault keys written through aliases of this domain's old keys (see VAULT_ALIASES).
   *  The caller projects Settings/Vault.md for them. Absent when no alias was written. */
  vaultApplied?: string[];
}
export interface PromptDefaultsResult { changed: boolean; applied: string[]; issues: SettingIssue[]; }
export interface ApplyPatchOptions {
  /** Persist applied-field ownership for a later Markdown projection retry. */
  journalProjection?: boolean;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Key-order-insensitive comparison of two flat settings objects. Values are
 * scalars or arrays (whose order IS meaningful), so a shallow key sort suffices
 * — except `model-ref` kind keys, which compare by `normalizeModelRef`: the
 * frontmatter parser strips `[[...]]` brackets from every field it reads back
 * off disk, so the exact same catalog reference can legitimately arrive
 * bracketed (an API patch) or bare (a settings-note re-ingest). Raw-string
 * comparison would treat that as a change every time, spuriously bumping the
 * version and firing re-arm listeners.
 */
function sameValue(domain: SettingsDomain, a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const modelRefKeys = new Set(
    descriptorsFor(domain).filter(d => d.type.kind === 'model-ref').map(d => d.key),
  );
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const same = modelRefKeys.has(k)
      ? normalizeModelRef(a[k]) === normalizeModelRef(b[k])
      : JSON.stringify(a[k]) === JSON.stringify(b[k]);
    if (!same) return false;
  }
  return true;
}

export class SettingsService {
  readonly settingsDir: string;
  private readonly db: Database.Database;
  /** Each note's issues from the last write that reached it, by {@link noteKey}. */
  private readonly lastIssues = new Map<string, SettingIssue[]>();
  private readonly listeners = new Map<SettingsDomain, Array<() => void>>();
  private modelRefResolver: ((ref: unknown) => ModelCatalogEntry | null) | null = null;

  /** The attachment folder (VAULT_ATTACHMENT_DIR, resolved at boot); reported, never stored. */
  readonly attachmentDir: string | null;

  constructor(db: Database.Database, opts: { settingsDir: string; attachmentDir?: string }) {
    this.db = db;
    this.settingsDir = opts.settingsDir;
    this.attachmentDir = opts.attachmentDir ?? null;
  }

  engine(): EngineSettings { return effectiveSettings<EngineSettings>('engine', this.stored('engine')); }
  wiki(): WikiSettings { return effectiveSettings<WikiSettings>('wiki', this.stored('wiki')); }
  /** The vault map. A kind or field that is null is none. */
  vault(): VaultSettings { return effectiveSettings<VaultSettings>('vault', this.stored('vault')); }
  /** The domain's own keys: what its note renders and stores. */
  effective(domain: SettingsDomain): Record<string, unknown> {
    return effectiveSettings<Record<string, unknown>>(domain, this.stored(domain));
  }
  /** What get-settings reports, and what the domain's note renders: its own keys, plus its
   *  old keys that moved to the vault domain, read from the vault map under their old names. */
  effectiveWithAliases(domain: SettingsDomain): Record<string, unknown> {
    return { ...this.effective(domain), ...vaultAliasValues(domain, this.vault()) };
  }
  stored(domain: SettingsDomain): Record<string, unknown> { return getStoredSettings(this.db, domain); }
  /** What get-settings reports as stored: the domain's deviations, plus the stored vault
   *  deviations of its old keys under their old names. */
  storedWithAliases(domain: SettingsDomain): Record<string, unknown> {
    const vault = this.stored('vault');
    return {
      ...this.stored(domain),
      ...Object.fromEntries(vaultAliasesOf(domain).filter(alias => Object.hasOwn(vault, alias.vaultKey))
        .map(alias => [alias.key, vault[alias.vaultKey]])),
    };
  }
  /** Every note's issues from the last write that reached it; for the vault domain also
   *  each designated name the vault lacks. */
  issues(domain: SettingsDomain): SettingIssue[] {
    const last = settingsNotesOf(domain).flatMap(note => this.lastIssues.get(noteKey(note)) ?? []);
    return domain === 'vault' ? this.withVaultNameIssues(last) : last;
  }
  /** The issues one note shows. */
  noteIssues(note: SettingsNote): SettingIssue[] {
    const last = this.lastIssues.get(noteKey(note)) ?? [];
    return note.domain === 'vault' ? this.withVaultNameIssues(last) : last;
  }
  private withVaultNameIssues(last: SettingIssue[]): SettingIssue[] {
    const reported = new Set(last.map(issue => issue.key));
    return [...last, ...vaultNameIssues(this.db, this.vault()).filter(issue => !reported.has(issue.key))];
  }
  /** Forget a note's issues (the one-time read of a retired single note, #746). */
  clearNoteIssues(note: SettingsNote): void {
    this.lastIssues.delete(noteKey(note));
  }
  /** A patch's issues replace those of the notes it wrote, each issue in its key's note. */
  private setPatchIssues(domain: SettingsDomain, keys: readonly string[], issues: SettingIssue[]): void {
    for (const note of settingsNotesForKeys(domain, keys)) {
      this.lastIssues.set(noteKey(note), issues.filter(issue => settingsNoteForIssue(domain, issue.key) === note));
    }
  }
  version(domain: SettingsDomain): number { return getSettingsVersion(this.db, domain); }
  seeded(domain: SettingsDomain): boolean { return isDomainSeeded(this.db, domain); }
  promptDefaults(domain: SettingsDomain): Record<string, string> { return getPromptDefaults(this.db, domain); }

  stalePrompts(domain: SettingsDomain): Set<string> {
    const defaultHashes = getPromptDefaultHashes(this.db, domain);
    const overrideHashes = getPromptOverrideHashes(this.db, domain);
    const stored = this.stored(domain);
    const stale = new Set<string>();
    for (const d of descriptorsFor(domain)) {
      if (d.type.kind !== 'text') continue;
      const value = stored[d.key];
      if (typeof value !== 'string' || value.trim() === '') continue;
      const current = defaultHashes[d.key];
      const stamped = overrideHashes[d.key];
      if (current && stamped && current !== stamped) stale.add(d.key);
    }
    return stale;
  }

  registerPromptDefaults(domain: SettingsDomain, defaults: Record<string, string>): PromptDefaultsResult {
    const textKeys = new Set(descriptorsFor(domain).filter(d => d.type.kind === 'text').map(d => d.key));
    const valid: Record<string, string> = {};
    const issues: SettingIssue[] = [];
    for (const [key, value] of Object.entries(defaults)) {
      if (!textKeys.has(key)) {
        issues.push({ key, code: 'SETTINGS_UNKNOWN_KEY', message: `Unknown ${domain} prompt setting: ${key}` });
        continue;
      }
      if (typeof value !== 'string') {
        issues.push({ key, code: 'SETTINGS_INVALID_VALUE', message: `${key} must be a string` });
        continue;
      }
      valid[key] = value;
    }

    const currentDefaults = getPromptDefaults(this.db, domain);
    const nextDefaults = { ...currentDefaults, ...valid };
    const nextHashes = Object.fromEntries(Object.entries(nextDefaults).map(([key, value]) => [key, hashText(value)]));
    const changed = !samePlain(currentDefaults, nextDefaults)
      || !samePlain(getPromptDefaultHashes(this.db, domain), nextHashes);
    if (changed) {
      setPromptDefaults(this.db, domain, nextDefaults);
      setPromptDefaultHashes(this.db, domain, nextHashes);
    }
    this.stampMissingPromptOverrideHashes(domain, nextHashes);
    return { changed, applied: Object.keys(valid), issues };
  }

  /**
   * Record a frontmatter parse failure for `domain` so it surfaces via
   * `get-settings` on the next read (spec: "parse error logged + surfaced via
   * get-settings on next read"). No file write — the sanctioned no-touch on
   * unparseable notes stands; a subsequent successful parse clears this
   * naturally via `replaceFromFile`, which overwrites the note's issues.
   */
  noteParseError(note: SettingsNote, message: string): void {
    this.lastIssues.set(noteKey(note), [{ key: 'frontmatter', code: 'SETTINGS_INVALID_VALUE', message }]);
  }

  onChange(domain: SettingsDomain, cb: () => void): void {
    const arr = this.listeners.get(domain) ?? [];
    arr.push(cb);
    this.listeners.set(domain, arr);
  }

  /**
   * Contextual validator for `model-ref` kind values, mirroring the
   * `excludeDirs` guard: registry shape validation (a non-empty title/ref
   * string) runs first and is all `validateDomainPatch` can see; this
   * resolver narrows further using catalog state the registry has no
   * visibility into (Settings/Models/ notes are DB-assembled, not part of
   * the settings-registry descriptor tree). Return the resolved
   * {@link ModelCatalogEntry} to mean "resolvable" — exposing the entry (not
   * just a boolean) lets the validator apply capability gates such as the
   * `visionModel` vision-capability check below.
   *
   * `null` (the default) means no resolver is wired yet — every shape-valid
   * ref passes unconditionally. This is a deliberate boot-ordering safety
   * valve: `index.ts` wires the real resolver only after `seedModelsOnBoot`
   * has migrated any raw provider-id deviations into catalog refs, so a raw
   * id seeded from env earlier in the same boot (shape-valid, not yet a
   * ref) is never rejected before the migration gets a chance to convert it.
   * Tests that construct a bare `SettingsService` also get this pass-through
   * behavior for free.
   *
   * An unresolvable ref can only ENTER via `applyPatch`/`replaceFromFile`
   * (both call `validate()`, so both are gated). A ref that dangles LATER —
   * the referenced Settings/Models/ note is deleted or disabled after the
   * fact — is NOT retroactively caught here (this resolver only runs at
   * write time); it surfaces instead through `get-settings {domain:"models"}`
   * issues, the affected consumer's own fallback chain, and whichever
   * domain's next edit re-validates against the current catalog state.
   */
  setModelRefResolver(fn: ((ref: unknown) => ModelCatalogEntry | null) | null): void {
    this.modelRefResolver = fn;
  }

  /**
   * Patch semantics: omitted keys are unchanged; `null` resets a key to its default, except
   * a vault key whose type accepts null, where null is none. A key that moved to the vault
   * domain (VAULT_ALIASES) writes its vault key; null resets it, as it reset the old key.
   */
  applyPatch(
    domain: SettingsDomain,
    patch: Record<string, unknown>,
    options: ApplyPatchOptions = {},
  ): ApplyResult {
    const { own, aliased } = splitAliases(domain, patch);
    if (aliased.length === 0) {
      const result = this.applyOwnPatch(domain, patch, options);
      this.setPatchIssues(domain, Object.keys(patch), result.issues);
      return result;
    }
    const vaultDefaults = defaultsFor('vault');
    const vaultPatch = Object.fromEntries(aliased.map(([alias, value]) =>
      [alias.vaultKey, value === null ? vaultDefaults[alias.vaultKey] : value]));
    // One transaction: the vault write and the old domain's own write commit together.
    const result = this.db.transaction(() => {
      const vaultResult = this.applyOwnPatch('vault', vaultPatch, options);
      this.setPatchIssues('vault', Object.keys(vaultPatch), vaultResult.issues);
      const ownResult = this.applyOwnPatch(domain, own, options);
      return mergeAliasResult(ownResult, aliased.map(([alias]) => alias), vaultResult, []);
    })();
    this.setPatchIssues(domain, Object.keys(patch), result.issues);
    return result;
  }

  private applyOwnPatch(
    domain: SettingsDomain,
    patch: Record<string, unknown>,
    options: ApplyPatchOptions,
  ): ApplyResult {
    // Only the vault domain stores null (none); everywhere else null resets, as before.
    const nullable = new Set(domain !== 'vault' ? [] : descriptorsFor(domain)
      .filter(d => 'nullable' in d.type && d.type.nullable === true).map(d => d.key));
    const resets = Object.keys(patch).filter(k => patch[k] === null && !nullable.has(k));
    const values = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== null || nullable.has(k)));
    const { valid, issues } = this.validate(domain, values);
    const next = deviationsOnly(domain, { ...this.stored(domain), ...valid });
    const known = new Set(descriptorsFor(domain).map(d => d.key));
    for (const k of resets) {
      // A null value means "reset to default" — only meaningful for a known key.
      // Nulling an unknown key is a no-op that would otherwise pass silently, so
      // surface it the same way validateDomainPatch flags an unknown value.
      if (known.has(k)) delete next[k];
      else issues.push({ key: k, code: 'SETTINGS_UNKNOWN_KEY', message: `Unknown ${domain} setting: ${k}` });
    }
    const applied = [...Object.keys(valid), ...resets.filter(k => known.has(k))];
    return this.commit(domain, next, applied, issues, options.journalProjection === true);
  }

  /**
   * File snapshot semantics for one note: a key the note shows that is absent from the file is
   * a reset, and an invalid value keeps the last-good one. Keys other notes show keep their
   * values (#746). A line that is no key of this note is not read and is reported: a key of
   * another note names that note, and an old name of a vault key (the notes stopped showing
   * them) names its vault key, unless the line shows the vault map's own value, which is the
   * mirror an older note carried and is dropped without a word.
   */
  replaceFromFile(note: SettingsNote, fileValues: Record<string, unknown>): ApplyResult {
    const { domain } = note;
    // A field map, so a line named `__proto__` is a key like any other.
    const own = createFieldMap<unknown>();
    const misplaced: SettingIssue[] = [];
    const vault = domain === 'vault' ? {} : vaultAliasValues(domain, this.vault());
    for (const [key, value] of Object.entries(fileValues)) {
      if (note.keys.includes(key)) { own[key] = value; continue; }
      const home = settingsNoteOfKey(domain, key);
      if (home) {
        misplaced.push({ key, code: 'SETTINGS_UNKNOWN_KEY',
          message: `${key} is not read in this note: it is set in ${settingsNotePath(this.settingsDir, home)}` });
        continue;
      }
      const alias = domain === 'vault' ? undefined : vaultAliasFor(domain, key);
      if (alias) {
        if (JSON.stringify(value) === JSON.stringify(vault[key])) continue;
        misplaced.push({ key, code: 'SETTINGS_UNKNOWN_KEY',
          message: `${key} is not read here: it is set in ${settingsNotePath(this.settingsDir, { domain: 'vault', group: null })} as ${alias.vaultKey}` });
        continue;
      }
      own[key] = value; // an unknown key, reported by validation
    }
    const result = this.replaceOwnFromFile(domain, own, note.keys);
    const issues = [...result.issues, ...misplaced];
    this.lastIssues.set(noteKey(note), issues);
    return { ...result, issues };
  }

  private replaceOwnFromFile(
    domain: SettingsDomain, fileValues: Record<string, unknown>, shown: readonly string[],
  ): ApplyResult {
    const { valid, issues } = this.validate(domain, fileValues);
    const prior = this.stored(domain);
    const shownSet = new Set(shown);
    const known = new Set(descriptorsFor(domain).map(d => d.key));
    // Settings another note shows keep their stored values; a stored key that is no
    // setting any more is dropped, as a whole-domain snapshot always dropped it.
    const next: Record<string, unknown> = Object.fromEntries(
      Object.entries(prior).filter(([key]) => known.has(key) && !shownSet.has(key)));
    Object.assign(next, valid);
    // Rejected keys retain their last-good stored value (never regress the
    // live value on a typo). Restore on ANY issue except SETTINGS_UNKNOWN_KEY
    // rather than a code whitelist: every rejection of a KNOWN key's value —
    // shape-invalid (SETTINGS_INVALID_VALUE) and contextually unresolvable
    // (SETTINGS_MODEL_REF_UNRESOLVED) alike — must keep the prior deviation,
    // and a whitelist silently breaks each time a new rejection class is
    // added. SETTINGS_UNKNOWN_KEY stays excluded: an unknown key has no
    // descriptor, so "restoring" it could only resurrect stale stored junk
    // from an older registry, not protect a live value.
    for (const issue of issues) {
      if (issue.code !== 'SETTINGS_UNKNOWN_KEY' && issue.key in prior) next[issue.key] = prior[issue.key];
    }
    return this.commit(domain, deviationsOnly(domain, next), Object.keys(valid), issues);
  }

  private validate(domain: SettingsDomain, values: Record<string, unknown>):
      { valid: Record<string, unknown>; issues: SettingIssue[] } {
    const { valid, issues } = validateDomainPatch(domain, values);
    if (domain === 'engine' && 'excludeDirs' in valid) {
      const dirs = valid['excludeDirs'] as string[];
      // Normalize like src/indexer/ignore.ts (strip trailing slashes) so e.g.
      // "Settings/" can't slip past the guard; '' catches values like "/".
      const covers = dirs.some(raw => {
        const d = raw.replace(/\/+$/, '').trim();
        return d === '' || this.settingsDir === d || this.settingsDir.startsWith(d + '/');
      });
      if (covers) {
        delete valid['excludeDirs'];
        issues.push({
          key: 'excludeDirs', code: 'SETTINGS_INVALID_VALUE',
          message: `excludeDirs may not cover the settings folder ("${this.settingsDir}")`,
        });
      }
    }
    if (this.modelRefResolver) {
      const resolver = this.modelRefResolver;
      const modelRefKeys = new Set(
        descriptorsFor(domain).filter(d => d.type.kind === 'model-ref').map(d => d.key),
      );
      for (const key of Object.keys(valid)) {
        if (!modelRefKeys.has(key)) continue;
        const value = valid[key];
        if (value === null) continue; // nullable model-ref reset — nothing to resolve
        const resolved = resolver(value);
        if (resolved === null) {
          delete valid[key];
          issues.push({
            key, code: 'SETTINGS_MODEL_REF_UNRESOLVED',
            message: `${key} does not resolve to an enabled Settings/Models entry: ${normalizeModelRef(value)}`,
          });
          continue;
        }
        // Capability gate: the engine's `visionModel` must point at a
        // vision-capable catalog entry. Reuse the same UNRESOLVED code (a
        // resolvable-but-unsuitable ref is, for this setting, effectively
        // dangling) rather than widening the IssueCode union.
        if (domain === 'engine' && key === 'visionModel' && !isVisionCapableEntry(resolved)) {
          delete valid[key];
          issues.push({
            key, code: 'SETTINGS_MODEL_REF_UNRESOLVED',
            message: `visionModel resolves to "${resolved.title}" which is not marked vision-capable (vision: true)`,
          });
        }
      }
    }
    return { valid, issues };
  }

  private commit(
    domain: SettingsDomain,
    next: Record<string, unknown>,
    applied: string[],
    issues: SettingIssue[],
    journalProjection = false,
  ): ApplyResult {
    if (domain === 'engine') {
      try { readProvenanceLimits(effectiveSettings<EngineSettings>('engine', next)); }
      catch (error) {
        if (!(error instanceof ProvenanceError)) throw error;
        // Limits are one coupled configuration. Validate after merging/resetting,
        // and preserve its last-good state while accepting unrelated settings.
        const prior = this.stored(domain);
        const keys = ['provenanceComponentBytes', 'provenanceRequestBytes', 'provenanceOutputBytes',
          'provenanceTotalBytes', 'provenanceCapacityBytes'];
        for (const key of keys) {
          if (applied.includes(key) || next[key] !== prior[key]) issues.push({
            key, code: 'SETTINGS_INVALID_VALUE',
            message: 'Provenance limits require component <= request <= total, output <= total, and total <= capacity. Coupled byte limits retained their previous values.',
          });
          if (key in prior) next[key] = prior[key];
          else delete next[key];
        }
        applied = applied.filter(key => !keys.includes(key));
      }
    }
    const changed = !sameValue(domain, this.stored(domain), next);
    // Programmatic settings state and the fields its Markdown projection owns
    // commit atomically. If the subsequent filesystem projection fails, a
    // restart can replay ownership without first ingesting the stale values.
    this.db.transaction(() => {
      if (journalProjection) addPendingSettingsNoteFields(this.db, domain, applied);
      if (changed) setStoredSettings(this.db, domain, next);
      this.syncPromptOverrideHashes(domain, next);
    })();
    if (changed) {
      // Isolate listeners: a throwing re-arm hook must not abort applyPatch (the
      // change is already stored) nor starve the listeners registered after it.
      for (const cb of this.listeners.get(domain) ?? []) {
        try {
          cb();
        } catch (err) {
          console.error(`[settings] ${domain} change listener threw:`, err instanceof Error ? err.message : err);
        }
      }
    }
    return { applied, issues, changed };
  }

  private syncPromptOverrideHashes(domain: SettingsDomain, stored: Record<string, unknown>): void {
    const textKeys = descriptorsFor(domain).filter(d => d.type.kind === 'text').map(d => d.key);
    if (textKeys.length === 0) return;
    const defaultHashes = getPromptDefaultHashes(this.db, domain);
    const current = getPromptOverrideHashes(this.db, domain);
    const next = { ...current };
    for (const key of textKeys) {
      const value = stored[key];
      if (typeof value === 'string' && value.trim() !== '') {
        next[key] = defaultHashes[key] ?? '';
      } else {
        delete next[key];
      }
    }
    if (!samePlain(current, next)) setPromptOverrideHashes(this.db, domain, next);
  }

  private stampMissingPromptOverrideHashes(domain: SettingsDomain, defaultHashes: Record<string, string>): void {
    const stored = this.stored(domain);
    const textKeys = descriptorsFor(domain).filter(d => d.type.kind === 'text').map(d => d.key);
    if (textKeys.length === 0) return;
    const current = getPromptOverrideHashes(this.db, domain);
    const next = { ...current };
    for (const key of textKeys) {
      const value = stored[key];
      if (typeof value === 'string' && value.trim() !== '' && !next[key] && defaultHashes[key]) {
        next[key] = defaultHashes[key];
      }
    }
    if (!samePlain(current, next)) setPromptOverrideHashes(this.db, domain, next);
  }
}

/** Separate a domain's own keys from its old keys that moved to the vault domain. */
function splitAliases(domain: SettingsDomain, values: Record<string, unknown>):
    { own: Record<string, unknown>; aliased: Array<[VaultAlias, unknown]> } {
  const own: Record<string, unknown> = {};
  const aliased: Array<[VaultAlias, unknown]> = [];
  for (const [key, value] of Object.entries(values)) {
    const alias = domain === 'vault' ? undefined : vaultAliasFor(domain, key);
    if (alias) aliased.push([alias, value]); else own[key] = value;
  }
  return { own, aliased };
}

/** Report a vault write made through old keys under those keys, beside the domain's own result. */
function mergeAliasResult(
  own: ApplyResult,
  aliases: readonly VaultAlias[],
  vault: ApplyResult,
  aliasIssues: SettingIssue[],
): ApplyResult {
  const byVaultKey = new Map(aliases.map(alias => [alias.vaultKey as string, alias]));
  const applied = aliases.filter(alias => vault.applied.includes(alias.vaultKey)).map(alias => alias.key);
  const issues = vault.issues.map(issue => {
    const alias = byVaultKey.get(issue.key);
    return alias ? { ...issue, key: alias.key, message: `${issue.message} (${alias.key} is vault.${alias.vaultKey})` } : issue;
  });
  return {
    applied: [...own.applied, ...applied],
    issues: [...own.issues, ...aliasIssues, ...issues],
    changed: own.changed || vault.changed,
    vaultApplied: vault.applied,
  };
}

/** The key a note's issues are kept under. */
function noteKey(note: Pick<SettingsNote, 'domain' | 'group'>): string {
  return `${note.domain}/${note.group ?? ''}`;
}

function samePlain(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(Object.fromEntries(Object.entries(a).sort()))
    === JSON.stringify(Object.fromEntries(Object.entries(b).sort()));
}
