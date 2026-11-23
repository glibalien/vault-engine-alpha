// AI-caller parity for #387: a topic wiki made from a note, driven only over the Curator's MCP tools,
// the same calls the plugin's command will make. Synthetic Engine, model and build.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../src/topic.js', () => ({
  curateTopic: vi.fn(async (_engine: unknown, _llm: unknown, _config: unknown, root: { title: string }) =>
    ({ project: root.title, outcome: 'written', dryRun: false })),
  topicRefreshCommitMaterial: vi.fn(() => undefined),
}));
import { curateTopic } from '../src/topic.js';
import { runMigrations } from '../src/db/migrate.js';
import { explicitTopicRefreshSources } from '../src/db/topic-refresh.js';
import { CurationQueue } from '../src/queue.js';
import { BackgroundBuilds } from '../src/background-builds.js';
import { curatorServerFactory } from '../src/server-bootstrap.js';
import type { CoreDeps } from '../src/core.js';
import type { LlmClient } from '../src/llm/types.js';

const NOTES: Record<string, { title: string; body: string }> = {
  'clip-1': { title: 'Why the Owls fired their coach', body: 'The Metro Owls fired their head coach after a nine-game losing streak and named an interim coach for the rest of 2026.' },
  'clip-2': { title: 'Owls sign a new goalkeeper', body: 'The Metro Owls signed a goalkeeper from a rival club, their first major signing since the coaching change this season.' },
  'clip-3': { title: 'Owls attendance falls', body: 'Home attendance for the Metro Owls fell for a third straight month, the club said, as the losing streak went on into the spring.' },
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  (curateTopic as ReturnType<typeof vi.fn>).mockClear();
});

async function connect(scopes: string[]) {
  const db = new Database(':memory:'); runMigrations(db);
  let created = 0;
  const engine = {
    getNode: vi.fn(async (id: string) => ({ id, types: ['clipping'], fields: {}, ...NOTES[id] })),
    listActiveProjects: vi.fn(async () => []),
    ensureTopicSchema: vi.fn(async () => {}),
    createNode: vi.fn(async () => ({ node_id: `topic-root-${++created}`, file_path: 'Topics/T.md' })),
    projectEvidence: vi.fn(async (id: string) => ({
      project: { id, title: 'T', file_path: '', status: null },
      existing_wiki: { home_id: 'home', home: null, topology_hash: '', catalog_valid: true, subpages: [] },
    })),
  };
  const llm: LlmClient = {
    configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
    withConfiguration: () => llm,
    structuredCall: vi.fn(async () => ({
      output: { topic: 'The 2026 Metro Owls', brief: 'The Metro Owls\' 2026 season.', confidence: 'high', alternatives: [], existing_wiki: '' },
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    })),
  };
  // As on the server: builds run after the call replies.
  const running: Promise<unknown>[] = [];
  const deps = {
    engine, llm, queue: new CurationQueue(), db, builds: new BackgroundBuilds(work => { running.push(work); }),
    config: { model: 'main-model', wikiPlanningModel: 'planning-model', wikiPageModel: null, wikiHomeModel: null,
      wikiPlanningMaxTokens: 0, homeMaxTokens: 4000, wikiPlanningReasoningEffort: 'inherit', activeStatuses: ['open'] },
  } as unknown as CoreDeps;
  const server = curatorServerFactory(async () => deps, new Date())();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const send = clientSide.send.bind(clientSide);
  clientSide.send = message => send(message, { authInfo: { token: 'synthetic', clientId: 'ai-caller', scopes } });
  const client = new Client({ name: 'ai-caller', version: '1' });
  await server.connect(serverSide); await client.connect(clientSide);
  closers.push(async () => { await Promise.all(running); await client.close(); await server.close(); db.close(); });
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text);
  return { call, db, llm, client, running };
}

describe('topic wiki from a note, over MCP alone (#387)', () => {
  it('chains propose → confirm → create, then adds a second note to the same wiki', async () => {
    const { call, db, llm, client, running } = await connect(['curate:read', 'curate:trigger']);
    const tools = (await client.listTools()).tools;
    expect(tools.find(t => t.name === 'propose-topic-wiki')?.description).toMatch(/accept or edit/);
    expect(tools.find(t => t.name === 'create-or-update-wiki')?.inputSchema.properties).toHaveProperty('paused');

    const proposal = await call('propose-topic-wiki', { node_id: 'clip-1' });
    expect(proposal).toMatchObject({ ok: true, topic: 'The 2026 Metro Owls', existing_wiki: null });
    // The user accepts, editing the brief.
    const created = await call('create-or-update-wiki', { ...proposal.next.create, brief: 'The Owls\' 2026 season and coaching.' });
    expect(created).toMatchObject({ ok: true, created: true, paused: true, outcome: 'queued', topic: 'The 2026 Metro Owls' });
    // The build runs behind the reply; curator-status follows it by the topic.
    await Promise.all(running);
    expect(curateTopic).toHaveBeenCalledTimes(1);
    expect(await call('curator-status', { project: 'The 2026 Metro Owls' }))
      .toMatchObject({ paused: true, in_progress: null, latest_run: { outcome: 'written' } });

    // Two notes proposed before either is confirmed: confirming both keeps both.
    const second = await call('propose-topic-wiki', { node_id: 'clip-2' });
    const third = await call('propose-topic-wiki', { node_id: 'clip-3' });
    expect(second).toMatchObject({ ok: true, existing_wiki: { title: 'The 2026 Metro Owls', kind: 'topic', paused: true } });
    expect(second.next.create).toBeUndefined();
    expect(await call('create-or-update-wiki', second.next.add_source)).toMatchObject({ ok: true, created: false, paused: true, outcome: 'queued' });
    await Promise.all(running);
    expect(await call('create-or-update-wiki', third.next.add_source)).toMatchObject({ ok: true, created: false, paused: true, outcome: 'queued' });
    await Promise.all(running);
    expect(explicitTopicRefreshSources(db, 'The 2026 Metro Owls').map(row => row.node_id)).toEqual(['clip-1', 'clip-2', 'clip-3']);
    expect(curateTopic).toHaveBeenCalledTimes(3);
    expect(llm.structuredCall).toHaveBeenCalledTimes(3);
  });

  it('needs curate:trigger to propose, since it is a paid call', async () => {
    const { call, llm } = await connect(['curate:read']);
    expect(await call('propose-topic-wiki', { node_id: 'clip-1' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(llm.structuredCall).not.toHaveBeenCalled();
  });
});
