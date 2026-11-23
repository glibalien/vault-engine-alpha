import { vaultSettingsFrom } from '@vault/settings-registry';
import { connectEngine } from '../engine/transport.js';
import { unwrapEnvelope } from '../engine/client.js';
import { makeWikiRebuildClient } from '../provenance/wiki-rebuild-client.js';
import { noteTypes } from '../engine/type-key.js';
import type { VaultPluginSettings } from '../settings.js';

const TYPE_TTL_MS = 10 * 60_000;
/** The vault map's project kind before Engine has been read: its default. */
const DEFAULT_PROJECT_TYPE = vaultSettingsFrom(undefined).projectType;
// The full curator-status is large, so it is read at most every five minutes; the panel's dry run decides.
const WIKIS_TTL_MS = 5 * 60_000;

/** Whether a note's value under the type key includes `type`, read as Engine reads it: a `[[type]]` link counts. */
export function hasType(types: unknown, type: string): boolean {
  return noteTypes(types).includes(type);
}

export type ProjectWikiSources = {
  /** The project kind in Engine's vault map; null when it is none (no project wikis). */
  projectType(): Promise<string | null>;
  /** Titles of the projects the Curator keeps wikis for. */
  projectWikis(): Promise<string[]>;
};

/** Read both over MCP, each on a short-lived connection: get-settings on Engine, curator-status
 *  on the Curator. The same tools an AI caller has. */
export function pluginProjectWikiSources(settings: VaultPluginSettings): ProjectWikiSources {
  return {
    projectType: async () => {
      const conn = await connectEngine(settings.engineUrl, settings.token);
      try {
        // All domains: an Engine older than the vault map reports the project type under wiki.
        const env = unwrapEnvelope<{ domains?: Record<string, unknown> }>(
          await conn.call({ name: 'get-settings', arguments: {} }));
        const domains = env.ok ? env.data?.domains : undefined;
        if (!domains || (domains['vault'] === undefined && domains['wiki'] === undefined)) {
          throw Error('Engine reported no project type');
        }
        return vaultSettingsFrom(domains).projectType;
      } finally { await conn.close().catch(() => {}); }
    },
    projectWikis: async () => {
      const client = makeWikiRebuildClient({ endpoint: settings.curatorUrl, token: settings.curatorToken });
      try { return await client.projectWikis(); } finally { await client.close(); }
    },
  };
}

/**
 * What the plugin knows, synchronously, about which notes can take a new project wiki: Engine's
 * project type and the Curator's project wikis. A command's check and a context menu can't wait,
 * so each is refreshed in the background when stale and read as last known. Until a read succeeds
 * it assumes Engine's default project type and no wikis; the create panel's free check decides.
 */
export class ProjectWikiIndex {
  /** undefined until read; null when the vault map's project kind is none. */
  private projectType: string | null | undefined = undefined;
  private typeAt = -Infinity;
  private typeLoading = false;
  private wikis: Set<string> | null = null;
  private wikisAt = -Infinity;
  private wikisLoading = false;
  /** Titles marked here, kept until a read that started after the mark replaces them. */
  private readonly marks = new Map<string, number>();
  private markSeq = 0;
  private generation = 0;

  constructor(private readonly sources: () => ProjectWikiSources, private readonly now: () => number = Date.now) {}

  /**
   * Whether to offer "Create project wiki" on a note with this frontmatter value under the
   * type key (`types` unless Engine reports another) and this title.
   */
  offers(types: unknown, title: string): boolean {
    this.refreshType();
    const projectType = this.projectType === undefined ? DEFAULT_PROJECT_TYPE : this.projectType;
    if (projectType === null || !hasType(types, projectType)) return false;
    this.refreshWikis();
    return !this.wikis?.has(title);
  }

  /** The project has a wiki now, so stop offering to create one. */
  markHasWiki(title: string): void {
    this.marks.set(title, ++this.markSeq);
    (this.wikis ??= new Set()).add(title);
  }

  /** Forget everything: the connection settings changed. */
  reset(): void {
    this.generation++;
    this.projectType = undefined; this.typeAt = -Infinity; this.typeLoading = false;
    this.wikis = null; this.wikisAt = -Infinity; this.wikisLoading = false;
    this.marks.clear();
  }

  private refreshType(): void {
    if (this.typeLoading || this.now() - this.typeAt < TYPE_TTL_MS) return;
    const generation = this.generation;
    this.typeLoading = true;
    void (async () => {
      try {
        const type = await this.sources().projectType();
        if (generation === this.generation) this.projectType = type;
      } catch { /* Keep the last known type. */ } finally {
        // Success and failure both wait out the TTL: no hammering an unreachable Engine.
        if (generation === this.generation) { this.typeLoading = false; this.typeAt = this.now(); }
      }
    })();
  }

  private refreshWikis(): void {
    if (this.wikisLoading || this.now() - this.wikisAt < WIKIS_TTL_MS) return;
    const generation = this.generation;
    const since = this.markSeq;
    this.wikisLoading = true;
    void (async () => {
      try {
        const titles = await this.sources().projectWikis();
        if (generation !== this.generation) return;
        const next = new Set(titles);
        for (const [title, seq] of this.marks) {
          if (seq > since) next.add(title);
          else this.marks.delete(title);
        }
        this.wikis = next;
      } catch { /* Keep the last known wikis. */ } finally {
        if (generation === this.generation) { this.wikisLoading = false; this.wikisAt = this.now(); }
      }
    })();
  }
}
