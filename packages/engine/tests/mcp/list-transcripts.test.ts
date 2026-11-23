import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { upgradeForAttachmentTranscripts } from '../../src/db/migrate.js';
import { TranscriptStore } from '../../src/extraction/transcript-store.js';
import { registerListTranscripts } from '../../src/mcp/tools/list-transcripts.js';

let db: Database.Database;
let store: TranscriptStore;

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

function getHandler(opts?: { maxInlineTextChars?: number }): (params: Record<string, unknown>) => Promise<any> {
  let captured: (params: Record<string, unknown>) => Promise<any>;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      captured = (params) => Promise.resolve(handler(params)) as Promise<any>;
    },
  } as unknown as McpServer;
  registerListTranscripts(fakeServer, store, opts);
  return captured!;
}

beforeEach(() => {
  db = createTestDb();
  upgradeForAttachmentTranscripts(db);
  store = new TranscriptStore(db);
  store.capture({
    embedRef: 'alpha.pdf',
    vaultPath: 'docs/alpha.pdf',
    contentHash: 'h-alpha',
    extractedText: 'alpha text',
    mediaType: 'application/pdf',
    extractorId: 'unpdf',
  });
  store.capture({
    embedRef: 'beta.png',
    vaultPath: 'imgs/beta.png',
    contentHash: 'h-beta',
    extractedText: 'beta vision description here',
    mediaType: 'image/png',
    extractorId: 'gemini',
  });
  // Delete the source file behind the second transcript.
  store.markDeleted('imgs/beta.png');
});

