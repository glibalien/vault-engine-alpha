// Tests for the private-terms matcher and the script that builds its term file.
// Dependency-free: node --test. Every name here is made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontmatterList, readVaultNotes, typeName } from './build-private-terms.mjs';
import { formatTermFindings, scanPaths } from './check-repository-safety.mjs';
import {
  COMMON_IN_FILES,
  buildTerms,
  createMatcher,
  createTreeScan,
  loadPrivateTerms,
  missingPrivateTerms,
  privateTermsDir,
  scanText,
  words,
} from './private-terms.mjs';

const NOTES = [
  { title: 'Orchid Ledger — phase two kickoff', types: ['meeting'] },
  { title: 'Ask Wendeline about the Harbourline freight renewal', types: ['task'] },
  { title: 'Wendeline Ashcombe', aliases: ['Wendy A'], types: ['person'] },
  { title: 'Harbourline Freight', aliases: ['HLF Group'], types: ['company'] },
  { title: 'Kestrel', types: ['project'] },
  { title: '2026-03-04', types: ['daily-note'] },
  { title: 'QA', types: ['note'] },
  { title: 'Notes on the way to the fair', types: ['note'] },
];

const matcherFor = (allow = []) => createMatcher({ ...buildTerms(NOTES), allow });
const hits = (line, allow) => matcherFor(allow).scanLine(line).map((hit) => `${hit.kind}:${hit.match}`).sort();

test('words drops case, accents, apostrophes and punctuation', () => {
  assert.deepEqual(words("Ping-Pong's Café/Menu — v2"), ['ping', 'pong', 'cafe', 'menu', 'v2']);
  assert.deepEqual(words('It doesn’t; the Joneses’ dog’s bowl'), ['it', 'doesnt', 'the', 'joneses', 'dog', 'bowl']);
  assert.deepEqual(words('11_23 Prep'), ['11', '23', 'prep']);
  assert.deepEqual(words(' — '), []);
});

test('buildTerms leaves out dates and very short one-word titles', () => {
  const terms = buildTerms(NOTES);
  assert.ok(terms.titles.includes('orchid ledger phase two kickoff'));
  assert.ok(terms.titles.includes('kestrel'));
  assert.ok(terms.titles.includes('wendy a'));
  assert.ok(!terms.titles.includes('2026 03 04'));
  assert.ok(!terms.titles.includes('qa'));
});

test('buildTerms keeps three-word runs with two words that carry meaning', () => {
  const { partials } = buildTerms(NOTES);
  assert.ok(partials.includes('orchid ledger phase'));
  assert.ok(partials.includes('harbourline freight renewal'));
  // "on the way", "the way to", "way to the", "to the fair": one meaningful word at most.
  assert.ok(!partials.some((partial) => partial.includes('way')));
  // A three-word title has no partials of its own.
  assert.deepEqual(buildTerms([{ title: 'Orchid Ledger kickoff' }]).partials, []);
  // A run that is itself a title is matched as a title, not twice.
  const both = buildTerms([{ title: 'Orchid Ledger kickoff notes' }, { title: 'Orchid Ledger kickoff' }]);
  assert.ok(!both.partials.includes('orchid ledger kickoff'));
});

test('buildTerms takes surnames from people and words from companies', () => {
  assert.deepEqual(buildTerms(NOTES).nameWords, ['ashcombe', 'harbourline']);
  // A one-word company is matched as a title; a short or stop-word first word names nothing.
  assert.deepEqual(buildTerms([{ title: 'Harbourline', types: ['company'] }, { title: 'The Freight Co', types: ['company'] }]).nameWords, []);
  const custom = buildTerms([{ title: 'Wendeline Ashcombe', types: ['Contact'] }], { personTypes: ['contact'] });
  assert.deepEqual(custom.nameWords, ['ashcombe']);
  // A person known by one word gives no surname.
  assert.deepEqual(buildTerms([{ title: 'Wendeline', types: ['person'] }]).nameWords, []);
});

test('a whole title matches whatever its case and punctuation', () => {
  assert.deepEqual(hits("const t = 'ORCHID LEDGER: phase-two kickoff';"), ['title:orchid ledger phase two kickoff']);
  assert.deepEqual(hits('the Kestrel plan'), ['title:kestrel']);
  assert.deepEqual(hits('kestrels and kestrelPlan are other words'), []);
});

test('a trimmed copy of a title matches as a partial', () => {
  assert.deepEqual(hits("insert('Ask Wendeline about the freight renewal')"), ['partial:ask wendeline about']);
  assert.deepEqual(hits('Orchid Ledger phase'), ['partial:orchid ledger phase']);
  // Inside the whole title, its own runs are not reported again.
  assert.deepEqual(hits('Orchid Ledger phase two kickoff'), ['title:orchid ledger phase two kickoff']);
});

