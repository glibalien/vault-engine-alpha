import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { vaultOf, type Config } from './config.js';
import { EngineError, type Engine, type LinkSweepBacklogRef, type LinkSweepNoteRef } from './engine.js';
import type { CurationQueue } from './queue.js';
import type { ActionRecorder } from './journal/recorder.js';
import type { RunTrigger } from './db/runs.js';
import type { LlmClient } from './llm/types.js';
import type { UsageReporter } from './usage-reporter.js';
import { writeJournalEntry } from './journal/writer.js';
import {
  countLinkSweepRechecks, countReportedLinkSweepNotes, dropLinkSweepRecheck, forgetLinkSweepNote, knownLinkSweepNames, linkSweepNamesSeeded,
  linkSweepNoteFailures, linkSweepNoteStatuses, linkSweepRechecks, markLinkSweepNote, pendingLinkSweepNotes, queueLinkSweepRechecks,
  readLinkSweepWatermark, recordLinkSweepName, reportedLinkSweepNotes, seedLinkSweepNames, writeLinkSweepWatermark,
} from './db/link-sweep.js';
import { buildNameIndex, findMentions, type Mention } from './link-sweep-match.js';
import { ledgerHash, upsertLedger } from './db/memory-sweep.js';
import { orgLedgerHash, upsertOrgLedger } from './db/org-sweep.js';
import { carryPageNoteHash } from './db/page-note-states.js';

/**
 * The link sweep (#332): read the notes created since its last run and find the plain-text
 * mentions of people, companies and projects that could become links (`link-sweep-match.ts`).
 * No model calls. Off by default (`linkSweepEnabled`); runs in the daily sweep, or on its own
 * every 30 minutes (`linkSweepSchedule: timer`).
 *
 * `linkSweepMode: report` lists each note's links in the Curator Journal and changes no note.
 * `apply` writes the narrow set (`applicableMention`): people by a name of two or more words, and
 * companies by their own name or an alias as written. Each note is one Engine write, guarded by the
 * version and content hash it was read at (database and disk), and journaled with its undo
 * operation. Everything else is still only listed. Apply mode also reads again the notes an
 * earlier report-only run read (`reported`), so the links reviewed during the trial are written.
 */

/** How often the timer schedule runs. A constant, like the wiki-field check's. */
export const LINK_SWEEP_EVERY_MS = 30 * 60_000;
/** A first run looks back this far, so it has something to show without reading old notes. */
export const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60_000;
/**
 * A name found in at least this share of the vault's notes, and in at least `COMMON_NAME_MIN_NOTES`
 * of them, is too common to link: the vault owner's own company, a platform most notes mention. In
 * the first reports such names were proposed in most notes read. The note floor keeps a small
 * vault's main project, which can pass the share alone, linkable.
 */
export const COMMON_NAME_SHARE = 0.05;
export const COMMON_NAME_MIN_NOTES = 200;

export interface LinkSweepDeps {
  engine: Engine;
  config: Config;
  queue: CurationQueue;
  db?: Database.Database;
  recorder?: ActionRecorder;
}

export interface LinkSweepResult {
  ran: boolean;
  detail?: string;
  dryRun: boolean;
  runRef?: string;
  /** Notes read for mentions. */
  read: number;
  /** Notes with at least one link to propose (listed, not written), and those links. */
  notesWithLinks: number;
  links: number;
  /** Apply mode: links written, and the notes they went into. */
  linksAdded: number;
  notesLinked: number;
  /** Notes read again from report-only runs (apply mode), and those still to read. */
  reread: number;
  rereadLeft: number;
  /** Older notes read from the backlog (`linkSweepBacklog`, #697), and those it has still to read. */
  backlogRead: number;
  backlogLeft: number;
  /** Names that got a note since they were last looked for (#699), those past the run's limit,
   *  and the notes read again because they name one, and those still queued. */
  newNames: number;
  newNamesLeft: number;
  rechecked: number;
  recheckLeft: number;
  /** The Engine's undo operation of each note this run linked, in order: one `undo-operations`
   *  call with all of them undoes the run. */
  operationIds: string[];
  /** Linked notes whose memory-sweep, typing or wiki page record moved to the new hash (`keepLedgers`). */
  ledgersKept: number;
  /** Notes left for a later run: edited too recently, or past the run's cap. */
  leftForLater: number;
  /** Names more than one note answers to, so never matched. */
  ambiguousNames: number;
  /** Names left out as too common, each with the share of notes it is found in ("Acme 12%"). */
  commonNames: string[];
  errors: number;
}

