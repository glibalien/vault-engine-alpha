import type Database from 'better-sqlite3';
import { resolveModelRef, defaultsFor, FALLBACK_MODELS, MODEL_PROVIDERS, normalizeModelRef, PROVIDERS } from '@vault/settings-registry';
import type { ModelCatalogEntry, ModelEntryPricing, ModelProvider } from '@vault/settings-registry';
import { LIKE_ESCAPE, literalPrefixPattern } from '../db/like-pattern.js';
import { resolveFieldValue, type FieldRow } from '../mcp/field-value.js';
import { readJson, writeJson } from './store.js';

export interface CatalogIssue { path: string; message: string; }

const VERSION_META_KEY = 'settings.models_version';
const VALID_PROVIDERS: ReadonlySet<string> = new Set<ModelProvider>(MODEL_PROVIDERS);

/** Optional boolean field: undefined/null → undefined (no issue); wrong type → issue, dropped. */
function optBool(fields: Map<string, unknown>, key: string, path: string, issues: CatalogIssue[]): boolean | undefined {
  const raw = fields.get(key);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw;
  issues.push({ path, message: `${key} must be a boolean: ${JSON.stringify(raw)}` });
  return undefined;
}

/** Optional numeric field passing `isValid`: undefined/null → undefined (no issue); invalid → issue, dropped. */
function optNum(
  fields: Map<string, unknown>,
  key: string,
  path: string,
  issues: CatalogIssue[],
  isValid: (n: number) => boolean,
  expectedDesc: string,
): number | undefined {
  const raw = fields.get(key);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && isValid(raw)) return raw;
  issues.push({ path, message: `${key} must be ${expectedDesc}: ${JSON.stringify(raw)}` });
  return undefined;
}

const isPositive = (n: number): boolean => n > 0;
const isNonNegative = (n: number): boolean => n >= 0;

/** The two engine settings that hold a model-ref and are resolved via {@link resolveEngineModelEntry}. */
export type EngineModelKey = 'visionModel' | 'memoryConsolidationModel';

/** Provider + raw model id a resolved engine model-ref points at. Both engine
 *  model-backed paths run on every catalog provider through `@vault/llm`. */
export interface ResolvedEngineModel {
  provider: ModelProvider;
  model: string;
}

/** The minimal shape resolution needs — satisfied by {@link ModelCatalog}, and easy to fake in tests. */
export interface ModelResolver {
  resolve(ref: unknown): ModelCatalogEntry | null;
}

/**
 * A catalog entry is vision-capable if it is explicitly marked `vision: true`,
 * OR it is the legacy `Qwen 3.7 Plus` seed note (which predates the `vision`
 * capability field and is known-good) with no explicit `vision` value. Anything
 * else — `vision: false`, or an unmarked non-Qwen entry — is treated as
 * non-vision-capable. Shared by resolution and the contextual settings validator
 * so both agree on exactly which refs are acceptable for `visionModel`.
 */
export function isVisionCapableEntry(entry: ModelCatalogEntry): boolean {
  if (entry.vision === true) return true;
  if (entry.vision === undefined && entry.title === 'Qwen 3.7 Plus') return true;
  return false;
}

/** One link in the fallback chain: resolve `ref`, then — for visionModel only —
 *  gate on vision capability. A gated-out hit is logged and returned as null so
 *  the chain continues rather than handing a text-only model to vision. */
function resolveEntryOnce(
  catalog: ModelResolver, ref: unknown, key: EngineModelKey,
): ResolvedEngineModel | null {
  const hit = catalog.resolve(ref);
  if (!hit) return null;
  if (key === 'visionModel' && !isVisionCapableEntry(hit)) {
    console.warn(
      `[settings] model ref "${normalizeModelRef(ref)}" (${hit.title}) resolves to a non-vision-capable model — treating as dangling`,
    );
    return null;
  }
  return { provider: hit.provider, model: hit.model };
}

/**
 * Resolves an engine model-ref setting (`visionModel` / `memoryConsolidationModel`)
 * to its provider + raw provider model id, walking the fallback chain:
 * stored ref → registry default ref → hardcoded `FALLBACK_MODELS`. Any catalog
 * provider is accepted. For `visionModel`, a ref resolving to a non-vision-capable
 * model is logged and treated the same as a dangling ref (the referenced
 * Settings/Models/ note was deleted/disabled/retyped), so the chain continues
 * rather than handing a text-only model to vision.
 */
