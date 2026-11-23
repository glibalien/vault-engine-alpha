import { describe, it, expect } from 'vitest';
import type { Envelope } from '@vault/contract';
import { wrapEngineTools } from '@vault/chat-core';
import { makeBenchExecutor } from './execute.js';
import type { BenchEngineClient } from './engine-client.js';

/** Records every call and answers from a canned table, keyed by tool name.
 *  Throws on an unexpected name so a stray non-suppressed call is loud, not
 *  a silent undefined. */
function makeStubClient(responses: Record<string, Envelope<unknown>>): {
  client: BenchEngineClient;
  calls: Array<{ name: string; args: unknown }>;
} {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client: BenchEngineClient = {
    async callToolEnvelope(name, args) {
      calls.push({ name, args });
      const envelope = responses[name];
      if (!envelope) throw new Error(`stub: no canned response for "${name}"`);
      return envelope;
    },
    async listTools() {
      return [];
    },
    async modelCatalog() {
      return [];
    },
    async close() {},
  };
  return { client, calls };
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content?.[0]?.text;
  return text === undefined ? undefined : JSON.parse(text);
}

describe('makeBenchExecutor', () => {
  it('executes read tools live and flows PASS/WEAK/FAIL verdicts through to the model', async () => {
    const { client, calls } = makeStubClient({
      'query-nodes': { ok: true, data: { nodes: [] }, warnings: [] }, // empty collection → WEAK
      'get-node': { ok: true, data: { id: '1' }, warnings: [] }, // PASS
      'vault-doctor': { ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' }, warnings: [] }, // FAIL
    });
    const executor = makeBenchExecutor(client);

    const r1 = await executor.engineCall('query-nodes', { types: ['task'] });
    const r2 = await executor.engineCall('get-node', { node_id: '1' });
    const r3 = await executor.engineCall('vault-doctor', {});

    expect(calls).toEqual([
      { name: 'query-nodes', args: { types: ['task'] } },
      { name: 'get-node', args: { node_id: '1' } },
      { name: 'vault-doctor', args: {} },
    ]);
    expect(textOf(r1)).toEqual({ ok: true, data: { nodes: [] }, warnings: [] });
    expect(textOf(r2)).toEqual({ ok: true, data: { id: '1' }, warnings: [] });
    expect(textOf(r3)).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' }, warnings: [] });

    expect(executor.outcomes()).toEqual([
      { kind: 'read', verdict: 'WEAK', envelope: { ok: true, data: { nodes: [] }, warnings: [] } },
      { kind: 'read', verdict: 'PASS', envelope: { ok: true, data: { id: '1' }, warnings: [] } },
      {
        kind: 'read',
        verdict: 'FAIL',
        envelope: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' }, warnings: [] },
      },
    ]);
  });

  it('a dry-runnable write always gets dry_run:true injected, even if the model passed dry_run:false', async () => {
    const { client, calls } = makeStubClient({
      'update-node': { ok: true, data: {}, warnings: [] },
    });
    const executor = makeBenchExecutor(client);

    const result = await executor.engineCall('update-node', { node_id: '1', fields: { status: 'done' }, dry_run: false });

    expect(calls).toEqual([
      { name: 'update-node', args: { node_id: '1', fields: { status: 'done' }, dry_run: true } },
    ]);
    expect(textOf(result)).toEqual({ ok: true, data: {}, warnings: [] });
    expect(executor.outcomes()).toEqual([
      { kind: 'write-validated', verdict: 'VALID', envelope: { ok: true, data: {}, warnings: [] } },
    ]);
  });

  it('a dry-run validation failure (ok:true + error-severity warning) scores INVALID via dryRunVerdict', async () => {
    const invalidEnvelope: Envelope<unknown> = {
      ok: true,
      data: {},
      warnings: [{ code: 'VALIDATION_FAILED', message: 'bad enum', severity: 'error' }],
    };
    const { client } = makeStubClient({ 'update-node': invalidEnvelope });
    const executor = makeBenchExecutor(client);

    await executor.engineCall('update-node', { node_id: '1' });

    expect(executor.outcomes()).toEqual([{ kind: 'write-validated', verdict: 'INVALID', envelope: invalidEnvelope }]);
  });

  it('an unvalidatable write is never sent to the client and truncates the turn', async () => {
    const { client, calls } = makeStubClient({});
    const executor = makeBenchExecutor(client);

    const result = await executor.engineCall('rename-global-field', { old_name: 'status', new_name: 'state' });

    expect(calls).toEqual([]); // the stub was never called
    expect(textOf(result)).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'bench: write tool has no dry-run path; turn truncated' },
      warnings: [],
    });
    expect(executor.outcomes()).toEqual([{ kind: 'write-unvalidatable' }]);
  });

  it('suppresses every call after the first write in a turn — the stub is never called again', async () => {
    const { client, calls } = makeStubClient({
      'update-node': { ok: true, data: {}, warnings: [] },
    });
    const executor = makeBenchExecutor(client);

    await executor.engineCall('update-node', { node_id: '1' });
    const afterWrite1 = await executor.engineCall('query-nodes', { types: ['task'] });
    const afterWrite2 = await executor.engineCall('delete-node', { node_id: '2' });

    // Only the first (validated) write ever reached the stub client.
    expect(calls).toEqual([{ name: 'update-node', args: { node_id: '1', dry_run: true } }]);

    const suppressedEnvelope: Envelope<unknown> = {
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'bench: turn truncated at first write' },
      warnings: [],
    };
    expect(textOf(afterWrite1)).toEqual(suppressedEnvelope);
    expect(textOf(afterWrite2)).toEqual(suppressedEnvelope);

    expect(executor.outcomes()).toEqual([
      { kind: 'write-validated', verdict: 'VALID', envelope: { ok: true, data: {}, warnings: [] } },
      { kind: 'suppressed' },
      { kind: 'suppressed' },
    ]);
  });

  it('an unvalidatable write also sets the latch — a later call in the same turn is suppressed, not executed', async () => {
    const { client, calls } = makeStubClient({
      'get-node': { ok: true, data: { id: '1' }, warnings: [] },
    });
    const executor = makeBenchExecutor(client);

    await executor.engineCall('rename-global-field', { old_name: 'status', new_name: 'state' });
    const after = await executor.engineCall('get-node', { node_id: '1' });

    expect(calls).toEqual([]); // read after an unvalidatable write never reaches the client either
    expect(executor.outcomes()).toEqual([{ kind: 'write-unvalidatable' }, { kind: 'suppressed' }]);
    expect((await textOf(after)) as Envelope<unknown>).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'bench: turn truncated at first write' },
      warnings: [],
    });
  });

  it('reset() clears both the latch and recorded outcomes so one executor serves many turns', async () => {
    const { client, calls } = makeStubClient({
      'update-node': { ok: true, data: {}, warnings: [] },
      'get-node': { ok: true, data: { id: '1' }, warnings: [] },
    });
    const executor = makeBenchExecutor(client);

    await executor.engineCall('update-node', { node_id: '1' });
    expect(executor.outcomes()).toHaveLength(1);

    executor.reset();
    expect(executor.outcomes()).toEqual([]);

    calls.length = 0;
    const result = await executor.engineCall('get-node', { node_id: '1' });

    // The latch was cleared by reset(): this read executes live, not suppressed.
    expect(calls).toEqual([{ name: 'get-node', args: { node_id: '1' } }]);
    expect(textOf(result)).toEqual({ ok: true, data: { id: '1' }, warnings: [] });
    expect(executor.outcomes()).toEqual([
      { kind: 'read', verdict: 'PASS', envelope: { ok: true, data: { id: '1' }, warnings: [] } },
    ]);
  });

  it('composes with chat-core\'s wrapEngineTools seam end to end', async () => {
    const { client, calls } = makeStubClient({
      'get-node': { ok: true, data: { id: '1' }, warnings: [] },
    });
    const executor = makeBenchExecutor(client);
    const set = wrapEngineTools(
      [{ name: 'get-node', description: 'get a node', inputSchema: { type: 'object' } }],
      executor.engineCall,
    );
    const tool = set['get-node'] as unknown as {
      execute: (input: unknown, opts: unknown) => Promise<{ ok: boolean; data: unknown; _ms: number }>;
    };

    const out = await tool.execute({ node_id: '1' }, {});

    expect(out.ok).toBe(true);
    expect(out.data).toEqual({ id: '1' });
    expect(typeof out._ms).toBe('number');
    expect(calls).toEqual([{ name: 'get-node', args: { node_id: '1' } }]);
  });
});

