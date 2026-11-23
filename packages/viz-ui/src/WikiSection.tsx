import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WikiControlApi, WikiRebuildStatus } from '@vault/query-core';
import type { PageWiki } from './use-provenance-inspector.js';
import { friendlyTime } from './provenance-sources.js';
import { plainWikiDetail, shortDay, usd, waitingInLane } from './wiki-build-text.js';

/** The wiki's live status from Curator, and pausing or resuming its scheduled builds (#545). Everything
 *  comes from tools an AI caller has: curator-status and set-wiki-paused on Curator. */
export type WikiLive = {
  status: WikiRebuildStatus | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  notice: string | null;
  setPaused: (paused: boolean) => Promise<void>;
};

export function useWikiStatus(
  api: WikiControlApi | undefined,
  wiki: PageWiki | null,
  refreshKey = 0,
  onChanged?: () => void,
): WikiLive {
  const [status, setStatus] = useState<WikiRebuildStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const epoch = useRef(0);
  const name = wiki?.name ?? null;

  useEffect(() => {
    const turn = ++epoch.current;
    // A pause or resume still in flight belongs to the read this replaces: its finally won't clear busy.
    setStatus(null); setNotice(null); setError(null); setBusy(false);
    if (!api || !name) { setLoading(false); return; }
    setLoading(true);
    void api.status(name).then(next => {
      if (turn !== epoch.current) return;
      setStatus(next); setLoading(false);
    }, () => {
      if (turn !== epoch.current) return;
      setStatus(null); setLoading(false);
      setError('Couldn\'t read this wiki\'s status from Curator. Check the Curator connection, token scopes and version.');
    });
    return () => { epoch.current++; };
  }, [api, name, refreshKey]);

  const setPaused = async (pause: boolean): Promise<void> => {
    if (!api || !name || !status || busy) return;
    const turn = ++epoch.current;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api.setPaused(name, pause);
      if (turn !== epoch.current) return;
      setStatus({ ...status, paused: result.paused });
      setNotice(result.paused ? 'Scheduled builds are off.' : 'Scheduled builds are on.');
      onChanged?.();
      // The rest of the status may have moved too; a failed re-read keeps the answer above.
      const next = await api.status(name).catch(() => null);
      if (next && turn === epoch.current) setStatus(next);
    } catch {
      if (turn === epoch.current)
        setError(pause
          ? 'Couldn\'t turn scheduled builds off. Check the Curator connection and that its token has the curate:trigger scope.'
          : 'Couldn\'t turn scheduled builds on. Check the Curator connection and that its token has the curate:trigger scope.');
    } finally {
      if (turn === epoch.current) setBusy(false);
    }
  };

  return { status, loading, error, busy, notice, setPaused };
}

export type Dot = 'ok' | 'warn' | 'error' | 'busy' | 'paused' | 'muted';
export type RowState = { dot: Dot; label: string; detail: string | null };

/** The wiki's state in a word and a sentence, from Curator's live status and the home's `wiki_status`
 *  (#547): Curator knows about a pause, a running build and a failed run; only the home says whether a
 *  project wiki's notes have moved on since its last build. */
