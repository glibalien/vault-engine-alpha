import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { runMemorySweep } from '../src/memory-sweep.js';
import { runMemoryNoteRefresh } from '../src/memory-note-refresh.js';
import { runSweep, type CoreDeps } from '../src/core.js';
import { CurationQueue } from '../src/queue.js';
import { Engine, type EngineClientFactory } from '../src/engine.js';
import type { Config } from '../src/config.js';
import type { LlmClient } from '../src/llm/types.js';

/** query-nodes answers as Engine does: an empty `one_of` fails its input schema. */
function engineRejectingEmptyOneOf(calls: string[]): Engine {
  const factory: EngineClientFactory = () => ({
    transport: { close: async () => {} },
    client: {
      connect: async () => {},
      callTool: async (req) => {
        calls.push(req.name);
        const fields = (req.arguments.fields ?? {}) as Record<string, { one_of?: unknown[] }>;
        if (req.name === 'query-nodes' && Object.values(fields).some(f => Array.isArray(f.one_of) && f.one_of.length === 0)) {
          return { isError: true, content: [{ type: 'text', text: 'MCP error -32602: Input validation error: Invalid arguments for tool query-nodes: one_of Too small: expected array to have >=1 items' }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes: [] }, warnings: [] }) }] };
      },
    },
  });
  return new Engine({ engineUrl: 'http://localhost:3334', engineToken: 't' } as Config, factory);
}

describe('runSweep with an empty active-status list (#454)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('curates no projects and still runs the phases after the wiki work', async () => {
    const calls: string[] = [];
    const deps: CoreDeps = {
      engine: engineRejectingEmptyOneOf(calls),
      llm: { structuredCall: async () => { throw new Error('unused'); } } as LlmClient,
      config: {
        activeStatuses: [], projectType: 'project', projectStatusField: 'status',
        wikiReconciliationMode: 'live', journalEnabled: false,
      } as unknown as Config,
      queue: new CurationQueue(),
    };

    await expect(runSweep(deps, { dryRun: false, force: false, trigger: 'scheduled' })).resolves.toEqual([]);

    expect(calls).not.toContain('query-nodes');
    expect(runMemorySweep).toHaveBeenCalledTimes(1);
    expect(runMemoryNoteRefresh).toHaveBeenCalledTimes(1);
  });
});
