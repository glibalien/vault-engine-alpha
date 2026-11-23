import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, mkdir, readFile, realpath, stat, statfs } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { dirname } from 'node:path';

export interface CommandResult {
  /** Exit code, or null when the command could not be started (for example, not installed). */
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Everything the read-only stages learn about the machine goes through this seam,
 * so tests can describe a host without touching the real one.
 */
export interface Host {
  platform: NodeJS.Platform;
  /** The CPU architecture of the Node.js binary running the installer (`arm64`, `x64`). */
  arch: string;
  nodeVersion: string;
  /** The absolute path of the Node.js binary running the installer; the services pin it. */
  execPath: string;
  homeDir: string;
  /** The login name the services run as. */
  username: string;
  /** Effective user id, or null where the platform has none. */
  uid: number | null;
  /** The system's IANA time zone, for example `Europe/London`. */
  timeZone: string;
  /** A variable from the installer's own environment. */
  env(name: string): string | undefined;
  run(command: string, args: string[], options?: RunOptions): Promise<CommandResult>;
  /**
   * Run a command attached to the installer's terminal, so it can ask for a password
   * (sudo). Resolves to its exit code, or null when it could not be started.
   */
  runAttached(command: string, args: string[]): Promise<number | null>;
  /** A file's text, or null when it does not exist. */
  readText(path: string): Promise<string | null>;
  /** Memory available to new processes, or null when it cannot be read. */
  memAvailableBytes(): Promise<number | null>;
  /** Free space on the filesystem holding `path` or its nearest existing ancestor. */
  freeDiskBytes(path: string): Promise<number | null>;
  isPortFree(port: number): Promise<boolean>;
  canReach(url: string, timeoutMs: number): Promise<boolean>;
  /** The HTTP status of a GET, or null when nothing answered. The body is discarded. */
  httpStatus(url: string, headers: Record<string, string>, timeoutMs: number): Promise<number | null>;
  pathExists(path: string): Promise<boolean>;
  inspectDirectory(path: string): Promise<DirectoryAccess>;
  /** The path with every symlink resolved. */
  realPath(path: string): Promise<string>;
  /** Create a folder and any missing parents, as `mkdir -p` does. */
  makeDirectory(path: string): Promise<void>;
  /** Copy a folder to a path that does not exist yet, creating it and its parents; never over anything already there. */
  copyDirectory(from: string, to: string): Promise<void>;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  /** The child's whole environment; by default it inherits the installer's. */
  env?: Record<string, string>;
}

export interface DirectoryAccess {
  exists: boolean;
  directory: boolean;
  readable: boolean;
  writable: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createSystemHost(): Host {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    execPath: process.execPath,
    homeDir: homedir(),
    username: userInfo().username,
    uid: typeof process.geteuid === 'function' ? process.geteuid() : null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    env: name => process.env[name],
    run: runCommand,
    runAttached,
    readText,
    memAvailableBytes,
    freeDiskBytes,
    isPortFree,
    canReach,
    httpStatus,
    pathExists,
    inspectDirectory,
    realPath: path => realpath(path),
    makeDirectory: async path => { await mkdir(path, { recursive: true }); },
    copyDirectory: async (from, to) => { await cp(from, to, { recursive: true, force: false, errorOnExist: true }); },
  };
}

function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  return new Promise(resolve => {
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          resolve({ code: null, stdout: String(stdout), stderr: String(stderr || error.message) });
          return;
        }
        resolve({ code: error ? (error.code as number) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function runAttached(command: string, args: string[]): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', () => resolve(null));
    child.once('exit', code => resolve(code));
  });
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function memAvailableBytes(): Promise<number | null> {
  if (process.platform === 'darwin') return darwinMemAvailableBytes();
  try {
    const meminfo = await readFile('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * macOS has no MemAvailable. What it can hand to a new process without swapping: free,
 * inactive, speculative, and purgeable pages, from `vm_stat`.
 */
async function darwinMemAvailableBytes(): Promise<number | null> {
  const result = await runCommand('/usr/bin/vm_stat', []);
  if (result.code !== 0) return null;
  return parseVmStat(result.stdout);
}

export function parseVmStat(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  if (pageSize === undefined) return null;
  const pages = (name: string) => {
    const value = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?$`, 'm').exec(output)?.[1];
    return value === undefined ? null : Number(value);
  };
  const free = pages('free');
  if (free === null) return null;
  // The others are missing from some versions' output; missing counts as none.
  return (free + (pages('inactive') ?? 0) + (pages('speculative') ?? 0) + (pages('purgeable') ?? 0)) * Number(pageSize);
}

async function freeDiskBytes(path: string): Promise<number | null> {
  let current = path;
  for (;;) {
    try {
      const stats = await statfs(current);
      return stats.bavail * stats.bsize;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function canReach(url: string, timeoutMs: number): Promise<boolean> {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

async function httpStatus(url: string, headers: Record<string, string>, timeoutMs: number): Promise<number | null> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
}

function pathExists(path: string): Promise<boolean> {
  return accessible(path, constants.F_OK);
}

async function inspectDirectory(path: string): Promise<DirectoryAccess> {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) return { exists: true, directory: false, readable: false, writable: false };
  } catch {
    return { exists: false, directory: false, readable: false, writable: false };
  }
  return {
    exists: true,
    directory: true,
    readable: await accessible(path, constants.R_OK | constants.X_OK),
    writable: await accessible(path, constants.W_OK),
  };
}

async function accessible(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}
