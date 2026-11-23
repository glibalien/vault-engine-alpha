import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';
import { createEmbeddingIndexer } from '../../src/search/indexer.js';
import type { EmbeddingIndexer } from '../../src/search/indexer.js';
import type { Embedder } from '../../src/search/embedder.js';

// Fake embedder with deterministic vectors
function createFakeEmbedder(): Embedder {
  return {
    async embedDocument(text: string): Promise<Float32Array[]> {
      const arr = new Float32Array(256);
      const seed = text.length;
      for (let i = 0; i < 256; i++) {
        arr[i] = (seed % 100) / 100 + i * 0.001;
      }
      return [arr];
    },
    async embedQuery(text: string): Promise<Float32Array> {
      const arr = new Float32Array(256);
      const seed = text.length;
      for (let i = 0; i < 256; i++) {
        arr[i] = (seed % 100) / 100 + i * 0.001;
      }
      return arr;
    },
    isReady(): boolean {
      return true;
    },
  };
}

function insertNode(
  db: Database.Database,
  id: string,
  title: string,
  body: string | null = null,
  types: string[] = [],
): void {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)',
  ).run(id, `/${id}.md`, title, body);

  db.prepare(
    'INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)',
  ).run(id, title, body);

  for (const t of types) {
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, t);
  }
}

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

let db: Database.Database;
let indexer: EmbeddingIndexer;
let embedder: Embedder;
let handler: (args: Record<string, unknown>) => Promise<unknown>;

function captureHandler(idx?: EmbeddingIndexer, emb?: Embedder) {
  let capturedHandler: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: (args: Record<string, unknown>) => Promise<unknown>) => {
      capturedHandler = h;
    },
    registerTool: (_name: string, _config: unknown, h: (args: Record<string, unknown>) => Promise<unknown>) => {
      capturedHandler = h;
    },
  };
  registerQueryNodes(fakeServer as unknown as McpServer, db, idx, emb);
  return capturedHandler!;
}

beforeEach(async () => {
  db = createTestDb();
  embedder = createFakeEmbedder();
  indexer = createEmbeddingIndexer(db, embedder);
});

