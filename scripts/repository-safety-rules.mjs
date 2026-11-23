// Repository-safety rules. Pure, dependency-free, and safe to unit test.
//
// scanTrackedFile(path, bytes, options) returns findings of shape { ruleId, path, line }.
// scanTrackedPath(path, options) applies content rules to the path text and redacts it.
// isForbiddenTrackedPath(path) returns a rule id string for a forbidden filename,
// or null when the path is allowed.
//
// Findings intentionally never carry the matched text: callers must not print
// credentials or owner data. No owner term lives in this module: the owner-name rule
// takes its names from the caller (`options.ownerNames`), who reads them from outside
// the repository (see private-terms.mjs). With no names it does not run.

import { createHash } from 'node:crypto';

const SYNTHETIC_NODE_IDS = new Set([
  'projectAlphaRoot00001',
  'projectAlphaHome00001',
  'projectAlphaPage00001',
]);

/** Documentation paths that historically described the reconciliation incident.
 *  Besides the random-shape test every Markdown file gets (#128), any 21-character
 *  letter-and-digit token counts as a production node ID here; that looser shape
 *  would match ordinary names like `relationship_views_v1` elsewhere. */
const INCIDENT_DOC_PATTERNS = [
  /2026-08-17-curator-reconciliation/,
  /wiki-semantic-reconciliation/,
];

/** Dated historical design records. The owner-name rule is the only rule that
 *  may exempt them (per issue #122); every other rule has no documentation
 *  exception. */
export function isHistoricalRecord(path) {
  const p = normalize(path);
  return p.startsWith('docs/foundations/') || p.includes('/superpowers/') || p.startsWith('superpowers/');
}

const NODE_ID_SHAPE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{21}(?![A-Za-z0-9_-])/g;

function isMarkdown(path) {
  return /\.(md|mdx)$/i.test(normalize(path));
}

/**
 * True for a 21-character token that looks random, the way an Engine node ID does,
 * rather than like a name (#128). Split at case changes, digits and separators, with an
 * all-caps run as one piece (`HTML`), a name breaks into a few word-sized pieces
 * (`isStrictIsoDateString` → 5) and a random ID into many short ones (11 to 15). Seven
 * or more pieces with both cases catches about 99.4% of random 21-character IDs, and
 * nothing tracked in Markdown but real IDs when it was written. Single-case tokens
 * (`kimi-k2-instruct-0905`, hex) never count.
 */
export function looksLikeRandomNodeId(token) {
  if (token.length !== 21 || SYNTHETIC_NODE_IDS.has(token)) return false;
  if (!/[A-Z]/.test(token) || !/[a-z]/.test(token)) return false;
  const pieces = token.match(/[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+|[0-9]+/g) ?? [];
  return pieces.length >= 7;
}

function findRandomNodeId(line) {
  for (const m of line.matchAll(NODE_ID_SHAPE)) {
    if (looksLikeRandomNodeId(m[0])) return true;
  }
  return false;
}

function findLetterDigitNodeId(line) {
  for (const m of line.matchAll(NODE_ID_SHAPE)) {
    const id = m[0];
    if (!SYNTHETIC_NODE_IDS.has(id) && /[0-9]/.test(id) && /[A-Za-z]/.test(id)) return true;
  }
  return false;
}

function normalize(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.\//, '');
}

function basename(path) {
  return normalize(path).split('/').pop() ?? '';
}

function extension(path) {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

// --- forbidden tracked filenames -------------------------------------------

const FORBIDDEN_BASENAMES = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.netrc',
  '.git-credentials',
  'credentials',
]);

const FORBIDDEN_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.kdbx',
  '.bak',
  '.backup',
  '.dump',
  '.ppk',
]);

/** SQLite databases, every sidecar suffix (WAL, SHM, rollback journal), and
 *  compressed/archived database backups. */
const FORBIDDEN_SQLITE_RE =
  /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?(?:\.(?:gz|bz2|xz|zip|tar|tgz|7z|zst))?$/i;