export function resolveEngineModelEntry(
  catalog: ModelResolver,
  ref: unknown,
  key: EngineModelKey,
  fallbackTitle: string,
): ResolvedEngineModel {
  const direct = resolveEntryOnce(catalog, ref, key);
  if (direct !== null) return direct;
  const fromDefault = resolveEntryOnce(catalog, defaultsFor('engine')[key], key);
  if (fromDefault !== null) return fromDefault;
  // FALLBACK_MODELS are hardcoded known-good seeds; the only fallbackTitle used
  // for engine keys is 'Qwen 3.7 Plus' (fireworks).
  const fb = FALLBACK_MODELS[fallbackTitle]!;
  return { provider: fb.provider, model: fb.model };
}

/** Thin string-returning wrapper over {@link resolveEngineModelEntry} for callers
 *  that only need the raw model id. */
export function resolveEngineModel(
  catalog: ModelResolver,
  ref: unknown,
  key: EngineModelKey,
  fallbackTitle: string,
): string {
  return resolveEngineModelEntry(catalog, ref, key, fallbackTitle).model;
}

interface ModelNodeRow {
  id: string;
  title: string | null;
  file_path: string;
}

/**
 * Assembles the model catalog from `Settings/Models/*.md` nodes.
 *
 * Mirrors SettingsService's cache-until-invalidated shape, but the source
 * data is ordinary indexed nodes (one per model) rather than a single
 * `meta.settings.<domain>` blob, so assembly reads `nodes` + `node_fields`
 * directly instead of going through SettingsService/store's domain helpers.
 */
export class ModelCatalog {
  private readonly db: Database.Database;
  private readonly env: Record<string, string | undefined>;
  /** '<settingsDir>/Models/' */
  readonly modelsDir: string;

  private cachedEntries: ModelCatalogEntry[] | null = null;
  private cachedIssues: CatalogIssue[] = [];

  constructor(db: Database.Database, opts: { settingsDir: string; env?: Record<string, string | undefined> }) {
    this.db = db;
    this.modelsDir = `${opts.settingsDir}/Models/`;
    this.env = opts.env ?? process.env;
  }

  /** Prefix match on modelsDir + '.md' suffix — used by the ingest hook to route Models/ file events here. */
  handles(relPath: string): boolean {
    return relPath.startsWith(this.modelsDir) && relPath.endsWith('.md');
  }

  /** Ingest hook calls this on any Models/ change so the next read reassembles from the DB. */
  invalidate(): void {
    this.cachedEntries = null;
    this.cachedIssues = [];
  }

  /** Cached DB assembly; invalid notes excluded. */
  entries(): ModelCatalogEntry[] {
    this.assemble();
    return this.cachedEntries!;
  }

  /** Per-note validation problems from the last assembly. */
  issues(): CatalogIssue[] {
    this.assemble();
    return this.cachedIssues;
  }

  version(): number {
    return readJson<number>(this.db, VERSION_META_KEY, 0);
  }

  bumpVersion(): void {
    writeJson(this.db, VERSION_META_KEY, this.version() + 1);
  }

  /** ENGINE env presence booleans — never surfaces the actual key values. */
  /** Which provider keys the Engine holds: every catalog provider, plus Gemini (vision). */
  providerKeys(): Record<ModelProvider | 'gemini', boolean> {
    const present = (v: string | undefined): boolean => v !== undefined && v.trim() !== '';
    const keys = { gemini: present(this.env['GEMINI_API_KEY']) } as Record<ModelProvider | 'gemini', boolean>;
    for (const provider of MODEL_PROVIDERS) keys[provider] = present(this.env[PROVIDERS[provider].apiKeyEnv]);
    return keys;
  }

  resolve(ref: unknown): ModelCatalogEntry | null {
    return resolveModelRef(this.entries(), ref);
  }

