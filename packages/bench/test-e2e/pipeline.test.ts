// End-to-end: the whole bench pipeline against a REAL engine subprocess.
//
// Nothing else in this package has ever exercised the full path — every other
// suite stubs the engine client. This one boots the engine twice (once to build
// the corpus DB for a 4-file fixture vault, once for the sandbox under test),
// replays five scripted turns through the production chat-core assembly, and
// proves the system's central safety claim AT THE FILESYSTEM: a benchmark run
// validates writes without ever committing them.
//
// No spend, and no network AT THE MODEL LAYER: the LLM is a
// MockLanguageModelV4 injected through runReplayTurn's `makeModel` seam, and
// engineSpawnSpec hands the sandboxed engine empty-string provider keys, so
// nothing in this suite can reach a paid API.
//
// The suite is NOT network-free overall. The fixture vault has no
// `.vault-engine/models`, so prepareSandbox has nothing to symlink and the
// sandboxed engine's embedder worker runs with `allowRemoteModels = true`
// against an empty cache dir — i.e. it attempts an ONNX weight download from
// HuggingFace. That download is free, asynchronous, and non-fatal: it fails
// offline, semantic search silently degrades to FTS-only, and nothing this
// suite asserts depends on it. Worth knowing before running this offline (a
// slower boot) and before treating "no network" as a property of the harness.

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModel, UIMessage } from 'ai';
import { coerceContext } from '@vault/chat-core';
import type { ModelCatalogEntry } from '@vault/settings-registry';
import { ALL_TURN_CLASSES } from '../src/sample.js';
import type { TurnClass } from '../src/classify.js';
import type { CorpusTurn } from '../src/corpus.js';
import { connectSandboxEngine, type BenchEngineClient } from '../src/engine-client.js';
import { buildHistoryEntry, buildReport, type CoverageInput, type ReportManifest } from '../src/report.js';
import { runReplayTurn, toEngineToolInfos, type TurnResult } from '../src/runner.js';
import { disposeSandboxSafely } from '../src/cli.js';
import { engineSpawnSpec, prepareSandbox, type SandboxPaths } from '../src/sandbox.js';
import { toolKind } from '../src/tools-readwrite.js';
import { buildMiniSource, disposeMiniSource } from './fixtures/mini-db.js';

// --------------------------------------------------------------- constants

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = resolve(TEST_DIR, '..');
const REPO_ROOT = resolve(BENCH_DIR, '..', '..');
const ENGINE_DIST = join(REPO_ROOT, 'packages', 'engine', 'dist', 'index.js');
const CLI_PATH = join(BENCH_DIR, 'src', 'cli.ts');

/** The exact, actionable message a missing engine build must produce. Shared
 *  by the preflight test and the beforeAll hook so BOTH routes say the same
 *  thing — an e2e that skips (or dies with an opaque spawn error) when the
 *  engine isn't built reads as green, which is worse than failing. */
const ENGINE_DIST_MISSING = 'engine dist missing — run: npm run build -w vault-engine';

const BOOT_TIMEOUT_MS = 180_000;

/** Sandbox roots are `mkdtemp(os.tmpdir()/vault-bench-)`; the leak scans below
 *  key off exactly that prefix. */
const SANDBOX_PREFIX = join(tmpdir(), 'vault-bench-');

/** Minimum window over which a failed run's aftermath is OBSERVED before it is
 *  declared clean. Checking once, immediately, is precisely the method that
 *  missed the shipped SIGINT-mid-boot leak: the orphaned engine child RECREATED
 *  the deleted directory seconds later, once its boot got far enough to write
 *  settings notes and a DB backup. This is a floor on the sampling window, not
 *  a sleep-then-look-once — see expectNoSandboxResidue. */
const LEAK_MIN_OBSERVE_MS = 10_000;

/** Ceiling on how long a lingering DESCENDANT may take to disappear before it
 *  counts as a real orphan. Deliberately generous, because the thing being
 *  waited on is an engine-side race this suite cannot fix: the engine forks an
 *  ONNX embedder worker which self-exits on IPC `disconnect`
 *  (packages/engine/src/search/embedder-worker.ts:114), but cannot service that
 *  event while blocked in a synchronous weight load — exactly what it is doing
 *  in the seconds after boot, which is when these tests kill the engine. If the
 *  engine reaches SIGKILL first, the worker keeps running until its current
 *  synchronous block ends, then reaps itself. A fixed 10s window made this test
 *  fail ~2 runs in 3. Waiting for the self-reap makes the test reliable; it does
 *  NOT make the orphan impossible. */
