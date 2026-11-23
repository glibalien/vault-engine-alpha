import { useEffect, useRef } from 'react';
import type { WikiRebuildRun } from '@vault/query-core';
import { useWikiRebuild, type WikiRebuildProps } from './use-wiki-rebuild.js';
import { plainWikiDetail, shortDay, usd } from './wiki-build-text.js';
import { Icon } from './icon.js';

function outcome(run: WikiRebuildRun | null, project: string): string {
  if (!run) return 'It finished with no new run on record. Curator status may say more.';
  switch (run.outcome) {
    case 'written': return run.cost_usd === null ? 'The wiki was rebuilt.' : `The wiki was rebuilt, for an estimated ${usd(run.cost_usd)}.`;
    case 'skipped_budget': return 'Today\'s spend cap was reached, so it wasn\'t rebuilt. Try again tomorrow, or raise the cap.';
    case 'error': return run.error ? `The rebuild failed: ${plainWikiDetail(project, run.error)}` : 'The rebuild failed.';
    default: return `It finished without rebuilding (${run.outcome}).`;
  }
}

/** Rebuild a whole wiki: a free check, then a paid confirm. The host shows it in a dialog (#545);
 *  closing it doesn't stop a rebuild that has already started. */
export function WikiRebuild(props: WikiRebuildProps) {
  const state = useWikiRebuild(props);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const { phase, status, check, run, blocked, error } = state;
  const rebuilt = phase === 'finished' && run?.outcome === 'written';
  /** A topic wiki (#425): rebuilt only whole, and with web research when its source includes the web. */
  const topic = status?.kind === 'topic';
  const web = topic && status?.source === 'vault+web';
  const cap = status?.daily_budget.cap_usd ?? null;
  const left = status?.daily_budget.remaining_usd ?? null;
  const started = phase === 'starting' || phase === 'running' || phase === 'unconfirmed' || phase === 'finished';
  return <section className="vp-dialog" aria-label="Rebuild the whole wiki">
    <h2 ref={heading} tabIndex={-1}>Rebuild the whole {props.project} wiki?</h2>
    {!started && <>
      <p className="vp-lede">
        A full curation. Curator plans the wiki’s pages, rewrites the ones that need it, then rewrites the home.
        It can add, merge or retire pages, and it picks up pending page requests. Your own text stays as it is.
      </p>
      {topic && <p className="vp-hint">This is a topic wiki, so it can only be rebuilt whole: not one page or its home on its own.{web
        ? ' Like its scheduled builds, it also searches the web for the topic and reads the top results.' : ''}</p>}
    </>}
    {phase === 'checking' && <p role="status" className="vp-hint">Checking…</p>}
    {error && <p role="alert">{error}</p>}
    {phase === 'blocked' && blocked && <p role="alert">{blocked}</p>}
    {phase === 'ready' && status && <>
      {status.paused && <div className="vp-callout">
        <p><strong>Scheduled builds are off for this wiki</strong></p>
        <p>This rebuild still runs, and scheduled builds stay off afterwards.</p>
      </div>}
      {check?.evidence_unchanged && <p className="vp-hint">{web
        ? 'None of its notes have changed since the last build. The web search may still turn up something new.'
        : 'Nothing has changed since the last build, so this may not change much.'}</p>}
      <div className="vp-cost">
        <dl>
          <dt>Cost</dt>
          <dd>1 planning call (<code>{status.models.planning}</code>), 1 per page it changes (<code>{status.models.page}</code>) and 1 for the home (<code>{status.models.home}</code>)</dd>
          <dt>Last full build</dt>
          <dd>{status.last_written
            ? status.last_written.cost_usd === null
              ? `${shortDay(status.last_written.ts)}, no cost recorded`
              : `${shortDay(status.last_written.ts)}, est. ${usd(status.last_written.cost_usd)}`
            : 'None on record, so there’s no cost to go by'}</dd>
          {cap !== null && left !== null && <><dt>Today’s Curator budget</dt><dd>{usd(left)} of {usd(cap)} left</dd></>}
        </dl>
      </div>
      <p className="vp-free"><Icon name="b-circle-check" />This check was free. Nothing has been spent yet.</p>
    </>}
    {phase === 'starting' && <p role="status">Starting…</p>}
    {phase === 'running' && <p role="status">Rebuilding. This usually takes a few minutes.</p>}
    {phase === 'finished' && <div role="status">
      <p>{outcome(run, props.project)}</p>
    </div>}
    {started && phase !== 'finished' && <p className="vp-hint">It runs in Curator, so you can close this.</p>}
    <div className="vp-dialog-buttons">
      {(phase === 'unconfirmed' || (phase === 'running' && error)) && <button onClick={() => void state.retryStatus()}>Check status now</button>}
      {rebuilt && <button className="mod-cta" onClick={props.onShowLatest}>Show the new build</button>}
      <button onClick={props.onClose}>{phase === 'ready' || phase === 'checking' ? 'Cancel' : 'Close'}</button>
      {phase === 'ready' && status && <button className="mod-cta" onClick={() => void state.confirm()}>
        <Icon name="b-coins" />Rebuild wiki
      </button>}
    </div>
  </section>;
}
