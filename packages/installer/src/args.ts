import { CURATOR_PORT, ENGINE_PORT } from './layout.js';

interface CommonArgs {
  answers?: string;
  dataDir?: string;
  repo?: string;
  checkNetwork: boolean;
  enginePort?: number;
  curatorPort?: number;
}

export interface PlanArgs extends CommonArgs {
  command: 'plan';
  json: boolean;
  out?: string;
}

export interface InstallArgs extends CommonArgs {
  command: 'install';
  /** Approve the review (or continue a saved install) without asking. */
  yes: boolean;
  /** Print the root commands for the user to run instead of running them with sudo. */
  sudo: boolean;
}

export interface StatusArgs {
  command: 'status';
  dataDir?: string;
}

export interface UndoArgs {
  command: 'undo';
  dataDir?: string;
  /** Undo without asking (headless). */
  yes: boolean;
}

export interface UninstallArgs {
  command: 'uninstall';
  dataDir?: string;
  /** Uninstall without asking (headless). */
  yes: boolean;
  /** Print the root commands for the user to run instead of running them with sudo. */
  sudo: boolean;
}

export type CliArgs = PlanArgs | InstallArgs | StatusArgs | UndoArgs | UninstallArgs | { command: 'help' } | { command: 'version' };

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export const USAGE = `Usage: vault-installer <plan|install|status|undo|uninstall> [options]

Commands:
  plan                   Inspect this machine and a folder of Markdown, and report
                         what installing Vault Engine and Vault Curator would do.
                         Nothing is changed.
  install                Ask the same questions, show the review, and after your
                         approval write the configuration, back up the vault, and
                         start Engine. Run it again to continue an install that
                         stopped.
  status                 Check an installation's health with free, read-only
                         requests (only --data-dir applies).
  undo                   Undo the changes organizing made to your notes, through
                         Engine, within 24 hours of organizing (--data-dir, --yes).
  uninstall              Stop and remove the services and set the installer's
                         files aside; your notes and the backup stay
                         (--data-dir, --yes, --no-sudo).

Options:
  --answers <file>       Answer every question from a JSON answers file (headless)
  --yes                  install, undo, uninstall: go ahead without asking (headless)
  --no-sudo              install, uninstall: print the root commands for you to run instead
  --json                 plan: print the plan as JSON on stdout (requires --answers)
  --out <file>           plan: also write the plan as JSON to <file>
  --data-dir <dir>       Where the services keep their state (default ~/vault-suite-data)
  --repo <dir>           Vault Suite checkout to use (default: the one this runs from)
  --engine-port <port>   Port for Engine (default 3334)
  --curator-port <port>  Port for Curator (default 3335)
  --skip-network-check   Do not probe Hugging Face or check provider keys
  -h, --help             Show this help
  --version              Show the installer version`;

const VALUE_FLAGS = new Set(['--answers', '--out', '--data-dir', '--repo', '--engine-port', '--curator-port']);
const PLAN_ONLY = new Set(['--json', '--out']);
const INSTALL_ONLY = new Set(['--yes', '--no-sudo']);

export function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) return { command: 'help' };
  if (argv.includes('--version')) return { command: 'version' };

  const [command, ...rest] = argv;
  if (command === 'status') return parseStatusArgs(rest);
  if (command === 'undo' || command === 'uninstall') return parseRemovalArgs(command, rest);
  if (command !== 'plan' && command !== 'install') throw new UsageError(`unknown command: ${command}`);

  const common: CommonArgs = { checkNetwork: true };
  let json = false;
  let yes = false;
  let sudo = true;
  let out: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index] as string;
    if (seen.has(flag)) throw new UsageError(`duplicate option: ${flag}`);
    seen.add(flag);
    if ((command === 'plan' && INSTALL_ONLY.has(flag)) || (command === 'install' && PLAN_ONLY.has(flag))) {
      throw new UsageError(`${flag} is not an option of ${command}`);
    }
    if (flag === '--json') {
      json = true;
    } else if (flag === '--yes') {
      yes = true;
    } else if (flag === '--no-sudo') {
      sudo = false;
    } else if (flag === '--skip-network-check') {
      common.checkNetwork = false;
    } else if (VALUE_FLAGS.has(flag)) {
      const value = rest[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`missing value for ${flag}`);
      index++;
      if (flag === '--answers') common.answers = value;
      else if (flag === '--out') out = value;
      else if (flag === '--data-dir') common.dataDir = value;
      else if (flag === '--repo') common.repo = value;
      else if (flag === '--engine-port') common.enginePort = parsePort(flag, value);
      else common.curatorPort = parsePort(flag, value);
    } else {
      throw new UsageError(`unknown option: ${flag}`);
    }
  }
  if ((common.enginePort ?? ENGINE_PORT) === (common.curatorPort ?? CURATOR_PORT)) {
    throw new UsageError('Engine and Curator need different ports');
  }
  if (command === 'install') return { command, ...common, yes, sudo };
  if (json && common.answers === undefined) {
    throw new UsageError('--json needs --answers, because questions cannot be asked while JSON is printed');
  }
  return { command, ...common, json, ...(out !== undefined ? { out } : {}) };
}

function parseStatusArgs(rest: string[]): StatusArgs {
  if (rest.length === 0) return { command: 'status' };
  const [flag, value, ...extra] = rest;
  if (flag !== '--data-dir') throw new UsageError(`${flag} is not an option of status`);
  if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError('missing value for --data-dir');
  if (extra.length > 0) throw new UsageError(`unknown option: ${extra[0]}`);
  return { command: 'status', dataDir: value };
}

/** `undo` takes --data-dir and --yes; `uninstall` also --no-sudo. */
function parseRemovalArgs(command: 'undo' | 'uninstall', rest: string[]): UndoArgs | UninstallArgs {
  let dataDir: string | undefined;
  let yes = false;
  let sudo = true;
  const seen = new Set<string>();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index] as string;
    if (seen.has(flag)) throw new UsageError(`duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--yes') {
      yes = true;
    } else if (flag === '--no-sudo' && command === 'uninstall') {
      sudo = false;
    } else if (flag === '--data-dir') {
      const value = rest[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError('missing value for --data-dir');
      index++;
      dataDir = value;
    } else {
      throw new UsageError(`${flag} is not an option of ${command}`);
    }
  }
  const common = { ...(dataDir !== undefined ? { dataDir } : {}), yes };
  return command === 'undo' ? { command, ...common } : { command, ...common, sudo };
}

function parsePort(flag: string, value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) throw new UsageError(`${flag} must be a port number, 1 to 65535`);
  return port;
}
