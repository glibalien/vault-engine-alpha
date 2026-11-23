// Tests for the repository-safety lint. Dependency-free: node --test.
//
// No usable credential is embedded here. Secret-shaped samples are synthetic
// and only exercise rule shapes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isForbiddenTrackedPath,
  scanTrackedFile,
  isHistoricalRecord,
  looksLikeRandomNodeId,
} from './repository-safety-rules.mjs';
import {
  formatFinding,
  formatTermFindings,
  listTrackedFiles,
  resolveRepoRoot,
  runCheck,
  scanPaths,
} from './check-repository-safety.mjs';
import { createMatcher } from './private-terms.mjs';

// The owner-name rule takes its names from outside the repository; these stand in for them.
const OWNER_DISPLAY_NAME = 'Quillon';
const OWNER_NAMES = { ownerNames: [OWNER_DISPLAY_NAME, 'Tessaly-Vane'] };

const buf = (text) => Buffer.from(text, 'utf8');
const ruleIds = (path, text) => scanTrackedFile(path, buf(text), OWNER_NAMES).map((f) => f.ruleId);
// Assemble secret-shaped samples from parts so this tracked test file does not
// itself trip the lint it exercises.
const j = (...parts) => parts.join('');

test('forbidden filename classes are rejected', () => {
  assert.equal(isForbiddenTrackedPath('.env'), 'forbidden-env-file');
  assert.equal(isForbiddenTrackedPath('.env.local'), 'forbidden-env-file');
  assert.equal(isForbiddenTrackedPath('config/production.env'), 'forbidden-env-file');
  assert.equal(isForbiddenTrackedPath('deploy/engine.env'), 'forbidden-env-file');
  assert.equal(isForbiddenTrackedPath('packages/engine/prod.db'), 'forbidden-secret-file');
  assert.equal(isForbiddenTrackedPath('data/vault.sqlite3'), 'forbidden-secret-file');
  assert.equal(isForbiddenTrackedPath('data/vault.sqlite-wal'), 'forbidden-secret-file');
  assert.equal(isForbiddenTrackedPath('data/vault.sqlite3-shm'), 'forbidden-secret-file');
  assert.equal(isForbiddenTrackedPath('data/vault.db-journal'), 'forbidden-secret-file');
  assert.equal(isForbiddenTrackedPath('backups/vault.db.gz'), 'forbidden-secret-file');
  assert.equal(isForbiddenTrackedPath('backups/vault.sqlite.zip'), 'forbidden-secret-file');
  assert.equal(isForbiddenTrackedPath('keys/id_rsa'), 'forbidden-private-key');
  assert.equal(isForbiddenTrackedPath('certs/server.pem'), 'forbidden-secret-file');
  assert.equal(isForbiddenTrackedPath('certs/client.p12'), 'forbidden-secret-file');
  assert.equal(isForbiddenTrackedPath('vault/.obsidian/data.json'), 'forbidden-obsidian-data');
  assert.equal(isForbiddenTrackedPath('home/.aws/credentials'), 'forbidden-credential-store');
  assert.equal(isForbiddenTrackedPath('.docker/config.json'), 'forbidden-credential-store');
  assert.equal(isForbiddenTrackedPath('.ssh/custom_deploy_key'), 'forbidden-credential-store');
  assert.equal(
    isForbiddenTrackedPath('packages/curator/eval/corpus.json'),
    'forbidden-local-eval-corpus',
  );
  assert.equal(isForbiddenTrackedPath('backups/vault.bak'), 'forbidden-secret-file');
  assert.equal(isForbiddenTrackedPath('keys/deploy.ppk'), 'forbidden-secret-file');
});

test('forbidden filename checks are case-insensitive', () => {
  assert.equal(isForbiddenTrackedPath('.ENV'), 'forbidden-env-file');
  assert.equal(isForbiddenTrackedPath('keys/ID_RSA'), 'forbidden-private-key');
  assert.equal(isForbiddenTrackedPath('vault/.Obsidian/Data.json'), 'forbidden-obsidian-data');
  assert.equal(isForbiddenTrackedPath('.DOCKERCFG'), 'forbidden-credential-store');
});

