import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { AnalyzerRunner, DiscoverReport } from './analyzer.js';
import type { AnswerId } from './answers.js';
import type { Host } from './host.js';
import { DEFAULT_SETTINGS_DIR, DEFAULT_TOPIC_DIR, DEFAULT_WIKI_DIR, isWithin, resolveUserPath } from './layout.js';
import { withSpinner, type Prompter } from './prompter.js';
import { count } from './text.js';

const GIB = 1024 ** 3;
const MIN_VAULT_DISK_BYTES = 2 * GIB;
const ALTERNATIVE_SETTINGS_DIR = 'Vault Settings';
const ALTERNATIVE_WIKI_DIR = 'Vault Wikis';
const ALTERNATIVE_TOPIC_DIR = 'Vault Topics';
const TEMPLATE_FOLDER_RE = /^_?templates?$/i;
/** The choice after Obsidian's vaults; never a path, since every vault path is absolute. */
const SOMEWHERE_ELSE = 'somewhere-else';
const DECLINED = Symbol('declined');

/**
 * The messy sample (#650), in the code checkout: about 150 made-up notes exported from three
 * apps, untyped, with tags, dates in other forms, copies, and names with no note. A new
 * folder can start with it, to try the sorting on.
 */
export const MESSY_SAMPLE = ['examples', 'messy-vault'] as const;
type FolderStart = 'empty' | 'messy';

/** Folder names of common third-party sync clients. */
const SYNC_FOLDER_NAMES: Array<[RegExp, string]> = [
  [/^Dropbox( \(.+\))?$/i, 'Dropbox'],
  [/^(Google ?Drive|My Drive)$/i, 'Google Drive'],
  [/^OneDrive( - .+)?$/i, 'OneDrive'],
  [/^(iCloud ?Drive|Mobile Documents)$/i, 'iCloud Drive'],
  [/^Nextcloud$/i, 'Nextcloud'],
  [/^pCloud ?Drive$/i, 'pCloud'],
];
/** Marker files or folders a sync client keeps at the root of what it syncs. */
const SYNC_MARKERS: Array<[string, string]> = [
  ['.stfolder', 'Syncthing'],
  ['.dropbox', 'Dropbox'],
];

export interface VaultPlan {
  path: string;
  /** Directories the user chose to leave out of Engine and the analysis. */
  exclusions: string[];
  settingsDir: string;
  /** Engine's wiki pages and Curator's journal (the vault map's wikiDir). */
  wikiDir: string;
  /** Curator's topic notes (the vault map's topicDir, set when Curator is installed). */
  topicDir: string;
  /** Exclusions for structure analysis: the user's plus Engine's settings folder. */
  analyzerExclusions: string[];
  obsidian: boolean;
  managedByEngine: boolean;
  syncService: string | null;
  discovery: DiscoverReport;
  warnings: string[];
}

export interface VaultStageDeps {
  host: Host;
  prompter: Prompter;
  analyzer: AnalyzerRunner;
  cwd: string;
  /** The services' data directory, which must not overlap the vault. */
  dataDir: string;
  /** The code checkout the installer runs from, which must not overlap the vault either. */
  repoRoot: string;
}

/**
 * Stage 2. Choose the folder (creating a new one when the user agrees), inspect it
 * read-only, and settle exclusions.
 */