/** True when path looks like an environment file that is not an example. */
function isNonExampleEnvFile(base) {
  const lower = base.toLowerCase();
  if (lower.endsWith('.example')) return false;
  return /^\.env(?:\.|$)|\.env$/.test(lower);
}

export function isForbiddenTrackedPath(path) {
  const p = normalize(path);
  const base = basename(p);
  const lower = p.toLowerCase();
  const lowerBase = base.toLowerCase();

  if (lower === 'packages/curator/eval/corpus.json') return 'forbidden-local-eval-corpus';
  if (isNonExampleEnvFile(lowerBase)) return 'forbidden-env-file';
  if (lower === '.aws/credentials' || lower.endsWith('/.aws/credentials')) return 'forbidden-credential-store';
  if (lower === '.docker/config.json' || lower.endsWith('/.docker/config.json') || lowerBase === '.dockercfg') {
    return 'forbidden-credential-store';
  }
  if (/(?:^|\/)\.ssh\//.test(lower) && !lower.endsWith('.pub')) return 'forbidden-credential-store';
  if (FORBIDDEN_BASENAMES.has(lowerBase)) return 'forbidden-private-key';
  if (/(?:^|\/)\.obsidian\/data\.json$/.test(lower)) return 'forbidden-obsidian-data';
  if (FORBIDDEN_SQLITE_RE.test(base)) return 'forbidden-secret-file';
  if (FORBIDDEN_EXTENSIONS.has(extension(p))) return 'forbidden-secret-file';
  return null;
}

// --- secret and identifier patterns ----------------------------------------

const SECRET_RULES = [
  {
    ruleId: 'pem-private-key',
    re: /-----BEGIN (?:ENCRYPTED |RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    ruleId: 'putty-private-key',
    re: /PuTTY-User-Key-File-\d/,
  },
  {
    ruleId: 'aws-access-key-id',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    ruleId: 'github-token',
    re: /\b(?:ghp|gho|ghu)_[A-Za-z0-9_]{36}\b|\bghr_[A-Za-z0-9_]{76}\b|\bghs_[A-Za-z0-9_.-]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  },
  {
    ruleId: 'provider-api-key',
    re: /\bsk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}\b|\bsk-or-v1-[a-f0-9]{32,}\b|\bsk-[A-Za-z0-9]{32,}\b|\bfw_[A-Za-z0-9]{20,}\b|(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/,
  },
];

const ASSIGNMENT_KEY_RE =
  /(?:api[_-]?key|secret|token|password|passwd|bearer|credential)|(?:^|_)auth$/i;

function looksLikePlaceholderOrSlug(value) {
  if (value.length < 12) return true;
  if (/^task-\d/i.test(value)) return true;
  // A template interpolation is source code, not a literal credential.
  if (value.includes('${')) return true;
  // Lowercase slug (descriptive-words): requires a separator, so a bare
  // lowercase alphanumeric (a hex/base64 token) is NOT exempted here.
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value)) return true;
  // Exempt only explicit placeholder vocabulary, not arbitrary grouped
  // alphabetic values that may be real generated credentials.
  if (isExplicitPlaceholder(value)) return true;
  return false;
}

function isExplicitPlaceholder(value) {
  if (
    /^(?:FIXTURE-CREDENTIAL|(?:FIXTURE-)?CREDENTIAL-MARKER|RAW-MODEL-SECRET|FILTERED-PARTIAL-OUTPUT)-[0-9a-f]{4}$/i.test(
      value,
    )
  ) {
    return true;
  }
  if (/^SECRET_(?:ENUM_CURRENT|LIST_ELEMENT)_VALUE_[0-9a-f]{4}$/i.test(value)) return true;
  return false;
}

/** Opaque-looking secret value: mixed-case + digit, hex, or base64. */
function isOpaqueSecret(value) {
  if (/^[a-f0-9]{32,}$/i.test(value)) return true;
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(value)) return true;
  return /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value);
}

