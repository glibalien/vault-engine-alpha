// allow: SIZE_OK — contract tests intentionally mirror the single Engine MCP facade.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { adaptSdkClient, CREATE_MEMORY_TIMEOUT_MS, Engine, EngineError, type EngineClientFactory, type WikiReconcileInput } from '../src/engine.js';
import type { Config } from '../src/config.js';
import { defaultsFor, type VaultSettings } from '@vault/settings-registry';

const DEFAULT_VAULT = defaultsFor('vault') as unknown as VaultSettings;

const config = {
  engineUrl: 'http://localhost:3334', engineToken: 't',
  fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
  fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
} as Config;

function envelope(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] };
}

function factoryReturning(data: unknown, capture?: (req: { name: string; arguments: Record<string, unknown> }) => void): EngineClientFactory {
  return () => ({
    transport: { close: async () => {} },
    client: {
      connect: async () => {},
      callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
        capture?.(req);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data, warnings: [] }) }] };
      },
    },
  });
}

describe('Engine reconnect', () => {
  it('reconnects once and retries after a transport error', async () => {
    let builds = 0;
    const factory: EngineClientFactory = () => {
      builds += 1;
      const myBuild = builds;
      return {
        transport: { close: async () => {} },
        client: {
          connect: async () => {},
          callTool: async () => {
            if (myBuild === 1) throw new Error('transport closed');
            return envelope({ nodes: [] });
          },
        },
      };
    };
    const engine = new Engine(config, factory);
    const result = await engine.listActiveProjects(['open']);
    expect(result).toEqual([]);
    expect(builds).toBe(2); // initial build + one reconnect
  });

  it('does not retry a tool-level ok:false error', async () => {
    let calls = 0;
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async () => {
          calls += 1;
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'NOPE', message: 'no' } }) }] };
        },
      },
    });
    const engine = new Engine(config, factory);
    await expect(engine.getNode('x')).rejects.toThrow('engine NOPE');
    expect(calls).toBe(1); // tool-level failure is not a transport error → no retry
  });

  it('retains structured details from a failed tool envelope', async () => {
    const details = {
      issues: [{ code: 'REQUIRED_MISSING', field: 'context', message: 'sensitive text' }],
    };
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          error: { code: 'VALIDATION_FAILED', message: 'validation failed', details },
        }) }] }),
      },
    });
    const engine = new Engine(config, factory);
    await expect(engine.getNode('x')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details,
    });
  });

  it('gives up after one failed retry on a persistent transport error', async () => {
    let builds = 0;
    const factory: EngineClientFactory = () => {
      builds += 1;
      return {
        transport: { close: async () => {} },
        client: { connect: async () => {}, callTool: async () => { throw new Error('transport closed'); } },
      };
    };
    const engine = new Engine(config, factory);
    await expect(engine.getNode('x')).rejects.toThrow('transport closed');
    expect(builds).toBe(2); // initial + one reconnect, then propagates
  });

  it('does not resend a request that timed out: the Engine may still finish it', async () => {
    let builds = 0;
    let calls = 0;
    const factory: EngineClientFactory = () => {
      builds += 1;
      return {
        transport: { close: async () => {} },
        client: {
          connect: async () => {},
          callTool: async () => {
            calls += 1;
            throw new McpError(ErrorCode.RequestTimeout, 'Request timed out', { timeout: CREATE_MEMORY_TIMEOUT_MS });
          },
        },
      };
    };
    const engine = new Engine(config, factory);
    await expect(engine.createMemory({ source: 'curator', scope: 'vault', content: 'A fact.' }))
      .rejects.toMatchObject({ code: ErrorCode.RequestTimeout });
    expect(calls).toBe(1); // sent once, never again
    expect(builds).toBe(1); // a timeout is not a broken connection
  });

  it('gives create-memory a longer timeout than the SDK default; other tools keep the default', async () => {
    const seen: Array<{ name: string; options: unknown }> = [];
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req, _schema, options) => {
          seen.push({ name: req.name, options });
          return envelope(req.name === 'create-memory' ? { id: 7, operation: 'add' } : { memories: [] });
        },
      },
    });
    const engine = new Engine(config, factory);
    await engine.createMemory({ source: 'curator', scope: 'vault', content: 'A fact.' });
    await engine.listMemories({ source: 'curator' });
    expect(seen).toEqual([
      { name: 'create-memory', options: { timeout: CREATE_MEMORY_TIMEOUT_MS } },
      { name: 'list-memories', options: undefined },
    ]);
    expect(CREATE_MEMORY_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it('the production SDK adapter passes the per-call timeout through to the MCP client', async () => {
    const seen: unknown[][] = [];
    const sdk = {
      connect: async () => {},
      callTool: async (...args: unknown[]) => { seen.push(args); return envelope({ id: 1, operation: 'add' }); },
    };
    const engine = new Engine(config, () => ({
      transport: { close: async () => {} },
      client: adaptSdkClient(sdk as unknown as Parameters<typeof adaptSdkClient>[0]),
    }));
    await engine.createMemory({ source: 'curator', scope: 'vault', content: 'A fact.' });
    await engine.getNode('x').catch(() => {});
    expect(seen[0]?.[2]).toEqual({ timeout: CREATE_MEMORY_TIMEOUT_MS });
    expect(seen[1]?.[2]).toBeUndefined();
  });

  it('the real MCP SDK client honors the timeout the adapter passes', async () => {
    const server = new McpServer({ name: 'slow-engine', version: '0' });
    server.tool('slow', async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data: {} }) }] };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = adaptSdkClient(new Client({ name: 'test', version: '0' }));
    await client.connect(clientSide);
    await expect(client.callTool({ name: 'slow', arguments: {} }, undefined, { timeout: 30 }))
      .rejects.toMatchObject({ code: ErrorCode.RequestTimeout });
    await expect(client.callTool({ name: 'slow', arguments: {} }, undefined, { timeout: 2_000 }))
      .resolves.toMatchObject({ content: [{ type: 'text' }] });
    await server.close();
  });

  it('close() before connect is a no-op', async () => {
    let builds = 0;
    const factory: EngineClientFactory = () => {
      builds += 1;
      return {
        transport: { close: async () => {} },
        client: { connect: async () => {}, callTool: async () => ({ content: [] }) },
      };
    };
    const engine = new Engine(config, factory);
    await expect(engine.close()).resolves.toBeUndefined();
    expect(builds).toBe(0);
  });

  it('connect() is idempotent', async () => {
    let builds = 0;
    let connects = 0;
    const factory: EngineClientFactory = () => {
      builds += 1;
      return {
        transport: { close: async () => {} },
        client: { connect: async () => { connects += 1; }, callTool: async () => ({ content: [] }) },
      };
    };
    const engine = new Engine(config, factory);
    await engine.connect();
    await engine.connect();
    expect(builds).toBe(1);
    expect(connects).toBe(1);
  });
});

