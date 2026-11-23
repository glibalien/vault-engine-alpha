// The wiki status on a wiki's home page (#547): what the Curator writes, and when.
//
// The home's `wiki_status` reads current, behind, paused, paused-behind, building or failed.
// The Curator owns paused, building and failed; a build's own home write stamps current (or
// paused); the Engine moves current to behind and paused to paused-behind once the project's
// notes no longer match the last build. Every write here goes through the Engine's
// `wiki-status` tool, which writes only when the value changes. All of it is best-effort: a
// failed status write is logged and never fails a build, a pause, or startup.

import type { BuildStatusHooks } from './reconciliation-pipeline.js';
import { EngineError, type Engine, type WikiStatus } from './engine.js';
import type { CurationQueue } from './queue.js';
import type { CurateResult } from './types.js';
import type Database from 'better-sqlite3';
import { isPaused } from './db/control.js';
import { getWikiRoot, projectWikiRoots, topicWikiRoots } from './db/wiki-roots.js';

function warn(message: string, err: unknown): void {
  console.warn(`[wiki-status] ${message}: ${err instanceof Error ? err.message : String(err)}`);
}

/** What pausing makes of a home's status, or null to leave it (a build under way stamps its own end). */
export function pausedStatus(stored: WikiStatus | null): WikiStatus | null {
  if (stored === 'building') return null;
  return stored === 'behind' || stored === 'paused-behind' ? 'paused-behind' : 'paused';
}

/** What resuming makes of a home's status, or null to leave it. */
export function resumedStatus(stored: WikiStatus | null): WikiStatus | null {
  if (stored === 'paused') return 'current';
  if (stored === 'paused-behind') return 'behind';
  return null;
}

/** The status a build that started but did not write leaves: failed, or a paused wiki's own. */
export function failedStatus(prior: WikiStatus | null, paused: boolean): WikiStatus {
  if (!paused) return 'failed';
  return prior === 'paused-behind' ? 'paused-behind' : 'paused';
}

/**
 * The status a home should have when no build is running (the status check runs in the build
 * lane), or null to leave it. A `building` left over (by a stopped process, or brought back by
 * an undo of a build) becomes paused or current, and the Engine makes that paused-behind or
 * behind if the notes moved on; one that was never built becomes failed. A home with no status
 * gets paused or current, once it has been built. A status that disagrees with the pause table
 * follows it.
 */
export function startupStatus(stored: WikiStatus | null, paused: boolean, built: boolean): WikiStatus | null {
  if (stored === 'building') return paused ? 'paused' : built ? 'current' : 'failed';
  if (stored === null) {
    if (paused) return 'paused';
    return built ? 'current' : null;
  }
  if (paused) return stored === 'paused' || stored === 'paused-behind' ? null : pausedStatus(stored);
  return resumedStatus(stored);
}

function pausedSafe(db: Database.Database | undefined, title: string): boolean {
  if (!db) return false;
  try {
    return isPaused(db, title);
  } catch (err) {
    warn(`pause state unavailable for ${title}`, err);
    return false;
  }
}

/** The root a wiki's home is found by: its registered node id, else its title. */
function rootRefOf(db: Database.Database | undefined, title: string): string {
  if (!db) return title;
  try {
    return getWikiRoot(db, title)?.root_node_id ?? title;
  } catch {
    return title;
  }
}

/** A build's status hooks and the step that settles a build that did not stamp its own end. */
export interface BuildStatusTracker {
  readonly hooks: BuildStatusHooks;
  /** After the build: a home still reading `building` gets the build's end status. */
  finish(result: CurateResult): Promise<void>;
}

/**
 * Status hooks for one build of the wiki registered as `title` whose root is `rootRef`.
 * `building` is written only once the build passes every gate; the build's home write
 * stamps paused or current, read from the pause table at that moment, so a pause during
 * the build holds.
 */
