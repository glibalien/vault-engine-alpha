import { join } from 'node:path';
import { DEFAULT_TYPE_KEY, typeKeyOf, type AnalyzeSpec } from './analyzer.js';
import { formatBytes, type BackupPlan } from './backup.js';
import type { CuratorPlan, WikiMode } from './curator-plan.js';
import { ASKED_ROLE_ORDER, type ModelsPlan, type Preset, type VisionProvider } from './models.js';
import type { CheckResult, CheckStatus } from './preflight.js';
import { PROVIDERS, providerInfo, type KeyCheck, type ProviderId, type ProviderKey } from './providers.js';
import { dollars, type ReviewSummary, type ServicePlan } from './review.js';
import { plannedManager, type ServiceManager } from './service-manager.js';
import { ROLES, type FieldDefinition, type Role } from './starter-types.js';
import { describeFieldType, type StructurePlan, type TypingSource } from './structure.js';
import { count } from './text.js';
import { wrap } from './tui.js';
import { CURATOR_UNIT, ENGINE_UNIT } from './units.js';
import { buildVaultMap, taskCheckboxOffIn, type StatusKind, type VaultMapSummary } from './vault-map.js';
import type { VaultPlan } from './vault.js';

export interface PlanReport {
  format: 'vault-installer-plan';
  version: 1;
  generated_at: string;
  repo_root: string;
  data_dir: string;
  /** Who runs the services and on which Node.js binary and ports. */
  services: {
    user: string;
    node_path: string;
    engine_port: number;
    curator_port: number;
    /** What runs the services; absent from plans saved before macOS support (systemd). */
    service_manager?: ServiceManager;
    /** The folder their definitions are installed in. */
    service_dir?: string;
  };
  preflight: CheckResult[];
  vault: VaultSummary | null;
  structure: StructureSummary | null;
  /**
   * The vocabulary map the install writes to Settings/Vault.md: each kind's type, each
   * status kind's field and value meanings, the folders, and what each none turns off.
   * Null when no structure is planned; then the install writes no map.
   */
  vault_map: VaultMapSummary | null;
  providers: ProviderSummary[];
  models: ModelsSummary;
  curator: CuratorSummary | null;
  backup: BackupPlan | null;
  review: ReviewSummary;
  /** Attachment extraction as the answers file decided it; null when asked after adoption. */
  extraction_approved: boolean | null;
  /**
   * Whether the install adds the Obsidian plugin to the vault, as the answers file decided
   * it; null when asked at the end, or when the folder is not an Obsidian vault.
   */
  obsidian_plugin: boolean | null;
  /** What `install` does not do yet in this version. */
  not_in_this_version: string[];
}

export interface VaultSummary {
  path: string;
  exclusions: string[];
  settings_dir: string;
  wiki_dir: string;
  topic_dir: string;
  analyzer_exclusions: string[];
  obsidian: boolean;
  managed_by_engine: boolean;
  sync_service: string | null;
  analyzer_version: string;
  source_fingerprint: string;
  inventory: VaultPlan['discovery']['inventory'];
  top_level_folders: Array<{ path: string; notes: number }>;
  type_field_candidates: Array<{ key: string; notes: number; samples: string[] }>;
  issues: Array<{ code: string; count: number }>;
  warnings: string[];
}

export interface StructureSummary {
  source: TypingSource;
  /** The exact Analyzer input; adoption reruns it and compares the fingerprint. */
  analyzer_spec: AnalyzeSpec;
  source_fingerprint: string | null;
  typed_notes: number;
  untyped_notes: number;
  types: Array<{
    name: string;
    from: 'vault' | 'starter';
    /** The kind this type holds, if any. */
    role: Role | null;
    notes: number;
    default_directory: string | null;
    fields: string[];
  }>;
  fields_from_vault: string[];
  starter_fields: FieldDefinition[];
  roles: Record<Role, string | null>;
  unmanaged_fields: Array<{ name: string; reasons: string[] }>;
  /** Remove the old type field from notes once adoption gives them types. */
  remove_type_field: boolean;
  warnings: string[];
}

