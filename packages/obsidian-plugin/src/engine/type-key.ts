import { connectEngine } from './transport.js';
import { unwrapEnvelope } from './client.js';
import type { VaultPluginSettings } from '../settings.js';

/** The frontmatter key for a note's types when Engine names none (its default, and older Engines). */
export const DEFAULT_TYPE_KEY = 'types';
/** After a failed read, wait this long before asking Engine again. */
const RETRY_MS = 10 * 60_000;

/**
 * A note's types as Engine reads them from the frontmatter value under its type key
 * (Engine's `src/parser/frontmatter.ts`), so the plugin's checks agree with Engine's index.
 * One reading for every key, `types` included (#445, #482): an unquoted `[[link]]` (YAML's
 * nested list, as Obsidian's frontmatter cache gives it too) is its target, a link's `|alias`
 * is dropped, a number or boolean is its text, and a type held twice is one type. A mapping
 * or a list other than a link is no type.
 */
export function noteTypes(raw: unknown): string[] {
  const items: unknown[] = isNestedLink(raw) ? [raw] : Array.isArray(raw) ? raw : [raw];
  const types = items.flatMap((item): string[] => {
    const value = typeValue(item);
    return value === null ? [] : [value];
  });
  return [...new Set(types)];
}

function typeValue(item: unknown): string | null {
  if (typeof item === 'string') {
    const link = /^\[\[(.+)\]\]$/.exec(item);
    return link ? linkTarget(link[1] as string) : item;
  }
  if (isNestedLink(item)) return linkTarget(item[0][0]);
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  return null;
}

/** A link's target: the text before `|alias`, trimmed; null when empty. */
function linkTarget(inner: string): string | null {
  const bar = inner.indexOf('|');
  if (bar === -1) return inner;
  const target = inner.slice(0, bar).trim();
  return target.length > 0 ? target : null;
}

/** An unquoted `[[target]]` as YAML parses it: `[['target']]`. */
function isNestedLink(value: unknown): value is [[string]] {
  return Array.isArray(value) && value.length === 1
    && Array.isArray(value[0]) && value[0].length === 1 && typeof value[0][0] === 'string';
}

/**
 * Engine's type key over MCP: get-settings reports it as `typeKey` beside the install
 * folders, on any domain. An Engine that reports none keeps types in `types`.
 */
export async function readEngineTypeKey(settings: VaultPluginSettings): Promise<string> {
  const conn = await connectEngine(settings.engineUrl, settings.token);
  try {
    const env = unwrapEnvelope<{ typeKey?: unknown }>(
      await conn.call({ name: 'get-settings', arguments: { domain: 'engine' } }));
    if (!env.ok) throw Error('Engine did not report its settings');
    const key = env.data?.typeKey;
    return typeof key === 'string' && key.trim() !== '' ? key : DEFAULT_TYPE_KEY;
  } finally { await conn.close().catch(() => {}); }
}

/**
 * The frontmatter key that holds a note's types (#445), known synchronously: a menu check
 * or a Reading-view render can't wait. Engine sets it at install, so one successful read
 * lasts until the connection settings change; until then it is `types`. `onChange` hears
 * when a read finds another key, so what was shown under `types` can be shown again.
 */
export class EngineTypeKey {
  private key = DEFAULT_TYPE_KEY;
  private known = false;
  private loading = false;
  private failedAt = -Infinity;
  private generation = 0;

  constructor(
    private readonly read: () => Promise<string>,
    private readonly now: () => number = Date.now,
    private readonly onChange: (key: string) => void = () => {},
  ) {}

  current(): string {
    this.refresh();
    return this.key;
  }

  /** Forget the key: the connection settings changed. */
  reset(): void {
    this.generation++;
    this.key = DEFAULT_TYPE_KEY; this.known = false; this.loading = false; this.failedAt = -Infinity;
  }

  private refresh(): void {
    if (this.known || this.loading || this.now() - this.failedAt < RETRY_MS) return;
    const generation = this.generation;
    this.loading = true;
    void (async () => {
      try {
        const key = await this.read();
        if (generation === this.generation) {
          const changed = key !== this.key;
          this.key = key; this.known = true;
          if (changed) this.onChange(key);
        }
      } catch {
        if (generation === this.generation) this.failedAt = this.now();
      } finally {
        if (generation === this.generation) this.loading = false;
      }
    })();
  }
}
