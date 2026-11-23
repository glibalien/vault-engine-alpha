#!/usr/bin/env node
// Writes vault-terms.json into the private terms directory from a vault's notes, so the
// repository-safety check can tell when a real note title, alias or name is in a tracked
// file. See private-terms.mjs for the directory and what matches.
//
//   node scripts/build-private-terms.mjs <vault-dir> [--out <dir>] [--type-key types]
//                                        [--person-types person] [--company-types company]
//
// It reads each Markdown file's name and three frontmatter keys, nothing else: `aliases`,
// `alias`, and the key that holds a note's kinds. That key is `--type-key`, else the
// Engine's `VAULT_TYPE_KEY`, else `types`. It prints counts only. Folders whose names start
// with a dot are skipped.

import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTerms, privateTermsDir } from './private-terms.mjs';

/** One YAML scalar as text, without its quotes or a trailing comment. */
function scalar(raw) {
  const value = raw.trim();
  const double = value.match(/^"((?:[^"\\]|\\.)*)"/);
  if (double) return double[1].replace(/\\(["\\])/g, '$1').trim();
  const single = value.match(/^'((?:[^']|'')*)'/);
  if (single) return single[1].replace(/''/g, "'").trim();
  const plain = value.replace(/(^|\s)#.*$/, '').trim();
  return /^(?:null|~)$/i.test(plain) ? '' : plain;
}

/**
 * The items of a flow list (`[a, "b, c", [[d]]]`), or null while its brackets are still
 * open. A comma or a `#` inside quotes is part of the item; a nested list comes back as
 * its text, brackets included.
 */
function flowItems(text) {
  const items = [];
  let depth = 0;
  let quote = null;
  let item = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      item += ch;
      if (quote === '"' && ch === '\\') item += text[++i] ?? '';
      else if (ch === quote && quote === "'" && text[i + 1] === "'") item += text[++i];
      else if (ch === quote) quote = null;
    } else if ((ch === '"' || ch === "'") && item.trim() === '') {
      quote = ch;
      item += ch;
    } else if (ch === '[') {
      if (++depth > 1) item += ch;
    } else if (ch === ']') {
      if (--depth === 0) return [...items, item].map(scalar).filter(Boolean);
      item += ch;
    } else if (ch === ',' && depth === 1) {
      items.push(item);
      item = '';
    } else if (ch === '#' && /\s/.test(text[i - 1] ?? ' ')) {
      const lineEnd = text.indexOf('\n', i);
      if (lineEnd === -1) break;
      i = lineEnd;
    } else {
      item += ch;
    }
  }
  return null;
}

/**
 * The values of one top-level frontmatter key written as a scalar, a flow list (on one
 * line or several) or a block list. Quotes and YAML comments are read as YAML reads them.
 * It does not read a block scalar (`|`, `>`), an anchor or a nested mapping.
 */
export function frontmatterList(markdown, key) {
  const text = markdown.replace(/^\uFEFF/, '');
  if (!/^---[ \t]*\r?\n/.test(text)) return [];
  const end = text.search(/\r?\n---[ \t]*(?:\r?\n|$)/);
  const lines = (end === -1 ? text : text.slice(0, end)).split(/\r?\n/).slice(1);
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return [];
  const rest = lines[start].slice(key.length + 1).trim();
  if (rest.startsWith('[')) {
    let flow = rest;
    for (let next = start + 1; ; next++) {
      const items = flowItems(flow);
      if (items !== null) return items;
      if (next >= lines.length) return [];
      flow += `\n${lines[next]}`;
    }
  }
  const inline = scalar(rest);
  if (inline !== '') return [inline];
  const values = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const item = line.match(/^\s*-(?:\s+(.*))?$/);
    if (!item) break;
    values.push(scalar(item[1] ?? ''));
  }
  return values.filter(Boolean);
}

/**
 * The kind a `types` value names. The Engine also reads a kind written as a link
 * (`"[[person]]"`, `[[person]]`, `[[person|Person]]`), so the brackets and any alias go.
 */
export function typeName(value) {
  return value.replace(/^\[+|\]+$/g, '').split('|')[0].split('#')[0].trim();
}

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(path);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) yield path;
  }
}

/**
 * Reads `{ title, aliases, types }` for every note under a vault folder. `typeKey` is the
 * frontmatter key that holds a note's kinds; other names are read from `aliases` and
 * `alias`, as the Engine reads them.
 */
export function readVaultNotes(vaultDir, { typeKey = 'types' } = {}) {
  const notes = [];
  for (const path of markdownFiles(vaultDir)) {
    let head = '';
    try {
      head = readFileSync(path, 'utf8').slice(0, 16_384);
    } catch {
      continue;
    }
    notes.push({
      title: basename(path).replace(/\.md$/i, ''),
      aliases: [...frontmatterList(head, 'aliases'), ...frontmatterList(head, 'alias')],
      types: frontmatterList(head, typeKey).map(typeName).filter(Boolean),
    });
  }
  return notes;
}

function main(argv) {
  const args = [...argv];
  const option = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? null : args.splice(at, 2)[1];
  };
  const out = option('--out') ?? privateTermsDir();
  const typeKey = option('--type-key') ?? (process.env.VAULT_TYPE_KEY || 'types');
  const personTypes = option('--person-types')?.split(',');
  const companyTypes = option('--company-types')?.split(',');
  const vaultDir = args[0];
  if (!vaultDir || args.length !== 1) {
    console.error('usage: node scripts/build-private-terms.mjs <vault-dir> [--out <dir>] [--type-key key] [--person-types a,b] [--company-types a,b]');
    return 2;
  }
  const notes = readVaultNotes(resolve(vaultDir), { typeKey });
  const terms = buildTerms(notes, {
    ...(personTypes ? { personTypes } : {}),
    ...(companyTypes ? { companyTypes } : {}),
  });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const target = join(out, 'vault-terms.json');
  writeFileSync(target, JSON.stringify({ builtAt: new Date().toISOString(), noteCount: notes.length, ...terms }), { mode: 0o600 });
  chmodSync(target, 0o600);
  console.log(
    `${notes.length} notes: ${terms.titles.length} titles and aliases, ${terms.partials.length} three-word runs, ${terms.nameWords.length} name words (kinds read from "${typeKey}")`,
  );
  console.log(`wrote ${target}`);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