export async function runVaultStage(deps: VaultStageDeps): Promise<VaultPlan> {
  const { host, prompter, analyzer } = deps;
  const path = await askVaultPath(deps);
  const warnings: string[] = [];

  const [obsidian, managedByEngine, syncService, freeBytes] = await Promise.all([
    host.pathExists(join(path, '.obsidian')),
    host.pathExists(join(path, '.vault-engine')),
    detectSyncService(path, marker => host.pathExists(marker)),
    host.freeDiskBytes(path),
  ]);
  if (managedByEngine) {
    warnings.push('This folder already has a .vault-engine/ directory, so Vault Engine has used it before. This installer version plans fresh installs only.');
  }
  if (syncService) {
    warnings.push(`This folder is synced by ${syncService}. Engine keeps a live SQLite database and a large search-model cache in .vault-engine/, and sync clients can corrupt the database; installing keeps both outside the vault.`);
  }
  if (freeBytes !== null && freeBytes < MIN_VAULT_DISK_BYTES) {
    warnings.push(`Only ${(freeBytes / GIB).toFixed(1)} GB is free on this folder's disk; Engine's database and search model need about 2 GB.`);
  }

  let discovery = await withSpinner(
    prompter,
    'Scanning the folder (read-only)…',
    () => analyzer.discover(path, []),
    report => `Found ${count(report.inventory.markdown_files, 'Markdown file')}.`,
  );

  const exclusions = await askExclusions(prompter, discovery);
  const settingsDir = await chooseSettingsDir(deps, path, managedByEngine, exclusions);
  const wikiDir = await chooseFolder(deps, path, managedByEngine, exclusions, WIKI_FOLDER, [
    { directory: settingsDir, holds: 'Engine\'s settings folder' },
  ]);
  const topicDir = await chooseFolder(deps, path, managedByEngine, exclusions, TOPIC_FOLDER, [
    { directory: settingsDir, holds: 'Engine\'s settings folder' },
    { directory: wikiDir, holds: 'the wiki folder' },
  ]);

  if (exclusions.length > 0) {
    discovery = await withSpinner(
      prompter,
      'Rescanning without the excluded folders…',
      () => analyzer.discover(path, exclusions),
      report => `Kept ${count(report.inventory.markdown_files, 'Markdown file')}.`,
    );
  }

  return {
    path: discovery.source.canonical_root,
    exclusions,
    settingsDir,
    wikiDir,
    topicDir,
    analyzerExclusions: [...new Set([...exclusions, settingsDir])].sort(),
    obsidian,
    managedByEngine,
    syncService,
    discovery,
    warnings,
  };
}

async function askVaultPath({ host, prompter, cwd, dataDir, repoRoot }: VaultStageDeps): Promise<string> {
  // Only an interactive run offers Obsidian's vaults; an answers file names its folder.
  const obsidianVaults = prompter.interactive ? await findObsidianVaults(host) : [];
  for (;;) {
    const chosen = obsidianVaults.length > 0
      ? await prompter.select({
        id: 'vault.path',
        message: 'Where are your notes? These are the Obsidian vaults on this computer.',
        options: [
          ...obsidianVaults.map(vault => ({ value: vault, label: homeRelative(vault, host.homeDir) })),
          { value: SOMEWHERE_ELSE, label: 'Somewhere else', hint: 'pick or type a folder' },
        ],
        initialValue: obsidianVaults[0] as string,
      })
      : SOMEWHERE_ELSE;
    const answer = chosen !== SOMEWHERE_ELSE ? chosen : await prompter.text({
      id: 'vault.path',
      message: 'Where are your notes? Choose the folder that holds your Markdown files, or type a new folder to start one.',
      placeholder: '~/Notes',
      folder: true,
      // The folder the installer was run from, unless that is the code checkout: install.sh
      // is usually run from there, and accepting it would make the code the vault.
      ...(isWithin(cwd, repoRoot) ? {} : { initialInput: cwd }),
      relativeTo: cwd,
    });
    const path = resolveUserPath(answer, host.homeDir, cwd);
    let access = await host.inspectDirectory(path);
    // An answers file asks for a new folder by saying how it starts.
    const start = prompter.interactive ? null : await prompter.decide<FolderStart | null>({
      id: 'vault.sample',
      ask: async () => null,
      defaultValue: () => null,
    });
    if (start !== null) {
      if (access.exists) {
        prompter.rejectAnswer('vault.sample', `${path} already exists; vault.sample creates a new folder, so name one that does not exist yet.`);
        continue;
      }
      const problem = await createFolder(host, prompter, path, dataDir, repoRoot, start);
      if (problem !== null) {
        prompter.rejectAnswer('vault.sample', problem);
        continue;
      }
      access = await host.inspectDirectory(path);
    }
    if (!access.exists && prompter.interactive) {
      const problem = await offerNewFolder(host, prompter, path, dataDir, repoRoot);
      if (problem === DECLINED) continue;
      if (problem !== null) {
        prompter.rejectAnswer('vault.path', problem);
        continue;
      }
      access = await host.inspectDirectory(path);
    }
    const problem = !access.exists
      ? `${path} does not exist.`
      : !access.directory
        ? `${path} is not a folder.`
        : !access.readable
          ? `${path} is not readable by you.`
          : !access.writable
            ? `${path} is not writable by you; Engine needs to write into the vault.`
            : null;
    if (problem === null) {
      // Resolve symlinks so sync detection sees the real location, not an alias.
      const real = await host.realPath(path);
      const overlap = await checkoutOverlap(host, real, repoRoot) ?? await dataDirOverlap(host, real, dataDir);
      if (overlap === null) return real;
      prompter.rejectAnswer('vault.path', overlap);
    } else {
      prompter.rejectAnswer('vault.path', problem);
    }
  }
}

