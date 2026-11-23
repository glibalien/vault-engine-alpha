import { describe, expect, it, vi } from 'vitest';
import { BackgroundBuilds } from '../src/background-builds.js';
import { ServerLifecycle, finishWithin } from '../src/server-lifecycle.js';

describe('BackgroundBuilds', () => {
  it('starts work once per key until it settles, and hands it to keepAlive', async () => {
    const kept: Promise<unknown>[] = [];
    const builds = new BackgroundBuilds((work) => { kept.push(work); });
    let release!: () => void;
    const work = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const first = builds.start('project:Atlas', 'build', 'p-1', work);
    expect(first).toMatchObject({ started: true, build: { projectId: 'p-1', since: expect.any(String) } });
    expect(work).toHaveBeenCalledTimes(1); // started synchronously, so it is queued before the reply
    const second = builds.start('project:Atlas', 'build', 'p-1', work);
    expect(second).toEqual({ started: false, build: first.build });
    expect(builds.get('project:Atlas')).toBe(first.build);
    expect(builds.start('project:Other', 'build', null, async () => {}).started).toBe(true);
    release();
    await Promise.all(kept);
    expect(builds.get('project:Atlas')).toBeUndefined();
    expect(builds.start('project:Atlas', 'build', 'p-1', async () => {}).started).toBe(true);
  });

  it('registers a build under every name its project goes by', async () => {
    const kept: Promise<unknown>[] = [];
    const builds = new BackgroundBuilds((work) => { kept.push(work); });
    let release!: () => void;
    const first = builds.start(['project:p-1', 'project:Atlas', 'project:Atlas'], 'build', 'p-1', () => new Promise<void>((r) => { release = r; }));
    expect(builds.get('project:p-1')).toBe(first.build);
    expect(builds.get('project:Atlas')).toBe(first.build);
    expect(builds.start(['project:Atlas Renamed', 'project:p-1'], 'build', 'p-1', async () => {})).toEqual({ started: false, build: first.build });
    expect(builds.get('project:Atlas Renamed')).toBeUndefined();
    release();
    await Promise.all(kept);
    expect(builds.get('project:p-1')).toBeUndefined();
    expect(builds.get('project:Atlas')).toBeUndefined();
  });

  it('logs a failed or throwing build instead of rejecting, and frees its key', async () => {
    const kept: Promise<unknown>[] = [];
    const log = vi.fn();
    const builds = new BackgroundBuilds((work) => { kept.push(work); }, log);
    builds.start('a', 'build a', null, async () => { throw new Error('engine down'); });
    builds.start('b', 'build b', null, () => { throw new Error('sync boom'); });
    await Promise.all(kept); // never rejects
    expect(log.mock.calls.map(([line]) => line)).toEqual(['build a failed: engine down', 'build b failed: sync boom']);
    expect(builds.get('a')).toBeUndefined();
    expect(builds.get('b')).toBeUndefined();
  });
});

describe('BackgroundBuilds interruption (#405)', () => {
  it('records each unfinished build once, under its label, and forgets builds that settled', async () => {
    const kept: Array<[Promise<unknown>, string]> = [];
    const log = vi.fn();
    const builds = new BackgroundBuilds((work, label) => { kept.push([work, label]); }, log);
    const recorded: string[] = [];
    builds.start(['project:p-1', 'project:Atlas'], 'curation of Atlas', 'p-1', () => new Promise(() => {}),
      detail => recorded.push(`Atlas: ${detail}`));
    builds.start('sweep', 'on-demand sweep', null, () => new Promise(() => {}), () => { throw new Error('db closed'); });
    builds.start('project:Done', 'curation of Done', null, async () => {}, detail => recorded.push(`Done: ${detail}`));
    builds.start('project:Plain', 'curation of Plain', null, () => new Promise(() => {}));
    expect(kept.map(([, label]) => label)).toEqual(['curation of Atlas', 'on-demand sweep', 'curation of Done', 'curation of Plain']);
    await kept[2]![0];
    expect(builds.interruptAll('interrupted')).toEqual(['curation of Atlas', 'on-demand sweep', 'curation of Plain']);
    expect(recorded).toEqual(['Atlas: interrupted']);
    expect(log).toHaveBeenCalledWith('on-demand sweep: interruption not recorded: db closed');
    expect(builds.interruptAll('again')).toEqual([]);
    expect(recorded).toHaveLength(1);
  });
});

describe('finishWithin (#405)', () => {
  it('reports what it waits on at each interval and gives up at the limit', async () => {
    vi.useFakeTimers();
    try {
      const waiting = vi.fn();
      const stuck = finishWithin(new Promise(() => {}), 120_000, 30_000, waiting);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(waiting.mock.calls.map(([elapsed]) => elapsed)).toEqual([30_000, 60_000, 90_000]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await stuck).toBe(false);
      let release!: () => void;
      const done = finishWithin(new Promise<void>(r => { release = r; }), 120_000, 30_000, () => { throw new Error('log failed'); });
      await vi.advanceTimersByTimeAsync(45_000);
      release();
      expect(await done).toBe(true);
      expect(await finishWithin(Promise.reject(new Error('failed work')), 120_000, 30_000, () => {})).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ServerLifecycle', () => {
  it('lists tracked work by label, oldest first, until it settles', async () => {
    const lifecycle = new ServerLifecycle();
    let release!: () => void;
    const build = new Promise<void>((r) => { release = r; });
    lifecycle.keepAlive(build, 'curation of Atlas');
    await new Promise((r) => setTimeout(r, 2));
    const call = lifecycle.run(() => new Promise<void>(() => {}));
    expect(call).toBeDefined();
    expect(lifecycle.pending().map(p => p.label)).toEqual(['curation of Atlas', 'a tool call']);
    release();
    await build;
    await new Promise((r) => setTimeout(r, 0));
    expect(lifecycle.pending().map(p => p.label)).toEqual(['a tool call']);
  });

  it('stop waits for work an accepted call hands to keepAlive, even after stop began', async () => {
    const lifecycle = new ServerLifecycle();
    let releaseCall!: () => void;
    let releaseBuild!: () => void;
    const build = new Promise<void>((r) => { releaseBuild = r; });
    const call = lifecycle.run(async () => {
      await new Promise<void>((r) => { releaseCall = r; });
      lifecycle.keepAlive(build); // the call replies, its build keeps running
    });
    expect(call).toBeDefined();
    let stopped = false;
    const stopping = lifecycle.stop().then(() => { stopped = true; });
    expect(lifecycle.run(async () => {})).toBeUndefined(); // admission closed
    await new Promise((r) => setTimeout(r, 0)); // the call's action has started
    releaseCall();
    await call;
    await new Promise((r) => setTimeout(r, 0));
    expect(stopped).toBe(false);
    releaseBuild();
    await stopping;
    expect(stopped).toBe(true);
  });
});
