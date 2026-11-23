import type Database from 'better-sqlite3';
import { deviationsOnly, seedFromEnv, settingsNoteLabel, staleEnvVars, SEED_MODELS, VAULT_ALIASES } from '@vault/settings-registry';
import type { SettingsDomain, ModelProvider } from '@vault/settings-registry';
import {
  addPendingSettingsNoteFields,
  getPendingSettingsNoteFields,
  markDomainSeeded,
  readJson,
  writeJson,
  getStoredSettings,
  setStoredSettings,
} from './store.js';
import type { SettingsService } from './service.js';
import { getStoredWikiConfig } from '../wiki/config.js';
import { writeModelNoteIfAbsent, writeSettingsNotes } from './note.js';
import type { NoteWriterDeps } from './note.js';
import type { ModelCatalog } from './models.js';

/** The engine process seeds + warns for exactly these; chat/curator own their domains. */
const ENGINE_OWNED_DOMAINS: readonly SettingsDomain[] = ['engine', 'wiki', 'vault'];

export function seedSettingsOnBoot(
  db: Database.Database, service: SettingsService, env: Record<string, string | undefined>,
): void {
  if (!service.seeded('engine')) {
    const seeded = seedFromEnv('engine', env);
    // Per-entry excludeDirs filtering: the service guard rejects a list covering
    // the settings folder WHOLESALE; at seed time that would silently drop every
    // other entry too. Filter the offending entries and keep the rest.
    const handledByExcludeDirsGuard = new Set<string>();
    if (Array.isArray(seeded['excludeDirs'])) {
      const dirs = seeded['excludeDirs'] as string[];
      const kept = dirs.filter(raw => {
        const d = raw.replace(/\/+$/, '').trim();
        return !(d === '' || service.settingsDir === d || service.settingsDir.startsWith(d + '/'));
      });
      if (kept.length < dirs.length) {
        console.warn(`[settings] VAULT_EXCLUDE_DIRS entries covering the settings folder ("${service.settingsDir}") were dropped at seeding`);
        if (kept.length > 0) seeded['excludeDirs'] = kept; else { delete seeded['excludeDirs']; handledByExcludeDirsGuard.add('excludeDirs'); }
      }
    }
    // Seed-drop delta logging (Phase 2 follow-up): an env var whose value failed
    // the registry's shape validation never makes it into `seeded` at all —
    // seedFromEnv silently skips it. Name every such var loudly here rather than
    // letting it vanish; excludeDirs is excluded since the guard above already
    // warned about it specifically.
    for (const s of staleEnvVars('engine', env)) {
      if (!(s.key in seeded) && !handledByExcludeDirsGuard.has(s.key)) {
        console.warn(`[settings] ${s.var} is set but its value failed validation and was NOT seeded — fix it or remove it`);
      }
    }
    if (Object.keys(seeded).length > 0) {
      const result = service.applyPatch('engine', seeded);
      for (const i of result.issues) console.warn(`[settings] engine seed: ${i.message}`);
    }
    markDomainSeeded(db, 'engine');
    console.log(`[settings] seeded engine domain from env (${Object.keys(seeded).length} keys)`);
  }
  // chat/curator are SERVICE-seeded via update-settings — never from the engine's env.
  if (!service.seeded('wiki')) {
    const legacy = getStoredWikiConfig(db);
    if (Object.keys(legacy).length > 0) {
      const result = service.applyPatch('wiki', legacy as Record<string, unknown>);
      for (const i of result.issues) console.warn(`[settings] wiki_config migration: ${i.message}`);
      console.log(`[settings] migrated meta.wiki_config into settings.wiki (${Object.keys(legacy).length} keys)`);
    }
    markDomainSeeded(db, 'wiki');
  }
  // Every boot, not once: an Engine rolled back to a release before the vault map stores
  // these keys under their old names again, and the next upgrade must pick them up.
  const firstRun = !service.seeded('vault');
  const moved = migrateVaultSettings(db, { firstRun });
  if (moved.length > 0) console.log(`[settings] moved ${moved.join(', ')} into settings.vault`);
  if (firstRun) markDomainSeeded(db, 'vault');
}

/** Each project status list starts as a copy of the task list that served both before #444. */
const SHARED_STATUS_LISTS: ReadonlyArray<[string, string]> = [
  ['taskDoneStatuses', 'projectDoneStatuses'],
  ['taskBlockedStatuses', 'projectBlockedStatuses'],
  ['taskBacklogStatuses', 'projectBacklogStatuses'],
  ['taskIgnoredStatuses', 'projectIgnoredStatuses'],
];

/**
 * Move the vocabulary keys stored under the wiki and curator domains (their VAULT_ALIASES)
 * into settings.vault, so the vault map is their only store. Values move unchanged. On the
 * first run, the project status lists without an old key of their own also start as copies
 * of the shared lists. Later runs find nothing, unless an older Engine (a rollback) stored
 * the old keys again; their values are then the newer ones. Returns the moved
 * `domain.key` names.
 */
