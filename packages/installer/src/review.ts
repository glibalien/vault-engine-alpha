import { join } from 'node:path';
import { DEFAULT_TYPE_KEY, typeKeyOf } from './analyzer.js';
import { formatBytes, type BackupPlan } from './backup.js';
import { OPTIONAL_SWEEPS_OFF, type CuratorPlan } from './curator-plan.js';
import { DEFAULT_WIKI_DIR } from './layout.js';
import type { ModelsPlan } from './models.js';
import { obsidianPluginDir } from './obsidian.js';
import { EXTRACTION_PROVIDERS, MODEL_PROVIDERS, providerInfo, type ProviderKey } from './providers.js';
import type { StructurePlan } from './structure.js';
import { installCommands, restartCommand, serviceFileName, type ServiceManager } from './service-manager.js';
import { count } from './text.js';
import { CURATOR_UNIT, curatorCommand, ENGINE_UNIT, engineCommand } from './units.js';
import { buildVaultMap, vaultMapSettings } from './vault-map.js';
import type { VaultPlan } from './vault.js';

/**
 * Stage 5: everything installing would do, in one place. Nothing is applied before the
 * user approves this; the `plan` command only shows it.
 */
export interface ReviewSummary {
  /** Each service, run as `user` on the Node.js binary the checkout was built with. */
  services: Array<{ unit: string; user: string; command: string[]; port: number; url: string }>;
  files: Array<{ path: string; private: boolean; purpose: string }>;
  /**
   * The commands that install and start the services, shown before each runs; `when` marks
   * one that runs only in some cases. Through sudo under systemd; as the user under launchd.
   */
  sudo_commands: Array<{ command: string; when?: string }>;
  /** Variable names only; values never appear in a plan. */
  env_keys: {
    engine_first_boot: string[];
    /** On a vault Engine already manages: added once its extraction is turned off. */
    engine_after_extraction_off: string[];
    curator: string[];
  };
  /**
   * engine.env seeds Engine's extractionEnabled setting off (`EXTRACTION_ENABLED=false`),
   * so its first start makes no paid extraction calls; approval turns it on.
   */
  extraction_seeded_off: boolean;
  engine_database: string | null;
  /** Where Engine keeps its search model cache; null for its default in `.vault-engine/`. */
  engine_models_dir: string | null;
  vault_changes: string[];
  /**
   * Settings applied through Engine before Curator first starts; `when` marks a later one.
   * `inherits` marks a model setting cleared so it uses Curator's writing model.
   */
  settings: Array<{ setting: string; value: SettingValue; when?: string; inherits?: true }>;
  paid_calls: string[];
}

type SettingValue = string | number | boolean | string[] | null;

export interface ServicePlan {
  repoRoot: string;
  user: string;
  nodePath: string;
  enginePort: number;
  curatorPort: number;
  manager: ServiceManager;
  /** Where the service definitions are installed (`serviceDirFor`). */
  serviceDir: string;
}