// --- Fix round 1: concurrency + reset-mid-flight races ---------------------
//
// Every test above calls engineCall one at a time with `await`, so the whole
// suite was blind to concurrent dispatch. But wrapEngineTools feeds
// engineCall to the ai SDK, and the SDK dispatches a step's tool calls via
// Promise.all — genuinely concurrent. A model step containing a write plus
// another call (e.g. `update-node` + `query-nodes` together) is an ordinary
// agentic pattern, not a contrived edge case. These tests drive
// makeBenchExecutor the same way: multiple engineCall invocations in flight
// at once, with an artificial delay before the stub resolves so the async
// gap is wide enough to actually exercise interleaving (as opposed to a
// same-tick resolution that would pass even under the old racy code by
// accident of timing).

/** Like the delay-free stub above, but the client's response takes `delayMs`
 *  to resolve (or reject, for names in `rejects`) — wide enough that two
 *  concurrently-dispatched engineCall invocations are both mid-flight at
 *  once, so a latch race would actually manifest if one were present. */
function makeDelayedStubClient(opts: { delayMs?: number; rejects?: ReadonlySet<string> } = {}): {
  client: BenchEngineClient;
  calls: Array<{ name: string; args: unknown }>;
} {
  const { delayMs = 10, rejects = new Set<string>() } = opts;
  const calls: Array<{ name: string; args: unknown }> = [];
  const client: BenchEngineClient = {
    async callToolEnvelope(name, args) {
      calls.push({ name, args });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (rejects.has(name)) throw new Error(`simulated transport failure for ${name}`);
      return { ok: true, data: {}, warnings: [] };
    },
    async listTools() {
      return [];
    },
    async modelCatalog() {
      return [];
    },
    async close() {},
  };
  return { client, calls };
}

