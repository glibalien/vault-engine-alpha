// Thin typed MCP client over a sandboxed engine subprocess. Envelope parsing
// deliberately mirrors packages/curator/src/engine.ts's `Engine.invoke`
// (line ~116): the engine reports tool-level failures as HTTP-200-shaped MCP
// results with `ok:false` INSIDE the first text content item, never via
// transport/JSON-RPC error status — so this client always parses the text
// content and never branches on `result.isError`.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Envelope } from '@vault/contract';
import type { ModelCatalogEntry } from '@vault/settings-registry';
import { assertEngineDistBuilt } from './sandbox.js';

/** How much of the child's stderr to keep (tail) for diagnosing a boot
 *  timeout/failure. Bounded so a chatty child can't blow up memory. */
const STDERR_TAIL_MAX_CHARS = 8000;

export interface BenchEngineClient {
  callToolEnvelope(name: string, args: unknown): Promise<Envelope<unknown>>;
  listTools(): Promise<{ name: string; description: string; inputSchema: unknown }[]>;
  modelCatalog(): Promise<ModelCatalogEntry[]>; // get-settings → the read-only 'models' pseudo-domain
  close(): Promise<void>;
}

/**
 * The minimal shape a caller needs to kill an in-flight (possibly
 * not-yet-connected) engine child. `StdioClientTransport.close()` tears the
 * whole child process down — ends stdin, waits up to ~2s for a clean exit,
 * escalates to SIGTERM then (after another ~2s) SIGKILL if it doesn't — so
 * this one call is both "kill" and "wait for it to actually exit" in the
 * ordering a caller needs before it's safe to delete the sandbox the child
 * is running against. Exported as a narrow structural type so a caller
 * (cli.ts) doesn't need to import the MCP SDK's transport class just to
 * hold a reference to it.
 */
export interface KillableTransport {
  close(): Promise<void>;
}

/** Wire shape of get-settings' read-only "models" pseudo-domain payload.
 *  Mirrors packages/curator/src/engine.ts's `ModelsDomainPayload` — do NOT
 *  reuse curator's `loadRuntimeConfig`, which has seeding side effects
 *  (`seedIfNeeded` + `registerPromptDefaults` submit writes). */
interface ModelsDomainPayload {
  catalog: ModelCatalogEntry[];
  providers: Record<string, boolean>;
  version: number;
  issues: unknown[];
}

function textContentOf(result: { content?: Array<{ type: string; text?: string }> }): string | undefined {
  return result.content?.find((c) => c.type === 'text')?.text;
}

/**
 * Pure envelope-parsing core of `callToolEnvelope`, split out so its edge
 * cases (no text content at all, a non-text first content item, malformed
 * JSON) are directly unit-testable without spawning a real MCP client/child
 * process. Never throws — every input, however malformed, synthesizes a
 * distinct `ok:false` `INTERNAL_ERROR` envelope rather than resembling
 * success. This is the most safety-sensitive parsing path in the module:
 * mirrors packages/curator/src/engine.ts's `Engine.invoke` in never trusting
 * transport-level status, only the parsed text content.
 */
export function parseEngineToolResult(
  name: string,
  result: { content?: Array<{ type: string; text?: string }> },
): Envelope<unknown> {
  const text = textContentOf(result);
  if (text === undefined) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: `tool ${name} returned no text content` }, warnings: [] };
  }
  try {
    return JSON.parse(text) as Envelope<unknown>;
  } catch {
    return {
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: `tool ${name} returned non-JSON text: ${text.slice(0, 200)}` },
      warnings: [],
    };
  }
}

class McpBenchEngineClient implements BenchEngineClient {
  constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
  ) {}

  async callToolEnvelope(name: string, args: unknown): Promise<Envelope<unknown>> {
    const result = await this.client.callTool({ name, arguments: args as Record<string, unknown> | undefined });
    return parseEngineToolResult(name, result as { content?: Array<{ type: string; text?: string }> });
  }

  async listTools(): Promise<{ name: string; description: string; inputSchema: unknown }[]> {
    const res = await this.client.listTools();
    return res.tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema }));
  }

  async modelCatalog(): Promise<ModelCatalogEntry[]> {
    const envelope = await this.callToolEnvelope('get-settings', { domain: 'models' });
    if (!envelope.ok) {
      throw new Error(`get-settings {domain:'models'} failed: ${envelope.error.code}: ${envelope.error.message}`);
    }
    const domains = (envelope.data as { domains?: Record<string, unknown> } | null)?.domains;
    const models = domains?.['models'] as ModelsDomainPayload | undefined;
    if (!models) {
      throw new Error("get-settings {domain:'models'} response missing the 'models' domain payload");
    }
    return models.catalog;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

/**
 * Connects to a sandboxed engine subprocess spawned per `spec` (from
 * `engineSpawnSpec`). `StdioClientTransport` spawns and owns the child —
 * this function never calls `spawn` itself. Connect resolving means the
 * engine finished booting (migrations + a full index over the vault, which
 * for a large vault is slow — this promise can stay pending for a long
 * time before it settles).
 *
 * `opts.onTransport`, if given, fires SYNCHRONOUSLY the instant the
 * transport is constructed — before `client.connect(transport)` is even
 * called, let alone awaited. This exists so a caller can always reach a
 * killable handle to the child, independent of whether (or when) this
 * function's own promise ever resolves: a caller that only awaits this
 * function's return value has no way to kill the child if it's interrupted
 * (SIGINT/SIGTERM) while still mid-boot, because the `BenchEngineClient` —
 * and the `close()` it exposes — doesn't exist yet at that point. Handing
 * the raw transport out via callback closes that gap; see cli.ts's
 * `installSandboxSignalHandlers` for the caller side of this.
 *
 * `assertEngineDistBuilt` MUST run before the spawn attempt: it was split
 * out of `engineSpawnSpec` (Task 6) purely so that function stays unit
 * testable without a built engine, and nothing in the type system forces
 * the check to happen — skipping it here would surface a missing
 * `packages/engine/dist/index.js` as an opaque spawn failure instead of a
 * clear, actionable error.
 */
export async function connectSandboxEngine(
  spec: { command: string; args: string[]; env: Record<string, string> },
  timeoutMs: number,
  opts?: { onTransport?: (transport: KillableTransport) => void },
): Promise<BenchEngineClient> {
  assertEngineDistBuilt(spec);

  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: spec.env,
    stderr: 'pipe',
  });
  // Fires before the child is even spawned (spawning happens inside
  // transport.start(), called by client.connect() below) — as early as
  // this function can possibly hand out a killable handle.
  opts?.onTransport?.(transport);

  // Attach the stderr tail-capture immediately after construction — per the
  // SDK's docs, `transport.stderr` is available right away (a PassThrough)
  // when `stderr: 'pipe'` is requested, precisely so early boot output isn't
  // lost by attaching listeners only after `connect()`/`start()`.
  let stderrTail = '';
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX_CHARS);
  });

  const client = new Client({ name: 'vault-bench', version: '0.1.0' });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`engine did not boot within ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    await Promise.race([client.connect(transport), timeout]);
  } catch (err) {
    await transport.close().catch(() => {});
    const reason = err instanceof Error ? err.message : String(err);
    const tail = stderrTail.trim();
    throw new Error(
      `connectSandboxEngine: ${reason}${tail ? `\n--- child stderr tail ---\n${tail}` : '\n(no child stderr captured)'}`,
    );
  } finally {
    clearTimeout(timer);
  }

  return new McpBenchEngineClient(client, transport);
}
