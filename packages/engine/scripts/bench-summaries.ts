/** Synthetic only. Run from the repository root with node --import tsx. */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { createSchema } from '../src/db/schema.js';
import { upgradeForResolvedTargetId } from '../src/db/migrate.js';
import { summarizeNodes } from '../src/summaries/service.js';
import type { SummaryRequest } from '../src/summaries/types.js';
const sizes = process.argv[2] ? [Number(process.argv[2])] : [100, 1000, 10000];
if (sizes.some(n => ![100, 1000, 10000].includes(n)))
    throw new Error('Parent count must be 100, 1000 or 10000');
const results: unknown[] = [];
for (const count of sizes) {
    for (const duplicate of [false, true]) {
        const dir = mkdtempSync(join(tmpdir(), 'vault-summary-bench-'));
        const db = new Database(join(dir, 'synthetic.db'));
        try {
            createSchema(db);
            upgradeForResolvedTargetId(db);
            db.transaction(() => {
                db.prepare("INSERT INTO schemas (name) VALUES ('project'),('task')").run();
                db.prepare("INSERT INTO global_fields (name,field_type,list_item_type) VALUES ('project','list','reference'),('status','enum',NULL),('estimate','number',NULL)").run();
                const node = db.prepare('INSERT INTO nodes (id,title,file_path) VALUES (?,?,?)');
                const type = db.prepare('INSERT INTO node_types (node_id,schema_type) VALUES (?,?)');
                const edge = db.prepare("INSERT INTO relationships (source_id,target,resolved_target_id,rel_type) VALUES (?,?,?,'project')");
                const field = db.prepare("INSERT INTO node_fields (node_id,field_name,value_text,value_number,source) VALUES (?,?,?,?,'frontmatter')");
                for (let i = 0; i < count; i++) {
                    const parent = `P${String(i).padStart(5, '0')}`;
                    node.run(parent, parent, `${parent}.md`);
                    type.run(parent, 'project');
                    for (let j = 0; j < 10; j++) {
                        const child = `${parent}-T${duplicate ? 0 : j}`;
                        if (!duplicate || j === 0) {
                            node.run(child, child, `${child}.md`);
                            type.run(child, 'task');
                            field.run(child, 'status', j === 0 ? 'open' : 'done', null);
                            field.run(child, 'estimate', null, j);
                        }
                        edge.run(child, `${parent}-spelling${j}`, parent);
                    }
                }
            })();
            // Use the same indexes as the Engine; no ANALYZE or benchmark-only indexes.
            for (const filtered of [false, true]) {
                const request: SummaryRequest = {
                    filter: { types: ['project'] },
                    relations: [{ as: 'tasks', direction: 'incoming', field: 'project', filter: filtered ? { fields: { status: { eq: 'open' } } } : {},
                            metrics: [{ as: 'count', op: 'count' }, { as: 'max_estimate', op: 'max', field: 'estimate' }], lookup: { fields: ['status'], limit: 2 } }],
                    sort: { by: 'metric', relation: 'tasks', metric: 'count', order: 'desc' }, limit: 100,
                };
                summarizeNodes(db, request);
                const timings: number[] = [];
                let peakSampledRss = 0;
                for (let run = 0; run < 5; run++) {
                    peakSampledRss = Math.max(peakSampledRss, process.memoryUsage().rss);
                    const start = performance.now();
                    summarizeNodes(db, request);
                    timings.push(performance.now() - start);
                    peakSampledRss = Math.max(peakSampledRss, process.memoryUsage().rss);
                }
                timings.sort((a, b) => a - b);
                results.push({ parents: count, rawEdges: count * 10, duplicate, filtered, minMs: timings[0], medianMs: timings[2], maxMs: timings[4], peakSampledRssMiB: peakSampledRss / 1048576 });
                if (count === 10000 && !filtered) {
                    let rejected = false;
                    try {
                        summarizeNodes(db, { ...request, relations: [request.relations[0], { ...request.relations[0], as: 'again' }] });
                    }
                    catch (error) {
                        if ((error as {
                            details?: {
                                reason?: string;
                            };
                        }).details?.reason === 'QUERY_LIMIT_EXCEEDED')
                            rejected = true;
                        else
                            throw error;
                    }
                    if (!rejected)
                        throw new Error('Repeated descriptors must exceed the shared edge cap');
                }
            }
            const parentIds = Array.from({ length: Math.min(200, count) }, (_, i) => `P${String(i).padStart(5, '0')}`);
            const placeholders = parentIds.map(() => '?').join(',');
            const plans = {
                parents: db.prepare("EXPLAIN QUERY PLAN SELECT DISTINCT n.id,n.title,n.file_path,n.version FROM nodes n JOIN node_types t ON t.node_id=n.id AND t.schema_type=? LIMIT ?").all('project', 10001),
                incoming: db.prepare(`EXPLAIN QUERY PLAN SELECT resolved_target_id AS parent_id,source_id AS related_id FROM relationships WHERE rel_type=? AND resolved_target_id IN (${placeholders}) LIMIT ?`).all('project', ...parentIds, 100001),
                outgoing: db.prepare(`EXPLAIN QUERY PLAN SELECT source_id AS parent_id,resolved_target_id AS related_id FROM relationships WHERE rel_type=? AND source_id IN (${placeholders}) LIMIT ?`).all('project', ...parentIds.map(id => `${id}-T0`), 100001),
            };
            results.push({ parents: count, duplicate, plans });
        }
        finally {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }
}
console.log(JSON.stringify({ node: process.version, platform: platform(), arch: arch(), runs: 5, results }, null, 2));