export function buildReview(input: {
  dataDir: string;
  services: ServicePlan;
  vault: VaultPlan | null;
  structure: StructurePlan | null;
  keys: readonly ProviderKey[];
  models: ModelsPlan;
  curator: CuratorPlan | null;
  backup: BackupPlan | null;
  /** The answers file's approval of attachment extraction; null when asked after adoption. */
  extractionApproved?: boolean | null;
  /** The answers file's choice to add the Obsidian plugin; null when asked at the end. */
  obsidianPlugin?: boolean | null;
}): ReviewSummary {
  const { dataDir, services, vault, structure, keys, models, curator, backup } = input;
  const unitStaging = join(dataDir, 'installer', 'units');
  const { manager } = services;
  const launchd = manager === 'launchd';
  const installedPath = (unit: string) => join(services.serviceDir, serviceFileName(manager, unit));
  const managed = vault?.managedByEngine ?? false;
  // In a synced folder, Engine's live database and its large model cache stay out of the sync.
  const outsideSync = vault !== null && vault.syncService !== null && !managed;
  const engineDatabase = vault
    ? outsideSync ? join(dataDir, 'vault.db') : join(vault.path, '.vault-engine', 'vault.db')
    : null;

  // A new database seeds extractionEnabled off from engine.env, so every key can be there
  // from the first start. An existing one ignores the seed and keeps its stored settings,
  // under which any of these keys could start extraction, so they wait until Engine's
  // extraction is turned off through update-settings.
  const consent = needsExtractionConsent(keys, models);
  const engineKeys = keys.filter(key => usedByEngine(key, models));
  const heldUntilExtractionOff = managed
    ? engineKeys.filter(key => (EXTRACTING_PROVIDERS as readonly string[]).includes(key.provider))
    : [];
  const engineEnv = (held: readonly ProviderKey[]) => held.flatMap(key => providerInfo(key.provider).engineEnv ?? []);
  const envKeys = {
    engine_first_boot: engineEnv(engineKeys.filter(key => !heldUntilExtractionOff.includes(key))),
    engine_after_extraction_off: engineEnv(heldUntilExtractionOff),
    curator: curator ? keys.flatMap(key => providerInfo(key.provider).curatorEnv ?? []) : [],
  };
  const held = heldUntilExtractionOff.length > 0;

  const files: ReviewSummary['files'] = [
    { path: `${dataDir}/`, private: true, purpose: 'service state, env files, and installer progress' },
    { path: join(dataDir, 'engine.env'), private: true, purpose: 'Engine configuration, a generated owner password, and keys' },
    ...(curator ? [{ path: join(dataDir, 'curator.env'), private: true, purpose: 'Curator configuration, a generated owner password, and keys' }] : []),
    ...(held ? [{ path: join(dataDir, 'installer', 'pending-keys.env'), private: true, purpose: 'the keys Engine does not get yet (below), until its extraction is off' }] : []),
    { path: join(dataDir, 'installer', 'installer.env'), private: true, purpose: 'the installer\'s own Engine token, valid for a day and removed when the install finishes' },
    { path: join(dataDir, 'installer', 'state.json'), private: true, purpose: 'installer progress and answers, without keys' },
    {
      path: `${unitStaging}/`,
      private: true,
      purpose: launchd ? `the service definitions, before they are copied to ${services.serviceDir}` : 'the service definitions, before sudo installs them',
    },
    ...(launchd ? [{ path: join(dataDir, 'logs') + '/', private: true, purpose: 'the services\' logs (launchd keeps none)' }] : []),
    ...(backup && backup.mode !== 'skip'
      ? [{ path: join(dataDir, 'installer', 'backups') + '/', private: true, purpose: 'a copy of the vault, taken before anything in it changes' }]
      : []),
    ...[ENGINE_UNIT, ...(curator ? [CURATOR_UNIT] : [])].map(unit => ({
      path: installedPath(unit),
      private: false,
      purpose: launchd ? 'launchd agent: runs the service as you while you are logged in' : 'systemd service, installed with sudo',
    })),
    { path: join(dataDir, 'PUBLIC-ACCESS.md'), private: false, purpose: 'guidance for reaching the services from the internet (nothing is exposed)' },
    ...(vault?.obsidian && !managed && input.obsidianPlugin !== false
      ? [{
          path: `${obsidianPluginDir(vault.path)}/`,
          private: false,
          purpose: `${input.obsidianPlugin ? '' : 'only if you agree at the end: '}the Vault Engine Obsidian plugin (built from this checkout first), connected with its own tokens in data.json (private); a plugin already there is not replaced without asking`,
        }]
      : []),
  ];

  // In the order they run: Engine starts, takes any held keys, and only then Curator starts.
  const install = (unit: string) => installCommands(manager, join(unitStaging, serviceFileName(manager, unit)), installedPath(unit), unit)
    .map(command => ({ command }));
  const sudoCommands: ReviewSummary['sudo_commands'] = install(ENGINE_UNIT);
  if (held) {
    sudoCommands.push({ command: restartCommand(manager, [ENGINE_UNIT]), when: 'after extraction is turned off, to add the held keys' });
  }
  if (consent) {
    sudoCommands.push({ command: restartCommand(manager, [ENGINE_UNIT]), when: 'only if you approve attachment extraction' });
  }
  if (curator) sudoCommands.push(...install(CURATOR_UNIT));

  return {
    services: [
      {
        unit: ENGINE_UNIT,
        user: services.user,
        command: engineCommand({ ...services, port: services.enginePort }),
        port: services.enginePort,
        url: `http://localhost:${services.enginePort}/mcp`,
      },
      ...(curator
        ? [{
            unit: CURATOR_UNIT,
            user: services.user,
            command: curatorCommand(services),
            port: services.curatorPort,
            url: `http://localhost:${services.curatorPort}/mcp`,
          }]
        : []),
    ],
    files,
    sudo_commands: sudoCommands,
    env_keys: envKeys,
    extraction_seeded_off: consent && !managed,
    engine_database: engineDatabase,
    engine_models_dir: outsideSync ? join(dataDir, 'models') : null,
    vault_changes: vault ? vaultChanges(vault, structure, backup, dataDir, engineDatabase, outsideSync) : [],
    settings: [
      ...(held
        ? [{ setting: 'engine.extractionEnabled', value: false, when: 'as soon as Engine starts, before its other keys are added' }]
        : []),
      ...settingsToApply(vault, models, curator, structure, consent),
    ],
    paid_calls: paidCalls(keys, models, curator, input.extractionApproved ?? null),
  };
}


