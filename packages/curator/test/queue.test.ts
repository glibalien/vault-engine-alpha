import { describe, expect, it } from 'vitest';
import { CurationQueue } from '../src/queue.js';

describe('CurationQueue', () => {
  it('runs tasks strictly one at a time', async () => {
    const q = new CurationQueue();
    let active = 0;
    let maxActive = 0;
    const task = () => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return 'ok';
    };
    await Promise.all([q.enqueue('a', task()), q.enqueue('b', task())]);
    expect(maxActive).toBe(1);
  });

  it('returns each task its own result', async () => {
    const q = new CurationQueue();
    const r = await Promise.all([q.enqueue('a', async () => 1), q.enqueue('b', async () => 2)]);
    expect(r).toEqual([1, 2]);
  });

  it('a rejected task does not wedge the queue', async () => {
    const q = new CurationQueue();
    await expect(q.enqueue('bad', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(q.enqueue('good', async () => 'ok')).resolves.toBe('ok');
  });

  it('reports depth/current/running across the lifecycle', async () => {
    const q = new CurationQueue();
    expect(q.state).toEqual({ running: false, depth: 0, current: undefined });
    let started!: () => void;
    const didStart = new Promise<void>((r) => { started = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = q.enqueue('work', async () => { started(); await gate; return 'done'; });
    await didStart;
    expect(q.state).toEqual({ running: true, depth: 1, current: 'work' });
    release();
    await p;
    expect(q.state).toEqual({ running: false, depth: 0, current: undefined });
  });

  it('counts queued tasks in depth while one runs', async () => {
    const q = new CurationQueue();
    let firstStarted!: () => void;
    const firstRunning = new Promise<void>((r) => { firstStarted = r; });
    let releaseFirst!: () => void;
    const gate1 = new Promise<void>((r) => { releaseFirst = r; });
    const p1 = q.enqueue('first', async () => { firstStarted(); await gate1; return 1; });
    const p2 = q.enqueue('second', async () => 2);
    await firstRunning;
    expect(q.state).toEqual({ running: true, depth: 2, current: 'first' });
    releaseFirst();
    await Promise.all([p1, p2]);
    expect(q.state).toEqual({ running: false, depth: 0, current: undefined });
  });
});