/** Contextual bearer/secret assignment: KEY=longvalue or KEY: "longvalue",
 *  restricted to opaque-looking literals so ordinary property chains such as
 *  `token: this.plugin.settings.token` or slugs such as `task-1-...` do not
 *  produce false positives. Quoted values are captured through the matching
 *  quote so punctuation-bearing passwords/base64 (`!`, `=`) are covered. */
function supportsUnquotedConfigScalars(path) {
  const p = normalize(path).toLowerCase();
  const ext = extension(p);
  return (
    ['.yaml', '.yml', '.toml', '.ini', '.conf', '.config'].includes(ext) ||
    /(?:^|\/)\.env(?:\.|$)/.test(p)
  );
}

function findAssignmentSecretOffsets(path, text) {
  // Each quoting form is matched on its own, so the other quote character and
  // escaped delimiters stay inside the captured value.
  const re =
    /["']?([A-Za-z0-9_-]+)["']?\s*[:=]\s*(?:"((?:[^"\\\n]|\\.){12,})"|'((?:[^'\\\n]|\\.){12,})'|([A-Za-z0-9_-]{12,}))/g;
  const offsets = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!ASSIGNMENT_KEY_RE.test(m[1])) continue;
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (looksLikePlaceholderOrSlug(value)) continue;
    if (isOpaqueSecret(value)) offsets.push(m.index);
  }

  if (supportsUnquotedConfigScalars(path)) {
    const plainScalarRe =
      /["']?([A-Za-z0-9_-]+)["']?[ \t]*[:=][ \t]*(?!["'])([^\s#,\[\]{}]{12,})/g;
    while ((m = plainScalarRe.exec(text)) !== null) {
      if (!ASSIGNMENT_KEY_RE.test(m[1])) continue;
      const value = m[2] ?? '';
      if (looksLikePlaceholderOrSlug(value)) continue;
      if (isOpaqueSecret(value)) offsets.push(m.index);
    }
  }
  return offsets;
}

const CLOUDFLARE_CONTEXT_RE = /(account|zone|tunnel|dns[ _-]?record)/i;
const CLOUDFLARE_HEX_ID_RE = /\b[0-9a-f]{32}\b/;
const CLOUDFLARE_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

function findCloudflareId(line) {
  if (!CLOUDFLARE_CONTEXT_RE.test(line)) return false;
  return CLOUDFLARE_HEX_ID_RE.test(line) || CLOUDFLARE_UUID_RE.test(line);
}

function findMultilineCloudflareIdOffsets(text) {
  const re =
    /(?:account|zone|tunnel|dns[ _-]?record)(?:[_ -]?id)?["']?[ \t]*[:=][ \t]*(?:\r\n|\r|\n)[ \t]*["']?(?:[0-9a-f]{32}\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)/gi;
  return Array.from(text.matchAll(re), (match) => match.index);
}

// --- path, hostname, owner-name rules (active surfaces only) ----------------

// A leading boundary keeps relative path chains such as "retire/home/stamp"
// from being read as a home directory.
const HOME_PATH_RE =
  /(?<![A-Za-z0-9._/-])(?:\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+)(?![A-Za-z0-9._-])/i;

/** A developer-local vault/database path: a home directory (absolute or tilde)
 *  combined with `.vault-engine` or a database file. This catches a personal
 *  vault basename without the scanner hard-coding that basename. */
function findDeveloperVaultPath(line) {
  return DEVELOPER_VAULT_PATH_RE.test(line);
}

// Path segments exclude separators so the repetition has one way to split a
// path; otherwise a deep path without a match backtracks exponentially.
const DEVELOPER_VAULT_PATH_RE =
  /(?<![A-Za-z0-9._/-])(?:\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+|~(?:[A-Za-z_][A-Za-z0-9._-]*)?)(?:[\\/][^\s`"'<>\\/]*)*(?:\.vault-engine|\.db\b)/i;

const ALLOWED_HOST_SUFFIXES = [
  '.example.com',
  '.example.org',
  '.example.net',
  '.example',
  '.test',
  '.invalid',
  '.localhost',
];

const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'example.com',
  'example.org',
  'example.net',
  'openrouter.ai',
  'api.anthropic.com',
  'api.fireworks.ai',
  'api.together.xyz',
  'generativelanguage.googleapis.com',
  'api.deepgram.com',
  'api.exa.ai',
  'github.com',
  'npmjs.com',
  'obsidian.md',
  'nodejs.org',
]);

function hostnameAllowed(host) {
  const h = host.toLowerCase();
  if (ALLOWED_HOSTS.has(h)) return true;
  // Single-label service names are portable container/test-network aliases,
  // not identifying deployment FQDNs.
  if (!h.includes('.')) return true;
  return ALLOWED_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

const URL_HOST_CONTEXT_RE =
  /(?:ENGINE_URL|OAUTH_ISSUER_URL|CURATOR_[A-Z_]+|BASE_URL|\bhost\b|origin)[`"']?\s*(?:(?:[:=]\s*)|(?:\bto\b\s*))?[`"']?https?:\/\/([A-Za-z0-9.-]+)/gi;
const BARE_HOST_CONTEXT_RE =
  /(?:server_name\s+|\bhost\s*[:=]\s*)["']?([A-Za-z0-9.-]+)(?::[0-9]{1,5})?(?=[\s;,\'"}\]]|$)/gi;

function findDeploymentHostname(line) {
  for (const re of [URL_HOST_CONTEXT_RE, BARE_HOST_CONTEXT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      const host = m[1];
      if (host === undefined || host.startsWith('<') || host.includes('your-')) continue;
      if (!hostnameAllowed(host)) return true;
    }
  }
  return false;
}

function findMultilineDeploymentHostnameOffsets(text) {
  const re =
    /(?:ENGINE_URL|OAUTH_ISSUER_URL|CURATOR_[A-Z_]+|BASE_URL|\bhost\b|origin)["']?[ \t]*[:=][ \t]*(?:\r\n|\r|\n)[ \t]*["']?https?:\/\/([A-Za-z0-9.-]+)/gi;
  const offsets = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const host = match[1];
    if (host !== undefined && !hostnameAllowed(host)) offsets.push(match.index);
  }
  return offsets;
}

/** One alternation of the owner's names, each escaped, or null when there are none. */
function ownerNamePattern(ownerNames) {
  const names = (ownerNames ?? []).map((name) => String(name).trim()).filter(Boolean);
  if (names.length === 0) return null;
  return `(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
}

function findOwnerName(line, name) {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${name}(?![\\p{L}\\p{N}_])`, 'iu').test(line);
}

function isHistoricalOwnerAttribution(line, name) {
  const approvalVerb = '(?:approved|authorized|reviewed|waived)';
  const modifier = '(?:(?:already|explicitly|later|previously|separately|subsequently|then)\\s+){0,2}';
  const artifact =
    '(?:branch|change|commit|decision|design|implementation|merge|option|plan|policy|proposal|pull request|release|requirement|review|scope|spec(?:ification)?|task|workflow|work)';
  const determiner = '(?:(?:an?|the|this|that|these|those|written)\\s+)?';
  const prefix = '(?:[-*>#]+\\s*)?(?:\\*\\*[^*]+:\\*\\*\\s*)?';
  const suffix = '(?:\\s+on\\s+\\d{4}-\\d{2}-\\d{2})?[.!]?';
  return (
    new RegExp(`^\\s*${prefix}${name}\\s+${modifier}${approvalVerb}\\s+${determiner}${artifact}${suffix}\\s*$`, 'i').test(
      line,
    ) ||
    new RegExp(`^\\s*${prefix}${determiner}${artifact}\\s+${approvalVerb}\\s+by\\s+${name}${suffix}\\s*$`, 'i').test(
      line,
    )
  );
}

// --- per-line dispatch ------------------------------------------------------

function scanLines(path, text, check, findings) {
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (check(line)) findings.push({ ruleId: check.ruleId, path, line: i + 1 });
  }
}

