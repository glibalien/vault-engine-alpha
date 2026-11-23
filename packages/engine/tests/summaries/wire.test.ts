import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { makeSummaryDb } from '../helpers/summary-fixture.js';
import { summarizeNodes } from '../../src/summaries/service.js';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../tests/fixtures/summarize-nodes/${name}.json`, import.meta.url), 'utf8'));
it('matches the frozen wire fixture used by both clients', () => {
    const db = makeSummaryDb();
    try {
        expect(JSON.parse(summarizeNodes(db, fixture('request')).content[0].text)).toEqual(fixture('success'));
    }
    finally {
        db.close();
    }
});
