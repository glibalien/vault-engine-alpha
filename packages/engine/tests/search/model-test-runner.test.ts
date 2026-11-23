import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const sourceRunner = resolve(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'run-model-integration-tests.sh');
const sourceDeploymentLock = resolve(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'model-validation-deployment-lock.sh');
const sourceProvenance = resolve(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'embedder-worker-provenance.mjs');
const sourceResultValidator = resolve(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'verify-model-test-result.mjs');
const sourceTypeScript = resolve(import.meta.dirname, '..', '..', '..', '..', 'node_modules', 'typescript');
const temporaryRoots: string[] = [];
const exactSuccessReport = JSON.stringify({
  numTotalTests: 7,
  numPassedTests: 7,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  success: true,
});

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeFixtureManifest(root: string): void {
  const files = [
    'package-lock.json',
    'packages/engine/dist/search/chunker.js',
    'packages/engine/dist/search/document-embedder.js',
    'packages/engine/dist/search/embedder-worker.js',
    'packages/engine/package.json',
  ];
  writeFileSync(join(root, 'packages', 'engine', 'dist', 'search', 'embedder-worker.build.json'), `${JSON.stringify({
    schemaVersion: 3,
    commit: 'deadbeef',
    trackedClean: true,
    files: Object.fromEntries(files.map((file) => [file, sha256(readFileSync(join(root, file)))])),
  })}\n`);
}

function createRunnerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'model-test-runner-'));
  temporaryRoots.push(root);

  const runner = join(root, 'scripts', 'run-model-integration-tests.sh');
  const deploymentLock = join(root, 'scripts', 'model-validation-deployment-lock.sh');
  const provenance = join(root, 'scripts', 'embedder-worker-provenance.mjs');
  const resultValidator = join(root, 'scripts', 'verify-model-test-result.mjs');
  const fakeBin = join(root, 'fake-bin');
  const testCache = join(root, 'test-cache');
  const liveCache = join(root, 'live-cache');
  const testCacheCapture = join(root, 'test-cache-value');
  const liveCacheCapture = join(root, 'live-cache-value');
  const offlineCapture = join(root, 'offline-value');
  const argsCapture = join(root, 'npm-args');
  const resultModeCapture = join(root, 'result-mode');
  const npmMarker = join(root, 'npm-invoked');
  const deployLockPath = join(root, 'fixture-git', 'vault-engine-deploy.lock');
  const lockObservation = join(root, 'lock-observation');
  const lockFdObservation = join(root, 'lock-fd-observation');
  const versionLockFdObservation = join(root, 'version-lock-fd-observation');
  const backgroundDescendantPid = join(root, 'background-descendant-pid');
  const backgroundDescendantReady = join(root, 'background-descendant-ready');
  const backgroundDescendantLockState = join(root, 'background-descendant-lock-state');
  const versionBackgroundDescendantPid = join(root, 'version-background-descendant-pid');
  const versionBackgroundDescendantReady = join(root, 'version-background-descendant-ready');
  const versionBackgroundDescendantLockState = join(root, 'version-background-descendant-lock-state');
  const workerPath = join(root, 'packages', 'engine', 'dist', 'search', 'embedder-worker.js');
  const chunkerPath = join(root, 'packages', 'engine', 'dist', 'search', 'chunker.js');
  const manifestPath = join(root, 'packages', 'engine', 'dist', 'search', 'embedder-worker.build.json');
  const temporaryDir = join(root, 'custom-tmp');
  const npmExit = 23;

  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'fixture-git'), { recursive: true });
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(root, 'packages', 'engine', 'dist', 'search'), { recursive: true });
  mkdirSync(join(testCache, 'nomic-ai'), { recursive: true });
  mkdirSync(join(liveCache, 'nomic-ai'), { recursive: true });
  mkdirSync(fakeBin);
  mkdirSync(temporaryDir);

  copyFileSync(sourceRunner, runner);
  copyFileSync(sourceDeploymentLock, deploymentLock);
  copyFileSync(sourceProvenance, provenance);
  copyFileSync(sourceResultValidator, resultValidator);
  chmodSync(runner, 0o755);
  writeFileSync(deployLockPath, '');
  chmodSync(deployLockPath, 0o600);
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(root, 'packages', 'engine', 'package.json'), '{"name":"vault-engine"}\n');
  symlinkSync(sourceTypeScript, join(root, 'node_modules', 'typescript'), 'junction');
  writeExecutable(join(root, 'node_modules', '.bin', 'vitest'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(workerPath, "import './document-embedder.js';\nexport const compiledWorker = true;\n");
  writeFileSync(
    join(root, 'packages', 'engine', 'dist', 'search', 'document-embedder.js'),
    "export { chunk } from './chunker.js';\n",
  );
  writeFileSync(
    join(root, 'packages', 'engine', 'dist', 'search', 'chunker.js'),
    'export const chunk = true;\n',
  );
  writeFixtureManifest(root);
  writeExecutable(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [ "$*" = "-C $FIXTURE_REPO_ROOT rev-parse --git-path vault-engine-deploy.lock" ]; then
  printf '%s\\n' "$FIXTURE_DEPLOY_LOCK_PATH"
else
  printf '%s\\n' deadbeef
fi
`);
  writeExecutable(join(fakeBin, 'npm'), `#!/usr/bin/env bash
record_lock_fd_observation() {
  local observation_path="$1" lock_fd_observation=absent fd
  for fd in /proc/$BASHPID/fd/*; do
    if [ "$(readlink "$fd")" = "$FIXTURE_DEPLOY_LOCK_PATH" ]; then
      lock_fd_observation=present
      break
    fi
  done
  printf '%s' "$lock_fd_observation" > "$observation_path"
}

start_background_descendant() {
  local pid_path="$1" ready_path="$2" lock_state_path="$3" inherited_lock_fd='' fd
  for fd in /proc/$BASHPID/fd/*; do
    if [ "$(readlink "$fd")" = "$FIXTURE_DEPLOY_LOCK_PATH" ]; then
      inherited_lock_fd="\${fd##*/}"
      break
    fi
  done
  if [ -n "$inherited_lock_fd" ]; then
    setsid env BACKGROUND_LOCK_STATE_PATH="$lock_state_path" BACKGROUND_READY_PATH="$ready_path" flock "$FIXTURE_DEPLOY_LOCK_PATH" bash -c 'printf "%s" held > "$BACKGROUND_LOCK_STATE_PATH"
printf "%s" ready > "$BACKGROUND_READY_PATH"
exec sleep 30' </dev/null >/dev/null 2>&1 &
  else
    setsid env BACKGROUND_LOCK_STATE_PATH="$lock_state_path" BACKGROUND_READY_PATH="$ready_path" bash -c 'printf "%s" absent > "$BACKGROUND_LOCK_STATE_PATH"
printf "%s" ready > "$BACKGROUND_READY_PATH"
exec sleep 30' </dev/null >/dev/null 2>&1 &
  fi
  printf '%s' "$!" > "$pid_path"
}

if [ "\${1:-}" = "--version" ]; then
  record_lock_fd_observation "$VERSION_LOCK_FD_OBSERVATION"
  if [ -n "\${VERSION_BACKGROUND_DESCENDANT_PID_PATH:-}" ]; then
    start_background_descendant "$VERSION_BACKGROUND_DESCENDANT_PID_PATH" "$VERSION_BACKGROUND_DESCENDANT_READY_PATH" "$VERSION_BACKGROUND_DESCENDANT_LOCK_STATE"
  fi
  echo 12.0.1
  exit 0
fi
report_path=''
for arg in "$@"; do
  case "$arg" in
    --outputFile.json=*) report_path="\${arg#*=}" ;;
  esac
done
if [ -n "\${REPORT_JSON:-}" ]; then
  printf '%s' "$REPORT_JSON" > "$report_path"
fi
printf '%s' "\${VAULT_ENGINE_MODELS_DIR:-}" > "$TEST_CACHE_CAPTURE"
printf '%s' "\${VAULT_ENGINE_LIVE_MODELS_DIR-unset}" > "$LIVE_CACHE_CAPTURE"
printf '%s' "\${VAULT_ENGINE_MODELS_OFFLINE:-}" > "\$OFFLINE_CAPTURE"
printf '%s\\n' "$@" > "$ARGS_CAPTURE"
stat -c '%a' "$report_path" > "$RESULT_MODE_CAPTURE"
record_lock_fd_observation "$LOCK_FD_OBSERVATION"
if flock -n "$FIXTURE_DEPLOY_LOCK_PATH" -c true; then
  printf '%s' 'available' > "$LOCK_OBSERVATION"
else
  printf '%s' 'held' > "$LOCK_OBSERVATION"
fi
if [ -n "\${BACKGROUND_DESCENDANT_PID_PATH:-}" ]; then
  start_background_descendant "$BACKGROUND_DESCENDANT_PID_PATH" "$BACKGROUND_DESCENDANT_READY_PATH" "$BACKGROUND_DESCENDANT_LOCK_STATE"
fi
if [ -n "\${MUTATE_COMPILED_PATH:-}" ]; then
  printf '%s' 'changed during model validation' > "$MUTATE_COMPILED_PATH"
fi
if [ -n "\${COHERENT_TRANSITION_PATH:-}" ]; then
  printf '%s' 'changed during coherent model validation' > "$COHERENT_TRANSITION_PATH"
  node "$PWD/scripts/embedder-worker-provenance.mjs" write "$PWD" >/dev/null
fi
printf '%s' invoked > "\$NPM_MARKER"
exit "\${NPM_EXIT:-0}"
`);

  return {
    argsCapture,
    backgroundDescendantPid,
    backgroundDescendantReady,
    backgroundDescendantLockState,
    chunkerPath,
    deployLockPath,
    fakeBin,
    liveCache,
    liveCacheCapture,
    lockFdObservation,
    lockObservation,
    manifestPath,
    npmExit,
    npmMarker,
    offlineCapture,
    resultModeCapture,
    root,
    runner,
    temporaryDir,
    testCache,
    testCacheCapture,
    workerPath,
    versionBackgroundDescendantLockState,
    versionBackgroundDescendantPid,
    versionBackgroundDescendantReady,
    versionLockFdObservation,
  };
}

function createNpmWorkspaceRunnerFixture() {
  const fixture = createRunnerFixture();
  const capturedArgs = join(fixture.root, 'captured-model-test-args.json');
  const engineScripts = join(fixture.root, 'packages', 'engine', 'scripts');

  rmSync(join(fixture.fakeBin, 'npm'));
  mkdirSync(engineScripts, { recursive: true });
  writeFileSync(join(fixture.root, 'package.json'), `${JSON.stringify({
    name: 'model-test-runner-workspace-fixture',
    private: true,
    workspaces: ['packages/*'],
    scripts: {
      'test:model': 'npm run test:model -w vault-engine',
    },
  })}\n`);
  writeFileSync(join(fixture.root, 'packages', 'engine', 'package.json'), `${JSON.stringify({
    name: 'vault-engine',
    version: '0.0.0',
    scripts: {
      'test:model': 'node scripts/capture-model-test-args.mjs',
    },
  })}\n`);
  writeFileSync(join(engineScripts, 'capture-model-test-args.mjs'), `import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const outputFile = args.find((arg) => arg.startsWith('--outputFile.json='));
writeFileSync(process.env.CAPTURED_ARGS_PATH, JSON.stringify(args));
if (!outputFile) process.exit(2);
writeFileSync(outputFile.slice('--outputFile.json='.length), JSON.stringify({
  numTotalTests: 7,
  numPassedTests: 7,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  success: true,
}));
`);
  writeFixtureManifest(fixture.root);

  return { ...fixture, capturedArgs };
}

function runRunner(
  fixture: ReturnType<typeof createRunnerFixture>,
  {
    mutateCompiledPath,
    coherentTransitionPath,
    backgroundDescendant = false,
    versionBackgroundDescendant = false,
    npmExit = 0,
    reportJson,
  }: { backgroundDescendant?: boolean; coherentTransitionPath?: string; mutateCompiledPath?: string; npmExit?: number; reportJson?: string; versionBackgroundDescendant?: boolean } = {},
) {
  return spawnSync(fixture.runner, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`,
      NPM_MARKER: fixture.npmMarker,
      NPM_EXIT: String(npmExit),
      OFFLINE_CAPTURE: fixture.offlineCapture,
      ARGS_CAPTURE: fixture.argsCapture,
      REPORT_JSON: reportJson,
      RESULT_MODE_CAPTURE: fixture.resultModeCapture,
      TEST_CACHE_CAPTURE: fixture.testCacheCapture,
      LIVE_CACHE_CAPTURE: fixture.liveCacheCapture,
      MUTATE_COMPILED_PATH: mutateCompiledPath,
      FIXTURE_DEPLOY_LOCK_PATH: fixture.deployLockPath,
      FIXTURE_REPO_ROOT: fixture.root,
      BACKGROUND_DESCENDANT_PID_PATH: backgroundDescendant ? fixture.backgroundDescendantPid : undefined,
      BACKGROUND_DESCENDANT_READY_PATH: backgroundDescendant ? fixture.backgroundDescendantReady : undefined,
      BACKGROUND_DESCENDANT_LOCK_STATE: backgroundDescendant ? fixture.backgroundDescendantLockState : undefined,
      LOCK_FD_OBSERVATION: fixture.lockFdObservation,
      VERSION_LOCK_FD_OBSERVATION: fixture.versionLockFdObservation,
      VERSION_BACKGROUND_DESCENDANT_PID_PATH: versionBackgroundDescendant ? fixture.versionBackgroundDescendantPid : undefined,
      VERSION_BACKGROUND_DESCENDANT_READY_PATH: versionBackgroundDescendant ? fixture.versionBackgroundDescendantReady : undefined,
      VERSION_BACKGROUND_DESCENDANT_LOCK_STATE: versionBackgroundDescendant ? fixture.versionBackgroundDescendantLockState : undefined,
      LOCK_OBSERVATION: fixture.lockObservation,
      COHERENT_TRANSITION_PATH: coherentTransitionPath,
      TMPDIR: fixture.temporaryDir,
      VAULT_ENGINE_MODELS_DIR: fixture.testCache,
      VAULT_ENGINE_LIVE_MODELS_DIR: fixture.liveCache,
      VAULT_ENGINE_MODELS_OFFLINE: '0',
    },
  });
}

