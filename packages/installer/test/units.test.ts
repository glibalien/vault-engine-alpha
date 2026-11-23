import { describe, expect, it } from 'vitest';
import { renderCuratorUnit, renderEngineUnit, UnitError, type ServiceSpec } from '../src/units.js';

const SPEC: ServiceSpec = {
  unit: 'vault-engine.service',
  user: 'sam',
  nodePath: '/srv/sam/.local/share/mise/installs/node/24.11.0/bin/node',
  repoRoot: '/srv/sam/vault-suite',
  dataDir: '/srv/sam/vault-suite-data',
  port: 3334,
};

describe('service units', () => {
  it('runs Engine on the pinned Node binary from the data directory', () => {
    expect(renderEngineUnit(SPEC)).toBe([
      '# Written by vault-installer.',
      '[Unit]',
      'Description=Vault Engine',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      'User=sam',
      'WorkingDirectory=/srv/sam/vault-suite-data',
      'EnvironmentFile=/srv/sam/vault-suite-data/engine.env',
      'ExecStart=/srv/sam/.local/share/mise/installs/node/24.11.0/bin/node /srv/sam/vault-suite/packages/engine/dist/index.js --transport http --port 3334',
      'Restart=on-failure',
      'RestartSec=10',
      'NoNewPrivileges=true',
      'PrivateTmp=true',
      'ProtectSystem=full',
      'UMask=0077',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n'));
  });

  it('starts Curator after Engine', () => {
    const unit = renderCuratorUnit({ ...SPEC, unit: 'vault-curator.service', port: 3335 });

    expect(unit).toContain('After=network-online.target vault-engine.service\nWants=network-online.target vault-engine.service\n');
    expect(unit).toContain('EnvironmentFile=/srv/sam/vault-suite-data/curator.env\n');
    expect(unit).toContain('ExecStart=/srv/sam/.local/share/mise/installs/node/24.11.0/bin/node /srv/sam/vault-suite/packages/curator/dist/server.js\n');
    expect(unit).toContain('Restart=always\n');
  });

  it('escapes specifiers and quotes arguments with spaces', () => {
    const unit = renderEngineUnit({ ...SPEC, repoRoot: '/srv/sam/My Code/100% "suite"', dataDir: '/srv/sam/data 50%', nodePath: '/opt/n$de/node' });

    expect(unit).toContain('WorkingDirectory=/srv/sam/data 50%%\n');
    expect(unit).toContain('EnvironmentFile=/srv/sam/data 50%%/engine.env\n');
    expect(unit).toContain('ExecStart=/opt/n$$de/node "/srv/sam/My Code/100%% \\"suite\\"/packages/engine/dist/index.js" --transport http');
  });

  it.each([
    [{ user: 'root; rm' }],
    [{ dataDir: '/data\nExecStartPre=/bin/sh' }],
    [{ dataDir: ' /data' }],
    [{ repoRoot: '/repo\n' }],
  ])('refuses %j', overrides => {
    expect(() => renderEngineUnit({ ...SPEC, ...overrides })).toThrow(UnitError);
  });
});