describe('makeBenchExecutor — concurrent dispatch and reset-mid-flight (fix round 1)', () => {
  it('a dry-runnable write raced with a read (Promise.all): exactly one write-validated, the read is suppressed and never reaches the client', async () => {
    const { client, calls } = makeDelayedStubClient();
    const executor = makeBenchExecutor(client);

    // Mirrors the write-then-read call order the ai SDK would dispatch for a
    // model step containing both — Promise.all evaluates array elements
    // (and so starts each async call's synchronous prefix) left to right.
    await Promise.all([
      executor.engineCall('update-node', { node_id: '1' }),
      executor.engineCall('query-nodes', { types: ['task'] }),
    ]);

    // The read must never have reached the client — only the write's own
    // dry-run dispatch did.
    expect(calls).toEqual([{ name: 'update-node', args: { node_id: '1', dry_run: true } }]);
    // Order-insensitive by design: the suppressed outcome is pushed
    // synchronously (no await on that path), while write-validated is only
    // pushed after the write's own client round-trip resolves — so under
    // real concurrent dispatch, 'suppressed' is recorded BEFORE
    // 'write-validated' even though the write was issued first. "Emission
    // order" means push order, not call-invocation order; only the counts
    // and kinds are asserted here, not array position.
    const outcomes = executor.outcomes();
    expect(outcomes).toHaveLength(2);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { kind: 'write-validated', verdict: 'VALID', envelope: { ok: true, data: {}, warnings: [] } },
        { kind: 'suppressed' },
      ]),
    );
  });

  it('two dry-runnable writes raced (Promise.all): exactly one write-validated, the other suppressed, exactly one client call', async () => {
    const { client, calls } = makeDelayedStubClient();
    const executor = makeBenchExecutor(client);

    await Promise.all([
      executor.engineCall('update-node', { node_id: '1' }),
      executor.engineCall('delete-node', { node_id: '2' }),
    ]);

    expect(calls).toEqual([{ name: 'update-node', args: { node_id: '1', dry_run: true } }]);
    const outcomes = executor.outcomes();
    expect(outcomes).toHaveLength(2);
    expect(outcomes.filter((o) => o.kind === 'write-validated')).toEqual([
      { kind: 'write-validated', verdict: 'VALID', envelope: { ok: true, data: {}, warnings: [] } },
    ]);
    expect(outcomes.filter((o) => o.kind === 'suppressed')).toEqual([{ kind: 'suppressed' }]);
  });

  it('a write whose client call rejects still latches the turn (latch is set before dispatch) — a later call is suppressed and never reaches the client', async () => {
    const { client, calls } = makeDelayedStubClient({ rejects: new Set(['update-node']) });
    const executor = makeBenchExecutor(client);

    await expect(executor.engineCall('update-node', { node_id: '1' })).rejects.toThrow(
      'simulated transport failure for update-node',
    );

    const second = await executor.engineCall('get-node', { node_id: '1' });

    // get-node must never reach the client — the latch was already set
    // (synchronously, before the write's own dispatch) by the time it threw.
    expect(calls).toEqual([{ name: 'update-node', args: { node_id: '1', dry_run: true } }]);
    expect(textOf(second)).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'bench: turn truncated at first write' },
      warnings: [],
    });
    // The rejected write itself recorded no outcome (its own continuation
    // never ran); the only recorded outcome is the suppressed follow-up.
    expect(executor.outcomes()).toEqual([{ kind: 'suppressed' }]);
  });

  it('reset() during an in-flight write: the stale completion contributes nothing to the new turn and does not latch it', async () => {
    const { client } = makeDelayedStubClient({ delayMs: 30 });
    const executor = makeBenchExecutor(client);

    const pending = executor.engineCall('update-node', { node_id: '1' }); // in flight, not yet awaited

    await new Promise((resolve) => setTimeout(resolve, 5));
    executor.reset();
    expect(executor.outcomes()).toEqual([]);

    // The new turn begins. This read resolves (also after `delayMs`) AFTER
    // the stale write settles, so by the time we observe outcomes here the
    // stale write's continuation has already run and (correctly) discarded
    // itself.
    const nextTurnRead = await executor.engineCall('get-node', { node_id: '1' });
    expect(textOf(nextTurnRead)).toEqual({ ok: true, data: {}, warnings: [] });
    expect(executor.outcomes()).toEqual([
      { kind: 'read', verdict: 'PASS', envelope: { ok: true, data: {}, warnings: [] } },
    ]);

    await pending; // let the stale write fully settle (it already has by now)
    expect(executor.outcomes()).toEqual([
      { kind: 'read', verdict: 'PASS', envelope: { ok: true, data: {}, warnings: [] } },
    ]); // unchanged — the stale write added nothing

    // And critically: the stale write did not leave the new turn latched.
    const followUp = await executor.engineCall('vault-doctor', {});
    expect(textOf(followUp)).toEqual({ ok: true, data: {}, warnings: [] }); // not suppressed
  });
});
