// The bench CLI: `npm run bench -w @vault/bench -- <corpus|run> [flags]`.
//
// Style copied verbatim from packages/curator/src/eval.ts's main() (~line
// 247): process.argv.slice(2), args[0] as subcommand, inline flag()/
// boolFlag() helpers, and the isMain guard keyed off argv[1] ending in
// '/cli.ts' or '/cli.js' — without that guard this file does nothing at all
// under tsx (it would just define functions and exit).
//
// `run` is the only subcommand that spends money or touches a sandboxed
// engine. `corpus` is a pure, read-only DB inspection — no sandbox, no
// model, no spend.

import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderKeys } from '@vault/chat-core';
import { providerAvailability } from '@vault/chat-core';
import type { ModelProvider } from '@vault/settings-registry';
import { extractTurns, replayable, type CorpusTurn } from './corpus.js';
import { ALL_TURN_CLASSES, stratifiedSample } from './sample.js';
import type { TurnClass } from './classify.js';
import { prepareSandbox, disposeSandbox, engineSpawnSpec, type SandboxPaths } from './sandbox.js';
import { connectSandboxEngine, type BenchEngineClient, type KillableTransport } from './engine-client.js';
import { runReplayTurn, toEngineToolInfos, type TurnResult } from './runner.js';
import { resolveBenchModelRef } from './model-refs.js';
import { buildHistoryEntry, buildReport, type CoverageInput, type ModelResultsInput, type ReportManifest } from './report.js';

// packages/bench/src/cli.ts -> packages/bench (one level up from src/).
const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(BENCH_DIR, '..', '..');

/**
 * Validates a required source path argument. Source vaults and databases can
 * live anywhere, but Bench never guesses: the value must be supplied and must
 * be absolute, so a run can never silently fall back to a developer-local
 * vault. Throws BenchCliError (after printing usage) before any effect.
 */
export function resolveRequiredAbsolutePath(flagName: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    console.error(`[bench] ${flagName} is required and must be an absolute path`);
    throw new BenchCliError();
  }
  if (!isAbsolute(value)) {
    console.error(`[bench] ${flagName} must be an absolute path, got "${value}"`);
    throw new BenchCliError();
  }
  return value;
}

/** Curator's env names, mapped into chat-core's ProviderKeys shape — there
 *  are no chat-side env names (VEfO stores keys in plugin settings), so
 *  bench borrows curator's bootstrap convention. */
const PROVIDER_ENV_VARS: Record<ModelProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  fireworks: 'OPENAI_COMPAT_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
};

function providerKeysFromEnv(): ProviderKeys {
  return {
    anthropic: process.env['ANTHROPIC_API_KEY'],
    fireworks: process.env['OPENAI_COMPAT_API_KEY'],
    openrouter: process.env['OPENROUTER_API_KEY'],
    openai: process.env['OPENAI_API_KEY'],
  };
}

/** Wall-clock cap on the sandboxed engine's boot (embedder weight load
 *  included) — generous because a hung/slow boot here is a harness problem,
 *  not something worth retrying quickly. */
const ENGINE_BOOT_TIMEOUT_MS = 60_000;

/** Thrown for an already-reported, expected CLI failure (usage error,
 *  missing provider key) whose details were printed by the caller. Caught
 *  specially by main() so the process still exits 1 without also dumping a
 *  redundant Error/stack trace on top of the message already shown — but,
 *  critically, IS a thrown exception rather than a direct process.exit()
 *  call at the point of detection, so any enclosing try/finally (sandbox
 *  disposal, engine client close) still runs. A bare process.exit() inside
 *  runBenchmark's try block was exactly the bug this fixes: it terminated
 *  the process before disposeSandbox() ran, leaking the sandbox's VACUUMed
 *  DB copy + markdown copy under os.tmpdir() on every pre-flight failure. */
class BenchCliError extends Error {}