describe('Engine field-guess facade', () => {
  it('surfaces candidate warnings without fetching candidate values', async () => {
    const requests: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const page = {
      candidates: [{
        node_id: 'n1', title: 'Project One', file_path: 'Projects/One.md',
        types: ['project'], version: 4, content_hash: 'abc', file_mtime: 123,
        fields: [{
          field: 'status', description: 'Current lifecycle state', field_type: 'enum',
          list_item_type: null, required: true, enum_values: ['active', 'paused'],
          reference_target: null, claiming_types: ['project'], eligibility: 'invalid',
          definition_hash: 'definition-1',
        }],
      }],
      next_cursor: 'next-page',
    };
    const warning = {
      code: 'FIELD_PRESENCE_BACKFILL_PENDING',
      severity: 'warning' as const,
      message: 'Explicit-null presence is not ready.',
    };
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (request) => {
          requests.push(request);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: page, warnings: [warning] }) }] };
        },
      },
    });

    await expect(new Engine(config, factory).listFieldGuessCandidates({ limit: 50, cursor: 'cursor-1' }))
      .resolves.toEqual({ page, warnings: [warning] });
    expect(requests).toEqual([{
      name: 'list-field-guess-candidates',
      arguments: { limit: 50, cursor: 'cursor-1' },
    }]);
  });

  describe('an on-demand run\'s listing (#644)', () => {
    const offered = (field: string) => ({ field, definition_hash: 'd'.repeat(64) });
    const candidate = (fields: string[]) => ({ node_id: 'n1', title: 'Sync', file_path: 'Sync.md', types: ['meeting'], version: 1, content_hash: 'h', file_mtime: 1, fields: fields.map(offered) });
    const listing = (data: Record<string, unknown>, warnings: unknown[] = []) => {
      const requests: Array<{ name: string; arguments: Record<string, unknown> }> = [];
      const factory: EngineClientFactory = () => ({
        transport: { close: async () => {} },
        client: {
          connect: async () => {},
          callTool: async (request) => {
            requests.push(request);
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data, warnings }) }] };
          },
        },
      });
      return { requests, engine: new Engine(config, factory) };
    };
    const requested = { fields: ['date', 'people'], query: { types: ['meeting'] } };

    it('sends the fields and the query, and takes a page the Engine marked as requested', async () => {
      const page = { mode: 'requested', candidates: [candidate(['date'])], next_cursor: null };
      const { engine, requests } = listing(page);
      await expect(engine.listFieldGuessCandidates({ limit: 20, requested })).resolves.toEqual({ page, warnings: [] });
      expect(requests).toEqual([{ name: 'list-field-guess-candidates', arguments: { limit: 20, requested } }]);
      // Replacing values that fail their type is asked for only when the run said so.
      await engine.listFieldGuessCandidates({ requested: { ...requested, replace_invalid: true } });
      expect(requests[1]!.arguments).toEqual({ requested: { ...requested, replace_invalid: true } });
      await engine.listFieldGuessCandidates({ requested: { ...requested, replace_invalid: false } });
      expect(requests[2]!.arguments).toEqual({ requested });
    });

    it('refuses the nightly listing an older Engine answers with', async () => {
      // An Engine from before #644 drops `requested`: no mark, and whatever fields the nightly rule offers.
      const { engine } = listing({ candidates: [candidate(['status'])], next_cursor: null });
      await expect(engine.listFieldGuessCandidates({ requested })).rejects.toMatchObject({
        code: 'ENGINE_TOO_OLD', message: expect.stringContaining('Update the Engine'),
      });
      // Even an empty unmarked page is not this run's scope.
      await expect(listing({ candidates: [], next_cursor: null }).engine.listFieldGuessCandidates({ requested }))
        .rejects.toMatchObject({ code: 'ENGINE_TOO_OLD' });
      // A marked page offering a field the run did not name is refused too.
      await expect(listing({ mode: 'requested', candidates: [candidate(['date', 'status'])], next_cursor: null }).engine
        .listFieldGuessCandidates({ requested })).rejects.toMatchObject({ code: 'ENGINE_TOO_OLD' });
    });

    it('lets the Engine\'s not-ready answer through, and leaves the nightly listing unchecked', async () => {
      const pending = [{ code: 'FIELD_PRESENCE_BACKFILL_PENDING', severity: 'warning', message: 'pending' }];
      await expect(listing({ candidates: [], next_cursor: null }, pending).engine.listFieldGuessCandidates({ requested }))
        .resolves.toMatchObject({ page: { candidates: [] } });
      await expect(listing({ candidates: [candidate(['status'])], next_cursor: null }).engine.listFieldGuessCandidates({ limit: 5 }))
        .resolves.toMatchObject({ page: { candidates: [{ node_id: 'n1' }] } });
    });
  });

  it('queries exact title only and hard-caps the result count at two', async () => {
    const requests: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const nodes = [{
      id: 'n1', title: 'Exact Title', file_path: 'Notes/Exact Title.md', types: ['note'],
      version: 2, field_count: 3,
    }];
    const engine = new Engine(config, factoryReturning({ nodes }, request => requests.push(request)));

    await expect(engine.findNodesByExactTitle('Exact Title', 99)).resolves.toEqual(nodes);
    expect(requests).toEqual([{
      name: 'query-nodes',
      arguments: { title_eq: 'Exact Title', limit: 2 },
    }]);
  });

  it('lists active projects by the vault map\'s kind and status field, and none turns each off', async () => {
    const requests: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const nodes = [{ id: 'p1', title: 'Pilot', file_path: 'Pilot.md', fields: { state: 'live' } }];
    const engine = new Engine(config, factoryReturning({ nodes }, request => requests.push(request)));

    expect(await engine.listActiveProjects(['live'], 'initiative', 'state')).toEqual([
      { id: 'p1', title: 'Pilot', file_path: 'Pilot.md', status: 'live' },
    ]);
    expect(requests[0]?.arguments).toMatchObject({
      types: ['initiative'], fields: { state: { one_of: ['live'] } }, include_fields: ['state'],
    });
    // No status field: every project of the kind, without a status.
    expect(await engine.listActiveProjects(['live'], 'initiative', null)).toEqual([
      { id: 'p1', title: 'Pilot', file_path: 'Pilot.md', status: null },
    ]);
    expect(requests[1]?.arguments).not.toHaveProperty('fields');
    // No project kind: no projects, and no call.
    expect(await engine.listActiveProjects(['live'], null, 'state')).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it('fetches the nullable get-node detail shape with embeds explicitly disabled', async () => {
    const requests: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const detail = {
      id: 'n1', title: null, file_path: 'Inbox/Untitled.md', types: ['note'], version: 2,
      fields: {}, relationships: { outgoing: {}, incoming: {} }, body: null,
      metadata: { content_hash: 'hash-1', file_mtime: 123, indexed_at: 456 },
    };
    const engine = new Engine(config, factoryReturning(detail, request => requests.push(request)));

    await expect(engine.getNode('n1')).resolves.toEqual(detail);
    expect(requests).toEqual([{
      name: 'get-node',
      arguments: { node_id: 'n1', include_embeds: false },
    }]);
  });

  it('sends the exact combined field patch and both CAS guards', async () => {
    const requests: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const preview = { node_id: 'n1', dry_run: false };
    const engine = new Engine(config, factoryReturning(preview, request => requests.push(request)));

    await expect(engine.updateNodeFieldsCas({
      nodeId: 'n1',
      setFields: { status: 'active' },
      expectedVersion: 4,
      expectedContentHash: 'abc',
      guard: {
        offered_fields: [{ field: 'status', definition_hash: 'definition-1' }],
      },
      dryRun: false,
    })).resolves.toEqual(preview);
    expect(requests).toEqual([{
      name: 'update-node',
      arguments: {
        node_id: 'n1',
        set_fields: { status: 'active' },
        expected_version: 4,
        expected_content_hash: 'abc',
        field_guess_guard: {
          offered_fields: [{ field: 'status', definition_hash: 'definition-1' }],
        },
        dry_run: false,
      },
    }]);
  });
});

describe('Engine.wikiReconcile', () => {
  const input: WikiReconcileInput = {
    project: 'Demo',
    project_id: 'root-1',
    reconcile_key: 'reconcile-1',
    pages: [],
    home: {
      expected_version: 3,
      sections: [{ name: 'Now', mode: 'replace', content: 'Current.' }],
      evidence_hash: 'evidence-1',
      curated_at: '2026-08-14T12:00:00.000Z',
      refresh_live: true,
    },
    dry_run: true,
  };

  it('sends the exact typed request and returns data with envelope warnings', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const data = {
      operation_id: null,
      reconcile_key: 'reconcile-1',
      plan_digest: 'digest-1',
      reused: false,
      dry_run: true,
      created: [],
      updated: [],
      mappings: [],
      home: { node_id: 'home', title: 'Demo Wiki', file_path: 'Wikis/Demo Wiki.md', version: 4, created: false },
      topology_hash: 'topology-2',
      warnings: [],
      preview: { total: 0, items: [], truncated: false },
    };
    const warning = { code: 'WIKI_SCHEMA_BOOTSTRAP_REQUIRED', message: 'Schema upgrade required.', severity: 'warning' as const };
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          seen = req;
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data, warnings: [warning] }) }] };
        },
      },
    });

    const result = await new Engine(config, factory).wikiReconcile(input);

    expect(seen).toEqual({ name: 'wiki-reconcile', arguments: input });
    expect(result).toEqual({ data, warnings: [warning] });
  });

  it('preserves stale engine error codes without retrying', async () => {
    let calls = 0;
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async () => {
          calls += 1;
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'STALE_NODE', message: 'version changed' }, warnings: [] }) }] };
        },
      },
    });

    await expect(new Engine(config, factory).wikiReconcile(input))
      .rejects.toMatchObject({ code: 'STALE_NODE' });
    expect(calls).toBe(1);
  });
});

describe('Engine wiki mutation surface', () => {
  it('deletes a note only for remove-dossier, the owner\'s own request (#723): no wiki path or sweep deletes', () => {
    // Wiki pages are retired, never deleted (2026-08). remove-dossier (owner's choice, 2026-11-21)
    // is the one caller of the client's delete-node.
    const source = readFileSync(new URL('../src/engine.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/node-deleted/);
    expect(source.match(/'delete-node'/g)).toHaveLength(1);
    const dir = new URL('../src/', import.meta.url);
    const callers = readdirSync(dir, { recursive: true }).map(String).filter(file => file.endsWith('.ts') && file !== 'engine.ts')
      .filter(file => /\.deleteNode\(|'delete-node'/.test(readFileSync(new URL(file, dir), 'utf8')));
    expect(callers).toEqual(['dossier/remove.ts']);
  });
});

describe('Engine.webSearch', () => {
  it('passes query + num_results and returns the results array', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ results: [{ title: 'A', url: 'https://a', snippet: 's', published: '2026-01-01' }] }, (r) => { seen = r; }));
    const out = await engine.webSearch('owls', 8);
    expect(out).toEqual([{ title: 'A', url: 'https://a', snippet: 's', published: '2026-01-01' }]);
    expect(seen).toMatchObject({ name: 'web-search', arguments: { query: 'owls', num_results: 8 } });
  });
  it('tolerates a missing results array', async () => {
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never, factoryReturning({}));
    expect(await engine.webSearch('q')).toEqual([]);
  });
});