test('allowed filenames are accepted', () => {
  assert.equal(isForbiddenTrackedPath('.env.example'), null);
  assert.equal(isForbiddenTrackedPath('packages/engine/.env.example'), null);
  assert.equal(isForbiddenTrackedPath('config/data.json'), null);
  assert.equal(isForbiddenTrackedPath('keys/id_rsa.pub'), null);
  assert.equal(isForbiddenTrackedPath('packages/bench/src/cli.ts'), null);
  assert.equal(isForbiddenTrackedPath('scripts/env.mjs'), null);
});

test('pem private-key headers are rejected', () => {
  assert.deepEqual(ruleIds('x.txt', j('-----BEGIN ', 'RSA ', 'PRIVATE KEY-----')), ['pem-private-key']);
  assert.deepEqual(ruleIds('x.txt', j('-----BEGIN ', 'ENCRYPTED ', 'PRIVATE KEY-----')), ['pem-private-key']);
});

test('putty private keys are rejected', () => {
  assert.deepEqual(ruleIds('x.txt', j('PuTTY-User-Key-File-', '3: ssh-rsa')), ['putty-private-key']);
});

test('recognizable provider/secret patterns are rejected', () => {
  assert.ok(ruleIds('x.ts', `const k = "${j('AKIA', 'IOSFODNN7EXAMPLE')}";`).includes('aws-access-key-id'));
  assert.ok(ruleIds('x.ts', `const k = "${j('ASIA', 'IOSFODNN7EXAMPLE')}";`).includes('aws-access-key-id'));
  assert.ok(ruleIds('x.ts', `const k = "ghp_${'a'.repeat(36)}";`).includes('github-token'));
  assert.ok(
    ruleIds('x.ts', `const k = "${j('ghp_', 'a'.repeat(17), '_', 'b'.repeat(18))}";`).includes('github-token'),
  );
  assert.ok(ruleIds('x.ts', `const k = "${j('ghr_', 'a'.repeat(76))}";`).includes('github-token'));
  assert.ok(
    ruleIds('x.ts', `const k = "${j('ghr_', 'a'.repeat(38), '_', 'b'.repeat(37))}";`).includes('github-token'),
  );
  assert.ok(
    ruleIds('x.ts', `const k = "${j('ghs_', '123456_', 'a'.repeat(24), '.', 'b'.repeat(24), '.', 'c'.repeat(24))}";`).includes(
      'github-token',
    ),
  );
  assert.ok(ruleIds('x.ts', `const k = "sk-ant-api03-${'a'.repeat(24)}";`).includes('provider-api-key'));
  const googleKey = j('AI', 'za', 'AbCdEfGhIjKlMnOpQrStUvWxYz123456789');
  assert.ok(ruleIds('x.txt', `GET /resource?key=${googleKey}`).includes('provider-api-key'));
  const googleKeyEndingInHyphen = j('AI', 'za', `${'A'.repeat(34)}-`);
  assert.ok(ruleIds('x.txt', `key=${googleKeyEndingInHyphen};`).includes('provider-api-key'));
});

test('GitHub token detection is prefix-aware without flagging placeholders', () => {
  assert.deepEqual(ruleIds('x.md', 'ghp_example-placeholder-token'), []);
  assert.deepEqual(ruleIds('x.md', 'ghu_REPLACE_WITH_GITHUB_TOKEN'), []);
  assert.deepEqual(ruleIds('x.md', 'ghs_example-installation-token'), []);
  assert.deepEqual(ruleIds('x.md', `ghp_${'a'.repeat(35)}`), []);
  assert.deepEqual(ruleIds('x.md', `ghr_${'a'.repeat(75)}`), []);
});

