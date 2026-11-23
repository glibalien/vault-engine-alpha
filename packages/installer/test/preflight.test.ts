import { describe, expect, it } from 'vitest';
import { hasFailures, runPreflight, type PreflightOptions } from '../src/preflight.js';
import { fakeHost } from './helpers.js';

const OPTIONS: PreflightOptions = {
  repoRoot: '/repo',
  dataDir: '/srv/tester/vault-suite-data',
  requiredNodeMajor: 24,
  enginePort: 3334,
  curatorPort: 3335,
  checkNetwork: true,
};

function statusOf(results: Awaited<ReturnType<typeof runPreflight>>, id: string) {
  return results.find(result => result.id === id)?.status;
}

describe('runPreflight', () => {
  it('passes every check on a healthy Linux host', async () => {
    const results = await runPreflight(fakeHost(), OPTIONS);

    expect(results.map(result => [result.id, result.status])).toEqual([
      ['platform', 'pass'],
      ['user', 'pass'],
      ['node', 'pass'],
      ['systemd', 'pass'],
      ['sudo', 'pass'],
      ['build', 'pass'],
      ['env-files', 'pass'],
      ['memory', 'pass'],
      ['disk', 'pass'],
      ['ports', 'pass'],
      ['network', 'pass'],
      ['existing', 'pass'],
    ]);
    expect(hasFailures(results)).toBe(false);
  });

  it('fails on another operating system, Node major, or a host without systemd', async () => {
    const results = await runPreflight(fakeHost({
      platform: 'freebsd',
      nodeVersion: '26.1.0',
      run: async command => (command === 'systemctl'
        ? { code: null, stdout: '', stderr: 'not found' }
        : { code: 0, stdout: '', stderr: '' }),
    }), OPTIONS);

    expect(statusOf(results, 'platform')).toBe('fail');
    expect(statusOf(results, 'node')).toBe('fail');
    expect(results.find(result => result.id === 'node')?.detail).toContain('Node.js 24');
    expect(statusOf(results, 'systemd')).toBe('fail');
    expect(hasFailures(results)).toBe(true);
  });

  describe('on macOS', () => {
    /** An Apple Silicon Mac with the user logged in; launchctl answers `print gui/501`. */
    function mac(overrides: Parameters<typeof fakeHost>[0] = {}) {
      return fakeHost({
        platform: 'darwin',
        arch: 'arm64',
        homeDir: '/srv/tester',
        uid: 501,
        run: async (command, args) => ({
          code: command === 'launchctl' && args.join(' ') === 'print gui/501' ? 0 : 1,
          stdout: '',
          stderr: '',
        }),
        pathExists: async path => path.endsWith('/dist/analyzer/cli.js'),
        ...overrides,
      });
    }

    it('passes on an Apple Silicon Mac, checking launchd instead of systemd and sudo', async () => {
      const results = await runPreflight(mac(), { ...OPTIONS, dataDir: '/srv/tester/vault-suite-data' });

      expect(results.map(result => [result.id, result.status])).toEqual([
        ['platform', 'pass'],
        ['user', 'pass'],
        ['node', 'pass'],
        ['launchd', 'pass'],
        ['build', 'pass'],
        ['env-files', 'pass'],
        ['memory', 'pass'],
        ['disk', 'pass'],
        ['ports', 'pass'],
        ['network', 'pass'],
        ['existing', 'pass'],
      ]);
      expect(results.find(result => result.id === 'platform')?.title).toBe('macOS (Apple Silicon)');
    });

    it('stops on an Intel Mac, or Node.js under Rosetta, and says why', async () => {
      const results = await runPreflight(mac({ arch: 'x64' }), OPTIONS);

      expect(results.find(result => result.id === 'platform')).toMatchObject({
        status: 'fail',
        title: 'Intel Mac',
        detail: expect.stringContaining('Rosetta'),
      });
    });

    it('stops when the user has no login session for launchd agents', async () => {
      const results = await runPreflight(mac({ run: async () => ({ code: 113, stdout: '', stderr: 'Could not find domain' }) }), OPTIONS);

      expect(results.find(result => result.id === 'launchd')).toMatchObject({ status: 'fail', title: 'No login session' });
    });

    it('finds an earlier install by its launchd agents', async () => {
      const agent = '/srv/tester/Library/LaunchAgents/vault-engine.plist';
      const results = await runPreflight(mac({
        pathExists: async path => path === agent || path.endsWith('/dist/analyzer/cli.js'),
      }), OPTIONS);

      expect(results.find(result => result.id === 'existing')).toMatchObject({
        status: 'warn',
        detail: expect.stringContaining(agent),
      });
    });
  });

  it('fails when the repository is not built', async () => {
    const results = await runPreflight(fakeHost({
      pathExists: async path => path === '/run/systemd/system',
    }), OPTIONS);

    expect(results.find(result => result.id === 'build')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('npm ci && npm run build'),
    });
  });

  it('fails when a .env file the services would also read exists', async () => {
    const strays = ['/repo/packages/engine/.env', '/srv/tester/vault-suite-data/.env'];
    const host = fakeHost();
    const results = await runPreflight(fakeHost({
      pathExists: async path => strays.includes(path) || host.pathExists(path),
    }), OPTIONS);

    expect(results.find(result => result.id === 'env-files')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('/repo/packages/engine/.env and /srv/tester/vault-suite-data/.env'),
    });
  });

  it('warns instead of failing for missing sudo, low memory or disk, and no network', async () => {
    const results = await runPreflight(fakeHost({
      run: async command => (command === 'sudo'
        ? { code: null, stdout: '', stderr: 'not found' }
        : { code: 0, stdout: '', stderr: '' }),
      memAvailableBytes: async () => 1024 ** 3,
      freeDiskBytes: async () => 512 * 1024 ** 2,
      canReach: async () => false,
    }), OPTIONS);

    expect(statusOf(results, 'sudo')).toBe('warn');
    expect(statusOf(results, 'memory')).toBe('warn');
    expect(statusOf(results, 'disk')).toBe('warn');
    expect(statusOf(results, 'network')).toBe('warn');
    expect(hasFailures(results)).toBe(false);
  });

  it('fails on busy ports unless an existing installation explains them', async () => {
    const busy = { isPortFree: async (port: number) => port !== 3334 };
    const fresh = await runPreflight(fakeHost(busy), OPTIONS);
    const existing = await runPreflight(fakeHost({
      ...busy,
      pathExists: async path => path === '/run/systemd/system'
        || path.endsWith('/dist/analyzer/cli.js')
        || path === '/etc/systemd/system/vault-engine-new.service',
    }), OPTIONS);

    expect(fresh.find(result => result.id === 'ports')).toMatchObject({ status: 'fail', title: 'Port 3334 in use' });
    expect(statusOf(existing, 'ports')).toBe('warn');
    expect(existing.find(result => result.id === 'existing')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('vault-engine-new.service'),
    });
  });

  it('skips the network probe when asked', async () => {
    let probed = false;
    const results = await runPreflight(
      fakeHost({ canReach: async () => { probed = true; return true; } }),
      { ...OPTIONS, checkNetwork: false },
    );

    expect(probed).toBe(false);
    expect(statusOf(results, 'network')).toBe('warn');
  });

  it('warns when run as root', async () => {
    const results = await runPreflight(fakeHost({ uid: 0 }), OPTIONS);

    expect(results.find(result => result.id === 'user')).toMatchObject({ status: 'warn', title: 'Running as root' });
    expect(hasFailures(results)).toBe(false);
  });

  it('warns when the pinned Node version cannot be read', async () => {
    const results = await runPreflight(fakeHost(), { ...OPTIONS, requiredNodeMajor: null });

    expect(statusOf(results, 'node')).toBe('warn');
  });
});
