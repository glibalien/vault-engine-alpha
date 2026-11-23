import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createProjectWiki, NO_LONGER_REQUESTED, type CoreDeps, type CreateProjectWikiResponse } from './core.js';
import type { Engine } from './engine.js';
import { projectWikiRoots } from './db/wiki-roots.js';
import { writeJournalEntry } from './journal/writer.js';
import { asksForWiki } from './wiki-field.js';

/** How often the server looks for project notes that say `wiki: true` (#385). A constant, not a
 *  setting: each check is two cheap Engine reads (the settings, then the notes) and no model call. */
export const WIKI_FIELD_CHECK_EVERY_MS = 15 * 60_000;

/** `created_by` on a wiki registered because its project note says `wiki: true`. */
export const WIKI_FIELD_CREATOR = 'wiki-field';

export interface WikiFieldCheckDeps {
  /** For the check's one read. */
  readonly engine: Pick<Engine, 'listNodesWithField'>;
  readonly db: Database.Database;
  /**
   * The vault map's project kind and wiki request field (`wikiFlagField`), read fresh at the start
   * of each check (the server fetches the settings; the last known values when Engine can't be
   * reached). The check uses this one snapshot throughout. Null = none: no project kind or no
   * request field turns the check off.
   */
  readonly vocabulary: () => Promise<{ readonly projectType: string | null; readonly wikiFlagField: string | null }>;
  /** Fresh run deps, the same create-project-wiki gets. Fetched only when a project note asks
   *  for a wiki it doesn't have. */
  readonly coreDeps: () => Promise<CoreDeps>;
}

export interface WikiFieldRefusal {
  readonly title: string;
  readonly code: string;
  readonly message: string;
  /** True when this check journaled it; false when the same refusal was journaled before. */
  readonly reported: boolean;
}

export interface WikiFieldCheckResult {
  /** The wiki request field this check read; null when it is none and the check did nothing. */
  readonly field: string | null;
  /** Project notes that say `<field>: true`. */
  readonly asked: number;
  /** Projects this check registered a wiki for, with create-project-wiki's own detail. */
  readonly created: Array<{ readonly title: string; readonly detail: string }>;
  readonly refused: WikiFieldRefusal[];
}

/**
 * Lets a person create a project wiki by editing the project note (#385). Each run reads the
 * project notes that say `wiki: true` and, for each one with no registered wiki, calls
 * `createProjectWiki`, the create-project-wiki tool's own path: it registers the wiki and queues
 * the first build through `BackgroundBuilds`, so the daily budget, the queue and every refusal
 * work as they do for the tool. A registered wiki, paused or not, is left alone, and removing the
 * field does nothing. A refusal is journaled once per note and reason, not on every run.
 */
export class WikiFieldCheck {
  /** Refusals already journaled, as note id → reason code. Held in memory, so a refusal that
   *  still stands is journaled again once after a restart. */
  private readonly journaled = new Map<string, string>();

  constructor(private readonly deps: WikiFieldCheckDeps) {}

