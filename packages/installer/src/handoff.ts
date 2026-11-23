import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { engineEnvPath, curatorEnvPath, installerEnvPath, replaceFile } from './configure.js';
import type { Host } from './host.js';
import { installerCommand } from './layout.js';
import {
  buildPlugin,
  installObsidianPlugin,
  obsidianPluginDir,
  pluginPackageDir,
  pluginUrls,
  type ObsidianPluginOutcome,
} from './obsidian.js';
import { withSpinner, type Prompter } from './prompter.js';
import { engineTokenCommand, publicAccessGuide } from './public-access.js';
import { dollars } from './review.js';
import { SORTING_COMMAND, SORTING_REQUEST, unsortedNotes, unsortedWords, type UnsortedNotes } from './sorting.js';
import { saveState, type InstallState } from './state.js';
import { shellCommand } from './text.js';
import { INSTALLER_TOKEN, revokeCuratorTokens, revokeEngineTokens } from './tokens.js';

export interface HandoffDeps {
  host: Host;
  prompter: Prompter;
  now: () => Date;
}

/** Where the public-access guide goes. */
export function publicAccessPath(dataDir: string): string {
  return join(dataDir, 'PUBLIC-ACCESS.md');
}

/**
 * Stage 13. Write the public-access guide, add the Obsidian plugin when asked, revoke the
 * installer's own tokens on both services (with their own scripts), and show how to
 * connect something and what to try first. Each step repeats safely.
 */
export async function runHandoffStage(deps: HandoffDeps, state: InstallState, path: string): Promise<void> {
  if (state.stages.handoff?.completed_at) return;
  const plan = state.plan;
  state.stages.handoff ??= { started_at: deps.now().toISOString(), completed_at: null };
  await saveState(path, state);

  const guide = publicAccessPath(plan.data_dir);
  await replaceFile(guide, publicAccessGuide(plan, deps.now()));
  await connectObsidian(deps, state, path);
  await revokeInstallerTokens(deps.host, plan);

  const handoff = state.stages.handoff;
  handoff.completed_at = deps.now().toISOString();
  await saveState(path, state);
  deps.prompter.note(connectSomething(plan, handoff.obsidian_plugin).join('\n'), 'Connect something');
  const status = installerCommand(deps.host, 'status', plan.data_dir);
  // Verification's own search check: anything but a pass means the index is not ready.
  const searchReady = state.stages.verify?.checks.find(check => check.id === 'search')?.status === 'pass';
  deps.prompter.note(firstThingToTry(plan, handoff.obsidian_plugin === 'installed', { status, searchReady }).join('\n'), 'First thing to try');
  deps.prompter.note(nextSteps(plan, guide, status).join('\n'), 'Next steps');
}

/**
 * Revoke every token the installer minted for itself: Engine's (it lasts a day) and
 * Curator's read-only ones. Its saved Engine token goes too. `vault-installer status`
 * mints new ones when it runs, and revokes them again.
 */
export async function revokeInstallerTokens(host: Host, plan: InstallState['plan']): Promise<void> {
  const script = { host, nodePath: plan.services.node_path, repoRoot: plan.repo_root };
  await revokeEngineTokens({ ...script, vaultPath: plan.vault?.path ?? '', dbPath: plan.review.engine_database ?? '', name: INSTALLER_TOKEN.name });
  if (plan.curator) await revokeCuratorTokens({ ...script, dbPath: join(plan.data_dir, 'curator.db'), name: INSTALLER_TOKEN.name });
  await rm(installerEnvPath(plan.data_dir), { force: true });
}

/**
 * In an Obsidian vault, add the Vault Engine plugin, connected, when the user agrees (the
 * answers file decides headless; no by default). A plugin folder already there is replaced
 * only when an interactive user says so. The choice is saved before the folder is
 * written, so a rerun after an interruption finishes it without asking again.
 */
async function connectObsidian(deps: HandoffDeps, state: InstallState, path: string): Promise<void> {
  const plan = state.plan;
  const handoff = state.stages.handoff as NonNullable<InstallState['stages']['handoff']>;
  if (!plan.vault?.obsidian) return;
  if (handoff.obsidian_plugin === undefined) {
    handoff.obsidian_plugin = await choosePlugin(deps, plan, obsidianPluginDir(plan.vault.path));
    await saveState(path, state);
  }
  if (handoff.obsidian_plugin !== 'installing') return;

  const { host, prompter } = deps;
  // Built every time, never taken as found: a bundle an earlier build left in the checkout
  // (or one copied in with it) predates any later pull, and nothing in it shows its age.
  const failure = await withSpinner(prompter, 'Building the Obsidian plugin…', () => buildPlugin(host, plan.repo_root),
    problem => problem ? 'The Obsidian plugin could not be built.' : 'Built the Obsidian plugin.');
  if (failure) {
    prompter.warn(`The Obsidian plugin was not added: its build failed (${failure}).`);
    handoff.obsidian_plugin = 'not_built';
    await saveState(path, state);
    return;
  }
  await installObsidianPlugin(host, plan);
  handoff.obsidian_plugin = 'installed';
  await saveState(path, state);
}

