// Private terms: names from a real vault that must stay out of tracked files.
//
// The terms never live in the repository. They are read from a directory outside it:
// $VAULT_ENGINE_PRIVATE_TERMS, or <config home>/vault-engine/private-terms. Where that
// directory does not exist, the rules that need it do not run.
//
//   owner-names.txt   one name per line; the owner-name rule looks for each as a whole word
//   vault-terms.json  note titles and aliases, written by scripts/build-private-terms.mjs
//   extra-terms.txt   more phrases, one per line, kept by hand and treated like a title
//   allow.txt         matches that were read and may stay, one per line; "#" starts a comment
//
// Text is compared as words: lower case, with accents, possessive endings and punctuation
// dropped. Three things match:
//
//   title    a whole title or alias
//   partial  three words in a row from a title of four or more (a trimmed copy of one)
//   name     a person's surname, or the first word of a company's name, on its own
//
// A phrase in allow.txt is fine wherever it appears, together with anything inside it. The
// same words outside the phrase still match.
//
// Over a whole tree (`createTreeScan`), a partial or a name made only of words found in
// COMMON_IN_FILES files or more is not reported: those are the tree's own vocabulary, and a
// vault that documents the project shares it. A whole title is always reported.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Words too common to make three words in a row worth reporting. */
const STOP_WORDS = new Set(
  ('a about after all also an and any are as at be been but by can could did do does doesnt dont for from get '
    + 'had has have how if in into is isnt it its just more most much my new no not now of on one only or other '
    + 'our out over so some than that the their them then there these they this to up use was we were what when '
    + 'where which who why will with wont would you your')
    .split(' '),
);

/** A partial or name made only of words in this many files or more is the tree's own vocabulary. */
export const COMMON_IN_FILES = 20;

const isNumber = (word) => /^\d+$/.test(word);

/**
 * The words of a text, in order: lower case, no accents, no punctuation. A possessive
 * loses its ending ("Ada's" is "ada"); any other apostrophe just goes ("doesn't" is "doesnt").
 */