export interface ProviderSummary {
  provider: ProviderId;
  /** `env:NAME` or `entered`; the key itself is never in the plan. */
  source: string;
  check: KeyCheck;
  detail: string;
}

export interface ModelsSummary {
  preset: Preset;
  vision_provider: VisionProvider;
  /** Every model setting in the engine, chat, and curator domains. */
  roles: Array<{ setting: string; label: string; model: string | null; inherits: boolean; off: string | null }>;
  /** The models the roles use, with list prices in USD per million tokens. */
  models: Array<{ title: string; provider: string; model: string; input: number; output: number; add_to_catalog: boolean }>;
}

export interface CuratorSummary {
  daily_budget_cents: number;
  sweep_at: string;
  tz: string;
  wiki_mode: WikiMode;
}

/** What `install` does not do yet; empty now that every stage exists. */
const NOT_IN_THIS_VERSION: string[] = [];

const MAX_CANDIDATES = 5;

export function buildPlanReport(input: {
  repoRoot: string;
  dataDir: string;
  services: ServicePlan;
  preflight: CheckResult[];
  vault: VaultPlan | null;
  structure: StructurePlan | null;
  keys: readonly ProviderKey[];
  models: ModelsPlan;
  curator: CuratorPlan | null;
  backup: BackupPlan | null;
  review: ReviewSummary;
  extractionApproved?: boolean | null;
  obsidianPlugin?: boolean | null;
  now: Date;
}): PlanReport {
  return {
    format: 'vault-installer-plan',
    version: 1,
    generated_at: input.now.toISOString(),
    repo_root: input.repoRoot,
    data_dir: input.dataDir,
    services: {
      user: input.services.user,
      node_path: input.services.nodePath,
      engine_port: input.services.enginePort,
      curator_port: input.services.curatorPort,
      service_manager: input.services.manager,
      service_dir: input.services.serviceDir,
    },
    preflight: input.preflight,
    vault: input.vault ? summarizeVault(input.vault) : null,
    structure: input.structure
      ? summarizeStructure(input.structure, input.vault?.discovery.inventory.markdown_files ?? 0)
      : null,
    vault_map: input.vault && input.structure ? buildVaultMap(input.vault, input.structure, input.curator) : null,
    providers: input.keys.map(key => ({ provider: key.provider, source: key.source, check: key.check, detail: key.detail })),
    models: summarizeModels(input.models),
    curator: input.curator
      ? { daily_budget_cents: input.curator.dailyBudgetCents, sweep_at: input.curator.sweepAt, tz: input.curator.tz, wiki_mode: input.curator.wikiMode }
      : null,
    backup: input.backup,
    review: input.review,
    extraction_approved: input.extractionApproved ?? null,
    obsidian_plugin: input.obsidianPlugin ?? null,
    not_in_this_version: NOT_IN_THIS_VERSION,
  };
}

function summarizeModels(plan: ModelsPlan): ModelsSummary {
  const used = new Map(plan.assignments.flatMap(assignment => assignment.model ? [[assignment.model.title, assignment.model] as const] : []));
  return {
    preset: plan.preset,
    vision_provider: plan.visionProvider,
    roles: plan.assignments.map(({ role, model, off }) => ({
      setting: role.id,
      label: role.label,
      model: model?.title ?? null,
      inherits: off === null && model === null && role.nullable,
      off,
    })),
    models: [...used.values()].map(model => ({
      title: model.title,
      provider: model.provider,
      model: model.model,
      input: model.pricing.input,
      output: model.pricing.output,
      add_to_catalog: !model.seeded,
    })),
  };
}