const LEAK_DEADLINE_MS = 60_000;

const LEAK_POLL_MS = 250;

const SEED = 4242;
const REPORT_TAG = 'e2e-golden';

const STUB_ENTRY: ModelCatalogEntry = {
  title: 'Bench E2E Stub',
  provider: 'fireworks',
  model: 'bench-e2e/stub-model',
  enabled: true,
};

// ---------------------------------------------------------------- scripting

/** Structural stand-in for LanguageModelV4StreamPart — @ai-sdk/provider is a
 *  transitive dep, not one this package declares. */
type StreamPart = { type: string; [k: string]: unknown };

const USAGE = {
  inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 6, text: 6 },
};

function toolStep(toolName: string, input: string, id: string): StreamPart[] {
  return [
    { type: 'tool-call', toolCallId: id, toolName, input },
    { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
  ];
}

function textStep(text = 'done'): StreamPart[] {
  return [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: text },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: 'stop', usage: USAGE },
  ];
}

/** Plays `steps` in order, one per doStream call, repeating the last one. */
function scriptedModel(steps: StreamPart[][]): LanguageModel {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(call, steps.length - 1)] ?? textStep();
      call += 1;
      return { stream: convertArrayToReadableStream(step as never[]) };
    },
  }) as unknown as LanguageModel;
}

function turnFixture(over: Partial<CorpusTurn> & { seq: number; turnClass: TurnClass }): CorpusTurn {
  return {
    conversationId: 'e2e-conv',
    history: [{ id: `m${over.seq}`, role: 'user', parts: [{ type: 'text', text: 'go' }] }] as UIMessage[],
    recordedCalls: [],
    partial: false,
    unknownTools: [],
    modelRef: null,
    contextState: coerceContext(null),
    conversationUpdatedAt: '2026-08-01T12:00:00.000Z',
    ...over,
  };
}

// ------------------------------------------------------------- leak probes

function sandboxDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((n) => n.startsWith('vault-bench-'))
    .sort();
}

/** The descendant scan below reads /proc, i.e. it is Linux-only. It must never
 *  degrade to "found nothing" on a platform without /proc: an empty result from
 *  a scan that cannot see any process at all reads GREEN, silently turning the
 *  strongest half of the leak assertion into a no-op. So availability is
 *  probed once and a missing /proc is a loud, explanatory failure. (Today this
 *  only ever fires off Linux; the repo's dev box and its deploy target are both
 *  Linux, so the scan is live in every environment this suite actually runs in.) */
const PROC_AVAILABLE = existsSync('/proc/self/cmdline');

/**
 * Every live process whose argv mentions a bench sandbox path — the engine
 * child (its db path argument) and the embedder worker it forks (its modelsDir
 * argument) both qualify. `excludeRoot` filters out this suite's own,
 * legitimately-running sandbox engine.
 */
