import type {
  ConversationCaptureProposal,
  ConversationCaptureSweepResult,
} from './conversation-capture-sweep.js';

function summary(result: ConversationCaptureSweepResult, dryRun: boolean): string {
  if (dryRun) {
    return `Conversation capture preview — would create ${result.wouldCreate}, would append ${result.wouldAppend}, deferred ${result.deferred}, errors ${result.errors}`;
  }
  return `Conversation capture — created ${result.created}, appended ${result.appended}, deferred ${result.deferred}, errors ${result.errors}`;
}

function countNoun(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function coverageSummary(result: ConversationCaptureSweepResult): string {
  return `coverage: ${result.coverageCalls} ${countNoun(result.coverageCalls, 'call')}; ${result.uncoveredArtifacts} uncovered, ${result.partiallyCoveredArtifacts} partial, ${result.fullyCoveredArtifacts} full ${countNoun(result.fullyCoveredArtifacts, 'artifact')}`;
}

function previewProposal(proposal: ConversationCaptureProposal): string {
  const destinationNode = proposal.destinationNodeId === undefined ? 'new node' : proposal.destinationNodeId;
  return [
    'Capture proposal:',
    `  conversation "${proposal.conversationTitle}" (${proposal.conversationId})`,
    `  capture ${proposal.captureId}`,
    `  destination ${proposal.destinationKind} "${proposal.destinationTitle}" (${destinationNode})`,
    '--- begin exact body ---',
    proposal.body,
    '--- end exact body ---',
  ].join('\n');
}

/** Render capture observability for the all-project CLI without persisting
 * proposal bodies to the journal or changing the wiki result callback. */
export function formatConversationCaptureCliOutput(
  result: ConversationCaptureSweepResult,
  dryRun: boolean,
): string[] {
  const lines = [summary(result, dryRun), coverageSummary(result)];
  if (dryRun) lines.push(...result.proposals.map(previewProposal));
  return lines;
}
