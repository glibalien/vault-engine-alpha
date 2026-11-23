import type Database from 'better-sqlite3';
import type { CoreDeps } from '../core.js';
import { getDossier, listDossiers, setDossierStatus, type DossierRecord, type DossierStatus } from '../db/dossiers.js';
import type { Engine } from '../engine.js';
import { fieldValue } from '../evidence.js';
import type { InspectData } from '../provenance-types.js';
import { DossierError, readDossierMemories } from './evidence.js';

/**
 * Whether a dossier is behind, and the nightly rebuild of those asked for (#714). Owner's decisions
 * (2026-11-21): a dossier is built only when asked, by default; it is behind when a memory about its
 * subject, or a note it read, changed since its build; the subject note's `dossier: on-change` asks
 * for a rebuild in the nightly sweep when it is behind, at most `DOSSIER_NIGHTLY_LIMIT` a night,
 * inside the daily cap. The field is the note's own, like `wiki: true` on a project note, so a
 * person sets it in Markdown as an AI caller does.
 */

/** The subject note's field that asks for nightly rebuilds. */
export const DOSSIER_FIELD = 'dossier';
export type DossierRebuild = 'manual' | 'on-change';
/** At most this many dossiers are rebuilt a night (owner, 2026-11-21). */
export const DOSSIER_NIGHTLY_LIMIT = 5;
/** How often the server checks which dossiers are behind. */
export const DOSSIER_CHECK_EVERY_MS = 30 * 60_000;
/** Pages of an output's inputs read per check: 100 a page, so 1,000 inputs. A dossier has a few hundred at most. */
const INPUT_PAGES = 10;

/** `on-change` (any case, spaces around it) asks for nightly rebuilds; anything else is manual. */
export function rebuildOf(value: unknown): DossierRebuild {
  const raw = fieldValue(value);
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'on-change' ? 'on-change' : 'manual';
}

export interface DossierFreshness {
  /** null: the check could not tell (the output's inputs could not be read). */
  readonly behind: boolean | null;
  /** What changed, for the log. */
  readonly reasons: readonly string[];
}

type OutputInputs = Extract<InspectData, { select: 'output' }>['inputs'];

/**
 * Behind when, since the build: a note or memory it read changed or is gone (the Engine compares each
 * recorded input with now; a note that only gained links is unchanged, #696), the memories a build
 * would show now are not the ones it showed (a new memory about the subject, or one left the set),
 * or the subject's live memory total moved. A new meeting or note that it never read is not a
 * change by the owner's rule; its memories usually are.
 */
export async function dossierFreshness(engine: Pick<Engine, 'inspectProvenance' | 'listMemoriesWithTotal'>,
  record: Pick<DossierRecord, 'nodeId' | 'outputRevisionId' | 'memoryTotal'>): Promise<DossierFreshness> {
  const inputs: OutputInputs = [];
  let cursor: string | undefined;
  for (let page = 0; page < INPUT_PAGES; page++) {
    const read = await engine.inspectProvenance({ select: 'output', output_revision_id: record.outputRevisionId, include_comparisons: true,
      limit: 100, ...(cursor ? { cursor } : {}) });
    if (read.select !== 'output') return { behind: null, reasons: ['the page\'s inputs could not be read'] };
    inputs.push(...read.inputs);
    if (!read.next_cursor) break;
    cursor = read.next_cursor;
  }
  const reasons: string[] = [];
  const changed = inputs.filter(input => input.comparison === 'changed' || input.comparison === 'missing');
  if (changed.length > 0) reasons.push(`${changed.length} of the notes and memories it read changed or are gone`);
  const shown = new Set(inputs.filter(input => input.source?.kind === 'memory').map(input => Number(input.source!.native_id)));
  const now = await readDossierMemories(engine, record.nodeId);
  // Past facts too (#717): a newer memory replacing one adds it to what the page would show.
  // Each past fact's replacement is shown with it (#717), so it is one of the page's inputs too.
  const current = new Set([...now.owner, ...now.rules, ...now.facts, ...now.past, ...now.replacedBy.values()].map(memory => memory.id));
  const added = [...current].filter(id => !shown.has(id)).length;
  const left = [...shown].filter(id => !current.has(id)).length;
  if (added > 0) reasons.push(`${added} memor${added === 1 ? 'y' : 'ies'} it would show now ${added === 1 ? 'is' : 'are'} new to it`);
  if (left > 0 && changed.length === 0) reasons.push(`${left} memor${left === 1 ? 'y' : 'ies'} it showed would not be shown now`);
  if (record.memoryTotal !== null && now.total !== null && now.total !== record.memoryTotal) {
    reasons.push(`the memories about the subject went from ${record.memoryTotal} to ${now.total}`);
  }
  return { behind: reasons.length > 0, reasons };
}

/** The status a dossier's home should show, written through the Engine and then recorded, so a
 *  failed write leaves the record as it was and the next check tries again (Codex, #731). */