describe('Engine.listMemories', () => {
  it('passes the given filters to list-memories and returns the memories array', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const memory = {
      id: 1, source: 'curator', scope: 'vault' as const, node_id: null,
      content: 'Prefers concise summaries.', category: 'preference',
      metadata_json: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
    };
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ memories: [memory], total: 1 }, (r) => { seen = r; }));
    const out = await engine.listMemories({ source: 'curator', scope: 'vault', limit: 20 });
    expect(out).toEqual([memory]);
    expect(seen).toMatchObject({ name: 'list-memories', arguments: { source: 'curator', scope: 'vault', limit: 20 } });
  });

  it('tolerates an empty memories array', async () => {
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never, factoryReturning({ memories: [], total: 0 }));
    expect(await engine.listMemories({})).toEqual([]);
  });
});

describe('Engine.fetchUrl', () => {
  it('returns {url, content}', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ url: 'https://a', content: 'readable text' }, (r) => { seen = r; }));
    expect(await engine.fetchUrl('https://a')).toEqual({ url: 'https://a', content: 'readable text' });
    expect(seen).toMatchObject({ name: 'fetch-url', arguments: { url: 'https://a' } });
  });
});

describe('Engine.recordUsage', () => {
  it('never replays an insert after an ambiguous transport response', async () => {
    let inserts = 0;
    const engine = new Engine(config, () => ({ transport: { close: async () => {} }, client: {
      connect: async () => {}, callTool: async () => { inserts++; throw new Error('reply lost after insert'); },
    } }));
    await expect(engine.recordUsage({ provider: 'openrouter' })).rejects.toThrow('reply lost');
    expect(inserts).toBe(1);
  });
  it('calls record-usage with the given args', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ id: 1, cost_usd: 0.01, cost_basis: 'known' }, (r) => { seen = r; }));
    await engine.recordUsage({ provider: 'fireworks', service: 'curator', purpose: 'wiki-synthesis' });
    expect(seen).toMatchObject({
      name: 'record-usage',
      arguments: { provider: 'fireworks', service: 'curator', purpose: 'wiki-synthesis' },
    });
  });
});

describe('Engine.semanticRelated', () => {
  it('passes the query as hybrid search with status include and maps nodes', async () => {
    let captured: Record<string, unknown> | undefined;
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          captured = req.arguments;
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes: [
            { id: 'n1', title: 'Alpha', types: ['note'], fields: { status: 'open' }, match_sources: ['semantic'] },
            { id: 'n2', title: 'Beta', types: ['task'], fields: {}, match_sources: ['fts', 'semantic'] },
          ] } }) }] };
        },
      },
    });
    const out = await new Engine(config, factory).semanticRelated('Demo\nfix login', 15, {});
    expect(captured?.['query']).toBe('Demo\nfix login');
    expect(captured?.['include_fields']).toEqual(['status']);
    expect(captured?.['limit']).toBe(15);
    expect(out).toEqual([
      { id: 'n1', title: 'Alpha', types: ['note'], status: 'open', match_sources: ['semantic'] },
      { id: 'n2', title: 'Beta', types: ['task'], status: null, match_sources: ['fts', 'semantic'] },
    ]);
  });

  it('never returns generated wiki pages or settings notes as evidence', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          calls.push(req.arguments);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes: [] } }) }] };
        },
      },
    });
    const engine = new Engine(config, factory);
    await engine.semanticRelated('q', 5, { settingsDir: 'System/Settings/' });
    await engine.semanticRelated('q', 5, {});
    expect(calls[0]).toMatchObject({ without_types: ['wiki'], without_path_prefix: 'System/Settings/' });
    expect(calls[1]).toMatchObject({ without_types: ['wiki'] });
    expect(calls[1]).not.toHaveProperty('without_path_prefix');
  });

  it('sends exactly today\'s query with the default vault map', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          calls.push(req.arguments);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes: [] } }) }] };
        },
      },
    });
    await new Engine(config, factory).semanticRelated('q', 5, { settingsDir: 'Settings', vault: DEFAULT_VAULT });
    expect(calls[0]).toEqual({
      query: 'q', include_fields: ['status'], without_fields: ['vault_engine_projection'], without_types: ['wiki'],
      without_path_prefix: 'Settings/', limit: 5,
    });
  });

  it('reads the vault map\'s wiki kind and status fields; none leaves them out', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          calls.push(req.arguments);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes: [
            { id: 't', title: 'Task', types: ['todo'], fields: { state: 'stuck', phase: 'ignored' } },
            { id: 'p', title: 'Initiative', types: ['initiative'], fields: { state: 'ignored', phase: { value: 'live' } } },
            { id: 'n', title: 'Note', types: ['note'], fields: { state: 'draft' } },
          ] } }) }] };
        },
      },
    });
    const engine = new Engine(config, factory);
    const vault = { ...DEFAULT_VAULT, wikiType: 'page', projectType: 'initiative', taskStatusField: 'state', projectStatusField: 'phase' };
    const out = await engine.semanticRelated('q', 5, { vault });
    expect(calls[0]).toMatchObject({ include_fields: ['state', 'phase'], without_types: ['page'] });
    expect(out.map(c => [c.id, c.status])).toEqual([['t', 'stuck'], ['p', 'live'], ['n', 'draft']]);

    await engine.semanticRelated('q', 5, { vault: { ...vault, wikiType: null, taskStatusField: null, projectStatusField: null } });
    expect(calls[1]).not.toHaveProperty('include_fields');
    expect(calls[1]).not.toHaveProperty('without_types');
  });

  it('tolerates the {value} field envelope and missing types', async () => {
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes: [
          { id: 'n3', title: 'Gamma', fields: { status: { value: 'blocked' } } },
        ] } }) }] }),
      },
    });
    const out = await new Engine(config, factory).semanticRelated('q', 5, {});
    expect(out[0]).toEqual({ id: 'n3', title: 'Gamma', types: [], status: 'blocked', match_sources: undefined });
  });
});

// Captures every tool call so multi-step methods (wiki-write + update-node) can be asserted.
function recordingFactory(calls: Array<{ name: string; arguments: Record<string, unknown> }>, data: unknown = { node_id: 'w9', created: false }): EngineClientFactory {
  return () => ({
    transport: { close: async () => {} },
    client: {
      connect: async () => {},
      callTool: async (req) => {
        calls.push({ name: req.name, arguments: req.arguments });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data, warnings: [] }) }] };
      },
    },
  });
}

describe('Engine.wikiWriteThemed', () => {
  it('writes a subpage with no page_kind, refresh_live:false, then stamps wiki_state', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const engine = new Engine(config, recordingFactory(calls, { node_id: 'w9', created: true }));
    const res = await engine.wikiWriteThemed('Demo', 'Demo — Auth Pot', 'BODY', 'active', 'workstream', '**2026-06-07** — created', false);
    expect(res).toEqual({ node_id: 'w9', created: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.name).toBe('wiki-write');
    expect(calls[0]!.arguments).toMatchObject({
      project: 'Demo', target: 'subpage', subpage_title: 'Demo — Auth Pot', refresh_live: false, dry_run: false,
    });
    expect(calls[0]!.arguments).not.toHaveProperty('page_kind');
    expect(calls[0]!.arguments.sections).toEqual([
      { name: 'Summary', mode: 'replace', content: 'BODY' },
      { name: 'Log', mode: 'append', content: '**2026-06-07** — created' },
    ]);
    expect(calls[1]!.name).toBe('update-node');
    expect(calls[1]!.arguments).toMatchObject({ node_id: 'w9', set_fields: { wiki_state: 'active', wiki_kind: 'workstream' }, dry_run: false });
  });

  it('omits the Log section when logNote is empty', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await new Engine(config, recordingFactory(calls)).wikiWriteThemed('Demo', 'Demo — X', 'B', 'active', 'freeform', '', false);
    expect(calls[0]!.arguments.sections).toEqual([{ name: 'Summary', mode: 'replace', content: 'B' }]);
  });

  it('skips the wiki_state stamp under dry-run', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await new Engine(config, recordingFactory(calls)).wikiWriteThemed('Demo', 'Demo — X', 'B', 'active', 'spotlight', 'note', true);
    expect(calls.map(c => c.name)).toEqual(['wiki-write']); // no update-node
    expect(calls[0]!.arguments.dry_run).toBe(true);
  });
});

describe('Engine.retireThemedPage', () => {
  it('appends a dated Status note and stamps the retire state', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const engine = new Engine(config, recordingFactory(calls, { node_id: 'w7', created: false }));
    const res = await engine.retireThemedPage('Demo', 'Demo — Gone', 'retired', 'merged into Auth Pot', false, new Date('2026-06-07T00:00:00Z'));
    expect(res).toEqual({ node_id: 'w7', created: false });
    expect(calls[0]!.name).toBe('wiki-write');
    expect(calls[0]!.arguments).toMatchObject({ project: 'Demo', target: 'subpage', subpage_title: 'Demo — Gone', refresh_live: false });
    expect(calls[0]!.arguments.sections).toEqual([
      { name: 'Status', mode: 'replace', content: '**2026-06-07** — Retired (retired): merged into Auth Pot' },
    ]);
    expect(calls[1]!).toMatchObject({ name: 'update-node', arguments: { node_id: 'w7', set_fields: { wiki_state: 'retired' } } });
  });

  it('skips the stamp under dry-run', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await new Engine(config, recordingFactory(calls)).retireThemedPage('Demo', 'Demo — Gone', 'dormant', '', true, new Date('2026-06-07T00:00:00Z'));
    expect(calls.map(c => c.name)).toEqual(['wiki-write']);
  });
});

