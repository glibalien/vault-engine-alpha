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

import { runConversationCaptureSweep, type ConversationCaptureSweepResult } from '../src/conversation-capture-sweep.js';
import { runFieldGuessSweep } from '../src/field-guess/sweep.js';
import { runConversationSweep } from '../src/conversation-sweep.js';
import { runMemorySweep } from '../src/memory-sweep.js';
import { runMemoryNoteRefresh } from '../src/memory-note-refresh.js';
import { runOrgSweep } from '../src/org-sweep.js';
import { runReconcile } from '../src/reconcile.js';
import { curateOne, runSweep, triggerCuration, type CoreDeps } from '../src/core.js';
import { CurationQueue } from '../src/queue.js';
import type { Config } from '../src/config.js';
import type { Engine } from '../src/engine.js';
import type { LlmClient } from '../src/llm/types.js';

function makeDeps(events: string[], active = [{ id: 'p1', title: 'Project', file_path: '', status: 'open' }]): CoreDeps {
  return {
    engine: {
      listActiveProjects: async () => {
        events.push('wiki:list-active-projects');
        return active;
      },
    } as unknown as Engine,
    llm: { structuredCall: async () => { throw new Error('unused'); } } as LlmClient,
    config: {
      activeStatuses: ['open'],
      wikiReconciliationMode: 'live',
      conversationCaptureMode: 'preview',
    } as unknown as Config,
    queue: new CurationQueue(),
  };
}

function captureResult(overrides: Partial<ConversationCaptureSweepResult> = {}): ConversationCaptureSweepResult {
  return {
    ran: true,
    dryRun: false,
    scanned: 1,
    settled: 1,
    belowFloor: 0,
    unchanged: 0,
    unreliable: 0,
    protectedOnly: 0,
    evaluated: 1,
    notValuable: 0,
    fullyCovered: 0,
    partiallyCovered: 0,
    ungrounded: 0,
    coverageCalls: 0,
    uncoveredArtifacts: 0,
    partiallyCoveredArtifacts: 0,
    fullyCoveredArtifacts: 0,
    wouldCreate: 0,
    created: 0,
    wouldAppend: 1,
    appended: 0,
    deferred: 0,
    errors: 0,
    proposals: [],
    ...overrides,
  };
}