function runRunnerAgainstNpmWorkspace(fixture: ReturnType<typeof createNpmWorkspaceRunnerFixture>) {
  return spawnSync(fixture.runner, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`,
      CAPTURED_ARGS_PATH: fixture.capturedArgs,
      FIXTURE_DEPLOY_LOCK_PATH: fixture.deployLockPath,
      FIXTURE_REPO_ROOT: fixture.root,
      TMPDIR: fixture.temporaryDir,
      VAULT_ENGINE_MODELS_DIR: fixture.testCache,
      VAULT_ENGINE_LIVE_MODELS_DIR: fixture.liveCache,
    },
  });
}

async function startFixtureLockHolder(lockPath: string): Promise<ChildProcess> {
  const holder = spawn('bash', ['-c', `exec {lock_fd}<"$1"
flock -n "$lock_fd"
printf '%s\\n' held
read -r _`, '--', lockPath], { stdio: ['pipe', 'pipe', 'pipe'] });

  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('fixture lock holder did not acquire its lock')), 1_000);
    holder.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    holder.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`fixture lock holder exited before acquiring its lock: ${code}`));
    });
    holder.stdout?.on('data', chunk => {
      output += chunk;
      if (output.includes('held\n')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  return holder;
}

async function stopFixtureLockHolder(holder: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.once('exit', () => resolve());
    holder.stdin?.end('\n');
  });
}

async function stopFixtureBackgroundDescendant(pid: number): Promise<void> {
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

async function waitForFixtureFile(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const waitForFile = () => {
      if (existsSync(path)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`fixture file was not created: ${path}`));
        return;
      }
      setTimeout(waitForFile, 10);
    };
    waitForFile();
  });
}

// The real-model lane (scripts/run-model-integration-tests.sh) runs on the Linux server only: it takes its lock with flock and checks
// it through /proc, neither of which macOS has.
describe.skipIf(process.platform !== 'linux')('real-model test runner', () => {
  it('forwards reporter and result-file arguments through the npm workspace boundary', () => {
    const fixture = createNpmWorkspaceRunnerFixture();

    const result = runRunnerAgainstNpmWorkspace(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const capturedArgs: string[] = JSON.parse(readFileSync(fixture.capturedArgs, 'utf8'));
    expect(capturedArgs).toHaveLength(4);
    expect(capturedArgs.slice(0, 3)).toEqual([
      '--no-cache',
      '--reporter=verbose',
      '--reporter=json',
    ]);
    expect(capturedArgs[3].startsWith(
      `--outputFile.json=${fixture.temporaryDir}/vault-engine-model-tests.`,
    )).toBe(true);
  });

  it('runs exact seven-pass model tests in a canonical, private, cacheless environment', () => {
    const fixture = createRunnerFixture();

    const result = runRunner(fixture, { reportJson: exactSuccessReport });

    expect(result.status).toBe(0);
    expect(existsSync(fixture.npmMarker)).toBe(true);
    expect(readFileSync(fixture.testCacheCapture, 'utf8')).toBe(realpathSync(fixture.testCache));
    expect(readFileSync(fixture.liveCacheCapture, 'utf8')).toBe('unset');
    expect(readFileSync(fixture.offlineCapture, 'utf8')).toBe('1');
    expect(readFileSync(fixture.argsCapture, 'utf8')).toContain('--no-cache');
    expect(readFileSync(fixture.resultModeCapture, 'utf8').trim()).toBe('600');
    expect(readdirSync(fixture.temporaryDir).filter(name => name.startsWith('vault-engine-model-tests.'))).toEqual([]);
  });

  it('fails before npm when the deployment lock file is missing', () => {
    const fixture = createRunnerFixture();
    rmSync(fixture.deployLockPath);

    const result = runRunner(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('existing regular lock file is required');
    expect(existsSync(fixture.npmMarker)).toBe(false);
  });

  it('fails before npm when a deployment holds the checkout lock', async () => {
    const fixture = createRunnerFixture();
    const holder = await startFixtureLockHolder(fixture.deployLockPath);

    try {
      const result = runRunner(fixture);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('deployment/model-validation lock is held');
      expect(existsSync(fixture.npmMarker)).toBe(false);
    } finally {
      await stopFixtureLockHolder(holder);
    }
  });

  it('holds the checkout lock while the model command executes', () => {
    const fixture = createRunnerFixture();

    const result = runRunner(fixture, { reportJson: exactSuccessReport });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.lockObservation, 'utf8')).toBe('held');
  });

  it('does not expose the checkout lock descriptor to fake npm', () => {
    const fixture = createRunnerFixture();

    const result = runRunner(fixture, { reportJson: exactSuccessReport });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.lockFdObservation, 'utf8')).toBe('absent');
  });

  it('does not expose the checkout lock to npm version descendants', async () => {
    const fixture = createRunnerFixture();
    let descendantPid: number | undefined;

    try {
      const result = runRunner(fixture, { reportJson: exactSuccessReport, versionBackgroundDescendant: true });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(fixture.versionLockFdObservation, 'utf8')).toBe('absent');
      descendantPid = Number(readFileSync(fixture.versionBackgroundDescendantPid, 'utf8'));
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(() => process.kill(descendantPid!, 0)).not.toThrow();

      await waitForFixtureFile(fixture.versionBackgroundDescendantReady);

      const holder = await startFixtureLockHolder(fixture.deployLockPath);
      try {
        expect(readFileSync(fixture.versionBackgroundDescendantLockState, 'utf8')).toBe('absent');
      } finally {
        await stopFixtureLockHolder(holder);
      }
    } finally {
      if (descendantPid !== undefined) await stopFixtureBackgroundDescendant(descendantPid);
    }
  });

  it('releases the checkout lock when an npm descendant outlives the runner', async () => {
    const fixture = createRunnerFixture();
    let descendantPid: number | undefined;

    try {
      const result = runRunner(fixture, { backgroundDescendant: true, reportJson: exactSuccessReport });

      expect(result.status, result.stderr).toBe(0);
      descendantPid = Number(readFileSync(fixture.backgroundDescendantPid, 'utf8'));
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(() => process.kill(descendantPid!, 0)).not.toThrow();

      await waitForFixtureFile(fixture.backgroundDescendantReady);

      const holder = await startFixtureLockHolder(fixture.deployLockPath);
      try {
        expect(readFileSync(fixture.backgroundDescendantLockState, 'utf8')).toBe('absent');
      } finally {
        await stopFixtureLockHolder(holder);
      }
    } finally {
      if (descendantPid !== undefined) await stopFixtureBackgroundDescendant(descendantPid);
    }
  });

  it('rejects a successful Vitest run with a pending model test', () => {
    const fixture = createRunnerFixture();

    const result = runRunner(fixture, {
      reportJson: JSON.stringify({
        numTotalTests: 7,
        numPassedTests: 6,
        numFailedTests: 0,
        numPendingTests: 1,
        numTodoTests: 0,
        success: true,
      }),
    });

    expect(result.status).toBe(1);
    expect(existsSync(fixture.npmMarker)).toBe(true);
  });

  it('rejects a successful Vitest run with a malformed result report', () => {
    const fixture = createRunnerFixture();

    const result = runRunner(fixture, { reportJson: '{not-json' });

    expect(result.status).toBe(1);
    expect(existsSync(fixture.npmMarker)).toBe(true);
  });

  it('forces the model suite offline and preserves its nonzero Vitest exit code', () => {
    const fixture = createRunnerFixture();

    const result = runRunner(fixture, { npmExit: fixture.npmExit });

    expect(result.status).toBe(fixture.npmExit);
    expect(readFileSync(fixture.offlineCapture, 'utf8')).toBe('1');
    expect(readdirSync(fixture.temporaryDir).filter(name => name.startsWith('vault-engine-model-tests.'))).toEqual([]);
  });

  it('cleans up the private result file when permission hardening fails', () => {
    const fixture = createRunnerFixture();
    writeExecutable(join(fixture.fakeBin, 'chmod'), '#!/usr/bin/env bash\nexit 31\n');

    const result = runRunner(fixture);

    expect(result.status).toBe(31);
    expect(readdirSync(fixture.temporaryDir).filter(name => name.startsWith('vault-engine-model-tests.'))).toEqual([]);
  });

  it('rejects compiled closure changes introduced during otherwise successful model validation', () => {
    const fixture = createRunnerFixture();

    const result = runRunner(fixture, {
      mutateCompiledPath: fixture.chunkerPath,
      reportJson: exactSuccessReport,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('compiled worker provenance changed during model validation');
  });

  it('preserves a failing Vitest exit when compiled closure changes during validation', () => {
    const fixture = createRunnerFixture();

    const result = runRunner(fixture, {
      mutateCompiledPath: fixture.chunkerPath,
      npmExit: fixture.npmExit,
    });

    expect(result.status).toBe(fixture.npmExit);
  });

  it('rejects a coherently rewritten attestation after otherwise successful model validation', () => {
    const fixture = createRunnerFixture();

    const result = runRunner(fixture, {
      coherentTransitionPath: fixture.chunkerPath,
      reportJson: exactSuccessReport,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('compiled worker provenance changed during model validation');
  });

  it('preserves a failing Vitest exit when its attestation changes coherently', () => {
    const fixture = createRunnerFixture();

    const result = runRunner(fixture, {
      coherentTransitionPath: fixture.chunkerPath,
      npmExit: fixture.npmExit,
    });

    expect(result.status).toBe(fixture.npmExit);
  });

  it('fails closed when start-time metadata cannot be collected', () => {
    const fixture = createRunnerFixture();
    writeExecutable(join(fixture.fakeBin, 'date'), '#!/usr/bin/env bash\nexit 19\n');

    const result = runRunner(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not collect start time metadata');
    expect(existsSync(fixture.npmMarker)).toBe(false);
  });

  it('rejects a stale compiled worker before invoking npm', () => {
    const fixture = createRunnerFixture();
    writeFileSync(fixture.workerPath, 'worker changed after build');

    const result = runRunner(fixture);

    expect(result.status).toBe(1);
    expect(existsSync(fixture.npmMarker)).toBe(false);
  });

  it('rejects worker provenance written from a dirty checkout before invoking npm', () => {
    const fixture = createRunnerFixture();
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
    manifest.trackedClean = false;
    writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest)}\n`);

    const result = runRunner(fixture);

    expect(result.status).toBe(1);
    expect(existsSync(fixture.npmMarker)).toBe(false);
  });
});