describe('Engine.readNodeFields', () => {
  it('reads multiple fields off one node, unwrapping the {value} envelope', async () => {
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: {
          id: 'w1', title: 'T', types: ['wiki'], body: '',
          fields: { wiki_evidence_hash: 'h1', wiki_curated_at: { value: '2026-06-01T00:00:00Z' } },
        } }) }] }),
      },
    });
    const out = await new Engine(config, factory).readNodeFields('w1', ['wiki_evidence_hash', 'wiki_curated_at', 'missing']);
    expect(out).toEqual({ wiki_evidence_hash: 'h1', wiki_curated_at: '2026-06-01T00:00:00Z', missing: undefined });
  });
});

describe('refreshHome', () => {
  it('writes the home with refresh_live:true and an appended Log entry', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          calls.push({ name: req.name, arguments: req.arguments });
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { node_id: 'home1', created: false } }) }] };
        },
      },
    });
    const engine = new Engine({} as Config, factory);
    await engine.refreshHome('Demo', '**2026-06-11** — Added page.', false);
    expect(calls).toEqual([{
      name: 'wiki-write',
      arguments: {
        project: 'Demo', refresh_live: true, dry_run: false,
        sections: [{ name: 'Log', mode: 'append', content: '**2026-06-11** — Added page.' }],
      },
    }]);
  });
});

describe('wikiWriteThemed origin', () => {
  it('stamps wiki_origin alongside state/kind when origin is given', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          calls.push({ name: req.name, arguments: req.arguments });
          const data = req.name === 'wiki-write' ? { node_id: 'n1', created: true } : { updated: true };
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] };
        },
      },
    });
    const engine = new Engine({} as Config, factory);
    await engine.wikiWriteThemed('Demo', 'Demo — X', 'b', 'active', 'workstream', '', false, 'requested');
    const stamp = calls.find(c => c.name === 'update-node');
    expect((stamp?.arguments as { set_fields?: Record<string, unknown> }).set_fields).toEqual({
      wiki_state: 'active', wiki_kind: 'workstream', wiki_origin: 'requested',
    });
  });

  it('omits wiki_origin when no origin is given', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          calls.push({ name: req.name, arguments: req.arguments });
          const data = req.name === 'wiki-write' ? { node_id: 'n1', created: true } : { updated: true };
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] };
        },
      },
    });
    const engine = new Engine({} as Config, factory);
    await engine.wikiWriteThemed('Demo', 'Demo — X', 'b', 'active', 'workstream', '', false);
    const stamp = calls.find(c => c.name === 'update-node');
    expect((stamp?.arguments as { set_fields?: Record<string, unknown> }).set_fields).toEqual({
      wiki_state: 'active', wiki_kind: 'workstream',
    });
  });
});

describe('Engine.createMemory', () => {
  it('passes args to create-memory and returns the created row', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ id: 7, content: 'A fact.', category: 'fact', dedup_checked: true, embedding: false },
        (r) => { seen = r; }));
    const out = await engine.createMemory({ source: 'curator', scope: 'node', node_id: 'home1', content: 'A fact.', category: 'fact' });
    expect(out).toMatchObject({ id: 7 });
    expect(seen).toMatchObject({
      name: 'create-memory',
      arguments: { source: 'curator', scope: 'node', node_id: 'home1', content: 'A fact.', category: 'fact' },
    });
  });

  it("passes on the Engine's warning that it added the memory without merging (#346)", async () => {
    const warning = { code: 'MEMORY_CONSOLIDATION_FAILED', severity: 'warning', message: 'consolidation failed: 403 Key limit exceeded' };
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { id: 7, operation: 'add' }, warnings: [warning] }) }] }),
      },
    });
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never, factory);
    const out = await engine.createMemory({ source: 'curator', scope: 'vault', content: 'A fact.' });
    expect(out).toEqual({ id: 7, operation: 'add', superseded: [], consolidationFailure: warning.message });
  });

  it('reports no consolidation failure when the Engine warns of nothing', async () => {
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never, factoryReturning({ id: 7, operation: 'add' }));
    expect(await engine.createMemory({ source: 'curator', scope: 'vault', content: 'A fact.' })).toEqual({ id: 7, operation: 'add', superseded: [] });
  });

  it('propagates a DUPLICATE_MEMORY tool error as EngineError', async () => {
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'DUPLICATE_MEMORY', message: 'dup' } }) }] }),
      },
    });
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never, factory);
    await expect(engine.createMemory({ source: 'curator', scope: 'node', node_id: 'h', content: 'x' }))
      .rejects.toMatchObject({ code: 'DUPLICATE_MEMORY' });
  });

  it('forwards first-class evidence to create-memory verbatim (Memories v3 §3)', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ id: 8 }, (r) => { seen = r; }));
    await engine.createMemory({
      source: 'curator', scope: 'node', node_id: 'home1', content: 'A fact.', category: 'fact',
      evidence: { kind: 'curation-run', ref: 'run-1', node_id: 'home1', hash: 'hash-1' },
    });
    expect(seen?.arguments.evidence).toEqual({ kind: 'curation-run', ref: 'run-1', node_id: 'home1', hash: 'hash-1' });
  });
});

describe('Engine.createMemory operation and usage (#298)', () => {
  function engineAnswering(data: unknown, onCall?: (r: { name: string; arguments: Record<string, unknown> }) => void) {
    const recorded: Array<{ action: string; detail: string }> = [];
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never, factoryReturning(data, onCall));
    engine.setRecorder({ record: (e: { action: string; detail: string }) => recorded.push(e) } as never);
    return { engine, recorded };
  }

  it('returns the operation and journals nothing for a noop: nothing was written', async () => {
    const { engine, recorded } = engineAnswering({ id: 3, operation: 'noop', superseded: [] });
    const out = await engine.createMemory({ source: 'curator', scope: 'vault', content: 'Known fact.' });
    expect(out).toEqual({ id: 3, operation: 'noop', superseded: [] });
    expect(recorded).toEqual([]);
  });

  it('journals a write that replaces an older memory, naming it', async () => {
    const { engine, recorded } = engineAnswering({ id: 9, operation: 'contradict', superseded: [{ id: 4, content: 'old' }] });
    expect(await engine.createMemory({ source: 'curator', scope: 'vault', content: 'New fact.' })).toEqual({ id: 9, operation: 'contradict', superseded: [4] });
    expect(recorded).toEqual([expect.objectContaining({ action: 'memory-created', detail: 'memory: "New fact." (supersedes memory 4)' })]);
  });

  it('charges a call\'s own spend function in place of the observer, and journals nothing when asked not to (#659)', async () => {
    const observed: Array<number | null> = [];
    const charged: Array<number | null> = [];
    const { engine, recorded } = engineAnswering({ id: 5, operation: 'update', superseded: [{ id: 2, content: 'old' }], consolidation_cost_usd: 0.004 });
    engine.setSpendObserver(usd => observed.push(usd));
    const out = await engine.createMemory({ source: 'curator', scope: 'vault', content: 'x', usage: { runRef: 'run-1', sourceRef: 'memory-extraction-run' } },
      { onSpend: usd => charged.push(usd), journal: false });
    expect(out).toEqual({ id: 5, operation: 'update', superseded: [2] });
    expect([observed, charged, recorded]).toEqual([[], [0.004], []]);
  });

  it("passes the consolidation cost to the spend observer, but only for calls on the Curator's account", async () => {
    const seen: Array<number | null> = [];
    const priced = engineAnswering({ id: 1, operation: 'add', consolidation_cost_usd: 0.003 });
    priced.engine.setSpendObserver(usd => seen.push(usd));
    await priced.engine.createMemory({ source: 'curator', scope: 'vault', content: 'x', usage: { runRef: 'r' } });
    await priced.engine.createMemory({ source: 'curator', scope: 'vault', content: 'y' }); // Engine's account
    const unknown = engineAnswering({ id: 2, operation: 'noop', consolidation_cost_usd: null });
    unknown.engine.setSpendObserver(usd => seen.push(usd));
    await unknown.engine.createMemory({ source: 'curator', scope: 'vault', content: 'z', usage: { runRef: 'r' } });
    const noCall = engineAnswering({ id: 3, operation: 'add' });
    noCall.engine.setSpendObserver(usd => seen.push(usd));
    await noCall.engine.createMemory({ source: 'curator', scope: 'vault', content: 'w', usage: { runRef: 'r' } });
    expect(seen).toEqual([0.003, null]);
  });

  it('sends usage as Curator spend under the run and source', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const { engine } = engineAnswering({ id: 1, operation: 'add' }, (r) => { seen = r; });
    await engine.createMemory({ source: 'curator', scope: 'vault', content: 'x', usage: { runRef: 'run-1', sourceRef: 'memory-sweep' } });
    expect(seen?.arguments.usage).toEqual({ service: 'curator', run_ref: 'run-1', source_ref: 'memory-sweep' });
    await engine.createMemory({ source: 'curator', scope: 'vault', content: 'y' });
    expect(seen?.arguments).not.toHaveProperty('usage');
    // A run paid from its own limit names the purpose its consolidation call is recorded under (#659).
    await engine.createMemory({ source: 'curator', scope: 'vault', content: 'z', usage: { runRef: 'run-2', sourceRef: 'memory-extraction-run', purpose: 'memory-consolidation-run' } });
    expect(seen?.arguments.usage).toEqual({ service: 'curator', run_ref: 'run-2', source_ref: 'memory-extraction-run', purpose: 'memory-consolidation-run' });
  });
});

