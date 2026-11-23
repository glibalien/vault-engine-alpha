// Unit tests for the CLI's sandbox-lifetime cleanup helpers — never the
// full `run` pipeline (that needs a real sandbox + engine + network, which
// is Task 10's e2e job per ambiguity ruling #1). Both functions under test
// are exported specifically so the signal-handling path can be verified
// honestly in-process: `installSandboxSignalHandlers` registers REAL
// `process.on('SIGINT'/'SIGTERM'/'SIGHUP', ...)` listeners, and this suite drives
// them via `process.emit(...)` (a normal EventEmitter dispatch, not an
// actual OS signal) with `process.exit` mocked so a passing assertion can
// never actually terminate the test runner.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BenchEngineClient, KillableTransport } from './engine-client.js';
import type { SandboxPaths } from './sandbox.js';
import {
  disposeSandboxSafely,
  installSandboxSignalHandlers,
  killEngineChildIfAny,
  resolveRequiredAbsolutePath,
  runBenchmark,
  runCorpus,
} from './cli.js';
import { extractTurns } from './corpus.js';
import { prepareSandbox } from './sandbox.js';

// Editing/sandbox/model effects are mocked so validation-order assertions can
// prove they are never reached on a missing or relative source path. The
// sandbox module keeps its real implementations (other tests in this file
// exercise them) and only wraps `prepareSandbox` in a spy.
vi.mock('./corpus.js', () => ({ extractTurns: vi.fn(() => []), replayable: vi.fn(() => true) }));
vi.mock('./sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sandbox.js')>();
  return { ...actual, prepareSandbox: vi.fn(actual.prepareSandbox) };
});
vi.mock('./engine-client.js', () => ({
  connectSandboxEngine: vi.fn(() => {
    throw new Error('connectSandboxEngine must not run on validation failure');
  }),
}));

function fixtureSandbox(prefix: string): SandboxPaths {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const vaultPath = join(root, 'vault');
  mkdirSync(vaultPath, { recursive: true });
  return { root, vaultPath, dbPath: join(vaultPath, '.vault-engine', 'vault.db') };
}