function emptyResult(dryRun: boolean, detail?: string): LinkSweepResult {
  return {
    ran: false, dryRun, read: 0, notesWithLinks: 0, links: 0, linksAdded: 0, notesLinked: 0, reread: 0, rereadLeft: 0,
    backlogRead: 0, backlogLeft: 0, newNames: 0, newNamesLeft: 0, rechecked: 0, recheckLeft: 0, operationIds: [], ledgersKept: 0,
    leftForLater: 0, ambiguousNames: 0, commonNames: [], errors: 0, ...(detail !== undefined ? { detail } : {}),
  };
}

/** The kinds whose notes are link targets: the setting, else the vault map's project, person and company kinds. */
export function linkTargetTypes(config: Config): string[] {
  if (config.linkSweepTargetTypes.length > 0) return [...config.linkSweepTargetTypes];
  const vault = vaultOf(config);
  return [vault.projectType, vault.personType, vault.companyType].filter((t): t is string => t !== null);
}

function mentionList(mentions: readonly Mention[]): string {
  return mentions.map(m => `${m.title}${m.text === m.title ? '' : ` (as "${m.text}")`}: "${m.context}"`).join('; ');
}
const howMany = (n: number) => (n === 1 ? 'one mention' : `${n} mentions`);

/** One journal line for a note's proposed links. */
export function proposalDetail(title: string, mentions: readonly Mention[]): string {
  return `could link ${howMany(mentions.length)} in "${title}": ${mentionList(mentions)}`;
}

/** One journal line for the links apply mode wrote into a note, with the write's undo operation. */
export function linkedDetail(title: string, mentions: readonly Mention[], operationId: string | null, dryRun = false): string {
  const undo = operationId === null ? '' : ` (undo-operations ${operationId})`;
  return `${dryRun ? 'would link' : 'linked'} ${howMany(mentions.length)} in "${title}": ${mentionList(mentions)}${undo}`;
}

export interface TargetInfo { title: string; aliases: readonly string[]; type: string }

const fold = (text: string) => text.trim().replace(/\s+/g, ' ');

/**
 * Whether apply mode writes this mention (#332, the narrow set the owner approved on 2026-11-20):
 * - a person (the vault's person kind): the matcher already takes them only by a name of two or
 *   more words, so any such mention;
 * - a company (the vault's company kind): only by its title or one of its aliases exactly as
 *   written, letter case included, so a lowercase phrase that happens to spell a company's name
 *   ("general assembly") is listed, not linked;
 * - anything else (projects, other kinds): listed only.
 */
export function applicableMention(
  mention: Mention, target: TargetInfo, kinds: { person: string | null; company: string | null },
): boolean {
  if (kinds.person !== null && target.type === kinds.person) return true;
  if (kinds.company !== null && target.type === kinds.company) {
    const text = fold(mention.text);
    return [target.title, ...target.aliases].some(name => fold(name) === text);
  }
  return false;
}

/** A title ending like a file name (`Acme.md`, `Northwind.ai`): `[[title]]` can name a file at
 *  that exact path, or an attachment, rather than the note (Codex, #689). The Engine's own rule
 *  for an attachment-looking link (`ATTACHMENT_EXTENSION` in its link counts). */
const FILE_NAME_ENDING = /\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,6}$/;

/** A link can be written around this mention as `[[title|text]]` without breaking: no line break
 *  in the text, no link syntax in either part, and a title that names the note and nothing else. */
