import { describe, expect, it } from 'vitest';
import {
  CANONICAL_WEB_PROBE_PUBLISHED_CHAR_CAP,
  CANONICAL_WEB_PROBE_RESULT_CAP,
  CANONICAL_WEB_PROBE_SNAPSHOT_CHAR_CAP,
  CANONICAL_WEB_PROBE_SNIPPET_CHAR_CAP,
  CANONICAL_WEB_PROBE_TITLE_CHAR_CAP,
  CANONICAL_WEB_PROBE_URL_CHAR_CAP,
  TOPIC_VAULT_SOURCE_TITLE_CHAR_CAP,
  buildCanonicalWebProbe,
  comparableTopicBody,
  topicVaultSourceFingerprint,
} from '../src/topic-refresh-evidence.js';

function present(over: Partial<{
  nodeId: string;
  title: string;
  types: string[];
  bodyIncluded: boolean;
  renderedBody: string;
}> = {}) {
  return topicVaultSourceFingerprint({
    nodeId: 'node-1',
    title: 'Source',
    types: ['note'],
    bodyIncluded: true,
    renderedBody: 'visible body',
    ...over,
  });
}

function successfulProbe(input: Parameters<typeof buildCanonicalWebProbe>[0]) {
  const result = buildCanonicalWebProbe(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected probe, got ${result.reason}`);
  return result.probe;
}

function urlAtCap(index: number, extraChars = 0): string {
  const prefix = `https://example.test/${String(index).padStart(2, '0')}/`;
  return `${prefix}${'u'.repeat(CANONICAL_WEB_PROBE_URL_CHAR_CAP - prefix.length + extraChars)}`;
}

describe('comparableTopicBody (#332)', () => {
  const tail = ' and more text after it.'.repeat(4);
  it('reads links as their words before the cap, so a link moves neither the cut nor the count', () => {
    expect(comparableTopicBody(`Met [[Dana Whitfield]] of Acme.${tail}`, 30)).toBe(comparableTopicBody(`Met Dana Whitfield of Acme.${tail}`, 30));
    // A link entirely past the cap still changed the count of characters cut when read after it.
    expect(comparableTopicBody(`Met Dana Whitfield.${tail} [[Acme]]`, 30)).toBe(comparableTopicBody(`Met Dana Whitfield.${tail} Acme`, 30));
  });
  it('still sees a change to the words, and gives no body for none', () => {
    expect(comparableTopicBody(`Met Dana Whitfield.${tail}`, 30)).not.toBe(comparableTopicBody(`Met Dana Whitfield.${tail} More.`, 30));
    expect(comparableTopicBody(undefined, 30)).toBe('');
    expect(comparableTopicBody('  ', null)).toBe('');
  });
});

describe('topic vault source fingerprints', () => {
  it('projects normalized present evidence with sorted unique types and version 1 only', () => {
    const result = present({
      types: [' reference ', 'note', 'reference', ''],
      title: `  ${'a'.repeat(TOPIC_VAULT_SOURCE_TITLE_CHAR_CAP + 8)}  `,
    });

    expect(result).toMatchObject({
      version: 1,
      projection: {
        version: 1,
        nodeId: 'node-1',
        state: 'present',
        title: 'a'.repeat(TOPIC_VAULT_SOURCE_TITLE_CHAR_CAP),
        types: ['note', 'reference'],
        bodyIncluded: true,
        body: 'visible body',
      },
    });
  });

  it('makes a sorted combined baseline independent of source ordering', () => {
    const first = [
      present({ nodeId: 'node-b', title: 'B' }),
      present({ nodeId: 'node-a', title: 'A' }),
    ].sort((left, right) => left.projection.nodeId.localeCompare(right.projection.nodeId));
    const second = [
      present({ nodeId: 'node-a', title: 'A' }),
      present({ nodeId: 'node-b', title: 'B' }),
    ].sort((left, right) => left.projection.nodeId.localeCompare(right.projection.nodeId));

    expect(first.map(item => item.hash)).toEqual(second.map(item => item.hash));
  });

  it('changes the digest for synthesis-visible title, types, and included body changes', () => {
    const base = present();

    expect(present({ title: 'Changed' }).hash).not.toBe(base.hash);
    expect(present({ types: ['reference'] }).hash).not.toBe(base.hash);
    expect(present({ renderedBody: 'changed body' }).hash).not.toBe(base.hash);
  });

  it('does not accept engine version or unrelated metadata as fingerprint inputs', () => {
    const input = {
      nodeId: 'node-1',
      title: 'Source',
      types: ['note'],
      bodyIncluded: true,
      renderedBody: 'visible body',
      version: 9,
      fields: { secret: 'unrelated' },
    };

    expect(topicVaultSourceFingerprint(input).hash).toBe(present().hash);
  });

  it('uses the exact trimmed and body-capped projection supplied by topic evidence', () => {
    const bodyCharCap = 12;
    const firstRenderedBody = '  visible text beyond the cap  '.trim().slice(0, bodyCharCap);
    const secondRenderedBody = '  visible text beyond the cap with later edits  '.trim().slice(0, bodyCharCap);

    expect(present({ renderedBody: firstRenderedBody }).hash).toBe(
      present({ renderedBody: secondRenderedBody }).hash,
    );
    expect(present({ renderedBody: firstRenderedBody }).projection).toMatchObject({
      body: 'visible text',
    });
  });

  it('ignores body changes when body was not included in synthesis', () => {
    expect(present({ bodyIncluded: false, renderedBody: 'first' }).hash).toBe(
      present({ bodyIncluded: false, renderedBody: 'second' }).hash,
    );
  });

  it('emits a minimal version-1 missing projection', () => {
    const result = topicVaultSourceFingerprint({ nodeId: 'node-1', state: 'missing' });

    expect(result).toEqual({
      version: 1,
      hash: result.hash,
      projection: { version: 1, nodeId: 'node-1', state: 'missing' },
    });
  });

  it('rejects an empty stable node id', () => {
    expect(() => present({ nodeId: '  ' })).toThrow('nodeId');
  });
});

describe('canonical web probes', () => {
  it('makes rank-only reordering immaterial and removes URL fragments', () => {
    const records = [
      { url: 'https://example.test/b#section', title: 'B', snippet: 'second', published: null },
      { url: 'https://example.test/a#top', title: 'A', snippet: 'first', published: '2026-01-01' },
    ];
    const first = successfulProbe(records);
    const second = successfulProbe([...records].reverse());

    expect(first.results).toEqual([
      { url: 'https://example.test/a', title: 'A', snippet: 'first', published: '2026-01-01' },
      { url: 'https://example.test/b', title: 'B', snippet: 'second', published: null },
    ]);
    expect(second.results).toEqual(first.results);
    expect(second.snapshotJson).toBe(first.snapshotJson);
    expect(second.hash).toBe(first.hash);
    expect(first.version).toBe(1);
  });

  it('deduplicates a canonical URL by a lexically selected bounded record rather than input rank', () => {
    const first = successfulProbe([
      { url: 'https://example.test/item#first', title: 'Zulu', snippet: 'z', published: '2026-02-02' },
      { url: 'https://example.test/item#second', title: 'Alpha', snippet: 'a', published: '2026-01-01' },
    ]);
    const second = successfulProbe([
      { url: 'https://example.test/item#second', title: 'Alpha', snippet: 'a', published: '2026-01-01' },
      { url: 'https://example.test/item#first', title: 'Zulu', snippet: 'z', published: '2026-02-02' },
    ]);

    expect(first.results).toEqual([
      { url: 'https://example.test/item', title: 'Alpha', snippet: 'a', published: '2026-01-01' },
    ]);
    expect(second).toEqual(first);
  });

  it('changes the digest when a canonical record field changes', () => {
    const base = successfulProbe([{ url: 'https://example.test/a', title: 'A', snippet: 'one', published: null }]);

    expect(successfulProbe([{ url: 'https://example.test/b', title: 'A', snippet: 'one', published: null }]).hash).not.toBe(base.hash);
    expect(successfulProbe([{ url: 'https://example.test/a', title: 'B', snippet: 'one', published: null }]).hash).not.toBe(base.hash);
    expect(successfulProbe([{ url: 'https://example.test/a', title: 'A', snippet: 'two', published: null }]).hash).not.toBe(base.hash);
    expect(successfulProbe([{ url: 'https://example.test/a', title: 'A', snippet: 'one', published: '2026-01-01' }]).hash).not.toBe(base.hash);
  });

  it('caps sorted canonical results at 20 and bounds every textual field', () => {
    const probe = successfulProbe(Array.from({ length: CANONICAL_WEB_PROBE_RESULT_CAP + 4 }, (_, index) => ({
      url: urlAtCap(index),
      title: 'title',
      snippet: 'snippet',
      published: 'published',
    })));

    expect(probe.results).toHaveLength(CANONICAL_WEB_PROBE_RESULT_CAP);
    for (const result of probe.results) {
      expect(result.url.length).toBeLessThanOrEqual(CANONICAL_WEB_PROBE_URL_CHAR_CAP);
    }
    const bounded = successfulProbe([{
      url: urlAtCap(0),
      title: `  ${'t'.repeat(CANONICAL_WEB_PROBE_TITLE_CHAR_CAP + 5)}  `,
      snippet: `  ${'s'.repeat(CANONICAL_WEB_PROBE_SNIPPET_CHAR_CAP + 5)}  `,
      published: `  ${'p'.repeat(CANONICAL_WEB_PROBE_PUBLISHED_CHAR_CAP + 5)}  `,
    }]).results[0];
    expect(bounded).toMatchObject({
      title: 't'.repeat(CANONICAL_WEB_PROBE_TITLE_CHAR_CAP),
      snippet: 's'.repeat(CANONICAL_WEB_PROBE_SNIPPET_CHAR_CAP),
      published: 'p'.repeat(CANONICAL_WEB_PROBE_PUBLISHED_CHAR_CAP),
    });
  });

  it('reduces snippets deterministically to fit the snapshot while retaining every admitted identity', () => {
    const records = Array.from({ length: CANONICAL_WEB_PROBE_RESULT_CAP }, (_, index) => ({
      url: urlAtCap(index),
      title: 't'.repeat(900),
      snippet: `${index}`.padStart(CANONICAL_WEB_PROBE_SNIPPET_CHAR_CAP, 's'),
      published: 'p'.repeat(CANONICAL_WEB_PROBE_PUBLISHED_CHAR_CAP),
    }));
    const probe = successfulProbe(records);

    expect(probe.snapshotJson.length).toBeLessThanOrEqual(CANONICAL_WEB_PROBE_SNAPSHOT_CHAR_CAP);
    expect(probe.results).toHaveLength(CANONICAL_WEB_PROBE_RESULT_CAP);
    expect(probe.results.every(result => result.url.length === CANONICAL_WEB_PROBE_URL_CHAR_CAP)).toBe(true);
    expect(probe.results.every(result => result.title.length === 900)).toBe(true);
    expect(probe.results.every(result => result.published?.length === CANONICAL_WEB_PROBE_PUBLISHED_CHAR_CAP)).toBe(true);
    expect(probe.results.some(result => result.snippet.length < CANONICAL_WEB_PROBE_SNIPPET_CHAR_CAP)).toBe(true);
    expect(successfulProbe([...records].reverse())).toEqual(probe);
  });

  it('fails closed when URL identity is invalid, overlong, or mandatory identity cannot fit', () => {
    expect(buildCanonicalWebProbe([{ url: 'ftp://example.test/a', title: 'A', snippet: '', published: null }]))
      .toEqual({ ok: false, reason: 'web_probe_overflow' });
    expect(buildCanonicalWebProbe([{
      url: urlAtCap(0, 1),
      title: 'A', snippet: '', published: null,
    }])).toEqual({ ok: false, reason: 'web_probe_overflow' });
    expect(buildCanonicalWebProbe(Array.from({ length: CANONICAL_WEB_PROBE_RESULT_CAP }, (_, index) => ({
      url: urlAtCap(index),
      title: 't'.repeat(CANONICAL_WEB_PROBE_TITLE_CHAR_CAP),
      snippet: '',
      published: 'p'.repeat(CANONICAL_WEB_PROBE_PUBLISHED_CHAR_CAP),
    })))).toEqual({ ok: false, reason: 'web_probe_overflow' });
  });
});
