import { describe, expect, it } from 'vitest';
import { rewritePlan, synthesizeAcceptedPages, type PageNoteBaseline } from '../src/page-synthesis.js';
import type { PageSourceSelection } from '../src/provenance-page-evidence.js';
import type { LlmClient, StructuredCallRequest } from '../src/llm/types.js';
import type { EngineNode, ExistingWiki, TopologyPlan, WikiScopeV1 } from '../src/types.js';

const scope = (facet: string): WikiScopeV1 => ({ v: 1, subject: 'Atlas', facet });
const PAGE_BODY = '## Current risks\n\n- **Contract** — The pilot MSA is in Acme legal review.\n\n'
  + '## Mitigations\n\n- Do not mention the Gold pricing tiers to Acme until legal approves them.';

function note(id: string, hash: string, body: string): EngineNode {
  return {
    id, title: `Note ${id}`, types: ['meeting'], fields: {}, body, metadata: { content_hash: hash },
    provenance_observation: { authority: 'engine', source: { kind: 'node', native_id: id }, content_hash: hash } as never,
  };
}

const page: EngineNode = { id: 'risks', title: 'Atlas — Risks', types: ['wiki'], fields: {},
  body: `<!-- ve:managed:Summary -->\n${PAGE_BODY}\n<!-- /ve:managed:Summary -->`,
  provenance_observation: { authority: 'engine', source: { kind: 'node', native_id: 'risks' } } as never };

const wiki: ExistingWiki = {
  home_id: 'home', home: { id: 'home', version: 1 }, topology_hash: 'topology', catalog_valid: true,
  subpages: [{ id: 'risks', title: 'Atlas — Risks', file_path: 'Wikis/Risks.md', version: 2, content_hash: 'page-hash',
    wiki_state: 'active', wiki_kind: 'risk-register', wiki_origin: 'automatic', wiki_scope: scope('risks'), wiki_pinned: false }],
};

// n1 is unchanged since the page was built, n2 changed, n3 is new to the page.
const notes = [
  note('n1', 'h1', 'The pilot MSA went to Acme legal on 2026-10-01.'),
  note('n2', 'h2-new', 'Acme signed the pilot MSA on 2026-10-15.'),
  note('n3', 'h3', 'Acme procurement wants a security questionnaire by 2026-10-30.'),
];
const baseline: PageNoteBaseline = { builtAt: '2026-10-10T09:00:00.000Z', notes: { n1: 'h1', n2: 'h2-old' } };
const refresh: TopologyPlan = { reviewed_page_ids: ['risks'], actions: [
  { op: 'refresh', node_id: 'risks', scope: scope('risks'), synthesis_brief: 'Update the risks.' },
] };

