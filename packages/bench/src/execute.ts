// The write-interception executor: the safety property that makes the whole
// benchmark safe to run against a sandbox. Reads execute live and get
// scored. The FIRST write in a turn is either dry-run validated (for
// dry-runnable tools) or refused outright (for unvalidatable tools) — either
// way it sets a latch. Every call after the latch is suppressed: never sent
// to the client, never scored as a real outcome. No write this executor
// mediates is ever committed; no post-write read can observe phantom state.
//
// Scope of that claim, stated precisely: it covers writes THIS EXECUTOR
// MEDIATES. It is not a claim that the sandbox is immutable for the duration
// of a sweep, and reading it that way overstates the "no ordering effects
// between turns" argument. Two engine-side write paths run underneath us,
// both sandbox-only and therefore harmless to the real vault, but both real:
//
//   1. `read-embedded` is a READ tool that populates `extraction_cache` on a
//      miss (packages/engine/src/extraction/cache.ts). A later turn reading
//      the same attachment hits a warm cache — same text, different latency.
//   2. The sandboxed engine boots the full production schedule, because the
//      settings that drive it (`normalizeCron`,
//      `normalizeQuiescenceMinutes`, `backupsEnabled`, retention windows)
//      ride along inside the VACUUM'd snapshot of an already-seeded
//      production DB. So the normalizer and the maintenance sweep really do
//      run mid-sweep, and the normalizer re-renders markdown in the sandbox
//      copy.
//
// Neither can escape the sandbox — that is what sandbox.ts's containment
// guard and pinned env are for — and neither changes a turn's SCORED
// outcome. But turns are not perfectly hermetic from each other, and a
// mid-sweep re-render is a real (if remote) source of variance to remember
// when a replayed turn's result looks inexplicably order-dependent.

import type { Envelope } from '@vault/contract';
import { verdict, dryRunVerdict, type Verdict, type DryRunVerdict } from '@vault/contract';
import type { EngineCall, ToolCallResultLike } from '@vault/chat-core';
import { toolKind } from './tools-readwrite.js';
import type { BenchEngineClient } from './engine-client.js';

// `outcomes()` returns calls in EMISSION order — the order each outcome was
// actually pushed, not necessarily the order engineCall was invoked. Under
// concurrent dispatch (Promise.all, as the ai SDK does for a step's tool
// calls) a 'suppressed' outcome is pushed synchronously the instant its call
// starts, while 'read'/'write-validated' are only pushed after their client
// round-trip resolves — so a write issued first can still have its own
// outcome land AFTER a later-issued suppressed call's outcome. The
// determinism the truncation latch guarantees is about WHICH calls reach the
// client and get scored at all (exactly the calls up to and including the
// turn's first write), not the array position of their outcomes.
export type CallOutcome =
  | { kind: 'read'; verdict: Verdict; envelope: Envelope<unknown> }
  | { kind: 'write-validated'; verdict: DryRunVerdict; envelope: Envelope<unknown> }
  | { kind: 'write-unvalidatable' }
  | { kind: 'suppressed' }; // calls after the first write in a turn — never executed

/** Synthetic envelope for an unvalidatable write: refused, never sent to the
 *  client. `INTERNAL_ERROR` is the only honest choice from contract's closed
 *  `ErrorCode` union — the harness (not bad model arguments) stopped the
 *  call, so `INVALID_PARAMS` would wrongly invite a retry. */
const UNVALIDATABLE_ENVELOPE: Envelope<unknown> = {
  ok: false,
  error: { code: 'INTERNAL_ERROR', message: 'bench: write tool has no dry-run path; turn truncated' },
  warnings: [],
};

/** Synthetic envelope for every call after the latch is set. Same
 *  reasoning as {@link UNVALIDATABLE_ENVELOPE} for the error code. */
const SUPPRESSED_ENVELOPE: Envelope<unknown> = {
  ok: false,
  error: { code: 'INTERNAL_ERROR', message: 'bench: turn truncated at first write' },
  warnings: [],
};

function toResult(envelope: Envelope<unknown>): ToolCallResultLike {
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
}

