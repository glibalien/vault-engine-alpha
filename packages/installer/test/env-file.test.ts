import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvFileError, parseEnvFile, renderEnvFile } from '../src/env-file.js';
import { Secret } from '../src/secret.js';
import { makeTree, removeTrees } from './helpers.js';

afterEach(removeTrees);

const VALUES = {
  PLAIN: '/srv/notes/vault.db',
  SPACES: '/srv/sam/My Vault',
  DOLLAR: 'a$b`c\\d"e',
  APOSTROPHE: "/srv/sam/Sam's Notes",
  BOTH: `it's "$HOME"\\`,
  EMPTY: '',
  PERCENT: '50%',
};

describe('renderEnvFile', () => {
  it('writes plain values bare and quotes the rest', () => {
    const text = renderEnvFile(['Written by a test.'], Object.entries(VALUES).map(([name, value]) => ({ name, value })));

    expect(text).toBe([
      '# Written by a test.',
      '',
      'PLAIN=/srv/notes/vault.db',
      "SPACES='/srv/sam/My Vault'",
      "DOLLAR='a$b`c\\d\"e'",
      `APOSTROPHE="/srv/sam/Sam's Notes"`,
      `BOTH="it's \\"\\$HOME\\"\\\\"`,
      'EMPTY=',
      'PERCENT=50%',
      '',
    ].join('\n'));
    expect(Object.fromEntries(parseEnvFile(text))).toEqual(VALUES);
  });

  it('reads back the same values as a POSIX shell', async () => {
    const directory = await makeTree({});
    const path = join(directory, 'test.env');
    await writeFile(path, renderEnvFile([], Object.entries(VALUES).map(([name, value]) => ({ name, value }))));

    const script = `set -a; . "$1"; ${Object.keys(VALUES).map(name => `printf '%s\\0' "$${name}"`).join('; ')}`;
    const { stdout } = await promisify(execFile)('sh', ['-c', script, 'sh', path]);

    expect(stdout.split('\0').slice(0, -1)).toEqual(Object.values(VALUES));
  });

  it('reveals a secret only in the rendered file and never names it in an error', () => {
    const secret = new Secret('sk-secret\nvalue');

    expect(renderEnvFile([], [{ name: 'KEY', value: new Secret('sk-secret') }])).toBe('KEY=sk-secret\n');
    expect(() => renderEnvFile([], [{ name: 'KEY', value: secret }])).toThrow(EnvFileError);
    expect(() => renderEnvFile([], [{ name: 'KEY', value: secret }])).toThrow(/^KEY contains a line break/);
    try {
      renderEnvFile([], [{ name: 'KEY', value: secret }]);
    } catch (error) {
      expect((error as Error).message).not.toContain('sk-secret');
    }
  });

  describe('for Node\'s --env-file (launchd agents)', () => {
    // Node's parser has no escapes, so these take whichever quote they do not contain.
    const NODE_VALUES = {
      PLAIN: '/srv/notes/vault.db',
      SPACES: '/srv/sam/My Vault',
      DOLLAR: 'a$b"c\\d',
      APOSTROPHE: "/srv/sam/Sam's Notes",
      APOSTROPHE_BACKTICK: "it's `x` $HOME",
      NEWLINE_ESCAPE: "it's a\\nb",
      HASH: 'a #b',
      EMPTY: '',
      PERCENT: '50%',
    };

    it('quotes each value so Node reads it back verbatim', async () => {
      const text = renderEnvFile(['Written by a test.'], Object.entries(NODE_VALUES).map(([name, value]) => ({ name, value })), 'node');

      expect(text).toBe([
        '# Written by a test.',
        '',
        'PLAIN=/srv/notes/vault.db',
        "SPACES='/srv/sam/My Vault'",
        "DOLLAR='a$b\"c\\d'",
        "APOSTROPHE=`/srv/sam/Sam's Notes`",
        `APOSTROPHE_BACKTICK="it's \`x\` $HOME"`,
        "NEWLINE_ESCAPE=`it's a\\nb`",
        "HASH='a #b'",
        'EMPTY=',
        'PERCENT=50%',
        '',
      ].join('\n'));
      expect(Object.fromEntries(parseEnvFile(text))).toEqual(NODE_VALUES);

      const directory = await makeTree({});
      const path = join(directory, 'test.env');
      await writeFile(path, text);
      const { stdout } = await promisify(execFile)(process.execPath, [
        `--env-file=${path}`,
        '-e',
        `process.stdout.write(JSON.stringify(${JSON.stringify(Object.keys(NODE_VALUES))}.map(name => process.env[name])))`,
      ], { env: {} });
      expect(JSON.parse(stdout)).toEqual(Object.values(NODE_VALUES));
    });

    it('refuses a value no Node quote can hold, without showing it', () => {
      const value = new Secret('a\'b`c"d');

      expect(() => renderEnvFile([], [{ name: 'KEY', value }], 'node')).toThrow(/^KEY holds ', ` and " or \\ together/);
      try {
        renderEnvFile([], [{ name: 'KEY', value }], 'node');
      } catch (error) {
        expect((error as Error).message).not.toContain('a\'b');
      }
    });
  });

  it.each([
    [[{ name: '1BAD', value: 'x' }], /invalid variable name/],
    [[{ name: 'A', value: 'x' }, { name: 'A', value: 'y' }], /set twice/],
  ])('refuses %j', (entries, message) => {
    expect(() => renderEnvFile([], entries)).toThrow(message);
  });
});
