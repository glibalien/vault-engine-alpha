import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Host } from './host.js';
import { shellCommand } from './text.js';

/** Conventional ports from the reference deployment. */
export const ENGINE_PORT = 3334;
export const CURATOR_PORT = 3335;

/** Engine's settings folder unless the vault already uses that name. */
export const DEFAULT_SETTINGS_DIR = 'Settings';
/** Where Engine writes wiki pages (the vault map's wikiDir default) and Curator its journal. */
export const DEFAULT_WIKI_DIR = 'Wikis';
/** The folder offered for Curator's topic notes (the vault map's topicDir). */
export const DEFAULT_TOPIC_DIR = 'Topics';

export function defaultDataDir(homeDir: string): string {
  return join(homeDir, 'vault-suite-data');
}

/**
 * install.sh sets this to its own path. The `vault-installer` bin exists only inside the
 * workspace, so messages name the script instead.
 */
export const INSTALLER_COMMAND_VAR = 'VAULT_INSTALLER_COMMAND';

/**
 * install.sh moves into the checkout to build, so it sets this to the folder it was run
 * from; relative paths and the vault folder's starting suggestion mean that folder.
 */
export const INSTALLER_CWD_VAR = 'VAULT_INSTALLER_CWD';

/** Whether `path` is `folder` or inside it (both absolute). */
export function isWithin(path: string, folder: string): boolean {
  const relativePath = relative(folder, path);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

/**
 * A command line that runs the installer's `command` the way this run was started:
 * install.sh's path when it started the installer, otherwise `node <path>/dist/cli.js`.
 * A data directory other than the default is passed along, since the saved install
 * lives there.
 */
export function installerCommand(host: Pick<Host, 'env' | 'homeDir'>, command: string, dataDir?: string): string {
  const script = host.env(INSTALLER_COMMAND_VAR);
  // The built entrypoint, also when this run is from source (`tsx src/cli.ts`).
  const program = script ? [script] : ['node', fileURLToPath(new URL('../dist/cli.js', import.meta.url))];
  const otherDataDir = dataDir !== undefined && resolve(dataDir) !== defaultDataDir(host.homeDir);
  return shellCommand([...program, command, ...(otherDataDir ? ['--data-dir', dataDir] : [])]);
}

/** The monorepo checkout this installer runs from (`packages/installer/{src,dist}/…`). */
export function repoRootFromModule(moduleUrl: string): string {
  return resolve(fileURLToPath(new URL('.', moduleUrl)), '..', '..', '..');
}

/** The Node.js major version the services must run on, from the checkout's `.nvmrc`. */
export async function requiredNodeMajor(repoRoot: string): Promise<number | null> {
  try {
    const pinned = (await readFile(join(repoRoot, '.nvmrc'), 'utf8')).trim().replace(/^v/, '');
    const major = Number.parseInt(pinned, 10);
    return Number.isInteger(major) ? major : null;
  } catch {
    return null;
  }
}

/** Expand a leading `~` and resolve relative paths against `cwd`. */
export function resolveUserPath(input: string, homeDir: string, cwd: string): string {
  const trimmed = input.trim();
  const expanded = trimmed === '~'
    ? homeDir
    : trimmed.startsWith('~/') ? join(homeDir, trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}
