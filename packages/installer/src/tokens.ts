import { join } from 'node:path';
import type { Host } from './host.js';
import { Secret } from './secret.js';

export class TokenError extends Error {
  override readonly name = 'TokenError';
}

/** The installer's own token is short-lived and revoked at handoff. */
export const INSTALLER_TOKEN = { name: 'installer', ttlDays: 1 } as const;
export const CURATOR_TOKEN = { name: 'vault-curator', ttlDays: 36500 } as const;
/** Read-only, for `curator-status`; held only in memory. */
export const INSTALLER_CURATOR_TOKEN = { name: 'installer', ttlDays: 1, scope: 'curate:read' } as const;

const BEARER = /Authorization: Bearer ([0-9a-f]{64})\b/;
const BUSY = /SQLITE_BUSY|database is locked/i;

/**
 * Mint an Engine service token with Engine's own script, which writes the token's hash
 * into the database and prints the token once. It runs only after Engine's first start:
 * the script creates the database file, and a database Engine did not create starts on
 * the older reference-resolution policy. The token is never logged; a failure reports
 * only the script's error output.
 */
export async function mintEngineToken(input: EngineScriptInput & { token: { name: string; ttlDays: number } }): Promise<Secret> {
  const args = ['--name', input.token.name, '--ttl-days', String(input.token.ttlDays)];
  return bearer(await runTokenScript({ ...input, service: 'engine', env: engineEnv(input), args }), 'engine', input.token.name);
}

/** Revoke every Engine token of client `service-<name>`, with Engine's own script. */
export async function revokeEngineTokens(input: EngineScriptInput & { name: string }): Promise<void> {
  await runTokenScript({ ...input, service: 'engine', env: engineEnv(input), args: ['--name', input.name, '--revoke'] });
}

interface EngineScriptInput {
  host: Host;
  nodePath: string;
  repoRoot: string;
  vaultPath: string;
  dbPath: string;
  retryDelayMs?: number;
}

function engineEnv(input: EngineScriptInput): Record<string, string> {
  return { VAULT_PATH: input.vaultPath, DB_PATH: input.dbPath };
}

/**
 * Mint a Curator token with Curator's own script, which writes into Curator's database;
 * like Engine's, only once Curator has started and created it.
 */
export async function mintCuratorToken(input: CuratorScriptInput & { token: { name: string; ttlDays: number; scope: string } }): Promise<Secret> {
  const args = ['--name', input.token.name, '--ttl-days', String(input.token.ttlDays), '--scope', input.token.scope];
  const stdout = await runTokenScript({ ...input, service: 'curator', env: { CURATOR_DB_PATH: input.dbPath }, args });
  return bearer(stdout, 'curator', input.token.name);
}

/** Revoke every Curator token of client `service-<name>`, with Curator's own script. */
export async function revokeCuratorTokens(input: CuratorScriptInput & { name: string }): Promise<void> {
  await runTokenScript({ ...input, service: 'curator', env: { CURATOR_DB_PATH: input.dbPath }, args: ['--name', input.name, '--revoke'] });
}

interface CuratorScriptInput {
  host: Host;
  nodePath: string;
  repoRoot: string;
  dbPath: string;
  retryDelayMs?: number;
}

function bearer(stdout: string, service: 'engine' | 'curator', name: string): Secret {
  const match = BEARER.exec(stdout);
  if (!match) throw new TokenError(`${label(service)}'s token script could not mint the ${name} token: no token in its output`);
  return new Secret(match[1] as string);
}

/** Run a service's token script; returns its output. The script never logs the token's hash. */
async function runTokenScript(input: {
  host: Host;
  nodePath: string;
  repoRoot: string;
  service: 'engine' | 'curator';
  env: Record<string, string>;
  args: string[];
  retryDelayMs?: number;
}): Promise<string> {
  const { host } = input;
  const script = join(input.repoRoot, 'packages', input.service, 'scripts', 'issue-service-token.ts');
  const env: Record<string, string> = { PATH: host.env('PATH') ?? '/usr/bin:/bin', HOME: host.homeDir, ...input.env };
  let last = '';
  for (let attempt = 1; attempt <= 5; attempt++) {
    // `tsx` resolves from the checkout, which is the working directory.
    const result = await host.run(input.nodePath, ['--import', 'tsx', script, ...input.args], { cwd: input.repoRoot, env, timeoutMs: 60_000 });
    if (result.code === 0) return result.stdout;
    last = result.stderr.trim() || `exit ${result.code}`;
    // The service holds its database open; the script retries when a write lock is busy.
    if (!BUSY.test(result.stderr)) break;
    await new Promise(resolve => setTimeout(resolve, input.retryDelayMs ?? 2000));
  }
  throw new TokenError(`${label(input.service)}'s token script failed (${input.args.join(' ')}): ${last}`);
}

function label(service: 'engine' | 'curator'): string {
  return service === 'engine' ? 'Engine' : 'Curator';
}