export function buildStatusTracker(deps: { engine: Pick<Engine, 'wikiStatus'>; db?: Database.Database }, title: string, rootRef: string): BuildStatusTracker {
  let prior: WikiStatus | null = null;
  let stamped = false;
  const homeStatus = (): 'current' | 'paused' => pausedSafe(deps.db, title) ? 'paused' : 'current';
  return {
    hooks: {
      onBuildStart: async () => {
        try {
          const write = await deps.engine.wikiStatus(rootRef, 'building');
          if (write.home_node_id === null) return;
          stamped = true;
          prior = write.previous_status ?? null;
        } catch (err) {
          warn(`could not mark ${title} building`, err);
        }
      },
      get homeStatus() {
        return homeStatus();
      },
    },
    finish: async (result) => {
      if (!stamped) return;
      try {
        const current = await deps.engine.wikiStatus(rootRef);
        if (current.status !== 'building') return;
        const paused = pausedSafe(deps.db, title);
        const to = result.outcome === 'written' ? (paused ? 'paused' : 'current') : failedStatus(prior, paused);
        await deps.engine.wikiStatus(rootRef, to);
      } catch (err) {
        warn(`could not settle the status of ${title} after its build`, err);
      }
    },
  };
}

/** Write the status a pause or resume of `title` calls for. Returns the home's status after, or null. */
export async function stampPause(deps: { engine: Pick<Engine, 'wikiStatus'>; db?: Database.Database }, title: string, paused: boolean): Promise<WikiStatus | null> {
  const rootRef = rootRefOf(deps.db, title);
  try {
    const current = await deps.engine.wikiStatus(rootRef);
    if (current.home_node_id === null) return null;
    const to = paused ? pausedStatus(current.status) : resumedStatus(current.status);
    if (to === null || to === current.status) return current.status;
    return (await deps.engine.wikiStatus(rootRef, to)).status;
  } catch (err) {
    warn(`could not stamp ${paused ? 'paused' : 'resumed'} on ${title}`, err);
    return null;
  }
}

/**
 * Give every registered wiki's home the status `startupStatus` calls for. Run in the build
 * lane, where no build is under way, so a `building` it finds is left over.
 * Returns false when the Engine could not be reached (try again later); a refusal for one
 * wiki (an edit not read yet, a root gone) skips that wiki.
 */
export async function syncWikiStatuses(deps: { engine: Pick<Engine, 'wikiStatus'>; db: Database.Database }, log: (line: string) => void): Promise<boolean> {
  let roots;
  try {
    roots = [...projectWikiRoots(deps.db), ...topicWikiRoots(deps.db)];
  } catch (err) {
    warn('wiki registry unavailable', err);
    return true;
  }
  let written = 0;
  for (const root of roots) {
    const rootRef = root.root_node_id ?? root.root_title;
    try {
      const current = await deps.engine.wikiStatus(rootRef);
      if (current.home_node_id === null) continue;
      const to = startupStatus(current.status, pausedSafe(deps.db, root.root_title), current.built === true);
      if (to === null || to === current.status) continue;
      await deps.engine.wikiStatus(rootRef, to);
      written++;
    } catch (err) {
      if (!(err instanceof EngineError)) {
        warn('Engine unavailable for the startup status check; trying again later', err);
        return false;
      }
      warn(`left the status of ${root.root_title} as it is`, err);
    }
  }
  if (written > 0) log(`wiki status: set the status of ${written} wiki home(s)`);
  return true;
}

export const WIKI_STATUS_SYNC_RETRY_MS = 60_000;
export const WIKI_STATUS_SYNC_EVERY_MS = 15 * 60_000;

/**
 * Settle every wiki's status in the build lane at Curator start, then every 15 minutes, and each
 * minute while the Engine cannot be reached (it may still be starting). The repeat catches what a
 * single pass can't: a home refused once (an edit not read yet), a `building` an undo brought
 * back, a status a page request stamped on a paused wiki. It writes only where a status is wrong.
 */
export function startWikiStatusSync(
  deps: { engine: Pick<Engine, 'wikiStatus'>; db: Database.Database; queue: Pick<CurationQueue, 'enqueue'> },
  log: (line: string) => void,
  keepAlive: (work: Promise<unknown>, label: string) => void,
  options: { retryMs?: number; everyMs?: number } = {},
): { stop(): void } {
  const retryMs = options.retryMs ?? WIKI_STATUS_SYNC_RETRY_MS;
  const everyMs = options.everyMs ?? WIKI_STATUS_SYNC_EVERY_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(run, ms);
    timer.unref?.();
  };
  const run = (): void => {
    if (stopped) return;
    const work = deps.queue.enqueue('wiki status check', () => syncWikiStatuses(deps, log)).then(
      done => next(done ? everyMs : retryMs),
      (err: unknown) => { warn('wiki status check failed', err); next(everyMs); },
    );
    keepAlive(work, 'the wiki status check');
  };
  run();
  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