describe('Engine.expireMemory / listMemoryNearPairs (v3 P3)', () => {
  it('expireMemory calls expire-memory with the exact args and journals the action', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const recorded: Array<{ action: string; detail: string }> = [];
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ id: 4, expired_at: 'now' }, (r) => { seen = r; }));
    engine.setRecorder({ record: (e: { action: string; detail: string }) => recorded.push(e) } as never);
    await engine.expireMemory({ id: 4, reason: 'contradicted', superseded_by: 9 });
    expect(seen).toMatchObject({ name: 'expire-memory', arguments: { id: 4, reason: 'contradicted', superseded_by: 9 } });
    expect(recorded[0]).toMatchObject({ action: 'memory-expired' });
    expect(recorded[0]!.detail).toContain('superseded by 9');
  });

  it('listMemoryNearPairs returns pairs + total', async () => {
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ pairs: [{ a: { id: 1, content: 'a' }, b: { id: 2, content: 'b' }, distance: 0.1 }], total_in_band: 5 }, () => {}));
    const r = await engine.listMemoryNearPairs({ limit: 200 });
    expect(r.pairs).toHaveLength(1);
    expect(r.total_in_band).toBe(5);
  });

  it('listMemoryNearPairs defaults safely on a sparse envelope', async () => {
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never, factoryReturning({}));
    const r = await engine.listMemoryNearPairs({});
    expect(r.pairs).toEqual([]);
    expect(r.total_in_band).toBe(0);
  });

  it('listMemories forwards the evidence_node_id filter', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ memories: [] }, (r) => { seen = r; }));
    await engine.listMemories({ evidence_node_id: 'n1', limit: 50 });
    expect(seen?.arguments).toEqual({ evidence_node_id: 'n1', limit: 50 });
  });
});

describe('Engine.wikiWrite at_a_glance', () => {
  it('prepends At a glance as the FIRST managed section when sections.at_a_glance is present', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const engine = new Engine(config, recordingFactory(calls, { node_id: 'w1', created: false }));
    await engine.wikiWrite('Demo', {
      now: 'N', focus: 'F', open_threads: 'O', log_entry: 'L', at_a_glance: 'G',
    }, false);
    expect(calls).toHaveLength(1);
    const sections = calls[0]!.arguments['sections'] as Array<{ name: string; mode: string; content: string }>;
    expect(sections[0]).toEqual({ name: 'At a glance', mode: 'replace', content: 'G' });
    // remaining four unchanged in order
    expect(sections[1]).toEqual({ name: 'Now', mode: 'replace', content: 'N' });
    expect(sections[2]).toEqual({ name: 'Focus', mode: 'replace', content: 'F' });
    expect(sections[3]).toEqual({ name: 'Open threads', mode: 'replace', content: 'O' });
    expect(sections[4]).toEqual({ name: 'Log', mode: 'append', content: 'L' });
    expect(sections).toHaveLength(5);
  });

  it('omits At a glance and leaves 4 sections unchanged when at_a_glance is absent', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const engine = new Engine(config, recordingFactory(calls, { node_id: 'w1', created: false }));
    await engine.wikiWrite('Demo', {
      now: 'N', focus: 'F', open_threads: 'O', log_entry: 'L',
    }, false);
    expect(calls).toHaveLength(1);
    const sections = calls[0]!.arguments['sections'] as Array<{ name: string; mode: string; content: string }>;
    expect(sections.some(s => s.name === 'At a glance')).toBe(false);
    expect(sections).toEqual([
      { name: 'Now', mode: 'replace', content: 'N' },
      { name: 'Focus', mode: 'replace', content: 'F' },
      { name: 'Open threads', mode: 'replace', content: 'O' },
      { name: 'Log', mode: 'append', content: 'L' },
    ]);
  });
});

describe('Engine.createNode', () => {
  it('calls create-node and returns the live result with envelope warnings', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const engine = new Engine(config, recordingFactory(calls, { node_id: 'tnode', file_path: 'Topics/Demo.md' }));
    const res = await engine.createNode({ title: 'Demo', types: ['topic'] });
    expect(res).toEqual({ node_id: 'tnode', file_path: 'Topics/Demo.md', warnings: [] });
    expect(calls[0]!.name).toBe('create-node');
    expect(calls[0]!.arguments).toMatchObject({ title: 'Demo', types: ['topic'], fields: {}, body: '' });
  });

  it('sends dry_run and returns the preview with envelope warnings', async () => {
    let createPreview: { name: string; arguments: Record<string, unknown> } | undefined;
    const warning = { code: 'BODY_WARNING', message: 'Preview warning', severity: 'warning' as const };
    const engine = new Engine(config, () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          createPreview = req;
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { dry_run: true, would_create: { file_path: 'Notes/T.md' } }, warnings: [warning] }) }] };
        },
      },
    }));

    const preview = await engine.createNode({
      title: 'T', types: ['note'], body: 'B', dryRun: true,
      conversationAuthority: {
        conversationId: 'c1', expectedRevision: 7,
        expectedLinkMode: 'unbound', expectedLinkedDocs: [],
      },
    });

    expect(createPreview).toMatchObject({
      name: 'create-node',
      arguments: {
        title: 'T', types: ['note'], body: 'B', dry_run: true,
        conversation_authority: {
          conversation_id: 'c1', expected_revision: 7,
          expected_link_mode: 'unbound', expected_linked_docs: [],
        },
      },
    });
    expect(preview).toEqual({ dry_run: true, would_create: { file_path: 'Notes/T.md' }, warnings: [warning] });
  });
});

describe('Engine.ensureTopicSchema', () => {
  it('no-ops when describe-schema finds the topic schema', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const engine = new Engine(config, recordingFactory(calls, { name: 'topic' }));
    await engine.ensureTopicSchema('topic');
    expect(calls.map(c => c.name)).toEqual(['describe-schema']); // found it → no create
  });

  it('creates the topic schema when describe-schema reports it missing', async () => {
    const names: string[] = [];
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          names.push(req.name);
          if (req.name === 'describe-schema') {
            // ok:false → Engine.call throws EngineError → ensureTopicSchema creates.
            return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'no such schema' } }) }] };
          }
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { name: 'topic' } }) }] };
        },
      },
    });
    await new Engine(config, factory).ensureTopicSchema('topic');
    expect(names).toEqual(['describe-schema', 'create-schema']);
  });
});

describe('Engine.ensureNoteSchema', () => {
  function missingSchemaFactory(calls: Array<{ name: string; arguments: Record<string, unknown> }>, createError?: string): EngineClientFactory {
    return () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          calls.push({ name: req.name, arguments: req.arguments });
          const failed = req.name === 'describe-schema' ? 'no such schema' : createError;
          return { content: [{ type: 'text', text: JSON.stringify(failed
            ? { ok: false, error: { code: 'NOT_FOUND', message: failed } }
            : { ok: true, data: { name: req.arguments.name } }) }] };
        },
      },
    });
  }

  it('no-ops when describe-schema finds the note schema', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await new Engine(config, recordingFactory(calls, { name: 'note' })).ensureNoteSchema('note');
    expect(calls).toEqual([{ name: 'describe-schema', arguments: { name: 'note' } }]);
  });

  it('creates a minimal note schema with no default directory when it is missing', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await new Engine(config, missingSchemaFactory(calls)).ensureNoteSchema('note');
    expect(calls[1]).toEqual({ name: 'create-schema', arguments: { name: 'note', display_name: 'Note', field_claims: [] } });
  });

  it('creates the schema of the kind it is given, and refuses a kind name with a path part', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await new Engine(config, missingSchemaFactory(calls)).ensureNoteSchema('log');
    await new Engine(config, missingSchemaFactory(calls)).ensureTopicSchema('subject', 'Subjects');
    expect(calls.filter(c => c.name === 'create-schema').map(c => c.arguments)).toEqual([
      { name: 'log', display_name: 'Log', field_claims: [] },
      { name: 'subject', display_name: 'Subject', default_directory: 'Subjects', field_claims: [] },
    ]);
    const refused: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    for (const kind of ['../outside', 'a/b', 'a\\b', '..', '_fields']) {
      await expect(new Engine(config, missingSchemaFactory(refused)).ensureNoteSchema(kind)).rejects.toThrow("can't name a kind");
    }
    expect(refused).toEqual([]);
  });

  it('keeps the topic schema rooted at Topics/', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await new Engine(config, missingSchemaFactory(calls)).ensureTopicSchema('topic');
    expect(calls[1]).toEqual({ name: 'create-schema',
      arguments: { name: 'topic', display_name: 'Topic', default_directory: 'Topics', field_claims: [] } });
  });

  it('roots a new topic schema at the folder it is given', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await new Engine(config, missingSchemaFactory(calls)).ensureTopicSchema('topic', 'Subjects');
    expect(calls[1]?.arguments).toMatchObject({ name: 'topic', default_directory: 'Subjects' });
  });

  it('swallows a create that lost a race to an existing schema and surfaces other errors', async () => {
    await expect(new Engine(config, missingSchemaFactory([], 'schema "note" already exists')).ensureNoteSchema('note')).resolves.toBeUndefined();
    await expect(new Engine(config, missingSchemaFactory([], 'disk full')).ensureNoteSchema('note')).rejects.toThrow('disk full');
  });
});

