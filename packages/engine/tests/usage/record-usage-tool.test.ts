import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { addUsageEvents } from '../../src/db/migrate.js';
import {
  UsageRecorder, USAGE_PROVIDERS, USAGE_SERVICES, USAGE_PURPOSES,
} from '../../src/usage/recorder.js';
import { registerRecordUsage, recordUsageParamsShape } from '../../src/mcp/tools/record-usage.js';

describe('record-usage tool', () => {
  it('accepts a key fingerprint and nothing that could be a key', () => {
    const shape = recordUsageParamsShape.key_ref;
    expect(shape.safeParse('0123456789abcdef').success).toBe(true);
    expect(shape.safeParse(undefined).success).toBe(true);
    expect(shape.safeParse('sk-or-v1-secret').success).toBe(false);
  });

  it('registers without throwing and the recorder path round-trips', () => {
    const db = new Database(':memory:');
    addUsageEvents(db);
    const recorder = new UsageRecorder(db);
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    expect(() => registerRecordUsage(server, recorder)).not.toThrow();

    // The exact mapping the tool handler performs:
    const r = recorder.recordOrThrow({
      provider: 'fireworks', service: 'chat-web', purpose: 'conversation',
      model: 'accounts/fireworks/models/qwen3p7-plus',
      inputTokens: 5000, outputTokens: 800, cacheReadTokens: 2000,
      conversationId: 'conv-1', latencyMs: 900,
    });
    expect(r.costBasis).toBe('computed');
    const row = db.prepare('SELECT conversation_id, service FROM usage_events WHERE id = ?').get(r.id) as { conversation_id: string; service: string };
    expect(row).toEqual({ conversation_id: 'conv-1', service: 'chat-web' });
    db.close();
  });

  it('rejects a ts that is not an ISO 8601 datetime', () => {
    // ts lands in the ledger's primary time column and every report buckets on
    // it — an unvalidated string silently produces rows no date range matches.
    expect(recordUsageParamsShape.ts.safeParse('yesterday').success).toBe(false);
    expect(recordUsageParamsShape.ts.safeParse('2026-07-25').success).toBe(false);
    expect(recordUsageParamsShape.ts.safeParse('2026-07-25T14:31:40.000Z').success).toBe(true);
    expect(recordUsageParamsShape.ts.safeParse(undefined).success).toBe(true);
  });

  it("accepts purpose 'memory-sweep' (v1.6 curator sweep attribution)", () => {
    const db = new Database(':memory:');
    addUsageEvents(db);
    const recorder = new UsageRecorder(db);
    const r = recorder.recordOrThrow({
      provider: 'fireworks', service: 'curator', purpose: 'memory-sweep',
      model: 'accounts/fireworks/models/qwen3p7-plus',
      inputTokens: 1200, outputTokens: 150,
    });
    const row = db.prepare('SELECT purpose FROM usage_events WHERE id = ?').get(r.id) as { purpose: string };
    expect(row.purpose).toBe('memory-sweep');
    db.close();
  });

  it("accepts purpose 'reconcile' (v3 §4c reconciliation attribution)", () => {
    // The MCP zod layer is where an unknown purpose dies (INVALID_PARAMS before
    // the recorder ever sees it) — assert that layer, not just recorder storage.
    expect(recordUsageParamsShape.purpose.safeParse('reconcile').success).toBe(true);
    const db = new Database(':memory:');
    addUsageEvents(db);
    const recorder = new UsageRecorder(db);
    const r = recorder.recordOrThrow({
      provider: 'fireworks', service: 'curator', purpose: 'reconcile',
      model: 'accounts/fireworks/models/qwen3p7-plus',
      inputTokens: 1200, outputTokens: 150,
    });
    const row = db.prepare('SELECT purpose FROM usage_events WHERE id = ?').get(r.id) as { purpose: string };
    expect(row.purpose).toBe('reconcile');
    db.close();
  });

  it("accepts purpose 'title-generation' (LLM conversation-title attribution)", () => {
    expect(recordUsageParamsShape.purpose.safeParse('title-generation').success).toBe(true);
    const db = new Database(':memory:');
    addUsageEvents(db);
    const recorder = new UsageRecorder(db);
    const r = recorder.recordOrThrow({
      provider: 'fireworks', service: 'chat-web', purpose: 'title-generation',
      model: 'accounts/fireworks/models/gpt-oss-120b',
      inputTokens: 300, outputTokens: 12,
    });
    const row = db.prepare('SELECT purpose FROM usage_events WHERE id = ?').get(r.id) as { purpose: string };
    expect(row.purpose).toBe('title-generation');
    db.close();
  });

  it("accepts purpose 'field-guess' (curator field inference attribution)", () => {
    expect(USAGE_PURPOSES).toContain('field-guess');
    expect(recordUsageParamsShape.purpose.safeParse('field-guess').success).toBe(true);
  });

  it.each([
    'conversation-capture-planner',
    'conversation-capture-coverage',
    'conversation-capture-composer',
    'conversation-sweep',
    'topic-refresh-assessment',
    'viz-interpret',
    'journal',
    'project-home-refresh',
    'project-page-refresh',
    'eval-wiki',
    'topic-inference',
    'entity-dossier',
  ])("accepts Curator purpose '%s'", (purpose) => {
    expect(USAGE_PURPOSES).toContain(purpose);
    expect(recordUsageParamsShape.purpose.safeParse(purpose).success).toBe(true);
  });

  // Drift guard: every vocabulary value the recorder can store must be reportable
  // through the MCP tool. A recorder purpose missing from the zod enum means clients'
  // spend reports fail validation and the rows are silently dropped.
  it('zod enums match the recorder vocabularies exactly', () => {
    expect([...recordUsageParamsShape.provider.options].sort()).toEqual([...USAGE_PROVIDERS].sort());
    expect([...recordUsageParamsShape.service.options].sort()).toEqual([...USAGE_SERVICES].sort());
    expect([...recordUsageParamsShape.purpose.options].sort()).toEqual([...USAGE_PURPOSES].sort());
    for (const purpose of USAGE_PURPOSES) {
      expect(recordUsageParamsShape.purpose.safeParse(purpose).success, `purpose ${purpose}`).toBe(true);
    }
  });
});
