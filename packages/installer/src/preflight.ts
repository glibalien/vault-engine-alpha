import { join } from 'node:path';
import type { Host } from './host.js';
import { serviceDirFor, serviceFileName, serviceManagerFor, type ServiceManager } from './service-manager.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  status: CheckStatus;
  title: string;
  detail: string;
}

export interface PreflightOptions {
  repoRoot: string;
  dataDir: string;
  requiredNodeMajor: number | null;
  enginePort: number;
  curatorPort: number;
  /** Skip the Hugging Face reachability probe (offline tests, air-gapped dry runs). */
  checkNetwork: boolean;
}

const GIB = 1024 ** 3;
const MIN_MEMORY_BYTES = 3 * GIB;
const MIN_DISK_BYTES = 2 * GIB;
const MODEL_HOST = 'https://huggingface.co';
const EXISTING_UNITS = ['vault-engine.service', 'vault-engine-new.service', 'vault-curator.service'];
const EXISTING_AGENTS = ['vault-engine.service', 'vault-curator.service'];

/**
 * Stage 1. Read-only checks that the machine can host both services. A failure means
 * installing here would not work; a warning means it would work with a caveat.
 */
export async function runPreflight(host: Host, options: PreflightOptions): Promise<CheckResult[]> {
  const manager = serviceManagerFor(host.platform);
  const existing = await existingInstall(host, manager, options.dataDir);
  return [
    checkPlatform(host),
    checkUser(host, manager),
    checkNode(host, options.requiredNodeMajor),
    ...manager === 'launchd'
      ? [await checkLaunchd(host)]
      : [await checkSystemd(host), await checkSudo(host)],
    await checkBuild(host, options.repoRoot),
    await checkStrayEnvFiles(host, options.repoRoot, options.dataDir),
    await checkMemory(host),
    await checkDisk(host, options.dataDir),
    await checkPorts(host, [options.enginePort, options.curatorPort], existing.length > 0),
    await checkNetwork(host, options.checkNetwork),
    existingInstallResult(existing),
  ];
}

export function hasFailures(checks: readonly CheckResult[]): boolean {
  return checks.some(check => check.status === 'fail');
}

function checkPlatform(host: Host): CheckResult {
  if (host.platform === 'linux') {
    return { id: 'platform', status: 'pass', title: 'Linux', detail: 'Vault Installer supports Linux with systemd.' };
  }
  if (host.platform === 'darwin') {
    // onnxruntime-node, which runs Engine's local search model, ships no Intel Mac build.
    return host.arch === 'arm64'
      ? { id: 'platform', status: 'pass', title: 'macOS (Apple Silicon)', detail: 'Vault Installer supports macOS on Apple Silicon with launchd.' }
      : {
          id: 'platform',
          status: 'fail',
          title: 'Intel Mac',
          detail: `Node.js here runs as ${host.arch}. Engine's local search model has no build for Intel Macs, so Vault Installer supports Apple Silicon Macs only. On an Apple Silicon Mac this means Node.js runs under Rosetta: install the arm64 Node.js and run the installer with it.`,
        };
  }
  return {
    id: 'platform',
    status: 'fail',
    title: 'Unsupported operating system',
    detail: `This is ${host.platform}. Vault Installer supports Linux with systemd and macOS on Apple Silicon.`,
  };
}

function checkUser(host: Host, manager: ServiceManager): CheckResult {
  return host.uid === 0
    ? {
        id: 'user',
        status: 'warn',
        title: 'Running as root',
        detail: manager === 'launchd'
          ? 'Run the installer as the user who will own the vault; the services run as that user, while they are logged in.'
          : 'Run the installer as the user who will own the vault and the services; it asks for sudo only when it installs them.',
      }
    : { id: 'user', status: 'pass', title: 'Regular user', detail: 'The services will run as this user.' };
}