export function words(text) {
  return (
    String(text)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/['’]s(?![\p{L}\p{N}])/gu, '')
      .replace(/['’]/g, '')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** A word that can single out a title: not a number, not short, not a stop word. */
function isContentWord(word) {
  return word.length >= 3 && !isNumber(word) && !STOP_WORDS.has(word);
}

/** The three-word runs of a title that are worth matching on their own. */
function partialsOf(titleWords) {
  const found = [];
  if (titleWords.length < 4) return found;
  for (let i = 0; i + 3 <= titleWords.length; i++) {
    const run = titleWords.slice(i, i + 3);
    if (run.filter(isContentWord).length >= 2) found.push(run.join(' '));
  }
  return found;
}

/**
 * Turns notes into the three term lists. `notes` is a list of
 * `{ title, aliases?: string[], types?: string[] }`. A title made only of numbers (a date)
 * and a one-word title under three letters are left out: they match everything.
 */
export function buildTerms(notes, { personTypes = ['person'], companyTypes = ['company'] } = {}) {
  const titles = new Set();
  const partials = new Set();
  const nameWords = new Set();
  const people = new Set(personTypes.map((type) => type.toLowerCase()));
  const companies = new Set(companyTypes.map((type) => type.toLowerCase()));

  const addPhrase = (phrase) => {
    const phraseWords = words(phrase);
    if (phraseWords.length === 0 || phraseWords.every(isNumber)) return null;
    if (phraseWords.length === 1 && phraseWords[0].length < 3) return null;
    titles.add(phraseWords.join(' '));
    for (const partial of partialsOf(phraseWords)) partials.add(partial);
    return phraseWords;
  };

  for (const note of notes) {
    const types = (note.types ?? []).map((type) => String(type).toLowerCase());
    const titleWords = addPhrase(note.title ?? '');
    const aliasWords = (note.aliases ?? []).map(addPhrase).filter(Boolean);
    if (titleWords && types.some((type) => people.has(type)) && titleWords.length >= 2) {
      const surname = titleWords[titleWords.length - 1];
      if (isContentWord(surname)) nameWords.add(surname);
    }
    if (types.some((type) => companies.has(type))) {
      // A company's first word is the one that names it ("Harbourline" of "Harbourline Freight").
      for (const phraseWords of [titleWords, ...aliasWords]) {
        const first = phraseWords?.[0];
        if (first && phraseWords.length >= 2 && first.length >= 4 && isContentWord(first)) nameWords.add(first);
      }
    }
  }
  for (const partial of partials) if (titles.has(partial)) partials.delete(partial);
  return { titles: [...titles].sort(), partials: [...partials].sort(), nameWords: [...nameWords].sort() };
}

/** Longest phrase of `phrases` (a Set) that starts at word `i`, as a word count, else 0. */
function longestAt(lineWords, i, phrases, longestByFirstWord) {
  const longest = Math.min(longestByFirstWord.get(lineWords[i]) ?? 0, lineWords.length - i);
  for (let n = longest; n >= 1; n--) {
    if (phrases.has(n === 1 ? lineWords[i] : lineWords.slice(i, i + n).join(' '))) return n;
  }
  return 0;
}

function indexByFirstWord(phrases) {
  const longest = new Map();
  for (const phrase of phrases) {
    const phraseWords = phrase.split(' ');
    if ((longest.get(phraseWords[0]) ?? 0) < phraseWords.length) longest.set(phraseWords[0], phraseWords.length);
  }
  return longest;
}

/**
 * Builds a matcher from term lists (already in word form, as `buildTerms` returns them) and
 * the allowed phrases. `scanLine(line)` returns `{ kind, match }` for each distinct match on
 * the line, where `match` is the line's own words.
 */
export function createMatcher({ titles = [], partials = [], nameWords = [], allow = [] } = {}) {
  const allowed = new Set(allow.map((phrase) => words(phrase).join(' ')).filter(Boolean));
  const titleSet = new Set(titles.filter((title) => !allowed.has(title)));
  const partialSet = new Set(partials.filter((partial) => !allowed.has(partial)));
  const nameSet = new Set(nameWords.filter((word) => !allowed.has(word)));
  const allowedIndex = indexByFirstWord(allowed);
  const titleIndex = indexByFirstWord(titleSet);

  function scanWords(lineWords) {
    if (lineWords.length === 0) return [];
    const found = new Map();
    // Word ranges already answered for: an allowed phrase, or a title reported whole.
    const covered = [];
    const inside = (start, end) => covered.some(([from, to]) => from <= start && end <= to);

    for (let i = 0; i < lineWords.length; i++) {
      const n = longestAt(lineWords, i, allowed, allowedIndex);
      if (n > 0) covered.push([i, i + n]);
    }
    for (let i = 0; i < lineWords.length; i++) {
      const n = longestAt(lineWords, i, titleSet, titleIndex);
      if (n === 0 || inside(i, i + n)) continue;
      covered.push([i, i + n]);
      const match = lineWords.slice(i, i + n).join(' ');
      found.set(`title ${match}`, { kind: 'title', match });
    }
    for (let i = 0; i < lineWords.length; i++) {
      if (nameSet.has(lineWords[i]) && !inside(i, i + 1)) {
        found.set(`name ${lineWords[i]}`, { kind: 'name', match: lineWords[i] });
      }
      if (i + 3 > lineWords.length || inside(i, i + 3)) continue;
      const match = `${lineWords[i]} ${lineWords[i + 1]} ${lineWords[i + 2]}`;
      if (partialSet.has(match)) found.set(`partial ${match}`, { kind: 'partial', match });
    }
    return [...found.values()];
  }

  return { scanWords, scanLine: (line) => scanWords(words(line)), size: titleSet.size + partialSet.size + nameSet.size };
}

/** Every match in a text: `{ line, kind, match }`, with 1-based line numbers. */
export function scanText(matcher, text) {
  const findings = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const hit of matcher.scanLine(lines[i])) findings.push({ line: i + 1, ...hit });
  }
  return findings;
}

/**
 * Scans a set of files as one tree. `add(path, text)` takes each file (text may be null for
 * binary content; the path is scanned as line 0). `findings()` then returns
 * `{ path, line, kind, match }`, without the partials and names made only of words that
 * COMMON_IN_FILES or more of the files share.
 */
export function createTreeScan(matcher) {
  const filesWithWord = new Map();
  const pending = [];
  return {
    add(path, text) {
      const seen = new Set();
      const scan = (line, lineNumber) => {
        const lineWords = words(line);
        for (const word of lineWords) seen.add(word);
        for (const hit of matcher.scanWords(lineWords)) pending.push({ path, line: lineNumber, ...hit });
      };
      scan(path, 0);
      if (text !== null) text.split(/\r\n|\r|\n/).forEach((line, index) => scan(line, index + 1));
      for (const word of seen) filesWithWord.set(word, (filesWithWord.get(word) ?? 0) + 1);
    },
    findings() {
      const rare = (word) => (filesWithWord.get(word) ?? 0) < COMMON_IN_FILES;
      return pending.filter((hit) => hit.kind === 'title' || hit.match.split(' ').filter(isContentWord).some(rare));
    },
  };
}

/** Where the private terms are read from. */
export function privateTermsDir(env = process.env) {
  if (env.VAULT_ENGINE_PRIVATE_TERMS) return env.VAULT_ENGINE_PRIVATE_TERMS;
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'vault-engine', 'private-terms');
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean);
}

/**
 * Reads the private terms directory. Returns null when it does not exist, else
 * `{ dir, ownerNames, matcher, vaultTitleCount, builtAt, noteCount }`. Every file in it is
 * optional, so a caller that must not run unchecked asks `missingPrivateTerms` as well.
 */
export function loadPrivateTerms(dir = privateTermsDir()) {
  if (!existsSync(dir)) return null;
  const vaultTermsPath = join(dir, 'vault-terms.json');
  const vaultTerms = existsSync(vaultTermsPath) ? JSON.parse(readFileSync(vaultTermsPath, 'utf8')) : {};
  const extra = buildTerms(readLines(join(dir, 'extra-terms.txt')).map((title) => ({ title })));
  const matcher = createMatcher({
    titles: [...(vaultTerms.titles ?? []), ...extra.titles],
    partials: [...(vaultTerms.partials ?? []), ...extra.partials],
    nameWords: vaultTerms.nameWords ?? [],
    allow: readLines(join(dir, 'allow.txt')),
  });
  return {
    dir,
    ownerNames: readLines(join(dir, 'owner-names.txt')),
    matcher,
    vaultTitleCount: (vaultTerms.titles ?? []).length,
    builtAt: vaultTerms.builtAt ?? null,
    noteCount: vaultTerms.noteCount ?? null,
  };
}

/**
 * What the loaded terms lack for each rule to run, as sentences; empty when both rules have
 * something to look for. `terms` is what `loadPrivateTerms` returned.
 */
export function missingPrivateTerms(terms) {
  if (terms === null) return ['no private terms are set up, so owner-name and private-term did not run'];
  const missing = [];
  if (terms.ownerNames.length === 0) missing.push('owner-names.txt holds no name, so owner-name did not run');
  if (terms.vaultTitleCount === 0) {
    missing.push('vault-terms.json holds no titles (scripts/build-private-terms.mjs writes it), so no note title was looked for');
  }
  return missing;
}
