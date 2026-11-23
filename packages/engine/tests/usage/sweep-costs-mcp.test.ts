import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addUsageEvents, upgradeConversationsStore } from '../../src/db/migrate.js';
import { UsageRecorder } from '../../src/usage/recorder.js';
import { registerRecordUsage } from '../../src/mcp/tools/record-usage.js';
import { registerUsageReport } from '../../src/mcp/tools/usage-report.js';
import { writeUsageCsvReports } from '../../src/usage/csv-reports.js';

it('round-trips actual charges through real MCP and reconciles report groups, totals and automatic CSV', async () => {
  const db = new Database(':memory:'); addUsageEvents(db); upgradeConversationsStore(db);
  const server = new McpServer({ name: 'cost-test', version: '1' });
  registerRecordUsage(server, new UsageRecorder(db)); registerUsageReport(server, db);
  const client = new Client({ name: 'cost-reader', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const dir = mkdtempSync(join(tmpdir(), 'sweep-costs-'));
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError).not.toBe(true);
      return JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
    };
    const event = { provider: 'openrouter', service: 'curator', purpose: 'wiki-synthesis', model: 'openrouter/auto',
      run_ref: 'r', source_ref: 'Project', metadata: { curator_usage: { version: 1,
        sweep_ref: 's', stage: 'page', outcome: 'failed', usage_complete: true, reported_model: 'actual' } } };
    expect(await call('record-usage', { ...event, provider_cost_usd: 0.2 })).toMatchObject({ ok: true,
      data: { cost_usd: 0.2, cost_basis: 'provider-reported' }, warnings: [] });
    await call('record-usage', { ...event, run_ref: 'unknown' });
    const before = db.serialize();
    const result = await call('usage-report', { service: 'curator', sweep_ref: 's', group_by: ['sweep', 'run', 'stage'], limit: 1 });
    expect(result.data).toMatchObject({ group_count: 2, totals: { events: 2, provider_reported_usd: 0.2, unpriced_events: 1 } });
    expect(result.warnings[0].code).toBe('UNPRICED_MODELS');
    const page2 = await call('usage-report', { service: 'curator', sweep_ref: 's', group_by: ['sweep', 'run', 'stage'], limit: 1, offset: 1 });
    expect(page2.data.groups[0].run).toBe('unknown');
    const stats = writeUsageCsvReports(db, dir);
    expect(stats.files['usage-curator-sweeps.csv']).toBe(2);
    const csv = readFileSync(join(dir, 'usage-curator-sweeps.csv'), 'utf8').trim().split('\n');
    const headers = csv[0]!.split(',');
    const amounts = csv.slice(1).map(line => line.split(','));
    expect(amounts.reduce((n, row) => n + Number(row[headers.indexOf('provider_reported_usd')]), 0)).toBe(0.2);
    expect(amounts.reduce((n, row) => n + Number(row[headers.indexOf('unpriced_events')]), 0)).toBe(1);
    expect(db.serialize()).toEqual(before);
  } finally { await client.close(); await server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