describe('Engine.projectEvidence', () => {
  function capturingFactory(captured: { args?: Record<string, unknown> }): EngineClientFactory {
    return () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          captured.args = req.arguments;
          return envelope({});
        },
      },
    });
  }

  it('passes meeting_recent_limit when given, clamped to 100', async () => {
    const captured: { args?: Record<string, unknown> } = {};
    await new Engine(config, capturingFactory(captured)).projectEvidence('Demo', 150);
    expect(captured.args?.['project']).toBe('Demo');
    expect(captured.args?.['meeting_recent_limit']).toBe(100);
  });

  it('omits meeting_recent_limit when not given', async () => {
    const captured: { args?: Record<string, unknown> } = {};
    await new Engine(config, capturingFactory(captured)).projectEvidence('Demo');
    expect(captured.args?.['project']).toBe('Demo');
    expect(captured.args?.['meeting_recent_limit']).toBeUndefined();
  });

  it('forwards since when provided', async () => {
    const captured: { args?: Record<string, unknown> } = {};
    await new Engine(config, capturingFactory(captured)).projectEvidence('Demo', 12, '2026-06-01T00:00:00Z');
    expect(captured.args?.['project']).toBe('Demo');
    expect(captured.args?.['meeting_recent_limit']).toBe(12);
    expect(captured.args?.['since']).toBe('2026-06-01T00:00:00Z');
  });

  it('omits since when not provided', async () => {
    const captured: { args?: Record<string, unknown> } = {};
    await new Engine(config, capturingFactory(captured)).projectEvidence('Demo');
    expect(captured.args?.['since']).toBeUndefined();
  });
});

describe('Engine.wikiWrite — Sources section', () => {
  it('appends a managed Sources section when sources is present', async () => {
    let seen: { arguments: Record<string, unknown> } | undefined;
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ node_id: 'h', created: true, narrative_status: 'ok' }, (r) => { seen = r; }));
    await engine.wikiWrite('T', { now: 'n', focus: 'f', open_threads: 'o', log_entry: 'l', sources: '- [A](https://a)' } as never, false);
    const sections = (seen!.arguments.sections as Array<{ name: string; content: string }>);
    const src = sections.find(s => s.name === 'Sources');
    expect(src).toMatchObject({ name: 'Sources', mode: 'replace', content: '- [A](https://a)' });
  });
  it('omits the Sources section when absent', async () => {
    let seen: { arguments: Record<string, unknown> } | undefined;
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ node_id: 'h', created: true }, (r) => { seen = r; }));
    await engine.wikiWrite('T', { now: 'n', focus: 'f', open_threads: 'o', log_entry: 'l' } as never, false);
    const sections = (seen!.arguments.sections as Array<{ name: string }>);
    expect(sections.find(s => s.name === 'Sources')).toBeUndefined();
  });
});

describe('listChangedNodes (v1.6)', () => {
  it('issues one query PER TYPE plus one per path prefix (engine types filter is an intersection), merges by id, reports truncation', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
          calls.push(req.arguments);
          // meeting query returns n1; daily-note query returns n2; path query returns n2+n3 (n2 overlaps)
          const t = req.arguments.types as string[] | undefined;
          const nodes = t?.[0] === 'meeting'
            ? [{ id: 'n1', title: 'A', file_path: 'Meetings/A.md' }]
            : t?.[0] === 'daily-note'
              ? [{ id: 'n2', title: 'B', file_path: 'Journal/B.md' }]
              : [{ id: 'n2', title: 'B', file_path: 'Journal/B.md' }, { id: 'n3', title: 'C', file_path: 'Clippings/C.md' }];
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes } }) }] };
        },
      },
    });
    const engine = new Engine(config, factory);
    const { nodes, truncated } = await engine.listChangedNodes({
      types: ['meeting', 'daily-note'], pathPrefixes: ['Clippings/'], modifiedSince: '2026-07-01T00:00:00.000Z',
    });
    expect(nodes.map(n => n.id).sort()).toEqual(['n1', 'n2', 'n3']);
    expect(truncated).toBe(false);
    // The engine's `types` filter is AND (node must have ALL listed types), so a
    // multi-type allowlist MUST fan out to one single-type query each.
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      types: ['meeting'], modified_since: '2026-07-01T00:00:00.000Z', select: ['id', 'file_path', 'title', 'file_mtime'],
      sort_by: 'file_mtime', sort_order: 'desc', offset: 0,
    });
    expect(calls[1]).toMatchObject({ types: ['daily-note'], modified_since: '2026-07-01T00:00:00.000Z' });
    expect(calls[2]).toMatchObject({ path_prefix: 'Clippings/', modified_since: '2026-07-01T00:00:00.000Z' });
  });

  type Row = { id: string; file_mtime: number };
  const rowsOf = (...ns: number[]): Row[] => ns.map(n => ({ id: `n${n}`, file_mtime: n * 1000 }));

  /** Serves `rows` (already newest first) one `limit`/`offset` page at a time, logging each
   *  call; `afterCall` may change `rows` between pages, as concurrent vault edits would. */
  function pagedFactory(rows: Row[], calls: Array<Record<string, unknown>>, afterCall?: (call: number) => void): EngineClientFactory {
    return () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
          calls.push(req.arguments);
          const offset = req.arguments.offset as number;
          const nodes = rows.slice(offset, offset + (req.arguments.limit as number))
            .map(r => ({ ...r, title: r.id, file_path: `P/${r.id}.md` }));
          afterCall?.(calls.length);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes } }) }] };
        },
      },
    });
  }

  const meetings = { types: ['meeting'], pathPrefixes: [], modifiedSince: '2026-07-01T00:00:00.000Z' };

  it('pages past the first page of a sub-query, overlapping pages, and returns all nodes newest first', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const engine = new Engine(config, pagedFactory(rowsOf(5, 4, 3, 2, 1), calls));
    const res = await engine.listChangedNodes({ ...meetings, pageSize: 4 });
    expect(res.nodes.map(n => n.id)).toEqual(['n5', 'n4', 'n3', 'n2', 'n1']);
    expect(res.nodes[0]).toEqual({ id: 'n5', title: 'n5', file_path: 'P/n5.md', file_mtime: 5000 });
    expect(res.truncated).toBe(false);
    expect(calls.map(c => c.offset)).toEqual([0, 2]); // page 2 re-reads 2 rows; it is short, so the sub-query ends
  });

  it('still reads every remaining node when one is deleted between pages', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const rows = rowsOf(6, 5, 4, 3, 2, 1);
    const engine = new Engine(config, pagedFactory(rows, calls, (call) => {
      if (call === 1) rows.splice(1, 1); // n5 deleted after page 1
    }));
    const res = await engine.listChangedNodes({ ...meetings, pageSize: 4 });
    expect(res.nodes.map(n => n.id)).toEqual(['n6', 'n5', 'n4', 'n3', 'n2', 'n1']);
    expect(res.truncated).toBe(false);
  });

  it('flags truncated when more nodes vanish between pages than the overlap covers', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const rows = rowsOf(6, 5, 4, 3, 2, 1);
    const engine = new Engine(config, pagedFactory(rows, calls, (call) => {
      if (call === 1) rows.splice(0, 3); // n6, n5, n4 leave the allowlist after page 1
    }));
    const res = await engine.listChangedNodes({ ...meetings, pageSize: 4 });
    expect(res.nodes.map(n => n.id)).not.toContain('n2'); // slipped past unread
    expect(res.truncated).toBe(true);
  });

  it('skips the type query when types is empty and flags truncated when a sub-query outlasts maxPages', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const engine = new Engine(config, pagedFactory(rowsOf(4, 3, 2, 1), calls));
    const res = await engine.listChangedNodes({ types: [], pathPrefixes: ['P/'], modifiedSince: '2026-07-01T00:00:00.000Z', pageSize: 2, maxPages: 2 });
    expect(res.nodes.map(n => n.id)).toEqual(['n4', 'n3', 'n2']);
    expect(res.truncated).toBe(true); // n1 was never read
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ path_prefix: 'P/' });
  });
});

describe('listMemoriesWithTotal / createMemory metadata (v1.6)', () => {
  it('returns memories plus total', async () => {
    const factory = factoryReturning({ memories: [{ id: 1, source: 'curator', scope: 'vault', node_id: null, content: 'c', category: null, created_at: 't', updated_at: 't' }], total: 42 });
    const engine = new Engine(config, factory);
    const { memories, total } = await engine.listMemoriesWithTotal({ source: 'curator', scope: 'vault' });
    expect(memories).toHaveLength(1);
    expect(total).toBe(42);
  });

  it('passes metadata through to create-memory', async () => {
    let captured: Record<string, unknown> | undefined;
    const factory = factoryReturning({ id: 7 }, (req) => { captured = req.arguments; });
    const engine = new Engine(config, factory);
    await engine.createMemory({
      source: 'curator', scope: 'vault', content: 'fact',
      metadata: { origin: 'memory-sweep', source_node_id: 'n1' },
    });
    expect(captured?.metadata).toEqual({ origin: 'memory-sweep', source_node_id: 'n1' });
  });
});