export function linkable(title: string, text: string): boolean {
  return !/[[\]|#^\n\r]/.test(title) && !/[[\]|\n\r]/.test(text) && !FILE_NAME_ENDING.test(title);
}

/** The mention can become `[[…]]` in place: not right after `[` (an undefined reference would
 *  become `[[[…]]]`), `!` (an embed) or `\` (an escaped bracket), nor right before `]` (Codex, #689). */
export function standsAlone(body: string, mention: Pick<Mention, 'start' | 'end'>): boolean {
  const before = body[mention.start - 1];
  return before !== '[' && before !== '!' && before !== '\\' && body[mention.end] !== ']';
}

/** `body` with each mention made a link: `[[Title]]`, or `[[Title|text]]` where the text differs. */
export function withLinks(body: string, mentions: readonly Mention[]): string {
  let out = body;
  for (const m of [...mentions].sort((a, b) => b.start - a.start)) {
    const link = m.text === m.title ? `[[${m.title}]]` : `[[${m.title}|${m.text}]]`;
    out = out.slice(0, m.start) + link + out.slice(m.end);
  }
  return out;
}

/**
 * A link changes a note's content hash but not what it says. The memory sweep and the org sweep's
 * typing remember each note by the hash they last read, and read a note again (a paid call; the
 * memory sweep also re-checks, and can expire, the memories drawn from it) when its hash moves.
 * A wiki sub-page's record of the notes it was built from holds a content hash too when it was
 * written before text hashes (#332), and a changed note goes back into the page's next rewrite.
 * Where a record holds the very hash this run read before writing, it is moved to the hash after
 * the write, so links alone never make a note look new to them. A note edited since they read it
 * holds another hash, keeps its record and is read again, as it should be. Returns whether any
 * record moved.
 */
export function keepLedgers(db: Database.Database, nodeId: string, readHash: string, newHash: string, now: string): boolean {
  let kept = false;
  if (ledgerHash(db, nodeId) === readHash) { upsertLedger(db, nodeId, newHash, now); kept = true; }
  if (orgLedgerHash(db, nodeId) === readHash) { upsertOrgLedger(db, nodeId, newHash, now); kept = true; }
  if (carryPageNoteHash(db, nodeId, readHash, newHash) > 0) kept = true;
  return kept;
}

/** The note changed since it was read (the Engine refused the guarded write): read it next run. */
function changedSinceRead(err: unknown): boolean {
  return err instanceof EngineError && ['STALE_NODE', 'CONTENT_HASH_MISMATCH', 'NOT_FOUND'].includes(err.code);
}

/**
 * Run the sweep if it is on and this is its schedule. In the curation queue, like every phase.
 * Never rejects. A dry run changes no bookkeeping, so the next real run reads the same notes.
 */
export async function runLinkSweep(
  deps: LinkSweepDeps,
  opts: { dryRun: boolean; trigger: RunTrigger; schedule: 'daily' | 'timer'; now?: () => Date },
): Promise<LinkSweepResult> {
  const { config, db } = deps;
  if (!config.linkSweepEnabled || config.linkSweepSchedule !== opts.schedule) return emptyResult(opts.dryRun);
  if (!db) return emptyResult(opts.dryRun, 'no curator db');

  return deps.queue.enqueue('link-sweep', async () => {
    const runRef = randomUUID();
    deps.recorder?.setContext({ runRef, trigger: opts.trigger, fn: 'link-sweep' });
    try {
      const r = await linkSweep(deps, db, opts.dryRun, (opts.now ?? (() => new Date()))());
      r.runRef = runRef;
      emitSummary(deps, r, opts.schedule);
      return r;
    } catch (err) {
      console.warn(`[curator] link sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      const r = { ...emptyResult(opts.dryRun, err instanceof Error ? err.message : String(err)), ran: true, errors: 1, runRef };
      emitSummary(deps, r, opts.schedule);
      return r;
    } finally {
      deps.recorder?.setContext(null);
    }
  });
}

async function linkSweep(deps: LinkSweepDeps, db: Database.Database, dryRun: boolean, now: Date): Promise<LinkSweepResult> {
  const { engine, config } = deps;
  const result: LinkSweepResult = { ...emptyResult(dryRun), ran: true };
  const nowIso = now.toISOString();
  const types = linkTargetTypes(config);
  if (types.length === 0) return { ...result, detail: 'no kinds to link to: the vault map has no project, person or company kind' };
  const apply = config.linkSweepMode === 'apply';

  const vault = vaultOf(config);
  const kinds = { person: vault.personType, company: vault.companyType };
  const targets = await engine.listLinkTargets(types);
  const targetsById = new Map<string, TargetInfo>(targets.map(t => [t.id, t]));
  const index = buildNameIndex(targets.map(target => ({ ...target, person: kinds.person !== null && target.type === kinds.person })));
  result.ambiguousNames = index.ambiguous.length;
  const common = commonNameCheck(engine);
  const titleCounts = new Map<string, number>();
  const namesOneNote = async (title: string): Promise<boolean> => {
    const key = title.toLowerCase();
    let count = titleCounts.get(key);
    if (count === undefined) { count = await engine.countTitled(title); titleCounts.set(key, count); }
    return count === 1;
  };

  // New notes since the last run (a first run looks back a day), plus the ones left for later.
  const since = readLinkSweepWatermark(db) ?? new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS).toISOString();
  const wikiType = vault.wikiType;
  const filters = {
    withoutTypes: wikiType === null ? [] : [wikiType],
    withoutPathPrefix: `${(config.settingsDir ?? 'Settings').replace(/\/+$/, '')}/`,
  };
  const created = await engine.listCreatedNotes({ createdSince: since, ...filters });
  // Notes read before a name in them had a note of its own are queued to be read again (#699).
  // Best-effort: a failure here only delays those notes.
  if (!dryRun) {
    try {
      const names = await queueNotesNamingNewNames(engine, db, index, targetsById, kinds, filters, nowIso);
      result.newNames = names.looked;
      result.newNamesLeft = names.left;
    } catch (err) {
      result.errors += 1;
      console.warn(`[curator] link sweep: could not look for new names: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const pendingIds = pendingLinkSweepNotes(db);
  // In the ledger's order (fewest failed reads, then longest waiting), not the order the Engine
  // lists them, so a note whose read keeps failing can't hold the cap and block the rest (Codex on #624).
  const waited = new Map(pendingIds.map((id, i) => [id, i]));
  const pending = (pendingIds.length === 0 ? [] : await engine.listNotesById(pendingIds))
    .sort((a, b) => (waited.get(a.id) ?? 0) - (waited.get(b.id) ?? 0));
  if (!dryRun) {
    const still = new Set(pending.map(n => n.id));
    for (const id of pendingIds) if (!still.has(id)) forgetLinkSweepNote(db, id); // deleted while it waited
  }
  const statuses = linkSweepNoteStatuses(db, created.nodes.map(n => n.id));
  // A pending note whose read or write has failed goes behind the new notes, the queued notes and
  // the rereads below, so a note that keeps failing can't take the cap from them (Codex, #689); it
  // still comes before the backlog (Codex, #701).
  const failures = linkSweepNoteFailures(db, pendingIds);
  const failedBefore = pending.filter(n => (failures.get(n.id) ?? 0) > 0);
  const candidates = new Map<string, LinkSweepNoteRef>();
  for (const n of [...pending.filter(n => (failures.get(n.id) ?? 0) === 0), ...created.nodes]) {
    const status = statuses.get(n.id);
    if (status === 'reported' || status === 'applied' || candidates.has(n.id)) continue;
    if ((failures.get(n.id) ?? 0) > 0) continue; // listed again as new: it waits with the failed
    candidates.set(n.id, n);
  }
  // Then the notes queued because a name in them got a note (#699), longest waiting first. One the
  // cap or the quiet window leaves out stays queued.
  const rechecks = new Set<string>();
  const queuedIds = linkSweepRechecks(db, config.linkSweepNoteCap);
  if (queuedIds.length > 0) {
    const found = await engine.listNotesById(queuedIds);
    if (!dryRun) {
      const still = new Set(found.map(n => n.id));
      for (const id of queuedIds) if (!still.has(id)) dropLinkSweepRecheck(db, id); // deleted since
    }
    for (const n of found) {
      if (candidates.has(n.id)) continue;
      candidates.set(n.id, n);
      rechecks.add(n.id);
    }
  }
  // Apply mode reads again what report-only runs read, after the new notes and only as far as the
  // cap leaves room. A note it does not reach stays `reported` for a later run.
  const rereads = new Set<string>();
  if (apply) {
    const ids = reportedLinkSweepNotes(db, config.linkSweepNoteCap);
    const found = ids.length === 0 ? [] : await engine.listNotesById(ids);
    if (!dryRun) {
      const still = new Set(found.map(n => n.id));
      for (const id of ids) if (!still.has(id)) forgetLinkSweepNote(db, id); // deleted since
    }
    for (const n of found) {
      if (candidates.has(n.id)) continue;
      candidates.set(n.id, n);
      rereads.add(n.id);
    }
  }
  // A note whose read or write failed before comes next. There are few, and behind a backlog that
  // can take months they would not be read again until it ends (Codex, #701).
  for (const n of failedBefore) if (!candidates.has(n.id)) candidates.set(n.id, n);
  // Then, when the cap has room, the notes the sweep has never read: those with the fewest links
  // first, links in and out together, newest first among equals (owner, #697). All of them are
  // offered in that order and the cap stops the reading, so one still being edited is passed over
  // for the next rather than taking the room (Codex, #701). A backlog note the cap or the quiet
  // window leaves out is not queued; the walk finds it again.
  const backlog = new Set<string>();
  let backlogUnread = 0;
  const room = config.linkSweepNoteCap - candidates.size;
  if (config.linkSweepBacklog === 'fewest-links' && room > 0) {
    const listed = await engine.listLinkSweepBacklog(filters);
    const known = linkSweepNoteStatuses(db, listed.nodes.map(n => n.id));
    const unread = listed.nodes
      .filter(n => !known.has(n.id) && !candidates.has(n.id))
      .sort(fewestLinksFirst);
    backlogUnread = unread.length;
    for (const n of unread) {
      candidates.set(n.id, n);
      backlog.add(n.id);
    }
  }

  const quietSince = now.getTime() - config.linkSweepQuietMinutes * 60_000;
  let readCount = 0;
  for (const note of candidates.values()) {
    const title = note.title ?? note.file_path;
    const reread = rereads.has(note.id);
    const fromBacklog = backlog.has(note.id);
    const recheck = rechecks.has(note.id);
    const editedRecently = typeof note.file_mtime === 'number' && note.file_mtime > quietSince;
    if (editedRecently || readCount >= config.linkSweepNoteCap) {
      // A queued note still being edited goes to the pending queue, as a reread does, so it can't
      // hold the front of the queue and keep the quiet ones behind it from being read (Codex, #701).
      if (fromBacklog || (recheck && !editedRecently)) continue;
      // A reread the cap did not reach stays `reported`, read again by a later run. One edited too
      // recently goes to the pending queue like a new note, so notes still being written can't hold
      // the front of the reported backlog and keep the rest from being read (Codex, #689).
      if (reread && !editedRecently) continue;
      result.leftForLater += 1;
      // A note left only for the cap keeps its place in the line; any other goes to the back.
      if (!dryRun && !(waited.has(note.id) && !editedRecently)) markLinkSweepNote(db, note.id, 'pending', 0, nowIso);
      if (!dryRun && recheck) dropLinkSweepRecheck(db, note.id);
      continue;
    }
    readCount += 1;
    try {
      const node = await engine.getNode(note.id);
      const linkedIds = new Set(Object.values(node.relationships?.outgoing ?? {})
        .flat().map(r => r.target_id).filter((id): id is string => id !== null));
      const mentions: Mention[] = [];
      for (const mention of findMentions(node.body ?? '', index, { selfId: note.id, linkedIds })) {
        if (!(await common.isCommon(mention.text))) mentions.push(mention);
      }
      const toApply: Mention[] = [];
      const toList: Mention[] = [];
      const version = node.version;
      const hash = node.metadata?.content_hash;
      for (const mention of mentions) {
        const target = targetsById.get(mention.targetId);
        const writes = apply && target !== undefined && typeof version === 'number' && typeof hash === 'string'
          && applicableMention(mention, target, kinds) && linkable(mention.title, mention.text)
          && standsAlone(node.body ?? '', mention) && await namesOneNote(mention.title);
        (writes ? toApply : toList).push(mention);
      }

      let operationId: string | null = null;
      let newHash: string | null = null;
      if (toApply.length > 0 && !dryRun) {
        try {
          ({ operationId, contentHash: newHash } = await engine.setBodyCas({
            nodeId: note.id, body: withLinks(node.body ?? '', toApply), expectedVersion: version!, expectedContentHash: hash!,
          }));
        } catch (err) {
          if (!changedSinceRead(err)) throw err;
          // Edited between the read and the write: nothing was written; read it again next run.
          result.leftForLater += 1;
          markLinkSweepNote(db, note.id, 'pending', 0, nowIso);
          dropLinkSweepRecheck(db, note.id);
          continue;
        }
      }
      result.read += 1;
      if (reread) result.reread += 1;
      if (fromBacklog) result.backlogRead += 1;
      if (recheck) result.rechecked += 1;
      if (operationId !== null) result.operationIds.push(operationId);
      // Best-effort: a failure only means the other sweeps read the note again, as before.
      if (newHash !== null) {
        try {
          if (keepLedgers(db, note.id, hash!, newHash, nowIso)) result.ledgersKept += 1;
        } catch (err) {
          console.warn(`[curator] link sweep: could not keep the other sweeps' records for "${title}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (toApply.length > 0) {
        result.notesLinked += 1;
        result.linksAdded += toApply.length;
        deps.recorder?.record({ action: 'links-added', nodeId: note.id, target: title, detail: linkedDetail(title, toApply, operationId, dryRun), dryRun });
      }
      if (toList.length > 0) {
        result.notesWithLinks += 1;
        result.links += toList.length;
        deps.recorder?.record({ action: 'links-proposed', nodeId: note.id, target: title, detail: proposalDetail(title, toList), dryRun });
      }
      if (!dryRun) {
        markLinkSweepNote(db, note.id, apply ? 'applied' : 'reported', mentions.length, nowIso);
        dropLinkSweepRecheck(db, note.id);
      }
    } catch (err) {
      // Read again next run, behind the notes that have not failed: a new note or a reread goes to
      // the pending queue, whose order counts failures, so a note that keeps failing can't block
      // the backlog it came from (Codex, #689).
      result.errors += 1;
      console.warn(`[curator] link sweep: could not read or link "${title}": ${err instanceof Error ? err.message : String(err)}`);
      if (!dryRun) {
        markLinkSweepNote(db, note.id, 'pending', 0, nowIso, true);
        dropLinkSweepRecheck(db, note.id);
      }
    }
  }
  // Every listed note now has a record (reported, applied or pending), so the mark can move past
  // them. A truncated listing (oldest first) moves it to the last note it listed, so the next run
  // lists the ones after; its own boundary note comes back and is skipped (Codex on #624).
  if (!dryRun) {
    const lastListed = created.nodes.at(-1)?.created_at;
    if (!created.truncated) writeLinkSweepWatermark(db, nowIso, nowIso);
    else if (typeof lastListed === 'number') writeLinkSweepWatermark(db, new Date(lastListed).toISOString(), nowIso);
  }
  if (created.truncated) result.detail = 'more new notes than one run lists; the rest come next run';
  if (apply) result.rereadLeft = countReportedLinkSweepNotes(db) - (dryRun ? result.reread : 0);
  result.recheckLeft = Math.max(0, countLinkSweepRechecks(db) - (dryRun ? result.rechecked : 0));
  // Backlog notes this run gave a record (read, or queued after a failed write) are no longer unread.
  result.backlogLeft = Math.max(0, backlogUnread - (dryRun ? result.backlogRead : linkSweepNoteStatuses(db, [...backlog]).size));
  result.commonNames = [...common.skipped].map(([name, share]) => `${name} ${Math.round(share * 100)}%`);
  return result;
}

/** Whether a name is too common to link (`COMMON_NAME_SHARE`): one Engine count per name a run
 *  meets, of the notes holding it as whole words (#687), kept for the run. A count that fails is not
 *  kept, so it throws for that note only. */
/** At most this many new names are looked for in one run; the rest wait for the next (#699). */
export const NEW_NAMES_PER_RUN = 50;

/**
 * A name that got a note after notes naming it were read (#699): a new person or company note, a
 * new alias, a rename. Each run compares the names it can link (a person's name of two or more
 * words, a company's title or alias; one note answering to it) with those it has seen, and for
 * each new one queues the notes that hold it as whole words and were read before, so they are read
 * again and get the link. The first run only records the names, so nothing reads the vault again
 * at once. A name too common to link is recorded and not looked for. Projects are not looked for:
 * apply mode never links them. At most `NEW_NAMES_PER_RUN` names a run, so an import of many
 * people notes is spread over nights.
 */
async function queueNotesNamingNewNames(
  engine: Pick<Engine, 'countNotes' | 'listNotesNaming'>,
  db: Database.Database,
  index: ReturnType<typeof buildNameIndex>,
  targetsById: ReadonlyMap<string, TargetInfo>,
  kinds: { person: string | null; company: string | null },
  filters: { withoutTypes: readonly string[]; withoutPathPrefix: string },
  now: string,
): Promise<{ looked: number; left: number }> {
  const linkable = new Map<string, { spelling: string; targetId: string }>();
  for (const [key, entry] of index.names) {
    if (entry.targetIds.size !== 1 || entry.personFirstName) continue;
    const targetId = [...entry.targetIds][0]!;
    const type = targetsById.get(targetId)?.type;
    if (type === undefined || (type !== kinds.person && type !== kinds.company)) continue;
    linkable.set(key, { spelling: [...entry.spellings][0]!, targetId });
  }
  if (!linkSweepNamesSeeded(db)) {
    seedLinkSweepNames(db, [...linkable].map(([key, name]) => ({ key, targetId: name.targetId })), now);
    return { looked: 0, left: 0 };
  }
  const known = knownLinkSweepNames(db);
  const fresh = [...linkable].filter(([key]) => !known.has(key)).sort(([a], [b]) => a.localeCompare(b));
  const common = commonNameCheck(engine);
  const batch = fresh.slice(0, NEW_NAMES_PER_RUN);
  for (const [key, { spelling, targetId }] of batch) {
    if (!(await common.isCommon(spelling))) {
      const ids = await engine.listNotesNaming(spelling, filters);
      const statuses = linkSweepNoteStatuses(db, ids);
      const readBefore = ids.filter(id => id !== targetId && (statuses.get(id) === 'applied' || statuses.get(id) === 'reported'));
      queueLinkSweepRechecks(db, readBefore, spelling, now);
    }
    recordLinkSweepName(db, key, targetId, now);
  }
  return { looked: batch.length, left: fresh.length - batch.length };
}

function commonNameCheck(engine: Pick<Engine, 'countNotes'>): { isCommon(name: string): Promise<boolean>; skipped: Map<string, number> } {
  let total: number | null = null;
  const counts = new Map<string, number>();
  const skipped = new Map<string, number>();
  return {
    skipped,
    async isCommon(name) {
      const key = name.toLowerCase();
      total ??= await engine.countNotes();
      let count = counts.get(key);
      if (count === undefined) {
        count = await engine.countNotes(name);
        // An Engine from before #687 drops `full_text_words` and counts every note. No name of a
        // vault this size is in every note, so stop rather than skip every name as too common.
        if (count >= total && total >= COMMON_NAME_MIN_NOTES) {
          throw new Error('the Engine counted every note for a name: it is older than this Curator (no full_text_words)');
        }
        counts.set(key, count);
      }
      const isCommon = count >= COMMON_NAME_MIN_NOTES && count >= total * COMMON_NAME_SHARE;
      if (isCommon && total > 0) skipped.set(name, count / total);
      return isCommon;
    },
  };
}

/** The run's journal summary line. */
/**
 * The backlog's order (#697): fewest links first, counting the notes that link to it and those it
 * links to, then newest first, then by id so the order is the same every run.
 */
export function fewestLinksFirst(a: LinkSweepBacklogRef, b: LinkSweepBacklogRef): number {
  return (a.inlink_count + a.outlink_count) - (b.inlink_count + b.outlink_count)
    || (b.created_at ?? 0) - (a.created_at ?? 0)
    || a.id.localeCompare(b.id);
}

export function summaryLine(r: LinkSweepResult, apply: boolean): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const sources = [
    ...(r.reread > 0 ? [`${r.reread} read again from report-only runs`] : []),
    ...(r.rechecked > 0 ? [`${r.rechecked} read again for a name that got a note`] : []),
    ...(r.backlogRead > 0 ? [`${r.backlogRead} older, fewest links first`] : []),
  ];
  const found = apply
    ? `read ${plural(r.read, 'note')}${sources.length > 0 ? ` (${sources.join('; ')})` : ''}; `
      + `${r.dryRun ? 'would add' : 'added'} ${plural(r.linksAdded, 'link')} in ${plural(r.notesLinked, 'note')}`
      + (r.links > 0 ? `; ${plural(r.links, 'more link')} to propose in ${plural(r.notesWithLinks, 'note')}` : '')
    : `${sources.length > 0 ? `read ${plural(r.read, 'note')} (${sources.join('; ')})` : `read ${r.read} new note${r.read === 1 ? '' : 's'}`}; `
      + `${plural(r.links, 'link')} to propose in ${plural(r.notesWithLinks, 'note')}`;
  return found
    + (r.leftForLater > 0 ? `; ${r.leftForLater} left for a later run` : '')
    + (apply && r.rereadLeft > 0 ? `; ${plural(r.rereadLeft, 'note')} from report-only runs still to read` : '')
    + (r.newNames > 0 ? `; looked for ${plural(r.newNames, 'name')} that got a note${r.newNamesLeft > 0 ? ` (${r.newNamesLeft} more next run)` : ''}` : '')
    + (r.recheckLeft > 0 ? `; ${plural(r.recheckLeft, 'note')} still to read again for such names` : '')
    + (r.backlogLeft > 0 ? `; ${plural(r.backlogLeft, 'older note')} still to read` : '')
    + (r.ambiguousNames > 0 ? `; ${plural(r.ambiguousNames, 'name')} skipped as ambiguous` : '')
    + (r.commonNames.length > 0 ? `; ${plural(r.commonNames.length, 'name')} skipped as too common (${r.commonNames.join(', ')})` : '')
    + (r.errors > 0 ? `; ${plural(r.errors, 'error')}` : '')
    + (r.detail ? ` (${r.detail})` : '')
    + (apply ? undoSentence(r) : '. Report only: no note was changed.');
}

/** How to undo an apply run: one note by the id on its line, or the whole run in one
 *  `undo-operations` call with every id, listed here ready to pass. */
function undoSentence(r: LinkSweepResult): string {
  if (r.operationIds.length > 0) {
    return '. Undo one note with the undo-operations id on its line, or this whole run in one call: '
      + `undo-operations with operation_ids ${JSON.stringify(r.operationIds)}. The Engine keeps undo for 24 hours.`;
  }
  return r.linksAdded > 0 && !r.dryRun ? '. The Engine returned no undo ids for these writes.' : '.';
}

/** Whether a run has anything for the journal: on the timer, a run that found nothing writes nothing. */
const foundSomething = (r: LinkSweepResult) => r.links > 0 || r.linksAdded > 0 || r.errors > 0;

function emitSummary(deps: LinkSweepDeps, r: LinkSweepResult, schedule: 'daily' | 'timer'): void {
  if (!r.ran) return;
  // On the timer, a run that found nothing stays out of the journal: 48 empty lines a day say nothing.
  if (schedule === 'timer' && !foundSomething(r)) return;
  deps.recorder?.summary('link-sweep', summaryLine(r, deps.config.linkSweepMode === 'apply'), {
    read: r.read, notesWithLinks: r.notesWithLinks, links: r.links, linksAdded: r.linksAdded, notesLinked: r.notesLinked,
    reread: r.reread, rereadLeft: r.rereadLeft, backlogRead: r.backlogRead, backlogLeft: r.backlogLeft,
    newNames: r.newNames, newNamesLeft: r.newNamesLeft, rechecked: r.rechecked, recheckLeft: r.recheckLeft,
    leftForLater: r.leftForLater, ledgersKept: r.ledgersKept,
    ambiguousNames: r.ambiguousNames, commonNames: r.commonNames.length, errors: r.errors,
    ...(r.operationIds.length > 0 ? { operationIds: r.operationIds } : {}),
  }, r.dryRun);
}

/**
 * One tick of the timer schedule (every `LINK_SWEEP_EVERY_MS`, from the server). It reads fresh
 * settings each time, so it runs only while the sweep is on and set to `timer`. A run that found or
 * added links, or hit an error, gets its own journal entry at once, with the plain lede (no model call),
 * like the wiki-field check; a run that found nothing writes nothing.
 */
export async function runLinkSweepOnTimer(
  deps: LinkSweepDeps & { llm: LlmClient; usage?: UsageReporter },
  log: (line: string) => void = () => {},
  now: () => Date = () => new Date(),
): Promise<LinkSweepResult> {
  const r = await runLinkSweep(deps, { dryRun: false, trigger: 'scheduled', schedule: 'timer', now });
  if (!r.ran || !foundSomething(r)) return r;
  log(`link sweep: ${r.linksAdded > 0 ? `${r.linksAdded} link(s) added in ${r.notesLinked} note(s), ` : ''}${r.links} link(s) to propose in ${r.notesWithLinks} of ${r.read} note(s)${r.errors > 0 ? `, ${r.errors} error(s)` : ''}`);
  if (deps.db && deps.recorder && r.runRef) {
    await writeJournalEntry({ engine: deps.engine, llm: deps.llm, config: deps.config, db: deps.db, recorder: deps.recorder,
      ...(deps.usage ? { usage: deps.usage } : {}) }, { kind: 'run-refs', runRefs: [r.runRef] }, 'link sweep', now(), { modelLede: false });
  }
  return r;
}