describe('query-nodes with query param (hybrid search)', () => {
  it('returns scored results when query is provided', async () => {
    insertNode(db, 'n1', 'Machine Learning Fundamentals', 'Introduction to neural networks');
    insertNode(db, 'n2', 'Gardening Tips', 'How to grow tomatoes');

    // Embed nodes
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    indexer.enqueue({ node_id: 'n2', source_type: 'node' });
    await indexer.processAll();

    handler = captureHandler(indexer, embedder);
    const result = await handler({ query: 'machine learning' });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    const parsed = envelope.data;
    expect(Array.isArray(parsed.nodes)).toBe(true);
    const nodes = parsed.nodes as Array<Record<string, unknown>>;
    expect(nodes.length).toBeGreaterThan(0);

    // n1 should be in results (FTS match on 'machine learning')
    const n1 = nodes.find(n => n.id === 'n1');
    expect(n1).toBeDefined();
    expect(typeof n1!.score).toBe('number');
    expect((n1!.score as number)).toBeGreaterThan(0);
    expect(Array.isArray(n1!.match_sources)).toBe(true);
  });

  it('falls back to standard query when no query param is provided', async () => {
    insertNode(db, 'n1', 'Alpha Node', null, ['article']);
    insertNode(db, 'n2', 'Beta Node', null, ['article']);
    insertNode(db, 'n3', 'Gamma Node', null, ['task']);

    handler = captureHandler(indexer, embedder);
    const result = await handler({ types: ['article'] });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    const parsed = envelope.data;
    const nodes = parsed.nodes as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(2);
    const ids = nodes.map(n => n.id).sort();
    expect(ids).toEqual(['n1', 'n2']);

    // No score fields in standard path
    expect(nodes[0].score).toBeUndefined();
  });

  it('combines query with type filter (structured pre-filter)', async () => {
    insertNode(db, 'n1', 'Machine Learning Article', 'Neural nets', ['article']);
    insertNode(db, 'n2', 'Machine Learning Task', 'Train model', ['task']);
    insertNode(db, 'n3', 'Gardening Article', 'Grow tomatoes', ['article']);

    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    indexer.enqueue({ node_id: 'n2', source_type: 'node' });
    indexer.enqueue({ node_id: 'n3', source_type: 'node' });
    await indexer.processAll();

    handler = captureHandler(indexer, embedder);
    const result = await handler({ query: 'machine learning', types: ['article'] });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    const parsed = envelope.data;
    const nodes = parsed.nodes as Array<Record<string, unknown>>;
    const ids = nodes.map(n => n.id);

    // n2 (task type) should be excluded by the type filter pre-filter
    expect(ids).not.toContain('n2');
    // n1 (article + machine learning match) should be present
    expect(ids).toContain('n1');
  });

  it('returns total reflecting number of search hits (not db total)', async () => {
    insertNode(db, 'n1', 'Machine Learning Deep', 'Neural net fundamentals');
    insertNode(db, 'n2', 'Unrelated Cooking', 'Recipes for pasta');

    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    indexer.enqueue({ node_id: 'n2', source_type: 'node' });
    await indexer.processAll();

    handler = captureHandler(indexer, embedder);
    const result = await handler({ query: 'machine learning' });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    const parsed = envelope.data;
    // total should match how many search hits came back
    const nodes = parsed.nodes as Array<Record<string, unknown>>;
    expect(typeof parsed.total).toBe('number');
    expect(parsed.total).toBe(nodes.length + (parsed.offset as number | undefined ?? 0));
  });

  it('falls back to standard path when embedder is not provided', async () => {
    insertNode(db, 'n1', 'Node One', null);
    insertNode(db, 'n2', 'Node Two', null);

    // Register without embedder
    handler = captureHandler(undefined, undefined);
    const result = await handler({ query: 'anything' });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    const parsed = envelope.data;
    // Standard path — returns all nodes (no filter)
    const nodes = parsed.nodes as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(2);
    expect(nodes[0].score).toBeUndefined();
  });

  it('returns include_fields data in search path', async () => {
    insertNode(db, 'n1', 'Machine Learning Article', 'Deep learning content', ['article']);
    db.prepare(
      'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('n1', 'status', 'published', null, null, null, 'frontmatter');

    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processAll();

    handler = captureHandler(indexer, embedder);
    const result = await handler({ query: 'machine learning', include_fields: ['status'] });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    const parsed = envelope.data;
    const nodes = parsed.nodes as Array<Record<string, unknown>>;
    const n1 = nodes.find(n => n.id === 'n1');
    expect(n1).toBeDefined();
    expect(n1!.fields).toBeDefined();
    const fields = n1!.fields as Record<string, unknown>;
    expect(fields.status).toBe('published');
  });

  it('search_mode=fts returns fts-only results without an embedder', async () => {
    insertNode(db, 'n1', 'Machine Learning', 'neural networks');

    // FTS needs no embedder — register handler with no embedder/indexer
    handler = captureHandler(undefined, undefined);
    const result = await handler({ query: 'machine', search_mode: 'fts' });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    const nodes = envelope.data.nodes as Array<Record<string, unknown>>;
    expect(nodes.length).toBeGreaterThan(0);
    // FTS-only path: every match_sources array must be exactly ['fts']
    for (const n of nodes) {
      expect(n.match_sources).toEqual(['fts']);
    }
  });

  it('search_mode=semantic returns semantic-only results with an embedder', async () => {
    insertNode(db, 'n1', 'Machine Learning', 'neural networks');

    // Embed the node so vector search has data
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processAll();

    handler = captureHandler(indexer, embedder);
    const result = await handler({ query: 'machine', search_mode: 'semantic' });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    const nodes = envelope.data.nodes as Array<Record<string, unknown>>;
    expect(nodes.length).toBeGreaterThan(0);
    // Semantic-only path: every match_sources array must contain only 'semantic'
    for (const n of nodes) {
      expect((n.match_sources as string[]).every((s) => s === 'semantic')).toBe(true);
    }
  });

  it('default search_mode is hybrid (unchanged behavior)', async () => {
    insertNode(db, 'n1', 'Machine Learning', 'neural networks');

    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processAll();

    handler = captureHandler(indexer, embedder);
    // No search_mode supplied — should default to hybrid
    const result = await handler({ query: 'machine' });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    expect(envelope.data.nodes.length).toBeGreaterThan(0);
    // Hybrid: n1 must be present with a score
    const n1 = (envelope.data.nodes as Array<Record<string, unknown>>).find(n => n.id === 'n1');
    expect(n1).toBeDefined();
    expect(typeof n1!.score).toBe('number');
  });

  it('search_mode=semantic without embedder falls through to structured path (no scores)', async () => {
    insertNode(db, 'n1', 'Machine Learning', 'neural networks');

    // No embedder — semantic without embedder should fall through to structured query
    handler = captureHandler(undefined, undefined);
    const result = await handler({ query: 'machine', search_mode: 'semantic' });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    const nodes = envelope.data.nodes as Array<Record<string, unknown>>;
    // Structured path: no score field on results
    for (const n of nodes) {
      expect(n.score).toBeUndefined();
    }
  });

  it('search results project both file_mtime and indexed_at (projection contract)', async () => {
    // Insert node with explicit file_mtime and indexed_at so the values are non-null
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('nts1', '/nts1.md', 'TypeScript Projection Test', 'projection contract test', 1700000000, 1700000001);
    db.prepare(
      'INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)',
    ).run('nts1', 'TypeScript Projection Test', 'projection contract test');

    indexer.enqueue({ node_id: 'nts1', source_type: 'node' });
    await indexer.processAll();

    handler = captureHandler(indexer, embedder);
    const result = await handler({ query: 'projection contract' });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    const nodes = envelope.data.nodes as Array<Record<string, unknown>>;
    const n = nodes.find(node => node.id === 'nts1');
    expect(n).toBeDefined();
    // Both timestamp columns must be projected on search-path results
    expect(typeof n!.file_mtime).toBe('number');
    expect(typeof n!.indexed_at).toBe('number');
  });

  it('search results carry title + file_mtime + indexed_at by default (sort projection contract)', async () => {
    // FTS needs no embedder — register handler without indexer/embedder.
    // Inserts explicit timestamp values so the assertion is on real numbers, not null.
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('spc1', '/spc1.md', 'Alpha Sort Contract', 'sort projection alpha', 1710000000, 1710000001);
    db.prepare(
      'INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)',
    ).run('spc1', 'Alpha Sort Contract', 'sort projection alpha');
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('spc2', '/spc2.md', 'Beta Sort Contract', 'sort projection beta', 1710000010, 1710000011);
    db.prepare(
      'INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)',
    ).run('spc2', 'Beta Sort Contract', 'sort projection beta');

    // No select param — default full projection must include all three sort fields.
    handler = captureHandler(undefined, undefined);
    const result = await handler({ query: 'sort projection', search_mode: 'fts', limit: 10 });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    const nodes = envelope.data.nodes as Array<Record<string, unknown>>;
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      // title — Name sort
      expect(typeof n.title).toBe('string');
      // file_mtime — Modified sort (the Inc 8 silent-no-op fix)
      expect(typeof n.file_mtime).toBe('number');
      // indexed_at — Created sort (the Inc 8 silent-no-op fix)
      expect(typeof n.indexed_at).toBe('number');
    }
  });
});

