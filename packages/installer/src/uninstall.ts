import { lstat, mkdir, rename, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { backupStamp } from './backup.js';
import { installerEnvPath, sha256, unitStagingPath } from './configure.js';
import { EXIT_BLOCKED, EXIT_OK } from './exit.js';
import type { Host } from './host.js';
import { installerCommand } from './layout.js';
import { OBSIDIAN_CURATOR_TOKEN, OBSIDIAN_TOKEN, obsidianPluginDir } from './obsidian.js';
import { withSpinner, type Prompter } from './prompter.js';
import { curatorRevokeCommand, engineTokenCommand } from './public-access.js';
import { removeLaunchAgents } from './launchd.js';
import { plannedManager, plannedServicePath, removalCommands, serviceFileName } from './service-manager.js';
import { runRootCommands, ServicePausedError, unitRemovalCommands } from './services.js';
import { StateError, statePath, type InstallState } from './state.js';
import { shellCommand } from './text.js';
import { revokeCuratorTokens, revokeEngineTokens } from './tokens.js';
import { undoDeadline } from './undo.js';
import { CURATOR_UNIT, ENGINE_UNIT } from './units.js';

export interface UninstallDeps {
  host: Host;
  prompter: Prompter;
  /** Uninstall without asking (headless). */
  yes: boolean;
  /** Print the root commands for the user to run instead of running them with sudo. */
  sudo: boolean;
  now: Date;
}

/**
 * A service definition in systemd's folder or `~/Library/LaunchAgents`: one this
 * installation installed (`ours`, still as the installer wrote it), one it installed that
 * has changed since (`changed`), one it did not install (`foreign`), or none (`absent`).
 */
interface UnitCheck {
  unit: string;
  path: string;
  status: 'ours' | 'changed' | 'foreign' | 'absent';
}

/** A plugin token whose revoke failed: why, and the command that revokes it. */
interface Unrevoked {
  service: 'Engine' | 'Curator';
  reason: string;
  command: string;
}

/**
 * `vault-installer uninstall`: stop, disable, and remove the services this installation
 * installed, showing each root command, then move the installer's own files (its saved
 * progress and the configuration it wrote) aside, so a new install starts fresh. Only units
 * whose content matches what the installer recorded are removed; anything else stops the
 * run before it changes something. Once the services are removed, the tokens the installer
 * minted for the Obsidian plugin are revoked. The notes, the backup, the plugin folder, and
 * what the services keep are left, and the run ends by saying how to remove them.
 */
export async function runUninstall(deps: UninstallDeps, state: InstallState, dataDir: string): Promise<number> {
  const { host, prompter } = deps;
  const command = (name: string) => installerCommand(host, name, dataDir);
  prompter.intro('Vault Installer · uninstall');
  if (resolve(state.plan.data_dir) !== resolve(dataDir)) {
    prompter.outro(`${statePath(dataDir)} records an installation in ${state.plan.data_dir}, so its files are not where it says. Nothing was changed.`);
    return EXIT_BLOCKED;
  }

  const manager = plannedManager(state.plan.services);
  const units = await checkUnits(host, state);
  const changed = units.filter(check => check.status === 'changed');
  if (changed.length > 0) {
    prompter.outro([
      ...changed.map(check => `${check.path} changed after the installer wrote it (${unitStagingPath(dataDir, serviceFileName(manager, check.unit))}), so it may hold your own changes and is not removed.`),
      `Restore ${changed.length === 1 ? 'it' : 'them'} from the installer's copy, or remove ${changed.length === 1 ? 'it' : 'them'} yourself:`,
      ...removalCommands(manager, changed).map(line => `  ${line}`),
      `Then run \`${command('uninstall')}\` again. Nothing was changed.`,
    ].join('\n'));
    return EXIT_BLOCKED;
  }
  const removingChecks = units.filter(check => check.status === 'ours');
  const removing = removingChecks.map(check => check.unit);
  const files = await installerFiles(state, dataDir);
  const aside = join(dataDir, `uninstalled-${backupStamp(deps.now)}`);
  const plugin = addedPlugin(state);

  prompter.note([
    removing.length > 0
      ? `Stops and removes the services this installation set up: ${removing.join(', ')}. The ${manager === 'launchd' ? '' : 'root '}commands, each shown again as it runs:`
      : 'No service this installation set up is installed.',
    ...removalCommands(manager, removingChecks).map(line => `  ${line}`),
    ...units.filter(check => check.status === 'foreign').map(check => `${check.path} was not installed by this installation, so it stays.`),
    ...(plugin
      ? [`Then revokes the tokens the installer made for the Obsidian plugin${state.plan.curator ? ', on Engine and Curator' : ''}, so the plugin no longer connects. Its folder, ${plugin}, stays.`]
      : []),
    `Moves the installer's own files, its saved progress and the configuration with your keys and passwords, to ${aside}.`,
    `Keeps your notes, the backup, and everything else in ${dataDir}.`,
  ].join('\n'), 'Uninstall Vault');
  const undoUntil = undoDeadline(state);
  if (undoUntil !== null && deps.now.getTime() < undoUntil.getTime()) {
    prompter.warn(`Organizing your notes changed them. Until about ${undoUntil.toISOString()}, \`${command('undo')}\` can undo that, but only while Engine runs: run it before uninstalling. After that, the backup is the way back.`);
  }

  const approved = prompter.interactive
    ? await prompter.confirm({ message: 'Uninstall Vault? Your notes and the backup stay.', initialValue: false })
    : deps.yes;
  if (!approved) {
    prompter.outro(prompter.interactive ? 'Nothing was changed.' : 'Nothing was changed. Run again with --yes to uninstall.');
    return EXIT_OK;
  }

  try {
    if (manager === 'launchd') await removeLaunchAgents(host, prompter, removingChecks);
    else await runRootCommands({ host, prompter, sudo: deps.sudo, command: 'uninstall', dataDir }, unitRemovalCommands(removing), 'stop and remove the Vault services');
  } catch (error) {
    if (!(error instanceof ServicePausedError)) throw error;
    prompter.outro(`${error.message} Nothing else was changed.`);
    return EXIT_BLOCKED;
  }
  const remaining = (await checkUnits(host, state)).filter(check => removing.includes(check.unit) && check.status !== 'absent');
  if (remaining.length > 0) {
    prompter.outro(`${remaining.map(check => check.path).join(' and ')} ${remaining.length === 1 ? 'is' : 'are'} still installed, so nothing else was changed. Remove ${remaining.length === 1 ? 'it' : 'them'} and run \`${command('uninstall')}\` again.`);
    return EXIT_BLOCKED;
  }

  const unrevoked = plugin ? await revokePluginTokens(host, prompter, state.plan) : [];
  await moveAside(files, dataDir, aside, command('uninstall'));
  prompter.note((await leftBehind(host, state, dataDir, aside, units, { plugin, unrevoked })).join('\n'), 'What is left');
  prompter.outro(`Vault is uninstalled. Once you have removed what you no longer need from the list above, \`${command('install')}\` can install it again.`);
  return EXIT_OK;
}

async function checkUnits(host: Host, state: InstallState): Promise<UnitCheck[]> {
  const { plan, stages } = state;
  const candidates = [
    { unit: CURATOR_UNIT, installed: Boolean(plan.curator && stages.curator) },
    { unit: ENGINE_UNIT, installed: Boolean(stages.engine) },
  ];
  const checks: UnitCheck[] = [];
  const manager = plannedManager(plan.services);
  for (const { unit, installed } of candidates) {
    const path = plannedServicePath(plan.services, unit);
    const content = await host.readText(path);
    // The definition the installer staged, as configure recorded it.
    const recorded = stages.configure?.files[unitStagingPath(plan.data_dir, serviceFileName(manager, unit))];
    const status = content === null ? 'absent'
      : !installed || recorded === undefined ? 'foreign'
        : sha256(content) === recorded ? 'ours' : 'changed';
    checks.push({ unit, path, status });
  }
  return checks;
}

/**
 * The Obsidian plugin folder the installer wrote, or null. Only the saved progress says so:
 * `installed`, or `installing` when a run stopped while adding it. A plugin folder that was
 * kept, declined, or added by the user is never named or touched.
 */
function addedPlugin(state: InstallState): string | null {
  const outcome = state.stages.handoff?.obsidian_plugin;
  const vault = state.plan.vault?.path;
  return vault && (outcome === 'installed' || outcome === 'installing') ? obsidianPluginDir(vault) : null;
}

/**
 * Revoke the `obsidian` tokens the installer minted for the plugin, with each service's own
 * script (`--revoke`), as the handoff revokes the installer's own. The scripts write each
 * service's database directly, so they work with the services stopped, and revoking again
 * changes nothing. A failure does not stop the uninstall: it returns the command instead.
 */
async function revokePluginTokens(host: Host, prompter: Prompter, plan: InstallState['plan']): Promise<Unrevoked[]> {
  const script = { host, nodePath: plan.services.node_path, repoRoot: plan.repo_root };
  const revokes: Array<{ service: Unrevoked['service']; command: string; revoke: () => Promise<void> }> = [{
    service: 'Engine',
    command: engineTokenCommand(plan, OBSIDIAN_TOKEN.name, true),
    revoke: () => revokeEngineTokens({ ...script, vaultPath: plan.vault?.path ?? '', dbPath: plan.review.engine_database ?? '', name: OBSIDIAN_TOKEN.name }),
  }];
  if (plan.curator) {
    revokes.push({
      service: 'Curator',
      command: curatorRevokeCommand(plan, OBSIDIAN_CURATOR_TOKEN.name),
      revoke: () => revokeCuratorTokens({ ...script, dbPath: join(plan.data_dir, 'curator.db'), name: OBSIDIAN_CURATOR_TOKEN.name }),
    });
  }
  return withSpinner(prompter, 'Revoking the Obsidian plugin\'s tokens…', async () => {
    const failed: Unrevoked[] = [];
    for (const { service, command, revoke } of revokes) {
      try {
        await revoke();
      } catch (error) {
        failed.push({ service, reason: (error as Error).message, command });
      }
    }
    return failed;
  }, failed => failed.length === 0
    ? 'Revoked the Obsidian plugin\'s tokens.'
    : `Could not revoke the Obsidian plugin's token on ${failed.map(token => token.service).join(' and ')}; the list below says how.`);
}

/** The installer's files that exist, each inside the data directory; the state file last. */
async function installerFiles(state: InstallState, dataDir: string): Promise<string[]> {
  const candidates = [...Object.keys(state.stages.configure?.files ?? {}), installerEnvPath(dataDir), statePath(dataDir)];
  const outside = candidates.find(path => {
    const inside = relative(dataDir, path);
    return inside === '' || inside.startsWith('..') || isAbsolute(inside);
  });
  if (outside !== undefined) throw new StateError(`the saved state names a file outside ${dataDir}: ${outside}`);
  const found: string[] = [];
  for (const path of new Set(candidates)) {
    if (await exists(path)) found.push(path);
  }
  return [...found.filter(path => path !== statePath(dataDir)), statePath(dataDir)];
}

/** Move each file to the same place under `aside`, never over another file. */
async function moveAside(files: readonly string[], dataDir: string, aside: string, again: string): Promise<void> {
  for (const file of files) {
    const target = join(aside, relative(dataDir, file));
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      if (await exists(target)) throw new Error(`${target} already exists`);
      await rename(file, target);
    } catch (error) {
      throw new StateError(`could not move ${file} to ${target}: ${(error as Error).message}. Run \`${again}\` again once that is fixed.`);
    }
  }
  // The folder the units were staged in, once empty.
  await rmdir(join(dataDir, 'installer', 'units')).catch(() => {});
}