  /** One check. Stops before the next project once `stopped` says so (shutdown). */
  async run(stopped: () => boolean = () => false): Promise<WikiFieldCheckResult> {
    // The registry before the notes: remove-wiki clears the field before it deregisters, so a
    // wiki missing from this snapshot has its field already gone from the read below. A
    // remove-wiki that runs later, while this check waits for the queue, is caught by the field
    // being read again in the queued registration step (stillWanted).
    const roots = projectWikiRoots(this.deps.db);
    const { projectType, wikiFlagField: field } = await this.deps.vocabulary();
    // No project kind or no request field (none in the vault map): nothing can ask, nothing is read.
    const asked = projectType === null || field === null ? []
      : (await this.deps.engine.listNodesWithField(projectType, field)).filter(note => asksForWiki(note.value));
    // Node identity decides when the registration has one, as for sweeps: a renamed project keeps its wiki.
    const missing = asked.filter(note => !roots.some(root => root.root_node_id !== null
      ? root.root_node_id === note.id : root.root_title === note.title));
    for (const id of [...this.journaled.keys()]) {
      if (!missing.some(note => note.id === id)) this.journaled.delete(id); // a later refusal is news again
    }
    const created: Array<{ title: string; detail: string }> = [];
    const refused: WikiFieldRefusal[] = [];
    if (missing.length === 0 || field === null) return { field, asked: asked.length, created, refused };

    const deps = await this.deps.coreDeps();
    const runRef = randomUUID();
    for (const note of missing) {
      if (stopped()) break;
      const res = await createSafely(deps, note.id, field);
      if (!res.ok && res.error.code === NO_LONGER_REQUESTED) {
        this.journaled.delete(note.id); // the note stopped asking while this check waited: nothing to report
        continue;
      }
      if (res.ok) {
        this.journaled.delete(note.id);
        if (res.created) created.push({ title: res.project, detail: res.detail });
        continue;
      }
      const { code, message } = res.error;
      const reported = this.journaled.get(note.id) !== code;
      refused.push({ title: note.title, code, message, reported });
      if (!reported) continue;
      this.journaled.set(note.id, code);
      // Explicit context: this runs outside the curation queue, beside curations that set their own.
      deps.recorder?.recordWithContext({ runRef, trigger: 'scheduled', fn: 'wiki-field' }, {
        action: 'wiki-not-created', nodeId: note.id, target: note.title,
        detail: `no wiki created for "${note.title}", whose note says ${field}: true: ${message} (${code})`,
      });
    }
    if (refused.some(r => r.reported) && deps.db && deps.recorder) {
      // The deterministic lede: the check makes no model calls.
      await writeJournalEntry({ engine: deps.engine, llm: deps.llm, config: deps.config, db: deps.db, recorder: deps.recorder,
        usage: deps.usage }, { kind: 'run-refs', runRefs: [runRef] }, 'wiki field check', new Date(), { modelLede: false });
    }
    return { field, asked: asked.length, created, refused };
  }
}

async function createSafely(deps: CoreDeps, nodeId: string, field: string): Promise<CreateProjectWikiResponse> {
  try {
    return await createProjectWiki(deps, { project: nodeId, dryRun: false, by: WIKI_FIELD_CREATOR,
      stillWanted: async id => asksForWiki(await deps.engine.readNodeField(id, field)) });
  } catch (err) {
    return { ok: false, error: { code: 'CREATE_FAILED', message: err instanceof Error ? err.message : String(err) } };
  }
}

/** Server log lines for one check: each wiki registered, and each refusal the first time. */
export function wikiFieldCheckLog(result: WikiFieldCheckResult): string[] {
  return [
    ...result.created.map(c => `wiki field check: registered a wiki for "${c.title}" (its note says ${result.field}: true): ${c.detail}`),
    ...result.refused.filter(r => r.reported).map(r => `wiki field check: no wiki created for "${r.title}": ${r.message} (${r.code})`),
  ];
}

type SetTimer = (callback: () => void, ms: number) => { clear(): void };

/**
 * Runs `check` once now and again `everyMs` after each run ends, until stopped. Runs never
 * overlap. `check` returns undefined when the server no longer accepts work (shutdown), which
 * ends the timer as well. A failed run is reported to `onError` and retried at the next interval.
 */
export function startWikiFieldTimer(opts: {
  check: (stopped: () => boolean) => Promise<unknown> | undefined;
  onError?: (err: unknown) => void;
  everyMs?: number;
  setTimer?: SetTimer;
}): { stop(): void } {
  const setTimer: SetTimer = opts.setTimer ?? ((callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return { clear: () => clearTimeout(timer) };
  });
  let stopped = false;
  let pending: { clear(): void } | null = null;
  const tick = async (): Promise<void> => {
    pending = null;
    if (stopped) return;
    try {
      const running = opts.check(() => stopped);
      if (running === undefined) return;
      await running;
    } catch (err) {
      opts.onError?.(err);
    }
    if (!stopped) pending = setTimer(() => void tick(), opts.everyMs ?? WIKI_FIELD_CHECK_EVERY_MS);
  };
  pending = setTimer(() => void tick(), 0);
  return { stop: () => { stopped = true; pending?.clear(); } };
}
