import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../src/conversation-capture-sweep.js', () => ({
  runConversationCaptureSweep: vi.fn(async () => ({ ran: false, dryRun: false })),
}));
vi.mock('../src/field-guess/sweep.js', () => ({
  runFieldGuessSweep: vi.fn(async () => ({ ran: false, dryRun: false })),
}));
vi.mock('../src/memory-sweep.js', () => ({ runMemorySweep: vi.fn(async () => ({ ran: false })) }));
vi.mock('../src/conversation-sweep.js', () => ({ runConversationSweep: vi.fn(async () => ({ ran: false, dryRun: false })) }));
vi.mock('../src/org-sweep.js', () => ({ runOrgSweep: vi.fn(async () => ({ ran: false })) }));
vi.mock('../src/reconcile.js', () => ({ runReconcile: vi.fn(async () => ({ ran: false })) }));
vi.mock('../src/memory-note-refresh.js', () => ({
  runMemoryNoteRefresh: vi.fn(async () => ({ ran: false, file_written: false, live_count: 0, historical_count: 0, total: 0, issues_rendered: 0, error: null })),
}));

import { runMemoryNoteRefresh } from '../src/memory-note-refresh.js';
import { runSweep, type CoreDeps } from '../src/core.js';
import { CurationQueue } from '../src/queue.js';
import type { Config } from '../src/config.js';
import type { Engine } from '../src/engine.js';
import type { ActionRecorder, JournalRunContext } from '../src/journal/recorder.js';
import type { LlmClient } from '../src/llm/types.js';

describe('runSweep memory note refresh journaling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records the refreshed note under its own run context and clears it after', async () => {
    let context: JournalRunContext | null = null;
    const recorded: Array<{ action: string; context: JournalRunContext | null }> = [];
    const recorder = {
      setContext: vi.fn((next: JournalRunContext | null) => { context = next; }),
      record: vi.fn((event: { action: string }) => { recorded.push({ action: event.action, context }); }),
      summary: vi.fn(),
    } as unknown as ActionRecorder;
    (runMemoryNoteRefresh as Mock).mockImplementation(async () => ({
      ran: true, file_written: true, live_count: 3, historical_count: 1, total: 4, issues_rendered: 0, error: null,
    }));
    const deps: CoreDeps = {
      engine: { listActiveProjects: async () => [] } as unknown as Engine,
      llm: { structuredCall: async () => { throw new Error('unused'); } } as LlmClient,
      config: { activeStatuses: ['open'], wikiReconciliationMode: 'live', journalEnabled: false } as unknown as Config,
      queue: new CurationQueue(),
      recorder,
    };

    await runSweep(deps, { dryRun: false, force: false, trigger: 'scheduled' });

    expect(recorded).toEqual([{
      action: 'memory-note-refreshed',
      context: expect.objectContaining({ fn: 'memory-note-refresh', trigger: 'scheduled', runRef: expect.any(String) }),
    }]);
    expect(context).toBeNull();
  });
});
