import { describe, it, expect, vi } from 'vitest';
import { runMemoryNoteRefresh } from '../src/memory-note-refresh.js';
import type { Engine, MemoryNoteRefreshResult } from '../src/engine.js';
import type { Config } from '../src/config.js';

const cfg = {
  fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
  fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
} as Config;

function makeEngine(result: Partial<MemoryNoteRefreshResult> = {}): Engine {
  return {
    refreshMemoryNote: vi.fn(async () => ({
      file_path: 'Settings/Memories.md',
      node_id: 'n1',
      live_count: 10,
      historical_count: 2,
      total: 12,
      rendered_hash: 'sha256:abc',
      bytes: 5000,
      would_write: false,
      file_written: true,
      issues_rendered: 0,
      snapshot_at: '2026-08-13T09:00:00.000Z',
      ...result,
    })),
  } as unknown as Engine;
}

describe('runMemoryNoteRefresh', () => {
  it('skips refresh when trigger is not scheduled', async () => {
    const engine = makeEngine();
    const res = await runMemoryNoteRefresh(engine, cfg, { dryRun: false, trigger: 'cli' });
    expect(res.ran).toBe(false);
    expect(engine.refreshMemoryNote).not.toHaveBeenCalled();
  });

  it('skips refresh for on-demand trigger', async () => {
    const engine = makeEngine();
    const res = await runMemoryNoteRefresh(engine, cfg, { dryRun: false, trigger: 'on-demand' });
    expect(res.ran).toBe(false);
  });

  it('calls engine.refreshMemoryNote for scheduled trigger', async () => {
    const engine = makeEngine();
    const res = await runMemoryNoteRefresh(engine, cfg, { dryRun: false, trigger: 'scheduled' });
    expect(res.ran).toBe(true);
    expect(engine.refreshMemoryNote).toHaveBeenCalledWith(false);
    expect(res.file_written).toBe(true);
    expect(res.total).toBe(12);
  });

  it('passes dryRun through', async () => {
    const engine = makeEngine();
    await runMemoryNoteRefresh(engine, cfg, { dryRun: true, trigger: 'scheduled' });
    expect(engine.refreshMemoryNote).toHaveBeenCalledWith(true);
  });

  it('never rejects: an engine error is caught and reported', async () => {
    const engine = {
      refreshMemoryNote: vi.fn(async () => { throw new Error('engine down'); }),
    } as unknown as Engine;
    const res = await runMemoryNoteRefresh(engine, cfg, { dryRun: false, trigger: 'scheduled' });
    expect(res.ran).toBe(true);
    expect(res.file_written).toBe(false);
    expect(res.error).toBe('engine down');
  });
});
