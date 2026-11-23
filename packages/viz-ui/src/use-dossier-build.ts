import { useCallback, useEffect, useRef, useState } from 'react';
import type { DossierApi, DossierPreview, WikiRebuildRun, WikiRebuildStatus } from '@vault/query-core';
import { baselineRun, POLL_MS } from './use-wiki-rebuild.js';

export type DossierBuildProps = {
  api: DossierApi;
  /** The note's Engine node, from `noteRef` (its path), so a namesake in another folder can't be taken for it. */
  note: (ref: string) => Promise<{ id: string; title: string }>;
  /** The note's file name, shown until Engine names it. */
  noteTitle: string;
  noteRef: string;
  onClose: () => void;
  /** Open the dossier's page by its title. */
  onOpenPage?: (title: string) => void;
};

export type DossierBuildPhase =
  | 'checking'
  /** The free dry run passed: the preview is shown. */
  | 'ready'
  /** The Curator refused, or the check failed. */
  | 'blocked'
  | 'starting'
  /** Queued or running. */
  | 'running'
  /** The build request got no clear reply: it may or may not have started. */
  | 'unconfirmed'
  | 'finished';

/** How it ended: the build's run (null when none is on record), or the Curator's answer when it built at once. */
export type DossierBuildEnd =
  | { kind: 'run'; run: WikiRebuildRun | null }
  | { kind: 'answered'; outcome: string; detail: string };

const NO_SIGN_YET = 'No sign of it yet: it isn\'t running and no new build is recorded. Check again shortly. To try again, close this and run the command again.';

/**
 * "Build dossier" (#715): the free dry run of build-dossier, the paid build on confirm, then the
 * build followed by curator-status under the page's title, where the Curator records its runs. A
 * paid start is never repeated automatically, and a lost reply is settled by reading status.
 */
export function useDossierBuild(props: DossierBuildProps) {
  const { api, note, noteRef } = props;
  const [phase, setPhase] = useState<DossierBuildPhase>('checking');
  const [title, setTitle] = useState(props.noteTitle);
  const [preview, setPreview] = useState<DossierPreview | null>(null);
  const [status, setStatus] = useState<WikiRebuildStatus | null>(null);
  const [ended, setEnded] = useState<DossierBuildEnd | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nodeId = useRef<string | null>(null);
  const epoch = useRef(0);
  const baseline = useRef(0);

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
    setPhase('checking'); setPreview(null); setStatus(null); setEnded(null); setBlocked(null); setError(null);
    void (async () => {
      try {
        const found = await note(noteRef);
        if (turn !== epoch.current) return;
        nodeId.current = found.id;
        setTitle(found.title);
        const checked = await api.check(found.id);
        if (turn !== epoch.current) return;
        if (checked.status === 'refused') { setBlocked(checked.message || `Curator refused it (${checked.code}).`); setPhase('blocked'); return; }
        setPreview(checked);
        const current = await api.status(checked.page_title);
        if (turn !== epoch.current) return;
        setStatus(current);
        baseline.current = baselineRun(current);
        setPhase(current.in_progress ? 'running' : 'ready');
      } catch {
        if (turn !== epoch.current) return;
        setBlocked('Cannot check this note. Check the Engine and Curator connections, token scopes and versions.');
        setPhase('blocked');
      }
    })();
    return () => { epoch.current++; };
  }, [api, note, noteRef]);

  const pageTitle = preview?.page_title ?? null;
  useEffect(() => {
    if (phase !== 'running' || error || pageTitle === null) return;
    const turn = epoch.current;
    const timer = setTimeout(() => {
      void api.status(pageTitle).then(next => follow(next, turn)).catch(() => {
        if (turn === epoch.current) setError('Cannot read its status. It may still be running.');
      });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [api, pageTitle, phase, status, error, follow]);

  /** The paid build. `nightly` sets how the dossier is kept when it differs from the note's mode now: the
   *  Curator writes the note's `dossier` field before the build reads the note (#714). */
  const confirm = async (nightly?: boolean): Promise<void> => {
    if (phase !== 'ready' || !nodeId.current || !preview?.fits) return;
    const turn = epoch.current;
    const mode = nightly === undefined ? undefined : nightly ? 'on-change' as const : 'manual' as const;
    setPhase('starting'); setError(null);
    try {
      const started = mode !== undefined && mode !== preview.rebuild ? await api.start(nodeId.current, mode) : await api.start(nodeId.current);
      if (turn !== epoch.current) return;
      switch (started.status) {
        case 'refused': setBlocked(started.message || `Curator refused it (${started.code}).`); setPhase('blocked'); return;
        case 'answered': setEnded({ kind: 'answered', outcome: started.outcome, detail: started.detail }); setPhase('finished'); return;
        case 'queued': case 'in_progress': setPhase('running'); return;
      }
    } catch {
      if (turn !== epoch.current) return;
      setError('Couldn\'t confirm it started. Check its status before trying again.');
      setPhase('unconfirmed');
    }
  };

  /** Read status by hand: after a failed poll, or to settle a start with no clear reply. */
  const retryStatus = async (): Promise<void> => {
    if (pageTitle === null) return;
    const turn = epoch.current;
    setError(null);
    try {
      const next = await api.status(pageTitle);
      if (turn !== epoch.current) return;
      setStatus(next);
      if (next.in_progress) { setPhase('running'); return; }
      if ((next.latest_run?.id ?? 0) > baseline.current) { follow(next, turn); return; }
      // No sign of it doesn't prove it never started, so a paid start isn't offered again from here.
      if (phase === 'unconfirmed') { setError(NO_SIGN_YET); return; }
      follow(next, turn);
    } catch {
      if (turn === epoch.current) setError('Cannot read its status. It may still be running.');
    }
  };

  return { phase, title, preview, status, ended, blocked, error, confirm, retryStatus };
}