export function makeBenchExecutor(client: BenchEngineClient): {
  engineCall: EngineCall;
  outcomes: () => CallOutcome[];
  reset: () => void;
} {
  let latched = false;
  let outcomes: CallOutcome[] = [];
  // Bumped by reset(). Each call captures the epoch synchronously at entry
  // (before any await) and re-checks it after resuming from its own await,
  // before touching `outcomes` — see fix-round-1 report section for the two
  // races this closes:
  //  1. TOCTOU on `latched`: wrapEngineTools/the ai SDK dispatch a step's
  //     tool calls via Promise.all, so multiple engineCall invocations can
  //     be in flight concurrently. Everything that DECIDES whether a call
  //     is the turn's first write (the `if (latched)` check, `toolKind`,
  //     and — critically — setting `latched = true` for both write kinds)
  //     now happens synchronously, before this call's first await. JS's
  //     run-to-completion semantics mean each concurrently-invoked
  //     engineCall's synchronous prefix runs to completion (or to its own
  //     first await) before the next queued call's synchronous prefix
  //     begins, so by the time a later-ordered call checks `latched`, an
  //     earlier-ordered write has already set it — no interleaving window.
  //     (This also fixes the write-throws case for free: since `latched`
  //     is now set BEFORE the dispatch, a subsequent rejection can't leave
  //     it unset — there is no "revert" path, so no try/finally is needed.)
  //  2. Stale writes/reads outliving reset(): if a runner-side per-turn
  //     timeout calls reset() while a call is still awaiting its client
  //     round-trip, that call's `outcomes.push(...)` would otherwise land
  //     in the NEW turn's (reassigned) `outcomes` array once it resolves.
  //     The epoch check after resuming discards such a stale completion
  //     entirely — no outcome recorded, no latch touched — rather than
  //     misattributing it to a turn it was never part of.
  let epoch = 0;

  const engineCall: EngineCall = async (name, args) => {
    const myEpoch = epoch;

    if (latched) {
      outcomes.push({ kind: 'suppressed' });
      return toResult(SUPPRESSED_ENVELOPE);
    }

    const kind = toolKind(name);

    if (kind === 'read') {
      const envelope = await client.callToolEnvelope(name, args);
      if (myEpoch === epoch) outcomes.push({ kind: 'read', verdict: verdict(name, envelope), envelope });
      return toResult(envelope);
    }

    if (kind === 'write-dry-runnable') {
      // Latch BEFORE dispatch, synchronously — closes the TOCTOU window
      // (see epoch comment above). Always pass dry_run explicitly — never
      // rely on the engine's default, since e.g. update-node's default is
      // mode-dependent (true in query mode, false in single-node mode).
      latched = true;
      const envelope = await client.callToolEnvelope(name, { ...args, dry_run: true });
      if (myEpoch === epoch) outcomes.push({ kind: 'write-validated', verdict: dryRunVerdict(envelope), envelope });
      return toResult(envelope);
    }

    // kind is 'write-unvalidatable' or 'unknown' here. 'unknown' should
    // never reach a live turn in practice — the corpus builder (Task 4)
    // excludes any recorded turn containing an unknown-kind tool call from
    // replay — but if a model ever named a tool this executor can't
    // classify, refusing to run it live (rather than guessing it's safe) is
    // the fail-closed choice consistent with this module's one job. Warn
    // audibly on genuinely 'unknown' names so tools-readwrite.ts's static
    // lists falling behind the engine's real surface is visible, not
    // silently indistinguishable from an ordinary no-dry-run refusal.
    if (kind === 'unknown') {
      console.warn(`[bench] engineCall: unclassified tool "${name}" — refusing to execute live, treating as an unvalidatable write`);
    }
    latched = true;
    outcomes.push({ kind: 'write-unvalidatable' });
    return toResult(UNVALIDATABLE_ENVELOPE);
  };

  return {
    engineCall,
    outcomes: () => [...outcomes],
    reset: () => {
      epoch += 1;
      latched = false;
      outcomes = [];
    },
  };
}