function checkNode(host: Host, required: number | null): CheckResult {
  const major = Number.parseInt(host.nodeVersion, 10);
  if (required === null) {
    return {
      id: 'node',
      status: 'warn',
      title: `Node.js ${host.nodeVersion}`,
      detail: 'Could not read the pinned version from .nvmrc.',
    };
  }
  return major === required
    ? { id: 'node', status: 'pass', title: `Node.js ${host.nodeVersion}`, detail: `Matches the pinned Node.js ${required}.` }
    : {
        id: 'node',
        status: 'fail',
        title: `Node.js ${host.nodeVersion}`,
        detail: `The services must run on Node.js ${required} (pinned in .nvmrc); its native modules are built for that version. Install Node.js ${required} (for example with mise or nvm) and run the installer with it.`,
      };
}

async function checkSystemd(host: Host): Promise<CheckResult> {
  const [version, booted] = await Promise.all([
    host.run('systemctl', ['--version']),
    host.pathExists('/run/systemd/system'),
  ]);
  return version.code === 0 && booted
    ? { id: 'systemd', status: 'pass', title: 'systemd', detail: 'Services can be installed as systemd units.' }
    : {
        id: 'systemd',
        status: 'fail',
        title: 'systemd not available',
        detail: 'The installer runs Engine and Curator as systemd services, and this system is not running systemd.',
      };
}

/**
 * A launchd agent runs in the session of a user logged in at the Mac (`gui/<uid>`); over
 * SSH with nobody logged in, that session does not exist.
 */
async function checkLaunchd(host: Host): Promise<CheckResult> {
  const session = host.uid === null ? null : await host.run('launchctl', ['print', `gui/${host.uid}`]);
  return session?.code === 0
    ? {
        id: 'launchd',
        status: 'pass',
        title: 'launchd',
        detail: 'Services can be installed as launchd agents for this user: no sudo, and they start when you log in.',
      }
    : {
        id: 'launchd',
        status: 'fail',
        title: 'No login session',
        detail: 'The installer runs Engine and Curator as launchd agents in your login session, and this user is not logged in at the Mac. Log in at the Mac (or through Screen Sharing), then run the installer again.',
      };
}

async function checkSudo(host: Host): Promise<CheckResult> {
  const sudo = await host.run('sudo', ['--version']);
  return sudo.code === 0
    ? {
        id: 'sudo',
        status: 'pass',
        title: 'sudo',
        detail: 'Installing the services will show each sudo command and ask for your password.',
      }
    : {
        id: 'sudo',
        status: 'warn',
        title: 'sudo not found',
        detail: 'Without sudo, the installer prints the service commands for you to run as root (--no-sudo).',
      };
}

async function checkBuild(host: Host, repoRoot: string): Promise<CheckResult> {
  const analyzer = join(repoRoot, 'packages', 'engine', 'dist', 'analyzer', 'cli.js');
  return await host.pathExists(analyzer)
    ? { id: 'build', status: 'pass', title: 'Repository built', detail: `Using the checkout at ${repoRoot}.` }
    : {
        id: 'build',
        status: 'fail',
        title: 'Repository not built',
        detail: `Build the checkout at ${repoRoot} first: npm ci && npm run build.`,
      };
}

/**
 * Engine also reads `packages/engine/.env` next to its build, and Curator reads `.env` in
 * its working directory (the data directory). Either would add settings or keys the
 * installer did not choose, such as an extraction key that starts paid calls at boot.
 */
async function checkStrayEnvFiles(host: Host, repoRoot: string, dataDir: string): Promise<CheckResult> {
  const candidates = [join(repoRoot, 'packages', 'engine', '.env'), join(dataDir, '.env')];
  const found: string[] = [];
  for (const path of candidates) {
    if (await host.pathExists(path)) found.push(path);
  }
  return found.length === 0
    ? { id: 'env-files', status: 'pass', title: 'No stray .env files', detail: 'The services will read only the env files the installer writes.' }
    : {
        id: 'env-files',
        status: 'fail',
        title: 'Stray .env file',
        detail: `The services would also read ${found.join(' and ')}, adding settings or keys outside this plan. Move ${found.length === 1 ? 'it' : 'them'} away first.`,
      };
}

