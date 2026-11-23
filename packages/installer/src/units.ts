import { join } from 'node:path';

export const ENGINE_UNIT = 'vault-engine.service';
export const CURATOR_UNIT = 'vault-curator.service';
export const UNIT_DIR = '/etc/systemd/system';

export class UnitError extends Error {
  override readonly name = 'UnitError';
}

export interface ServiceSpec {
  unit: string;
  user: string;
  nodePath: string;
  repoRoot: string;
  dataDir: string;
  port: number;
}

/** The command a unit starts, as arguments; `ExecStart=` quotes them. */
export function engineCommand(spec: Pick<ServiceSpec, 'nodePath' | 'repoRoot' | 'port'>): string[] {
  return [spec.nodePath, join(spec.repoRoot, 'packages', 'engine', 'dist', 'index.js'), '--transport', 'http', '--port', String(spec.port)];
}

export function curatorCommand(spec: Pick<ServiceSpec, 'nodePath' | 'repoRoot'>): string[] {
  return [spec.nodePath, join(spec.repoRoot, 'packages', 'curator', 'dist', 'server.js')];
}

/**
 * Both services start in the data directory: Curator loads a `.env` from its working
 * directory, and the data directory has none, so a stray file in the checkout never
 * reaches it. The Node binary is pinned because native modules are built for it.
 */
export function renderEngineUnit(spec: ServiceSpec): string {
  return renderUnit({
    description: 'Vault Engine',
    after: ['network-online.target'],
    wants: ['network-online.target'],
    spec,
    command: engineCommand(spec),
    environmentFile: join(spec.dataDir, 'engine.env'),
    service: ['Restart=on-failure', 'RestartSec=10'],
  });
}

export function renderCuratorUnit(spec: ServiceSpec): string {
  return renderUnit({
    description: 'Vault Curator',
    // Curator connects to Engine lazily and reconnects, so Engine's warm-up is fine.
    after: ['network-online.target', ENGINE_UNIT],
    wants: ['network-online.target', ENGINE_UNIT],
    spec,
    command: curatorCommand(spec),
    environmentFile: join(spec.dataDir, 'curator.env'),
    service: ['Restart=always', 'RestartSec=5', 'TimeoutStopSec=15'],
  });
}

function renderUnit(input: {
  description: string;
  after: string[];
  wants: string[];
  spec: ServiceSpec;
  command: string[];
  environmentFile: string;
  service: string[];
}): string {
  const { spec } = input;
  if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(spec.user)) throw new UnitError(`cannot run a service as "${spec.user}"`);
  return [
    '# Written by vault-installer.',
    '[Unit]',
    `Description=${input.description}`,
    `After=${input.after.join(' ')}`,
    `Wants=${input.wants.join(' ')}`,
    '',
    '[Service]',
    'Type=simple',
    `User=${spec.user}`,
    `WorkingDirectory=${unitPath(spec.dataDir)}`,
    `EnvironmentFile=${unitPath(input.environmentFile)}`,
    `ExecStart=${input.command.map(execArgument).join(' ')}`,
    ...input.service,
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=full',
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

/** A path setting takes the rest of the line as is; only `%` (a specifier) needs escaping. */
function unitPath(path: string): string {
  if (/[\n\r\0]/.test(path) || path !== path.trim() || path.startsWith('-')) {
    throw new UnitError(`a systemd unit cannot name the path ${JSON.stringify(path)}`);
  }
  return path.replaceAll('%', '%%');
}

/** `ExecStart=` splits on whitespace; quote an argument that needs it. */
function execArgument(argument: string): string {
  if (/[\n\r\0]/.test(argument)) throw new UnitError(`a systemd unit cannot run ${JSON.stringify(argument)}`);
  const escaped = argument.replaceAll('%', '%%').replaceAll('$', '$$$$');
  return /^[A-Za-z0-9_@%+=:,./$-]+$/.test(escaped) ? escaped : `"${escaped.replace(/[\\"]/g, character => `\\${character}`)}"`;
}