test('long bearer/secret assignment is rejected but slugs are not', () => {
  const token = j('aB3xY9kLmN2', 'pQ7rT5vW8zC1dE4fG6hJ0');
  assert.ok(ruleIds('x.ts', `const apiKey = "${token}";`).includes('bearer-token-assignment'));
  // Separators alone are not proof of safety: an opaque value with `_` is still flagged.
  assert.ok(
    ruleIds('x.ts', `const apiKey = "${j('abCDefghijklmnopqrstuvwx', '_123456')}";`).includes(
      'bearer-token-assignment',
    ),
  );
  assert.deepEqual(ruleIds('x.ts', 'const token = "task-1-abcdefghijklmnopqrst";'), []);
  assert.deepEqual(ruleIds('x.ts', 'const token = "task-1-report-2026-09-27-clean";'), []);
  // Lowercase hex is a common opaque token shape, not a slug.
  assert.ok(ruleIds('x.ts', `const apiKey = "${'deadbeef'.repeat(4)}";`).includes('bearer-token-assignment'));
  // Quoted values with punctuation are captured through the closing quote.
  assert.ok(
    ruleIds('x.ts', `const password = "${j('CorrectHorseBattery', 'Staple!123')}";`).includes(
      'bearer-token-assignment',
    ),
  );
  // Quoted configuration keys (JSON/YAML) are matched too.
  assert.ok(
    ruleIds('x.json', `{"apiKey": "${j('Xy9AbCdEfGhIjKlMnOpQr', 'StUvWx12')}"}`).includes('bearer-token-assignment'),
  );
  // Hyphenated and short credential keys/values are covered.
  const shortOpaque = j('Abcd1234', 'Efgh5678Ijkl9012!');
  assert.ok(ruleIds('x.yaml', `api-key: "${shortOpaque}"`).includes('bearer-token-assignment'));
  assert.ok(ruleIds('x.yaml', `password: "${j('Abcd1234', 'Efgh')}"`).includes('bearer-token-assignment'));
  // Docker registry auth entries are covered by the auth key.
  assert.ok(ruleIds('x.json', `{"auth": "${shortOpaque}"}`).includes('bearer-token-assignment'));
  // Quoted dotted credentials are literals, not JavaScript member expressions.
  assert.ok(
    ruleIds('x.env', `TOKEN="${j('eyJhbGciOiJIUzI1NiJ9', '.AbCdEfGhIjKlMnOpQrStUvWx.abcDEF1234567890')}"`).includes(
      'bearer-token-assignment',
    ),
  );
  assert.ok(
    ruleIds('x.yaml', `password: "${j('alpha.beta', '.Gamma123456789')}"`).includes(
      'bearer-token-assignment',
    ),
  );
  assert.deepEqual(ruleIds('x.ts', 'const token = this.plugin.settings.token;'), []);
  // `author` is not a credential key.
  assert.deepEqual(ruleIds('x.json', `{"author": "${shortOpaque}"}`), []);
});

test('arbitrary grouped credential values are not treated as placeholders', () => {
  const groupedOpaque = j('GhIj-KlMn-', 'OpQr-9012');
  assert.ok(ruleIds('x.env', `API_KEY="${groupedOpaque}"`).includes('bearer-token-assignment'));
});

test('unquoted YAML credentials retain punctuation during scanning', () => {
  const punctuationOpaque = j('Abcd1234', '!Efgh5678');
  assert.ok(ruleIds('x.yaml', `api_key: ${punctuationOpaque}`).includes('bearer-token-assignment'));
});

test('credential assignments split across lines are rejected', () => {
  const multilineOpaque = j('Abcd1234', 'Efgh5678Ijkl9012!');
  const json = `{"apiKey":\n  "${multilineOpaque}"}`;
  const yaml = `password:\n  "${multilineOpaque}"`;
  assert.ok(ruleIds('x.json', json).includes('bearer-token-assignment'));
  assert.ok(ruleIds('x.yaml', yaml).includes('bearer-token-assignment'));
});