function harness(): { llm: LlmClient & { calls: StructuredCallRequest[] }; reader: { getNode: (id: string) => Promise<EngineNode> } } {
  const calls: StructuredCallRequest[] = [];
  const llm = { calls, supportsPreparedCapture: true as const, structuredCall: async (request: StructuredCallRequest) => {
    calls.push(request);
    return { output: { body: '## Current risks\n\n- Questionnaire due 2026-10-30.' }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
  } };
  const byId = new Map([page, ...notes].map(node => [node.id, node]));
  return { llm, reader: { getNode: async (id: string) => byId.get(id)! } };
}
const evidenceOf = (call: StructuredCallRequest) => JSON.parse(call.user).evidence as string;

describe('rewritePlan (#352)', () => {
  const wikiIds = new Set(['home', 'risks']);
  it('takes the notes new or changed since the page was built, and nothing else', () => {
    const plan = rewritePlan(page, baseline, notes, [], wikiIds, null);
    expect(plan?.changedIds).toEqual(['n2', 'n3']);
    expect(plan?.pageBlock).toBe(`CURRENT PAGE (as last built on 2026-10-10: the evidence for everything it already says; keep each section and entry no changed note changes)\n${PAGE_BODY}`);
    expect(plan?.prefix.startsWith(`${plan.pageBlock}\n\nCHANGED NOTES (`)).toBe(true);
  });
  it('dates the current page in the configured zone (#459)', () => {
    // 20:30 UTC on 10 October is already 11 October in Tokyo.
    const evening = { ...baseline, builtAt: '2026-10-10T20:30:00.000Z' };
    expect(rewritePlan(page, evening, notes, [], wikiIds, null, 'UTC')?.pageBlock).toMatch(/^CURRENT PAGE \(as last built on 2026-10-10:/);
    expect(rewritePlan(page, evening, notes, [], wikiIds, null, 'Asia/Tokyo')?.pageBlock).toMatch(/^CURRENT PAGE \(as last built on 2026-10-11:/);
  });
  it('synthesizes in full without a record, with nothing changed, or when the page would reach the writer cut', () => {
    expect(rewritePlan(page, undefined, notes, [], wikiIds, null)).toBeNull();
    expect(rewritePlan(page, { ...baseline, notes: { n1: 'h1', n2: 'h2-new', n3: 'h3' } }, notes, [], wikiIds, null)).toBeNull();
    expect(rewritePlan(page, baseline, notes, [], wikiIds, 40)).toBeNull();
    expect(rewritePlan({ ...page, body: '' }, baseline, notes, [], wikiIds, null)).toBeNull();
  });
  it('takes a note that only gained links as unchanged, recorded by text hash or by content hash (#332)', () => {
    const linked = (id: string, contentHash: string, textHash: string) =>
      ({ ...note(id, contentHash, 'Linked.'), metadata: { content_hash: contentHash, text_hash: textHash } });
    // n2 is recorded by its text hash (a build since #332): a new content hash with the same text is no change.
    // n3 is recorded by its content hash (a build before, or carried forward by the link sweep).
    const record = { ...baseline, notes: { n1: 'h1', n2: 't2', n3: 'h3' } };
    expect(rewritePlan(page, record, [notes[0]!, linked('n2', 'h2-linked', 't2'), linked('n3', 'h3', 't3')], [], wikiIds, null)).toBeNull();
    // A changed text is a change whatever the record holds.
    expect(rewritePlan(page, record, [notes[0]!, linked('n2', 'h2-edited', 't2-edited'), linked('n3', 'h3', 't3')], [], wikiIds, null)?.changedIds)
      .toEqual(['n2']);
  });
  it('never counts the wiki\'s own pages, keeps to selected evidence, and treats a note without a hash as changed', () => {
    const wikiNode = note('home', 'x', 'Home text.');
    const unhashed = { ...note('n4', 'h4', 'No hash.'), metadata: {} };
    expect(rewritePlan(page, baseline, [...notes, wikiNode, unhashed], [], wikiIds, null)?.changedIds).toEqual(['n2', 'n3', 'n4']);
    expect(rewritePlan(page, baseline, notes, ['n1', 'n3'], wikiIds, null)?.changedIds).toEqual(['n3']);
  });
});

describe('a refresh rewritten from changed notes (#352)', () => {
  it('sends the current page and only the changed notes, under the rewrite prompt and rules', async () => {
    const { llm, reader } = harness();
    const result = await synthesizeAcceptedPages(llm, reader, {
      model: 'm', existingWiki: wiki, evidenceNodes: notes, plan: refresh, pageNoteStates: new Map([['risks', baseline]]),
      system: 'Owner page prompt override.',
    });
    const call = llm.calls[0]!;
    expect(call.system).toContain('You update one existing page of a wiki');
    expect(call.system).toContain('7. This is an update of the current page (current_target)');
    expect(call.system).not.toContain('Owner page prompt override.');
    expect(JSON.parse(call.user).action).toBe('refresh');
    const evidence = evidenceOf(call);
    expect(evidence.startsWith('CURRENT PAGE (as last built on 2026-10-10')).toBe(true);
    expect(evidence).toContain('Do not mention the Gold pricing tiers');
    expect(evidence).toContain('Acme signed the pilot MSA');
    expect(evidence).toContain('security questionnaire');
    expect(evidence).not.toContain('went to Acme legal');
    expect(result.pages[0]).toMatchObject({ target: { node_id: 'risks' }, rewrite: true });
  });

  it('tells the writer today and the build date in the configured zone (#459)', async () => {
    const { llm, reader } = harness();
    await synthesizeAcceptedPages(llm, reader, {
      model: 'm', existingWiki: wiki, evidenceNodes: notes, plan: refresh, timeZone: 'Asia/Tokyo',
      generatedAt: new Date('2026-10-12T20:30:00.000Z'),
      pageNoteStates: new Map([['risks', { ...baseline, builtAt: '2026-10-10T20:30:00.000Z' }]]),
    });
    const call = llm.calls[0]!;
    expect(call.system.endsWith('Today is Tuesday, 2026-10-13 (Asia/Tokyo).')).toBe(true);
    expect(evidenceOf(call).startsWith('CURRENT PAGE (as last built on 2026-10-11:')).toBe(true);
  });

  it('synthesizes in full, as before, without a record or for a page it creates', async () => {
    const { llm, reader } = harness();
    const result = await synthesizeAcceptedPages(llm, reader, {
      model: 'm', existingWiki: wiki, evidenceNodes: notes, pageNoteStates: new Map([['other', baseline]]),
      plan: { reviewed_page_ids: ['risks'], actions: [...refresh.actions,
        { op: 'create', plan_key: 'new', title: 'Atlas — Timeline', kind: 'timeline', scope: scope('timeline'), synthesis_brief: 'Dates.' }] },
    });
    for (const call of llm.calls) {
      expect(call.system).toContain('Use the template\'s headings as ## sections');
      expect(evidenceOf(call)).not.toContain('CURRENT PAGE');
      expect(evidenceOf(call)).toContain('went to Acme legal');
    }
    expect(result.pages.map(page => page.rewrite)).toEqual([undefined, undefined]);
  });

  it('credits the current page as generated context and each changed note at its own bytes', async () => {
    const { llm, reader } = harness();
    let selection: PageSourceSelection | undefined;
    let request: StructuredCallRequest | undefined;
    await synthesizeAcceptedPages(llm, reader, {
      model: 'm', existingWiki: wiki, evidenceNodes: notes, plan: refresh, pageNoteStates: new Map([['risks', baseline]]),
      captureFactory: (_target, prepared, picked) => {
        selection = picked; request = prepared;
        return { onPrepared: async () => {}, stage: async () => null, fail: async () => {} };
      },
    });
    const evidence = Buffer.from(evidenceOf(request!));
    const items = selection!.items.filter(item => item.spans.every(span => span.field === 'evidence'));
    expect(items[0]).toMatchObject({ key: 'evidence:0', role: 'generated_context', origin: 'opaque', observation: null,
      selection: 'rewrite-current-page:v1' });
    expect(evidence.subarray(0, items[0]!.spans[0]!.end).toString()).toMatch(/^CURRENT PAGE [^]*until legal approves them\.$/);
    const credited = items.slice(1).map(item => evidence.subarray(item.spans[0]!.start, item.spans[0]!.end).toString());
    expect(credited).toEqual([
      '### [n2] Note n2\ntypes: meeting\nAcme signed the pilot MSA on 2026-10-15.',
      '### [n3] Note n3\ntypes: meeting\nAcme procurement wants a security questionnaire by 2026-10-30.',
    ]);
    expect(selection!.omissions).toContainEqual(expect.objectContaining({ code: 'page_evidence_not_selected' }));
  });
});