/** What the uninstall left, each with how to remove it. */
async function leftBehind(
  host: Host,
  state: InstallState,
  dataDir: string,
  aside: string,
  units: readonly UnitCheck[],
  obsidian: { plugin: string | null; unrevoked: readonly Unrevoked[] },
): Promise<string[]> {
  const { plan, stages } = state;
  const vault = plan.vault?.path;
  const lines: string[] = [];
  if (vault) {
    lines.push(stages.adopt && stages.adopt.operations.length > 0
      ? `- Your notes in ${vault}, with the changes organizing made.`
      : `- Your notes in ${vault}.`);
  }
  const backup = stages.backup?.completed_at ? stages.backup.directory : null;
  if (backup && vault) {
    const copy = join(backup, 'vault');
    lines.push(`- The backup of your notes from before installing: ${copy}. To put them back: ${shellCommand(['cp', '-a', `${copy}/.`, `${vault}/`])} (this replaces every note changed since, by you as well).`);
  }
  lines.push(`- The installer's files, with your keys and passwords: ${aside}. Remove them with: ${shellCommand(['rm', '-rf', aside])}`);
  const database = plan.review.engine_database;
  const engineFolder = vault ? join(vault, '.vault-engine') : null;
  const inEngineFolder = engineFolder !== null && database !== null && !relative(engineFolder, database).startsWith('..');
  if (engineFolder && await host.pathExists(engineFolder)) {
    lines.push(`- Engine's folder in your notes, ${engineFolder}${inEngineFolder ? ', with its database and search model' : ''}. A new install into ${vault} refuses while it is there. Remove it with: ${shellCommand(['rm', '-rf', engineFolder])}`);
  }
  if (database && !inEngineFolder && await host.pathExists(database)) {
    lines.push(`- Engine's database: ${database}. A new install with this data directory would use it again. Remove it with: ${shellCommand(['rm', '-f', database, `${database}-wal`, `${database}-shm`])}`);
  }
  const models = plan.review.engine_models_dir;
  if (models && await host.pathExists(models)) {
    lines.push(`- Engine's search model: ${models}. A new install reuses it. Remove it with: ${shellCommand(['rm', '-rf', models])}`);
  }
  const curatorDatabase = join(dataDir, 'curator.db');
  if (await host.pathExists(curatorDatabase)) {
    lines.push(`- Curator's database: ${curatorDatabase}. A new install with this data directory would use it again. Remove it with: ${shellCommand(['rm', '-f', curatorDatabase, `${curatorDatabase}-wal`, `${curatorDatabase}-shm`])}`);
  }
  if (vault && plan.vault && await host.pathExists(join(vault, plan.vault.settings_dir))) {
    lines.push(`- Engine's settings notes in ${join(vault, plan.vault.settings_dir)}. A new install that keeps its settings in the same folder starts from them.`);
  }
  if (obsidian.plugin && await host.pathExists(obsidian.plugin)) {
    lines.push(`- The Vault Engine plugin the installer added to Obsidian, in ${obsidian.plugin}${obsidian.unrevoked.length === 0 ? ', with its tokens revoked' : ''}. To remove it, uninstall it in Obsidian (Settings → Community plugins), or delete its folder: ${shellCommand(['rm', '-rf', obsidian.plugin])}`);
  }
  for (const token of obsidian.unrevoked) {
    lines.push(`- The Obsidian plugin's token on ${token.service}, which could not be revoked (${token.reason}). Revoke it with: ${token.command}`);
  }
  for (const check of units) {
    if (check.status === 'foreign') {
      lines.push(`- ${check.path}, which this installation did not install. A new install refuses while it is there.`);
    } else if (check.status === 'ours' && plannedManager(plan.services) === 'systemd' && await host.pathExists(`${check.path}.d`)) {
      lines.push(`- ${check.path}.d, overrides made for the removed unit. Remove it with: ${shellCommand(['sudo', 'rm', '-r', `${check.path}.d`])}`);
    }
  }
  return lines;
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
