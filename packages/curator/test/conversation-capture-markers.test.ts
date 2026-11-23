import { describe, expect, it } from 'vitest';
import {
  captureBlockDate,
  captureBlockHash,
  captureCompositionHash,
  captureId,
  captureTitleCandidates,
  captureIdMarkerQuery,
  conversationCaptureMarkerQuery,
  decodeCaptureMarkerAttribute,
  encodeCaptureMarkerAttribute,
  parseCaptureBlocks,
  renderCaptureBlock,
  stripCaptureBlocksForMemory,
} from '../src/conversation-capture-markers.js';

const fixture = {
  captureId: 'cap-123',
  conversationId: 'conversation-9',
  transcriptHash: 'transcript-hash',
  conversationTitle: '  A <useful> chat & follow-up  ',
  capturedOn: '2026-08-25',
  title: 'Vehicle <overview> & choices',
  markdown: 'A concise **summary**.',
  sourceUrls: ['https://example.test/a?x=1&y=2', 'https://example.test/b'],
  includeHeading: true,
};

describe('conversation capture markers', () => {
  it('renders a host-stamped linked block with escaped attribution and sources', () => {
    expect(renderCaptureBlock(fixture)).toBe([
      '<!-- ve:chat-curation:start id="cap-123" conversation="conversation-9" transcript-hash="transcript-hash" -->',
      '## From chat — Vehicle &lt;overview&gt; &amp; choices',
      '',
      'A concise **summary**.',
      '',
      '**Sources:** <https://example.test/a?x=1&y=2>, <https://example.test/b>',
      '',
      '_Curated from “A &lt;useful&gt; chat &amp; follow-up” on 2026-08-25._',
      '<!-- ve:chat-curation:end id="cap-123" -->',
    ].join('\n'));
  });

  it('does not add an append heading to a standalone note body', () => {
    const block = renderCaptureBlock({ ...fixture, includeHeading: false });
    expect(block).not.toContain('## From chat');
    expect(block).toContain('A concise **summary**.');
  });

  it('parses only a non-nested pair and preserves its exact stamped slice', () => {
    const block = renderCaptureBlock(fixture);
    const body = `Before\n\n${block}\n\nAfter`;

    expect(parseCaptureBlocks(body)).toEqual({
      ok: true,
      blocks: [expect.objectContaining({
        captureId: 'cap-123',
        conversationId: 'conversation-9',
        transcriptHash: 'transcript-hash',
        contentMarkdown: block,
        start: 8,
        end: 8 + block.length,
      })],
    });
  });

  it('uses one canonical attribute codec for render, parse, and lookup queries', () => {
    const captureIdValue = `cap-'\"<&>`;
    const conversationIdValue = `conversation-'\"<&>`;
    const block = renderCaptureBlock({ ...fixture, captureId: captureIdValue, conversationId: conversationIdValue });
    const encodedCaptureId = 'cap-&#39;&quot;&lt;&amp;&gt;';
    const encodedConversationId = 'conversation-&#39;&quot;&lt;&amp;&gt;';

    expect(encodeCaptureMarkerAttribute(captureIdValue)).toBe(encodedCaptureId);
    expect(decodeCaptureMarkerAttribute(encodedCaptureId)).toBe(captureIdValue);
    expect(block).toContain(`id="${encodedCaptureId}" conversation="${encodedConversationId}"`);
    expect(parseCaptureBlocks(block)).toMatchObject({
      ok: true,
      blocks: [{ captureId: captureIdValue, conversationId: conversationIdValue }],
    });
    expect(captureIdMarkerQuery(captureIdValue)).toBe(`ve:chat-curation:start id="${encodedCaptureId}"`);
    const conversationQuery = `conversation="${encodedConversationId}" transcript-hash=`;
    expect(conversationCaptureMarkerQuery(conversationIdValue)).toBe(conversationQuery);
    expect(block).toContain(conversationQuery);
  });

  it.each(['line\nbreak', 'carriage\rreturn', 'nul\0byte', 'control\u0085'])('rejects control characters in marker attributes: %s', (value) => {
    expect(() => encodeCaptureMarkerAttribute(value)).toThrow(/control/i);
    expect(() => renderCaptureBlock({ ...fixture, captureId: value })).toThrow(/control/i);
    expect(() => captureIdMarkerQuery(value)).toThrow(/control/i);
  });

  it.each([
    '<!-- ve:chat-curation:start id="raw&value" conversation="c" transcript-hash="h" -->\n<!-- ve:chat-curation:end id="raw&value" -->',
    '<!-- ve:chat-curation:start id="raw\'value" conversation="c" transcript-hash="h" -->\n<!-- ve:chat-curation:end id="raw\'value" -->',
    '<!-- ve:chat-curation:start id="&apos;" conversation="c" transcript-hash="h" -->\n<!-- ve:chat-curation:end id="&apos;" -->',
  ])('rejects non-canonical marker attribute encodings: %s', (body) => {
    expect(parseCaptureBlocks(body)).toMatchObject({ ok: false });
  });

  it('strips only paired capture blocks and preserves surrounding human text', () => {
    const block = renderCaptureBlock(fixture);
    expect(stripCaptureBlocksForMemory(`Human before\n\n${block}\n\nHuman after`)).toEqual({
      ok: true,
      body: 'Human before\n\nHuman after',
      removed: 1,
    });
  });

  it.each([
    '<!-- ve:chat-curation:start id="x" -->\nno end',
    '<!-- ve:chat-curation:end id="x" -->',
    '<!-- ve:chat-curation:start id="x" conversation="c" transcript-hash="h" -->\n<!-- ve:chat-curation:end id="y" -->',
    '<!-- ve:chat-curation:start id="x" conversation="c" transcript-hash="h" -->\n<!-- ve:chat-curation:start id="y" conversation="c" transcript-hash="h" -->\n<!-- ve:chat-curation:end id="y" -->\n<!-- ve:chat-curation:end id="x" -->',
    'ordinary text <!-- ve:chat-curation:start id="x" conversation="c" transcript-hash="h" -->',
  ])('fails closed when marker structure is malformed: %s', (body) => {
    expect(parseCaptureBlocks(body)).toMatchObject({ ok: false });
    expect(stripCaptureBlocksForMemory(body)).toMatchObject({ ok: false });
  });

  it('keeps composition and stamped-block hashes distinct and derives an id deterministically', () => {
    expect(captureCompositionHash('A concise **summary**.')).toBe('7184889448402e3ca02c45e2b40bd98fbf6864774624da67d39e7ecaf99e8322');
    const block = renderCaptureBlock(fixture);
    expect(captureBlockHash(block)).toBe('2bbdd12ea7ae10976c9561b7999644dd641a15643905138d60fb2e33bbe86863');
    expect(captureBlockHash(block)).not.toBe(captureCompositionHash(fixture.markdown));
    expect(captureId({
      conversationId: 'conversation-9',
      inputHash: 'transcript-hash',
      destinationIdentity: 'node-2',
      compositionHash: captureCompositionHash(fixture.markdown),
    })).toBe('cap-138624d081f0fbd3d233c7bd2f1241b4acb4f7e94f23cbff7247fdb8cd8a99ad');
  });

  it('normalizes and de-duplicates deterministic title candidates', () => {
    expect(captureTitleCandidates('  Vehicle   Overview  ', ' Vehicle Overview ', '2026-08-25')).toEqual([
      'Vehicle Overview',
      'Vehicle Overview (from chat 2026-08-25)',
    ]);
    expect(captureTitleCandidates('Vehicle Overview', 'Launch discussion', '2026-08-25')).toEqual([
      'Vehicle Overview',
      'Vehicle Overview — Launch discussion',
      'Vehicle Overview (from chat 2026-08-25)',
    ]);
  });

  it('reads the date back from a stamped block\'s attribution line (#496)', () => {
    expect(captureBlockDate(renderCaptureBlock(fixture))).toBe('2026-08-25');
    expect(captureBlockDate(renderCaptureBlock({ ...fixture, sourceUrls: [], includeHeading: false }))).toBe('2026-08-25');
    expect(captureBlockDate('<!-- start -->\nNo attribution here.\n<!-- end -->')).toBeNull();
  });
});
