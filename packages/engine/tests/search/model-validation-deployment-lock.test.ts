import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const helper = join(repositoryRoot, 'scripts', 'model-validation-deployment-lock.sh');
const deployScript = join(repositoryRoot, 'scripts', 'deploy.sh');
const cutoverScript = join(repositoryRoot, 'scripts', 'cutover.sh');
const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const gitFixtureEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const temporaryRoots: string[] = [];
const backgroundPids: number[] = [];

function createLockFixture(): { root: string; lockPath: string; targetPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'model-validation-deployment-lock-'));
  temporaryRoots.push(root);
  const initialized = spawnSync(realGit, ['init', '--quiet', root], { encoding: 'utf8', env: gitFixtureEnv });
  if (initialized.status !== 0) throw new Error(initialized.stderr);

  const lockPath = join(root, '.git', 'vault-engine-deploy.lock');
  const targetPath = join(root, 'symlink-target');
  writeFileSync(targetPath, 'not a lock\n');
  return { root, lockPath, targetPath };
}

function runLock(
  fixture: ReturnType<typeof createLockFixture>,
  mode: 'existing' | 'create',
  actor: string,
): SpawnSyncReturns<string> {
  return spawnSync(
    'bash',
    ['-c', 'source "$1"; model_validation_acquire_lock "$2" "$3" "$4"', 'bash', helper, fixture.root, mode, actor],
    { encoding: 'utf8' },
  );
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function runGit(root: string, args: string[]): void {
  const result = spawnSync(realGit, ['-C', root, ...args], { encoding: 'utf8', env: gitFixtureEnv });
  if (result.status !== 0) throw new Error(result.stderr);
}

function commitFixture(root: string): void {
  runGit(root, ['add', '.']);
  runGit(root, [
    '-c',
    'user.name=Lock Fixture',
    '-c',
    'user.email=lock-fixture@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
}

function installFixtureScripts(root: string, script: string): { fakeBin: string; runnable: string } {
  const scriptsDir = join(root, 'scripts');
  const fakeBin = join(root, 'fixture-bin');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(fakeBin);
  copyFileSync(helper, join(scriptsDir, 'model-validation-deployment-lock.sh'));
  const runnable = join(scriptsDir, script.split('/').at(-1)!);
  copyFileSync(script, runnable);
  chmodSync(runnable, 0o755);
  return { fakeBin, runnable };
}

function installFakeGit(fakeBin: string): void {
  writeExecutable(
    join(fakeBin, 'git'),
    `#!/usr/bin/env bash
if [ "$*" = "rev-parse HEAD" ] && [ -n "$GIT_INSPECTION_MARKER" ]; then
  : > "$GIT_INSPECTION_MARKER"
fi
case "$1" in
  fetch|pull)
    : > "$GIT_MUTATION_MARKER"
    exit 0
    ;;
esac
exec "$REAL_GIT" "$@"
`,
  );
}

function installFakeNpm(fakeBin: string): void {
  writeExecutable(
    join(fakeBin, 'npm'),
    `#!/usr/bin/env bash
record_lock_state() {
  local observation_path="$1"
  if flock -n "$FIXTURE_DEPLOY_LOCK_PATH" -c true; then
    printf '%s' available > "$observation_path"
  else
    printf '%s' held > "$observation_path"
  fi
}

record_lock_fd_state() {
  local observation_path="$1" state=absent fd
  for fd in /proc/$BASHPID/fd/*; do
    if [ "$(readlink "$fd")" = "$FIXTURE_DEPLOY_LOCK_PATH" ]; then
      state=present
      break
    fi
  done
  printf '%s' "$state" > "$observation_path"
}

start_background_descendant() {
  setsid bash -c 'printf "%s" ready > "$BACKGROUND_DESCENDANT_READY_PATH"
exec sleep 30' </dev/null >/dev/null 2>&1 &
  printf '%s' "$!" > "$BACKGROUND_DESCENDANT_PID_PATH"
}

: > "$NPM_MARKER"
case "$*" in
  ci)
    record_lock_state "$INSTALL_LOCK_OBSERVATION"
    record_lock_fd_state "$INSTALL_LOCK_FD_OBSERVATION"
    ;;
  "run build")
    record_lock_state "$BUILD_LOCK_OBSERVATION"
    record_lock_fd_state "$BUILD_LOCK_FD_OBSERVATION"
    if [ -n "$BACKGROUND_DESCENDANT_PID_PATH" ]; then
      start_background_descendant
    fi
    ;;
esac
`,
  );
}

function createDeployFixture() {
  const lockFixture = createLockFixture();
  const { root } = lockFixture;
  const { fakeBin, runnable: deploy } = installFixtureScripts(root, deployScript);
  const npmMarker = join(root, 'npm-marker');
  const gitInspectionMarker = join(root, 'git-inspection-marker');
  const buildLockObservation = join(root, 'build-lock-observation');
  const buildLockFdObservation = join(root, 'build-lock-fd-observation');
  const smokeLockObservation = join(root, 'smoke-lock-observation');
  const smokeLockFdObservation = join(root, 'smoke-lock-fd-observation');
  const backgroundDescendantPid = join(root, 'background-descendant-pid');
  const backgroundDescendantReady = join(root, 'background-descendant-ready');

  installFakeGit(fakeBin);
  installFakeNpm(fakeBin);
  writeExecutable(join(fakeBin, 'sudo'), '#!/usr/bin/env bash\nexit 97\n');
  writeExecutable(join(fakeBin, 'systemctl'), '#!/usr/bin/env bash\nexit 97\n');
  writeExecutable(
    join(root, 'scripts', 'smoke.sh'),
    `#!/usr/bin/env bash
if flock -n "$FIXTURE_DEPLOY_LOCK_PATH" -c true; then
  printf '%s' available > "$SMOKE_LOCK_OBSERVATION"
else
  printf '%s' held > "$SMOKE_LOCK_OBSERVATION"
fi
state=absent
for fd in /proc/$BASHPID/fd/*; do
  if [ "$(readlink "$fd")" = "$FIXTURE_DEPLOY_LOCK_PATH" ]; then
    state=present
    break
  fi
done
printf '%s' "$state" > "$SMOKE_LOCK_FD_OBSERVATION"
`,
  );
  writeFileSync(join(root, 'package.json'), '{"private":true}\n');
  commitFixture(root);

  return {
    backgroundDescendantPid,
    backgroundDescendantReady,
    buildLockFdObservation,
    buildLockObservation,
    deploy,
    fakeBin,
    gitInspectionMarker,
    lockFixture,
    npmMarker,
    smokeLockFdObservation,
    smokeLockObservation,
  };
}

function runDeploy(
  fixture: ReturnType<typeof createDeployFixture>,
  args: string[],
  { backgroundDescendant = false }: { backgroundDescendant?: boolean } = {},
): SpawnSyncReturns<string> {
  return spawnSync(fixture.deploy, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      ALLOW_NON_PROD: '1',
      BACKGROUND_DESCENDANT_PID_PATH: backgroundDescendant ? fixture.backgroundDescendantPid : '',
      BACKGROUND_DESCENDANT_READY_PATH: backgroundDescendant ? fixture.backgroundDescendantReady : '',
      BUILD_LOCK_FD_OBSERVATION: fixture.buildLockFdObservation,
      BUILD_LOCK_OBSERVATION: fixture.buildLockObservation,
      FIXTURE_DEPLOY_LOCK_PATH: fixture.lockFixture.lockPath,
      GIT_INSPECTION_MARKER: fixture.gitInspectionMarker,
      GIT_MUTATION_MARKER: join(fixture.lockFixture.root, 'forbidden-git-mutation'),
      INSTALL_LOCK_FD_OBSERVATION: join(fixture.lockFixture.root, 'forbidden-install-fd-observation'),
      INSTALL_LOCK_OBSERVATION: join(fixture.lockFixture.root, 'forbidden-install-observation'),
      NPM_MARKER: fixture.npmMarker,
      PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`,
      REAL_GIT: realGit,
      SMOKE_LOCK_FD_OBSERVATION: fixture.smokeLockFdObservation,
      SMOKE_LOCK_OBSERVATION: fixture.smokeLockObservation,
    },
  });
}

function createCutoverFixture() {
  const lockFixture = createLockFixture();
  const { root } = lockFixture;
  const { fakeBin, runnable: cutover } = installFixtureScripts(root, cutoverScript);
  const npmMarker = join(root, 'npm-marker');
  const gitMutationMarker = join(root, 'git-mutation-marker');
  const installLockObservation = join(root, 'install-lock-observation');
  const installLockFdObservation = join(root, 'install-lock-fd-observation');
  const buildLockObservation = join(root, 'build-lock-observation');
  const buildLockFdObservation = join(root, 'build-lock-fd-observation');
  const backgroundDescendantPid = join(root, 'background-descendant-pid');
  const backgroundDescendantReady = join(root, 'background-descendant-ready');

  mkdirSync(join(root, 'packages', 'engine'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"private":true}\n');
  installFakeGit(fakeBin);
  installFakeNpm(fakeBin);
  writeExecutable(join(fakeBin, 'node'), '#!/usr/bin/env bash\nprintf "%s\\n" v22.0.0\n');
  writeExecutable(join(fakeBin, 'sudo'), '#!/usr/bin/env bash\nexit 97\n');
  writeExecutable(join(fakeBin, 'systemctl'), '#!/usr/bin/env bash\nexit 0\n');
  commitFixture(root);
  runGit(root, ['branch', '-M', 'main']);

  return {
    backgroundDescendantPid,
    backgroundDescendantReady,
    buildLockFdObservation,
    buildLockObservation,
    cutover,
    fakeBin,
    gitMutationMarker,
    installLockFdObservation,
    installLockObservation,
    lockFixture,
    npmMarker,
  };
}

function runCutoverPreflight(
  fixture: ReturnType<typeof createCutoverFixture>,
  { backgroundDescendant = false }: { backgroundDescendant?: boolean } = {},
): SpawnSyncReturns<string> {
  return spawnSync(fixture.cutover, ['preflight'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ASSUME_YES: '1',
      BACKGROUND_DESCENDANT_PID_PATH: backgroundDescendant ? fixture.backgroundDescendantPid : '',
      BACKGROUND_DESCENDANT_READY_PATH: backgroundDescendant ? fixture.backgroundDescendantReady : '',
      BUILD_LOCK_FD_OBSERVATION: fixture.buildLockFdObservation,
      BUILD_LOCK_OBSERVATION: fixture.buildLockObservation,
      FIXTURE_DEPLOY_LOCK_PATH: fixture.lockFixture.lockPath,
      GIT_INSPECTION_MARKER: '',
      GIT_MUTATION_MARKER: fixture.gitMutationMarker,
      INSTALL_LOCK_FD_OBSERVATION: fixture.installLockFdObservation,
      INSTALL_LOCK_OBSERVATION: fixture.installLockObservation,
      MONOREPO: fixture.lockFixture.root,
      NODE_BIN: join(fixture.fakeBin, 'node'),
      NPM_MARKER: fixture.npmMarker,
      PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`,
      REAL_GIT: realGit,
    },
  });
}

function runLockPublicStateProbe(fixture: ReturnType<typeof createLockFixture>): SpawnSyncReturns<string> {
  return spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
model_validation_acquire_lock "$2" create public-state-probe || exit $?
printf 'MODEL_VALIDATION_LOCK_PATH=%s\\n' "$MODEL_VALIDATION_LOCK_PATH"
printf 'MODEL_VALIDATION_LOCK_FD=%s\\n' "$MODEL_VALIDATION_LOCK_FD"
[[ "$MODEL_VALIDATION_LOCK_FD" =~ ^[0-9]+$ ]] || exit 1
[ -e "/proc/$$/fd/$MODEL_VALIDATION_LOCK_FD" ] || exit 1
if printf 'must-not-write' >&"$MODEL_VALIDATION_LOCK_FD"; then
  printf '%s\\n' 'lock descriptor unexpectedly writable' >&2
  exit 1
fi`,
      'bash',
      helper,
      fixture.root,
    ],
    { encoding: 'utf8' },
  );
}

async function startLockHolder(
  fixture: ReturnType<typeof createLockFixture>,
): Promise<ChildProcessWithoutNullStreams> {
  const created = runLock(fixture, 'create', 'setup');
  if (created.status !== 0) throw new Error(created.stderr);

  const readyPath = join(fixture.root, '.git', 'lock-holder-ready');
  const holder = spawn(
    'bash',
    [
      '-c',
      'source "$1"; model_validation_acquire_lock "$2" existing holder || exit $?; : > "$3"; read',
      'bash',
      helper,
      fixture.root,
      readyPath,
    ],
    { stdio: 'pipe' },
  );

  await waitForReady(holder, readyPath);
  return holder;
}

async function waitForReady(holder: ChildProcessWithoutNullStreams, readyPath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(readyPath)) return;
    if (holder.exitCode !== null) throw new Error(`lock holder exited with ${holder.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('lock holder did not become ready');
}

async function stopLockHolder(holder: ChildProcessWithoutNullStreams): Promise<void> {
  const exited = new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.once('exit', () => resolve());
  });
  holder.stdin.end();
  await exited;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`fixture file was not created: ${path}`);
}