function scanAssignmentSecrets(path, text, findings) {
  scanOffsets(path, text, findAssignmentSecretOffsets(path, text), 'bearer-token-assignment', findings);
}

function scanOffsets(path, text, offsets, ruleId, findings) {
  const reportedLines = new Set();
  for (const offset of offsets) {
    const line = text.slice(0, offset).split(/\r\n|\r|\n/).length;
    if (reportedLines.has(line)) continue;
    reportedLines.add(line);
    findings.push({ ruleId, path, line });
  }
}

/** The text of a tracked file, or null for binary content. */
export function decodeTrackedText(buffer) {
  const utf16le = buffer[0] === 0xff && buffer[1] === 0xfe;
  const utf16be = buffer[0] === 0xfe && buffer[1] === 0xff;
  if (utf16le || utf16be) {
    const body = Buffer.from(buffer.subarray(2));
    if (body.length % 2 !== 0) return null;
    if (utf16be) body.swap16();
    const text = body.toString('utf16le');
    return text.includes('\0') ? null : text;
  }
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

/**
 * Scan one tracked file's content. `bytes` may be a Buffer or Uint8Array.
 * BOM-marked UTF-16 text is decoded; remaining NUL-bearing binary content is
 * skipped deterministically.
 */
export function scanTrackedFile(path, bytes, { ownerNames = [] } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = decodeTrackedText(buffer);
  if (text === null) return [];
  const findings = [];
  const p = normalize(path);

  for (const rule of SECRET_RULES) {
    scanLines(p, text, Object.assign((line) => rule.re.test(line), { ruleId: rule.ruleId }), findings);
  }

  scanAssignmentSecrets(p, text, findings);
  scanLines(p, text, Object.assign(findCloudflareId, { ruleId: 'cloudflare-resource-id' }), findings);
  scanOffsets(p, text, findMultilineCloudflareIdOffsets(text), 'cloudflare-resource-id', findings);

  // Every Markdown file gets the random-shape test; the incident records also flag any
  // letter-and-digit token, so they are never less strict than other docs.
  const incidentDoc = INCIDENT_DOC_PATTERNS.some((re) => re.test(p));
  if (incidentDoc || isMarkdown(p)) {
    scanLines(
      p,
      text,
      Object.assign(
        (line) => findRandomNodeId(line) || (incidentDoc && findLetterDigitNodeId(line)),
        { ruleId: 'production-node-id' },
      ),
      findings,
    );
  }

  // Personal home/vault paths have no documentation exception: dated plans can
  // still contain executable owner-database commands, so these scan every file.
  scanLines(p, text, Object.assign(findDeveloperVaultPath, { ruleId: 'developer-vault-path' }), findings);
  scanLines(p, text, Object.assign((line) => HOME_PATH_RE.test(line), { ruleId: 'owner-home-path' }), findings);

  // The owner's names come from the caller. Historical records may carry one only in
  // approval/provenance attribution.
  const ownerName = ownerNamePattern(ownerNames);
  if (ownerName !== null) {
    scanLines(
      p,
      text,
      Object.assign(
        (line) =>
          findOwnerName(line, ownerName) && !(isHistoricalRecord(p) && isHistoricalOwnerAttribution(line, ownerName)),
        { ruleId: 'owner-name' },
      ),
      findings,
    );
  }

  // Infrastructure hostnames have no documentation exception: dated records can
  // still carry production endpoints, so this rule scans every tracked file.
  scanLines(p, text, Object.assign(findDeploymentHostname, { ruleId: 'deployment-hostname' }), findings);
  scanOffsets(p, text, findMultilineDeploymentHostnameOffsets(text), 'deployment-hostname', findings);

  return findings;
}

/** Scan the tracked path itself without returning any sensitive component. */
export function scanTrackedPath(path, options = {}) {
  const p = normalize(path);
  const ruleIds = new Set(scanTrackedFile(p, Buffer.from(p, 'utf8'), options).map((finding) => finding.ruleId));
  if (ruleIds.size === 0) return [];
  const digest = createHash('sha256').update(p).digest('hex').slice(0, 12);
  const redactedPath = `redacted-path-sha256-${digest}`;
  return Array.from(ruleIds, (ruleId) => ({ ruleId, path: redactedPath, line: 0 }));
}
