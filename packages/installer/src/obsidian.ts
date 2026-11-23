import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replaceFile } from './configure.js';
import type { Host } from './host.js';
import type { PlanReport } from './report.js';
import { mintCuratorToken, mintEngineToken } from './tokens.js';

/** The plugin's id in its manifest: Obsidian loads it from `.obsidian/plugins/<id>/`. */
export const OBSIDIAN_PLUGIN_ID = 'vault-engine';
/** What Obsidian loads, as `npm run build -w vault-obsidian` leaves it in the plugin's package. */
export const PLUGIN_BUNDLE = ['main.js', 'manifest.json', 'styles.css'] as const;
/** The plugin's own tokens: long-lived, like Curator's, and revoked by name. */
export const OBSIDIAN_TOKEN = { name: 'obsidian', ttlDays: 36500 } as const;
/** The scopes the plugin's wiki commands need. */
export const OBSIDIAN_CURATOR_TOKEN = { name: 'obsidian', ttlDays: 36500, scope: 'curate:read,curate:trigger' } as const;

/**
 * What became of the plugin at handoff. `installing` is saved before the plugin folder is
 * written, so a rerun knows the folder is the installer's own and finishes it.
 */
export type ObsidianPluginOutcome = 'installing' | 'installed' | 'declined' | 'kept' | 'not_built';

type Plan = Pick<PlanReport, 'repo_root' | 'data_dir' | 'services' | 'curator' | 'review' | 'vault'>;

export function obsidianPluginDir(vaultPath: string): string {
  return join(vaultPath, '.obsidian', 'plugins', OBSIDIAN_PLUGIN_ID);
}

export function pluginPackageDir(repoRoot: string): string {
  return join(repoRoot, 'packages', 'obsidian-plugin');
}

/** The addresses the plugin connects to: the services on this computer. */
export function pluginUrls(plan: Pick<PlanReport, 'services'>): { engineUrl: string; curatorUrl: string } {
  return {
    engineUrl: `http://localhost:${plan.services.engine_port}/mcp`,
    curatorUrl: `http://localhost:${plan.services.curator_port}/mcp`,
  };
}

export async function pluginBundleBuilt(host: Host, repoRoot: string): Promise<boolean> {
  const source = pluginPackageDir(repoRoot);
  return (await Promise.all(PLUGIN_BUNDLE.map(file => host.pathExists(join(source, file))))).every(Boolean);
}

/**
 * Build the plugin, which the root build leaves out, with npm on the installer's PATH (as
 * install.sh runs it). Returns why it could not be built, or null.
 */
export async function buildPlugin(host: Host, repoRoot: string): Promise<string | null> {
  const result = await host.run('npm', ['run', 'build', '-w', 'vault-obsidian'], { cwd: repoRoot, timeoutMs: 15 * 60_000 });
  if (result.code !== 0) {
    const tail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-3).join(' ').trim();
    return tail || (result.code === null ? 'npm could not be started' : `npm exited with ${result.code}`);
  }
  return await pluginBundleBuilt(host, repoRoot) ? null : 'the build left no plugin bundle';
}

/**
 * Put the built plugin into the vault and connect it: copy its bundle, mint its own Engine
 * token (and, with Curator, a Curator token with the scopes its wiki commands need), and
 * write the connection into its `data.json`, 0600. Settings already in a `data.json` the
 * user agreed to replace are kept, except an old Curator connection when this install has no
 * Curator: it would point the plugin at another installation's Curator. Each token goes only
 * into that file.
 */
export async function installObsidianPlugin(host: Host, plan: Plan): Promise<void> {
  if (!plan.vault) throw new Error('the saved plan has no vault');
  const target = obsidianPluginDir(plan.vault.path);
  await mkdir(target, { recursive: true });
  for (const file of PLUGIN_BUNDLE) await copyFile(join(pluginPackageDir(plan.repo_root), file), join(target, file));

  const script = { host, nodePath: plan.services.node_path, repoRoot: plan.repo_root };
  const token = await mintEngineToken({ ...script, vaultPath: plan.vault.path, dbPath: plan.review.engine_database ?? '', token: OBSIDIAN_TOKEN });
  const curatorToken = plan.curator
    ? await mintCuratorToken({ ...script, dbPath: join(plan.data_dir, 'curator.db'), token: OBSIDIAN_CURATOR_TOKEN })
    : null;
  const { engineUrl, curatorUrl } = pluginUrls(plan);
  const dataPath = join(target, 'data.json');
  const existing = await existingSettings(dataPath);
  if (!curatorToken) {
    // Back to the plugin's defaults, which leave Curator unconnected (no token).
    delete existing.curatorUrl;
    delete existing.curatorToken;
  }
  const settings = {
    ...existing,
    engineUrl,
    token: token.reveal(),
    ...(curatorToken ? { curatorUrl, curatorToken: curatorToken.reveal() } : {}),
  };
  await replaceFile(dataPath, `${JSON.stringify(settings, null, 2)}\n`);
}

/** The plugin's settings already in `data.json`, or none when there is no such object. */
async function existingSettings(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
