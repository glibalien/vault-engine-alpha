import { useCallback, useEffect, useRef, useState } from 'react';
import type { WikiCreateApi, WikiRebuildApi, WikiRebuildRun, WikiRebuildStatus } from '@vault/query-core';
import { baselineRun, POLL_MS } from './use-wiki-rebuild.js';
import { createRefusal } from './wiki-build-text.js';

export type WikiCreateProps = {
  api: WikiCreateApi;
  /** The project note's title: shown, and used to follow its build. */
  project: string;
  /** What create-project-wiki is called with: the note's path or node id, so a namesake in another
   *  folder can't be taken for it. Defaults to `project`. */
  projectRef?: string;
  onClose: () => void;
  /** The project has a wiki now: it already had one, or this registered it. */
  onRegistered?: () => void;
  /** Open the wiki's home page. */
  onOpenWiki?: () => void;
  /** Whole-wiki builds (curate-project-wiki with force, as the inspector's rebuild uses). With it, a
   *  first build that a pause from before the create stopped is offered as Build it now (#544). */
  rebuild?: WikiRebuildApi;
};

export type WikiCreatePhase =
  | 'checking'
  /** The free check passed: it can be created. */
  | 'ready'
  /** The project already has a wiki. */
  | 'exists'
  /** The check or the Curator says it can't be created. */
  | 'blocked'
  | 'starting'
  /** Its first build is queued or running. */
  | 'running'
  /** The create request got no clear reply: it may or may not have started. */
  | 'unconfirmed'
  | 'finished';

/** How it ended: the first build's run (null when none is on record), or the Curator's answer
 *  when it registered the wiki without running a first build. */
export type WikiCreateEnd =
  | { kind: 'run'; run: WikiRebuildRun | null }
  | { kind: 'registered' }
  /** A renamed project's wiki now goes by its current title. */
  | { kind: 'moved'; from: string }
  | { kind: 'not_started'; outcome: string; detail: string | null };

const NO_SIGN_YET = 'No sign of it yet: no build is running and none is recorded. Check again shortly. To try again, close this window and run the command again.';

/** A project wiki's create panel. The check is free; creating registers the wiki and queues its
 *  first build, which the Curator tracks by project, so the panel follows it by status. A paid
 *  start is never repeated automatically, and a lost reply is settled by reading status. */
export function useWikiCreate(props: WikiCreateProps) {
  const { api, project } = props;
  const ref = props.projectRef ?? project;
  const registered = useRef(props.onRegistered);
  registered.current = props.onRegistered;
  const [phase, setPhase] = useState<WikiCreatePhase>('checking');
  const [status, setStatus] = useState<WikiRebuildStatus | null>(null);
  const [homeMissing, setHomeMissing] = useState(true);
  /** The old title a renamed project's wiki is still registered under: creating moves it. */
  const [renamedFrom, setRenamedFrom] = useState<string | null>(null);
  const [ended, setEnded] = useState<WikiCreateEnd | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  /** The newest run before this build: a newer one is its result. */
  const baseline = useRef(0);
  const markRegistered = (): void => { registered.current?.(); };

  const follow = useCallback((next: WikiRebuildStatus, turn: number): void => {
    if (turn !== epoch.current) return;
    setStatus(next);
    if (next.in_progress) { setPhase('running'); return; }
    const latest = next.latest_run;
    setEnded({ kind: 'run', run: latest && latest.id > baseline.current ? latest : null });
    setPhase('finished');
  }, []);

  useEffect(() => {
    const turn = ++epoch.current;
    setPhase('checking'); setStatus(null); setHomeMissing(true); setRenamedFrom(null); setEnded(null); setBlocked(null); setError(null);
    void (async () => {
      try {
        const current = await api.status(project);
        if (turn !== epoch.current) return;
        setStatus(current);
        baseline.current = baselineRun(current);
        // Only a registered wiki has a build in flight.
        if (current.in_progress) { markRegistered(); setPhase('running'); return; }
        const result = await api.check(ref);
        if (turn !== epoch.current) return;
        switch (result.status) {
          case 'in_progress': markRegistered(); setPhase('running'); return;
          case 'exists': markRegistered(); setPhase('exists'); return;
          case 'renamed': setRenamedFrom(result.from); setHomeMissing(false); setPhase('ready'); return;
          case 'refused': setBlocked(createRefusal(project, result.code, result.message)); setPhase('blocked'); return;
          case 'ready': setHomeMissing(result.home_missing); setPhase('ready'); return;
        }
      } catch {
        if (turn !== epoch.current) return;
        setBlocked('Cannot check this project. Check the Curator connection, token scopes and version.');
        setPhase('blocked');
      }
    })();
    return () => { epoch.current++; };
  }, [api, project, ref]);

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
      const started = await api.start(ref);
      if (turn !== epoch.current) return;
      switch (started.status) {
        case 'refused':
          // The wiki is registered even though its home couldn't be written.
          if (started.code === 'HOME_CREATE_FAILED') markRegistered();
          setBlocked(createRefusal(project, started.code, started.message)); setPhase('blocked'); return;
        case 'exists':
          markRegistered();
          if (renamedFrom !== null) { setEnded({ kind: 'moved', from: renamedFrom }); setPhase('finished'); return; }
          setPhase('exists'); return;
        case 'registered': markRegistered(); setEnded({ kind: 'registered' }); setPhase('finished'); return;
        case 'not_started':
          markRegistered(); setEnded({ kind: 'not_started', outcome: started.outcome, detail: started.detail }); setPhase('finished'); return;
        case 'queued': case 'in_progress': markRegistered(); setPhase('running'); return;
      }
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
      if (next.in_progress) { markRegistered(); setPhase('running'); return; }
      if ((next.latest_run?.id ?? 0) > baseline.current) { markRegistered(); follow(next, turn); return; }
      // No sign of it doesn't prove it never started, so a paid start isn't offered again from here.
      if (phase === 'unconfirmed') { setError(NO_SIGN_YET); return; }
      follow(next, turn);
    } catch {
      if (turn === epoch.current) setError('Cannot read its status. It may still be running.');
    }
  };

  return { phase, status, homeMissing, renamedFrom, ended, blocked, error, confirm, retryStatus };
}
