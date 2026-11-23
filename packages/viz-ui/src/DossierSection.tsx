import { useEffect, useRef, useState } from 'react';
import type { DossierApi, MemoryRow, WikiRebuildStatus } from '@vault/query-core';
import type { PageDossier } from './use-provenance-inspector.js';
import { useVizClient } from './viz-client-context.js';
import { friendlyTime, plural } from './provenance-sources.js';
import { aheadInLane, shortDay, usd, waitingInLane } from './wiki-build-text.js';
import { Setting, type RowState } from './WikiSection.js';

/**
 * A dossier in the wiki panel (#554): one page about a person or a company, kept by the Curator's
 * build-dossier. Everything here comes from tools an AI caller has: curator-status under the page's
 * title for its builds and today's budget, list-memories for what was recorded since a build, and
 * update-node for the note's own `dossier` field.
 */

/** The dossier's builds from Curator: curator-status with `project` set to the page title, where they run. */
export type DossierLive = {
  status: WikiRebuildStatus | null;
  loading: boolean;
  error: string | null;
};

/** How often the panel reads a build in flight again, until it ends. */
export const DOSSIER_POLL_MS = 5000;

/** The title the dossier's builds run under: its page's, or for a note with no page yet the one its first
 *  build gives it ("<Name> Dossier", as build-dossier names it), so a first build in flight shows too. */
export function dossierPageTitle(dossier: PageDossier | null): string | null {
  return dossier ? dossier.pageTitle ?? `${dossier.subjectTitle} Dossier` : null;
}

/**
 * The dossier's status from Curator, read again every few seconds while a build is in flight. When one
 * the panel saw running ends, `onFinished` is called, so the panel can read the page it wrote.
 */