const scratchDirs: string[] = [];
afterEach(() => {
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('resolveRequiredAbsolutePath', () => {
  it('rejects a missing value', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => resolveRequiredAbsolutePath('--db', undefined)).toThrow();
      expect(() => resolveRequiredAbsolutePath('--db', '')).toThrow();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('rejects a relative path', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => resolveRequiredAbsolutePath('--db', 'relative.db')).toThrow();
      expect(errSpy.mock.calls.flat().join(' ')).toContain('absolute');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('returns an absolute path unchanged', () => {
    expect(resolveRequiredAbsolutePath('--db', '/srv/example-vault/.vault-engine/vault.db')).toBe(
      '/srv/example-vault/.vault-engine/vault.db',
    );
  });
});

describe('runCorpus source-path validation happens before effects', () => {
  it('rejects a missing --db before extractTurns', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => runCorpus([])).toThrow();
      expect(extractTurns).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('rejects a relative --db before extractTurns', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => runCorpus(['--db', 'relative.db'])).toThrow();
      expect(extractTurns).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('accepts an absolute --db and reads it', () => {
    const db = '/srv/example-vault/.vault-engine/vault.db';
    runCorpus(['--db', db]);
    expect(extractTurns).toHaveBeenCalledWith(db);
  });
});

describe('runBenchmark source-path validation happens before effects', () => {
  it('rejects a missing --vault before any effect', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        runBenchmark(['--models', 'x', '--db', '/srv/example-vault/.vault-engine/vault.db']),
      ).rejects.toThrow();
      expect(extractTurns).not.toHaveBeenCalled();
      expect(prepareSandbox).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('rejects a relative --db before any effect', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runBenchmark(['--models', 'x', '--vault', '/srv/example-vault', '--db', 'v.db'])).rejects.toThrow();
      expect(extractTurns).not.toHaveBeenCalled();
      expect(prepareSandbox).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('accepts absolute --vault/--db and reaches extraction but not the sandbox when no turns match', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        runBenchmark(['--models', 'x', '--vault', '/srv/example-vault', '--db', '/srv/example-vault/.vault-engine/vault.db']),
      ).rejects.toThrow();
      expect(extractTurns).toHaveBeenCalledWith('/srv/example-vault/.vault-engine/vault.db');
      expect(prepareSandbox).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('disposeSandboxSafely', () => {
  it('disposes the sandbox when keep is false', () => {
    const paths = fixtureSandbox('dispose-safely-');
    scratchDirs.push(paths.root);

    expect(existsSync(paths.root)).toBe(true);
    disposeSandboxSafely(paths, { keep: false });
    expect(existsSync(paths.root)).toBe(false);
  });

  it('leaves the sandbox in place when keep is true', () => {
    const paths = fixtureSandbox('dispose-safely-keep-');
    scratchDirs.push(paths.root);

    disposeSandboxSafely(paths, { keep: true });
    expect(existsSync(paths.root)).toBe(true);
  });

  it('catches and logs a disposal failure rather than throwing — a failed disposal must not block process exit', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'dispose-safely-fail-'));
    scratchDirs.push(scratch);
    // vaultPath outside os.tmpdir() fails assertContained inside
    // disposeSandbox, which throws — the exact case this function exists
    // to swallow. Read-only negative use of the real vault path, same
    // pattern as sandbox.test.ts's own disposeSandbox containment tests.
    const paths: SandboxPaths = {
      root: scratch,
      vaultPath: '/srv/example-vault',
      dbPath: '/srv/example-vault/.vault-engine/vault.db',
    };

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => disposeSandboxSafely(paths, { keep: false })).not.toThrow();
      expect(errSpy).toHaveBeenCalled();
      // root (the scratch dir this function was actually allowed to touch)
      // is untouched — disposeSandbox refused before any rmSync ran.
      expect(existsSync(scratch)).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('killEngineChildIfAny (fix round 2: the mid-boot orphan gap)', () => {
  it('prefers client.close() when the client is defined (post-boot case) and does not also touch the raw transport', async () => {
    const clientClose = vi.fn().mockResolvedValue(undefined);
    const transportClose = vi.fn().mockResolvedValue(undefined);
    const client = { close: clientClose } as unknown as BenchEngineClient;
    const transport: KillableTransport = { close: transportClose };

    await killEngineChildIfAny(client, transport);

    expect(clientClose).toHaveBeenCalledOnce();
    expect(transportClose).not.toHaveBeenCalled();
  });

  it('falls back to the raw transport handle when client is undefined — the exact mid-boot shape', async () => {
    const transportClose = vi.fn().mockResolvedValue(undefined);
    const transport: KillableTransport = { close: transportClose };

    await killEngineChildIfAny(undefined, transport);

    expect(transportClose).toHaveBeenCalledOnce();
  });

  it('is a no-op and does not throw when neither client nor transport exist (signal arrived before the transport was even constructed)', async () => {
    await expect(killEngineChildIfAny(undefined, undefined)).resolves.toBeUndefined();
  });

  it('catches and logs a close() failure rather than throwing — a failed kill must not block disposal', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const transport: KillableTransport = { close: vi.fn().mockRejectedValue(new Error('kill failed')) };
      await expect(killEngineChildIfAny(undefined, transport)).resolves.toBeUndefined();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('kill failed'))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('installSandboxSignalHandlers', () => {
  // SIGHUP belongs here with the other two: a multi-minute sweep started over
  // SSH or in a terminal tab gets SIGHUP when that session goes away, and
  // Node's default disposition for it is terminate — no finally, ~250 MB of
  // sandbox left under os.tmpdir().
  it('registers real SIGINT + SIGTERM + SIGHUP listeners, removable via the returned remove()', () => {
    const paths = fixtureSandbox('signal-register-');
    scratchDirs.push(paths.root);

    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const before = signals.map((s) => process.listenerCount(s));

    const remove = installSandboxSignalHandlers(paths, { keep: true });
    signals.forEach((s, i) => expect(process.listenerCount(s), s).toBe((before[i] ?? 0) + 1));

    remove();
    signals.forEach((s, i) => expect(process.listenerCount(s), s).toBe(before[i] ?? 0));
  });

  // The leak SIGHUP closes is the one an operator hits by closing the terminal
  // (or dropping SSH) mid-sweep — never by pressing Ctrl-C — so it needs its own
  // end-to-end assertion, not just a listener-count check.
  it('on SIGHUP: runs onCleanup, disposes the sandbox, and exits non-zero — same path as SIGINT', async () => {
    const paths = fixtureSandbox('signal-sighup-');
    scratchDirs.push(paths.root);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cleanupCalls: string[] = [];
    const remove = installSandboxSignalHandlers(paths, {
      keep: false,
      onCleanup: async () => {
        cleanupCalls.push('onCleanup');
      },
    });

    try {
      process.emit('SIGHUP');
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(cleanupCalls).toEqual(['onCleanup']);
      expect(existsSync(paths.root)).toBe(false);
      expect(exitSpy).toHaveBeenCalledWith(1);
      // The log line names the signal that actually arrived, not a hardcoded one.
      expect(errSpy.mock.calls.flat().join(' ')).toContain('received SIGHUP');
    } finally {
      remove();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('on SIGINT: runs onCleanup, disposes the sandbox, and exits non-zero — then is idempotent on a second signal', async () => {
    const paths = fixtureSandbox('signal-dispose-');
    scratchDirs.push(paths.root);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
    const cleanupCalls: string[] = [];
    const remove = installSandboxSignalHandlers(paths, {
      keep: false,
      onCleanup: async () => {
        cleanupCalls.push('onCleanup');
      },
    });

    try {
      expect(existsSync(paths.root)).toBe(true);

      // A normal EventEmitter dispatch to the REAL registered listener —
      // not a reimplementation of it, and not an actual OS signal (which
      // would risk killing the test worker even with process.exit mocked,
      // since the default SIGINT disposition is a Node/OS-level concern
      // this emit() bypasses entirely).
      process.emit('SIGINT');
      // handleSignal's cleanup chain (Promise.resolve().then(onCleanup)
      // .finally(dispose + exit)) is async — let it settle.
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(cleanupCalls).toEqual(['onCleanup']);
      expect(existsSync(paths.root)).toBe(false);
      expect(exitSpy).toHaveBeenCalledWith(1);

      // Idempotent: a second SIGINT after cleanup already latched is a
      // total no-op — no second dispose attempt, no second exit call.
      exitSpy.mockClear();
      cleanupCalls.length = 0;
      process.emit('SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cleanupCalls).toEqual([]);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      remove();
      exitSpy.mockRestore();
    }
  });

  it('mid-boot SIGINT (client never assigned): waits for the child to actually exit before disposing — the round-2 regression', async () => {
    // This is the exact shape that leaked on disk: `client` is only
    // assigned once connectSandboxEngine's ENTIRE promise resolves, which
    // requires the engine to finish migrations + a full index. A signal
    // arriving during that window previously saw client === undefined,
    // treated "no client" as "nothing to kill", and disposeSandboxSafely
    // deleted the tree out from under a still-running child — which then
    // recreated part of it (settings notes + a DB backup) once it got far
    // enough into boot to write them. onCleanup here is wired exactly as
    // runBenchmark wires it: killEngineChildIfAny(client, childTransport)
    // with client undefined and only the raw transport handle available.
    const paths = fixtureSandbox('signal-midboot-');
    scratchDirs.push(paths.root);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);

    let resolveClose: (() => void) | undefined;
    let closeCalled = false;
    let sandboxStillIntactWhenCloseResolved: boolean | undefined;
    const fakeChildTransport: KillableTransport = {
      close: () =>
        new Promise<void>((resolve) => {
          closeCalled = true;
          resolveClose = () => {
            // Captured at the instant close() is ABOUT to resolve — proves
            // disposal hadn't started yet, i.e. it really waited for this.
            sandboxStillIntactWhenCloseResolved = existsSync(paths.root);
            resolve();
          };
        }),
    };

    const remove = installSandboxSignalHandlers(paths, {
      keep: false,
      onCleanup: () => killEngineChildIfAny(undefined, fakeChildTransport),
    });

    try {
      process.emit('SIGINT');
      // Let the handler reach fakeChildTransport.close() and start
      // awaiting it (close() deliberately never resolves on its own).
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(closeCalled).toBe(true);
      // The child hasn't "exited" yet (close() hasn't resolved) — the
      // sandbox must still be on disk. This is the assertion that would
      // have failed against the round-2 code, which disposed immediately
      // because it only ever checked `client`.
      expect(existsSync(paths.root)).toBe(true);

      resolveClose?.();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(sandboxStillIntactWhenCloseResolved).toBe(true); // still there the instant the kill finished
      expect(existsSync(paths.root)).toBe(false); // gone only AFTER the kill was confirmed
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      remove();
      exitSpy.mockRestore();
    }
  });

  it('an onCleanup failure is caught and logged, and disposal + exit still happen', async () => {
    const paths = fixtureSandbox('signal-cleanup-fails-');
    scratchDirs.push(paths.root);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const remove = installSandboxSignalHandlers(paths, {
      keep: false,
      onCleanup: async () => {
        throw new Error('client.close() boom');
      },
    });

    try {
      process.emit('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(existsSync(paths.root)).toBe(false); // disposal still ran despite onCleanup throwing
      expect(exitSpy).toHaveBeenCalledWith(1); // exit still happened
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('client.close() boom'))).toBe(true);
    } finally {
      remove();
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