describe('runSweep conversation capture integration (task 10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs capture, then field guessing, before wiki work and the existing scheduled phases', async () => {
    const events: string[] = [];
    const deps = makeDeps(events, []);
    (runConversationCaptureSweep as Mock).mockImplementation(async () => {
      events.push('capture:list-conversations');
      return { ran: true, dryRun: true };
    });
    vi.mocked(runFieldGuessSweep).mockImplementation(async () => {
      events.push('field-guess:candidates');
      return { ran: false, dryRun: false } as never;
    });
    (runMemorySweep as Mock).mockImplementation(async () => { events.push('memory-sweep'); return { ran: false }; });
    (runConversationSweep as Mock).mockImplementation(async () => { events.push('conversation-sweep'); return { ran: false, dryRun: false }; });
    (runOrgSweep as Mock).mockImplementation(async () => { events.push('org-sweep'); return { ran: false }; });
    (runReconcile as Mock).mockImplementation(async () => { events.push('reconcile'); return { ran: false }; });
    (runMemoryNoteRefresh as Mock).mockImplementation(async () => {
      events.push('memory-note-refresh');
      return { ran: false, file_written: false, live_count: 0, historical_count: 0, total: 0, issues_rendered: 0, error: null };
    });

    await runSweep(deps, { dryRun: false, force: false, trigger: 'scheduled' });

    expect(events).toEqual([
      'capture:list-conversations',
      'field-guess:candidates',
      'wiki:list-active-projects',
      'memory-sweep', 'conversation-sweep', 'org-sweep', 'reconcile', 'memory-note-refresh',
    ]);
  });

  it('reports the full preview result before wiki observability without changing wiki onResult', async () => {
    const events: string[] = [];
    const deps = makeDeps(events, []);
    const preview = captureResult({
      dryRun: true,
      proposals: [{
        captureId: 'cap-preview', conversationId: 'conversation-preview', conversationTitle: 'Preview chat',
        destinationKind: 'appended', destinationTitle: 'Linked note', destinationNodeId: 'node-linked',
        body: '<!-- exact preview -->\nMarkdown body',
      }],
    });
    const onConversationCaptureResult = vi.fn((result: ConversationCaptureSweepResult) => {
      events.push(`capture:callback:${result.proposals[0]?.captureId}`);
    });
    const onResult = vi.fn((result) => events.push(`wiki:result:${result.project}`));
    (runConversationCaptureSweep as Mock).mockImplementation(async () => {
      events.push('capture:run');
      return preview;
    });

    await runSweep(deps, {
      dryRun: true, preview: true, force: false, trigger: 'cli',
      onConversationCaptureResult, onResult,
    });

    expect(onConversationCaptureResult).toHaveBeenCalledWith(preview);
    expect(events).toEqual([
      'capture:run', 'capture:callback:cap-preview', 'wiki:list-active-projects',
    ]);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('reports off and captured error results through the dedicated callback', async () => {
    const offResult = captureResult({ ran: false, dryRun: false, detail: 'mode off' });
    const offCallback = vi.fn();
    (runConversationCaptureSweep as Mock).mockResolvedValueOnce(offResult);

    await runSweep(makeDeps([], []), {
      dryRun: false, force: false, trigger: 'scheduled', onConversationCaptureResult: offCallback,
    });

    expect(offCallback).toHaveBeenCalledWith(offResult);

    const errorCallback = vi.fn();
    (runConversationCaptureSweep as Mock).mockRejectedValueOnce(new Error('capture exploded'));
    await runSweep(makeDeps([], []), {
      dryRun: true, preview: true, force: false, trigger: 'scheduled', onConversationCaptureResult: errorCallback,
    });

    expect(errorCallback).toHaveBeenCalledWith(expect.objectContaining({
      ran: false, dryRun: true, detail: 'capture sweep failed: capture exploded',
      coverageCalls: 0, uncoveredArtifacts: 0, partiallyCoveredArtifacts: 0, fullyCoveredArtifacts: 0,
      errors: 1, proposals: [],
    }));
  });

  it('runs capture when scheduled wiki reconciliation is off or no projects are active', async () => {
    const events: string[] = [];
    const deps = makeDeps(events, []);
    deps.config = { ...deps.config, wikiReconciliationMode: 'off' } as Config;

    await runSweep(deps, { dryRun: false, force: false, trigger: 'scheduled' });

    expect(runConversationCaptureSweep).toHaveBeenCalledWith(deps, { dryRun: false, trigger: 'scheduled' });
    expect(events).not.toContain('wiki:list-active-projects');
  });

  it.each([
    ['scheduled', 'scheduled'],
    ['CLI', 'cli'],
  ] as const)('forwards a preview dry run to capture for %s all-project sweeps; a plain dry run skips it', async (_label, trigger) => {
    const deps = makeDeps([], []);

    await runSweep(deps, { dryRun: true, preview: true, force: false, trigger });

    expect(runConversationCaptureSweep).toHaveBeenCalledWith(deps, { dryRun: true, trigger });
    (runConversationCaptureSweep as Mock).mockClear();
    await runSweep(deps, { dryRun: true, force: false, trigger });
    expect(runConversationCaptureSweep).not.toHaveBeenCalled();
  });

  it('runs capture for an all-project triggerCuration call but never for one project', async () => {
    const deps = makeDeps([], []);

    await triggerCuration(deps, { force: false, dryRun: false, project: null }, 'on-demand');
    expect(runConversationCaptureSweep).toHaveBeenCalledTimes(1);
    await curateOne(deps, 'Project', { dryRun: false, force: false, trigger: 'on-demand' });
    await triggerCuration(deps, { force: false, dryRun: false, project: 'Project' }, 'on-demand');

    expect(runConversationCaptureSweep).toHaveBeenCalledTimes(1);
  });

  it('never invokes an all-project capture callback from curateOne', async () => {
    const callback = vi.fn();
    const deps = makeDeps([], []);

    await runSweep(deps, {
      dryRun: false, force: false, trigger: 'cli', onConversationCaptureResult: callback,
    });
    await curateOne(deps, 'Project', { dryRun: false, force: false, trigger: 'cli' });

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('keeps wiki onResult limited to wiki results when capture reporting is enabled', async () => {
    const deps = makeDeps([], []);
    deps.config = { ...deps.config, wikiReconciliationMode: 'off' } as Config;
    const onConversationCaptureResult = vi.fn();
    const onResult = vi.fn();

    await runSweep(deps, {
      dryRun: false, force: false, trigger: 'scheduled', onConversationCaptureResult, onResult,
    });

    expect(onConversationCaptureResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      project: 'Scheduled wiki reconciliation', outcome: 'skipped_mode_disabled',
    }));
    expect(onResult.mock.calls[0]?.[0]).not.toHaveProperty('proposals');
  });

  it('swallows a capture regression and continues into wiki work', async () => {
    const events: string[] = [];
    const deps = makeDeps(events, []);
    vi.mocked(runConversationCaptureSweep).mockRejectedValueOnce(new Error('capture failed'));

    const results = await runSweep(deps, { dryRun: false, force: false, trigger: 'scheduled' });

    expect(results).toEqual([]);
    expect(runFieldGuessSweep).toHaveBeenCalledTimes(1);
    expect(events).toContain('wiki:list-active-projects');
  });
});
