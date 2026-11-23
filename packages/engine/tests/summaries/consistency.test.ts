import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSchema } from '../../src/db/schema.js';
import { seedSummaryFixture, summaryRequest } from '../helpers/summary-fixture.js';
import { summarizeNodes } from '../../src/summaries/service.js';
import type { SummaryRequest } from '../../src/summaries/types.js';
it('keeps one read snapshot when another WAL connection commits between stages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'summary-snapshot-'));
    const writer = new Database(join(dir, 'test.db'));
    writer.pragma('journal_mode=WAL');
    createSchema(writer);
    seedSummaryFixture(writer);
    let changed = false;
    const reader = new Database(join(dir, 'test.db'), { verbose(sql) {
            if (!changed && typeof sql === 'string' && sql.includes('AS parent_id')) {
                changed = true;
                writer.prepare("UPDATE node_fields SET value_text='2026-09-22' WHERE node_id='T2' AND field_name='due'").run();
            }
        } });
    try {
        const read = () => JSON.parse(summarizeNodes(reader, summaryRequest()).content[0].text).data;
        expect(read().rows[0].relations.outstanding_tasks.metrics.next_due).toBe('2026-09-18');
        expect(changed).toBe(true);
        expect(read().rows[0].relations.outstanding_tasks.metrics.next_due).toBe('2026-09-20');
    }
    finally {
        reader.close();
        writer.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
it('keeps percentage numerator and temporal denominator in the same WAL snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'percentage-snapshot-'));
    const writer = new Database(join(dir, 'test.db'));
    writer.pragma('journal_mode=WAL');
    createSchema(writer);
    seedSummaryFixture(writer);
    let changed = false;
    const reader = new Database(join(dir, 'test.db'), { verbose(sql) {
        if (!changed && typeof sql === 'string' && sql.includes('AS parent_id')) {
            changed = true;
            writer.transaction(() => {
                writer.prepare("UPDATE node_fields SET value_text='open' WHERE node_id='T3' AND field_name='status'").run();
                writer.prepare("UPDATE node_fields SET value_text='2026-09-22' WHERE node_id='T2' AND field_name='due'").run();
            })();
        }
    } });
    try {
        const request: SummaryRequest = {
            filter: { node_ids: ['P1'] },
            evaluation_context: { time_zone: 'UTC', as_of: '2026-09-19T12:00:00Z' },
            relations: [{ as: 'r', direction: 'incoming', field: 'project',
                filter: { fields: { due: { date_window: { to_days: 0 } } } },
                metrics: [{ as: 'p', op: 'percentage', matching_filter: { fields: { status: { eq: 'done' } } } }] }],
        };
        const read = () => JSON.parse(summarizeNodes(reader, request).content[0].text).data.rows[0].relations.r;
        expect(read()).toMatchObject({ metrics: { p: 50 }, metric_details: { p: { numerator_count: 1, denominator_count: 2 } } });
        expect(changed).toBe(true);
        expect(read()).toMatchObject({ metrics: { p: 0 }, metric_details: { p: { numerator_count: 0, denominator_count: 1 } } });
    } finally {
        reader.close();writer.close();rmSync(dir, { recursive: true, force: true });
    }
});