export function useDossierStatus(api: DossierApi | undefined, dossier: PageDossier | null, refreshKey = 0,
  onFinished?: () => void): DossierLive {
  const [status, setStatus] = useState<WikiRebuildStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const title = dossierPageTitle(dossier);

  useEffect(() => {
    const turn = ++epoch.current;
    setStatus(null); setError(null);
    if (!api || !title) { setLoading(false); return; }
    setLoading(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const read = (): void => {
      void api.status(title).then(next => {
        if (turn !== epoch.current) return;
        setStatus(next); setLoading(false); setError(null);
        if (next.in_progress) { running = true; timer = setTimeout(read, DOSSIER_POLL_MS); return; }
        if (running) { running = false; finished.current?.(); }
      }, () => {
        if (turn !== epoch.current) return;
        setLoading(false);
        // A build in flight keeps its last status and is read again later; a first read that fails says so.
        if (running) { timer = setTimeout(read, DOSSIER_POLL_MS * 3); return; }
        setError('Couldn\'t read this dossier\'s status from Curator. Check the Curator connection, token scopes and version.');
      });
    };
    read();
    return () => { epoch.current++; if (timer !== undefined) clearTimeout(timer); };
  }, [api, title, refreshKey]);

  return { status, loading, error };
}

/** list-memories pages read to find what is new: 200 memories a page, so up to 1,000 about one subject. */
export const NEWS_PAGE = 200;
export const NEWS_PAGES = 5;

/** Memories recorded about the dossier's subject since its build, which the build didn't read. `complete`
 *  is false when the subject has more memories than were read, so more may be new. */
export type DossierNews = { memories: MemoryRow[]; loading: boolean; error: string | null; complete: boolean };

/**
 * What has been recorded about the subject since the build (#714's "a new memory about the subject"):
 * list-memories `subject_of` the note, keeping those created after the build that are not among its
 * inputs. list-memories orders by when each memory became true, not when it was recorded, so a memory
 * recorded today from an older note can be anywhere in the list: it is read page by page, up to
 * `NEWS_PAGES`. `read` is null until the build's inputs have all loaded.
 */
export function useDossierNews(dossier: PageDossier | null, builtAt: string | null, read: ReadonlySet<string> | null, refreshKey = 0): DossierNews {
  const client = useVizClient();
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const epoch = useRef(0);
  const subject = dossier?.role === 'page' ? dossier.subjectId : null;
  // The inputs drive the effect by value, so a new Set for the same build doesn't read again.
  const readKey = read ? [...read].sort().join('\n') : null;

  useEffect(() => {
    const turn = ++epoch.current;
    setMemories([]); setError(null); setComplete(false);
    if (!subject || !builtAt || readKey === null) { setLoading(false); return; }
    const seen = new Set(readKey ? readKey.split('\n') : []);
    const since = Date.parse(builtAt);
    setLoading(true);
    void (async () => {
      const found: MemoryRow[] = [];
      let offset = 0;
      let all = false;
      for (let page = 0; page < NEWS_PAGES && !all; page++) {
        const env = await client.listMemories({ subject_of: subject, limit: NEWS_PAGE, offset });
        if (turn !== epoch.current) return;
        if (!env.ok || !Array.isArray(env.data?.memories)) throw Error('Invalid list-memories response');
        found.push(...env.data.memories.filter(m => !seen.has(String(m.id)) && Date.parse(m.created_at) > since));
        offset += env.data.memories.length;
        all = env.data.memories.length < NEWS_PAGE || offset >= env.data.total;
      }
      setMemories(found); setComplete(all); setLoading(false);
    })().catch(() => {
      if (turn !== epoch.current) return;
      setLoading(false);
      setError('Couldn\'t read the memories recorded since this build.');
    });
    return () => { epoch.current++; };
  }, [client, subject, builtAt, readKey, refreshKey]);

  return { memories, loading, error, complete };
}

/** What has changed since the build, as the panel can count it: its sources that changed or are gone,
 *  and the memories recorded about the subject since. */
export type DossierChanges = {
  sources: number;
  memories: number;
  /** False when the subject has more memories than the panel read, so `memories` is a lower bound. */
  allMemories?: boolean;
};

/**
 * The dossier's state in a word and a sentence: Curator knows about a build in flight and a failed one;
 * the page's `wiki_status`, which the Curator writes every 30 minutes, says whether it is behind; and
 * on the page itself the panel counts what changed since the build.
 */
export function dossierState(dossier: PageDossier, live: DossierLive, changes: DossierChanges | null = null): RowState {
  const status = live.status;
  const page = dossierPageTitle(dossier) ?? dossier.subjectTitle;
  if (status?.in_progress) {
    const ahead = aheadInLane(status, page);
    return waitingInLane(status, page)
      ? { dot: 'busy', label: 'Queued', detail: `Curator is finishing ${ahead ? `“${ahead}”` : 'other work'} first. This build starts after it.` }
      : { dot: 'busy', label: 'Building now', detail: `Started ${friendlyTime(status.in_progress.since)}. This usually takes a minute or two.` };
  }
  const latest = status?.latest_run ?? null;
  const written = status?.last_written ?? null;
  const failed = latest?.outcome === 'error' && (!written || latest.id > written.id) ? latest : null;
  const since = written ? ` since its ${shortDay(written.ts)} build` : ' since its last build';
  if (failed)
    return {
      dot: 'error',
      label: 'Last build failed',
      detail: `${shortDay(failed.ts)}: ${failed.error?.replace(/\.$/, '') ?? 'it failed'}.${written ? ` The page still shows its ${shortDay(written.ts)} build.` : ''}`,
    };
  const counted = changes !== null && changes.sources + changes.memories > 0;
  if (dossier.homeStatus === 'behind' || counted) {
    const parts = changes
      ? [
          ...(changes.memories > 0
            ? [`${changes.allMemories === false ? 'at least ' : ''}${plural(changes.memories, 'new memory', 'new memories')} about ${dossier.subjectTitle}`]
            : []),
          ...(changes.sources > 0 ? [plural(changes.sources, 'changed source')] : []),
        ]
      : [];
    const listed = parts.join(' and ');
    const what = parts.length > 0 ? `${listed.charAt(0).toUpperCase()}${listed.slice(1)}${since}.` : `Memories or notes it read have changed${since}.`;
    return { dot: 'warn', label: 'Behind', detail: `${what}${dossier.rebuild === 'on-change' ? ' Set to rebuild tonight.' : ''}` };
  }
  if (dossier.homeStatus === 'current') return { dot: 'ok', label: 'Up to date', detail: written ? `Built ${shortDay(written.ts)}.` : null };
  if (live.loading) return { dot: 'muted', label: 'Checking…', detail: null };
  if (live.error) return { dot: 'muted', label: 'Status unavailable', detail: live.error };
  return { dot: 'muted', label: written ? `Built ${shortDay(written.ts)}` : 'No status yet', detail: null };
}

export type DossierSectionProps = {
  dossier: PageDossier;
  live: DossierLive;
  /** Turn nightly rebuilds on or off: the subject note's `dossier` field. */
  onSetRebuild?: (on: boolean) => void;
  busy?: boolean;
  error?: string | null;
  /** Open a note: the dossier page from its subject, the subject from its page. */
  onOpen?: (nodeId: string) => void;
};

/** The dossier's controls, as setting rows: nightly rebuilds, its last build and today's budget. */
export function DossierSection({ dossier, live, onSetRebuild, busy = false, error = null, onOpen }: DossierSectionProps) {
  const { status } = live;
  const on = dossier.rebuild === 'on-change';
  const written = status?.last_written ?? null;
  const cap = status?.daily_budget.cap_usd ?? null;
  const left = status?.daily_budget.remaining_usd ?? null;
  const share = cap && left !== null ? Math.max(0, Math.min(100, Math.round((left / cap) * 100))) : null;
  const open = dossier.role === 'page'
    ? { id: dossier.subjectId, label: `Open ${dossier.subjectTitle}` }
    : dossier.pageId ? { id: dossier.pageId, label: 'Open dossier' } : null;
  return <div className="vp-wiki">
    {live.loading && <p className="vp-hint" role="status">Checking the dossier's status…</p>}
    {live.error && <p role="alert" className="vp-hint">{live.error}</p>}
    <Setting
      name="Rebuild nightly when behind"
      desc={<>
        {on
          ? 'On. Curator rebuilds it in the nightly sweep when it falls behind, from the daily budget (at most 5 dossiers a night).'
          : 'Off. It changes only when you rebuild it.'}
        {onSetRebuild && <span className="vp-setting-note">
          {' '}Saved on {dossier.subjectTitle} as <code>dossier: on-change</code>, so the dossier shows that note as changed until its next build.
          The rebuild dialog can set it as part of the build instead.
        </span>}
      </>}
    >
      {onSetRebuild && <button
        className="vp-toggle"
        role="switch"
        aria-checked={on}
        aria-label="Rebuild nightly when behind"
        disabled={busy}
        onClick={() => onSetRebuild(!on)}
      />}
    </Setting>
    {error && <p role="alert" className="vp-hint">{error}</p>}
    {status && <Setting name="Last build">
      <div className="vp-setting-value">
        {written ? shortDay(written.ts) : 'None yet'}
        {written && <small>{written.cost_usd === null ? 'no cost recorded' : `est. ${usd(written.cost_usd)}`}</small>}
      </div>
    </Setting>}
    {cap !== null && left !== null && <Setting
      name="Today's Curator budget"
      desc={<>
        {usd(left)} of {usd(cap)} left
        <span
          className={`vp-meter${share !== null && share < 20 ? ' vp-meter--low' : ''}`}
          role="meter"
          aria-label="Today's Curator budget left"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={share ?? 0}
          style={{ display: 'block' }}
        ><span style={{ width: `${share ?? 0}%` }} /></span>
      </>}
    />}
    {open && onOpen && (
      <div className="vp-actions">
        <button onClick={() => onOpen(open.id)}>{open.label}</button>
      </div>
    )}
  </div>;
}