describe('query-nodes FTS_QUERY_INVALID warning', () => {
  it('neutralizes an unterminated quote instead of warning (b02)', async () => {
    insertNode(db, 'n1', 'Some unterminated Node', 'with content', ['note']);

    // Pre-b02 an unterminated quote raised an FTS5 syntax error → FTS_QUERY_INVALID.
    // The ranked lane now tokenizes + quotes the input, so it is a valid literal search.
    handler = captureHandler(indexer, embedder);
    const result = await handler({ query: '"unterminated', search_mode: 'fts' });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    const codes = (envelope.warnings as Array<{ code: string }>).map((w) => w.code);
    expect(codes).not.toContain('FTS_QUERY_INVALID');
  });

  it('does not warn for a valid FTS query', async () => {
    insertNode(db, 'n1', 'Some Node', 'with content', ['note']);

    handler = captureHandler(indexer, embedder);
    const result = await handler({ query: 'content', search_mode: 'fts' });
    const envelope = parseResult(result) as any;

    const codes = (envelope.warnings as Array<{ code: string }>).map((w) => w.code);
    expect(codes).not.toContain('FTS_QUERY_INVALID');
  });
});

describe('query-nodes full_text param', () => {
  it('filters by literal full_text substring on the structured path (no query)', async () => {
    insertNode(db, 'n1', 'Project Roadmap', 'milestones and deadlines', ['note']);
    insertNode(db, 'n2', 'Grocery List', 'milk and eggs', ['note']);

    handler = captureHandler(indexer, embedder);
    const result = await handler({ full_text: 'milestones' });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    const ids = (envelope.data.nodes as Array<{ id: string }>).map((n) => n.id);
    expect(ids).toEqual(['n1']);
  });

  it('combines full_text with query to narrow candidates before ranking', async () => {
    insertNode(db, 'n1', 'Machine Learning', 'neural networks deep learning', ['note']);
    insertNode(db, 'n2', 'Machine Shop', 'lathes and mills', ['note']);
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    indexer.enqueue({ node_id: 'n2', source_type: 'node' });
    await indexer.processAll();

    handler = captureHandler(indexer, embedder);
    const result = await handler({ query: 'machine', full_text: 'neural' });
    const envelope = parseResult(result) as any;

    expect(envelope.ok).toBe(true);
    const ids = (envelope.data.nodes as Array<{ id: string }>).map((n) => n.id);
    expect(ids).toContain('n1');
    expect(ids).not.toContain('n2'); // excluded by the full_text candidate filter
  });

  it('finds every exact conversation marker through its contiguous canonical attribute slice', async () => {
    const conversation = 'conversation-&#39;&quot;&lt;&amp;&gt;';
    insertNode(db, 'n1', 'First capture', `<!-- ve:chat-curation:start id="cap-one" conversation="${conversation}" transcript-hash="hash-one" -->\nFirst`, ['note']);
    insertNode(db, 'n2', 'Second capture', `<!-- ve:chat-curation:start id="cap-two" conversation="${conversation}" transcript-hash="hash-two" -->\nSecond`, ['note']);
    insertNode(db, 'n3', 'Different conversation', `<!-- ve:chat-curation:start id="cap-three" conversation="${conversation}-suffix" transcript-hash="hash-three" -->`, ['note']);

    handler = captureHandler(indexer, embedder);
    const exact = parseResult(await handler({
      full_text: `conversation="${conversation}" transcript-hash=`,
      select: ['id'],
      limit: 200,
    })) as any;
    const impossible = parseResult(await handler({
      full_text: `ve:chat-curation:start conversation="${conversation}"`,
      select: ['id'],
      limit: 200,
    })) as any;

    expect((exact.data.nodes as Array<{ id: string }>).map((node) => node.id).sort()).toEqual(['n1', 'n2']);
    expect(impossible.data.nodes).toEqual([]);
  });
});