/**
 * Offer to create a folder that does not exist yet, for someone starting without notes.
 * The data directory check runs first, so a folder the next check would refuse is never
 * created. Null once the folder exists; otherwise why it cannot be the vault, or DECLINED.
 */
async function offerNewFolder(
  host: Host,
  prompter: Prompter,
  path: string,
  dataDir: string,
  repoRoot: string,
): Promise<string | null | typeof DECLINED> {
  const real = await existingRealPath(host, path);
  const overlap = await checkoutOverlap(host, real, repoRoot) ?? await dataDirOverlap(host, real, dataDir);
  if (overlap !== null) return overlap;
  const create = await prompter.confirm({
    message: `${homeRelative(path, host.homeDir)} does not exist. Create it as a new notes folder?`,
    initialValue: true,
  });
  if (!create) return DECLINED;
  const start = await prompter.select<FolderStart>({
    id: 'vault.sample',
    message: 'Start it empty, or with a messy sample to try the sorting on?',
    options: [
      { value: 'empty', label: 'Empty', hint: 'for your own notes' },
      { value: 'messy', label: 'With a messy sample', hint: 'about 150 made-up notes exported from three apps, none sorted yet' },
    ],
    initialValue: 'empty',
  });
  return createFolder(host, prompter, path, dataDir, repoRoot, start);
}

/**
 * Create a new notes folder, empty or with the messy sample. Null once it exists; otherwise why
 * it cannot be the vault. The checks that refuse a vault inside the code checkout or around the
 * data directory run first, so nothing is created there.
 */