export function migrateVaultSettings(db: Database.Database, options: { firstRun: boolean } = { firstRun: true }): string[] {
  const blobs = { wiki: getStoredSettings(db, 'wiki'), curator: getStoredSettings(db, 'curator') };
  const vault: Record<string, unknown> = { ...getStoredSettings(db, 'vault') };
  const moved: string[] = [];
  const movedVaultKeys: string[] = [];
  for (const alias of VAULT_ALIASES) {
    const blob = blobs[alias.domain];
    if (!Object.hasOwn(blob, alias.key)) continue;
    vault[alias.vaultKey] = blob[alias.key];
    delete blob[alias.key];
    moved.push(`${alias.domain}.${alias.key}`);
    movedVaultKeys.push(alias.vaultKey);
  }
  let copied = false;
  for (const [task, project] of options.firstRun ? SHARED_STATUS_LISTS : []) {
    if (Object.hasOwn(vault, task) && !Object.hasOwn(vault, project)) { vault[project] = vault[task]; copied = true; }
  }
  if (moved.length === 0 && !copied) return moved;
  db.transaction(() => {
    for (const domain of ['wiki', 'curator'] as const) {
      if (moved.some(name => name.startsWith(`${domain}.`))) setStoredSettings(db, domain, blobs[domain]);
    }
    setStoredSettings(db, 'vault', deviationsOnly('vault', vault));
    // A Settings/Vault.md left from before a rollback holds older values: these keys win
    // over it at its next ingest (and the journal clears when Vault.md is first written).
    addPendingSettingsNoteFields(db, 'vault', movedVaultKeys);
  })();
  return moved;
}

const MODELS_SEEDED_META_KEY = 'settings.models_seeded';

/**
 * The keys, across domains, that will eventually hold a model-catalog
 * reference (`[[Title]]`) rather than a raw provider model id. Deliberately a
 * plain data table rather than a descriptor-kind lookup: on this commit none
 * of these keys are `model-ref`-typed yet (that's Tasks 4/7/8's job, done
 * per-domain later), so keeping this list hand-written here means those
 * later tasks activate the migration for their domain just by flipping the
 * descriptor's `type.kind` — no edit to this file required.
 */
export const MODEL_REF_KEYS: ReadonlyArray<{ domain: SettingsDomain; key: string }> = [
  { domain: 'engine', key: 'visionModel' },
  { domain: 'engine', key: 'memoryConsolidationModel' },
  { domain: 'chat', key: 'defaultModel' },
  { domain: 'curator', key: 'model' },
  { domain: 'curator', key: 'memorySweepModel' },
  { domain: 'curator', key: 'orgSweepModel' },
];

/** id starts `claude-` → anthropic (Anthropic's own model-id convention); else fireworks. */
function inferProvider(rawId: string): ModelProvider {
  return rawId.startsWith('claude-') ? 'anthropic' : 'fireworks';
}

function lastPathSegment(rawId: string): string {
  const parts = rawId.split('/');
  return parts[parts.length - 1] ?? rawId;
}

/**
 * One-shot models migration: seed catalog notes + rewrite stored raw-id
 * deviations into refs.
 *
 * Ordering matters and is deliberate: create seed notes → invalidate → rewrite
 * stored values. Notes must exist in the catalog BEFORE the rewrite loop runs
 * so a raw id that matches a `SEED_MODELS` entry's `model` resolves to that
 * seeded note instead of spawning a duplicate "unknown id" note.
 *
 * Guarded by a plain meta key (`settings.models_seeded`, an ISO stamp) rather
 * than `SettingsDomain`-based `isDomainSeeded` — "models" isn't a settings
 * domain (Models/ notes are per-node data, not a `settings.<domain>` blob), so
 * widening `SettingsDomain` for a single boot-guard would be the wrong shape.
 */
