import { useEffect, useRef, useState } from 'react';
import { HomeRefreshError, HomeRefreshNotSentError, isHomeRefreshTerminal, type HomeRefreshApi, type HomeRefreshPreview, type HomeRefreshRequest, type HomeRefreshStatus } from '@vault/query-core';
export type HomeRefreshResume = { request_id: string; vault_namespace: string };
export type HomeRefreshProps = {
  api: HomeRefreshApi; outputRevisionId?: string; expectedNamespace: string; resume?: HomeRefreshResume;
  /** Clearing must compare expectedRequestId so an old panel cannot erase a newer request. */
  onPersist: (resume: HomeRefreshResume | null, expectedRequestId?: string) => Promise<void>;
  onClose: () => void; onInspect: (outputId: string, nodeId: string) => void;
};
export function useHomeRefresh(props: HomeRefreshProps) {
  const [preview, setPreview] = useState<HomeRefreshPreview | null>(null);
  const [status, setStatus] = useState<HomeRefreshStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0), inFlight = useRef(false);
  const request = useRef<{ value: HomeRefreshRequest; attempted: boolean } | null>(null);
  const resumeId = props.resume?.request_id;
  const readStatus = async (id: string) => {
    if (inFlight.current) return;
    const turn = epoch.current; inFlight.current = true; setBusy(true); setError(null);
    try {
      if (props.resume && props.resume.vault_namespace !== props.expectedNamespace) throw Error('identity');
      const result = await props.api.status(id);
      if (turn === epoch.current) setStatus(result);
    } catch {
      if (turn === epoch.current) setError('Cannot read refresh status. Restore the original connection, then retry status.');
    } finally { if (turn === epoch.current) { inFlight.current = false; setBusy(false); } }
  };
  useEffect(() => {
    epoch.current++; inFlight.current = false; request.current = null;
    setPreview(null); setStatus(null); setError(null);
    if (resumeId) void readStatus(resumeId);
    else if (props.outputRevisionId) {
      const turn = epoch.current; inFlight.current = true; setBusy(true);
      void props.api.preview(props.outputRevisionId).then(p => {
        if (turn !== epoch.current) return;
        if (p.guard && p.guard.vault_namespace !== props.expectedNamespace) {
          setError('Engine and Curator refer to different vaults. Check connection settings.'); return;
        }
        setPreview(p);
      }).catch(() => { if (turn === epoch.current) setError('Cannot preview. Check Curator connection, token scopes, and version.'); })
        .finally(() => { if (turn === epoch.current) { inFlight.current = false; setBusy(false); } });
    }
    return () => { epoch.current++; inFlight.current = false; };
  }, [props.api, props.outputRevisionId, props.expectedNamespace, resumeId]);
  useEffect(() => {
    if (!status || isHomeRefreshTerminal(status.phase) || error) return;
    const timer = setTimeout(() => void readStatus(status.request_id), 2000);
    return () => clearTimeout(timer);
  }, [status, error]);
  const confirm = async () => {
    if (inFlight.current || status || (!request.current && (!preview?.eligible || !preview.guard))) return;
    const turn = epoch.current; inFlight.current = true; setBusy(true); setError(null);
    request.current ??= { value: { request_id: crypto.randomUUID(), guard: preview!.guard!, confirm_paid: true }, attempted: false };
    const submission = request.current, submitted = submission.value;
    const previouslyAttempted = submission.attempted;
    try {
      await props.onPersist({ request_id: submitted.request_id, vault_namespace: submitted.guard.vault_namespace });
      if (turn !== epoch.current) {
        if (!submission.attempted) await props.onPersist(null, submitted.request_id);
        return;
      }
      submission.attempted = true;
      const result = await props.api.execute(submitted);
      // Target collision can return another active request. Keep that identity for reopen.
      if (turn === epoch.current && result.request_id !== submitted.request_id)
        await props.onPersist({ request_id: result.request_id, vault_namespace: submitted.guard.vault_namespace });
      if (turn === epoch.current) setStatus(result);
    } catch (cause) {
      // A host can still abort during async preflight inside execute. This proves
      // only the current attempt was unsent; never forget an earlier lost reply.
      if (cause instanceof HomeRefreshNotSentError) submission.attempted = previouslyAttempted;
      if (!submission.attempted) {
        // Persistence can fail after saving the identity. Nothing was sent, even
        // if this panel is already gone; clean up only this request's bookmark.
        try { await props.onPersist(null, submitted.request_id); } catch { /* Host persistence remains unavailable. */ }
        if (turn === epoch.current) {
          request.current = null;
          if (cause instanceof HomeRefreshNotSentError) {
            setPreview(null);
            setError('The request was not submitted. Check your connection, then close this dialog and preview again.');
          } else setError('The request was not submitted because its saved status could not be stored. Try confirming again.');
        }
        return;
      }
      if (!previouslyAttempted && cause instanceof HomeRefreshError
        && ['FORBIDDEN', 'READINESS_UNAVAILABLE', 'SHUTTING_DOWN'].includes(cause.code)) {
        // These precise rejections precede admission. Even a closed panel can
        // forget this UUID, but a rejected retry cannot disprove an earlier lost reply.
        let cleared = true;
        try { await props.onPersist(null, submitted.request_id); } catch { cleared = false; }
        if (turn === epoch.current) {
          request.current = null; setPreview(null);
          setError(cleared
            ? 'This request was rejected. Close this dialog and preview again before confirming.'
            : 'This request was rejected, but its saved status could not be cleared. Close this dialog and preview again.');
        }
        return;
      }
      if (turn !== epoch.current) return;
      if (cause instanceof HomeRefreshError && ['GUARD_CONFLICT', 'INVALID_ARGUMENT', 'REQUEST_CONFLICT'].includes(cause.code)) {
        request.current = null; setPreview(null);
        setError('This request was rejected. Close this dialog and preview again before confirming.');
        try { await props.onPersist(null, submitted.request_id); } catch {
          if (turn === epoch.current) setError('This request was rejected, but its saved status could not be cleared. Close this dialog and preview again.');
        }
      } else setError('Submission was not confirmed. Retry the same request; do not start another paid request.');
    } finally { if (turn === epoch.current) { inFlight.current = false; setBusy(false); } }
  };
  return { preview, status, error, busy, submitted: request.current !== null, confirm,
    retryStatus: () => { const id = status?.request_id ?? resumeId ?? request.current?.value.request_id; if (id) void readStatus(id); } };
}