async function createFolder(
  host: Host,
  prompter: Prompter,
  path: string,
  dataDir: string,
  repoRoot: string,
  start: FolderStart,
): Promise<string | null> {
  const real = await existingRealPath(host, path);
  const overlap = await checkoutOverlap(host, real, repoRoot) ?? await dataDirOverlap(host, real, dataDir);
  if (overlap !== null) return overlap;
  if (start === 'messy') {
    // The copy creates the folder, as it creates each folder inside it.
    try {
      await host.copyDirectory(join(repoRoot, ...MESSY_SAMPLE), path);
    } catch (error) {
      return `Could not create ${path} with the sample: ${error instanceof Error ? error.message : String(error)}`;
    }
    prompter.info(`Created ${homeRelative(path, host.homeDir)} with the messy sample. Every note in it is made up.`);
    return null;
  }
  try {
    await host.makeDirectory(path);
  } catch (error) {
    return `Could not create ${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
  prompter.info(`Created ${homeRelative(path, host.homeDir)}.`);
  return null;
}

/**
 * Where Obsidian keeps its list of vaults on Linux: its config folder (under
 * `$XDG_CONFIG_HOME`, else `~/.config`), and the same file inside a Flatpak or Snap install.
 */
function obsidianConfigFiles(host: Host): string[] {
  const xdg = host.env('XDG_CONFIG_HOME');
  const configHome = xdg !== undefined && isAbsolute(xdg) ? xdg : join(host.homeDir, '.config');
  return [...new Set([
    join(configHome, 'obsidian', 'obsidian.json'),
    join(host.homeDir, '.config', 'obsidian', 'obsidian.json'),
    join(host.homeDir, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'),
    join(host.homeDir, 'snap', 'obsidian', 'current', '.config', 'obsidian', 'obsidian.json'),
  ])];
}

/**
 * The vaults Obsidian lists on this computer that are still folders, most recently opened
 * first. Obsidian's `obsidian.json` holds `{ vaults: { <id>: { path, ts } } }`; a file that
 * is missing, unreadable, or not in that shape just suggests nothing.
 */
export async function findObsidianVaults(host: Host): Promise<string[]> {
  const opened = new Map<string, number>();
  for (const file of obsidianConfigFiles(host)) {
    let config: unknown;
    try {
      const text = await host.readText(file);
      if (text === null) continue;
      config = JSON.parse(text);
    } catch {
      continue;
    }
    const vaults = isRecord(config) && isRecord(config.vaults) ? Object.values(config.vaults) : [];
    for (const vault of vaults) {
      if (!isRecord(vault) || typeof vault.path !== 'string' || !isAbsolute(vault.path)) continue;
      const path = resolve(vault.path);
      const ts = typeof vault.ts === 'number' && Number.isFinite(vault.ts) ? vault.ts : 0;
      opened.set(path, Math.max(opened.get(path) ?? ts, ts));
    }
  }
  const folders = await Promise.all([...opened.keys()].map(async path => {
    const access = await host.inspectDirectory(path);
    return access.exists && access.directory ? path : null;
  }));
  return folders
    .filter((path): path is string => path !== null)
    .sort((left, right) => (opened.get(right) ?? 0) - (opened.get(left) ?? 0) || left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `~/Notes` for a folder in the home folder; other paths as they are. */
function homeRelative(path: string, homeDir: string): string {
  return path.startsWith(`${homeDir}${sep}`) ? `~${path.slice(homeDir.length)}` : path;
}

/**
 * The code checkout the installer runs from is not a notes folder: install.sh is usually run
 * from it, and as a vault (or inside one) its docs and test notes would be indexed as notes.
 */
async function checkoutOverlap(host: Host, vault: string, repoRoot: string): Promise<string | null> {
  const checkout = await existingRealPath(host, repoRoot);
  if (vault === checkout) {
    return 'This folder is the Vault Engine code checkout, not a notes folder. Choose the folder that holds your notes.';
  }
  if (isWithin(vault, checkout)) {
    return `This folder is inside the Vault Engine code checkout ${checkout}, not a notes folder. Choose the folder that holds your notes.`;
  }
  if (isWithin(checkout, vault)) {
    return `The Vault Engine code checkout ${checkout} is inside this folder, and Engine would index its documentation and test notes as yours. Choose your notes folder, or move the checkout out of it.`;
  }
  return null;
}

/**
 * The data directory holds keys and the backups' copies of every note, so it must stay out
 * of the vault: Engine would index the copies as notes, and a sync client would copy keys.
 */
async function dataDirOverlap(host: Host, vault: string, dataDir: string): Promise<string | null> {
  const data = await existingRealPath(host, dataDir);
  if (data === vault || data.startsWith(`${vault}${sep}`)) {
    return `The data directory ${dataDir} is inside this folder, and Engine would index its backups as notes. Choose another folder, or pass --data-dir outside it.`;
  }
  if (vault.startsWith(`${data}${sep}`)) {
    return `This folder is inside the data directory ${dataDir}; keep the vault and the data directory apart.`;
  }
  return null;
}

/** `path` with symlinks resolved, for a path whose last parts may not exist yet. */
async function existingRealPath(host: Host, path: string): Promise<string> {
  if (await host.pathExists(path)) return host.realPath(path);
  const parent = dirname(path);
  return parent === path ? path : join(await existingRealPath(host, parent), basename(path));
}

async function askExclusions(prompter: Prompter, discovery: DiscoverReport): Promise<string[]> {
  const topLevel = discovery.folders.filter(folder => !folder.path.includes('/'));
  for (;;) {
    const chosen = await prompter.multiselect({
      id: 'vault.exclude',
      message: 'Any folders Vault should ignore? Tick them with Space. (Templates are ticked for you.)',
      options: topLevel.map(folder => ({
        value: folder.path,
        label: folder.path,
        hint: count(folder.subtree_markdown_files, 'note'),
      })),
      initialValues: topLevel.filter(folder => TEMPLATE_FOLDER_RE.test(folder.path)).map(folder => folder.path),
    });
    const normalized = chosen.map(parseRelativeDirectory);
    const invalid = chosen.find((_, index) => normalized[index] === null);
    // Engine takes its first exclusions from VAULT_EXCLUDE_DIRS, a comma-separated list.
    const comma = chosen.find(directory => directory.includes(','));
    if (invalid === undefined && comma === undefined) return [...new Set(normalized as string[])].sort();
    prompter.rejectAnswer('vault.exclude', invalid !== undefined
      ? `${JSON.stringify(invalid)} is not a folder path inside the vault.`
      : `${JSON.stringify(comma)} has a comma, and Engine reads its exclusions as a comma-separated list; rename the folder to leave it out.`);
  }
}

/** A folder the services write into, and what to ask when the vault already has one. */
interface ServiceFolder {
  id: AnswerId;
  folder: string;
  alternative: string;
  /** Warned when the vault already has the folder. */
  exists: string;
  /** Completes "<folder>/ is inside <exclusion>/, which you left out, so …". */
  excluded: string;
  message: string;
  /** Completes "<answer>/ is inside <exclusion>/, which you left out; …". */
  rejectExcluded: string;
}

const SETTINGS_FOLDER: ServiceFolder = {
  id: 'vault.settings_dir',
  folder: DEFAULT_SETTINGS_DIR,
  alternative: ALTERNATIVE_SETTINGS_DIR,
  exists: 'Engine keeps its own settings notes in a folder of that name.',
  excluded: 'Engine needs another folder for its settings notes.',
  message: 'Vault keeps its settings as notes. Which folder should they go in?',
  rejectExcluded: 'Engine cannot keep its settings there.',
};

const WIKI_FOLDER: ServiceFolder = {
  id: 'vault.wiki_dir',
  folder: DEFAULT_WIKI_DIR,
  alternative: ALTERNATIVE_WIKI_DIR,
  exists: `Engine writes wiki pages, and Vault Curator its journal, to a folder of that name. Answer ${DEFAULT_WIKI_DIR} to put them next to what is there.`,
  excluded: 'Engine needs another folder for wiki pages.',
  message: 'Which folder should wiki pages go in?',
  rejectExcluded: 'Engine would not see the wiki pages there.',
};

const TOPIC_FOLDER: ServiceFolder = {
  id: 'vault.topic_dir',
  folder: DEFAULT_TOPIC_DIR,
  alternative: ALTERNATIVE_TOPIC_DIR,
  exists: `Vault Curator keeps the topic notes its topic wikis are built on in a folder of that name. Answer ${DEFAULT_TOPIC_DIR} to put them next to what is there.`,
  excluded: 'Vault Curator needs another folder for topic notes.',
  message: 'Which folder should Curator\'s topic notes go in?',
  rejectExcluded: 'Engine would not see the topic notes there.',
};

function chooseSettingsDir(
  deps: VaultStageDeps,
  vaultPath: string,
  managedByEngine: boolean,
  exclusions: readonly string[],
): Promise<string> {
  return chooseFolder(deps, vaultPath, managedByEngine, exclusions, SETTINGS_FOLDER, []);
}

/**
 * Ask for the folder, offering its usual name, or another when the vault already has a
 * folder of that name, left it out, or it overlaps `taken` (each is said first). An answer
 * must not be left out, another existing folder, or overlap `taken`; the usual name may
 * share an existing folder of that name. A vault Engine already manages keeps the usual names.
 */
async function chooseFolder(
  { host, prompter }: VaultStageDeps,
  vaultPath: string,
  managedByEngine: boolean,
  exclusions: readonly string[],
  spec: ServiceFolder,
  taken: ReadonlyArray<{ directory: string; holds: string }>,
): Promise<string> {
  if (managedByEngine) return spec.folder;
  const defaultExcluded = excludedBy(spec.folder, exclusions);
  const defaultTaken = taken.find(other => overlaps(spec.folder, other.directory));
  let suggestion = spec.alternative;
  if (defaultExcluded !== null) {
    prompter.warn(`${spec.folder}/ is inside ${defaultExcluded}/, which you left out, so ${spec.excluded}`);
  } else if (defaultTaken !== undefined) {
    prompter.warn(`${spec.folder}/ overlaps ${defaultTaken.holds}, ${defaultTaken.directory}/, so ${spec.excluded}`);
  } else if (await host.pathExists(join(vaultPath, spec.folder))) {
    prompter.warn(`Your vault already has a ${spec.folder}/ folder. ${spec.exists}`);
  } else {
    suggestion = spec.folder;
  }
  for (;;) {
    // When the usual folder cannot simply be used, the choice is the user's, even in quick setup.
    const answer = await prompter.text({ id: spec.id, message: spec.message, defaultValue: suggestion, mustAsk: suggestion !== spec.folder });
    const directory = parseRelativeDirectory(answer);
    if (directory === null) {
      prompter.rejectAnswer(spec.id, `${JSON.stringify(answer)} is not a folder path inside the vault.`);
      continue;
    }
    // Engine refuses exclusions that cover its settings folder (settings/seed.ts, SettingsService),
    // and indexes nothing written into a left-out folder.
    const excluded = excludedBy(directory, exclusions);
    if (excluded !== null) {
      prompter.rejectAnswer(spec.id, `${directory}/ is inside ${excluded}/, which you left out; ${spec.rejectExcluded}`);
      continue;
    }
    const overlap = taken.find(other => overlaps(directory, other.directory));
    if (overlap !== undefined) {
      prompter.rejectAnswer(spec.id, `${directory}/ overlaps ${overlap.holds}, ${overlap.directory}/; choose another folder.`);
      continue;
    }
    if (directory !== spec.folder && await host.pathExists(join(vaultPath, directory))) {
      prompter.rejectAnswer(spec.id, `${directory}/ already exists; choose a new folder name.`);
      continue;
    }
    return directory;
  }
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** The exclusion that contains `directory`, matched by whole segments as Engine does. */
function excludedBy(directory: string, exclusions: readonly string[]): string | null {
  return exclusions.find(exclusion => directory === exclusion || directory.startsWith(`${exclusion}/`)) ?? null;
}

/**
 * A vault-relative POSIX directory with no surrounding whitespace, no leading slash,
 * and no empty, `.`, or `..` segments. Mirrors Vault Analyzer's own validation so a
 * bad value is caught before the Analyzer refuses it.
 */
export function parseRelativeDirectory(value: string): string | null {
  if (value !== value.trim()) return null;
  const directory = value.replace(/\/+$/, '');
  if (directory.length === 0 || directory.startsWith('/')) return null;
  const segments = directory.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null;
  return directory;
}

/** The sync service whose folder contains `path`, judged by folder names and markers. */
export async function detectSyncService(
  path: string,
  exists: (marker: string) => Promise<boolean>,
): Promise<string | null> {
  const segments = path.split(sep).filter(Boolean);
  for (const segment of segments) {
    for (const [pattern, service] of SYNC_FOLDER_NAMES) {
      if (pattern.test(segment)) return service;
    }
  }
  for (let depth = segments.length; depth >= 1; depth--) {
    const directory = sep + segments.slice(0, depth).join(sep);
    for (const [marker, service] of SYNC_MARKERS) {
      if (await exists(join(directory, marker))) return service;
    }
  }
  return null;
}