async function choosePlugin(deps: HandoffDeps, plan: InstallState['plan'], dir: string): Promise<ObsidianPluginOutcome> {
  const { host, prompter } = deps;
  // Nobody can be asked on a headless run of an interactive plan, so the plugin stays out.
  const wanted = plan.obsidian_plugin ?? (prompter.interactive ? null : false);
  if (wanted === false) return 'declined';
  if (await host.pathExists(dir)) {
    if (!prompter.interactive) return 'kept';
    const replace = await prompter.confirm({
      message: `A Vault Engine plugin is already in ${dir}. Replace it with this version and connect it to this Engine? Its other settings are kept.`,
      initialValue: false,
    });
    return replace ? 'installing' : 'kept';
  }
  if (wanted) return 'installing';
  const add = await prompter.confirm({
    message: 'Add the Vault Engine plugin to this Obsidian vault, already connected to Engine?',
    initialValue: true,
  });
  return add ? 'installing' : 'declined';
}

/** The command that prints the owner password in an env file, and nothing else. */
export function ownerPasswordCommand(envFile: string): string {
  return `sed -n 's/^OAUTH_OWNER_PASSWORD=//p' ${shellCommand([envFile])}`;
}

/**
 * Connect something: the Obsidian plugin, and an AI client on this computer. Claude Code
 * signs in to each service with OAuth at its `localhost` address (the issuer the install
 * configured), with the service's owner password.
 */
function connectSomething(plan: InstallState['plan'], plugin: ObsidianPluginOutcome | undefined): string[] {
  const engine = `http://localhost:${plan.services.engine_port}/mcp`;
  const curator = plan.curator ? `http://localhost:${plan.services.curator_port}/mcp` : null;
  return [
    ...obsidianLines(plan, plugin),
    'An AI client on this computer: Claude Code signs in to each service with its owner password. Paste:',
    `  claude mcp add --transport http --scope user vault-engine ${engine}`,
    '  claude mcp login vault-engine',
    ...(curator ? [`  claude mcp add --transport http --scope user vault-curator ${curator}`, '  claude mcp login vault-curator'] : []),
    `Each login opens a sign-in page in your browser (inside Claude Code, /mcp does the same). The owner password${curator ? 's are' : ' is'} what this shows:`,
    `  ${ownerPasswordCommand(engineEnvPath(plan.data_dir))}${curator ? '    # Engine' : ''}`,
    ...(curator ? [`  ${ownerPasswordCommand(curatorEnvPath(plan.data_dir))}    # Curator`] : []),
    'Another MCP client that signs in with OAuth uses the same address and password. Keep localhost in the address: 127.0.0.1 does not sign in.',
  ];
}

function obsidianLines(plan: InstallState['plan'], plugin: ObsidianPluginOutcome | undefined): string[] {
  if (!plan.vault?.obsidian || plugin === undefined) return [];
  const dir = obsidianPluginDir(plan.vault.path);
  const readme = join(pluginPackageDir(plan.repo_root), 'README.md');
  switch (plugin) {
    case 'installed':
      return [
        `Obsidian: the Vault Engine plugin is in ${dir}, connected to Engine${plan.curator ? ' and Curator' : ''}.`,
        '  In Obsidian, open Settings → Community plugins. Turn on community plugins if it asks, then turn on Vault Engine.',
        '  If Obsidian was already open, reload the installed plugins first (or restart Obsidian).',
        '  To check the connection, run "Vault Engine: Ping engine (vault-stats)" from the command palette.',
        '  Chat in Obsidian also needs a model key, in Settings → Vault Engine.',
        `  The plugin's tokens are in ${join(dir, 'data.json')}, which only you can read. Anything that syncs .obsidian copies them.`,
        '',
      ];
    case 'kept':
      return [
        `Obsidian: a Vault Engine plugin was already in ${dir}, so it was left as it is.`,
        `  To connect it, set its Engine URL to ${pluginUrls(plan).engineUrl} and its Bearer token to the token this prints once:`,
        `  ${engineTokenCommand(plan, 'obsidian')}`,
        '',
      ];
    case 'not_built':
      return [
        `Obsidian: the plugin could not be built, so it was not added. Run \`npm run build -w vault-obsidian\` in ${plan.repo_root} to see why; ${readme} says how to add it.`,
        '',
      ];
    case 'declined':
    case 'installing':
      return [`Obsidian: the Vault Engine plugin was not added. ${readme} says how to add it.`, ''];
  }
}