test('a surname or company word matches on its own, not inside a reported title', () => {
  assert.deepEqual(hits("Ashcombe's team signed"), ['name:ashcombe']);
  assert.deepEqual(hits('Wendeline Ashcombe signed'), ['title:wendeline ashcombe']);
  assert.deepEqual(hits('the Harbourline account'), ['name:harbourline']);
});

test('an allowed phrase is fine with everything inside it; its words elsewhere still match', () => {
  assert.deepEqual(hits('Wendeline Ashcombe signed', ['Wendeline Ashcombe']), []);
  assert.deepEqual(hits('Wendeline Ashcombe signed; Ashcombe left', ['Wendeline Ashcombe']), ['name:ashcombe']);
  assert.deepEqual(hits('Orchid Ledger phase two kickoff', ['orchid ledger — phase two kickoff']), []);
  assert.deepEqual(hits('Orchid Ledger phase', ['orchid ledger phase two kickoff']), ['partial:orchid ledger phase']);
  assert.deepEqual(hits('the Kestrel plan', ['kestrel  ']), []);
});

test('a line reports each match once', () => {
  assert.deepEqual(hits('Kestrel, kestrel and KESTREL'), ['title:kestrel']);
});

test('scanText numbers lines from one', () => {
  assert.deepEqual(scanText(matcherFor(), 'nothing here\r\nthe Kestrel plan\n'), [{ line: 2, kind: 'title', match: 'kestrel' }]);
});

test('frontmatterList reads scalar, inline and block lists', () => {
  assert.deepEqual(frontmatterList('---\naliases: [Wendy A, "W. Ashcombe"]\n---\nbody', 'aliases'), ['Wendy A', 'W. Ashcombe']);
  assert.deepEqual(frontmatterList('---\r\ntypes:\r\n  - person\r\n  - "contact"\r\ntitle: x\r\n---\r\n', 'types'), ['person', 'contact']);
  assert.deepEqual(frontmatterList('\uFEFF---\ntypes: person\n---\n', 'types'), ['person']);
  assert.deepEqual(frontmatterList('---\ntitle: x\n---\naliases: [late]\n', 'aliases'), []);
  assert.deepEqual(frontmatterList('aliases: [none]\n', 'aliases'), []);
  assert.deepEqual(frontmatterList('---\naliases:\ntypes: [note]\n---\n', 'aliases'), []);
});

test('frontmatterList reads quotes and comments as YAML does', () => {
  const list = (yaml, key = 'aliases') => frontmatterList(`---\n${yaml}\n---\nbody`, key);
  // A comment after a value is not part of it; a "#" with no space before it is.
  assert.deepEqual(list('aliases:\n  - Kestrel # nickname\n  - Harbour#9'), ['Kestrel', 'Harbour#9']);
  assert.deepEqual(list('aliases: Kestrel   # the project'), ['Kestrel']);
  assert.deepEqual(list('aliases: # filled in below\n  - Kestrel'), ['Kestrel']);
  assert.deepEqual(list('aliases:\n  # the old name\n\n  - Kestrel\n  -\n  - Orchid'), ['Kestrel', 'Orchid']);
  // Inside quotes a "#" and a comma are text, and escapes are undone.
  assert.deepEqual(list(`aliases:\n  - "Kestrel # two" # why\n  - 'Wendy''s list'`), ['Kestrel # two', "Wendy's list"]);
  assert.deepEqual(list('aliases: ["Ashcombe, Wendeline", Wendy A, \'O\'\'Dell\'] # three'), ['Ashcombe, Wendeline', 'Wendy A', "O'Dell"]);
  assert.deepEqual(list('aliases: "A \\"quoted\\" name"'), ['A "quoted" name']);
  assert.deepEqual(list("aliases: [Wendeline O'Dell, Kestrel]"), ["Wendeline O'Dell", 'Kestrel']);
  // A flow list over several lines, with a comment in it.
  assert.deepEqual(list('aliases: [\n  Kestrel, # first\n  "Orchid Ledger"\n]\ntitle: x'), ['Kestrel', 'Orchid Ledger']);
  assert.deepEqual(list('aliases: [Kestrel,\ntitle: x'), []);
  // Nothing, written three ways.
  assert.deepEqual(list('aliases: []'), []);
  assert.deepEqual(list('aliases: null'), []);
  assert.deepEqual(list('aliases: ~ # none'), []);
  // A nested list keeps its brackets, which typeName then drops.
  assert.deepEqual(list('types: [[[person]], "[[company]]"]', 'types').map(typeName), ['person', 'company']);
});

