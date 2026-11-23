/**
 * #340: the model a response says served the call (where OpenRouter's Auto Router routed it) is
 * recorded on every service's rows and groups in reports. Auto Router has no rate of its own, so
 * an uncharged row is reported as needing OpenRouter's charge, not a price row.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { addUsageEvents, upgradeConversationsStore } from '../../src/db/migrate.js';
import { completionUsageFields, UsageRecorder } from '../../src/usage/recorder.js';
import { registerRecordUsage } from '../../src/mcp/tools/record-usage.js';
import { registerUsageReport } from '../../src/mcp/tools/usage-report.js';
import { runUsageReport } from '../../src/usage/report.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  addUsageEvents(db); upgradeConversationsStore(db);
  return db;
}

const metadataOf = (db: Database.Database, id: number) =>
  JSON.parse((db.prepare('SELECT metadata_json FROM usage_events WHERE id = ?').get(id) as { metadata_json: string }).metadata_json);

describe('recorder', () => {
  it('stores the reported model beside other metadata and never prices from it', () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    const auto = rec.recordOrThrow({
      provider: 'openrouter', service: 'curator', purpose: 'memory-consolidation', model: 'openrouter/auto',
      inputTokens: 1000, outputTokens: 100, reportedModel: 'z-ai/glm-5.2', metadata: { backfill: false },
    });
    // GLM 5.2 has a table row, but the call is still unpriced: pricing from the routed model
    // is the owner's budget decision on #340, not this change.
    expect(auto).toMatchObject({ costUsd: 0, costBasis: 'unpriced' });
    expect(metadataOf(db, auto.id)).toEqual({ backfill: false, reported_model: 'z-ai/glm-5.2' });

    const priced = rec.recordOrThrow({
      provider: 'anthropic', service: 'engine', purpose: 'vision-extraction', model: 'claude-sonnet-4-6',
      inputTokens: 100_000, outputTokens: 10_000, reportedModel: 'claude-sonnet-4-6-20260901',
    });
    expect(priced.costUsd).toBeCloseTo(0.45, 10);
    expect(metadataOf(db, priced.id)).toEqual({ reported_model: 'claude-sonnet-4-6-20260901' });

    const none = rec.recordOrThrow({ provider: 'openrouter', service: 'engine', purpose: 'vision-extraction', model: 'm', inputTokens: 1 });
    expect(db.prepare('SELECT metadata_json FROM usage_events WHERE id = ?').get(none.id)).toEqual({ metadata_json: null });
    db.close();
  });

  it("carries complete()'s reported model through completionUsageFields", () => {
    expect(completionUsageFields({ usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, providerCostUsd: 0.01, reportedModel: 'a/b' }))
      .toMatchObject({ providerCostUsd: 0.01, reportedModel: 'a/b' });
    expect(completionUsageFields({ usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })).not.toHaveProperty('reportedModel');
  });
});

describe('reports', () => {
  it("groups by the reported model from the Engine's own rows and the Curator's", () => {
    const db = freshDb();
    const rec = new UsageRecorder(db);
    rec.recordOrThrow({ provider: 'openrouter', service: 'engine', purpose: 'vision-extraction', model: 'openrouter/auto', providerCostUsd: 0.01, reportedModel: 'z-ai/glm-5.2' });
    rec.recordOrThrow({ provider: 'openrouter', service: 'curator', purpose: 'wiki-synthesis', model: 'openrouter/auto', providerCostUsd: 0.02,
      metadata: { curator_usage: { version: 1, usage_complete: true, reported_model: 'z-ai/glm-5.2' } } });
    rec.recordOrThrow({ provider: 'openrouter', service: 'chat-plugin', purpose: 'conversation', model: 'openrouter/auto', providerCostUsd: 0.04, reportedModel: 'gpt-6-luna' });
    const result = runUsageReport(db, { groupBy: ['reported_model'] });
    const byModel = Object.fromEntries(result.groups.map((g) => [g.reported_model, g.cost_usd]));
    expect(byModel['z-ai/glm-5.2']).toBeCloseTo(0.03, 10);
    expect(byModel['gpt-6-luna']).toBeCloseTo(0.04, 10);
    db.close();
  });
});

describe('over MCP', () => {
  async function connect() {
    const db = freshDb();
    const server = new McpServer({ name: 'routed-model-test', version: '1' });
    registerRecordUsage(server, new UsageRecorder(db)); registerUsageReport(server, db);
    const client = new Client({ name: 'reader', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError).not.toBe(true);
      return JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
    };
    return { db, call, close: async () => { await client.close(); await server.close(); db.close(); } };
  }

  it('record-usage stores reported_model, and an uncharged Auto Router call asks for the charge, not a price row', async () => {
    const { db, call, close } = await connect();
    try {
      const auto = await call('record-usage', { provider: 'openrouter', service: 'chat-plugin', purpose: 'title-generation',
        model: 'openrouter/auto', reported_model: 'gpt-6-luna', input_tokens: 10, output_tokens: 2 });
      expect(auto).toMatchObject({ ok: true, data: { cost_basis: 'unpriced' } });
      expect(auto.warnings[0]).toMatchObject({ code: 'UNPRICED_MODELS', details: { model: 'openrouter/auto', provider_priced: true } });
      expect(auto.warnings[0].message).toMatch(/provider_cost_usd/);
      expect(auto.warnings[0].message).not.toMatch(/Add a row/);
      expect(metadataOf(db, auto.data.id)).toEqual({ reported_model: 'gpt-6-luna' });

      const other = await call('record-usage', { provider: 'fireworks', service: 'chat-plugin', purpose: 'conversation',
        model: 'accounts/fireworks/models/some-future-model', input_tokens: 10 });
      expect(other.warnings[0].message).toMatch(/Add a row to @vault\/pricing/);
      expect(other.warnings[0].details).not.toHaveProperty('provider_priced');

      const report = await call('usage-report', {});
      const unpriced = report.warnings.find((w: { code: string }) => w.code === 'UNPRICED_MODELS');
      expect(unpriced.details.unpriced).toEqual(expect.arrayContaining([
        { model: 'openrouter/auto', events: 1, provider_priced: true },
        { model: 'accounts/fireworks/models/some-future-model', events: 1 },
      ]));
      expect(unpriced.message).toMatch(/openrouter\/auto has no rate of its own/);
    } finally { await close(); }
  });

  it('rejects an empty reported_model', async () => {
    const { close, db } = await connect();
    try {
      const { recordUsageParamsShape } = await import('../../src/mcp/tools/record-usage.js');
      expect(recordUsageParamsShape.reported_model.safeParse('').success).toBe(false);
      expect(recordUsageParamsShape.reported_model.safeParse(undefined).success).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS n FROM usage_events').get()).toEqual({ n: 0 });
    } finally { await close(); }
  });
});
