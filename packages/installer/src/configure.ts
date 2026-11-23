import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DEFAULT_TYPE_KEY, typeKeyOf } from './analyzer.js';
import { renderEnvFile, type EnvEntry } from './env-file.js';
import { renderCuratorPlist, renderEnginePlist } from './launchd.js';
import { providerInfo, type ProviderKey } from './providers.js';
import type { PlanReport } from './report.js';
import { Secret } from './secret.js';
import { envDialect, plannedManager, serviceFileName } from './service-manager.js';
import { CURATOR_UNIT, ENGINE_UNIT, renderCuratorUnit, renderEngineUnit, type ServiceSpec } from './units.js';

export class ConfigureError extends Error {
  override readonly name = 'ConfigureError';
}

/** 32 random bytes, 43 characters: well above the runbook's bar for an owner password. */
export function generatePassword(): Secret {
  return new Secret(randomBytes(32).toString('base64url'));
}

export function engineEnvPath(dataDir: string): string {
  return join(dataDir, 'engine.env');
}

export function curatorEnvPath(dataDir: string): string {
  return join(dataDir, 'curator.env');
}

export function pendingKeysPath(dataDir: string): string {
  return join(dataDir, 'installer', 'pending-keys.env');
}

/** The installer's own Engine token; removed at handoff. */
export function installerEnvPath(dataDir: string): string {
  return join(dataDir, 'installer', 'installer.env');
}

/** Where configure stages a service's definition (`serviceFileName`) before it is installed. */
export function unitStagingPath(dataDir: string, fileName: string): string {
  return join(dataDir, 'installer', 'units', fileName);
}

/** engine.env's note on its seed-only variables, removed with them after the first start. */
export const SEED_ONLY_COMMENT = 'VAULT_EXCLUDE_DIRS and EXTRACTION_ENABLED apply on Engine\'s first start only; later changes go in its Engine settings note.';

/** Where files are written before being linked into place; nothing else lives there. */
function temporaryDir(dataDir: string): string {
  return join(dataDir, 'installer', 'tmp');
}

export interface ConfigurationFile {
  path: string;
  content: string;
  sha256: string;
}

/**
 * Stage 6, rendered: env files (with the held keys) and the service definitions staged
 * for installing: systemd units or launchd agents, with env files each one's reader
 * reads. Nothing is written, so a value an env file or definition cannot hold stops the
 * install before anything changes.
 */
export function prepareConfiguration(input: {
  plan: PlanReport;
  keys: readonly ProviderKey[];
  password?: () => Secret;
}): ConfigurationFile[] {
  const { plan, keys } = input;
  const password = input.password ?? generatePassword;
  const vault = plan.vault;
  if (!vault) throw new ConfigureError('the plan has no vault');
  const dataDir = plan.data_dir;
  const { services, review } = plan;
  const manager = plannedManager(services);
  const dialect = envDialect(manager);
  const staged = (unit: string) => unitStagingPath(dataDir, serviceFileName(manager, unit));
  const renderEngine = manager === 'launchd' ? renderEnginePlist : renderEngineUnit;
  const renderCurator = manager === 'launchd' ? renderCuratorPlist : renderCuratorUnit;

  const secretFor = (variable: string, side: 'engineEnv' | 'curatorEnv'): Secret => {
    const key = keys.find(candidate => providerInfo(candidate.provider)[side] === variable);
    if (!key) throw new ConfigureError(`no key was given for ${variable}`);
    return key.secret;
  };

  const exclusions = vault.exclusions;
  const comma = exclusions.find(directory => directory.includes(','));
  if (comma !== undefined) {
    throw new ConfigureError(`Engine reads its exclusions as a comma-separated list, so "${comma}" cannot be excluded.`);
  }
  const typeKey = plan.structure ? typeKeyOf(plan.structure.analyzer_spec) : DEFAULT_TYPE_KEY;
  const engineEnv: EnvEntry[] = [
    { name: 'VAULT_PATH', value: vault.path },
    { name: 'DB_PATH', value: review.engine_database ?? join(vault.path, '.vault-engine', 'vault.db') },
    { name: 'VAULT_SETTINGS_DIR', value: vault.settings_dir },
    // The notes' own type field holds their types (#445); `types`, Engine's default, is not written.
    ...(typeKey !== DEFAULT_TYPE_KEY ? [{ name: 'VAULT_TYPE_KEY', value: typeKey }] : []),
    ...(review.engine_models_dir !== null ? [{ name: 'EMBEDDER_MODELS_DIR', value: review.engine_models_dir }] : []),
    ...(exclusions.length > 0 ? [{ name: 'VAULT_EXCLUDE_DIRS', value: exclusions.join(',') }] : []),
    ...(review.extraction_seeded_off ? [{ name: 'EXTRACTION_ENABLED', value: 'false' }] : []),
    { name: 'OAUTH_OWNER_PASSWORD', value: password() },
    { name: 'OAUTH_ISSUER_URL', value: `http://localhost:${services.engine_port}` },
    { name: 'NODE_ENV', value: 'production' },
    ...review.env_keys.engine_first_boot.map(name => ({ name, value: secretFor(name, 'engineEnv') })),
  ];
  const held = review.env_keys.engine_after_extraction_off;
  const seedOnly = exclusions.length > 0 || review.extraction_seeded_off;

  const spec = (unit: string, port: number): ServiceSpec => ({
    unit,
    user: services.user,
    nodePath: services.node_path,
    repoRoot: plan.repo_root,
    dataDir,
    port,
  });
  const files: Array<{ path: string; content: string }> = [
    {
      path: engineEnvPath(dataDir),
      content: renderEnvFile([
        'Vault Engine, written by vault-installer. Keys and the owner password are secrets.',
        ...(seedOnly ? [SEED_ONLY_COMMENT] : []),
      ], engineEnv, dialect),
    },
    { path: staged(ENGINE_UNIT), content: renderEngine(spec(ENGINE_UNIT, services.engine_port)) },
  ];
  if (plan.curator) {
    files.push(
      {
        path: curatorEnvPath(dataDir),
        content: renderEnvFile([
          'Vault Curator, written by vault-installer. Keys and the owner password are secrets.',
          'ENGINE_TOKEN is added once Engine is running and has minted it.',
        ], [
          // Engine listens on IPv4 loopback only, and `localhost` can resolve to ::1 first.
          { name: 'ENGINE_URL', value: `http://127.0.0.1:${services.engine_port}` },
          { name: 'CURATOR_PORT', value: String(services.curator_port) },
          { name: 'CURATOR_DB_PATH', value: join(dataDir, 'curator.db') },
          { name: 'OAUTH_OWNER_PASSWORD', value: password() },
          { name: 'OAUTH_ISSUER_URL', value: `http://localhost:${services.curator_port}` },
          { name: 'NODE_ENV', value: 'production' },
          ...review.env_keys.curator.map(name => ({ name, value: secretFor(name, 'curatorEnv') })),
        ], dialect),
      },
      { path: staged(CURATOR_UNIT), content: renderCurator(spec(CURATOR_UNIT, services.curator_port)) },
    );
  }
  if (held.length > 0) {
    files.push({
      path: pendingKeysPath(dataDir),
      content: renderEnvFile([
        'Keys Engine does not have yet; vault-installer moves them into engine.env once Engine\'s extraction is off.',
      ], held.map(name => ({ name, value: secretFor(name, 'engineEnv') })), dialect),
    });
  }
  return files.map(file => ({ ...file, sha256: sha256(file.content) }));
}

