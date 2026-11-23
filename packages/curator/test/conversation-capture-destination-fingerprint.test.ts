import { describe, expect, it } from 'vitest';
import {
  destinationDecisionFingerprint,
  type DestinationDecisionEvidenceV1,
} from '../src/conversation-capture-destination-fingerprint.js';

const evidence: DestinationDecisionEvidenceV1[] = [
  {
    nodeId: 'node-a',
    state: 'eligible',
    plannerRecord: {
      id: 'node-a',
      title: 'Alpha',
      filePath: 'Notes/Alpha.md',
      bodyExcerpt: 'Planner-visible body',
    },
  },
  {
    nodeId: 'node-b',
    state: 'protected',
    reason: 'settings-path',
  },
];

describe('destinationDecisionFingerprint', () => {
  it('returns a v1 lowercase SHA-256 digest for the fixed-shape evidence payload', () => {
    expect(destinationDecisionFingerprint(evidence)).toEqual({
      version: 1,
      hash: 'cb2f520b23fbda98b42676dacb4fa9813d559b3da122f1cb2494847259683b97',
    });
  });

  it('is order-independent and does not mutate caller evidence', () => {
    const reversed = [...evidence].reverse();
    const original = JSON.parse(JSON.stringify(evidence)) as DestinationDecisionEvidenceV1[];
    expect(destinationDecisionFingerprint(reversed)).toEqual(destinationDecisionFingerprint(evidence));
    expect(reversed).toEqual([...evidence].reverse());
    expect(evidence).toEqual(original);
  });

  it('orders distinct collation-equivalent node IDs independently of caller order', () => {
    const canonicallyComposed = {
      nodeId: 'é',
      state: 'protected',
      reason: 'settings-path',
    } as const;
    const canonicallyDecomposed = {
      nodeId: 'e\u0301',
      state: 'protected',
      reason: 'schema-path',
    } as const;

    expect(destinationDecisionFingerprint([canonicallyComposed, canonicallyDecomposed]))
      .toEqual(destinationDecisionFingerprint([canonicallyDecomposed, canonicallyComposed]));
  });

  it('canonicalizes property order and ignores fields outside the planner evidence shape', () => {
    const reordered = [{
      state: 'eligible',
      plannerRecord: {
        bodyExcerpt: 'Planner-visible body',
        filePath: 'Notes/Alpha.md',
        title: 'Alpha',
        id: 'node-a',
        unrelatedEngineField: 'must not hash',
      },
      nodeId: 'node-a',
      nodeVersion: 42,
    }, {
      reason: 'settings-path',
      state: 'protected',
      nodeId: 'node-b',
      unrelatedEngineField: 'also ignored',
    }] as unknown as DestinationDecisionEvidenceV1[];
    expect(destinationDecisionFingerprint(reordered)).toEqual(destinationDecisionFingerprint(evidence));
  });

  it.each([
    ['title', { title: 'Changed' }],
    ['path', { filePath: 'Notes/Changed.md' }],
    ['body excerpt', { bodyExcerpt: 'Changed body' }],
  ])('changes when the eligible planner %s changes', (_label, change) => {
    const changed = structuredClone(evidence) as DestinationDecisionEvidenceV1[];
    if (changed[0]?.state === 'eligible') changed[0].plannerRecord = { ...changed[0].plannerRecord, ...change };
    expect(destinationDecisionFingerprint(changed).hash).not.toBe(destinationDecisionFingerprint(evidence).hash);
  });

  it.each([
    ['eligible to protected', [{ nodeId: 'node-a', state: 'protected', reason: 'settings-path' as const }, evidence[1]]],
    ['protected to eligible', [evidence[0], { nodeId: 'node-b', state: 'eligible', plannerRecord: { id: 'node-b', title: 'Beta', filePath: 'Notes/Beta.md', bodyExcerpt: 'Beta body' } }]],
    ['different protected reason', [evidence[0], { nodeId: 'node-b', state: 'protected', reason: 'schema-path' as const }]],
  ])('changes when destination classification changes: %s', (_label, changed) => {
    expect(destinationDecisionFingerprint(changed as DestinationDecisionEvidenceV1[]).hash)
      .not.toBe(destinationDecisionFingerprint(evidence).hash);
  });

  it('rejects duplicate IDs and mismatched eligible record IDs', () => {
    expect(() => destinationDecisionFingerprint([evidence[0]!, evidence[0]!])).toThrow(/duplicate/i);
    const eligible = evidence[0]!;
    if (eligible.state !== 'eligible') throw new Error('fixture must be eligible');
    expect(() => destinationDecisionFingerprint([{
      ...eligible, plannerRecord: { ...eligible.plannerRecord, id: 'other' },
    }])).toThrow(/match|mismatch/i);
  });
});