export function wikiState(wiki: PageWiki, live: WikiLive): RowState {
  const home = wiki.homeStatus;
  const status = live.status;
  if (status?.in_progress)
    return waitingInLane(status, wiki.name)
      ? { dot: 'busy', label: 'Queued', detail: 'Curator is finishing other work first. This build starts after it.' }
      : { dot: 'busy', label: 'Building now', detail: `Started ${friendlyTime(status.in_progress.since)}. This usually takes a few minutes.` };
  // A scheduled sweep's build stamps the home but isn't one the Curator reports as in progress.
  if (home === 'building') return { dot: 'busy', label: 'Building now', detail: 'A scheduled build is running.' };
  const paused = status ? status.paused : home === 'paused' || home === 'paused-behind';
  const behind = home === 'behind' || home === 'paused-behind';
  const latest = status?.latest_run ?? null;
  const written = status?.last_written ?? null;
  const failedRun = latest?.outcome === 'error' && (!written || latest.id > written.id) ? latest : null;
  const since = written ? ` since its ${shortDay(written.ts)} build` : ' since its last build';
  const off = 'Scheduled builds are off.';
  if (failedRun || (home === 'failed' && !paused)) {
    const why = failedRun?.error
      ? `${shortDay(failedRun.ts)}: ${plainWikiDetail(wiki.name, failedRun.error)}`
      : 'Its last build failed.';
    return { dot: 'error', label: 'Last build failed', detail: paused ? `${why} ${off}` : why };
  }
  if (status && !written && !home)
    return { dot: 'muted', label: 'Not built yet', detail: paused ? `Curator hasn't built it yet. ${off}` : 'Curator hasn\'t built it yet.' };
  if (paused && behind) return { dot: 'paused', label: 'Paused, and behind', detail: `Notes have changed${since}. ${off}` };
  if (paused) return { dot: 'paused', label: 'Paused', detail: `${off} It changes only when you rebuild it.` };
  if (behind) return { dot: 'warn', label: 'Behind', detail: `Notes have changed${since}.` };
  if (home === 'current')
    return { dot: 'ok', label: 'Up to date', detail: wiki.kind === 'project' ? `Its notes haven't changed${since}.` : written ? `Built ${shortDay(written.ts)}.` : null };
  if (live.loading) return { dot: 'muted', label: 'Checking…', detail: null };
  if (live.error) return { dot: 'muted', label: 'Status unavailable', detail: live.error };
  return { dot: 'muted', label: written ? `Built ${shortDay(written.ts)}` : 'No status yet', detail: null };
}

export function Setting({ name, desc, children }: { name: string; desc?: ReactNode; children?: ReactNode }) {
  return <div className="vp-setting">
    <div className="vp-setting-info">
      <div>{name}</div>
      {desc && <div className="vp-setting-desc">{desc}</div>}
    </div>
    {children}
  </div>;
}

export type WikiSectionProps = {
  wiki: PageWiki;
  live: WikiLive;
  /** Open the wiki's home page. */
  onOpenHome?: (homeId: string) => void;
};

/** The wiki's controls, as setting rows: scheduled builds, its last full build and today's budget. */
export function WikiSection({ wiki, live, onOpenHome }: WikiSectionProps) {
  const { status } = live;
  const web = status?.kind === 'topic' && status.source === 'vault+web';
  const written = status?.last_written ?? null;
  const cap = status?.daily_budget.cap_usd ?? null;
  const left = status?.daily_budget.remaining_usd ?? null;
  const share = cap && left !== null ? Math.max(0, Math.min(100, Math.round((left / cap) * 100))) : null;
  return <div className="vp-wiki">
    {live.loading && <p className="vp-hint" role="status">Checking the wiki's status…</p>}
    {live.error && <p role="alert" className="vp-hint">{live.error}</p>}
    {status && <Setting
      name="Scheduled builds"
      desc={status.paused ? 'Off. This wiki changes only when you rebuild it.' : 'Curator keeps this wiki current on its own schedule.'}
    >
      <button
        className="vp-toggle"
        role="switch"
        aria-checked={!status.paused}
        aria-label="Scheduled builds"
        disabled={live.busy}
        onClick={() => void live.setPaused(!status.paused)}
      />
    </Setting>}
    {web && <Setting name="Reads" desc="Its source notes, plus the top web results for the topic." />}
    {status && <Setting name="Last full build">
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
    {live.notice && <p role="status" className="vp-hint">{live.notice}</p>}
    {wiki.role !== 'home' && wiki.homeId && onOpenHome && (
      <div className="vp-actions">
        <button onClick={() => onOpenHome(wiki.homeId!)}>Open wiki home</button>
      </div>
    )}
  </div>;
}
