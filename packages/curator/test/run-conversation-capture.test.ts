import { defaultsFor, SEED_MODELS } from '@vault/settings-registry';
import type { CuratorSettings } from '@vault/settings-registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapConfig } from '../src/config.js';
import type { ConversationCaptureSweepResult } from '../src/conversation-capture-sweep.js';
import type { Engine } from '../src/engine.js';

vi.mock('../src/settings.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/settings.js')>(),
  loadRuntimeConfig: vi.fn(),
}));
vi.mock('../src/core.js', () => ({ runSweep: vi.fn(), curateOne: vi.fn() }));

import { runSweep } from '../src/core.js';
import { buildRuntimeConfig, loadRuntimeConfig } from '../src/settings.js';

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe('CLI conversation capture reporting', () => {
  it('prints preview counts and exact proposals in preview mode without --dry-run', async () => {
    const bootstrap: BootstrapConfig = {
      engineUrl: 'http://engine.test', engineToken: 'test-token', experiment: null, variant: null,
      llmKeys: { keys: {}, baseURLs: { fireworks: 'https://provider.test' } },
      oauthOwnerPassword: undefined, oauthIssuerUrl: undefined,
      curatorPort: 3335, curatorDbPath: ':memory:', memorySweepSince: null, conversationSweepSince: null,
    };
    const catalog = [...SEED_MODELS];
    const config = buildRuntimeConfig(bootstrap, {
      ...defaultsFor('curator'), conversationCaptureMode: 'preview',
    } as unknown as CuratorSettings, catalog);
    const engine = {
      connect: vi.fn(async () => {}), close: vi.fn(async () => {}), setRecorder: vi.fn(), setSpendObserver: vi.fn(),
    };
    vi.mocked(loadRuntimeConfig).mockResolvedValue({ bootstrap, config, engine: engine as unknown as Engine, catalog });
    const proposalBody = '## Captured idea\n\nKeep **exact Markdown** and  two spaces.\n';
    const preview: ConversationCaptureSweepResult = {
      ran: true, dryRun: true, scanned: 1, settled: 1, belowFloor: 0, unchanged: 0,
      unreliable: 0, protectedOnly: 0, evaluated: 1, notValuable: 0, fullyCovered: 0,
      partiallyCovered: 0, ungrounded: 0, coverageCalls: 0, uncoveredArtifacts: 1,
      partiallyCoveredArtifacts: 0, fullyCoveredArtifacts: 0, wouldCreate: 0, created: 0,
      wouldAppend: 1, appended: 0, deferred: 0, errors: 0,
      proposals: [{
        captureId: 'cap-preview', conversationId: 'conversation-preview', conversationTitle: 'Preview chat',
        destinationKind: 'appended', destinationTitle: 'Linked note', destinationNodeId: 'node-linked',
        body: proposalBody,
      }],
    };
    vi.mocked(runSweep).mockImplementation(async (_deps, options) => {
      options.onConversationCaptureResult?.(preview);
      return [];
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = ['node', 'run.ts'];

    await import('../src/run.js');
    await vi.waitFor(() => expect(engine.close).toHaveBeenCalled());

    expect(runSweep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dryRun: false }));
    const text = output.mock.calls.map(([line]) => line).join('\n');
    expect(text).toContain('Conversation capture preview — would create 0, would append 1');
    expect(text).toContain('conversation "Preview chat" (conversation-preview)');
    expect(text).toContain('capture cap-preview');
    expect(text).toContain('destination appended "Linked note" (node-linked)');
    expect(text).toContain(`--- begin exact body ---\n${proposalBody}\n--- end exact body ---`);
    expect(text).not.toContain('Conversation capture — created 0, appended 0');
  });
});
