import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, expect, it, vi } from 'vitest';
import type { CoreDeps } from '../src/core.js';
import type { ToolHandler } from '../src/auth/with-scope.js';
import type { HomeRefreshGuard } from '../src/home-refresh-types.js';

const state = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  events: [] as string[],
  guard: undefined as HomeRefreshGuard | undefined,
  validate: async () => {},
  settings: async () => {},
  work: async () => {},
  sweep: async () => {},
  catchUp: false,
  wikiFields: async () => {},
}));

// Keep the real bootstrap, MCP registration, refresh handler, durable admission,
// recovery and serialization. Replace external Engine/settings/network edges.
vi.mock('../src/config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/config.js')>(),
  loadBootstrapConfig: () => ({
    oauthOwnerPassword: 'test', oauthIssuerUrl: 'http://localhost:3335', llmKeys: {},
  }),
}));
vi.mock('../src/auth/env.js', () => ({
  validateAuthEnv: () => ({ ownerPassword: 'test', issuerUrl: new URL('http://localhost:3335') }),
  ownerPasswordWarning: () => undefined,
}));
vi.mock('../src/db/connection.js', () => ({ openCuratorDb: () => state.db }));
vi.mock('../src/settings.js', () => ({
  CuratorSettingsClient: class {
    async seedIfNeeded() {}
    warnStaleEnv() {}
    async effective() { await state.settings(); return { settings: {}, catalog: {} }; }
    async effectiveStrict() { return this.effective(); }
  },
  buildRuntimeConfig: () => ({ curatorSweepAt: '05:00', curatorTz: 'UTC', modelProviders: {} }),
}));
vi.mock('../src/llm/index.js', () => ({ createDispatchingLlmClient: () => ({}) }));
vi.mock('../src/usage-reporter.js', () => ({ UsageReporter: class { wrap(llm: unknown) { return llm; } }, openRouterKeyRef: () => undefined }));
vi.mock('../src/engine.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/engine.js')>(),
  Engine: class {
    setRecorder() {}
    setSpendObserver() {}
    async inspectProvenance() {
      state.events.push('work-start');
      await state.work();
      // A terminal identity conflict exercises the refresh worker's durable write.
      return { select: 'status', vault_namespace: 'changed-vault' };
    }
    async listNodesWithField() {
      state.events.push('wiki-fields-read');
      await state.wikiFields();
      return [];
    }
    async close() { state.events.push('engine-close'); }
  },
}));
vi.mock('../src/home-refresh-preview.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/home-refresh-preview.js')>(),
  previewHomeRefresh: async () => {
    await state.validate();
    return { eligible: true, reasons: [], guard: state.guard };
  },
}));
vi.mock('../src/core.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core.js')>(),
  runSweep: async (deps: CoreDeps) => deps.queue.enqueue('scheduled test work', async () => {
    state.events.push('work-start');
    await state.work();
    deps.db!.prepare('SELECT 1').get();
    state.events.push('work-finish');
    return [];
  }),
}));
vi.mock('../src/scheduler.js', () => ({
  SWEEP_INTERVAL_MS: 1,
  needsCatchUp: () => state.catchUp,
  startScheduler: (options: { sweep: () => Promise<void> }) => {
    state.sweep = options.sweep;
    return { stop: () => state.events.push('scheduler-stop') };
  },
}));
vi.mock('../src/transport/http.js', () => ({
  startHttpTransport: async (factory: () => McpServer) => {
    factory();
    return { httpServer: {
      closeIdleConnections() {},
      // An already-disconnected client leaves no socket for HTTP.close to await.
      close(done: () => void) { state.events.push('http-close'); done(); },
    } };
  },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const extra = { authInfo: { scopes: ['curate:trigger', 'curate:read'] } };

async function boot(options: { catchUp?: boolean; settings?: () => Promise<void>; wikiFields?: () => Promise<void> } = {}) {
  vi.resetModules();
  state.events = [];
  state.db = new Database(':memory:');
  state.settings = options.settings ?? (async () => {});
  state.wikiFields = options.wikiFields ?? (async () => {});
  state.catchUp = options.catchUp ?? false;
  state.validate = async () => {};
  state.work = async () => {};
  state.guard = { version: 1, vault_namespace: 'vault', project_id: 'project', home_node_id: 'home',
    output_revision_id: 'output', home_version: 1, topology_hash: 'topology',
    configuration_digest: 'config', corrections_digest: 'corrections' };
  const handlers = new Map<string, ToolHandler<any>>();
  vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation((name, _config, handler) => {
    handlers.set(name, handler as ToolHandler<any>);
    return {} as ReturnType<McpServer['registerTool']>;
  });
  const ready = deferred();
  const exited = deferred();
  let shutdown!: () => void;
  vi.spyOn(process, 'on').mockImplementation(((name: string, callback: () => void) => {
    if (name === 'SIGTERM') shutdown = callback;
    if (name === 'SIGINT') ready.resolve();
    return process;
  }) as typeof process.on);
  vi.spyOn(process, 'exit').mockImplementation((() => {
    state.events.push('exit'); exited.resolve();
  }) as typeof process.exit);
  await import('../src/server.js');
  await ready.promise;
  const request = () => ({ request_id: randomUUID(), confirm_paid: true, guard: state.guard });
  return { handlers, shutdown, exited: exited.promise, request };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (state.db?.open) state.db.close();
});

it('waits for a disconnected refresh handler validating its guard, then drains its detached work', async () => {
  const f = await boot();
  const validating = deferred();
  const validation = deferred();
  const workStarted = deferred();
  const work = deferred();
  state.validate = () => { validating.resolve(); return validation.promise; };
  state.work = () => { workStarted.resolve(); return work.promise; };
  const request = f.request();
  let finalPhase: string | undefined;
  const closeDb = state.db!.close.bind(state.db);
  vi.spyOn(state.db!, 'close').mockImplementation(() => {
    finalPhase = (state.db!.prepare('SELECT phase FROM home_refresh_requests WHERE request_id = ?')
      .get(request.request_id) as { phase: string }).phase;
    return closeDb();
  });
  const accepted = f.handlers.get('refresh-wiki-page')!(request, extra);
  await validating.promise;
  f.shutdown();
  // Let the old queue-only drain and immediate socket close finish, if present.
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(state.events).not.toContain('engine-close');
  expect(state.db!.open).toBe(true);
  validation.resolve();
  expect(await accepted).not.toHaveProperty('isError', true);
  await workStarted.promise;
  expect(state.events).not.toContain('engine-close');
  work.resolve();
  await f.exited;
  expect(finalPhase).toBe('conflict');
  expect(state.events.indexOf('engine-close')).toBeGreaterThan(state.events.indexOf('work-start'));
  expect(state.db!.open).toBe(false);
});

it('stops new tool admissions before loading dependencies during shutdown', async () => {
  const f = await boot();
  let dependencyReads = 0;
  state.settings = async () => { dependencyReads++; };
  state.validate = async () => { dependencyReads++; };
  f.shutdown();
  const result = await f.handlers.get('refresh-wiki-page')!(f.request(), extra);
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, error: { code: 'SHUTTING_DOWN' } });
  expect(await f.handlers.get('curate-project-wiki')!({ project: 'Project', dry_run: true }, extra))
    .toMatchObject({ isError: true });
  await state.sweep();
  expect(dependencyReads).toBe(0);
  await f.exited;
});