/**
 * What to try first. Sorting the notes that got no kind leads when they are a quarter of the
 * vault or more, and at least ten (#650); otherwise it is one line after the suggestion that follows the
 * vocabulary map: a project wiki only when a project kind holds notes, otherwise a topic
 * wiki; with no Curator, a search.
 *
 * `search`: the status command, and whether the search index had finished when the install
 * was verified. Grouping similar notes needs it; the list of what is unsorted does not.
 */
export function firstThingToTry(
  plan: InstallState['plan'],
  pluginInstalled: boolean,
  search: { status: string; searchReady: boolean } = { status: 'vault-installer status', searchReady: true },
): string[] {
  const map = plan.vault_map ?? null;
  const unsorted = unsortedNotes(plan.structure);
  const project = map?.kinds.project;
  const settingsNote = `${plan.vault?.settings_dir ?? 'Settings'}/Vault.md`;
  const cost = plan.curator
    ? [`Its first build is a paid call that counts against Curator's daily cap (${dollars(plan.curator.daily_budget_cents)}).`]
    : [];
  const suggestion: string[] = [];
  if (plan.curator && project?.type && project.from === 'vault') {
    suggestion.push(
      `Start a wiki for one of your projects. Ask Claude Code: "Create a project wiki for <one of your ${project.type} notes>."`,
      ...(pluginInstalled ? [`Or, in Obsidian, open one of your ${project.type} notes and run "Vault Engine: Create project wiki".`] : []),
      ...cost,
    );
  } else if (plan.curator) {
    suggestion.push(
      'Start a wiki about a topic. Ask Claude Code: "Make a topic wiki about <a subject your notes cover>."',
      ...(pluginInstalled ? ['Or, in Obsidian, open a note and run "Vault Engine: Create topic wiki from this note".'] : []),
      ...cost,
    );
  } else {
    suggestion.push(
      'Search your notes. Ask Claude Code: "Search my notes for <something you wrote about>."',
      ...(pluginInstalled ? ['Or, in Obsidian, run "Vault Engine: Search vault" from the command palette.'] : []),
    );
  }
  const lines: string[] = [];
  if (unsorted?.leads) {
    const [first = '', ...rest] = suggestion;
    lines.push(...sortingFirst(unsorted, search), '', `Then ${first.charAt(0).toLowerCase()}${first.slice(1)}`, ...rest);
  } else {
    lines.push(...suggestion);
    if (unsorted) lines.push('', `${unsortedWords(unsorted)}. To sort ${unsorted.untyped === 1 ? 'it' : 'them'}, ask Claude Code: "${SORTING_REQUEST}"`);
  }
  lines.push(
    '',
    `Which type of note is a project, task, meeting, person, or company is set in ${settingsNote} in your notes folder. Change it there, or ask an assistant connected to Engine to change it.`,
  );
  if (plan.vault?.obsidian && map && map.kinds.task.type === null) {
    lines.push(`No task kind is set, so the Vault Engine plugin hides its task views (the Kanban and List presets in Boards). To set one later, give taskType (and taskStatusField) a value in ${settingsNote}.`);
  }
  return lines;
}

/** Sorting as the first thing to try: the count, the request that starts it, and what it does. */
function sortingFirst(unsorted: UnsortedNotes, search: { status: string; searchReady: boolean }): string[] {
  return [
    `${unsortedWords(unsorted)} yet, so start by sorting them. Ask Claude Code: "${SORTING_REQUEST}"`,
    `Or type ${SORTING_COMMAND} there, which starts the same session.`,
    'It lists what is left to sort, largest first, and works through it with you: it groups similar notes, proposes a kind for each group, and changes nothing until you agree.',
    'Vault makes no paid calls for this, and each change can be undone for a day.',
    ...(search.searchReady
      ? []
      : [`Grouping similar notes needs the search index, which was not ready when this install was checked: \`${search.status}\` shows when it is, and then what the notes with no kind have in common.`]),
  ];
}

function nextSteps(plan: InstallState['plan'], guide: string, status: string): string[] {
  const engine = `http://localhost:${plan.services.engine_port}/mcp`;
  return [
    `Engine: ${engine}${plan.curator ? `; Curator: http://localhost:${plan.services.curator_port}/mcp` : ''}.`,
    `To reach the services from the internet, for Claude.ai, a phone, or another computer, follow ${guide}. Nothing was exposed.`,
    `\`${status}\` checks the installation at any time. The installer's own tokens are revoked.`,
  ];
}