test('a kind written as a link is read as the kind', () => {
  assert.equal(typeName('person'), 'person');
  assert.equal(typeName('[[person]]'), 'person');
  assert.equal(typeName('[person]'), 'person');
  assert.equal(typeName('[[person|Person]]'), 'person');
  assert.equal(typeName('[[]]'), '');

  const vault = mkdtempSync(join(tmpdir(), 'private-terms-kinds-'));
  try {
    writeFileSync(join(vault, 'Wendeline Ashcombe.md'), '---\ntypes: "[[person]]"\n---\n');
    writeFileSync(join(vault, 'Orrin Vantongeren.md'), '---\ntypes: [[person]]\n---\n');
    writeFileSync(join(vault, 'Harbourline Freight.md'), '---\ntypes:\n  - "[[company|Company]]"\n  - note\n---\n');
    const notes = readVaultNotes(vault);
    assert.deepEqual(notes.map((note) => note.types).sort(), [['company', 'note'], ['person'], ['person']]);
    assert.deepEqual(buildTerms(notes).nameWords, ['ashcombe', 'harbourline', 'vantongeren']);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('kinds are read from the vault\'s type key, and other names from aliases and alias', () => {
  const vault = mkdtempSync(join(tmpdir(), 'private-terms-type-key-'));
  const out = mkdtempSync(join(tmpdir(), 'private-terms-type-key-out-'));
  try {
    writeFileSync(join(vault, 'Wendeline Ashcombe.md'), '---\nkind: person\nalias: Wendy A\naliases: [W. Ashcombe]\n---\n');
    assert.deepEqual(readVaultNotes(vault)[0], { title: 'Wendeline Ashcombe', aliases: ['W. Ashcombe', 'Wendy A'], types: [] });
    assert.deepEqual(readVaultNotes(vault, { typeKey: 'kind' })[0].types, ['person']);

    const script = fileURLToPath(new URL('./build-private-terms.mjs', import.meta.url));
    const nameWords = (args, env = {}) => {
      const result = spawnSync(process.execPath, [script, vault, '--out', out, ...args], {
        encoding: 'utf8',
        env: { ...process.env, VAULT_TYPE_KEY: '', ...env },
      });
      assert.equal(result.status, 0, result.stderr);
      return loadPrivateTerms(out).matcher.scanLine('ask Ashcombe').map((hit) => hit.kind);
    };
    assert.deepEqual(nameWords([]), []);
    assert.deepEqual(nameWords(['--type-key', 'kind']), ['name']);
    assert.deepEqual(nameWords([], { VAULT_TYPE_KEY: 'kind' }), ['name']);
    assert.deepEqual(nameWords(['--type-key', 'types'], { VAULT_TYPE_KEY: 'kind' }), []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('the build script writes terms for a vault and prints counts only', () => {
  const vault = mkdtempSync(join(tmpdir(), 'private-terms-vault-'));
  const out = join(mkdtempSync(join(tmpdir(), 'private-terms-out-')), 'terms');
  try {
    mkdirSync(join(vault, 'People'));
    mkdirSync(join(vault, '.trash'));
    writeFileSync(join(vault, 'People', 'Wendeline Ashcombe.md'), '---\ntypes: [person]\naliases:\n  - Wendy A\n---\n');
    writeFileSync(join(vault, 'Orchid Ledger — phase two kickoff.md'), 'no frontmatter');
    writeFileSync(join(vault, '.trash', 'Deleted Thing.md'), '');
    writeFileSync(join(vault, 'picture.png'), '');
    assert.deepEqual(readVaultNotes(vault).map((note) => note.title).sort(), ['Orchid Ledger — phase two kickoff', 'Wendeline Ashcombe']);

    const script = fileURLToPath(new URL('./build-private-terms.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, vault, '--out', out], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^2 notes: 3 titles and aliases, 3 three-word runs, 1 name words \(kinds read from "types"\)\n/);
    assert.doesNotMatch(result.stdout, /Wendeline|Orchid/i);
    assert.equal(statSync(join(out, 'vault-terms.json')).mode & 0o777, 0o600);

    writeFileSync(join(out, 'owner-names.txt'), 'Quillon\n# a comment\n\n');
    writeFileSync(join(out, 'extra-terms.txt'), 'Project Larkspur  # code name\n');
    writeFileSync(join(out, 'allow.txt'), 'wendy a # a stock example\n');
    const terms = loadPrivateTerms(out);
    assert.deepEqual(terms.ownerNames, ['Quillon']);
    assert.deepEqual(missingPrivateTerms(terms), []);
    assert.equal(terms.vaultTitleCount, 3);
    assert.equal(terms.noteCount, 2);
    assert.ok(typeof terms.builtAt === 'string');
    const found = (line) => terms.matcher.scanLine(line).map((hit) => `${hit.kind}:${hit.match}`);
    assert.deepEqual(found('ask Ashcombe'), ['name:ashcombe']);
    assert.deepEqual(found('Project Larkspur'), ['title:project larkspur']);
    assert.deepEqual(found('Wendy A'), []);
    assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});

test('terms that leave a rule with nothing to look for are named as missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'private-terms-empty-'));
  try {
    assert.match(missingPrivateTerms(null).join('\n'), /no private terms are set up/);
    // The directory exists and holds nothing: both rules have nothing to look for.
    assert.deepEqual(missingPrivateTerms(loadPrivateTerms(dir)).map((line) => line.split(' ')[0]), ['owner-names.txt', 'vault-terms.json']);
    writeFileSync(join(dir, 'owner-names.txt'), 'Quillon\n');
    assert.deepEqual(missingPrivateTerms(loadPrivateTerms(dir)).map((line) => line.split(' ')[0]), ['vault-terms.json']);
    writeFileSync(join(dir, 'vault-terms.json'), JSON.stringify({ titles: [], partials: [], nameWords: [] }));
    assert.equal(missingPrivateTerms(loadPrivateTerms(dir)).length, 1);
    writeFileSync(join(dir, 'vault-terms.json'), JSON.stringify({ titles: ['kestrel'], partials: [], nameWords: [] }));
    assert.deepEqual(missingPrivateTerms(loadPrivateTerms(dir)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the terms directory comes from the environment, and a missing one loads as null', () => {
  assert.equal(privateTermsDir({ VAULT_ENGINE_PRIVATE_TERMS: '/x/terms' }), '/x/terms');
  assert.equal(privateTermsDir({ XDG_CONFIG_HOME: '/x/config' }), join('/x/config', 'vault-engine', 'private-terms'));
  assert.equal(loadPrivateTerms(join(tmpdir(), 'private-terms-missing-directory')), null);
});

test('the check reports private terms in content and paths, except in historical records', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-terms-scan-'));
  try {
    mkdirSync(join(root, 'docs', 'superpowers'), { recursive: true });
    writeFileSync(join(root, 'a.ts'), 'ok\nthe Kestrel plan\n');
    writeFileSync(join(root, 'Kestrel notes.md'), 'nothing');
    writeFileSync(join(root, 'docs', 'superpowers', 'plan.md'), 'the Kestrel plan\n');
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 75, 101]));
    const paths = ['a.ts', 'Kestrel notes.md', 'docs/superpowers/plan.md', 'blob.bin'];
    const terms = { ownerNames: [], matcher: matcherFor() };
    const term = { ruleId: 'private-term', kind: 'title', match: 'kestrel' };
    assert.deepEqual(scanPaths(root, paths, terms), [
      { ...term, path: 'a.ts', line: 2 },
      { ...term, path: 'Kestrel notes.md', line: 0 },
    ]);
    assert.deepEqual(scanPaths(root, ['blob.bin'], { ownerNames: [], matcher: createMatcher({ titles: ['blob'] }) }), [
      { ruleId: 'private-term', kind: 'title', match: 'blob', path: 'blob.bin', line: 0 },
    ]);
    assert.equal(scanPaths(root, paths, terms, { termsEverywhere: true }).length, 3);
    assert.deepEqual(scanPaths(root, paths, null), []);
    assert.deepEqual(formatTermFindings(scanPaths(root, paths, terms)), [
      'private-term (title) "kestrel": 2 line(s) in 2 file(s): a.ts:2, Kestrel notes.md:0',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('over a tree, a partial or name made of common words is left out; a title never is', () => {
  const lines = ['Ashcombe signed', 'Orchid Ledger phase', 'the Kestrel plan'].join('\n');
  const scanOf = (fileCount) => {
    const scan = createTreeScan(matcherFor());
    for (let i = 0; i < fileCount; i++) scan.add(`f${i}.ts`, lines);
    return scan;
  };
  const kinds = (scan) => [...new Set(scan.findings().map((hit) => `${hit.kind}:${hit.match}`))].sort();
  assert.deepEqual(kinds(scanOf(COMMON_IN_FILES - 1)), ['name:ashcombe', 'partial:orchid ledger phase', 'title:kestrel']);
  assert.deepEqual(kinds(scanOf(COMMON_IN_FILES)), ['title:kestrel']);
  // One rare word is enough to keep a partial.
  const mixed = scanOf(COMMON_IN_FILES);
  mixed.add('other.ts', 'the freight renewal was Orchid Ledger phase');
  assert.deepEqual(kinds(mixed), ['title:kestrel']);
  mixed.add('other.ts', 'ask Wendeline about Orchid');
  assert.deepEqual(kinds(mixed), ['partial:ask wendeline about', 'title:kestrel']);
});