function summarizeVault(vault: VaultPlan): VaultSummary {
  const { discovery } = vault;
  return {
    path: vault.path,
    exclusions: vault.exclusions,
    settings_dir: vault.settingsDir,
    wiki_dir: vault.wikiDir,
    topic_dir: vault.topicDir,
    analyzer_exclusions: vault.analyzerExclusions,
    obsidian: vault.obsidian,
    managed_by_engine: vault.managedByEngine,
    sync_service: vault.syncService,
    analyzer_version: discovery.analyzer_version,
    source_fingerprint: discovery.source.source_fingerprint,
    inventory: discovery.inventory,
    top_level_folders: discovery.folders
      .filter(folder => !folder.path.includes('/'))
      .map(folder => ({ path: folder.path, notes: folder.subtree_markdown_files })),
    type_field_candidates: discovery.candidates.slice(0, MAX_CANDIDATES).map(candidate => ({
      key: candidate.key,
      notes: candidate.documents_with_key,
      samples: candidate.sample_values.slice(0, 3),
    })),
    issues: discovery.issues.map(issue => ({ code: issue.code, count: issue.count })),
    warnings: vault.warnings,
  };
}

function summarizeStructure(plan: StructurePlan, vaultNotes: number): StructureSummary {
  const roleOf = (name: string): Role | null => ROLES.find(role => plan.roles[role] === name) ?? null;
  const extraClaims = (name: string) => plan.extraClaims.filter(claim => claim.schema === name).map(claim => claim.field);
  const vaultTypes = (plan.analysis?.proposal.schemas ?? []).map(schema => ({
    name: schema.name,
    from: 'vault' as const,
    role: roleOf(schema.name),
    notes: schema.evidence.typed_documents,
    default_directory: schema.default_directory ?? null,
    fields: [...schema.field_claims.map(claim => claim.field), ...extraClaims(schema.name)],
  }));
  const starterTypes = plan.starterTypes.map(type => ({
    name: type.name,
    from: 'starter' as const,
    role: type.role,
    notes: 0,
    default_directory: null,
    fields: type.claims,
  }));
  return {
    source: plan.source,
    analyzer_spec: plan.spec,
    source_fingerprint: plan.analysis?.source.source_fingerprint ?? null,
    typed_notes: plan.analysis?.coverage.typed_files ?? 0,
    // Without an analysis (no types from the vault), every note in the vault stays untyped.
    untyped_notes: plan.analysis
      ? plan.analysis.inventory.markdown_files - plan.analysis.coverage.typed_files
      : vaultNotes,
    types: [...vaultTypes, ...starterTypes],
    fields_from_vault: plan.analysis?.proposal.global_fields.map(field => field.name) ?? [],
    starter_fields: plan.starterFields,
    roles: plan.roles,
    unmanaged_fields: plan.unmanagedFields,
    remove_type_field: plan.removeTypeField,
    warnings: plan.warnings,
  };
}

const SYMBOLS: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '✗' };

export function renderChecks(checks: readonly CheckResult[]): string {
  return checks.map(check => `${SYMBOLS[check.status]} ${check.title}: ${check.detail}`).join('\n');
}

export function renderVault(vault: VaultSummary): string {
  const lines: string[] = [];
  const others = Object.entries(vault.inventory.non_markdown_by_extension)
    .sort(([, left], [, right]) => right - left)
    .map(([extension, count]) => `${extension} ${count}`);
  lines.push(`${vault.path}`);
  lines.push(`${count(vault.inventory.markdown_files, 'Markdown file')}${others.length > 0 ? `; other files: ${others.join(', ')}` : ''}`);
  if (vault.top_level_folders.length > 0) {
    lines.push(`Folders: ${vault.top_level_folders.map(folder => `${folder.path} (${folder.notes})`).join(', ')}`);
  }
  lines.push(`Left out: ${vault.exclusions.length > 0 ? vault.exclusions.join(', ') : 'nothing'}`);
  lines.push(`Engine settings folder: ${vault.settings_dir}/`);
  lines.push(`Wiki pages: ${vault.wiki_dir}/; Curator's topic notes: ${vault.topic_dir}/`);
  if (vault.obsidian) lines.push('Obsidian vault: yes (the install can add the Vault Engine plugin to it at the end)');
  if (vault.type_field_candidates.length > 0) {
    lines.push('Possible type fields:');
    for (const candidate of vault.type_field_candidates) {
      const samples = candidate.samples.length > 0 ? `, e.g. ${candidate.samples.join(', ')}` : '';
      lines.push(`  ${candidate.key}: ${count(candidate.notes, 'note')}${samples}`);
    }
  } else {
    lines.push('No frontmatter field looks like a type; folders can type notes instead.');
  }
  const malformed = vault.issues.find(issue => issue.code === 'FRONTMATTER_MALFORMED');
  if (malformed) {
    lines.push(`${count(malformed.count, 'note')} with frontmatter that is not valid YAML; these are indexed as untyped.`);
  }
  for (const warning of vault.warnings) lines.push(`! ${warning}`);
  return lines.join('\n');
}

