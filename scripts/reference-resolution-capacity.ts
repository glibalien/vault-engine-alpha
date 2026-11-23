/** Synthetic, offline capacity probe. Run with Node 24: node --import tsx scripts/reference-resolution-capacity.ts */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createTestDb } from '../packages/engine/tests/helpers/db.js';
import { createGlobalField } from '../packages/engine/src/global-fields/crud.js';
import { buildReferenceCatalog } from '../packages/engine/src/resolver/relationship-policy.js';
import { readNodeResolutionIdentity, reconcileTypedReferences, refreshTypedReferences, TYPED_REFERENCE_EDGE_SQL } from '../packages/engine/src/resolver/typed-refresh.js';
import { previewReferenceActivation, applyReferenceActivation } from '../packages/engine/src/resolver/activation.js';
import { fullIndex } from '../packages/engine/src/indexer/indexer.js';

const args = process.argv.slice(2);
if (!args.length) {
  for (const count of [10_000, 100_000]) for (const fanout of [1, 5]) for (const unresolved of [0, 50, 100]) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, 'matrix', String(count), String(fanout), String(unresolved)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    process.stdout.write(run.stdout); process.stderr.write(run.stderr);
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
  for (const count of [250, 500, 1000]) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, 'bulk', String(count)], { encoding: 'utf8' });
    process.stdout.write(run.stdout); process.stderr.write(run.stderr);
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
} else {
  const [mode, countArg, fanoutArg = '1', unresolvedArg = '0'] = args;
  const count = Number(countArg), fanout = Number(fanoutArg), unresolved = Number(unresolvedArg);
  let statements = 0, catalogScans = 0, edgeReads = 0;
  const db = createTestDb({ verbose: sql => {
    const text = String(sql); statements++;
    if (/^SELECT id, file_path, title FROM nodes(?: ORDER BY id)?$/.test(text)) catalogScans++;
    if (/^SELECT/i.test(text) && /FROM relationships/i.test(text)) edgeReads++;
  } });
  const measure = <T>(work: () => T) => {
    statements = 0; catalogScans = 0; edgeReads = 0;
    const start = performance.now(); const result = work();
    return { ms: Math.round(performance.now() - start), statements, fullNodeSelects: catalogScans, nodeRowsRead: catalogScans * count, relationshipSelects: edgeReads, result };
  };
  try {
    db.prepare("INSERT INTO meta VALUES ('reference_resolution_policy_version', '2')").run();
    createGlobalField(db, { name: 'projects', field_type: 'list', list_item_type: 'reference', reference_target: 'project' });
    if (mode === 'bulk') {
      const vault = mkdtempSync(join(tmpdir(), 'reference-bulk-'));
      try {
        mkdirSync(join(vault, 'Targets'));
        writeFileSync(join(vault, 'Targets/Target.md'), '---\ntypes: [project]\n---\n');
        for (let i = 1; i < count; i++) writeFileSync(join(vault, `Task${i}.md`), '---\nprojects: [Target]\n---\n');
        const indexed = measure(() => fullIndex(vault, db));
        if ((db.prepare('SELECT count(*) AS n FROM relationships WHERE resolved_target_id IS NULL').get() as { n: number }).n) throw new Error('Unresolved final bulk graph');
        console.log(JSON.stringify({ mode, count, indexed, peakRssKiB: process.resourceUsage().maxRSS }));
      } finally { rmSync(vault, { recursive: true, force: true }); }
    } else {
      const node = db.prepare('INSERT INTO nodes (id,file_path,title) VALUES (?,?,?)');
      const type = db.prepare('INSERT INTO node_types (node_id,schema_type) VALUES (?,?)');
      const field = db.prepare("INSERT INTO node_fields (node_id,field_name,value_json,source) VALUES (?,'projects',?,'frontmatter')");
      const edge = db.prepare("INSERT INTO relationships (source_id,target,rel_type,context) VALUES (?,?,'projects','projects')");
      db.transaction(() => {
        for (let i = 0; i < count; i++) { node.run(String(i), `Nodes/${i}.md`, `Group${Math.floor(i / 2)}`); type.run(String(i), i % 10 < 8 ? 'project' : 'wiki'); }
        for (let i = 0; i < count; i++) {
          const targets: string[] = [];
          for (let j = 0; j < fanout; j++) {
            const targetIndex = ((i * fanout + j) % (count / 10)) * 10;
            const isUnresolved = (i * fanout + j) % 100 < unresolved;
            const raw = isUnresolved ? ((i + j) % 2 ? `Missing${targetIndex}` : `Group${targetIndex / 2}`) : `Nodes/${targetIndex}.md`;
            targets.push(raw); edge.run(String(i), raw);
          }
          field.run(String(i), JSON.stringify(targets));
        }
      })();
      const catalog = measure(() => { const c = buildReferenceCatalog(db); return c.byPath.size; });
      const refresh = measure(() => db.transaction(() => reconcileTypedReferences(db))());
      const edgeCount = count * fanout;
      const nullCount = (db.prepare('SELECT count(*) AS n FROM relationships WHERE resolved_target_id IS NULL').get() as { n: number }).n;
      if (nullCount !== edgeCount * unresolved / 100) throw new Error(`Unexpected unresolved count: ${nullCount}`);
      const rename = measure(() => db.transaction(() => {
        const before = readNodeResolutionIdentity(db, '0');
        db.prepare("UPDATE nodes SET title='Renamed', file_path='Moved/0.md' WHERE id='0'").run();
        return refreshTypedReferences(db, { kind: 'node', before, after: readNodeResolutionIdentity(db, '0') });
      })());
      const typeChange = measure(() => db.transaction(() => {
        const before = readNodeResolutionIdentity(db, '10');
        db.prepare("UPDATE node_types SET schema_type='wiki' WHERE node_id='10'").run();
        return refreshTypedReferences(db, { kind: 'node', before, after: readNodeResolutionIdentity(db, '10') });
      })());
      db.prepare("UPDATE meta SET value='1' WHERE key='reference_resolution_policy_version'").run();
      db.prepare("UPDATE relationships SET resolved_target_id='9'").run();
      const preview = measure(() => previewReferenceActivation(db));
      const activation = measure(() => applyReferenceActivation(db, preview.result.fingerprint));
      const plans = ['SELECT id, file_path, title FROM nodes', `SELECT relationships.id, target FROM relationships JOIN global_fields gf ON gf.name=relationships.rel_type WHERE ${TYPED_REFERENCE_EDGE_SQL}`, `SELECT source_id,rel_type,target FROM relationships WHERE (source_id,rel_type,target) > ('0','projects','') ORDER BY source_id,rel_type,target LIMIT 500`].map(sql => ({ sql, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() }));
      console.log(JSON.stringify({ mode, count, fanout, unresolvedPercent: unresolved, edgeCount, catalog, refresh, rename, typeChange, preview: { ...preview, result: preview.result.counts }, activation: { ...activation, result: activation.result.counts }, peakRssKiB: process.resourceUsage().maxRSS, plans }));
    }
  } finally { db.close(); }
}