test('contextual cloudflare resource ids are rejected, bare hex is not', () => {
  const hex = '0123456789abcdef0123456789abcdef';
  assert.ok(ruleIds('x.md', `cloudflare_zone_id = ${hex}`).includes('cloudflare-resource-id'));
  assert.deepEqual(ruleIds('x.md', `checksum ${hex}`), []);
});

test('infrastructure assignments split across lines are rejected', () => {
  const cloudflareId = '0123456789abcdef0123456789abcdef';
  const privateHost = j('https', '://vault.private.internal');
  assert.ok(
    ruleIds('x.json', `"zone_id":\n"${cloudflareId}"`).includes('cloudflare-resource-id'),
  );
  assert.ok(
    ruleIds('x.yaml', `OAUTH_ISSUER_URL:\n ${privateHost}`).includes('deployment-hostname'),
  );
});

test('letter-and-digit node ids are rejected in incident docs, once per line, never in code', () => {
  const incident = 'docs/superpowers/plans/2026-08-17-curator-reconciliation-incident-recovery.md';
  const prodId = 'Abcdefghij12345678901';
  assert.ok(ruleIds(incident, `root node ${prodId}`).includes('production-node-id'));
  assert.ok(ruleIds(incident, `root node ${prodId.slice(0, 10)}_${prodId.slice(11)}`).includes('production-node-id'));
  assert.ok(ruleIds(incident, `root node ${prodId.slice(0, 10)}-${prodId.slice(11)}`).includes('production-node-id'));
  // A line matching both rules is reported once.
  assert.deepEqual(ruleIds(incident, `root node ${prodId} and qT7xLm2_RvB9aKpZ3wNfE`), ['production-node-id']);
  assert.deepEqual(ruleIds('packages/engine/src/x.ts', `const id = "${prodId}";`), []);
});

test('random-shaped node ids are rejected in any Markdown file, with or without digits (#128)', () => {
  const withDigits = 'qT7xLm2_RvB9aKpZ3wNfE';
  const noDigits = 'ZqWmPxTrLvBnKdHsGcFjY';
  for (const doc of [
    'docs/design.md', 'packages/obsidian-plugin/docs/superpowers/specs/x-design.md', 'README.mdx',
    // The incident records keep their stricter rule and get this one too.
    'docs/wiki-semantic-reconciliation-canary.md',
    'docs/superpowers/plans/2026-08-17-curator-reconciliation-incident-recovery.md',
  ]) {
    assert.ok(ruleIds(doc, `**Project:** (\`${withDigits}\`)`).includes('production-node-id'), doc);
    assert.ok(ruleIds(doc, `link from the project node ${noDigits}`).includes('production-node-id'), doc);
  }
  assert.deepEqual(ruleIds('packages/engine/src/x.ts', `const id = "${withDigits}";`), []);
  // A 22-character token is not a node id.
  assert.deepEqual(ruleIds('docs/design.md', `token ${withDigits}Q`), []);
});

test('ordinary 21-character names in Markdown are not node ids (#128)', () => {
  for (const name of [
    'isStrictIsoDateString', 'HTMLElementTagNameMap', 'toHaveBeenCalledTimes', 'getAbstractFileByPath',
    'relationship_views_v1', 'rollups-review2-build', 'kimi-k2-instruct-0905', '2026-06-08-vault-chat',
    'projectAlphaRoot00001',
  ]) {
    assert.equal(name.length, 21, name);
    assert.equal(looksLikeRandomNodeId(name), false, name);
    assert.deepEqual(ruleIds('docs/design.md', `see \`${name}\``), [], name);
  }
});