const SOURCE_LABELS: Record<TypingSource, string> = {
  field: 'a frontmatter field',
  folders: 'folders',
  both: 'a frontmatter field, then folders',
  tags: '#tags in the notes',
  none: 'nothing (no types from your notes)',
};

export function renderStructure(structure: StructureSummary): string {
  const lines: string[] = [];
  const typeField = structure.analyzer_spec.type_field;
  const tagRules = (structure.analyzer_spec.tag_rules ?? []).filter(rule => rule.type !== null);
  const byTags = structure.source !== 'tags' && tagRules.length > 0 ? `, and #tags (${tagRules.map(rule => `#${rule.tag}`).join(', ')})` : '';
  lines.push(`Typed by ${SOURCE_LABELS[structure.source]}${typeField ? ` (${typeField})` : ''}${byTags}`);
  lines.push(`${count(structure.typed_notes, 'note')} get a type; ${count(structure.untyped_notes, 'note')} stay untyped`);
  lines.push('Types:');
  for (const type of structure.types) {
    const details = [
      type.from === 'starter' ? 'new type' : count(type.notes, 'note'),
      ...(type.default_directory ? [`in ${type.default_directory}/`] : []),
      ...(type.role ? [`holds your ${type.role === 'person' ? 'people' : `${type.role}s`}`] : []),
    ];
    const fields = type.fields.length > 0 ? `; fields: ${type.fields.join(', ')}` : '';
    lines.push(`  ${type.name}: ${details.join(', ')}${fields}`);
  }
  lines.push(`Fields: ${count(structure.fields_from_vault.length, 'field')} from your notes${
    structure.starter_fields.length > 0 ? `, plus ${structure.starter_fields.map(field => field.name).join(', ')}` : ''}`);
  for (const [name, type] of Object.entries(structure.analyzer_spec.field_types ?? {})) {
    lines.push(`Stored as ${describeFieldType(type)}, as you chose: ${name}`);
  }
  for (const field of structure.unmanaged_fields) {
    lines.push(`Kept as-is for now: ${field.name} (${field.reasons.join('; ')})`);
  }
  const typeKey = typeKeyOf(structure.analyzer_spec);
  if (typeField && typeField === typeKey && typeKey !== DEFAULT_TYPE_KEY) {
    lines.push(`Engine keeps each note's types in its ${typeKey} field (VAULT_TYPE_KEY); no types field is added.`);
  } else if (typeField && typeField !== typeKey) {
    lines.push(structure.remove_type_field
      ? `Adoption replaces the ${typeField} field with a ${typeKey} field on each note that gets a type; the others keep it.`
      : `Notes keep their ${typeField} field; adoption adds a ${typeKey} field next to it.`);
  }
  for (const warning of structure.warnings) lines.push(`! ${warning}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------
// The review in short: what a first-time user needs to decide, before the details.

export interface SummaryOptions {
  /** Root commands run through sudo; false when `install --no-sudo` prints them instead. */
  sudo: boolean;
}

/** A note box at 80 columns holds 74 characters a line. */
export const SUMMARY_WIDTH = 74;
const SUMMARY_LABEL_WIDTH = 12;

const SUMMARY_KIND_LABELS: Record<Role, string> = {
  project: 'projects',
  task: 'tasks',
  meeting: 'meetings',
  person: 'people',
  company: 'companies',
};

const SERVICE_NAMES: Record<string, string> = { [ENGINE_UNIT]: 'Engine', [CURATOR_UNIT]: 'Curator' };

/**
 * The plan in about a dozen lines: what changes in the notes, the designations and what
 * each none turns off, the backup, what runs in the background, the most it spends a day,
 * and the root commands. Every number is read from the plan, never worked out again.
 */
export function renderSummary(report: PlanReport, options: SummaryOptions = { sudo: true }): string {
  // Each row is a label and its paragraphs; a paragraph starts on a new line.
  const rows: Array<[string, string[]]> = [['Your notes', [summarizeNotes(report).join(' ')]]];
  if (report.vault_map && report.structure) rows.push(...summarizeMap(report.vault_map, report.structure));
  rows.push(
    ['Backup', [summarizeBackup(report)]],
    ['Services', [summarizeServices(report.review, plannedManager(report.services))]],
    ['Spending', [summarizeSpending(report).join(' ')]],
    ['sudo', [summarizeSudo(report.review, options, plannedManager(report.services))]],
  );
  const width = SUMMARY_WIDTH - SUMMARY_LABEL_WIDTH;
  return rows.flatMap(([label, paragraphs]) => paragraphs.flatMap(paragraph => wrap(paragraph, width))
    // A word longer than the column (a long path) is broken, so no line runs past it.
    .flatMap(line => line.length <= width ? [line] : line.match(new RegExp(`.{1,${width}}`, 'g')) ?? [line])
    .map((line, index) => `${(index === 0 ? label : '').padEnd(SUMMARY_LABEL_WIDTH)}${line}`)).join('\n');
}

/** The frontmatter key adoption writes each note's types under: the plan's type key (#445). */
function writtenTypeKey(structure: StructureSummary): string {
  return typeKeyOf(structure.analyzer_spec);
}

function summarizeNotes(report: PlanReport): string[] {
  if (!report.vault) return ['Not read: Vault must be built first.'];
  const structure = report.structure;
  if (!structure) return ['Left as they are: Vault has used this folder before.'];
  const key = writtenTypeKey(structure);
  const field = structure.analyzer_spec.type_field;
  const typed = structure.typed_notes;
  const untyped = structure.untyped_notes;
  if (typed === 0) {
    return ['No note gets a type, and no key is added to any note.', ALIAS_LINKS];
  }
  const own = field === key;
  const where = own
    ? structure.source === 'field'
      ? `in the ${key} key they have (no key is added)`
      : `in their ${key} key, added to those typed by ${structure.source === 'folders' || structure.source === 'both' ? 'folder' : 'tag'}${(structure.source === 'folders' || structure.source === 'both') && (structure.analyzer_spec.tag_rules ?? []).some(rule => rule.type !== null) ? ' or tag' : ''}`
    : `under a new ${key} key${field === null
      ? ''
      : structure.remove_type_field ? `, in place of their ${field} key` : ` (their ${field} key stays)`}`;
  return [
    `${count(typed, 'note')} ${typed === 1 ? 'gets' : 'get'} a type ${where}; ${untyped} ${untyped === 1 ? 'stays' : 'stay'} untyped.`,
    'Engine rewrites the top of each note it changes.',
    ALIAS_LINKS,
  ];
}

/** Engine's link repair when it starts, whatever the plan types. */
const ALIAS_LINKS = 'It also rewrites links that use a note\'s alias.';

function summarizeMap(map: VaultMapSummary, structure: StructureSummary): Array<[string, string[]]> {
  const designated = ROLES.filter(role => map.kinds[role].type !== null)
    .map(role => `${SUMMARY_KIND_LABELS[role]}: ${map.kinds[role].type}${map.kinds[role].from === 'starter' ? ' (new)' : ''}`);
  const journal = map.kinds.journal;
  if (journal.type !== null) {
    designated.push(`journal: ${journal.type}${
      journal.from === 'curator' ? ' (Curator creates it)' : journal.from === 'starter' ? ' (new)' : ''}`);
  }
  if (map.kinds.dailyNote.type !== null) designated.push(`daily notes: ${map.kinds.dailyNote.type}`);
  // What each none turns off, in short (the plan's `off` says it at length). With no
  // project kind there are no project wikis for the other kinds to appear in.
  const none = ROLES.filter(role => map.kinds[role].type === null);
  const off = none.includes('project')
    ? 'so there are no project wikis and nothing is filed under a project'
    : 'so project wikis leave them out';
  const kinds = [
    ...(designated.length > 0 ? [`${designated.join(', ')}.`] : []),
    ...(none.length > 0 ? [`None: ${none.map(role => SUMMARY_KIND_LABELS[role]).join(', ')}, ${off}.`] : []),
  ];

  // A task status field with no done (or no usable open) value: the plan's `off` says a List
  // view shows no checkbox for it (#488).
  const checkbox = taskCheckboxOffIn(map);
  const statusField = (kind: StatusKind) => {
    const status = map.status[kind];
    const name = `${status.field ?? 'none'}${status.from === 'starter' ? ' (new)' : ''}`;
    // A kind that is none has no status field either; nothing more is off.
    const lost = status.field === null && map.kinds[kind].type !== null ? ` (${STATUS_FIELD_OFF[kind]})`
      : kind === 'task' && checkbox !== null ? ` (no ${checkbox} value, so List views show no checkbox)`
      : '';
    return `${kind} status: ${name}${lost}`;
  };

  const newTypes = structure.types.filter(type => type.from === 'starter').map(type => type.name);
  const newFields = structure.starter_fields.map(field => field.name);
  const created = newTypes.length === 0 && newFields.length === 0
    ? 'Nothing beyond the types and fields your notes already use.'
    : `Only what you picked: ${[
      // Names are listed with commas only: a name may itself hold "and".
      ...(newTypes.length > 0 ? [`the ${newTypes.length === 1 ? 'type' : 'types'} ${newTypes.join(', ')}`] : []),
      ...(newFields.length > 0 ? [`the ${newFields.length === 1 ? 'field' : 'fields'} ${newFields.join(', ')}`] : []),
    ].join('; ')}.`;

  return [
    ['Kinds', kinds],
    ['Fields', [`${statusField('project')}; ${statusField('task')}.`]],
    ['New', [created]],
  ];
}

const STATUS_FIELD_OFF: Record<StatusKind, string> = {
  project: 'every project counts as active',
  task: 'wikis cannot tell open tasks from done ones',
};

function summarizeBackup(report: PlanReport): string {
  const backup = report.backup;
  if (!backup) return 'Not planned.';
  if (backup.mode === 'skip') return 'None: you chose to skip it.';
  const what = backup.mode === 'full' ? count(backup.files, 'file') : count(backup.files, 'Markdown file');
  return `${what} (${formatBytes(backup.bytes)}) to ${join(report.data_dir, 'installer', 'backups')}/`;
}

function summarizeServices(review: ReviewSummary, manager: ServiceManager): string {
  const names = review.services.map(service => SERVICE_NAMES[service.unit] ?? service.unit);
  const one = names.length === 1;
  return `${listed(names)} ${one ? 'runs' : 'run'} in the background and ${one ? 'starts' : 'start'} ${manager === 'launchd' ? 'when you log in' : 'at boot'}.`;
}

function summarizeSpending(report: PlanReport): string[] {
  const sentences = [
    report.curator
      ? `Curator: at most ${dollars(report.curator.daily_budget_cents)} a day.`
      : 'Nothing spends on a schedule (no Curator).',
    'Chat and memory: only when used.',
  ];
  const extraction = report.review.settings.some(setting => setting.setting === 'engine.extractionEnabled' && setting.value === true);
  if (!extraction) sentences.push('Reading attachments is off.');
  else if (report.extraction_approved === true) sentences.push('Reading attachments turns on after setup, as your answers say.');
  else if (report.extraction_approved === false) sentences.push('Reading attachments stays off, as your answers say.');
  else sentences.push('Reading attachments (paid) is asked about separately.');
  return sentences;
}

function summarizeSudo(review: ReviewSummary, options: SummaryOptions, manager: ServiceManager): string {
  // launchd agents are the user's own: nothing runs as root.
  if (manager === 'launchd') return 'Not needed: the services run as you.';
  const always = review.sudo_commands.filter(command => command.when === undefined).length;
  const later = new Map<string, number>();
  for (const { when } of review.sudo_commands) if (when !== undefined) later.set(when, (later.get(when) ?? 0) + 1);
  const more = [...later].map(([when, n]) => `${n} more ${when}`);
  if (always === 0 && more.length === 0) return 'Not needed.';
  const first = options.sudo
    ? count(always, 'command')
    : `Not used: you run ${count(always, 'root command')} yourself (--no-sudo)`;
  return `${[first, ...more].join('; ')}.`;
}

/** `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function renderNotInThisVersion(report: PlanReport): string {
  return report.not_in_this_version.map(item => `- ${item}`).join('\n');
}

const KEY_SYMBOLS: Record<KeyCheck, string> = { valid: '✓', unreachable: '!', unchecked: '-' };

export function renderProviders(providers: readonly ProviderSummary[]): string {
  const lines = providers.map(provider => {
    const from = provider.source === 'entered' ? 'entered' : `from ${provider.source.slice('env:'.length)}`;
    return `${KEY_SYMBOLS[provider.check]} ${providerInfo(provider.provider).label}: ${provider.detail}; ${from}`;
  });
  const unused = PROVIDERS.filter(info => !providers.some(provider => provider.provider === info.id));
  if (unused.length > 0) lines.push(`No key: ${unused.map(info => info.label).join(', ')}`);
  return lines.join('\n');
}

const PRESET_LABELS: Record<Preset, string> = { balanced: 'Balanced', 'low-cost': 'Low cost', custom: 'Custom' };
const VISION_LABELS: Record<VisionProvider, string> = {
  gemini: 'Gemini',
  claude: 'Claude',
  model: 'a catalog model',
  off: 'off',
};

export function renderModels(models: ModelsSummary): string {
  const lines = [`Preset: ${PRESET_LABELS[models.preset]}`];
  const named = models.roles
    .filter(role => role.label !== role.setting)
    .sort((left, right) => ASKED_ROLE_ORDER.indexOf(left.setting) - ASKED_ROLE_ORDER.indexOf(right.setting));
  for (const role of named) lines.push(`${role.label}: ${roleChoice(role)}`);
  const others = new Map<string, string[]>();
  for (const role of models.roles.filter(candidate => candidate.label === candidate.setting && !candidate.inherits)) {
    const choice = roleChoice(role);
    others.set(choice, [...(others.get(choice) ?? []), role.setting]);
  }
  for (const [choice, settings] of others) lines.push(`${settings.join(', ')}: ${choice}`);
  const inheriting = models.roles.filter(role => role.label === role.setting && role.inherits);
  if (inheriting.length > 0) lines.push(`${count(inheriting.length, 'other setting')} use Curator's writing model`);
  if (models.models.length > 0) {
    lines.push('Prices per million tokens:');
    for (const model of models.models) {
      lines.push(`  ${model.title} (${providerInfo(model.provider as ProviderId).label}): $${model.input.toFixed(2)} in, $${model.output.toFixed(2)} out${
        model.add_to_catalog ? '; added to the catalog' : ''}`);
    }
  }
  lines.push(`Images and scanned PDFs: ${VISION_LABELS[models.vision_provider]}${models.vision_provider === 'off' ? '' : ', once you approve extraction'}`);
  return lines.join('\n');
}

function roleChoice(role: ModelsSummary['roles'][number]): string {
  if (role.off !== null) return `off (${role.off})`;
  if (role.inherits) return 'same as Curator writing';
  return role.model ?? 'unset';
}

const WIKI_MODE_LABELS: Record<WikiMode, string> = {
  live: 'kept current',
  'dry-run': 'previewed, never written',
  off: 'changed only when you ask',
};

export function renderCurator(curator: CuratorSummary | null, settingsDir: string | null): string {
  if (!curator) return 'Not installed.';
  return [
    `Daily cap: ${dollars(curator.daily_budget_cents)}; Curator refuses calls past it`,
    `Daily sweep: ${curator.sweep_at}, ${curator.tz || 'system time zone'}`,
    `Wikis you create: ${WIKI_MODE_LABELS[curator.wiki_mode]}`,
    `Optional sweeps (memories, conversations, conversation capture, organization): off; turn them on later in ${settingsDir ?? 'Settings'}/Curator/ (Memories, Conversation capture, Organization)`,
  ].join('\n');
}