describe('org-sweep engine methods', () => {
  it('listSchemas maps the catalog with null-safe display/directory', async () => {
    const engine = new Engine(config, factoryReturning([
      { name: 'person', display_name: 'Person', icon: '👤', filename_template: null, default_directory: 'Persons' },
      { name: 'transcript', display_name: null, icon: null, filename_template: null, default_directory: null },
    ]));
    expect(await engine.listSchemas()).toEqual([
      { name: 'person', display_name: 'Person', default_directory: 'Persons' },
      { name: 'transcript', display_name: null, default_directory: null },
    ]);
  });

  it('listTypes returns the names of the types in use', async () => {
    const engine = new Engine(config, factoryReturning([
      { name: 'note', node_count: 1, has_schema: true, claim_count: 0 },
      { name: 'person', node_count: 0, has_schema: true, claim_count: 2 },
      { name: 'task', node_count: 3, has_schema: true, claim_count: 0 },
    ]));
    expect(await engine.listTypes()).toEqual(['note', 'task']);
  });

  it('listSchemas leaves out types that have no schema', async () => {
    const engine = new Engine(config, factoryReturning([
      { name: 'custom', node_count: 2, has_schema: false, display_name: null, default_directory: null },
      { name: 'task', node_count: 3, has_schema: true, display_name: 'Task', default_directory: 'Tasks' },
    ]));
    expect(await engine.listSchemas()).toEqual([{ name: 'task', display_name: 'Task', default_directory: 'Tasks' }]);
  });

  it('listUntypedNodes excludes every known type, paginates to exhaustion, dedupes', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const pageA = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, title: `t${i}`, file_path: `p/${i}.md`, types: [], version: 1 }));
    const pageB = [{ id: 'n0', title: 't0', file_path: 'p/0.md', types: [], version: 1 }, { id: 'last', title: 'last', file_path: 'p/last.md', types: [], version: 2 }];
    let call = 0;
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
          if (req.name === 'list-schemas') {
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: [{ name: 'task', node_count: 4 }, { name: 'note', node_count: 2 }] }) }] };
          }
          captured.push(req.arguments);
          call += 1;
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes: call === 1 ? pageA : pageB } }) }] };
        },
      },
    });
    const engine = new Engine(config, factory);
    const { nodes, truncated } = await engine.listUntypedNodes({ pathPrefixes: [] });
    expect(nodes).toHaveLength(201);            // 200 + 2 with one duplicate id
    expect(truncated).toBe(false);
    expect(captured[0]?.without_types).toEqual(['task', 'note']);
    expect(captured[0]?.offset).toBe(0);
    expect(captured[1]?.offset).toBe(200);
  });

  it('listUntypedNodes flags truncation at maxPages', async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({ id: `x${i}`, title: 't', file_path: 'p.md', types: [], version: 1 }));
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req: { name: string; arguments: Record<string, unknown> }) => ({
          content: [{ type: 'text', text: JSON.stringify({ ok: true, data: req.name === 'list-schemas' ? [{ name: 'task', node_count: 1 }] : { nodes: full } }) }],
        }),
      },
    });
    const engine = new Engine(config, factory);
    const { truncated } = await engine.listUntypedNodes({ pathPrefixes: [], maxPages: 2 });
    expect(truncated).toBe(true);
  });

  it('listUntypedNodes reads on past the notes it is told to leave out, and stops at the notes it may keep (#644)', async () => {
    // Three pages of 200. The newest 300 are notes a typing run would not ask about.
    const all = Array.from({ length: 600 }, (_, i) => ({ id: `u${i}`, title: `t${i}`, file_path: `Inbox/${i}.md`, types: [], version: 1 }));
    const captured: Array<Record<string, unknown>> = [];
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
          if (req.name === 'list-schemas') return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: [{ name: 'task', node_count: 1 }] }) }] };
          captured.push(req.arguments);
          const offset = req.arguments.offset as number;
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes: all.slice(offset, offset + 200) } }) }] };
        },
      },
    });
    const engine = new Engine(config, factory);
    const keep = (node: { id: string }): boolean => Number(node.id.slice(1)) >= 300;
    // The limit counts kept notes, so the notes left out do not use it up: the listing reaches the notes behind them.
    const capped = await engine.listUntypedNodes({ pathPrefixes: [], keep, maxNodes: 150, filter: { path_prefix: 'Inbox/' } });
    expect(capped.truncated).toBe(true);
    expect(capped.nodes.map(node => node.id)).toEqual(all.slice(300, 450).map(node => node.id));
    expect(captured.map(args => args.offset)).toEqual([0, 200, 400]);
    // The caller's filter narrows the set; the untyped rule and the paging stay the listing's own.
    expect(captured[0]).toMatchObject({ path_prefix: 'Inbox/', without_types: ['task'], without_fields: ['vault_engine_projection'], limit: 200 });

    const whole = await engine.listUntypedNodes({ pathPrefixes: [], keep, maxNodes: 1_000 });
    expect(whole).toMatchObject({ truncated: false });
    expect(whole.nodes).toHaveLength(300);
  });

  it('listNodesInDirs queries each dir with path_dir and merges', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const factory: EngineClientFactory = () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
          captured.push(req.arguments);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes: [{ id: `d${captured.length}`, title: 't', file_path: 'f.md', types: ['note'], version: 1 }] } }) }] };
        },
      },
    });
    const engine = new Engine(config, factory);
    const { nodes, truncated } = await engine.listNodesInDirs(['', 'Notes']);
    expect(nodes).toHaveLength(2);
    expect(truncated).toBe(false);
    expect(captured[0]?.path_dir).toBe('');
    expect(captured[1]?.path_dir).toBe('Notes');
  });

  it('addTypeToNode and moveNode pass expected_version through', async () => {
    const reqs: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const engine = new Engine(config, factoryReturning({}, r => reqs.push(r)));
    await engine.addTypeToNode('n1', 'person', 4);
    await engine.moveNode('n1', 'Abigail Adams', 'Persons', 4);
    expect(reqs[0]).toEqual({ name: 'update-node', arguments: { node_id: 'n1', add_types: ['person'], expected_version: 4 } });
    expect(reqs[1]).toEqual({ name: 'update-node', arguments: { node_id: 'n1', set_directory: 'Persons', expected_version: 4 } });
  });
});

// Conversation-memory-sweep gaps (task 2): conversation reads, memory search,
// evidence_ref filter on list-memories. Uses the file's existing
// factoryReturning harness rather than stubbing the private `call` seam.
describe('Engine conversation reads', () => {
  it('requests linked docs with archived conversations when explicitly requested', async () => {
    let call: { name: string; arguments: Record<string, unknown> } | undefined;
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ conversations: [] }, (r) => { call = r; }));

    await engine.listConversations({ includeArchived: true, includeLinkedDocs: true });

    expect(call).toEqual({
      name: 'list-conversations',
      arguments: { include_archived: true, include_linked_docs: true },
    });
  });

  it('listConversations includes archived by default and unwraps the envelope', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ conversations: [{ id: 'c1', title: 'T', created_at: 'a', updated_at: 'b', archived: 0 }] }, (r) => { seen = r; }));
    const out = await engine.listConversations();
    expect(seen).toMatchObject({ name: 'list-conversations', arguments: { include_archived: true } });
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('c1');
  });

  it('listConversations honours includeArchived: false', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ conversations: [] }, (r) => { seen = r; }));
    await engine.listConversations({ includeArchived: false });
    expect(seen?.arguments).toEqual({ include_archived: false });
  });

  it('listConversations tolerates a missing conversations key', async () => {
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never, factoryReturning({}));
    expect(await engine.listConversations()).toEqual([]);
  });

  it('getConversation returns metadata plus opaque messages', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({
        conversation: { id: 'c1', title: 'T', created_at: 'a', updated_at: 'b', archived: 0 },
        messages: [{ role: 'user', parts: [] }],
      }, (r) => { seen = r; }));
    const out = await engine.getConversation('c1');
    expect(seen).toMatchObject({ name: 'get-conversation', arguments: { id: 'c1' } });
    expect(out.conversation.id).toBe('c1');
    expect(out.messages).toHaveLength(1);
  });

  it('retains linked docs returned with a conversation', async () => {
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({
        conversation: { id: 'c1', title: 'T', created_at: 'a', updated_at: 'b', archived: 0, linked_docs: ['n1'] },
        messages: [],
        linked_docs: ['n1'],
      }));

    expect(await engine.getConversation('c1')).toMatchObject({ linked_docs: ['n1'] });
  });

  it('getConversation defaults messages to [] when absent', async () => {
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ conversation: { id: 'c1', title: 'T', created_at: 'a', updated_at: 'b', archived: 0 } }));
    expect((await engine.getConversation('c1')).messages).toEqual([]);
  });

  it('searchMemories forwards query/source/limit and unwraps memories', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ memories: [{ id: 7 }], query: 'x' }, (r) => { seen = r; }));
    const out = await engine.searchMemories({ query: '"qwen" OR "curator"', source: 'curator', limit: 20 });
    expect(seen).toMatchObject({
      name: 'list-memories',
      arguments: { query: '"qwen" OR "curator"', source: 'curator', limit: 20 },
    });
    expect(out).toHaveLength(1);
  });

  it('listMemories forwards evidence_ref', async () => {
    let seen: { name: string; arguments: Record<string, unknown> } | undefined;
    const engine = new Engine({ engineUrl: 'http://x', engineToken: 't' } as never,
      factoryReturning({ memories: [] }, (r) => { seen = r; }));
    await engine.listMemories({ evidence_ref: 'conv-1', limit: 50 });
    expect(seen?.arguments).toEqual({ evidence_ref: 'conv-1', limit: 50 });
  });
});