test('the random-shape test catches nearly every random 21-character id (#128)', () => {
  // Engine node ids are nanoid-style: 21 characters from A-Za-z0-9_-. A seeded generator
  // keeps this deterministic.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let seed = 128;
  const next = () => { // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  const ids = Array.from({ length: 20000 }, () => Array.from({ length: 21 }, () => alphabet[next() & 63]).join(''));
  const caught = ids.filter(looksLikeRandomNodeId).length / ids.length;
  assert.ok(caught > 0.99, `caught ${caught}`);
});

test('fixed synthetic node ids are permitted', () => {
  const incident = 'docs/wiki-semantic-reconciliation-canary.md';
  assert.deepEqual(ruleIds(incident, 'root projectAlphaRoot00001'), []);
  assert.deepEqual(ruleIds(incident, 'home projectAlphaHome00001'), []);
  assert.deepEqual(ruleIds(incident, 'page projectAlphaPage00001'), []);
});

test('personal home paths are rejected in active surfaces (POSIX and Windows)', () => {
  assert.ok(ruleIds('scripts/deploy.sh', j('cd /home/', 'example/vault')).includes('owner-home-path'));
  assert.ok(ruleIds('scripts/deploy.sh', j('cd /Users/', 'example/vault')).includes('owner-home-path'));
  assert.ok(ruleIds('scripts/deploy.sh', j('cd C:\\Users\\', 'example\\vault')).includes('owner-home-path'));
  assert.ok(ruleIds('scripts/deploy.sh', j('VAULT_PATH=/home/', 'example')).includes('owner-home-path'));
  assert.ok(ruleIds('scripts/deploy.sh', j('VAULT_PATH=/Users/', 'example')).includes('owner-home-path'));
  assert.ok(ruleIds('scripts/deploy.sh', j('VAULT_PATH=C:\\Users\\', 'example')).includes('owner-home-path'));
  assert.ok(ruleIds('scripts/deploy.sh', j('VAULT_PATH=C:\\users\\', 'example')).includes('owner-home-path'));
  assert.ok(ruleIds('scripts/deploy.sh', j('WorkingDirectory=c:\\USERS\\', 'example')).includes('owner-home-path'));
  assert.deepEqual(ruleIds('scripts/deploy.sh', 'cd ~/example-vault'), []);
});

test('developer-local vault/database paths are rejected', () => {
  assert.ok(
    ruleIds('scripts/deploy.sh', j('DB=/home/', 'example/notes/.vault-engine/vault.db')).includes(
      'developer-vault-path',
    ),
  );
  assert.deepEqual(ruleIds('x.md', 'The snapshot is ~11.7 MB and stored in chat.db.'), []);
  assert.deepEqual(
    ruleIds('x.md', 'The snapshot is chat.db (~11.7 MB) and was retained through ~Jun 26.'),
    [],
  );
});

test('deployment hostnames are rejected unless they are examples', () => {
  const real = j('https', '://vault.private.internal');
  const example = j('https', '://vault.example.com');
  const apexExample = j('https', '://example.com');
  const provider = j('https', '://api.anthropic.com');
  assert.ok(ruleIds('config.ts', `ENGINE_URL=${real}`).includes('deployment-hostname'));
  assert.ok(ruleIds('nginx.conf', `server_name ${j('vault', '.private.internal')};`).includes('deployment-hostname'));
  assert.ok(ruleIds('service.env', `Host=${j('vault', '.private.internal')}`).includes('deployment-hostname'));
  assert.ok(ruleIds('service.env', `Host=${real}`).includes('deployment-hostname'));
  assert.ok(
    ruleIds('service.env', `Host=${j('vault', '.private.internal')}:3334`).includes('deployment-hostname'),
  );
  assert.ok(
    ruleIds('service.env', `ENGINE_URL=${j('https', '://localhost')} CURATOR_URL=${real}`).includes(
      'deployment-hostname',
    ),
  );
  assert.ok(ruleIds('service.env', `OAUTH_ISSUER_URL=${real}`).includes('deployment-hostname'));
  assert.ok(
    ruleIds('config.json', `{"OAUTH_ISSUER_URL": "${real}"}`).includes('deployment-hostname'),
  );
  assert.ok(
    ruleIds('deploy.md', `Set \`OAUTH_ISSUER_URL\` to \`${real}\`.`).includes('deployment-hostname'),
  );
  assert.deepEqual(ruleIds('config.ts', `ENGINE_URL=${example}`), []);
  assert.deepEqual(ruleIds('config.ts', `ENGINE_URL=${apexExample}`), []);
  assert.deepEqual(ruleIds('config.ts', `ENGINE_URL=${provider}`), []);
  assert.deepEqual(ruleIds('config.ts', 'OPENAI_COMPAT_BASE_URL=https://api.together.xyz/v1'), []);
  assert.deepEqual(ruleIds('config.ts', 'ENGINE_URL=http://engine:3334'), []);
  assert.deepEqual(ruleIds('config.ts', 'let host: string; host = new URL(value).host;'), []);
  assert.deepEqual(ruleIds('config.ts', 'const host = document.getElementById("banner-host");'), []);
  assert.deepEqual(ruleIds('config.ts', 'const host = url.hostname.replace(/^x/, "");'), []);
  // Historical records are not exempt from the hostname rule.
  assert.ok(
    ruleIds('docs/superpowers/specs/2026-01-01-x-design.md', `ENGINE_URL=${real}`).includes('deployment-hostname'),
  );
});

test('owner display name is rejected in active source', () => {
  assert.ok(ruleIds('packages/curator/src/x.ts', `hello ${OWNER_DISPLAY_NAME}`).includes('owner-name'));
});

test('owner display name is allowed in historical records', () => {
  assert.ok(isHistoricalRecord('docs/foundations/validation.md'));
  assert.deepEqual(ruleIds('docs/foundations/validation.md', `design approved by ${OWNER_DISPLAY_NAME}`), []);
  assert.deepEqual(
    ruleIds('docs/superpowers/plans/2026-01-01-thing.md', `${OWNER_DISPLAY_NAME} approved this design`),
    [],
  );
});

test('historical owner-name exemption is limited to approval and provenance', () => {
  assert.ok(
    ruleIds('docs/superpowers/specs/2026-01-01-thing.md', `Would future ${OWNER_DISPLAY_NAME} value this?`).includes(
      'owner-name',
    ),
  );
  assert.ok(
    ruleIds('docs/foundations/validation.md', `${OWNER_DISPLAY_NAME} prefers this workflow`).includes('owner-name'),
  );
  assert.ok(
    ruleIds('docs/foundations/validation.md', `${OWNER_DISPLAY_NAME} reported a private medical diagnosis`).includes(
      'owner-name',
    ),
  );
  assert.ok(
    ruleIds('docs/foundations/validation.md', `${OWNER_DISPLAY_NAME} lives in a private location`).includes('owner-name'),
  );
  assert.ok(
    ruleIds(
      'docs/foundations/validation.md',
      `${OWNER_DISPLAY_NAME} discussed a private location, and the team approved the plan`,
    ).includes('owner-name'),
  );
  for (const personalFact of [
    `${OWNER_DISPLAY_NAME} confirmed a private medical diagnosis`,
    `${OWNER_DISPLAY_NAME} chose a private medical treatment`,
    `${OWNER_DISPLAY_NAME} selected a private location`,
    `${OWNER_DISPLAY_NAME} requested medical leave`,
  ]) {
    assert.ok(ruleIds('docs/foundations/validation.md', personalFact).includes('owner-name'));
  }
  assert.deepEqual(
    ruleIds('docs/foundations/validation.md', `${OWNER_DISPLAY_NAME} explicitly approved this design`),
    [],
  );
  assert.deepEqual(ruleIds('docs/foundations/validation.md', `implementation authorized by ${OWNER_DISPLAY_NAME}`), []);
});

test('the owner-name rule needs names, matches each as a whole word, and escapes them', () => {
  const ids = (text, ownerNames) => scanTrackedFile('packages/curator/src/x.ts', buf(text), { ownerNames }).map((f) => f.ruleId);
  assert.deepEqual(ids(`hello ${OWNER_DISPLAY_NAME}`, []), []);
  assert.deepEqual(scanTrackedFile('packages/curator/src/x.ts', buf(`hello ${OWNER_DISPLAY_NAME}`)), []);
  assert.deepEqual(ids(`hello ${OWNER_DISPLAY_NAME.toLowerCase()}, again`, [OWNER_DISPLAY_NAME]), ['owner-name']);
  assert.deepEqual(ids(`${OWNER_DISPLAY_NAME}son and un${OWNER_DISPLAY_NAME}`, [OWNER_DISPLAY_NAME]), []);
  assert.deepEqual(ids('written by Tessaly-Vane.', OWNER_NAMES.ownerNames), ['owner-name']);
  assert.deepEqual(ids('a.c is not abc', ['a.c', '  ']), ['owner-name']);
  assert.deepEqual(ids('abc only', ['a.c']), []);
});

test('binary content is skipped', () => {
  assert.deepEqual(scanTrackedFile('packages/x/src/a.ts', Buffer.from([0, 66, 97, 114])), []);
});

test('BOM-marked UTF-16 text is decoded before binary skipping', () => {
  const text = `API_KEY=${j('Abcd1234', 'Efgh5678Ijkl9012')}`;
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const utf16beBody = Buffer.from(text, 'utf16le');
  utf16beBody.swap16();
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beBody]);
  const utf16WithNul = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${text}\0tail`, 'utf16le')]);
  const oddUtf16le = Buffer.concat([utf16le, Buffer.from([0x41])]);
  const oddUtf16be = Buffer.concat([utf16be, Buffer.from([0x41])]);

  assert.ok(scanTrackedFile('config-le.txt', utf16le).some((finding) => finding.ruleId === 'bearer-token-assignment'));
  assert.ok(scanTrackedFile('config-be.txt', utf16be).some((finding) => finding.ruleId === 'bearer-token-assignment'));
  assert.deepEqual(scanTrackedFile('config-nul.txt', utf16WithNul), []);
  assert.deepEqual(scanTrackedFile('config-odd-le.txt', oddUtf16le), []);
  assert.deepEqual(scanTrackedFile('config-odd-be.txt', oddUtf16be), []);
});

test('findings are redacted to rule id, path, and line', () => {
  const value = j('aB3xY9kLmN2', 'pQ7rT5vW8zC1dE4fG6hJ0');
  const [finding] = scanTrackedFile('packages/x/src/a.ts', buf(`const apiKey = "${value}";`));
  const line = formatFinding(finding);
  assert.equal(line, 'packages/x/src/a.ts:1: bearer-token-assignment');
  assert.ok(!line.includes(value));
});

test('repository root resolves from a nested working directory', () => {
  const root = resolveRepoRoot();
  const nested = join(root, 'packages', 'bench');
  assert.equal(resolveRepoRoot(nested), root);
});

test('tracked file listing excludes untracked and ignored directories', () => {
  const files = listTrackedFiles(resolveRepoRoot());
  assert.ok(files.includes('package.json'));
  assert.ok(!files.some((f) => f.startsWith('node_modules/')));
});

test('runCheck returns finding-shaped records only', () => {
  const findings = runCheck();
  for (const finding of findings) {
    assert.equal(typeof finding.ruleId, 'string');
    assert.equal(typeof finding.path, 'string');
    assert.equal(typeof finding.line, 'number');
  }
});

test('runCheck detects sensitive tracked paths without disclosing them', () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-safety-path-'));
  const fakeBin = mkdtempSync(join(tmpdir(), 'repo-safety-git-'));
  const originalPath = process.env.PATH;
  const tokenPath = j('ghp_', 'a'.repeat(36), '.txt');
  const ownerPath = j(OWNER_DISPLAY_NAME, '-private-plan.md');
  try {
    writeFileSync(join(root, tokenPath), '');
    writeFileSync(join(root, ownerPath), '');
    const fakeGit = join(fakeBin, 'git');
    writeFileSync(fakeGit, `#!/bin/sh\nprintf '${tokenPath}\\0${ownerPath}\\0'\n`);
    chmodSync(fakeGit, 0o755);
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;

    const terms = { ownerNames: [OWNER_DISPLAY_NAME], matcher: createMatcher() };
    const findings = runCheck(root, terms);
    assert.deepEqual(
      findings.map((finding) => finding.ruleId).sort(),
      ['github-token', 'owner-name'],
    );
    assert.deepEqual(runCheck(root, null).map((finding) => finding.ruleId), ['github-token']);
    assert.ok(findings.every((finding) => finding.line === 0));
    assert.ok(findings.every((finding) => /^redacted-path-sha256-[0-9a-f]{12}$/.test(finding.path)));
    assert.equal(new Set(findings.map((finding) => finding.path)).size, 2);
    assert.ok(findings.every((finding) => !finding.path.includes(tokenPath)));
    assert.ok(findings.every((finding) => !finding.path.includes(OWNER_DISPLAY_NAME)));
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('runCheck scans a tracked symlink blob without following its target', () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-safety-symlink-'));
  const fakeBin = mkdtempSync(join(tmpdir(), 'repo-safety-git-'));
  const originalPath = process.env.PATH;
  try {
    symlinkSync(j('/home/', 'example/private'), join(root, 'leak-link'));
    const fakeGit = join(fakeBin, 'git');
    writeFileSync(fakeGit, "#!/bin/sh\nprintf 'leak-link\\0'\n");
    chmodSync(fakeGit, 0o755);
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    assert.deepEqual(runCheck(root, null), [{ ruleId: 'owner-home-path', path: 'leak-link', line: 1 }]);
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('cutover rejects a relative MONOREPO before inspecting services', () => {
  const root = resolveRepoRoot();
  const fakeBin = mkdtempSync(join(tmpdir(), 'cutover-path-test-'));
  try {
    const fakeSystemctl = join(fakeBin, 'systemctl');
    writeFileSync(fakeSystemctl, '#!/bin/sh\nexit 1\n');
    chmodSync(fakeSystemctl, 0o755);
    const result = spawnSync('bash', ['scripts/cutover.sh', 'plan'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        MONOREPO: '.',
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MONOREPO must be an absolute path/);
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('deep ordinary paths scan in bounded time and vault paths are still caught', () => {
  const started = performance.now();
  assert.deepEqual(ruleIds('x.md', `See ~/${'folder/'.repeat(200)}note.md`), []);
  assert.ok(!ruleIds('x.md', `See ${j('/ho', 'me/someone/')}${'a/'.repeat(200)}notes.md`).includes('developer-vault-path'));
  assert.ok(performance.now() - started < 500);
  for (const line of [
    j('~/', 'Documents/myvault/', '.vault-engine/vault.db'),
    j('/home/', 'someone/deep/', 'a/b/c/state.db'),
    j('C:\\Users\\', 'someone\\notes\\', '.vault-engine'),
  ]) assert.ok(ruleIds('x.md', `Path: ${line}`).includes('developer-vault-path'), line);
});

test('credential literals may contain the other quote character or escaped delimiters', () => {
  const value = j('Correct', "'", 'HorseBattery', 'Staple!123');
  assert.ok(ruleIds('fixture.json', JSON.stringify({ password: value })).includes('bearer-token-assignment'));
  assert.ok(ruleIds('x.yaml', `password: "${value}"`).includes('bearer-token-assignment'));
  assert.ok(ruleIds('x.ts', `const secret = '${j('Correct"Horse', 'BatteryStaple!123')}';`).includes('bearer-token-assignment'));
  assert.ok(ruleIds('x.ts', `const secret = "${j('Correct\\"Horse', 'BatteryStaple!123')}";`).includes('bearer-token-assignment'));
  assert.ok(ruleIds('x.yaml', `password: ${value}`).includes('bearer-token-assignment'));
});
