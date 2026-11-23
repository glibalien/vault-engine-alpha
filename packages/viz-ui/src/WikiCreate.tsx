import { useEffect, useRef, useState } from 'react';
import type { WikiRebuildStatus } from '@vault/query-core';
import { useWikiCreate, type WikiCreateEnd, type WikiCreateProps } from './use-wiki-create.js';
import { WikiRebuild } from './WikiRebuild.js';
import { budgetLine, plainWikiDetail, usd, waitingInLane } from './wiki-build-text.js';

const budgetSpent = (status: WikiRebuildStatus): boolean =>
  status.daily_budget.remaining_usd !== null && status.daily_budget.remaining_usd <= 0;

/** Scheduled sweeps build wikis only while Curator's wikiReconciliationMode is live (its default is
 *  off), so the panel promises no sweep build: it points to building on request (#544). */
const FROM_HOME = 'open its home page and, in the wiki panel, choose Rebuild… on the Wiki row';

/** The Curator answered the first build at once because a pause from before this create still holds. */
const pausedFirstBuild = (ended: WikiCreateEnd | null): boolean =>
  ended?.kind === 'not_started' && ended.outcome === 'skipped' && ended.detail === 'paused';

function outcome(ended: WikiCreateEnd | null, project: string, canBuild: boolean): string {
  if (!ended) return '';
  if (ended.kind === 'moved')
    return `The wiki now goes by "${project}" instead of "${ended.from}".`;
  if (ended.kind === 'registered')
    return 'The wiki is registered again. Its pages were built before, so it needed no first build.';
  if (ended.kind === 'not_started') {
    if (pausedFirstBuild(ended))
      return 'The wiki is registered, but a pause set on it earlier still holds, so its first build didn\'t run. '
        + (canBuild ? 'Building it now runs that build and leaves the wiki paused.' : `To build it, ${FROM_HOME}; the wiki stays paused.`);
    const reason = ended.detail ? plainWikiDetail(project, ended.detail) : ended.outcome;
    return `The wiki is registered, but its first build didn't run: ${reason.replace(/\.$/, '')}.`;
  }
  const { run } = ended;
  if (!run) return 'It finished with no build on record. Curator status may say more.';
  const spent = run.cost_usd ? ` It spent an estimated ${usd(run.cost_usd)} first.` : '';
  switch (run.outcome) {
    case 'written': return run.cost_usd === null ? 'The wiki was built.' : `The wiki was built, for an estimated ${usd(run.cost_usd)}.`;
    case 'skipped_budget':
      return `Today's Curator budget is spent, so the first build didn't run. The wiki is registered with an empty home. To build it once there's budget, ${FROM_HOME}.`;
    case 'error':
      return `${run.error ? `The first build failed: ${plainWikiDetail(project, run.error)}` : 'The first build failed.'}${spent} The wiki stays registered.`;
    default: return `The wiki is registered, but its first build finished without writing it (${run.outcome}).${spent}`;
  }
}

function progress(status: WikiRebuildStatus | null, project: string): string {
  if (waitingInLane(status, project)) return 'Queued: it starts when the curation ahead of it finishes.';
  if (status?.in_progress) return 'Building the wiki. This usually takes a few minutes.';
  return 'Queued. The first build usually takes a few minutes.';
}

/** The create panel. Build it now swaps it for the whole-wiki rebuild panel, the same forced build
 *  the inspector offers: a free check, then a paid start on confirm, and a paused wiki stays paused. */
export function WikiCreate(props: WikiCreateProps) {
  const [building, setBuilding] = useState(false);
  if (building && props.rebuild)
    return <WikiRebuild api={props.rebuild} project={props.project} onClose={props.onClose} onShowLatest={props.onOpenWiki ?? props.onClose} />;
  return <CreatePanel {...props} onBuildNow={props.rebuild ? () => setBuilding(true) : undefined} />;
}

function CreatePanel(props: WikiCreateProps & { onBuildNow: (() => void) | undefined }) {
  const state = useWikiCreate(props);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const { phase, status, homeMissing, renamedFrom, ended, blocked, error } = state;
  const built = phase === 'finished' && ended?.kind === 'run' && ended.run?.outcome === 'written';
  return <section className="vp-home-refresh" aria-label="Create project wiki">
    <h3 ref={heading} tabIndex={-1}>Create a wiki for this project</h3>
    <p><strong>{props.project}</strong></p>
    <p>Curator builds a wiki from the notes linked to this project. Your notes aren't changed.</p>
    {phase === 'checking' && <p role="status">Checking…</p>}
    {error && <p role="alert">{error}</p>}
    {phase === 'blocked' && blocked && <p role="alert">{blocked}</p>}
    {phase === 'exists' && <div role="status">
      <p>This project already has a wiki. To rebuild it now, {FROM_HOME}.</p>
      {props.onOpenWiki && <div className="vp-actions"><button onClick={props.onOpenWiki}>Open the wiki</button></div>}
    </div>}
    {phase === 'ready' && status && renamedFrom !== null && <div>
      <p>This check was free. This project was renamed, and its wiki is still registered under its old name, "{renamedFrom}".
        Moving it to this name is free and keeps its pause setting and corrections. If the wiki was never built, its first build
        then runs, which is paid and counts against today's Curator budget.</p>
      <button onClick={() => void state.confirm()}>Move the wiki to this name</button>
    </div>}
    {phase === 'ready' && status && renamedFrom === null && <div>
      <p>This check was free. Creating the wiki registers it with Curator{homeMissing ? ' and writes an empty home page' : ''}, at no cost.
        Then its first build runs, which is paid: one planning call ({status.models.planning}), one call per page it writes ({status.models.page}) and one home call ({status.models.home}).</p>
      <p>The first build counts against today's Curator budget.{budgetLine(status) ? ` ${budgetLine(status)}` : ''}</p>
      {budgetSpent(status) && <p>Today's budget is spent, so the first build wouldn't run now: the wiki is registered with an empty home, and you can build it on request once there's budget.</p>}
      {status.paused && <p>A pause set on this wiki earlier still holds, so creating it won't run its first build. You can then build it on request, and it stays paused.</p>}
      <button onClick={() => void state.confirm()}>Create project wiki (paid)</button>
    </div>}
    {phase === 'starting' && <p role="status">Creating…</p>}
    {phase === 'running' && <p role="status">{progress(status, props.project)}</p>}
    {(phase === 'unconfirmed' || (phase === 'running' && error)) && <button onClick={() => void state.retryStatus()}>Check status now</button>}
    {phase === 'finished' && <div role="status">
      <p>{outcome(ended, props.project, !!props.onBuildNow)}</p>
      {built && props.onOpenWiki && <div className="vp-actions"><button onClick={props.onOpenWiki}>Open the wiki</button></div>}
      {pausedFirstBuild(ended) && props.onBuildNow && <div className="vp-actions"><button onClick={props.onBuildNow}>Build it now…</button></div>}
    </div>}
    <p>Closing this doesn't stop a build that has already started.</p>
    <button onClick={props.onClose}>Close</button>
  </section>;
}
