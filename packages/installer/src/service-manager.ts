import { join } from 'node:path';
import type { EnvDialect } from './env-file.js';
import { shellCommand } from './text.js';
import { UNIT_DIR } from './units.js';

/**
 * What runs the services: systemd system units on Linux, launchd agents in the user's
 * `~/Library/LaunchAgents` on macOS. Services are named by their systemd unit everywhere
 * (`vault-engine.service`); launchd's names come from it.
 */
export type ServiceManager = 'systemd' | 'launchd';

export function serviceManagerFor(platform: NodeJS.Platform): ServiceManager {
  return platform === 'darwin' ? 'launchd' : 'systemd';
}

/** The folder each manager reads service definitions from. */
export function serviceDirFor(manager: ServiceManager, homeDir: string): string {
  return manager === 'launchd' ? join(homeDir, 'Library', 'LaunchAgents') : UNIT_DIR;
}

/** The service's launchd label: its unit name without `.service`. */
export function launchdLabel(unit: string): string {
  return unit.replace(/\.service$/, '');
}

/** The service definition's file name, staged and installed. */
export function serviceFileName(manager: ServiceManager, unit: string): string {
  return manager === 'launchd' ? `${launchdLabel(unit)}.plist` : unit;
}

/** The env file format the services read: systemd's `EnvironmentFile`, or Node's `--env-file`. */
export function envDialect(manager: ServiceManager): EnvDialect {
  return manager === 'launchd' ? 'node' : 'systemd';
}

/** The plan's service settings; plans saved before macOS support are systemd's. */
export interface PlannedServices {
  service_manager?: ServiceManager | undefined;
  service_dir?: string | undefined;
}

export function plannedManager(services: PlannedServices): ServiceManager {
  return services.service_manager ?? 'systemd';
}

export function plannedServicePath(services: PlannedServices, unit: string): string {
  const manager = plannedManager(services);
  return join(services.service_dir ?? UNIT_DIR, serviceFileName(manager, unit));
}

/**
 * launchd's domain for the logged-in user, as a command to copy: `id -u` stands for the
 * user id, so the line is the same for everyone.
 */
const USER_DOMAIN = 'gui/$(id -u)';

/** How a message names a service: its systemd unit, or its launchd agent. */
export function serviceName(manager: ServiceManager, unit: string): string {
  return manager === 'launchd' ? `the ${launchdLabel(unit)} launchd agent` : unit;
}

/** A command that restarts the services, to show the user. */
export function restartCommand(manager: ServiceManager, units: readonly string[]): string {
  return manager === 'launchd'
    ? units.map(unit => `launchctl kickstart -k ${USER_DOMAIN}/${launchdLabel(unit)}`).join(' && ')
    : `sudo systemctl restart ${units.join(' ')}`;
}

/** A command that starts a stopped service, to show the user. */
export function startCommand(manager: ServiceManager, unit: string): string {
  return manager === 'launchd'
    ? `launchctl kickstart ${USER_DOMAIN}/${launchdLabel(unit)}`
    : `sudo systemctl start ${unit}`;
}

/** The commands that install and start a staged service, to show in the review. */
export function installCommands(manager: ServiceManager, staged: string, installed: string, unit: string): string[] {
  return manager === 'launchd'
    ? [
        shellCommand(['cp', staged, installed]),
        `launchctl bootstrap ${USER_DOMAIN} ${shellCommand([installed])}`,
      ]
    : [
        shellCommand(['sudo', 'install', '-m', '0644', staged, installed]),
        'sudo systemctl daemon-reload',
        `sudo systemctl enable --now ${unit}`,
      ];
}

/** The commands that stop and remove installed services, to show the user. */
export function removalCommands(manager: ServiceManager, services: ReadonlyArray<{ unit: string; path: string }>): string[] {
  if (services.length === 0) return [];
  return manager === 'launchd'
    ? [
        ...services.map(({ unit }) => `launchctl bootout ${USER_DOMAIN}/${launchdLabel(unit)}`),
        shellCommand(['rm', ...services.map(({ path }) => path)]),
      ]
    : [
        shellCommand(['sudo', 'systemctl', 'disable', '--now', ...services.map(({ unit }) => unit)]),
        shellCommand(['sudo', 'rm', ...services.map(({ path }) => path)]),
        'sudo systemctl daemon-reload',
      ];
}