/** Whether the install asks before turning attachment extraction on. */
export function needsExtractionConsent(keys: readonly ProviderKey[], models: ModelsPlan): boolean {
  return hasDeepgram(keys) || models.visionProvider !== 'off';
}

/** Keys that can start paid extraction under some vision provider. */
const EXTRACTING_PROVIDERS = [...MODEL_PROVIDERS, ...EXTRACTION_PROVIDERS] as const;

/**
 * Engine reads a Gemini key only for vision, and its default vision provider is Gemini,
 * so with image vision off the key would turn Gemini vision on with extraction.
 */
function usedByEngine(key: ProviderKey, models: ModelsPlan): boolean {
  return key.provider !== 'gemini' || models.visionProvider !== 'off';
}

function hasDeepgram(keys: readonly ProviderKey[]): boolean {
  return keys.some(key => key.provider === 'deepgram');
}

function vaultChanges(
  vault: VaultPlan,
  structure: StructurePlan | null,
  backup: BackupPlan | null,
  dataDir: string,
  engineDatabase: string | null,
  outsideSync: boolean,
): string[] {
  const markdown = vault.discovery.inventory.markdown_files;
  const backups = `${join(dataDir, 'installer', 'backups')}/`;
  const changes = [
    !backup
      ? 'Backup: not planned.'
      : backup.mode === 'skip'
        ? 'No backup: you chose to skip it.'
        : `Back up ${backup.mode === 'full' ? `the whole folder, ${count(backup.files, 'file')}` : count(backup.files, 'Markdown file')} (${formatBytes(backup.bytes)}) to ${backups} before Engine starts.`,
    vault.managedByEngine
      ? `Engine keeps using its existing database, ${engineDatabase}.`
      : outsideSync
        ? `Engine keeps its database (${engineDatabase}) and search model cache (${join(dataDir, 'models')}/) outside what ${vault.syncService} syncs.`
        : 'Engine creates .vault-engine/ inside the vault for its database and search model cache.',
    `Engine writes its settings notes to ${vault.settingsDir}/ and model notes to ${vault.settingsDir}/Models/.`,
    `Wiki pages go to ${vault.wikiDir}/${vault.wikiDir === DEFAULT_WIKI_DIR ? '' : ` instead of ${DEFAULT_WIKI_DIR}/`}.`,
    'When it starts, Engine rewrites links that reach a note only by an alias or a near-miss spelling, so they name the note\'s file.',
  ];
  if (!structure) return [...changes, 'Types and fields: not planned.'];

  const analysis = structure.analysis;
  const vaultTypes = analysis?.proposal.schemas.length ?? 0;
  const fields = (analysis?.proposal.global_fields.length ?? 0) + structure.starterFields.length;
  const typed = analysis?.coverage.typed_files ?? 0;
  changes.push([
    `Create ${count(vaultTypes + structure.starterTypes.length, 'type')}`,
    structure.starterTypes.length > 0 ? ` (including ${count(structure.starterTypes.length, 'new type')} you asked for)` : '',
    ` and ${count(fields, 'global field')}.`,
  ].join(''));
  const typeKey = typeKeyOf(structure.spec);
  changes.push(typeKey === DEFAULT_TYPE_KEY
    ? `Give ${count(typed, 'note')} a types field; ${count(markdown - typed, 'note')} stay untyped.`
    : `Give ${count(typed, 'note')} their types in the ${typeKey} field, which Engine reads and writes them in (VAULT_TYPE_KEY); ${count(markdown - typed, 'note')} stay untyped.`);
  if (structure.removeTypeField && typed > 0) {
    changes.push(`Remove the ${structure.spec.type_field} field from each note that gets a type.`);
  }
  if (typed > 0) changes.push('Each note Engine updates is rewritten with its standard frontmatter layout; note bodies are kept.');
  return changes;
}

function settingsToApply(
  vault: VaultPlan | null,
  models: ModelsPlan,
  curator: CuratorPlan | null,
  structure: StructurePlan | null,
  consent: boolean,
): ReviewSummary['settings'] {
  // A role in use without a model is a nullable one; an explicit null makes it inherit
  // even where an older override is stored. Roles that are off are left as they are.
  const settings: ReviewSummary['settings'] = models.assignments
    .filter(assignment => assignment.off === null)
    .map(({ role, model }) => model
      ? { setting: role.id, value: `[[${model.title}]]` }
      : { setting: role.id, value: null, inherits: true as const });
  // Extraction is off until approved, so the provider can be set now; turning extraction
  // on later then needs only extractionEnabled.
  if (models.visionProvider !== 'off') settings.push({ setting: 'engine.visionProvider', value: models.visionProvider });
  if (consent) {
    settings.push({ setting: 'engine.extractionEnabled', value: true, when: 'only if you approve attachment extraction' });
  }
  // The vocabulary map, through the vault domain's own keys: Engine's project tools, wikis,
  // Curator and the plugin read each kind, status field and folder from it. A none is
  // written as null, so Engine's default name does not stay in force.
  if (vault && structure) settings.push(...vaultMapSettings(buildVaultMap(vault, structure, curator)));
  if (curator) {
    settings.push(
      { setting: 'curator.dailyBudgetCents', value: curator.dailyBudgetCents },
      { setting: 'curator.sweepAt', value: curator.sweepAt },
      { setting: 'curator.tz', value: curator.tz },
      { setting: 'curator.wikiReconciliationMode', value: curator.wikiMode },
      ...OPTIONAL_SWEEPS_OFF.map(({ key, value }) => ({ setting: `curator.${key}`, value })),
    );
  }
  return settings;
}