/** Create the data directory's folders (0700) and refuse any file configure would replace. */
export async function prepareDataDir(dataDir: string, files: readonly ConfigurationFile[]): Promise<void> {
  for (const directory of [dataDir, join(dataDir, 'installer'), join(dataDir, 'installer', 'units')]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  for (const file of files) {
    if (await exists(file.path)) throw alreadyExists(file.path);
  }
}

/**
 * Stage 6, written. Each file appears whole or not at all: it is written under a
 * temporary name and linked into place, which never replaces an existing file. On
 * failure the files written so far are removed.
 */
export async function writeConfiguration(dataDir: string, files: readonly ConfigurationFile[]): Promise<void> {
  const written: string[] = [];
  try {
    await mkdir(temporaryDir(dataDir), { recursive: true, mode: 0o700 });
    for (const file of files) {
      await createExclusive(dataDir, file);
      written.push(file.path);
    }
  } catch (error) {
    await removeFiles(written);
    throw error;
  } finally {
    await rm(temporaryDir(dataDir), { recursive: true, force: true });
  }
}

/** The recorded files, by whether each still holds what configure wrote. */
export async function inspectConfiguration(files: Record<string, string>): Promise<{
  matching: string[];
  missing: string[];
  changed: string[];
}> {
  const result = { matching: [] as string[], missing: [] as string[], changed: [] as string[] };
  for (const [path, hash] of Object.entries(files)) {
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      result.missing.push(path);
      continue;
    }
    (sha256(content) === hash ? result.matching : result.changed).push(path);
  }
  return result;
}

/** Remove files configure wrote, and its temporary folder. */
export async function removeConfiguration(dataDir: string, paths: readonly string[]): Promise<void> {
  await removeFiles(paths);
  await rm(temporaryDir(dataDir), { recursive: true, force: true });
}

async function removeFiles(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(path => rm(path, { force: true })));
}

async function createExclusive(dataDir: string, file: ConfigurationFile): Promise<void> {
  const temporary = join(temporaryDir(dataDir), `${basename(file.path)}.${process.pid}.${randomBytes(4).toString('hex')}`);
  await writeFile(temporary, file.content, { mode: 0o600, flag: 'wx' });
  try {
    await link(temporary, file.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw alreadyExists(file.path);
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

function alreadyExists(path: string): ConfigureError {
  return new ConfigureError(`${path} already exists, perhaps from an earlier install. This installer version installs fresh only; move the file away and run it again.`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Replace a file in one step (a 0600 temporary file renamed over it), so a reader never
 * sees half of it. Returns the new content's SHA-256.
 */
export async function replaceFile(path: string, content: string): Promise<string> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return sha256(content);
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
