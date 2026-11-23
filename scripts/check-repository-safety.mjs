// Zero-dependency tracked-file safety check for the repository.
//
// Usage: node scripts/check-repository-safety.mjs
//
// Reads `git ls-files -z` (never shell-interpolated), reads only tracked files,
// skips binary content by detecting NUL bytes, and prints one redacted finding
// per line: `<path>:<line>: <ruleId>`. The matched value is never printed;
// sensitive tracked paths are replaced with a stable SHA-256 identifier. Exits
// nonzero when any finding exists. Resolves the repository root from any cwd.
//
// Rules and filename policy live in repository-safety-rules.mjs.
//
// Two rules need terms kept outside the repository (private-terms.mjs): `owner-name`, and
// `private-term`, which finds a real note title, a trimmed copy of one, or a real name.
// Where no private terms are set up, or a file of them is empty, the rule that needs it
// does not run and the check says so on its last line. A `private-term`
// finding does print its match: those are the file's own words, and nobody can fix the
// line without knowing which they are. Dated historical records are not held to it. A path
// that is itself sensitive is scanned for terms under its redacted name, so nothing in it
// is printed.

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTreeScan, loadPrivateTerms, missingPrivateTerms } from './private-terms.mjs';
import {
  decodeTrackedText,
  isForbiddenTrackedPath,
  isHistoricalRecord,
  scanTrackedFile,
  scanTrackedPath,
} from './repository-safety-rules.mjs';

export function resolveRepoRoot(startDir = process.cwd()) {
  const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: startDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.trim();
}

export function listTrackedFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.toString('utf8').split('\0').filter((p) => p !== '');
}

export function formatFinding(finding) {
  return `${finding.path}:${finding.line}: ${finding.ruleId}`;
}

/** `private-term` findings grouped by what matched, fewest lines first. */
export function formatTermFindings(findings) {
  const groups = new Map();
  for (const finding of findings) {
    if (finding.ruleId !== 'private-term') continue;
    const key = `${finding.kind} ${finding.match}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { kind: finding.kind, match: finding.match, lines: 0, files: new Set(), first: [] }));
    group.lines += 1;
    group.files.add(finding.path);
    if (group.first.length < 3) group.first.push(`${finding.path}:${finding.line}`);
  }
  return [...groups.values()]
    .sort((a, b) => a.lines - b.lines || a.match.localeCompare(b.match))
    .map(
      (group) =>
        `private-term (${group.kind}) "${group.match}": ${group.lines} line(s) in ${group.files.size} file(s): ${group.first.join(', ')}`,
    );
}

/**
 * Scan the given files under root and return findings. Only a `private-term` finding
 * carries text (`kind`, `match`). `terms` is what `loadPrivateTerms` returns, or null.
 * `termsEverywhere` holds historical records to the term rule too.
 */
export function scanPaths(root, paths, terms = null, { termsEverywhere = false } = {}) {
  const findings = [];
  const options = { ownerNames: terms?.ownerNames ?? [] };
  const treeScan = terms === null ? null : createTreeScan(terms.matcher);
  for (const path of paths) {
    const pathFindings = scanTrackedPath(path, options);
    const displayPath = pathFindings[0]?.path ?? path;
    findings.push(...pathFindings);
    const forbidden = isForbiddenTrackedPath(path);
    if (forbidden !== null) {
      findings.push({ ruleId: forbidden, path: displayPath, line: 0 });
      continue;
    }
    let bytes;
    try {
      const absolutePath = resolve(root, path);
      bytes = lstatSync(absolutePath).isSymbolicLink()
        ? Buffer.from(readlinkSync(absolutePath), 'utf8')
        : readFileSync(absolutePath);
    } catch {
      continue;
    }
    const contentFindings = scanTrackedFile(path, bytes, options);
    findings.push(
      ...contentFindings.map((finding) =>
        pathFindings.length > 0 ? { ...finding, path: displayPath } : finding,
      ),
    );
    if (treeScan === null || (!termsEverywhere && isHistoricalRecord(path))) continue;
    treeScan.add(displayPath, decodeTrackedText(bytes));
  }
  for (const hit of treeScan?.findings() ?? []) findings.push({ ruleId: 'private-term', ...hit });
  return findings;
}

/** Scan every tracked file under root and return findings. */
export function runCheck(root = resolveRepoRoot(), terms = loadPrivateTerms()) {
  return scanPaths(root, listTrackedFiles(root), terms);
}

/** Prints findings the way the command does and returns how many there were. */
export function reportFindings(findings, log = console.error) {
  for (const finding of findings) {
    if (finding.ruleId !== 'private-term') log(formatFinding(finding));
  }
  for (const line of formatTermFindings(findings)) log(line);
  return findings.length;
}

function isMain() {
  if (typeof process === 'undefined' || process.argv[1] === undefined) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMain()) {
  const root = resolveRepoRoot();
  const terms = loadPrivateTerms();
  const findings = runCheck(root, terms);
  const missing = missingPrivateTerms(terms);
  const termsNote = missing.length === 0 ? '' : ` (${missing.join('; ')})`;
  if (reportFindings(findings) === 0) {
    console.log(`[repo-safety] no findings${termsNote}`);
    process.exit(0);
  }
  console.error(`[repo-safety] ${findings.length} finding(s)${termsNote}`);
  process.exit(1);
}