it.each(['scheduled', 'startup'])('waits for a %s sweep loading fresh dependencies before its queue admission', async kind => {
  const loading = deferred();
  const settings = deferred();
  const workStarted = deferred();
  const work = deferred();
  let reads = 0;
  const f = await boot({ catchUp: kind === 'startup', settings: () => {
    if (++reads <= 2) return Promise.resolve();
    loading.resolve();
    return settings.promise;
  } });
  state.work = () => { workStarted.resolve(); return work.promise; };
  const accepted = kind === 'scheduled' ? state.sweep() : Promise.resolve();
  await loading.promise;
  f.shutdown();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(state.events).not.toContain('engine-close');
  settings.resolve();
  await workStarted.promise;
  expect(state.events).not.toContain('engine-close');
  work.resolve();
  await accepted;
  await f.exited;
  expect(state.events.indexOf('work-finish')).toBeLessThan(state.events.indexOf('engine-close'));
});

it('runs the wiki field check at startup as tracked work, so shutdown waits for it under its label (#385)', async () => {
  const reading = deferred();
  const read = deferred();
  const f = await boot({ wikiFields: () => { reading.resolve(); return read.promise; } });
  await reading.promise;
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  try {
    f.shutdown();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines.join('')).toMatch(/shutdown: still waiting after 30s on the wiki field check \(since [^)]+\)/);
    expect(state.events).not.toContain('engine-close');
    read.resolve();
    await f.exited;
  } finally {
    vi.useRealTimers();
  }
  expect(state.events.filter(e => e === 'wiki-fields-read')).toHaveLength(1); // no new check after shutdown began
  expect(state.events.indexOf('wiki-fields-read')).toBeLessThan(state.events.indexOf('engine-close'));
});

it('lets a sweep run for the grace period, then refuses new calls, then exits at the limit instead of waiting for SIGKILL (#405)', async () => {
  const f = await boot();
  const workStarted = deferred();
  state.work = () => { workStarted.resolve(); return new Promise<void>(() => {}); };
  void state.sweep();
  await workStarted.promise;
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  try {
    f.shutdown();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines.join('')).toMatch(/shutdown: still waiting after 30s on the daily sweep \(since [^)]+\); queue: scheduled test work/);
    await vi.advanceTimersByTimeAsync(269_999);
    expect(lines.join('')).not.toMatch(/refusing new model calls/);
    await vi.advanceTimersByTimeAsync(1);
    expect(lines.join('')).toMatch(/shutdown: refusing new model calls after 300s; the daily sweep .* stops at its next call/);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines.join('')).toMatch(/shutdown: still waiting after 330s on the daily sweep/);
    expect(state.events).not.toContain('exit');
    await vi.advanceTimersByTimeAsync(90_000);
    await f.exited;
  } finally {
    vi.useRealTimers();
  }
  expect(lines.join('')).toMatch(/shutdown: gave up after 420s; exiting with the daily sweep .* still running/);
  expect(state.events.slice(-2)).toEqual(['engine-close', 'exit']);
  expect(state.db!.open).toBe(false);
});
