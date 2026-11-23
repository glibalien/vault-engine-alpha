import { useEffect, useRef } from 'react';
import { useHomeRefresh, type HomeRefreshProps } from './use-home-refresh.js';
import { Icon } from './icon.js';

/** Rebuild one page or a project wiki's home: a free check, then a paid confirm. The host shows it in a
 *  dialog (#545); closing it doesn't stop a rebuild that has already started. */
export function HomeRefresh(props: HomeRefreshProps) {
  const state = useHomeRefresh(props);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const { preview, status } = state;
  const isPage = preview?.target_kind === 'page';
  const title = preview ? (isPage ? preview.page_title : preview.home_title) : null;
  const ready = !status && preview?.eligible && preview.model;
  return <section className="vp-dialog" aria-label={isPage || !preview ? 'Rebuild this page' : 'Rebuild the wiki home'}>
    <h2 ref={heading} tabIndex={-1}>{title ? `Rebuild “${title}”?` : 'Rebuild this page'}</h2>
    {!status && <p className="vp-lede">
      Curator rewrites its own sections of this page from your notes as they are now.
    </p>}
    {state.busy && !status && <p role="status" className="vp-hint">Checking…</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {!status && preview && <>
      {(isPage ? preview.page_path : preview.home_path) && <p className="vp-hint">{isPage ? preview.page_path : preview.home_path}</p>}
      {preview.reasons.map(reason => <p key={reason.code}>{reason.message}</p>)}
      {ready && preview.model && <>
        <div className="vp-dialog-boxes">
          <div className="vp-dialog-box">
            <h3>Rewrites</h3>
            <ul>
              {preview.sections.map(section => <li key={section}>{section}</li>)}
              <li>{isPage ? 'Maybe one new Log entry' : 'One new Log entry'}</li>
            </ul>
          </div>
          <div className="vp-dialog-box">
            <h3>Leaves alone</h3>
            <ul>
              <li>Your own text on this page</li>
              <li>The wiki’s other pages</li>
              <li>Pending page requests</li>
              <li>Your memories</li>
            </ul>
          </div>
        </div>
        {isPage && <p className="vp-hint">
          It works from this page’s current text, the notes its last build read and notes related to it now.
          The home isn’t rewritten, so what it says about this page may lag until the home is next rebuilt.
        </p>}
        <div className="vp-cost">
          <dl>
            <dt>Cost</dt><dd>1 paid model call</dd>
            <dt>Model</dt><dd><code>{preview.model.ref}</code> via {preview.model.provider}</dd>
            <dt>Output</dt><dd>up to {preview.model.max_output_tokens} tokens</dd>
          </dl>
        </div>
        <p className="vp-free"><Icon name="b-circle-check" />This check was free. Nothing has been spent yet.</p>
      </>}
    </>}
    {status && <div role="status">
      <p>{status.message}</p>
      <p className="vp-hint">{status.usage ? `Used ${status.usage.input} input and ${status.usage.output} output tokens.` : 'Token usage unavailable'}</p>
      {status.output && <div className="vp-actions">
        <button className="mod-cta" onClick={() => props.onInspect(status.output!.output_revision_id, status.output!.output_node_id)}>Show the new build</button>
        <button onClick={() => props.onInspect(status.replaces_output_revision_id, status.output!.output_node_id)}>Show the previous build</button>
      </div>}
      <details><summary>Request details</summary><p>Request ID: {status.request_id}</p><p>State: {status.phase}</p></details>
    </div>}
    {(state.submitted || props.resume) && !status && <p className="vp-hint">It runs in Curator, so you can close this.</p>}
    <div className="vp-dialog-buttons">
      {(status || props.resume || state.submitted) && <button disabled={state.busy} onClick={state.retryStatus}>Check status now</button>}
      {state.error && state.submitted && !status && <button disabled={state.busy} onClick={() => void state.confirm()}>Retry same request</button>}
      <button onClick={props.onClose}>{ready && !state.submitted ? 'Cancel' : 'Close'}</button>
      {ready && !state.submitted && <button className="mod-cta" disabled={state.busy} onClick={() => void state.confirm()}>
        <Icon name="b-coins" />Rebuild page
      </button>}
    </div>
  </section>;
}