describe('Engine conversation capture seams', () => {
  it('appends captured content with a CAS guard and returns warnings', async () => {
    let append: { name: string; arguments: Record<string, unknown> } | undefined;
    const warning = { code: 'BODY_WARNING', message: 'Body was adjusted', severity: 'warning' as const };
    const engine = new Engine(config, () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          append = req;
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: {}, warnings: [warning] }) }] };
        },
      },
    }));

    expect((await engine.appendCapturedContent({
      nodeId: 'n1', text: 'block', expectedVersion: 7, dryRun: true,
      conversationAuthority: {
        conversationId: 'conversation-1', expectedRevision: 11,
        expectedLinkMode: 'bound', expectedLinkedDocs: ['n1', 'n2'],
      },
    })).warnings).toEqual([expect.objectContaining({ code: 'BODY_WARNING' })]);
    expect(append).toEqual({
      name: 'update-node',
      arguments: {
        node_id: 'n1', append_body: 'block', expected_version: 7, dry_run: true,
        conversation_authority: {
          conversation_id: 'conversation-1', expected_revision: 11,
          expected_link_mode: 'bound', expected_linked_docs: ['n1', 'n2'],
        },
      },
    });
  });

  it('returns capture-id FTS candidates after reading each node', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const node = { id: 'n1', title: 'Captured', types: ['note'], fields: {}, body: 'unvalidated candidate' };
    const engine = new Engine(config, () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          calls.push(req);
          const data = req.name === 'query-nodes' ? { nodes: [{ id: 'n1' }] } : node;
          return envelope(data);
        },
      },
    }));

    expect(await engine.findNodesContainingCaptureId('cap-123')).toEqual([node]);
    expect(calls[0]).toEqual({
      name: 'query-nodes',
      arguments: { full_text: 've:chat-curation:start id="cap-123"', select: ['id'], limit: 20 },
    });
    expect(calls[1]).toEqual({ name: 'get-node', arguments: { node_id: 'n1', include_embeds: false } });
  });

  it('returns conversation-marker FTS candidates after reading each node', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const node = { id: 'n2', title: 'Captured', types: ['note'], fields: {}, body: 'unvalidated candidate' };
    const engine = new Engine(config, () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req) => {
          calls.push(req);
          const data = req.name === 'query-nodes' ? { nodes: [{ id: 'n2' }] } : node;
          return envelope(data);
        },
      },
    }));

    expect(await engine.findNodesContainingConversationCapture("conversation-'\"<&>")).toEqual([node]);
    expect(calls[0]).toEqual({
      name: 'query-nodes',
      arguments: {
        full_text: 'conversation="conversation-&#39;&quot;&lt;&amp;&gt;" transcript-hash=',
        select: ['id'], limit: 200,
      },
    });
    expect(calls[1]).toEqual({ name: 'get-node', arguments: { node_id: 'n2', include_embeds: false } });
  });
});

it('retains unresolved typed-reference IDs with an unknown successful-envelope warning', async () => {
  const data = { id: 'task', relationships: { outgoing: { project: [{ target_id: null, target_title: 'Same' }] }, incoming: {} } };
  let calls = 0;
  const factory: EngineClientFactory = () => ({
    transport: { close: async () => {} },
    client: { connect: async () => {}, callTool: async () => {
      calls++;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data, warnings: [{ code: 'FUTURE_REFERENCE_WARNING', severity: 'warning', message: 'unresolved' }] }) }] };
    } },
  });
  const engine = new Engine(config, factory);
  expect(await engine.getNode('task')).toEqual(data);
  expect(calls).toBe(1);
});

describe('Engine.listActiveProjects', () => {
  it('queries the configured project type', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await new Engine(config, recordingFactory(calls, { nodes: [] })).listActiveProjects(['open'], 'initiative');
    expect(calls[0]).toMatchObject({ name: 'query-nodes', arguments: { types: ['initiative'], fields: { status: { one_of: ['open'] } } } });
  });

  it('filters on and reads back the configured status field', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const nodes = [{ id: 'p1', title: 'Atlas', file_path: 'Atlas.md', fields: { state: 'active' } }];
    const projects = await new Engine(config, recordingFactory(calls, { nodes })).listActiveProjects(['active'], 'project', 'state');
    expect(calls[0]?.arguments).toMatchObject({ fields: { state: { one_of: ['active'] } }, include_fields: ['state'] });
    expect(calls[0]?.arguments.fields).not.toHaveProperty('status');
    expect(projects).toEqual([{ id: 'p1', title: 'Atlas', file_path: 'Atlas.md', status: 'active' }]);
  });

  it('answers an empty status list with no projects, without querying (#454)', async () => {
    // Engine rejects an empty one_of, so querying would throw instead of answering.
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const nodes = [{ id: 'p1', title: 'Atlas', file_path: 'Atlas.md', fields: { status: 'open' } }];
    expect(await new Engine(config, recordingFactory(calls, { nodes })).listActiveProjects([])).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('Engine.wikiRefreshLive', () => {
  it('re-renders live sections only, never sending narrative sections', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await new Engine(config, recordingFactory(calls)).wikiRefreshLive('p1', true);
    expect(calls).toEqual([{ name: 'wiki-write', arguments: { project: 'p1', refresh_live: true, dry_run: true } }]);
  });
});

describe('Engine.wikiCreateHome', () => {
  it('writes create-only narrative sections awaiting the first curation plus live sections', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await new Engine(config, recordingFactory(calls, { node_id: 'home-1', created: true })).wikiCreateHome('p1', false);
    expect(calls).toHaveLength(1);
    // Engine leaves a home that appeared meanwhile untouched, so a late call cannot replace a curated narrative.
    expect(calls[0]).toMatchObject({ name: 'wiki-write', arguments: { project: 'p1', refresh_live: true, dry_run: false, create_only: true } });
    expect((calls[0]!.arguments.sections as Array<{ name: string }>).map(section => section.name)).toEqual(['Now', 'Focus', 'Open threads']);
  });
});

describe('Engine.listLinkSweepBacklog (#697)', () => {
  it('reads every page to the end, with link counts, newest first (Codex, #698)', async () => {
    const pages = 260; // more than any fixed limit of 250 pages held
    const requests: Array<Record<string, unknown>> = [];
    const engine = new Engine(config, () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
          requests.push(req.arguments);
          const offset = Number(req.arguments.offset);
          const count = offset / 200 < pages - 1 ? 200 : 7;
          const nodes = Array.from({ length: count }, (_, i) => ({ id: `n${offset + i}`, title: null, file_path: `n${offset + i}.md`,
            inlink_count: 0, outlink_count: 0 }));
          return envelope({ nodes });
        },
      },
    }));
    const { nodes } = await engine.listLinkSweepBacklog({ withoutTypes: ['wiki'], withoutPathPrefix: 'Settings/' });
    expect(nodes).toHaveLength((pages - 1) * 200 + 7);
    expect(requests).toHaveLength(pages);
    expect(requests[0]).toMatchObject({
      without_types: ['wiki'], without_path_prefix: 'Settings/', without_fields: ['vault_engine_projection'],
      select: ['id', 'title', 'file_path', 'file_mtime', 'created_at', 'inlink_count', 'outlink_count'],
      sort_by: 'created_at', sort_order: 'desc', limit: 200, offset: 0,
    });
  });
});

describe('Engine.listNotesNaming (#699)', () => {
  it('reads every page of matches, past any fixed limit (Codex, #701)', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const engine = new Engine(config, () => ({
      transport: { close: async () => {} },
      client: {
        connect: async () => {},
        callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
          requests.push(req.arguments);
          const offset = Number(req.arguments.offset);
          const count = offset < 2400 ? 200 : 13;
          return envelope({ nodes: Array.from({ length: count }, (_, i) => ({ id: `n${offset + i}` })) });
        },
      },
    }));
    const ids = await engine.listNotesNaming('Dana Whitfield', { withoutTypes: ['wiki'], withoutPathPrefix: 'Settings/' });
    expect(ids).toHaveLength(2400 + 13);
    expect(requests[0]).toMatchObject({ full_text_words: 'Dana Whitfield', without_types: ['wiki'], without_path_prefix: 'Settings/',
      without_fields: ['vault_engine_projection'], select: ['id'], limit: 200, offset: 0 });
  });
});