async function settle(deps: Pick<CoreDeps, 'engine'> & { db: Database.Database }, record: DossierRecord, status: DossierStatus,
  log: (line: string) => void): Promise<void> {
  // A build since the check began has written its own record and status: leave them.
  if (getDossier(deps.db, record.nodeId)?.outputRevisionId !== record.outputRevisionId) return;
  try {
    await deps.engine.wikiStatus(record.nodeId, status);
  } catch (error) {
    log(`dossier "${record.pageTitle}": its status could not be written, tried again at the next check: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  setDossierStatus(deps.db, record.nodeId, record.outputRevisionId, status, new Date().toISOString());
}

/** Check every recorded dossier and write the status of each home that changed. Best effort per dossier. */
export async function checkDossiers(deps: Pick<CoreDeps, 'engine'> & { db: Database.Database }, log: (line: string) => void,
  stopped: () => boolean = () => false): Promise<{ checked: number; behind: number }> {
  let checked = 0;
  let behind = 0;
  for (const record of listDossiers(deps.db)) {
    if (stopped()) break;
    let freshness: DossierFreshness;
    try {
      freshness = await dossierFreshness(deps.engine, record);
    } catch (error) {
      log(`dossier "${record.pageTitle}": the behind check failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (freshness.behind === null) continue;
    checked += 1;
    const status: DossierStatus = freshness.behind ? 'behind' : 'current';
    if (freshness.behind) behind += 1;
    if (status !== record.status) {
      if (freshness.behind) log(`dossier "${record.pageTitle}" is behind: ${freshness.reasons.join('; ')}`);
      await settle(deps, record, status, log);
    }
  }
  return { checked, behind };
}

/**
 * Whether a scheduled rebuild is still wanted, asked when its turn in the queue comes and again
 * when a restart picks it up (#722): the note may have been set back to manual meanwhile (Codex,
 * #731), or a build ahead of it may have made it current.
 */
export function scheduledRebuildWanted(deps: Pick<CoreDeps, 'engine' | 'db'>, nodeId: string): () => Promise<boolean> {
  return async () => {
    const now = deps.db ? getDossier(deps.db, nodeId) : null;
    if (now === null || rebuildOf(await deps.engine.readNodeField(nodeId, DOSSIER_FIELD)) !== 'on-change') return false;
    return (await dossierFreshness(deps.engine, now)).behind === true;
  };
}

export interface DossierRebuildResult {
  readonly considered: number;
  readonly rebuilt: number;
  /** Already being built, or current by the time its turn came: not built again. */
  readonly skipped: number;
  readonly failed: number;
  /** Behind and asked for, but past the night's limit or the daily cap. */
  readonly leftForLater: number;
  readonly stoppedBy: 'budget' | null;
}

/**
 * The sweep's dossier phase: rebuild the dossiers whose subject note asks for it and that are
 * behind, oldest build first, at most `DOSSIER_NIGHTLY_LIMIT`, each through the same path as a
 * live `build-dossier` (its free checks, the daily cap's worst case, the build in the queue, its
 * run record and journal summary), awaited. The builds are tracked like a live build's, so one
 * already queued or running is not started twice, and each asks again whether it is still behind
 * when its turn in the queue comes (`stillWanted`): an on-demand build ahead of it may have made it
 * current (Codex, #731). A refusal by the daily cap ends the phase. A dry run rebuilds nothing.
 */
export async function runDossierRebuilds(deps: CoreDeps, opts: { readonly dryRun: boolean },
  start: (deps: CoreDeps, nodeId: string, stillWanted: () => Promise<boolean>) => Promise<{ readonly status: string }>): Promise<DossierRebuildResult> {
  const result = { considered: 0, rebuilt: 0, skipped: 0, failed: 0, leftForLater: 0, stoppedBy: null as DossierRebuildResult['stoppedBy'] };
  if (opts.dryRun || !deps.db) return result;
  const db = deps.db;
  const wanted: DossierRecord[] = [];
  for (const record of listDossiers(db)) {
    try {
      if (rebuildOf(await deps.engine.readNodeField(record.nodeId, DOSSIER_FIELD)) !== 'on-change') continue;
      if ((await dossierFreshness(deps.engine, record)).behind) wanted.push(record);
    } catch (error) {
      console.warn(`[curator] dossier rebuilds: "${record.pageTitle}" not checked: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  result.considered = wanted.length;
  for (const [index, record] of wanted.entries()) {
    if (index >= DOSSIER_NIGHTLY_LIMIT) { result.leftForLater = wanted.length - index; break; }
    const stillWanted = scheduledRebuildWanted(deps, record.nodeId);
    try {
      const outcome = await start(deps, record.nodeId, stillWanted);
      if (outcome.status === 'written') result.rebuilt += 1;
      else if (outcome.status === 'in_progress' || outcome.status === 'current') result.skipped += 1;
      else if (outcome.status === 'skipped_budget') { result.stoppedBy = 'budget'; result.leftForLater = wanted.length - index; break; }
      else result.failed += 1;
    } catch (error) {
      if (error instanceof DossierError && error.code === 'DAILY_BUDGET') {
        result.stoppedBy = 'budget';
        result.leftForLater = wanted.length - index;
        break;
      }
      result.failed += 1;
      console.warn(`[curator] dossier rebuilds: "${record.pageTitle}" not rebuilt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