export function seedModelsOnBoot(
  db: Database.Database,
  service: SettingsService,
  noteDeps: NoteWriterDeps,
  catalog: ModelCatalog,
): void {
  if (readJson<string | null>(db, MODELS_SEEDED_META_KEY, null) !== null) return;

  for (const entry of SEED_MODELS) {
    writeModelNoteIfAbsent(noteDeps, entry);
  }
  catalog.invalidate();

  for (const { domain, key } of MODEL_REF_KEYS) {
    const raw = service.stored(domain)[key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    if (catalog.resolve(raw) !== null) continue; // already a resolvable ref — nothing to migrate

    let match = catalog.entries().find(e => e.model === raw);
    if (!match) {
      const title = lastPathSegment(raw);
      const provider = inferProvider(raw);
      const written = writeModelNoteIfAbsent(noteDeps, { title, provider, model: raw, enabled: true });
      catalog.invalidate();
      match = catalog.entries().find(e => e.model === raw);
      if (!written && !match) {
        console.warn(`[settings] models migration (${domain}.${key}): ${service.settingsDir}/Models/${title}.md already exists and does not hold ${raw}; ${key} keeps its raw id until it is set to a catalog reference`);
      }
    }
    if (match) {
      const result = service.applyPatch(domain, { [key]: `[[${match.title}]]` });
      for (const i of result.issues) console.warn(`[settings] models migration (${domain}.${key}): ${i.message}`);
    }
  }

  writeJson(db, MODELS_SEEDED_META_KEY, new Date().toISOString());
  catalog.bumpVersion();
}

const VISION_MODEL_MIGRATED_META_KEY = 'settings.vision_model_migrated';

/**
 * One-shot vision-settings rename migration (Task 10). Generalizing the third
 * vision provider from a hardcoded `qwen` arm to "any vision-capable catalog
 * model" renamed two stored engine keys:
 *   - `visionProvider: 'qwen'` → `'model'`
 *   - `qwenVisionModel` → `visionModel` (value carried over verbatim)
 *
 * Runs right after {@link seedModelsOnBoot} (so any raw-id → ref rewrite has
 * already happened under the OLD key name on an upgraded install) and rewrites
 * the RAW stored engine blob directly through the store — NOT `applyPatch`,
 * which would reject the now-unknown `qwenVisionModel` key (and re-run the
 * contextual model-ref resolver against a still-booting catalog).
 *
 * A projection of the Engine's settings notes is required **unconditionally** (even
 * when the stored blob had no vision deviations): on the common upgrade — stored blob
 * clean, visionModel/visionProvider both at defaults — the old on-disk note could
 * still carry `qwenVisionModel: "[[…]]"`. Production startup defers that
 * projection to its immediately following `SettingsIngest.reconcile()` so a
 * just-drained watcher handoff keeps unrelated invalid/unknown raw values. Direct
 * callers retain the synchronous projection unless they request deferral.
 *
 * Guarded by the plain meta key `settings.vision_model_migrated` (an ISO stamp,
 * same shape as the models-seeded guard) and stamped unconditionally — even
 * when there was nothing to migrate — so it never re-runs.
 */
export function migrateVisionSettingsOnBoot(
  db: Database.Database,
  service: SettingsService,
  noteDeps: NoteWriterDeps,
  options: { deferProjection?: boolean } = {},
): void {
  if (readJson<string | null>(db, VISION_MODEL_MIGRATED_META_KEY, null) !== null) return;

  const projectionWasAlreadyPending = getPendingSettingsNoteFields(db, 'engine').length > 0;
  const stored = getStoredSettings(db, 'engine');
  const next = { ...stored };
  // The legacy key is migration-owned even when it exists only as an on-disk
  // explicit-null marker. The canonical projection must remove that stale key,
  // while every unrelated authored marker remains outside this migration's
  // ownership.
  const touchedFields = ['qwenVisionModel'];
  let changed = false;

  if (next['visionProvider'] === 'qwen') {
    next['visionProvider'] = 'model';
    touchedFields.push('visionProvider');
    changed = true;
  }
  if ('qwenVisionModel' in next) {
    next['visionModel'] = next['qwenVisionModel'];
    delete next['qwenVisionModel'];
    touchedFields.push('visionModel');
    changed = true;
  }

  // Commit migration ownership and the stored shape atomically. If the note
  // write fails afterward, the next boot still knows that visionProvider /
  // visionModel (and the retired key) belong to this migration; a crash during
  // this transaction leaves neither half committed and the migration reruns.
  db.transaction(() => {
    addPendingSettingsNoteFields(db, 'engine', touchedFields);
    if (changed) setStoredSettings(db, 'engine', next);
  })();

  if (changed) {
    console.log('[settings] migrated vision settings: visionProvider qwen→model, qwenVisionModel→visionModel');
  }

  if (projectionWasAlreadyPending || options.deferProjection === true) {
    // A prior projection (including a partially completed migration attempt),
    // and production startup after its suspended-watcher handoff, are projected
    // by the immediately following SettingsIngest.reconcile pass. That path
    // merges pending committed keys into the current file snapshot, preserving
    // unrelated human edits and invalid/unknown raw values instead of doing a
    // stale full projection over them.
    writeJson(db, VISION_MODEL_MIGRATED_META_KEY, new Date().toISOString());
    return;
  }

  // Direct-call projection remains unconditional (see the doc comment): drop a
  // stale `qwenVisionModel:` line even when no stored deviation changed.
  writeSettingsNotes(noteDeps, 'engine', { touchedFields });

  writeJson(db, VISION_MODEL_MIGRATED_META_KEY, new Date().toISOString());
}

export function warnStaleEnv(env: Record<string, string | undefined>): string[] {
  const stale: string[] = [];
  for (const domain of ENGINE_OWNED_DOMAINS) {
    for (const s of staleEnvVars(domain, env)) {
      stale.push(s.var);
      console.warn(
        `[settings] ${s.var} is set but ignored — "${s.key}" is managed in ${settingsNoteLabel(domain, s.key)}. Remove it from .env / the systemd EnvironmentFile.`,
      );
    }
  }
  return stale;
}