  private assemble(): void {
    if (this.cachedEntries !== null) return;

    const rows = this.db.prepare(
      `SELECT id, title, file_path FROM nodes WHERE file_path LIKE ? ${LIKE_ESCAPE} AND file_path LIKE '%.md' ORDER BY file_path`,
    ).all(literalPrefixPattern(this.modelsDir)) as ModelNodeRow[];

    const entries: ModelCatalogEntry[] = [];
    const issues: CatalogIssue[] = [];
    const seenTitles = new Set<string>();

    for (const row of rows) {
      const fieldRows = this.db.prepare(
        'SELECT field_name, value_text, value_number, value_date, value_json, source FROM node_fields WHERE node_id = ?',
      ).all(row.id) as FieldRow[];
      const fields = new Map<string, unknown>();
      for (const fr of fieldRows) fields.set(fr.field_name, resolveFieldValue(fr));

      const title = row.title ?? '';
      const provider = fields.get('provider');
      const model = fields.get('model');
      const enabledRaw = fields.get('enabled');

      if (typeof provider !== 'string' || !VALID_PROVIDERS.has(provider)) {
        issues.push({ path: row.file_path, message: `invalid provider (expected ${MODEL_PROVIDERS.join(', ')}): ${JSON.stringify(provider)}` });
        continue;
      }
      if (typeof model !== 'string' || model.trim() === '') {
        issues.push({ path: row.file_path, message: 'model must be a non-empty string' });
        continue;
      }

      let enabled: boolean;
      if (enabledRaw === undefined || enabledRaw === null) {
        // Missing enabled defaults to true — the spec's frontmatter default. Not an issue.
        enabled = true;
      } else if (typeof enabledRaw === 'boolean') {
        enabled = enabledRaw;
      } else {
        issues.push({ path: row.file_path, message: `enabled must be a boolean: ${JSON.stringify(enabledRaw)}` });
        continue;
      }

      // Capabilities + context length: bad optional field → issue, dropped, note still included.
      const vision = optBool(fields, 'vision', row.file_path, issues);
      const tools = optBool(fields, 'tools', row.file_path, issues);
      const contextLength = optNum(fields, 'context_length', row.file_path, issues, isPositive, 'a finite positive number');

      // Pricing: price_input and price_output must both be present and valid, or the whole
      // `pricing` field is omitted (with an issue) — never a half-built pricing object.
      let pricing: ModelEntryPricing | undefined;
      const rawPriceInput = fields.get('price_input');
      const rawPriceOutput = fields.get('price_output');
      const priceInputPresent = rawPriceInput !== undefined && rawPriceInput !== null;
      const priceOutputPresent = rawPriceOutput !== undefined && rawPriceOutput !== null;
      if (priceInputPresent || priceOutputPresent) {
        if (!(priceInputPresent && priceOutputPresent)) {
          issues.push({ path: row.file_path, message: 'pricing requires both price_input and price_output to be present' });
        } else {
          const pricingIssues: CatalogIssue[] = [];
          const input = optNum(fields, 'price_input', row.file_path, pricingIssues, isNonNegative, 'a finite non-negative number');
          const output = optNum(fields, 'price_output', row.file_path, pricingIssues, isNonNegative, 'a finite non-negative number');
          const cacheRead = optNum(fields, 'price_cache_read', row.file_path, pricingIssues, isNonNegative, 'a finite non-negative number');
          const cacheWrite = optNum(fields, 'price_cache_write', row.file_path, pricingIssues, isNonNegative, 'a finite non-negative number');
          if (pricingIssues.length > 0) {
            issues.push(...pricingIssues);
          } else {
            pricing = { input: input!, output: output! };
            if (cacheRead !== undefined) pricing.cacheRead = cacheRead;
            if (cacheWrite !== undefined) pricing.cacheWrite = cacheWrite;
          }
        }
      }

      // Duplicate titles: first by path order wins, later ones get an issue.
      if (seenTitles.has(title)) {
        issues.push({ path: row.file_path, message: `duplicate model title: ${JSON.stringify(title)}` });
        continue;
      }
      seenTitles.add(title);

      entries.push({
        title, provider: provider as ModelProvider, model, enabled,
        ...(vision !== undefined ? { vision } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(contextLength !== undefined ? { contextLength } : {}),
        ...(pricing !== undefined ? { pricing } : {}),
      });
    }

    this.cachedEntries = entries;
    this.cachedIssues = issues;
  }
}