function sandboxProcesses(excludeRoot: string): { pid: string; cmd: string }[] {
  if (!PROC_AVAILABLE) {
    throw new Error(
      'sandboxProcesses: /proc is unavailable (non-Linux platform?) — the orphaned-descendant ' +
        'half of the leak assertion cannot run here. Failing loudly rather than reporting ' +
        '"no orphans found": a green result from a scan that can see no processes at all is ' +
        'worse than having no test.',
    );
  }
  const found: { pid: string; cmd: string }[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let cmd: string;
    try {
      cmd = readFileSync(join('/proc', entry, 'cmdline'), 'utf8').replace(/\0/g, ' ');
    } catch {
      continue; // the process exited between readdir and read
    }
    if (!cmd.includes(SANDBOX_PREFIX)) continue;
    if (excludeRoot !== '' && cmd.includes(excludeRoot)) continue;
    found.push({ pid: entry, cmd });
  }
  return found;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Asserts a failed run left NOTHING behind — no sandbox directory, no surviving
 * descendant process — by SAMPLING the aftermath rather than sleeping a fixed
 * interval and looking once.
 *
 * The two halves are not symmetric, and treating them the same is what made
 * this assertion flaky:
 *
 *   • Directory — load-bearing and MONOTONE. After the CLI process has exited,
 *     nothing legitimate creates a `vault-bench-*` directory; disposal already
 *     ran inside the CLI's own `finally`. So a sighting at ANY sample is
 *     conclusive and fails immediately. This is strictly STRONGER than the old
 *     sleep-then-look-once: a directory recreated by an orphan at t+2s and
 *     removed again before t+10s used to pass silently, and now cannot.
 *
 *   • Descendant process — transient. The engine's forked ONNX embedder worker
 *     self-exits on IPC `disconnect`, but cannot service that event while
 *     blocked in a synchronous weight load, so after a SIGKILLed engine it can
 *     outlive its parent by an unbounded-but-finite interval. A fixed 10s cut-off
 *     turned that engine-side race into a ~2-in-3 test failure. Polled to
 *     LEAK_DEADLINE_MS instead; a process still present at the deadline is a
 *     genuine orphan and fails with its pid and full argv.
 *
 * Both halves keep observing for at least LEAK_MIN_OBSERVE_MS even once clean,
 * so the directory gets a continuous 10s+ watch rather than one glance at the
 * 10s mark. Nothing asserted here was weakened — only the waiting strategy
 * changed.
 */
async function expectNoSandboxResidue(opts: {
  dirsBefore: ReadonlySet<string>;
  pidsBefore: ReadonlySet<string>;
  ownRoot: string;
}): Promise<void> {
  const start = Date.now();
  let lingering: { pid: string; cmd: string }[] = [];

  for (;;) {
    const leakedDirs = sandboxDirs().filter((d) => !opts.dirsBefore.has(d));
    expect(
      leakedDirs,
      'a sandbox directory survived the run (or was recreated by an orphaned child) — conclusive at any sample',
    ).toEqual([]);

    lingering = sandboxProcesses(opts.ownRoot).filter((p) => !opts.pidsBefore.has(p.pid));
    const elapsed = Date.now() - start;
    if (lingering.length === 0 && elapsed >= LEAK_MIN_OBSERVE_MS) {
      // Surfaced only when the descendant needed longer than the old fixed
      // window: this is the engine-side embedder race, and seeing it in the run
      // log is the difference between "known race, absorbed" and "mystery".
      if (elapsed > LEAK_MIN_OBSERVE_MS + LEAK_POLL_MS) {
        console.log(`[e2e] sandbox descendants cleared after ${elapsed}ms (embedder self-reap)`);
      }
      return;
    }
    if (elapsed >= LEAK_DEADLINE_MS) break;
    await delay(LEAK_POLL_MS);
  }

  expect(
    lingering,
    `orphaned process(es) still alive ${LEAK_DEADLINE_MS}ms after the run exited — this is a real leak, not the embedder self-reap race`,
  ).toEqual([]);
}

interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `src/cli.ts` as its own process under tsx. Spawned as
 * `node --import tsx <cli.ts>` rather than through the `tsx` bin so there is
 * no wrapper process between us and the CLI — signals must reach the CLI
 * itself for the SIGINT scenario to test what it claims to test.
 *
 * The env deliberately drops every provider key so the CLI's own pre-flight
 * refuses; the sandboxed engine it spawns is separately key-less via
 * engineSpawnSpec.
 */
function runCli(args: string[], onStdout?: (line: string, child: ChildProcess) => void): Promise<CliRun> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env['ANTHROPIC_API_KEY'];
  delete env['OPENAI_COMPAT_API_KEY'];
  delete env['OPENROUTER_API_KEY'];

  const child = spawn(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], {
    cwd: BENCH_DIR,
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => {
    const text = c.toString();
    stdout += text;
    onStdout?.(text, child);
  });
  child.stderr.on('data', (c: Buffer) => {
    stderr += c.toString();
  });

  return new Promise<CliRun>((resolvePromise) => {
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

// ------------------------------------------------------------------ state

let seedSource: SandboxPaths | undefined;
let paths: SandboxPaths | undefined;
let client: BenchEngineClient | undefined;
let toolInfos: ReturnType<typeof toEngineToolInfos> = [];
let shipNodeId = '';
let shipPath = '';
let shipBefore = '';
const results: TurnResult[] = [];

async function replay(opts: {
  seq: number;
  turnClass: TurnClass;
  recordedCalls?: { toolName: string; state: string }[];
  steps: StreamPart[][];
}): Promise<TurnResult> {
  if (client === undefined || paths === undefined) throw new Error('e2e: sandbox not initialised');
  const model = scriptedModel(opts.steps);
  const result = await runReplayTurn({
    turn: turnFixture({
      seq: opts.seq,
      turnClass: opts.turnClass,
      recordedCalls: opts.recordedCalls ?? [],
    }),
    modelEntry: STUB_ENTRY,
    // Never consulted: `makeModel` below replaces resolveModel entirely, so no
    // provider client is ever constructed and no request can leave the box.
    keys: {},
    client,
    toolInfos,
    chatSettings: { systemPrompt: null, tieringNote: null, maxSteps: null },
    paths,
    makeModel: () => model,
    sleep: async () => {},
  });
  results.push(result);
  return result;
}

// ------------------------------------------------------------------ tests

describe('preflight', () => {
  it('the engine is built (never skips — a skipped e2e reads as green)', () => {
    expect(existsSync(ENGINE_DIST), ENGINE_DIST_MISSING).toBe(true);
  });
});

// Everything below needs a booted engine and a prepared sandbox, so the
// setup hooks live HERE rather than at file scope: a file-level beforeAll
// runs before every test in the file, including the preflight guard above,
// which would hide the one failure that actually names the fix.
describe('bench pipeline against a real engine subprocess', () => {
  beforeAll(async () => {
    // Same guard, same message as the preflight test — reached first when the
    // engine isn't built, so the failure names the fix instead of surfacing as
    // an opaque spawn error inside a hook.
    if (!existsSync(ENGINE_DIST)) throw new Error(ENGINE_DIST_MISSING);

    seedSource = await buildMiniSource();
    paths = prepareSandbox({ sourceVault: seedSource.vaultPath, sourceDb: seedSource.dbPath });
    client = await connectSandboxEngine(engineSpawnSpec(paths), BOOT_TIMEOUT_MS);
    toolInfos = toEngineToolInfos(await client.listTools());

    // Ambiguity ruling #3: node ids are generated, so they are discovered here
    // against the real engine, never hardcoded.
    const envelope = await client.callToolEnvelope('query-nodes', { title_contains: 'Ship Alpha' });
    if (!envelope.ok) throw new Error(`e2e: setup query-nodes failed: ${envelope.error.code}`);
    const nodes = (envelope.data as { nodes?: { id: string; title: string }[] } | null)?.nodes ?? [];
    const ship = nodes.find((n) => n.title === 'Ship Alpha');
    if (ship === undefined) throw new Error('e2e: fixture node "Ship Alpha" was not indexed');
    shipNodeId = ship.id;

    shipPath = join(paths.vaultPath, 'Tasks', 'Ship Alpha.md');
    shipBefore = readFileSync(shipPath, 'utf8');
  });

  afterAll(async () => {
    if (client !== undefined) await client.close().catch(() => {});
    // disposeSandboxSafely, not disposeSandbox: a disposal failure (a lingering
    // handle, EBUSY) would otherwise surface as an afterAll error that masks an
    // otherwise-clean suite result. It logs instead — and the failure-path
    // scenarios above are what actually assert that disposal happened.
    if (paths !== undefined) disposeSandboxSafely(paths, { keep: false });
    if (seedSource !== undefined) disposeMiniSource(seedSource);
  });

  describe('golden mini-corpus replay', () => {
    it('turn 1: a read that finds nodes scores PASS', async () => {
      const result = await replay({
        seq: 1,
        turnClass: 'single-read',
        recordedCalls: [{ toolName: 'query-nodes', state: 'output-available' }],
        steps: [toolStep('query-nodes', '{"title_contains":"Alpha"}', 'c1'), textStep()],
      });

      expect(result.outcome).toBe('PASS');
      expect(result.error).toBeUndefined();
      expect(result.emittedCallCount).toBe(1);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toMatchObject({ kind: 'read', verdict: 'PASS' });
      const data = (result.calls[0] as { envelope: { data: { nodes: unknown[] } } }).envelope.data;
      // Projects/Alpha.md, Notes/Alpha Kickoff.md, Tasks/Ship Alpha.md
      expect(data.nodes).toHaveLength(3);
      expect(result.truncatedAtWrite).toBe(false);
    });

    it('turn 2: a read that finds nothing scores WEAK', async () => {
      const result = await replay({
        seq: 2,
        turnClass: 'single-read',
        recordedCalls: [{ toolName: 'query-nodes', state: 'output-available' }],
        steps: [toolStep('query-nodes', '{"title_contains":"zzz-nonexistent"}', 'c1'), textStep()],
      });

      expect(result.outcome).toBe('WEAK');
      expect(result.calls[0]).toMatchObject({ kind: 'read', verdict: 'WEAK' });
      expect((result.calls[0] as { envelope: { data: { nodes: unknown[] } } }).envelope.data.nodes).toEqual([]);
    });

    it('turn 3: a read the engine rejects scores FAIL with NOT_FOUND', async () => {
      const result = await replay({
        seq: 3,
        turnClass: 'single-read',
        recordedCalls: [{ toolName: 'get-node', state: 'output-available' }],
        steps: [toolStep('get-node', '{"node_id":"does-not-exist"}', 'c1'), textStep()],
      });

      expect(result.outcome).toBe('FAIL');
      expect(result.calls[0]).toMatchObject({ kind: 'read', verdict: 'FAIL' });
      const envelope = (result.calls[0] as { envelope: { ok: boolean; error: { code: string } } }).envelope;
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe('NOT_FOUND');
    });

    it('turn 4: a write is dry-run validated, truncates the turn, and NEVER touches the vault file', async () => {
      const result = await replay({
        seq: 4,
        turnClass: 'single-write',
        recordedCalls: [{ toolName: 'update-node', state: 'output-available' }],
        steps: [
          toolStep('update-node', JSON.stringify({ node_id: shipNodeId, set_fields: { status: 'done' } }), 'c1'),
          textStep(),
        ],
      });

      expect(result.outcome).toBe('PASS');
      expect(result.truncatedAtWrite).toBe(true);
      expect(result.unvalidatable).toBe(0);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toMatchObject({ kind: 'write-validated', verdict: 'VALID' });

      // The dry run really ran and really would have changed the field. Without
      // this the whole turn passes vacuously: the engine's zod schema silently
      // DROPS an unknown parameter, so an update-node call that named the wrong
      // key would still return ok:true — a no-op that "proves" nothing about the
      // write path and leaves the file unchanged for the wrong reason.
      const envelope = (result.calls[0] as {
        envelope: { data: { dry_run: boolean; preview: { coerced_state: Record<string, { value: unknown }> } } };
      }).envelope;
      expect(envelope.data.dry_run).toBe(true);
      expect(envelope.data.preview.coerced_state['status']?.value).toBe('done');

      // THE mutation-free proof. Asserted on the FILE, not on a tool response:
      // the safety claim is about the disk, so the disk is what gets read.
      const shipAfter = readFileSync(shipPath, 'utf8');
      expect(shipAfter).toContain('status: open');
      expect(shipAfter).not.toContain('status: done');
      expect(shipAfter).toBe(shipBefore);
    });

    it('turn 5: a text-only turn scores PASS with no calls at all', async () => {
      const result = await replay({
        seq: 5,
        turnClass: 'trivial',
        steps: [textStep('no tools needed')],
      });

      expect(result.outcome).toBe('PASS');
      expect(result.calls).toEqual([]);
      expect(result.emittedCallCount).toBe(0);
      expect(result.truncatedAtWrite).toBe(false);
    });

    it('the report step writes report.json, appends exactly one history line, and carries the seed', () => {
      expect(results).toHaveLength(5);

      const outRoot = mkdtempSync(join(tmpdir(), 'bench-e2e-report-'));
      try {
        const historyPath = join(outRoot, 'history.jsonl');
        // A pre-existing entry, so "gained exactly one line" is a real delta and
        // not just "the file has one line".
        writeFileSync(historyPath, `${JSON.stringify({ tag: 'previous-run' })}\n`, 'utf8');
        const linesBefore = readFileSync(historyPath, 'utf8').split('\n').filter((l) => l !== '').length;

        const manifest: ReportManifest = {
          tag: REPORT_TAG,
          gitSha: 'e2e-no-sha',
          seed: SEED,
          perClass: 5,
          models: [STUB_ENTRY.model],
          tz: 'America/New_York',
          dbPath: seedSource?.dbPath ?? '',
          corpusTurnCount: results.length,
          engineDistMtime: statSync(ENGINE_DIST).mtime.toISOString(),
          startedAt: '2026-08-01T12:00:00.000Z',
          endedAt: '2026-08-01T12:01:00.000Z',
        };
        const sampledPerClass = Object.fromEntries(
          ALL_TURN_CLASSES.map((c) => [c, results.filter((r) => r.turnClass === c).length]),
        ) as Record<TurnClass, number>;
        const coverage: CoverageInput = {
          totalTurns: results.length,
          replayableTurns: results.length,
          partialExcluded: 0,
          unknownToolExcluded: 0,
          requestedClasses: [...ALL_TURN_CLASSES],
          sampledPerClass,
          shortfalls: [],
          externalToolTurns: 0,
        };

        const report = buildReport({
          models: [{ ref: 'stub', model: STUB_ENTRY.model, label: STUB_ENTRY.title, results }],
          manifest,
          coverage,
        });

        const runDir = join(outRoot, 'runs', REPORT_TAG);
        mkdirSync(runDir, { recursive: true });
        const reportJsonPath = join(runDir, 'report.json');
        writeFileSync(reportJsonPath, `${JSON.stringify(report.json, null, 2)}\n`, 'utf8');
        writeFileSync(join(runDir, 'report.md'), report.markdown, 'utf8');
        appendFileSync(historyPath, `${JSON.stringify(buildHistoryEntry(report.json))}\n`, 'utf8');

        expect(existsSync(reportJsonPath)).toBe(true);
        const parsed = JSON.parse(readFileSync(reportJsonPath, 'utf8')) as {
          manifest: { seed: number; tag: string };
          models: { cells: Record<TurnClass, Record<string, unknown>> }[];
        };
        expect(parsed.manifest.seed).toBe(SEED);
        expect(parsed.manifest.tag).toBe(REPORT_TAG);

        const cells = parsed.models[0]?.cells;
        // turns 1-3 are all single-read: one PASS, one WEAK, one FAIL.
        expect(cells?.['single-read']).toMatchObject({ turns: 3, pass: 1, weak: 1, fail: 1, error: 0 });
        expect(cells?.['single-write']).toMatchObject({ turns: 1, pass: 1, truncatedAtWrite: 1, unvalidatable: 0 });
        expect(cells?.['trivial']).toMatchObject({ turns: 1, pass: 1 });
        expect(cells?.['complex']).toMatchObject({ turns: 0 });
        expect(cells?.['multi-read']).toMatchObject({ turns: 0 });

        const linesAfter = readFileSync(historyPath, 'utf8').split('\n').filter((l) => l !== '').length;
        expect(linesAfter - linesBefore).toBe(1);
        const appended = JSON.parse(readFileSync(historyPath, 'utf8').split('\n').filter((l) => l !== '')[1] ?? '') as {
          seed: number;
          tag: string;
        };
        expect(appended.seed).toBe(SEED);
        expect(appended.tag).toBe(REPORT_TAG);
      } finally {
        rmSync(outRoot, { recursive: true, force: true });
      }
    });
  });

  describe('classification registry stays in sync with the real engine', () => {
    it('every tool the sandboxed engine advertises is classified (no "unknown")', async () => {
      if (client === undefined) throw new Error('e2e: sandbox not initialised');
      const tools = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      // A newly added engine tool fails here until it is deliberately placed in
      // one of tools-readwrite.ts's three sets — which is the point: an
      // unclassified tool is treated as an unvalidatable write and silently
      // truncates every turn that touches it.
      expect(tools.map((t) => t.name).filter((n) => toolKind(n) === 'unknown')).toEqual([]);
    });
  });

  // All three scenarios below assert cleanup on a FAILURE path, and all three
  // hand the aftermath to expectNoSandboxResidue, which SAMPLES it rather than
  // sleeping a fixed interval and looking once. Two real leaks shipped in this
  // package precisely because verification only checked the happy path, and the
  // second one was invisible to an immediate check: the orphaned engine child
  // RECREATED the deleted sandbox directory seconds later (a 248 MB artifact
  // found on disk). A third failure mode showed up in review — a fixed 10s
  // window failed these tests ~2 runs in 3 on an engine-side embedder race that
  // is not a leak at all. See expectNoSandboxResidue for how the two halves are
  // told apart without weakening either.
  describe('failure-path cleanup', () => {
    it('a run refused for a missing provider key leaves no sandbox and no engine process', async () => {
      const dirsBefore = new Set(sandboxDirs());
      const ownRoot = paths?.root ?? '';
      const pidsBefore = new Set(sandboxProcesses(ownRoot).map((p) => p.pid));

      const run = await runCli([
        'run',
        '--models',
        'Qwen 3.7 Plus',
        '--db',
        seedSource?.dbPath ?? '',
        '--vault',
        seedSource?.vaultPath ?? '',
        '--per-class',
        '1',
        '--seed',
        '1',
        '--tag',
        'e2e-keyfail',
      ]);

      expect(run.code).toBe(1);
      expect(run.stdout).toContain('booting sandboxed engine');
      expect(run.stderr).toMatch(/needs the \w+ API key/);

      await expectNoSandboxResidue({ dirsBefore, pidsBefore, ownRoot });
    });

    it('a SIGINT arriving mid-boot leaves no sandbox and no orphaned engine child', async () => {
      const dirsBefore = new Set(sandboxDirs());
      const ownRoot = paths?.root ?? '';
      const pidsBefore = new Set(sandboxProcesses(ownRoot).map((p) => p.pid));

      let interrupted = false;
      const run = await runCli(
        [
          'run',
          '--models',
          'Qwen 3.7 Plus',
          '--db',
          seedSource?.dbPath ?? '',
          '--vault',
          seedSource?.vaultPath ?? '',
          '--per-class',
          '1',
          '--seed',
          '1',
          '--tag',
          'e2e-sigint',
        ],
        (chunk, child) => {
          // The engine child is spawned right after this line and takes seconds
          // to finish booting — the exact window in which `client` is still
          // undefined and the shipped leak orphaned the child.
          if (interrupted || !chunk.includes('booting sandboxed engine')) return;
          interrupted = true;
          setTimeout(() => child.kill('SIGINT'), 300);
        },
      );

      expect(interrupted).toBe(true);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('received SIGINT');

      await expectNoSandboxResidue({ dirsBefore, pidsBefore, ownRoot });
    });

    it('a SECOND SIGINT during the kill escalation still leaves no sandbox and no orphan', async () => {
      const dirsBefore = new Set(sandboxDirs());
      const ownRoot = paths?.root ?? '';
      const pidsBefore = new Set(sandboxProcesses(ownRoot).map((p) => p.pid));

      let signals = 0;
      const run = await runCli(
        [
          'run',
          '--models',
          'Qwen 3.7 Plus',
          '--db',
          seedSource?.dbPath ?? '',
          '--vault',
          seedSource?.vaultPath ?? '',
          '--per-class',
          '1',
          '--seed',
          '1',
          '--tag',
          'e2e-sigint-twice',
        ],
        (chunk, child) => {
          if (signals > 0 || !chunk.includes('booting sandboxed engine')) return;
          signals = 1;
          setTimeout(() => child.kill('SIGINT'), 300);
          // Mashing Ctrl-C is what operators actually do when the first press
          // appears not to have worked, and the first press buys a multi-second
          // wait: the transport's escalation is stdin-end -> 2s -> SIGTERM ->
          // 2s -> SIGKILL (observed: ~4s to exit). 1.8s lands squarely inside
          // that window. Detaching the signal handlers at the TOP of
          // runBenchmark's finally left the whole window unhandled — the finally
          // is entered within milliseconds of the first signal, because that
          // signal's own transport.close() makes the in-flight connect() reject
          // — so this second press took Node's default terminate and orphaned
          // the child mid-escalation. Verified to fail on the pre-fix code.
          setTimeout(() => {
            signals = 2;
            child.kill('SIGINT');
          }, 1800);
        },
      );

      expect(signals).toBe(2);
      expect(run.code).toBe(1);
      // The idempotence latch means the second signal must NOT produce a second
      // "received SIGINT" line — one concurrent kill-and-dispose, not two.
      expect(run.stderr.match(/received SIGINT/g) ?? []).toHaveLength(1);

      await expectNoSandboxResidue({ dirsBefore, pidsBefore, ownRoot });
    });
  });
});