function paidCalls(
  keys: readonly ProviderKey[],
  models: ModelsPlan,
  curator: CuratorPlan | null,
  approved: boolean | null,
): string[] {
  const calls = ['None while installing. Key checks use free requests.'];
  if (curator) {
    calls.push(`Curator calls models from its first start, up to ${dollars(curator.dailyBudgetCents)} a day (${curator.tz || 'system time zone'}).`);
  }
  calls.push('Chat and Engine\'s memory consolidation call models only when you use them.');
  if (approved !== null && needsExtractionConsent(keys, models)) {
    calls.push(approved
      ? 'Attachment extraction turns on after adoption, as the answers file approves; each embedded attachment is a paid call.'
      : 'Attachment extraction stays off: the answers file does not approve it (extraction.approve).');
  } else if (needsExtractionConsent(keys, models)) {
    const kinds = [
      ...(models.visionProvider !== 'off' ? [`images and scanned PDFs via ${visionLabel(models.visionProvider)}`] : []),
      ...(hasDeepgram(keys) ? ['audio via Deepgram'] : []),
    ];
    calls.push(`Attachment extraction (${kinds.join('; ')}) stays off until you approve it after adoption, which shows what it would read and roughly what it costs.`);
  } else {
    calls.push('Attachment extraction: off.');
  }
  return calls;
}

function visionLabel(provider: ModelsPlan['visionProvider']): string {
  return provider === 'gemini' ? 'Gemini' : provider === 'claude' ? 'Claude' : 'a catalog model';
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function renderReview(review: ReviewSummary, manager: ServiceManager = 'systemd'): string {
  const lines: string[] = ['Services'];
  for (const service of review.services) {
    lines.push(`  ${service.unit}: runs as ${service.user}, answers at ${service.url}`);
    lines.push(`    ${service.command.join(' ')}`);
  }
  lines.push('Files');
  for (const file of review.files) lines.push(`  ${file.path}${file.private ? ' (private)' : ''}: ${file.purpose}`);
  lines.push('Keys, by variable name');
  lines.push(`  engine.env: ${list(review.env_keys.engine_first_boot)}`);
  if (review.extraction_seeded_off) {
    lines.push('  engine.env also has EXTRACTION_ENABLED=false, so Engine starts with paid attachment extraction off; the line is removed once Engine has started');
  }
  if (review.env_keys.engine_after_extraction_off.length > 0) {
    lines.push(`  engine.env once Engine's extraction is off: ${list(review.env_keys.engine_after_extraction_off)}`);
  }
  if (review.files.some(file => file.path.endsWith('curator.env'))) lines.push(`  curator.env: ${list(review.env_keys.curator)}`);
  lines.push(manager === 'launchd' ? 'Commands run as you (no sudo)' : 'Commands run with sudo');
  for (const { command, when } of review.sudo_commands) lines.push(`  ${command}${when ? `  (${when})` : ''}`);
  if (review.vault_changes.length > 0) {
    lines.push('Vault');
    for (const change of review.vault_changes) lines.push(`  ${change}`);
  }
  lines.push('Settings applied through Engine');
  const inheriting = review.settings.filter(setting => setting.inherits);
  for (const { setting, value, when } of review.settings.filter(candidate => !candidate.inherits)) {
    lines.push(`  ${setting} = ${formatValue(value)}${when ? `  (${when})` : ''}`);
  }
  if (inheriting.length > 0) {
    lines.push(`  ${count(inheriting.length, 'model setting')} = none (they use Curator's writing model): ${
      inheriting.map(setting => setting.setting).join(', ')}`);
  }
  lines.push('Paid calls');
  for (const call of review.paid_calls) lines.push(`  ${call}`);
  return lines.join('\n');
}

function list(names: readonly string[]): string {
  return names.length > 0 ? names.join(', ') : 'no keys';
}

function formatValue(value: SettingValue): string {
  if (value === null) return 'none';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'none';
  return String(value);
}
