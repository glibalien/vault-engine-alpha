import { describe, expect, it } from 'vitest';
import { formatConversationCaptureCliOutput } from '../src/capture-cli-output.js';
import type { ConversationCaptureSweepResult } from '../src/conversation-capture-sweep.js';

function result(overrides: Partial<ConversationCaptureSweepResult> = {}): ConversationCaptureSweepResult {
  return {
    ran: true,
    dryRun: true,
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

describe('formatConversationCaptureCliOutput', () => {
  it('renders each exact dry-run proposal body with ordered, complete operator identities', () => {
    const appendedBody = '  <!-- ve:chat-curation:start id="cap-append" -->\n## From chat\n\n- Exact **Markdown**  \n<!-- ve:chat-curation:end id="cap-append" -->\n';
    const createdBody = '\t# Standalone note\n\nParagraph with  two spaces.  \n\n`exact`\n';

    const lines = formatConversationCaptureCliOutput(result({
      proposals: [
        {
          captureId: 'cap-append', conversationId: 'conversation-append', conversationTitle: 'Research chat',
          destinationKind: 'appended', destinationTitle: 'Research note', destinationNodeId: 'node-append', body: appendedBody,
        },
        {
          captureId: 'cap-create', conversationId: 'conversation-create', conversationTitle: 'Design chat',
          destinationKind: 'created', destinationTitle: 'Standalone design note', body: createdBody,
        },
      ],
    }), true);
    const output = lines.join('\n');
    const appendedProposal = [
      'Capture proposal:',
      '  conversation "Research chat" (conversation-append)',
      '  capture cap-append',
      '  destination appended "Research note" (node-append)',
      `--- begin exact body ---\n${appendedBody}\n--- end exact body ---`,
    ].join('\n');
    const createdProposal = [
      'Capture proposal:',
      '  conversation "Design chat" (conversation-create)',
      '  capture cap-create',
      '  destination created "Standalone design note" (new node)',
      `--- begin exact body ---\n${createdBody}\n--- end exact body ---`,
    ].join('\n');

    expect(output).toContain('Conversation capture preview');
    expect(output).toContain(appendedProposal);
    expect(output).toContain(createdProposal);
    expect(output.indexOf(appendedProposal)).toBeLessThan(output.indexOf(createdProposal));
  });

  it('keeps non-dry-run output to concise counts and never prints proposal bodies', () => {
    const lines = formatConversationCaptureCliOutput(result({
      dryRun: false,
      created: 1,
      appended: 2,
      proposals: [{
        captureId: 'cap-live', conversationId: 'conversation-live', conversationTitle: 'Live chat',
        destinationKind: 'created', destinationTitle: 'New note', body: 'sensitive exact body',
      }],
    }), false);

    expect(lines.join('\n')).toContain('Conversation capture — created 1, appended 2');
    expect(lines.join('\n')).not.toContain('sensitive exact body');
    expect(lines.join('\n')).not.toContain('cap-live');
  });

  it.each([
    [{ coverageCalls: 0, uncoveredArtifacts: 0, partiallyCoveredArtifacts: 0, fullyCoveredArtifacts: 0 },
      'coverage: 0 calls; 0 uncovered, 0 partial, 0 full artifacts'],
    [{ coverageCalls: 1, uncoveredArtifacts: 1, partiallyCoveredArtifacts: 1, fullyCoveredArtifacts: 1 },
      'coverage: 1 call; 1 uncovered, 1 partial, 1 full artifact'],
    [{ coverageCalls: 3, uncoveredArtifacts: 2, partiallyCoveredArtifacts: 4, fullyCoveredArtifacts: 2 },
      'coverage: 3 calls; 2 uncovered, 4 partial, 2 full artifacts'],
  ] as const)('renders concise zero, singular, and plural coverage counts', (counts, expected) => {
    expect(formatConversationCaptureCliOutput(result(counts), false)).toContain(expected);
  });
});
