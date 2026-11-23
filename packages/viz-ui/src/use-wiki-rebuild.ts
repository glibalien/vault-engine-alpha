import { useCallback, useEffect, useRef, useState } from 'react';
import type { WikiRebuildApi, WikiRebuildCheck, WikiRebuildRun, WikiRebuildStatus } from '@vault/query-core';
import { plainWikiDetail } from './wiki-build-text.js';

export type WikiRebuildProps = {
  api: WikiRebuildApi;
  project: string;
  onClose: () => void;
  /** Close the panel and show this page's latest build. */
  onShowLatest: () => void;
};

export type WikiRebuildPhase =
  | 'checking'
  /** The free check passed: it can be started. */
  | 'ready'
  /** The check or the Curator says it can't run. */
  | 'blocked'
  | 'starting'
  | 'running'
  /** The start request got no clear reply: it may or may not be running. */
  | 'unconfirmed'
  | 'finished';

export const POLL_MS = 3000;
const NO_SIGN_YET = 'No sign of it yet: it isn\'t running and no new build is recorded. Check again shortly. To start it again, close this dialog and open it again.';

/** The newest run from before the rebuild this panel follows. A build records its run before it
 *  finishes writing its journal, so a build still in progress may already have its run recorded. */
export function baselineRun(status: WikiRebuildStatus): number {
  const latest = status.latest_run;
  if (!latest) return 0;
  return status.in_progress && latest.ts >= status.in_progress.since ? latest.id - 1 : latest.id;
}

/** A whole-wiki rebuild's panel state. The Curator tracks a build by project, so closing the panel
 *  loses nothing: reopening it finds the build by its status. A paid start is never repeated
 *  automatically, and a lost reply is settled by reading status. */
export function useWikiRebuild(props: WikiRebuildProps) {
  const { api, project } = props;
  const [phase, setPhase] = useState<WikiRebuildPhase>('checking');
  const [status, setStatus] = useState<WikiRebuildStatus | null>(null);
  const [check, setCheck] = useState<Extract<WikiRebuildCheck, { in_progress: false }> | null>(null);
  const [run, setRun] = useState<WikiRebuildRun | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  /** The newest run before this rebuild: a newer one is its result. */
  const baseline = useRef(0);

  const follow = useCallback((next: WikiRebuildStatus, turn: number): void => {
    if (turn !== epoch.current) return;
    setStatus(next);
    if (next.in_progress) { setPhase('running'); return; }
    const latest = next.latest_run;
    setRun(latest && latest.id > baseline.current ? latest : null);
    setPhase('finished');
  }, []);

  useEffect(() => {
    const turn = ++epoch.current;
    setPhase('checking'); setStatus(null); setCheck(null); setRun(null); setBlocked(null); setError(null);
    void (async () => {
      try {
        const current = await api.status(project);
        if (turn !== epoch.current) return;
        setStatus(current);
        baseline.current = baselineRun(current);
        if (current.in_progress) { setPhase('running'); return; }
        const result = await api.check(project);
        if (turn !== epoch.current) return;
        if (result.in_progress) { setPhase('running'); return; }
        setCheck(result);
        if (result.outcome === 'would_curate') setPhase('ready');
        else { setBlocked(result.detail ? plainWikiDetail(project, result.detail) : `This wiki can't be rebuilt right now (${result.outcome}).`); setPhase('blocked'); }
      } catch {
        if (turn !== epoch.current) return;
        setBlocked('Cannot check this wiki. Check the Curator connection, token scopes and version.');
        setPhase('blocked');
      }
    })();
    return () => { epoch.current++; };
  }, [api, project]);

  useEffect(() => {
    if (phase !== 'running' || error) return;
    const turn = epoch.current;
    const timer = setTimeout(() => {
      void api.status(project).then(next => follow(next, turn)).catch(() => {
        if (turn === epoch.current) setError('Cannot read its status. It may still be running.');
      });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [api, project, phase, status, error, follow]);

  const confirm = async (): Promise<void> => {
    if (phase !== 'ready') return;
    const turn = epoch.current;
    setPhase('starting'); setError(null);
    try {
      const started = await api.start(project);
      if (turn !== epoch.current) return;
      if (started.status === 'refused') { setBlocked(plainWikiDetail(project, started.detail)); setPhase('blocked'); return; }
      setPhase('running');
    } catch {
      if (turn !== epoch.current) return;
      setError('Couldn\'t confirm it started. Check its status before trying again.');
      setPhase('unconfirmed');
    }
  };

  /** Read status by hand: after a failed poll, or to settle a start with no clear reply. */
  const retryStatus = async (): Promise<void> => {
    const turn = epoch.current;
    setError(null);
    try {
      const next = await api.status(project);
      if (turn !== epoch.current) return;
      setStatus(next);
      if (next.in_progress) { setPhase('running'); return; }
      if ((next.latest_run?.id ?? 0) > baseline.current) { follow(next, turn); return; }
      // No sign of it doesn't prove it never started: the Curator registers a build only once it
      // has resolved the project. So a paid start isn't offered again from here.
      if (phase === 'unconfirmed') { setError(NO_SIGN_YET); return; }
      setPhase('finished');
    } catch {
      if (turn === epoch.current) setError('Cannot read its status. It may still be running.');
    }
  };

  return { phase, status, check, run, blocked, error, confirm, retryStatus };
}
