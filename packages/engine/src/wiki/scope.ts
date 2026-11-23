export interface WikiScopeV1 {
  v: 1;
  subject: string;
  facet: string;
  timeframe?: string;
  geography?: string;
  entities?: string[];
  exclusions?: string[];
}

export type WikiScopeErrorCode =
  | 'MALFORMED_JSON'
  | 'INVALID_SCOPE'
  | 'UNSUPPORTED_VERSION'
  | 'MISSING_SUBJECT'
  | 'MISSING_FACET'
  | 'INVALID_SCALAR'
  | 'INVALID_ARRAY';

export type WikiScopeParseResult =
  | { readonly ok: true; readonly scope: WikiScopeV1 }
  | { readonly ok: false; readonly code: WikiScopeErrorCode };

type ArrayParseResult =
  | { readonly kind: 'valid'; readonly values?: string[] }
  | { readonly kind: 'invalid' };

class WikiScopeCanonicalizationError extends Error {
  constructor(readonly code: WikiScopeErrorCode) {
    super(code);
    this.name = 'WikiScopeCanonicalizationError';
  }
}

export function canonicalizeWikiScope(input: unknown): WikiScopeV1 {
  const result = parseWikiScope(input);
  if (result.ok) return result.scope;
  throw new WikiScopeCanonicalizationError(result.code);
}

export function parseWikiScope(raw: unknown): WikiScopeParseResult {
  if (typeof raw === 'string') {
    try {
      return parseWikiScopeObject(JSON.parse(raw));
    } catch {
      return { ok: false, code: 'MALFORMED_JSON' };
    }
  }
  return parseWikiScopeObject(raw);
}

export function serializeWikiScope(scope: WikiScopeV1): string {
  return serializeCanonicalScope(canonicalizeWikiScope(scope));
}

export function wikiScopeComparisonKey(scope: WikiScopeV1): string {
  const canonical = canonicalizeWikiScope(scope);
  return serializeCanonicalScope({
    v: 1,
    subject: canonical.subject.toLowerCase(),
    facet: canonical.facet.toLowerCase(),
    ...(canonical.timeframe === undefined ? {} : { timeframe: canonical.timeframe.toLowerCase() }),
    ...(canonical.geography === undefined ? {} : { geography: canonical.geography.toLowerCase() }),
    ...(canonical.entities === undefined ? {} : { entities: canonical.entities.map(value => value.toLowerCase()) }),
    ...(canonical.exclusions === undefined ? {} : { exclusions: canonical.exclusions.map(value => value.toLowerCase()) }),
  });
}

export function sameWikiScope(a: WikiScopeV1, b: WikiScopeV1): boolean {
  return wikiScopeComparisonKey(a) === wikiScopeComparisonKey(b);
}

function parseWikiScopeObject(input: unknown): WikiScopeParseResult {
  if (!isPlainObject(input)) return { ok: false, code: 'INVALID_SCOPE' };
  if (input['v'] !== 1) return { ok: false, code: 'UNSUPPORTED_VERSION' };

  const subject = parseRequiredString(input['subject']);
  if (subject === 'invalid') return { ok: false, code: 'INVALID_SCALAR' };
  if (subject === 'missing') return { ok: false, code: 'MISSING_SUBJECT' };

  const facet = parseRequiredString(input['facet']);
  if (facet === 'invalid') return { ok: false, code: 'INVALID_SCALAR' };
  if (facet === 'missing') return { ok: false, code: 'MISSING_FACET' };

  const timeframe = parseOptionalString(input['timeframe']);
  if (timeframe === 'invalid') return { ok: false, code: 'INVALID_SCALAR' };
  const geography = parseOptionalString(input['geography']);
  if (geography === 'invalid') return { ok: false, code: 'INVALID_SCALAR' };

  const entities = parseOptionalArray(input['entities']);
  switch (entities.kind) {
    case 'invalid':
      return { ok: false, code: 'INVALID_ARRAY' };
    case 'valid':
      break;
    default:
      return assertNever(entities);
  }

  const exclusions = parseOptionalArray(input['exclusions']);
  switch (exclusions.kind) {
    case 'invalid':
      return { ok: false, code: 'INVALID_ARRAY' };
    case 'valid':
      break;
    default:
      return assertNever(exclusions);
  }

  return {
    ok: true,
    scope: {
      v: 1,
      subject,
      facet,
      ...(timeframe === undefined ? {} : { timeframe }),
      ...(geography === undefined ? {} : { geography }),
      ...(entities.values === undefined ? {} : { entities: entities.values }),
      ...(exclusions.values === undefined ? {} : { exclusions: exclusions.values }),
    },
  };
}

function serializeCanonicalScope(scope: WikiScopeV1): string {
  return JSON.stringify({
    v: scope.v,
    subject: scope.subject,
    facet: scope.facet,
    ...(scope.timeframe === undefined ? {} : { timeframe: scope.timeframe }),
    ...(scope.geography === undefined ? {} : { geography: scope.geography }),
    ...(scope.entities === undefined ? {} : { entities: scope.entities }),
    ...(scope.exclusions === undefined ? {} : { exclusions: scope.exclusions }),
  });
}

function parseRequiredString(value: unknown): string | 'invalid' | 'missing' {
  if (value === undefined) return 'missing';
  if (typeof value !== 'string') return 'invalid';
  const normalized = normalizeString(value);
  return normalized === '' ? 'missing' : normalized;
}

function parseOptionalString(value: unknown): string | 'invalid' | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return 'invalid';
  const normalized = normalizeString(value);
  return normalized === '' ? undefined : normalized;
}

function parseOptionalArray(value: unknown): ArrayParseResult {
  if (value === undefined) return { kind: 'valid' };
  if (!Array.isArray(value)) return { kind: 'invalid' };

  const displayByLowercase = new Map<string, string>();
  for (const entry of value) {
    if (typeof entry !== 'string') return { kind: 'invalid' };
    const normalized = normalizeString(entry);
    if (normalized === '') continue;
    const lowercase = normalized.toLowerCase();
    if (!displayByLowercase.has(lowercase)) displayByLowercase.set(lowercase, normalized);
  }

  const values = [...displayByLowercase.values()].sort(compareLowercaseCodePoints);
  return values.length === 0 ? { kind: 'valid' } : { kind: 'valid', values };
}

function normalizeString(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function compareLowercaseCodePoints(a: string, b: string): number {
  return compareCodePoints(a.toLowerCase(), b.toLowerCase());
}

function compareCodePoints(a: string, b: string): number {
  const aCharacters = Array.from(a);
  const bCharacters = Array.from(b);
  const shortestLength = Math.min(aCharacters.length, bCharacters.length);
  for (let index = 0; index < shortestLength; index += 1) {
    const aCodePoint = aCharacters[index]?.codePointAt(0);
    const bCodePoint = bCharacters[index]?.codePointAt(0);
    if (aCodePoint === undefined || bCodePoint === undefined) return 0;
    if (aCodePoint < bCodePoint) return -1;
    if (aCodePoint > bCodePoint) return 1;
  }
  return aCharacters.length - bCharacters.length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected wiki scope parse result: ${JSON.stringify(value)}`);
}