it('filters ranked candidates by where before page selection', async () => {
  insertNode(db,'n1','alpha alpha alpha','alpha');
  insertNode(db,'n2','alpha','secondary');
  handler=captureHandler();
  const r=parseResult(await handler({query:'alpha',search_mode:'fts',limit:1,where:{any:[{node_ids:['n2']},{title_eq:'missing'}]}})) as any;
  expect(r.data.nodes.map((n:any)=>n.id)).toEqual(['n2']);
  expect(r.data.total).toBe(1);
});

describe('query-nodes full_text_words param (#687)', () => {
  const ids = (envelope: any) => (envelope.data.nodes as Array<{ id: string }>).map((n) => n.id).sort();

  it('matches a name as a whole word, never inside a longer word', async () => {
    insertNode(db, 'n1', 'Call notes', 'We met Ark today.', ['note']);
    insertNode(db, 'n2', 'Shopping', 'The market was dark and the parking full.', ['note']);
    insertNode(db, 'n3', 'Plan', "Read Ark's plan first.", ['note']);
    insertNode(db, 'n4', 'Ark', null, ['note']);
    insertNode(db, 'n5', 'Lower case', 'an ark of boxes', ['note']);

    handler = captureHandler(indexer, embedder);
    const words = parseResult(await handler({ full_text_words: 'Ark', select: ['id'] })) as any;
    const substring = parseResult(await handler({ full_text: 'Ark', select: ['id'] })) as any;

    expect(words.ok).toBe(true);
    expect(ids(words)).toEqual(['n1', 'n3', 'n4', 'n5']);
    expect(words.data.total).toBe(4);
    expect(ids(substring)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
  });

  it('keeps a decomposed accent inside its word (Codex, #688)', async () => {
    insertNode(db, 'n1', 'One', 'Lunch at Cafe\u0301teria Nord.', ['note']);
    insertNode(db, 'n2', 'Two', 'Lunch at the cafe.', ['note']);

    handler = captureHandler(indexer, embedder);
    const result = parseResult(await handler({ full_text_words: 'Cafe\u0301teria', select: ['id'] })) as any;

    expect(ids(result)).toEqual(['n1']);
  });

  it('matches several words as a phrase, in order, across any whitespace', async () => {
    insertNode(db, 'n1', 'One', 'Spoke with Acme   Cloud about pricing.', ['note']);
    insertNode(db, 'n2', 'Two', 'The cloud at Acme was down.', ['note']);
    insertNode(db, 'n3', 'Three', 'acme cloud, again', ['note']);

    handler = captureHandler(indexer, embedder);
    const result = parseResult(await handler({ full_text_words: 'Acme Cloud', select: ['id'] })) as any;

    expect(ids(result)).toEqual(['n1', 'n3']);
  });

  it('matches nothing for text with no word in it, and works inside where and with a ranked query', async () => {
    insertNode(db, 'n1', 'Machine Learning', 'Ark builds neural networks', ['note']);
    insertNode(db, 'n2', 'Machine Shop', 'lathes and mills in the market', ['note']);
    insertNode(db, 'n3', 'Garden', 'tomatoes', ['note']);
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    indexer.enqueue({ node_id: 'n2', source_type: 'node' });
    indexer.enqueue({ node_id: 'n3', source_type: 'node' });
    await indexer.processAll();

    handler = captureHandler(indexer, embedder);
    const none = parseResult(await handler({ full_text_words: '+-+', select: ['id'] })) as any;
    expect(none.ok).toBe(true);
    expect(none.data.nodes).toEqual([]);
    const empty = parseResult(await handler({ where: { all: [{ full_text_words: '' }, { types: ['note'] }] }, select: ['id'] })) as any;
    expect(empty.data.nodes).toEqual([]);

    const where = parseResult(await handler({
      where: { any: [{ full_text_words: 'ark' }, { title_eq: 'Garden' }] }, select: ['id'],
    })) as any;
    expect(ids(where)).toEqual(['n1', 'n3']);

    const ranked = parseResult(await handler({ query: 'machine', full_text_words: 'ark' })) as any;
    expect(ids(ranked)).toEqual(['n1']);
  });
});