function rememberBackgroundPid(path: string): number {
  const pid = Number(readFileSync(path, 'utf8'));
  if (!Number.isSafeInteger(pid)) throw new Error(`invalid background PID: ${pid}`);
  backgroundPids.push(pid);
  return pid;
}

function stopBackgroundPid(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    try {
      process.kill(pid, 'SIGTERM');
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code !== 'ESRCH') throw fallbackError;
    }
  }
}

afterEach(() => {
  for (const pid of backgroundPids.splice(0)) stopBackgroundPid(pid);
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// The deployment lock (with deploy.sh and cutover.sh) runs on the Linux server only: it takes its lock with flock and checks
// it through /proc, neither of which macOS has.
describe.skipIf(process.platform !== 'linux')('model validation deployment lock', () => {
  it('creates a mode-0600 Git-metadata lock and acquires it read-only in create mode', () => {
    const fixture = createLockFixture();
    const result = runLock(fixture, 'create', 'helper-test');
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(fixture.lockPath).mode & 0o777).toBe(0o600);
  });

  it('exposes the normalized lock path and a read-only public lock descriptor after acquisition', () => {
    const fixture = createLockFixture();
    const result = runLockPublicStateProbe(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`MODEL_VALIDATION_LOCK_PATH=${realpathSync(fixture.lockPath)}\n`);
    expect(result.stdout).toMatch(/^MODEL_VALIDATION_LOCK_FD=\d+$/m);
  });

  it('rejects a missing lock in existing mode without creating it', () => {
    const fixture = createLockFixture();
    const result = runLock(fixture, 'existing', 'helper-test');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('existing regular lock file is required');
    expect(existsSync(fixture.lockPath)).toBe(false);
  });

  it('rejects a symlink at the resolved lock path', () => {
    const fixture = createLockFixture();
    symlinkSync(fixture.targetPath, fixture.lockPath);
    const result = runLock(fixture, 'existing', 'helper-test');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lock path must not be a symlink');
  });

  it('fails nonblocking acquisition while another process holds the same lock', async () => {
    const fixture = createLockFixture();
    const holder = await startLockHolder(fixture);
    const result = runLock(fixture, 'existing', 'contender');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('deployment/model-validation lock is held');
    await stopLockHolder(holder);
  });

  it('allows a new acquisition after the holder exits', async () => {
    const fixture = createLockFixture();
    const holder = await startLockHolder(fixture);
    await stopLockHolder(holder);
    const result = runLock(fixture, 'existing', 'next-run');
    expect(result.status, result.stderr).toBe(0);
  });

  it('blocks deploy before commit inspection when validation holds the lock', async () => {
    const fixture = createDeployFixture();
    const holder = await startLockHolder(fixture.lockFixture);
    try {
      const result = runDeploy(fixture, ['--no-pull', '--skip-install', '--no-restart']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('deployment/model-validation lock is held');
      expect(existsSync(fixture.gitInspectionMarker)).toBe(false);
      expect(existsSync(fixture.npmMarker)).toBe(false);
    } finally {
      await stopLockHolder(holder);
    }
  });

  it('holds the lock through deploy build and smoke', () => {
    const fixture = createDeployFixture();
    const result = runDeploy(fixture, ['--no-pull', '--skip-install', '--no-restart']);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.buildLockObservation, 'utf8')).toBe('held');
    expect(readFileSync(fixture.smokeLockObservation, 'utf8')).toBe('held');
    expect(readFileSync(fixture.buildLockFdObservation, 'utf8')).toBe('absent');
    expect(readFileSync(fixture.smokeLockFdObservation, 'utf8')).toBe('absent');
  });

  it('releases the deploy lock when a build descendant outlives deploy', async () => {
    const fixture = createDeployFixture();
    const result = runDeploy(fixture, ['--no-pull', '--skip-install', '--no-restart'], {
      backgroundDescendant: true,
    });
    const descendantPid = rememberBackgroundPid(fixture.backgroundDescendantPid);
    expect(result.status, result.stderr).toBe(0);
    await waitForFile(fixture.backgroundDescendantReady);
    expect(() => process.kill(descendantPid, 0)).not.toThrow();

    const contender = runLock(fixture.lockFixture, 'existing', 'post-deploy');
    expect(contender.status, contender.stderr).toBe(0);
  });

  it('blocks cutover preflight before fetch when validation holds the selected checkout lock', async () => {
    const fixture = createCutoverFixture();
    const holder = await startLockHolder(fixture.lockFixture);
    try {
      const result = runCutoverPreflight(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('deployment/model-validation lock is held');
      expect(existsSync(fixture.gitMutationMarker)).toBe(false);
      expect(existsSync(fixture.npmMarker)).toBe(false);
    } finally {
      await stopLockHolder(holder);
    }
  });

  it('holds the selected checkout lock through cutover install and build', () => {
    const fixture = createCutoverFixture();
    const result = runCutoverPreflight(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.installLockObservation, 'utf8')).toBe('held');
    expect(readFileSync(fixture.buildLockObservation, 'utf8')).toBe('held');
    expect(readFileSync(fixture.installLockFdObservation, 'utf8')).toBe('absent');
    expect(readFileSync(fixture.buildLockFdObservation, 'utf8')).toBe('absent');
  });

  it('releases the cutover lock when a build descendant outlives preflight', async () => {
    const fixture = createCutoverFixture();
    const result = runCutoverPreflight(fixture, { backgroundDescendant: true });
    const descendantPid = rememberBackgroundPid(fixture.backgroundDescendantPid);
    expect(result.status, result.stderr).toBe(0);
    await waitForFile(fixture.backgroundDescendantReady);
    expect(() => process.kill(descendantPid, 0)).not.toThrow();

    const contender = runLock(fixture.lockFixture, 'existing', 'post-cutover');
    expect(contender.status, contender.stderr).toBe(0);
  });
});