async function checkMemory(host: Host): Promise<CheckResult> {
  const available = await host.memAvailableBytes();
  if (available === null) {
    return { id: 'memory', status: 'warn', title: 'Memory unknown', detail: 'Could not read available memory.' };
  }
  return available >= MIN_MEMORY_BYTES
    ? { id: 'memory', status: 'pass', title: `${formatGiB(available)} memory available`, detail: 'Enough for Engine and its local search model.' }
    : {
        id: 'memory',
        status: 'warn',
        title: `${formatGiB(available)} memory available`,
        detail: 'Engine\'s local search model needs about 1.5 GB while it indexes; 3 GB or more available is recommended.',
      };
}

async function checkDisk(host: Host, dataDir: string): Promise<CheckResult> {
  const free = await host.freeDiskBytes(dataDir);
  if (free === null) {
    return { id: 'disk', status: 'warn', title: 'Disk space unknown', detail: `Could not read free space for ${dataDir}.` };
  }
  return free >= MIN_DISK_BYTES
    ? { id: 'disk', status: 'pass', title: `${formatGiB(free)} free for ${dataDir}`, detail: 'Enough for service state and backups.' }
    : {
        id: 'disk',
        status: 'warn',
        title: `${formatGiB(free)} free for ${dataDir}`,
        detail: 'At least 2 GB free is recommended for service state, backups, and the search model.',
      };
}

async function checkPorts(host: Host, ports: number[], existingInstall: boolean): Promise<CheckResult> {
  const busy: number[] = [];
  for (const port of ports) {
    if (!(await host.isPortFree(port))) busy.push(port);
  }
  if (busy.length === 0) {
    return { id: 'ports', status: 'pass', title: `Ports ${ports.join(' and ')} free`, detail: 'Engine and Curator can listen on their usual ports.' };
  }
  return {
    id: 'ports',
    status: existingInstall ? 'warn' : 'fail',
    title: `Port ${busy.join(' and ')} in use`,
    detail: existingInstall
      ? 'Probably the existing Vault services; see the existing-installation check.'
      : 'Another program is listening there. Stop it, or choose other ports with --engine-port and --curator-port.',
  };
}

async function checkNetwork(host: Host, enabled: boolean): Promise<CheckResult> {
  if (!enabled) {
    return { id: 'network', status: 'warn', title: 'Network check skipped', detail: 'Engine downloads its local search model from Hugging Face on first start.' };
  }
  return await host.canReach(MODEL_HOST, 5000)
    ? { id: 'network', status: 'pass', title: 'Hugging Face reachable', detail: 'Engine can download its local search model on first start.' }
    : {
        id: 'network',
        status: 'warn',
        title: 'Hugging Face unreachable',
        detail: 'Engine downloads its local search model on first start. Without it, search stays off until the download succeeds.',
      };
}

async function existingInstall(host: Host, manager: ServiceManager, dataDir: string): Promise<string[]> {
  const services = manager === 'launchd' ? EXISTING_AGENTS : EXISTING_UNITS;
  const candidates = [
    ...services.map(unit => join(serviceDirFor(manager, host.homeDir), serviceFileName(manager, unit))),
    join(dataDir, 'installer', 'state.json'),
  ];
  const found: string[] = [];
  for (const path of candidates) {
    if (await host.pathExists(path)) found.push(path);
  }
  return found;
}

function existingInstallResult(found: string[]): CheckResult {
  return found.length === 0
    ? { id: 'existing', status: 'pass', title: 'No existing installation', detail: 'This would be a fresh install.' }
    : {
        id: 'existing',
        status: 'warn',
        title: 'Existing installation found',
        detail: `Found ${found.join(', ')}. This installer version plans fresh installs only; repair and upgrade come later.`,
      };
}

function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}
