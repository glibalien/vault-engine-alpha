import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTree, removeTrees, REPO_ROOT } from './helpers.js';

afterEach(removeTrees);

const NO_SIDE_EFFECTS = ['--no-pull', '--skip-install', '--no-restart'];

async function executable(path: string, body: string) {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

function git(dir: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A throwaway git checkout holding scripts/deploy.sh, with npm, node, the smoke script,
 * sudo, systemctl, curl and journalctl replaced by fakes that log to calls.log. The fakes
 * read FAKE_* variables: FAKE_NPM_CI_EXIT, FAKE_BUILD_EXIT, FAKE_SMOKE_EXIT, FAKE_NODE_ABI,
 * FAKE_CURL_CODE and FAKE_JOURNAL.
 */
async function checkout() {
  const root = await makeTree({
    'package-lock.json': '{"lockfileVersion":3}\n',
    'packages/obsidian-plugin/main.js': 'main\n',
    'packages/obsidian-plugin/manifest.json': '{}\n',
    'packages/obsidian-plugin/styles.css': 'css\n',
  });
  await mkdir(join(root, 'scripts'));
  for (const file of ['deploy.sh', 'model-validation-deployment-lock.sh']) {
    await copyFile(join(REPO_ROOT, 'scripts', file), join(root, 'scripts', file));
  }
  const bin = await makeTree({});
  const log = join(bin, 'calls.log');
  await executable(join(root, 'scripts', 'smoke.sh'), `echo "smoke SMOKE_CURATOR=$SMOKE_CURATOR" >> ${log}\nexit "\${FAKE_SMOKE_EXIT:-0}"`);
  await executable(join(bin, 'npm'), [
    `echo "npm $*" >> ${log}`,
    'case "$*" in',
    '  ci) exit "${FAKE_NPM_CI_EXIT:-0}" ;;',
    '  "run build") exit "${FAKE_BUILD_EXIT:-0}" ;;',
    'esac',
  ].join('\n'));
  await executable(join(bin, 'node'), 'echo "${FAKE_NODE_ABI:-137}"');
  await executable(join(bin, 'sudo'), `echo "sudo $*" >> ${log}\nexec "$@"`);
  await executable(join(bin, 'systemctl'), `echo "systemctl $*" >> ${log}\n[ "$1" = show ] && echo 10min\nexit 0`);
  await executable(join(bin, 'curl'), 'printf "%s" "${FAKE_CURL_CODE:-200}"');
  await executable(join(bin, 'journalctl'), [
    '[ -n "$FAKE_JOURNAL" ] && printf "%s\\n" "$FAKE_JOURNAL"',
    // exec, so a broken pipe kills this process the way it kills the real journalctl.
    '[ -n "$FAKE_JOURNAL_MORE_LINES" ] && exec seq 1 "$FAKE_JOURNAL_MORE_LINES"',
    'exit 0',
  ].join('\n'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');

  const run = async (args: string[], env: Record<string, string> = {}, cwd?: string) => {
    const result = spawnSync('bash', [join(root, 'scripts', 'deploy.sh'), ...args], {
      env: { PATH: `${bin}:/usr/bin:/bin`, ALLOW_NON_PROD: '1', ...env },
      encoding: 'utf8',
      cwd,
    });
    const calls = await readFile(log, 'utf8').then(text => text.trim().split('\n').filter(Boolean), (): string[] => []);
    await writeFile(log, '');
    return { ...result, calls };
  };
  return { root, run };
}

// deploy.sh deploys the Linux server: it restarts systemd units and takes the deployment
// lock with flock, which macOS does not have.
describe.skipIf(process.platform !== 'linux')('scripts/deploy.sh', () => {
  it('restarts the reference deployment\'s units by default and smokes Curator', async () => {
    const { run } = await checkout();
    const { status, stdout, calls } = await run(NO_SIDE_EFFECTS);

    expect(status).toBe(0);
    expect(calls).toEqual(['npm run build', 'smoke SMOKE_CURATOR=1']);
    expect(stdout).toContain('sudo systemctl restart vault-engine-new vault-curator');
  });

  it('takes the installer\'s unit names, and skips Curator, smoke included, when it has none', async () => {
    const { run } = await checkout();
    const { status, stdout, calls } = await run(NO_SIDE_EFFECTS, { ENGINE_SERVICE: 'vault-engine', CURATOR_SERVICE: '' });

    expect(status).toBe(0);
    expect(calls).toEqual(['npm run build', 'smoke SMOKE_CURATOR=0']);
    expect(stdout).toMatch(/sudo systemctl restart vault-engine$/m);
  });

  describe('npm ci', () => {
    const args = ['--no-pull', '--no-restart'];

    it('runs without a record of a completed install, then not again for the same lockfile and Node ABI', async () => {
      const { run } = await checkout();

      const first = await run(args);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain('npm ci (no record of a completed install)');
      expect(first.calls).toContain('npm ci');

      const second = await run(args);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain('npm ci skipped (node_modules matches package-lock.json and Node ABI 137)');
      expect(second.calls).not.toContain('npm ci');
    });

    it('runs again when package-lock.json changes, with or without a pull', async () => {
      const { root, run } = await checkout();
      await run(args);
      await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');

      const { status, stdout, calls } = await run(args);
      expect(status).toBe(0);
      expect(stdout).toContain('npm ci (package-lock.json changed)');
      expect(calls).toContain('npm ci');
    });

    it('runs again after a Node major upgrade', async () => {
      const { run } = await checkout();
      await run(args);

      const { status, stdout, calls } = await run(args, { FAKE_NODE_ABI: '141' });
      expect(status).toBe(0);
      expect(stdout).toContain('npm ci (Node ABI changed from 137 to 141)');
      expect(calls).toContain('npm ci');
    });

    it('runs again on the next deploy after an install that failed', async () => {
      const { run } = await checkout();
      const failed = await run(args, { FAKE_NPM_CI_EXIT: '1' });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('npm ci failed; nothing was restarted.');
      expect(failed.calls).not.toContain('npm run build');

      const { status, calls } = await run(args);
      expect(status).toBe(0);
      expect(calls).toContain('npm ci');
    });
  });

  it('prints the command that puts the checkout back when the smoke fails after a pull', async () => {
    const { root, run } = await checkout();
    const before = git(root, 'rev-parse', 'HEAD');
    const upstream = join(await makeTree({}), 'origin.git');
    git(root, 'clone', '-q', '--bare', root, upstream);
    git(root, 'remote', 'add', 'origin', upstream);
    git(root, 'fetch', '-q', 'origin');
    git(root, 'branch', '-q', '-u', 'origin/main');
    const other = join(await makeTree({}), 'other');
    git(root, 'clone', '-q', upstream, other);
    await writeFile(join(other, 'change.txt'), 'new\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'change');
    git(other, 'push', '-q', 'origin', 'main');
    const after = git(other, 'rev-parse', 'HEAD');

    const { status, stderr, calls } = await run(['--skip-install'], { FAKE_SMOKE_EXIT: '1' });

    expect(status).toBe(1);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(after);
    expect(stderr).toContain('smoke failed; nothing was restarted.');
    expect(stderr).toContain(`from ${before.slice(0, 12)} to ${after.slice(0, 12)}`);
    expect(stderr).toContain(`git -C ${root} reset --hard ${before} && PROD_ROOT=${root} ${root}/scripts/deploy.sh --no-pull --no-restart`);
    expect(calls.some(call => call.startsWith('sudo'))).toBe(false);
  });

  it('says nothing about putting the checkout back when no pull moved it', async () => {
    const { run } = await checkout();
    const { status, stderr } = await run(['--no-pull', '--skip-install'], { FAKE_BUILD_EXIT: '1' });

    expect(status).toBe(1);
    expect(stderr).toContain('build failed; nothing was restarted.');
    expect(stderr).not.toContain('reset --hard');
  });

  describe('restart', () => {
    const args = ['--no-pull', '--skip-install'];

    it('waits until Engine and Curator answer on their ports before reporting success', async () => {
      const { run } = await checkout();
      const { status, stdout, calls } = await run(args);

      expect(status, stdout).toBe(0);
      expect(calls).toContain('sudo systemctl restart vault-engine-new vault-curator');
      expect(stdout).toContain('Curator stops only after any curation in flight finishes (up to 10min).');
      expect(stdout).toMatch(/✓ vault-engine-new answering on :3334/);
      expect(stdout).toMatch(/✓ vault-curator answering on :3335/);
      expect(stdout).toContain('✓ deployed + restarted');
    });

    it('fails with the unit\'s log when a service does not answer in time', async () => {
      const { run } = await checkout();
      const { status, stdout, stderr } = await run(args, {
        FAKE_CURL_CODE: '000', HEALTH_TIMEOUT: '1', FAKE_JOURNAL: 'engine: boom',
      });

      expect(status).toBe(1);
      expect(stderr).toContain('vault-engine-new did not answer on :3334 within 1s (last HTTP code \'000\')');
      expect(stderr).toContain('engine: boom');
      expect(stdout).not.toContain('✓ deployed');
    });

    it('warns when a service was killed for not stopping in time', async () => {
      const { run } = await checkout();
      const { status, stderr } = await run(args, {
        FAKE_JOURNAL: "vault-curator.service: State 'stop-sigterm' timed out. Killing.",
      });

      expect(status).toBe(0);
      expect(stderr).toContain('vault-curator did not stop within its stop timeout and was killed');
    });

    it('still warns when a long journal follows the timeout line', async () => {
      const { run } = await checkout();
      const { status, stderr } = await run(args, {
        FAKE_JOURNAL: "vault-curator.service: State 'stop-sigterm' timed out. Killing.",
        FAKE_JOURNAL_MORE_LINES: '200000',
      });

      expect(status).toBe(0);
      expect(stderr).toContain('vault-curator did not stop within its stop timeout and was killed');
    });
  });

  describe('PLUGIN_DIR', () => {
    it('builds the plugin before the smoke and copies it once the services answer', async () => {
      const { run } = await checkout();
      const dest = await makeTree({});
      const { status, stdout, calls } = await run(['--no-pull', '--skip-install'], { PLUGIN_DIR: dest });

      expect(status, stdout).toBe(0);
      expect(calls.indexOf('npm run build -w vault-obsidian')).toBeGreaterThan(-1);
      expect(calls.indexOf('npm run build -w vault-obsidian')).toBeLessThan(calls.indexOf('smoke SMOKE_CURATOR=1'));
      expect(await readFile(join(dest, 'main.js'), 'utf8')).toBe('main\n');
      expect(await readFile(join(dest, 'manifest.json'), 'utf8')).toBe('{}\n');
      expect(await readFile(join(dest, 'styles.css'), 'utf8')).toBe('css\n');
      expect(stdout).toContain(`✓ Obsidian plugin copied to ${dest}`);
    });

    it('reads a relative path from the caller\'s directory, not the checkout', async () => {
      const { root, run } = await checkout();
      const caller = await makeTree({ 'plugins/': '' });
      await mkdir(join(root, 'plugins'));
      const { status, stdout } = await run(['--no-pull', '--skip-install'], { PLUGIN_DIR: 'plugins' }, caller);

      expect(status, stdout).toBe(0);
      expect(await readFile(join(caller, 'plugins', 'main.js'), 'utf8')).toBe('main\n');
      await expect(readFile(join(root, 'plugins', 'main.js'))).rejects.toThrow();
      expect(stdout).toContain(`✓ Obsidian plugin copied to ${join(caller, 'plugins')}`);
    });

    it('does not copy the plugin when a service does not answer', async () => {
      const { run } = await checkout();
      const dest = await makeTree({});
      const { status } = await run(['--no-pull', '--skip-install'], { PLUGIN_DIR: dest, FAKE_CURL_CODE: '000', HEALTH_TIMEOUT: '1' });

      expect(status).toBe(1);
      await expect(readFile(join(dest, 'main.js'))).rejects.toThrow();
    });

    it('prints the copy command with --no-restart instead of copying', async () => {
      const { root, run } = await checkout();
      const dest = await makeTree({});
      const { status, stdout } = await run(NO_SIDE_EFFECTS, { PLUGIN_DIR: dest });

      expect(status).toBe(0);
      expect(stdout).toContain(`cp ${root}/packages/obsidian-plugin/main.js ${root}/packages/obsidian-plugin/manifest.json ${root}/packages/obsidian-plugin/styles.css ${dest}/`);
      await expect(readFile(join(dest, 'main.js'))).rejects.toThrow();
    });

    it('refuses to start when it is not a directory', async () => {
      const { root, run } = await checkout();
      const { status, stderr, calls } = await run(NO_SIDE_EFFECTS, { PLUGIN_DIR: join(root, 'missing') });

      expect(status).toBe(2);
      expect(stderr).toContain('PLUGIN_DIR is not a directory');
      expect(calls).toEqual([]);
    });
  });
});