describe('list-transcripts', () => {
  it('returns all transcripts with the mapped shape (no text by default)', async () => {
    const handler = getHandler();
    const body = parseResult(await handler({}));

    expect(body.ok).toBe(true);
    expect(body.data.count).toBe(2);
    expect(body.data.transcripts).toHaveLength(2);

    const beta = body.data.transcripts.find((t: any) => t.embed_ref === 'beta.png');
    expect(beta).toMatchObject({
      embed_ref: 'beta.png',
      vault_path: 'imgs/beta.png',
      media_type: 'image/png',
      extractor_id: 'gemini',
      source_deleted: true,
      text_length: 'beta vision description here'.length,
    });
    expect(beta.captured_at).toBeTypeOf('string');
    expect(beta.deleted_at).toBeTypeOf('string');
    // include_text defaults off
    expect(beta).not.toHaveProperty('text');

    const alpha = body.data.transcripts.find((t: any) => t.embed_ref === 'alpha.pdf');
    expect(alpha.source_deleted).toBe(false);
    expect(alpha.deleted_at).toBeNull();
  });

  it('filters to only deleted-source transcripts when source_deleted:true', async () => {
    const handler = getHandler();
    const body = parseResult(await handler({ source_deleted: true }));

    expect(body.ok).toBe(true);
    expect(body.data.count).toBe(1);
    expect(body.data.transcripts[0].embed_ref).toBe('beta.png');
    expect(body.data.transcripts[0].source_deleted).toBe(true);
  });

  it('filters to only live-source transcripts when source_deleted:false', async () => {
    const handler = getHandler();
    const body = parseResult(await handler({ source_deleted: false }));

    expect(body.ok).toBe(true);
    expect(body.data.count).toBe(1);
    expect(body.data.transcripts[0].embed_ref).toBe('alpha.pdf');
    expect(body.data.transcripts[0].source_deleted).toBe(false);
  });

  it('includes full text when include_text:true', async () => {
    const handler = getHandler();
    const body = parseResult(await handler({ include_text: true }));

    expect(body.ok).toBe(true);
    const alpha = body.data.transcripts.find((t: any) => t.embed_ref === 'alpha.pdf');
    expect(alpha.text).toBe('alpha text');
    expect(alpha.text_length).toBe('alpha text'.length);
  });

  it('respects limit', async () => {
    const handler = getHandler();
    const body = parseResult(await handler({ limit: 1 }));

    expect(body.ok).toBe(true);
    expect(body.data.count).toBe(1);
  });

  it('emits RESULT_TRUNCATED warning when result hits the limit', async () => {
    // Two transcripts captured in beforeEach; capture a third so limit:2 truncates.
    store.capture({
      embedRef: 'gamma.pdf',
      vaultPath: 'docs/gamma.pdf',
      contentHash: 'h-gamma',
      extractedText: 'gamma text',
      mediaType: 'application/pdf',
      extractorId: 'unpdf',
    });

    const handler = getHandler();
    const body = parseResult(await handler({ limit: 2 }));

    expect(body.ok).toBe(true);
    expect(body.data.count).toBe(2);
    const truncated = body.warnings.find((w: any) => w.code === 'RESULT_TRUNCATED');
    expect(truncated).toBeDefined();
    expect(truncated.severity).toBe('warning');
    expect(truncated.details).toMatchObject({ count: 2, limit: 2 });
  });

  it('does not emit RESULT_TRUNCATED when result is under the limit', async () => {
    const handler = getHandler();
    const body = parseResult(await handler({ limit: 10 }));

    expect(body.ok).toBe(true);
    expect(body.data.count).toBe(2);
    expect((body.warnings ?? []).some((w: any) => w.code === 'RESULT_TRUNCATED')).toBe(false);
  });

  it('caps total inlined text at the budget, trims rows, and warns TEXT_BUDGET_EXCEEDED', async () => {
    // beforeEach captured 'alpha text' (10 chars) + 'beta vision description here' (27),
    // 37 chars total — a 15-char budget forces trimming regardless of row order.
    const handler = getHandler({ maxInlineTextChars: 15 });
    const body = parseResult(await handler({ include_text: true }));

    expect(body.ok).toBe(true);
    const rows = body.data.transcripts;

    // Hard bound: total inlined text never exceeds the budget.
    const inlined = rows.reduce((sum: number, t: any) => sum + (t.text?.length ?? 0), 0);
    expect(inlined).toBeLessThanOrEqual(15);

    // Every row still reports its true text_length even when text is trimmed.
    for (const t of rows) expect(t.text_length).toBeTypeOf('number');

    // At least one row was trimmed (truncated or omitted).
    const trimmed = rows.filter((t: any) => t.text_truncated || t.text_omitted);
    expect(trimmed.length).toBeGreaterThanOrEqual(1);

    // Omitted rows carry no text; truncated rows carry less than the full text.
    for (const t of rows) {
      if (t.text_omitted) expect(t).not.toHaveProperty('text');
      if (t.text_truncated) expect(t.text.length).toBeLessThan(t.text_length);
    }

    const warn = body.warnings.find((w: any) => w.code === 'TEXT_BUDGET_EXCEEDED');
    expect(warn).toBeDefined();
    expect(warn.severity).toBe('warning');
    expect(warn.details).toMatchObject({ text_budget_chars: 15 });
    // Points the caller at the tools that fetch a single transcript's full text.
    expect(warn.message).toMatch(/read-embedded|materialize-transcript/);
  });

  it('inlines full text and does not warn when include_text fits the budget', async () => {
    const handler = getHandler({ maxInlineTextChars: 10_000 });
    const body = parseResult(await handler({ include_text: true }));

    expect(body.ok).toBe(true);
    for (const t of body.data.transcripts) {
      expect(t.text.length).toBe(t.text_length);
      expect(t.text_truncated).toBeUndefined();
      expect(t.text_omitted).toBeUndefined();
    }
    expect((body.warnings ?? []).some((w: any) => w.code === 'TEXT_BUDGET_EXCEEDED')).toBe(false);
  });

  it('never inlines or flags text without include_text, even under a tiny budget', async () => {
    const handler = getHandler({ maxInlineTextChars: 1 });
    const body = parseResult(await handler({}));

    for (const t of body.data.transcripts) {
      expect(t).not.toHaveProperty('text');
      expect(t.text_truncated).toBeUndefined();
      expect(t.text_omitted).toBeUndefined();
    }
    expect((body.warnings ?? []).some((w: any) => w.code === 'TEXT_BUDGET_EXCEEDED')).toBe(false);
  });
});