/**
 * Disposes the sandbox unless `opts.keep`, catching (and logging) any
 * disposal failure rather than letting it propagate — a failed disposal
 * must never prevent the process from exiting. Shared by the normal
 * `finally` path in `runBenchmark` and by `installSandboxSignalHandlers`
 * below, so both codepaths clean up identically. Safe to call more than
 * once for the same `paths`: a second call after the sandbox is already
 * gone hits disposeSandbox's assertContained realpath-ENOENT branch, which
 * this function catches and logs exactly like any other disposal failure.
 */
export function disposeSandboxSafely(paths: SandboxPaths, opts: { keep: boolean }): void {
  if (opts.keep) {
    console.log(`[bench] --keep-sandbox: leaving sandbox at ${paths.root}`);
    return;
  }
  try {
    disposeSandbox(paths);
  } catch (err) {
    console.error(
      `[bench] warning: failed to dispose sandbox at ${paths.root}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Kills the sandboxed engine child if one exists — preferring the fully
 * connected `client` when there is one, but falling back to the raw
 * `childTransport` handle when `client` was never assigned. The preference is
 * purely a matter of using the outermost handle we hold: both paths bottom out
 * in the SAME `StdioClientTransport.close()`, and neither performs any
 * protocol-level MCP shutdown — there is no graceful session teardown on the
 * wire, just the child-process kill escalation described below. The fallback,
 * not the preference, is what matters here; it is the fix for the round-2
 * leak: `client` is only assigned once `connectSandboxEngine`'s ENTIRE
 * promise resolves, which requires the engine to finish its own internal
 * boot (migrations + a full index over the vault) — a slow, multi-second-
 * to-minute window during which `client` stays `undefined` even though a
 * child process is already alive and running against the sandbox. A signal
 * arriving in that window previously saw `client === undefined`, treated
 * "no client" as "nothing to kill", and disposed the sandbox out from under
 * a still-running child — which then recreated part of the deleted tree
 * (its own settings notes + a DB backup) the moment it got far enough to
 * write them. `childTransport` is captured (via `connectSandboxEngine`'s
 * `onTransport` callback) synchronously the instant the transport is
 * constructed, well before the child is even spawned, so it is ALWAYS
 * available from the moment a child could possibly exist.
 *
 * Either `close()` call kills-then-waits: `StdioClientTransport.close()`
 * ends stdin, waits ~2s for a clean exit, escalates to SIGTERM then (after
 * another ~2s) SIGKILL — so by the time this function returns, the child is
 * confirmed gone (or force-killed), never merely "signaled and hoped for".
 * Never throws — a failed kill must not block the disposal that follows it.
 */
export async function killEngineChildIfAny(
  client: BenchEngineClient | undefined,
  childTransport: KillableTransport | undefined,
): Promise<void> {
  try {
    if (client !== undefined) {
      await client.close();
    } else if (childTransport !== undefined) {
      await childTransport.close();
    }
  } catch (err) {
    console.error(
      `[bench] warning: failed to close the engine client/transport cleanly: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Installs SIGINT/SIGTERM/SIGHUP handlers that dispose the sandbox and exit
 * non-zero. `run` is a strictly-sequential, multi-minute loop (ambiguity
 * ruling #2), and interrupting one is an entirely normal operator action —
 * but Node does NOT run pending `finally` blocks on an unhandled SIGINT/
 * SIGTERM/SIGHUP, so without this a Ctrl-C mid-sweep leaks the sandbox's
 * VACUUMed DB copy + markdown tree under os.tmpdir(). Same failure class the
 * BenchCliError fix closed for expected-failure exits, reached here through
 * an external interrupt instead.
 *
 * SIGHUP is not optional padding: a multi-minute sweep is exactly the kind of
 * job an operator starts over SSH or in a terminal tab, and closing that
 * terminal (or dropping the connection) delivers SIGHUP, whose Node default is
 * an immediate terminate — same ~250 MB leak, reached through the one
 * interrupt a Ctrl-C-shaped handler set doesn't cover.
 *
 * Ordering matters and is NOT optional: `opts.onCleanup` (which callers
 * should wire to `killEngineChildIfAny`) MUST run, and MUST be awaited,
 * BEFORE `disposeSandboxSafely`. Deleting the sandbox tree while the engine
 * child is still alive is exactly what produced the round-2 leak: an
 * orphaned child kept running against a path that had just been removed
 * out from under it, and recreated part of the tree (settings notes + a DB
 * backup) once it got far enough into boot to write them.
 *
 * Idempotent: `handled` latches on the first signal, so a second Ctrl-C
 * (operators mash it) while cleanup is already in flight is a no-op rather
 * than a second concurrent kill-and-dispose attempt. `opts.onCleanup`'s own
 * failure is caught and logged, never allowed to block the dispose+exit
 * that follows it.
 *
 * Returns a `remove()` that detaches every handler — callers MUST invoke it
 * once the run completes normally, or a non-interrupted process is held
 * open (Node keeps the event loop alive while a 'SIGINT'/'SIGTERM'/'SIGHUP'
 * listener is registered).
 */
export function installSandboxSignalHandlers(
  paths: SandboxPaths,
  opts: { keep: boolean; onCleanup?: () => Promise<void> | void },
): () => void {
  let handled = false;

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (handled) return;
    handled = true;
    console.error(`\n[bench] received ${signal} — disposing sandbox before exit`);
    Promise.resolve()
      .then(() => opts.onCleanup?.())
      .catch((err) => {
        console.error(`[bench] warning: cleanup callback failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        disposeSandboxSafely(paths, { keep: opts.keep });
        process.exit(1);
      });
  };

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  // One listener per signal, each closing over its own name so the log line
  // still says which one arrived. Registered/removed as a set so adding a
  // signal can never leave a half-detached handler holding the event loop open.
  const listeners = signals.map((signal) => {
    const listener = (): void => handleSignal(signal);
    process.on(signal, listener);
    return { signal, listener };
  });

  return () => {
    for (const { signal, listener } of listeners) process.off(signal, listener);
  };
}

function usage(): void {
  console.error('Usage: bench <corpus|run> [options]');
  console.error('  corpus --db <absolute-path>');
  console.error('  run --models <ref,ref,...> --vault <absolute-path> --db <absolute-path>');
  console.error('      [--per-class 40] [--classes a,b] [--seed 1] [--tag <t>] [--keep-sandbox]');
  console.error('  --vault and --db are required and must be absolute; Bench has no default source.');
}

// ---------------------------------------------------------------------------
// corpus
// ---------------------------------------------------------------------------

export function runCorpus(args: string[]): void {
  function flag(name: string): string | undefined {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  }

  const db = resolveRequiredAbsolutePath('--db', flag('--db'));
  console.log(`[bench] extracting corpus from ${db} ...`);
  const turns = extractTurns(db);

  const byClass = new Map<TurnClass, number>(ALL_TURN_CLASSES.map((c) => [c, 0]));
  let partial = 0;
  let unknownTool = 0;
  let replayableCount = 0;
  for (const t of turns) {
    byClass.set(t.turnClass, (byClass.get(t.turnClass) ?? 0) + 1);
    if (t.partial) partial += 1;
    if (t.unknownTools.length > 0) unknownTool += 1;
    if (replayable(t)) replayableCount += 1;
  }

  console.log(`[bench] total turns: ${turns.length}`);
  console.log(`[bench] replayable: ${replayableCount}`);
  console.log('[bench] class totals:');
  for (const c of ALL_TURN_CLASSES) {
    console.log(`[bench]   ${c}: ${byClass.get(c) ?? 0}`);
  }
  console.log(`[bench] excluded — partial: ${partial}, unknown-tool: ${unknownTool} (a turn may hit both)`);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function fetchChatSettings(
  client: BenchEngineClient,
): Promise<{ systemPrompt: string | null; tieringNote: string | null; maxSteps: number | null }> {
  const envelope = await client.callToolEnvelope('get-settings', { domain: 'chat' });
  if (!envelope.ok) {
    throw new Error(`get-settings {domain:'chat'} failed: ${envelope.error.code}: ${envelope.error.message}`);
  }
  const domains = (envelope.data as { domains?: Record<string, unknown> } | null)?.domains;
  const chat = domains?.['chat'] as { effective?: Record<string, unknown> } | undefined;
  const effective = chat?.effective;
  if (!effective) {
    throw new Error("get-settings {domain:'chat'} response missing the 'chat' domain payload");
  }
  const systemPrompt = typeof effective['chatSystemPrompt'] === 'string' ? effective['chatSystemPrompt'] : null;
  const tieringNote = typeof effective['chatTieringNote'] === 'string' ? effective['chatTieringNote'] : null;
  const maxSteps = typeof effective['maxSteps'] === 'number' ? effective['maxSteps'] : null;
  return { systemPrompt, tieringNote, maxSteps };
}

export async function runBenchmark(args: string[]): Promise<void> {
  function flag(name: string): string | undefined {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  }
  function boolFlag(name: string): boolean {
    return args.includes(name);
  }

  const modelsArg = flag('--models');
  if (modelsArg === undefined || modelsArg.trim() === '') {
    usage();
    throw new BenchCliError();
  }
  const modelRefs = modelsArg
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (modelRefs.length === 0) {
    console.error('[bench] --models must name at least one model ref');
    throw new BenchCliError();
  }

  const vault = resolveRequiredAbsolutePath('--vault', flag('--vault'));
  const db = resolveRequiredAbsolutePath('--db', flag('--db'));
  const perClass = Number(flag('--per-class') ?? '40');
  const seed = Number(flag('--seed') ?? '1');
  const tag = flag('--tag') ?? String(Date.now());
  const keepSandbox = boolFlag('--keep-sandbox');

  if (!Number.isInteger(perClass) || perClass <= 0) {
    console.error(`[bench] --per-class must be a positive integer, got "${flag('--per-class')}"`);
    throw new BenchCliError();
  }
  if (!Number.isFinite(seed)) {
    console.error(`[bench] --seed must be a number, got "${flag('--seed')}"`);
    throw new BenchCliError();
  }

  const classesArg = flag('--classes');
  let requestedClasses: TurnClass[];
  if (classesArg !== undefined) {
    const requested = classesArg
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const invalid = requested.filter((c) => !(ALL_TURN_CLASSES as readonly string[]).includes(c));
    if (invalid.length > 0) {
      console.error(`[bench] --classes: unknown class(es) "${invalid.join(', ')}" — valid: ${ALL_TURN_CLASSES.join(', ')}`);
      throw new BenchCliError();
    }
    requestedClasses = ALL_TURN_CLASSES.filter((c) => requested.includes(c));
    if (requestedClasses.length === 0) {
      console.error('[bench] --classes resolved to an empty set — nothing to run');
      throw new BenchCliError();
    }
  } else {
    requestedClasses = [...ALL_TURN_CLASSES];
  }

  const startedAt = new Date().toISOString();

  console.log(`[bench] corpus db: ${db}`);
  const corpus = extractTurns(db);
  const totalTurns = corpus.length;
  const replayableTurns = corpus.filter(replayable).length;
  const partialExcluded = corpus.filter((t) => t.partial).length;
  const unknownToolExcluded = corpus.filter((t) => t.unknownTools.length > 0).length;

  // Always sample over ALL classes, regardless of --classes: this keeps a
  // given seed's per-class draw identical across differently-filtered runs,
  // matching stratifiedSample's own documented determinism guarantee.
  const sample = stratifiedSample(corpus, { perClass, seed });
  const turnsToRun: CorpusTurn[] = sample.turns.filter((t) => requestedClasses.includes(t.turnClass));
  const sampledPerClass = Object.fromEntries(
    ALL_TURN_CLASSES.map((c) => [c, sample.turns.filter((t) => t.turnClass === c).length]),
  ) as Record<TurnClass, number>;
  const externalToolTurns = turnsToRun.filter((t) =>
    t.recordedCalls.some((c) => c.toolName === 'web-search' || c.toolName === 'fetch-url'),
  ).length;

  console.log(
    `[bench] sampled ${turnsToRun.length} turn(s) across ${requestedClasses.length}/${ALL_TURN_CLASSES.length} class(es)`,
  );
  for (const s of sample.shortfalls) {
    console.log(`[bench]   shortfall: ${s.turnClass} wanted ${s.requested}, only ${s.available} available`);
  }

  // Fail fast BEFORE prepareSandbox. --classes validates that every name is a
  // known class, but a valid class the corpus happens to contain none of (a
  // narrow --classes on a small/filtered DB) still lands here with an empty
  // set. Without this guard the run went on to copy ~270 MB into os.tmpdir(),
  // VACUUM the DB, boot an engine, then emit a report of nothing and append a
  // history line for it — polluting the cross-run trend ledger with an entry
  // that measured no model at all. Nothing downstream is meaningful with zero
  // turns, so refuse before spending the disk and the boot.
  if (turnsToRun.length === 0) {
    console.error(
      `[bench] no turns to run: the sample contains none of the requested class(es) ` +
        `(${requestedClasses.join(', ')}). Widen --classes, raise --per-class, or check --db.`,
    );
    throw new BenchCliError();
  }

  console.log(`[bench] preparing sandbox from ${vault} ...`);
  const paths = prepareSandbox({ sourceVault: vault, sourceDb: db });

  let client: BenchEngineClient | undefined;
  // Captured the instant connectSandboxEngine constructs the transport —
  // i.e. essentially immediately, well before the child finishes (or even
  // starts) its own boot — so there is ALWAYS a killable handle from the
  // moment a child process could possibly exist. `client` alone is NOT
  // enough: it is only assigned once connectSandboxEngine's entire promise
  // resolves, which requires the engine to finish migrations + a full index
  // (slow, can be minutes) — the round-2 leak was a signal arriving in
  // exactly that gap. See killEngineChildIfAny for how the two are used
  // together.
  let childTransport: KillableTransport | undefined;

  // Round-3 leak (found by the Task 10 e2e's SIGINT-mid-boot scenario): the
  // signal path and the normal finally path can BOTH reach cleanup, and the
  // signal path is what triggers the other one. A mid-boot SIGINT calls
  // transport.close(), which clears the transport's internal `_process` handle
  // SYNCHRONOUSLY and only THEN begins its up-to-4s kill escalation (stdin end
  // -> 2s -> SIGTERM -> 2s -> SIGKILL). That same close() makes the in-flight
  // client.connect() reject ("Not connected"), which throws out of the try
  // below and runs the finally — whose own killEngineChildIfAny call issues a
  // SECOND close() that, seeing `_process` already cleared, returns
  // IMMEDIATELY without waiting for anything. The finally then disposed the
  // sandbox and main() exited the process ~160ms after the signal, while the
  // engine child was still alive and mid-boot — and it went on to recreate the
  // deleted directory. Exactly the round-2 failure mode, reached through a
  // second concurrent caller instead of a missing handle.
  //
  // One shared promise fixes it: whoever asks for the teardown second awaits
  // the FIRST caller's real, still-running escalation instead of a no-op, so
  // no exit path can outrun the child's death. `client`/`childTransport` are
  // read when the teardown actually starts, so the first caller always sees
  // the best handle available at that moment.
  let teardown: Promise<void> | undefined;
  const killChildOnce = (): Promise<void> => (teardown ??= killEngineChildIfAny(client, childTransport));

  // Installed as soon as the sandbox exists (before anything that can
  // throw or hang — engine boot, model calls) so a Ctrl-C/SIGTERM at any
  // point in the run still kills the child and disposes the sandbox.
  // Removed in the finally below on normal completion.
  const removeSignalHandlers = installSandboxSignalHandlers(paths, {
    keep: keepSandbox,
    onCleanup: killChildOnce,
  });

  try {
    // Moved inside the try (was previously constructed before it): pure/
    // data-only today so this can't realistically throw, but keeping every
    // sandbox-lifetime statement inside the block that owns disposal is the
    // same consistency the rest of this function's cleanup handling cares
    // about.
    const spec = engineSpawnSpec(paths);
    console.log('[bench] booting sandboxed engine ...');
    client = await connectSandboxEngine(spec, ENGINE_BOOT_TIMEOUT_MS, {
      onTransport: (t) => {
        childTransport = t;
      },
    });

    const catalog = await client.modelCatalog();
    const resolved = modelRefs.map((ref) => resolveBenchModelRef(catalog, ref));

    // Pre-flight EVERY resolved model's provider key before any turn runs —
    // a missing key must name the model AND the env var and exit before any
    // spend (ambiguity ruling #3), not fail partway through a sweep.
    const keys = providerKeysFromEnv();
    const availability = providerAvailability(keys);
    const missing = resolved.filter((r) => !availability[r.entry.provider]);
    if (missing.length > 0) {
      for (const m of missing) {
        console.error(
          `[bench] model "${m.entry.model}" (ref "${m.ref}") needs the ${m.entry.provider} API key — ` +
            `set ${PROVIDER_ENV_VARS[m.entry.provider]}`,
        );
      }
      // throw, not process.exit(): this is inside the try/finally that owns
      // sandbox disposal + the engine client close. process.exit() here
      // previously killed the process before finally ran, leaking the
      // sandbox's VACUUMed DB copy under os.tmpdir() on every missing-key
      // preflight failure — exactly the "exit BEFORE any spend" case the
      // ambiguity ruling asks for, made worse by never cleaning up after
      // itself.
      throw new BenchCliError();
    }

    const toolInfos = toEngineToolInfos(await client.listTools());
    const chatSettings = await fetchChatSettings(client);

    const modelResults: ModelResultsInput[] = [];
    // Strictly sequential: turn by turn, model by model (ambiguity ruling #2
    // — sandbox contention and cross-attribution aren't worth parallel
    // speed here, same reasoning as curator's eval house style).
    for (const r of resolved) {
      console.log(`[bench] running ${r.entry.title} (${r.entry.model}) — ${turnsToRun.length} turn(s)`);
      const results: TurnResult[] = [];
      for (let i = 0; i < turnsToRun.length; i++) {
        const turn = turnsToRun[i];
        if (turn === undefined) continue;
        const result = await runReplayTurn({
          turn,
          modelEntry: r.entry,
          keys,
          client,
          toolInfos,
          chatSettings,
          paths,
        });
        results.push(result);
        console.log(
          `[bench]   [${i + 1}/${turnsToRun.length}] ${turn.turnClass} ${turn.conversationId}#${turn.seq} -> ${result.outcome}`,
        );
      }
      modelResults.push({ ref: r.ref, model: r.entry.model, label: r.entry.title, results });
    }

    const endedAt = new Date().toISOString();
    const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const distPath = spec.args[0];
    const engineDistMtime = distPath !== undefined ? statSync(distPath).mtime.toISOString() : 'unknown';

    const manifest: ReportManifest = {
      tag,
      gitSha,
      seed,
      perClass,
      models: resolved.map((r) => r.entry.model),
      // The RESOLVED zone, never a fabricated default. The date line injected
      // into every replayed system prompt comes from
      // `Intl.DateTimeFormat().resolvedOptions().timeZone`
      // (packages/chat-core/src/compose.ts) — which respects TZ when it is set
      // and otherwise reports whatever the machine resolved. Writing
      // 'America/New_York' here when TZ was unset made the manifest claim a
      // zone the prompts had not used, in a file whose entire purpose is to
      // state honestly what the run actually did.
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dbPath: db,
      corpusTurnCount: totalTurns,
      engineDistMtime,
      startedAt,
      endedAt,
    };

    const coverage: CoverageInput = {
      totalTurns,
      replayableTurns,
      partialExcluded,
      unknownToolExcluded,
      requestedClasses,
      sampledPerClass,
      shortfalls: sample.shortfalls,
      externalToolTurns,
    };

    const report = buildReport({ models: modelResults, manifest, coverage });

    const runDir = join(BENCH_DIR, '.bench', 'runs', tag);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report.json, null, 2)}\n`, 'utf8');
    writeFileSync(join(runDir, 'report.md'), report.markdown, 'utf8');

    const historyPath = join(BENCH_DIR, '.bench', 'history.jsonl');
    mkdirSync(dirname(historyPath), { recursive: true });
    appendFileSync(historyPath, `${JSON.stringify(buildHistoryEntry(report.json))}\n`, 'utf8');

    console.log(`[bench] report written to ${runDir}`);
    console.log(`[bench] history appended to ${historyPath}`);
  } finally {
    // Same ordering as the signal path, and the same shared teardown: kill the
    // child (client if connected, else the raw transport — e.g.
    // connectSandboxEngine itself threw or timed out) BEFORE disposing the
    // sandbox it runs against. Going through killChildOnce is what makes this
    // safe when a signal handler already started the teardown: this await
    // resolves only when the child is really gone, never on a second close()
    // that no-ops because the first one already took the process handle.
    // killEngineChildIfAny never throws, so this can't skip
    // disposeSandboxSafely below it.
    await killChildOnce();
    disposeSandboxSafely(paths, { keep: keepSandbox });
    // Detached LAST, not first. The await above can run for seconds — the
    // transport's kill escalation is stdin-end -> 2s -> SIGTERM -> 2s ->
    // SIGKILL — and on the interrupt path this finally is entered within
    // milliseconds of the signal (the signal's own transport.close() makes the
    // in-flight client.connect() reject, which throws straight into here).
    // Detaching before the await therefore left the ENTIRE escalation window
    // running with no SIGINT handler installed, so a second Ctrl-C — which is
    // exactly what an operator does when the first one appears not to have
    // worked — took Node's default terminate and orphaned the child
    // mid-escalation. Leaving them attached until everything is disposed is
    // strictly safer: on the interrupt path a second signal hits
    // installSandboxSignalHandlers' `handled` latch and is a no-op, and on the
    // normal path it re-enters killChildOnce, which is memoised. The original
    // "would hold the event loop open on nothing" reasoning is still honoured
    // — it just applies at the END of the finally, once there is genuinely
    // nothing left to clean up.
    removeSignalHandlers();
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (subcommand !== 'corpus' && subcommand !== 'run') {
    usage();
    throw new BenchCliError();
  }

  const rest = args.slice(1);
  if (subcommand === 'corpus') {
    runCorpus(rest);
  } else {
    await runBenchmark(rest);
  }
}

// Run main only when invoked directly (tsx src/cli.ts) — without this guard
// the CLI silently does nothing under tsx (curator's eval.ts hit this
// exact gap; copied verbatim).
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/cli.ts') || process.argv[1].endsWith('/cli.js'));

if (isMain) {
  main().catch((err) => {
    // BenchCliError: the specific reason was already printed at the point
    // of detection (usage(), or a targeted console.error) — don't also dump
    // a redundant "Error: bench: ..." + stack trace on top of it.
    if (!(err instanceof BenchCliError)) console.error(err);
    process.exit(1);
  });
}
